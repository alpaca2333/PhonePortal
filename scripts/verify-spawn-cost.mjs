/**
 * CPU-side verification for the cost of SPAWNING A CHARACTER (apps/shooter/src/assets.ts).
 *
 * WHY THIS EXISTS
 * ---------------
 * Real-device report: 「俯视角游戏有时候会突然卡个半秒」. The half-second stall lands at the moment a
 * wave spawns, and the spawn path is the one place in this app that does a large amount of
 * SYNCHRONOUS object creation: `spawnFromTemplate()` creates an `AnimationMixer` and then one
 * `AnimationAction` per ANIMATION CLIP in the model. Each shipped character GLB carries the whole
 * KayKit animation library — with the Adventurers pack that is **76 clips, up to 123 tracks each**
 * (the numbers are measured from the files below, not assumed) — while the game can only ever play
 * 10 of them (`P_ANIM`/`E_ANIM` in render.ts). three's `AnimationAction` constructor eagerly builds
 * one `Interpolant` AND one `PropertyBinding` per track, so the old code built thousands of objects
 * per enemy to play "Idle".
 *
 * WHAT THIS PROVES
 * ----------------
 *   1. THE CLIP LIBRARY IS THE REAL ONE: the counts below are read out of the shipped .glb, not
 *      assumed — and BOTH manifest characters are measured, so a model swap cannot slip past.
 *   2. SPAWNING IS LAZY: spawning a character must NOT create an action per clip in the library
 *      (counter on `AnimationMixer.prototype.clipAction`). This is the regression gate for the fix —
 *      it fails loudly if someone reintroduces the eager loop.
 *   3. EVERY CLIP THE GAME PLAYS EXISTS: each name in `P_ANIM` / `E_ANIM` (imported from the built
 *      renderer, so this cannot drift from what actually plays) must resolve to a clip in the
 *      shipped model and must produce exactly one action on first `play()`. `CharInstance.play()`
 *      silently ignores an unknown name, so a renamed clip in a re-exported GLB would otherwise show
 *      up only as "the attack animation stopped playing" on a device.
 *   4. IT COSTS LITTLE AND GIVES THE MEMORY BACK: per-spawn wall time and retained heap are budgeted,
 *      and `dispose()` (called when the death animation finishes) must release the mixer's bindings
 *      — the old code kept every dead enemy's actions alive for the rest of the run, which is what
 *      turns a spawn burst into growing GC pauses.
 *
 * NO GPU IS INVOLVED: this imports the BUILT module (`dist/apps/shooter/src/assets.js`) and a real
 * .glb, so the numbers come from the shipping code path. `SkeletonUtils.clone` is stood in for by
 * three's own structural `Object3D.clone(true)`: the skeleton clone is a fixed cost that the fix does
 * not touch, and leaving it out keeps the measurement pointed at the animation layer it is about.
 *
 * Run:  npm run build && node --expose-gc scripts/verify-spawn-cost.mjs
 * (`--expose-gc` only sharpens the heap numbers; without it the heap assertions are skipped and the
 *  timing/laziness assertions still run.)
 * Exit code is non-zero when any assertion fails.
 */
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

// `dist/apps/shooter/src/*.js` imports the bare specifier 'three' (the browser resolves it through the
// app's <script type="importmap">). Node has no import map, so this hook is that map, pointed at the
// SAME vendored build the browser uses — never at a different three from npm.
const VENDOR = new URL('../dist/apps/shooter/vendor/three.module.min.js', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'three') return { url: VENDOR, shortCircuit: true };
    return next(specifier, context);
  },
});

const THREE = await import(VENDOR);
const { spawnFromTemplate } = await import(new URL('../dist/apps/shooter/src/assets.js', import.meta.url).href);
// The character manifest: WHICH file to measure and WHICH clip names its states ask for. Imported
// from the built module, so the test cannot drift from what the game loads.
const { PLAYER_CHARACTER, ENEMY_CHARACTER, requiredClips } = await import(new URL('../dist/apps/shooter/src/characters.js', import.meta.url).href);

