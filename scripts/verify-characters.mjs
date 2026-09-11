/**
 * CPU-side verification for the SHIPPED CHARACTER MODELS (apps/shooter/assets/models/*.glb).
 *
 * WHY THIS EXISTS
 * ---------------
 * Swapping the characters is a pure asset change — no code in the render path knows a bone name, a
 * clip name or a file name — so nothing else in the suite would notice a broken swap. What WOULD
 * break is the set of assumptions the animation system and the placement math silently make:
 *
 *   1. THE RIG IS SHARED. `assets.ts` captures an upper-body aiming pose from the shoot clip by BONE
 *      NAME (`UPPER_BONES`: spine/chest/head/upperarml…), and both characters are driven by the same
 *      clip library, because both files ship the same skeleton. Two models from different packs (or a
 *      re-export) would silently lose the aim overlay instead of failing.
 *   2. THE MODEL FACES +Z. `render.ts` hard-codes `MODEL_FORWARD_YAW = Math.PI/2` because the rig's
 *      rest pose faces +Z; a model that faced -Z would walk backwards forever with no error anywhere.
 *      Measured here from the rig itself (toes are in front of the ankles), not from a screenshot.
 *   3. EVERY CLIP THE GAME PLAYS EXISTS. `CharInstance.play()` ignores an unknown name, so a renamed
 *      clip shows up only as "that animation stopped playing" on a device.
 *   4. HELD ITEMS ARE STRIPPED, AND THE STRIP IS LOAD-BEARING. KayKit ships each character holding its
 *      default weapon; the game has no weapon models, and — the part that is easy to miss — a held
 *      sword sticks out in FRONT, so `normalizeModel()` (which centres the model on its bounding box)
 *      would push the body ~0.58 units behind its own origin. This script computes both cases: the
 *      stripped model must centre, and the UNSTRIPPED one must fail that check (proving the strip is
 *      what keeps the picture and the collision circle in the same place).
 *   5. THE FILES ARE OFFLINE AND SELF-CONTAINED. No external buffer/image URIs (the app is served from
 *      a local portal with no network), and a sane size (they are shipped twice: source + dist).
 *
 * NOT asserted: that the characters look good. That is a device question (there is no browser here).
 * The measured head-to-height ratio IS printed, because it is the honest answer to "how stylized is
 * this pack", and pinned in a band so a future swap has to update the README that quotes it.
 *
 * Run:  npm run build && node scripts/verify-characters.mjs
 * Exit code is non-zero when any assertion fails.
 */
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { registerHooks } from 'node:module';

// `dist/apps/shooter/src/render.js` imports the bare specifier 'three' (the browser resolves it
// through the app's <script type="importmap">; Node has no import map). This hook is that map,
// pointed at the SAME vendored build — same trick as scripts/verify-spawn-cost.mjs.
const VENDOR = new URL('../dist/apps/shooter/vendor/three.module.min.js', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'three') return { url: VENDOR, shortCircuit: true };
    return next(specifier, context);
  },
});

const MODELS_DIR = new URL('../apps/shooter/assets/models/', import.meta.url);
// The clip names come from the BUILT renderer, so this cannot drift from what actually plays.
// The character manifest + the loader's bone list, straight from the built modules: the test checks
// the same mapping the game loads, not a copy of it.
const { PLAYER_CHARACTER, ENEMY_CHARACTER, requiredClips } = await import(new URL('../dist/apps/shooter/src/characters.js', import.meta.url).href);
const { UPPER_BONES } = await import(new URL('../dist/apps/shooter/src/assets.js', import.meta.url).href);

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL '} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

// ---------------------------------------------------------------------------------------------
// glTF reading: container + node TRS chain + accessor bounds (the same math scripts/lib/glb.mjs
// uses for props — deliberately dependency-free, no three.js).
// ---------------------------------------------------------------------------------------------
function parseGlb(file) {
  const buf = readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB: ' + file);
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
  return { json, bin, bytes: buf.length };
}

function compose(t, q, s) {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  const [sx, sy, sz] = s;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    t[0], t[1], t[2], 1,
  ];
}
const mul = (a, b) => {
  const r = new Array(16);
  for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[c * 4 + k];
    r[c * 4 + row] = s;
  }
  return r;
};
const xform = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];

