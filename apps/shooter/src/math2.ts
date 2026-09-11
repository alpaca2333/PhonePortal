// Pure 2D math helpers (no three dependency) so the game sim runs in Node too.
export interface Vec2 { x: number; y: number; }

export const v2 = (x = 0, y = 0): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const norm = (a: Vec2): Vec2 => {
  const l = len(a);
  return l > 1e-6 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 };
};
export const clampLen = (a: Vec2, max: number): Vec2 => {
  const l = len(a);
  return l > max ? scale(a, max / l) : a;
};
/**
 * Closest point to `p` on the segment `a`-`b` (clamped to the endpoints).
 * Used for swept bullet collision: a pellet can move further in one frame (1.5 units at
 * 60fps) than the hit radius (0.88), so testing only its final position lets it tunnel
 * straight through a point-blank enemy.
 */
export const segClosest = (a: Vec2, b: Vec2, p: Vec2): Vec2 => {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const l2 = abx * abx + aby * aby;
  if (l2 < 1e-12) return { x: a.x, y: a.y };
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return { x: a.x + abx * t, y: a.y + aby * t };
};
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const angleOf = (a: Vec2): number => Math.atan2(a.y, a.x);

// ---------------------------------------------------------------------------------------------
// Axis-aligned box primitives — the collision layer for level cover.
//
// WHY AABB AND NOT AN OBB/CAPSULE: cover here is crates and low walls seen from a fixed 3/4
// overhead camera. Axis-aligned rectangles are the shape the player expects, and they keep both
// queries below to a handful of compares. Rotated boxes would need OBB maths for no gameplay gain
// at this camera angle.
//
// NOTE ON `y`: the sim is 2D and `Vec2.y` carries the world's Z axis (the same convention
// `game.ts` uses for every position). An `Aabb2` is therefore a footprint on the ground plane;
// `render.ts` is the only place that turns one into 3D by pairing it with a height.
// ---------------------------------------------------------------------------------------------
export interface Aabb2 {
  /** centre on the world X axis */
  x: number;
  /** centre on the world Z axis (carried in `Vec2.y`) */
  y: number;
  /** half-extent along X */
  hw: number;
  /** half-extent along Z */
  hh: number;
}

/**
 * Push `pos` out of `box` if it overlaps, treating the circle as a point against a box grown by
 * `r` (the standard Minkowski approximation for circle-vs-AABB).
 *
 * The push is along the axis of LEAST penetration, and that choice is what makes an entity SLIDE
 * along a wall instead of sticking to it: walking into a wall's face has a tiny penetration along
 * the wall's normal and a huge one along its length, so the entity is nudged straight out and keeps
 * its tangential motion for free — no contact normals, no separate slide pass.
 *
 * @returns true when the position was corrected (asserted in scripts/verify-cover.mjs).
 */
export function circleAabbResolve(pos: Vec2, r: number, box: Aabb2): boolean {
  const minX = box.x - box.hw - r;
  const maxX = box.x + box.hw + r;
  const minY = box.y - box.hh - r;
  const maxY = box.y + box.hh + r;
  // Outside on any axis -> no overlap. Touching a face exactly is NOT a collision, which is what
  // keeps an entity resting against a wall from jittering every frame.
  if (pos.x <= minX || pos.x >= maxX || pos.y <= minY || pos.y >= maxY) return false;
  const left = pos.x - minX;
  const right = maxX - pos.x;
  const down = pos.y - minY;
  const up = maxY - pos.y;
  const mx = left < right ? left : right;
  const my = down < up ? down : up;
  if (mx < my) pos.x += left < right ? -left : right;
  else pos.y += down < up ? -down : up;
  return true;
}

