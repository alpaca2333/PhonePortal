// 「暗角」(vignette) of the shooter: the geometry math and the per-vertex brightness table — pure, so
// every number can be asserted in Node (scripts/verify-tone.mjs) even though the fill cost can only be
// measured on a device.
//
// WHY GEOMETRY INSTEAD OF A POST PASS
// -----------------------------------
// The vendored three has no addons (no EffectComposer/ShaderPass), and the project's convention is to
// express screen effects as plain geometry with baked vertex data — the vision overlay and the slash
// crescent both do exactly that. A vignette is a smooth, low-frequency radial darkening, so a
// tessellated quad whose VERTEX COLOURS hold the falloff and a `MultiplyBlending` material reproduce it
// with zero custom GLSL: `dst * src`, where src is the per-vertex brightness. One draw call, one
// full-screen multiply fill (the only cost), and `strength = 0` hides the mesh so the cost goes to 0.
//
// The mesh is a CHILD OF THE CAMERA, sized to cover the frustum at a fixed local distance, so it
// follows every camera move for free. vignetteQuadSize() is that math and is asserted against the
// camera's own projected frustum extents.
import { CAMERA_FOV_Y, orthoFrustumHeight } from './camera.js';

/** Normalised radius inside which nothing is darkened. */
export const VIGNETTE_INNER = 0.35;
/** Radius at which the darkening reaches full strength: 1.0 == the screen corner (see vignetteRadius). */
export const VIGNETTE_OUTER = 1.0;
/** How much light the corners keep at strength 1 — 0.72 means -28% at the extreme corner. */
export const VIGNETTE_FLOOR = 0.72;
/** Tint of the darkening: a touch cool, matching the fog/shadow family rather than going pure black. */
export const VIGNETTE_TINT = [0.94, 0.97, 1.0] as const;

export const VIGNETTE_STRENGTH_DEFAULT = 0.7;
export const VIGNETTE_STRENGTH_MIN = 0;
export const VIGNETTE_STRENGTH_MAX = 1.5;
export const VIGNETTE_STRENGTH_STEP = 0.05;

/** Grid resolution of the card: 18x18 cells is plenty for a low-frequency radial ramp. */
export const VIGNETTE_SEGMENTS = 18;
/** Local distance of the card from the camera (it is a screen-space quad; any positive value works). */
export const VIGNETTE_DIST = 1;

