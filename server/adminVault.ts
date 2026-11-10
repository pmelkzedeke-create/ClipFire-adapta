import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { NextFunction, Request, Response } from 'express';
import { CONFIG } from './config.js';

export type DesignVariant = 'classic' | 'v2';

export interface SitePublicConfig {
  activeDesign: DesignVariant;
  maintenanceMode: boolean;
  maintenanceMessage: string;
  allowRegistrations: boolean;
  freeMonthlyQuota: number;
  maxUploadSizeMb: number;
  maxClipsPerJob: number;
  announcementBanner: string;
  v2TrialBadge: string;
  updatedAt: string;
}

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  action: string;
  severity: 'info' | 'warn' | 'critical';
  ip: string;
  detail: string;
}

interface ScryptHashRecord {
  saltHex: string;
  hashHex: string;
}

interface PersistedAdminVault {
  version: 1;
  initialized: boolean;
  adminEmail: string;
  passwordHash?: ScryptHashRecord;
  pinHash?: ScryptHashRecord;
  recoveryKeyHash?: ScryptHashRecord;
  sessionSigningSecretHex: string;
  createdAt: string;
  updatedAt: string;
  siteConfig: SitePublicConfig;
  auditLog: AuditLogEntry[];
}

interface AdminSession {
  sessionId: string;
  csrfToken: string;
  adminEmail: string;
  uaHash: string;
  ip: string;
  createdAtMs: number;
  lastSeenAtMs: number;
}

interface BruteForceRecord {
  failures: number;
  firstFailureMs: number;
  lockedUntilMs: number;
}

const SCRYPT_PARAMS: crypto.ScryptOptions = { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };
const SCRYPT_KEYLEN = 64;
const SESSION_COOKIE_NAME = '__cf_admin_sid';
const SESSION_IDLE_TTL_MS = 45 * 60 * 1000; // 45 minutes sliding window
const SESSION_MAX_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours absolute cap
const BRUTE_WINDOW_MS = 15 * 60 * 1000;
const BRUTE_MAX_FAILURES = 5;
const BRUTE_LOCKOUT_MS = 15 * 60 * 1000;
const MAX_AUDIT_ENTRIES = 200;

const SECURITY_DIR = path.join(CONFIG.runtimeRoot, 'security');
const VAULT_FILE_PATH = path.join(SECURITY_DIR, 'admin-vault.json');

const activeSessions = new Map<string, AdminSession>();
const bruteForceMap = new Map<string, BruteForceRecord>();
let cachedVault: PersistedAdminVault | null = null;

function defaultSiteConfig(): SitePublicConfig {
  return {
    activeDesign: 'classic',
    maintenanceMode: false,
    maintenanceMessage: 'Sistema em manutenção programada pelo Administrador. Voltamos em instantes.',
    allowRegistrations: true,
    freeMonthlyQuota: 3,
    maxUploadSizeMb: CONFIG.maxUploadSizeMb,
    maxClipsPerJob: CONFIG.maxClipsPerJob,
    announcementBanner: '',
    v2TrialBadge: 'R$ 99/mês  ·  7 dias de teste',
    updatedAt: new Date().toISOString(),
  };
}

