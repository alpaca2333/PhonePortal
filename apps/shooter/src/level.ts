// The arena: the cover layout plus the queries that make cover matter.
//
// A leaf module by design — no three, no DOM, no game.ts — so `scripts/verify-cover.mjs` can assert
// both the layout and the collision maths in plain Node. `game.ts` owns the entities; this file owns
// only "what is solid" and "what blocks a line".
import { Aabb2, Vec2, circleAabbResolve, segmentAabbHit } from './math2.js';

/** One piece of cover: an axis-aligned footprint plus the height the renderer lifts it to. */
export interface Obstacle extends Aabb2 {
  /** visual height in world units (1 world unit ≈ 29 CSS px at the reference framing, see config.ts) */
  h: number;
}

/**
 * The arena layout, HAND-AUTHORED rather than generated.
 *
 * WHY NOT RANDOM: a generated layout cannot be asserted (tests would need a fixed seed), can
 * silently seal the player into a pocket, and produces sightlines nobody designed. A fixed list is
 * level design whose PROPERTIES the verification script can check.
 *
 * WHY THESE POSITIONS (76x76 arena, ARENA_HALF = 38, origin = the player's spawn):
 *   - **nothing within radius 10.8 of the origin.** The spawn must be open; melee reach is 3.4; and
 *     the weapon suites place test targets 2-5 units from the origin. The nearest inner edge here is
 *     the cover ring's, at 12.5 - 1.7 = 10.8.
 *   - **a broken cover ring at radius 12.5** — the gunners' preferred engagement range, with gaps on
 *     the diagonals (between the ring piece's corner (4.5, 10.8) and the next piece's corner
 *     (10.8, 4.5), i.e. a ~6 unit opening) so it can always be flanked. Cover placed where the
 *     fighting actually happens is the whole point; cover parked in empty space is scenery.
 *   - **quadrant crates at (+-18, +-18)** to break the four long diagonals, pushed out from the ring
 *     so the corridor between the ring's outer corner and the crate stays walkable.
 *   - **mid-field short walls at (+-13, +-24)** so the north and south approaches have two flanks.
 *   - **axis walls at +-26 on each axis** split the map into an inner and an outer ring; each is 19
 *     units long with its ends ~9.5 units from the centre, so the two walls of a pair leave a wide
 *     diagonal corridor (the old central gap, made generous enough for the bigger footprints).
 *   - **tall blocks in the four corners** as landmarks and as hard cover at the map's edge.
 *
 * SIZES: this is the second layout. The first dressed 20 small boxes (a 6x2.4 ring piece, 4x4
 * crates) with waist-high furniture, and the feedback was that the obstacles read as too small —
 * measurably so: some boxes ended up with a single prop in them (2% of their area filled) and the
 * props themselves were ~0.9 units tall against a 2.0-unit character. So every footprint here is
 * roughly 1.4-1.5x the old one (the ring piece is 9x3.4, the crates 5.6x5.6, the axis walls 19x3.4,
 * the corners 6.8x6.8) and props.ts now dresses them at COVER_SCALE with a chest-height target, so
 * what the player sees matches what the collision actually is. Positions moved out by one ring to
 * pay for the extra width; the structure (ring + diagonal gaps + broken wall lines + corner
 * landmarks) and every invariant below are unchanged.
 *
 * The layout must satisfy (all asserted in scripts/verify-cover.mjs): inside the arena with margin,
 * no pair overlapping, the origin clear, and NO SEALED POCKETS (a flood fill of free space from the
 * origin has to reach essentially all of it).
 */
