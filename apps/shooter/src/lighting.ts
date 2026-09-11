// Lighting ("光照") of the shooter, as pure data + pure functions: the ambient fill AND the
// directional (sun) pair. Renamed from ambient-only when the panel grew a 「方向光」 slider.
//
// WHY THIS IS ITS OWN LEAF MODULE
// ------------------------------
// Both are user settings (the 光照 group in the settings panel), and each slider's range, built-in
// default and the renderer's clamp must never drift apart. settings.ts is a PURE module (it is
// imported by the Node tests and must not pull in `three`), so the numbers cannot live in render.ts.
// Same pattern as camera.ts / vision.ts: the leaf module owns the numbers, settings.ts imports them,
// render.ts consumes them.
//
// WHICH LIGHT IS "AMBIENT", AND WHY THE TWO KNOBS ARE NOT INTERCHANGEABLE
// ---------------------------------------------------------------------
// The scene has three lights (see render.ts::addLights): a HemisphereLight and two DirectionalLights
// (the white key light that casts shadows + a warm diagonal fill). Only the HEMISPHERE light is the
// ambient term, for a reason that is easy to get wrong:
//
//   * a DirectionalLight's diffuse term goes through MeshToonMaterial's gradient map
//     (RE_Direct_Toon -> getGradientIrradiance), so it is clipped into the 4-step banding ramp in
//     toon.ts. It cannot lift a shadowed face — a face turned away from it stays on the dark band.
//   * a HemisphereLight's contribution is added as *indirect* irradiance, which the toon shader does
//     NOT band. It is a flat wash spread evenly over every surface regardless of its normal.
//
// So the ambient knob moves the FLAT FLOOR of the image (contrast: up = flat, down = contrasty) and
// the directional knob moves the SUN (shape/brightness of lit faces, and the strength of the shading
// the forms read from). That is why they are two settings instead of one "brightness" slider.
//
// History of the ambient level (each step was an explicit user request, so these numbers are not free
// parameters — they are what shipped):
//   * 1.05 — hardcoded in render.ts before this module existed;
//   * 0.42 — "可否削弱环境光" (weaken it), 40% of the old fill: the scene read as too bright / flat;
//   * 0.14 — "降低到现有值的 1/3" (a third of the current value);
//   * 0    — "把环境光改成 0" (off): the scene is now lit by the two directionals alone.
// The slider's TOP is DERIVED so the earlier looks stay reachable no matter how the base moves; see
// AMBIENT_SCALE_MAX.

// ---------------------------------------------------------------------------
// Ambient (hemisphere) light
// ---------------------------------------------------------------------------

/** Hemisphere sky colour (cold, from above). */
export const AMBIENT_SKY_COLOR = 0xcfe8ff;
/** Hemisphere ground colour (dark blue-grey, bounced from below). */
export const AMBIENT_GROUND_COLOR = 0x30323a;

/** The feel the scene had before the 「环境光」 setting existed (was hardcoded 1.05 in render.ts). */
export const AMBIENT_LEGACY_INTENSITY = 1.05;

/**
 * The ambient slider's UNIT: intensity at scale 1. It is deliberately NOT the shipped level any more
 * (that is 0 — see AMBIENT_SCALE_DEFAULT). Keeping a fixed non-zero unit means a stored/edited scale
 * keeps a stable meaning across re-tunes of the shipped level, and it is the only number to edit when
 * re-tuning what "100% of the ambient unit" is worth in intensity.
 */
export const AMBIENT_BASE = 0.14;

/** Scale 0 = the ambient light is OFF, and that is what now ships ("把环境光改成 0"). */
export const AMBIENT_SCALE_DEFAULT = 0;
/** 0 is a legal value, not "off": it leaves only the two directional lights (maximum contrast). */
export const AMBIENT_SCALE_MIN = 0;
export const AMBIENT_SCALE_STEP = 0.05;

/**
 * Top of the slider — DERIVED from the constants above, never hand-written.
 *
 * It is the scale that brings the light back to AMBIENT_LEGACY_INTENSITY (rounded to a whole step),
 * because "the user can always drag back to what shipped before this setting existed" is the
 * documented rollback path. Deriving it matters: lowering AMBIENT_BASE is the normal way to re-tune
 * this, and with a hand-written max each such edit would silently shrink the reachable range (the
 * first version hardcoded 2.5, which was exactly right for 0.42 and would have capped the light at
 * 0.35 — below the value it was just lowered from — for 0.14). With the current base that gives
 * 1.05 / 0.14 = 7.5x. `Math.max(DEFAULT, …)` is the guard for the opposite edit (a base above the
 * legacy intensity, where the derived top would fall below the default and make it unreachable).
 */
