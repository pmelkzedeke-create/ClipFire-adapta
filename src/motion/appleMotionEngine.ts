/**
 * ULTRACODE — Apple iOS 26 / visionOS Jelly & Spring Physics + Mobile Native UX Engine
 * - 100% GPU Compositor animations (`translate3d` + `scale3d` + `opacity` — ZERO layout thrashing)
 * - Volume-preserving Apple Jelly / Silicone deformation (`sx * sy ≈ 1`)
 * - Apple Liquid Glass Boot Loading Screen with Optical Zoom-Dissolve
 * - Scroll-Velocity Reactive Jelly Capsules & Native Mobile Bottom Dock + Touch Swipe Sheets
 */

export interface SpringParams {
  stiffness: number;
  damping: number;
  mass: number;
  velocity?: number;
}

export const APPLE_SPRINGS: Record<
  'snappy' | 'fluid' | 'bouncy' | 'jelly' | 'sheet' | 'gentle' | 'velvet',
  SpringParams
> = {
  snappy: { stiffness: 450, damping: 30, mass: 0.8 },
  fluid: { stiffness: 310, damping: 26, mass: 0.95 },
  bouncy: { stiffness: 390, damping: 18.5, mass: 0.86 },
  jelly: { stiffness: 420, damping: 14.5, mass: 0.84 },
  sheet: { stiffness: 345, damping: 27, mass: 0.94 },
  gentle: { stiffness: 220, damping: 24, mass: 1.05 },
  velvet: { stiffness: 265, damping: 25, mass: 0.98 },
};

const springCurveCache = new Map<string, { durationMs: number; samples: number[] }>();

export function computeSpringSamples(preset: keyof typeof APPLE_SPRINGS): {
  durationMs: number;
  samples: number[];
} {
  const cached = springCurveCache.get(preset);
  if (cached) return cached;

  const { stiffness, damping, mass, velocity = 0 } = APPLE_SPRINGS[preset];
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  const dt = 1 / 120;
  const maxSteps = 150;
  const raw: number[] = [0];

  let settledStep = maxSteps;
  for (let i = 1; i <= maxSteps; i++) {
    const t = i * dt;
    let x = 1;
    if (zeta < 1) {
      const wd = w0 * Math.sqrt(1 - zeta * zeta);
      const env = Math.exp(-zeta * w0 * t);
      const cosPart = Math.cos(wd * t);
      const sinPart = ((zeta * w0 - velocity) / wd) * Math.sin(wd * t);
      x = 1 - env * (cosPart + sinPart);
    } else {
      const env = Math.exp(-w0 * t);
      x = 1 - env * (1 + (w0 - velocity) * t);
    }
    raw.push(x);

    if (i > 20 && Math.abs(1 - x) < 0.001 && Math.abs(x - raw[i - 1]) < 0.0007) {
      settledStep = i;
      break;
    }
  }

  const trimmed = raw.slice(0, settledStep + 1);
  trimmed[trimmed.length - 1] = 1;

  const targetCount = Math.min(28, trimmed.length);
  const samples: number[] = [];
  for (let i = 0; i < targetCount; i++) {
    const idx = Math.round((i / (targetCount - 1)) * (trimmed.length - 1));
    samples.push(Number(trimmed[idx].toFixed(4)));
  }

  const durationMs = Math.max(220, Math.min(760, Math.round(settledStep * dt * 1000)));
  const result = { durationMs, samples };
  springCurveCache.set(preset, result);
  return result;
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Volume-Preserving Apple Jelly / Silicone Wobble (`scale3d(sx, sy, 1)` where `sx * sy ≈ 1`).
 * Runs 100% on GPU Compositor (`scale` property or `transform`).
 */
export function triggerAppleJelly(
  el: HTMLElement | null,
  amplitude = 0.085,
  durationMs = 520,
  useScaleProp = false
): void {
  if (!el || prefersReducedMotion()) return;

  const steps = 22;
  const frames: Keyframe[] = [];
  for (let i = 0; i <= steps; i++) {
    const p = i / steps;
    const decay = Math.exp(-5.2 * p);
    const wave = Math.sin(p * Math.PI * 3.0) * amplitude * decay;
    const sx = i === steps ? 1 : 1 + wave;
    // Preserve area (`sx * sy ≈ 1`) for authentic physical silicone/liquid-glass feel
    const sy = i === steps ? 1 : 1 / Math.max(0.75, sx);

    if (useScaleProp) {
      frames.push({ scale: `${sx.toFixed(4)} ${sy.toFixed(4)}` });
    } else {
      frames.push({ transform: `scale3d(${sx.toFixed(4)}, ${sy.toFixed(4)}, 1)` });
    }
  }

  el.animate(frames, {
    duration: durationMs,
    easing: 'linear',
  });
}

export function pulseElementPop(el: HTMLElement | null, intensity = 1.09): void {
  if (!el || prefersReducedMotion()) return;
  triggerAppleJelly(el, Math.max(0.05, intensity - 1), 480, true);
}

/* ==========================================================================
   0. APPLE iOS 26 LIQUID GLASS CINEMA BOOT / SPLASH SCREEN
   ========================================================================== */

let bootFinished = false;

function initAppleBootScreen(onBootReveal: () => void): void {
  const loader = document.getElementById('cf-apple-loader');
  if (!loader) {
    bootFinished = true;
    onBootReveal();
    return;
  }

  const orb = document.getElementById('cf-loader-glass-orb');
  const fill = document.getElementById('cf-loader-bar-fill');
  const pctEl = document.getElementById('cf-loader-pct');

  if (prefersReducedMotion()) {
    loader.style.display = 'none';
    bootFinished = true;
    onBootReveal();
    return;
  }

  // Entrance jelly swell on the refractive glass squircle lens
  if (orb) {
    const { durationMs, samples } = computeSpringSamples('jelly');
    orb.animate(
      samples.map((s, idx) => {
        const p = idx / Math.max(samples.length - 1, 1);
        const wobble = Math.sin(p * Math.PI * 2.5) * 0.055 * (1 - p);
        const scX = lerp(0.72, 1, s) + wobble;
        const scY = lerp(0.72, 1, s) - wobble * 0.75;
        return {
          opacity: String(Math.min(1, s * 1.35)),
          transform: `scale3d(${scX.toFixed(4)}, ${scY.toFixed(4)}, 1)`,
        };
      }),
      { duration: durationMs, easing: 'linear' }
    );
  }

  const startTime = performance.now();
  const totalBootMs = 820;

  const finishBoot = () => {
    if (bootFinished) return;
    bootFinished = true;

    if (fill) fill.style.transform = 'scaleX(1)';
    if (pctEl) pctEl.textContent = '100%';

    // Trigger Hero Keynote entrance underneath as the glass curtain optically zooms & dissolves
    onBootReveal();

    const exitAnim = loader.animate(
      [
        { opacity: '1', transform: 'scale3d(1, 1, 1)' },
        { opacity: '0', transform: 'scale3d(1.065, 1.065, 1)' },
      ],
      { duration: 380, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' }
    );

    exitAnim.onfinish = () => {
      loader.style.display = 'none';
      exitAnim.cancel();
    };
  };

  const stepProgress = (now: number) => {
    if (bootFinished) return;
    const elapsed = now - startTime;
    const p = Math.min(1, elapsed / totalBootMs);
    const eased = 1 - Math.pow(1 - p, 2.6);

    if (fill) {
      fill.style.transform = `scaleX(${eased.toFixed(4)})`;
    }
    if (pctEl) {
      pctEl.textContent = `${Math.round(eased * 100)}%`;
    }

    if (p < 1) {
      window.requestAnimationFrame(stepProgress);
    } else {
      finishBoot();
    }
  };

  window.requestAnimationFrame(stepProgress);
  // Hard safety timeout so loader can never get stuck
  window.setTimeout(finishBoot, 1300);
}

/* ==========================================================================
   1. ZERO-LAYOUT GPU SLIDING JELLY SEGMENTED CONTROLS (iOS 26)
   ========================================================================== */

interface SegmentedConfig {
  containerSelector: string;
  buttonSelector: string;
  activeClass: string;
}

const SEGMENTED_CONTROLS: SegmentedConfig[] = [
  {
    containerSelector: '.cf-subnav',
    buttonSelector: '.cf-subnav-btn',
    activeClass: 'cf-subnav-active',
  },
  {
    containerSelector: '.cf-source-tabs',
    buttonSelector: '.cf-source-tab',
    activeClass: 'cf-source-active',
  },
  {
    containerSelector: '.cf-auth-tabs',
    buttonSelector: '.cf-auth-tab',
    activeClass: 'cf-auth-active',
  },
  {
    containerSelector: '.cf-modal-pay-tabs',
    buttonSelector: '.cf-modal-pay-tab',
    activeClass: 'cf-pay-active',
  },
];

const thumbLastBox = new WeakMap<HTMLElement, { x: number; y: number; w: number; h: number }>();
let segResizeObserver: ResizeObserver | null = null;
const observedSegContainers = new WeakSet<HTMLElement>();

function ensureSegResizeObserver(): ResizeObserver | null {
  if (typeof ResizeObserver === 'undefined') return null;
  if (!segResizeObserver) {
    segResizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target instanceof HTMLElement && entry.target.offsetWidth > 0) {
          const thumb = entry.target.querySelector<HTMLElement>(':scope > .cf-apple-seg-thumb');
          if (!thumb || thumb.getAnimations().length === 0) {
            syncSegmentedControl(entry.target, false);
          }
        }
      }
    });
  }
  return segResizeObserver;
}