export function clampVignetteStrength(v: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return VIGNETTE_STRENGTH_DEFAULT;
  if (v < VIGNETTE_STRENGTH_MIN) return VIGNETTE_STRENGTH_MIN;
  if (v > VIGNETTE_STRENGTH_MAX) return VIGNETTE_STRENGTH_MAX;
  return v;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (lo: number, hi: number, x: number): number => {
  const t = clamp01((x - lo) / (hi - lo));
  return t * t * (3 - 2 * t);
};

/**
 * Normalised radial coordinate of a point given in -1..1 screen space, with the screen CORNER at
 * exactly 1.0 (hence the /sqrt(2)).
 *
 * Deliberately NOT aspect-corrected: measuring the radius in normalised space makes the falloff a
 * circle in UV and therefore an ELLIPSE on a non-square viewport, which is what a vignette should be
 * (corners darkest, long edges less). It also means the falloff table does not change when the phone
 * is rotated — only the card's size does — so rotating cannot produce a visible pop.
 */
export function vignetteRadius(x: number, y: number): number {
  return Math.hypot(x, y) / Math.SQRT2;
}

/**
 * The scalar falloff in the middle (tint-free): 1 at the centre, `1 - strength*(1 - floor)` at the
 * corners. Used for the readouts/tests; the actual per-channel multiplier is `vignetteFactor()`.
 */
export function vignetteBrightness(radius: number, strength: number): number {
  const s = clampVignetteStrength(strength);
  if (s === 0) return 1;
  const falloff = smoothstep(VIGNETTE_INNER, VIGNETTE_OUTER, radius);
  return 1 - s * falloff * (1 - VIGNETTE_FLOOR);
}

/**
 * The exact per-channel multiplier for one vertex: `1 - strength * falloff * (1 - floor * tint)`.
 *
 * Two properties are baked into that shape, and both are asserted in verify-tone.mjs:
 *   * strength 0 is EXACTLY (1,1,1). Writing it as `brightness * tint` would leave the tint on screen
 *     at strength 0 — a ~6% warm-darkening of the whole frame that the "0 = off" contract forbids and
 *     that nobody would notice on a device until they compared screenshots.
 *   * the TINT only applies where the falloff is: the centre of the screen is exactly 1, and the
 *     corners carry the tint. A vignette should not recolour the play area it is framing.
 */
export function vignetteFactor(radius: number, strength: number): [number, number, number] {
  const s = clampVignetteStrength(strength);
  const falloff = smoothstep(VIGNETTE_INNER, VIGNETTE_OUTER, radius);
  const factor = (tint: number): number => 1 - s * falloff * (1 - VIGNETTE_FLOOR * tint);
  return [factor(VIGNETTE_TINT[0]), factor(VIGNETTE_TINT[1]), factor(VIGNETTE_TINT[2])];
}

/**
 * The size of the card that exactly covers the view volume. Under the ORTHOGRAPHIC camera (see
 * camera.ts) the visible area does not depend on the distance, so this is just the frustum — a nice
 * simplification the projection change handed us: the card no longer has to be re-derived from the fov
 * and the distance, and it cannot drift if the dist changes.
 *
 * verify-tone.mjs projects the card's corners through the real `OrthographicCamera` and asserts they
 * land exactly on the clip-space edges.
 */
export function vignetteQuadSize(scale: number, camZoom: number, aspect: number): { width: number; height: number } {
  const height = orthoFrustumHeight(scale, camZoom);
  return { width: height * aspect, height };
}

export interface VignetteGrid {
  /** xyz per vertex (the card in camera-local space, z = -dist). */
  positions: Float32Array;
  /** uv per vertex, 0..1. */
  uvs: Float32Array;
  /** rgb per vertex = the multiply factor, already tinted and scaled by `strength`. */
  colors: Float32Array;
  /** Triangle indices. */
  indices: Uint16Array;
  /** uv per triangle vertex, flattened the same way as `indices`. */
  triUvs: Float32Array;
  /** Screen-space radius per vertex (the number the brightness came from) — for the tests. */
  radii: Float32Array;
}

/**
 * Build the vignette card: a `segments x segments` grid at z = -dist, each vertex's colour precomputed
 * for the given strength. The table is rebuilt when the setting or the viewport aspect changes (289
 * vertices — cheap, and it keeps the material a plain vertex-coloured MeshBasicMaterial).
 */
export function buildVignetteGrid(opts: {
  segments?: number; dist?: number; aspect: number; strength: number;
  scale?: number; camZoom?: number;
}): VignetteGrid {
  const n = opts.segments ?? VIGNETTE_SEGMENTS;
  const dist = opts.dist ?? VIGNETTE_DIST;
  const { width, height } = vignetteQuadSize(opts.scale ?? 1, opts.camZoom ?? 1, opts.aspect);
  const count = (n + 1) * (n + 1);
  const positions = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const colors = new Float32Array(count * 3);
  const radii = new Float32Array(count);
  for (let iy = 0; iy <= n; iy++) {
    for (let ix = 0; ix <= n; ix++) {
      const u = ix / n;
      const v = iy / n;
      const idx = iy * (n + 1) + ix;
      positions[idx * 3] = (u - 0.5) * width;
      positions[idx * 3 + 1] = (v - 0.5) * height;
      positions[idx * 3 + 2] = -dist;
      uvs[idx * 2] = u;
      uvs[idx * 2 + 1] = v;
      const r = vignetteRadius(u * 2 - 1, v * 2 - 1);
      radii[idx] = r;
      const [cr, cg, cb] = vignetteFactor(r, opts.strength);
      colors[idx * 3] = cr;
      colors[idx * 3 + 1] = cg;
      colors[idx * 3 + 2] = cb;
    }
  }
  const indices = new Uint16Array(n * n * 6);
  const triUvs = new Float32Array(n * n * 6 * 2);
  let k = 0;
  for (let iy = 0; iy < n; iy++) {
    for (let ix = 0; ix < n; ix++) {
      const a = iy * (n + 1) + ix;
      const b = a + 1;
      const c = a + (n + 1);
      const d = c + 1;
      const tri = [a, c, b, b, c, d];
      for (let t = 0; t < 6; t++) {
        indices[k + t] = tri[t];
        triUvs[(k + t) * 2] = uvs[tri[t] * 2];
        triUvs[(k + t) * 2 + 1] = uvs[tri[t] * 2 + 1];
      }
      k += 6;
    }
  }
  return { positions, uvs, colors, indices, triUvs, radii };
}

/** Panel readout: percent of the authored vignette (0 shows as 「关闭」). */
export function vignettePercent(strength: number): number {
  return Math.round(clampVignetteStrength(strength) * 100);
}