export const OBSTACLES: readonly Obstacle[] = [
  // Broken cover ring at the gunners' engagement range (radius 12.5, gaps on the diagonals).
  { x: 0, y: 12.5, hw: 4.5, hh: 1.7, h: 1.7 },
  { x: 0, y: -12.5, hw: 4.5, hh: 1.7, h: 1.7 },
  { x: 12.5, y: 0, hw: 1.7, hh: 4.5, h: 1.7 },
  { x: -12.5, y: 0, hw: 1.7, hh: 4.5, h: 1.7 },
  // Quadrant crates: break the long diagonals (pushed out to keep the ring->crate corridor open).
  { x: 18, y: 18, hw: 2.8, hh: 2.8, h: 1.6 },
  { x: -18, y: 18, hw: 2.8, hh: 2.8, h: 1.6 },
  { x: 18, y: -18, hw: 2.8, hh: 2.8, h: 1.6 },
  { x: -18, y: -18, hw: 2.8, hh: 2.8, h: 1.6 },
  // Mid-field short walls: two flanking routes to the north and south. Their inner end sits 2.9
  // units out from the axis wall's end, i.e. a doorway a player (radius 0.8) can actually use —
  // a 1-unit "gap" would look like an opening and behave like a wall.
  { x: 16, y: 24, hw: 3.6, hh: 1.3, h: 1.9 },
  { x: -16, y: 24, hw: 3.6, hh: 1.3, h: 1.9 },
  { x: 16, y: -24, hw: 3.6, hh: 1.3, h: 1.9 },
  { x: -16, y: -24, hw: 3.6, hh: 1.3, h: 1.9 },
  // Axis walls: inner ring / outer ring, with a wide diagonal corridor between each pair.
  { x: 26, y: 0, hw: 1.7, hh: 9.5, h: 2.2 },
  { x: -26, y: 0, hw: 1.7, hh: 9.5, h: 2.2 },
  { x: 0, y: 26, hw: 9.5, hh: 1.7, h: 2.2 },
  { x: 0, y: -26, hw: 9.5, hh: 1.7, h: 2.2 },
  // Corner landmarks: the tallest cover, at the map's edge.
  { x: 30, y: 30, hw: 3.4, hh: 3.4, h: 2.6 },
  { x: -30, y: 30, hw: 3.4, hh: 3.4, h: 2.6 },
  { x: 30, y: -30, hw: 3.4, hh: 3.4, h: 2.6 },
  { x: -30, y: -30, hw: 3.4, hh: 3.4, h: 2.6 },
];

/**
 * Does a circle of radius `r` at `p` overlap any obstacle?
 *
 * Uses the same Minkowski box as `resolveCover`, so "fits" and "gets pushed out" can never disagree
 * — spawn validation and collision share one definition of solid.
 */
export function overlapsCover(
  p: Vec2, r: number, obstacles: readonly Obstacle[] = OBSTACLES, pad = 0,
): boolean {
  const rr = r + pad;
  for (let i = 0; i < obstacles.length; i++) {
    const o = obstacles[i];
    if (p.x > o.x - o.hw - rr && p.x < o.x + o.hw + rr
      && p.y > o.y - o.hh - rr && p.y < o.y + o.hh + rr) return true;
  }
  return false;
}

/**
 * Push `pos` out of every obstacle it overlaps, in place. Iterating the whole list once is enough
 * because the layout is asserted to have no overlapping pairs — a position can only be inside one
 * box, so a single corrective pass cannot push it into another.
 *
 * @returns true when any correction was applied.
 */
export function resolveCover(
  pos: Vec2, r: number, obstacles: readonly Obstacle[] = OBSTACLES,
): boolean {
  let moved = false;
  for (let i = 0; i < obstacles.length; i++) {
    if (circleAabbResolve(pos, r, obstacles[i])) moved = true;
  }
  return moved;
}

/**
 * How much cover is SHRUNK for segment queries (bullets, line of sight), in world units.
 *
 * WHY THIS IS NOT ZERO: collision resolution parks an entity EXACTLY on a cover face
 * (`circleAabbResolve` treats touching as non-overlapping, which is what stops the jitter). So a
 * shot fired while hugging a wall starts precisely on that wall's boundary, and an exact test reads
 * that as "already inside" — shooting ALONG a wall you are leaning on would destroy your own round,
 * and a gunner leaning on a wall would consider itself permanently blind. Shrinking cover by 1 cm
 * makes contact-touching a miss while genuine penetration still hits: 1 cm is far below any
 * gameplay-relevant thickness (the thinnest cover here is 1.6 units) and far above float noise.
 */
export const SEGMENT_SKIN = -0.01;

/** First obstacle the segment `a`-`b` enters: its hit parameter (0..1) and the box, else null. */
export function firstCoverHit(
  a: Vec2, b: Vec2, obstacles: readonly Obstacle[] = OBSTACLES, pad = SEGMENT_SKIN,
): { t: number; box: Obstacle } | null {
  let best: { t: number; box: Obstacle } | null = null;
  for (let i = 0; i < obstacles.length; i++) {
    const t = segmentAabbHit(a, b, obstacles[i], pad);
    if (t < 0) continue;
    if (best === null || t < best.t) best = { t, box: obstacles[i] };
  }
  return best;
}

/**
 * Is the straight line `a`-`b` interrupted by cover? THE line-of-sight test: enemy gunners use it to
 * decide whether they may fire, the melee sweep uses it so a sword cannot cut through a wall, and
 * the rocket's blast uses it so the AoE cannot splash around a corner.
 *
 * Defaults to the `SEGMENT_SKIN` shrink — see that constant for why an exact test is wrong here.
 */
export function lineBlocked(
  a: Vec2, b: Vec2, obstacles: readonly Obstacle[] = OBSTACLES, pad = SEGMENT_SKIN,
): boolean {
  return firstCoverHit(a, b, obstacles, pad) !== null;
}
