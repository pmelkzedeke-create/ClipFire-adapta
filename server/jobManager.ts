import { ChildProcess } from 'child_process';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import {
  analyzeWithGroqAI,
  extractYouTubeId,
  extractYouTubeTranscript,
  fetchYouTubeOEmbed,
  formatTime,
  generateContextualClips,
  transcribeAudioWithGroqWhisper,
} from './aiAnalyzer.js';
import { CONFIG, ensureRuntimeDirectories } from './config.js';
import {
  detectSmartFocusCenterX,
  detectSpeechBoundaries,
  extractAudioForWhisper,
  extractFrameThumbnail,
  MediaProcessingError,
  probeMediaFile,
  renderClipWithFFmpeg,
  validateRenderedClip,
} from './ffmpeg.js';
import { createSignedZipUrl, getStorageProvider } from './storage.js';
import { ExportSettings, JobStatus, ProcessingJob, RenderedClip } from './types.js';
import {
  acquireAuthorizedRemoteVideo,
  computeFileSha256AndVerifySize,
  sanitizeDisplayFileName,
  VideoSourceError,
} from './videoSource.js';

class Semaphore {
  private active = 0;
  private readonly queue: Array<{
    resolve: (release: () => void) => void;
    reject: (err: Error) => void;
    onAbort?: () => void;
    signal?: AbortSignal;
  }> = [];

  constructor(private readonly maxConcurrency: number) {}

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(new MediaProcessingError('Processamento cancelado pelo usuário.', 'CANCELLED'));
    }

    if (this.active < this.maxConcurrency) {
      this.active += 1;
      let released = false;
      return Promise.resolve(() => {
        if (released) return;
        released = true;
        this.active -= 1;
        this.pump();
      });
    }

    return new Promise((resolve, reject) => {
      const entry: {
        resolve: (release: () => void) => void;
        reject: (err: Error) => void;
        onAbort?: () => void;
        signal?: AbortSignal;
      } = { resolve, reject, signal };

      if (signal) {
        const onAbort = () => {
          const idx = this.queue.indexOf(entry);
          if (idx !== -1) {
            this.queue.splice(idx, 1);
          }
          reject(new MediaProcessingError('Processamento cancelado na fila.', 'CANCELLED'));
        };
        entry.onAbort = onAbort;
        signal.addEventListener('abort', onAbort, { once: true });
      }

      this.queue.push(entry);
    });
  }

  private pump(): void {
    while (this.active < this.maxConcurrency && this.queue.length > 0) {
      const next = this.queue.shift()!;
      if (next.signal && next.onAbort) {
        next.signal.removeEventListener('abort', next.onAbort);
      }
      if (next.signal?.aborted) {
        next.reject(new MediaProcessingError('Processamento cancelado.', 'CANCELLED'));
        continue;
      }
      this.active += 1;
      let released = false;
      next.resolve(() => {
        if (released) return;
        released = true;
        this.active -= 1;
        this.pump();
      });
    }
  }
}

interface ActiveJobRuntime {
  abortController: AbortController;
  activeProcesses: Set<ChildProcess>;
  tempDir: string;
  uploadedTempFile?: string;
}

const jobSemaphore = new Semaphore(CONFIG.maxConcurrentJobs);
const ffmpegSemaphore = new Semaphore(CONFIG.maxFfmpegConcurrency);

const jobsCache = new Map<string, ProcessingJob>();
const activeJobRuntimes = new Map<string, ActiveJobRuntime>();
const activeByFingerprint = new Map<string, string>();
export const jobEvents = new EventEmitter();
jobEvents.setMaxListeners(200);

const ACTIVE_STATUSES: ReadonlySet<JobStatus> = new Set([
  'queued',
  'downloading',
  'validating',
  'probing',
  'transcribing',
  'analyzing',
  'rendering',
  'verifying',
]);

export function isJobActiveStatus(status: JobStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

function jobManifestPath(jobId: string): string {
  return path.join(CONFIG.jobsDir, `${jobId}.json`);
}

async function persistJob(job: ProcessingJob): Promise<void> {
  job.updatedAt = new Date().toISOString();
  jobsCache.set(job.id, job);

  try {
    await fs.promises.mkdir(CONFIG.jobsDir, { recursive: true });
    const target = jobManifestPath(job.id);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(job, null, 2), 'utf8');
    await fs.promises.rename(tmp, target);
  } catch (err) {
    console.warn(`[JobStore] Aviso ao persistir manifesto do job ${job.id}:`, err);
  }

  jobEvents.emit(`job:${job.id}`, serializeJobWithFreshUrls(job));
}

