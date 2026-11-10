import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { CONFIG } from './config.js';

const SAFE_ID_RE = /^[a-zA-Z0-9_-]{6,64}$/;
const SAFE_FILE_RE = /^[a-zA-Z0-9._-]{3,120}$/;

export function assertSafeStorageSegment(jobId: string, fileName?: string): void {
  if (!SAFE_ID_RE.test(jobId)) {
    throw new Error('Identificador de job inválido.');
  }
  if (fileName !== undefined) {
    if (!SAFE_FILE_RE.test(fileName) || fileName.includes('..')) {
      throw new Error('Nome de arquivo inválido.');
    }
  }
}

export function createSignedToken(payload: string, expiresUnixSec: number): string {
  const data = `${payload}:${expiresUnixSec}`;
  return crypto.createHmac('sha256', CONFIG.mediaSigningSecret).update(data).digest('hex');
}

export function verifySignedToken(payload: string, expiresUnixSec: number, signature: string): boolean {
  if (!Number.isFinite(expiresUnixSec) || expiresUnixSec < Math.floor(Date.now() / 1000)) {
    return false;
  }
  if (!signature || signature.length !== 64 || !/^[0-9a-f]{64}$/i.test(signature)) {
    return false;
  }
  const expected = createSignedToken(payload, expiresUnixSec);
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature.toLowerCase(), 'hex'));
}

export function createSignedZipUrl(jobId: string): string {
  assertSafeStorageSegment(jobId);
  const exp = Math.floor(Date.now() / 1000) + CONFIG.signedUrlTtlSec;
  const sig = createSignedToken(`zip:${jobId}`, exp);
  return `/api/jobs/${encodeURIComponent(jobId)}/download-zip?exp=${exp}&sig=${sig}`;
}

export interface StorageProvider {
  readonly driverName: 'local' | 's3';
  storeArtifact(jobId: string, fileName: string, localSourcePath: string, contentType: string): Promise<string>;
  getSignedPreviewUrl(jobId: string, fileName: string): string;
  getSignedDownloadUrl(jobId: string, fileName: string, downloadAsName: string): string;
  artifactExists(jobId: string, fileName: string): Promise<{ exists: boolean; sizeBytes: number }>;
  openArtifactStream(
    jobId: string,
    fileName: string,
    range?: { start: number; end: number }
  ): Promise<NodeJS.ReadableStream>;
  deleteJobArtifacts(jobId: string, fileNames?: string[]): Promise<void>;
}

class LocalSignedStorageProvider implements StorageProvider {
  public readonly driverName = 'local' as const;

  private resolveSafePath(jobId: string, fileName: string): string {
    assertSafeStorageSegment(jobId, fileName);
    const root = path.resolve(CONFIG.storageDir);
    const target = path.resolve(root, jobId, fileName);
    if (!target.startsWith(root + path.sep)) {
      throw new Error('Tentativa de acesso fora do diretório seguro bloqueada.');
    }
    return target;
  }

  async storeArtifact(jobId: string, fileName: string, localSourcePath: string): Promise<string> {
    const dest = this.resolveSafePath(jobId, fileName);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.copyFile(localSourcePath, dest);
    return `${jobId}/${fileName}`;
  }

  getSignedPreviewUrl(jobId: string, fileName: string): string {
    assertSafeStorageSegment(jobId, fileName);
    const exp = Math.floor(Date.now() / 1000) + CONFIG.signedUrlTtlSec;
    const sig = createSignedToken(`media:${jobId}:${fileName}:0`, exp);
    return `/api/media/${encodeURIComponent(jobId)}/${encodeURIComponent(fileName)}?exp=${exp}&dl=0&sig=${sig}`;
  }

  getSignedDownloadUrl(jobId: string, fileName: string, downloadAsName: string): string {
    assertSafeStorageSegment(jobId, fileName);
    const exp = Math.floor(Date.now() / 1000) + CONFIG.signedUrlTtlSec;
    const sig = createSignedToken(`media:${jobId}:${fileName}:1`, exp);
    const safeDlName = downloadAsName.replace(/[^\w.\-À-ÿ ]+/g, '_').slice(0, 100) || fileName;
    return `/api/media/${encodeURIComponent(jobId)}/${encodeURIComponent(fileName)}?exp=${exp}&dl=1&name=${encodeURIComponent(safeDlName)}&sig=${sig}`;
  }

