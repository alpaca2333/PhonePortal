// The player's field of view: which directions cover blocks, and how far the blocked region
// reaches. This is what makes "you cannot see there" READABLE on screen.
//
// WHY A PURE MODULE (no three, no DOM): the geometry here is the part of the feature that can be
// wrong in ways that matter — a shadow that does not line up with where bullets stop, a gap in the
// polygon, a sector list that overflows its pool and silently drops a shadow — and none of that
// needs a GPU to check. scripts/verify-vision.mjs cross-checks the polygon against `lineBlocked`
// on a ~23k-point grid, in Node.
//
// WHAT THIS FILE DOES **NOT** DO: it does not decide what is hidden. Enemy characters, bullets,
// aiming beams and health bars are hidden by calling the SAME `lineBlocked` predicate the sim uses
// (game.ts gunner fire gate, weapons.ts melee sweep), because gameplay visibility must agree with
// the simulation EXACTLY — see render.ts::visionVisible. The polygon below drives only two things:
// the darkness overlay's geometry, and a continuous fade factor for particles.
//
// WHY THE OVERLAY CAN BE DRAWN AT ALL (the one idea that makes this cheap): the polygon is
// STAR-SHAPED about the origin — every vertex is defined by a ray from the player — so for each
// angular sector its complement inside a bounding disc is EXACTLY the quadrilateral between the
// boundary chord and the disc rim. The occluded region is therefore a plain triangle list with no
// earcut, no hole-triangulation and no custom shader; and it contains geometry only where the
// player cannot see, so an unobstructed view costs nothing to darken.
import { Vec2, nearestPointOnAabb, raySegmentHit, segmentAabbHit } from './math2.js';
// Sharing SEGMENT_SKIN (rather than redeclaring -0.01) is what makes "what you can see" and "what
// your bullets hit" structurally the same query instead of two numbers that happen to match today.
// `Obstacle` (not the bare `Aabb2`) because the gating policy below forwards straight into
// `lineBlocked`: typing the cover list as the level's own cover type is what makes it impossible
// to hand this module a list the sim would disagree about. Only the footprint fields are read.
import { Obstacle, SEGMENT_SKIN, lineBlocked } from './level.js';

// ---------------------------------------------------------------------------------------------
// Tunables. Split by WHO consumes them:
//   * VISION_DIM_* are the slider contract — settings.ts imports them so the panel's range, the
//     clamp and the built-in default can never drift from each other (same pattern as camera.ts);
//   * the rest is consumed by render.ts / the tests.
// ---------------------------------------------------------------------------------------------

/**
 * Darkness applied to the occluded region, as the overlay material's opacity (0..1).
 *
 * This is the SINGLE strength knob, and 0 means "feature off": render.ts then hides the overlay
 * and skips every visibility query, which reproduces the pre-vision rendering exactly — a
 * rollback that needs no code change (and a performance escape hatch on a weak device).
 */
export const VISION_DIM_DEFAULT = 0.55;
export const VISION_DIM_MIN = 0;
export const VISION_DIM_MAX = 0.85;
export const VISION_DIM_STEP = 0.05;

/**
 * Clamp a stored/hand-edited value to the slider range; anything non-finite falls back to the
 * default. The single clamp shared by settings.ts (merge rules) and render.ts (the overlay), so a
 * bad `data/settings.json` cannot make the two disagree about what is applied.
 */
export function clampVisionDim(dim: number): number {
  if (typeof dim !== 'number' || !Number.isFinite(dim)) return VISION_DIM_DEFAULT;
  if (dim < VISION_DIM_MIN) return VISION_DIM_MIN;
  if (dim > VISION_DIM_MAX) return VISION_DIM_MAX;
  return dim;
}

