// WHERE THE KEY LIGHT'S SHADOW BOX GOES. Pure: no three, no DOM — render.ts feeds the numbers
// straight into DirectionalLight.position/target and the shadow camera, and
// scripts/verify-shadow.mjs proves them in Node (including against the vendored three.js, whose
// shadow matrix it reproduces).
//
// ---------------------------------------------------------------------------------------------
// THE BUG THIS MODULE EXISTS FOR
// ---------------------------------------------------------------------------------------------
// A directional light's shadow camera is an ORTHOGRAPHIC BOX. Before this file that box was a
// hardcoded +-30 world units around the player, with hardcoded `bias = -0.0003` /
// `normalBias = 0.02`, and its centre followed the player's exact float position. On the old arena
// (a flat grid floor with ~20 instanced cover boxes) that was invisible. After the indoor art
// landed (795 instanced props, 0.11-unit-thick walls, ~430 shadow casters) two artifacts appeared:
//
//   1. NOISE. The box spreads 2048 texels over 60 units = 0.0293 world units per texel. A texel can
//      hide `texel * tan(angle)` of depth error, and the most grazing LIT axis-aligned face (a
//      horizontal normal parallel to the light's horizontal direction) sits 60.3 degrees off the
//      light axis: tan = 1.72, so one texel hides 0.0504 units of depth. The old constants bought
//      0.0177 (bias) + 0.02*cos(angle) (normalBias) — roughly 2x short — so grazing faces speckled
//      with self-shadow acne. With ~430 casters now standing in the room, "a few speckles" became
//      "the room is noisy".
//   2. FLICKER. The box centre tracked the player's raw position, so it moved by a fraction of a
//      texel every frame. The texel grid then lands on different world positions each frame and
//      STATIC geometry gets re-sampled: every shadow edge in the room crawls and sparkles while the
//      player moves. Nothing was animating — the sampling grid was.
//
// ---------------------------------------------------------------------------------------------
// THE FIX (three parts, each independently checkable)
// ---------------------------------------------------------------------------------------------
// 1. FIT THE BOX TO WHAT THE CAMERA SEES. The half-extent comes from the camera's own frustum
//    (camera.ts numbers + viewport aspect), so shadows exist everywhere on screen at every
//    「摄像机高度」/zoom/aspect setting instead of only within 30 units of the player. It also keeps
//    the shadow's on-screen sharpness roughly CONSTANT: a box twice as far away is twice as coarse
//    in world units but covers twice as many world units per screen pixel, so the two cancel —
//    which is why a "one texel" bias rule can hold at every zoom. The box is clamped to the arena
//    (+margin): past the walls there is only the unshadowed surround plane, so covering more would
//    only waste texels.
// 2. SNAP THE CENTRE TO WHOLE TEXELS. The box may only move in whole-texel steps, so a sub-texel
//    player movement yields a bit-identical sampling grid and the shadow map cannot crawl. This is
//    the standard "shadow map texel snapping" technique (three.js's own cascade examples do it);
//    it is what actually cures the flicker.
// 3. DERIVE THE BIAS FROM THE TEXEL SIZE, in texels, so the acne margin tracks the texel's depth
//    error at any zoom, instead of being a constant that only happened to suit one camera setting.
//
// WHY NOT THE ALTERNATIVES: widening the fixed box to +-40 keeps the flicker and trades coverage
// for even coarser texels; a 4096 map costs 4x the memory/fill on a phone for something snapping
// gets for free; cascades/VSM/PCSS need custom shaders, which this app deliberately ships none of.
import { ARENA_HALF } from './config.js';
import { cameraBasis, cameraEye, orthoFrustumHeight } from './camera.js';

/** Shadow map resolution (square). 2048 is the memory/fill point this app can afford on a phone. */
export const SHADOW_MAP_SIZE = 2048;

/** Target -> light offset. The light DIRECTION is part of the arena's look (a 60 degree sun from
 * the +X/+Z corner); only the box around it moves. */
export const LIGHT_OFFSET: readonly [number, number, number] = [10, 22, 8];

