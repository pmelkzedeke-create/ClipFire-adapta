import 'dotenv/config';
import type * as ArchiverTypes from 'archiver';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const archiverPkg: any = require('archiver');
function createZipArchive(options?: ArchiverTypes.ArchiverOptions): ArchiverTypes.Archiver {
  if (typeof archiverPkg === 'function') {
    return archiverPkg('zip', options);
  }
  if (typeof archiverPkg?.default === 'function') {
    return archiverPkg.default('zip', options);
  }
  if (typeof archiverPkg?.ZipArchive === 'function') {
    return new archiverPkg.ZipArchive(options);
  }
  throw new Error('Pacote archiver incompatível para geração de ZIP.');
}
import express, { NextFunction, Request, Response } from 'express';
import fs from 'fs';
import http from 'http';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import zlib from 'zlib';
import { CONFIG, ensureRuntimeDirectories, sanitizeExportSettings } from './server/config.js';
import { verifyMediaBinaries } from './server/ffmpeg.js';
import {
  cancelProcessingJob,
  createAndStartProcessingJob,
  deleteJobById,
  getJobById,
  initJobManager,
  isJobActiveStatus,
  jobEvents,
  listRecentJobs,
  purgeAllInactiveJobs,
} from './server/jobManager.js';
import {
  getAuthenticatedAdminSession,
  getPublicSiteConfig,
  registerAdminRoutes,
} from './server/adminVault.js';
import {
  assertSafeStorageSegment,
  getStorageProvider,
  verifySignedToken,
} from './server/storage.js';
import {
  assertSafeExternalUrl,
  isYouTubeWatchOrShareUrl,
  validateUploadedFileExtensionAndMime,
  VideoSourceError,
} from './server/videoSource.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

ensureRuntimeDirectories();

const app = express();
app.disable('x-powered-by');
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '2mb' }));

// Fast gzip compression for JSON payloads >1KB (never touches SSE or MP4/ZIP streams)
app.use((req: Request, res: Response, next: NextFunction) => {
  const acceptEncoding = req.headers['accept-encoding'] || '';
  if (!acceptEncoding.includes('gzip')) {
    next();
    return;
  }
  const origJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    const payload = JSON.stringify(body);
    if (!payload || payload.length < 1024 || res.headersSent) {
      return origJson(body);
    }
    const compressed = zlib.gzipSync(Buffer.from(payload, 'utf8'), { level: 4 });
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('Content-Length', String(compressed.length));
    return res.send(compressed);
  }) as typeof res.json;
  next();
});

// Disk-streamed multipart upload (never buffers large videos in memory)
const uploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    fs.mkdirSync(CONFIG.uploadsDir, { recursive: true });
    cb(null, CONFIG.uploadsDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8) || '.mp4';
    cb(null, `upload_${Date.now()}_${crypto.randomUUID()}${ext}`);
  },
});

const uploadMiddleware = multer({
  storage: uploadStorage,
  limits: {
    fileSize: CONFIG.maxUploadBytes,
    files: 1,
  },
});

function runSingleVideoUpload(req: Request, res: Response): Promise<void> {
  return new Promise((resolve, reject) => {
    const handler = uploadMiddleware.single('videoFile');
    handler(req, res, (err: any) => {
      if (!err) {
        resolve();
        return;
      }
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          reject(
            new VideoSourceError(
              `O arquivo de vídeo excede o limite máximo permitido de ${CONFIG.maxUploadSizeMb} MB.`,
              'FILE_TOO_LARGE',
              413
            )
          );
          return;
        }
        reject(new VideoSourceError(`Erro no upload do arquivo: ${err.message}`, 'UPLOAD_ERROR', 400));
        return;
      }
      reject(err);
    });
  });
}

// -----------------------------------------------------------------------------
// PAINEL ADMIN DE SEGURANÇA MÁXIMA & CONFIGURAÇÃO GLOBAL DE DESIGN
// -----------------------------------------------------------------------------

registerAdminRoutes(app, {
  listRecentJobs,
  cancelProcessingJob,
  deleteJobById,
  purgeAllInactiveJobs,
  verifyMediaBinaries,
});

// -----------------------------------------------------------------------------
// ENDPOINTS DE STATUS & INFRAESTRUTURA
// -----------------------------------------------------------------------------