/**
 * Width of the soft edge, in world units, measured OUTWARD from the occlusion boundary: alpha
 * ramps 0 -> full across it.
 *
 * WHY THE RAMP IS ON THE OUTSIDE and not at the boundary itself: a hard edge at this resolution
 * reads as aliasing, and the ground immediately behind a wall is largely hidden by the wall in
 * screen space anyway (at the reference pitch a 1.5-unit wall hides ~0.9 units of floor). The
 * region beyond the ramp is fully dark, so the message is not weakened.
 *
 * NOTE ON A LARGE RADIUS JUMP ACROSS ONE SECTOR: when two neighbouring sector boundaries differ a
 * lot in distance (a corner in front of a near wall), the band is skewed and the ground right
 * behind the NEAR wall is only partly darkened. That is bounded and harmless: the big jumps only
 * happen across the +-epsilon slivers that bracket a silhouette corner (~0.1 deg wide).
 */
export const VISION_FADE = 1.2;

/**
 * Enemies closer than this are always drawn, cover or no cover ("you can hear them").
 *
 * WHY THIS EXISTS: occlusion hides only what you can SEE. A melee chaser needs no line of sight to
 * walk at you, so without this it can hug the far side of a corner and touch you for full contact
 * damage with no warning at all. This radius is a fairness floor, not a vision model, which is why
 * scripts/verify-vision.mjs asserts it is larger than the contact threshold
 * (enemyR + playerR + 1.2) — an entity that can hurt you is always on screen.
 */
export const VISION_REVEAL_R = 6;

/** Boundary radius cap: past this every direction counts as fully visible. */
export const VISION_QUERY_R = 130;

/**
 * Uniform seed angles added before the obstacle corners. They guarantee (a) no sector spans more
 * than 2*pi/16 = 22.5 deg, so the chord between two boundary points never cuts back inside the
 * disc, and (b) a valid polygon when there are NO obstacles at all — the degenerate "single sector
 * of 2*pi" case, whose chord would be a point.
 */
export const VISION_SEEDS = 16;

/** Angular offset of the extra rays cast around each corner: the standard fix for a ray that
 * grazes a silhouette corner exactly and would otherwise let a shadow leak through a pixel. */
export const VISION_ANGLE_EPS = 1e-4;
/** Two angles closer than this are the same boundary (dedupe, so no zero-area sectors). */
export const VISION_ANGLE_MIN_GAP = 1e-6;
/** Floor for a boundary distance, so a degenerate zero-radius sector cannot exist. */
export const VISION_MIN_R = 0.05;

const TAU = Math.PI * 2;

/** Bring an angle into [0, 2*pi). */
export function wrapAngle(a: number): number {
  const r = a % TAU;
  return r < 0 ? r + TAU : r;
}

/**
 * A rebuilt-every-frame visibility polygon, pre-allocated so the per-frame path never allocates.
 *
 * Sector `i` covers the angular range `angles[i]` (inclusive) up to `angles[i + 1]` (exclusive),
 * wrapping from the last sector back to `angles[0] + 2*pi`. `dist[i]` is the occlusion boundary
 * distance along the sector's START direction, so the true boundary within a sector is the chord
 * between the two neighbouring boundary points — `visionFadeAt` intersects that chord, which is
 * what keeps the query and the drawn overlay identical.
 *
 * Mutated only by `rebuildVision`; every other reader treats the arrays as read-only.
 */
export interface VisionField {
  originX: number;
  originY: number;
  angles: Float32Array;
  dist: Float32Array;
  /** Precomputed unit direction of each sector start (cos/sin), so the renderer writes no trig. */
  dirX: Float32Array;
  dirY: Float32Array;
  /** Number of live sectors. */
  n: number;
  /** Pool capacity; `rebuildVision` never writes past it. */
  cap: number;
  /** Angles produced before dedupe — a test hook proving the cap was not hit (see verify-vision). */
  raw: number;
  /** Angle build/sort buffer (private; exposed only so the field is one allocation). */
  scratch: Float64Array;
}

/**
 * Allocate a field sized for `cap` sectors. `cap` must cover `VISION_SEEDS + 12 * obstacles` (four
 * corners, three rays each) or `rebuildVision` would have to drop boundaries — which is a silently
 * missing shadow, so scripts/verify-vision.mjs asserts `raw <= cap` for the real layout.
 */
export function createVisionField(cap: number): VisionField {
  const c = Math.max(cap, VISION_SEEDS + 2);
  return {
    originX: 0, originY: 0, n: 0, cap: c, raw: 0,
    angles: new Float32Array(c),
    dist: new Float32Array(c),
    dirX: new Float32Array(c),
    dirY: new Float32Array(c),
    scratch: new Float64Array(c),
  };
}

