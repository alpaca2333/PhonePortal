// WHERE DOES A HALF-SECOND HITCH COME FROM? This module is the *decision* half of the answer: given
// two consecutive frame samples, name the cause. It is deliberately pure (no DOM, no three, no
// timers) so the rules can be asserted in Node — see scripts/verify-diag.mjs — while the browser-side
// sampling lives in diag.ts.
//
// WHY THIS EXISTS
// ---------------
// Real-device report: 「俯视角游戏有时候会突然卡个半秒，是因为在 gc 还是别的什么原因呢」. "GC or
// something else" is answerable ON THE DEVICE, but only if the frame samples carry the signals that
// tell the two apart, and the shape of the answer is:
//
//   * GC              — the frame is long and the JS heap DROPPED across it (a major collection just
//                       ran). This is the only cause that can be identified without DevTools, because
//                       it is about memory rather than about any one code path. `performance.memory`
//                       (Chrome) is the signal; it is absent elsewhere, which is reported honestly
//                       rather than guessed at.
//   * shader-compile  — the frame is long and `renderer.info.programs.length` GREW: three compiled a
//                       new program variant (a new material feature, a new skinning/instancing
//                       combination, a changed light count). This is the classic 100-500 ms stall on
//                       mobile GPUs and it looks exactly like a GC pause from the outside.
//   * asset-parse     — the frame is long while `?diag` is still watching the GLB loaders work: a
//                       multi-MB .glb is parsed and merged ON THE MAIN THREAD (fetch continuation, so
//                       it is not inside any rAF callback).
//   * long-task       — a long task was observed that does not overlap our own rAF work: the stall is
//                       in code that ran between frames (a promise continuation, a layout, a timer).
//   * sim/sync/render — one of our own phases dominates the frame (the honest case: the world really
//                       did get more expensive — e.g. a wave spawning characters).
//   * present         — the frame was long but our JavaScript was cheap: the browser was blocked on
//                       the compositor/GPU or was busy elsewhere. Screenshotting that as "our code" is
//                       the most common way a performance investigation goes wrong, so it gets its own
//                       bucket.
//
// THE ONE RULE THAT MATTERS: never claim GC without a measured heap drop, and never claim a phase
// without that phase actually dominating. Everything else here is bookkeeping.

/** A frame this long is a hitch a player can feel (one dropped frame is ~17 ms; 60 ms is ~4 frames). */
export const HITCH_MS = 60;

/**
 * How much the JS heap must FALL across one frame before it is called a collection. A scavenge of the
 * nursery is a normal, cheap event (sub-millisecond) and must not be blamed for a hitch; a major GC
 * that causes a 300 ms pause frees megabytes. 512 KB keeps the false positives out.
 */
export const GC_DROP_BYTES = 512 * 1024;

/** Share of the frame's own JS work one phase must own before the phase is named as the cause. */
export const PHASE_DOMINANCE = 0.6;

export type Phase = 'sim' | 'sync' | 'render';

export type HitchCause =
  | 'gc' | 'shader-compile' | 'asset-parse' | 'long-task'
  | 'sim' | 'sync' | 'render' | 'present' | 'unknown';

export interface FrameSample {
  /** ms since the profiler started. */
  t: number;
  /** rAF callback interval in ms: what the player experiences (includes idle + everything else). */
  frameMs: number;
  /** Total ms this callback spent in OUR code (sim + sync + render). */
  workMs: number;
  phases: Record<Phase, number>;
  /** `performance.memory.usedJSHeapSize` at the start / end of the callback; 0 = unavailable. */
  heapStart: number;
  heapEnd: number;
  /** three's `renderer.info`: compiled programs (the shader-compile tell) and draw calls. */
  programs: number;
  calls: number;
  triangles: number;
  enemies: number;
  bullets: number;
  particles: number;
  /** True while the arena/character GLBs are still being fetched+parsed (see main.ts::bootAssets). */
  loading: boolean;
  /** Longest long-task / long-animation-frame observed since the previous sample, and its top script. */
  longTaskMs: number;
  longTaskSource: string;
}

export interface HitchRecord extends FrameSample {
  cause: HitchCause;
  /** Short human-readable "why", for the on-screen panel and the console line. */
  detail: string;
}

/** Heap change across a sample (negative = freed); 0 when the browser does not expose memory. */
export function heapDelta(s: FrameSample): number {
  if (!s.heapStart || !s.heapEnd) return 0;
  return s.heapEnd - s.heapStart;
}

/**
 * The attribution rules, in priority order. `prev` is the previous sample (null for the first frame).
 *
 * ORDER IS THE DESIGN, and it is *evidence first*: the flags that identify a specific mechanism with a
 * measurement (a program-count increase, a heap drop) are checked before the circumstantial ones (GLBs
 * are still loading, so the stall is *probably* a parse), and all of those are checked before "some
 * phase was big". A shader compile or a major GC happens *inside* `render()`/`sync()` and would
 * otherwise be reported as ordinary phase cost — which is exactly the misdiagnosis this profiler exists
 * to prevent. Same reason `asset-parse` sits below `gc`: during the first seconds a big parse and a
 * major collection both happen, and only the measured one can say which the frame actually was (the
 * `loading` flag is still reported as context on every record).
 */
