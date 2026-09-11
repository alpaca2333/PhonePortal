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

/** Which axes a stick reports on. The look pad is 'x': it only turns the camera. */
export type StickAxis = 'both' | 'x';

/**
 * Where a control's zero point lives.
 *
 *   'centre' — a normal joystick with a FIXED BASE: the offset is measured from the element's centre,
 *              so the painted base is where "no input" is and the knob shows the current push.
 *   'press'  — a PRESS-ANCHORED control (the look pad): the finger's landing point IS the zero, and
 *              the offset is measured from there for as long as the finger is down.
 *
 * WHY 'press' EXISTS (real-device bug): the look pad is a large transparent rectangle, and with a
 * centre origin every press produced a step — touching 80px off-centre meant the reading jumped
 * straight to ~0.9 and the whole view snapped to a new angle before the finger had moved at all
 * (「每次按右边区域都会有朝向跳变」). Measuring from the press point makes the input start at exactly
 * zero wherever you touch, so entering the pad cannot change the camera by itself.
 */
export type StickOrigin = 'centre' | 'press';

/**
 * Travel (px) for a press-anchored control: how far the finger must drag for a full-deflection
 * reading. A FIXED distance, not a fraction of the element, because the element is no longer the
 * reference — "full push" has to mean the same gesture wherever you happened to land, in either
 * orientation, at any pad size. 90px is a comfortable one-thumb drag on a phone.
 */
export const PRESS_TRAVEL_PX = 90;


/**
 * Constrain a knob offset to the axes the stick actually reads.
 *
 * WHY THE KNOB IS LOCKED AND NOT JUST IGNORED: the right stick drives the camera yaw, and only its
 * horizontal component is used. If the knob still slid freely up and down, the control would promise
 * an input it does not have — the finger would drag vertically and the view would not move, which
 * reads as a broken stick. Locking the knob to the horizontal axis makes "left/right only" visible.
 *
 * Deliberately a pure function of the offset (not of the raw pointer): the vertical component is
 * dropped AFTER the circular clamp in `stickOffset`, so the horizontal reach is still the full
 * travel and the knob cannot creep diagonally.
 */
export function axisLockOffset(offset: Vec2, axis: StickAxis): Vec2 {
  return axis === 'x' ? v2(offset.x, 0) : offset;
}

