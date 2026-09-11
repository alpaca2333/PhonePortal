// Weapon definitions: cadence, magazine + reload, how many projectiles leave the muzzle, how
// they spread, what the muzzle flash looks like — and, for melee weapons, the swing arc. Weapons
// are data + a fire routine, so swapping the player's weapon is a single id assignment
// (`player.weaponId`), with no branch in game.ts.
//
// Design notes:
//   - `kind` is a discriminated union ('ranged' | 'melee'), so the fire routine switches
//     exhaustively and a melee weapon can never be asked for a muzzle position.
//   - A ranged weapon needs an aim direction (returns false when there is none, and the sim
//     retries on CONFIG.noAimRetry). A melee weapon only needs the owner's facing, so it
//     still swings while walking with no aim input.
//   - The weapon does NOT know about bullets: it asks the context to spawn a projectile
//     defined in projectiles.ts. Adding an ammo type never touches this file.
//   - The weapon also does NOT own its ammo COUNT: `magSize` / `reloadTime` are shared read-only
//     data, so the per-player magazine state (rounds left, reload timer) lives on `Player` in
//     game.ts. Never mutate a definition — every player/instance would share it.
import { Vec2, v2, add, sub, scale, norm, len } from './math2.js';
import type { CombatContext, ProjectileDef } from './projectiles.js';
import { PROJECTILES } from './projectiles.js';
// TYPE-ONLY, and deliberately so: items.ts imports projectiles.ts at runtime (`items ->
// projectiles`), so a value import here would be a cycle. `import type` is erased by tsc, leaving
// exactly one direction: items.ts owns the AmmoId union, weapons.ts names it.
import type { AmmoId } from './items.js';
// The muzzle-flash recipes. muzzle.ts is a leaf (config.ts only), so this is a one-way edge, and
// putting the VFX data there instead of inline keeps this file about CADENCE and AMMO, not smoke
// sizes. The recipes themselves are asserted in Node against this table (see verify-muzzle.mjs).
import { MUZZLE } from './muzzle.js';
import type { MuzzleFlashDef } from './muzzle.js';

export type WeaponKind = 'ranged' | 'melee';

interface WeaponBase {
  readonly id: string;
  readonly name: string;
  /** seconds between attacks */
  readonly cooldown: number;
  /** screen-shake impulse applied when an attack actually happens */
  readonly shake: number;
  /**
   * Camera RECOIL in world units, applied OPPOSITE the shot direction (the view is pushed back along
   * the shot line and recovers in a few frames). This is the directional half of "the gun kicks":
   * `shake` is the random rattle, this is the push. Tuned per weapon by weight — the RPG shoves the
   * frame a third of a screen, the SMG is a light continuous nudge — and 0 is legal (melee keeps the
   * shake only). See game.ts::addRecoil for the accumulation/recovery model and verify-ammo.mjs for
   * the "heavier gun kicks harder" ordering assertion.
   */
  readonly recoil: number;
}

export interface RangedWeaponDef extends WeaponBase {
  readonly kind: 'ranged';
  /** ammo fired by each shot (see projectiles.ts) */
  readonly projectile: ProjectileDef;
  /**
   * Which backpack ammo type feeds this weapon's magazine. Reserve rounds are counted by summing
   * the matching ammo items in the bag (see inventory.ts::reserveOf), and reloading draws from
   * them — so this string is the whole link between a weapon and its supply.
   */
  readonly ammoId: AmmoId;
  /** projectiles per shot */
  readonly pellets: number;
  /** half-angle (radians) of the random pellet cone; 0 = perfectly accurate */
  readonly spread: number;
  /** muzzle distance measured beyond the owner's collision radius */
  readonly muzzleOffset: number;
  /**
   * What leaves the barrel when this weapon fires (colours, layers, spark counts, and the coloured
   * light that comes with them). Required: a new ranged weapon must decide what its muzzle looks
   * like, and `fireWeapon()` emits it at the exact point the projectiles leave — the flash and the
   * rounds cannot drift apart because only one place computes that point.
   *
   * The DATA lives in muzzle.ts (one preset per weapon) rather than here, so the weapon table stays
   * readable and every muzzle recipe sits next to its siblings.
   */
  readonly muzzle: MuzzleFlashDef;
  /**
   * Rounds per magazine, counted in SHOTS (one trigger pull = one round, however many pellets
   * that shot fires). 0 = no magazine: the weapon never reloads and never runs dry (rpg).
   */
  readonly magSize: number;
  /**
   * Seconds to refill an empty magazine. Ignored when `magSize === 0`; `<= 0` with a real
   * magazine means the refill is instantaneous (documented footgun — do not "disable" reload
   * that way, use `magSize: 0`).
   */
  readonly reloadTime: number;
}

