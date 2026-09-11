// 「调色」(tone grade) of the shooter: the numbers, the JS mirror and the GLSL patch — pure, so the
// colour transform can be asserted in Node (scripts/verify-tone.mjs) even though the GPU path cannot.
//
// WHAT IT DOES, AND WHY IN THIS ORDER
// ----------------------------------
//     tint     rgb *= mix(shadowTint, highlightTint, smoothstep(lo, hi, luminance))   // split tone
//     contrast rgb  = (rgb - pivot) * contrast + pivot                                // S-curve
//     saturate rgb  = mix(vec3(luminance), rgb, saturation)                           // chroma
//     blend    rgb  = mix(before, after, strength)
//
// The split tone is MULTIPLICATIVE on purpose: `0 * tint == 0`, so the darks gain a hue without being
// lifted. That is the one property this scene needs — the user asked for the ambient light to be 0,
// i.e. for deep shadows, and a grade that lifts them (an additive "lift"/film-black) would quietly
// undo that. Multiplicative tinting instead gives the classic cool-shadow/warm-highlight split while
// keeping the black point where the lighting put it.
//
// WHERE IT RUNS
// -------------
// In the SAME `onBeforeCompile` injection as the height fog (see toon.ts), appended after it, in
// DISPLAY colour space but BEFORE three's `colorspace_fragment`. Three consequences, all deliberate:
//   * it runs inside worldlook.ts's explicit `LinearTosRGB -> look -> sRGB EOTF` wrap, so these numbers
//     are "what you see" values and are authored in display space (same convention as FOG_COLOR — do
//     NOT wrap them in THREE.Color). That wrap is what makes the grade space-INVARIANT: injected after
//     `colorspace_fragment` instead, it would act on raw linear values whenever the 「像素化」 pass
//     binds a render target, i.e. run at a different strength depending on a post-processing toggle;
//   * it lands after the fog mix, so the fog colour is graded too (the fog is part of the picture);
//   * it lands after the toon banding, so the grade cannot be re-quantised into the 4-step ramp.
// Only LIT materials are patched, so the additive signals (tracers, flames, sparks, the laser, the
// vision overlay, the bars) keep their pure authored colours: a grade that desaturated the tracers
// would cost readability exactly where the player aims.
//
// THE DOMAIN: THE INPUT IS CLAMPED TO 0..1, AND WHY THAT IS LOAD-BEARING
// ---------------------------------------------------------------------
// A "what you see" operator has a display-referred DOMAIN, and everything before it in the pipeline
// does not. `linearToOutputTexel()` is a pure encode — three's `LinearTosRGB` has no clamp — and the
// framebuffer only clips at the very end, after the whole world look. A lit surface under a close point
// light is therefore SUPER-WHITE: the floor 0.5 units below the dragon-breath pellet's light is ~2.9 in
// linear, i.e. ~1.6 once encoded. (worldlook.ts encodes with three's own unclamped function on purpose —
// clamping there would change the shipped canvas picture — so THIS clamp is the one the incident was
// fixed with, and it is also what the grade's own contract demands: 0..1 is its domain.)
//
// That is fine for fog (a mix) and fatal for `mix( before, after, s )` when s > 1, because that is an
// EXTRAPOLATION away from `after` — and `after` is clamped to 1 while `before` is not:
//
//     out = before + (1 - before) * s          (the brightest channel of a super-white pixel)
//
// so the ONE channel that is already out of gamut is also the one that gets pushed down, twice as fast
// as the others move up. At 「调性」 2 a red channel of 1.6 came out at 0.4: red light on a grey floor
// rendered #6a9b3a (green), and the RPG blast (#ffcf8a at intensity 90) drove R to -0.67. That is the
// reported 「龙息弹/RPG 的红光照到别的地方发绿」. Note what it is NOT: it is not the 「像素化」 pass.
// Back then the block ran after `colorspace_fragment`, i.e. on encoded values with the canvas and on
// raw linear ones with a render target (three forces `srgb-linear` there); that changed the SIZE of the
// overshoot but never its sign, so the defect reproduced with post-processing on AND off — exactly as
// reported, after this file had already blamed the post-processing once. Both halves of that story are
// now fixed: the domain here, and the space via worldlook.ts's encode/decode wrap.
//
// The fix is one line of domain: `gBase = clamp( gl_FragColor.rgb, 0.0, 1.0 )`, and then every use of
// "before" below is `gBase`. It is visually free (those extra stops of a super-white pixel are thrown
// away by the framebuffer, and by the pixelation pass's 8-bit render target, one step later anyway) and
// it makes the strength knob safe by construction: with `after` and `gBase` both in 0..1 the mix cannot
// leave 0..1 for s <= 1, and for s > 1 it can only widen a contrast that is already bounded. Keeping
// the clamp HERE (rather than only at the encode) is deliberate: this block is the one that reads
// 0..1 as a contract, so it enforces its own domain no matter who calls it.
//
// WHAT THE CLAMP DOES NOT FIX, measured (scripts/verify-tone.mjs pins both bounds): the split tone
// itself rotates the hue of the dark end (shadow tint R 0.86 / G 0.96 is what makes shadows read cool),
// so a DIM, fully saturated yellow surface (R == G, B == 0) can come out marginally green-dominant —
// 0.026 at the default 「调性」 1 and 0.052 at 2, worst case over the whole 0..1 cube. It is the
// authored cool-shadow split, not the slider and not the overshoot. NO LIGHT IN THIS GAME PRODUCES IT:
// over the five transient lights below x distance 0.4..12 x dotNL x 「调性」 0..2 the displayed result is
// never green-dominant (worst 0.000), which is the property verify-tone.mjs asserts on the real lights
// and the reason this residue is documented rather than tuned away.

