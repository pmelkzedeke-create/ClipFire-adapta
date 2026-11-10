import { ChildProcess, execFile, spawn } from 'child_process';
import fs from 'fs';
import { promisify } from 'util';
import { CONFIG } from './config.js';
import { ExportSettings, FramingModeOption, ProbedMediaMetadata } from './types.js';

const execFileAsync = promisify(execFile);

export interface MediaBinariesInfo {
  available: boolean;
  ffmpegPath: string;
  ffprobePath: string;
  ffmpegVersion: string;
  ffprobeVersion: string;
  encoders: {
    libx264: boolean;
    aac: boolean;
  };
  error?: string;
}

let cachedBinaries: MediaBinariesInfo | null = null;

async function tryBinaryVersion(binPath: string): Promise<string | null> {
  if (!binPath) return null;
  try {
    const { stdout } = await execFileAsync(binPath, ['-version'], {
      timeout: 8000,
      windowsHide: true,
    });
    const firstLine = stdout.split(/\r?\n/)[0]?.trim();
    return firstLine || null;
  } catch {
    return null;
  }
}

export async function verifyMediaBinaries(forceRefresh = false): Promise<MediaBinariesInfo> {
  if (cachedBinaries && cachedBinaries.available && !forceRefresh) {
    return cachedBinaries;
  }

  const ffmpegCandidates: string[] = [];
  const ffprobeCandidates: string[] = [];

  if (CONFIG.ffmpegPathOverride) ffmpegCandidates.push(CONFIG.ffmpegPathOverride);
  if (CONFIG.ffprobePathOverride) ffprobeCandidates.push(CONFIG.ffprobePathOverride);

  ffmpegCandidates.push('ffmpeg');
  ffprobeCandidates.push('ffprobe');

  try {
    const ffmpegInstaller = await import('@ffmpeg-installer/ffmpeg');
    const installerPath = (ffmpegInstaller.default || ffmpegInstaller)?.path;
    if (installerPath) ffmpegCandidates.push(installerPath);
  } catch {
    // Optional package fallback
  }

  try {
    const ffprobeInstaller = await import('@ffprobe-installer/ffprobe');
    const installerPath = (ffprobeInstaller.default || ffprobeInstaller)?.path;
    if (installerPath) ffprobeCandidates.push(installerPath);
  } catch {
    // Optional package fallback
  }

  let resolvedFfmpeg = '';
  let ffmpegVersion = '';
  for (const candidate of ffmpegCandidates) {
    const ver = await tryBinaryVersion(candidate);
    if (ver) {
      resolvedFfmpeg = candidate;
      ffmpegVersion = ver;
      break;
    }
  }

  let resolvedFfprobe = '';
  let ffprobeVersion = '';
  for (const candidate of ffprobeCandidates) {
    const ver = await tryBinaryVersion(candidate);
    if (ver) {
      resolvedFfprobe = candidate;
      ffprobeVersion = ver;
      break;
    }
  }

  if (!resolvedFfmpeg || !resolvedFfprobe) {
    cachedBinaries = {
      available: false,
      ffmpegPath: resolvedFfmpeg,
      ffprobePath: resolvedFfprobe,
      ffmpegVersion,
      ffprobeVersion,
      encoders: { libx264: false, aac: false },
      error: `Binários obrigatórios ausentes: ${!resolvedFfmpeg ? 'ffmpeg ' : ''}${!resolvedFfprobe ? 'ffprobe' : ''}`.trim(),
    };
    return cachedBinaries;
  }

  let libx264 = false;
  let aac = false;
  try {
    const { stdout } = await execFileAsync(resolvedFfmpeg, ['-hide_banner', '-encoders'], {
      timeout: 8000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    libx264 = /\blibx264\b/.test(stdout);
    aac = /\baac\b/.test(stdout);
  } catch (err: any) {
    cachedBinaries = {
      available: false,
      ffmpegPath: resolvedFfmpeg,
      ffprobePath: resolvedFfprobe,
      ffmpegVersion,
      ffprobeVersion,
      encoders: { libx264: false, aac: false },
      error: `Falha ao verificar codecs do FFmpeg: ${err?.message || 'erro desconhecido'}`,
    };
    return cachedBinaries;
  }

  const available = libx264 && aac;
  cachedBinaries = {
    available,
    ffmpegPath: resolvedFfmpeg,
    ffprobePath: resolvedFfprobe,
    ffmpegVersion,
    ffprobeVersion,
    encoders: { libx264, aac },
    error: available ? undefined : 'Codecs obrigatórios libx264 e/ou aac não encontrados na compilação do FFmpeg.',
  };
  return cachedBinaries;
}

export class MediaProcessingError extends Error {
  public readonly code: string;
  public readonly stderrTail?: string;

  constructor(message: string, code = 'FFMPEG_ERROR', stderrTail?: string) {
    super(message);
    this.name = 'MediaProcessingError';
    this.code = code;
    this.stderrTail = stderrTail;
  }
}

function terminateChildSafely(proc: ChildProcess): void {
  if (proc.killed || proc.exitCode !== null) return;
  try {
    proc.kill('SIGTERM');
  } catch {
    // ignore
  }
  const killTimer = setTimeout(() => {
    if (proc.exitCode === null) {
      try {
        proc.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
  }, 2500);
  killTimer.unref?.();
}

interface SpawnCaptureOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  activeProcesses?: Set<ChildProcess>;
  onStdoutChunk?: (chunk: Buffer) => void;
  collectStdout?: boolean;
}

function runProcessSafe(
  binaryPath: string,
  args: string[],
  options: SpawnCaptureOptions = {}
): Promise<{ stdout: Buffer; stderrTail: string }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new MediaProcessingError('Processamento cancelado pelo usuário.', 'CANCELLED'));
      return;
    }

    const proc = spawn(binaryPath, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    options.activeProcesses?.add(proc);

    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    const maxStdoutBytes = 16 * 1024 * 1024;
    let stderrTail = '';
    const maxStderrChars = 24_000;

    let settled = false;
    let timedOut = false;

    const onAbort = () => {
      terminateChildSafely(proc);
    };

    if (options.signal) {
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    const timer =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            terminateChildSafely(proc);
          }, options.timeoutMs)
        : null;
    timer?.unref?.();

    proc.stdout?.on('data', (chunk: Buffer) => {
      if (options.onStdoutChunk) {
        options.onStdoutChunk(chunk);
      }
      if (options.collectStdout !== false && stdoutBytes < maxStdoutBytes) {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      const str = chunk.toString('utf8');
      stderrTail += str;
      if (stderrTail.length > maxStderrChars) {
        stderrTail = stderrTail.slice(stderrTail.length - maxStderrChars);
      }
    });

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
      options.activeProcesses?.delete(proc);
    };

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new MediaProcessingError(`Erro ao executar binário de mídia: ${err.message}`, 'SPAWN_ERROR', stderrTail));
    });

    proc.on('close', (code, signalName) => {
      if (settled) return;
      settled = true;
      cleanup();

      if (options.signal?.aborted) {
        reject(new MediaProcessingError('Processamento cancelado pelo usuário.', 'CANCELLED', stderrTail));
        return;
      }

      if (timedOut) {
        reject(
          new MediaProcessingError(
            'Tempo limite excedido durante a execução do FFmpeg/FFprobe.',
            'TIMEOUT',
            stderrTail
          )
        );
        return;
      }

      if (code !== 0) {
        const lastLines = stderrTail
          .trim()
          .split(/\r?\n/)
          .slice(-6)
          .join(' | ');
        reject(
          new MediaProcessingError(
            ` Processo de mídia encerrou com código ${code ?? signalName}: ${lastLines || 'erro interno do FFmpeg'}`,
            'EXIT_NON_ZERO',
            stderrTail
          )
        );
        return;
      }

      resolve({
        stdout: Buffer.concat(stdoutChunks),
        stderrTail,
      });
    });
  });
}