const _far: Vec2 = { x: 0, y: 0 };

/**
 * Rebuild the polygon for `origin` against `obstacles`.
 *
 * The algorithm is the standard angular sweep over silhouette candidates:
 *   1. seed with VISION_SEEDS uniform angles;
 *   2. for every AABB corner, add the angle to that corner plus/minus VISION_ANGLE_EPS (the exact
 *      corner angle alone can graze and leak; the pair brackets the silhouette edge);
 *   3. sort, dedupe, then cast one ray per angle and keep the NEAREST cover hit, or VISION_QUERY_R.
 *
 * `pad` defaults to the sim's own SEGMENT_SKIN so a player parked against a wall (collision leaves
 * them exactly on its face) is not treated as being inside it — the same reason the sim shrinks
 * cover for line-of-sight queries.
 */
export function rebuildVision(
  field: VisionField, origin: Vec2, obstacles: readonly Obstacle[], pad = SEGMENT_SKIN,
): void {
  field.originX = origin.x;
  field.originY = origin.y;
  const scratch = field.scratch;

  let m = 0;
  for (let i = 0; i < VISION_SEEDS; i++) scratch[m++] = (i * TAU) / VISION_SEEDS;
  for (let i = 0; i < obstacles.length && m + 12 <= scratch.length; i++) {
    const o = obstacles[i];
    // ⚠️ THE CORNER ANGLES MUST COME FROM THE PADDED BOX, i.e. the exact box `segmentAabbHit`
    // clips against below. Deriving them from the raw footprint while the rays test a box shrunk
    // by SEGMENT_SKIN leaves the two angular spans disagreeing by the skin's angular width; the
    // sector that straddles the real corner then interpolates from "hit at 23 units" to "miss at
    // 130 units" across ~2 degrees instead of the 0.1-degree sliver, which LEAKS A SHADOW WEDGE
    // tens of units wide (caught by the 23k-point grid cross-check in scripts/verify-vision.mjs,
    // which is why that check compares against `lineBlocked` rather than eyeballing a picture).
    const x0 = o.x - o.hw - pad;
    const x1 = o.x + o.hw + pad;
    const y0 = o.y - o.hh - pad;
    const y1 = o.y + o.hh + pad;
    if (x1 <= x0 || y1 <= y0) continue;   // pad inverted the box (only possible if raw |pad| > hw)
    for (let c = 0; c < 4; c++) {
      const cx = (c & 1) === 0 ? x0 : x1;
      const cy = c < 2 ? y0 : y1;
      const a = Math.atan2(cy - origin.y, cx - origin.x);
      scratch[m++] = wrapAngle(a - VISION_ANGLE_EPS);
      scratch[m++] = wrapAngle(a);
      scratch[m++] = wrapAngle(a + VISION_ANGLE_EPS);
    }
  }

  const view = scratch.subarray(0, m);
  view.sort();
  // Compact in place (write cursor never overtakes the read cursor).
  let n = 0;
  for (let i = 0; i < m; i++) {
    const v = view[i];
    if (n === 0 || v - scratch[n - 1] > VISION_ANGLE_MIN_GAP) scratch[n++] = v;
  }
  // Guard the wrap-around sector too: angle 0 is a seed so this cannot normally fire, but a
  // sliver spanning the seam would be a sector with two nearly equal ends.
  if (n > 1 && scratch[0] + TAU - scratch[n - 1] <= VISION_ANGLE_MIN_GAP) n--;
  field.raw = n;
  if (n > field.cap) n = field.cap;   // defensive only; asserted unreachable for the real layout

  const angles = field.angles;
  const dist = field.dist;
  const dirX = field.dirX;
  const dirY = field.dirY;
  for (let i = 0; i < n; i++) {
    const a = scratch[i];
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    angles[i] = a;
    dirX[i] = dx;
    dirY[i] = dy;
    _far.x = origin.x + dx * VISION_QUERY_R;
    _far.y = origin.y + dy * VISION_QUERY_R;
    let best = VISION_QUERY_R;
    for (let j = 0; j < obstacles.length; j++) {
      const t = segmentAabbHit(origin, _far, obstacles[j], pad);
      if (t < 0) continue;
      const d = t * VISION_QUERY_R;
      if (d < best) best = d;
    }
    dist[i] = best < VISION_MIN_R ? VISION_MIN_R : best;
  }
  field.n = n;
}