app.get('/api/status', async (_req: Request, res: Response) => {
  const binaries = await verifyMediaBinaries();
  const storage = getStorageProvider();

  res.json({
    status: binaries.available ? 'online' : 'degraded',
    ffmpegAvailable: binaries.available,
    ffmpegVersion: binaries.ffmpegVersion,
    ffprobeVersion: binaries.ffprobeVersion,
    encoders: binaries.encoders,
    ffmpegError: binaries.error,
    groqConfigured: Boolean(process.env.GROQ_API_KEY),
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    storageDriver: storage.driverName,
    processingMode: CONFIG.processingMode,
    limits: {
      maxUploadSizeMb: CONFIG.maxUploadSizeMb,
      maxVideoDurationSec: CONFIG.maxVideoDurationSec,
      maxClipsPerJob: CONFIG.maxClipsPerJob,
      maxConcurrentJobs: CONFIG.maxConcurrentJobs,
      maxFfmpegConcurrency: CONFIG.maxFfmpegConcurrency,
    },
    timestamp: new Date().toISOString(),
  });
});

// -----------------------------------------------------------------------------
// CRIAÇÃO E GERENCIAMENTO DE JOBS DE PROCESSAMENTO REAL (FFMPEG + IA)
// -----------------------------------------------------------------------------

