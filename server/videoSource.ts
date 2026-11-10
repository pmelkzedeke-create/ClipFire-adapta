import crypto from 'crypto';
import dns from 'dns';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { Readable } from 'stream';
import { CONFIG } from './config.js';

const lookupAsync = dns.promises.lookup;

export class VideoSourceError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(message: string, code = 'SOURCE_ERROR', statusCode = 400) {
    super(message);
    this.name = 'VideoSourceError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const ALLOWED_VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mov',
  '.m4v',
  '.webm',
  '.mkv',
  '.avi',
  '.mpeg',
  '.mpg',
  '.ts',
  '.ogv',
  '.3gp',
]);

export function sanitizeDisplayFileName(rawName: string): string {
  const base = path.basename(rawName || 'video.mp4');
  const cleaned = base.replace(/[^\w.\-À-ÿ ]+/g, '_').trim();
  return cleaned.slice(0, 120) || 'video.mp4';
}

export function isYouTubeWatchOrShareUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl.trim());
    const host = parsed.hostname.toLowerCase();
    return (
      host === 'youtube.com' ||
      host.endsWith('.youtube.com') ||
      host === 'youtu.be' ||
      host.endsWith('.youtu.be')
    );
  } catch {
    return false;
  }
}

function isProtectedStreamingPageUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl.trim());
    const host = parsed.hostname.toLowerCase();

    if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') {
      return 'YouTube';
    }
    if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) {
      return 'TikTok';
    }
    if (host === 'instagram.com' || host.endsWith('.instagram.com')) {
      return 'Instagram';
    }
    if (host === 'netflix.com' || host.endsWith('.netflix.com')) {
      return 'Netflix';
    }
    if (host === 'twitch.tv' || host.endsWith('.twitch.tv')) {
      return 'Twitch';
    }
    return null;
  } catch {
    return null;
  }
}

function isPrivateOrReservedIp(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // Link-local / Cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // Multicast / Reserved
    return false;
  }
  if (version === 6) {
    const normalized = ip.toLowerCase();
    if (normalized === '::1' || normalized === '::') return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // Unique local
    if (normalized.startsWith('fe80')) return true; // Link-local
    if (normalized.startsWith('::ffff:')) {
      const v4Part = normalized.slice(7);
      if (net.isIP(v4Part) === 4) return isPrivateOrReservedIp(v4Part);
    }
    return false;
  }
  return true;
}

export async function assertSafeExternalUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new VideoSourceError('A URL da mídia externa informada é inválida.', 'INVALID_URL', 400);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new VideoSourceError('Apenas protocolos HTTP/HTTPS são permitidos para fontes externas.', 'INVALID_PROTOCOL', 400);
  }

  const platform = isProtectedStreamingPageUrl(rawUrl);
  if (platform) {
    throw new VideoSourceError(
      `Uma URL do ${platform} não é um arquivo de mídia baixável diretamente. O ClipFire respeita direitos autorais, DRM e proteções de plataforma. Para gerar cortes reais em MP4, envie o arquivo de vídeo autorizado (.mp4, .mov, .webm, .mkv) do seu dispositivo ou informe uma URL direta autorizada para o arquivo de mídia.`,
      'PROTECTED_PLATFORM_URL',
      422
    );
  }

  // Block internal/private IP addresses to prevent SSRF
  const hostname = parsed.hostname;
  if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new VideoSourceError('Endereços locais ou internos não são permitidos como fonte externa.', 'SSRF_BLOCKED', 403);
  }

  if (net.isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname)) {
      throw new VideoSourceError('Endereço IP privado ou reservado bloqueado por segurança.', 'SSRF_BLOCKED', 403);
    }
    return parsed;
  }

  try {
    const addresses = await lookupAsync(hostname, { all: true });
    if (!addresses || addresses.length === 0) {
      throw new VideoSourceError('Não foi possível resolver o domínio da URL informada.', 'DNS_FAILED', 400);
    }
    for (const addr of addresses) {
      if (isPrivateOrReservedIp(addr.address)) {
        throw new VideoSourceError('A URL resolve para uma rede privada não autorizada.', 'SSRF_BLOCKED', 403);
      }
    }
  } catch (err) {
    if (err instanceof VideoSourceError) throw err;
    throw new VideoSourceError(
      'Não foi possível conectar ao servidor de mídia externo (domínio inacessível ou sem rota).',
      'DNS_FAILED',
      400
    );
  }

  return parsed;
}