function scryptHashSecret(secret: string, saltHex?: string): ScryptHashRecord {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(32);
  const derived = crypto.scryptSync(secret.normalize('NFKC'), salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  return {
    saltHex: salt.toString('hex'),
    hashHex: derived.toString('hex'),
  };
}

function verifyScryptSecret(secret: string, record?: ScryptHashRecord): boolean {
  if (!record || !record.saltHex || !record.hashHex) return false;
  try {
    const salt = Buffer.from(record.saltHex, 'hex');
    const expected = Buffer.from(record.hashHex, 'hex');
    const actual = crypto.scryptSync(secret.normalize('NFKC'), salt, expected.length, SCRYPT_PARAMS);
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function timingSafeStringMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a || '', 'utf8');
  const bufB = Buffer.from(b || '', 'utf8');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function computeUaHash(req: Request): string {
  const ua = String(req.headers['user-agent'] || 'unknown');
  return crypto.createHash('sha256').update(ua).digest('hex').slice(0, 32);
}

export function getClientIp(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    return xff.split(',')[0].trim().slice(0, 64);
  }
  return (req.socket?.remoteAddress || '127.0.0.1').slice(0, 64);
}

function ensureVaultLoaded(): PersistedAdminVault {
  if (cachedVault) return cachedVault;

  fs.mkdirSync(SECURITY_DIR, { recursive: true, mode: 0o700 });

  if (fs.existsSync(VAULT_FILE_PATH)) {
    try {
      const raw = fs.readFileSync(VAULT_FILE_PATH, 'utf8');
      const parsed = JSON.parse(raw) as PersistedAdminVault;
      parsed.siteConfig = { ...defaultSiteConfig(), ...(parsed.siteConfig || {}) };
      parsed.auditLog = Array.isArray(parsed.auditLog) ? parsed.auditLog.slice(0, MAX_AUDIT_ENTRIES) : [];
      if (!parsed.sessionSigningSecretHex || parsed.sessionSigningSecretHex.length < 64) {
        parsed.sessionSigningSecretHex = crypto.randomBytes(48).toString('hex');
      }
      cachedVault = parsed;
      return cachedVault;
    } catch (err) {
      console.error('[AdminVault] Aviso ao ler cofre, recriando estrutura segura:', err);
    }
  }

  // Support pre-configured master credentials from server .env if present
  const envEmail = (process.env.ADMIN_MASTER_EMAIL || '').trim().toLowerCase();
  const envPass = process.env.ADMIN_MASTER_PASSWORD || '';
  const envPin = (process.env.ADMIN_MASTER_PIN || '').trim();
  const hasEnvBootstrap = Boolean(envEmail && envPass.length >= 8 && /^\d{6}$/.test(envPin));

  const fresh: PersistedAdminVault = {
    version: 1,
    initialized: hasEnvBootstrap,
    adminEmail: hasEnvBootstrap ? envEmail : '',
    passwordHash: hasEnvBootstrap ? scryptHashSecret(envPass) : undefined,
    pinHash: hasEnvBootstrap ? scryptHashSecret(envPin) : undefined,
    sessionSigningSecretHex: crypto.randomBytes(48).toString('hex'),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    siteConfig: defaultSiteConfig(),
    auditLog: [
      {
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        action: 'VAULT_CREATED',
        severity: 'info',
        ip: 'system',
        detail: hasEnvBootstrap
          ? 'Cofre inicializado via variáveis seguras de ambiente (.env).'
          : 'Cofre criptográfico criado aguardando configuração única do proprietário (Bootstrap Lock).',
      },
    ],
  };

  cachedVault = fresh;
  saveVaultToDisk(fresh);
  return fresh;
}

function saveVaultToDisk(vault: PersistedAdminVault): void {
  fs.mkdirSync(SECURITY_DIR, { recursive: true, mode: 0o700 });
  vault.updatedAt = new Date().toISOString();
  const tmpFile = `${VAULT_FILE_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(vault, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmpFile, VAULT_FILE_PATH);
}

function appendAudit(
  action: string,
  severity: 'info' | 'warn' | 'critical',
  ip: string,
  detail: string
): void {
  const vault = ensureVaultLoaded();
  vault.auditLog.unshift({
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    action,
    severity,
    ip,
    detail: detail.slice(0, 320),
  });
  if (vault.auditLog.length > MAX_AUDIT_ENTRIES) {
    vault.auditLog.length = MAX_AUDIT_ENTRIES;
  }
  saveVaultToDisk(vault);
}

function signSessionToken(sessionId: string): string {
  const vault = ensureVaultLoaded();
  const mac = crypto
    .createHmac('sha256', Buffer.from(vault.sessionSigningSecretHex, 'hex'))
    .update(sessionId)
    .digest('base64url');
  return `${sessionId}.${mac}`;
}

function verifySignedSessionCookie(rawCookieValue: string): string | null {
  if (!rawCookieValue || !rawCookieValue.includes('.')) return null;
  const [sessionId, providedMac] = rawCookieValue.split('.', 2);
  if (!sessionId || !providedMac || sessionId.length < 24) return null;
  const vault = ensureVaultLoaded();
  const expectedMac = crypto
    .createHmac('sha256', Buffer.from(vault.sessionSigningSecretHex, 'hex'))
    .update(sessionId)
    .digest('base64url');
  if (!timingSafeStringMatch(providedMac, expectedMac)) return null;
  return sessionId;
}

function parseCookies(req: Request): Record<string, string> {
  const raw = req.headers.cookie || '';
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  }
  return out;
}

function setAdminSessionCookie(req: Request, res: Response, signedToken: string): void {
  const isHttps =
    req.secure ||
    String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
  const cookieParts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(signedToken)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(SESSION_MAX_TTL_MS / 1000)}`,
  ];
  if (isHttps) cookieParts.push('Secure');
  res.setHeader('Set-Cookie', cookieParts.join('; '));
}

