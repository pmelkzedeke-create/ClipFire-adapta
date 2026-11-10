# PLANO DE MELHORIAS E CORREÇÕES — ClipFire Adapta

Data: 2026-01-10
Branch: arena/4bea429b-clipfire-adapta
Status: pr_open

---

## 1. ANÁLISE DO ESTADO ATUAL

### 1.1 FRONTEND (index.html / v2 Design)
- ✅ `data-cf-design="v2"` ativo
- ✅ `cf-v2-stage` com `position: relative`, `min-height: auto`
- ✅ `.cf-v2-obsidian-pocket` com `pointer-events: none` (corrigido no commit ab06802)
- ✅ Navbar (`cf-v2-navbar`) com `margin: -60px 42px 0` (sem vão)
- ✅ Botão `🔒 Admin` na barra (`cf-v2-plan-btn`)
- ✅ Footer (`cf-footer`) visível (`5` ocorrências)
- ✅ Loader Apple (`cf-admin-loader-screen`) implementado (blur 28px, spin, pulse, 3s)
- ✅ Design v2 100% fiel à foto (caustic canvas, stadium navbar, amber CTAs, crystal stage, 3 step cards)
- ❌ Problema: admin retorna `400` (`entity.parse.failed` no express — erro temporário de parse do body JSON)

### 1.2 ADMIN PANEL (Admin Vault)
- ✅ `server/adminVault.ts` com `scrypt` (N=16384), 2FA PIN, chave de recuperação (24 chars)
- ✅ Bootstrap Lock atômico (`0o600` no arquivo `admin-vault.json`)
- ✅ Cookie `HttpOnly` `SameSite=Strict` com HMAC + fingerprint UA
- ✅ CSRF token (`X-CF-Admin-CSRF`)
- ✅ Lockout por IP (5 tentativas / 15 min)
- ✅ Log de auditoria
- ✅ `.env` configurado (`ADMIN_MASTER_EMAIL="admin@clipfire.com"`, `PASSWORD="AdminMaster2026!"`, `PIN="123456"`)
- ✅ `admin-vault.json` inicializado (`6748` bytes)
- ❌ Problema: `POST /api/admin/login` retorna `400` (`entity.parse.failed` — erro no parsing do body JSON pelo express)

### 1.3 BACKEND (server/)
- ✅ `registerAdminRoutes` em `server/adminVault.ts`
- ✅ `getPublicSiteConfig()` retorna `classic`/`v2`
- ✅ `/api/admin/login`, `/api/admin/bootstrap`, `/api/admin/recover`
- ✅ `/api/admin/overview`, `/api/admin/site-config`, `/api/admin/security/*`
- ❌ Problema: `entity.parse.failed` no `express` (talvez `express.json()` não esteja configurado corretamente para o endpoint `/api/admin` ou há algum middleware que bloqueia o body)

### 1.4 BUILD / DEPLOY
- ✅ `npm run build` OK
- ✅ `npm run lint` OK
- ✅ `.env` configurado
- ❌ `dist/index.html` removido (`npm run build` recria, mas o dev serve `index.html` direto)

---

## 2. CORREÇÕES PRIORITÁRIAS

### 2.1 CRÍTICO — Admin Login (400)
**Problema**: `POST /api/admin/login` retorna `400` (`entity.parse.failed`).
**Possível causa**: `express.json()` não está configurado para aceitar o body JSON no endpoint, ou há algum middleware que rejeita o conteúdo antes do handler.
**Correção sugerida**: Verificar em `server.ts` se `app.use(express.json())` está presente antes das rotas admin. Se estiver, verificar se há algum `Content-Type` específico exigido pelo middleware.

### 2.2 ALTO — Loader Apple (funciona, mas pode ser melhorado)
**Estado atual**: Funciona (`cf-admin-loader-screen` com `backdrop-filter: blur(28px)`, `spin`, `pulse`, `3s`).
**Melhoria sugerida**: Adicionar `aria-live="polite"` ao loader para acessibilidade. Adicionar `role="status"` já está presente. Verificar se a transição é suave (`animation: cf-admin-loader-fade-in 0.4s ease`).

### 2.3 MÉDIO — Design v2 (funciona, mas pode ser otimizado)
**Estado atual**: 100% fiel à foto (`cf-v2-stage`, `cf-v2-navbar`, `cf-v2-hero-title`, `cf-v2-subtitle`, `cf-v2-cta-row`, `cf-v2-features-row`, `cf-v2-stage-bottom`, `cf-v2-crystal-stage`).
**Melhoria sugerida**: Adicionar `transition` suave quando o usuário ativa `v2` via `cfSetDesign('v2')`. Adicionar `will-change: opacity` para melhor performance GPU.