export function syncSegmentedControl(container: HTMLElement, animate = true): void {
  const cfg = SEGMENTED_CONTROLS.find((c) => container.matches(c.containerSelector));
  if (!cfg) return;

  if (!observedSegContainers.has(container)) {
    observedSegContainers.add(container);
    ensureSegResizeObserver()?.observe(container);
  }

  const activeBtn = container.querySelector<HTMLElement>(`.${cfg.activeClass}`);
  if (!activeBtn) return;

  const w = activeBtn.offsetWidth;
  const h = activeBtn.offsetHeight;
  const x = activeBtn.offsetLeft;
  const y = activeBtn.offsetTop;

  if (w <= 0 || h <= 0) return;

  let thumb = container.querySelector<HTMLElement>(':scope > .cf-apple-seg-thumb');
  if (!thumb) {
    thumb = document.createElement('div');
    thumb.className = 'cf-apple-seg-thumb';
    thumb.setAttribute('aria-hidden', 'true');
    container.prepend(thumb);
    animate = false;
  }

  container.classList.add('cf-seg-ready');

  const prev = thumbLastBox.get(thumb);
  let startX = prev ? prev.x : x;
  let startY = prev ? prev.y : y;
  let startW = prev ? prev.w : w;

  const runningAnims = thumb.getAnimations();
  if (runningAnims.length > 0) {
    const cRect = container.getBoundingClientRect();
    const tRect = thumb.getBoundingClientRect();
    const scale = container.offsetWidth > 0 ? cRect.width / container.offsetWidth : 1;
    if (scale > 0.1 && tRect.width > 0) {
      startX = (tRect.left - cRect.left) / scale - container.clientLeft;
      startY = (tRect.top - cRect.top) / scale - container.clientTop;
      startW = tRect.width / scale;
    }
    runningAnims.forEach((a) => a.cancel());
  }

  thumbLastBox.set(thumb, { x, y, w, h });

  // Set target dimensions ONCE; animate 100% via GPU `transform` (`transform-origin: 0 50%`)!
  thumb.style.width = `${w}px`;
  thumb.style.height = `${h}px`;
  thumb.style.transform = `translate3d(${x}px, ${y}px, 0) scale3d(1, 1, 1)`;

  const moved =
    Math.abs(startX - x) > 0.5 || Math.abs(startY - y) > 0.5 || Math.abs(startW - w) > 0.5;

  if (!animate || !prev || prefersReducedMotion() || !moved) {
    return;
  }

  const travel = Math.hypot(x - startX, y - startY);
  const { durationMs, samples } = computeSpringSamples('bouncy');

  const frames: Keyframe[] = samples.map((s, idx) => {
    const progress = idx / Math.max(samples.length - 1, 1);
    const sameRow = Math.abs(y - startY) < 4;
    // Volume-preserving Apple Jelly stretch mid-flight (`sx * sy ≈ 1`)
    const jellyFactor = sameRow
      ? Math.sin(progress * Math.PI) * Math.min(0.14, (travel / Math.max(w, 80)) * 0.09) * (1 - progress * 0.4)
      : 0;

    const baseW = lerp(startW, w, s);
    const visualW = Math.max(24, baseW * (1 + jellyFactor));
    const sx = visualW / Math.max(w, 1);
    const sy = 1 / Math.max(0.88, 1 + jellyFactor * 0.62);

    const curX = lerp(startX, x, s) - (visualW - baseW) * 0.5;
    const curY = lerp(startY, y, s);

    return {
      transform: `translate3d(${curX.toFixed(2)}px, ${curY.toFixed(2)}px, 0) scale3d(${sx.toFixed(4)}, ${sy.toFixed(4)}, 1)`,
    };
  });

  thumb.animate(frames, {
    duration: durationMs,
    easing: 'linear',
    fill: 'none',
  });
}

