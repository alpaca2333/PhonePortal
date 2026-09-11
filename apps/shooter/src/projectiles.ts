// Projectile ("ammo") definitions: one entry per bullet type, each carrying its own
// flight stats, its own visuals and its own ON-HIT logic. Weapons decide *when and how many*
// to fire; this file decides *what a projectile does when it connects*.
//
// Kept free of three.js and of game.ts so the sim stays node-testable: the sim implements
// `CombatContext` and passes itself in, which is also what keeps this module a leaf
// (projectiles.ts -> config.ts/math2.ts only, so game.ts can import it without a cycle).
import { Vec2, norm, sub, scale, len, dist } from './math2.js';
// Armour is a pure leaf module (no imports of its own), so the projectile layer may name its type
// without creating a cycle. Optional on the fixtures: a hand-built enemy in a test may simply omit it.
import type { ArmorState, RoundProfile } from './armor.js';

/** One stack of a damage-over-time effect. Owned and ticked by the sim (see `applyBurn`). */
export interface BurnStack {
  /** sim time (seconds) at which this stack stops ticking */
  endTime: number;
  /** sim time of the next tick */
  nextTick: number;
  /** damage applied per tick */
  dps: number;
  /** seconds between ticks */
  period: number;
}

/** Structural view of an enemy — the sim's richer Enemy satisfies it. */
export interface EnemyLike {
  pos: Vec2;
  r: number;
  hp: number;
  alive: boolean;
  /** enemy taxonomy ('chaser' | 'sprinter' | ...); only the sim's resolveDeath reads it */
  kind: string;
  /** seconds of red hit-flash left; written by the sim's damageEnemy() */
  hitFlash: number;
  /** active damage-over-time stacks (each hit pushes one; see CombatContext.applyBurn) */
  burns: BurnStack[];
  /**
   * Armour plate, when the target wears one. The sim's `damageEnemy` reads AND rewrites it (that
   * is the only reason this is on the structural view rather than internal to game.ts). Absent =
   * no armour, which is also what a bare test fixture gets.
   */
  armor?: ArmorState | null;
}

/** Structural view of an in-flight projectile (what `onHit` may read). */
export interface ProjectileLike extends RoundProfile {
  pos: Vec2;
  vel: Vec2;
  r: number;
  life: number;
  damage: number;
}

/**
 * The world-side API a projectile is allowed to touch. Implemented by GameSim.
 *
 * ORDER MATTERS: `damageEnemy()` only mutates numbers, `resolveDeath()` does the
 * score/shake/death-burst tail. Callers must run `damageEnemy -> onHit -> resolveDeath`
 * so the per-projectile VFX still lands between the hit and the death burst, exactly like
 * the pre-refactor inline code did (it also keeps the Math.random draw order stable).
 */
