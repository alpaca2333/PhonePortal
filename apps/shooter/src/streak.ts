// Streak orientation math for the instanced particle mesh — a leaf module (no imports at all)
// so it can be asserted in Node (scripts/verify-burn.mjs cross-checks it against the vendored
// three.js), instead of hiding an unverifiable one-liner inside render.ts.
//
// The particle mesh is a unit box scaled to (width, width, length), so its local +Z axis is the
// "length" axis. Orienting a particle therefore means: find the rotation that maps +Z onto the
// particle's velocity direction.
//
// History: before burn flames existed every particle moved in the XZ plane, so the renderer used
// a yaw-only `setFromAxisAngle(Y, atan2(vel.x, vel.y))`. Flames rise, so the rotation now has to
// follow a full 3D direction. `streakQuaternion(vel.x, 0, vel.y)` is mathematically identical to
// that old yaw rotation, which is why ground sparks are visually unchanged.
//
// Returns a plain [x, y, z, w] tuple: render.ts feeds it to THREE.Quaternion.set(), keeping this
// module free of any three.js dependency.

/**
 * Quaternion rotating local +Z onto the (normalised) direction (dx, dy, dz).
 * Degenerate/zero input returns the identity quaternion.
 */
export function streakQuaternion(dx: number, dy: number, dz: number): [number, number, number, number] {
  const len = Math.hypot(dx, dy, dz);
  if (!Number.isFinite(len) || len < 1e-12) return [0, 0, 0, 1];
  const x = dx / len, y = dy / len, z = dz / len;

  // Shortest-arc rotation from +Z = (0,0,1) to (x,y,z).
  //   cross = (0,0,1) x v = (-y, x, 0)   ->  axis in the XY plane
  //   w = 1 + dot = 1 + z
  const w0 = 1 + z;
  if (w0 < 1e-9) {
    // v is (anti)parallel to +Z: any axis perpendicular to +Z works, pick +X (rotation by pi).
    return [1, 0, 0, 0];
  }
  // Normalise: |(-y, x, 0, 1+z)| = sqrt(x² + y² + (1+z)²) = sqrt(2(1+z)) for a unit v.
  const n = Math.hypot(x, y, w0);
  return [-y / n, x / n, 0, w0 / n];
}