export function syncAllSegmentedControls(animate = false): void {
  for (const cfg of SEGMENTED_CONTROLS) {
    document.querySelectorAll<HTMLElement>(cfg.containerSelector).forEach((el) => {
      syncSegmentedControl(el, animate);
    });
  }
}

/* ==========================================================================
   2. DYNAMIC ISLAND HEADER, SCROLL-VELOCITY JELLY & PROGRESS FILAMENT
   ========================================================================== */

function initScrollFluidAndVelocityJelly(): void {
  const headerInner = document.querySelector<HTMLElement>('.cf-header-inner');
  const mobileDock = document.getElementById('cf-mobile-dock');

  let progressBar = document.getElementById('cf-scroll-progress-bar');
  if (!progressBar) {
    progressBar = document.createElement('div');
    progressBar.id = 'cf-scroll-progress-bar';
    progressBar.setAttribute('aria-hidden', 'true');
    document.body.appendChild(progressBar);
  }

  const landingView = document.getElementById('cf-view-landing');
  const heroBox = document.querySelector<HTMLElement>('#cf-view-landing .cf-hero');
  const reduced = prefersReducedMotion();

  let condensed = false;
  let scrollRaf = 0;
  let lastScrollY = window.scrollY || 0;
  let settleTimer: number | null = null;
  let cachedDocScrollMax = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);

  window.addEventListener(
    'resize',
    () => {
      cachedDocScrollMax = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    },
    { passive: true }
  );

  const updateScroll = () => {
    scrollRaf = 0;
    const scrollY = window.scrollY || 0;
    const dy = scrollY - lastScrollY;
    lastScrollY = scrollY;

    // 1. Dynamic Island Header condense
    if (headerInner) {
      const shouldCondense = scrollY > 24;
      if (shouldCondense !== condensed) {
        condensed = shouldCondense;
        headerInner.classList.toggle('cf-header-condensed', condensed);
        if (!reduced) {
          triggerAppleJelly(headerInner, 0.045, 420, true);
        }
      }
    }

    // 2. Top Liquid Filament (pure GPU scaleX, cached scrollHeight -> zero layout read!)
    if (progressBar) {
      const ratio = Math.max(0, Math.min(1, scrollY / cachedDocScrollMax));
      progressBar.style.transform = `scaleX(${ratio.toFixed(4)})`;
      progressBar.style.opacity = scrollY > 10 ? '1' : '0';
    }

    // 3. Subtle Scroll-Velocity Elastic Jelly on Floating Mobile Dock & Header
    if (!reduced && Math.abs(dy) > 4) {
      const clampedVel = Math.max(-1, Math.min(1, dy / 55));
      const sy = (1 + Math.abs(clampedVel) * 0.024).toFixed(4);
      const sx = (1 - Math.abs(clampedVel) * 0.018).toFixed(4);

      if (mobileDock && mobileDock.offsetWidth > 0) {
        mobileDock.style.scale = `${sx} ${sy}`;
      }

      if (settleTimer) window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        if (mobileDock && mobileDock.offsetWidth > 0) {
          mobileDock.style.scale = '';
          triggerAppleJelly(mobileDock, 0.04, 380, true);
        }
      }, 110);
    }

    // 4. Desktop-only gentle Hero depth parallax
    if (
      !reduced &&
      window.innerWidth > 768 &&
      heroBox &&
      landingView?.classList.contains('cf-view-active') &&
      scrollY < 620
    ) {
      heroBox.style.transform = `translate3d(0, ${(scrollY * 0.1).toFixed(1)}px, 0)`;
    } else if (heroBox && scrollY === 0) {
      heroBox.style.transform = '';
    }
  };

  window.addEventListener(
    'scroll',
    () => {
      if (!scrollRaf) {
        scrollRaf = window.requestAnimationFrame(updateScroll);
      }
    },
    { passive: true }
  );
  updateScroll();
}

/* ==========================================================================
   3. APPLE KEYNOTE JELLY-SPRING HERO ENTRANCE
   ========================================================================== */

export function animateHeroEntrance(): void {
  if (prefersReducedMotion()) return;
  const hero = document.querySelector<HTMLElement>('#cf-view-landing .cf-hero');
  if (!hero) return;

  hero.style.transform = '';

  const targets = [
    hero.querySelector<HTMLElement>('.cf-hero-kicker'),
    hero.querySelector<HTMLElement>('.cf-hero-title'),
    hero.querySelector<HTMLElement>('.cf-hero-sub'),
    hero.querySelector<HTMLElement>('.cf-hero-actions'),
    hero.querySelector<HTMLElement>('.cf-hero-glass-strip'),
  ].filter((el): el is HTMLElement => Boolean(el));

  const { durationMs, samples } = computeSpringSamples('bouncy');

  targets.forEach((el, index) => {
    el.getAnimations().forEach((a) => a.cancel());
    el.animate(
      samples.map((s, idx) => {
        const p = idx / Math.max(samples.length - 1, 1);
        const jelly = Math.sin(p * Math.PI * 2) * 0.026 * (1 - p);
        const scX = lerp(0.94, 1, s) + jelly;
        const scY = lerp(0.94, 1, s) - jelly * 0.7;
        return {
          opacity: String(Math.max(0, Math.min(1, s * 1.22))),
          transform: `translate3d(0, ${lerp(24, 0, s).toFixed(2)}px, 0) scale3d(${scX.toFixed(4)}, ${scY.toFixed(4)}, 1)`,
        };
      }),
      {
        duration: durationMs,
        delay: index * 55,
        easing: 'linear',
        fill: 'backwards',
      }
    );
  });

  const chips = hero.querySelectorAll<HTMLElement>('.cf-hero-glass-chip');
  const jellySpring = computeSpringSamples('jelly');
  chips.forEach((chip, idx) => {
    chip.getAnimations().forEach((a) => a.cancel());
    chip.animate(
      jellySpring.samples.map((s, i) => {
        const p = i / Math.max(jellySpring.samples.length - 1, 1);
        const w = Math.sin(p * Math.PI * 2.5) * 0.045 * (1 - p);
        return {
          opacity: String(Math.max(0, Math.min(1, s * 1.25))),
          transform: `translate3d(0, ${lerp(12, 0, s).toFixed(2)}px, 0) scale3d(${(lerp(0.86, 1, s) + w).toFixed(4)}, ${(lerp(0.86, 1, s) - w * 0.7).toFixed(4)}, 1)`,
        };
      }),
      {
        duration: jellySpring.durationMs,
        delay: 210 + idx * 45,
        easing: 'linear',
        fill: 'backwards',
      }
    );
  });
}

