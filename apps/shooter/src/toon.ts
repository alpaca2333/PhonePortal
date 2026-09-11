// Stylized cartoon rendering: a shared toon gradient map + material conversion, and
// inverted-hull outlines for characters. Kept separate so game.ts stays pure (no three import).
//
// This module is ALSO the single place allowed to construct a lit material (createToonMaterial) and
// the single place that patches one (registerWorldLook = height fog + tone grade, in that order), for
// the same reason it owns the gradient map:
// a material look is only consistent if there is one function that applies it. verify-fog.mjs asserts
// that `new THREE.MeshToonMaterial` appears nowhere else in the app.
import * as THREE from 'three';
import {
  FOG_BASE_Y, FOG_COLOR, FOG_HEIGHT_FALLOFF, FOG_MAX_OPACITY, clampFogDensity,
  patchHeightFogVertexShader,
} from './fog.js';
import {
  GRADE_CONTRAST, GRADE_HIGHLIGHT_TINT, GRADE_PIVOT, GRADE_SATURATION, GRADE_SHADOW_TINT,
  GRADE_STRENGTH_DEFAULT, GRADE_TINT_HI, GRADE_TINT_LO, clampGradeStrength,
} from './grade.js';
// The fragment-side composition (declarations + encode + fog + grade + decode) lives there and ONLY
// there: this module must not know the order, or the ordering bug below comes back.
import { patchWorldLookFragmentShader } from './worldlook.js';

// Tunable outline look. Width is in the model's local (normalized) space: characters are
// normalized to 2.0 units tall, so 0.07 ~ 3.5% of height (~2px on a phone screen).
export const OUTLINE_COLOR = 0x07090e;
export const OUTLINE_WIDTH = 0.07;

let sharedGradientMap: any = null;

// 4-step luminance ramp: fully-shadowed -> fully-lit (left -> right). Sampled by
// MeshToonMaterial's USE_GRADIENTMAP path (wiring verified against the vendored three build).
// NearestFilter keeps the bands crisp instead of interpolating between steps.
export function getToonGradientMap(): any {
  if (!sharedGradientMap) {
    const steps = 4;
    const ramp = [0.32, 0.55, 0.75, 0.95];
    const data = new Uint8Array(steps * 4);
    for (let i = 0; i < steps; i++) {
      const v = Math.round(ramp[i] * 255);
      data[i * 4] = v;
      data[i * 4 + 1] = v;
      data[i * 4 + 2] = v;
      data[i * 4 + 3] = 255;
    }
    sharedGradientMap = new THREE.DataTexture(data, steps, 1, THREE.RGBAFormat);
    sharedGradientMap.minFilter = THREE.NearestFilter;
    sharedGradientMap.magFilter = THREE.NearestFilter;
    sharedGradientMap.generateMipmaps = false;
    sharedGradientMap.needsUpdate = true;
  }
  return sharedGradientMap;
}

// ---------------------------------------------------------------------------
// height fog (see fog.ts for the model and for why this is a shader patch)
// ---------------------------------------------------------------------------

/**
 * The shared uniforms. ONE object per uniform for the whole scene, so `setHeightFogDensity()` is a
 * single assignment no matter how many materials exist, and so a material created later (a new enemy
 * wave) automatically follows the current setting instead of freezing whatever it was at boot.
 *
 * uFogColor is built from the raw hex BYTES, not from a THREE.Color: the mix runs in DISPLAY space
 * (inside worldlook.ts's explicit encode/decode wrap, on both render paths), which is the opposite of
 * every other colour in this codebase — `new THREE.Color(0x25303d)` would be linearised and come out
 * visibly paler than the constant says. See the headers of fog.ts and worldlook.ts.
 */
const GRADE_UNIFORMS = {
  uGradeStrength: { value: GRADE_STRENGTH_DEFAULT },
  uGradeShadowTint: { value: new THREE.Vector3(...GRADE_SHADOW_TINT) },
  uGradeHighlightTint: { value: new THREE.Vector3(...GRADE_HIGHLIGHT_TINT) },
  uGradeTintLo: { value: GRADE_TINT_LO },
  uGradeTintHi: { value: GRADE_TINT_HI },
  uGradeContrast: { value: GRADE_CONTRAST },
  uGradePivot: { value: GRADE_PIVOT },
  uGradeSaturation: { value: GRADE_SATURATION },
};

