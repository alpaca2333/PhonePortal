/**
 * CPU-side verification for the shooter's hitch profiler (`apps/shooter/src/diagcore.ts`).
 *
 * WHY THIS EXISTS: the profiler's whole value is that it says *why* a frame was long — GC or something
 * else — on a phone where no DevTools is attached. A profiler that guesses is worse than none, so the
 * attribution RULES are a pure module and are pinned here, where they can be driven with samples whose
 * ground truth is known by construction.
 *
 * WHAT IS ASSERTED
 *   1. `diagRequested()` — `?diag=1` / `#diag` switch it on; anything else (including `?diag=0`) does
 *      not, because the profiler must stay off unless asked for (it exists to find stalls, not to add
 *      them).
 *   2. `classifyHitch()` names the mechanism, in the documented priority order:
 *        a heap drop across the frame            -> gc            (and a *small* drop is NOT a gc)
 *        a program-count increase                -> shader-compile
 *        assets still loading                    -> asset-parse
 *        a long task that dwarfs our own work    -> long-task
 *        one of our phases dominating            -> sim / sync / render
 *        a long frame with cheap JS              -> present
 *      The negative cases matter as much as the positive ones: a shader compile that also dropped the
 *      heap must NOT be reported as GC (that is the misdiagnosis this file exists to prevent), and a
 *      400 ms frame whose JS cost 2 ms must not be blamed on `sim`.
 *   3. `HitchLog` keeps the worst frames (bounded, sorted), counts causes, and computes percentiles
 *      that a known distribution can be checked against exactly.
 *   4. The frame-loop wiring cannot be a per-frame leak: the log is bounded in BOTH directions (worst
 *      list and rolling window) after many thousands of frames.
 *   5. THE RESOLUTION CHAIN (postfx.ts::resolutionChain/resolutionText, section 5): the readout that
 *      exists because 「横屏比竖屏糊」 is a numerical question. It asserts the two quantities are
 *      reported separately and correctly on the device the report came from (same texel count in both
 *      orientations, 13.8 vs 18.7 px per world unit for the reporter's 2.1x/1.55x camera heights),
 *      that the direct path reports the canvas instead of a target, that dirty numbers print as 0.0
 *      and never as NaN, and — in the DOM half — that the badge really carries the line and remembers
 *      the other orientation.
 *
 * Run:  npm run build && node scripts/verify-diag.mjs
 * Exit code is non-zero when any assertion fails.
 */
const CORE = new URL('../dist/apps/shooter/src/diagcore.js', import.meta.url);
const {
  HITCH_MS, GC_DROP_BYTES, classifyHitch, hitchDetail, heapDelta, percentile, HitchLog, diagRequested,
} = await import(CORE.href);
const { resolutionChain, resolutionText } = await import(
  new URL('../dist/apps/shooter/src/postfx.js', import.meta.url).href);
const { orthoFrustumHeight } = await import(
  new URL('../dist/apps/shooter/src/camera.js', import.meta.url).href);

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL '} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}
const MB = 1048576;

/** A calm 60 fps frame; every test starts from this and perturbs one thing. */
function sample(over = {}) {
  return {
    t: 1000, frameMs: 16.7, workMs: 8,
    phases: { sim: 4, sync: 3, render: 1 },
    heapStart: 100 * MB, heapEnd: 100 * MB,
    programs: 12, calls: 70, triangles: 40000,
    enemies: 6, bullets: 12, particles: 90, loading: false,
    longTaskMs: 0, longTaskSource: '',
    ...over,
  };
}

// ---------------------------------------------------------------- 1. the switch
check(diagRequested('?diag=1', ''), '?diag=1 turns the profiler on');
check(diagRequested('?diag', ''), 'a valueless ?diag turns it on');
check(diagRequested('', '#diag'), '#diag turns it on');
check(diagRequested('#diag'), 'a hash passed as the only argument still turns it on');
check(diagRequested('?a=1&diag=1&b=2', ''), 'the flag works in a longer query');
check(!diagRequested('', ''), 'no flag: off');
check(!diagRequested('?diag=0', ''), '?diag=0 is explicitly off');
check(!diagRequested('?diag=false', ''), '?diag=false is off');
check(!diagRequested('?diagnostics=1', ''), 'a similar-looking flag does not enable it');
check(!diagRequested('', '#diagnostics'), 'a similar-looking hash does not enable it');

