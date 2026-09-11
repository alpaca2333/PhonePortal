/**
 * CPU-side verification for the SHADER-SPACE facts about a character: how big it is actually DRAWN,
 * and how thick its outline hull is.
 *
 * WHY THIS EXISTS (the bug that motivated it)
 * -------------------------------------------
 * A real-device screenshot showed every character as a 「巨大的黑球」. Nothing in the box-based checks
 * could see it, because the cause was in SHADER SPACE: a hull's outline offset is applied to
 * `transformed` in the MESH's local space, and the Quaternius exports carry a **100x node scale**
 * (mesh nodes have world scale ~145 after the loader's 2.0-unit normalization). `OUTLINE_WIDTH = 0.07`
 * was therefore a **10.2 world-unit** thick black BackSide shell — a 22-unit blob hiding a 2-unit
 * character — while the model that worked before (KayKit, world scale 0.86) accidentally made the same
 * constant read as 0.06 world units. `Box3.setFromObject` cannot see any of this: the offset happens
 * after the box is computed, in the vertex shader.
 *
 * WHAT THIS SCRIPT DOES
 * ---------------------
 * It rebuilds the loaded character the way GLTFLoader does (the glTF node object IS the SkinnedMesh,
 * bound with the IDENTITY matrix — that detail is what makes a scaled node so dangerous), runs the
 * REAL shipped code path (`assets.js::spawnFromTemplate`, which strips, normalizes, toonifies, clones
 * and calls `addOutline`), and then measures with the vendored three:
 *
 *   1. THE DRAWN HEIGHT is `applyBoneTransform()` x `matrixWorld` summed over all meshes: the same
 *      arithmetic the vertex shader does. It must be ~2.0 world units (the loader's target).
 *   2. NOTHING IS GIANT: every mesh's world-space bounding box must stay inside a small multiple of
 *      the character, both at rest and after the idle clip has been played for half a second.
 *   3. THE OUTLINE HULL IS WORLD-SIZED: the hull's local offset times its world scale must equal
 *      `OUTLINE_WIDTH`, not 145x it. This is the assertion that would have caught the black blob.
 *
 * It also prints the per-mesh world scale, because "why is this model scaled by 100" is the single
 * most surprising fact about it and the next person deserves to see it without re-deriving it.
 *
 * Run:  npm run build && node scripts/verify-character-render.mjs
 * Exit code is non-zero when any assertion fails.
 */
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';

const VENDOR = new URL('../dist/apps/shooter/vendor/three.module.min.js', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'three') return { url: VENDOR, shortCircuit: true };
    return next(specifier, context);
  },
});

const THREE = await import(VENDOR);
const { spawnFromTemplate } = await import(new URL('../dist/apps/shooter/src/assets.js', import.meta.url).href);
const { toonify, outlineLocalWidth, OUTLINE_WIDTH } = await import(new URL('../dist/apps/shooter/src/toon.js', import.meta.url).href);
const SkeletonUtils = await import(new URL('../dist/apps/shooter/vendor/addons/utils/SkeletonUtils.js', import.meta.url).href);
const { PLAYER_CHARACTER, ENEMY_CHARACTER } = await import(new URL('../dist/apps/shooter/src/characters.js', import.meta.url).href);

const MODELS_DIR = new URL('../apps/shooter/assets/models/', import.meta.url);
let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL '} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

const COMPONENT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NUM = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const PROPERTY = { translation: 'position', rotation: 'quaternion', scale: 'scale' };
// three's PropertyBinding.sanitizeNodeName — GLTFLoader applies it to every node name, and the clip
// track names are built from the sanitized name.
const sanitize = (n) => String(n).replace(/\s/g, '_').replace(/[\[\]\.:\/]/g, '');