const MODEL = new URL('../apps/shooter/assets/models/skeleton_minion.glb', import.meta.url);

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

// ---------------------------------------------------------------------------------------------
// A minimal glTF ANIMATION reader (scripts/lib/glb.mjs deliberately stops at geometry; this script
// needs samplers/tracks). Self-contained and dependency-free, like that helper.
// ---------------------------------------------------------------------------------------------
const COMPONENT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NUM_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function readContainer(source) {
  const buf = typeof source === 'string' || source instanceof URL ? readFileSync(source) : source;
  const jsonLength = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLength).toString('utf8'));
  let offset = 20 + jsonLength;
  let bin = null;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32LE(offset);
    const type = buf.readUInt32LE(offset + 4);
    if (type === 0x004e4942) bin = buf.subarray(offset + 8, offset + 8 + length);
    offset += 8 + length + ((4 - (length % 4)) % 4);
  }
  return { json, bin };
}

function accessorReader(json, bin) {
  return (index) => {
    const acc = json.accessors[index];
    const view = json.bufferViews[acc.bufferView];
    const Type = COMPONENT[acc.componentType];
    const n = NUM_COMPONENTS[acc.type];
    const base = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    return { values: new Type(bin.buffer, bin.byteOffset + base, acc.count * n), n, count: acc.count };
  };
}

/**
 * three's `PropertyBinding.sanitizeNodeName`, which is what GLTFLoader applies to node names before
 * building track names ('toes.l' -> 'toesl'). Reproduced so the tracks this test builds bind to the
 * nodes it builds (same reason the loader does it).
 */
const sanitize = (name) => String(name).replace(/\s/g, '_').replace(/[\[\]\.:\/]/g, '');

/** Build the node hierarchy (empty Object3D/Bone — geometry is irrelevant to animation cost). */
function buildScene(json) {
  const nodes = (json.nodes ?? []).map((node, i) => {
    const object = node.mesh !== undefined ? new THREE.Object3D() : new THREE.Bone();
    object.name = sanitize(node.name ?? 'node' + i);
    return object;
  });
  (json.nodes ?? []).forEach((node, i) => {
    for (const child of node.children ?? []) nodes[i].add(nodes[child]);
  });
  const root = new THREE.Object3D();
  const sceneRoots = json.scenes?.[json.scene ?? 0]?.nodes ?? [0];
  for (const i of sceneRoots) root.add(nodes[i]);
  return root;
}

/**
 * glTF animation paths -> the three property they drive. GLTFLoader does exactly this mapping
 * (PATH_PROPERTIES), which is why a track is called `<node>.position` and not `<node>.translation`;
 * getting it wrong does not fail loudly (three only warns "Trying to update property for track
 * … but it wasn't found"), so it is spelled out here.
 */
const PATH_PROPERTY = { translation: 'position', rotation: 'quaternion', scale: 'scale', weights: 'morphTargetInfluences' };

/** The model's clips as real `AnimationClip`s (same track names/types GLTFLoader produces). */
function buildClips(json, bin) {
  const read = accessorReader(json, bin);
  const clips = [];
  for (const animation of json.animations ?? []) {
    const tracks = [];
    let duration = 0;
    for (const channel of animation.channels) {
      const sampler = animation.samplers[channel.sampler];
      const times = read(sampler.input);
      const values = read(sampler.output);
      duration = Math.max(duration, times.values[times.values.length - 1] ?? 0);
      const property = PATH_PROPERTY[channel.target.path];
      if (property === undefined) continue; // e.g. morph weights: this model has none
      const name = sanitize(json.nodes[channel.target.node].name ?? 'node') + '.' + property;
      // Copied out of the GLB buffer so each track owns standalone arrays, exactly as the loader hands
      // them over (the retain-cost measurement must not accidentally share the file's memory).
      const t = Float32Array.from(times.values);
      const v = Float32Array.from(values.values);
      tracks.push(channel.target.path === 'rotation'
        ? new THREE.QuaternionKeyframeTrack(name, t, v)
        : new THREE.VectorKeyframeTrack(name, t, v));
    }
    clips.push(new THREE.AnimationClip(animation.name, duration, tracks));
  }
  return clips;
}