const FOG_UNIFORMS = {
  uFogDensity: { value: 0 },
  uFogHeightFalloff: { value: FOG_HEIGHT_FALLOFF },
  uFogBaseY: { value: FOG_BASE_Y },
  uFogMaxOpacity: { value: FOG_MAX_OPACITY },
  uFogColor: {
    value: new THREE.Vector3(
      ((FOG_COLOR >> 16) & 0xff) / 255,
      ((FOG_COLOR >> 8) & 0xff) / 255,
      (FOG_COLOR & 0xff) / 255,
    ),
  },
};

/**
 * Patch a shader object in place (`onBeforeCompile`). ALL-OR-NOTHING on purpose: if either anchor is
 * missing we change nothing at all. A half patch (fragment body without the vertex-declared varyings)
 * would not compile, and "the whole game stops rendering because a three.js chunk got renamed" is not
 * an acceptable failure mode for a cosmetic effect — the acceptable one is "the fog quietly does not
 * appear". The anchors are asserted against the vendored build in scripts/verify-fog.mjs.
 *
 * The fragment side is composed by worldlook.ts::patchWorldLookFragmentShader — the ORDER of the
 * injected blocks is written down there and nowhere else, because leaving it to two chained
 * `String.replace` calls produced the wrong order once (each patch inserts AFTER its anchor, so the
 * patch applied last ends up first). This function only decides whether to apply anything at all.
 */
function applyWorldLookShader(shader: any): void {
  const vs = patchHeightFogVertexShader(String(shader.vertexShader));
  const frag = patchWorldLookFragmentShader(String(shader.fragmentShader));
  if (!vs.ok || !frag.ok) return;                 // all-or-nothing
  shader.vertexShader = vs.src;
  shader.fragmentShader = frag.src;
  shader.uniforms.uFogDensity = FOG_UNIFORMS.uFogDensity;
  shader.uniforms.uFogHeightFalloff = FOG_UNIFORMS.uFogHeightFalloff;
  shader.uniforms.uFogBaseY = FOG_UNIFORMS.uFogBaseY;
  shader.uniforms.uFogMaxOpacity = FOG_UNIFORMS.uFogMaxOpacity;
  shader.uniforms.uFogColor = FOG_UNIFORMS.uFogColor;
  shader.uniforms.uGradeStrength = GRADE_UNIFORMS.uGradeStrength;
  shader.uniforms.uGradeShadowTint = GRADE_UNIFORMS.uGradeShadowTint;
  shader.uniforms.uGradeHighlightTint = GRADE_UNIFORMS.uGradeHighlightTint;
  shader.uniforms.uGradeTintLo = GRADE_UNIFORMS.uGradeTintLo;
  shader.uniforms.uGradeTintHi = GRADE_UNIFORMS.uGradeTintHi;
  shader.uniforms.uGradeContrast = GRADE_UNIFORMS.uGradeContrast;
  shader.uniforms.uGradePivot = GRADE_UNIFORMS.uGradePivot;
  shader.uniforms.uGradeSaturation = GRADE_UNIFORMS.uGradeSaturation;
}

/**
 * Register the height-fog patch on a lit material. Chains onto any existing `onBeforeCompile` (the
 * outline hull has one) and onto any existing `customProgramCacheKey`, because two different patches
 * must never share a compiled program.
 */
export function registerWorldLook(material: any): any {
  if (!material || material.userData.__worldLook) return material;
  material.userData.__worldLook = true;
  const prevCompile = material.onBeforeCompile;
  material.onBeforeCompile = function (shader: any, renderer: any): void {
    if (prevCompile) prevCompile.call(this, shader, renderer);
    applyWorldLookShader(shader);
  };
  const prevKey = material.customProgramCacheKey;
  material.customProgramCacheKey = function (): string {
    return (prevKey ? prevKey.call(this) : '') + '|world-look';
  };
  return material;
}

/** The 「高度雾」 setting. 0 = off (the mix becomes a no-op), which is why no recompile is needed. */
export function setHeightFogDensity(density: number): void {
  FOG_UNIFORMS.uFogDensity.value = clampFogDensity(density);
}

