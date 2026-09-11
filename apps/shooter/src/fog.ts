// Height fog ("高度雾") for the shooter: the numbers, the math, and the GLSL patch — all pure, so
// every part except "does the GPU accept it" can be asserted in Node (scripts/verify-fog.mjs).
//
// WHAT "HEIGHT FOG" MEANS HERE
// ---------------------------
// Classic exponential height fog: the fog density falls off exponentially with world Y, so the air is
// thickest at floor level and thin above it, and on top of that the usual distance term applies:
//
//     density(y) = FOG_DENSITY * exp( -FOG_HEIGHT_FALLOFF * max(0, y - FOG_BASE_Y) )
//     factor     = 1 - exp( -( density(y) * depth )^2 )        // three's FogExp2 shape
//     result     = mix( colour, fogColour, min(factor, FOG_MAX_OPACITY) )
//
// In this camera (a ~58 deg oblique top-down view) that reads as mist pooling on the floor: the floor
// hazes first, the tops of props/walls/characters stay clear, and everything fades a little with
// distance. See FOG_MAX_OPACITY for the readability clamp (enemies must stay visible through it).
//
// WHY IT IS A SHADER PATCH AND NOT scene.fog
// ------------------------------------------
// `THREE.Fog` / `FogExp2` are DISTANCE fog — uniform in Y, so they cannot express "thicker near the
// floor". Getting the height term without a custom shader would mean building a stack of translucent
// planes, which costs mobile fill (the vision overlay is already a near-fullscreen transparent pass)
// and still only approximates the profile in steps.
//
// So this uses the one hook three gives us: `material.onBeforeCompile`. The module below stays PURE
// (no three import) and only does the string surgery; ./toon.ts owns the three-side application. Two
// anchors are used, both of which exist exactly once in every lit material's shader (asserted against
// the vendored build in verify-fog.mjs):
//
//   * vertex:   `#include <project_vertex>`      -> append the world-Y / view-depth capture
//   * fragment: `#include <colorspace_fragment>` -> insert the mix on its LEFT
//
// WHICH COLOUR SPACE THE MIX RUNS IN (and why the anchor is the colours-space include)
// ------------------------------------------------------------------------------------
// The fog colour below is a plain "what you see" value, so the mix has to run in DISPLAY space. The
// first version of this patch injected after `#include <dithering_fragment>` (the last chunk), which
// is display space for the canvas pass but LINEAR space when the 「像素化」 pass binds a render target
// (three forces `srgb-linear` there — see postfx.ts). Same code, two spaces, chosen by a toggle.
//
// The injection point is therefore now `#include <colorspace_fragment>` — the ONE line whose expansion
// depends on the render target — and the whole world look is wrapped in an explicit encode/decode pair
// by worldlook.ts (`LinearTosRGB` going in, a hand-written sRGB EOTF coming out). That keeps the fog
// colour a raw byte value (do NOT wrap it in `new THREE.Color`) AND makes the result identical in both
// paths, while the render target still holds linear light for the blit and for additive blending.
// `WORLD_LOOK_FRAGMENT_DECLS` must be injected alongside this body; toon.ts does both in one edit, and
// verify-fog.mjs asserts the encodings are declared and that the mix sits between them.
//
// The other half of the old rationale still holds: the mix lands on top of the toon banding, so it
// softens the look instead of being re-quantised by the gradient map.

/** Fog colour, as it appears ON SCREEN (see the display-space note above). Cold blue-grey: lighter than
 *  the near-black surround (0x0b0e14) so veiling reads as mist rather than as "distance darkening",
 *  but darker than the lit grey floor (0x83878b) so it mutes instead of washing out. */
export const FOG_COLOR = 0x25303d;

/** Density at y = FOG_BASE_Y (the floor). 0 = feature off. */
export const FOG_DENSITY_DEFAULT = 0.016;
export const FOG_DENSITY_MIN = 0;
export const FOG_DENSITY_MAX = 0.06;
export const FOG_DENSITY_STEP = 0.002;

/** Per-world-unit falloff of the density with height. 0 = plain distance fog; large = a thin slab of
 *  mist on the floor. 0.18 keeps a character (2 units tall) at ~70% of the floor density. */
export const FOG_HEIGHT_FALLOFF = 0.18;
/** Height where the density is FOG_DENSITY — the floor, i.e. the bottom of everything in the arena. */
export const FOG_BASE_Y = 0;
/** Hard cap on how much of a pixel's colour the fog may replace. This is a READABILITY clamp, not a
 *  physical one: past ~0.6 the far floor and any enemy standing on it both approach a flat sheet of
 *  fog colour, and "you cannot see the thing shooting at you" is a worse bug than "the fog is subtle". */
export const FOG_MAX_OPACITY = 0.6;

/** Clamp a stored/hand-edited density; anything non-finite falls back to the shipped default. */
export function clampFogDensity(density: number): number {
  if (typeof density !== 'number' || !Number.isFinite(density)) return FOG_DENSITY_DEFAULT;
  if (density < FOG_DENSITY_MIN) return FOG_DENSITY_MIN;
  if (density > FOG_DENSITY_MAX) return FOG_DENSITY_MAX;
  return density;
}

/** exp() height profile of the density, 1 at/below FOG_BASE_Y — the JS mirror of the GLSL below. */
export function fogHeightScale(y: number): number {
  return Math.exp(-FOG_HEIGHT_FALLOFF * Math.max(0, y - FOG_BASE_Y));
}