// ---------------------------------------------------------------------------------------------
// Measure — EVERY shipped character model, not just one: both are spawned through this path (the
// player template at startup, the enemy template on every wave), and a future model swap must not
// be able to hide behind a stale file name here.
// ---------------------------------------------------------------------------------------------
const MODELS_DIR = new URL('../apps/shooter/assets/models/', import.meta.url);
const MODELS = [['player', PLAYER_CHARACTER], ['enemy', ENEMY_CHARACTER]]
  .map(([role, def]) => ({ role, def, url: new URL(def.file, MODELS_DIR) }));
const spawns = 14; // one late wave's worth of enemies
const heapMB = () => process.memoryUsage().heapUsed / 1048576;
const gc = () => { if (global.gc) { global.gc(); global.gc(); } };

// Count the actions the spawn path builds. This is the behaviour the fix changes, asserted below.
let actionCalls = 0;
const realClipAction = THREE.AnimationMixer.prototype.clipAction;
THREE.AnimationMixer.prototype.clipAction = function (...args) { actionCalls++; return realClipAction.apply(this, args); };
let uncacheCalls = 0;
const realUncacheRoot = THREE.AnimationMixer.prototype.uncacheRoot;
THREE.AnimationMixer.prototype.uncacheRoot = function (...args) { uncacheCalls++; return realUncacheRoot.apply(this, args); };

check(MODELS.length === 2, 'both manifest characters are measured', MODELS.map((m) => m.def.file).join(', '));
console.log('');