export interface CombatContext {
  /**
   * hp -= dmg, hitFlash = hitFlashTime. Returns true when this hit killed the enemy.
   *
   * `round` is the round's penetration profile (see armor.ts). Passing the projectile itself is the
   * normal case; a bare number is read as `{level: n, penetration: n}`; OMITTING it means "this
   * damage ignores armour" — which is what melee, enemy contact damage and the burn DoT do on
   * purpose (burn damage is direct flesh, and it is the dragon-breath shell's only flesh damage
   * while a plate is still intact).
   */
  damageEnemy(e: EnemyLike, dmg: number, round?: RoundProfile | number): boolean;
  /** Score + shake + death burst for an enemy that `damageEnemy` just killed. */
  resolveDeath(e: EnemyLike): void;
  /** Fire sparks fanned along `normal` (see GameSim.spawnSplash). */
  spawnSplash(pos: Vec2, normal: Vec2, n: number): void;
  /** Omnidirectional particle burst (see GameSim.spawnBurst). */
  spawnBurst(pos: Vec2, n: number, color: string): void;
  /**
   * The RPG's layered detonation at `pos`: flash + fireball + radial shockwave ring + ember arcs
   * + smoke + solid debris (see GameSim.spawnExplosion). One call, no parameters to tune from
   * the ammo side — the layers and their tuning live with the particle system.
   *
   * `radius` (optional) is the DAMAGE radius the effect must depict. It defaults to
   * ROCKET_BLAST_RADIUS, so the rocket calls it with one argument; thrown ordnance passes its own
   * smaller radius and the whole effect (including the shockwave ring's maximum radius) scales to
   * match, which is what keeps "what you see is what it hits" true for both.
   */
  spawnExplosion(pos: Vec2, radius?: number): void;
  addShake(v: number): void;
  /**
   * Add a camera RECOIL kick: `amount` world units along the unit direction (dx, dz). Unlike
   * `addShake` (a random amplitude the renderer jitters by) this is DIRECTIONAL and ACCUMULATES, so
   * sustained fire pushes the view back along the shot line and the sim's recovery pulls it home —
   * see game.ts::addRecoil and weapons.ts's per-weapon `recoil`.
   */
  addRecoil(amount: number, dx: number, dz: number): void;
  /**
   * Push one damage-over-time stack onto `e`. Stacks are INDEPENDENT: each keeps its own
   * `endTime`/`nextTick`, so N hits mean N ticks per period until each expires on its own
   * schedule (they never refresh each other). The sim ticks them once per frame.
   */
  applyBurn(e: EnemyLike, dps: number, duration: number, period: number): void;
  /** Live enemy list (used for melee sweeps and AoE queries). */
  enemyList(): readonly EnemyLike[];
  /**
   * Is the straight line `a`-`b` interrupted by cover? The blast below uses it so an explosion
   * cannot splash around a corner; the sim's own bullet loop uses the same test so a wall stops a
   * round for either side.
   */
  lineBlocked(a: Vec2, b: Vec2): boolean;
}

/** Everything render.ts needs to draw a projectile, so the renderer never knows its type. */
export interface ProjectileVisual {
  /** core colour (additive: keep G/B low, see the colour note below) */
  color: number;
  glowColor: number;
  /** per-axis multiplier applied to `size` for the glow sheath */
  glowScale: [number, number, number];
  /** box size in world units: (width, height, length) */
  size: [number, number, number];
  lightColor: number;
  lightIntensity: number;
  lightDistance: number;
}

export interface ProjectileDef {
  readonly id: string;
  readonly speed: number;   // world units / second
  readonly radius: number;  // collision radius
  readonly life: number;    // seconds before it despawns
  readonly damage: number;  // direct damage to the enemy it hits
  /**
   * DISPLAY level 1..6 (see armor.ts). This drives the HUD badge and the inventory colours only —
   * the damage maths is fed `penetration`. Kept as the single source for the display value:
   * items.ts reads it off this definition, so the badge can never disagree with the ammo item.
   */
  readonly level: number;
  /**
   * 0..6 penetration fed to the DEFAULT armour/flesh formulas. Absent = the round sells itself at
   * its display level, which is what every ordinary round does. A value BELOW `level` means "hits
   * hard but does not pierce" (the dragon-breath shell: level 4, penetration 0).
   */
  readonly penetration?: number;
  /**
   * Optional OVERRIDE tables, one entry per ARMOUR level 1..6 (index 0 = armour level 1), as
   * multipliers on this round's damage. A missing entry, a `null`, or a corrupt value falls back to
   * the default formula for that armour level — so a partial table is valid and dirty data can never
   * turn into NaN damage. See armor.ts for the resolution order.
   */
  readonly vsArmor?: readonly (number | null)[];
  readonly vsFlesh?: readonly (number | null)[];
  readonly visual: ProjectileVisual;
  /**
   * The per-type logic. `point` is the swept impact point (see the bullet loop in game.ts).
   *
   * `enemy` is NULL when the round was stopped by cover. The impact still resolves — an RPG hitting
   * a wall has to detonate, and a pellet hitting a wall should still spark — there just is no target
   * to burn or blast. Implementations must handle the null case.
   */
  readonly onHit: (ctx: CombatContext, bullet: ProjectileLike, enemy: EnemyLike | null, point: Vec2) => void;
  /**
   * OPTIONAL: what happens when `life` runs out naturally, at `point`. Without this hook a round
   * simply vanishes at the end of its life (every gun in the game). Thrown ordnance uses it as its
   * fuse: a grenade has no target to hit, it just detonates where it ran out of time.
   *
   * Kept SEPARATE from the arena-exit cull on purpose: leaving the map must never detonate a
   * grenade outside the playfield.
   */
  readonly onLifeEnd?: (ctx: CombatContext, bullet: ProjectileLike, point: Vec2) => void;
}