export function serializeJobWithFreshUrls(job: ProcessingJob): ProcessingJob {
  const storage = getStorageProvider();
  const refreshedCuts: RenderedClip[] = (job.cuts || []).map((clip) => {
    if (!clip.validated || !clip.fileName) return clip;
    const slugTitle = clip.title
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 42);
    const dlName = `clipfire-corte-${String(clip.rank).padStart(2, '0')}-${slugTitle || 'viral'}.mp4`;

    return {
      ...clip,
      previewUrl: storage.getSignedPreviewUrl(job.id, clip.fileName),
      downloadUrl: storage.getSignedDownloadUrl(job.id, clip.fileName, dlName),
      thumbnailUrl: clip.thumbnailFileName
        ? storage.getSignedPreviewUrl(job.id, clip.thumbnailFileName)
        : clip.thumbnailUrl,
    };
  });

  return {
    ...job,
    cuts: refreshedCuts,
    zipDownloadUrl:
      job.status === 'completed' && refreshedCuts.length > 0 ? createSignedZipUrl(job.id) : undefined,
  };
}

export async function getJobById(jobId: string): Promise<ProcessingJob | null> {
  if (!/^[a-zA-Z0-9_-]{6,64}$/.test(jobId)) return null;

  if (CONFIG.processingMode === 'remote_worker' && CONFIG.remoteWorkerUrl) {
    try {
      const headers: Record<string, string> = {};
      if (CONFIG.workerSharedSecret) {
        headers['x-worker-secret'] = CONFIG.workerSharedSecret;
      }
      const res = await fetch(`${CONFIG.remoteWorkerUrl.replace(/\/+$/, '')}/api/jobs/${encodeURIComponent(jobId)}`, {
        headers,
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const data = await res.json();
        if (data?.job) return data.job as ProcessingJob;
      }
    } catch {
      // Fallback to local job manifest
    }
  }

  let job = jobsCache.get(jobId) || null;
  if (!job) {
    try {
      const raw = await fs.promises.readFile(jobManifestPath(jobId), 'utf8');
      job = JSON.parse(raw) as ProcessingJob;
      jobsCache.set(jobId, job);
    } catch {
      return null;
    }
  }
  return serializeJobWithFreshUrls(job);
}

export async function listRecentJobs(limit = 25): Promise<ProcessingJob[]> {
  const all = Array.from(jobsCache.values());
  all.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return all.slice(0, limit).map(serializeJobWithFreshUrls);
}

async function cleanupTempDirectory(dirPath: string | undefined, filePath?: string): Promise<void> {
  if (filePath) {
    await fs.promises.unlink(filePath).catch(() => {});
  }
  if (dirPath) {
    const tempRoot = path.resolve(CONFIG.tempDir);
    const resolved = path.resolve(dirPath);
    if (resolved.startsWith(tempRoot + path.sep)) {
      await fs.promises.rm(resolved, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export async function cancelProcessingJob(jobId: string): Promise<ProcessingJob | null> {
  if (CONFIG.processingMode === 'remote_worker' && CONFIG.remoteWorkerUrl) {
    const headers: Record<string, string> = {};
    if (CONFIG.workerSharedSecret) headers['x-worker-secret'] = CONFIG.workerSharedSecret;
    const res = await fetch(
      `${CONFIG.remoteWorkerUrl.replace(/\/+$/, '')}/api/jobs/${encodeURIComponent(jobId)}/cancel`,
      { method: 'POST', headers }
    );
    if (res.ok) {
      const data = await res.json();
      return data.job || null;
    }
  }

  const job = jobsCache.get(jobId) || (await getJobById(jobId));
  if (!job) return null;

  if (!isJobActiveStatus(job.status)) {
    return serializeJobWithFreshUrls(job);
  }

  const runtime = activeJobRuntimes.get(jobId);
  if (runtime) {
    runtime.abortController.abort();
    for (const proc of runtime.activeProcesses) {
      try {
        proc.kill('SIGTERM');
      } catch {
        // ignore
      }
      setTimeout(() => {
        if (proc.exitCode === null) {
          try {
            proc.kill('SIGKILL');
          } catch {
            // ignore
          }
        }
      }, 2000).unref?.();
    }
    await cleanupTempDirectory(runtime.tempDir, runtime.uploadedTempFile);
  }

  if (job.fingerprint) {
    activeByFingerprint.delete(job.fingerprint);
  }

  // Also purge any partial artifacts saved for this cancelled job
  const storage = getStorageProvider();
  await storage
    .deleteJobArtifacts(
      jobId,
      job.cuts.flatMap((c) => [c.fileName, c.thumbnailFileName].filter(Boolean) as string[])
    )
    .catch(() => {});

  job.status = 'cancelled';
  job.stageLabel = 'Processamento cancelado';
  job.stageDetail = 'Operação interrompida pelo usuário e processos FFmpeg encerrados com segurança.';
  job.progressPct = null;
  job.cuts = [];
  job.completedAt = new Date().toISOString();
  await persistJob(job);

  return serializeJobWithFreshUrls(job);
}

export interface CreateJobInput {
  uploadedFile?: {
    tempFilePath: string;
    originalName: string;
    mimeType?: string;
    sizeBytes: number;
  };
  authorizedMediaUrl?: string;
  providerSource?: {
    name: 'google_drive';
    fileId: string;
    accessToken?: string;
  };
  youtubeRefUrl?: string;
  customTitle?: string;
  exportSettings: ExportSettings;
  forceReprocess?: boolean;
}

function computeJobFingerprint(sourceIdentity: string, settings: ExportSettings): string {
  return crypto
    .createHash('sha256')
    .update(`${sourceIdentity}::${JSON.stringify(settings)}`)
    .digest('hex')
    .slice(0, 32);
}

export async function createAndStartProcessingJob(
  input: CreateJobInput
): Promise<{ job: ProcessingJob; deduplicated: boolean }> {
  ensureRuntimeDirectories();

  let initialSha256 = '';
  if (input.uploadedFile) {
    const verified = await computeFileSha256AndVerifySize(input.uploadedFile.tempFilePath);
    initialSha256 = verified.sha256;
  }

  const prelimIdentity = initialSha256 || input.authorizedMediaUrl || input.providerSource?.fileId || crypto.randomUUID();
  const fingerprint = computeJobFingerprint(prelimIdentity, input.exportSettings);

  // Deduplication: prevent simultaneous duplicate rendering of the same video + settings
  if (!input.forceReprocess) {
    const existingActiveId = activeByFingerprint.get(fingerprint);
    if (existingActiveId) {
      const existingJob = await getJobById(existingActiveId);
      if (existingJob && isJobActiveStatus(existingJob.status)) {
        if (input.uploadedFile?.tempFilePath) {
          await fs.promises.unlink(input.uploadedFile.tempFilePath).catch(() => {});
        }
        return { job: existingJob, deduplicated: true };
      }
    }
  }

  const jobId = `job_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`;
  const jobTempDir = path.join(CONFIG.tempDir, jobId);
  await fs.promises.mkdir(jobTempDir, { recursive: true });

  const displaySourceName = input.uploadedFile
    ? sanitizeDisplayFileName(input.uploadedFile.originalName)
    : input.customTitle?.trim() || 'Vídeo Autorizado';

  const nowIso = new Date().toISOString();
  const job: ProcessingJob = {
    id: jobId,
    fingerprint,
    status: 'queued',
    stepIndex: 0,
    stageLabel: 'Na fila de processamento',
    stageDetail: 'Aguardando slot disponível no worker FFmpeg...',
    progressPct: 0,
    createdAt: nowIso,
    updatedAt: nowIso,
    exportSettings: input.exportSettings,
    cuts: [],
    diagnostics: [],
  };

  const runtime: ActiveJobRuntime = {
    abortController: new AbortController(),
    activeProcesses: new Set<ChildProcess>(),
    tempDir: jobTempDir,
    uploadedTempFile: input.uploadedFile?.tempFilePath,
  };

  activeJobRuntimes.set(jobId, runtime);
  activeByFingerprint.set(fingerprint, jobId);
  await persistJob(job);

  // Launch asynchronous background pipeline (never blocks HTTP response)
  void runJobPipeline(job, input, runtime, displaySourceName);

  return {
    job: serializeJobWithFreshUrls(job),
    deduplicated: false,
  };
}

async function runJobPipeline(
  job: ProcessingJob,
  input: CreateJobInput,
  runtime: ActiveJobRuntime,
  displaySourceName: string
): Promise<void> {
  const { signal } = runtime.abortController;
  let releaseJobSlot: (() => void) | null = null;
  let localSourceVideoPath = input.uploadedFile?.tempFilePath || '';

  try {
    releaseJobSlot = await jobSemaphore.acquire(signal);

    // STEP 1 (index 0): Acquire & Validate Video + FFprobe Metadata
    let sourceType: 'upload' | 'authorized_url' | 'provider' = 'upload';
    let finalFileName = displaySourceName;

    if (!localSourceVideoPath) {
      job.status = 'downloading';
      job.stepIndex = 0;
      job.stageLabel = 'Obtendo arquivo de vídeo autorizado...';
      job.stageDetail = 'Conectando à fonte externa autorizada...';
      job.progressPct = null;
      await persistJob(job);

      const downloadedPath = path.join(runtime.tempDir, 'source_input.bin');
      let lastDownloadEmit = 0;

      const dlResult = await acquireAuthorizedRemoteVideo({
        mediaUrl: input.authorizedMediaUrl,
        provider: input.providerSource,
        destFilePath: downloadedPath,
        signal,
        onProgress: (loaded, total) => {
          const now = Date.now();
          if (now - lastDownloadEmit < 350) return;
          lastDownloadEmit = now;
          const mbLoaded = (loaded / (1024 * 1024)).toFixed(1);
          if (total && total > 0) {
            const mbTotal = (total / (1024 * 1024)).toFixed(1);
            const pct = Math.min(18, Math.round((loaded / total) * 18));
            job.progressPct = pct;
            job.stageDetail = `Baixando mídia autorizada: ${mbLoaded} MB de ${mbTotal} MB`;
          } else {
            job.progressPct = null;
            job.stageDetail = `Baixando mídia autorizada: ${mbLoaded} MB recebidos...`;
          }
          void persistJob(job);
        },
      });

      localSourceVideoPath = downloadedPath;
      sourceType = dlResult.sourceType;
      if (!input.customTitle) {
        finalFileName = dlResult.resolvedFileName;
      }

      // Update fingerprint with real content hash
      const contentFp = computeJobFingerprint(dlResult.sha256, input.exportSettings);
      activeByFingerprint.delete(job.fingerprint);
      job.fingerprint = contentFp;
      activeByFingerprint.set(contentFp, job.id);
    }

    if (signal.aborted) {
      throw new MediaProcessingError('Processamento cancelado pelo usuário.', 'CANCELLED');
    }

    job.status = 'probing';
    job.stepIndex = 0;
    job.stageLabel = 'Validando arquivo e extraindo metadados com FFprobe...';
    job.stageDetail = 'Inspecionando container, streams de vídeo/áudio e duração real...';
    job.progressPct = null;
    await persistJob(job);

    const sourceMeta = await probeMediaFile(localSourceVideoPath, {
      signal,
      activeProcesses: runtime.activeProcesses,
    });

    if (sourceMeta.durationSec < CONFIG.minVideoDurationSec) {
      throw new VideoSourceError(
        `O vídeo enviado é muito curto (${sourceMeta.durationSec.toFixed(1)}s). Envie um vídeo com pelo menos ${CONFIG.minVideoDurationSec} segundos.`,
        'VIDEO_TOO_SHORT',
        422
      );
    }

    if (sourceMeta.durationSec > CONFIG.maxVideoDurationSec) {
      throw new VideoSourceError(
        `A duração do vídeo (${formatTime(sourceMeta.durationSec)}) excede o limite máximo configurado de ${formatTime(CONFIG.maxVideoDurationSec)}.`,
        'VIDEO_TOO_LONG',
        422
      );
    }

    job.diagnostics.push(
      `FFprobe OK: ${sourceMeta.effectiveWidth}x${sourceMeta.effectiveHeight}, ${sourceMeta.durationSec.toFixed(2)}s, vcodec=${sourceMeta.videoCodec}, acodec=${sourceMeta.audioCodec || 'none'}, fps=${sourceMeta.fps}`
    );

    // STEP 2 (index 1): Audio / Transcript Extraction
    job.status = 'transcribing';
    job.stepIndex = 1;
    job.stageLabel = 'Extraindo áudio, falas e legendas sincronizadas...';
    job.stageDetail = `Vídeo validado (${sourceMeta.effectiveWidth}×${sourceMeta.effectiveHeight} · ${formatTime(sourceMeta.durationSec)}). Analisando faixa de áudio...`;
    job.progressPct = null;
    await persistJob(job);

    let videoTitle =
      input.customTitle?.trim() ||
      finalFileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() ||
      'Vídeo Processado';
    let authorName = 'Criador Autorizado';
    let youtubeThumb: string | undefined;
    let transcriptData: { text: string; lines: Array<{ start: number; dur: number; text: string }> } | null = null;
    let transcriptSource: 'groq_whisper' | 'youtube_captions' | 'audio_silence_analysis' | 'timeline' = 'timeline';

    // Optional metadata/caption enrichment if user attached a reference YouTube URL
    if (input.youtubeRefUrl) {
      const ytId = extractYouTubeId(input.youtubeRefUrl);
      if (ytId) {
        const oEmbed = await fetchYouTubeOEmbed(ytId);
        if (!input.customTitle && oEmbed?.title) videoTitle = oEmbed.title;
        if (oEmbed?.author_name) authorName = oEmbed.author_name;
        if (oEmbed?.thumbnail_url) youtubeThumb = oEmbed.thumbnail_url;
      }
    }

    // 2a. Real Groq Whisper transcription from the actual video's audio track when GROQ_API_KEY is available
    if (process.env.GROQ_API_KEY && sourceMeta.hasAudio) {
      job.stageDetail = 'Extraindo trilha de áudio 16kHz com FFmpeg para transcrição Groq Whisper...';
      await persistJob(job);

      const whisperMp3Path = path.join(runtime.tempDir, 'whisper_audio.mp3');
      const extractedOk = await extractAudioForWhisper(
        localSourceVideoPath,
        whisperMp3Path,
        Math.min(sourceMeta.durationSec, 2400),
        { signal, activeProcesses: runtime.activeProcesses }
      );

      if (extractedOk) {
        job.stageDetail = 'Transcrevendo fala com timestamps reais via Groq Whisper...';
        await persistJob(job);
        const whisperResult = await transcribeAudioWithGroqWhisper(whisperMp3Path, signal);
        if (whisperResult && whisperResult.lines.length > 0) {
          transcriptData = whisperResult;
          transcriptSource = 'groq_whisper';
          job.diagnostics.push(`Groq Whisper OK: ${whisperResult.lines.length} segmentos transcritos.`);
        }
        await fs.promises.unlink(whisperMp3Path).catch(() => {});
      }
    }

    // 2b. Optional YouTube captions if provided and Whisper didn't run
    if (!transcriptData && input.youtubeRefUrl) {
      const ytId = extractYouTubeId(input.youtubeRefUrl);
      if (ytId) {
        const ytCaps = await extractYouTubeTranscript(ytId);
        if (ytCaps && ytCaps.lines.some((l) => l.start < sourceMeta.durationSec)) {
          transcriptData = {
            text: ytCaps.text,
            lines: ytCaps.lines.filter((l) => l.start < sourceMeta.durationSec),
          };
          transcriptSource = 'youtube_captions';
        }
      }
    }

    // 2c. Real FFmpeg audio speech boundary detection (`silencedetect`) when no external transcript API is set
    if (!transcriptData && sourceMeta.hasAudio) {
      job.stageDetail = 'Detectando limites reais de fala e pausas de áudio com FFmpeg...';
      await persistJob(job);
      const speechSegments = await detectSpeechBoundaries(localSourceVideoPath, sourceMeta.durationSec, {
        signal,
        activeProcesses: runtime.activeProcesses,
      });
      if (speechSegments.length > 0) {
        transcriptData = {
          text: speechSegments.map((s) => `[${formatTime(s.start)}] (${s.dur}s) ${s.text}`).join('\n'),
          lines: speechSegments,
        };
        transcriptSource = 'audio_silence_analysis';
        job.diagnostics.push(`FFmpeg silencedetect: ${speechSegments.length} segmentos ativos de fala identificados.`);
      }
    }

    job.video = {
      id: job.id,
      title: videoTitle,
      author: authorName,
      sourceType,
      originalFileName: finalFileName,
      youtubeRefUrl: input.youtubeRefUrl,
      thumbnail: youtubeThumb,
      hasRealTranscript: transcriptSource === 'groq_whisper' || transcriptSource === 'youtube_captions',
      transcriptSource,
      durationSec: Number(sourceMeta.durationSec.toFixed(2)),
      width: sourceMeta.effectiveWidth,
      height: sourceMeta.effectiveHeight,
      sizeBytes: sourceMeta.sizeBytes,
      videoCodec: sourceMeta.videoCodec,
      audioCodec: sourceMeta.audioCodec,
      fps: sourceMeta.fps,
      hasAudio: sourceMeta.hasAudio,
    };

    // STEP 3 (index 2): AI Viral Cut Moment Identification
    job.status = 'analyzing';
    job.stepIndex = 2;
    job.stageLabel = 'Identificando os melhores momentos de corte com IA...';
    job.stageDetail = process.env.GROQ_API_KEY
      ? 'Analisando retenção e selecionando intervalos exatos com Groq AI...'
      : 'Calculando intervalos de corte sincronizados à duração e falas do vídeo...';
    job.progressPct = null;
    await persistJob(job);

    let candidates = null;
    let providerUsed = 'groq';

    if (process.env.GROQ_API_KEY) {
      const summary = transcriptData
        ? transcriptData.text
        : `Vídeo "${videoTitle}" (${formatTime(sourceMeta.durationSec)}).`;
      candidates = await analyzeWithGroqAI({
        videoTitle,
        author: authorName,
        transcriptSummary: summary,
        videoDurationSec: sourceMeta.durationSec,
        maxClips: input.exportSettings.maxClips,
        signal,
      });
    }

    if (!candidates || candidates.length === 0) {
      providerUsed = process.env.GROQ_API_KEY ? 'groq_fallback' : 'contextual_engine';
      candidates = generateContextualClips({
        videoTitle,
        author: authorName,
        videoDurationSec: sourceMeta.durationSec,
        maxClips: input.exportSettings.maxClips,
        transcriptLines: transcriptData?.lines,
      });
    }

    job.provider = providerUsed;
    job.totalClipsToRender = candidates.length;

    // STEP 4 (index 3): Real FFmpeg Cutting, Encoding & Smart Framing
    job.status = 'rendering';
    job.stepIndex = 3;
    job.progressPct = 0;
    job.stageLabel = `Renderizando ${candidates.length} cortes MP4 reais com FFmpeg...`;
    job.stageDetail = `Iniciando codificação H.264 + AAC (${input.exportSettings.aspectRatio} · ${input.exportSettings.resolution})...`;
    await persistJob(job);

    const totalClipsDurationSec = candidates.reduce(
      (acc, c) => acc + Math.max(0.5, c.endSec - c.startSec),
      0
    );
    const clipRenderedSecTracker = new Array<number>(candidates.length).fill(0);
    let completedClipsCount = 0;
    let lastProgressPersistAt = 0;

    const storage = getStorageProvider();
    const renderedResults: Array<RenderedClip | null> = new Array(candidates.length).fill(null);

    // Worker tasks bounded by ffmpegSemaphore
    await Promise.all(
      candidates.map(async (candidate, idx) => {
        const releaseFfmpeg = await ffmpegSemaphore.acquire(signal);
        try {
          if (signal.aborted) {
            throw new MediaProcessingError('Processamento cancelado pelo usuário.', 'CANCELLED');
          }

          const rankPadded = String(candidate.rank).padStart(2, '0');
          const clipFileName = `corte-${rankPadded}.mp4`;
          const thumbFileName = `corte-${rankPadded}-thumb.jpg`;
          const tempOutputMp4 = path.join(runtime.tempDir, clipFileName);
          const tempOutputThumb = path.join(runtime.tempDir, thumbFileName);

          let focusCenterX = 0.5;
          if (
            input.exportSettings.framingMode === 'smart_crop' &&
            input.exportSettings.aspectRatio !== 'original'
          ) {
            focusCenterX = await detectSmartFocusCenterX(
              localSourceVideoPath,
              candidate.startSec,
              candidate.endSec - candidate.startSec,
              sourceMeta,
              { signal, activeProcesses: runtime.activeProcesses }
            );
          }

          job.currentClipIndex = completedClipsCount + 1;

          const { exportSpec } = await renderClipWithFFmpeg({
            inputPath: localSourceVideoPath,
            outputPath: tempOutputMp4,
            startSec: candidate.startSec,
            endSec: candidate.endSec,
            sourceMeta,
            settings: input.exportSettings,
            focusCenterX,
            signal,
            activeProcesses: runtime.activeProcesses,
            onProgress: (prog) => {
              clipRenderedSecTracker[idx] = prog.renderedSec;
              const sumRendered = clipRenderedSecTracker.reduce((a, b) => a + b, 0);
              const overallPct = Math.min(
                99,
                Math.max(0, Math.round((sumRendered / Math.max(0.5, totalClipsDurationSec)) * 100))
              );
              const clipPct = Math.round(prog.clipFraction * 100);
              const speedInfo = prog.speed ? ` · ${prog.speed}` : '';

              job.progressPct = overallPct;
              job.stageLabel = `Renderizando cortes MP4 com FFmpeg (${overallPct}%)`;
              job.stageDetail = `Corte #${rankPadded} (${completedClipsCount + 1}/${candidates.length}): ${clipPct}% (${prog.renderedSec.toFixed(1)}s / ${(candidate.endSec - candidate.startSec).toFixed(1)}s${speedInfo})`;

              const now = Date.now();
              if (now - lastProgressPersistAt >= 280 || prog.clipFraction >= 1) {
                lastProgressPersistAt = now;
                void persistJob(job);
              }
            },
          });

          // STEP 5 Validation per generated MP4 with FFprobe before accepting!
          const validatedProbe = await validateRenderedClip(
            tempOutputMp4,
            candidate.endSec - candidate.startSec,
            sourceMeta.hasAudio,
            exportSpec.targetWidth,
            exportSpec.targetHeight,
            { signal, activeProcesses: runtime.activeProcesses }
          );

          const hasThumb = await extractFrameThumbnail(
            tempOutputMp4,
            tempOutputThumb,
            validatedProbe.durationSec,
            { signal, activeProcesses: runtime.activeProcesses }
          );

          const storageKey = await storage.storeArtifact(job.id, clipFileName, tempOutputMp4, 'video/mp4');
          let thumbnailStorageKey: string | undefined;
          if (hasThumb) {
            thumbnailStorageKey = await storage.storeArtifact(
              job.id,
              thumbFileName,
              tempOutputThumb,
              'image/jpeg'
            );
          }

          // Remove local temp clip immediately after storing to keep disk usage minimal
          await fs.promises.unlink(tempOutputMp4).catch(() => {});
          await fs.promises.unlink(tempOutputThumb).catch(() => {});

          // Confirm stored artifact is physically accessible
          const storedCheck = await storage.artifactExists(job.id, clipFileName);
          if (!storedCheck.exists || storedCheck.sizeBytes <= 0) {
            throw new MediaProcessingError(
              `Falha ao verificar persistência de armazenamento do Corte #${rankPadded}.`,
              'STORAGE_VERIFY_FAILED'
            );
          }

          clipRenderedSecTracker[idx] = candidate.endSec - candidate.startSec;
          completedClipsCount += 1;

          const sumRendered = clipRenderedSecTracker.reduce((a, b) => a + b, 0);
          job.progressPct = Math.min(
            99,
            Math.round((sumRendered / Math.max(0.5, totalClipsDurationSec)) * 100)
          );
          job.stageDetail = `Corte #${rankPadded} validado (${validatedProbe.effectiveWidth}×${validatedProbe.effectiveHeight} · ${(validatedProbe.sizeBytes / (1024 * 1024)).toFixed(2)} MB) — ${completedClipsCount}/${candidates.length} prontos`;
          await persistJob(job);

          renderedResults[idx] = {
            ...candidate,
            duration: Number(validatedProbe.durationSec.toFixed(1)),
            timeLabel: `${formatTime(candidate.startSec)} → ${formatTime(candidate.endSec)} · ${Math.round(validatedProbe.durationSec)}s`,
            fileName: clipFileName,
            thumbnailFileName: hasThumb ? thumbFileName : undefined,
            storageKey,
            thumbnailStorageKey,
            sizeBytes: validatedProbe.sizeBytes,
            actualDurationSec: Number(validatedProbe.durationSec.toFixed(2)),
            width: validatedProbe.effectiveWidth,
            height: validatedProbe.effectiveHeight,
            resolutionLabel: `${validatedProbe.effectiveWidth}×${validatedProbe.effectiveHeight}`,
            fps: validatedProbe.fps,
            videoCodec: validatedProbe.videoCodec,
            audioCodec: validatedProbe.audioCodec,
            hasAudio: validatedProbe.hasAudio,
            framingApplied: exportSpec.framingApplied,
            focusCenterX: exportSpec.framingApplied === 'smart_crop' ? focusCenterX : undefined,
            validated: true,
            previewUrl: '',
            downloadUrl: '',
            thumbnailUrl: youtubeThumb,
          };
        } finally {
          releaseFfmpeg();
        }
      })
    );

    // Final verification pass
    job.status = 'verifying';
    job.stepIndex = 4;
    job.stageLabel = 'Verificando integridade final dos arquivos MP4...';
    job.stageDetail = 'Gerando links seguros assinados para prévia e download...';
    job.progressPct = 100;
    await persistJob(job);

    const finalClips = renderedResults.filter((c): c is RenderedClip => Boolean(c && c.validated));
    if (finalClips.length === 0) {
      throw new MediaProcessingError('Nenhum corte pôde ser validado com sucesso.', 'NO_VALID_CLIPS');
    }

    if (!job.video.thumbnail && finalClips[0]?.thumbnailFileName) {
      job.video.thumbnail = storage.getSignedPreviewUrl(job.id, finalClips[0].thumbnailFileName);
    }

    job.cuts = finalClips;
    job.status = 'completed';
    job.stepIndex = 4;
    job.progressPct = 100;
    job.completedAt = new Date().toISOString();
    job.stageLabel = 'Processamento concluído!';
    job.stageDetail = `${finalClips.length} arquivos MP4 (H.264 + AAC) renderizados e validados com FFmpeg.`;
    await persistJob(job);
  } catch (err: any) {
    const isCancelled =
      signal.aborted || err?.code === 'CANCELLED' || (job.status as string) === 'cancelled';

    if (isCancelled) {
      job.status = 'cancelled';
      job.stageLabel = 'Processamento cancelado';
      job.stageDetail = 'Operação interrompida pelo usuário e arquivos temporários removidos.';
      job.progressPct = null;
      job.cuts = [];
      job.completedAt = new Date().toISOString();
      await persistJob(job);
    } else {
      console.error(`[ClipFire Job ${job.id} Falhou]:`, err);
      job.status = 'failed';
      job.error = err?.message || 'Erro interno durante o processamento de vídeo com FFmpeg.';
      job.errorCode = err?.code || 'PROCESSING_FAILED';
      job.stageLabel = 'Falha no processamento';
      job.stageDetail = job.error || 'Falha ao renderizar cortes.';
      job.progressPct = null;
      job.completedAt = new Date().toISOString();
      if (err?.stderrTail) {
        job.diagnostics.push(String(err.stderrTail).slice(-1500));
      }
      await persistJob(job);
    }
  } finally {
    if (releaseJobSlot) releaseJobSlot();
    activeByFingerprint.delete(job.fingerprint);
    activeJobRuntimes.delete(job.id);
    await cleanupTempDirectory(runtime.tempDir, localSourceVideoPath);
  }
}

let cleanupIntervalHandle: NodeJS.Timeout | null = null;

export async function initJobManager(): Promise<void> {
  ensureRuntimeDirectories();

  // 1. Clean orphaned temp/upload files from previous runs
  try {
    const tempEntries = await fs.promises.readdir(CONFIG.tempDir).catch(() => []);
    for (const entry of tempEntries) {
      await fs.promises.rm(path.join(CONFIG.tempDir, entry), { recursive: true, force: true }).catch(() => {});
    }
    const uploadEntries = await fs.promises.readdir(CONFIG.uploadsDir).catch(() => []);
    for (const entry of uploadEntries) {
      await fs.promises.rm(path.join(CONFIG.uploadsDir, entry), { recursive: true, force: true }).catch(() => {});
    }
  } catch {
    // ignore
  }

  // 2. Load persisted job manifests from disk and mark any interrupted jobs safely
  try {
    const files = await fs.promises.readdir(CONFIG.jobsDir).catch(() => []);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const fullPath = path.join(CONFIG.jobsDir, file);
        const raw = await fs.promises.readFile(fullPath, 'utf8');
        const job = JSON.parse(raw) as ProcessingJob;
        if (isJobActiveStatus(job.status)) {
          job.status = 'failed';
          job.error = 'O processamento anterior foi interrompido devido à reinicialização do servidor.';
          job.errorCode = 'SERVER_RESTARTED';
          job.completedAt = new Date().toISOString();
          await persistJob(job);
        } else {
          jobsCache.set(job.id, job);
        }
      } catch {
        // ignore malformed manifest
      }
    }
  } catch {
    // ignore
  }

  // 3. Periodic TTL garbage collection for expired artifacts
  if (!cleanupIntervalHandle) {
    cleanupIntervalHandle = setInterval(() => {
      void purgeExpiredJobs();
    }, CONFIG.cleanupIntervalMs);
    cleanupIntervalHandle.unref?.();
  }
}

export async function purgeExpiredJobs(): Promise<number> {
  const now = Date.now();
  const storage = getStorageProvider();
  let purged = 0;

  for (const [jobId, job] of jobsCache.entries()) {
    if (isJobActiveStatus(job.status)) continue;
    const refTime = new Date(job.completedAt || job.updatedAt || job.createdAt).getTime();
    if (Number.isFinite(refTime) && now - refTime > CONFIG.jobRetentionTtlMs) {
      const artifactNames = (job.cuts || []).flatMap(
        (c) => [c.fileName, c.thumbnailFileName].filter(Boolean) as string[]
      );
      await storage.deleteJobArtifacts(jobId, artifactNames).catch(() => {});
      await fs.promises.unlink(jobManifestPath(jobId)).catch(() => {});
      jobsCache.delete(jobId);
      purged += 1;
    }
  }

  return purged;
}

export async function deleteJobById(jobId: string): Promise<boolean> {
  if (!/^[a-zA-Z0-9_-]{6,64}$/.test(jobId)) return false;
  const job = jobsCache.get(jobId);
  if (!job) return false;
  if (isJobActiveStatus(job.status)) {
    await cancelProcessingJob(jobId);
  }
  const storage = getStorageProvider();
  const artifactNames = (job.cuts || []).flatMap(
    (c) => [c.fileName, c.thumbnailFileName].filter(Boolean) as string[]
  );
  await storage.deleteJobArtifacts(jobId, artifactNames).catch(() => {});
  await fs.promises.unlink(jobManifestPath(jobId)).catch(() => {});
  jobsCache.delete(jobId);
  return true;
}

export async function purgeAllInactiveJobs(): Promise<number> {
  const storage = getStorageProvider();
  let purged = 0;
  for (const [jobId, job] of jobsCache.entries()) {
    if (isJobActiveStatus(job.status)) continue;
    const artifactNames = (job.cuts || []).flatMap(
      (c) => [c.fileName, c.thumbnailFileName].filter(Boolean) as string[]
    );
    await storage.deleteJobArtifacts(jobId, artifactNames).catch(() => {});
    await fs.promises.unlink(jobManifestPath(jobId)).catch(() => {});
    jobsCache.delete(jobId);
    purged += 1;
  }
  return purged;
}

