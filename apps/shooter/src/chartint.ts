// Per-character surface tinting: the hit flash and the burn glow, as pure colour math.
//
// WHY THIS IS ITS OWN MODULE
// --------------------------
// `toon.ts` owns the materials but imports three, so nothing in it can run in Node. The *decision* of
// what a tinted surface looks like is exactly the kind of thing this project asserts without a GPU, so
// it lives here as plain functions over RGB triples (same pattern as camera.ts / grade.ts).
//
// THE BUG THIS EXISTS FOR (real-device feedback: 「龙息弹显示的有点怪，外面一圈是红色亮光，中间反而变
// 黑了」)
// ---------------------------------------------------------------------------------------------
// The dragon-breath shells set enemies on fire. Burn flames are UNLIT additive quads (correct: they
// must stay crisp and they are drawn before the fog/grade), and the only real lights in the scene are
// the two directionals plus a capped pool of point lights that sit on *projectiles*. So while an enemy
// burns, nothing at all lights its body — and with the ambient light at 0 (an explicit user request)
// its unlit surfaces are essentially black. The result is a ring of bright additive fire around a
// black silhouette: the fire cannot light the thing it is burning, and the opaque body occludes the
// flames behind it.
//
// The fix is to make the burning body SELF-LIT: an emissive tint proportional to how many burn stacks
// it carries. That is how fire reads anyway (the fuel glows from inside), it costs one lerp per
// material per frame, and it needs no extra lights (the point-light pool is capped for a reason).
//
// ORDER MATTERS: burn first, then flash. The burn glow is the resting state of a burning enemy; a hit
// has to stay readable on top of it (CONFIG.hitFlashTime = 0.1 s).

export type RGB = [number, number, number];

/** The surface turns red on a hit; `HIT_FLASH_EMISSIVE` is how much of that red is self-lit. */
export const HIT_FLASH_COLOR = 0xff2222;
export const HIT_FLASH_EMISSIVE = 0.6;

/**
 * The burn glow: a hot orange the burning body is tinted toward, and how much of it becomes emissive.
 * 0.55 in LINEAR space encodes to roughly 0.77 on screen for the red channel, i.e. unmistakably
 * "on fire" without turning the character into a white blob (the flame quads in front of it are
 * brighter still, which keeps the fire reading as the source).
 */
export const BURN_GLOW_COLOR = 0xff7a1e;
export const BURN_GLOW_EMISSIVE = 0.55;
/** How much of the burn glow goes into the base COLOUR (the rest is emissive). Kept below 1 so a
 *  burning enemy still reads as the same character instead of a flat orange silhouette. */
export const BURN_GLOW_COLOR_MIX = 0.55;

/** Burn stacks at which the glow is fully developed. 1 stack = a smoulder, 3 = ablaze. */
export const BURN_GLOW_STACKS = 3;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** rgb 0..1 from an sRGB hex, as plain floats (three does the real conversion; this is for the math
 *  and the Node tests, which is why the tests compare against `Color.setHex` in the vendored three). */
export function rgbFromHex(hex: number): RGB {
  return [((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255];
}

/** How glowing a body with `stacks` burn stacks is: 0 (not burning) .. 1 (fully ablaze). */
export function burnGlowFor(stacks: number, full: number = BURN_GLOW_STACKS): number {
  if (!Number.isFinite(stacks) || stacks <= 0) return 0;
  const f = Number.isFinite(full) && full > 0 ? full : BURN_GLOW_STACKS;
  return clamp01(stacks / f);
}

export interface CharTint {
  /** Surface colour, 0..1 per channel. */
  color: RGB;
  /** Self-lit colour added on top of the shaded result, 0..1 per channel. */
  emissive: RGB;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const lerpRgb = (a: RGB, b: RGB, t: number): RGB => [
  lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t),
];

/**
 * The tinted surface for one character material. `baseColor`/`baseEmissive` are the material's
 * untouched values (captured once at spawn), `flashT` the hit flash 1..0 and `burnT` the burn glow
 * 0..1 (see burnGlowFor).
 *
 * flashT = 0 / burnT = 0 returns the base EXACTLY, which is what makes "the enemy looks normal when
 * nothing is happening to it" an asserted property rather than an accident.
 */
export function charTint(
  baseColor: RGB, baseEmissive: RGB, flashT: number, burnT: number,
): CharTint {
  const b = clamp01(burnT);
  const f = clamp01(flashT);
  const burnCol = rgbFromHex(BURN_GLOW_COLOR);
  const flashCol = rgbFromHex(HIT_FLASH_COLOR);
  let color: RGB = baseColor;
  let emissive: RGB = baseEmissive;
  if (b > 0) {
    color = lerpRgb(color, burnCol, b * BURN_GLOW_COLOR_MIX);
    emissive = lerpRgb(emissive, burnCol, b * BURN_GLOW_EMISSIVE);
  }
  if (f > 0) {
    color = lerpRgb(color, flashCol, f);
    emissive = lerpRgb(emissive, flashCol, f * HIT_FLASH_EMISSIVE);
  }
  return { color, emissive };
}