// ---------------------------------------------------------------------------
// flameShot — the dragon-breath pellet (default weapon's ammo)
// ---------------------------------------------------------------------------
// Every pellet that connects also sets the target alight: one burn stack = 1 damage every
// 0.5 seconds for 5 seconds (10 ticks at +0.5s..+5s, i.e. 10 damage per stack = 2 dps).
// Stacks are independent, so an 8-pellet volley that lands fully means 16 damage/s for 5s
// (80 extra damage on top of the 64 direct). The tick rate was raised from 1s to 0.5s AND the
// per-tick damage kept at 1 (deliberate: the burn is meant to be a real damage source, not just
// a tempo effect) — that doubled the per-stack total from 5 to 10. Each tick also pulses the
// red hit flash, and the sim emits rising flame particles continuously while a target burns.
export const BURN_DPS = 1;        // damage per tick, per stack
export const BURN_DURATION = 5;   // seconds one stack lasts
export const BURN_PERIOD = 0.5;   // seconds between ticks (10 ticks per stack)
//
// Colour rule (moved here with the visuals): the materials are additive and the renderer
// runs NoToneMapping, so stacked pellets CLIP at 1.0 per channel. Two consequences drive the
// numbers below: (a) saturation has to come from pushing G/B down, never from brightening the
// whole colour; (b) any warm colour with G ≳ 0.34 clips to yellow once three pellets overlap,
// so hue is chosen for the SINGLE-pellet read (that is what the player sees in flight) and the
// overlap case is accepted, not pretended away. The per-instance channels are `color` (the core,
// drawn at full intensity) and `glowColor` (an additive sheath at BULLET_GLOW_OPACITY = 0.45);
// the core therefore dominates the read even though the sheath is the wider part.
//
// RETUNED ON REQUEST (「子弹太粗了，调细一点。也有点太红了，橙一点」). Both knobs are per-instance and
// live in the table below — no renderer change, because every projectile is a unit box scaled by
// `size` plus that sheath at `size * glowScale` (render.ts):
//   * THINNER: core 0.08 -> 0.055, sheath 3.6x -> 3.2x, i.e. the drawn width 0.288 -> 0.176 world
//     units (-39%) — just under the SMG tracer's drawn width (0.06 x 3 = 0.18), so a pellet reads
//     as the smallest thing on screen, a thin streak rather than a small rocket. Length stays near
//     1.0 so the streak still shows its direction of travel (0.95 core / 1.14 sheath).
//     `radius` (0.18) is the COLLISION radius and is deliberately untouched: the request was about
//     how the pellet LOOKS, and moving the hitbox would change the weapon's damage output.
//   * MORE ORANGE, LESS RED: core 0xff4200 (hue 15.5°) -> 0xff5f13 (19.3°), sheath 0xff5a10 (19.2°)
//     -> 0xff8a2e (26.4°), light 0xff4a12 -> 0xff6a1c (20.6°). That lands the pellet inside the
//     colour band the weapon already throws — FIRE_PALETTE's five oranges span 15.7°..36° and the
//     dragon-breath muzzle light is 0xff5a14 ≈ 20° — instead of at its red end. Measured composite
//     of one pellet (core + 0.45 x sheath): hue ≈ 33°, up from ≈ 24°.
//     KNOWN TRADE-OFF: 2 stacked cores now read 42° (was 31°) and 3 read 60° (yellow), because the
//     change moved G up. That is additive clipping, not a bug, and it only shows in the tight
//     muzzle cluster of a volley. If that cluster ever reads too yellow, lower the CORE's green
//     first (0xff4a10 restores the old stacking) — do not dim the sheath or the light.
const flameShot: ProjectileDef = {
  id: 'flameShot',
  // Speed history: 90 -> 63 u/s (-30%, on request: the pellets read as too fast/frantic).
  // Consequences that matter: 1.05 world units per frame at 60fps (was 1.5) against a 0.88 hit
  // radius, so the swept segment test in game.ts is still required.
  //
  // ARENA SIZE CHANGED THIS AMMO'S WORST CASE (ARENA_HALF 20 -> 38, see config.ts). Bullets are
  // culled at |pos| > ARENA_HALF + 2, so flight distance is set by the map:
  //   - from the centre, a volley now travels 40 units -> 0.635s, LONGER than the 0.6s cadence, so
  //     TWO volleys (16 pellets) share the screen; corner-to-corner is ~77 units -> 24 pellets.
  //     The old "at most one volley in flight / max 8 pellets" invariant was a property of the
  //     small map, not of the weapon, and it is gone. Both numbers are asserted in verify-ammo.
  //   - `life` is a pure safety net again only because it was raised to 1.6s (101 units, longer
  //     than the ~77-unit worst case); at the old 1.1s a long diagonal shot expired in mid-air.
  speed: 63,
  radius: 0.18,
  life: 1.6,
  damage: 8,
  // ---------------------------------------------------------------------------------------------
  // THE FIRST ROUND WITH A HAND-WRITTEN PENETRATION PROFILE (user spec). It is the worked example
  // of "the default ladder is only a default":
  //   * DISPLAY level 4 — the HUD badge and the inventory cell show Lv4 (purple). Display only.
  //   * penetration 0 — fed to the default formulas, which for a shell means "cannot pierce":
  //     default armour damage would be 0.7^armourLevel and default flesh damage 0 against ANY plate.
  //   * vsArmor overrides that: full armour damage up to level 4, 80% at level 5, 50% at level 6.
  //   * vsFlesh is NOT overridden, so flesh stays at the penetration-0 default = 0% through a plate.
  // Net: a can-opener. It never hurts flesh through an intact plate, but it strips one fast (8
  // pellets x 8 damage x 100% = 64 armour per volley: a wave-1 28-value plate and a level-3 44-value
  // plate both break in ONE volley, a level-6 68-value plate in three), and the BURN stacks it
  // applies on every pellet do direct flesh damage the whole time (see armor.ts's header).
  // ---------------------------------------------------------------------------------------------
  level: 4,                            // 显示等级（徽章/颜色）—— 不参与伤害计算
  penetration: 0,                      // 结算用的穿甲等级：默认公式按"完全不能穿甲"算
  vsArmor: [1, 1, 1, 1, 0.8, 0.5],     // 对 1–4 级甲 100%、5 级 80%、6 级 50% 甲伤
  visual: {
    color: 0xff5f13,
    glowColor: 0xff8a2e,
    glowScale: [3.2, 3.2, 1.2],
    size: [0.055, 0.055, 0.95],
    lightColor: 0xff6a1c,
    lightIntensity: 10,
    lightDistance: 9,
  },
  onHit(ctx, bullet, enemy, point) {
    // `enemy` is null when the pellet was stopped by cover: an impact is still an impact (sparks),
    // but there is nothing to set alight. The normal then falls back to the reversed pellet
    // direction, which is also the existing degenerate-case fallback for a centre hit.
    let n = enemy ? norm(sub(point, enemy.pos)) : norm(scale(bullet.vel, -1));
    if (len(n) < 1e-3) n = norm(scale(bullet.vel, -1));
    ctx.spawnSplash(point, n, 7);
    // Set the target alight — one stack per pellet, so `pellets: 8` means 8 stacks per volley.
    if (enemy) ctx.applyBurn(enemy, BURN_DPS, BURN_DURATION, BURN_PERIOD);
  },
};