  async artifactExists(jobId: string, fileName: string): Promise<{ exists: boolean; sizeBytes: number }> {
    try {
      const target = this.resolveSafePath(jobId, fileName);
      const st = await fs.promises.stat(target);
      return { exists: st.isFile() && st.size > 0, sizeBytes: st.size };
    } catch {
      return { exists: false, sizeBytes: 0 };
    }
  }

  async openArtifactStream(
    jobId: string,
    fileName: string,
    range?: { start: number; end: number }
  ): Promise<NodeJS.ReadableStream> {
    const target = this.resolveSafePath(jobId, fileName);
    if (range) {
      return fs.createReadStream(target, { start: range.start, end: range.end });
    }
    return fs.createReadStream(target);
  }

  async deleteJobArtifacts(jobId: string): Promise<void> {
    assertSafeStorageSegment(jobId);
    const root = path.resolve(CONFIG.storageDir);
    const jobDir = path.resolve(root, jobId);
    if (jobDir.startsWith(root + path.sep)) {
      await fs.promises.rm(jobDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * S3 / Cloudflare R2 / MinIO / Supabase Object Storage Provider using AWS Signature V4.
 * Designed for stateless serverless / multi-worker production deployments.
 */
function hmacSha256(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function awsUriEncode(str: string, encodeSlash = true): string {
  let out = '';
  for (const ch of Buffer.from(str, 'utf8')) {
    const c = String.fromCharCode(ch);
    if (
      (c >= 'A' && c <= 'Z') ||
      (c >= 'a' && c <= 'z') ||
      (c >= '0' && c <= '9') ||
      c === '_' ||
      c === '-' ||
      c === '~' ||
      c === '.'
    ) {
      out += c;
    } else if (c === '/' && !encodeSlash) {
      out += '/';
    } else {
      out += '%' + ch.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

class S3CompatibleStorageProvider implements StorageProvider {
  public readonly driverName = 's3' as const;

  private buildObjectUrl(objectKey: string): { url: URL; canonicalUri: string } {
    const endpoint = new URL(CONFIG.s3.endpoint);
    const cleanBase = endpoint.pathname.replace(/\/+$/, '');
    const keyPath = `/${CONFIG.s3.bucket}/${objectKey}`;
    const fullPath = `${cleanBase}${keyPath}`;
    const url = new URL(endpoint.toString());
    url.pathname = fullPath;
    return { url, canonicalUri: awsUriEncode(fullPath, false) };
  }

  private getSigningKey(dateStamp: string): Buffer {
    const kDate = hmacSha256(`AWS4${CONFIG.s3.secretAccessKey}`, dateStamp);
    const kRegion = hmacSha256(kDate, CONFIG.s3.region);
    const kService = hmacSha256(kRegion, 's3');
    return hmacSha256(kService, 'aws4_request');
  }

  private presignGetUrl(objectKey: string, queryExtra: Record<string, string> = {}): string {
    const { url, canonicalUri } = this.buildObjectUrl(objectKey);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const credentialScope = `${dateStamp}/${CONFIG.s3.region}/s3/aws4_request`;

    const params: Record<string, string> = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${CONFIG.s3.accessKeyId}/${credentialScope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(CONFIG.signedUrlTtlSec),
      'X-Amz-SignedHeaders': 'host',
      ...queryExtra,
    };

    const sortedKeys = Object.keys(params).sort();
    const canonicalQuery = sortedKeys
      .map((k) => `${awsUriEncode(k)}=${awsUriEncode(params[k])}`)
      .join('&');

    const canonicalHeaders = `host:${url.host}\n`;
    const canonicalRequest = [
      'GET',
      canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      'host',
      'UNSIGNED-PAYLOAD',
    ].join('\n');

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join('\n');

    const signature = hmacSha256(this.getSigningKey(dateStamp), stringToSign).toString('hex');
    return `${url.origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  }

  private async signedRequest(
    method: 'PUT' | 'HEAD' | 'GET' | 'DELETE',
    objectKey: string,
    options: { bodyPath?: string; contentType?: string; range?: { start: number; end: number } } = {}
  ): Promise<Response> {
    const { url, canonicalUri } = this.buildObjectUrl(objectKey);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const credentialScope = `${dateStamp}/${CONFIG.s3.region}/s3/aws4_request`;

    const payloadHash = 'UNSIGNED-PAYLOAD';
    const headers: Record<string, string> = {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };

    let bodyStream: any = undefined;
    if (options.bodyPath) {
      const stat = await fs.promises.stat(options.bodyPath);
      headers['content-length'] = String(stat.size);
      if (options.contentType) headers['content-type'] = options.contentType;
      bodyStream = Readable.toWeb(fs.createReadStream(options.bodyPath));
    }
    if (options.range) {
      headers['range'] = `bytes=${options.range.start}-${options.range.end}`;
    }

    const signedHeaderNames = Object.keys(headers).sort();
    const canonicalHeaders = signedHeaderNames.map((k) => `${k}:${headers[k].trim()}\n`).join('');
    const signedHeadersStr = signedHeaderNames.join(';');

    const canonicalRequest = [
      method,
      canonicalUri,
      '',
      canonicalHeaders,
      signedHeadersStr,
      payloadHash,
    ].join('\n');

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join('\n');

    const sig = hmacSha256(this.getSigningKey(dateStamp), stringToSign).toString('hex');
    headers['Authorization'] =
      `AWS4-HMAC-SHA256 Credential=${CONFIG.s3.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeadersStr}, Signature=${sig}`;

    const fetchInit: any = {
      method,
      headers,
    };
    if (bodyStream) {
      fetchInit.body = bodyStream;
      fetchInit.duplex = 'half';
    }

    return fetch(url.toString(), fetchInit);
  }

  async storeArtifact(jobId: string, fileName: string, localSourcePath: string, contentType: string): Promise<string> {
    assertSafeStorageSegment(jobId, fileName);
    const objectKey = `clips/${jobId}/${fileName}`;
    const res = await this.signedRequest('PUT', objectKey, { bodyPath: localSourcePath, contentType });
    if (!res.ok) {
      throw new Error(`Falha ao enviar artefato para Object Storage S3 (HTTP ${res.status}).`);
    }
    return objectKey;
  }

  getSignedPreviewUrl(jobId: string, fileName: string): string {
    assertSafeStorageSegment(jobId, fileName);
    return this.presignGetUrl(`clips/${jobId}/${fileName}`, {
      'response-content-disposition': 'inline',
    });
  }

  getSignedDownloadUrl(jobId: string, fileName: string, downloadAsName: string): string {
    assertSafeStorageSegment(jobId, fileName);
    const safeName = downloadAsName.replace(/[^\w.\-À-ÿ ]+/g, '_').slice(0, 100) || fileName;
    return this.presignGetUrl(`clips/${jobId}/${fileName}`, {
      'response-content-disposition': `attachment; filename="${safeName}"`,
    });
  }

  async artifactExists(jobId: string, fileName: string): Promise<{ exists: boolean; sizeBytes: number }> {
    assertSafeStorageSegment(jobId, fileName);
    const res = await this.signedRequest('HEAD', `clips/${jobId}/${fileName}`);
    if (!res.ok) return { exists: false, sizeBytes: 0 };
    const size = Number(res.headers.get('content-length') || 0);
    return { exists: size > 0, sizeBytes: size };
  }

  async openArtifactStream(
    jobId: string,
    fileName: string,
    range?: { start: number; end: number }
  ): Promise<NodeJS.ReadableStream> {
    assertSafeStorageSegment(jobId, fileName);
    const res = await this.signedRequest('GET', `clips/${jobId}/${fileName}`, { range });
    if (!res.ok || !res.body) {
      throw new Error(`Não foi possível abrir o stream do objeto S3 (HTTP ${res.status}).`);
    }
    return Readable.fromWeb(res.body as any);
  }

  async deleteJobArtifacts(jobId: string, fileNames: string[] = []): Promise<void> {
    assertSafeStorageSegment(jobId);
    await Promise.allSettled(
      fileNames.map((fn) => this.signedRequest('DELETE', `clips/${jobId}/${fn}`))
    );
  }
}

let activeStorage: StorageProvider | null = null;

export function getStorageProvider(): StorageProvider {
  if (activeStorage) return activeStorage;
  if (
    CONFIG.storageDriver === 's3' &&
    CONFIG.s3.endpoint &&
    CONFIG.s3.bucket &&
    CONFIG.s3.accessKeyId &&
    CONFIG.s3.secretAccessKey
  ) {
    activeStorage = new S3CompatibleStorageProvider();
  } else {
    activeStorage = new LocalSignedStorageProvider();
  }
  return activeStorage;
}
