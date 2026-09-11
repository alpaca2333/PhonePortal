// Shooter settings schema: pure data + pure functions (no DOM, no fetch), so the merge/clamp
// rules are testable in Node (scripts/verify-stick.mjs).
//
// The server stores an opaque JSON object per scope; THIS module owns the schema. Stored values
// are SPARSE OVERRIDES: a key that was never touched is absent and keeps following the built-in
// default, which is computed from the live viewport (that is how the landscape stick default keeps
// tracking `min(96px, 18vh)` instead of being frozen at the size of one phone).
//
// Six groups, each stored per orientation (`shooter.<group>.<portrait|landscape>`):
//   - `stick`  → 操控: the joystick size/position (geometry math lives in ./stick.ts)
//   - `camera` → 画面: the camera height multiplier AND horizontal angle (./camera.ts)
//   - `vision` → 视野: the occlusion darkness (the overlay lives in ./vision.ts)
//   - `light`  → 光照: the ambient + directional multipliers (the lights live in ./lighting.ts)
//   - `fog`    → 雾:   the height-fog density (the fog lives in ./fog.ts)
//   - `look`   → 后期: the tone grade + vignette + pixelation (./grade.ts, ./vignette.ts, ./postfx.ts)
// Every group uses the same sparse-override shape, and the two orientations are independent, so
// rotating the phone switches to the other direction's values instead of overwriting them.
import {
  CAMERA_SCALE_DEFAULT, CAMERA_SCALE_MAX, CAMERA_SCALE_MIN, CAMERA_SCALE_STEP,
  CAMERA_YAW_DEFAULT, CAMERA_YAW_MAX, CAMERA_YAW_MIN, CAMERA_YAW_STEP, clampCameraScale,
  clampCameraYaw,
} from './camera.js';
// Same pattern as camera.ts: the vision module owns the darkness numbers, so the slider range, the
// built-in default and the clamp can never drift from what the overlay actually does.
import {
  VISION_DIM_DEFAULT, VISION_DIM_MAX, VISION_DIM_MIN, VISION_DIM_STEP, clampVisionDim,
} from './vision.js';
// ...and the lighting module owns the ambient-light numbers for the same reason: the slider IS the
// renderer's clamp (see lighting.ts, which also explains why only the hemisphere light counts).
// ...and grade.ts / vignette.ts own the tone numbers (both pure: the GLSL string is data there).
import {
  GRADE_STRENGTH_DEFAULT, GRADE_STRENGTH_MAX, GRADE_STRENGTH_MIN, GRADE_STRENGTH_STEP,
  clampGradeStrength,
} from './grade.js';
import {
  VIGNETTE_STRENGTH_DEFAULT, VIGNETTE_STRENGTH_MAX, VIGNETTE_STRENGTH_MIN, VIGNETTE_STRENGTH_STEP,
  clampVignetteStrength,
} from './vignette.js';
// ...and postfx.ts owns the pixelation block size / target maths.
import {
  PIXEL_BLOCK_DEFAULT, PIXEL_BLOCK_MAX, PIXEL_BLOCK_MIN, PIXEL_BLOCK_STEP, clampPixelBlock,
} from './postfx.js';
// ...and fog.ts owns the height-fog numbers (it is pure too: the GLSL text is data there).
import {
  FOG_DENSITY_DEFAULT, FOG_DENSITY_MAX, FOG_DENSITY_MIN, FOG_DENSITY_STEP, clampFogDensity,
} from './fog.js';
import {
  AMBIENT_SCALE_DEFAULT, AMBIENT_SCALE_MAX, AMBIENT_SCALE_MIN, AMBIENT_SCALE_STEP,
  DIRECTIONAL_SCALE_DEFAULT, DIRECTIONAL_SCALE_MAX, DIRECTIONAL_SCALE_MIN, DIRECTIONAL_SCALE_STEP,
  clampAmbientScale, clampDirectionalScale,
} from './lighting.js';

export type Orientation = 'portrait' | 'landscape';
export const ORIENTATIONS: readonly Orientation[] = ['portrait', 'landscape'];

export interface StickLayout {
  /** Stick diameter in px. */
  sizePx: number;
  /** Left stick: distance from the left edge / from the bottom edge. */
  leftX: number; leftY: number;
  /** Right stick: distance from the right edge / from the bottom edge. */
  rightX: number; rightY: number;
}