/** Shadow tint (multiplier): pulls the darks toward cold blue-grey. */
export const GRADE_SHADOW_TINT = [0.86, 0.96, 1.16] as const;
/** Highlight tint (multiplier): keeps the lights warm, so the split reads as one light source. */
export const GRADE_HIGHLIGHT_TINT = [1.09, 1.01, 0.90] as const;
/** Luminance window over which the split tone crossfades (below lo = full shadow tint). */
export const GRADE_TINT_LO = 0.12;
export const GRADE_TINT_HI = 0.78;
export const GRADE_CONTRAST = 1.06;
export const GRADE_PIVOT = 0.42;
export const GRADE_SATURATION = 1.10;

/** 1 = the authored grade, 0 = exactly the ungraded image (the escape hatch, like the fog's 0). */
export const GRADE_STRENGTH_DEFAULT = 1;
export const GRADE_STRENGTH_MIN = 0;
export const GRADE_STRENGTH_MAX = 2;
export const GRADE_STRENGTH_STEP = 0.05;

export type RGB = [number, number, number];

export function clampGradeStrength(v: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return GRADE_STRENGTH_DEFAULT;
  if (v < GRADE_STRENGTH_MIN) return GRADE_STRENGTH_MIN;
  if (v > GRADE_STRENGTH_MAX) return GRADE_STRENGTH_MAX;
  return v;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (lo: number, hi: number, x: number): number => {
  const t = clamp01((x - lo) / (hi - lo));
  return t * t * (3 - 2 * t);
};
const lum = (c: RGB): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** The JS mirror of the GLSL below — one implementation, two consumers (shader + analysis + tests). */
export function gradeDisplay(rgb: RGB, strength: number): RGB {
  const s = clampGradeStrength(strength);
  // The DOMAIN clamp (see the header): a display-space operator must not be fed out-of-gamut values,
  // because the `mix` below is an extrapolation for s > 1 and would push the brightest channel DOWN.
  const base: RGB = [clamp01(rgb[0]), clamp01(rgb[1]), clamp01(rgb[2])];
  if (s === 0) return [base[0], base[1], base[2]];
  const t = smoothstep(GRADE_TINT_LO, GRADE_TINT_HI, lum(base));
  const shaded: RGB = [
    base[0] * (GRADE_SHADOW_TINT[0] + (GRADE_HIGHLIGHT_TINT[0] - GRADE_SHADOW_TINT[0]) * t),
    base[1] * (GRADE_SHADOW_TINT[1] + (GRADE_HIGHLIGHT_TINT[1] - GRADE_SHADOW_TINT[1]) * t),
    base[2] * (GRADE_SHADOW_TINT[2] + (GRADE_HIGHLIGHT_TINT[2] - GRADE_SHADOW_TINT[2]) * t),
  ];
  const contrasted: RGB = [
    (shaded[0] - GRADE_PIVOT) * GRADE_CONTRAST + GRADE_PIVOT,
    (shaded[1] - GRADE_PIVOT) * GRADE_CONTRAST + GRADE_PIVOT,
    (shaded[2] - GRADE_PIVOT) * GRADE_CONTRAST + GRADE_PIVOT,
  ];
  const l = lum(contrasted);
  const saturated: RGB = [
    l + (contrasted[0] - l) * GRADE_SATURATION,
    l + (contrasted[1] - l) * GRADE_SATURATION,
    l + (contrasted[2] - l) * GRADE_SATURATION,
  ];
  const out: RGB = [clamp01(saturated[0]), clamp01(saturated[1]), clamp01(saturated[2])];
  if (s === 1) return out;
  return [
    base[0] + (out[0] - base[0]) * s,
    base[1] + (out[1] - base[1]) * s,
    base[2] + (out[2] - base[2]) * s,
  ];
}

// ---------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------
export const GRADE_UNIFORMS = [
  'uGradeStrength', 'uGradeShadowTint', 'uGradeHighlightTint', 'uGradeTintLo', 'uGradeTintHi',
  'uGradeContrast', 'uGradePivot', 'uGradeSaturation',
] as const;

export const GRADE_FRAGMENT_DECLS = [
  'uniform float uGradeStrength;',
  'uniform vec3 uGradeShadowTint;',
  'uniform vec3 uGradeHighlightTint;',
  'uniform float uGradeTintLo;',
  'uniform float uGradeTintHi;',
  'uniform float uGradeContrast;',
  'uniform float uGradePivot;',
  'uniform float uGradeSaturation;',
].join('\n');

/** Injected after the fog's block and before worldlook.ts's decode — all three share the one anchor.
 *
 *  `gBase` is the DOMAIN clamp (see the header): it must stay the base of the final `mix`, and no line
 *  here may read `gl_FragColor.rgb` directly, or a super-white pixel is extrapolated again. The clamp
 *  is idempotent with worldlook.ts's encode (which already hands this block a bounded value), so the
 *  two are belt-and-braces: whichever runs first, this block's input domain is 0..1. */
export const GRADE_FRAGMENT_BODY = [
  '{',
  '  vec3 gBase = clamp( gl_FragColor.rgb, 0.0, 1.0 );',
  '  float gLum = dot( gBase, vec3( 0.2126, 0.7152, 0.0722 ) );',
  '  float gMix = smoothstep( uGradeTintLo, uGradeTintHi, gLum );',
  '  vec3 gCol = gBase * mix( uGradeShadowTint, uGradeHighlightTint, gMix );',
  '  gCol = ( gCol - uGradePivot ) * uGradeContrast + uGradePivot;',
  '  float gLum2 = dot( gCol, vec3( 0.2126, 0.7152, 0.0722 ) );',
  '  gCol = mix( vec3( gLum2 ), gCol, uGradeSaturation );',
  '  gCol = clamp( gCol, 0.0, 1.0 );',
  '  gl_FragColor.rgb = mix( gBase, gCol, uGradeStrength );',
  '}',
].join('\n');

// Deliberately the same anchor as the fog (worldlook.ts owns the canonical string and the composition):
// the world look is injected on the LEFT of three's `colorspace_fragment`, wrapped in worldlook.ts's
// explicit encode/decode pair, with the fog first and this grade last. verify-tone.mjs asserts the two
// anchor constants and worldlook's are identical, and that the composition really is in that order.
export const GRADE_FRAGMENT_ANCHOR = '#include <colorspace_fragment>';

// NOTE there is deliberately NO `patchGradeFragmentShader` here any more: the grade is not a standalone
// patch. It has to sit AFTER the fog and INSIDE worldlook.ts's encode/decode wrap (its numbers are
// display-space, and the wrap is what guarantees they see display values on both render paths).
// worldlook.ts::patchWorldLookFragmentShader composes it; toon.ts calls only that.

/** Panel readout: percent of the authored grade (0 shows as 「关闭」). */
export function gradePercent(strength: number): number {
  return Math.round(clampGradeStrength(strength) * 100);
}
