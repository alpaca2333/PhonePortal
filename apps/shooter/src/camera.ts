// Camera framing geometry — the single source of truth for "where is the camera relative to the
// player". Deliberately a leaf module (no imports at all, no DOM, no three): render.ts uses it to
// place the camera, settings.ts uses its limits for the 「画面」 setting, and
// scripts/verify-stick.mjs imports it in Node to prove the numbers.
//
// Reference framing (scale = 1) is exactly what the renderer used to hardcode:
//   CAM_H    = 24  world units above the player
//   CAM_BACK = 15  world units behind the player (toward +Z)
//   -> pitch atan2(24, 15) = 57.995°, distance 28.317
//
// The 「摄像机高度」 setting moves the camera along
//     height = CAM_H * scale,  back = CAM_BACK * max(1, scale)
//
//   * scale <= 1 LOWERS it with the back offset held: the pitch shallows from 58.0 deg at 1.0 to
//     32.6 deg at 0.4 — a lower, flatter, closer 3/4 view.
//   * scale >= 1 raises it AND backs it off by the SAME factor, which holds the pitch at exactly
//     the reference 58.0 deg: above 1.0 the slider pulls the camera out along the same 3/4 axis
//     instead of tilting it toward top-down.
//
// WHY IT IS THIS AND NOT A LITERAL HEIGHT MULTIPLIER (it was, and it changed on request): scaling
// the height alone steepened the pitch as it climbed — 78.2 deg at 3.0x, i.e. near top-down — and
// the feedback was exactly that ("raise the camera and the view gets too top-down; can it stay
// oblique?"). The algebra is why the fix is one `max`: at the reference framing tan(pitch) =
// CAM_H / CAM_BACK, so holding the angle means back = height * CAM_BACK / CAM_H = CAM_BACK * scale.
// Clamping the factor at 1 leaves the whole LOW half of the slider — where the flat close-up look
// lives, and which nobody complained about — bit-for-bit unchanged.
//
// WHAT IT COSTS, since the range is otherwise free: distance grows faster than before (3.0x is
// 84.85 units rather than 73.55), so at the top of the slider the world is ~13% smaller (the
// character ~10.9 px rather than ~12.6 px on a 400 px-tall viewport), and because the camera stays
// oblique the top of the frame now looks OVER the far wall into the dark surround (~15% of the
// frame at 3.0x, ~0% below about 2.0x). What it buys is the angle the player chose at 1.0x.
//
// Interaction with the viewport-height dolly (`CAM_REF_H` in render.ts): the renderer multiplies
// BOTH components by `camZoom`, which is a dolly along the camera's own view axis, so it rescales
// the projection for short landscape viewports without touching the pitch. Every consumer must take
// the pair from `cameraOffset()` (shadow.ts does) rather than re-deriving it, or the two rules drift.
//
// The 「摄像机水平角度」 (yaw) setting added below orbits that same pose around +Y: the pitch and the
// distance stay the 「摄像机高度」's business, and `cameraEye`/`cameraBasis` are the single source for
// "where is the camera and which way does it look" — used by render.ts (the pose), shadow.ts (the
// visible-ground fit) and input.ts (mapping the sticks onto the ground). See `screenToWorld`.
export const CAM_H = 24;
export const CAM_BACK = 15;

/** Vertical field of view, in degrees (what the renderer's PerspectiveCamera is built with).
 *
 * It lives here rather than inline in render.ts because the key light's shadow box is sized from
 * what the camera can SEE (see shadow.ts). If this and the camera's fov ever disagreed, the fitted
 * shadow box would silently under-cover the screen — the very artifact it exists to prevent. */
export const CAMERA_FOV_Y = 52;

/** Slider range for the height multiplier (see the 「画面」 group in the settings panel).
 *
 * Widened from 0.6-1.8 to 0.4-3.0 on request ("increase the adjustment range"). End points:
 *   0.4 -> height 9.6,  back 15, distance 17.81, pitch 32.62 deg (character ~1.59x bigger)
 *   3.0 -> height 72.0, back 15, distance 73.55, pitch 78.23 deg (character ~0.39x, near top-down)
 * 0.4 is deliberately the floor: 0.3 would put the pitch at 25.6 deg, i.e. almost a side view
 * where the ground goes edge-on, characters occlude each other and the flat aiming line
 * disappears. 3.0 is a "see the whole 40x40 arena" overview; the character is only ~12.6 px
 * tall there, so it is an extreme setting, not a default. */