app.post('/api/jobs', async (req: Request, res: Response) => {
  let tempUploadPath: string | undefined;

  try {
    const siteCfg = getPublicSiteConfig();
    if (siteCfg.maintenanceMode && !getAuthenticatedAdminSession(req)) {
      res.status(503).json({
        error: siteCfg.maintenanceMessage || 'Sistema temporariamente em manutenção pelo Administrador.',
        code: 'MAINTENANCE_MODE',
      });
      return;
    }

    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('multipart/form-data')) {
      await runSingleVideoUpload(req, res);
      tempUploadPath = req.file?.path;
    }

    // 1. Check FFmpeg / FFprobe availability
    const binaries = await verifyMediaBinaries();
    if (!binaries.available) {
      if (tempUploadPath) await fs.promises.unlink(tempUploadPath).catch(() => {});
      res.status(503).json({
        error: binaries.error || 'FFmpeg e FFprobe não estão disponíveis no servidor.',
        code: 'BINARY_MISSING',
      });
      return;
    }

    // 2. Verify user authorization declaration
    const rawAuth = req.body?.userAuthorized;
    const isAuthorized = rawAuth === true || rawAuth === 'true' || rawAuth === '1' || rawAuth === 'on';
    if (!isAuthorized) {
      if (tempUploadPath) await fs.promises.unlink(tempUploadPath).catch(() => {});
      res.status(400).json({
        error: 'Confirme que você possui autorização legal ou direitos sobre o vídeo antes de iniciar o processamento.',
        code: 'AUTHORIZATION_REQUIRED',
      });
      return;
    }

    // 3. Parse & sanitize export settings strictly against whitelists
    let parsedSettingsRaw: unknown = req.body?.exportSettings;
    if (typeof parsedSettingsRaw === 'string') {
      try {
        parsedSettingsRaw = JSON.parse(parsedSettingsRaw);
      } catch {
        parsedSettingsRaw = {};
      }
    } else if (!parsedSettingsRaw && req.body) {
      parsedSettingsRaw = {
        aspectRatio: req.body.aspectRatio,
        resolution: req.body.resolution,
        framingMode: req.body.framingMode,
        fps: req.body.fps,
        quality: req.body.quality,
        videoBitrateKbps: req.body.videoBitrateKbps,
        audioBitrateKbps: req.body.audioBitrateKbps,
        maxClips: req.body.maxClips,
      };
    }
    const exportSettings = sanitizeExportSettings(parsedSettingsRaw);

    const authorizedMediaUrl =
      typeof req.body?.authorizedMediaUrl === 'string'
        ? req.body.authorizedMediaUrl.trim()
        : typeof req.body?.mediaUrl === 'string'
        ? req.body.mediaUrl.trim()
        : '';

    const youtubeRefUrl =
      typeof req.body?.youtubeRefUrl === 'string' ? req.body.youtubeRefUrl.trim() : '';

    const customTitle =
      typeof req.body?.customTitle === 'string' ? req.body.customTitle.trim().slice(0, 140) : '';

    const forceReprocess = req.body?.forceReprocess === true || req.body?.forceReprocess === 'true';

    // 4. Validate video source
    if (req.file && tempUploadPath) {
      validateUploadedFileExtensionAndMime(req.file.originalname, req.file.mimetype);

      const { job, deduplicated } = await createAndStartProcessingJob({
        uploadedFile: {
          tempFilePath: tempUploadPath,
          originalName: req.file.originalname,
          mimeType: req.file.mimetype,
          sizeBytes: req.file.size,
        },
        youtubeRefUrl: youtubeRefUrl || undefined,
        customTitle: customTitle || undefined,
        exportSettings,
        forceReprocess,
      });

      // Ownership of tempUploadPath transferred to job pipeline
      tempUploadPath = undefined;

      res.status(deduplicated ? 200 : 202).json({
        success: true,
        deduplicated,
        jobId: job.id,
        job,
      });
      return;
    }

    if (req.body?.providerName === 'google_drive' && typeof req.body?.providerFileId === 'string') {
      const { job, deduplicated } = await createAndStartProcessingJob({
        providerSource: {
          name: 'google_drive',
          fileId: req.body.providerFileId.trim(),
          accessToken:
            typeof req.body.providerAccessToken === 'string' ? req.body.providerAccessToken.trim() : undefined,
        },
        youtubeRefUrl: youtubeRefUrl || undefined,
        customTitle: customTitle || undefined,
        exportSettings,
        forceReprocess,
      });

      res.status(deduplicated ? 200 : 202).json({
        success: true,
        deduplicated,
        jobId: job.id,
        job,
      });
      return;
    }

    if (authorizedMediaUrl) {
      if (isYouTubeWatchOrShareUrl(authorizedMediaUrl)) {
        res.status(422).json({
          error:
            'Uma URL do YouTube não é um arquivo de mídia baixável diretamente e o ClipFire não contorna restrições de acesso ou DRM. Envie o arquivo de vídeo autorizado (.mp4, .mov, .webm, .mkv) do seu dispositivo (você pode manter o link do YouTube como referência opcional de título e legendas) ou informe uma URL direta autorizada para o arquivo de vídeo.',
          code: 'YOUTUBE_DIRECT_MEDIA_REQUIRED',
        });
        return;
      }

      await assertSafeExternalUrl(authorizedMediaUrl);

      const { job, deduplicated } = await createAndStartProcessingJob({
        authorizedMediaUrl,
        youtubeRefUrl: youtubeRefUrl || undefined,
        customTitle: customTitle || undefined,
        exportSettings,
        forceReprocess,
      });

      res.status(deduplicated ? 200 : 202).json({
        success: true,
        deduplicated,
        jobId: job.id,
        job,
      });
      return;
    }

    if (youtubeRefUrl) {
      res.status(422).json({
        error:
          'Você informou apenas uma URL do YouTube. Para gerar cortes reais em MP4 com FFmpeg sem violar proteções da plataforma, selecione também o arquivo de vídeo autorizado (.mp4, .mov, .webm, .mkv) no seu dispositivo ou informe uma URL direta para o arquivo de mídia.',
        code: 'MEDIA_FILE_REQUIRED',
      });
      return;
    }

    res.status(400).json({
      error:
        'Nenhum vídeo foi fornecido. Faça upload de um arquivo de vídeo (.mp4, .mov, .webm, .mkv) ou forneça uma URL direta autorizada para a mídia.',
      code: 'MISSING_VIDEO_SOURCE',
    });
  } catch (err: any) {
    if (tempUploadPath) {
      await fs.promises.unlink(tempUploadPath).catch(() => {});
    }
    const status = err instanceof VideoSourceError ? err.statusCode : 500;
    const code = err?.code || 'JOB_CREATE_ERROR';
    res.status(status).json({
      error: err?.message || 'Erro ao iniciar processamento do vídeo.',
      code,
    });
  }
});

app.get('/api/jobs', async (_req: Request, res: Response) => {
  const jobs = await listRecentJobs(25);
  res.json({ success: true, jobs });
});

