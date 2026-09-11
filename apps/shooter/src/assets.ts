// GLB character loading + animation, with a primitive fallback so the game
// always runs even if a model fails to load.
import * as THREE from 'three';
import { toonify, addOutline, setCastShadow, createToonMaterial, tintCharacter,
  cloneInstanceMaterials, captureFlashMaterials, applyCharTint, FlashMaterial } from './toon.js';
// The recentring formula and the theme's albedo overrides live in the pure layout module, so the
// Node tests can assert the same numbers/colours the loader uses (see propNormalizeOffset,
// propTintForFile).
import { propNormalizeOffset, propTintForFile } from './props.js';
// The character manifest: which file, which meshes to strip, which clip is the aim pose (see that
// module for why these three live together).
import { CharacterDef, requiredClips } from './characters.js';

// Upper-body bones by three.js sanitized names ('Shoulder.L' -> 'ShoulderL', 'toes.l' -> 'toesl').
// Used to layer the aiming pose on top of a full-body locomotion clip, so the legs keep moving.
// EXPORTED for scripts/verify-characters.mjs: a character swap is only safe if the new rig actually
// has these bones, and a test that re-declared the list could drift from the one the loader uses.
// NOTE the pack's own bone names: the Quaternius rig is Hips/Abdomen/Torso/Chest/Neck/Head plus
// Shoulder/UpperArm/LowerArm/Hand (it has no `wrist`, and the spine is split into Abdomen+Torso).
// ⚠️ THE CASE AND THE SANITIZED FORM MATTER: `getObjectByName` is case-sensitive, and the loader's
// sanitizer only strips `[].:/` (so `Shoulder.L` -> `ShoulderL`, while `Abdomen` keeps its capital).
// Writing these lower-case is a silent failure — the overlay simply finds no bones and never applies
// (verify-characters caught exactly that when this list was first ported to the new rig).
export const UPPER_BONES = ['Abdomen', 'Torso', 'Chest', 'Neck', 'Head',
  'ShoulderL', 'UpperArmL', 'LowerArmL', 'HandL',
  'ShoulderR', 'UpperArmR', 'LowerArmR', 'HandR'];

export interface CharTemplate {
  root: any;
  clips: Map<string, any>;
  cloneFn: (obj: any) => any;
  upperTracks: Map<string, any>; // upper-body quaternion tracks from the shoot clip
}

export interface CharInstance {
  root: any;
  mixer: any;
  hasUpperBody: boolean;
  /**
   * Cross-fade to `name`. A repeated name is a no-op UNLESS `restart` is set, which rewinds the
   * clip to frame 0 — that is what makes a one-shot attack animation (the melee slice) replayable
   * without the caller having to alternate between two clip names.
   */
  play(name: string, fade?: number, restart?: boolean): void;
  update(dt: number): void;
  setUpperBlend(weight: number, dt: number): void;
  setHitFlash(t: number): void; // 1 = surface fully red, 0 = normal; deduped internally
  /** 0..1 burn glow (see chartint.ts): a burning body is self-lit so it cannot read as a black hole. */
  setBurnGlow(t: number): void;
  /**
   * Release this instance's animation bindings (three's `AnimationMixer.uncacheRoot`) and detach its
   * root. NOT idempotent-by-accident: after this the instance must not be played or updated again —
   * render.ts only calls it on a corpse whose death animation has finished, and never revisits that
   * view. Geometry and textures are shared with the template and are deliberately left alone.
   */
  dispose(): void;
}

// Tint closure shared by both spawn paths. Flash and burn are separate channels that BOTH write the
// material's colour/emissive, so they have to be applied together (see toon.ts::applyCharTint) and are
// deduped as a PAIR: the common case (an idle character, called every frame) costs two compares.
function makeFlash(mats: FlashMaterial[]): { setHitFlash: (t: number) => void; setBurnGlow: (t: number) => void } {
  let lastFlash = -1;
  let lastBurn = -1;
  const apply = (): void => {
    const f = lastFlash > 0 ? (lastFlash > 1 ? 1 : lastFlash) : 0;
    const b = lastBurn > 0 ? (lastBurn > 1 ? 1 : lastBurn) : 0;
    applyCharTint(mats, f, b);
  };
  return {
    setHitFlash(t: number) {
      const c = t > 0 ? (t > 1 ? 1 : t) : 0;
      if (c === lastFlash) return;
      lastFlash = c;
      apply();
    },
    setBurnGlow(t: number) {
      const c = t > 0 ? (t > 1 ? 1 : t) : 0;
      if (c === lastBurn) return;
      lastBurn = c;
      apply();
    },
  };
}