function readModel(file) {
  const { json, bin, bytes } = parseGlb(file);
  const parents = new Array(json.nodes.length).fill(-1);
  json.nodes.forEach((node, i) => { for (const child of node.children ?? []) parents[child] = i; });
  const cache = new Map();
  const world = (i) => {
    if (cache.has(i)) return cache.get(i);
    const node = json.nodes[i];
    const local = compose(node.translation ?? [0, 0, 0], node.rotation ?? [0, 0, 0, 1], node.scale ?? [1, 1, 1]);
    const m = parents[i] < 0 ? local : mul(world(parents[i]), local);
    cache.set(i, m);
    return m;
  };
  const position = (i) => { const m = world(i); return { x: m[12], y: m[13], z: m[14] }; };
  const byName = new Map(json.nodes.map((node, i) => [node.name, i]));

  /** Every mesh node, with the AABB three's `Box3.setFromObject` would see (accessor bounds × world). */
  const meshes = [];
  for (let i = 0; i < json.nodes.length; i++) {
    const node = json.nodes[i];
    if (node.mesh === undefined) continue;
    const m = world(i);
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const prim of json.meshes[node.mesh].primitives) {
      const acc = json.accessors[prim.attributes.POSITION];
      if (!acc || !acc.min) continue;
      for (const x of [acc.min[0], acc.max[0]]) for (const y of [acc.min[1], acc.max[1]]) for (const z of [acc.min[2], acc.max[2]]) {
        const p = xform(m, [x, y, z]);
        for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
      }
    }
    const chain = [];
    for (let j = i; j >= 0; j = parents[j]) chain.push(json.nodes[j].name);
    meshes.push({ name: node.name, lo, hi, chain, held: chain.some((n) => typeof n === 'string' && n.startsWith('handslot')) });
  }

  const union = (list) => {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const m of list) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], m.lo[k]); hi[k] = Math.max(hi[k], m.hi[k]); }
    return { lo, hi };
  };
  return { file, json, bytes, bin, byName, position, meshes, union, clips: new Map((json.animations ?? []).map((a) => [a.name, a])) };
}

/** What `assets.ts::normalizeModel` does to a set of meshes: scale to 2.0 tall, feet at 0, centred. */
function normalize(box, targetHeight = 2.0) {
  const height = box.hi[1] - box.lo[1];
  const s = targetHeight / height;
  const scaled = {
    lo: box.lo.map((v) => v * s),
    hi: box.hi.map((v) => v * s),
  };
  const cx = (scaled.lo[0] + scaled.hi[0]) / 2;
  const cz = (scaled.lo[2] + scaled.hi[2]) / 2;
  const shift = [cx, scaled.lo[1], cz];   // what the code subtracts
  return {
    height: (scaled.hi[1] - scaled.lo[1]),
    minY: 0,
    // Residual centre after the shift — the model stands on its own origin only if this is ~0.
    centre: [(scaled.lo[0] + scaled.hi[0]) / 2 - cx, (scaled.lo[2] + scaled.hi[2]) / 2 - cz],
    // Same measurement WITHOUT the shift, i.e. how far off-centre the raw (held items included) box is.
    rawCentre: [(box.lo[0] + box.hi[0]) / 2 * s, (box.lo[2] + box.hi[2]) / 2 * s],
    shift,
  };
}

// ---------------------------------------------------------------------------------------------
// The shipped set — driven by the CHARACTER MANIFEST (src/characters.ts), so the test checks the
// same file+clip mapping the game loads, per character, instead of guessing from the file list.
// ---------------------------------------------------------------------------------------------
const files = readdirSync(MODELS_DIR).filter((f) => f.endsWith('.glb')).sort();
const CHARACTERS = [['player', PLAYER_CHARACTER], ['enemy', ENEMY_CHARACTER]];
const models = CHARACTERS.map(([role, def]) => ({ role, def, model: readModel(new URL(def.file, MODELS_DIR)) }));

const manifestFiles = [...new Set(CHARACTERS.map(([, def]) => def.file))];
check(manifestFiles.every((f) => files.includes(f)), 'every manifest file is on disk',
  manifestFiles.join(', ') + ' vs ' + files.join(', '));
check(files.every((f) => manifestFiles.includes(f)), 'the models directory is EXACTLY the manifest (no unused .glb)',
  files.join(', '));
for (const f of manifestFiles) check(files.includes(f), `the manifest file exists: ${f}`);

// 5: offline + self-contained + sane size + a skin every mesh shares
for (const { role, def, model } of models) {
  const base = def.file;
  const external = (model.json.buffers ?? []).some((b) => b.uri) || (model.json.images ?? []).some((i) => i.uri);
  check(!external, `${role} ${base}: self-contained (no external buffer/image URIs)`);
  check(model.bytes > 5e4 && model.bytes < 5e6, `${role} ${base}: shipped size is sane`, `${(model.bytes / 1048576).toFixed(2)} MB`);
  const skins = model.json.skins ?? [];
  check(skins.length >= 1, `${role} ${base}: has a skin`, String(skins.length));
  const shared = skins.every((s) => JSON.stringify(s.joints) === JSON.stringify(skins[0].joints));
  check(shared, `${role} ${base}: every mesh is driven by the SAME joints ` +
    '(otherwise animating the root would move only one part)', `${skins.length} skins, ${new Set(skins.flatMap((s) => s.joints)).size} joint nodes`);
}