const _o: Vec2 = { x: 0, y: 0 };
const _u: Vec2 = { x: 0, y: 0 };
const _pa: Vec2 = { x: 0, y: 0 };
const _pb: Vec2 = { x: 0, y: 0 };

/**
 * How much of a point is visible: 1 inside the visible polygon, ramping to 0 across `fade` world
 * units past its boundary, 0 beyond. The player's own position is 1 by definition.
 *
 * The boundary distance is found by intersecting the query ray with the sector's boundary CHORD,
 * not by interpolating the two sector distances in angle. The difference matters exactly where it
 * is visible: an angular interpolation bulges outward in the middle of a long chord, so the
 * darkness drawn on screen and the edge particles fade at would disagree.
 */
export function visionFadeAt(field: VisionField, x: number, y: number, fade = VISION_FADE): number {
  const n = field.n;
  if (n < 2) return 1;
  const dx = x - field.originX;
  const dy = y - field.originY;
  const r = Math.hypot(dx, dy);
  if (r < 1e-9) return 1;
  const a = wrapAngle(Math.atan2(dy, dx));
  const angles = field.angles;
  // Last sector whose start angle is <= a. `angles[0]` is 0 (a seed), so `a` never falls before it.
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (angles[mid] <= a) lo = mid;
    else hi = mid - 1;
  }
  const i0 = lo;
  const i1 = i0 + 1 < n ? i0 + 1 : 0;
  const d0 = field.dist[i0];
  const d1 = field.dist[i1];
  const ox = field.originX;
  const oy = field.originY;
  _o.x = ox;
  _o.y = oy;
  _u.x = dx / r;
  _u.y = dy / r;
  _pa.x = ox + field.dirX[i0] * d0;
  _pa.y = oy + field.dirY[i0] * d0;
  _pb.x = ox + field.dirX[i1] * d1;
  _pb.y = oy + field.dirY[i1] * d1;
  let d = raySegmentHit(_o, _u, _pa, _pb);
  // A miss means the chord is degenerate (overlapping sector ends); the conservative answer is the
  // nearer of the two, i.e. darken rather than leak.
  if (d < 0) d = d0 < d1 ? d0 : d1;
  if (r <= d) return 1;
  if (fade <= 0) return 0;
  const k = 1 - (r - d) / fade;
  return k > 0 ? k : 0;
}

/** Binary form of `visionFadeAt` (used by the tests, and by callers that want a hard cut). */
export function isPointVisible(field: VisionField, x: number, y: number): boolean {
  return visionFadeAt(field, x, y, 0) > 0;
}

// ---------------------------------------------------------------------------------------------
// The overlay MESH, as pure math.
//
// This lives here, and not in render.ts, for a blunt reason: there is no browser in this
// environment, so geometry written straight into a three.js buffer is geometry nobody ever checks.
// As a pure function it can be asserted — the vertex count, the ring radii, and (the one that
// matters) that the region drawn FULLY OPAQUE is exactly the region `visionFadeAt` calls fully
// occluded. scripts/verify-vision.mjs rasterises these triangles and compares.
//
// PER SECTOR: three rings at two angular ends -> 12 vertices -> 4 triangles, non-indexed.
//   ring 0 = the occlusion boundary (alpha 0), ring 1 = one VISION_FADE further out (alpha 1),
//   ring 2 = the VISION_QUERY_R rim (alpha 1). Every vertex colour is black, so with normal
//   blending the result is `dst *= (1 - alpha * opacity)`: the soft edge falls out of the geometry
//   with no shader and no texture.
//
// A sector whose two ends are both unoccluded has all three rings on the rim, i.e. four zero-area
// triangles — so an unobstructed view adds geometry that covers nothing.
// ---------------------------------------------------------------------------------------------