export interface MeleeWeaponDef extends WeaponBase {
  readonly kind: 'melee';
  readonly damage: number;
  /** reach measured from the owner's centre (the target's radius is added on top) */
  readonly reach: number;
  /** total swing arc in radians, centred on the owner's facing */
  readonly arc: number;
  /** sparks spawned on each enemy hit */
  readonly sparks: number;
  /**
   * Seconds the crescent takes to travel the arc. VISUAL ONLY — the damage lands in one instant
   * on the fire frame (a melee sweep is not a moving hitbox). Kept separate from `cooldown` so a
   * future weapon can have a long recovery without an equally long, muddy trail.
   */
  readonly swingTime: number;
  /**
   * Seconds the swing body animation owns the player. Must be >= `swingTime` (the clip keeps
   * settling after the blade stops) but < `cooldown`, otherwise the next swing would cut off the
   * previous animation and the alternating slice clips would never read.
   */
  readonly swingAnimTime: number;
}

export type WeaponDef = RangedWeaponDef | MeleeWeaponDef;

/** What the sim must expose so a weapon can attack. Implemented by GameSim. */
export interface FireContext extends CombatContext {
  /**
   * The entity holding the weapon. `aimAngle` is its current facing (radians); `swingDir` is the
   * melee sweep direction the sim alternates per swing (+1 / -1) — the weapon reads it, the sim
   * flips it AFTER the swing resolves, so one call sees one consistent direction.
   */
  readonly owner: {
    readonly pos: Vec2;
    readonly r: number;
    readonly aimAngle: number;
    readonly swingDir: 1 | -1;
  };
  /** Push one projectile into the world, flying along `dir` (unit vector). */
  spawnProjectile(def: ProjectileDef, pos: Vec2, dir: Vec2): void;
  /**
   * The muzzle flash (particles + coloured light) for ONE shot, at `pos` — which is the exact point
   * the projectiles of this shot spawn from, and along the weapon's nominal aim `dir` (never a
   * pellet's spread direction). Called once per shot however many pellets there are.
   *
   * `def` comes off the weapon so the sim stays weapon-agnostic; an unusable/absent definition must
   * be a silent no-op (the sim must still be able to fire any hand-built weapon, see
   * scripts/verify-muzzle.mjs).
   */
  spawnMuzzleFlash(pos: Vec2, dir: Vec2, def: MuzzleFlashDef): void;
  /**
   * Show one melee sweep: a crescent that travels `arc` radians over `time` seconds, plus the
   * slipstream it sheds while travelling (see GameSim.spawnSlash / slash.ts). The weapon passes
   * the SAME reach/arc it is about to test against, so the drawn cone and the damaged cone cannot
   * drift apart.
   */
  spawnSlash(aim: number, reach: number, arc: number, dir: 1 | -1, time: number): void;
  /**
   * The blade landing on an enemy: cold sparks plus a tight ring at the impact, distinct from a
   * projectile's fire `spawnSplash`. `sparks` is the weapon's hit-spark count.
   */
  spawnMeleeHit(pos: Vec2, normal: Vec2, sparks: number): void;
}

/**
 * Fire `w` once. Returns true when the attack happened, in which case the caller resets its
 * cooldown to `w.cooldown`; false means "could not attack" (ranged weapon without an aim
 * direction) and the caller should retry on the short CONFIG.noAimRetry timer instead.
 */
