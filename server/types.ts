export type AspectRatioOption = '9:16' | '16:9' | '1:1' | 'original';
export type ResolutionOption = '1080p' | '720p' | 'original';
export type FramingModeOption = 'smart_crop' | 'crop_center' | 'fit_blur';
export type FpsOption = 'original' | '24' | '30' | '60';
export type QualityPresetOption = 'high' | 'medium' | 'low';

export interface ExportSettings {
  aspectRatio: AspectRatioOption;
  resolution: ResolutionOption;
  framingMode: FramingModeOption;
  fps: FpsOption;
  quality: QualityPresetOption;
  videoBitrateKbps?: number;
  audioBitrateKbps?: number;
  maxClips: number;
}

export interface ProbedMediaMetadata {
  durationSec: number;
  width: number;
  height: number;
  effectiveWidth: number;
  effectiveHeight: number;
  rotation: number;
  videoCodec: string;
  audioCodec: string | null;
  fps: number;
  hasAudio: boolean;
  sizeBytes: number;
  bitrateKbps: number;
  formatName: string;
}

export interface CutIntervalCandidate {
  rank: number;
  score: number;
  startSec: number;
  endSec: number;
  duration: number;
  timeLabel: string;
  title: string;
  desc: string;
  captionWords: string[];
  tags: string[];
}

export interface RenderedClip extends CutIntervalCandidate {
  fileName: string;
  thumbnailFileName?: string;
  storageKey: string;
  thumbnailStorageKey?: string;
  sizeBytes: number;
  actualDurationSec: number;
  width: number;
  height: number;
  resolutionLabel: string;
  fps: number;
  videoCodec: string;
  audioCodec: string | null;
  hasAudio: boolean;
  framingApplied: FramingModeOption | 'original';
  focusCenterX?: number;
  validated: boolean;
  previewUrl: string;
  downloadUrl: string;
  thumbnailUrl?: string;
}

export type JobStatus =
  | 'queued'
  | 'downloading'
  | 'validating'
  | 'probing'
  | 'transcribing'
  | 'analyzing'
  | 'rendering'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface JobVideoInfo {
  id: string;
  title: string;
  author: string;
  sourceType: 'upload' | 'authorized_url' | 'provider';
  originalFileName: string;
  youtubeRefUrl?: string;
  thumbnail?: string;
  hasRealTranscript: boolean;
  transcriptSource: 'groq_whisper' | 'youtube_captions' | 'audio_silence_analysis' | 'timeline';
  durationSec: number;
  width: number;
  height: number;
  sizeBytes: number;
  videoCodec: string;
  audioCodec: string | null;
  fps: number;
  hasAudio: boolean;
}

export interface ProcessingJob {
  id: string;
  fingerprint: string;
  status: JobStatus;
  stepIndex: number; // 0..4 maps to the 5 UI steps
  stageLabel: string;
  stageDetail: string;
  progressPct: number | null; // null when exact % cannot be calculated honestly
  currentClipIndex?: number;
  totalClipsToRender?: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  exportSettings: ExportSettings;
  video?: JobVideoInfo;
  provider?: string;
  cuts: RenderedClip[];
  zipDownloadUrl?: string;
  error?: string;
  errorCode?: string;
  diagnostics: string[];
}