/**
 * Closest point to `p` ON the box (clamped per axis) — its nearest surface point, not its centre.
 *
 * WHY THIS EXISTS: deciding whether a piece of cover is visible from a point by looking at the
 * box's CENTRE is wrong for elongated cover. The long walls here are 2 x 14 units, so a player
 * leaning on one has a clear view of the part in front of them while the centre is still around
 * the corner — using the centre would flicker the wall between lit and unlit as the player walks
 * past it. The nearest point is the part you are actually looking at (see render.ts cover dimming).
 *
 * `out` may be supplied to avoid allocating in the per-frame path; the default keeps the pure
 * two-argument call usable in tests (scripts/verify-cover.mjs).
 */
export function nearestPointOnAabb(p: Vec2, box: Aabb2, out: Vec2 = { x: 0, y: 0 }): Vec2 {
  const minX = box.x - box.hw;
  const maxX = box.x + box.hw;
  const minY = box.y - box.hh;
  const maxY = box.y + box.hh;
  out.x = p.x < minX ? minX : p.x > maxX ? maxX : p.x;
  out.y = p.y < minY ? minY : p.y > maxY ? maxY : p.y;
  return out;
}

/**
 * Intersection of the ray `origin + t * dir` (t >= 0) with the SEGMENT `a`-`b`, as `t` in the
 * units of `dir`, or -1 when it does not hit. `dir` is expected to be a unit vector when the
 * caller cares about world distances.
 *
 * WHY NOT `segmentAabbHit`: this is the query the visibility field needs (a ray against one
 * arbitrary edge of the visibility polygon, which is NOT axis-aligned). Derivation: solve
 * `origin + t*dir = a + u*(b-a)` by Cramer's rule; the denominator is the 2D cross product of
 * `dir` and the edge, so a parallel ray (denominator 0) is a clean miss rather than a division by
 * zero — including the fully degenerate edge `a === b`.
 *
 * `u` is checked with a small tolerance: a ray that grazes an endpoint exactly is a hit, which is
 * what makes the sector boundary continuous as the player walks along a wall.
 */
export function raySegmentHit(origin: Vec2, dir: Vec2, a: Vec2, b: Vec2): number {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const denom = dir.x * ry - dir.y * rx;
  if (Math.abs(denom) < 1e-12) return -1;
  const wx = a.x - origin.x;
  const wy = a.y - origin.y;
  const t = (wx * ry - wy * rx) / denom;
  if (t < 0) return -1;
  // Parameter of the hit along the edge; solved on whichever axis is larger to stay well
  // conditioned (the denominator guarantees the two are not both ~0).
  const u = Math.abs(rx) >= Math.abs(ry) ? (t * dir.x - wx) / rx : (t * dir.y - wy) / ry;
  if (u < -1e-9 || u > 1 + 1e-9) return -1;
  return t;
}

/**
 * First intersection of the segment `a`-`b` with `box` grown by `pad`, as a fraction of the segment
 * (0 = at `a`, 1 = at `b`), or -1 when the segment misses.
 *
 * Slab method. Returning the PARAMETER rather than a boolean is what lets callers place the impact
 * exactly: bullets use it for the spark position, line-of-sight queries only care that it is >= 0.
 * A segment starting inside the box reports 0, which is the honest answer ("blocked at the start")
 * and is what makes a muzzle pressed against a wall collide on its very first frame.
 */
export function segmentAabbHit(a: Vec2, b: Vec2, box: Aabb2, pad = 0): number {
  const minX = box.x - box.hw - pad;
  const maxX = box.x + box.hw + pad;
  const minY = box.y - box.hh - pad;
  const maxY = box.y + box.hh + pad;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  if (Math.abs(dx) < 1e-12) {
    if (a.x < minX || a.x > maxX) return -1;
  } else {
    let ta = (minX - a.x) / dx;
    let tb = (maxX - a.x) / dx;
    if (ta > tb) { const s = ta; ta = tb; tb = s; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return -1;
  }
  if (Math.abs(dy) < 1e-12) {
    if (a.y < minY || a.y > maxY) return -1;
  } else {
    let ta = (minY - a.y) / dy;
    let tb = (maxY - a.y) / dy;
    if (ta > tb) { const s = ta; ta = tb; tb = s; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return -1;
  }
  return t0;
}