function parseRationalFps(rateStr: string | undefined): number {
  if (!rateStr) return 0;
  const parts = rateStr.split('/');
  if (parts.length === 2) {
    const num = Number(parts[0]);
    const den = Number(parts[1]);
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0) {
      return num / den;
    }
  }
  const direct = Number(rateStr);
  return Number.isFinite(direct) && direct > 0 ? direct : 0;
}

function extractRotationDegrees(videoStream: any): number {
  const tagRotate = Number(videoStream?.tags?.rotate);
  if (Number.isFinite(tagRotate)) {
    return ((Math.round(tagRotate) % 360) + 360) % 360;
  }
  if (Array.isArray(videoStream?.side_data_list)) {
    for (const sd of videoStream.side_data_list) {
      if (sd && sd.rotation !== undefined) {
        const rot = Number(sd.rotation);
        if (Number.isFinite(rot)) {
          return ((Math.round(rot) % 360) + 360) % 360;
        }
      }
    }
  }
  return 0;
}

export async function probeMediaFile(
  filePath: string,
  options: { signal?: AbortSignal; activeProcesses?: Set<ChildProcess> } = {}
): Promise<ProbedMediaMetadata> {
  const bins = await verifyMediaBinaries();
  if (!bins.available) {
    throw new MediaProcessingError(bins.error || 'FFprobe indisponível no servidor.', 'BINARY_MISSING');
  }

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    throw new MediaProcessingError('Arquivo de vídeo não encontrado para análise.', 'FILE_NOT_FOUND');
  }

  if (!stat.isFile() || stat.size <= 0) {
    throw new MediaProcessingError('O arquivo enviado está vazio ou inválido.', 'INVALID_FILE');
  }

  const { stdout } = await runProcessSafe(
    bins.ffprobePath,
    ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', '--', filePath],
    {
      signal: options.signal,
      timeoutMs: 30_000,
      activeProcesses: options.activeProcesses,
    }
  );

  let parsed: any;
  try {
    parsed = JSON.parse(stdout.toString('utf8'));
  } catch {
    throw new MediaProcessingError('Não foi possível interpretar os metadados FFprobe do arquivo.', 'INVALID_PROBE_JSON');
  }

  const streams: any[] = Array.isArray(parsed?.streams) ? parsed.streams : [];
  const format = parsed?.format || {};

  // Exclude attached cover pictures (e.g. MP3 album art)
  const videoStream = streams.find(
    (s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1 && Number(s.width) > 0 && Number(s.height) > 0
  );

  if (!videoStream) {
    throw new MediaProcessingError(
      'O arquivo fornecido não contém uma faixa de vídeo válida decodificável.',
      'NO_VIDEO_STREAM'
    );
  }

  const audioStream = streams.find((s) => s.codec_type === 'audio');

  const formatDuration = Number(format.duration);
  const streamDuration = Number(videoStream.duration);
  const durationSec =
    Number.isFinite(formatDuration) && formatDuration > 0
      ? formatDuration
      : Number.isFinite(streamDuration) && streamDuration > 0
      ? streamDuration
      : 0;

  if (durationSec <= 0.4) {
    throw new MediaProcessingError(
      'Não foi possível determinar uma duração válida para este vídeo (arquivo corrompido ou muito curto).',
      'INVALID_DURATION'
    );
  }

  const width = Number(videoStream.width);
  const height = Number(videoStream.height);
  const rotation = extractRotationDegrees(videoStream);
  const isRotated90 = rotation === 90 || rotation === 270;
  const effectiveWidth = isRotated90 ? height : width;
  const effectiveHeight = isRotated90 ? width : height;

  const avgFps = parseRationalFps(videoStream.avg_frame_rate);
  const realFps = parseRationalFps(videoStream.r_frame_rate);
  const fps = avgFps > 1 && avgFps <= 240 ? Number(avgFps.toFixed(3)) : realFps > 1 && realFps <= 240 ? Number(realFps.toFixed(3)) : 30;

  const bitrateRaw = Number(format.bit_rate) || Number(videoStream.bit_rate) || 0;
  const bitrateKbps = bitrateRaw > 0 ? Math.round(bitrateRaw / 1000) : Math.round((stat.size * 8) / durationSec / 1000);

  return {
    durationSec,
    width,
    height,
    effectiveWidth,
    effectiveHeight,
    rotation,
    videoCodec: String(videoStream.codec_name || 'unknown'),
    audioCodec: audioStream ? String(audioStream.codec_name || 'unknown') : null,
    fps,
    hasAudio: Boolean(audioStream),
    sizeBytes: stat.size,
    bitrateKbps,
    formatName: String(format.format_name || 'unknown'),
  };
}