// ---------------------------------------------------------------- 2. attribution
const calm = sample();
const calmPrev = sample({ t: 983 });

// GC: the frame is long and the heap came down by megabytes. THE ONLY WAY "GC" IS EVER CLAIMED.
{
  const gcFrame = sample({ frameMs: 420, workMs: 40, heapStart: 186 * MB, heapEnd: 178 * MB, phases: { sim: 20, sync: 12, render: 8 } });
  check(classifyHitch(gcFrame, calmPrev) === 'gc', 'a long frame that freed 8 MB is attributed to GC', classifyHitch(gcFrame, calmPrev));
  check(/MB/.test(hitchDetail(gcFrame, calmPrev, 'gc')), '…and its detail line reports the freed megabytes', hitchDetail(gcFrame, calmPrev, 'gc'));
  // The neighbouring negative case: a normal scavenge must not be dressed up as a stall cause.
  const smallDrop = sample({ frameMs: 70, workMs: 20, heapStart: 100 * MB, heapEnd: 100 * MB - 64 * 1024 });
  check(classifyHitch(smallDrop, calmPrev) !== 'gc', 'a 64 KB drop is NOT reported as a GC stall');
  check(GC_DROP_BYTES > 64 * 1024 && HITCH_MS > 16.7, 'the thresholds are the documented ones');
}

// The heap can also come down BETWEEN two samples (the drop happens on the next frame's reading).
{
  const before = sample({ heapEnd: 150 * MB });
  const after = sample({ t: before.t + 400, frameMs: 380, workMs: 30, heapStart: 150 * MB, heapEnd: 141 * MB });
  check(classifyHitch(after, before) === 'gc', 'a heap drop measured across frames is still a GC');
}

// Shader compile: programs grew. Note this sample ALSO has a huge workMs and a small heap drop in the
// other direction — the mechanism flags must win over "some phase was big".
{
  const compile = sample({ frameMs: 300, workMs: 260, phases: { sim: 5, sync: 5, render: 250 }, programs: 13 });
  check(classifyHitch(compile, calmPrev) === 'shader-compile', 'a grown program count is attributed to a shader compile', classifyHitch(compile, calmPrev));
  const compileWithGc = sample({ frameMs: 300, workMs: 200, programs: 13, heapStart: 120 * MB, heapEnd: 112 * MB });
  check(classifyHitch(compileWithGc, calmPrev) === 'shader-compile',
    'a compile that also dropped the heap is reported as a compile, not as GC', classifyHitch(compileWithGc, calmPrev));
}

// Asset parsing: still loading, but nothing measured says otherwise.
{
  const loading = sample({ frameMs: 500, workMs: 5, loading: true, programs: 12 });
  check(classifyHitch(loading, calmPrev) === 'asset-parse', 'a stall while GLBs are loading is an asset parse', classifyHitch(loading, calmPrev));
  // …but the measured mechanisms outrank the circumstantial one: a collection that happens to run
  // while the GLBs are still loading is a GC, not "the asset parse". (Evidence beats context.)
  const loadingGc = sample({ frameMs: 500, workMs: 5, loading: true, heapStart: 150 * MB, heapEnd: 140 * MB });
  check(classifyHitch(loadingGc, calmPrev) === 'gc',
    'a heap drop during loading is still reported as GC', classifyHitch(loadingGc, calmPrev));
  const loadingCompile = sample({ frameMs: 500, workMs: 5, loading: true, programs: 13 });
  check(classifyHitch(loadingCompile, calmPrev) === 'shader-compile',
    'a program bump during loading is still reported as a compile', classifyHitch(loadingCompile, calmPrev));
}