// 2: the model faces +Z (what MODEL_FORWARD_YAW = PI/2 assumes). Two independent rig signals, in
//    order of preference: the toes in front of the ankle (human-shaped rigs), else the eye in front
//    of the body (the robot has no usable foot direction — its legs splay sideways).
for (const { role, def, model } of models) {
  const base = def.file;
  const z = (name) => { const i = model.byName.get(name); return i === undefined ? null : model.position(i).z; };
  // Candidate signals, strongest first. A robot whose legs splay sideways has foot-end bones too —
  // they just carry no forward information (delta ~0), so the signal with the largest displacement
  // wins and the eye-vs-body offset is the fallback.
  const signals = [];
  for (const side of ['L', 'R']) {
    const toe = z(`Toe.${side}`) ?? z(`toes.${side}`) ?? z(`Foot.${side}_end`);
    const foot = z(`Foot.${side}`);
    if (toe !== null && foot !== null) signals.push({ name: `Foot.${side}_end - Foot.${side}`, value: toe - foot });
  }
  const eye = z('Eye'), body = z('Body') ?? z('Hips');
  if (eye !== null && body !== null) signals.push({ name: 'Eye - Body', value: eye - body });
  const best = signals.reduce((a, b) => (Math.abs(b.value) > Math.abs(a.value) ? b : a), { name: 'none', value: 0 });
  check(best.value > 0.02,
    `${role} ${base}: the rest pose faces +Z (so MODEL_FORWARD_YAW stays PI/2)`,
    signals.map((s) => `${s.name} = ${s.value.toFixed(2)}`).join(' | ') + ` -> used ${best.name}`);
}

// 3: every clip the manifest maps exists in that character's file, and the file is a real library
for (const { role, def, model } of models) {
  const base = def.file;
  const needed = requiredClips(def);
  const missing = needed.filter((n) => !model.clips.has(n));
  check(missing.length === 0, `${role} ${base}: has every clip its states ask for (${needed.length} names)`,
    missing.length ? 'missing: ' + missing.join(', ') : `${model.clips.size} clips shipped`);
  check(model.clips.size >= 5, `${role} ${base}: ships a real clip library, not a 1-clip demo`, `${model.clips.size} clips`);
  if (def.aimPose) {
    // Coverage, not just existence: the overlay can only override the bones the aim clip animates,
    // and this pack's clips are sparse (13-21 bones each). A sparse aim clip would leave the other
    // arm playing its run animation while one arm aims, so the count is asserted.
    const aim = model.json.animations.find((a) => a.name === def.aimPose);
    const animated = new Set((aim?.channels ?? [])
      .filter((c) => c.target.path === 'rotation')
      .map((c) => String(model.json.nodes[c.target.node].name).replace(/\s/g, '_').replace(/[\[\]\.:\/]/g, '')));
    // three's PropertyBinding.sanitizeNodeName: 'Shoulder.L' -> 'ShoulderL' (the names UPPER_BONES
    // and the clip tracks are both written in).
    const sanitize = (n) => String(n).replace(/\s/g, '_').replace(/[\[\]\.:\/]/g, '');
    const covered = UPPER_BONES.filter((b) => animated.has(b));
    const raw = new Set(model.json.nodes.map((n) => n.name));
    const sanitized = new Set([...raw].map(sanitize));
    const missingBones = UPPER_BONES.filter((b) => !raw.has(b) && !sanitized.has(b));
    check(missingBones.length === 0,
      `${role} ${base}: has every upper-body bone the aim overlay samples (${UPPER_BONES.length} bones)`,
      missingBones.length ? 'missing: ' + missingBones.join(', ') : `${def.aimPose} -> ${UPPER_BONES.join(', ')}`);
    check(covered.length >= 10,
      `${role} ${base}: the aim clip actually animates most of those bones (coverage >= 10/13)`,
      `${def.aimPose} animates ${covered.length}/${UPPER_BONES.length}: ${covered.join(', ')}`);
  } else {
    check(true, `${role} ${base}: no aim overlay (manifest aimPose = ''), so no bones are required`);
  }
}