function toEven(n: number, minVal = 64): number {
  const clamped = Math.max(minVal, Math.round(n));
  return clamped % 2 === 0 ? clamped : clamped - 1;
}

/**
 * Analyzes actual decoded frames from [startSec, startSec + durationSec]
 * to find where visual detail / speaker activity is concentrated horizontally,
 * enabling real smart 9:16 vertical framing without distorting the image.
 */
export async function detectSmartFocusCenterX(
  inputPath: string,
  startSec: number,
  durationSec: number,
  sourceMeta: ProbedMediaMetadata,
  options: { signal?: AbortSignal; activeProcesses?: Set<ChildProcess> } = {}
): Promise<number> {
  const sourceAr = sourceMeta.effectiveWidth / sourceMeta.effectiveHeight;
  if (sourceAr <= 1.05) {
    return 0.5;
  }

  const bins = await verifyMediaBinaries();
  if (!bins.available) return 0.5;

  const sampleW = 64;
  const sampleH = 36;
  const safeDur = Math.max(1, Math.min(durationSec, 30));
  const sampleFps = Number((4 / safeDur).toFixed(4));

  try {
    const { stdout } = await runProcessSafe(
      bins.ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        startSec.toFixed(3),
        '-t',
        safeDur.toFixed(3),
        '-i',
        inputPath,
        '-vf',
        `fps=${Math.max(0.15, sampleFps)},scale=${sampleW}:${sampleH}`,
        '-frames:v',
        '5',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'gray',
        'pipe:1',
      ],
      {
        signal: options.signal,
        timeoutMs: 12_000,
        activeProcesses: options.activeProcesses,
      }
    );

    const frameSize = sampleW * sampleH;
    const frameCount = Math.floor(stdout.length / frameSize);
    if (frameCount < 1) return 0.5;

    const colScores = new Float64Array(sampleW);

    // Weight upper-middle rows (speaker head/shoulders) higher than bottom edge
    for (let f = 0; f < frameCount; f++) {
      const base = f * frameSize;
      for (let y = 3; y < sampleH - 5; y++) {
        const rowWeight = y >= 5 && y <= 24 ? 1.5 : 0.8;
        const rowOffset = base + y * sampleW;
        for (let x = 1; x < sampleW - 1; x++) {
          const gx = Math.abs(stdout[rowOffset + x + 1] - stdout[rowOffset + x - 1]);
          const gy = Math.abs(stdout[rowOffset + sampleW + x] - stdout[rowOffset - sampleW + x]);
          colScores[x] += (gx + gy) * rowWeight;
        }
      }
    }

    // Sliding window matching a 9:16 width fraction relative to source aspect ratio
    const targetAr = 9 / 16;
    const windowCols = Math.max(8, Math.min(sampleW - 2, Math.round((sampleW * targetAr) / sourceAr)));
    const halfWin = windowCols / 2;

    let bestCenterCol = sampleW / 2;
    let bestScore = -1;

    for (let startCol = 0; startCol <= sampleW - windowCols; startCol++) {
      let sum = 0;
      for (let x = startCol; x < startCol + windowCols; x++) {
        sum += colScores[x];
      }
      const centerCol = startCol + halfWin;
      // Gentle center prior (prevents locking onto noisy border logos unless a speaker is clearly off-center)
      const distFromCenter = Math.abs(centerCol / sampleW - 0.5);
      const prior = 1 - distFromCenter * 0.18;
      const weighted = sum * prior;

      if (weighted > bestScore) {
        bestScore = weighted;
        bestCenterCol = centerCol;
      }
    }

    const normalized = bestCenterCol / sampleW;
    return Number(Math.min(0.82, Math.max(0.18, normalized)).toFixed(4));
  } catch {
    return 0.5;
  }
}