/** Vertices emitted per sector by `writeVisionGeometry`. */
export const VISION_VERTS_PER_SECTOR = 12;

/**
 * Write the overlay triangles for `field` into `out` (three floats per vertex, laid out for a
 * non-indexed `BufferAttribute`) at height `y`. Returns the number of VERTICES written, which the
 * caller passes to `setDrawRange`.
 *
 * Vertex 0, 1 and 3 of each sector sit on the boundary and get alpha 0; every other vertex is at or
 * past the fade ring and gets alpha 1 (the caller bakes that constant array once at init).
 */
export function writeVisionGeometry(field: VisionField, out: Float32Array, y: number): number {
  const n = field.n;
  if (n < 2) return 0;
  const ox = field.originX;
  const oz = field.originY;
  let v = 0;
  const pt = (ux: number, uy: number, r: number): void => {
    out[v++] = ox + ux * r;
    out[v++] = y;
    out[v++] = oz + uy * r;
  };
  for (let i = 0; i < n; i++) {
    const j = i + 1 < n ? i + 1 : 0;
    const u0x = field.dirX[i];
    const u0y = field.dirY[i];
    const u1x = field.dirX[j];
    const u1y = field.dirY[j];
    const d0 = field.dist[i];
    const d1 = field.dist[j];
    const e0 = Math.min(d0 + VISION_FADE, VISION_QUERY_R);   // the fade band's outer edge
    const e1 = Math.min(d1 + VISION_FADE, VISION_QUERY_R);
    // boundary -> fade ring (the soft edge)
    pt(u0x, u0y, d0);
    pt(u1x, u1y, d1);
    pt(u1x, u1y, e1);
    pt(u0x, u0y, d0);
    pt(u1x, u1y, e1);
    pt(u0x, u0y, e0);
    // fade ring -> rim (fully dark)
    pt(u0x, u0y, e0);
    pt(u1x, u1y, e1);
    pt(u1x, u1y, VISION_QUERY_R);
    pt(u0x, u0y, e0);
    pt(u1x, u1y, VISION_QUERY_R);
    pt(u0x, u0y, VISION_QUERY_R);
  }
  return n * VISION_VERTS_PER_SECTOR;
}

// ---------------------------------------------------------------------------------------------
// The GATING POLICY, kept here rather than inline in the renderer.
//
// These two functions are the entire gameplay decision of the vision system, and both are pure, so
// scripts/verify-vision.mjs can assert them against `lineBlocked` in Node — including the two
// invariants that make the feature fair:
//   * "no invisible shooter": the enemy gate is `lineBlocked` on the SAME segment the gunner's own
//     fire gate uses, and segment blocking is symmetric, so anything that can shoot you is visible;
//   * "no blind hit": anything inside VISION_REVEAL_R is visible regardless of cover.
// ---------------------------------------------------------------------------------------------

/**
 * Is `target` drawn? True when it is within the near reveal radius (you can hear it) OR the line
 * to it is clear — deliberately the SAME `lineBlocked` the sim uses for its own line-of-sight
 * queries, so "I can see it" and "I can hit it" cannot disagree.
 */
export function visibleWithReveal(
  origin: Vec2, target: Vec2, obstacles: readonly Obstacle[], pad = SEGMENT_SKIN,
): boolean {
  const dx = origin.x - target.x;
  const dy = origin.y - target.y;
  if (dx * dx + dy * dy <= VISION_REVEAL_R * VISION_REVEAL_R) return true;
  return !lineBlocked(origin, target, obstacles, pad);
}

const _near: Vec2 = { x: 0, y: 0 };

/**
 * Is a piece of cover lit? Judged on the part of it you are actually looking at — the NEAREST point
 * on its footprint, not its centre — so a long wall you are leaning on stays lit while the wall
 * behind it goes dark.
 */
export function coverVisible(
  origin: Vec2, box: Obstacle, obstacles: readonly Obstacle[], pad = SEGMENT_SKIN,
): boolean {
  return !lineBlocked(origin, nearestPointOnAabb(origin, box, _near), obstacles, pad);
}