async function getGLTFLoader(): Promise<any> {
  // @ts-ignore - vendored three addon, untyped
  const m = await import('../vendor/addons/loaders/GLTFLoader.js');
  return m.GLTFLoader;
}

function normalizeModel(scene: any, targetHeight = 2.0): void {
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene);
  const size = new THREE.Vector3();
  box.getSize(size);
  if (size.y <= 1e-4) return;
  const s = targetHeight / size.y;
  scene.scale.multiplyScalar(s);
  scene.updateMatrixWorld(true);
  const b2 = new THREE.Box3().setFromObject(scene);
  scene.position.x -= (b2.min.x + b2.max.x) / 2;
  scene.position.z -= (b2.min.z + b2.max.z) / 2;
  scene.position.y -= b2.min.y;
}

/**
 * Bone whose children are a character's held items, for packs that parent them there.
 */
const HAND_SLOT_PREFIX = 'handslot';

/**
 * Drop the meshes the character is HOLDING.
 *
 * WHY (two independent reasons, both real):
 *   1. THE GAME HAS NO WEAPON MODELS. `apps/shooter` gives characters no weapon mesh at all — the
 *      muzzle, the aim laser and the projectiles are the weapon, and the melee swing is a crescent
 *      in the air (see the README's 「没有武器模型（角色手里是空的）」). A character holding its own
 *      sword/gun contradicts every one of those effects: the swing crescent would come out of a
 *      blade that never moves, and the tracer would leave a barrel that never fires.
 *   2. IT WOULD ALSO BREAK PLACEMENT. A held item sticks out in front (measured on the previous
 *      pack: the Knight's bbox reached z = +2.00 with its sword, -0.58 without; the cyber-human's
 *      sword takes z from +0.24 to +1.06), and `normalizeModel` centres the model on its BOUNDING
 *      BOX. Centring a body-plus-weapon box pushes the body behind its own origin — i.e. the
 *      character visibly stands off-centre from its collision circle, its health bar and its shadow.
 *      So the strip has to run BEFORE normalize. `scripts/verify-characters.mjs` asserts exactly
 *      that, including the "what if we did NOT strip" counter-case.
 *
 * TWO RULES, on purpose:
 *   * the manifest's explicit `strip` name list (`CharacterDef.strip`) — the packs in use here are
 *     exported from Godot/Blender with the weapon as a SIBLING mesh (`Sword`, `Cylinder`), so there
 *     is no parent bone to key off;
 *   * plus "any mesh parented under a `handslot*` bone", which is how KayKit-style rigs mark held
 *     items and costs nothing to check. A pack that uses neither simply strips nothing.
 */
function stripHeldItems(scene: any, named: readonly string[]): number {
  const wanted = new Set(named);
  const doomed: any[] = [];
  scene.traverse((o: any) => {
    if (!o || !o.isMesh) return;
    if (wanted.has(o.name)) { doomed.push(o); return; }
    for (let p = o.parent; p; p = p.parent) {
      if (typeof p.name === 'string' && p.name.startsWith(HAND_SLOT_PREFIX)) { doomed.push(o); return; }
    }
  });
  for (const o of doomed) o.parent?.remove(o);
  return doomed.length;
}



// Capture the model's upper-body quaternion tracks from the shoot clip. Track names use
// GLTFLoader's sanitized bone names ('upperarml.quaternion'). We sample these each frame so the
// upper body does a dynamic shooting motion while the legs keep walking.
function captureUpperPose(clips: Map<string, any>, aimPose: string): Map<string, any> {
  const pose = new Map<string, any>();
  const clip = aimPose ? clips.get(aimPose) : undefined;
  if (!clip) return pose;
  for (const name of UPPER_BONES) {
    const track = clip.tracks.find((t: any) => t.name === name + '.quaternion')
      || clip.tracks.find((t: any) => t.name.startsWith(name) && t.name.endsWith('.quaternion'));
    if (track) pose.set(name, track);
  }
  return pose;
}