/** Group name in the stored scope for the 操控 settings. */
export const STICK_GROUP = 'stick';
/** Group name in the stored scope for the 画面 settings. */
export const CAMERA_GROUP = 'camera';

export const STICK_KEYS = ['sizePx', 'leftX', 'leftY', 'rightX', 'rightY'] as const;
export type StickKey = (typeof STICK_KEYS)[number];

export const LIMITS: Record<StickKey, { min: number; max: number; step: number }> = {
  sizePx: { min: 48, max: 240, step: 2 },
  leftX: { min: 0, max: 160, step: 1 },
  leftY: { min: 0, max: 160, step: 1 },
  rightX: { min: 0, max: 160, step: 1 },
  rightY: { min: 0, max: 160, step: 1 },
};

/** The whole scope value as stored on the server. Unknown keys are preserved verbatim on save. */
export type RawSettings = Record<string, unknown>;

export interface Viewport { width: number; height: number; }

export function orientationOf(width: number, height: number): Orientation {
  return width > height ? 'landscape' : 'portrait';
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * Built-in defaults. Portrait reproduces the previously hardcoded CSS exactly (148px, 26px
 * insets). Landscape reproduces the old `min(112px, 21vh)` / 8px formula scaled down ~14% after
 * real-device feedback that the landscape UI still felt too large: `min(96px, 18vh)` (400px tall
 * viewport -> 72px) with 8px insets. It stays viewport-relative, so short viewports shrink too.
 */
export function defaultsFor(o: Orientation, vp: Viewport): StickLayout {
  if (o === 'landscape') {
    return { sizePx: Math.round(Math.min(96, 0.18 * vp.height)), leftX: 8, leftY: 8, rightX: 8, rightY: 8 };
  }
  return { sizePx: 148, leftX: 26, leftY: 26, rightX: 26, rightY: 26 };
}

/** Keep a layout on screen and inside the slider ranges (also used for hand-edited files). */
export function clampLayout(layout: StickLayout, vp: Viewport): StickLayout {
  // 0.5 * viewport height keeps one stick from covering the whole screen in landscape; the
  // Math.max guards absurdly short viewports where the cap would fall below the minimum.
  const maxSize = Math.max(LIMITS.sizePx.min, Math.min(LIMITS.sizePx.max, vp.height * 0.5));
  const sizePx = Math.round(clamp(layout.sizePx, LIMITS.sizePx.min, maxSize));
  const maxX = Math.min(LIMITS.leftX.max, Math.max(0, vp.width - sizePx));
  const maxY = Math.min(LIMITS.leftY.max, Math.max(0, vp.height - sizePx));
  return {
    sizePx,
    leftX: Math.round(clamp(layout.leftX, 0, maxX)),
    rightX: Math.round(clamp(layout.rightX, 0, maxX)),
    leftY: Math.round(clamp(layout.leftY, 0, maxY)),
    rightY: Math.round(clamp(layout.rightY, 0, maxY)),
  };
}

/** Accept whatever the server holds (or a hand-edited file) and return a safe raw object. */
export function createState(raw: unknown): RawSettings {
  return isPlainObject(raw) ? raw : {};
}

/** Sparse stick overrides for one orientation. Anything non-numeric is ignored. */
export function readOverrides(raw: RawSettings, o: Orientation): Partial<StickLayout> {
  const stick = raw[STICK_GROUP];
  if (!isPlainObject(stick)) return {};
  const src = stick[o];
  if (!isPlainObject(src)) return {};
  const out: Partial<StickLayout> = {};
  for (const k of STICK_KEYS) {
    const v = src[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/** Set one stick override in place, creating the nested objects as needed. */
export function writeOverride(raw: RawSettings, o: Orientation, key: StickKey, value: number): void {
  if (!isPlainObject(raw[STICK_GROUP])) raw[STICK_GROUP] = {};
  const stick = raw[STICK_GROUP] as Record<string, unknown>;
  if (!isPlainObject(stick[o])) stick[o] = {};
  (stick[o] as Record<string, unknown>)[key] = value;
}

/** Drop every stick override for one orientation, cleaning up empty containers (「恢复默认」). */
export function clearStickOverrides(raw: RawSettings, o: Orientation): void {
  if (!isPlainObject(raw[STICK_GROUP])) return;
  const stick = raw[STICK_GROUP] as Record<string, unknown>;
  delete stick[o];
  if (Object.keys(stick).length === 0) delete raw[STICK_GROUP];
}

/** Defaults merged with the sparse stick overrides, then clamped to the current viewport. */
export function effectiveFor(raw: RawSettings, o: Orientation, vp: Viewport): StickLayout {
  const base = defaultsFor(o, vp);
  const over = readOverrides(raw, o);
  for (const k of STICK_KEYS) {
    const v = over[k];
    if (v !== undefined) base[k] = v;
  }
  return clampLayout(base, vp);
}

/** Convenience for callers that already have a viewport: is any stick key overridden for `o`? */
export function hasStickOverrides(raw: RawSettings, o: Orientation): boolean {
  return Object.keys(readOverrides(raw, o)).length > 0;
}

// ---------------------------------------------------------------------------
// 画面 group: camera height + camera horizontal angle (yaw)
// ---------------------------------------------------------------------------
// Two keys, both pure geometry owned by ./camera.ts:
//   * `heightScale` — the height multiplier (height = CAM_H * scale, and the back offset scales with
//     it above the reference so the tilt stays oblique).
//   * `yaw`         — the horizontal angle in degrees: the camera ORBITS the player around +Y without
//     touching the pitch or the distance. 0 = the pose that shipped, so an upgrade changes nothing;
//     the sign convention (positive = the camera moves to the player's +X side) and the fact that the
//     sticks follow the rotation are documented in camera.ts.
// Unlike the stick these do not depend on the viewport, so no Viewport parameter is needed; the
// viewport-height dolly (CAM_REF_H) is a separate, non-configurable constant in render.ts.
export interface CameraSettings {
  /** Multiplier on CAM_H. 1 = the reference framing the renderer used to hardcode; above 1 the
   * camera also backs off, so the 58 degree tilt is preserved. */
  heightScale: number;
  /** Horizontal angle in degrees (see camera.ts::cameraEye); 0 = the shipped pose. */
  yaw: number;
}

export const CAMERA_KEYS = ['heightScale', 'yaw'] as const;
export type CameraKey = (typeof CAMERA_KEYS)[number];

/** Slider range/step, sourced from camera.ts so the UI and the geometry can never drift apart. */
export const CAMERA_LIMITS: Record<CameraKey, { min: number; max: number; step: number }> = {
  heightScale: { min: CAMERA_SCALE_MIN, max: CAMERA_SCALE_MAX, step: CAMERA_SCALE_STEP },
  yaw: { min: CAMERA_YAW_MIN, max: CAMERA_YAW_MAX, step: CAMERA_YAW_STEP },
};

/** Built-in camera defaults. Both orientations use 1 / 0 (the reference framing) — giving landscape a
 *  different default would change the framing on upgrade for no reason. */
export function cameraDefaultsFor(_o: Orientation): CameraSettings {
  return { heightScale: CAMERA_SCALE_DEFAULT, yaw: CAMERA_YAW_DEFAULT };
}

/** Sparse camera overrides for one orientation. Non-finite values are ignored, not clamped. */
export function readCameraOverrides(raw: RawSettings, o: Orientation): Partial<CameraSettings> {
  const cam = raw[CAMERA_GROUP];
  if (!isPlainObject(cam)) return {};
  const src = cam[o];
  if (!isPlainObject(src)) return {};
  const out: Partial<CameraSettings> = {};
  for (const k of CAMERA_KEYS) {
    const v = src[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/** Set one camera override in place, creating the nested objects as needed. */
export function writeCameraOverride(raw: RawSettings, o: Orientation, key: CameraKey, value: number): void {
  if (!isPlainObject(raw[CAMERA_GROUP])) raw[CAMERA_GROUP] = {};
  const cam = raw[CAMERA_GROUP] as Record<string, unknown>;
  if (!isPlainObject(cam[o])) cam[o] = {};
  (cam[o] as Record<string, unknown>)[key] = value;
}

/** Drop every camera override for one orientation, cleaning up empty containers. */
export function clearCameraOverrides(raw: RawSettings, o: Orientation): void {
  if (!isPlainObject(raw[CAMERA_GROUP])) return;
  const cam = raw[CAMERA_GROUP] as Record<string, unknown>;
  delete cam[o];
  if (Object.keys(cam).length === 0) delete raw[CAMERA_GROUP];
}

/** Defaults merged with the sparse camera overrides, then clamped to the slider range. */
export function effectiveCamera(raw: RawSettings, o: Orientation): CameraSettings {
  const base = cameraDefaultsFor(o);
  const over = readCameraOverrides(raw, o);
  if (over.heightScale !== undefined) base.heightScale = over.heightScale;
  if (over.yaw !== undefined) base.yaw = over.yaw;
  return { heightScale: clampCameraScale(base.heightScale), yaw: clampCameraYaw(base.yaw) };
}

/** Is the camera overridden for `o`? (drives the 画面 group's 「恢复默认」 enabled state) */
export function hasCameraOverrides(raw: RawSettings, o: Orientation): boolean {
  return Object.keys(readCameraOverrides(raw, o)).length > 0;
}

// ---------------------------------------------------------------------------
// 视野 group: how dark the region the player cannot see is drawn
// ---------------------------------------------------------------------------
// One key — the opacity of the darkness laid over everything cover hides (vision.ts owns the
// geometry, render.ts owns the overlay). 0 is not a cosmetic endpoint: it is the OFF switch, since
// render.ts then hides the overlay, skips every visibility query and puts cover back on its
// palette, i.e. exactly the rendering that shipped before the vision system existed.
//
// PER ORIENTATION LIKE EVERY OTHER GROUP, even though darkness is not orientation-dependent: the
// storage path is `scope.<group>.<orientation>.<key>` for every group, and special-casing one of
// them would put a branch in the panel's apply/merge path for no user-visible gain. Recorded as a
// known quirk in apps/shooter/README.md.
export interface VisionSettings {
  /** Darkness opacity over the occluded region; 0 turns the whole feature off. */
  dim: number;
}

export const VISION_GROUP = 'vision';
export const VISION_KEYS = ['dim'] as const;
export type VisionKey = (typeof VISION_KEYS)[number];

/** Slider range/step, sourced from vision.ts so the UI and the renderer cannot drift apart. */
export const VISION_LIMITS: Record<VisionKey, { min: number; max: number; step: number }> = {
  dim: { min: VISION_DIM_MIN, max: VISION_DIM_MAX, step: VISION_DIM_STEP },
};

/** Built-in vision defaults: the shipped look, applied the first time the game loads. */
export function visionDefaultsFor(_o: Orientation): VisionSettings {
  return { dim: VISION_DIM_DEFAULT };
}

/** Sparse vision overrides for one orientation. Non-finite values are ignored, not clamped. */
export function readVisionOverrides(raw: RawSettings, o: Orientation): Partial<VisionSettings> {
  const vis = raw[VISION_GROUP];
  if (!isPlainObject(vis)) return {};
  const src = vis[o];
  if (!isPlainObject(src)) return {};
  const out: Partial<VisionSettings> = {};
  for (const k of VISION_KEYS) {
    const v = src[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/** Set one vision override in place, creating the nested objects as needed. */
export function writeVisionOverride(
  raw: RawSettings, o: Orientation, key: VisionKey, value: number,
): void {
  if (!isPlainObject(raw[VISION_GROUP])) raw[VISION_GROUP] = {};
  const vis = raw[VISION_GROUP] as Record<string, unknown>;
  if (!isPlainObject(vis[o])) vis[o] = {};
  (vis[o] as Record<string, unknown>)[key] = value;
}

/** Drop every vision override for one orientation, cleaning up empty containers. */
export function clearVisionOverrides(raw: RawSettings, o: Orientation): void {
  if (!isPlainObject(raw[VISION_GROUP])) return;
  const vis = raw[VISION_GROUP] as Record<string, unknown>;
  delete vis[o];
  if (Object.keys(vis).length === 0) delete raw[VISION_GROUP];
}

/** Defaults merged with the sparse vision overrides, then clamped (dirty data must not throw). */
export function effectiveVision(raw: RawSettings, o: Orientation): VisionSettings {
  const base = visionDefaultsFor(o);
  const over = readVisionOverrides(raw, o);
  const v = over.dim;
  if (v !== undefined) base.dim = v;
  return { dim: clampVisionDim(base.dim) };
}

/** Is the vision value overridden for `o`? (drives the 视野 group's 「恢复默认」 enabled state) */
export function hasVisionOverrides(raw: RawSettings, o: Orientation): boolean {
  return Object.keys(readVisionOverrides(raw, o)).length > 0;
}

// ---------------------------------------------------------------------------
// 光照 group: ambient light + directional light
// ---------------------------------------------------------------------------
// TWO keys, both plain MULTIPLIERS whose bases live in lighting.ts, so a stored value keeps its
// meaning when those bases are re-tuned (the ambient shipped level has been re-tuned four times:
// 1.05 → 0.42 → 0.14 → 0). They are the two knobs that decided the scene's look, and they are NOT
// interchangeable: `ambient` moves the flat floor of the image (contrast / flatness), `directional`
// scales both directional lights together (the sun = brightness and shading strength of lit faces).
// See lighting.ts for that distinction and for the derived ambient top.
//
// PER ORIENTATION LIKE EVERY OTHER GROUP even though light does not depend on the device's
// orientation: every group's storage path is `scope.<group>.<orientation>.<key>`, and special-casing
// one of them would add a branch to the panel's apply/merge path for no user-visible gain. The same
// quirk is already recorded for 视野 in apps/shooter/README.md.
export interface LightSettings {
  /** Multiplier on AMBIENT_BASE; 0 = the ambient light is off (what ships). */
  ambient: number;
  /** Multiplier on BOTH directional base intensities; 1 = the sun as it has always shipped. */
  directional: number;
}

export const LIGHT_GROUP = 'light';
export const LIGHT_KEYS = ['ambient', 'directional'] as const;
export type LightKey = (typeof LIGHT_KEYS)[number];

/** Slider range/step, sourced from lighting.ts so the UI and the renderer cannot drift apart. */
export const LIGHT_LIMITS: Record<LightKey, { min: number; max: number; step: number }> = {
  ambient: { min: AMBIENT_SCALE_MIN, max: AMBIENT_SCALE_MAX, step: AMBIENT_SCALE_STEP },
  directional: {
    min: DIRECTIONAL_SCALE_MIN, max: DIRECTIONAL_SCALE_MAX, step: DIRECTIONAL_SCALE_STEP,
  },
};

/** Built-in lighting defaults: ambient off, sun as shipped. */
export function lightDefaultsFor(_o: Orientation): LightSettings {
  return { ambient: AMBIENT_SCALE_DEFAULT, directional: DIRECTIONAL_SCALE_DEFAULT };
}

/** Sparse lighting overrides for one orientation. Non-finite values are ignored, not clamped. */
export function readLightOverrides(raw: RawSettings, o: Orientation): Partial<LightSettings> {
  const light = raw[LIGHT_GROUP];
  if (!isPlainObject(light)) return {};
  const src = light[o];
  if (!isPlainObject(src)) return {};
  const out: Partial<LightSettings> = {};
  for (const k of LIGHT_KEYS) {
    const v = src[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/** Set one lighting override in place, creating the nested objects as needed. */
export function writeLightOverride(
  raw: RawSettings, o: Orientation, key: LightKey, value: number,
): void {
  if (!isPlainObject(raw[LIGHT_GROUP])) raw[LIGHT_GROUP] = {};
  const light = raw[LIGHT_GROUP] as Record<string, unknown>;
  if (!isPlainObject(light[o])) light[o] = {};
  (light[o] as Record<string, unknown>)[key] = value;
}

/** Drop every lighting override for one orientation, cleaning up empty containers. */
export function clearLightOverrides(raw: RawSettings, o: Orientation): void {
  if (!isPlainObject(raw[LIGHT_GROUP])) return;
  const light = raw[LIGHT_GROUP] as Record<string, unknown>;
  delete light[o];
  if (Object.keys(light).length === 0) delete raw[LIGHT_GROUP];
}

/** Defaults merged with the sparse lighting overrides, then clamped (dirty data must not throw). */
export function effectiveLight(raw: RawSettings, o: Orientation): LightSettings {
  const base = lightDefaultsFor(o);
  const over = readLightOverrides(raw, o);
  if (over.ambient !== undefined) base.ambient = over.ambient;
  if (over.directional !== undefined) base.directional = over.directional;
  return {
    ambient: clampAmbientScale(base.ambient),
    directional: clampDirectionalScale(base.directional),
  };
}

/** Is any lighting value overridden for `o`? (drives the 光照 group's 「恢复默认」 enabled state) */
export function hasLightOverrides(raw: RawSettings, o: Orientation): boolean {
  return Object.keys(readLightOverrides(raw, o)).length > 0;
}

// ---------------------------------------------------------------------------
// 雾 group: height fog
// ---------------------------------------------------------------------------
// One key — the fog density at floor level, in world units (fog.ts owns the range, the height falloff
// and the visibility clamp). 0 = the feature is OFF, and unlike the lighting keys that is a real
// switch rather than a look: the shader mix becomes a no-op, so it is also the rollback path if the
// effect ever misbehaves on a device.
//
// PER ORIENTATION LIKE EVERY OTHER GROUP even though fog does not depend on the device's orientation:
// every group's storage path is `scope.<group>.<orientation>.<key>`, and special-casing one of them
// would add a branch to the panel's apply/merge path for no user-visible gain (the same quirk is
// already recorded for 视野 and 光照).
export interface FogSettings {
  /** Fog density at the floor (y = FOG_BASE_Y); 0 turns the effect off. */
  density: number;
}

export const FOG_GROUP = 'fog';
export const FOG_KEYS = ['density'] as const;
export type FogKey = (typeof FOG_KEYS)[number];

/** Slider range/step, sourced from fog.ts so the UI and the shader cannot drift apart. */
export const FOG_LIMITS: Record<FogKey, { min: number; max: number; step: number }> = {
  density: { min: FOG_DENSITY_MIN, max: FOG_DENSITY_MAX, step: FOG_DENSITY_STEP },
};

/** Built-in fog default: a visible but subtle haze (the "加一点高度雾" request). */
export function fogDefaultsFor(_o: Orientation): FogSettings {
  return { density: FOG_DENSITY_DEFAULT };
}

/** Sparse fog overrides for one orientation. Non-finite values are ignored, not clamped. */
export function readFogOverrides(raw: RawSettings, o: Orientation): Partial<FogSettings> {
  const fog = raw[FOG_GROUP];
  if (!isPlainObject(fog)) return {};
  const src = fog[o];
  if (!isPlainObject(src)) return {};
  const out: Partial<FogSettings> = {};
  for (const k of FOG_KEYS) {
    const v = src[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/** Set the fog override in place, creating the nested objects as needed. */
export function writeFogOverride(
  raw: RawSettings, o: Orientation, key: FogKey, value: number,
): void {
  if (!isPlainObject(raw[FOG_GROUP])) raw[FOG_GROUP] = {};
  const fog = raw[FOG_GROUP] as Record<string, unknown>;
  if (!isPlainObject(fog[o])) fog[o] = {};
  (fog[o] as Record<string, unknown>)[key] = value;
}

/** Drop the fog override for one orientation, cleaning up empty containers. */
export function clearFogOverrides(raw: RawSettings, o: Orientation): void {
  if (!isPlainObject(raw[FOG_GROUP])) return;
  const fog = raw[FOG_GROUP] as Record<string, unknown>;
  delete fog[o];
  if (Object.keys(fog).length === 0) delete raw[FOG_GROUP];
}

/** Defaults merged with the sparse fog override, then clamped (dirty data must not throw). */
export function effectiveFog(raw: RawSettings, o: Orientation): FogSettings {
  const base = fogDefaultsFor(o);
  const over = readFogOverrides(raw, o);
  if (over.density !== undefined) base.density = over.density;
  return { density: clampFogDensity(base.density) };
}

/** Is the fog value overridden for `o`? (drives the 雾 group's 「恢复默认」 enabled state) */
export function hasFogOverrides(raw: RawSettings, o: Orientation): boolean {
  return Object.keys(readFogOverrides(raw, o)).length > 0;
}

// ---------------------------------------------------------------------------
// 后期 group (storage key `look`): tone grade + vignette + pixelation
// ---------------------------------------------------------------------------
// Three keys, all "how the finished image is finished" rather than "what is in the world":
//   * `tone`     — strength of the split-tone/contrast/saturation grade (grade.ts).
//   * `vignette` — strength of the corner falloff card (vignette.ts).
//   * `pixel`    — the pixelation block size in CSS px, 0 = the whole post pass is off (postfx.ts).
// (The panel label for this group is 「后期」; the STORAGE key stays `look` so nobody's saved values have
// to be migrated when the label changed.)
// Both treat 0 as EXACTLY the unprocessed image: the grade blends to the identity and the vignette
// card is hidden (so it also costs nothing). That is what makes them safe to ship on a device nobody
// here can look at — a slider back to 0 is a full rollback of the change.
//
// PER ORIENTATION LIKE EVERY OTHER GROUP (see the note at the top of this file): the storage path
// shape is uniform, and the panel's apply/merge path needs no special case for one group.
export interface LookSettings {
  /** Grade strength; 0 = ungraded. */
  tone: number;
  /** Vignette strength; 0 = off (the card is hidden). */
  vignette: number;
  /** Pixelation block in CSS px; 0 = the post pass is off entirely. */
  pixel: number;
}

export const LOOK_GROUP = 'look';
export const LOOK_KEYS = ['tone', 'vignette', 'pixel'] as const;
export type LookKey = (typeof LOOK_KEYS)[number];

/** Slider ranges/steps, sourced from the two leaf modules so the UI cannot drift from them. */
export const LOOK_LIMITS: Record<LookKey, { min: number; max: number; step: number }> = {
  tone: { min: GRADE_STRENGTH_MIN, max: GRADE_STRENGTH_MAX, step: GRADE_STRENGTH_STEP },
  vignette: {
    min: VIGNETTE_STRENGTH_MIN, max: VIGNETTE_STRENGTH_MAX, step: VIGNETTE_STRENGTH_STEP,
  },
  pixel: { min: PIXEL_BLOCK_MIN, max: PIXEL_BLOCK_MAX, step: PIXEL_BLOCK_STEP },
};

/** Built-in look defaults: the authored grade on, a subtle vignette, and a 2 CSS px pixel block
 *  (the request was explicitly "not too big"). */
export function lookDefaultsFor(_o: Orientation): LookSettings {
  return {
    tone: GRADE_STRENGTH_DEFAULT, vignette: VIGNETTE_STRENGTH_DEFAULT, pixel: PIXEL_BLOCK_DEFAULT,
  };
}

/** Sparse look overrides for one orientation. Non-finite values are ignored, not clamped. */
export function readLookOverrides(raw: RawSettings, o: Orientation): Partial<LookSettings> {
  const look = raw[LOOK_GROUP];
  if (!isPlainObject(look)) return {};
  const src = look[o];
  if (!isPlainObject(src)) return {};
  const out: Partial<LookSettings> = {};
  for (const k of LOOK_KEYS) {
    const v = src[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/** Set one look override in place, creating the nested objects as needed. */
export function writeLookOverride(
  raw: RawSettings, o: Orientation, key: LookKey, value: number,
): void {
  if (!isPlainObject(raw[LOOK_GROUP])) raw[LOOK_GROUP] = {};
  const look = raw[LOOK_GROUP] as Record<string, unknown>;
  if (!isPlainObject(look[o])) look[o] = {};
  (look[o] as Record<string, unknown>)[key] = value;
}

/** Drop the look overrides for one orientation, cleaning up empty containers. */
export function clearLookOverrides(raw: RawSettings, o: Orientation): void {
  if (!isPlainObject(raw[LOOK_GROUP])) return;
  const look = raw[LOOK_GROUP] as Record<string, unknown>;
  delete look[o];
  if (Object.keys(look).length === 0) delete raw[LOOK_GROUP];
}

/** Defaults merged with the sparse look overrides, then clamped (dirty data must not throw). */
export function effectiveLook(raw: RawSettings, o: Orientation): LookSettings {
  const base = lookDefaultsFor(o);
  const over = readLookOverrides(raw, o);
  if (over.tone !== undefined) base.tone = over.tone;
  if (over.vignette !== undefined) base.vignette = over.vignette;
  if (over.pixel !== undefined) base.pixel = over.pixel;
  return {
    tone: clampGradeStrength(base.tone),
    vignette: clampVignetteStrength(base.vignette),
    pixel: clampPixelBlock(base.pixel),
  };
}

/** Is any look value overridden for `o`? (drives the 调色 group's 「恢复默认」 enabled state) */
export function hasLookOverrides(raw: RawSettings, o: Orientation): boolean {
  return Object.keys(readLookOverrides(raw, o)).length > 0;
}