app.get('/api/jobs/:jobId', async (req: Request, res: Response) => {
  const job = await getJobById(String(req.params.jobId || ''));
  if (!job) {
    res.status(404).json({ error: 'Processamento não encontrado ou expirado.', code: 'JOB_NOT_FOUND' });
    return;
  }
  res.json({ success: true, job });
});

// Server-Sent Events (SSE) for real-time FFmpeg progress updates
app.get('/api/jobs/:jobId/events', async (req: Request, res: Response) => {
  const jobId = String(req.params.jobId || '');
  const initialJob = await getJobById(jobId);
  if (!initialJob) {
    res.status(404).json({ error: 'Processamento não encontrado.', code: 'JOB_NOT_FOUND' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const sendEvent = (payload: unknown) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  sendEvent(initialJob);

  if (!isJobActiveStatus(initialJob.status)) {
    res.end();
    return;
  }

  const listener = (updatedJob: any) => {
    sendEvent(updatedJob);
    if (!isJobActiveStatus(updatedJob.status)) {
      cleanup();
      res.end();
    }
  };

  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 15000);
  heartbeat.unref?.();

  const cleanup = () => {
    clearInterval(heartbeat);
    jobEvents.removeListener(`job:${jobId}`, listener);
  };

  jobEvents.on(`job:${jobId}`, listener);
  req.on('close', cleanup);
});

// Real cancellation endpoint: kills active FFmpeg processes & removes temp files
app.post('/api/jobs/:jobId/cancel', async (req: Request, res: Response) => {
  const jobId = String(req.params.jobId || '');
  const cancelled = await cancelProcessingJob(jobId);
  if (!cancelled) {
    res.status(404).json({ error: 'Processamento não encontrado.', code: 'JOB_NOT_FOUND' });
    return;
  }
  res.json({
    success: true,
    message: 'Processamento cancelado e processos FFmpeg encerrados.',
    job: cancelled,
  });
});

// -----------------------------------------------------------------------------
// STREAMING DE PRÉVIA (HTTP RANGE) E DOWNLOAD DE MP4 ASSINADO
// -----------------------------------------------------------------------------

app.get('/api/media/:jobId/:fileName', async (req: Request, res: Response) => {
  try {
    const jobId = String(req.params.jobId || '');
    const fileName = String(req.params.fileName || '');
    assertSafeStorageSegment(jobId, fileName);

    const exp = Number(req.query.exp);
    const dlFlag = req.query.dl === '1' ? '1' : '0';
    const sig = String(req.query.sig || '');

    if (!verifySignedToken(`media:${jobId}:${fileName}:${dlFlag}`, exp, sig)) {
      res.status(403).json({ error: 'URL de mídia expirada ou assinatura inválida.', code: 'INVALID_SIGNATURE' });
      return;
    }

    const storage = getStorageProvider();
    const check = await storage.artifactExists(jobId, fileName);
    if (!check.exists || check.sizeBytes <= 0) {
      res.status(404).json({ error: 'Arquivo de mídia não encontrado no armazenamento.', code: 'MEDIA_NOT_FOUND' });
      return;
    }

    const isMp4 = fileName.endsWith('.mp4');
    const contentType = isMp4 ? 'video/mp4' : fileName.endsWith('.jpg') ? 'image/jpeg' : 'application/octet-stream';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=3600');

    if (dlFlag === '1') {
      const requestedName = typeof req.query.name === 'string' ? req.query.name : fileName;
      const safeDownloadName = requestedName.replace(/[^\w.\- ]+/g, '_').slice(0, 100) || fileName;
      res.setHeader('Content-Disposition', `attachment; filename="${safeDownloadName}"`);
    } else {
      res.setHeader('Content-Disposition', 'inline');
    }

    const totalSize = check.sizeBytes;
    const rangeHeader = req.headers.range;

    if (req.method === 'HEAD') {
      res.setHeader('Content-Length', String(totalSize));
      res.status(200).end();
      return;
    }

    if (rangeHeader && isMp4) {
      const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
      if (match) {
        const start = match[1] ? Number.parseInt(match[1], 10) : 0;
        const end = match[2] ? Number.parseInt(match[2], 10) : totalSize - 1;

        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= totalSize) {
          res.status(416).setHeader('Content-Range', `bytes */${totalSize}`).end();
          return;
        }

        const clampedEnd = Math.min(end, totalSize - 1);
        const chunkSize = clampedEnd - start + 1;

        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${clampedEnd}/${totalSize}`);
        res.setHeader('Content-Length', String(chunkSize));

        const stream = await storage.openArtifactStream(jobId, fileName, { start, end: clampedEnd });
        stream.on('error', () => {
          if (!res.headersSent) res.status(500).end();
          else res.destroy();
        });
        stream.pipe(res);
        return;
      }
    }

    res.status(200);
    res.setHeader('Content-Length', String(totalSize));
    const stream = await storage.openArtifactStream(jobId, fileName);
    stream.on('error', () => {
      if (!res.headersSent) res.status(500).end();
      else res.destroy();
    });
    stream.pipe(res);
  } catch (err: any) {
    if (!res.headersSent) {
      res.status(400).json({ error: err?.message || 'Requisição de mídia inválida.' });
    }
  }
});

// -----------------------------------------------------------------------------
// DOWNLOAD REAL DE TODOS OS CORTES EM UM ÚNICO ARQUIVO ZIP
// -----------------------------------------------------------------------------

app.get('/api/jobs/:jobId/download-zip', async (req: Request, res: Response) => {
  try {
    const jobId = String(req.params.jobId || '');
    assertSafeStorageSegment(jobId);

    const exp = Number(req.query.exp);
    const sig = String(req.query.sig || '');
    if (!verifySignedToken(`zip:${jobId}`, exp, sig)) {
      res.status(403).json({ error: 'Link de download ZIP expirado ou inválido.', code: 'INVALID_SIGNATURE' });
      return;
    }

    const job = await getJobById(jobId);
    if (!job || job.status !== 'completed' || !job.cuts || job.cuts.length === 0) {
      res.status(404).json({ error: 'Cortes não disponíveis para compactação ZIP.', code: 'JOB_NOT_READY' });
      return;
    }

    const storage = getStorageProvider();
    const verifiedClips = [];
    for (const clip of job.cuts) {
      if (!clip.validated || !clip.fileName) continue;
      const check = await storage.artifactExists(jobId, clip.fileName);
      if (check.exists && check.sizeBytes > 0) {
        verifiedClips.push(clip);
      }
    }

    if (verifiedClips.length === 0) {
      res.status(404).json({
        error: 'Os arquivos MP4 deste processamento já expiraram ou não foram encontrados.',
        code: 'FILES_MISSING',
      });
      return;
    }

    if (req.method === 'HEAD') {
      res.status(200).end();
      return;
    }

    const safeVideoSlug = (job.video?.title || 'clipfire')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 36);

    const zipName = `clipfire-${safeVideoSlug || 'cortes'}-${verifiedClips.length}-mp4.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
    res.setHeader('Cache-Control', 'no-store');

    // Use store: true because MP4 (H.264/AAC) is already compressed — streams fast with minimal CPU/RAM
    const archive = createZipArchive({ store: true });

    archive.on('error', (err: any) => {
      console.error('[ZIP Stream Error]:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Falha ao gerar arquivo ZIP.' });
      } else {
        res.destroy();
      }
    });

    res.on('close', () => {
      if (!res.writableEnded) {
        archive.abort();
      }
    });

    archive.pipe(res);

    // Include a clean metadata summary text file alongside all real MP4 clips
    const metadataReport = [
      `ClipFire — Relatório de Cortes Renderizados com FFmpeg`,
      `Vídeo Original: ${job.video?.title || 'N/A'}`,
      `Resolução Original: ${job.video?.width}x${job.video?.height} (${job.video?.durationSec}s)`,
      `Configuração de Exportação: ${job.exportSettings.aspectRatio} | ${job.exportSettings.resolution} | ${job.exportSettings.framingMode} | Qualidade: ${job.exportSettings.quality}`,
      `Gerado em: ${job.completedAt || job.updatedAt}`,
      `------------------------------------------------------------`,
      '',
      ...verifiedClips.map(
        (c) =>
          `Corte #${String(c.rank).padStart(2, '0')} [Score ${c.score}/100]\n` +
          `Intervalo: ${c.timeLabel}\n` +
          `Arquivo: ${c.resolutionLabel} | ${c.actualDurationSec}s | ${(c.sizeBytes / (1024 * 1024)).toFixed(2)} MB | ${c.videoCodec.toUpperCase()}${c.audioCodec ? '+' + c.audioCodec.toUpperCase() : ''}\n` +
          `Título: ${c.title}\n` +
          `Descrição: ${c.desc}\n` +
          `Hashtags: ${c.tags.join(' ')}\n`
      ),
    ].join('\n');

    archive.append(metadataReport, { name: '00-metadados-dos-cortes.txt' });

    for (const clip of verifiedClips) {
      const slug = clip.title
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 42);
      const entryName = `${String(clip.rank).padStart(2, '0')}-score${clip.score}-${slug || 'corte'}.mp4`;
      const clipStream = await storage.openArtifactStream(jobId, clip.fileName);
      archive.append(clipStream as any, { name: entryName });
    }

    await archive.finalize();
  } catch (err: any) {
    if (!res.headersSent) {
      res.status(500).json({ error: err?.message || 'Erro ao gerar pacote ZIP dos cortes.' });
    }
  }
});