export interface VideoExportSpec {
  targetWidth: number;
  targetHeight: number;
  useFilterComplex: boolean;
  filterArg: string;
  framingApplied: FramingModeOption | 'original';
  targetFps: number;
}

export function buildVideoExportSpec(
  sourceMeta: ProbedMediaMetadata,
  settings: ExportSettings,
  focusCenterX = 0.5
): VideoExportSpec {
  const effW = sourceMeta.effectiveWidth;
  const effH = sourceMeta.effectiveHeight;
  const sourceAr = effW / effH;

  let targetW: number;
  let targetH: number;

  if (settings.aspectRatio === '9:16') {
    if (settings.resolution === '1080p') {
      targetW = 1080;
      targetH = 1920;
    } else if (settings.resolution === '720p') {
      targetW = 720;
      targetH = 1280;
    } else {
      // Original resolution density in 9:16 without artificial upscaling
      if (sourceAr >= 9 / 16) {
        targetH = toEven(effH);
        targetW = toEven((targetH * 9) / 16);
      } else {
        targetW = toEven(effW);
        targetH = toEven((targetW * 16) / 9);
      }
    }
  } else if (settings.aspectRatio === '16:9') {
    if (settings.resolution === '1080p') {
      targetW = 1920;
      targetH = 1080;
    } else if (settings.resolution === '720p') {
      targetW = 1280;
      targetH = 720;
    } else {
      if (sourceAr >= 16 / 9) {
        targetH = toEven(effH);
        targetW = toEven((targetH * 16) / 9);
      } else {
        targetW = toEven(effW);
        targetH = toEven((targetW * 9) / 16);
      }
    }
  } else if (settings.aspectRatio === '1:1') {
    if (settings.resolution === '1080p') {
      targetW = 1080;
      targetH = 1080;
    } else if (settings.resolution === '720p') {
      targetW = 720;
      targetH = 720;
    } else {
      const side = toEven(Math.min(effW, effH));
      targetW = side;
      targetH = side;
    }
  } else {
    // 'original' aspect ratio
    if (settings.resolution === '1080p') {
      if (effW >= effH) {
        targetH = 1080;
        targetW = toEven(1080 * sourceAr);
      } else {
        targetW = 1080;
        targetH = toEven(1080 / sourceAr);
      }
    } else if (settings.resolution === '720p') {
      if (effW >= effH) {
        targetH = 720;
        targetW = toEven(720 * sourceAr);
      } else {
        targetW = 720;
        targetH = toEven(720 / sourceAr);
      }
    } else {
      targetW = toEven(effW);
      targetH = toEven(effH);
    }
  }

  const targetAr = targetW / targetH;
  const fpsNum =
    settings.fps === 'original' ? Number(sourceMeta.fps.toFixed(3)) : Number.parseInt(settings.fps, 10);
  const fpsFilterSuffix = settings.fps === 'original' ? '' : `,fps=${fpsNum}`;

  // If aspect ratio matches source closely (<2% diff) or aspectRatio === 'original'
  if (settings.aspectRatio === 'original' || Math.abs(sourceAr - targetAr) < 0.02) {
    const vf = `scale=${targetW}:${targetH}:flags=bicubic,setsar=1${fpsFilterSuffix}`;
    return {
      targetWidth: targetW,
      targetHeight: targetH,
      useFilterComplex: false,
      filterArg: vf,
      framingApplied: 'original',
      targetFps: fpsNum,
    };
  }

  // Fit with blurred cinema background (preserves 100% of frame without distortion or cropping)
  if (settings.framingMode === 'fit_blur') {
    const fc =
      `[0:v]split=2[bg][fg];` +
      `[bg]scale=${targetW}:${targetH}:force_original_aspect_ratio=increase:flags=bicubic,` +
      `crop=${targetW}:${targetH},boxblur=20:2,eq=brightness=-0.18:saturation=0.85[bg2];` +
      `[fg]scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease:flags=bicubic[fg2];` +
      `[bg2][fg2]overlay=(W-w)/2:(H-h)/2,setsar=1${fpsFilterSuffix}[vout]`;

    return {
      targetWidth: targetW,
      targetHeight: targetH,
      useFilterComplex: true,
      filterArg: fc,
      framingApplied: 'fit_blur',
      targetFps: fpsNum,
    };
  }

  // Distortion-free crop (either dead-center `crop_center` or subject-aware `smart_crop`)
  let cropW: number;
  let cropH: number;
  let cropX: number;
  let cropY: number;

  if (sourceAr > targetAr) {
    // Source is wider than target (e.g. 16:9 -> 9:16 or 1:1): crop horizontally
    cropH = effH;
    cropW = Math.min(effW, Math.max(2, Math.floor(cropH * targetAr)));
    cropW = cropW % 2 === 0 ? cropW : cropW - 1;
    cropH = cropH % 2 === 0 ? cropH : cropH - 1;

    if (settings.framingMode === 'smart_crop') {
      const desiredCenterPx = focusCenterX * effW;
      const rawX = Math.round(desiredCenterPx - cropW / 2);
      cropX = Math.max(0, Math.min(effW - cropW, rawX));
    } else {
      cropX = Math.floor((effW - cropW) / 2);
    }
    cropY = Math.floor((effH - cropH) / 2);
  } else {
    // Source is taller than target (e.g. 9:16 -> 16:9 or 1:1): crop vertically
    cropW = effW;
    cropH = Math.min(effH, Math.max(2, Math.floor(cropW / targetAr)));
    cropW = cropW % 2 === 0 ? cropW : cropW - 1;
    cropH = cropH % 2 === 0 ? cropH : cropH - 1;
    cropX = Math.floor((effW - cropW) / 2);
    // For smart_crop on vertical source, bias slightly upward (0.38) where faces typically sit
    const verticalBias = settings.framingMode === 'smart_crop' ? 0.38 : 0.5;
    cropY = Math.max(0, Math.min(effH - cropH, Math.round((effH - cropH) * verticalBias)));
  }

  const vf = `crop=${cropW}:${cropH}:${cropX}:${cropY},scale=${targetW}:${targetH}:flags=bicubic,setsar=1${fpsFilterSuffix}`;
  return {
    targetWidth: targetW,
    targetHeight: targetH,
    useFilterComplex: false,
    filterArg: vf,
    framingApplied: settings.framingMode,
    targetFps: fpsNum,
  };
}

