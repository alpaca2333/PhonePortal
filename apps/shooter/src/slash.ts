// The melee swing crescent: sim state + the PURE math that turns it into a frame.
//
// WHY THIS IS ITS OWN MODULE (and why it imports only config.ts):
//   * the crescent's motion has to be provable without a browser. `scripts/verify-melee.mjs`
//     imports this file and asserts the geometry claims below with plain arithmetic — no three,
//     no DOM, no canvas. The renderer only replays what is computed here;
//   * gameplay timing must not live in the renderer. game.ts owns exactly one number (`t`);
//     everything a frame needs is derived from `(aim, arc, reach, dir, t, max)`.
//
// THE ONE INVARIANT THAT MATTERS: the drawn crescent never claims area the hit test did not
// grant. The melee sweep damages everything within `reach + enemy.r` of the attacker and within
// +/-`arc/2` of the facing (see weapons.ts). So the crescent's outer radius animates UP TO
// `reach` but never past it, and the union of the crescent's angular footprint over the whole
// swing is exactly the damage cone — no more (an oversized slash would be a lie the player can
// see) and no less (the visual has to communicate the 180 degrees they actually get).
import { CONFIG } from './config.js';

export interface SlashFx {
  /** attacker centre when the swing started (world XZ) */
  x: number;
  z: number;
  /** facing at the moment the swing started (radians) */
  aim: number;
  /** total arc swept, i.e. the width of the damage cone (radians) */
  arc: number;
  /** outer radius of the crescent, i.e. the weapon's reach (world units) */
  reach: number;
  /** +1 = the leading edge travels toward increasing angles, -1 = decreasing (alternates) */
  dir: 1 | -1;
  /** seconds elapsed since the swing started */
  t: number;
  /** total duration of the visual sweep (seconds) */
  max: number;
  /** accumulator for slipstream emission (see GameSim.update); sim-internal */
  emitAcc: number;
}

/** Start a swing. `time` is the weapon's `swingTime` (data), never a hardcoded constant. */
export function makeSlash(
  x: number, z: number, aim: number, reach: number, arc: number, dir: 1 | -1, time: number,
): SlashFx {
  return { x, z, aim, arc, reach, dir, t: 0, max: time, emitAcc: 0 };
}

/**
 * Eased 0..1 sweep progress: **fast out of the wind-up, then decelerating** (ease-out power curve).
 *
 * This used to be smoothstep (ease-in-out), which was wrong for a heavy blade: the slow START is
 * most of what "没有力量感" was. A powerful slash does not wind up into the swing — it snaps the
 * blade out at full speed and spends the rest of the swing DECELERATING through the follow-through,
 * so nearly all of the arc is covered in the first frames and the tail creeps to a stop:
 *
 *     p(u) = 1 - (1 - u)^k        k = CONFIG.slashEase
 *
 * At k = 3 that is 58% of the arc in the first quarter of the time, 87.5% by halfway, and the last
 * 12.5% spread over the entire second half (the follow-through that reads as weight). The exponent
 * is a config knob because "power" is a taste call, and `scripts/verify-melee.mjs` pins the shape:
 * front-loaded, strictly decelerating, never linear.
 */
export function slashProgress(t: number, max: number): number {
  if (!(max > 0)) return 1;
  let u = t / max;
  if (u < 0) u = 0;
  else if (u > 1) u = 1;
  return 1 - Math.pow(1 - u, CONFIG.slashEase);
}

/**
 * The crescent's own angular width (radians). Clamped to `arc` so a narrow-arc melee weapon can
 * never be drawn wider than the cone it damages.
 */
export function slashSpan(arc: number): number {
  return Math.min(CONFIG.slashSpan, arc);
}

/**
 * Leading-edge angle of the crescent (radians) at the swing's current time.
 *
 * The sweep is offset inward by one crescent width: at `t = 0` the crescent's TAIL sits exactly on
 * the cone's start edge, and at `t = max` its LEADING EDGE sits exactly on the cone's end edge.
 * That makes the union of the crescent's footprint over the swing equal to the damage cone, which
 * is the invariant in the header — an un-offset sweep would fling the first frames of the trail
 * outside the area the player can actually hit.
 */
export function slashAngle(s: SlashFx): number {
  const half = s.arc * 0.5;
  const span = slashSpan(s.arc);
  const start = s.aim - (half - span) * s.dir;
  return start + (s.arc - span) * s.dir * slashProgress(s.t, s.max);
}

