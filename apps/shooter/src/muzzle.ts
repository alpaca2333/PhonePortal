// Muzzle flash: the per-weapon RECIPE (pure data + pure math) for what leaves the barrel when a
// ranged weapon fires, plus the light that comes with it.
//
// WHY THIS IS ITS OWN MODULE (and why it imports only config.ts):
//   * a muzzle flash is per-WEAPON data, exactly like melee's `sparks`/`swingTime` or a
//     projectile's `visual`. Keeping the recipes in `weapons.ts` would bury the weapon table
//     (cadence/magazine/pellets) under ~30 VFX fields per gun, and keeping them in `game.ts`
//     would make "what does the shotgun's muzzle look like" a code path instead of a table;
//   * the sim (game.ts) only INTERPRETS a recipe: one generic loop over `layers`. Adding a fourth
//     ranged weapon means adding a layer list here — no new branch anywhere;
//   * the numbers are assertable without a browser: `scripts/verify-muzzle.mjs` reads this module
//     and the weapon table and checks the invariants that make the effects behave (see below).
//
// THE LAYER MODEL IS THE "LAYERED, HIGH-END" REQUIREMENT MADE STRUCTURAL. A muzzle flash reads as
// expensive because several things happen at once at different scales and speeds: a white-hot core
// (1-3 frames), a dim wider halo behind it, thin streaks shooting out of the cone, sometimes a
// pressure ring, sometimes a flame tongue, sometimes dark smoke and debris left hanging in the air.
// So a recipe is a LIST of layers, each with its own physics preset, palette, size/life/speed
// ranges, emission cone and brightness. `MUZZLE_PHYSICS` is deliberately a copy of the physics the
// game has ALREADY verified elsewhere (impact sparks, burn flames, the explosion's ring / smoke /
// debris / embers), so "the shotgun's muzzle tongue is the same fire as the burn DoT" is literally
// true in the code and stays true if those constants are retuned.
//
// THE INVARIANT THAT MATTERS (asserted, not eyeballed): every weapon's longest-lived muzzle
// particle dies BEFORE the weapon can fire again (`muzzleMaxLife(def) < weapon.cooldown`), and so
// does the light. That is the numeric form of the three requests — the SMG's "一闪而过", the
// shotgun's "不要时长太长", the RPG's "爆燃但不拖沓" — and it is what stops a held trigger from
// stacking flashes into a permanent glow stuck to the barrel.
//
// WHAT IS DELIBERATELY ABSENT:
//   * no new mesh, material, texture or shader. Layers are plain `Particle`s in the sim's existing
//     array, drawn by the existing additive / normal-blended instanced pools (so a muzzle flash
//     costs ZERO extra draw calls);
//   * no new light pool. The light is replayed by the renderer through the SAME capped 8-point-light
//     pool the projectiles use, as one entry in the shared transient-light list (fxlight.ts) — a
//     second pool would raise the scene's point-light count, which is per-fragment cost AND another
//     shader program variant (the explosion feeds the same list; see game.ts::spawnExplosion);
//   * no enemy muzzle flash. The gunner's rounds keep their existing 4-particle magenta burst; giving
//     enemies a full flash needs a hostile palette plus light gating (a hidden gunner's muzzle light
//     would leak its position, like its health bar and aim beam do), which is its own piece of work;
//   * no setting. Intensity is an art constant here, like `CONFIG.flameDim` or `burnGlowStacks`.
import { CONFIG, DEBRIS_PALETTE, FIRE_CORE_PALETTE, FIRE_PALETTE, SMOKE_PALETTE } from './config.js';

/**
 * Height of the muzzle on a 2.0-unit-tall character. This is the same height the gunner's aim beam
 * is drawn at (render.ts::AIM_BEAM_Y), and the one source of truth for it: projectiles render at
 * y = 0.35, but that is a projectile-streak convention, not a "where the gun is" statement.
 */
export const MUZZLE_Y = 0.75;

/**
 * Particles a single shot may emit. Not a runtime clamp (a recipe is internal data, and silently
 * eating half of an effect would be worse than the bug): it is the budget the test suite holds the
 * recipes to, so "one muzzle flash" can never become a measurable chunk of the 2048-particle pool.
 */