/** Tallest shadow caster the arena is expected to have (the perimeter wall is 2.97 world units).
 * Only a fallback — render.ts measures the real one from the plan and passes it in. */
export const SHADOW_CASTER_H_FALLBACK = 2.98;

/** Unit vector from the target toward the light. */
const LIGHT_DIR = ((): readonly [number, number, number] => {
  const [x, y, z] = LIGHT_OFFSET;
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
})();

/** Horizontal fraction of the light direction: how far a caster's shadow travels per unit height. */
const LIGHT_THROW = Math.hypot(LIGHT_OFFSET[0], LIGHT_OFFSET[2]) / LIGHT_OFFSET[1];

/**
 * `tan` of the most grazing LIT **axis-aligned** face — 3.00 for this light, on a face whose normal
 * is `+Z` (`n.l = Lz/|L| = 0.314`). This is the case that matters here: every wall runs along an
 * axis and so do the box-like props, so this is the worst receiver the room actually contains. (A
 * face tilted to be *even more* grazing is possible in principle — `tan` is unbounded as `n.l -> 0`
 * — which is why a single shadow map can never be provably acne-free on arbitrary curved geometry;
 * the probe in scripts/verify-shadow.mjs measures the real answer instead.)
 */
export const SHADOW_SLOPE_WORST =
  Math.sqrt(1 - Math.min(Math.abs(LIGHT_DIR[0]), Math.abs(LIGHT_DIR[2])) ** 2)
  / Math.min(Math.abs(LIGHT_DIR[0]), Math.abs(LIGHT_DIR[2]));

/** Off-screen caster margin a given tallest caster needs, in world units. A caster of height h
 * throws its shadow at most `h * LIGHT_THROW` (0.585 here) horizontally, so a receiver with no
 * caster within `h * (1 + LIGHT_THROW)` cannot be legitimately shadowed by one. */
export function shadowMarginFor(casterHeight: number): number {
  return casterHeight * (1 + LIGHT_THROW);
}

/** Fallback margin, for callers that do not know the caster height. */
export const SHADOW_MARGIN = shadowMarginFor(SHADOW_CASTER_H_FALLBACK);

/** Smallest box half-extent: below this the box stops covering the shadow a single tall caster
 * throws, and the margin dominates anyway. */
export const SHADOW_HALF_MIN = 8;

/**
 * Acne margins, in TEXELS (multipliers — see fitShadowBox).
 *
 * The depth a texel can hide on the worst lit face is `texel * SHADOW_SLOPE_WORST`, so `bias` is
 * sized as a multiple of that (plus the sideways reach of the PCF kernel, whose outermost taps sit
 * 2 texels away). Both numbers come from the measured curves in scripts/verify-shadow.mjs, where the
 * acne rate and the contact-shadow offset are the two ends of the same trade-off: 0.6 keeps the
 * probe acne-free with margin to spare while holding the contact offset under a screen pixel.
 * `normalBias` is the cheaper tool for flat receivers, where it costs no contact offset at all.
 */
export const SHADOW_BIAS_TEXELS = 0.6;
export const SHADOW_NORMAL_TEXELS = 1.0;

export interface ShadowAxes {
  /** light-space +X (the shadow camera's right), unit */
  x: readonly [number, number, number];
  /** light-space +Y (the shadow camera's up), unit */
  y: readonly [number, number, number];
  /** light-space +Z = normalize(light - target); the orthographic view direction is -z */
  z: readonly [number, number, number];
}

/**
 * The shadow camera's basis, reproducing what three.js's `Object3D.lookAt` builds for a
 * DirectionalLightShadow (`z = normalize(eye - target)`, `x = normalize(up x z)`, `y = cross(z,x)`,
 * up = +Y). scripts/verify-shadow.mjs compares this against the real `light.shadow.matrix` built by
 * the vendored three, so a three.js upgrade that changed the convention would fail the suite.
 */