// ---------------------------------------------------------------------------
// smgRound — the sub-machine gun's round: fast, tiny, no special effect
// ---------------------------------------------------------------------------
// The spread lives on the WEAPON — `weapons.ts::smg.spread`, a half-angle: 3 deg when this ammo
// shipped, 6 deg since the 「子弹散射角度扩大一倍」 request — never here; this file owns flight,
// visuals and on-hit only.
// Speed history: 300 -> 100 u/s, because 300 was
// faster than the tracer could read — it moved 5 world units per frame at 60fps, i.e. 6x the hit
// radius, so the bullet skipped between frames and the 0.9-unit tracer looked like a dotted line.
// At 100 u/s it moves 1.67 units/frame (2x the 0.82 hit radius) and the same tracer covers ~54%
// of the gap, which reads as motion. The swept segment test in game.ts is still load-bearing
// (a point test would tunnel).
//   - Flight: the arena boundary (|pos| > ARENA_HALF + 2 = 40) culls a round after at most 0.4s,
//     and `life` is 1.0s (100 units), so the boundary always wins — which is exactly the point of
//     the split. Before the map grew to 76x76 a 0.4s life was already longer than any possible
//     flight; it is now the SHORTER of the two, so it had to be raised (40 units would have expired
//     in mid-air on a long diagonal shot).
// No burn and no splash fan: a 10-rounds-per-second weapon must not spawn 7 fire streaks per
// hit. The impact is a small warm puff through the existing `spawnBurst` (no new API, and it
// reuses the shared particle mesh, so no extra draw call).
const smgRound: ProjectileDef = {
  id: 'smgRound',
  speed: 100,
  radius: 0.12,
  life: 1.0,
  damage: 10,
  level: 2,            // 9mm: held back by level-3+ plates (the default gunner plate)
  visual: {
    // Warm tracer. Same additive rule as the other ammo (projectiles.ts header): keep the hue
    // stable under clipping by leaving B low, so stacked rounds brighten toward yellow-white
    // instead of washing out the whole screen.
    color: 0xffb020,
    glowColor: 0xffd060,
    glowScale: [3, 3, 1.2],
    size: [0.06, 0.06, 0.9],
    lightColor: 0xffa030,
    lightIntensity: 6,
    lightDistance: 6,
  },
  onHit(ctx, _bullet, _enemy, point) {
    ctx.spawnBurst(point, 6, '#ffcf6a');
  },
};