/* ==========================================================================
   4. SPATIAL SPA VIEW & JELLY DIRECTIONAL TAB TRANSITIONS
   ========================================================================== */

const VIEW_ORDER: Record<string, number> = {
  landing: 0,
  auth: 1,
  dashboard: 2,
};

export function animateSpaViewEnter(viewEl: HTMLElement, fromViewId: string, toViewId: string): void {
  if (prefersReducedMotion()) return;

  const dir = (VIEW_ORDER[toViewId] ?? 1) >= (VIEW_ORDER[fromViewId] ?? 0) ? 1 : -1;
  const { durationMs, samples } = computeSpringSamples('fluid');

  viewEl.getAnimations().forEach((a) => a.cancel());
  viewEl.animate(
    samples.map((s) => ({
      opacity: String(Math.max(0, Math.min(1, s * 1.25))),
      transform: `translate3d(${lerp(dir * 22, 0, s).toFixed(2)}px, ${lerp(8, 0, s).toFixed(2)}px, 0) scale3d(${lerp(0.984, 1, s).toFixed(4)}, ${lerp(0.984, 1, s).toFixed(4)}, 1)`,
    })),
    { duration: durationMs, easing: 'linear' }
  );

  const headerInner = document.querySelector<HTMLElement>('.cf-header-inner');
  triggerAppleJelly(headerInner, 0.038, 420, true);
}

export function animatePanelDirectionalEnter(panelEl: HTMLElement, direction = 1): void {
  if (!panelEl || prefersReducedMotion()) return;
  const { durationMs, samples } = computeSpringSamples('snappy');

  panelEl.getAnimations().forEach((a) => a.cancel());
  panelEl.animate(
    samples.map((s) => ({
      opacity: String(Math.max(0, Math.min(1, s * 1.28))),
      transform: `translate3d(${lerp(direction * 16, 0, s).toFixed(2)}px, 0, 0) scale3d(${lerp(0.988, 1, s).toFixed(4)}, ${lerp(0.988, 1, s).toFixed(4)}, 1)`,
    })),
    { duration: durationMs, easing: 'linear' }
  );
}

/* ==========================================================================
   5. TACTILE SILICONE JELLY BUTTONS, LIQUID RIPPLE & DESKTOP 3D CARD TILT
   ========================================================================== */