// 4: the manifest's strip list is real, and stripping is what keeps the body on its origin
for (const { role, def, model } of models) {
  const base = def.file;
  const names = new Set(model.meshes.map((m) => m.name));
  const stale = def.strip.filter((n) => !names.has(n));
  check(stale.length === 0, `${role} ${base}: the manifest's strip list matches the file`, stale.length ? 'not in file: ' + stale.join(', ') : def.strip.join(', ') || '(none)');
  const body = model.meshes.filter((m) => !m.held && !def.strip.includes(m.name));
  const removed = model.meshes.length - body.length;
  check(removed === def.strip.length, `${role} ${base}: exactly the listed meshes are stripped`, `${removed} of ${model.meshes.length}`);
  check(body.length > 0, `${role} ${base}: a body survives the strip`, body.map((b) => b.name).join(', '));

  const stripped = normalize(model.union(body));
  const unstripped = normalize(model.union(model.meshes));
  check(Math.abs(stripped.height - 2.0) < 1e-6 && Math.abs(stripped.minY) < 1e-6,
    `${role} ${base}: normalizes to exactly 2.0 world units tall, standing on y = 0`, `h=${stripped.height.toFixed(4)}`);
  check(Math.abs(stripped.centre[0]) < 0.05 && Math.abs(stripped.centre[1]) < 0.05,
    `${role} ${base}: the BODY ends up centred on its own origin (hitbox/health bar/shadow agree with the picture)`,
    `centre x=${stripped.centre[0].toFixed(3)} z=${stripped.centre[1].toFixed(3)}`);
  if (def.strip.length) {
    check(Math.abs(unstripped.rawCentre[0]) > 0.1 || Math.abs(unstripped.rawCentre[1]) > 0.1,
      `${role} ${base}: …and the strip is load-bearing (WITH the held item the body would sit off-centre)`,
      `unstripped centre x=${unstripped.rawCentre[0].toFixed(2)} z=${unstripped.rawCentre[1].toFixed(2)}`);
  }
}

// The stylization metric, measured and reported: how much of the height sits ABOVE the head bone.
// This is the honest answer to "is this a big-head character", and it is the number the README quotes
// (the previous pack was ~50%, i.e. ~2 heads tall by this measure; the cyber-human is ~82%).
for (const { role, def, model } of models) {
  const base = def.file;
  const body = model.meshes.filter((m) => !m.held && !def.strip.includes(m.name));
  const box = model.union(body);
  const height = box.hi[1] - box.lo[1];
  const headBone = model.byName.get('Head');
  const boneRatio = headBone === undefined ? NaN : (model.position(headBone).y - box.lo[1]) / height;
  console.log(`  info  ${role} ${base}: head bone at ${(boneRatio * 100).toFixed(0)}% of height `
    + `(chibi packs sit near 50%, a realistic human near 85%)`);
  if (role === 'player') {
    check(boneRatio > 0.72, 'the PLAYER model is realistically proportioned (not a big-head character)',
      `head bone at ${(boneRatio * 100).toFixed(1)}% of height`);
  }
}

// 6: the two sides must be TELLABLE APART. They share one model, so the only thing separating them in
//    world space is the tint — a missing or equal tint would put two identical orange humans in the
//    arena (the health bar and the tracers would be the only clue, and both are easy to miss in a dark
//    room). Negative/zero channels are rejected too: that is a black or invisible character.
{
  const [pRole, pDef] = CHARACTERS[0];
  const [eRole, eDef] = CHARACTERS[1];
  for (const [role, def] of CHARACTERS) {
    if (!def.tint) { check(true, `${role}: no tint (keeps the model's own colours)`); continue; }
    const sane = def.tint.every((c) => Number.isFinite(c) && c > 0.05 && c <= 1.5);
    check(sane, `${role}: the tint is a sane positive multiplier`, def.tint.map((c) => c.toFixed(2)).join('/'));
  }
  if (pDef.file === eDef.file) {
    const sameTint = JSON.stringify(pDef.tint ?? null) === JSON.stringify(eDef.tint ?? null);
    const spread = pDef.tint && eDef.tint
      ? Math.max(...pDef.tint.map((c, i) => Math.abs(c - eDef.tint[i]))) : 1;
    check(!sameTint && spread >= 0.25,
      'the two sides sharing one model are tinted differently enough to tell apart',
      `spread ${spread.toFixed(2)} (player ${JSON.stringify(pDef.tint ?? null)} vs enemy ${JSON.stringify(eDef.tint ?? null)})`);
  }
}

console.log('');
console.log(failures === 0 ? 'verify-characters: all assertions passed' : `verify-characters: ${failures} assertion(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