// ---------------------------------------------------------------------------
// rocket — RPG round: no splash fan, a real area explosion
// ---------------------------------------------------------------------------
// BALANCE (on request: 伤害 -30% / 爆炸半径 +50%) — deliberately a trade of single-target damage
// for area. The 30% cut applies to BOTH numbers, the direct hit (60 -> 42) and the full blast
// (70 -> 49), so a point-blank hit goes 130 -> 91 (= exactly 0.7x) while the covered area goes
// from 3.5^2 to 5.25^2 = 2.25x. Cutting ONLY the blast would leave a point-blank hit at -16%,
// i.e. it would not feel weaker at all, which is why the direct hit is included; if the direct
// hit should be preserved, `damage` below is the single constant to put back.
//
// ⚠️ THE RADIUS IS COUPLED TO THE EXPLOSION VFX. GameSim.spawnExplosion scales every layer's
// sizes and speeds by ROCKET_BLAST_RADIUS / 3.5 and the shockwave ring's maximum radius is
// ASSERTED to equal the damage radius ("视觉即伤害范围", scripts/verify-burn.mjs). So changing the
// radius rescales the whole effect automatically — never hand-tune the layer numbers to compensate,
// and never move this constant without re-running verify-burn.
export const ROCKET_BLAST_RADIUS = 5.25;   // 3.5 -> 5.25 (+50%): area x2.25
export const ROCKET_BLAST_DAMAGE = 49;     // 70 -> 49 (-30%): damage at the epicentre, linear falloff