/**
 * Load a prop .glb and flatten it into ONE vertex-coloured geometry.
 *
 * WHY MERGE, AND WHY VERTEX COLOURS: a prop file can hold several meshes with their own flat
 * colours, and one InstancedMesh per MESH would multiply the draw calls (the kit has ~40 props),
 * while one material per prop would break the vision pass — that dims by writing `instanceColor`,
 * which is a per-INSTANCE knob, not a per-material one. Baking each mesh's base colour into a
 * `color` attribute and merging gives exactly one instanced pool per prop and keeps `instanceColor`
 * as the single dimming control. A toon material with `vertexColors: true` multiplies vertex colour
 * by instance colour, which is the same trick the slash/beam/cover code already relies on.
 *
 * Textures are dropped on purpose: the Kenney kit has none, and this app ships none. The merge is
 * done non-indexed so every part has identical attribute sets (mergeGeometries requires that), which
 * costs a few hundred duplicated vertices on props this size.
 */
export async function loadPropGeometry(file: string): Promise<any> {
  const GLTFLoader = await getGLTFLoader();
  // @ts-ignore - vendored three addon, untyped
  const { mergeGeometries } = await import('../vendor/addons/utils/BufferGeometryUtils.js');
  const loader = new GLTFLoader();
  const gltf: any = await loader.loadAsync('./assets/props/' + file + '.glb');
  // Theme override, if the catalog declares one for this prop (only the floor does). COLOUR SPACE:
  // a glTF baseColorFactor is LINEAR and GLTFLoader hands it over in the renderer's working space,
  // so the baked `color` attribute is linear. `Color.setHex` interprets its argument as sRGB and
  // converts — which is exactly right for a hex constant written the way every other colour in this
  // app is written, and keeps the override in the same space as the colours it replaces.
  const tint = propTintForFile(file);
  const tintColor = tint === null ? null : new THREE.Color(tint);
  const parts: any[] = [];
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o: any) => {
    if (!o.isMesh || !o.geometry) return;
    let g = o.geometry.clone();
    g.applyMatrix4(o.matrixWorld);
    if (g.index) g = g.toNonIndexed();
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    }
    if (!g.attributes.normal) g.computeVertexNormals();
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    const c = tintColor ?? ((mat && mat.color) ? mat.color : new THREE.Color(0xffffff));
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    parts.push(g);
  });
  if (parts.length === 0) throw new Error('prop has no mesh: ' + file);
  const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
  return normalizeProp(merged);
}

/**
 * Put a prop's ORIGIN at the centre of its footprint and the bottom of its bounding box, because
 * that is the convention every consumer already assumes — and the raw Kenney files do not follow it.
 *
 * WHY THIS IS NOT COSMETIC: a glTF model's origin is wherever the author put it. In this kit most
 * props keep it at a CORNER of the footprint (`floorFull` spans x 0..1, z -1..0; a sofa spans
 * x 0..0.98, z -0.41..0), and a few are authored sunk below y = 0 (the fridge's base is at -0.13).
 * props.ts places an instance by putting that origin on the target point and then proves, with the
 * catalog's measured size, that the prop fits inside its obstacle's collision box; nothing in the
 * chain recentred anything. Measured before this function existed: 89 of the 222 cover instances
 * hung out of the collision box they dress (worst 0.95 world units — a third of a character), and
 * because the same offset applied to every floor tile the tiled floor was shifted by a full 2 units,
 * leaving a 2-unit strip of bare dark ground along two walls. Both are exactly the "the picture
 * disagrees with the collision" failure this app treats as a bug, and both disappear here.
 *
 * The characters already had this step (`normalizeModel` above does the same for a rigged model);
 * this is the props' version of it, and it deliberately does NOT rescale: a prop's size is what the
 * catalog measured and what the placement math fits to.
 */
function normalizeProp(g: any): any {
  g.computeBoundingBox();
  const b = g.boundingBox;
  if (!b) return g;
  const [dx, dy, dz] = propNormalizeOffset(
    [b.min.x, b.min.y, b.min.z], [b.max.x, b.max.y, b.max.z],
  );
  g.translate(dx, dy, dz);
  g.computeBoundingBox();
  return g;
}

/**
 * Load every prop the arena plan needs. Returns file -> merged geometry (see loadPropGeometry).
 *
 * CONCURRENCY IS CAPPED (6 at a time): the room needs ~40 files, and firing 40 parallel fetches +
 * parses is what makes a mobile browser stall while the first frame is still being drawn. Six keeps
 * the pipe busy without flooding it.
 */
