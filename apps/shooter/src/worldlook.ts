// WHERE the world look (height fog + tone grade) is injected, and WHICH COLOUR SPACE it runs in.
//
// This is its own leaf module (no imports at all) because the answer belongs to neither fog.ts nor
// grade.ts: it is a property of the injection POINT that both of them share, and getting it wrong is
// silent. See apps/shooter/README.md 「关键不变量 / 坑」 for the two incidents that produced it.
//
// THE PROBLEM
// -----------
// The world look is authored in DISPLAY space: `FOG_COLOR = 0x25303d` means "#25303d on screen", the
// grade's pivot/contrast/tints are "what you see" numbers. The obvious place to inject it was
// `#include <dithering_fragment>` (the last chunk), which is AFTER `#include <colorspace_fragment>` —
// i.e. after three's `linearToOutputTexel()`. That is display space for the canvas pass…
//
// …but NOT for the 「像素化」 pass. With a render target bound, three forces
// `outputColorSpace = 'srgb-linear'` (see postfx.ts), so `linearToOutputTexel()` is the IDENTITY
// there and the same injected code receives RAW LINEAR values. Same shader, two spaces, chosen by the
// render target — so the fog veiled differently and the grade's tint bit differently depending on a
// post-processing toggle, with nothing in the code saying so.
//
// THE FIX: inject BEFORE that include, and cross the space boundary explicitly
// -------------------------------------------------------------------------
//     LinearTosRGB( linear )               <- encode with THREE'S OWN function (no clamp: the canvas
//                                             path has always fed these values to the look)
//     <fog body>                           <- display space, exactly as authored
//     <grade body>                         <- display space (it clamps its own input, see grade.ts)
//     worldLookDisplayToLinear( clamp( ) ) <- back to linear, bounded (pow() needs a bounded input)
//     #include <colorspace_fragment>       <- canvas: encodes once; render target: identity
//
// `colorspace_fragment` is the ONLY line in the shader where the two paths differ, so doing the whole
// look on the near side of it makes the look itself space-INVARIANT by construction: the fog and the
// grade see display values on both paths. (The *rest* of the offscreen frame — blending — needed the
// same treatment for the same reason, and postfx.ts now makes the whole pass display-referred; this
// wrap stays because the look has to run in display space even when the target's output space is not
// the thing being asked about.)
//
// WHY THE INVERSE IS HAND-WRITTEN
// -------------------------------
// The vendored three r160 prefix defines `LinearTransferOETF`, `sRGBTransferOETF` and `LinearTosRGB`
// (linear -> display) but there is NO display -> linear function anywhere in the build — texture
// decoding is done by the sampler's internal format, not in GLSL. So the forward half uses three's own
// `LinearTosRGB` (byte-identical to what the canvas path would have done, no duplicated approximation)
// and the backward half is the exact algebraic inverse of `sRGBTransferOETF`, written here and
// asserted numerically against it in scripts/verify-fog.mjs:
//
//     three:  mix( pow( v, 0.41666 ) * 1.055 - 0.055, v * 12.92, v <= 0.0031308 )
//     ours:   mix( x / 12.92, pow( ( x + 0.055 ) / 1.055, 2.4 ), x >= 0.04045 )
//
// (`v <= 0.0031308` encodes to `x = 0.040449`, so the two branch points agree.) The round trip
// `displayToLinear( linearToDisplay( v ) )` is asserted to better than 1/255 over the whole range, and
// in the canvas path three then re-encodes with the SAME function it would have used before — so a
// material that renders to the canvas comes out bit-for-bit where it did, and the render-target path
// now agrees with it.
//
// COST: two `pow()` calls per fragment for every LIT material, plus one clamp. Unlit/additive
// materials (particles, tracers, bars, the vision overlay) are not patched at all and pay nothing.

import { FOG_FRAGMENT_BODY, FOG_FRAGMENT_DECLS } from './fog.js';
import { GRADE_FRAGMENT_BODY, GRADE_FRAGMENT_DECLS } from './grade.js';

/** The one line whose expansion depends on the render target: inject on its LEFT and the look is
 *  space-invariant. Exported through fog.ts::FOG_FRAGMENT_ANCHOR and grade.ts::GRADE_FRAGMENT_ANCHOR
 *  as well (deliberate duplicates, kept so those two modules stay dependency-free; verify-tone.mjs
 *  asserts all three are the same string). */
export const WORLD_LOOK_FRAGMENT_ANCHOR = '#include <colorspace_fragment>';

/**
 * Injected at the top of the fragment shader (global scope — an `onBeforeCompile` source has no
 * `#version` line yet, three prepends the prefix afterwards, so a function definition is safe here).
 * `c` must already be inside 0..1: the caller clamps, because `pow()` of a negative base is undefined.
 */
export const WORLD_LOOK_FRAGMENT_DECLS = [
  'vec3 worldLookDisplayToLinear( vec3 c ) {',
  '  return mix( c / 12.92, pow( ( c + 0.055 ) / 1.055, vec3( 2.4 ) ), step( vec3( 0.04045 ), c ) );',
  '}',
].join('\n');