export const MUZZLE_PARTICLE_BUDGET = 40;

/**
 * The physics vocabulary. Each entry is the EXISTING tuning of a layer the game already ships
 * (impact sparks, burn flames, the RPG explosion's ring / smoke / debris / embers) — the muzzle
 * effects are new COMPOSITIONS of verified parts, not new particle physics.
 */
export type MuzzlePhysics = 'spark' | 'flame' | 'ring' | 'smoke' | 'debris' | 'ember';

export interface MuzzlePhysicsDef {
  /** camera-facing billboard (true) or a streak stretched along the velocity (false) */
  readonly puff: boolean;
  /** billboard width/height ratio for puffs (1 = square); ignored by streaks */
  readonly aspect: number;
  /** true = normal-blended pool: dark smoke / solid debris, which ADDITIVE CANNOT DRAW AT ALL */
  readonly solid: boolean;
  /** upward acceleration (u/s²); negative = gravity (embers, debris) */
  readonly buoy: number;
  /** per-second velocity damping */
  readonly drag: number;
  /** curl-noise force scale */
  readonly swirl: number;
}

/**
 * The six presets, each a literal copy of an existing verified layer:
 *   spark  — impact splash sparks (CONFIG.sparkDrag / sparkCurl);
 *   flame  — burn flames: the narrow buoyant tongue (flameBuoy/flameDrag/flameSwirl/flameAspect);
 *   ring   — the explosion's shockwave: a damped particle travels v0/drag units in total, so
 *            speed/drag IS the ring's radius (CONFIG.blastRingDrag);
 *   smoke  — the explosion's dark smoke (normal-blended, slow rise, damped);
 *   debris — the explosion's solid chunks (gravity + floor clamp, normal-blended);
 *   ember  — the explosion's embers: fast, low drag, gravity pulling them into an arc.
 */
export const MUZZLE_PHYSICS: Record<MuzzlePhysics, MuzzlePhysicsDef> = {
  spark: { puff: false, aspect: 1, solid: false, buoy: 0, drag: CONFIG.sparkDrag, swirl: CONFIG.sparkCurl },
  flame: {
    puff: true, aspect: CONFIG.flameAspect, solid: false,
    buoy: CONFIG.flameBuoy, drag: CONFIG.flameDrag, swirl: CONFIG.flameSwirl,
  },
  ring: { puff: false, aspect: 1, solid: false, buoy: 0, drag: CONFIG.blastRingDrag, swirl: 0 },
  smoke: {
    puff: true, aspect: 1, solid: true,
    buoy: CONFIG.blastSmokeRise, drag: 1.2, swirl: CONFIG.flameSwirl * 0.6,
  },
  debris: { puff: false, aspect: 1, solid: true, buoy: CONFIG.blastGravity, drag: 3, swirl: 0 },
  ember: {
    puff: false, aspect: 1, solid: false,
    buoy: CONFIG.blastGravity, drag: CONFIG.blastEmberDrag, swirl: CONFIG.sparkCurl * 0.12,
  },
};

/** One layer of a muzzle flash. Ranges are [min, max]; COUNTS ARE ALWAYS EXACT (see `count`). */
export interface MuzzleLayer {
  readonly physics: MuzzlePhysics;
  /**
   * Particles this layer emits, exactly (never a random count). Determinism is what makes the
   * per-shot budget and every "≥ N streaks in the cone" claim in the test suite provable.
   */
  readonly count: number;
  /** additive: dimmed to stay in hue under clipping. solid: LITERAL screen colour, so dim = 1 */
  readonly colors: readonly string[];
  /** world units (1 unit ≈ 29 CSS px at the reference framing) */
  readonly size: [number, number];
  /** streak length in world units; ignored by puffs (omit for puff layers) */
  readonly len?: [number, number];
  readonly life: [number, number];
  readonly speed: [number, number];
  /** initial vertical speed (u/s); omit for ground-flat layers */
  readonly vy?: [number, number];
  /** HALF-angle of the emission cone around `angle` (radians); π = every direction */
  readonly cone: number;
  /** centre of the emission cone: 0 = straight ahead, π = straight back (the RPG's backblast) */
  readonly angle?: number;
  /** spread the particles EVENLY across the cone by index instead of randomly (shockwave rings:
   *  a 6-particle ring drawn with random angles is visibly lopsided) */
  readonly even?: boolean;
  /** random vertical jitter of the spawn point (u); 0 = all at MUZZLE_Y */
  readonly ySpread?: number;
  /** colour multiplier. Additive layers dim to survive overlap; solid layers must stay 1 */
  readonly dim: number;
}

