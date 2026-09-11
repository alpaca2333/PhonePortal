// Transient FX lights: the short-lived point lights that muzzle flashes and explosions leave behind.
//
// WHY ONE SHARED SYSTEM (and not an array per effect): the renderer can only afford a FIXED number of
// point lights, because the count is per-fragment cost on every lit material AND part of three's
// shader program cache key (see render.ts::BULLET_LIGHTS). Every "something just flashed here" event
// therefore has to compete for the same small pool, so one list plus one priority rule beats N lists
// that each believe they own a light.
//
// WHAT THE SIM OWNS vs WHAT THE RENDERER OWNS: the sim stores only the SPEC (where, how bright, how
// long) and a clock `t`; the intensity for a given frame is DERIVED from that clock by
// `fxLightScale`. Nothing stores a per-frame intensity, so a light can never drift out of step with
// the effect that spawned it, and the decay curve has exactly one definition for every producer.
// The renderer copies the current value into a real THREE.PointLight and does nothing else.
//
// NO DEPENDENCIES (not even config.ts): this is pure bookkeeping plus one power curve, shared by
// weapons (muzzle.ts recipes), the explosion (config.ts knobs) and the renderer's pool loop.

/**
 * Hard cap on live transient lights. The only writers are real events whose lights are far shorter
 * than their cadence, so normal play holds one or two; a hand-written definition with a huge lifetime
 * would otherwise grow this array without bound, and it is per-frame render state, not gameplay
 * state. At the cap the OLDEST entry is dropped — for a light, the newest event is the one worth
 * showing.
 */
export const FX_LIGHT_MAX = 16;

/** One transient light, as the sim sees it. Plain numbers: the renderer reads it, nothing mutates it. */
export interface FxLight {
  /** world XZ of the event (the muzzle point, or the blast centre) */
  x: number;
  z: number;
  /** height above the ground (world units) */
  y: number;
  /** unit direction for the optional `forward` offset; (0, 0) when the light sits where it spawned */
  dx: number;
  dz: number;
  /**
   * How far to push the light along (dx, dz).
   *
   * WHY ANYONE WOULD WANT THIS: a muzzle light is a point source ~0.8 units from the shooter, and a
   * point light with `decay = 2` that close saturates the toon ramp on the player's OWN body — at the
   * SMG's 10 shots/second that is a 10 Hz white strobe on your own character. Pushing it forward
   * moves it away from the shooter while still lighting the muzzle smoke and the ground. Explosions
   * leave it 0 (the light belongs exactly where the blast is).
   */
  forward: number;
  /** seconds elapsed; advanced by the sim, read by the renderer */
  t: number;
  /** total life in seconds (`t >= max` means finished) */
  max: number;
  color: number;
  /** PEAK intensity, i.e. the value at `t = 0` */
  intensity: number;
  distance: number;
  /**
   * Decay exponent of `(1 - t/max) ^ falloff`: high = a snap (a gunshot's 2.8), low = a lingering
   * burn (an explosion's 2.0 designed around a 0.5s fireball).
   */
  falloff: number;
}

/** What a producer hands to `makeFxLight`. */
export interface FxLightSpec {
  x: number;
  z: number;
  y: number;
  color: number;
  intensity: number;
  distance: number;
  /** seconds; the light is over at `t >= life` */
  life: number;
  falloff: number;
  forward?: number;
  dx?: number;
  dz?: number;
}

/**
 * Build a light, or return null when the spec is unusable.
 *
 * The rule this project lives by is "dirty data must be discarded, never thrown": a producer with a
 * NaN position or a zero/NaN life must not put a NaN uniform into the light pool (that is exactly
 * how a single bad number turns into a black screen).
 */
export function makeFxLight(spec: FxLightSpec): FxLight | null {
  if (!spec || typeof spec !== 'object') return null;
  if (!Number.isFinite(spec.x) || !Number.isFinite(spec.z) || !Number.isFinite(spec.y)) return null;
  if (!Number.isFinite(spec.life) || !(spec.life > 0)) return null;
  if (!Number.isFinite(spec.falloff) || !(spec.falloff > 0)) return null;
  if (!Number.isFinite(spec.intensity) || spec.intensity < 0) return null;
  if (!Number.isFinite(spec.distance) || spec.distance < 0) return null;
  if (!Number.isFinite(spec.color)) return null;
  const forward = spec.forward ?? 0;
  const dx = spec.dx ?? 0;
  const dz = spec.dz ?? 0;
  if (!Number.isFinite(forward) || forward < 0) return null;
  if (!Number.isFinite(dx) || !Number.isFinite(dz)) return null;
  return {
    x: spec.x, z: spec.z, y: spec.y,
    dx, dz, forward,
    t: 0, max: spec.life,
    color: spec.color, intensity: spec.intensity, distance: spec.distance, falloff: spec.falloff,
  };
}

/** Append a light, enforcing FX_LIGHT_MAX by dropping the OLDEST entry. */
export function pushFxLight(list: FxLight[], light: FxLight): void {
  if (list.length >= FX_LIGHT_MAX) list.shift();
  list.push(light);
}

/**
 * Intensity over the light's life as a 1 -> 0 factor: `(1 - t/max) ^ falloff`.
 *
 * A power curve (not a linear fade) because these are all SPIKES: a gunshot drops to 10% inside its
 * first 0.04s of 0.05s, while an explosion's 0.5s tail is still at 67% when its 0.09s flash layer is
 * over and ~10% when the last fireball puff dies. NaN/negative input is clamped rather than
 * propagated.
 */
export function fxLightScale(t: number, max: number, falloff: number): number {
  if (!Number.isFinite(t) || !Number.isFinite(max) || !Number.isFinite(falloff)) return 0;
  if (!(max > 0)) return 0;
  const f = falloff > 0 ? falloff : 1;
  const u = t / max;
  if (u <= 0) return 1;
  if (u >= 1) return 0;
  return Math.pow(1 - u, f);
}