export async function computeFileSha256AndVerifySize(
  filePath: string,
  maxBytes = CONFIG.maxUploadBytes
): Promise<{ sha256: string; sizeBytes: number }> {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile() || stat.size <= 0) {
    throw new VideoSourceError('O arquivo de vídeo enviado está vazio.', 'EMPTY_FILE', 400);
  }
  if (stat.size > maxBytes) {
    throw new VideoSourceError(
      `O arquivo excede o tamanho máximo permitido de ${CONFIG.maxUploadSizeMb} MB.`,
      'FILE_TOO_LARGE',
      413
    );
  }

  const hash = crypto.createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve());
  });

  return {
    sha256: hash.digest('hex'),
    sizeBytes: stat.size,
  };
}

export function validateUploadedFileExtensionAndMime(originalName: string, mimeType?: string): void {
  const ext = path.extname(originalName || '').toLowerCase();
  const mime = (mimeType || '').toLowerCase();

  const extAllowed = ext ? ALLOWED_VIDEO_EXTENSIONS.has(ext) : false;
  const mimeAllowed = mime.startsWith('video/') || mime === 'application/octet-stream';

  if (!extAllowed && !mimeAllowed) {
    throw new VideoSourceError(
      'Formato de arquivo não suportado. Envie um arquivo de vídeo válido (.mp4, .mov, .webm, .mkv, .m4v).',
      'UNSUPPORTED_FORMAT',
      415
    );
  }
}

export interface ExternalDownloadResult {
  sha256: string;
  sizeBytes: number;
  resolvedFileName: string;
  sourceType: 'authorized_url' | 'provider';
}

/**
 * Downloads an authorized media file from an external URL or authorized provider API
 * (such as S3/R2 presigned URL, CDN direct MP4, or Google Drive API file ID with explicit OAuth token)
 * while enforcing size limits, Content-Type verification, SSRF checks, and cancellation.
 */