export interface MuzzleLight {
  /** warm white-yellow for the SMG, deep orange for the dragon breath, orange-white for the RPG */
  readonly color: number;
  /** PEAK intensity, at the flash's first frame; the renderer decays it (see fxlight.ts::fxLightScale) */
  readonly intensity: number;
  readonly distance: number;
  /** seconds the light lives; must be < the weapon's cooldown (asserted) */
  readonly life: number;
  /** decay exponent of `(1 - t/life) ^ falloff`: high = a snap, low = a lingering burn */
  readonly falloff: number;
  /**
   * How far the light sits AHEAD of the muzzle point along the aim direction.
   *
   * WHY THIS EXISTS: the light is a point source ~0.8 units from the shooter, and with `decay = 2`
   * that saturates the toon ramp on the player's OWN body — at the SMG's 10 shots/second that is a
   * 10 Hz white strobe on your own character. Pushing the light forward moves it away from the
   * shooter (lighting the room and the muzzle smoke about as well) without touching its colour.
   */
  readonly forward: number;
}

export interface MuzzleFlashDef {
  readonly id: string;
  readonly layers: readonly MuzzleLayer[];
  /**
   * The coloured light the shot throws. The sim turns this into a transient `FxLight`
   * (fxlight.ts) — muzzle flashes, explosions and anything else that flashes share ONE list and ONE
   * capped point-light pool in the renderer, because the number of lights in the scene is
   * per-fragment cost and part of three's shader program key.
   */
  readonly light: MuzzleLight;
}

// -------------------------------------------------------------------------------------------
// The recipes
// -------------------------------------------------------------------------------------------
/**
 * SMG — "火光，一闪而过": 3 layers, 9 particles, nothing lives past **0.065s** (< the **0.0769s**
 * cadence), so each shot is its own blip and sustained fire reads as a flicker on the barrel rather
 * than a glow.
 *
 * ⚠️ THE LIFETIMES FOLLOW THE CADENCE (real-device request 「射速提高 1.3 倍」, 0.1s -> 0.1/1.3s): the
 * spark layer used to live up to 0.09s, which was inside the old 0.1s cadence and OUTSIDE the new
 * one — i.e. sustained fire would have stacked flashes into the permanent glow this recipe exists to
 * avoid. `verify-muzzle.mjs` asserts `muzzleMaxLife(def) < weapon.cooldown` for every weapon, so the
 * rate change could not land without this trim. Retuning the rate again means retuning these.
 *
 * A WHITE-HOT CORE IS THE POINT HERE, so this recipe breaks the additive hue rule on purpose: the
 * tracer colours in projectiles.ts push G/B down to stay orange when pellets overlap, but a muzzle
 * flash's core IS white — clipping to white on the first frame is the effect, not a bug. The halo
 * layer underneath (dimmed `FIRE_PALETTE`) is what keeps an orange fringe around it.
 *
 * NO SMOKE LAYER: at 10 rounds/second even a 0.3s wisp would stack ~3 deep into a permanent haze
 * over the barrel. The shotgun and the RPG, which fire once per 0.6s / 1.6s, can afford smoke.
 */
const smg: MuzzleFlashDef = {
  id: 'smg',
  layers: [
    {
      physics: 'flame', count: 1, colors: FIRE_CORE_PALETTE,
      size: [0.28, 0.32], life: [0.045, 0.055], speed: [0, 2], vy: [0.4, 0.8],
      cone: 0.25, dim: 1,
    },
    {
      physics: 'flame', count: 1, colors: FIRE_PALETTE,
      size: [0.70, 0.78], life: [0.05, 0.065], speed: [0, 1],
      cone: 0.25, dim: 0.35,
    },
    {
      // The star: short bright streaks out of the barrel. `len` stays small (0.18-0.30) so the
      // layers read as spikes around the core, not as a fan of tracers.
      physics: 'spark', count: 7, colors: FIRE_CORE_PALETTE,
      size: [0.030, 0.045], len: [0.18, 0.30], life: [0.045, 0.065], speed: [16, 26],
      cone: 0.55, dim: 0.9,
    },
  ],
  light: { color: 0xffd9a0, intensity: 10, distance: 6, life: 0.05, falloff: 2.8, forward: 0.35 },
};