function spawnLiquidClickRipple(host: HTMLElement, clientX: number, clientY: number): void {
  if (prefersReducedMotion()) return;
  const rect = host.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;

  const size = Math.max(rect.width, rect.height) * 1.25;
  const x = clientX - rect.left - size * 0.5;
  const y = clientY - rect.top - size * 0.5;

  const ripple = document.createElement('span');
  ripple.className = 'cf-apple-ripple';
  ripple.setAttribute('aria-hidden', 'true');
  ripple.style.cssText = `width:${size.toFixed(0)}px;height:${size.toFixed(0)}px;left:${x.toFixed(0)}px;top:${y.toFixed(0)}px;`;

  host.appendChild(ripple);
  const anim = ripple.animate(
    [
      { transform: 'scale3d(0.15, 0.15, 1)', opacity: '0.40' },
      { transform: 'scale3d(1.85, 1.85, 1)', opacity: '0' },
    ],
    { duration: 480, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
  );
  anim.onfinish = () => ripple.remove();
}

function initJellyTactileAndDesktopTilt(): void {
  if (prefersReducedMotion()) return;

  const TACTILE_SELECTOR =
    '.cf-btn, .cf-play-btn, .cf-ctrl-icon-btn, .cf-nav-link, .cf-tag-pill, .cf-hero-glass-chip, .cf-logo, .cf-dock-btn';
  const RIPPLE_SELECTOR = '.cf-btn-primary, .cf-btn-ghost, .cf-play-btn, .cf-hero-glass-chip';
  const TILT_CARD_SELECTOR =
    '.cf-step-card, .cf-social-card, .cf-pricing-card, .cf-card, .cf-history-item';

  let pressedEl: HTMLElement | null = null;

  document.addEventListener(
    'pointerdown',
    (e: PointerEvent) => {
      const target =
        e.target instanceof HTMLElement ? e.target.closest<HTMLElement>(TACTILE_SELECTOR) : null;
      if (!target || (target as HTMLButtonElement).disabled) return;
      pressedEl = target;
      target.classList.add('cf-apple-pressing');

      const rippleHost =
        e.target instanceof HTMLElement ? e.target.closest<HTMLElement>(RIPPLE_SELECTOR) : null;
      if (rippleHost && !(rippleHost as HTMLButtonElement).disabled) {
        spawnLiquidClickRipple(rippleHost, e.clientX, e.clientY);
      }
    },
    { passive: true }
  );

  const releasePress = () => {
    if (!pressedEl) return;
    const el = pressedEl;
    pressedEl = null;
    el.classList.remove('cf-apple-pressing');
    // Authentic Apple Volume-Preserving Jelly Rebound on release!
    const isDock = el.classList.contains('cf-dock-btn');
    triggerAppleJelly(el, isDock ? 0.13 : 0.082, isDock ? 540 : 460, true);
  };

  window.addEventListener('pointerup', releasePress, { passive: true });
  window.addEventListener('pointercancel', releasePress, { passive: true });

  // Desktop-only 3D Card Tilt (never runs on touch screens -> 0% mobile overhead!)
  const hasFinePointer =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  if (!hasFinePointer) return;

  let activeTiltCard: HTMLElement | null = null;
  let tiltRect: DOMRect | null = null;
  let targetRotX = 0;
  let targetRotY = 0;
  let curRotX = 0;
  let curRotY = 0;
  let inertiaRaf = 0;

  const stepTilt = () => {
    if (!activeTiltCard || !activeTiltCard.isConnected) {
      inertiaRaf = 0;
      return;
    }

    curRotX += (targetRotX - curRotX) * 0.2;
    curRotY += (targetRotY - curRotY) * 0.2;

    activeTiltCard.style.transform = `perspective(1000px) rotateX(${curRotX.toFixed(2)}deg) rotateY(${curRotY.toFixed(2)}deg) translate3d(0, -4px, 0)`;

    if (Math.abs(targetRotX - curRotX) > 0.02 || Math.abs(targetRotY - curRotY) > 0.02) {
      inertiaRaf = window.requestAnimationFrame(stepTilt);
    } else {
      inertiaRaf = 0;
    }
  };

  const resetCard = (card: HTMLElement) => {
    card.style.transform = '';
  };

  document.addEventListener(
    'pointerover',
    (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      const nextCard = t ? t.closest<HTMLElement>(TILT_CARD_SELECTOR) : null;
      if (activeTiltCard !== nextCard) {
        if (activeTiltCard) resetCard(activeTiltCard);
        activeTiltCard = nextCard;
        tiltRect = nextCard ? nextCard.getBoundingClientRect() : null;
        curRotX = 0;
        curRotY = 0;
      }
    },
    { passive: true }
  );

  window.addEventListener(
    'scroll',
    () => {
      tiltRect = null;
    },
    { passive: true }
  );

  window.addEventListener(
    'pointermove',
    (e: PointerEvent) => {
      if (e.pointerType === 'touch' || !activeTiltCard) return;
      if (!tiltRect) tiltRect = activeTiltCard.getBoundingClientRect();
      if (tiltRect.width > 0 && tiltRect.height > 0) {
        const nx = Math.max(-1, Math.min(1, ((e.clientX - tiltRect.left) / tiltRect.width - 0.5) * 2));
        const ny = Math.max(-1, Math.min(1, ((e.clientY - tiltRect.top) / tiltRect.height - 0.5) * 2));
        targetRotX = -ny * 2.4;
        targetRotY = nx * 2.6;
        if (!inertiaRaf) {
          inertiaRaf = window.requestAnimationFrame(stepTilt);
        }
      }
    },
    { passive: true }
  );
}

/* ==========================================================================
   6. FILE JELLY ISLAND, QUOTA SPRING, PIPELINE TELEMETRY & ERROR SHAKE
   ========================================================================== */

export function animateFileSelectedCapsule(barEl: HTMLElement | null): void {
  if (!barEl || prefersReducedMotion()) return;
  const { durationMs, samples } = computeSpringSamples('jelly');
  barEl.getAnimations().forEach((a) => a.cancel());
  barEl.animate(
    samples.map((s, idx) => {
      const p = idx / Math.max(samples.length - 1, 1);
      const w = Math.sin(p * Math.PI * 2.5) * 0.06 * (1 - p);
      return {
        opacity: String(Math.max(0, Math.min(1, s * 1.3))),
        transform: `translate3d(0, ${lerp(12, 0, s).toFixed(2)}px, 0) scale3d(${(lerp(0.84, 1, s) + w).toFixed(4)}, ${(lerp(0.78, 1, s) - w * 0.7).toFixed(4)}, 1)`,
      };
    }),
    { duration: durationMs, easing: 'linear' }
  );
}

export function animateQuotaBarSpring(): void {
  const fill = document.getElementById('cf-quota-fill');
  if (!fill || prefersReducedMotion()) return;
  fill.getAnimations().forEach((a) => a.cancel());
  fill.animate(
    [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }],
    { duration: 640, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
  );
}

export function animateMacOSErrorShake(errorEl: HTMLElement | null): void {
  if (!errorEl || prefersReducedMotion()) return;
  errorEl.getAnimations().forEach((a) => a.cancel());
  errorEl.animate(
    [
      { transform: 'translate3d(0, 0, 0)' },
      { transform: 'translate3d(-10px, 0, 0) scale3d(1.02, 0.98, 1)' },
      { transform: 'translate3d(9px, 0, 0) scale3d(0.98, 1.02, 1)' },
      { transform: 'translate3d(-7px, 0, 0)' },
      { transform: 'translate3d(5px, 0, 0)' },
      { transform: 'translate3d(-3px, 0, 0)' },
      { transform: 'translate3d(0, 0, 0)' },
    ],
    { duration: 420, easing: 'cubic-bezier(0.36, 0.07, 0.19, 0.97)' }
  );
}

function initPipelineAndPlayerObservers(): void {
  const procBox = document.getElementById('cf-processing-box');
  if (procBox) {
    let wasVisible = procBox.style.display !== 'none' && procBox.classList.contains('cf-active');
    const stepStates = new Map<string, string>();

    const obs = new MutationObserver(() => {
      const isVisible =
        procBox.style.display !== 'none' &&
        (procBox.classList.contains('cf-active') || procBox.offsetHeight > 0);
      if (isVisible && !wasVisible && !prefersReducedMotion()) {
        triggerAppleJelly(procBox, 0.05, 480, false);
      }
      wasVisible = isVisible;

      for (let i = 0; i < 5; i++) {
        const id = `cf-pstep-${i}`;
        const stepEl = document.getElementById(id);
        if (!stepEl) continue;
        const cls = stepEl.className;
        const prevCls = stepStates.get(id) || '';
        if (cls !== prevCls) {
          stepStates.set(id, cls);
          if (
            (cls.includes('cf-step-done') && !prevCls.includes('cf-step-done')) ||
            (cls.includes('cf-step-active') && !prevCls.includes('cf-step-active'))
          ) {
            const icon = stepEl.querySelector<HTMLElement>('.cf-step-icon');
            triggerAppleJelly(icon || stepEl, 0.14, 480, true);
          }
        }
      }
    });

    obs.observe(procBox, { attributes: true, subtree: true, attributeFilter: ['class', 'style'] });
  }

  const dropzone = document.getElementById('cf-upload-dropzone');
  if (dropzone) {
    dropzone.addEventListener(
      'drop',
      () => {
        triggerAppleJelly(dropzone, 0.065, 520, true);
      },
      { passive: true }
    );
  }

  const video = document.getElementById('cf-preview-video-el') as HTMLVideoElement | null;
  const playBtn = document.getElementById('cf-prev-play-btn');
  const stage = document.querySelector<HTMLElement>('.cf-video-stage');
  if (video) {
    video.addEventListener('play', () => {
      stage?.classList.add('cf-stage-playing');
      triggerAppleJelly(playBtn, 0.12, 460, true);
    });
    video.addEventListener('pause', () => {
      stage?.classList.remove('cf-stage-playing');
      triggerAppleJelly(playBtn, 0.1, 420, true);
    });
    video.addEventListener('ended', () => {
      stage?.classList.remove('cf-stage-playing');
    });
  }
}

/* ==========================================================================
   7. VIRAL CUT CARDS JELLY-SPRING WAVE CASCADE
   ========================================================================== */

export function animateCardsWaveCascade(container: HTMLElement | null, itemSelector: string): void {
  if (!container || prefersReducedMotion()) return;
  const items = container.querySelectorAll<HTMLElement>(itemSelector);
  if (items.length === 0) return;

  const { durationMs, samples } = computeSpringSamples('bouncy');

  items.forEach((card, idx) => {
    card.getAnimations().forEach((a) => a.cancel());
    card.animate(
      samples.map((s) => ({
        opacity: String(Math.max(0, Math.min(1, s * 1.25))),
        transform: `translate3d(0, ${lerp(26, 0, s).toFixed(2)}px, 0) scale3d(${lerp(0.94, 1, s).toFixed(4)}, ${lerp(0.94, 1, s).toFixed(4)}, 1)`,
      })),
      {
        duration: durationMs,
        delay: Math.min(idx * 45, 450),
        easing: 'linear',
        fill: 'backwards',
      }
    );
  });
}

/* ==========================================================================
   8. iOS 26 JELLY MODALS, NATIVE MOBILE BOTTOM SHEETS & TOUCH SWIPE-TO-CLOSE
   ========================================================================== */

export function openAppleModal(modalBackdrop: HTMLElement | null): void {
  if (!modalBackdrop) return;
  modalBackdrop.classList.remove('cf-modal-closing');
  modalBackdrop.classList.add('cf-modal-open');

  const box = modalBackdrop.querySelector<HTMLElement>('.cf-modal-box, .cf-video-modal-box');
  if (box) {
    box.style.transform = '';
    if (!prefersReducedMotion()) {
      const isMobile = window.innerWidth <= 768;
      const { durationMs, samples } = computeSpringSamples(isMobile ? 'sheet' : 'bouncy');
      box.getAnimations().forEach((a) => a.cancel());
      box.animate(
        samples.map((s, idx) => {
          const p = idx / Math.max(samples.length - 1, 1);
          const jelly = isMobile ? 0 : Math.sin(p * Math.PI * 2) * 0.025 * (1 - p);
          const startY = isMobile ? 160 : 28;
          const scX = isMobile ? 1 : lerp(0.88, 1, s) + jelly;
          const scY = isMobile ? 1 : lerp(0.88, 1, s) - jelly * 0.7;
          return {
            opacity: String(Math.max(0, Math.min(1, s * 1.35))),
            transform: `translate3d(0, ${lerp(startY, 0, s).toFixed(2)}px, 0) scale3d(${scX.toFixed(4)}, ${scY.toFixed(4)}, 1)`,
          };
        }),
        { duration: durationMs, easing: 'linear' }
      );
    }
  }

  window.requestAnimationFrame(() => syncAllSegmentedControls(false));
}

export function closeAppleModal(modalBackdrop: HTMLElement | null, onClosed?: () => void): void {
  if (!modalBackdrop || !modalBackdrop.classList.contains('cf-modal-open')) {
    onClosed?.();
    return;
  }

  if (prefersReducedMotion()) {
    modalBackdrop.classList.remove('cf-modal-open');
    onClosed?.();
    return;
  }

  const box = modalBackdrop.querySelector<HTMLElement>('.cf-modal-box, .cf-video-modal-box');
  modalBackdrop.classList.add('cf-modal-closing');
  const isMobile = window.innerWidth <= 768;

  if (box) {
    box.getAnimations().forEach((a) => a.cancel());
    const anim = box.animate(
      [
        { opacity: '1', transform: box.style.transform || 'translate3d(0, 0, 0) scale3d(1, 1, 1)' },
        {
          opacity: '0',
          transform: isMobile
            ? 'translate3d(0, 180px, 0) scale3d(1, 1, 1)'
            : 'translate3d(0, 18px, 0) scale3d(0.93, 0.93, 1)',
        },
      ],
      { duration: 200, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' }
    );
    anim.onfinish = () => {
      box.style.transform = '';
      modalBackdrop.classList.remove('cf-modal-open', 'cf-modal-closing');
      onClosed?.();
    };
  } else {
    modalBackdrop.classList.remove('cf-modal-open', 'cf-modal-closing');
    onClosed?.();
  }
}

function initMobileSheetTouchSwipe(): void {
  const attachSwipe = (modalId: string, closeFnName: string) => {
    const backdrop = document.getElementById(modalId);
    const box = backdrop?.querySelector<HTMLElement>('.cf-modal-box, .cf-video-modal-box');
    if (!backdrop || !box) return;

    let startY = 0;
    let currentDy = 0;
    let dragging = false;

    box.addEventListener(
      'touchstart',
      (e: TouchEvent) => {
        if (window.innerWidth > 768 || e.touches.length !== 1) return;
        const target = e.target as HTMLElement | null;
        // Do not hijack range sliders (<input type="range">) or scrollable inner text unless at scrollTop === 0
        if (target && target.tagName === 'INPUT' && (target as HTMLInputElement).type === 'range') {
          return;
        }
        if (box.scrollTop > 2 && !target?.closest('.cf-sheet-grabber')) return;

        startY = e.touches[0].clientY;
        currentDy = 0;
        dragging = true;
      },
      { passive: true }
    );

    box.addEventListener(
      'touchmove',
      (e: TouchEvent) => {
        if (!dragging || e.touches.length !== 1) return;
        const dy = e.touches[0].clientY - startY;
        if (dy > 0) {
          // Apple rubber-band damping
          currentDy = Math.pow(dy, 0.88) * 1.25;
          box.style.transform = `translate3d(0, ${currentDy.toFixed(1)}px, 0)`;
        } else {
          currentDy = 0;
          box.style.transform = '';
        }
      },
      { passive: true }
    );

    const endTouch = () => {
      if (!dragging) return;
      dragging = false;

      if (currentDy > 88) {
        const w = window as unknown as Record<string, (() => void) | undefined>;
        w[closeFnName]?.();
      } else if (currentDy > 2) {
        const fromY = currentDy;
        box.style.transform = '';
        const { durationMs, samples } = computeSpringSamples('bouncy');
        box.animate(
          samples.map((s) => ({
            transform: `translate3d(0, ${lerp(fromY, 0, s).toFixed(1)}px, 0)`,
          })),
          { duration: durationMs, easing: 'linear' }
        );
      }
      currentDy = 0;
    };

    box.addEventListener('touchend', endTouch, { passive: true });
    box.addEventListener('touchcancel', endTouch, { passive: true });
  };

  attachSwipe('cf-upgrade-modal', 'cfCloseUpgradeModal');
  attachSwipe('cf-video-preview-modal', 'cfClosePreviewModal');
}

/* ==========================================================================
   9. DYNAMIC ISLAND JELLY TOAST & MOBILE BOTTOM LIQUID GLASS DOCK
   ========================================================================== */

export function animateDynamicIslandToast(toastEl: HTMLElement | null): void {
  if (!toastEl || prefersReducedMotion()) return;

  const alreadyShown = toastEl.classList.contains('cf-toast-show');
  const { durationMs, samples } = computeSpringSamples('jelly');

  toastEl.getAnimations().forEach((a) => a.cancel());

  if (alreadyShown) {
    toastEl.animate(
      samples.map((_, idx) => {
        const p = idx / Math.max(samples.length - 1, 1);
        const swell = Math.sin(p * Math.PI * 2.5) * 0.085 * (1 - p);
        return {
          transform: `translate3d(-50%, 0, 0) scale3d(${(1 + swell).toFixed(4)}, ${(1 - swell * 0.65).toFixed(4)}, 1)`,
        };
      }),
      { duration: 420, easing: 'linear' }
    );
  } else {
    toastEl.animate(
      samples.map((s, idx) => {
        const p = idx / Math.max(samples.length - 1, 1);
        const wobble = Math.sin(p * Math.PI * 2.5) * 0.06 * (1 - p);
        return {
          opacity: String(Math.max(0, Math.min(1, s * 1.3))),
          transform: `translate3d(-50%, ${lerp(32, 0, s).toFixed(2)}px, 0) scale3d(${(lerp(0.74, 1, s) + wobble).toFixed(4)}, ${(lerp(0.8, 1, s) - wobble * 0.65).toFixed(4)}, 1)`,
        };
      }),
      { duration: durationMs, easing: 'linear' }
    );
  }
}

export function syncMobileDockState(activeView?: string, activeDashTab?: string): void {
  const dockGuest = document.getElementById('cf-mobile-dock-guest');
  const dockUser = document.getElementById('cf-mobile-dock-user');
  if (!dockGuest || !dockUser) return;

  const isLogged = document.getElementById('cf-nav-user')?.style.display !== 'none';
  dockGuest.style.display = isLogged ? 'none' : 'flex';
  dockUser.style.display = isLogged ? 'flex' : 'none';

  const view =
    activeView ||
    (document.getElementById('cf-view-dashboard')?.classList.contains('cf-view-active')
      ? 'dashboard'
      : document.getElementById('cf-view-auth')?.classList.contains('cf-view-active')
      ? 'auth'
      : 'landing');

  const tab =
    activeDashTab ||
    (document.getElementById('cf-subnav-history')?.classList.contains('cf-subnav-active')
      ? 'history'
      : document.getElementById('cf-subnav-plan')?.classList.contains('cf-subnav-active')
      ? 'plan'
      : 'generator');

  document.querySelectorAll<HTMLElement>('#cf-mobile-dock .cf-dock-btn').forEach((btn) => {
    const key = btn.getAttribute('data-dock-key');
    const isActive =
      (view === 'landing' && key === 'landing') ||
      (view === 'auth' && key === 'auth') ||
      (view === 'dashboard' && key === `dash-${tab}`);
    btn.classList.toggle('cf-dock-active', isActive);
  });
}

/* ==========================================================================
   AUTO-WIRING TO WINDOW.CF* HANDLERS & INITIALIZATION
   ========================================================================== */

function initStaggeredScrollReveals(): void {
  document
    .querySelectorAll<HTMLElement>('.cf-steps-grid, .cf-social-grid, .cf-pricing-grid')
    .forEach((grid) => {
      Array.from(grid.children).forEach((child, idx) => {
        if (child instanceof HTMLElement) {
          child.style.setProperty('--cf-stagger-idx', String(idx));
        }
      });
    });
}

function wireClipFireHandlersWithAppleMotion(): void {
  const w = window as unknown as Record<string, any>;

  let currentView = document.getElementById('cf-view-dashboard')?.classList.contains('cf-view-active')
    ? 'dashboard'
    : 'landing';
  let lastDashTab = 'generator';

  const origNavigate = w.cfNavigate;
  if (typeof origNavigate === 'function') {
    w.cfNavigate = function (viewId: string, subParam?: string) {
      const prevView = currentView;
      currentView = viewId;

      origNavigate.call(this, viewId, subParam);

      const target = document.getElementById(`cf-view-${viewId}`);
      if (target && prevView !== viewId) {
        animateSpaViewEnter(target, prevView, viewId);
        if (viewId === 'landing' && bootFinished) {
          animateHeroEntrance();
        }
      }

      syncAllSegmentedControls(false);
      syncMobileDockState(viewId, viewId === 'dashboard' ? subParam || lastDashTab : undefined);
    };
  }

  const DASH_TAB_ORDER: Record<string, number> = { generator: 0, history: 1, plan: 2 };
  const origSwitchDashTab = w.cfSwitchDashTab;
  if (typeof origSwitchDashTab === 'function') {
    w.cfSwitchDashTab = function (tabId: string) {
      const dir = (DASH_TAB_ORDER[tabId] ?? 0) >= (DASH_TAB_ORDER[lastDashTab] ?? 0) ? 1 : -1;
      const changed = tabId !== lastDashTab;
      lastDashTab = tabId;

      origSwitchDashTab.call(this, tabId);

      const subnav = document.querySelector<HTMLElement>('.cf-subnav');
      if (subnav) syncSegmentedControl(subnav, true);

      if (changed) {
        const panel = document.getElementById(`cf-subview-${tabId}`);
        if (panel) animatePanelDirectionalEnter(panel, dir);
      }
      if (tabId === 'plan') {
        animateQuotaBarSpring();
      }
      syncMobileDockState('dashboard', tabId);
    };
  }

  let lastSourceMode = 'upload';
  const origSwitchSource = w.cfSwitchSourceMode;
  if (typeof origSwitchSource === 'function') {
    w.cfSwitchSourceMode = function (mode: string) {
      const next = mode === 'url' ? 'url' : 'upload';
      const dir = next === 'url' ? 1 : -1;
      const changed = next !== lastSourceMode;
      lastSourceMode = next;

      origSwitchSource.call(this, mode);

      const tabs = document.querySelector<HTMLElement>('.cf-source-tabs');
      if (tabs) syncSegmentedControl(tabs, true);

      if (changed) {
        const panel = document.getElementById(
          next === 'upload' ? 'cf-source-panel-upload' : 'cf-source-panel-url'
        );
        if (panel) animatePanelDirectionalEnter(panel, dir);
      }
    };
  }

  let lastAuthMode = 'login';
  const origSwitchAuth = w.cfSwitchAuthTab;
  if (typeof origSwitchAuth === 'function') {
    w.cfSwitchAuthTab = function (mode: string) {
      const changed = mode !== lastAuthMode;
      lastAuthMode = mode;

      origSwitchAuth.call(this, mode);

      const tabs = document.querySelector<HTMLElement>('.cf-auth-tabs');
      if (tabs) syncSegmentedControl(tabs, true);

      if (changed) {
        const authForm = document.getElementById('cf-auth-form');
        triggerAppleJelly(authForm, 0.032, 380, false);
      }
    };
  }

  let lastPayMethod = 'pix';
  const origSwitchPay = w.cfSwitchPayTab;
  if (typeof origSwitchPay === 'function') {
    w.cfSwitchPayTab = function (method: string) {
      const dir = method === 'card' ? 1 : -1;
      const changed = method !== lastPayMethod;
      lastPayMethod = method;

      origSwitchPay.call(this, method);

      const tabs = document.querySelector<HTMLElement>('.cf-modal-pay-tabs');
      if (tabs) syncSegmentedControl(tabs, true);

      if (changed) {
        const content = document.getElementById(
          method === 'pix' ? 'cf-pay-content-pix' : 'cf-pay-content-card'
        );
        if (content) animatePanelDirectionalEnter(content, dir);
      }
    };
  }

  const origOpenUpgrade = w.cfOpenUpgradeModal;
  if (typeof origOpenUpgrade === 'function') {
    w.cfOpenUpgradeModal = function (...args: unknown[]) {
      origOpenUpgrade.apply(this, args);
      openAppleModal(document.getElementById('cf-upgrade-modal'));
    };
  }

  const origCloseUpgrade = w.cfCloseUpgradeModal;
  if (typeof origCloseUpgrade === 'function') {
    w.cfCloseUpgradeModal = function () {
      const modal = document.getElementById('cf-upgrade-modal');
      closeAppleModal(modal, () => origCloseUpgrade.call(this));
    };
  }

  const origPlayPreview = w.cfPlayPreview;
  if (typeof origPlayPreview === 'function') {
    w.cfPlayPreview = async function (...args: unknown[]) {
      await origPlayPreview.apply(this, args);
      const modal = document.getElementById('cf-video-preview-modal');
      if (modal && modal.classList.contains('cf-modal-open')) {
        openAppleModal(modal);
      }
    };
  }

  const origClosePreview = w.cfClosePreviewModal;
  if (typeof origClosePreview === 'function') {
    w.cfClosePreviewModal = function () {
      const modal = document.getElementById('cf-video-preview-modal');
      const video = document.getElementById('cf-preview-video-el') as HTMLVideoElement | null;
      if (video) video.pause();
      closeAppleModal(modal, () => origClosePreview.call(this));
    };
  }

  const origShowToast = w.cfShowToast;
  if (typeof origShowToast === 'function') {
    w.cfShowToast = function (msg: string) {
      const toast = document.getElementById('cf-toast');
      animateDynamicIslandToast(toast);
      origShowToast.call(this, msg);
    };
  }

  const origConfirmPay = w.cfConfirmSimulatedPayment;
  if (typeof origConfirmPay === 'function') {
    w.cfConfirmSimulatedPayment = async function (...args: unknown[]) {
      await origConfirmPay.apply(this, args);
      document
        .querySelectorAll<HTMLElement>('#cf-nav-plan-badge, #cf-dash-plan-badge, #cf-my-plan-title')
        .forEach((b) => triggerAppleJelly(b, 0.14, 520, true));
    };
  }

  const origLogout = w.cfLogout;
  if (typeof origLogout === 'function') {
    w.cfLogout = function (...args: unknown[]) {
      origLogout.apply(this, args);
      syncMobileDockState('landing');
    };
  }

  const cardsGrid = document.getElementById('cf-cards-grid');
  if (cardsGrid) {
    const gridObs = new MutationObserver((mutations) => {
      if (mutations.some((m) => m.addedNodes.length > 0)) {
        animateCardsWaveCascade(cardsGrid, '.cf-card');
      }
    });
    gridObs.observe(cardsGrid, { childList: true });
  }

  const historyList = document.getElementById('cf-history-list');
  if (historyList) {
    const histObs = new MutationObserver((mutations) => {
      if (mutations.some((m) => m.addedNodes.length > 0)) {
        animateCardsWaveCascade(historyList, '.cf-history-item, .cf-empty-state');
      }
    });
    histObs.observe(historyList, { childList: true });
  }

  const fileBar = document.getElementById('cf-file-selected-bar');
  if (fileBar) {
    let wasShown = fileBar.classList.contains('cf-show');
    const barObs = new MutationObserver(() => {
      const nowShown = fileBar.classList.contains('cf-show');
      if (nowShown && !wasShown) {
        animateFileSelectedCapsule(fileBar);
      }
      wasShown = nowShown;
    });
    barObs.observe(fileBar, { attributes: true, attributeFilter: ['class'] });
  }

  const errBox = document.getElementById('cf-url-error');
  if (errBox) {
    const errObs = new MutationObserver(() => {
      if (errBox.classList.contains('cf-visible')) {
        animateMacOSErrorShake(errBox);
      }
    });
    errObs.observe(errBox, { attributes: true, childList: true, subtree: true });
  }

  let resizeRaf = 0;
  window.addEventListener(
    'resize',
    () => {
      if (!resizeRaf) {
        resizeRaf = window.requestAnimationFrame(() => {
          resizeRaf = 0;
          syncAllSegmentedControls(false);
        });
      }
    },
    { passive: true }
  );
}

let isMotionMounted = false;

export function mountAppleMotionSystem(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (isMotionMounted) return;
  isMotionMounted = true;

  const boot = () => {
    initScrollFluidAndVelocityJelly();
    initStaggeredScrollReveals();
    initJellyTactileAndDesktopTilt();
    initPipelineAndPlayerObservers();
    initMobileSheetTouchSwipe();
    wireClipFireHandlersWithAppleMotion();
    syncAllSegmentedControls(false);
    syncMobileDockState();

    initAppleBootScreen(() => {
      const landingActive = document
        .getElementById('cf-view-landing')
        ?.classList.contains('cf-view-active');
      if (landingActive) {
        animateHeroEntrance();
      }
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    window.requestAnimationFrame(boot);
  }
}