export const CAMERA_SCALE_MIN = 0.4;
export const CAMERA_SCALE_MAX = 3.0;
export const CAMERA_SCALE_STEP = 0.05;
export const CAMERA_SCALE_DEFAULT = 1;

export interface CameraOffset {
  /** world units above the player */
  height: number;
  /** world units behind the player (toward +Z) */
  back: number;
}

/** Clamp to the slider range; anything non-finite (hand-edited file, bad JSON) falls back to 1. */
export function clampCameraScale(scale: number): number {
  if (typeof scale !== 'number' || !Number.isFinite(scale)) return CAMERA_SCALE_DEFAULT;
  if (scale < CAMERA_SCALE_MIN) return CAMERA_SCALE_MIN;
  if (scale > CAMERA_SCALE_MAX) return CAMERA_SCALE_MAX;
  return scale;
}

/** Camera offset from the player for a height multiplier. Clamps defensively (pure + cheap). */
export function cameraOffset(scale: number): CameraOffset {
  const s = clampCameraScale(scale);
  // `max(1, s)` and not `s`: see the header. Above the reference scale both components grow
  // together (constant 58.0 deg pitch); below it the back offset holds and the view flattens.
  return { height: CAM_H * s, back: CAM_BACK * Math.max(1, s) };
}

// ---------------------------------------------------------------------------
// 「摄像机水平角度」 (yaw): the camera ORBITS the player around +Y
// ---------------------------------------------------------------------------
// The pitch and the distance are untouched (they belong to 「摄像机高度」), so the yaw only changes
// WHERE on the circle around the player the camera sits:
//
//     eye = (back * sin ψ, height, back * cos ψ)          ψ = 0 -> (0, height, back) = the shipped pose
//
// SIGN CONVENTION (flip the two `sin` signs here if a device ever says it feels backwards): ψ > 0
// moves the camera toward the player's +X side, so the world appears to rotate to the LEFT on screen.
//
// Everything else derives from that eye, and `ψ = 0` must reproduce the pre-setting numbers EXACTLY —
// the renderer, the shadow-box fit and the screen->world input mapping all take their geometry from
// here, and verify-stick.mjs pins the ψ = 0 case against the numbers that were hardcoded before.
export const CAMERA_YAW_MIN = -180;
export const CAMERA_YAW_MAX = 180;
export const CAMERA_YAW_STEP = 15;
export const CAMERA_YAW_DEFAULT = 0;

/** Clamp to the slider range; anything non-finite (hand-edited file, bad JSON) falls back to 0. */
export function clampCameraYaw(deg: number): number {
  if (typeof deg !== 'number' || !Number.isFinite(deg)) return CAMERA_YAW_DEFAULT;
  if (deg < CAMERA_YAW_MIN) return CAMERA_YAW_MIN;
  if (deg > CAMERA_YAW_MAX) return CAMERA_YAW_MAX;
  return deg;
}

/** The yaw in radians (clamped first, so every consumer agrees on the angle). */
export function cameraYawRad(deg: number): number {
  return (clampCameraYaw(deg) * Math.PI) / 180;
}

/**
 * Eye position relative to the player, world units. Multiply the whole triple by the viewport dolly
 * (`camZoom`) if you need the dollied pose: the dolly scales both components of `cameraOffset`
 * equally, so it scales this vector without changing its direction (and therefore not the basis).
 */
export function cameraEye(scale: number, yawDeg: number): [number, number, number] {
  const o = cameraOffset(scale);
  const r = cameraYawRad(yawDeg);
  return [o.back * Math.sin(r), o.height, o.back * Math.cos(r)];
}

/**
 * The camera's orthonormal basis, the SAME rule three's `Matrix4.lookAt` uses with `up = +Y`:
 * `vz` points from the player back toward the eye, `vx = normalize(up × vz)` (the screen's right axis,
 * which for an up-vector of +Y depends only on the yaw — the camera never rolls), `vy = vz × vx`.
 *
 * It is exported because TWO modules need it and a second copy would silently describe a camera nobody
 * is looking through: `shadow.ts` clips the ortho view volume against the ground with it, and
 * `screenToWorld` below maps the sticks with it. `cameraBasis(scale, 0)` with the shipped scale equals
 * the `[1,0,0] / [0, vz.z, -vz.y] / vz` triple that shadow.ts used to hardcode.
 *
 * camZoom-independent by construction: the dolly scales height and back together, so the pitch — and
 * with it every basis vector — is unchanged.
 */
export interface CameraBasis {
  /** unit vector from the player toward the eye (three's +Z of the camera frame) */
  vz: [number, number, number];
  /** screen right (three's +X) */
  vx: [number, number, number];
  /** screen up (three's +Y) */
  vy: [number, number, number];
}