/**
 * Linear (possibly HDR) -> display, with three's OWN function and NO clamp — deliberately.
 *
 * Why no clamp here: `LinearTosRGB` is what the canvas path would have applied to this value anyway, so
 * leaving it unclamped keeps the direct-canvas picture bit-for-bit what it was before this wrap existed
 * (verify-fog.mjs asserts that as "the canvas path did not move"). The out-of-gamut values then flow
 * into the fog — which is a `mix`, and has always received them on the canvas path — and are finally
 * clamped by the grade's own domain clamp (grade.ts) and by the decode below, which needs a bounded
 * input for its `pow()`. Clamping here instead would make a fogged hot spot darker than it has ever
 * been, i.e. it would fix a domain problem by changing the look.
 *
 * (The value cannot be negative: a material's output is `diffuse * light + emissive`, and `LinearTosRGB`
 * of a negative would be NaN through `mix(NaN, x, 1)`. Three's own `colorspace_fragment` has the same
 * assumption, so this is not a new one.)
 */
export const WORLD_LOOK_ENCODE_BODY = [
  '{',
  '  gl_FragColor.rgb = LinearTosRGB( gl_FragColor ).rgb;',
  '}',
].join('\n');

/** Bounded display -> linear, immediately before three's own `colorspace_fragment`. This clamp is the
 *  one that has to be here: `pow()` is undefined for a negative base, and a super-white value would
 *  come back as a linear value > 1 that the render target (8-bit UNORM) and the framebuffer would clip
 *  anyway — clipping it one step earlier is visually free, and it is what makes the two paths agree. */
export const WORLD_LOOK_DECODE_BODY = [
  '{',
  '  vec3 wlDisplay = clamp( gl_FragColor.rgb, 0.0, 1.0 );',
  '  gl_FragColor.rgb = worldLookDisplayToLinear( wlDisplay );',
  '}',
].join('\n');

// ---------------------------------------------------------------------------
// JS mirrors (for the assertions — the GPU path itself cannot be run here)
// ---------------------------------------------------------------------------

/** Linear -> display, EXACTLY the vendored `sRGBTransferOETF` (three's `LinearTosRGB` calls it). */
export function worldLookLinearToDisplay(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 0.41666) - 0.055;
}

/** Display -> linear: the mirror of `WORLD_LOOK_FRAGMENT_DECLS` (clamped, like the GLSL caller). */
export function worldLookDisplayToLinear(c: number): number {
  const x = c < 0 ? 0 : c > 1 ? 1 : c;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

/** The worst |v - displayToLinear(linearToDisplay(v))| over the displayable range. */
export function worldLookRoundTripError(steps = 1000): number {
  let worst = 0;
  for (let i = 0; i <= steps; i++) {
    const v = i / steps;
    worst = Math.max(worst, Math.abs(v - worldLookDisplayToLinear(worldLookLinearToDisplay(v))));
  }
  return worst;
}

// ---------------------------------------------------------------------------
// THE COMPOSITION (the one place the order of the injected blocks is written down)
// ---------------------------------------------------------------------------
// Both the wrap and the ordering live here rather than in toon.ts for the same reason the order is not
// left to two chained `String.replace` calls (a real bug: each patch inserts AFTER its anchor, so the
// patch applied last ends up FIRST — fog-then-grade silently produced grade-then-fog). toon.ts calls
// this and only this, so what verify-tone.mjs asserts in Node is the string the GPU is given.

export interface WorldLookPatchResult {
  /** False when the anchor is missing or duplicated: the caller must then apply NOTHING. */
  ok: boolean;
  src: string;
}

/** Count non-overlapping occurrences of `needle` in `src`. */
function countOccurrences(src: string, needle: string): number {
  let n = 0;
  let i = src.indexOf(needle);
  while (i !== -1) {
    n++;
    i = src.indexOf(needle, i + needle.length);
  }
  return n;
}

/**
 * Compose the whole world look onto a lit material's fragment shader source:
 *
 *     <declarations: the sRGB EOTF, then the fog's and the grade's>
 *     ... original shader ...
 *     <encode to bounded display space>
 *     <height fog, in display space>
 *     <tone grade, in display space>
 *     <decode back to linear>
 *     #include <colorspace_fragment>     <- canvas: encodes once; render target: identity
 *
 * All-or-nothing: `ok:false` and the source untouched when the anchor is not unique.
 */
export function patchWorldLookFragmentShader(src: string): WorldLookPatchResult {
  if (countOccurrences(src, WORLD_LOOK_FRAGMENT_ANCHOR) !== 1) return { ok: false, src };
  return {
    ok: true,
    src: WORLD_LOOK_FRAGMENT_DECLS + '\n' + FOG_FRAGMENT_DECLS + '\n' + GRADE_FRAGMENT_DECLS + '\n'
      + src.replace(WORLD_LOOK_FRAGMENT_ANCHOR,
        WORLD_LOOK_ENCODE_BODY + '\n' + FOG_FRAGMENT_BODY + '\n' + GRADE_FRAGMENT_BODY + '\n'
        + WORLD_LOOK_DECODE_BODY + '\n' + WORLD_LOOK_FRAGMENT_ANCHOR),
  };
}