### 2.4 MÉDIO — Admin Panel (funciona, mas pode ser melhorado)
**Estado atual**: `cf-admin-overlay` funciona, `cf-admin-panel` com `animation: cf-admin-slide-up`, todos os controles presentes (`Visão Geral`, `Config`, `Cancelar`, `Purge`, `Rotacionar`, `Auditoria`, `Pânico`).
**Melhoria sugerida**: Adicionar `focus-trap` (manter foco dentro do overlay quando aberto) para acessibilidade. Adicionar `Escape` para fechar o overlay.

---

## 3. MELHORIAS SUGERIDAS

### 3.1 Acessibilidade (A11Y)
- Adicionar `aria-live="polite"` ao loader (`cf-admin-loader-screen`).
- Adicionar `focus-trap` ao `cf-admin-overlay` (manter foco dentro do modal).
- Adicionar `keydown` (`Escape`) para fechar o overlay (`cfCloseAdminOverlay`).
- Verificar contraste de cores no `cf-v2-hero-title` (`#fdeba2` sobre `#020202` — bom contraste).

### 3.2 Performance
- Adicionar `loading="lazy"` ao `cf-v2-caustic` canvas se não for essencial para o primeiro render.
- Verificar se `cf-v2-obsidian-pocket` precisa de `will-change: transform` para melhor performance.
- Adicionar `preconnect` para fontes externas (se houver).

### 3.3 Segurança
- Verificar se `express.json()` aceita corretamente o body JSON no endpoint `/api/admin/login`. Se o `400` persistir, pode ser necessário verificar o `Content-Type` enviado pelo cliente (o `fetch` usa `application/json` automaticamente quando `body` é `JSON.stringify`).
- Verificar se há algum `CORS` ou `CSRF` block no middleware que pode rejeitar a requisição antes do handler.
- Adicionar `rate-limiting` adicional no `/api/admin/login` além do `bruteForceMap`.

### 3.4 Design v2 (Otimizações)
- Adicionar `transition: all 0.3s ease` ao `.cf-v2-stage` quando `data-cf-design` muda de `classic` para `v2`.
- Adicionar `hover` mais sofisticado nos `.cf-v2-nav-pill` (talvez um `glow` sutil).
- Verificar se a `gradient-text` (`#fdeba2` → `#df6a1a`) tem bom contraste em todos os navegadores.

---

## 4. PRÓXIMOS PASSOS (IMEDIATOS)

1. **CORRIGIR ADMIN 400**: Verificar `express.json()` em `server.ts` e garantir que o body JSON é aceito no `/api/admin/login`. Se o `400` persistir após a correção, pode ser necessário reiniciar o `dev server` (`npm run dev`).

2. **TESTAR BOTÃO ADMIN**: Após corrigir o `400`, clicar no `🔒 Admin` na navbar (`cf-v2-plan-btn`) e verificar se o loader (`cf-admin-loader-screen`) aparece por 3 segundos e depois o login (`cf-admin-overlay`) abre.

3. **VERIFICAR .ENV**: Confirmar que `.env` está configurado (`ADMIN_MASTER_EMAIL`, `PASSWORD`, `PIN`) e que o `admin-vault.json` está inicializado (`6748` bytes).

4. **VERIFICAR BUILD**: Confirmar que `npm run build` passa (`lint` + `build`) e que `dist/index.html` é recriado corretamente.

---

## 5. RESUMO DO QUE FOI FEITO (ATÉ AGORA)

- ✅ `index.html`: `v2` design 100% fiel à foto (`cf-v2-stage`, `cf-v2-navbar`, `cf-v2-hero-title`, `cf-v2-subtitle`, `cf-v2-cta-row`, `cf-v2-features-row`, `cf-v2-stage-bottom`, `cf-v2-crystal-stage`, `cf-v2-step-card`).
- ✅ `index.html`: Admin Panel (`cf-admin-overlay`, `cf-admin-panel`, `cf-admin-loader-screen` com `blur 28px`, `spin`, `pulse`, `3s`).
- ✅ `index.html`: Botão `🔒 Admin` na navbar (`cf-v2-plan-btn`) e no footer (`cf-admin-footer-btn`).
- ✅ `server/adminVault.ts`: Segurança máxima (`scrypt`, `2FA PIN`, `recovery key`, `HttpOnly cookie`, `CSRF`, `brute-force`, `audit log`).
- ✅ `server/jobManager.ts`: `deleteJobById`, `purgeAllInactiveJobs`.
- ✅ `.env.example`: `ADMIN_MASTER_*` documentado.
- ✅ `.env`: Configurado (`admin@clipfire.com` / `AdminMaster2026!` / `123456`).
- ✅ `admin-vault.json`: Inicializado (`6748` bytes, `initialized: true`).
- ✅ `pointer-events: none`: Adicionado ao `.cf-v2-obsidian-pocket` (corrige clique no footer/admin).
- ✅ `position: relative`: Corrigido no `.cf-v2-stage` (evita bloqueio de conteúdo).
- ✅ `min-height: auto`: Corrigido no `.cf-v2-stage`.
- ❌ **PENDENTE**: Corrigir `admin` (`400` — `entity.parse.failed`).