export function cameraBasis(scale: number, yawDeg: number): CameraBasis {
  const o = cameraOffset(scale);
  const r = cameraYawRad(yawDeg);
  const sin = Math.sin(r);
  const cos = Math.cos(r);
  const len = Math.hypot(o.height, o.back);
  const s = o.back / len;          // horizontal share of the view axis
  const h = o.height / len;        // vertical share
  return {
    vz: [s * sin, h, s * cos],
    // normalize(up × vz) = normalize((vz.z, 0, -vz.x)); the s factor cancels, leaving (cos, 0, -sin).
    vx: [cos, 0, -sin],
    vy: [-h * sin, s, -h * cos],
  };
}

/**
 * Screen-space stick/mouse direction -> WORLD ground direction, for a rotated camera.
 *
 * `dir` is what input.ts samples: `+x` right on screen, `+y` DOWN on screen, |dir| <= 1. The world
 * vector is `dir.x * vx + dir.y * screenDown`, where `screenDown` is the ground projection of the
 * screen's down axis (= -vy, normalized): the two components give `(cos, -sin)` and `(sin, cos)`, i.e.
 * a rotation of the input by the yaw. ψ = 0 is the identity — which is the mapping that shipped, so
 * the default setting cannot change how the game plays.
 *
 * WHY THIS EXISTS AT ALL: the sim consumes `InputState.move/aim` as world-space XZ (game.ts turns them
 * into velocity and `aimAngle` directly), and it must keep doing so — the simulation is view-agnostic
 * and stays node-testable. Mapping the screen axes onto the ground therefore happens HERE, at the
 * input boundary, exactly once. (Vertical ground compression under the pitched camera is deliberately
 * not modelled: it never was, and `+y`-on-screen already means `+Z` in the world at yaw 0.)
 */
export function screenToWorld(dir: { x: number; y: number }, yawDeg: number): { x: number; z: number } {
  const r = cameraYawRad(yawDeg);
  const sin = Math.sin(r);
  const cos = Math.cos(r);
  return { x: dir.x * cos + dir.y * sin, z: -dir.x * sin + dir.y * cos };
}

/** Downward tilt of the view axis in degrees. Constant above scale 1 (see the header) — this is
 * what scripts/verify-stick.mjs pins, and what the shadow fit's coverage test relies on. */
export function cameraPitchDeg(scale: number): number {
  // Both components come from cameraOffset: the pitch is atan2(height, back), and `back` is no
  // longer the constant CAM_BACK (it scales with the height above the reference — see the header).
  const o = cameraOffset(scale);
  return (Math.atan2(o.height, o.back) * 180) / Math.PI;
}

/** Camera-to-player distance in world units (drives how large the world looks on screen). */
export function cameraDistance(scale: number): number {
  const o = cameraOffset(scale);
  return Math.hypot(o.height, o.back);
}

/**
 * Vertical size of the ORTHOGRAPHIC view volume, in world units.
 *
 * The renderer projects with `OrthographicCamera` (it used to be a PerspectiveCamera with
 * CAMERA_FOV_Y). The change is deliberately "same pose, same framing at the focus plane, parallel
 * projection": the frustum height is the height the OLD perspective camera saw at the player's depth,
 *
 *     2 * distance(scale) * camZoom * tan(CAMERA_FOV_Y / 2)
 *
 * so at the reference framing the world is exactly as large on screen as it was (28.317 * 2 * 0.4877
 * = 27.62 world units tall at camZoom 1), while everything behind or in front of the focus plane no
 * longer changes size. The 「摄像机高度」 slider keeps its meaning because it moves the camera along
 * the same 3/4 axis (cameraOffset): a wider/further pose still shows MORE world, just without the
 * perspective convergence that used to come with it.
 *
 * WHY ORTHO AT ALL (the request): with a parallel projection the world-space size of one screen pixel
 * is CONSTANT across the frame, which is what makes the pixelation pass (see postfx.ts) stable — a
 * perspective projection would need a per-depth pixel size, and the block grid would breathe.
 *
 * `camZoom` is render.ts's viewport-height dolly. Under perspective it dollied the camera closer; under
 * ortho there is nothing to dolly (moving an ortho camera does not change the image), so it scales the
 * frustum instead — which is the same thing the dolly used to do to the projection.
 */
export function orthoFrustumHeight(scale: number, camZoom: number): number {
  const tanY = Math.tan(((CAMERA_FOV_Y * Math.PI) / 180) / 2);
  return 2 * cameraDistance(scale) * camZoom * tanY;
}
