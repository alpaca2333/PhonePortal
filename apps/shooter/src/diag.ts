// The BROWSER half of the hitch profiler: sampling, the on-screen readout, the console report.
//
// The rules that decide WHAT a long frame was live in diagcore.ts (pure, Node-tested). This file only
// gathers the signals those rules need and shows the result — because the device where the stutter
// happens is a phone, and a phone has no DevTools console attached.
//
// HOW TO USE IT (documented in apps/shooter/README.md):
//   * open the game with `?diag=1` (e.g. http://localhost:3000/apps/shooter/?diag=1);
//   * the HUD's top-right corner grows a line: `60fps · 最差 412ms(gc) · 堆 182MB`;
//   * under it, a second line prints the RESOLUTION CHAIN: which viewport/dpr/「像素化」 block are in
//     play, how many texels that renders, and how much WORLD each pixel covers — plus the other
//     orientation's last measurement, so rotating the phone once answers "why does landscape look
//     lower resolution?" with a ratio instead of an impression (postfx.ts::resolutionText);
//   * TAP that readout to open the hitch table (cause + ms + context for the worst frames) and the
//     full per-orientation chains;
//   * `__SHOOTER_DIAG__.report()` / `.json()` in the console gives the same thing as data.
//
// COST WHEN OFF: `createDiag()` with the flag absent returns an object whose methods return
// immediately, so the frame loop pays three empty calls and no `performance.now()`.
import {
  FrameSample, HitchCause, HitchLog, HitchRecord, Phase, classifyHitch, diagRequested, heapDelta,
} from './diagcore.js';
// The resolution chain (what the profiler prints next to the frame rate). PURE, and owned by postfx.ts
// for the same reason the attribution rules are owned by diagcore.ts: 「横屏比竖屏糊」 is a numerical
// question, so it is answered by numbers that Node can assert (verify-diag.mjs section 6).
import { ResolutionChain, ResolutionFacts, resolutionChain, resolutionText } from './postfx.js';

/** What the profiler pulls from the renderer each frame (GameRenderer::debugInfo — one object read). */
export interface DiagInfo { calls: number; triangles: number; programs: number; geometries: number; textures: number; }
/** …and from the simulation/HUD side (cheap counters, no traversal). */
export interface DiagCounts { enemies: number; bullets: number; particles: number; loading: boolean; }

export interface DiagOptions {
  info: () => DiagInfo;
  counts: () => DiagCounts;
  /**
   * The render-resolution chain (GameRenderer::debugResolution): viewport, dpr, 「像素化」 block,
   * rendered texels and the camera's world-per-CSS-px. Optional — without it the profiler behaves
   * exactly as it did before the readout existed.
   */
  resolution?: () => ResolutionFacts;
  /** Overridable for tests; defaults to the page URL. */
  search?: string;
  hash?: string;
}

export interface Diag {
  /** False when the URL did not ask for the profiler: every method below is then a no-op. */
  readonly enabled: boolean;
  /** The records, for `report()`/`json()` and for tests. Empty when disabled. */
  readonly log: HitchLog;
  beginFrame(nowMs: number): void;
  begin(phase: Phase): void;
  end(phase: Phase): void;
  endFrame(): void;
  /** Print the summary + the worst hitches to the console. */
  report(): void;
  /** The whole report as a JSON string (console-friendly: `copy(__SHOOTER_DIAG__.json())`). */
  json(): string;
  reset(): void;
}

const NOOP: Diag = {
  enabled: false,
  log: new HitchLog(),
  beginFrame() {}, begin() {}, end() {}, endFrame() {},
  report() {}, json() { return '{"enabled":false}'; }, reset() {},
};

/**
 * `performance.memory` is a Chrome-only API and its absence must be reported, not faked: without it
 * the GC rule in diagcore.ts degrades to "cannot tell", which is the honest answer.
 */
function heapUsed(): number {
  const memory = (performance as any).memory;
  return memory && typeof memory.usedJSHeapSize === 'number' ? memory.usedJSHeapSize : 0;
}