/** Trailing-edge angle of the crescent (radians); always `slashSpan` behind the leading edge. */
export function slashTailAngle(s: SlashFx): number {
  return slashAngle(s) - slashSpan(s.arc) * s.dir;
}

/**
 * Brightness multiplier, 1 -> 0.
 *
 * Holds at full for the first `slashHold` of the sweep (the blade is bright while it travels) and
 * then dissolves quadratically, so the trail lingers rather than popping off at exactly `max`.
 */
export function slashAlpha(s: SlashFx): number {
  const u = s.max > 0 ? Math.min(1, Math.max(0, s.t / s.max)) : 1;
  const hold = CONFIG.slashHold;
  if (u <= hold) return 1;
  const k = (u - hold) / (1 - hold);
  return 1 - k * k;
}

/**
 * Radius multiplier for the crescent, `slashRadiusStart` -> 1.
 *
 * The blade whips outward as it travels, which is what stops the effect from reading as a flat
 * decal rotating around a pivot. It EXPANDS TO 1 and stops there: the outer edge lands on
 * `reach` exactly when the swing ends, so the effect never overstates the weapon's range.
 */
export function slashRadiusScale(s: SlashFx): number {
  return CONFIG.slashRadiusStart + (1 - CONFIG.slashRadiusStart) * slashProgress(s.t, s.max);
}

/** True while the crescent is still being drawn. */
export function slashAlive(s: SlashFx): boolean {
  return s.t < s.max;
}

// ---------------------------------------------------------------------------------------------
// Crescent geometry
// ---------------------------------------------------------------------------------------------
// The vertex data lives here (and not in render.ts) for one reason: it is the part of the effect
// most likely to be silently wrong — a mirrored envelope, an inverted winding or a NaN would only
// show up as "the slash looks a bit off" on a real device, which is exactly the class of bug this
// repo verifies on the CPU instead. Returning plain arrays keeps it assertable in node with no
// three and no canvas; render.ts wraps the result in a BufferGeometry.
//
// The two envelopes multiplied into the vertex colour are the whole soft-edge story (this game
// ships no textures and no custom shaders): the material is ADDITIVE, and additive black
// contributes nothing, so "fade the colour to black" IS an alpha ramp.
/** Radius fraction where the blade band is brightest (radial envelope peaks here). */
export const CRESCENT_PEAK = 0.72;
/** Exponent of the angular envelope: 0 at the tail, 1 at the leading edge. */
export const CRESCENT_ANG_POW = 1.7;

export interface CrescentMesh {
  /** xyz triples, in the XZ plane (y = 0), radius `inner`..1, leading edge at local angle 0 */
  positions: number[];
  /** rgb triples: the baked radial x angular envelope, already multiplied */
  colors: number[];
  indices: number[];
}

/**
 * Build the crescent as a unit mesh: leading edge at local angle `0`, tail at `-span`, outer radius
 * exactly 1 (so the instance scale carries the weapon's reach), inner radius `inner`.
 *
 * Winding is arbitrary — the material is DoubleSide — so the only structural requirement is that
 * every index is in range and the grid is fully covered.
 */
export function buildCrescent(span: number, inner: number, angSeg: number, radSeg: number): CrescentMesh {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const cols = angSeg + 1;
  for (let r = 0; r <= radSeg; r++) {
    const rt = r / radSeg;
    const radius = inner + (1 - inner) * rt;
    // Asymmetric bump peaking at CRESCENT_PEAK: reaches exactly 0 at BOTH rt = 0 and rt = 1, so the
    // ribbon has no hard silhouette on either side.
    const d = rt < CRESCENT_PEAK
      ? (rt - CRESCENT_PEAK) / CRESCENT_PEAK
      : (rt - CRESCENT_PEAK) / (1 - CRESCENT_PEAK);
    const radial = Math.max(0, 1 - d * d);
    for (let a = 0; a <= angSeg; a++) {
      const at = a / angSeg;                     // 0 tail .. 1 leading edge
      const ang = -span + span * at;
      const v = radial * Math.pow(at, CRESCENT_ANG_POW);
      positions.push(Math.cos(ang) * radius, 0, Math.sin(ang) * radius);
      colors.push(v, v, v);
    }
  }
  for (let r = 0; r < radSeg; r++) {
    for (let a = 0; a < angSeg; a++) {
      const i0 = r * cols + a;
      indices.push(i0, i0 + cols, i0 + 1, i0 + 1, i0 + cols, i0 + cols + 1);
    }
  }
  return { positions, colors, indices };
}