export async function loadPropGeometries(
  files: readonly string[], concurrency = 6,
): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  const queue = [...files];
  const worker = async (): Promise<void> => {
    for (;;) {
      const f = queue.shift();
      if (f === undefined) return;
      out.set(f, await loadPropGeometry(f));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return out;
}

/**
 * Load one character from the manifest: fetch the .glb, strip the meshes the manifest lists (plus
 * anything parented to a hand slot), normalize it to `targetHeight` standing on y = 0, give it the
 * toon material + outline, and capture the upper-body aiming pose from the manifest's `aimPose` clip.
 *
 * VALIDATION IS AT LOAD, NOT IN A TEST ONLY: every clip name the character's states can ask for is
 * checked against the clips that actually arrived, and a missing one is logged loudly here. `play()`
 * silently ignores an unknown name (by design — it must not throw mid-frame), so without this the
 * only symptom of a bad swap would be "that animation stopped playing" on a device.
 */
export async function loadCharTemplate(def: CharacterDef<any>): Promise<CharTemplate> {
  const GLTFLoader = await getGLTFLoader();
  // @ts-ignore - vendored three addon, untyped
  const mod = await import('../vendor/addons/utils/SkeletonUtils.js');
  const loader = new GLTFLoader();
  const url = './assets/models/' + def.file;
  return await new Promise((resolve, reject) => {
    loader.load(url, (gltf: any) => {
      const clips = new Map<string, any>();
      for (const c of (gltf.animations || [])) clips.set(c.name, c);
      const inner = gltf.scene;
      const wrapper = new THREE.Group();
      wrapper.add(inner);
      // BEFORE normalizeModel: a held sword/gun would otherwise be measured into the model's
      // bounding box and drag the body off its own origin (see stripHeldItems).
      const stripped = stripHeldItems(inner, def.strip);
      normalizeModel(inner, 2.0);
      toonify(inner);
      // Team tint BEFORE the flash snapshot: it becomes the material's resting colour, so the hit
      // flash / burn glow still restore exactly (see toon.ts::tintCharacter).
      if (def.tint) tintCharacter(inner, def.tint);
      const upperTracks = captureUpperPose(clips, def.aimPose);
      const missing = requiredClips(def).filter((n) => !clips.has(n));
      if (missing.length) {
        console.warn('[shooter] ' + def.file + ' is missing mapped clips: ' + missing.join(', ')
          + ' (those states will keep their previous animation)');
      }
      console.log('[shooter] character loaded: ' + def.file + ' (' + clips.size + ' clips, '
        + stripped + ' held items stripped, aim overlay ' + (upperTracks.size ? 'on' : 'off') + ')');
      resolve({ root: wrapper, clips, cloneFn: mod.clone, upperTracks });
    }, undefined, reject);
  });
}

export function spawnFromTemplate(t: CharTemplate): CharInstance {
  const root = t.cloneFn(t.root);
  // Order matters: clone per-instance materials BEFORE snapshotting (the snapshot must point
  // at this instance's own materials, not the shared template ones) and both BEFORE
  // addOutline (outline shells are unlit and must never be tinted).
  cloneInstanceMaterials(root);
  const tint = makeFlash(captureFlashMaterials(root));
  addOutline(root);
  setCastShadow(root);
  const mixer = new THREE.AnimationMixer(root);
  // ACTIONS ARE CREATED ON DEMAND, and this is a performance invariant, not a style choice.
  //
  // ⚠️ The model ships the WHOLE KayKit shared library: 95 clips x up to 123 tracks = 10,807 tracks
  // (measured in scripts/verify-spawn-cost.mjs). three's `AnimationAction` constructor eagerly builds
  // one `Interpolant` and one `PropertyBinding` PER TRACK, so calling `clipAction()` for every clip —
  // which is what this did — built ~21,600 objects per enemy to be able to play "Idle": 8.1 ms of
  // synchronous work and 1.79 MB RETAINED per spawn on the machine that test runs on (real-device
  // report: 「有时候会突然卡个半秒」, at the moment a wave spawns). The render loop can only ever play
  // 10 of the 95 clips (P_ANIM/E_ANIM), and `play()` below is the only place that knows which.
  //
  // `clipAction` caches per (clip, root), so a name only ever pays for itself once — the old eager
  // loop bought all 95 whether or not they were used.
  const actions = new Map<string, any>();
  const actionFor = (name: string): any => {
    const cached = actions.get(name);
    if (cached !== undefined) return cached;
    const clip = t.clips.get(name);
    if (!clip) return undefined;   // unknown name: same silent no-op as before (verify-spawn-cost asserts none are)
    const action = mixer.clipAction(clip);
    actions.set(name, action);
    return action;
  };
  let current = '';
  const upper: { bone: any; interp: any; dur: number }[] = [];
  for (const [name, track] of t.upperTracks) {
    const b = root.getObjectByName(name);
    if (b) {
      const times = track.times;
      upper.push({ bone: b, interp: track.createInterpolant(), dur: (times && times[times.length - 1]) || 1 });
    }
  }
  let upperClock = 0;
  const sample = new THREE.Quaternion();
  return {
    root, mixer, hasUpperBody: upper.length > 0,
    play(name, fade = 0.15, restart = false) {
      if (name === current && !restart) return;
      const next = actionFor(name);
      if (!next) return;
      const prev = current ? actions.get(current) : undefined;
      // `prev !== next` matters for the restart case: fading an action out and then rewinding and
      // fading the SAME action in would leave two competing weight fades on one action.
      if (prev && prev !== next) prev.fadeOut(fade);
      next.reset().fadeIn(fade).play();
      current = name;
    },
    update(dt) { if (mixer) mixer.update(dt); },
    setUpperBlend(w, dt) {
      if (!this.hasUpperBody || w <= 0.001) return;
      upperClock += dt;
      const t = Math.min(1, w);
      for (const it of upper) {
        try {
          sample.fromArray(it.interp.evaluate(upperClock % it.dur));
          it.bone.quaternion.slerp(sample, t);
        } catch (err) { /* keep the locomotion pose for this bone */ }
      }
    },
    setHitFlash: tint.setHitFlash,
    setBurnGlow: tint.setBurnGlow,
    /**
     * Hand the mixer's bindings back. Called by render.ts the moment a corpse's death animation is
     * over — see render.ts::releaseView for why an enemy view is never needed again (the sim never
     * removes an enemy from `enemies`, it only flips `alive`, and new enemies are always appended).
     *
     * `uncacheRoot` is the part that matters: it walks the root's property bindings, deactivates and
     * uncaches its actions, and drops the per-root binding cache — i.e. it is what makes the ~1.79 MB
     * this instance allocated collectable. Geometry/textures are NOT disposed here: they are SHARED
     * with the template (SkeletonUtils.clone and cloneInstanceMaterials share geometry and textures,
     * only the materials themselves are per-instance), so disposing them would break the next spawn.
     */
    dispose() {
      if (mixer) {
        mixer.stopAllAction();
        mixer.uncacheRoot(root);
      }
      actions.clear();
      if (root.parent) root.parent.remove(root);
    },
  };
}

export function spawnPrimitive(kind: 'player' | 'enemy', sprinter = false): CharInstance {
  if (kind === 'player') {
    const g = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.42, 0.7, 6, 12),
      createToonMaterial({ color: 0x40c4ff })
    );
    body.position.y = 0.75;
    g.add(body);
    const gun = new THREE.Mesh(
      new THREE.BoxGeometry(1.2, 0.16, 0.16),
      createToonMaterial({ color: 0x20303f })
    );
    gun.position.set(0.7, 0.7, 0);
    g.add(gun);
    const tint = makeFlash(captureFlashMaterials(g)); // before addOutline (unlit shells)
    addOutline(g);
    setCastShadow(g);
    return { root: g, mixer: null, hasUpperBody: false, play() {}, update() {}, setUpperBlend() {}, setHitFlash: tint.setHitFlash,
    setBurnGlow: tint.setBurnGlow, dispose() {} };
  }
  const g = new THREE.Group();
  const color = sprinter ? 0xff9800 : 0xff5a5a;
  const body = new THREE.Mesh(
    new THREE.ConeGeometry(0.5, 1.2, 8),
    createToonMaterial({ color })
  );
  body.position.y = 0.6;
  g.add(body);
  const tint = makeFlash(captureFlashMaterials(g));
  addOutline(g);
  setCastShadow(g);
  return { root: g, mixer: null, hasUpperBody: false, play() {}, update() {}, setUpperBlend() {}, setHitFlash: tint.setHitFlash,
    setBurnGlow: tint.setBurnGlow, dispose() {} };
}