/** Build the GLTFLoader-shaped scene graph (mesh node IS the SkinnedMesh, identity bind) + real clips. */
function buildGltfScene(file) {
  const buf = readFileSync(file);
  const jsonLength = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLength).toString('utf8'));
  let offset = 20 + jsonLength, bin = null;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32LE(offset), type = buf.readUInt32LE(offset + 4);
    if (type === 0x004e4942) bin = buf.subarray(offset + 8, offset + 8 + length);
    offset += 8 + length + ((4 - (length % 4)) % 4);
  }
  const read = (i) => {
    const a = json.accessors[i], v = json.bufferViews[a.bufferView];
    const T = COMPONENT[a.componentType], n = NUM[a.type];
    const start = (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
    return { arr: new T(bin.buffer, bin.byteOffset + start, a.count * n), n, count: a.count };
  };
  const toMatrix = (i) => new THREE.Matrix4().fromArray(Array.from(read(i).arr));

  const nodes = json.nodes.map((n) => (n.mesh !== undefined ? null : new THREE.Bone()));
  json.nodes.forEach((n, i) => {
    if (!nodes[i]) return;
    // GLTFLoader SANITIZES node names ('Foot.R' -> 'FootR'); without this the clip tracks for every
    // dotted bone fail to bind and the animated half of this test would silently measure the rest pose.
    if (n.name) nodes[i].name = sanitize(n.name);
    nodes[i].position.fromArray(n.translation ?? [0, 0, 0]);
    nodes[i].quaternion.fromArray(n.rotation ?? [0, 0, 0, 1]);
    nodes[i].scale.fromArray(n.scale ?? [1, 1, 1]);
  });
  json.nodes.forEach((n, i) => { for (const c of n.children ?? []) if (nodes[i] && nodes[c]) nodes[i].add(nodes[c]); });
  const scene = new THREE.Object3D();
  for (const r of json.scenes?.[json.scene ?? 0]?.nodes ?? [0]) if (nodes[r]) scene.add(nodes[r]);
  scene.updateMatrixWorld(true);

  const meshNodes = [];
  json.nodes.forEach((n, i) => {
    if (n.mesh === undefined) return;
    const prim = json.meshes[n.mesh].primitives[0];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(read(prim.attributes.POSITION).arr), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(read(prim.attributes.NORMAL).arr), 3));
    const mat = new THREE.MeshStandardMaterial({ color: 0x808080 });
    let mesh;
    if (n.skin !== undefined) {
      g.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint16Array(read(prim.attributes.JOINTS_0).arr), 4));
      g.setAttribute('skinWeight', new THREE.BufferAttribute(new Float32Array(read(prim.attributes.WEIGHTS_0).arr), 4));
      const skin = json.skins[n.skin];
      const bones = skin.joints.map((x) => nodes[x]);
      const inverses = skin.joints.map((_, k) => toMatrix(skin.inverseBindMatrices).clone().fromArray(Array.from(read(skin.inverseBindMatrices).arr).slice(k * 16, k * 16 + 16)));
      mesh = new THREE.SkinnedMesh(g, mat);
      mesh.bind(new THREE.Skeleton(bones, inverses), new THREE.Matrix4());   // GLTFLoader binds IDENTITY
    } else {
      mesh = new THREE.Mesh(g, mat);
    }
    mesh.name = n.name ? sanitize(n.name) : '';
    const src = json.nodes[i];
    mesh.position.fromArray(src.translation ?? [0, 0, 0]);
    mesh.quaternion.fromArray(src.rotation ?? [0, 0, 0, 1]);
    mesh.scale.fromArray(src.scale ?? [1, 1, 1]);
    const parent = nodes[i] ? nodes[i].parent : scene;
    if (nodes[i] && parent) parent.remove(nodes[i]);
    (parent ?? scene).add(mesh);
    nodes[i] = mesh;
    for (const c of src.children ?? []) if (nodes[c] && nodes[c] !== mesh) mesh.add(nodes[c]);
    meshNodes.push(mesh);
  });
  scene.updateMatrixWorld(true);

  const clips = new Map();
  for (const a of json.animations ?? []) {
    const tracks = [];
    let dur = 0;
    for (const ch of a.channels) {
      const sm = a.samplers[ch.sampler];
      const times = read(sm.input), vals = read(sm.output);
      dur = Math.max(dur, times.arr[times.count - 1] ?? 0);
      const name = sanitize(json.nodes[ch.target.node].name) + '.' + PROPERTY[ch.target.path];
      tracks.push(ch.target.path === 'rotation'
        ? new THREE.QuaternionKeyframeTrack(name, Float32Array.from(times.arr), Float32Array.from(vals.arr))
        : new THREE.VectorKeyframeTrack(name, Float32Array.from(times.arr), Float32Array.from(vals.arr)));
    }
    clips.set(a.name, new THREE.AnimationClip(a.name, dur, tracks));
  }
  return { scene, clips, meshNodes };
}

/** The vertex shader's arithmetic: skin the vertex, then multiply by matrixWorld. */
function drawnBounds(root) {
  const v = new THREE.Vector3();
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  root.traverse((o) => {
    if (!o.isMesh) return;
    const pos = o.geometry.attributes.position;
    for (let k = 0; k < pos.count; k++) {
      v.fromBufferAttribute(pos, k);
      if (o.isSkinnedMesh) o.applyBoneTransform(k, v);
      v.applyMatrix4(o.matrixWorld);
      for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], v.getComponent(c)); hi[c] = Math.max(hi[c], v.getComponent(c)); }
    }
  });
  return { lo, hi, size: hi.map((h, i) => h - lo[i]) };
}