export const AMBIENT_SCALE_MAX = Math.max(
  AMBIENT_SCALE_DEFAULT,
  Math.round(AMBIENT_LEGACY_INTENSITY / AMBIENT_BASE / AMBIENT_SCALE_STEP) * AMBIENT_SCALE_STEP,
);

/**
 * Clamp a stored/hand-edited scale to the slider range; anything non-finite falls back to the
 * built-in default (the server does not validate business schemas, so dirty data must never throw
 * and must never reach the light).
 */
export function clampAmbientScale(scale: number): number {
  if (typeof scale !== 'number' || !Number.isFinite(scale)) return AMBIENT_SCALE_DEFAULT;
  if (scale < AMBIENT_SCALE_MIN) return AMBIENT_SCALE_MIN;
  if (scale > AMBIENT_SCALE_MAX) return AMBIENT_SCALE_MAX;
  return scale;
}

/** The actual HemisphereLight intensity for a scale. Clamps, so it is safe to call with anything. */
export function ambientIntensity(scale: number): number {
  return AMBIENT_BASE * clampAmbientScale(scale);
}

/**
 * The ambient slider's readout, as a percentage OF THE PRE-SETTING INTENSITY (1.05) rather than of the
 * slider unit: 0% = off (the shipped default), 40% = the 0.42 that shipped for one round, 100% = the
 * original hardcoded light. Anchoring the display to that fixed reference keeps "40%" meaning the
 * same thing forever, while the unit (AMBIENT_BASE) and the shipped level both changed twice.
 */
export function ambientPercentOfLegacy(scale: number): number {
  return Math.round((ambientIntensity(scale) / AMBIENT_LEGACY_INTENSITY) * 100);
}

// ---------------------------------------------------------------------------
// Directional ("方向光") light
// ---------------------------------------------------------------------------
// TWO lights, ONE knob. The key light is the shadow caster and the warm one is the diagonal fill
// (late-afternoon sun from the opposite corner); the pair is what gives the toon scene its form. A
// single multiplier on BOTH keeps their ratio (and therefore the warm/cool balance and the relative
// strength of the two faces of every object) intact — which is the property you want when the goal is
// "brighter/darker". If the goal ever becomes "less/more fill relative to the key" (i.e. a contrast
// knob for the sun itself), that is a SECOND key, not a rescaling of this one.
//
// 0 is legal (it leaves only the ambient light). 0 here AND 0 on the ambient slider is a fully black
// scene — a legal combination, deliberately not blocked, because a cross-key rule would have to live
// in the panel and would surprise anyone editing the stored JSON by hand.

/** Key light intensity the scene has always shipped (white, casts the shadows). */
export const DIR_KEY_INTENSITY = 1.4;
/** Warm diagonal fill intensity the scene has always shipped (no shadow, to keep the cost down). */
export const DIR_WARM_INTENSITY = 1.0;

/** 1 = the shipped sun; the readout is a plain percentage of it. */
export const DIRECTIONAL_SCALE_DEFAULT = 1;
export const DIRECTIONAL_SCALE_MIN = 0;
/**
 * 0–2x. The useful band is 0–1x: MeshToonMaterial's top ramp step is 0.95 and the key light already
 * lands on it, so past ~1x the lit faces are simply clipped (brighter, not more detailed). The extra
 * headroom is there so that "it stopped changing" is discoverable as clipping rather than suspicious.
 */
export const DIRECTIONAL_SCALE_MAX = 2;
export const DIRECTIONAL_SCALE_STEP = 0.05;

/** Same contract as clampAmbientScale: clamp the range, fall back to the default on anything dirty. */
export function clampDirectionalScale(scale: number): number {
  if (typeof scale !== 'number' || !Number.isFinite(scale)) return DIRECTIONAL_SCALE_DEFAULT;
  if (scale < DIRECTIONAL_SCALE_MIN) return DIRECTIONAL_SCALE_MIN;
  if (scale > DIRECTIONAL_SCALE_MAX) return DIRECTIONAL_SCALE_MAX;
  return scale;
}

/** One directional light's intensity for a scale. Call it for the key AND the warm fill. */
export function directionalIntensity(base: number, scale: number): number {
  return base * clampDirectionalScale(scale);
}

/** The directional slider's readout: percent of the shipped sun (100% = what has always shipped). */
export function directionalPercent(scale: number): number {
  return Math.round(clampDirectionalScale(scale) * 100);
}