const rocket: ProjectileDef = {
  id: 'rocket',
  speed: 45,
  radius: 0.3,
  life: 3,
  damage: 42,          // direct hit (60 -> 42 with the -30% cut); the blast below stacks on top
  level: 5,            // rockets punch through every plate except the level-6 one
  visual: {
    color: 0xff7a00,
    glowColor: 0xffa040,
    glowScale: [4.2, 4.2, 1.5],
    size: [0.16, 0.16, 1.35],
    lightColor: 0xff6a12,
    lightIntensity: 14,
    lightDistance: 12,
  },
  onHit(ctx, bullet, _enemy, point) {
    // Layered detonation (flash / fireball / shockwave ring / embers / smoke / debris). Replaced
    // a flat 28-spark `spawnBurst`, which read as just another death burst and shared the
    // dragon-breath splash's vocabulary of thin additive streaks. See GameSim.spawnExplosion.
    //
    // BLAST ORIGIN, NOT IMPACT POINT: when a rocket hits cover the impact point lies exactly ON the
    // wall face, and a line-of-sight query that STARTS on a box boundary is ambiguous — the slab test
    // reports t = 0 whether the segment then goes into the box or away from it. So the blast is
    // centred a little back along the incoming direction, which is unambiguously on the NEAR side.
    // That is both the honest answer (the grenade went off in front of the wall, not inside it) and
    // what makes "front side takes the hit, back side is protected" fall out with no epsilon tuning.
    const origin = sub(point, scale(norm(bullet.vel), 0.1));
    ctx.spawnExplosion(origin);
    ctx.addShake(0.5);
    // AoE with linear falloff from the blast origin. Snapshot first: damaging an enemy can
    // kill it (alive=false), and we still want to apply the blast to everyone in range.
    const targets = ctx.enemyList().filter((e) => e.alive
      && dist(e.pos, origin) <= ROCKET_BLAST_RADIUS + e.r
      && !ctx.lineBlocked(origin, e.pos));
    for (const e of targets) {
      const falloff = Math.max(0, 1 - dist(e.pos, origin) / ROCKET_BLAST_RADIUS);
      // The blast carries the ROUND's profile (`bullet`), exactly like the direct hit and like the
      // grenade below: two explosives must not disagree about armour. Without this argument the
      // blast would be "true damage" that ignores plates entirely — which is what it accidentally
      // was until the profile work, while the grenade already respected them.
      if (ctx.damageEnemy(e, ROCKET_BLAST_DAMAGE * falloff, bullet)) ctx.resolveDeath(e);
    }
  },
};

// ---------------------------------------------------------------------------
// grenade — the throwable: a fused area charge, not a bullet
// ---------------------------------------------------------------------------
// Deliberately NOT a gun: `damage: 0` means the direct contact does no damage at all, the whole
// payload is the blast. Two hooks call the SAME detonation because a grenade can end in three ways
// — it runs out of fuse in mid-air (`onLifeEnd`), it hits cover (`onHit` with a null enemy), or it
// hits an enemy (`onHit`) — and all three must go off identically.
//
// The blast radius is its own constant (4.2, smaller than the rocket's 5.25) and is PASSED to
// `spawnExplosion`, so the drawn shockwave still traces the damage area — the "视觉即伤害范围"
// rule from the rocket holds for thrown ordnance too (verify-burn asserts the ring maths).
//
// FUSE, NOT DISTANCE: speed 20 x fuse 0.9s ≈ 18 world units of travel, i.e. a lob across most of
// one engagement. There is no arc and no bounce — cover stops it and it goes off against the wall
// (documented simplification; see apps/shooter/README.md).
export const GRENADE_FUSE = 0.9;      // seconds
export const GRENADE_RADIUS = 4.2;    // world units
export const GRENADE_DAMAGE = 65;     // at the epicentre, linear falloff to the rim