export async function acquireAuthorizedRemoteVideo(params: {
  mediaUrl?: string;
  provider?: { name: 'google_drive'; fileId: string; accessToken?: string };
  destFilePath: string;
  signal?: AbortSignal;
  onProgress?: (downloadedBytes: number, totalBytes: number | null) => void;
}): Promise<ExternalDownloadResult> {
  let fetchUrl: string;
  const headers: Record<string, string> = {
    'User-Agent': 'ClipFireMediaWorker/2.0',
  };
  let sourceType: 'authorized_url' | 'provider' = 'authorized_url';
  let fallbackName = 'video-externo.mp4';

  if (params.provider?.name === 'google_drive' && params.provider.fileId) {
    const fileId = params.provider.fileId.trim();
    if (!/^[a-zA-Z0-9_-]{10,120}$/.test(fileId)) {
      throw new VideoSourceError('ID de arquivo do Google Drive inválido.', 'INVALID_DRIVE_ID', 400);
    }
    const token = params.provider.accessToken || process.env.GOOGLE_DRIVE_ACCESS_TOKEN;
    if (!token) {
      throw new VideoSourceError(
        'Para importar diretamente da API oficial do Google Drive, é necessário um token de acesso autorizado ou fazer o upload direto do arquivo MP4.',
        'PROVIDER_AUTH_REQUIRED',
        401
      );
    }
    fetchUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
    headers['Authorization'] = `Bearer ${token}`;
    sourceType = 'provider';
    fallbackName = `drive-${fileId.slice(0, 12)}.mp4`;
    await assertSafeExternalUrl(fetchUrl);
  } else if (params.mediaUrl) {
    const safeUrl = await assertSafeExternalUrl(params.mediaUrl);
    fetchUrl = safeUrl.toString();
    const base = path.basename(safeUrl.pathname);
    if (base && base.includes('.')) {
      fallbackName = sanitizeDisplayFileName(decodeURIComponent(base));
    }
  } else {
    throw new VideoSourceError(
      'Nenhuma fonte de vídeo foi informada. Envie um arquivo de vídeo ou informe uma URL direta de mídia autorizada.',
      'MISSING_SOURCE',
      400
    );
  }

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), CONFIG.externalDownloadTimeoutMs);
  timeoutId.unref?.();

  const onParentAbort = () => timeoutController.abort();
  params.signal?.addEventListener('abort', onParentAbort, { once: true });

  try {
    let response: Response;
    try {
      response = await fetch(fetchUrl, {
        method: 'GET',
        headers,
        redirect: 'follow',
        signal: timeoutController.signal,
      });
    } catch (err: any) {
      if (params.signal?.aborted) {
        throw new VideoSourceError('Download da mídia cancelado pelo usuário.', 'CANCELLED', 499);
      }
      throw new VideoSourceError(
        `Não foi possível baixar o arquivo de mídia da URL informada (${err?.message || 'erro de rede'}).`,
        'DOWNLOAD_FAILED',
        502
      );
    }

    // Re-check final URL after redirects against SSRF & protected platforms
    if (response.url && response.url !== fetchUrl) {
      await assertSafeExternalUrl(response.url);
    }

    if (!response.ok) {
      throw new VideoSourceError(
        `O servidor de mídia externo recusou o acesso (HTTP ${response.status}). Verifique se você possui acesso autorizado ou envie o arquivo diretamente.`,
        'REMOTE_HTTP_ERROR',
        422
      );
    }

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('text/html') || contentType.includes('application/json')) {
      throw new VideoSourceError(
        'A URL informada retornou uma página web (HTML/JSON) em vez de um arquivo de vídeo direto. Forneça o link direto do arquivo (.mp4, .mov, .webm) ou faça o upload do vídeo.',
        'NOT_DIRECT_MEDIA',
        422
      );
    }

    const contentLengthHeader = response.headers.get('content-length');
    const totalBytes = contentLengthHeader ? Number(contentLengthHeader) : null;
    if (totalBytes && Number.isFinite(totalBytes) && totalBytes > CONFIG.maxUploadBytes) {
      throw new VideoSourceError(
        `A mídia externa (${(totalBytes / (1024 * 1024)).toFixed(1)} MB) excede o limite de ${CONFIG.maxUploadSizeMb} MB.`,
        'FILE_TOO_LARGE',
        413
      );
    }

    if (!response.body) {
      throw new VideoSourceError('Resposta vazia ao obter arquivo de mídia externo.', 'EMPTY_BODY', 502);
    }

    const hash = crypto.createHash('sha256');
    let downloadedBytes = 0;

    await fs.promises.mkdir(path.dirname(params.destFilePath), { recursive: true });
    const fileOut = fs.createWriteStream(params.destFilePath);

    const nodeStream = Readable.fromWeb(response.body as any);

    await new Promise<void>((resolve, reject) => {
      nodeStream.on('data', (chunk: Buffer) => {
        downloadedBytes += chunk.length;
        if (downloadedBytes > CONFIG.maxUploadBytes) {
          nodeStream.destroy(
            new VideoSourceError(
              `O download excedeu o limite máximo de ${CONFIG.maxUploadSizeMb} MB.`,
              'FILE_TOO_LARGE',
              413
            )
          );
          return;
        }
        hash.update(chunk);
        params.onProgress?.(downloadedBytes, totalBytes && Number.isFinite(totalBytes) ? totalBytes : null);
      });

      nodeStream.on('error', (err) => {
        fileOut.destroy();
        reject(err);
      });

      fileOut.on('error', (err) => {
        nodeStream.destroy();
        reject(err);
      });

      fileOut.on('finish', () => resolve());
      nodeStream.pipe(fileOut);
    });

    return {
      sha256: hash.digest('hex'),
      sizeBytes: downloadedBytes,
      resolvedFileName: fallbackName,
      sourceType,
    };
  } finally {
    clearTimeout(timeoutId);
    params.signal?.removeEventListener('abort', onParentAbort);
  }
}