/**
 * Dragon breath — "枪口火花，灵动自然，但持续时间不要太长": 4 layers, 19 particles, longest life 0.26s
 * (well inside the 0.6s cadence).
 *
 * The sparks are the dominant layer (11 of 19) because that is the ask; the `ember` layer is what
 * makes it read as NATURAL rather than as a static burst — gravity turns those four into little
 * arcs that fall away from the muzzle instead of flying in a straight line. The `tongue` layer is
 * the same fire as the burn DoT (flame physics AND the 0.55 aspect) at the barrel, which is what
 * ties the muzzle to what the pellets do on impact.
 */
const dragonBreath: MuzzleFlashDef = {
  id: 'dragonBreath',
  layers: [
    {
      physics: 'flame', count: 3, colors: FIRE_PALETTE,
      size: [0.32, 0.45], life: [0.14, 0.20], speed: [8, 16], vy: [0.5, 1.2],
      cone: 0.35, ySpread: 0.1, dim: 0.5,
    },
    {
      physics: 'spark', count: 11, colors: FIRE_PALETTE,
      size: [0.035, 0.055], len: [0.30, 0.50], life: [0.10, 0.22], speed: [16, 30],
      cone: 0.75, dim: 0.9,
    },
    {
      physics: 'flame', count: 1, colors: FIRE_CORE_PALETTE,
      size: [0.32, 0.36], life: [0.06, 0.08], speed: [0, 2],
      cone: 0.2, dim: 1,
    },
    {
      physics: 'ember', count: 4, colors: FIRE_CORE_PALETTE,
      size: [0.028, 0.040], len: [0.22, 0.36], life: [0.18, 0.26], speed: [8, 14], vy: [2.0, 4.0],
      cone: 0.5, dim: 0.8,
    },
  ],
  light: { color: 0xff5a14, intensity: 18, distance: 10, life: 0.22, falloff: 1.6, forward: 0.3 },
};

/**
 * RPG — "枪口爆燃": 6 layers, 31 particles, longest life 0.5s (< the 1.6s cadence).
 *
 * THE `backblast` LAYER IS THE WHOLE POINT of this one: a rocket launcher is an open tube, so the
 * visible fire is behind the shooter. It fires a rearward cone (`angle: π`) of streaks while the
 * `fireball` puffs bloom around the muzzle, the `ring` traces the launch pressure wave, and the
 * smoke/debris (NORMAL-blended, the two layers additive physically cannot draw) are left hanging
 * in the air behind the player — the cloud the RPG leaves and the rifle does not.
 */
const rpg: MuzzleFlashDef = {
  id: 'rpg',
  layers: [
    {
      physics: 'flame', count: 1, colors: FIRE_CORE_PALETTE,
      size: [0.85, 0.95], life: [0.08, 0.10], speed: [0, 2],
      cone: 0.2, dim: 1,
    },
    {
      physics: 'ring', count: 6, colors: FIRE_CORE_PALETTE,
      size: [0.06, 0.09], len: [0.35, 0.50], life: [0.16, 0.22], speed: [10, 14],
      cone: Math.PI, even: true, dim: 0.7,
    },
    {
      physics: 'flame', count: 6, colors: FIRE_PALETTE,
      size: [0.45, 0.70], life: [0.20, 0.34], speed: [3, 9], vy: [0.8, 1.8],
      cone: 1.2, ySpread: 0.2, dim: 0.5,
    },
    {
      physics: 'spark', count: 10, colors: FIRE_PALETTE,
      size: [0.040, 0.060], len: [0.35, 0.55], life: [0.14, 0.28], speed: [14, 26],
      cone: 0.5, angle: Math.PI, ySpread: 0.15, dim: 0.9,
    },
    {
      physics: 'smoke', count: 4, colors: SMOKE_PALETTE,
      size: [0.50, 0.80], life: [0.32, 0.50], speed: [1, 3], vy: [0.7, 1.1],
      cone: 1.6, ySpread: 0.25, dim: 1,
    },
    {
      physics: 'debris', count: 4, colors: DEBRIS_PALETTE,
      size: [0.06, 0.11], len: [0.10, 0.20], life: [0.25, 0.40], speed: [6, 12], vy: [1.5, 3.5],
      cone: 0.9, ySpread: 0.3, dim: 1,
    },
  ],
  light: { color: 0xffa050, intensity: 40, distance: 15, life: 0.40, falloff: 1.5, forward: 0.45 },
};