// A long task outside our own callback (a promise continuation, a layout, a timer).
{
  const external = sample({ frameMs: 320, workMs: 6, longTaskMs: 300, longTaskSource: 'mergeGeometries@BufferGeometryUtils.js' });
  check(classifyHitch(external, calmPrev) === 'long-task', 'external main-thread work is attributed to a long task', classifyHitch(external, calmPrev));
  check(/mergeGeometries/.test(hitchDetail(external, calmPrev, 'long-task')), '…and the source is named', hitchDetail(external, calmPrev, 'long-task'));
}

// Our own phases: whichever dominates.
{
  const simHeavy = sample({ frameMs: 120, workMs: 100, phases: { sim: 92, sync: 5, render: 3 } });
  check(classifyHitch(simHeavy, calmPrev) === 'sim', 'a frame owned by the simulation says sim', classifyHitch(simHeavy, calmPrev));
  // The spawn path lives in sync() (ensureViews -> spawnFromTemplate): this is the shape of the bug
  // that was actually measured and fixed (see scripts/verify-spawn-cost.mjs).
  const spawn = sample({ frameMs: 90, workMs: 70, phases: { sim: 6, sync: 62, render: 2 }, enemies: 14 });
  check(classifyHitch(spawn, calmPrev) === 'sync', 'a spawn stall is attributed to sync (the phase that owns it)', classifyHitch(spawn, calmPrev));
  const renderHeavy = sample({ frameMs: 100, workMs: 90, phases: { sim: 3, sync: 4, render: 83 } });
  check(classifyHitch(renderHeavy, calmPrev) === 'render', 'a frame owned by the draw says render', classifyHitch(renderHeavy, calmPrev));
  // Split work with no dominant phase is honestly "unknown" rather than a coin flip.
  const split = sample({ frameMs: 100, workMs: 90, phases: { sim: 30, sync: 30, render: 30 } });
  check(classifyHitch(split, calmPrev) === 'unknown', 'a frame with no dominant phase is unknown, not a guess', classifyHitch(split, calmPrev));
}

// The browser blocked (compositor/GPU): long frame, cheap JS. Must NOT be blamed on a phase.
{
  const blocked = sample({ frameMs: 480, workMs: 4, phases: { sim: 1, sync: 2, render: 1 } });
  check(classifyHitch(blocked, calmPrev) === 'present',
    'a 480 ms frame whose JS cost 4 ms is the browser, not our code', classifyHitch(blocked, calmPrev));
}

// A browser without `performance.memory`: no heap signal, so no GC claim is possible or made.
{
  const noMemory = sample({ frameMs: 400, workMs: 30, heapStart: 0, heapEnd: 0, phases: { sim: 5, sync: 20, render: 5 } });
  check(classifyHitch(noMemory, sample({ heapStart: 0, heapEnd: 0 })) !== 'gc', 'without a memory API a GC is never claimed');
  check(heapDelta(noMemory) === 0, 'heapDelta() is 0 when the browser exposes no memory info');
}

// ---------------------------------------------------------------- 3. the log
{
  const log = new HitchLog(3, 10);
  check(log.frames === 0 && log.summary().p50 === 0, 'an empty log reports zeroes instead of NaN');
  for (const ms of [16, 17, 16, 18, 500, 16]) log.push(sample({ frameMs: ms, t: 1000 + ms }), 'present');
  const s = log.summary(100 * MB, 12);
  check(s.frames === 6 && s.hitches === 1, 'only frames past the hitch threshold are counted as hitches', `${s.frames} frames / ${s.hitches} hitches`);
  check(s.max === 500, 'the max frame time is kept', String(s.max));
  check(s.worst.length === 1 && s.worst[0].frameMs === 500, 'the worst list holds the 500 ms frame');
  check(s.heapMB === 100 && s.programs === 12, 'the summary carries the heap (MB) and program count');
  // Percentiles on a known set: nearest rank over [16,16,16,17,18,500].
  check(percentile([16, 16, 16, 17, 18, 500], 50) === 16, 'p50 of the known set', String(percentile([16, 16, 16, 17, 18, 500], 50)));
  check(percentile([16, 16, 16, 17, 18, 500], 95) === 500, 'p95 of the known set', String(percentile([16, 16, 16, 17, 18, 500], 95)));
  check(percentile([], 95) === 0, 'percentile of an empty set is 0, not NaN');

  // The worst list is bounded AND sorted, no matter the order the hitches arrive in.
  const big = new HitchLog(3, 10);
  for (const ms of [100, 900, 300, 700, 500, 200]) big.push(sample({ frameMs: ms }), 'sync');
  check(big.worst.length === 3, 'the worst list is capped', String(big.worst.length));
  check(big.worst.map((h) => h.frameMs).join(',') === '900,700,500', '…and keeps the three worst, descending',
    big.worst.map((h) => h.frameMs).join(','));
  check(big.byCause.sync === 6, 'every hitch is counted by cause', JSON.stringify(big.byCause));
}

