/**
 * Unit / scale heuristics — PURE math, no three.js, no DOM.
 *
 * WHY THIS EXISTS: Mixamo (and most DCC exports) hand you a character 100 units tall, because the FBX
 * unit is the centimetre while three.js — like glTF — treats 1 unit as 1 metre. Converted 1:1, that
 * character is a 180-metre giant, and the consumer (a game that spawns a 2-unit-tall player) shows it
 * as an eyeball-filling blob. The fix is one number, but it must be chosen honestly:
 *
 *   * `auto` compares the measured height against a threshold and MEASURES rather than guesses from
 *     the file name, so it works for any exporter, not just Mixamo;
 *   * it is a positive decision only — we never divide by an assumed "expected" height, because that
 *     would rescale a deliberately small prop (a 0.2-unit teacup) into a 1.8-unit monster. A model
 *     that is not clearly in centimetres is left exactly as it came.
 *   * `keep` (原样) exists for the case where the FBX really is in metres, or where the consumer
 *     wants to do its own normalization.
 *
 * The threshold is deliberately a wide band: a humanoid is 1.5–2.0 units in metres and 150–200 in
 * centimetres, so anything above 20 units is not a metre-scaled character, and anything below is not
 * a centimetre-scaled one. Both cases are asserted in scripts/verify-fbx2glb.mjs.
 */

export const SCALE_MODES = ['auto', 'keep', 'cm'] as const;
export type ScaleMode = (typeof SCALE_MODES)[number];

/** Units per metre in the centimetre convention. */
export const CM_PER_M = 100;
/** Above this many units of height, treat the file as centimetres. */
export const CM_HEIGHT_THRESHOLD = 20;

/** Is this height more plausibly centimetres than metres? */
export function looksLikeCentimetres(height: number): boolean {
  return Number.isFinite(height) && height > CM_HEIGHT_THRESHOLD;
}

export interface ScaleDecision {
  /** Multiplier to apply on export (1 = untouched). */
  scale: number;
  /** True when `auto` decided to divide by 100. */
  autoApplied: boolean;
  /** The measurement the decision was based on (world units, 0 when unknown). */
  height: number;
}

/**
 * Decide the export scale. `height` is the model's measured world height (Y extent) BEFORE scaling.
 * `mode` 'keep' and 'cm' ignore the measurement; 'auto' only fires above the threshold.
 */
export function resolveScale(mode: ScaleMode, height: number): ScaleDecision {
  const h = Number.isFinite(height) ? Math.abs(height) : 0;
  switch (mode) {
    case 'cm':
      return { scale: 1 / CM_PER_M, autoApplied: false, height: h };
    case 'keep':
      return { scale: 1, autoApplied: false, height: h };
    case 'auto':
    default:
      return looksLikeCentimetres(h)
        ? { scale: 1 / CM_PER_M, autoApplied: true, height: h }
        : { scale: 1, autoApplied: false, height: h };
  }
}

/** `×0.01` / `×1` — for the UI's one-line summary of a decision. */
export function scaleLabel(scale: number): string {
  if (!Number.isFinite(scale) || scale === 1) return "×1";
  return "×" + String(scale);
}