/** The current density, for assertions/debugging (the sim never reads it). */
export function heightFogDensity(): number {
  return FOG_UNIFORMS.uFogDensity.value;
}

/**
 * The 「调性」 setting: the split-tone/contrast/saturation grade (see grade.ts). Same contract as the
 * fog — one shared uniform, no recompile, and 0 blends to exactly the ungraded image.
 */
export function setGradeStrength(strength: number): void {
  GRADE_UNIFORMS.uGradeStrength.value = clampGradeStrength(strength);
}

/** The current grade strength, for assertions/debugging. */
export function gradeStrength(): number {
  return GRADE_UNIFORMS.uGradeStrength.value;
}

/**
 * EVERY lit material in the app must come from here. It applies the toon ramp and the height fog, so
 * a new prop/character/ground cannot be added "toon but unfogged" by forgetting a second call.
 * (Unlit effect materials — bullets, particles, bars, the vision overlay, outlines — deliberately do
 * NOT use this: they opt out of fog, see render.ts.)
 */
export function createToonMaterial(params: any): any {
  const m = new THREE.MeshToonMaterial({ gradientMap: getToonGradientMap(), ...params });
  registerWorldLook(m);
  return m;
}

function toonMaterial(m: any, obj: any, gm: any): any {
  if (!m) return m;
  if (m.isMeshToonMaterial) return m;
  // Only re-shade lit PBR materials; leave unlit accents (bullets/particles/outline) alone.
  if (!(m.isMeshStandardMaterial || m.isMeshPhongMaterial ||
        m.isMeshLambertMaterial || m.isMeshPhysicalMaterial)) {
    return m;
  }
  const t = createToonMaterial({
    color: m.color ? m.color.clone() : new THREE.Color(0xffffff),
    map: m.map || null,
    gradientMap: gm,
  });
  if (m.emissive) t.emissive = m.emissive.clone();
  if (m.emissiveMap) t.emissiveMap = m.emissiveMap;
  if (m.emissiveIntensity !== undefined) t.emissiveIntensity = m.emissiveIntensity;
  if (m.normalMap) t.normalMap = m.normalMap;
  if (m.normalScale) t.normalScale = m.normalScale.clone();
  if (m.alphaMap) t.alphaMap = m.alphaMap;
  if (m.alphaTest !== undefined) t.alphaTest = m.alphaTest;
  if (m.transparent) t.transparent = true;
  if (m.opacity !== undefined) t.opacity = m.opacity;
  if (m.side !== undefined) t.side = m.side;
  if (m.vertexColors) t.vertexColors = true;
  if (m.skinning || obj.isSkinnedMesh) t.skinning = true;
  if (m.morphTargets) t.morphTargets = true;
  if (m.morphNormals) t.morphNormals = true;
  if (m.depthWrite === false) t.depthWrite = false;
  if (m.depthTest === false) t.depthTest = false;
  return t;
}

// Convert every lit material under root to MeshToonMaterial (sharing one gradient map).
// Called on the GLB template so every cloned instance inherits the same toon look.
export function toonify(root: any): number {
  const gm = getToonGradientMap();
  let count = 0;
  root.traverse((obj: any) => {
    if (!obj || !obj.isMesh) return;
    const arr = Array.isArray(obj.material) ? obj.material : [obj.material];
    const wasArray = Array.isArray(obj.material);
    const out = arr.map((m: any) => toonMaterial(m, obj, gm));
    obj.material = wasArray ? out : out[0];
    count++;
  });
  return count;
}

// Mark character meshes as shadow casters; skip the inverted-hull outline shells
// (they sit just outside the body and would cast a false double shadow).
export function setCastShadow(root: any, cast = true): void {
  root.traverse((obj: any) => {
    if (obj && obj.isMesh && !obj.userData.__outline) obj.castShadow = cast;
  });
}

// --- per-instance hit flash --------------------------------------------------
// IMPORTANT: SkeletonUtils.clone() shares material objects BY REFERENCE between instances,
// so tinting a material would flash every enemy at once. cloneInstanceMaterials() must run
// first to give each instance its own copies.
// The flash/burn tint MATH lives in chartint.ts (pure, so verify-burn can assert it in Node); this
// module only applies the result to three's Colour objects.
import {
  BURN_GLOW_COLOR, HIT_FLASH_COLOR, charTint,
} from './chartint.js';
import type { RGB } from './chartint.js';