// ---------------------------------------------------------------- 4. bounded under a long run
{
  let heap = 80 * MB;
  const log = new HitchLog();
  for (let i = 0; i < 20000; i++) {
    // A deliberately pathological run: every 20th frame is a 400 ms GC pause and the heap saw-tooths.
    const hitch = i % 20 === 0;
    heap += hitch ? -6 * MB : 200 * 1024;
    log.push(sample({ t: i * 16.7, frameMs: hitch ? 400 : 16.7, heapStart: heap + 6 * MB, heapEnd: heap, phases: { sim: 3, sync: 2, render: 1 } }), hitch ? 'gc' : 'unknown');
  }
  check(log.worst.length <= 24, 'the worst list stays bounded over 20k frames', String(log.worst.length));
  check(log.intervals.length <= 900, 'the percentile window stays bounded over 20k frames', String(log.intervals.length));
  check(log.frames === 20000, 'every frame is still counted', String(log.frames));
  check(log.byCause.gc === 1000, 'all 1000 GC pauses were counted', String(log.byCause.gc));
}

// ---------------------------------------------------------------- 5. the resolution chain (pure)
// The readout behind the real report 「横屏分辨率明显比竖屏低」: it must report HOW MANY pixels are
// rendered separately from HOW MUCH WORLD each pixel covers, because those two have different owners
// (the 「像素化」 setting vs the camera pose) and only the second one can differ between orientations.
{
  // The reported device: 1200x2608 @ 480 dpi -> dpr 3 (the renderer caps its drawing ratio at 2), so
  // 400 x 869.33 CSS px portrait / 869.33 x 400 landscape. Camera heights: 1.55x portrait, 2.1x landscape.
  const CSS_W = 1200 / 3, CSS_H = 2608 / 3;
  const base = (orientation, block, scale) => {
    const viewportW = orientation === 'landscape' ? CSS_H : CSS_W;
    const viewportH = orientation === 'landscape' ? CSS_W : CSS_H;
    const camZoom = Math.max(0.42, Math.min(1.15, viewportH / 800));
    const dpr = 2;
    // block CSS px x dpr 2 device px = a texel every 2 device px, i.e. one texel per CSS px; with the
    // pass off the canvas itself is the target (dpr device px per CSS px).
    const targetW = block > 0 ? Math.floor(viewportW / block) : Math.floor(viewportW * dpr);
    const targetH = block > 0 ? Math.floor(viewportH / block) : Math.floor(viewportH * dpr);
    return {
      viewportW, viewportH, dpr, deviceDpr: 3, block,
      targetW, targetH,
      frustumHeight: orthoFrustumHeight(scale, camZoom),
      screenW: CSS_W, screenH: CSS_H,
    };
  };
  const land1 = resolutionChain(base('landscape', 1, 2.1));
  const port1 = resolutionChain(base('portrait', 1, 1.55));
  check('the chain reports the two quantities separately and labels the orientation',
    land1.orientation === 'landscape' && port1.orientation === 'portrait'
    && land1.direct === false && land1.block === 1, land1.orientation + '/' + port1.orientation);
  check('the SAME 「像素化」 block renders the SAME number of texels in both orientations',
    land1.texels === port1.texels && land1.texels === 869 * 400,
    `${land1.texels} vs ${port1.texels}`);
  check('…and that is 11% of the panel, not 44%, because block 1 CSS px = 2 device px on a 2x canvas',
    Math.abs(land1.percentOfNative - 11.1) < 0.1 && land1.percentOfNative === port1.percentOfNative,
    `${land1.percentOfNative.toFixed(2)}%`);
  check('the world-per-pixel half follows the CAMERA, not the viewport: 13.8 vs 18.7 px per world unit '
    + 'for the reporter\'s 2.1x/1.55x (1.35x coarser in landscape)',
    Math.abs(land1.pxPerWorldUnit - 13.8) < 0.1 && Math.abs(port1.pxPerWorldUnit - 18.7) < 0.1
    && Math.abs(land1.pxPerWorldUnit / port1.pxPerWorldUnit - 0.74) < 0.01,
    `${land1.pxPerWorldUnit.toFixed(2)} / ${port1.pxPerWorldUnit.toFixed(2)}`);

  const landText = resolutionText(land1);
  check('the line names the viewport, the renderer dpr AND the device dpr (the cap is the information, '
    + 'not noise), the block, the target texels, the native share and the density',
    /分辨率 869×400css/.test(landText) && /dpr2\/设备3/.test(landText) && /块1css/.test(landText)
    && /869×400tex/.test(landText) && /原生11%/.test(landText) && /13\.8px\/世界单位/.test(landText),
    landText);
  check('…and once the other orientation has been seen the line reports the ratio — the whole point: '
    + 'one rotation turns "looks worse" into a number',
    /竖屏的 74%/.test(resolutionText(land1, port1)) && !/的 \d+%/.test(landText),
    resolutionText(land1, port1));
  check('the portrait reading reports the inverse ratio (no sign/ownership mistake)',
    /横屏的 135%/.test(resolutionText(port1, land1)), resolutionText(port1, land1));

  // 像素化 = 0 is the direct path: the canvas replaces the target, so the DPR cap starts to matter.
  const direct = resolutionChain(base('landscape', 0, 2.1));
  check('with 「像素化」 off the chain reports the canvas (4x the texels, 44% of native) and says so',
    direct.direct === true && direct.texels === 1738 * 800
    && Math.abs(direct.percentOfNative - 44.4) < 0.2 && /后处理关/.test(resolutionText(direct)),
    resolutionText(direct));

  // A readout must never print NaN, whatever it is handed (a torn-down renderer, a zero-size iframe).
  const junk = resolutionChain({
    viewportW: NaN, viewportH: 0, dpr: NaN, deviceDpr: 0, block: NaN,
    targetW: -1, targetH: NaN, frustumHeight: NaN, screenW: NaN, screenH: 0,
  });
  check('dirty facts degrade to 0 (and a portrait label), never to NaN',
    !/NaN/.test(resolutionText(junk)) && junk.pxPerWorldUnit === 0 && junk.texels === 0
    && junk.orientation === 'portrait' && junk.direct === false,
    resolutionText(junk));
}