/** The fog factor for one fragment: three's FogExp2 shape with a height-scaled density, then clamped
 *  by FOG_MAX_OPACITY. This is the reference implementation verify-fog.mjs checks the GLSL against. */
export function fogFactor(depth: number, y: number, density: number): number {
  const d = clampFogDensity(density) * fogHeightScale(y);
  const raw = 1 - Math.exp(-d * d * depth * depth);
  return Math.min(raw, FOG_MAX_OPACITY);
}

/** Slider readout: percent of FOG_DENSITY_MAX. 0 means the feature is off (the panel says 「关闭」). */
export function fogPercent(density: number): number {
  return Math.round((clampFogDensity(density) / FOG_DENSITY_MAX) * 100);
}

// ---------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------
// Every number lives in a uniform (whose value comes from the constants above), so there is exactly
// one place to change each one and no way for the shader text to drift from the JS math.

/** Names, exported so the tests can assert "declared == referenced" without a GLSL parser. */
export const FOG_VARYINGS = ['vHeightFogY', 'vHeightFogDepth'] as const;
export const FOG_UNIFORMS = [
  'uFogDensity', 'uFogHeightFalloff', 'uFogBaseY', 'uFogMaxOpacity', 'uFogColor',
] as const;

/** Injected at the top of the fragment shader (global scope — `onBeforeCompile` sources have no
 *  `#version` line yet, three prepends the prefix afterwards, so declarations are safe here). */
export const FOG_FRAGMENT_DECLS = [
  'varying float vHeightFogY;',
  'varying float vHeightFogDepth;',
  'uniform float uFogDensity;',
  'uniform float uFogHeightFalloff;',
  'uniform float uFogBaseY;',
  'uniform float uFogMaxOpacity;',
  'uniform vec3 uFogColor;',
].join('\n');

/** Injected at the top of the vertex shader. */
export const FOG_VERTEX_DECLS = [
  'varying float vHeightFogY;',
  'varying float vHeightFogDepth;',
].join('\n');

/**
 * Captured right after `#include <project_vertex>`: at that point `transformed` is final (morph and
 * skinning already ran) and `mvPosition` is in scope. The world-position expression is a deliberate
 * byte-for-byte copy of the engine's own `worldpos_vertex` chunk (including USE_BATCHING, which the
 * vendored r160 has) — verify-fog.mjs asserts that equivalence, because getting it wrong would fog
 * objects by the wrong height in a way that looks plausible rather than broken.
 */
export const FOG_VERTEX_BODY = [
  '{',
  '  vec4 hfWorldPosition = vec4( transformed, 1.0 );',
  '  #ifdef USE_BATCHING',
  '    hfWorldPosition = batchingMatrix * hfWorldPosition;',
  '  #endif',
  '  #ifdef USE_INSTANCING',
  '    hfWorldPosition = instanceMatrix * hfWorldPosition;',
  '  #endif',
  '  hfWorldPosition = modelMatrix * hfWorldPosition;',
  '  vHeightFogY = hfWorldPosition.y;',
  '  vHeightFogDepth = - mvPosition.z;',
  '}',
].join('\n');

/** The mix itself, in DISPLAY space, between worldlook.ts's encode and decode (see the header note).
 *  Wrapped in a block so it cannot collide with any name in the enclosing `main()`. */
export const FOG_FRAGMENT_BODY = [
  '{',
  '  float hfDensity = uFogDensity * exp( - uFogHeightFalloff * max( 0.0, vHeightFogY - uFogBaseY ) );',
  '  float hfFactor = 1.0 - exp( - hfDensity * hfDensity * vHeightFogDepth * vHeightFogDepth );',
  '  gl_FragColor.rgb = mix( gl_FragColor.rgb, uFogColor, min( hfFactor, uFogMaxOpacity ) );',
  '}',
].join('\n');

export const FOG_VERTEX_ANCHOR = '#include <project_vertex>';
// The single shared injection point for the whole world look. The canonical definition lives in
// worldlook.ts (with the colour-space reasoning); this is the same string, kept here so fog.ts stays
// dependency-free, and verify-tone.mjs asserts the two — plus grade.ts's — are identical.
export const FOG_FRAGMENT_ANCHOR = '#include <colorspace_fragment>';

export interface PatchResult {
  /** False when the anchor was missing or duplicated: the caller must then apply NOTHING (a partial
   *  patch is the one failure mode that would not compile, see toon.ts::applyHeightFogShader). */
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

/** Insert the world-Y/depth capture after the engine's `project_vertex` include. */
export function patchHeightFogVertexShader(src: string): PatchResult {
  if (countOccurrences(src, FOG_VERTEX_ANCHOR) !== 1) return { ok: false, src };
  return { ok: true, src: FOG_VERTEX_DECLS + '\n' + src.replace(
    FOG_VERTEX_ANCHOR, FOG_VERTEX_ANCHOR + '\n' + FOG_VERTEX_BODY,
  ) };
}

// NOTE there is deliberately NO `patchHeightFogFragmentShader` here any more. The fragment side is not
// a standalone patch: the mix has to sit inside worldlook.ts's encode/decode wrap (otherwise it runs in
// a different colour space depending on the render target — the bug this pair of anchors exists to
// prevent). worldlook.ts::patchWorldLookFragmentShader composes the declarations, the wrap, the fog and
// the grade in one place, and toon.ts calls only that.