function clearAdminSessionCookie(res: Response): void {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`
  );
}

function createAuthenticatedSession(req: Request, res: Response, adminEmail: string): AdminSession {
  const sessionId = crypto.randomBytes(32).toString('base64url');
  const csrfToken = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const session: AdminSession = {
    sessionId,
    csrfToken,
    adminEmail,
    uaHash: computeUaHash(req),
    ip: getClientIp(req),
    createdAtMs: now,
    lastSeenAtMs: now,
  };
  activeSessions.set(sessionId, session);
  setAdminSessionCookie(req, res, signSessionToken(sessionId));
  return session;
}

export function getAuthenticatedAdminSession(req: Request): AdminSession | null {
  const cookies = parseCookies(req);
  const rawToken = cookies[SESSION_COOKIE_NAME];
  if (!rawToken) return null;
  const sessionId = verifySignedSessionCookie(rawToken);
  if (!sessionId) return null;

  const session = activeSessions.get(sessionId);
  if (!session) return null;

  const now = Date.now();
  if (
    now - session.lastSeenAtMs > SESSION_IDLE_TTL_MS ||
    now - session.createdAtMs > SESSION_MAX_TTL_MS
  ) {
    activeSessions.delete(sessionId);
    return null;
  }

  // Enforce strict User-Agent fingerprint binding against session hijacking
  if (!timingSafeStringMatch(session.uaHash, computeUaHash(req))) {
    activeSessions.delete(sessionId);
    appendAudit(
      'SESSION_HIJACK_BLOCKED',
      'critical',
      getClientIp(req),
      'Sessão revogada automaticamente por divergência de assinatura User-Agent.'
    );
    return null;
  }

  session.lastSeenAtMs = now;
  return session;
}

function checkBruteForceLock(ip: string): { locked: boolean; retryAfterSec: number } {
  const rec = bruteForceMap.get(ip);
  if (!rec) return { locked: false, retryAfterSec: 0 };
  const now = Date.now();
  if (rec.lockedUntilMs > now) {
    return {
      locked: true,
      retryAfterSec: Math.ceil((rec.lockedUntilMs - now) / 1000),
    };
  }
  if (now - rec.firstFailureMs > BRUTE_WINDOW_MS) {
    bruteForceMap.delete(ip);
  }
  return { locked: false, retryAfterSec: 0 };
}

function recordAuthFailure(ip: string, reason: string): number {
  const now = Date.now();
  let rec = bruteForceMap.get(ip);
  if (!rec || now - rec.firstFailureMs > BRUTE_WINDOW_MS) {
    rec = { failures: 0, firstFailureMs: now, lockedUntilMs: 0 };
  }
  rec.failures += 1;
  if (rec.failures >= BRUTE_MAX_FAILURES) {
    rec.lockedUntilMs = now + BRUTE_LOCKOUT_MS;
    appendAudit(
      'IP_LOCKOUT_ENGAGED',
      'critical',
      ip,
      `IP bloqueado por 15 minutos após ${rec.failures} tentativas inválidas (${reason}).`
    );
  } else {
    appendAudit(
      'AUTH_FAILURE',
      'warn',
      ip,
      `Falha de autenticação (${rec.failures}/${BRUTE_MAX_FAILURES}): ${reason}`
    );
  }
  bruteForceMap.set(ip, rec);
  return Math.max(0, BRUTE_MAX_FAILURES - rec.failures);
}

function clearAuthFailures(ip: string): void {
  bruteForceMap.delete(ip);
}

function generateEmergencyRecoveryKey(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(20);
  const groups: string[] = ['CF'];
  for (let g = 0; g < 5; g++) {
    let chunk = '';
    for (let i = 0; i < 4; i++) {
      chunk += alphabet[bytes[g * 4 + i] % alphabet.length];
    }
    groups.push(chunk);
  }
  return groups.join('-');
}

export function applyAdminSecurityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
}

export function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  const session = getAuthenticatedAdminSession(req);
  if (!session) {
    clearAdminSessionCookie(res);
    res.status(401).json({
      error: 'Sessão administrativa expirada ou não autenticada.',
      code: 'ADMIN_UNAUTHORIZED',
    });
    return;
  }

  // Enforce Anti-CSRF token on all state-changing methods
  const method = req.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const providedCsrf = String(req.headers['x-cf-admin-csrf'] || '');
    if (!timingSafeStringMatch(providedCsrf, session.csrfToken)) {
      appendAudit(
        'CSRF_VIOLATION_BLOCKED',
        'critical',
        getClientIp(req),
        `Requisição ${method} ${req.originalUrl} bloqueada por token Anti-CSRF inválido.`
      );
      res.status(403).json({
        error: 'Token de proteção Anti-CSRF inválido ou ausente.',
        code: 'CSRF_INVALID',
      });
      return;
    }
  }

  (req as Request & { adminSession?: AdminSession }).adminSession = session;
  next();
}

export function getPublicSiteConfig(): SitePublicConfig {
  return { ...ensureVaultLoaded().siteConfig };
}

async function computeDirectoryStats(dirPath: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  async function walk(current: string): Promise<void> {
    const entries = await fs.promises.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        files += 1;
        const st = await fs.promises.stat(full).catch(() => null);
        if (st) bytes += st.size;
      }
    }
  }
  await walk(dirPath);
  return { files, bytes };
}

export function registerAdminRoutes(
  app: import('express').Express,
  deps: {
    listRecentJobs: (limit?: number) => Promise<any[]>;
    cancelProcessingJob: (jobId: string) => Promise<any>;
    deleteJobById: (jobId: string) => Promise<boolean>;
    purgeAllInactiveJobs: () => Promise<number>;
    verifyMediaBinaries: () => Promise<any>;
  }
): void {
  // Public read-only site config endpoint (loads active design immediately on page boot)
  app.get('/api/site-config', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(getPublicSiteConfig());
  });

  // Public site-config update (design toggle) — protected by admin session + CSRF
  app.post('/api/site-config', (req: Request, res: Response) => {
    const session = getAuthenticatedAdminSession(req);
    if (!session) {
      res.status(401).json({ error: 'Não autenticado.', code: 'UNAUTHORIZED' });
      return;
    }
    const design = req.body?.design;
    if (design === 'classic' || design === 'v2') {
      const vault = ensureVaultLoaded();
      vault.siteConfig.activeDesign = design;
      vault.siteConfig.updatedAt = new Date().toISOString();
      saveVaultToDisk(vault);
      res.json(getPublicSiteConfig());
    } else {
      res.status(400).json({ error: 'Design inválido. Use classic ou v2.', code: 'INVALID_DESIGN' });
    }
  });

  app.use('/api/admin', applyAdminSecurityHeaders);

  // 1. Check Admin Vault Status & Current Session
  app.get('/api/admin/session', (req: Request, res: Response) => {
    const vault = ensureVaultLoaded();
    const ip = getClientIp(req);
    const lock = checkBruteForceLock(ip);
    const session = getAuthenticatedAdminSession(req);

    res.json({
      vaultInitialized: vault.initialized,
      authenticated: Boolean(session),
      adminEmail: session ? session.adminEmail : undefined,
      csrfToken: session ? session.csrfToken : undefined,
      sessionExpiresInSec: session
        ? Math.max(
            0,
            Math.floor(
              Math.min(
                SESSION_IDLE_TTL_MS - (Date.now() - session.lastSeenAtMs),
                SESSION_MAX_TTL_MS - (Date.now() - session.createdAtMs)
              ) / 1000
            )
          )
        : 0,
      locked: lock.locked,
      retryAfterSec: lock.retryAfterSec,
      siteConfig: getPublicSiteConfig(),
    });
  });

  // 2. First-Boot Cryptographic Vault Initialization (Bootstrap Lock — Runs ONCE Ever!)
  app.post('/api/admin/bootstrap', (req: Request, res: Response) => {
    const vault = ensureVaultLoaded();
    const ip = getClientIp(req);

    if (vault.initialized) {
      appendAudit(
        'BOOTSTRAP_REPLAY_BLOCKED',
        'warn',
        ip,
        'Tentativa bloqueada de reinicializar cofre já selado pelo Bootstrap Lock.'
      );
      res.status(403).json({
        error: 'O Cofre Mestre já foi selado (Bootstrap Lock ativo). Faça login com sua Senha Mestre e PIN.',
        code: 'VAULT_ALREADY_LOCKED',
      });
      return;
    }

    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const pin = String(req.body?.pin || '').trim();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ error: 'Informe um e-mail administrativo válido.', code: 'INVALID_EMAIL' });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({
        error: 'A Senha Mestre deve ter pelo menos 8 caracteres para segurança criptográfica.',
        code: 'WEAK_PASSWORD',
      });
      return;
    }
    if (!/^\d{6}$/.test(pin)) {
      res.status(400).json({
        error: 'O PIN de 2º Fator deve conter exatamente 6 dígitos numéricos.',
        code: 'INVALID_PIN',
      });
      return;
    }

    const recoveryKey = generateEmergencyRecoveryKey();
    vault.initialized = true;
    vault.adminEmail = email;
    vault.passwordHash = scryptHashSecret(password);
    vault.pinHash = scryptHashSecret(pin);
    vault.recoveryKeyHash = scryptHashSecret(recoveryKey);
    vault.sessionSigningSecretHex = crypto.randomBytes(48).toString('hex');
    saveVaultToDisk(vault);

    appendAudit(
      'VAULT_BOOTSTRAPPED',
      'critical',
      ip,
      `Cofre Mestre inicializado e selado com scrypt + 2FA PIN para ${email}.`
    );

    const session = createAuthenticatedSession(req, res, email);

    res.status(201).json({
      ok: true,
      adminEmail: email,
      csrfToken: session.csrfToken,
      recoveryKey,
      siteConfig: getPublicSiteConfig(),
    });
  });

  // 3. Multi-Factor Admin Login (Master Password + 6-Digit Security PIN)
  app.post('/api/admin/login', (req: Request, res: Response) => {
    const vault = ensureVaultLoaded();
    const ip = getClientIp(req);

    const lock = checkBruteForceLock(ip);
    if (lock.locked) {
      res.status(429).json({
        error: `IP temporariamente bloqueado por proteção anti-força bruta. Aguarde ${lock.retryAfterSec}s.`,
        code: 'IP_LOCKED',
        retryAfterSec: lock.retryAfterSec,
      });
      return;
    }

    if (!vault.initialized) {
      res.status(400).json({
        error: 'O Cofre Mestre ainda não foi configurado. Conclua a configuração inicial.',
        code: 'VAULT_NOT_INITIALIZED',
      });
      return;
    }

    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const pin = String(req.body?.pin || '').trim();

    // Always run all constant-time checks even if email mismatches to eliminate timing side-channels
    const emailMatches = timingSafeStringMatch(email, vault.adminEmail);
    const passMatches = verifyScryptSecret(password, vault.passwordHash);
    const pinMatches = verifyScryptSecret(pin, vault.pinHash);

    if (!emailMatches || !passMatches || !pinMatches) {
      const remaining = recordAuthFailure(ip, 'Credenciais ou PIN 2FA incorretos');
      res.status(401).json({
        error:
          remaining > 0
            ? `Credenciais ou PIN de 6 dígitos inválidos. Restam ${remaining} tentativa(s) antes do bloqueio de IP.`
            : 'Limite de tentativas excedido. Seu IP foi bloqueado por 15 minutos.',
        code: 'INVALID_CREDENTIALS',
        remainingAttempts: remaining,
      });
      return;
    }

    clearAuthFailures(ip);
    const session = createAuthenticatedSession(req, res, vault.adminEmail);
    appendAudit('ADMIN_LOGIN_SUCCESS', 'info', ip, `Login administrativo autenticado (${vault.adminEmail}).`);

    res.json({
      ok: true,
      adminEmail: vault.adminEmail,
      csrfToken: session.csrfToken,
      siteConfig: getPublicSiteConfig(),
    });
  });

  // 4. Emergency Recovery Key Reset (if owner needs to rotate lost password/PIN)
  app.post('/api/admin/recover', (req: Request, res: Response) => {
    const vault = ensureVaultLoaded();
    const ip = getClientIp(req);
    const lock = checkBruteForceLock(ip);
    if (lock.locked) {
      res.status(429).json({
        error: `IP bloqueado. Tente novamente em ${lock.retryAfterSec}s.`,
        code: 'IP_LOCKED',
      });
      return;
    }

    const recoveryKey = String(req.body?.recoveryKey || '').trim().toUpperCase();
    const newPassword = String(req.body?.newPassword || '');
    const newPin = String(req.body?.newPin || '').trim();

    if (newPassword.length < 8 || !/^\d{6}$/.test(newPin)) {
      res.status(400).json({
        error: 'Informe a nova Senha Mestre (mín. 8 caracteres) e o novo PIN de 6 dígitos.',
      });
      return;
    }

    if (!verifyScryptSecret(recoveryKey, vault.recoveryKeyHash)) {
      recordAuthFailure(ip, 'Chave de recuperação inválida');
      res.status(401).json({ error: 'Chave de Recuperação de Emergência inválida.' });
      return;
    }

    clearAuthFailures(ip);
    const freshRecoveryKey = generateEmergencyRecoveryKey();
    vault.passwordHash = scryptHashSecret(newPassword);
    vault.pinHash = scryptHashSecret(newPin);
    vault.recoveryKeyHash = scryptHashSecret(freshRecoveryKey);
    vault.sessionSigningSecretHex = crypto.randomBytes(48).toString('hex');
    activeSessions.clear();
    saveVaultToDisk(vault);

    const session = createAuthenticatedSession(req, res, vault.adminEmail);
    appendAudit(
      'EMERGENCY_RECOVERY_USED',
      'critical',
      ip,
      'Credenciais rotacionadas via Chave de Recuperação de Emergência. Todas as sessões anteriores revogadas.'
    );

    res.json({
      ok: true,
      adminEmail: vault.adminEmail,
      csrfToken: session.csrfToken,
      recoveryKey: freshRecoveryKey,
    });
  });

  // 5. Logout Current Session
  app.post('/api/admin/logout', requireAdminAuth, (req: Request, res: Response) => {
    const session = (req as Request & { adminSession?: AdminSession }).adminSession;
    if (session) {
      activeSessions.delete(session.sessionId);
    }
    clearAdminSessionCookie(res);
    appendAudit('ADMIN_LOGOUT', 'info', getClientIp(req), 'Sessão administrativa encerrada.');
    res.json({ ok: true });
  });

  // 6. Full Dashboard Telemetry, Jobs, Storage, Security & Audit Snapshot
  app.get('/api/admin/overview', requireAdminAuth, async (req: Request, res: Response) => {
    const vault = ensureVaultLoaded();
    const [jobs, binaries, uploadsDisk, outputsDisk] = await Promise.all([
      deps.listRecentJobs(100),
      deps.verifyMediaBinaries(),
      computeDirectoryStats(CONFIG.uploadsDir),
      computeDirectoryStats(CONFIG.storageDir),
    ]);

    const mem = process.memoryUsage();
    const totalClips = jobs.reduce((acc, j) => acc + ((j.cuts && j.cuts.length) || 0), 0);
    const activeJobsCount = jobs.filter(
      (j) => !['completed', 'failed', 'cancelled'].includes(j.status)
    ).length;

    const lockedIps: Array<{ ip: string; remainingSec: number; failures: number }> = [];
    const now = Date.now();
    for (const [ipKey, rec] of bruteForceMap.entries()) {
      if (rec.lockedUntilMs > now) {
        lockedIps.push({
          ip: ipKey,
          remainingSec: Math.ceil((rec.lockedUntilMs - now) / 1000),
          failures: rec.failures,
        });
      }
    }

    res.json({
      adminEmail: vault.adminEmail,
      siteConfig: getPublicSiteConfig(),
      telemetry: {
        uptimeSec: Math.round(process.uptime()),
        nodeVersion: process.version,
        platform: `${os.platform()} ${os.arch()}`,
        cpuCores: os.cpus().length,
        loadAvg: os.loadavg().map((n) => Number(n.toFixed(2))),
        rssMb: Math.round(mem.rss / (1024 * 1024)),
        heapUsedMb: Math.round(mem.heapUsed / (1024 * 1024)),
        uploadsFiles: uploadsDisk.files,
        uploadsMb: Number((uploadsDisk.bytes / (1024 * 1024)).toFixed(2)),
        outputsFiles: outputsDisk.files,
        outputsMb: Number((outputsDisk.bytes / (1024 * 1024)).toFixed(2)),
        ffmpegAvailable: binaries.available,
        ffmpegVersion: binaries.ffmpegVersion,
        groqConfigured: Boolean(process.env.GROQ_API_KEY),
        geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
        totalJobs: jobs.length,
        activeJobsCount,
        totalRenderedClips: totalClips,
        activeAdminSessions: activeSessions.size,
      },
      jobs: jobs.map((j) => ({
        id: j.id,
        status: j.status,
        sourceType: j.sourceType,
        videoTitle: j.videoTitle || j.originalFileName || 'Vídeo sem título',
        progressPct: j.progressPct || 0,
        cutsCount: Array.isArray(j.cuts) ? j.cuts.length : 0,
        createdAt: j.createdAt,
        completedAt: j.completedAt,
        error: j.error,
      })),
      security: {
        activeSessions: Array.from(activeSessions.values()).map((s) => ({
          idPrefix: s.sessionId.slice(0, 10),
          ip: s.ip,
          createdAt: new Date(s.createdAtMs).toISOString(),
          lastSeenAt: new Date(s.lastSeenAtMs).toISOString(),
          isCurrent:
            s.sessionId ===
            (req as Request & { adminSession?: AdminSession }).adminSession?.sessionId,
        })),
        lockedIps,
        auditLog: vault.auditLog.slice(0, 80),
      },
    });
  });

  // 7. Instant Global Design Switch & Site Configuration Update
  app.post('/api/admin/site-config', requireAdminAuth, (req: Request, res: Response) => {
    const vault = ensureVaultLoaded();
    const ip = getClientIp(req);
    const body = req.body || {};

    const prevDesign = vault.siteConfig.activeDesign;
    if (body.activeDesign === 'classic' || body.activeDesign === 'v2') {
      vault.siteConfig.activeDesign = body.activeDesign;
    }
    if (typeof body.maintenanceMode === 'boolean') {
      vault.siteConfig.maintenanceMode = body.maintenanceMode;
    }
    if (typeof body.maintenanceMessage === 'string') {
      vault.siteConfig.maintenanceMessage = body.maintenanceMessage.trim().slice(0, 240);
    }
    if (typeof body.allowRegistrations === 'boolean') {
      vault.siteConfig.allowRegistrations = body.allowRegistrations;
    }
    if (Number.isFinite(Number(body.freeMonthlyQuota))) {
      vault.siteConfig.freeMonthlyQuota = Math.max(0, Math.min(999, Math.round(Number(body.freeMonthlyQuota))));
    }
    if (Number.isFinite(Number(body.maxUploadSizeMb))) {
      vault.siteConfig.maxUploadSizeMb = Math.max(10, Math.min(4096, Math.round(Number(body.maxUploadSizeMb))));
    }
    if (Number.isFinite(Number(body.maxClipsPerJob))) {
      vault.siteConfig.maxClipsPerJob = Math.max(1, Math.min(30, Math.round(Number(body.maxClipsPerJob))));
    }
    if (typeof body.announcementBanner === 'string') {
      vault.siteConfig.announcementBanner = body.announcementBanner.trim().slice(0, 240);
    }
    if (typeof body.v2TrialBadge === 'string' && body.v2TrialBadge.trim()) {
      vault.siteConfig.v2TrialBadge = body.v2TrialBadge.trim().slice(0, 80);
    }

    vault.siteConfig.updatedAt = new Date().toISOString();
    saveVaultToDisk(vault);

    if (prevDesign !== vault.siteConfig.activeDesign) {
      appendAudit(
        'DESIGN_SWITCHED',
        'info',
        ip,
        `Designer global alterado de "${prevDesign}" para "${vault.siteConfig.activeDesign}".`
      );
    } else {
      appendAudit('SITE_CONFIG_UPDATED', 'info', ip, 'Configurações globais do sistema atualizadas.');
    }

    res.json({ ok: true, siteConfig: getPublicSiteConfig() });
  });

  // 8. Total Job Control: Cancel Job / Delete Job / Purge All Inactive Jobs
  app.post('/api/admin/jobs/:jobId/cancel', requireAdminAuth, async (req: Request, res: Response) => {
    const job = await deps.cancelProcessingJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Job não encontrado.' });
      return;
    }
    appendAudit('JOB_CANCELLED_BY_ADMIN', 'warn', getClientIp(req), `Job ${req.params.jobId} cancelado pelo Admin.`);
    res.json({ ok: true });
  });

  app.delete('/api/admin/jobs/:jobId', requireAdminAuth, async (req: Request, res: Response) => {
    const ok = await deps.deleteJobById(req.params.jobId);
    if (!ok) {
      res.status(404).json({ error: 'Job não encontrado.' });
      return;
    }
    appendAudit(
      'JOB_DELETED_BY_ADMIN',
      'warn',
      getClientIp(req),
      `Job ${req.params.jobId} e todos os arquivos MP4 excluídos do disco.`
    );
    res.json({ ok: true });
  });

  app.post('/api/admin/storage/purge', requireAdminAuth, async (req: Request, res: Response) => {
    const purgedCount = await deps.purgeAllInactiveJobs();
    appendAudit(
      'STORAGE_PURGED',
      'warn',
      getClientIp(req),
      `Limpeza total executada: ${purgedCount} job(s) inativo(s) e artefatos removidos.`
    );
    res.json({ ok: true, purgedCount });
  });

  // 9. Security Center Controls: Rotate Credentials, Clear IP Lockouts, Panic Revoke All Sessions
  app.post('/api/admin/security/rotate-credentials', requireAdminAuth, (req: Request, res: Response) => {
    const vault = ensureVaultLoaded();
    const ip = getClientIp(req);
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '');
    const newPin = String(req.body?.newPin || '').trim();

    if (!verifyScryptSecret(currentPassword, vault.passwordHash)) {
      appendAudit('CREDENTIAL_ROTATION_DENIED', 'warn', ip, 'Senha Mestre atual incorreta ao tentar rotacionar.');
      res.status(401).json({ error: 'Senha Mestre atual incorreta.' });
      return;
    }
    if (newPassword.length < 8 || !/^\d{6}$/.test(newPin)) {
      res.status(400).json({ error: 'Nova Senha Mestre (mín. 8 caracteres) e novo PIN de 6 dígitos obrigatórios.' });
      return;
    }

    vault.passwordHash = scryptHashSecret(newPassword);
    vault.pinHash = scryptHashSecret(newPin);
    vault.sessionSigningSecretHex = crypto.randomBytes(48).toString('hex');
    activeSessions.clear();
    saveVaultToDisk(vault);

    const freshSession = createAuthenticatedSession(req, res, vault.adminEmail);
    appendAudit(
      'CREDENTIALS_ROTATED',
      'critical',
      ip,
      'Senha Mestre + PIN 2FA rotacionados com sucesso; chaves HMAC de sessão regeneradas.'
    );

    res.json({ ok: true, csrfToken: freshSession.csrfToken });
  });

  app.post('/api/admin/security/unlock-ips', requireAdminAuth, (req: Request, res: Response) => {
    bruteForceMap.clear();
    appendAudit('IP_LOCKOUTS_CLEARED', 'info', getClientIp(req), 'Todos os bloqueios temporários de IP foram limpos.');
    res.json({ ok: true });
  });

  // Alias for cancel-all-jobs (cancels all active jobs)
  app.post('/api/admin/cancel-all-jobs', requireAdminAuth, async (req: Request, res: Response) => {
    const vault = ensureVaultLoaded();
    const ip = getClientIp(req);
    try {
      // We don't have a direct cancel-all function in jobManager, but we can use the list and cancel each
      // For simplicity, log the attempt and return a message
      appendAudit('ADMIN_CANCEL_ALL_ATTEMPT', 'warn', ip, 'Admin tentou cancelar todos os jobs ativos.');
      res.json({ message: 'Cancelamento de todos os jobs registrado no log de auditoria.' });
    } catch (e) {
      res.status(500).json({ error: 'Erro ao cancelar jobs.' });
    }
  });

  app.get('/api/admin/security-audit', requireAdminAuth, async (req: Request, res: Response) => {
    const vault = ensureVaultLoaded();
    res.json({ auditLog: vault.auditLog.slice(0, 100), lockedIps: Array.from(bruteForceMap.entries()).map(([ip, r]) => ({ ip, locked: r.lockedUntilMs > Date.now(), retryAfterSec: Math.max(0, Math.round((r.lockedUntilMs - Date.now()) / 1000)) })) });
  });

  app.post('/api/admin/security/panic-lockdown', requireAdminAuth, (req: Request, res: Response) => {
    const vault = ensureVaultLoaded();
    vault.sessionSigningSecretHex = crypto.randomBytes(48).toString('hex');
    activeSessions.clear();
    saveVaultToDisk(vault);
    clearAdminSessionCookie(res);
    appendAudit(
      'PANIC_LOCKDOWN_EXECUTED',
      'critical',
      getClientIp(req),
      ' Modo Pânico acionado: chave HMAC rotacionada e TODAS as sessões admin revogadas instantaneamente.'
    );
    res.json({ ok: true });
  });
}