export function createDiag(opts: DiagOptions): Diag {
  const search = opts.search ?? (typeof location !== 'undefined' ? location.search : '');
  const hash = opts.hash ?? (typeof location !== 'undefined' ? location.hash : '');
  if (!diagRequested(search, hash)) return NOOP;

  const log = new HitchLog();
  let started = performance.now();
  let prevFrameAt = -1;    // the previous callback's rAF timestamp (-1 = first frame)
  let sampleFrameMs = 0;
  let heapStart = 0;
  let phaseStart = 0;
  const phases: Record<Phase, number> = { sim: 0, sync: 0, render: 0 };
  let prev: FrameSample | null = null;
  let lastWarn = -1e9;

  // Long tasks / long animation frames: the only signal for work that ran BETWEEN our callbacks
  // (an asset parse in a fetch continuation, a style/layout, a timer). Chrome-only, feature-detected.
  // The entry is emitted AFTER the frame that ran long, so it is KEPT for up to a second instead of
  // being dropped at the next (calm) frame — otherwise the attribution would be thrown away before the
  // frame it explains is ever classified. `longTaskSources` keeps the worst few for the report.
  let pendingLongTaskMs = 0;
  let pendingLongTaskSource = '';
  let pendingLongTaskAt = -1e9;
  const longTaskSources: { ms: number; source: string }[] = [];
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const scripts = (entry as any).scripts as { sourceURL?: string; sourceFunctionName?: string; duration?: number }[] | undefined;
        let top = '';
        if (scripts && scripts.length) {
          const best = scripts.reduce((a, b) => ((b.duration ?? 0) > (a.duration ?? 0) ? b : a));
          const url = (best.sourceURL || '').split('/').pop() || best.sourceURL || '';
          top = `${best.sourceFunctionName || '?'}@${url}`;
        }
        if (entry.duration > pendingLongTaskMs) {
          pendingLongTaskMs = entry.duration;
          pendingLongTaskSource = top;
          pendingLongTaskAt = performance.now();
        }
        if (entry.duration >= 50) {
          longTaskSources.push({ ms: entry.duration, source: top });
          longTaskSources.sort((a, b) => b.ms - a.ms);
          if (longTaskSources.length > 8) longTaskSources.length = 8;
        }
      }
    });
    observer.observe({ type: 'long-animation-frame' } as any);
  } catch {
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration > pendingLongTaskMs) {
            pendingLongTaskMs = entry.duration;
            pendingLongTaskSource = 'longtask';
            pendingLongTaskAt = performance.now();
          }
        }
      }).observe({ entryTypes: ['longtask'] });
    } catch { /* neither API: the profiler falls back to phases + heap */ }
  }

  // --- on-screen readout ---------------------------------------------------------------------
  // Lives inside #hudRight next to the existing FPS line: that IS the app's performance readout, and
  // the corner is already reserved (the sticks own the bottom, the wave/health the top left). The
  // badge is the only clickable thing `diag.ts` adds, so it takes `pointer-events:auto` itself
  // (#hud is pointer-events:none). The panel is a top-right card anchored to #hud — see styles.css.
  //
  // TWO LINES, ONE ELEMENT: the frame rate and the resolution chain are two spans inside the badge
  // (a column), so they share one tap target and one top-right box. Assigning `badge.textContent`
  // would DELETE children in a real DOM — the frame-rate text therefore owns its own node.
  const badge = document.createElement('div');
  badge.id = 'diagBadge';
  badge.title = '点一下看卡顿明细 + 分辨率链（?diag=1）';
  const fpsText = document.createElement('div');
  fpsText.id = 'diagFps';
  const resText = document.createElement('div');
  resText.id = 'diagRes';
  badge.appendChild(fpsText);
  badge.appendChild(resText);
  const panel = document.createElement('div');
  panel.id = 'diagPanel';
  panel.className = 'hidden';
  const host = document.getElementById('hudRight') || document.body;
  host.appendChild(badge);
  host.appendChild(panel);

  // The last chain seen PER ORIENTATION. This is what makes the readout answer the question it exists
  // for: rotate the phone once and the line says e.g. `13.8px/世界单位 (竖屏的 74%)` — the two numbers
  // that used to be "looks worse" side by side.
  const lastChain: Partial<Record<'portrait' | 'landscape', ResolutionChain>> = {};
  const measure = (): ResolutionChain | null => {
    if (!opts.resolution) return null;
    try {
      const chain = resolutionChain(opts.resolution());
      lastChain[chain.orientation] = chain;
      return chain;
    } catch {
      // A diagnostic must never take the game down with it (a bad getter, a half-torn-down renderer).
      return null;
    }
  };
  const otherChain = (c: ResolutionChain): ResolutionChain | null =>
    lastChain[c.orientation === 'landscape' ? 'portrait' : 'landscape'] ?? null;
  /** Both orientations, one line each (no ratio: they are side by side already). */
  const resolutionBlock = (): string => {
    if (!opts.resolution) return '';
    const lines = (['landscape', 'portrait'] as const)
      .map((o) => [o, lastChain[o]] as const)
      .filter(([, c]) => !!c)
      .map(([o, c]) => `${o === 'landscape' ? '横屏' : '竖屏'} ${resolutionText(c as ResolutionChain)}`);
    return lines.length ? `<b>分辨率链</b><br>${lines.join('<br>')}<br>` : '';
  };

  const fmtHitch = (h: HitchRecord): string =>
    `${h.frameMs.toFixed(0)}ms · ${h.cause} · ${h.detail} · 敌${h.enemies}/弹${h.bullets}/粒${h.particles} · calls ${h.calls}`;

  let panelOpen = false;
  const renderPanel = (): void => {
    const s = log.summary(heapUsed(), opts.info().programs);
    const list = s.worst.map((h, i) => `${i + 1}. ${fmtHitch(h)}`).join('<br>');
    const causes = Object.entries(s.byCause).map(([k, v]) => `${k}×${v}`).join(' ') || '无';
    const longs = longTaskSources.slice(0, 3).map((l) => `${l.ms.toFixed(0)}ms ${l.source || '未知'}`).join('<br>') || '无';
    panel.innerHTML =
      `${resolutionBlock()}` +
      `<b>帧 p50 ${s.p50.toFixed(1)} / p95 ${s.p95.toFixed(1)} / max ${s.max.toFixed(0)}ms</b><br>` +
      `共 ${s.frames} 帧 · 卡顿 ${s.hitches} 次 · ${causes}<br>` +
      `堆 ${s.heapMB ? s.heapMB.toFixed(0) + 'MB' : 'n/a'} · programs ${s.programs}<br>` +
      `长任务：<br>${longs}<br>最差：<br>${list || '无（没有超过 60ms 的帧）'}`;
  };
  badge.addEventListener('pointerdown', (e) => {
    // pointerdown, not click: a second finger tapping while a stick is held never produces a click
    // (same real-device trap documented in weaponButton.ts).
    e.preventDefault();
    panelOpen = !panelOpen;
    panel.classList.toggle('hidden', !panelOpen);
    if (panelOpen) renderPanel();
  });

  let badgeAt = 0;
  const updateBadge = (): void => {
    const now = performance.now();
    if (now - badgeAt < 250) return;   // a DOM write per frame would be its own performance problem
    badgeAt = now;
    const s = log.summary(heapUsed(), opts.info().programs);
    const worst = s.worst[0];
    const fps = s.p50 > 0 ? (1000 / s.p50).toFixed(0) : '--';
    fpsText.textContent = `${fps}fps · 最差 ${s.max.toFixed(0)}ms${worst ? '(' + worst.cause + ')' : ''}`
      + (s.heapMB ? ` · 堆 ${s.heapMB.toFixed(0)}MB` : '') + (s.hitches ? ` · 卡 ${s.hitches}` : '');
    const chain = measure();
    resText.textContent = chain ? resolutionText(chain, otherChain(chain)) : '';
    if (panelOpen) renderPanel();
  };

  return {
    enabled: true,
    log,
    beginFrame(nowMs: number) {
      // The rAF timestamp is the frame's own clock: the interval between two callbacks is exactly what
      // the player experienced, and it never includes the cost of this profiler's own work.
      sampleFrameMs = prevFrameAt < 0 ? 0 : nowMs - prevFrameAt;
      prevFrameAt = nowMs;
      phases.sim = 0; phases.sync = 0; phases.render = 0;
      heapStart = heapUsed();
    },
    begin(_phase: Phase) { phaseStart = performance.now(); },
    end(phase: Phase) { phases[phase] += performance.now() - phaseStart; },
    endFrame() {
      const ended = performance.now();
      const counts = opts.counts();
      const info = opts.info();
      const sample: FrameSample = {
        t: ended - started,
        frameMs: sampleFrameMs,
        workMs: phases.sim + phases.sync + phases.render,
        phases: { ...phases },
        heapStart,
        heapEnd: heapUsed(),
        programs: info.programs,
        calls: info.calls,
        triangles: info.triangles,
        enemies: counts.enemies,
        bullets: counts.bullets,
        particles: counts.particles,
        loading: counts.loading,
        longTaskMs: pendingLongTaskMs,
        longTaskSource: pendingLongTaskSource,
      };
      pendingLongTaskMs = ended - pendingLongTaskAt > 1000 ? 0 : pendingLongTaskMs;
      if (pendingLongTaskMs === 0) pendingLongTaskSource = '';

      const cause: HitchCause = classifyHitch(sample, prev);
      const record = log.push(sample, cause, prev);
      if (record && ended - lastWarn > 400) {
        lastWarn = ended;
        // eslint-disable-next-line no-console
        console.warn(`[shooter/diag] 卡顿 ${record.frameMs.toFixed(0)}ms → ${record.cause} (${record.detail})`
          + ` · 敌 ${record.enemies} / 粒子 ${record.particles} / calls ${record.calls}`
          + (heapDelta(record) ? ` · 堆变化 ${(heapDelta(record) / 1048576).toFixed(1)}MB` : ''));
      }
      prev = sample;
      updateBadge();
    },
    report() {
      const s = log.summary(heapUsed(), opts.info().programs);
      const chain = measure();
      // eslint-disable-next-line no-console
      console.log(`[shooter/diag] ${s.frames} 帧 · p50 ${s.p50.toFixed(1)}ms / p95 ${s.p95.toFixed(1)}ms / p99 ${s.p99.toFixed(1)}ms / max ${s.max.toFixed(0)}ms`
        + ` · 卡顿 ${s.hitches} 次 ${JSON.stringify(s.byCause)}`
        + ` · 堆 ${s.heapMB ? s.heapMB.toFixed(0) + 'MB' : 'n/a (此浏览器不暴露 performance.memory)'}`
        + ` · programs ${s.programs}`);
      if (chain) console.log(`[shooter/diag] ${resolutionText(chain, otherChain(chain))}`);
      if (s.worst.length) console.table(s.worst.map((h) => ({ ...h, phases: undefined })));
      if (longTaskSources.length) console.log('[shooter/diag] 最长任务', longTaskSources);
    },
    json() {
      const info = opts.info();
      const s = log.summary(heapUsed(), info.programs);
      const chain = measure();
      return JSON.stringify({
        ua: navigator.userAgent,
        dpr: window.devicePixelRatio,
        viewport: [window.innerWidth, window.innerHeight],
        canMeasureMemory: heapUsed() > 0,
        info,
        // The chain, per orientation: `current` is this frame's, the other two are the last
        // measurement seen in each orientation (see ResolutionChain for what each field means).
        resolution: {
          current: chain ? resolutionText(chain, otherChain(chain)) : null,
          landscape: lastChain.landscape ? resolutionText(lastChain.landscape) : null,
          portrait: lastChain.portrait ? resolutionText(lastChain.portrait) : null,
        },
        summary: s,
        longTasks: longTaskSources,
      }, null, 1);
    },
    reset() {
      log.worst.length = 0;
      log.intervals.length = 0;
      log.frames = 0;
      log.max = 0;
      for (const k of Object.keys(log.byCause)) delete log.byCause[k];
      longTaskSources.length = 0;
      started = performance.now();
      prev = null;
      prevFrameAt = -1;
      sampleFrameMs = 0;
    },
  };
}