export interface FlashMaterial { mat: any; baseColor: any; baseEmissive: any; }

/** Scratch RGB triples for the tint call (the frame loop must not allocate). */
const _tintBase: RGB = [0, 0, 0];
const _tintEmissive: RGB = [0, 0, 0];

/**
 * Give every mesh under root its OWN material copy (GLB clones otherwise share by reference).
 *
 * ⚠️ TRAP (asserted against the vendored three in verify-fog.mjs): `Material.clone()` does NOT copy
 * an instance-level `onBeforeCompile` — it only copies data properties — while it DOES deep-copy
 * `userData`. So a clone arrives *marked* as world-look patched and with no patch at all, and the
 * guard in registerWorldLook would then refuse to re-add it: every cloned character would silently
 * render ungraded/unfogged while the room around it is not. Hence the reset + re-register below.
 */
export function cloneInstanceMaterials(root: any): void {
  const own = (m: any): any => {
    if (!m || !m.clone) return m;
    const c = m.clone();
    if (m.userData && m.userData.__worldLook) {
      delete c.userData.__worldLook;
      registerWorldLook(c);
    }
    return c;
  };
  root.traverse((obj: any) => {
    if (!obj || !obj.isMesh || obj.userData.__outline) return;
    const isArr = Array.isArray(obj.material);
    const arr = isArr ? obj.material : [obj.material];
    obj.material = isArr ? arr.map(own) : own(arr[0]);
  });
}

/** Snapshot each lit material's base colour/emissive so the flash can be applied and undone. */
export function captureFlashMaterials(root: any): FlashMaterial[] {
  const out: FlashMaterial[] = [];
  root.traverse((obj: any) => {
    if (!obj || !obj.isMesh || obj.userData.__outline) return;
    const arr = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of arr) {
      if (!m || !m.isMeshToonMaterial) continue; // skip unlit outline shells / accents
      out.push({ mat: m, baseColor: m.color.clone(), baseEmissive: m.emissive.clone() });
    }
  });
  return out;
}

/** t = 1 fully red, 0 = untouched. The caller skips unchanged values. */
export function applyHitFlash(mats: FlashMaterial[], t: number): void {
  applyCharTint(mats, t, 0);
}

/**
 * Apply the hit flash AND the burn glow in one pass. Both write `color` + `emissive`, so there has to
 * be exactly one writer — see chartint.ts for why the burn glow exists (a burning enemy used to read as
 * a bright fire ring around a black silhouette, because nothing lit its body).
 */
export function applyCharTint(mats: FlashMaterial[], flashT: number, burnT: number): void {
  if (flashT <= 0 && burnT <= 0) {
    // The common case (nothing happening to this character): restore the base exactly, which also
    // undoes whatever the last frame applied. Cheap enough to do unconditionally.
    for (const f of mats) {
      f.mat.color.copy(f.baseColor);
      f.mat.emissive.copy(f.baseEmissive);
    }
    return;
  }
  for (const f of mats) {
    _tintBase[0] = f.baseColor.r; _tintBase[1] = f.baseColor.g; _tintBase[2] = f.baseColor.b;
    _tintEmissive[0] = f.baseEmissive.r; _tintEmissive[1] = f.baseEmissive.g; _tintEmissive[2] = f.baseEmissive.b;
    const out = charTint(_tintBase, _tintEmissive, flashT, burnT);
    f.mat.color.setRGB(out.color[0], out.color[1], out.color[2]);
    f.mat.emissive.setRGB(out.emissive[0], out.emissive[1], out.emissive[2]);
  }
}

/** Exported for the docs/tests: the burn glow's colour, as authored. */
export const BURN_GLOW_HEX = BURN_GLOW_COLOR;

