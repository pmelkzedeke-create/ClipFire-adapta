import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  AspectRatioOption,
  ExportSettings,
  FpsOption,
  FramingModeOption,
  QualityPresetOption,
  ResolutionOption,
} from './types.js';

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

const DEFAULT_RUNTIME_ROOT = process.env.CLIPFIRE_RUNTIME_DIR || path.join(os.tmpdir(), 'clipfire-runtime');

function resolveSigningSecret(): string {
  if (process.env.MEDIA_SIGNING_SECRET && process.env.MEDIA_SIGNING_SECRET.length >= 16) {
    return process.env.MEDIA_SIGNING_SECRET;
  }
  // Persist a local machine secret in runtime dir so signed URLs survive dev restarts
  try {
    fs.mkdirSync(DEFAULT_RUNTIME_ROOT, { recursive: true });
    const secretFile = path.join(DEFAULT_RUNTIME_ROOT, '.signing_secret');
    if (fs.existsSync(secretFile)) {
      const existing = fs.readFileSync(secretFile, 'utf8').trim();
      if (existing.length >= 32) return existing;
    }
    const generated = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(secretFile, generated, { mode: 0o600 });
    return generated;
  } catch {
    return crypto.randomBytes(32).toString('hex');
  }
}

const cpuCount = Math.max(1, os.cpus()?.length || 2);

export const CONFIG = {
  runtimeRoot: DEFAULT_RUNTIME_ROOT,
  tempDir: process.env.CLIPFIRE_TEMP_DIR || path.join(DEFAULT_RUNTIME_ROOT, 'temp'),
  uploadsDir: process.env.CLIPFIRE_UPLOADS_DIR || path.join(DEFAULT_RUNTIME_ROOT, 'uploads'),
  storageDir: process.env.CLIPFIRE_STORAGE_DIR || path.join(DEFAULT_RUNTIME_ROOT, 'storage'),
  jobsDir: process.env.CLIPFIRE_JOBS_DIR || path.join(DEFAULT_RUNTIME_ROOT, 'jobs'),

  // Binary overrides
  ffmpegPathOverride: process.env.FFMPEG_PATH || '',
  ffprobePathOverride: process.env.FFPROBE_PATH || '',

  // Limits & Resource Protection
  maxUploadSizeMb: envInt('MAX_UPLOAD_SIZE_MB', 500, 10, 4096),
  get maxUploadBytes(): number {
    return this.maxUploadSizeMb * 1024 * 1024;
  },
  maxVideoDurationSec: envInt('MAX_VIDEO_DURATION_SEC', 7200, 10, 28800), // default 2 hours
  minVideoDurationSec: 2,
  maxClipsPerJob: envInt('MAX_CLIPS_PER_JOB', 15, 1, 30),
  maxConcurrentJobs: envInt('MAX_CONCURRENT_JOBS', 2, 1, 8),
  maxFfmpegConcurrency: envInt('MAX_FFMPEG_CONCURRENCY', Math.min(2, cpuCount), 1, 8),
  ffmpegThreadsPerProc: envInt('FFMPEG_THREADS_PER_PROC', Math.min(2, cpuCount), 1, 8),
  ffmpegClipTimeoutMs: envInt('FFMPEG_CLIP_TIMEOUT_MS', 300_000, 15_000, 1_800_000),
  externalDownloadTimeoutMs: envInt('EXTERNAL_DOWNLOAD_TIMEOUT_MS', 180_000, 10_000, 900_000),

  // Retention & GC
  jobRetentionTtlMs: envInt('JOB_RETENTION_TTL_MS', 2 * 60 * 60 * 1000, 5 * 60 * 1000, 7 * 24 * 60 * 60 * 1000),
  cleanupIntervalMs: envInt('CLEANUP_INTERVAL_MS', 10 * 60 * 1000, 60 * 1000, 60 * 60 * 1000),

  // Storage & Worker Infrastructure
  storageDriver: (process.env.STORAGE_DRIVER === 's3' ? 's3' : 'local') as 'local' | 's3',
  s3: {
    endpoint: process.env.S3_ENDPOINT || '',
    region: process.env.S3_REGION || 'auto',
    bucket: process.env.S3_BUCKET || '',
    accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
  },

  processingMode: (process.env.PROCESSING_MODE === 'remote_worker' ? 'remote_worker' : 'local_worker') as
    | 'local_worker'
    | 'remote_worker',
  remoteWorkerUrl: process.env.REMOTE_WORKER_URL || '',
  workerSharedSecret: process.env.WORKER_SHARED_SECRET || '',

  // Signed URLs
  mediaSigningSecret: resolveSigningSecret(),
  signedUrlTtlSec: envInt('SIGNED_URL_TTL_SEC', 7200, 300, 86400),
};