function parseOutTimeToSeconds(outTimeStr: string): number | null {
  // Format: HH:MM:SS.mmmmmm
  const match = outTimeStr.trim().match(/^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  const s = Number(match[3]);
  if (!Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(s)) return null;
  return h * 3600 + m * 60 + s;
}

export interface ClipRenderProgress {
  clipFraction: number; // 0..1
  renderedSec: number;
  fps?: number;
  speed?: string;
}

export interface RenderClipParams {
  inputPath: string;
  outputPath: string;
  startSec: number;
  endSec: number;
  sourceMeta: ProbedMediaMetadata;
  settings: ExportSettings;
  focusCenterX?: number;
  signal?: AbortSignal;
  activeProcesses?: Set<ChildProcess>;
  onProgress?: (prog: ClipRenderProgress) => void;
}

export async function renderClipWithFFmpeg(params: RenderClipParams): Promise<{
  exportSpec: VideoExportSpec;
  stderrTail: string;
}> {
  const bins = await verifyMediaBinaries();
  if (!bins.available) {
    throw new MediaProcessingError(bins.error || 'FFmpeg indisponível no servidor.', 'BINARY_MISSING');
  }

  const clipDuration = Number((params.endSec - params.startSec).toFixed(3));
  if (clipDuration <= 0.2) {
    throw new MediaProcessingError('Intervalo de corte inválido (duração menor ou igual a zero).', 'INVALID_INTERVAL');
  }

  const exportSpec = buildVideoExportSpec(params.sourceMeta, params.settings, params.focusCenterX ?? 0.5);

  // Hybrid demuxer + decoder seeking for fast AND frame-accurate A/V sync
  const fastSeek = Math.max(0, Number((params.startSec - 4).toFixed(3)));
  const accurateSeek = Number((params.startSec - fastSeek).toFixed(3));

  const args: string[] = [
    '-hide_banner',
    '-y',
    '-ss',
    fastSeek.toFixed(3),
    '-i',
    params.inputPath,
    '-ss',
    accurateSeek.toFixed(3),
    '-t',
    clipDuration.toFixed(3),
  ];

  if (exportSpec.useFilterComplex) {
    args.push('-filter_complex', exportSpec.filterArg, '-map', '[vout]');
  } else {
    args.push('-vf', exportSpec.filterArg, '-map', '0:v:0');
  }

  if (params.sourceMeta.hasAudio) {
    args.push('-map', '0:a:0?');
  } else {
    args.push('-an');
  }

  // H.264 video encoding + configurable quality / bitrate
  args.push(
    '-c:v',
    'libx264',
    '-preset',
    params.settings.quality === 'high' ? 'fast' : 'veryfast',
    '-profile:v',
    'high',
    '-pix_fmt',
    'yuv420p',
    '-threads',
    String(CONFIG.ffmpegThreadsPerProc)
  );

  if (params.settings.videoBitrateKbps) {
    const vb = `${params.settings.videoBitrateKbps}k`;
    const buf = `${params.settings.videoBitrateKbps * 2}k`;
    args.push('-b:v', vb, '-maxrate', vb, '-bufsize', buf);
  } else {
    const crfMap = { high: '19', medium: '23', low: '27' } as const;
    const maxRateMap = { high: '6500k', medium: '3800k', low: '1800k' } as const;
    const bufSizeMap = { high: '13000k', medium: '7600k', low: '3600k' } as const;
    args.push(
      '-crf',
      crfMap[params.settings.quality],
      '-maxrate',
      maxRateMap[params.settings.quality],
      '-bufsize',
      bufSizeMap[params.settings.quality]
    );
  }

  // AAC audio encoding + PTS alignment to preserve exact A/V sync
  if (params.sourceMeta.hasAudio) {
    const defaultAudioBitrate = { high: 192, medium: 160, low: 128 }[params.settings.quality];
    const audioBitrate = params.settings.audioBitrateKbps || defaultAudioBitrate;
    args.push(
      '-af',
      'aresample=async=1:first_pts=0',
      '-c:a',
      'aac',
      '-b:a',
      `${audioBitrate}k`,
      '-ar',
      '48000',
      '-ac',
      '2'
    );
  }

  args.push(
    '-avoid_negative_ts',
    'make_zero',
    '-movflags',
    '+faststart',
    '-progress',
    'pipe:1',
    '-nostats',
    params.outputPath
  );

  let stdoutCarry = '';
  let currentFps: number | undefined;
  let currentSpeed: string | undefined;
  let currentRenderedSec = 0;

  const { stderrTail } = await runProcessSafe(bins.ffmpegPath, args, {
    signal: params.signal,
    timeoutMs: CONFIG.ffmpegClipTimeoutMs,
    activeProcesses: params.activeProcesses,
    collectStdout: false,
    onStdoutChunk: (chunk) => {
      if (!params.onProgress) return;
      stdoutCarry += chunk.toString('utf8');
      const lines = stdoutCarry.split(/\r?\n/);
      stdoutCarry = lines.pop() || '';

      for (const line of lines) {
        const eqIdx = line.indexOf('=');
        if (eqIdx <= 0) continue;
        const key = line.slice(0, eqIdx).trim();
        const val = line.slice(eqIdx + 1).trim();

        if (key === 'fps') {
          const n = Number(val);
          if (Number.isFinite(n) && n > 0) currentFps = n;
        } else if (key === 'speed') {
          if (val && val !== 'N/A') currentSpeed = val;
        } else if (key === 'out_time') {
          const sec = parseOutTimeToSeconds(val);
          if (sec !== null && sec >= 0) {
            currentRenderedSec = sec;
          }
        } else if (key === 'out_time_us' && currentRenderedSec === 0) {
          const us = Number(val);
          if (Number.isFinite(us) && us > 0) {
            currentRenderedSec = us / 1_000_000;
          }
        } else if (key === 'progress') {
          const frac = val === 'end' ? 1 : Math.min(0.995, Math.max(0, currentRenderedSec / clipDuration));
          params.onProgress({
            clipFraction: frac,
            renderedSec: Math.min(clipDuration, currentRenderedSec),
            fps: currentFps,
            speed: currentSpeed,
          });
        }
      }
    },
  });

  return { exportSpec, stderrTail };
}

export async function validateRenderedClip(
  clipPath: string,
  expectedDurationSec: number,
  expectAudio: boolean,
  expectedWidth: number,
  expectedHeight: number,
  options: { signal?: AbortSignal; activeProcesses?: Set<ChildProcess> } = {}
): Promise<ProbedMediaMetadata> {
  const probed = await probeMediaFile(clipPath, options);

  if (probed.sizeBytes < 1024) {
    throw new MediaProcessingError(
      `O arquivo MP4 gerado está corrompido ou truncado (${probed.sizeBytes} bytes).`,
      'VALIDATION_SIZE_TOO_SMALL'
    );
  }

  if (!probed.formatName.includes('mp4') && !probed.formatName.includes('mov')) {
    throw new MediaProcessingError(
      `Container inesperado no arquivo renderizado: ${probed.formatName}`,
      'VALIDATION_BAD_CONTAINER'
    );
  }

  if (probed.videoCodec !== 'h264') {
    throw new MediaProcessingError(
      `Codec de vídeo inesperado no corte gerado: ${probed.videoCodec} (esperado h264).`,
      'VALIDATION_BAD_VCODEC'
    );
  }

  if (probed.effectiveWidth !== expectedWidth || probed.effectiveHeight !== expectedHeight) {
    throw new MediaProcessingError(
      `Dimensões do corte (${probed.effectiveWidth}x${probed.effectiveHeight}) diferem da configuração (${expectedWidth}x${expectedHeight}).`,
      'VALIDATION_BAD_DIMENSIONS'
    );
  }

  const tolerance = Math.max(2.0, expectedDurationSec * 0.18);
  if (Math.abs(probed.durationSec - expectedDurationSec) > tolerance) {
    throw new MediaProcessingError(
      `Duração do corte (${probed.durationSec.toFixed(1)}s) diverge significativamente do intervalo esperado (${expectedDurationSec.toFixed(1)}s).`,
      'VALIDATION_BAD_DURATION'
    );
  }

  if (expectAudio && (!probed.hasAudio || probed.audioCodec !== 'aac')) {
    throw new MediaProcessingError(
      'A faixa de áudio AAC não foi preservada corretamente no corte gerado.',
      'VALIDATION_MISSING_AUDIO'
    );
  }

  return probed;
}

export async function extractFrameThumbnail(
  clipPath: string,
  outputJpgPath: string,
  clipDurationSec: number,
  options: { signal?: AbortSignal; activeProcesses?: Set<ChildProcess> } = {}
): Promise<boolean> {
  const bins = await verifyMediaBinaries();
  if (!bins.available) return false;

  const seekSec = Math.max(0, Math.min(clipDurationSec * 0.25, 2.5));
  try {
    await runProcessSafe(
      bins.ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-ss',
        seekSec.toFixed(3),
        '-i',
        clipPath,
        '-frames:v',
        '1',
        '-vf',
        'scale=480:-2',
        '-q:v',
        '4',
        outputJpgPath,
      ],
      {
        signal: options.signal,
        timeoutMs: 15_000,
        activeProcesses: options.activeProcesses,
      }
    );
    const st = await fs.promises.stat(outputJpgPath);
    return st.size > 200;
  } catch {
    return false;
  }
}