export function shadowAxes(): ShadowAxes {
  const z = LIGHT_DIR;
  const up: readonly [number, number, number] = [0, 1, 0];
  const xr = up[1] * z[2] - up[2] * z[1];
  const yr = up[2] * z[0] - up[0] * z[2];
  const zr = up[0] * z[1] - up[1] * z[0];
  const xl = Math.hypot(xr, yr, zr);
  const x: readonly [number, number, number] = [xr / xl, yr / xl, zr / xl];
  const y: readonly [number, number, number] = [
    z[1] * x[2] - z[2] * x[1],
    z[2] * x[0] - z[0] * x[2],
    z[0] * x[1] - z[1] * x[0],
  ];
  return { x, y, z };
}

export interface ShadowFit {
  /** world-space centre of the ortho box (= the light's target) */
  target: readonly [number, number, number];
  /** world-space light position */
  light: readonly [number, number, number];
  /** ortho half-extent; the box is SQUARE so the texel stays isotropic */
  half: number;
  near: number;
  far: number;
  /** world units per shadow texel */
  texel: number;
  /** depth bias in three's normalised [0,1] shadow-depth units */
  bias: number;
  /** normal bias in world units */
  normalBias: number;
}

/** Snap a scalar to a multiple of `texel` — this is what freezes the sampling grid in world space. */
export function snapToTexel(v: number, texel: number): number {
  return Math.round(v / texel) * texel;
}

export interface GroundSpans {
  /** light-space extent of the UNCLIPPED visible ground on the light's X axis, [min,max] */
  ax: [number, number];
  /** light-space extent of the UNCLIPPED visible ground on the light's Y axis, [min,max] */
  ay: [number, number];
  /** world-space midpoint of the visible ARENA ground (the box centre, before texel snapping) */
  mid: [number, number];
  /** that same midpoint in light-space coordinates (what gets snapped to the texel grid) */
  midA: number;
  midB: number;
  /** corner count of the visible-arena polygon (0 means the camera sees none of the arena) */
  corners: number;
}

/**
 * Light-space bounds of the ARENA ground the camera can see right now.
 *
 * Clips a large quad on y = 0 against the camera's four side planes (Sutherland-Hodgman), then
 * against the arena square, and projects the result onto the LIGHT's axes. Clipping against planes
 * rather than sampling rays is what makes the corners exact. Clipping to the arena matters for two
 * reasons: past the walls there is only the dark surround plane (which never receives shadows, so
 * covering it would waste texels), and the midpoint of what remains is the box centre that covers
 * the most *reachable* screen area when the camera is looking over a wall.
 *
 * `camZoom` is render.ts's viewport-height dolly, `scale` the 「摄像机高度」 setting and
 * (playerX, playerZ) where the camera is looking: all three act on the same camera, so this frustum
 * is the real one.
 */