// ---------------------------------------------------------------- 6. the browser half (DOM shim)
// diag.ts is the half that samples and draws; a ~30-line shim (the same pattern as verify-panel.mjs)
// lets it be driven with a controlled clock and heap, which is the only way to check the frame
// accounting (rAF timestamps vs phase timers) without a browser.
{
  const { createDiag } = await import(new URL('../dist/apps/shooter/src/diag.js', import.meta.url).href);

  const nodes = [];
  function mkEl(tag) {
    const node = {
      tag, className: '', textContent: '', innerHTML: '', title: '', children: [], listeners: {},
      append(...kids) { for (const k of kids) this.children.push(k); },
      appendChild(k) { this.children.push(k); return k; },
      addEventListener(ev, fn) { (this.listeners[ev] ??= []).push(fn); },
      dispatch(ev, extra) { for (const fn of this.listeners[ev] ?? []) fn({ target: this, preventDefault() {}, ...extra }); },
      classList: {
        set: new Set(['hidden']),
        toggle(c, on) { on ? this.set.add(c) : this.set.delete(c); },
        contains(c) { return this.set.has(c); },
      },
    };
    nodes.push(node);
    return node;
  }
  const hudRight = mkEl('div');
  globalThis.document = { createElement: mkEl, getElementById: (id) => (id === 'hudRight' ? hudRight : mkEl('div')), body: mkEl('body') };
  let clock = 0;
  let heap = 100 * MB;
  globalThis.window = { devicePixelRatio: 2.5, innerWidth: 800, innerHeight: 400 };
  // node's `navigator` global is getter-only, so it is redefined rather than assigned.
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'verify-diag' } });
  // `memory.usedJSHeapSize` is a GETTER on purpose: the profiler must read the heap at the moment it
  // samples (start/end of a frame), not at setup — a snapshot would make every delta zero.
  Object.defineProperty(globalThis, 'performance', {
    configurable: true, writable: true,
    value: { now: () => clock, memory: { get usedJSHeapSize() { return heap; } } },
  });

  const info = { calls: 70, triangles: 40000, programs: 12, geometries: 30, textures: 4 };
  const counts = { enemies: 5, bullets: 3, particles: 40, loading: false };
  // The facts a renderer would hand over; mutable so the test can "rotate" the phone mid-run.
  const facts = {
    viewportW: 800, viewportH: 400, dpr: 2, deviceDpr: 3, block: 1,
    targetW: 800, targetH: 400, frustumHeight: 27.6, screenW: 400, screenH: 800,
  };
  const target = { info: () => info, counts: () => counts, resolution: () => facts };

  // The disabled path must not touch the DOM at all (that is the "zero cost when off" promise).
  const before = hudRight.children.length + nodes.length;
  const off = createDiag({ ...target, search: '', hash: '' });
  check(!off.enabled && nodes.length === before - hudRight.children.length && hudRight.children.length === 0,
    'a page without ?diag=1 builds no DOM and reports enabled:false');
  off.beginFrame(0); off.begin('sim'); off.end('sim'); off.endFrame(); off.report();
  check(off.log.frames === 0, 'the disabled profiler records nothing');

  const diag = createDiag({ ...target, search: '?diag=1', hash: '' });
  check(diag.enabled, 'a page with ?diag=1 builds the profiler');
  check(hudRight.children.length === 2, 'the badge and the (hidden) panel are appended to #hudRight', String(hudRight.children.length));
  const badge = hudRight.children[0];
  const panel = hudRight.children[1];
  check(badge.id === 'diagBadge' && panel.id === 'diagPanel', 'they are #diagBadge / #diagPanel');
  check(panel.classList.contains('hidden'), 'the panel starts hidden');

  // Drive frames: `rnow` is the rAF timestamp (it advances by the interval the player felt) and the
  // fake clock IS that wall clock, so the phases are sub-intervals of the frame exactly as they are
  // in a browser. `performance.now()` therefore advances even on a frame our code barely touched.
  let rnow = 0;
  const put = (p, ms) => { diag.begin(p); clock += ms; diag.end(p); };
  function runFrame(intervalMs, phases, heapEnd) {
    rnow += intervalMs;
    clock = rnow;
    diag.beginFrame(rnow);
    put('sim', phases.sim); put('sync', phases.sync); put('render', phases.render);
    heap = heapEnd;
    diag.endFrame();
  }
  const calm = { sim: 4, sync: 3, render: 1 };
  for (let i = 0; i < 20; i++) runFrame(16.7, calm, 100 * MB);
  check(diag.log.frames === 20, 'every frame is recorded', String(diag.log.frames));
  check(diag.log.worst.length === 0, 'a steady 60 fps run records no hitches', String(diag.log.worst.length));
  check(/fps/.test(badge.children[0].textContent), 'the badge shows the frame rate', badge.children[0].textContent);
  check(badge.children.length === 2 && badge.children[1].id === 'diagRes',
    'the badge carries the frame rate and the resolution chain as TWO lines of one element',
    badge.children.map((c) => c.id).join(','));
  check(/分辨率 800×400css/.test(badge.children[1].textContent)
    && /块1css/.test(badge.children[1].textContent)
    && /px\/世界单位/.test(badge.children[1].textContent),
    'the second line is the resolution chain (viewport / block / world-per-pixel)',
    badge.children[1].textContent);

  // A spawn-shaped stall (sync owns it)…
  runFrame(90, { sim: 6, sync: 62, render: 2 }, 100 * MB);
  check(diag.log.worst[0]?.cause === 'sync', 'a spawn-shaped stall is recorded as sync', String(diag.log.worst[0]?.cause));
  // …and a GC pause: 400 ms frame, heap down 8 MB.
  runFrame(400, { sim: 20, sync: 12, render: 8 }, 92 * MB);
  check(diag.log.worst[0]?.cause === 'gc' && diag.log.worst[0]?.frameMs === 400,
    'a 400 ms frame with a heap drop is recorded as GC', `${diag.log.worst[0]?.frameMs}ms ${diag.log.worst[0]?.cause}`);
  check(diag.log.worst.length === 2, 'both hitches are kept', String(diag.log.worst.length));

  // Tapping the badge opens the table (pointerdown, so a second finger still works — weaponButton.ts).
  badge.dispatch('pointerdown');
  check(!panel.classList.contains('hidden'), 'tapping the badge opens the detail panel');
  check(/p50/.test(panel.innerHTML) && /gc/.test(panel.innerHTML),
    'the panel lists the frame percentiles and the worst hitches');
  badge.dispatch('pointerdown');
  check(panel.classList.contains('hidden'), 'tapping again closes it');

  // "Rotate the phone": the next measurement arrives with swapped dimensions. The line must now report
  // the ratio against the REMEMBERED landscape reading — that is what makes one rotation enough.
  facts.viewportW = 400; facts.viewportH = 800;
  facts.targetW = 400; facts.targetH = 800; facts.frustumHeight = 46.5;
  for (let i = 0; i < 20; i++) runFrame(16.7, calm, 100 * MB);
  check(/分辨率 400×800css/.test(badge.children[1].textContent)
    && /横屏的 119%/.test(badge.children[1].textContent),
    'after a rotation the chain reports the ratio against the other orientation',
    badge.children[1].textContent);
  badge.dispatch('pointerdown');
  check(/横屏 分辨率/.test(panel.innerHTML) && /竖屏 分辨率/.test(panel.innerHTML),
    'the panel lists BOTH orientations\' chains', panel.innerHTML.slice(0, 160));
  badge.dispatch('pointerdown');

  const json2 = JSON.parse(diag.json());
  check(json2.resolution && /分辨率/.test(json2.resolution.current)
    && /800×400css/.test(json2.resolution.landscape) && /400×800/.test(json2.resolution.portrait),
    'json() carries the current chain plus both remembered orientations',
    JSON.stringify(json2.resolution));

  // A diagnostic must never take the frame loop down: a throwing provider leaves the line empty.
  const nBefore = hudRight.children.length;
  const boom = createDiag({ ...target, resolution: () => { throw new Error('boom'); }, search: '?diag=1', hash: '' });
  rnow += 500; clock = rnow;
  boom.beginFrame(rnow); boom.endFrame();
  check(hudRight.children[nBefore].children[1].textContent === '',
    'a throwing resolution provider is swallowed and leaves the line empty');

  const json = JSON.parse(diag.json());
  check(json.summary.frames === 42 && json.summary.hitches === 2, 'json() carries the summary', JSON.stringify(json.summary.hitches));
  check(json.dpr === 2.5 && json.viewport.join('x') === '800x400', 'json() carries the device context');
  check(json.canMeasureMemory === true && json.info.programs === 12, 'json() reports the memory API and renderer counters');
  diag.reset();
  check(diag.log.frames === 0 && diag.log.worst.length === 0, 'reset() clears the log');
  diag.report();
}

console.log('');
console.log(failures === 0 ? 'verify-diag: all assertions passed' : `verify-diag: ${failures} assertion(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