export function classifyHitch(cur: FrameSample, prev: FrameSample | null): HitchCause {
  // 1. A new shader program appeared in this frame: three compiled a variant (skinning, instancing,
  //    light count, a newly patched material). 100-500 ms on mobile GPUs, and it is NOT a GC pause.
  if (prev && cur.programs > prev.programs) return 'shader-compile';
  // 2. The heap came down across this frame: a collection ran. Measured, not assumed.
  const drop = heapDelta(cur);
  if (drop <= -GC_DROP_BYTES) return 'gc';
  if (prev && prev.heapEnd && cur.heapEnd && cur.heapEnd <= prev.heapEnd - GC_DROP_BYTES) return 'gc';
  // 3. Assets still loading: the .glb parses and geometry merges are main-thread work between frames.
  if (cur.loading) return 'asset-parse';
  // 4. A long task outside our callback was observed: the stall is not in the code we timed.
  if (cur.longTaskMs >= Math.max(HITCH_MS, cur.workMs * 1.5)) return 'long-task';
  // 5. Our own work: name the phase that dominates it.
  const phases: Phase[] = ['sim', 'sync', 'render'];
  let top: Phase = 'sim';
  for (const p of phases) if (cur.phases[p] > cur.phases[top]) top = p;
  if (cur.workMs > 0 && cur.phases[top] >= cur.workMs * PHASE_DOMINANCE) return top;
  // 6. Long frame, cheap JS: the browser was blocked elsewhere (compositor/GPU/another task).
  if (cur.workMs < cur.frameMs * 0.5) return 'present';
  return 'unknown';
}

/** One line explaining the cause, with the numbers that produced it. */
export function hitchDetail(cur: FrameSample, prev: FrameSample | null, cause: HitchCause): string {
  const used = cur.heapEnd ? `堆 ${(cur.heapEnd / 1048576).toFixed(0)}MB` : '堆 n/a';
  switch (cause) {
    case 'gc': {
      const d = heapDelta(cur) || (prev && prev.heapEnd ? cur.heapEnd - prev.heapEnd : 0);
      return `堆 -${(Math.abs(d) / 1048576).toFixed(1)}MB`;
    }
    case 'shader-compile': return `programs ${prev ? prev.programs : 0} → ${cur.programs}`;
    case 'asset-parse': return '资源加载/解析中';
    case 'long-task': return `${cur.longTaskMs.toFixed(0)}ms ${cur.longTaskSource || '未知来源'}`;
    case 'sim': case 'sync': case 'render':
      return `${cause} ${cur.phases[cause].toFixed(1)}ms / 本帧 JS ${cur.workMs.toFixed(1)}ms`;
    case 'present': return `JS 仅 ${cur.workMs.toFixed(1)}ms，其余 ${(cur.frameMs - cur.workMs).toFixed(0)}ms 在浏览器侧`;
    default: return `${used} · JS ${cur.workMs.toFixed(1)}ms`;
  }
}

export interface DiagSummary {
  frames: number;
  /** Frame interval percentiles over the rolling window, in ms. */
  p50: number;
  p95: number;
  p99: number;
  max: number;
  hitches: number;
  byCause: Record<string, number>;
  worst: HitchRecord[];
  heapMB: number;
  programs: number;
}

/** Nearest-rank percentile over an already-sorted ascending array. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index];
}

/**
 * Keeps the worst hitches (full samples, for the report) plus a rolling window of frame intervals
 * (for percentiles) — bounded on purpose: a profiler that itself grows without bound would be a
 * fittingly bad joke in a stutter investigation.
 */
export class HitchLog {
  readonly worst: HitchRecord[] = [];
  readonly intervals: number[] = [];
  readonly byCause: Record<string, number> = {};
  frames = 0;
  max = 0;

  constructor(readonly worstLimit = 24, readonly window = 900) {}

  /**
   * Push one frame. Returns the record when this frame was a hitch (and was worth keeping). `prev` is
   * only used to phrase the cause in `detail` ("programs 12 → 13").
   */
  push(s: FrameSample, cause: HitchCause, prev: FrameSample | null = null): HitchRecord | null {
    this.frames++;
    this.intervals.push(s.frameMs);
    if (this.intervals.length > this.window) this.intervals.shift();
    if (s.frameMs > this.max) this.max = s.frameMs;
    if (s.frameMs < HITCH_MS) return null;
    const record: HitchRecord = { ...s, cause, detail: hitchDetail(s, prev, cause) };
    this.byCause[cause] = (this.byCause[cause] ?? 0) + 1;
    this.worst.push(record);
    this.worst.sort((a, b) => b.frameMs - a.frameMs);
    if (this.worst.length > this.worstLimit) this.worst.length = this.worstLimit;
    return record;
  }

  summary(heapBytes = 0, programs = 0): DiagSummary {
    const sorted = [...this.intervals].sort((a, b) => a - b);
    return {
      frames: this.frames,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      max: this.max,
      hitches: Object.values(this.byCause).reduce((a, b) => a + b, 0),
      byCause: { ...this.byCause },
      worst: this.worst.slice(0, 8),
      heapMB: heapBytes / 1048576,
      programs,
    };
  }
}

/**
 * Is the profiler switched on? `?diag=1` (query) or `#diag` (hash) — a URL flag rather than a stored
 * setting, because a profiler is a debugging tool, not user data (root AGENTS.md: `localStorage` /
 * server settings are for things the user would call *their settings*). Pure so it is testable.
 */
export function diagRequested(search: string, hash = ''): boolean {
  // `search` may arrive as a plain query (`?diag=1`), as a bare hash (`#diag` — a hash-only URL has an
  // empty search), or as bare text, so all three spellings are normalised before parsing.
  const raw = search.startsWith('?') || search.startsWith('#') ? search.slice(1) : search;
  const flag = new URLSearchParams(raw).get('diag');
  if (flag !== null && flag !== '0' && flag !== 'false') return true;
  return hash.replace(/^#/, '').split(/[&,]/).includes('diag');
}