const grenade: ProjectileDef = {
  id: 'grenade',
  speed: 20,
  radius: 0.22,
  life: GRENADE_FUSE,
  damage: 0,           // no direct hit: the blast below is the entire effect
  level: 3,            // frag charge: sells itself at level 3 (no penetration override, so pen = 3)
  visual: {
    // A short, fat, pale-warm charge — deliberately NOT a long tracer like the bullets, so a
    // thrown object reads as "something lobbed" rather than as another round in flight.
    color: 0xffe08a,
    glowColor: 0xfff3c0,
    glowScale: [2.2, 2.2, 1.1],
    size: [0.16, 0.16, 0.34],
    lightColor: 0xffd070,
    lightIntensity: 5,
    lightDistance: 6,
  },
  onHit(ctx, bullet, _enemy, point) { detonate(ctx, bullet, point); },
  onLifeEnd(ctx, bullet, point) { detonate(ctx, bullet, point); },
};

/**
 * Shared detonation for both grenade hooks. Mirrors the rocket's blast exactly — same
 * line-of-sight filter (an explosion must not splash around a corner), same linear falloff, same
 * "back the origin off the impact face" trick to avoid a line query that starts on a box boundary
 * — but with its own radius, which is also handed to the VFX.
 */
function detonate(ctx: CombatContext, bullet: ProjectileLike, point: Vec2): void {
  const origin = sub(point, scale(norm(bullet.vel), 0.1));
  ctx.spawnExplosion(origin, GRENADE_RADIUS);
  ctx.addShake(0.4);
  const targets = ctx.enemyList().filter((e) => e.alive
    && dist(e.pos, origin) <= GRENADE_RADIUS + e.r
    && !ctx.lineBlocked(origin, e.pos));
  for (const e of targets) {
    const falloff = Math.max(0, 1 - dist(e.pos, origin) / GRENADE_RADIUS);
    // Same as the rocket: the round's own profile decides how much of the blast is armour and how
    // much is flesh (see armor.ts).
    if (ctx.damageEnemy(e, GRENADE_DAMAGE * falloff, bullet)) ctx.resolveDeath(e);
  }
}

// ---------------------------------------------------------------------------
// enemyRound — the gunner's round: slow, visible, hostile-coloured
// ---------------------------------------------------------------------------
// The design constraints, in order of importance:
//   1. DODGEABLE. 34 u/s is slower than every player projectile, so a round crosses the gunners'
//      12-unit engagement range in ~0.35s — long enough to read the aim telegraph and step behind
//      cover. This is the single number that makes the gunfight fair rather than punishing.
//   2. UNMISTAKABLE. It must never be confused with the player's amber tracer (0xffb020), so it is
//      magenta: in a crowded firefight the colour is the only cue that says "this one is incoming".
//   3. CHEAP. `onHit` is a small puff and nothing else. Enemy rounds arrive in volleys and must not
//      flood the particle pool.
// Deliberately NO burn and NO splash fan: the player has 100 HP and 0.6s of i-frames, so the threat
// is meant to come from positioning and volume, not from a damage-over-time the player cannot see.
const enemyRound: ProjectileDef = {
  id: 'enemyRound',
  speed: 34,
  radius: 0.18,
  life: 2.5,           // 85 units — longer than the ~77-unit worst-case flight (see ARENA_HALF)
  damage: 6,
  level: 3,            // matches the player's default level-3 plate: 50% flesh until it breaks
  visual: {
    // Additive + NoToneMapping clips at 1.0 per channel, so keep R high and G low: overlapping
    // rounds brighten toward pink-white while the HUE stays hostile, the same rule the other ammo
    // follows (projectiles.ts header).
    color: 0xff2a6a,
    glowColor: 0xff5a90,
    glowScale: [3.2, 3.2, 1.2],
    size: [0.07, 0.07, 0.8],
    lightColor: 0xff2a6a,
    lightIntensity: 6,
    lightDistance: 7,
  },
  onHit(ctx, _bullet, _enemy, point) {
    ctx.spawnBurst(point, 3, '#ff7aa0');
  },
};

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------
export const PROJECTILES = { flameShot, smgRound, rocket, grenade, enemyRound } satisfies Record<string, ProjectileDef>;
export type ProjectileId = keyof typeof PROJECTILES;