for (const [role, def] of [['player', PLAYER_CHARACTER], ['enemy', ENEMY_CHARACTER]]) {
  const file = new URL(def.file, MODELS_DIR);
  const { scene, clips } = buildGltfScene(file);

  // --- the loader's own steps, in the loader's order (assets.ts::loadCharTemplate) ---
  const doomed = [];
  scene.traverse((o) => { if (o.isMesh && def.strip.includes(o.name)) doomed.push(o); });
  for (const o of doomed) o.parent.remove(o);
  const box = new THREE.Box3().setFromObject(scene);
  const height = box.max.y - box.min.y;
  scene.scale.multiplyScalar(2.0 / height);
  scene.updateMatrixWorld(true);
  const box2 = new THREE.Box3().setFromObject(scene);
  scene.position.x -= (box2.min.x + box2.max.x) / 2;
  scene.position.z -= (box2.min.z + box2.max.z) / 2;
  scene.position.y -= box2.min.y;
  scene.updateMatrixWorld(true);
  toonify(scene);
  const wrapper = new THREE.Group();
  wrapper.add(scene);

  const worldScale = new THREE.Vector3();
  const scales = [];
  scene.traverse((o) => { if (o.isMesh) { o.getWorldScale(worldScale); scales.push(Math.abs(worldScale.x)); } });
  const worstScale = Math.max(...scales);

  // --- the real spawn path (clone + materials + addOutline + castShadow) ---
  const char = spawnFromTemplate({ root: wrapper, clips, cloneFn: SkeletonUtils.clone, upperTracks: new Map() });
  char.root.updateMatrixWorld(true);
  const atRest = drawnBounds(char.root);

  console.log(`\n${role} ${def.file}: ${scales.length} meshes, worst world scale ${worstScale.toFixed(2)}`);
  check(atRest.size[1] > 1.8 && atRest.size[1] < 2.2,
    `${role}: is DRAWN ~2.0 world units tall at rest (the loader's target)`,
    `${atRest.size[1].toFixed(3)} units, y ${atRest.lo[1].toFixed(2)}..${atRest.hi[1].toFixed(2)}`);
  check(atRest.lo[1] > -0.35 && atRest.lo[1] < 0.35, `${role}: stands on the floor (feet near y = 0)`,
    `min y ${atRest.lo[1].toFixed(3)}`);
  check(Math.max(...atRest.size) < 3.2, `${role}: no mesh is giant at rest`,
    `largest extent ${Math.max(...atRest.size).toFixed(2)} units`);

  // --- THE ASSERTION THAT WOULD HAVE CAUGHT THE BLACK BLOB ---
  let worstOutline = 0;
  char.root.traverse((o) => {
    if (!o.isMesh || !o.userData.__outline) return;
    o.getWorldScale(worldScale);
    const local = (o.material.userData.__outlineWidth ?? outlineLocalWidth((Math.abs(worldScale.x) + Math.abs(worldScale.y) + Math.abs(worldScale.z)) / 3));
    worstOutline = Math.max(worstOutline, Math.abs(local) * worstScale);
  });
  check(worstOutline <= OUTLINE_WIDTH * 1.5 + 1e-9,
    `${role}: the outline hull is WORLD-sized (<= 1.5x OUTLINE_WIDTH), not scaled with the model`,
    `effective thickness ${worstOutline.toFixed(3)} world units (OUTLINE_WIDTH = ${OUTLINE_WIDTH}; uncompensated it was ${(OUTLINE_WIDTH * worstScale).toFixed(1)})`);
  check(worstScale > 10 ? worstOutline < 0.2 : true,
    `${role}: …and for this model that compensation is load-bearing (node scale ${worstScale.toFixed(0)}x)`,
    `uncompensated thickness would be ${(OUTLINE_WIDTH * worstScale).toFixed(1)} world units`);

  // --- animated: play the idle clip and re-measure (nothing may explode once the mixer runs) ---
  const idle = def.anims.idle || clips.values().next().value?.name;
  const action = clips.has(idle) ? char.mixer.clipAction(clips.get(idle)) : null;
  if (action) {
    action.play();
    for (let i = 0; i < 30; i++) { char.update(1 / 60); char.root.updateMatrixWorld(true); }
    const posed = drawnBounds(char.root);
    check(posed.size[1] > 1.5 && posed.size[1] < 2.6 && Math.max(...posed.size) < 3.5,
      `${role}: stays character-sized after 0.5s of "${idle}"`,
      `${posed.size.map((v) => v.toFixed(2)).join(' x ')} units`);
  }
  char.dispose();
}

console.log('');
console.log(failures === 0 ? 'verify-character-render: all assertions passed' : `verify-character-render: ${failures} assertion(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