export const MUZZLE: { smg: MuzzleFlashDef; dragonBreath: MuzzleFlashDef; rpg: MuzzleFlashDef } = {
  smg, dragonBreath, rpg,
};

// -------------------------------------------------------------------------------------------
// Pure readers
// -------------------------------------------------------------------------------------------
/** Total particles one shot of this weapon emits (the per-shot budget the test asserts). */
export function muzzleParticleCount(def: MuzzleFlashDef): number {
  let n = 0;
  for (const l of def.layers) n += l.count;
  return n;
}

/**
 * Longest life in the recipe, INCLUDING the light. The invariant that makes a muzzle flash read as
 * an event instead of a glow is `muzzleMaxLife(def) < weapon.cooldown` — see the file header.
 */
export function muzzleMaxLife(def: MuzzleFlashDef): number {
  let m = def.light.life;
  for (const l of def.layers) m = Math.max(m, l.life[1]);
  return m;
}

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const nonNegative = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/**
 * Is this a definition the sim may interpret? The recipes above are internal constants, but the
 * weapon table is extensible (a test registers a synthetic weapon, a future weapon may be added by
 * hand) and the rule this project lives by is "dirty data must be discarded, never thrown".
 *
 * It checks STRUCTURE and FINITENESS only — never the art budget: a recipe that is merely large is
 * still meant to render, and the budget is asserted in the test suite instead of silently halving
 * somebody's effect at runtime.
 */
export function isUsableMuzzleDef(def: unknown): def is MuzzleFlashDef {
  if (!def || typeof def !== 'object') return false;
  const d = def as MuzzleFlashDef;
  const light = d.light;
  if (!light || typeof light !== 'object') return false;
  if (!positive(light.life) || !positive(light.falloff)) return false;
  if (!Number.isFinite(light.color)) return false;
  if (!nonNegative(light.intensity) || !nonNegative(light.distance) || !nonNegative(light.forward)) return false;
  // `Array.isArray` narrows a readonly array to `any[]`, which would make every field access below
  // untyped — so the raw element is re-narrowed to the declared shape by hand.
  const raw = d.layers as unknown;
  if (!Array.isArray(raw)) return false;
  for (const entry of raw as readonly unknown[]) {
    if (!entry || typeof entry !== 'object') return false;
    const l = entry as MuzzleLayer;
    if (!MUZZLE_PHYSICS[l.physics]) return false;
    if (!Number.isInteger(l.count) || l.count < 0) return false;
    if (!Array.isArray(l.colors) || l.colors.length === 0) return false;
    if (!positive(l.life[1])) return false;
    if (!positive(l.size[1])) return false;
    if (!nonNegative(l.cone) || !Number.isFinite(l.cone)) return false;
    if (!nonNegative(l.dim)) return false;
    for (const p of [l.life, l.size, l.speed]) {
      if (!Array.isArray(p) || p.length !== 2) return false;
      if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]) || p[0] < 0 || p[1] < p[0]) return false;
    }
    if (l.len && (!Array.isArray(l.len) || !Number.isFinite(l.len[0]) || !Number.isFinite(l.len[1]))) return false;
    if (l.vy && (!Array.isArray(l.vy) || !Number.isFinite(l.vy[0]) || !Number.isFinite(l.vy[1]))) return false;
    if (l.angle !== undefined && !Number.isFinite(l.angle)) return false;
    if (l.ySpread !== undefined && !nonNegative(l.ySpread)) return false;
  }
  return true;
}