// Inverted-hull outline: for each Mesh/SkinnedMesh add a sibling that renders only its BACK
// faces with vertices pushed outward along the normal. Skinned outlines share the character's
// skeleton so the outline follows the animation; static meshes offset along the geometry
// normal attribute (the skinned objectNormal is only declared under USE_SKINNING).
/**
 * A hull offset is applied in the MESH's local space (the shader pushes `transformed` before
 * `project_vertex`), so the world-space thickness is `width x the mesh's world scale`. For a model
 * whose nodes carry a 100x export scale that is a 100x-too-thick outline — a black shell 20 units
 * across around a 2-unit character, which is what a real device screenshot showed as a
 * 「巨大的黑球」 (see the README's character section). This converts the intended WORLD width into
 * the local value the shader needs. Exported so the Node test can assert the contract.
 */
export function outlineLocalWidth(worldScale: number, width: number = OUTLINE_WIDTH): number {
  const s = Math.abs(worldScale);
  return width / (s > 1e-6 ? s : 1e-6);
}

/**
 * Multiply every LIT material's base colour by `tint` (per channel). Used to tell two characters that
 * share one model apart (see characters.ts). Runs BEFORE any flash/burn snapshot, so the tint becomes
 * the material's resting colour and `applyCharTint` restores it exactly.
 *
 * Outline shells are skipped on purpose: they are unlit and must stay near-black whatever the team.
 */
export function tintCharacter(root: any, tint: readonly [number, number, number]): number {
  let count = 0;
  root.traverse((obj: any) => {
    if (!obj || !obj.isMesh || obj.userData.__outline) return;
    const arr = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of arr) {
      if (!m || !m.isMeshToonMaterial || !m.color) continue;
      m.color.setRGB(m.color.r * tint[0], m.color.g * tint[1], m.color.b * tint[2]);
      count++;
    }
  });
  return count;
}

export function addOutline(root: any, opts?: { color?: number; width?: number }): number {
  const color = (opts && opts.color !== undefined) ? opts.color : OUTLINE_COLOR;
  const width = (opts && opts.width !== undefined) ? opts.width : OUTLINE_WIDTH;
  // `getWorldScale` needs current matrices, and this runs on a freshly cloned root that may never
  // have been rendered — an explicit update is what makes the scale below trustworthy.
  root.updateMatrixWorld(true);
  const _ws = new THREE.Vector3();
  let count = 0;
  root.traverse((obj: any) => {
    if (!obj || !obj.isMesh || obj.userData.__outline) return;
    const skinned = !!obj.isSkinnedMesh;
    const mat = new THREE.MeshBasicMaterial({ color, side: THREE.BackSide });
    obj.getWorldScale(_ws);
    // one value for the whole mesh (a non-uniform export scale is not worth three widths for)
    const localWidth = outlineLocalWidth((_ws.x + _ws.y + _ws.z) / 3, width);
    // Kept on the material so the Node test can read the value the shader actually got (a test that
    // recomputed it could pass while the wiring was wrong).
    mat.userData.__outlineWidth = localWidth;
    if (skinned) mat.skinning = true;
    // objectNormal (skinned normal) only exists when USE_SKINNING is set; static meshes use
    // the normal attribute, which is always declared in three's vertex prefix.
    const nrm = skinned ? 'objectNormal' : 'normal';
    mat.onBeforeCompile = (shader: any) => {
      shader.uniforms.outlineWidth = { value: localWidth };
      shader.vertexShader = 'uniform float outlineWidth;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <project_vertex>',
        'transformed += normalize( ' + nrm + ' ) * outlineWidth;\n#include <project_vertex>'
      );
    };
    // Skinned vs static outline shaders differ, so they must not share a cached program.
    mat.customProgramCacheKey = () => (skinned ? 'toon-outline-skinned' : 'toon-outline-static');
    const outline = skinned
      ? new THREE.SkinnedMesh(obj.geometry, mat)
      : new THREE.Mesh(obj.geometry, mat);
    if (skinned) {
      outline.bind(obj.skeleton, obj.bindMatrix);
      if (obj.bindMode !== undefined) outline.bindMode = obj.bindMode;
    }
    outline.position.copy(obj.position);
    outline.quaternion.copy(obj.quaternion);
    outline.scale.copy(obj.scale);
    outline.frustumCulled = false;
    outline.renderOrder = -1;
    outline.userData.__outline = true;
    obj.parent.add(outline);
    count++;
  });
  return count;
}
