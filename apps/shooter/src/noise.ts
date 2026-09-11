// Pure 2D curl noise (no three dependency) so the sim stays node-testable.
// Curl of a scalar field is divergence-free: sparks swirl without clumping or
// vanishing, which reads as turbulent fire instead of straight radial lines.

function hash3(xi: number, yi: number, zi: number): number {
  let n = Math.imul(xi, 0x1b873593) ^ Math.imul(yi, 0x85ebca6b) ^ Math.imul(zi, 0xc2b2ae35);
  n = Math.imul(n ^ (n >>> 15), 0x9e3779b1);
  n = Math.imul(n ^ (n >>> 13), 0x9e3779b1);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296; // 0..1
}

const SMOOTH = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

// Trilinear-interpolated value noise (C1 smooth, cheap, no permutation table).
function value3(x: number, y: number, z: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = SMOOTH(xf), v = SMOOTH(yf), w = SMOOTH(zf);
  const c000 = hash3(xi, yi, zi),       c100 = hash3(xi + 1, yi, zi);
  const c010 = hash3(xi, yi + 1, zi),   c110 = hash3(xi + 1, yi + 1, zi);
  const c001 = hash3(xi, yi, zi + 1),   c101 = hash3(xi + 1, yi, zi + 1);
  const c011 = hash3(xi, yi + 1, zi + 1), c111 = hash3(xi + 1, yi + 1, zi + 1);
  const x00 = c000 + (c100 - c000) * u;
  const x10 = c010 + (c110 - c010) * u;
  const x01 = c001 + (c101 - c001) * u;
  const x11 = c011 + (c111 - c011) * u;
  const y0 = x00 + (x10 - x00) * v;
  const y1 = x01 + (x11 - x01) * v;
  return y0 + (y1 - y0) * w;
}

// Two-octave fractal noise for more spark-like detail.
function fbm2(x: number, y: number, z: number): number {
  return value3(x, y, z) * 0.65 + value3(x * 2.13, y * 2.13, z * 2.13) * 0.35;
}

// Spatial frequency: one noise "cell" spans ~1/FREQ world units. FREQ=0.25 makes
// swirl features ~4 units wide, which fits the 40x40 arena.
const FREQ = 0.25;
const EPS = 0.01;

// curl φ = (∂φ/∂y, -∂φ/∂x), evaluated with a central finite difference. The
// chain rule factor FREQ keeps the returned vector in world-space units.
export function curl2(x: number, y: number, t: number): { x: number; y: number } {
  const X = x * FREQ, Y = y * FREQ;
  const dx = (fbm2(X + EPS, Y, t) - fbm2(X - EPS, Y, t)) / (2 * EPS);
  const dy = (fbm2(X, Y + EPS, t) - fbm2(X, Y - EPS, t)) / (2 * EPS);
  return { x: dy * FREQ, y: -dx * FREQ };
}

/**
 * The scalar field that `curl2` differentiates, exposed in 0..1 (same world-unit coordinates).
 * Used for per-instance VFX flicker (flame brightness) so the noise that moves particles also
 * makes them shimmer — one field, one implementation, still node-testable.
 */
export function noise2(x: number, y: number, t: number): number {
  return fbm2(x * FREQ, y * FREQ, t);
}
