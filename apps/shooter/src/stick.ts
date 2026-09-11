// Pure joystick geometry — no DOM, so it runs in Node (see scripts/verify-stick.mjs).
//
// WHY THIS IS A SEPARATE MODULE: the stick's size and position are user settings (see
// settings.ts / settingsPanel.ts). Keeping the math here proves — and lets us test — that the
// input behaves identically at ANY diameter and ANY position: travel is derived from the
// measured element size at pointer-down, and the reported direction is the clamped offset
// divided by that same travel, so |dir| is always <= 1 and exactly 1 at the rim.
import { Vec2, v2, scale, clampLen } from './math2.js';

/**
 * Knob travel as a fraction of the measured diameter. 0.42 * 148px = 62.16px, i.e. the same
 * feel as the original hardcoded 62px, but now valid for every size the user picks.
 */
export const TRAVEL_RATIO = 0.42;

/** Never let a tiny stick (or a 0-width layout) produce a degenerate travel. */
export const MIN_TRAVEL = 8;

export function travelForSize(sizePx: number): number {
  return Math.max(MIN_TRAVEL, sizePx * TRAVEL_RATIO);
}

/** Pointer position relative to the stick centre, clamped to the travel radius. */
export function stickOffset(cx: number, cy: number, px: number, py: number, travel: number): Vec2 {
  return clampLen(v2(px - cx, py - cy), travel);
}

/** Normalized stick direction: length 0 at the centre, 1 at (and beyond) the rim. */
export function dirFromOffset(offset: Vec2, travel: number): Vec2 {
  return travel > 0 ? scale(offset, 1 / travel) : v2(0, 0);
}

/**
 * Right-stick deadzone as a fraction of full travel. Below it the stick counts as "held in
 * place" and the sim auto-aims at the nearest enemy; at or above it the stick aims manually.
 * Was 0.3, doubled to 0.6 on request: with 0.3 the auto-aim band was so narrow that a slight
 * thumb slip (or a smaller stick size) flipped you into manual aiming, which felt like the
 * auto-aim had stopped working. 0.6 means the inner 60% of the travel is "auto-aim territory".
 */
export const AIM_DEADZONE = 0.6;

/** True when the right stick is pushed far enough to aim manually (otherwise auto-aim). */
export function isManualAim(dir: Vec2): boolean {
  return Math.hypot(dir.x, dir.y) > AIM_DEADZONE;
}