// -----------------------------------------------------------------------------
// ENDPOINT LEGADO /api/process-video (SEM SIMULAÇÃO — EXIGE MÍDIA AUTORIZADA)
// -----------------------------------------------------------------------------

app.post('/api/process-video', (_req: Request, res: Response) => {
  res.status(422).json({
    error:
      'O ClipFire agora opera exclusivamente com renderização real via FFmpeg (/api/jobs). Uma URL do YouTube isolada não é um arquivo de vídeo baixável. Envie o arquivo de vídeo autorizado (.mp4, .mov, .webm, .mkv) ou uma URL direta autorizada para o arquivo de mídia.',
    code: 'REAL_MEDIA_REQUIRED',
  });
});

// Simulador de Checkout (Pix & Cartão de Crédito — Sistema de Planos)
app.post('/api/checkout-simulate', (req: Request, res: Response) => {
  const { plan, method } = req.body;
  if (!plan || !['Pro', 'Turbo'].includes(plan)) {
    res.status(400).json({ error: 'Plano inválido para checkout.' });
    return;
  }

  const amount = plan === 'Pro' ? 29.0 : 59.0;
  const transactionId = `CF_${Date.now()}_${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

  res.json({
    success: true,
    plan,
    amount,
    currency: 'BRL',
    method: method || 'pix',
    transactionId,
    activatedAt: new Date().toISOString(),
    receiptUrl: `#receipt-${transactionId}`,
    message: `Plano ${plan} ativado com sucesso! Limites ilimitados desbloqueados.`,
  });
});