export function visibleGroundSpans(
  playerX: number, playerZ: number, scale: number, camZoom: number, aspect: number,
  axes: ShadowAxes = shadowAxes(), yawDeg: number = 0,
): GroundSpans {
  // Taken from camera.ts rather than re-derived: the height/back PAIR is what fixes the pitch, and
  // a second copy of that rule here would silently describe a camera the player is not looking
  // through (it did: this file still assumed `back = CAM_BACK` after the 「摄像机高度」 setting
  // started backing the camera off as well, which would have mis-fitted the box at every zoom).
  //
  // The eye and the basis now come from camera.ts as well, so the 「摄像机水平角度」 orbit is
  // described in ONE place: `cameraEye` gives the offset (which the dolly scales uniformly, hence
  // `camZoom` on all three components) and `cameraBasis` the orthonormal frame — yaw 0 reproduces the
  // `[1,0,0] / [0, vz.z, -vz.y] / vz` triple that used to be written out here.
  const eye = cameraEye(scale, yawDeg);
  const camera: readonly [number, number, number] = [
    playerX + eye[0] * camZoom, eye[1] * camZoom, playerZ + eye[2] * camZoom,
  ];
  // The VIEW camera's lookAt basis (looking at the player): z = normalize(eye - target).
  const basis = cameraBasis(scale, yawDeg);
  const vz: readonly [number, number, number] = basis.vz;
  const vx: readonly [number, number, number] = basis.vx;
  const vy: readonly [number, number, number] = basis.vy;
  // ORTHOGRAPHIC view volume (the renderer projects with OrthographicCamera — see
  // camera.ts::orthoFrustumHeight). The four side planes are PARALLEL to the view axis now, so each is
  // simply one of the camera's lateral axes with a fixed offset — the fov tilts are gone, and with
  // them the depth dependence. That is strictly better for this fit: the frustum is a fixed SHAPE that
  // translates with the camera, where the perspective one widened with distance.
  const halfH = orthoFrustumHeight(scale, camZoom) / 2;
  const halfW = halfH * aspect;
  // Interior satisfies dot(n, P - camera) <= half, i.e. clip()'s `dot(n, P) <= c` with c = dot(n, cam)
  // + half (the offset is carried per plane in the fourth slot).
  const planes: Array<[number, number, number, number]> = [
    [vx[0], vx[1], vx[2], halfW],
    [-vx[0], -vx[1], -vx[2], halfW],
    [vy[0], vy[1], vy[2], halfH],
    [-vy[0], -vy[1], -vy[2], halfH],
  ];
  let poly: Array<[number, number]> = [[-400, -400], [400, -400], [400, 400], [-400, 400]];
  const clip = (nx: number, nz: number, c: number): void => {
    const out: Array<[number, number]> = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const fa = nx * a[0] + nz * a[1] - c;
      const fb = nx * b[0] + nz * b[1] - c;
      if (fa <= 0) out.push(a);
      if ((fa <= 0) !== (fb <= 0)) {
        const t = fa / (fa - fb);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    poly = out;
  };
  for (const [nx, ny, nz, half] of planes) {
    clip(nx, nz, nx * camera[0] + ny * camera[1] + nz * camera[2] + half);   // ground: y = 0
    if (poly.length === 0) break;
  }
  // The box SIZE must not depend on the arena clip: clipping makes the quad's extent change as the
  // camera walks past a wall, and a size that changes changes the TEXEL size, which re-aligns the
  // whole sampling grid — i.e. it would reintroduce the flicker this module exists to remove. The
  // unclipped frustum quad is a pure translation of a fixed shape, so its extent is constant while
  // walking. (It is also the larger of the two, so nothing that needs covering is lost.)
  const extent = { ax: bounds(poly, axes, 0), ay: bounds(poly, axes, 1) };
  // The CENTRE, on the other hand, should follow the part of the room the player can actually see:
  // looking over a wall, the useful centre is inside the arena, not out in the dark beyond it.
  // Each side is a separate half-plane — |x| <= H is NOT one, and treating it as one clipped the
  // polygon to nothing whenever the visible quad was wider than the arena.
  for (const [nx, nz, c] of [[1, 0, ARENA_HALF], [-1, 0, ARENA_HALF], [0, 1, ARENA_HALF], [0, -1, ARENA_HALF]] as const) {
    clip(nx, nz, c);
    if (poly.length === 0) break;
  }
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of poly) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  // An empty clip (the camera cannot see any of the room — possible in a degenerate viewport) falls
  // back to the origin so the fit stays finite; the box still covers the arena.
  const empty = poly.length === 0 || !Number.isFinite(x0);
  const mx = empty ? 0 : (x0 + x1) / 2;
  const mz = empty ? 0 : (z0 + z1) / 2;
  return {
    ax: extent.ax,
    ay: extent.ay,
    mid: [mx, mz],
    midA: mx * axes.x[0] + mz * axes.x[2],
    midB: mx * axes.y[0] + mz * axes.y[2],
    corners: poly.length,
  };
}