const ALLOWED_ASPECT_RATIOS: ReadonlySet<AspectRatioOption> = new Set(['9:16', '16:9', '1:1', 'original']);
const ALLOWED_RESOLUTIONS: ReadonlySet<ResolutionOption> = new Set(['1080p', '720p', 'original']);
const ALLOWED_FRAMING_MODES: ReadonlySet<FramingModeOption> = new Set(['smart_crop', 'crop_center', 'fit_blur']);
const ALLOWED_FPS: ReadonlySet<FpsOption> = new Set(['original', '24', '30', '60']);
const ALLOWED_QUALITIES: ReadonlySet<QualityPresetOption> = new Set(['high', 'medium', 'low']);

export function sanitizeExportSettings(raw: unknown): ExportSettings {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  const aspectRatio: AspectRatioOption = ALLOWED_ASPECT_RATIOS.has(input.aspectRatio as AspectRatioOption)
    ? (input.aspectRatio as AspectRatioOption)
    : '9:16';

  const resolution: ResolutionOption = ALLOWED_RESOLUTIONS.has(input.resolution as ResolutionOption)
    ? (input.resolution as ResolutionOption)
    : '1080p';

  const framingMode: FramingModeOption = ALLOWED_FRAMING_MODES.has(input.framingMode as FramingModeOption)
    ? (input.framingMode as FramingModeOption)
    : 'smart_crop';

  const fps: FpsOption = ALLOWED_FPS.has(input.fps as FpsOption) ? (input.fps as FpsOption) : 'original';

  const quality: QualityPresetOption = ALLOWED_QUALITIES.has(input.quality as QualityPresetOption)
    ? (input.quality as QualityPresetOption)
    : 'high';

  const maxClipsRaw = Number(input.maxClips);
  const maxClips = Number.isFinite(maxClipsRaw)
    ? Math.min(CONFIG.maxClipsPerJob, Math.max(1, Math.round(maxClipsRaw)))
    : CONFIG.maxClipsPerJob;

  const settings: ExportSettings = {
    aspectRatio,
    resolution,
    framingMode,
    fps,
    quality,
    maxClips,
  };

  if (input.videoBitrateKbps !== undefined && input.videoBitrateKbps !== '' && input.videoBitrateKbps !== null) {
    const vb = Number(input.videoBitrateKbps);
    if (Number.isFinite(vb) && vb >= 400 && vb <= 25000) {
      settings.videoBitrateKbps = Math.round(vb);
    }
  }

  if (input.audioBitrateKbps !== undefined && input.audioBitrateKbps !== '' && input.audioBitrateKbps !== null) {
    const ab = Number(input.audioBitrateKbps);
    if (Number.isFinite(ab) && ab >= 64 && ab <= 320) {
      settings.audioBitrateKbps = Math.round(ab);
    }
  }

  return settings;
}

export function ensureRuntimeDirectories(): void {
  for (const dir of [CONFIG.runtimeRoot, CONFIG.tempDir, CONFIG.uploadsDir, CONFIG.storageDir, CONFIG.jobsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