// Global API Error Guard
app.use('/api', (err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[API Unhandled Error]:', err);
  if (!res.headersSent) {
    res.status(err?.statusCode || 500).json({
      error: err?.message || 'Erro interno no servidor.',
      code: err?.code || 'INTERNAL_ERROR',
    });
  }
});

// -----------------------------------------------------------------------------
// INTEGRAÇÃO COM VITE (DEV MIDDLEWARE OU STATIC DIST)
// -----------------------------------------------------------------------------
async function startServer() {
  await initJobManager();
  const binaries = await verifyMediaBinaries();

  const httpServer = http.createServer(app);
  httpServer.keepAliveTimeout = 65_000;
  httpServer.headersTimeout = 66_000;

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: true,
        hmr: process.env.DISABLE_HMR === 'true' ? false : { server: httpServer },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(
      '/assets',
      express.static(path.join(distDir, 'assets'), {
        immutable: true,
        maxAge: '365d',
        etag: true,
      })
    );
    app.use(express.static(distDir, { maxAge: '1h', etag: true }));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`[ClipFire] Servidor full-stack rodando em http://0.0.0.0:${PORT}`);
    console.log(
      `[ClipFire] FFmpeg: ${binaries.available ? `Ativo ✅ (${binaries.ffmpegVersion})` : `Indisponível ❌ (${binaries.error})`}`
    );
    console.log(
      `[ClipFire] Groq API: ${process.env.GROQ_API_KEY ? 'Configurada ✅' : 'Chave não detectada (FFmpeg silencedetect + motor contextual)'}`
    );
  });
}

startServer().catch((err) => {
  console.error('[ClipFire] Falha ao iniciar o servidor:', err);
  process.exit(1);
});