for (const { role, def, url } of MODELS) {
  const base = role + ' ' + def.file;
  const allNames = requiredClips(def);
  console.log(`role ${role}: ${allNames.length} clips can ever play`);
  const { json, bin } = readContainer(url);
  const clips = buildClips(json, bin);
  const trackCounts = clips.map((c) => c.tracks.length);
  const trackTotal = trackCounts.reduce((a, b) => a + b, 0);
  const clipMap = new Map(clips.map((c) => [c.name, c]));
  const template = {
    root: buildScene(json),
    clips: clipMap,
    cloneFn: (object) => object.clone(true),
    upperTracks: new Map(),
  };

  console.log(`--- ${base}: ${clips.length} clips, ${trackTotal} tracks (max ${Math.max(...trackCounts)}/clip, `
    + `${Math.max(...clips.map((c) => c.tracks[0].times.length))} keys) ---`);

  gc();
  const heapBefore = heapMB();
  const t0 = performance.now();
  actionCalls = 0;
  // Spawned into a real scene, so "dispose() detaches the character" is a meaningful assertion rather
  // than a trivially true one (an unparented root has no parent either way).
  const scene = new THREE.Scene();
  const alive = [];
  for (let i = 0; i < spawns; i++) {
    const char = spawnFromTemplate(template);
    scene.add(char.root);
    alive.push(char);
  }
  const totalMs = performance.now() - t0;
  const callsPerSpawn = actionCalls / spawns;
  gc();
  const retainedPerSpawn = (heapMB() - heapBefore) / spawns;

  console.log(`spawn x${spawns}: ${totalMs.toFixed(0)} ms total, ${(totalMs / spawns).toFixed(2)} ms each`);
  console.log(`clipAction() calls per spawn: ${callsPerSpawn} (eager per-clip loop = ${clips.length} clips x up to ${Math.max(...trackCounts)} tracks)`);
  console.log(global.gc ? `retained heap per spawn: ${retainedPerSpawn.toFixed(2)} MB`
    : 'retained heap per spawn: n/a (run with --expose-gc for the heap numbers)');
  console.log('');

  // 1 + 2: laziness. Instantiating the whole library to be able to play "Idle" is exactly what
  // stalled the frame and kept ~1.8 MB per enemy alive for the whole run.
  check(clips.length >= 5, `${base}: ships a real clip library`, clips.length + ' clips');
  check(callsPerSpawn === 0, `${base}: spawning a character creates NO animation actions`,
    `got ${callsPerSpawn} per spawn (${clips.length} clips / ${trackTotal} tracks in the library)`);

  // 3: every name this character's states ask for exists, and gets exactly one action on first use.
  const missing = allNames.filter((n) => !clipMap.has(n));
  check(missing.length === 0, `${base}: every clip name its states ask for exists`, missing.join(', '));

  const char = alive[0];
  actionCalls = 0;
  for (const name of allNames) char.play(name, 0.1, true);
  check(actionCalls === allNames.length, `${base}: each played clip creates exactly one action, once`,
    `${actionCalls} actions for ${allNames.length} names`);
  actionCalls = 0;
  for (const name of allNames) char.play(name, 0.1, false);
  check(actionCalls === 0, `${base}: replaying an already-created clip creates no further actions`, `${actionCalls} calls`);

  // 4: the death path must give the bindings back.
  uncacheCalls = 0;
  for (const a of alive) a.dispose();
  check(uncacheCalls === spawns, `${base}: dispose() uncaches every spawned mixer`, `${uncacheCalls} uncacheRoot calls for ${spawns} spawns`);
  check(alive.every((a) => a.root.parent === null), `${base}: dispose() detaches the character from the scene graph`);
  // three's own bookkeeping is the contract that matters here: after dispose the mixer must hold no
  // action for this root (those actions are what own the interpolants). Asserted structurally rather
  // than by heap size, because the heap also carries the character clone and V8's own noise.
  check(alive.every((a) => Object.keys(a.mixer._actionsByClip ?? {}).length === 0),
    `${base}: the disposed mixers hold no actions for their root`,
    String(Object.keys(alive[0].mixer._actionsByClip ?? {}).length));
  // …and the memory really does come back. NOTE the second half: `uncacheRoot` alone is not enough if
  // the caller still holds the `AnimationAction` objects (they own their interpolants), which is why
  // `dispose()` also clears the instance's action map — and why this drops the char references exactly
  // like render.ts::releaseView does (`v.char = null`) before measuring. What remains is the character
  // clone plus V8's own accounting; what must NOT remain is anything proportional to the clip library.
  if (global.gc) {
    alive.length = 0;
    gc();
    const residualPerSpawn = (heapMB() - heapBefore) / spawns;
    check(residualPerSpawn < 0.1, `${base}: after the death path the residual per enemy is small`,
      `+${residualPerSpawn.toFixed(3)} MB/enemy left (was ${retainedPerSpawn.toFixed(2)} MB while alive;`
      + ' a negative number only means the heap settled back under its baseline)');
  }

  // Budgets. The laziness assertion above is exact and machine-independent; these two are the coarse
  // net (measured on the machine this was written on: the eager 95-clip loop cost 8.1-8.6 ms and
  // 1.79 MB per spawn, the lazy path ~2-4 ms and ~0.1 MB).
  check(totalMs / spawns < 6, `${base}: spawn cost stays under the per-spawn budget`, `${(totalMs / spawns).toFixed(2)} ms < 6 ms`);
  if (global.gc) check(retainedPerSpawn < 0.4, `${base}: retained heap per spawn stays under budget`, `${retainedPerSpawn.toFixed(2)} MB < 0.4 MB`);
  console.log('');
}

console.log(failures === 0 ? 'verify-spawn-cost: all assertions passed' : `verify-spawn-cost: ${failures} assertion(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