export async function extractAudioForWhisper(
  inputPath: string,
  outputMp3Path: string,
  maxDurationSec = 2400,
  options: { signal?: AbortSignal; activeProcesses?: Set<ChildProcess> } = {}
): Promise<boolean> {
  const bins = await verifyMediaBinaries();
  if (!bins.available) return false;

  try {
    await runProcessSafe(
      bins.ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        inputPath,
        '-t',
        String(maxDurationSec),
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'libmp3lame',
        '-b:a',
        '48k',
        outputMp3Path,
      ],
      {
        signal: options.signal,
        timeoutMs: 90_000,
        activeProcesses: options.activeProcesses,
      }
    );
    const st = await fs.promises.stat(outputMp3Path);
    // Groq Whisper accepts files up to 25 MB
    return st.size > 512 && st.size <= 24 * 1024 * 1024;
  } catch {
    return false;
  }
}

/**
 * Uses FFmpeg `silencedetect` to find natural speech boundaries in the video's audio track,
 * allowing cuts to align cleanly with real speech pauses when external captions aren't present.
 */
export async function detectSpeechBoundaries(
  inputPath: string,
  durationSec: number,
  options: { signal?: AbortSignal; activeProcesses?: Set<ChildProcess> } = {}
): Promise<Array<{ start: number; dur: number; text: string }>> {
  const bins = await verifyMediaBinaries();
  if (!bins.available) return [];

  const analyzeLimit = Math.min(durationSec, 3600);
  try {
    const { stderrTail } = await runProcessSafe(
      bins.ffmpegPath,
      [
        '-hide_banner',
        '-i',
        inputPath,
        '-t',
        analyzeLimit.toFixed(2),
        '-vn',
        '-af',
        'silencedetect=noise=-32dB:d=0.45',
        '-f',
        'null',
        '-',
      ],
      {
        signal: options.signal,
        timeoutMs: 35_000,
        activeProcesses: options.activeProcesses,
      }
    );

    const silenceStarts: number[] = [];
    const silenceEnds: number[] = [];
    const lines = stderrTail.split(/\r?\n/);

    for (const line of lines) {
      const startMatch = line.match(/silence_start:\s*([0-9.]+)/);
      if (startMatch) silenceStarts.push(Number(startMatch[1]));
      const endMatch = line.match(/silence_end:\s*([0-9.]+)/);
      if (endMatch) silenceEnds.push(Number(endMatch[1]));
    }

    const segments: Array<{ start: number; dur: number; text: string }> = [];
    let speechCursor = 0;

    for (let i = 0; i < silenceStarts.length; i++) {
      const sStart = silenceStarts[i];
      if (sStart - speechCursor >= 2.0) {
        segments.push({
          start: Number(speechCursor.toFixed(2)),
          dur: Number((sStart - speechCursor).toFixed(2)),
          text: `Segmento de fala ativa (${speechCursor.toFixed(1)}s - ${sStart.toFixed(1)}s)`,
        });
      }
      if (silenceEnds[i] !== undefined) {
        speechCursor = silenceEnds[i];
      }
    }

    if (analyzeLimit - speechCursor >= 2.0) {
      segments.push({
        start: Number(speechCursor.toFixed(2)),
        dur: Number((analyzeLimit - speechCursor).toFixed(2)),
        text: `Segmento de fala ativa (${speechCursor.toFixed(1)}s - ${analyzeLimit.toFixed(1)}s)`,
      });
    }

    return segments;
  } catch {
    return [];
  }
}