export function fireWeapon(ctx: FireContext, w: WeaponDef, aimDir: Vec2 | null): boolean {
  if (w.kind === 'ranged') {
    if (!aimDir) return false;
    const dir = norm(aimDir);
    const muzzle = add(ctx.owner.pos, scale(dir, ctx.owner.r + w.muzzleOffset));
    const base = Math.atan2(dir.y, dir.x);
    // The muzzle flash comes FIRST: it is the cause, the pellets are the effect, and emitting it
    // before the loop keeps the flash's random draws in a fixed place in the RNG stream (the trace
    // fingerprint in scripts/trace-shooter.mjs depends on that order). ONE flash per shot, not one
    // per pellet — `pellets: 8` on the dragon breath is still a single muzzle event.
    ctx.spawnMuzzleFlash(muzzle, dir, w.muzzle);
    for (let i = 0; i < w.pellets; i++) {
      const a = base + (Math.random() * 2 - 1) * w.spread;
      ctx.spawnProjectile(w.projectile, muzzle, v2(Math.cos(a), Math.sin(a)));
    }
    ctx.addShake(w.shake);
    // Recoil: the camera is pushed BACK along the shot line (a unit vector, negated). Called with the
    // muzzle flash/particles already emitted, so the RNG order of a shot is unchanged.
    ctx.addRecoil(w.recoil, -dir.x, -dir.y);
    return true;
  }

  // Melee: sweep the whole arc in front of the owner. No projectile and no aim vector required —
  // the swing follows the facing that game.ts already resolved this frame.
  //
  // The crescent is spawned with the SAME (reach, arc) this loop is about to test, so the drawn
  // sweep is a literal picture of the damage cone (see slash.ts for that invariant).
  ctx.spawnSlash(ctx.owner.aimAngle, w.reach, w.arc, ctx.owner.swingDir, w.swingTime);
  const dir = v2(Math.cos(ctx.owner.aimAngle), Math.sin(ctx.owner.aimAngle));
  const halfArc = w.arc * 0.5;
  let hitAny = false;
  for (const e of ctx.enemyList()) {
    if (!e.alive) continue;
    const to = sub(e.pos, ctx.owner.pos);
    const d = len(to);
    if (d > w.reach + e.r) continue;
    if (d > 1e-4) {
      let da = Math.atan2(to.y, to.x) - ctx.owner.aimAngle;
      while (da > Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      if (Math.abs(da) > halfArc) continue;
    }
    const normal = d > 1e-4 ? norm(to) : dir;
    // Cover blocks the blade: a sword must not cut through a wall. Checked AFTER the cheap
    // distance/angle rejects so the line test only runs for targets that are actually in the cone.
    if (ctx.lineBlocked(ctx.owner.pos, e.pos)) continue;
    const killed = ctx.damageEnemy(e, w.damage);
    ctx.spawnMeleeHit(e.pos, normal, w.sparks);
    if (killed) ctx.resolveDeath(e);
    hitAny = true;
  }
  // A swing always consumes the cooldown, even when it whiffs (standard melee feel).
  if (hitAny) {
    ctx.addShake(w.shake);
    // Same semantics as the ranged path (a unit direction, here the swing's facing). The shipped sword
    // declares `recoil: 0` — the request was about firearms — but the field works for melee too.
    ctx.addRecoil(w.recoil, -dir.x, -dir.y);
  }
  return true;
}

// ---------------------------------------------------------------------------
// The arsenal
// ---------------------------------------------------------------------------
const dragonBreath: RangedWeaponDef = {
  id: 'dragonBreath',
  name: '龙息喷',
  kind: 'ranged',
  // Cadence history: 0.13s (a 9.2x faster spam that read as a machine gun) -> 1.2s -> 1.0s -> 0.6s.
  // Balance side effect: theoretical DPS 8x8/0.13 = 492 -> 8x8/1.2 = 53.3 -> 8x8/1.0 = 64 ->
  // 8x8/0.6 = 106.7 while a magazine lasts (8 shots = 4.8s), then 1.5s of reload. Sustained over
  // a full 6.3s magazine cycle: 8 volleys x 64 / 6.3 = 81.3 direct dps (burn stacks add on top).
  // A chaser (100 HP) still dies to 2 volleys (t ~= 0.6s). If that reads too strong, tune the
  // projectile's damage or `pellets` — not the cadence.
  //
  // ON-SCREEN PELLET COUNT CHANGED WITH THE MAP (ARENA_HALF 20 -> 38; see config.ts and
  // projectiles.ts::flameShot). Bullets die at the arena boundary, so on a small map a volley was
  // gone before the next one left the barrel and only 8 pellets ever shared the screen. On the
  // 76x76 map a volley fired from the centre lives 0.635s — LONGER than the 0.6s cadence — so two
  // volleys (16 pellets) are in flight, and 24 in the corner-to-corner worst case. That invariant
  // was a property of the map, not of this weapon; both new numbers are asserted in
  // scripts/verify-ammo.mjs so the docs cannot drift again.
  cooldown: 0.6,
  shake: 0.06,
  // 0.30 units ~ 3.5 blocks at the default 2 CSS px pixelation, ~9 px at the reference framing: a
  // clear shove per volley without walking the camera away from the player at a 0.6s cadence.
  recoil: 0.30,
  projectile: PROJECTILES.flameShot,
  ammoId: 'ammoShell',
  pellets: 8,
  spread: 0.22,
  muzzleOffset: 0.2,
  // Flame tongue + a fan of sparks, longest life 0.26s: "枪口火花，灵动自然" but never long enough to
  // outlive the 0.6s cadence (see verify-muzzle.mjs).
  muzzle: MUZZLE.dragonBreath,
  magSize: 8,       // 8 shells; each shell still fires the full 8-pellet spread
  reloadTime: 1.5,
};

const smg: RangedWeaponDef = {
  id: 'smg',
  name: '冲锋枪',
  kind: 'ranged',
  // 13 rounds/second = **780 rounds per minute** (0.1s / 1.3, real-device request 「射速提高 1.3 倍」,
  // up from 10/s = 600 rpm). `main.ts` clamps dt to 0.05s and the sim fires at most once per frame,
  // so this cadence needs >= 20 fps to be representable at all; below that the sim clock itself
  // slows down, so shots per SIMULATED second still hold.
  //
  // ⚠️ 0.0769s is NOT a whole number of 60fps frames (4.6 frames). Resetting `fireTimer` to the
  // cooldown after each shot would quantise this up to 5 frames = 0.0833s = 12/s = 720 rpm — i.e.
  // 1.2x, not the requested 1.3x — while the old 0.1s (exactly 6 frames) hid that bug completely.
  // `game.ts` now CARRIES the overshoot (`fireTimer += cooldown`, clamped), so the long-run rate is
  // exact and frame-rate independent; `verify-ammo.mjs` measures it at 30/60/120 fps.
  cooldown: 0.1 / 1.3,
  shake: 0.01,      // small per-shot kick; at 10/s a bigger value would be a constant rumble
  // 0.10 per shot at 10/s against the sim's recovery settles around ~0.2 units of standing push: a
  // visible continuous nudge while held, gone within a couple of frames of releasing the trigger.
  recoil: 0.10,
  projectile: PROJECTILES.smgRound,
  ammoId: 'ammo9mm',
  pellets: 1,
  // `spread` is a HALF-angle in `fireWeapon()`, so this is +/-6 degrees (12 degrees total), kept in
  // degrees here so the intent stays readable. History: 1.3 -> 3 degrees (real-device feedback that
  // the gun was too laser-accurate) -> 6 degrees (real-device request 「子弹散射角度扩大一倍」).
  // CONSEQUENCE, so nobody re-derives it later: at 100 u/s over the gunner's 12-unit sight band a
  // round now lands up to 12*tan(6deg) = 1.26 units off the aim line, which is wider than an enemy
  // body (r = 0.7) — so beyond ~7 units the SMG is a suppression weapon, not a marksman's, and
  // sustained fire at long range trades accuracy for the 10/s cadence. `verify-ammo.mjs` still
  // asserts the cone is exactly +/-6 deg and uniform.
  spread: (6 * Math.PI) / 180,
  muzzleOffset: 0.25,
  // A white-hot core + halo + a 7-spike star, all dead within 0.065s (the cadence is 0.0769s), so
  // sustained fire is a flicker on the barrel and never a glow. No smoke layer on purpose: at
  // 10 rounds/s a wisp would stack into a permanent haze (see muzzle.ts).
  muzzle: MUZZLE.smg,
  magSize: 30,
  reloadTime: 1.5,
};

const rpg: RangedWeaponDef = {
  id: 'rpg',
  name: '火箭筒',
  kind: 'ranged',
  cooldown: 1.6,
  shake: 0.35,
  // The heavy one: 0.90 units is ~1/4 of the reference frustum height, i.e. the frame lurches and
  // settles over ~0.3s. One shot per 1.6s, so it can never accumulate into a drift.
  recoil: 0.90,
  projectile: PROJECTILES.rocket,
  ammoId: 'ammoRocket',
  pellets: 1,
  spread: 0.02,
  muzzleOffset: 0.25,
  // Six layers, including the signature one: an open-tube launcher's fire is BEHIND the shooter
  // (a rearward streak cone) plus the smoke and debris additive blending cannot draw.
  muzzle: MUZZLE.rpg,
  // No MAGAZINE, but no longer infinite: each shot spends one rocket straight out of the backpack
  // reserve (see game.ts's fire section). `magSize: 0` still means "no magazine, never reloads" —
  // it just means the round comes off the reserve directly instead of through a reload.
  magSize: 0,
  reloadTime: 0,
};

const sword: MeleeWeaponDef = {
  id: 'sword',
  name: '砍刀',
  kind: 'melee',
  cooldown: 0.5,
  shake: 0.12,
  recoil: 0,        // firearms only (the request): a swing keeps the existing shake, no camera push
  damage: 34,
  // Reach 2.2 -> 3.4 after real-device feedback that the blade "距离太近": at the reference framing
  // (1 world unit ≈ 29 CSS px, see config.ts) 2.2 units is ~64 px of reach, which is inside the
  // character's own silhouette once you account for its 2.0-unit height drawn at an angle. 3.4
  // units ≈ 100 px: the sweep now clearly leaves the body. Contact damage triggers at
  // playerR + enemyR = 1.25, so this still out-ranges a chaser by a wide margin.
  reach: 3.4,
  // 180° (was 1.9 rad ≈ 109°): the whole front half. This is a deliberate, large AoE buff — the
  // sword now hits every enemy in front of the player, so its effective DPS scales with the crowd
  // instead of staying single-target. Damage was left at 34 on purpose (no unrequested nerf); if
  // the crowd clear is too strong, cut `damage` rather than the arc, since the arc is the point.
  arc: Math.PI,
  sparks: 6,
  // 0.22 -> 0.17s together with the ease-out curve (CONFIG.slashEase): the blade now covers 87.5% of
  // the arc in the first 0.085s (~5 frames) and creeps through the last 12.5% as follow-through. The
  // old 0.22s spent its first half accelerating, which is what read as "太慢 / 没有力量感".
  swingTime: 0.17,
  swingAnimTime: 0.36, // > swingTime so the slice clip settles; < cooldown so swings never overlap
};

export const WEAPONS = { dragonBreath, smg, rpg, sword } satisfies Record<string, WeaponDef>;
export type WeaponId = keyof typeof WEAPONS;

/** The weapon the player starts with, and the default primary slot in the starting loadout.
 *
 * Currently the SMG, so it can be tested from the first second (the shotgun sits in the secondary
 * slot — the loadout is in inventory.ts::createInventory). */
export const DEFAULT_WEAPON: WeaponId = 'smg';

/** Look a weapon up by id, falling back to the default for unknown ids. */
export function getWeapon(id: WeaponId | string): WeaponDef {
  return (WEAPONS as Record<string, WeaponDef>)[id] ?? WEAPONS[DEFAULT_WEAPON];
}

/**
 * Look a weapon up by id, or null when the id is unknown / empty.
 *
 * WHY BOTH THIS AND `getWeapon`: the fallback version is the historical behaviour ("an unknown id
 * quietly becomes the default"), which is right for a data lookup. But since weapons now live in
 * inventory slots, "the active slot is EMPTY" is a real state (`player.weaponId === ''`) and it
 * must NOT silently arm the player with the default SMG — an empty slot has to mean no weapon.
 */
export function getWeaponOrNull(id: WeaponId | string | null | undefined): WeaponDef | null {
  if (typeof id !== 'string' || id === '') return null;
  return (WEAPONS as Record<string, WeaponDef>)[id] ?? null;
}

/**
 * Rounds in a weapon's magazine, 0 for anything without one (melee weapons and ranged weapons
 * with `magSize: 0`). Single source of truth: game.ts checks it to decide whether to consume
 * ammo / auto-reload, render.ts uses it for the HUD.
 */
export function magSizeOf(w: WeaponDef): number {
  return w.kind === 'ranged' ? w.magSize : 0;
}

/** The backpack ammo type a weapon feeds from, or null for melee weapons (no ammo at all). */
export function ammoIdOf(w: WeaponDef | null | undefined): AmmoId | null {
  return w && w.kind === 'ranged' ? w.ammoId : null;
}