/** Project a ground polygon onto one of the light's lateral axes and return [min,max]. */
function bounds(poly: ReadonlyArray<readonly [number, number]>, axes: ShadowAxes, which: 0 | 1): [number, number] {
  const axis = which === 0 ? axes.x : axes.y;
  let lo = Infinity;
  let hi = -Infinity;
  for (const [x, z] of poly) {
    const v = x * axis[0] + z * axis[2];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

/**
 * Largest useful box half-extent for a given tallest caster: big enough to cover the whole arena in
 * LIGHT space (the arena's extent along the light's own axes, not its 76 units of width) plus the
 * off-screen throw margin. Once the camera can see the whole room, this is the box that covers it —
 * and it is the reason the fit does not grow without bound on a wide window.
 */
export function shadowHalfMaxFor(casterHeight: number, axes: ShadowAxes = shadowAxes()): number {
  const arenaA = ARENA_HALF * (Math.abs(axes.x[0]) + Math.abs(axes.x[2]));
  const arenaB = ARENA_HALF * (Math.abs(axes.y[0]) + Math.abs(axes.y[2]));
  return Math.max(arenaA, arenaB) + shadowMarginFor(casterHeight);
}

/**
 * Fit the key light's shadow box for this frame.
 *
 * The box SIZE comes only from the camera's frustum (scale/zoom/aspect/yaw) and never from the
 * player's position: sizing it off the player would make the texel grid breathe while walking, which
 * is the flicker this module exists to remove. The player position only says where the camera is
 * looking, and therefore where the box sits — and that offset is quantised to whole texels below.
 *
 * `yawDeg` (the 「摄像机水平角度」 setting) is deliberately part of the SIZE and not of the walk: a
 * rotated view quad has a different extent along the light's axes, so the box (and its texel size)
 * changes when the SETTING changes — never while walking, which is the invariant that matters.
 */
export function fitShadowBox(
  playerX: number, playerZ: number, scale: number, camZoom: number, aspect: number,
  casterHeight: number = SHADOW_CASTER_H_FALLBACK, axes: ShadowAxes = shadowAxes(),
  yawDeg: number = 0,
): ShadowFit {
  const span = visibleGroundSpans(playerX, playerZ, scale, camZoom, aspect, axes, yawDeg);
  // The margin has to cover casters that are off-screen but throw their shadow on-screen, so it
  // scales with the tallest caster; the cap keeps the box at the largest size that can still pay
  // for itself (see shadowHalfMaxFor).
  const margin = shadowMarginFor(casterHeight);
  const halfSpan = Math.max((span.ax[1] - span.ax[0]) / 2, (span.ay[1] - span.ay[0]) / 2);
  const half = Math.min(shadowHalfMaxFor(casterHeight, axes), Math.max(SHADOW_HALF_MIN, halfSpan + margin));
  const texel = (2 * half) / SHADOW_MAP_SIZE;

  // --- centre: the visible ARENA's midpoint, snapped to whole texels on the light's axes ---
  const mid = span.mid;
  const shiftA = snapToTexel(span.midA, texel) - span.midA;
  const shiftB = snapToTexel(span.midB, texel) - span.midB;
  const target: [number, number, number] = [
    mid[0] + shiftA * axes.x[0] + shiftB * axes.y[0],
    shiftA * axes.x[1] + shiftB * axes.y[1],
    mid[1] + shiftA * axes.x[2] + shiftB * axes.y[2],
  ];

  // --- depth window: every caster that could matter, measured from the (snapped) centre ---
  let uMin = Infinity;
  let uMax = -Infinity;
  for (const sx of [-ARENA_HALF, ARENA_HALF]) {
    for (const sz of [-ARENA_HALF, ARENA_HALF]) {
      for (const y of [0, casterHeight]) {
        const u = (sx - target[0]) * axes.z[0] + (y - target[1]) * axes.z[1] + (sz - target[2]) * axes.z[2];
        if (u < uMin) uMin = u;
        if (u > uMax) uMax = u;
      }
    }
  }
  // Put the light where the nearest caster sits at depth 1; the window then spans exactly the
  // arena's depth extent, so the depth range — and with it the bias conversion below — stays
  // constant no matter where the player stands.
  const lightDistance = uMax + 1;
  const near = 1;
  const far = lightDistance - uMin;
  const light: [number, number, number] = [
    target[0] + axes.z[0] * lightDistance,
    target[1] + axes.z[1] * lightDistance,
    target[2] + axes.z[2] * lightDistance,
  ];

  // --- bias: the acne margin, expressed in texels and converted into three's units ---
  const bias = -(SHADOW_BIAS_TEXELS * texel * SHADOW_SLOPE_WORST) / (far - near);
  const normalBias = SHADOW_NORMAL_TEXELS * texel;

  return { target, light, half, near, far, texel, bias, normalBias };
}
