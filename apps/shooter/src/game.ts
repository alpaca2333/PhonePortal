// Pure, browser-free game simulation. Renders nothing; only mutates numeric state.
//
// Weapons live in weapons.ts and projectiles in projectiles.ts. GameSim owns the world and
// implements their contexts (FireContext / CombatContext), so the sim is the only place that
// knows about enemies, particles and score — weapon code stays data-driven and swappable.
import { Vec2, v2, add, sub, scale, len, norm, dist, clampLen, segClosest } from './math2.js';
import { curl2 } from './noise.js';
import {
  ARENA_HALF, CONFIG, EXPLOSION_LIGHT_COLOR, FIRE_PALETTE, FIRE_CORE_PALETTE, SMOKE_PALETTE,
  DEBRIS_PALETTE, DEATH_BURST_COLOR, SLASH_PALETTE,
} from './config.js';
import type { BurnStack, CombatContext, EnemyLike, ProjectileDef } from './projectiles.js';
import { PROJECTILES, ROCKET_BLAST_RADIUS } from './projectiles.js';
import { getWeaponOrNull, magSizeOf, fireWeapon, ammoIdOf } from './weapons.js';
import type { FireContext, WeaponDef, WeaponId } from './weapons.js';
// Armour / penetration: the damage split itself is a pure function in armor.ts, so the SAME rule
// runs for enemies and for the player (whose plate lives in the armour slot of the inventory).
import { armorForWave, resolveHit } from './armor.js';
import type { ArmorState, RoundProfile } from './armor.js';
// Backpack model. Pure rules live in inventory.ts; the sim owns the instance and applies the
// side effects a UI cannot know about (priming a magazine from the reserve, re-deriving the
// equipped weapon). Dependency direction: items -> projectiles -> weapons -> inventory -> game.
import {
  addAmmo as bagAddAmmo, applyMove, canMove, consumeAmmo, createInventory, getItem,
  isWeaponItem, reserveOf as bagReserve, takeOne,
} from './inventory.js';
import type { AmmoId, Inventory, ItemRef } from './inventory.js';
import { HEALINGS } from './items.js';
import { makeSlash, slashAlive, slashAngle, slashProgress } from './slash.js';
import type { SlashFx } from './slash.js';
// Muzzle flashes: the recipe (data) and the light math live in muzzle.ts; the sim only INTERPRETS a
// recipe into particles (one generic loop over `layers`) and keeps the light state the renderer
// replays. `MUZZLE_PHYSICS` is the same particle physics the sparks/flames/explosion already use.
import { MUZZLE_PHYSICS, MUZZLE_Y, isUsableMuzzleDef } from './muzzle.js';
import type { MuzzleFlashDef, MuzzleLayer } from './muzzle.js';
// Transient lights (muzzle flashes AND explosions) share ONE list and ONE renderer pool — see
// fxlight.ts for why the scene's point-light budget forces that, and render.ts for the priority.
import { makeFxLight, pushFxLight } from './fxlight.js';
import type { FxLight } from './fxlight.js';
// Cover: the layout + the solid/line-of-sight queries. Imported as `coverBlocks` so the
// CombatContext method of the same name cannot be confused with the module function.
import {
  OBSTACLES, firstCoverHit, lineBlocked as coverBlocks, overlapsCover, resolveCover,
} from './level.js';
import type { Obstacle } from './level.js';
// The visibility predicate, shared with the renderer: auto-aim locks only onto what is drawn.
// No cycle — vision.ts depends on math2.ts + level.ts only (see apps/shooter/README.md).
import { visibleWithReveal } from './vision.js';

// Re-exported so existing importers (render.ts, node verification snippets) keep working.
export { ARENA_HALF, CONFIG };

export interface Entity {
  id: number;
  pos: Vec2;
  vel: Vec2;
  r: number;
  hp: number;
  maxHp: number;
  alive: boolean;
}

export interface Player extends Entity {
  aimAngle: number; // facing (radians, XZ plane)
  fireTimer: number;
  invuln: number;
  firing: boolean;
  moving: boolean;
  /** firing AND a resolved aim direction this frame: i.e. `aimAngle` really is the aim
   *  direction (drives the aiming line in render.ts). False while merely walking. */
  aiming: boolean;
  /**
   * Which entry of WEAPONS this player carries, i.e. what the ACTIVE weapon slot (primary or
   * secondary) currently holds. `''` is a real state since weapons live in inventory slots: the
   * player can drag both weapons out and end up empty-handed, and an empty slot must mean "no
   * weapon", not "silently arm the default gun" (see weapons.ts::getWeaponOrNull).
   */
  weaponId: WeaponId | '';
  /**
   * Rounds left in the magazine, counted in SHOTS (one trigger pull = one round). Only
   * meaningful when the equipped weapon has `magSizeOf(weapon) > 0`; for a no-magazine weapon
   * (rpg) or a melee weapon it stays 0 and is never read.
   *
   * WHY HERE and not on the weapon definition: definitions are shared read-only data, so a
   * magazine state stored there would be shared by every holder (and every future bot). The
   * ROUNDS themselves are mirrored from the equipped weapon ITEM in the backpack
   * (items.ts) — this field is the live copy the fire loop and the HUD read.
   */
  ammo: number;
  /** seconds left in the reload in progress; 0 = not reloading */
  reloadTimer: number;
  /** total duration of the reload in progress (HUD progress bar); 0 when idle */
  reloadTotal: number;
  /**
   * A use request from a discrete action (the throwable / healing buttons and their desktop keys).
   * `requestUse()` records it and `update()` consumes it once the frame's aim direction is known,
   * because "where does the grenade go" is a per-frame decision the button cannot make. Kept as
   * state rather than per-frame input so the button stays a leaf DOM module (see weaponButton.ts).
   */
  pendingUse: 'throwable' | 'healing' | null;
  /** seconds before the throwable can be used again */
  throwCd: number;
  /** seconds before the healing item can be used again */
  healCd: number;
  /**
   * Melee sweep direction for the NEXT swing (+1 / -1). `fireWeapon()` reads it to orient the
   * crescent; the sim flips it only AFTER the swing resolved, so one swing sees one direction and
   * consecutive swings alternate. Alternating is the cheapest way to stop a repeated attack from
   * reading as one canned animation — see also the alternating slice clip in render.ts.
   */
  swingDir: 1 | -1;
  /**
   * Monotonic swing counter. The renderer restarts the slice clip when this CHANGES (an edge), so
   * the one-shot animation replays on every swing without the renderer having to poll `swingT`
   * for a 0 -> >0 transition (which would miss a re-swing inside the same animation window).
   */
  swingCount: number;
  /**
   * Seconds left of the swing body animation owning the player; 0 = normal locomotion/aim.
   * While > 0 the renderer plays the full-body slice clip and skips the upper-body aim layer,
   * because a slice is a whole-body motion and layering an aim pose on top of it looks broken.
   */
  swingT: number;
}

export type EnemyKind = 'chaser' | 'sprinter' | 'gunner';

export interface Enemy extends Entity {
  kind: EnemyKind;
  speed: number;
  touchDmg: number;
  hitFlash: number;
  touchCd: number; // per-enemy contact damage cooldown
  /**
   * Gunner trigger timer, counting down the WHOLE cycle: `gunnerAimTime + gunnerFireCd` seconds,
   * of which the last `gunnerAimTime` are the telegraph.
   *
   * WHY ONE TIMER AND NOT `aimT` + `fireT`: two timers can disagree ("is it aiming or cooling
   * down?"), and every state machine that has to keep them in sync eventually desyncs. Deriving
   * `aiming` from a single countdown makes that impossible: telegraphed <=> `fireT <= gunnerAimTime`.
   * Unused by melee kinds.
   */
  fireT: number;
  /**
   * True while the gunner is inside its pre-shot telegraph. The renderer draws the aim beam from
   * this flag, so what the player sees and what the sim is about to do come from one source.
   */
  aiming: boolean;
  /**
   * Active damage-over-time stacks (one per pellet that hit; see `applyBurn`). Each stack is
   * independent — its own `endTime`/`nextTick` — so N stacks tick N times per period and
   * expire on their own schedule instead of refreshing each other.
   */
  burns: BurnStack[];
  /** flame-VFX emission accumulator (particles); advanced by dt while burning, reset at 0 stacks */
  flameAcc: number;
  /**
   * Armour plate for this enemy (see armor.ts), or null for an unarmoured one. Seeded per wave in
   * `spawnEnemy` from CONFIG's two profiles, and chipped by the player's rounds — the enemy bar
   * draws it as a second strip whose COLOUR is the plate's level.
   */
  armor: ArmorState | null;
}

export interface Bullet extends RoundProfile {
  pos: Vec2;
  vel: Vec2;
  r: number;
  life: number;
  damage: number;
  fromPlayer: boolean;
  alive: boolean;
  /** which projectile type this is: carries the visuals and the on-hit logic */
  def: ProjectileDef;
}

export interface Particle {
  pos: Vec2;
  vel: Vec2;
  /** height above the ground plane (world units). Sparks sit flat at 0.2; burn flames rise. */
  y: number;
  /** vertical velocity (world units/s). 0 for ground sparks. */
  vy: number;
  /** upward acceleration (world units/s²). 0 for sparks, positive buoyancy for flames. */
  buoy: number;
  life: number;
  max: number;
  size: number;   // spark width (world units); renders as the streak thickness
  len: number;    // spark length (world units), stretched further by speed
  /** per-second velocity damping (sparks use CONFIG.sparkDrag, flames CONFIG.flameDrag) */
  drag: number;
  /** curl-noise force scale (sparks use CONFIG.sparkCurl, flames CONFIG.flameSwirl) */
  swirl: number;
  /**
   * True for burn flames: the renderer draws them as camera-facing puffs (not streaks stretched
   * along the velocity) and flickers their brightness with `noise2`.
   */
  puff: boolean;
  /** billboard width/height ratio for puffs (1 = square). Ignored by streaks. */
  aspect: number;
  /** random phase (radians) added to the flicker noise, so puffs do not blink in unison */
  flick: number;
  /**
   * True = draw with NORMAL blending (smoke, solid debris), false = additive (fire, sparks).
   *
   * WHY THIS EXISTS: every particle used to be additive, and additive blending cannot draw a
   * dark pixel — a "dark smoke puff" simply contributes nothing, and a "dark debris chunk" is
   * invisible. So the renderer keeps two instanced pools and routes by this flag: additive
   * fire/sparks keep their exact previous look, while smoke/debris get a normal-blended mesh.
   * Cost: one extra draw call, only when something non-additive exists.
   */
  solid: boolean;
  color: string;
  alive: boolean;
}

/** Scale a '#rrggbb' colour by k (0..1). Used to dim additive fire so overlaps stay orange. */
function dimHex(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * k);
  const g = Math.round(((n >> 8) & 255) * k);
  const b = Math.round((n & 255) * k);
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}

export interface InputState {
  move: Vec2;   // normalized-ish, from left stick
  aim: Vec2;    // normalized direction, from right stick (0,0 when idle)
  firing: boolean;
  // Right stick held without a direction (pressed, not dragged): lock onto the nearest
  // live enemy instead of a manual direction. The *choice* of target lives here in the
  // sim so it stays node-testable; input.ts only reports the flag.
  autoAim: boolean;
}

let _id = 1;
const nid = () => _id++;

/**
 * Tolerance for "this timer has expired" comparisons.
 *
 * WHY THIS EXISTS (measured, not theoretical): a cooldown is implemented as
 * `timer -= dt` every frame, and the residual after the mathematically exact number of frames
 * is NOT always <= 0 in IEEE 754. Examples at 60fps (dt = 1/60): 0.1s leaves +2.1e-17 after 6
 * frames, 0.2s leaves +4.9e-17 after 12, 0.5s leaves +1.0e-16 after 30, 1.6s leaves +7.7e-16
 * after 96; at 20fps (dt = 0.05) 0.6s leaves +1.4e-17 after 12 frames. Without a tolerance
 * every one of those waits one EXTRA frame, which is a silent cadence nerf: the SMG's 0.1s
 * would really be 7 frames = 0.1167s (16% slower), the sword's 0.5s would be 0.5167s.
 * 1e-9 is ~7 orders of magnitude above the observed residuals and many orders below any real
 * frame time, so it can never fire a shot genuinely early.
 */
const TIMER_EPS = 1e-9;
/** Hard cap on the accumulated camera recoil (world units); see GameSim::addRecoil. */
const RECOIL_MAX = 2.0;

/**
 * Height at which a falling particle is treated as having landed (just above the floor at
 * y = -0.01 and the grid at y = 0). See the particle loop in `update()`.
 */
const PARTICLE_GROUND_Y = 0.05;

export class GameSim implements FireContext {
  arenaHalf = ARENA_HALF;
  player!: Player;
  /**
   * The player's backpack: 20 cells + the five equipment slots.
   *
   * PUBLIC, but REPLACED BY reset() — a run gets a fresh loadout object, so anything holding this
   * must re-read it (the renderer reads `sim.inventory` every frame; the panel takes a getter, see
   * inventoryPanel.ts). The panel does NOT mutate it directly; every change goes through the methods
   * below (moveItem / requestUse / …), which are the only writers. The renderer reads it every
   * frame for the HUD. Anything that changes WHICH weapon is equipped must go through
   * `moveItem()` / `switchWeapon()` / `equipWeapon()` rather than poking `slots` by hand, so the
   * derived state (`player.weaponId`, the magazine) cannot lag behind.
   */
  inventory: Inventory = createInventory();
  enemies: Enemy[] = [];
  bullets: Bullet[] = [];
  particles: Particle[] = [];
  /**
   * Live melee crescents (see slash.ts). State only — the shape, the sweep curve and the fade all
   * live in slash.ts, and the mesh lives in render.ts, so the sim stays browser-free and testable.
   */
  slashes: SlashFx[] = [];
  /**
   * Live transient lights (see fxlight.ts): one entry per muzzle flash and per explosion. STATE
   * ONLY — the particles those events emitted live in `particles` like everything else; what is left
   * here is the LIGHT, which the renderer replays through the same capped point-light pool the
   * projectiles use.
   *
   * Cleared by `reset()` — it is per-run state, and a flash left over from the previous run would
   * light the new one (the same class of bug as the backpack holding the old run's model).
   */
  fxLights: FxLight[] = [];
  /**
   * Solid cover for this run (layout + height in level.ts).
   *
   * PUBLIC AND REPLACEABLE ON PURPOSE: the weapon suites (`verify-ammo` / `verify-burn` /
   * `verify-melee`) test weapon mechanics, not level design, so they set `sim.obstacles = []` in
   * their `freshSim()` helper instead of accidentally testing cover. The real layout is owned by
   * `scripts/verify-cover.mjs`, which asserts its properties directly.
   */
  obstacles: readonly Obstacle[] = OBSTACLES;
  wave = 1;
  score = 0;
  over = false;
  spawnQueue = 0;
  spawnTimer = 0;
  fireTimer = 0;
  shake = 0; // screen-shake magnitude (renderer reads)
  // Camera RECOIL: a decaying world-space offset the renderer adds to the camera pose (weapons.ts
  // kicks it on every shot). Directional and additive, unlike `shake`'s random amplitude.
  recoilX = 0;
  recoilZ = 0;
  time = 0;  // elapsed sim seconds (drives the curl-noise field)

  constructor() { this.reset(); }

  reset(): void {
    this.player = {
      id: nid(), pos: v2(0, 0), vel: v2(0, 0), r: CONFIG.playerR,
      hp: CONFIG.playerMaxHp, maxHp: CONFIG.playerMaxHp, alive: true,
      aimAngle: 0, fireTimer: 0, invuln: 0, firing: false, moving: false,
      aiming: false, weaponId: '',
      ammo: 0, reloadTimer: 0, reloadTotal: 0,
      pendingUse: null, throwCd: 0, healCd: 0,
      swingDir: 1, swingCount: 0, swingT: 0,
    };
    this.enemies = [];
    this.bullets = [];
    this.particles = [];
    this.slashes = [];
    this.fxLights = [];
    this.obstacles = OBSTACLES;
    this.wave = 1;
    this.score = 0;
    this.over = false;
    this.spawnQueue = this.waveTarget(1);
    this.spawnTimer = 1.0;
    this.fireTimer = 0;
    this.shake = 0;
    this.recoilX = 0;
    this.recoilZ = 0;
    this.time = 0;
    // A fresh backpack every run (the loadout is per-run state, not a setting). `syncLoadout()`
    // then derives the equipped weapon from it and primes that weapon's magazine out of the
    // starting reserve — the single initialisation path, so a new loadout field cannot be
    // forgotten here.
    this.inventory = createInventory();
    this.syncLoadout();
  }

  /**
   * Switch the player's weapon: fill a fresh magazine from the backpack reserve and cancel any
   * reload in progress.
   *
   * The only seam for FORCING a weapon into the ACTIVE slot (desktop tests, node suites); the
   * in-game button goes through `switchWeapon()` instead, which only ever trades the two weapon
   * slots. `fireTimer` is reset so the new weapon is ready immediately (standard weapon-swap feel).
   */
  equipWeapon(id: WeaponId | string): void {
    const w = getWeaponOrNull(id);
    if (!w) return;
    const inv = this.inventory;
    // No silent ammo loss: whatever was in the outgoing weapon's magazine goes back to the bag
    // before it is replaced. Same principle as the drag path (which keeps the rounds ON the item).
    const cur = inv.slots[inv.activeSlot];
    if (isWeaponItem(cur) && cur.primed && cur.ammo > 0) {
      const curAmmo = ammoIdOf(getWeaponOrNull(cur.weaponId));
      if (curAmmo) bagAddAmmo(inv, curAmmo, cur.ammo);
    }
    inv.slots[inv.activeSlot] = { kind: 'weapon', weaponId: w.id, ammo: 0, primed: false };
    this.syncLoadout();
  }

  /**
   * Tap-to-switch between the TWO WEAPON SLOTS (primary <-> secondary). This is the only weapon
   * switching in the game: the throwable and healing slots are used through their own buttons and
   * are never "equipped". Returns false when the other slot has no weapon (a no-op tap).
   *
   * WHY IT CANNOT REFILL A MAGAZINE: the rounds belong to the weapon ITEM, so switching just
   * changes which item is in hand. Without that, tapping the button would be a free reload and the
   * whole reserve-ammo rule would be pointless.
   */
  switchWeapon(): boolean {
    const inv = this.inventory;
    const other: 'primary' | 'secondary' = inv.activeSlot === 'primary' ? 'secondary' : 'primary';
    if (!isWeaponItem(inv.slots[other])) return false;
    this.commitMag();
    inv.activeSlot = other;
    this.syncLoadout();
    return true;
  }

  /** Re-derive the equipped weapon + live magazine from the inventory. Call after any loadout change. */
  syncLoadout(): void {
    const inv = this.inventory;
    const p = this.player;
    // If the active weapon slot lost its weapon, fall back to the other one when it still has one.
    if (!isWeaponItem(inv.slots[inv.activeSlot])) {
      const other: 'primary' | 'secondary' = inv.activeSlot === 'primary' ? 'secondary' : 'primary';
      if (isWeaponItem(inv.slots[other])) inv.activeSlot = other;
    }
    const item = inv.slots[inv.activeSlot];
    if (isWeaponItem(item)) {
      p.weaponId = item.weaponId as WeaponId;
      const w = getWeaponOrNull(item.weaponId);
      const mag = w ? magSizeOf(w) : 0;
      if (!item.primed) {
        // First time this weapon is in hand: load it from the bag. `consumeAmmo` returns what was
        // actually available, so a thin reserve gives a partial magazine rather than a free full one.
        const id = w ? ammoIdOf(w) : null;
        item.ammo = id && mag > 0 ? consumeAmmo(inv, id, mag) : 0;
        item.primed = true;
      }
      p.ammo = item.ammo;
    } else {
      p.weaponId = '';
      p.ammo = 0;
    }
    // Any loadout change cancels a reload (documented: switching weapons cancels the reload rather
    // than freezing it per slot).
    p.reloadTimer = 0;
    p.reloadTotal = 0;
    this.fireTimer = 0;
  }

  /** Push the live magazine count back onto the equipped weapon item (fire/reload write-through). */
  private commitMag(): void {
    const item = this.inventory.slots[this.inventory.activeSlot];
    if (isWeaponItem(item)) item.ammo = this.player.ammo;
  }

  /** The equipped weapon, or null when the active slot is empty. */
  activeWeapon(): WeaponDef | null {
    return getWeaponOrNull(this.player.weaponId);
  }

  /** Rounds of `ammoId` in the backpack — 「备弹 = 背包中这种武器的子弹总数」. */
  reserveOf(ammoId: AmmoId | null): number {
    return bagReserve(this.inventory, ammoId);
  }

  /** Put ammo into the backpack. Public: this is the seam a future loot/crate system would use. */
  addAmmo(ammoId: AmmoId, n: number): { added: number; ok: boolean } {
    return bagAddAmmo(this.inventory, ammoId, n);
  }

  /**
   * Move an item in the backpack (the drag-and-drop commit). The PANEL never mutates the inventory
   * itself: it asks the sim, so validation, the derived loadout and the magazine bookkeeping live
   * in one place and a rejected drop simply leaves the state untouched.
   */
  moveItem(from: ItemRef, to: ItemRef): boolean {
    if (!canMove(this.inventory, from, to)) return false;
    // Write the live magazine back onto the equipped item BEFORE anything moves: after the swap
    // the active slot may hold a different weapon, and the rounds belong to the item.
    this.commitMag();
    applyMove(this.inventory, from, to);
    this.syncLoadout();
    return true;
  }

  /** Ask for a discrete use (throwable / healing button). Consumed by the next `update()`. */
  requestUse(kind: 'throwable' | 'healing'): boolean {
    if (this.over || !this.player.alive) return false;
    this.player.pendingUse = kind;
    return true;
  }

  /**
   * Apply the pending throwable / healing request, if any.
   *
   * Runs once per frame from `update()` AFTER the aim direction is resolved — that is the whole
   * reason the request is deferred state instead of an immediate action: a grenade has to go
   * where the player is aiming THIS frame, and a DOM button cannot know that.
   *
   * Every guard is a silent no-op (nothing is consumed, no cooldown is spent):
   *   * throwable: on cooldown, or the slot is empty;
   *   * healing: on cooldown, the slot is empty, or the player is already at full HP.
   */
  private resolvePendingUse(aimDir: Vec2 | null): void {
    const p = this.player;
    const kind = p.pendingUse;
    p.pendingUse = null;
    if (!kind) return;

    if (kind === 'throwable') {
      if (p.throwCd > 0) return;
      const ref: ItemRef = { where: 'slot', slot: 'throwable' };
      if (!getItem(this.inventory, ref)) return;
      // No aim direction (walking with no right-stick input) falls back to the current facing, so
      // the button always does something visible.
      const dir = aimDir && len(aimDir) > 1e-3
        ? norm(aimDir)
        : v2(Math.cos(p.aimAngle), Math.sin(p.aimAngle));
      this.spawnProjectile(PROJECTILES.grenade, add(p.pos, scale(dir, p.r + 0.35)), dir);
      takeOne(this.inventory, ref);       // empties the slot -> the HUD button hides itself
      p.throwCd = CONFIG.throwCooldown;
      this.addShake(0.05);
      return;
    }

    if (p.healCd > 0 || p.hp >= p.maxHp) return;
    const ref: ItemRef = { where: 'slot', slot: 'healing' };
    const item = getItem(this.inventory, ref);
    if (!item || item.kind !== 'healing') return;
    const def = HEALINGS[item.id];
    if (!def) return;
    p.hp = Math.min(p.maxHp, p.hp + def.heal);
    takeOne(this.inventory, ref);
    p.healCd = def.cooldown;
    this.spawnBurst(p.pos, 12, '#7dffa8');
  }

  /**
   * Begin the reload for `w`. A no-op without a magazine, while already reloading, when the
   * magazine is full, or — the new rule — when the BACKPACK HAS NO ROUNDS of this ammo type.
   * Returns silently in every no-op case so the caller can call it freely.
   */
  private startReload(w: WeaponDef): void {
    const mag = magSizeOf(w);
    if (mag <= 0) return;
    const p = this.player;
    if (p.reloadTimer > 0) return;
    if (p.ammo >= mag) return;
    const ammoId = ammoIdOf(w);
    if (!ammoId || bagReserve(this.inventory, ammoId) <= 0) return;   // dry: nothing to reload with
    const t = w.kind === 'ranged' ? w.reloadTime : 0;
    if (t <= 0) {
      // reloadTime <= 0 with a magazine = instant refill, still paid for out of the reserve.
      p.ammo += consumeAmmo(this.inventory, ammoId, mag - p.ammo);
      this.commitMag();
      return;
    }
    p.reloadTimer = t;
    p.reloadTotal = t;
  }

  private waveTarget(wave: number): number {
    return Math.min(CONFIG.waveBase + (wave - 1) * CONFIG.waveGrowth, CONFIG.maxEnemies);
  }

  aliveEnemies(): number { return this.enemies.reduce((n, e) => n + (e.alive ? 1 : 0), 0); }

  /**
   * Nearest live enemy the player can actually SEE, or null. Drives right-stick auto-aim.
   *
   * WHY THE VISIBILITY FILTER LIVES IN THE SIM: "which enemy do I lock onto" is a game rule, so the
   * sim owns it (the renderer must not decide it). But the PREDICATE is the renderer's own
   * `vision.ts::visibleWithReveal` — that is the entire point of the design: auto-aim can only lock
   * onto something that is on screen, and anything on screen can always be locked onto. Two
   * definitions of "visible" would make the game lie in one direction or the other — either the
   * crosshair tracks an enemy the player cannot see, or the player stares at an enemy that the
   * stick refuses to aim at.
   *
   * The near-reveal radius is part of that shared rule: an enemy closer than `VISION_REVEAL_R`
   * counts as visible even behind cover ("you can hear it"), so it is both drawn and targetable.
   */
  nearestVisibleEnemy(from: Vec2): Enemy | null {
    let best: Enemy | null = null;
    let bestD2 = Infinity;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const dx = e.pos.x - from.x;
      const dy = e.pos.y - from.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= bestD2) continue;   // farther than the incumbent: not a candidate at all
      // Visibility is the expensive half (a segment query against every piece of cover), so it is
      // only paid for candidates that already beat the incumbent. "Nearest" therefore stays
      // "nearest AMONG VISIBLE", not "nearest, then checked".
      if (!visibleWithReveal(from, e.pos, this.obstacles)) continue;
      bestD2 = d2;
      best = e;
    }
    return best;
  }

  update(dt: number, input: InputState): void {
    if (this.over) return;
    this.time += dt;
    const p = this.player;

    // --- age the live transient lights BEFORE anything can create one ---
    // ORDER MATTERS HERE, and it is the opposite of the crescents below: a crescent is spawned and
    // then immediately advanced in the same frame, which is fine because its curve is deliberately
    // front-loaded (87.5% of the arc in the first half of the sweep — see slash.ts). A LIGHT must be
    // at FULL intensity on the frame its event happened, so the clock is advanced first and a light
    // created by this frame's shot or detonation still reads `t = 0` to the renderer.
    if (this.fxLights.length > 0) {
      let fw = 0;
      for (let i = 0; i < this.fxLights.length; i++) {
        const fx = this.fxLights[i];
        fx.t += dt;
        if (fx.t >= fx.max) continue;
        this.fxLights[fw++] = fx;
      }
      this.fxLights.length = fw;
    }

    // --- player movement ---
    p.vel = scale(clampLen(input.move, 1), CONFIG.playerSpeed);
    p.pos = add(p.pos, scale(p.vel, dt));
    this.clampToArena(p.pos, p.r);
    // Cover is solid for the player too. Push out AFTER moving: the least-penetration resolve in
    // math2.ts slides the player along a wall rather than stopping them dead, which is what makes
    // strafing along cover feel right without a separate slide/response pass.
    resolveCover(p.pos, p.r, this.obstacles);
    // --- resolve the aim direction ---
    // A manual stick direction always wins (and is NOT visibility-filtered: a manual shot at a wall
    // is the player's business). If the right stick is held without a direction (input.autoAim),
    // lock onto the nearest VISIBLE live enemy instead. Recomputed every frame:
    // stateless "nearest" is simple and predictable, at the cost of switching targets
    // when two enemies are nearly equidistant (add hysteresis here if that ever reads bad).
    let aimDir = input.aim;
    if (input.autoAim && len(aimDir) < 1e-3) {
      const t = this.nearestVisibleEnemy(p.pos);
      if (t) aimDir = norm(sub(t.pos, p.pos));
    }
    const hasAim = len(aimDir) > 1e-3;
    p.moving = len(input.move) > 0.05;
    p.firing = input.firing;
    // "aiming" = there is a real aim direction AND the player is attacking, which is exactly
    // when the facing below becomes the aim direction (render.ts shows the aiming line then).
    p.aiming = hasAim && p.firing;
    // Facing priority: aim while FIRING, else the movement direction, else keep the last facing.
    // Why gate on `firing` instead of `hasAim`: `input.aim` is non-zero even when nobody is
    // aiming — desktop mouse hover (position relative to the canvas centre) and a stale finger
    // drag left in `input.mouse` on touch. With `hasAim` alone this branch was true nearly every
    // frame, so the movement branch never ran and the facing looked hard-coded while walking.
    // `firing` is the only signal that the player is really aiming (right stick held / LMB down).
    if (hasAim && p.firing) p.aimAngle = Math.atan2(aimDir.y, aimDir.x);
    else if (p.moving) p.aimAngle = Math.atan2(input.move.y, input.move.x);
    // attack: the equipped weapon decides whether/how it fires (see weapons.ts), the sim
    // decides whether the magazine AND the backpack reserve allow it.
    const weapon = this.activeWeapon();
    const mag = weapon ? magSizeOf(weapon) : 0;
    const ammoId = weapon ? ammoIdOf(weapon) : null;
    // Reload first: an in-progress reload blocks firing and refills on completion. Because
    // `fireTimer` keeps counting down while reloading (and is allowed to go negative), the first
    // shot after a reload happens on the very frame the magazine is full again.
    if (p.reloadTimer > 0) {
      p.reloadTimer -= dt;
      if (p.reloadTimer <= TIMER_EPS) {
        p.reloadTimer = 0;
        p.reloadTotal = 0;
        // Top up from the backpack, and only as far as the reserve reaches: a nearly-dry bag gives
        // a PARTIAL magazine (`18/30`) rather than refusing to reload at all.
        if (ammoId) p.ammo += consumeAmmo(this.inventory, ammoId, mag - p.ammo);
        this.commitMag();
      }
    }
    this.fireTimer -= dt;
    if (weapon && p.firing && this.fireTimer <= TIMER_EPS && p.reloadTimer <= 0) {
      // One reserve read per frame, used by all three branches below.
      const dry = ammoId ? bagReserve(this.inventory, ammoId) <= 0 : false;
      if (mag > 0 && p.ammo <= 0) {
        // Empty magazine + trigger held: auto-reload instead of firing. This is also the recovery
        // path if ammo is set to 0 by hand. With no reserve left it is a no-op, so a dry weapon
        // never enters a reload loop.
        if (!dry) this.startReload(weapon);
      } else if (mag === 0 && ammoId && dry) {
        // Magazine-less ranged weapon (rpg) with an empty reserve: the trigger is simply ignored
        // until the backpack has rockets again (deliberately no noAimRetry churn).
      } else {
        // Ranged weapons need an aim direction; a melee weapon only needs the facing, which is
        // already resolved above, so it passes `null` and swings anyway.
        const fired = fireWeapon(this, weapon, hasAim ? aimDir : null);
        if (fired) {
          // CARRY THE OVERSHOOT instead of resetting to the full cooldown. The sim fires at most once
          // per rendered frame, so resetting quantises every cadence UP to a whole number of frames:
          // the old SMG cadence (0.1s = exactly 6 frames at 60fps) never showed it, but 0.1/1.3 =
          // 0.0769s rounds up to 5 frames (0.0833s = 12/s, i.e. 1.2x instead of the requested 1.3x),
          // and at 30fps it would round up to 3 frames = 600rpm. Adding the cooldown to the (already
          // negative) timer keeps the LONG-RUN rate exact and frame-rate independent, spreading the
          // remainder across shots.
          //
          // ⚠️ THE `<= 0` BRANCH IS LOAD-BEARING, and it is not "a clamp for tidiness": this timer
          // keeps counting DOWN through a reload (deliberately — the first post-reload shot fires on
          // the frame the magazine is full), so at that moment it is ~1.5s in debt. Carrying that
          // debt forward — or flooring it at 0 — makes the NEXT frame fire again (measured: the
          // shotgun double-tapped 1 frame apart at 5.700s/5.717s and put an extra volley in the air,
          // 24 -> 32 pellets). A timer in debt by a whole cadence or more is a fresh trigger pull, so
          // it resets; only a sub-cadence remainder is carried.
          const carried = this.fireTimer + weapon.cooldown;
          this.fireTimer = carried > 0 ? carried : weapon.cooldown;
          if (weapon.kind === 'melee') {
            // Melee bookkeeping, and ONLY here: the flip happens after the swing resolved, because
            // fireWeapon() already read `swingDir` to orient this crescent. Every melee weapon gets
            // this for free (there is no per-weapon branch here — `kind` is the only switch).
            p.swingDir = p.swingDir === 1 ? -1 : 1;
            p.swingCount++;
            p.swingT = weapon.swingAnimTime;
          }
          if (mag > 0) {
            // Ammo is spent ONLY here: `fireWeapon()` returning false (no aim direction) must
            // not cost a round, otherwise holding the trigger with nothing to shoot would
            // silently drain the magazine.
            p.ammo -= 1;
            this.commitMag();
            // Auto-reload the moment the last round leaves: the reload runs during the pause
            // after a burst instead of waiting for the next trigger pull.
            if (p.ammo <= 0 && !dry) this.startReload(weapon);
          } else if (ammoId) {
            // No magazine: the round comes straight off the backpack reserve (rpg).
            consumeAmmo(this.inventory, ammoId, 1);
          }
        } else {
          this.fireTimer = CONFIG.noAimRetry;
        }
      }
    }
    // Discrete uses (throwable / healing buttons). Resolved HERE, after the frame's aim direction
    // is known, because "where does the grenade go" cannot be answered by a DOM button.
    if (p.throwCd > 0) p.throwCd = Math.max(0, p.throwCd - dt);
    if (p.healCd > 0) p.healCd = Math.max(0, p.healCd - dt);
    this.resolvePendingUse(hasAim ? aimDir : null);
    // Clamped to exactly 0, not just driven <= 0: `invuln` is compared with `> 0` all over (and
    // `render.ts` scales the player for it), and floating-point countdowns land on ~-1.7e-16 rather
    // than 0. Same treatment as `swingT` below — a timer that is "finished" must read as 0.
    if (p.invuln > 0) p.invuln = Math.max(0, p.invuln - dt);
    // The swing body animation owns the player for `swingAnimTime`; the renderer reads this to
    // decide between the full-body slice clip and locomotion + the upper-body aim layer.
    if (p.swingT > 0) p.swingT = Math.max(0, p.swingT - dt);

    // --- enemies ---
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const toP = sub(p.pos, e.pos);
      const d = len(toP);
      const dir = d > 1e-4 ? scale(toP, 1 / d) : v2(0, 0);
      if (e.kind === 'gunner') {
        this.updateGunner(e, dir, d, dt);
      } else {
        e.vel = scale(dir, e.speed);
      }
      e.pos = add(e.pos, scale(e.vel, dt));
      this.clampToArena(e.pos, e.r);
      // Cover stops enemies as well as the player. An enemy that walks into a wall slides along it
      // and naturally comes free at the corner — there is deliberately NO pathfinding (see the
      // README's known limitations), and the gunner's design does not need any: it holds position.
      resolveCover(e.pos, e.r, this.obstacles);
      if (e.hitFlash > 0) e.hitFlash -= dt;
      if (e.touchCd > 0) e.touchCd -= dt;
      // Contact damage: MELEE kinds only. A gunner that let the player walk into it must not also
      // be a melee threat — its entire design is that it keeps its distance.
      if (e.kind !== 'gunner' && d < e.r + p.r && e.touchCd <= 0) {
        // `damagePlayer` owns the i-frame check, so a blocked hit (player still invulnerable) does
        // not spend this enemy's own contact cooldown.
        if (this.damagePlayer(e.touchDmg, '#ff4030', 0.35)) e.touchCd = 0.5;
      }
    }

    // --- burn (damage over time) ---
    // One pass over every burning enemy per frame. Each stack accumulates ALL ticks that came
    // due since the last frame (`while`), so the total damage is frame-rate independent; the
    // whole frame's burn damage is applied in ONE `damageEnemy` call (one red flash, and the
    // hit-flash duration is not multiplied by the number of stacks). `damageEnemy` is the
    // numbers-only step, so a lethal tick still runs `resolveDeath` for score/burst.
    for (const e of this.enemies) {
      if (!e.alive || e.burns.length === 0) {
        if (e.flameAcc !== 0) e.flameAcc = 0;   // stop emitting the instant the last stack expires
        continue;
      }
      let dmg = 0;
      for (let i = e.burns.length - 1; i >= 0; i--) {
        const b = e.burns[i];
        while (b.nextTick <= this.time && b.nextTick <= b.endTime) {
          dmg += b.dps;
          b.nextTick += b.period;
        }
        if (b.endTime <= this.time) e.burns.splice(i, 1);
      }
      if (dmg > 0 && this.damageEnemy(e, dmg)) { this.resolveDeath(e); continue; }
      // Flame VFX: continuous while burning, rate scaled by stack count and capped so a heavily
      // stacked target cannot flood the pool. `flameAcc` is a time accumulator (frame-rate
      // independent) and the global cap stops the array growing without bound when many enemies
      // burn at once; overflow frames simply emit nothing (existing flames keep fading).
      const rate = Math.min(CONFIG.flameRateMax, CONFIG.flameRateBase + CONFIG.flameRatePerStack * e.burns.length);
      e.flameAcc += rate * dt;
      while (e.flameAcc >= 1) {
        e.flameAcc -= 1;
        if (this.particles.length >= CONFIG.flameParticleCap) { e.flameAcc = 0; break; }
        this.spawnBurnFlame(e.pos);
      }
    }

    // --- bullets ---
    for (const b of this.bullets) {
      if (!b.alive) continue;
      const prev = b.pos;
      b.pos = add(prev, scale(b.vel, dt));
      b.life -= dt;
      if (b.life <= 0) {
        // NATURAL end of life (a fuse, for thrown ordnance). Split from the arena cull below on
        // purpose: leaving the map must never detonate a grenade outside the playfield.
        b.alive = false;
        if (b.def.onLifeEnd) b.def.onLifeEnd(this, b, b.pos);
        continue;
      }
      if (Math.abs(b.pos.x) > this.arenaHalf + 2 || Math.abs(b.pos.y) > this.arenaHalf + 2) {
        b.alive = false; continue;
      }
      // COVER FIRST: a wall stops a round before it can reach anyone standing behind it, for both
      // sides. The impact is placed on the wall face (at the hit parameter, not at the bullet's
      // end-of-frame position, which may already be through the box), and `def.onHit` IS still
      // called — with a null target — because an RPG hitting a wall has to detonate. Hitting cover
      // is not hitting a person; it is still hitting something.
      const wall = firstCoverHit(prev, b.pos, this.obstacles);
      if (wall !== null) {
        const hit = add(prev, scale(sub(b.pos, prev), wall.t));
        b.def.onHit(this, b, null, hit);
        this.spawnBurst(hit, 3, b.fromPlayer ? '#ffcf6a' : '#ff7aa0');
        b.alive = false;
        continue;
      }
      if (b.fromPlayer) {
        for (const e of this.enemies) {
          if (!e.alive) continue;
          // Swept hit test (segment prev -> b.pos vs the enemy disc), NOT a point test on b.pos:
          // a projectile covers def.speed*dt = 1.5 units per frame at 60fps for the dragon
          // breath, far more than the 0.88 hit radius, so a point test lets it tunnel straight
          // through an enemy that is closer than one step — a hugging enemy was literally immune.
          const hit = segClosest(prev, b.pos, e.pos);
          if (dist(hit, e.pos) < b.r + e.r) {
            // Order is deliberate: numbers first, then the projectile's own effect (splash,
            // blast, ...), then the death tail — so per-ammo VFX land before the death burst
            // exactly as the pre-refactor inline code did (and Math.random order stays stable).
            // The BULLET carries the whole penetration profile (`level` for display, `penetration`
            // and the override tables for the maths), so it is handed over as-is.
            const killed = this.damageEnemy(e, b.damage, b);
            b.def.onHit(this, b, e, hit);
            if (killed) this.resolveDeath(e);
            b.alive = false;
            break;
          }
        }
      } else {
        // Enemy round vs the player. Swept for the same reason as above: a gunner round moves
        // 34*dt units per frame against a 0.73 hit radius, so at the 20 fps floor main.ts allows
        // (dt = 0.05) a point test would tunnel straight through the player.
        const hit = segClosest(prev, b.pos, p.pos);
        if (dist(hit, p.pos) < b.r + p.r) {
          // Consumed even when the i-frames absorb it: a round must never linger inside the player
          // and land a second hit the instant invulnerability lapses. The round's PROFILE goes with
          // it, so the armour slot decides how much of it is flesh and how much is plate.
          b.alive = false;
          this.damagePlayer(b.damage, '#ff4030', 0.3, b);
        }
      }
    }

    // Compact dead bullets so the array stays small (8 pellets/shot makes this matter).
    if (this.bullets.some((b) => !b.alive)) this.bullets = this.bullets.filter((b) => b.alive);

    // --- melee crescents ---
    // Runs BEFORE the particle pass on purpose: a slipstream streak emitted here then takes its
    // first integration step in the same frame. Emitting after the particle loop would leave the
    // whole trail frozen at the leading edge for the frame it appears.
    if (this.slashes.length > 0) {
      let w = 0;
      for (let i = 0; i < this.slashes.length; i++) {
        const s = this.slashes[i];
        // The crescent is the trail of a blade the attacker is HOLDING, so it translates with them
        // instead of freezing at the coordinates the swing started from. This was a real bug: at
        // playerSpeed 11 a 0.17s swing covers ~1.9 units, comparable to the 3.4 reach, so a walking
        // player left the whole effect behind. Only the LIVE crescent follows — the streaks it has
        // already shed stay in world space, which is what a motion trail physically does.
        // NOTE: the player is the only melee attacker today; when enemies get melee this becomes an
        // owner lookup rather than a direct read.
        s.x = this.player.pos.x;
        s.z = this.player.pos.y;

        // Emit by ARC DISTANCE travelled, not by time: the sweep is deliberately front-loaded (see
        // CONFIG.slashEase), so a per-second rate would starve the fast opening and clump every
        // streak into the slow settle. Driving the accumulator with the progress delta keeps the
        // trail's density even along the arc, at any frame rate and under any easing curve.
        const before = slashProgress(s.t, s.max);
        s.t += dt;
        const after = slashProgress(s.t, s.max);
        if (after > before) {
          s.emitAcc += (after - before) * CONFIG.slashStreakCount;
          while (s.emitAcc >= 1) {
            s.emitAcc -= 1;
            this.spawnSlashStreak(s);
          }
        }
        // Culled AFTER emitting, so the final slice of the arc still gets its streaks.
        if (!slashAlive(s)) continue;
        this.slashes[w++] = s;
      }
      this.slashes.length = w;
    }

    // --- particles ---
    for (const pt of this.particles) {
      if (!pt.alive) continue;
      if (pt.drag > 0 || pt.swirl > 0) {
        // Damp velocity so sparks taper off, then swirl via divergence-free curl noise. `drag`
        // and `swirl` are per-particle so burn flames can drift (small drag/swirl) while impact
        // sparks stay snappy — the old code scaled both by a single 0..1 `curl` factor, and the
        // spark spawners now pre-multiply by the same constants, so spark motion is unchanged.
        pt.vel = scale(pt.vel, Math.max(0, 1 - pt.drag * dt));
        const c = curl2(pt.pos.x, pt.pos.y, this.time * 0.8);
        pt.vel = add(pt.vel, scale(c, pt.swirl * dt));
      }
      pt.vy += pt.buoy * dt;          // 0 for sparks, buoyant for flames
      pt.pos = add(pt.pos, scale(pt.vel, dt));
      pt.y += pt.vy * dt;
      // Floor: particles never sink through the ground plane (there is no collision, so falling
      // debris/embers would otherwise vanish *under* the floor mid-flight). They stop, lose most
      // of their horizontal speed and slide for the remainder of their life, which reads as
      // "landed". Only particles with negative buoyancy can ever reach this (sparks sit at
      // y = 0.2 with vy = 0, flames rise), so nothing existing changes.
      if (pt.y < PARTICLE_GROUND_Y && pt.vy < 0) {
        pt.y = PARTICLE_GROUND_Y;
        pt.vy = 0;
        pt.vel = scale(pt.vel, 0.55);
      }
      pt.life -= dt;
      if (pt.life <= 0) pt.alive = false;
    }

    // Compact dead particles so the array stays small (sparks are short-lived).
    if (this.particles.some((pt) => !pt.alive)) this.particles = this.particles.filter((pt) => pt.alive);

    // --- wave / spawning ---
    if (this.spawnQueue > 0) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0) {
        this.spawnTimer = CONFIG.spawnCadence;
        this.spawnEnemy();
        this.spawnQueue--;
      }
    } else if (this.aliveEnemies() === 0 && this.bulletsEveryDead()) {
      this.currentWaveDone();
    }

    // decay shake
    this.shake *= Math.pow(0.001, dt);
    if (this.shake < 0.01) this.shake = 0;
    // decay recoil (same time constant as the shake: ~0.145s to fall to 1/e, so a 10/s burst settles
    // instead of drifting, and the kick is gone a couple of frames after the trigger is released)
    this.recoilX *= Math.pow(0.001, dt);
    this.recoilZ *= Math.pow(0.001, dt);
    if (Math.abs(this.recoilX) < 0.002 && Math.abs(this.recoilZ) < 0.002) {
      this.recoilX = 0;
      this.recoilZ = 0;
    }
  }

  // -----------------------------------------------------------------------------------
  // FireContext / CombatContext — the only surface weapons.ts and projectiles.ts may use.
  // Kept deliberately small: spawn a projectile, read the enemies, mutate HP, spawn VFX.
  // -----------------------------------------------------------------------------------

  /** Live view of the weapon holder (fresh object; `pos` is replaced every frame). */
  get owner(): { pos: Vec2; r: number; aimAngle: number; swingDir: 1 | -1 } {
    const p = this.player;
    return { pos: p.pos, r: p.r, aimAngle: p.aimAngle, swingDir: p.swingDir };
  }

  /** Push one projectile into the world; stats/visuals/on-hit logic all come from `def`. */
  spawnProjectile(def: ProjectileDef, pos: Vec2, dir: Vec2): void {
    this.bullets.push({
      pos, vel: scale(dir, def.speed), r: def.radius, life: def.life,
      damage: def.damage, fromPlayer: true, alive: true, def,
      // The penetration profile travels WITH the round, so on-hit code (which only sees the bullet)
      // can hand the very same profile to damageEnemy / damagePlayer. `level` is the display value;
      // `penetration` / the override tables are what the damage maths reads (see armor.ts).
      level: def.level,
      penetration: def.penetration,
      vsArmor: def.vsArmor,
      vsFlesh: def.vsFlesh,
    });
  }

  /** Live enemy list for melee sweeps and AoE queries. */
  enemyList(): readonly EnemyLike[] { return this.enemies; }

  /**
   * Is the straight line `a`-`b` interrupted by cover? (CombatContext)
   *
   * The single line-of-sight test, shared by everything that must respect cover: enemy gunners
   * deciding whether they may fire, the melee sweep (a blade must not cut through a wall) and the
   * rocket's blast (an explosion must not splash around a corner).
   */
  lineBlocked(a: Vec2, b: Vec2): boolean {
    return coverBlocks(a, b, this.obstacles);
  }

  /**
   * Numbers only: hp -= dmg and a fresh hit flash. Returns true when this hit was lethal.
   * The death tail (score / shake / burst) is `resolveDeath`, so callers can run the
   * projectile's own effect in between and keep the VFX + Math.random order stable.
   *
   * `round` is the round's penetration profile: the projectile itself, or a bare number (read as
   * `{level: n, penetration: n}`). When it is present AND the target wears a working plate, the
   * damage is split by armor.ts::resolveHit — the plate eats armour damage, HP takes the flesh
   * fraction, and the per-ammo override tables decide both. OMITTING it means "this damage ignores
   * armour", which is exactly what melee (a blade), enemy contact damage and the BURN DoT are:
   * burn damage is direct flesh by design, and it is the dragon-breath shell's only flesh damage
   * while a plate is intact.
   */
  damageEnemy(e: EnemyLike, dmg: number, round?: RoundProfile | number): boolean {
    let flesh = dmg;
    if (round !== undefined && e.armor) {
      const hit = resolveHit(dmg, round, e.armor);
      e.armor.value = hit.armorLeft;
      flesh = hit.fleshDmg;
    }
    e.hp -= flesh;
    if (dmg > 0) e.hitFlash = CONFIG.hitFlashTime;
    return e.hp <= 0;
  }

  /** Score, shake and death burst for an enemy that `damageEnemy` just killed. */
  resolveDeath(e: EnemyLike): void {
    e.hp = 0;
    e.alive = false;
    e.burns.length = 0;   // a corpse must not keep burning (and must not keep flashing red)
    this.score += e.kind === 'sprinter' ? 2 : 1;
    this.shake = Math.max(this.shake, 0.12);
    this.spawnBurst(e.pos, 16, DEATH_BURST_COLOR);
  }

  /**
   * Push one independent burn stack: 1 tick every `period` seconds for `duration` seconds,
   * `dps` damage per tick. The first tick lands one period after the hit, and each hit pushes
   * its OWN stack, so damage per second scales linearly with how many pellets connected.
   */
  applyBurn(e: EnemyLike, dps: number, duration: number, period: number): void {
    e.burns.push({ endTime: this.time + duration, nextTick: this.time + period, dps, period });
  }

  addShake(v: number): void { this.shake = Math.max(this.shake, v); }

  /**
   * Add a camera recoil kick of `amount` world units along the unit direction (dx, dz).
   *
   * WHY IT ACCUMULATES (and why that is safe): each shot adds its weapon's `recoil` to a decaying
   * vector, so a burst walks the view back along the shot line the way a held trigger does. The decay
   * above is the same 0.001/s (1/e in ~0.145s) as the shake's, so the steady state is
   * `perShot / (1 - exp(-cadence/0.145))` — about 1.9x the per-shot kick for the SMG's 0.1s cadence
   * (0.19 units, a third of a screen block at the default pixelation) and never more, because the
   * fastest cadence in the game is that SMG. `RECOIL_MAX` is a hard cap for hand-edited weapon defs.
   *
   * The direction is normalised here on purpose: the caller passes the *shot* direction negated, and a
   * zero/degenerate/garbage vector must not put a NaN into the renderer's camera pose (the project's
   * "dirty data must degrade, never explode" rule).
   */
  addRecoil(amount: number, dx: number, dz: number): void {
    if (!Number.isFinite(amount) || amount === 0) return;
    if (!Number.isFinite(dx) || !Number.isFinite(dz)) return;
    const l = Math.hypot(dx, dz);
    if (!(l > 1e-6)) return;
    // Clamp the ACCUMULATED magnitude, not the individual kick, so one absurd weapon def cannot park
    // the camera off the player.
    const nx = this.recoilX + (dx / l) * amount;
    const nz = this.recoilZ + (dz / l) * amount;
    const m = Math.hypot(nx, nz);
    if (m > RECOIL_MAX) {
      this.recoilX = (nx / m) * RECOIL_MAX;
      this.recoilZ = (nz / m) * RECOIL_MAX;
    } else {
      this.recoilX = nx;
      this.recoilZ = nz;
    }
  }

  /**
   * Apply damage to the player, if they are not in i-frames. ONE path for both damage sources
   * (enemy contact and enemy rounds), so the death tail, the shake, the blood burst and the
   * i-frame grant can never drift apart between them.
   *
   * THE I-FRAME TIMER IS THE INCOMING-DPS CAP: every hit grants `CONFIG.contactInvuln` (0.6s)
   * during which nothing lands, so N gunners deal at most `damage / 0.6` per second no matter how
   * many are shooting. That is the whole reason several gunners can fire at once without deleting
   * the player, and why there is no separate "max simultaneous shooters" throttle.
   *
   * @returns true when the hit landed (callers use it to spend their own cooldown).
   */
  damagePlayer(dmg: number, burstColor: string, shake: number, round?: RoundProfile | number): boolean {
    const p = this.player;
    if (!p.alive || p.invuln > 0) return false;
    let flesh = dmg;
    // The player's plate is the ARMOUR SLOT item — one source of truth, so the inventory panel and
    // the HUD bar show the same value that just absorbed the hit. A missing `round` (or no plate)
    // means full damage: enemy contact damage carries no penetration profile, only its rounds do.
    const plate = this.inventory.slots.armor;
    if (round !== undefined && plate && plate.kind === 'armor') {
      const hit = resolveHit(dmg, round, plate);
      plate.value = hit.armorLeft;
      flesh = hit.fleshDmg;
    }
    p.hp -= flesh;
    p.invuln = CONFIG.contactInvuln;
    this.shake = Math.max(this.shake, shake);
    this.spawnBurst(p.pos, 10, burstColor);
    if (p.hp <= 0) { p.hp = 0; p.alive = false; this.over = true; }
    return true;
  }

  /**
   * Compose the next enemy: a gunner most of the time, a melee rusher sometimes.
   *
   * WHY THE MIX (and not "all gunners", which is what "敌人和我一样拿枪" literally asks for): a cover
   * shooter in which every enemy shoots lets the player camp behind one crate indefinitely — nothing
   * ever forces a reposition, so the cover becomes a win button instead of a decision. The melee
   * minority is the pressure that makes leaving cover necessary. Wave 1 gets gunners too (this is a
   * gunfight from the first second), while sprinters keep their original "wave >= 2" rule.
   */
  private spawnEnemy(): void {
    const gunner = Math.random() < CONFIG.gunnerShare;
    const sprinter = !gunner && this.wave >= 2 && Math.random() < Math.min(0.25 + this.wave * 0.03, 0.5);
    const hp = gunner ? CONFIG.gunnerHp : sprinter ? CONFIG.sprinterHp : CONFIG.baseEnemyHp;
    const e: Enemy = {
      id: nid(), pos: this.spawnPos(), vel: v2(0, 0), r: CONFIG.enemyR,
      hp, maxHp: hp,
      alive: true,
      kind: gunner ? 'gunner' : sprinter ? 'sprinter' : 'chaser',
      speed: gunner ? CONFIG.gunnerSpeed : sprinter ? CONFIG.sprinterSpeed : CONFIG.chaserSpeed,
      touchDmg: CONFIG.touchDmg, hitFlash: 0, touchCd: 0, burns: [], flameAcc: 0,
      // Armour by wave (armor.ts::armorForWave + the two CONFIG profiles). Gunners are plated from
      // wave 1; melee rushers only later, so early waves stay about reading the gunfight.
      armor: armorForWave(this.wave, gunner ? CONFIG.gunnerArmor : CONFIG.rusherArmor),
      // Start one telegraph away from a shot, so a gunner that spawns with a clear line still has
      // to aim first (see updateGunner).
      fireT: CONFIG.gunnerAimTime, aiming: false,
    };
    this.enemies.push(e);
  }

  /**
   * Where the next enemy appears: on a ring around the PLAYER, not at the arena edge.
   *
   * WHY: on a 76x76 map an edge spawn can be ~107 units away, so every wave would open with a long
   * walk and the shooter would spend the fight alone. The ring keeps encounters close while still
   * spawning out of sight. Positions are REJECTION-SAMPLED against the arena bounds, cover and the
   * player, and the edge fallback is pushed out of cover so this can never return a point inside a
   * wall — even for a pathological layout or a player jammed into a corner.
   */
  private spawnPos(): Vec2 {
    const p = this.player;
    const h = this.arenaHalf - 0.5;
    const span = Math.max(0, CONFIG.spawnRingMax - CONFIG.spawnRingMin);
    for (let i = 0; i < CONFIG.spawnTries; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = CONFIG.spawnRingMin + Math.random() * span;
      const pos = v2(p.pos.x + Math.cos(a) * r, p.pos.y + Math.sin(a) * r);
      if (pos.x < -h || pos.x > h || pos.y < -h || pos.y > h) continue;      // outside the arena
      if (dist(pos, p.pos) < CONFIG.spawnMinPlayerGap) continue;             // never on top of the player
      if (overlapsCover(pos, CONFIG.enemyR, this.obstacles, 0.4)) continue;  // not inside cover
      return pos;
    }
    const edge = this.edgePos();
    resolveCover(edge, CONFIG.enemyR + 0.2, this.obstacles);
    this.clampToArena(edge, CONFIG.enemyR);
    return edge;
  }

  /**
   * One gunner's frame: hold the preferred range, stand still, telegraph, then shoot.
   *
   * The three movement zones are the whole "low aggression, 尽量站在原地" requirement — the middle
   * zone (`range ± slack`) is where a gunner's velocity is set to exactly zero, so once it has
   * walked into position it plants and stays planted while the player moves around it.
   */
  private updateGunner(e: Enemy, dir: Vec2, d: number, dt: number): void {
    const p = this.player;
    // Cover is what makes this a gunfight rather than a shooting gallery: breaking the line does
    // not merely spoil the aim, it stops the shooting entirely.
    const hasLos = !coverBlocks(e.pos, p.pos, this.obstacles);
    const band = CONFIG.gunnerRange + CONFIG.gunnerRangeSlack;
    const engaged = hasLos && d <= band && p.alive;

    // --- movement: approach / plant / back off -------------------------------------------------
    // Reads `e.speed`, NOT CONFIG.gunnerSpeed directly, so a gunner's pace is per-entity data like
    // every other kind's (`spawnEnemy` seeds it from config). Reading the config here would make
    // "slow this one enemy down" impossible and would silently ignore `Enemy.speed`.
    if (d > band) {
      // Close in slowly, but only while the player is inside the gunner's sight budget: beyond it a
      // low-aggression enemy holds its ground instead of marching across the map.
      e.vel = hasLos && d <= CONFIG.gunnerSight && p.alive ? scale(dir, e.speed) : v2(0, 0);
    } else if (d < CONFIG.gunnerRange - CONFIG.gunnerRangeSlack) {
      // Back off rather than let the player walk into it for a free melee kill.
      e.vel = scale(dir, -e.speed * CONFIG.gunnerBackoff);
    } else {
      e.vel = v2(0, 0);
    }

    // --- trigger: one countdown, telegraph at the end -------------------------------------------
    if (!engaged) {
      // Rewind to exactly ONE telegraph away from a shot, so ducking behind cover (or leaving the
      // range band) always buys the player a full telegraph before the next round. Without this,
      // popping out mid-cycle could eat a shot with no warning — cover would feel like a coin flip.
      e.aiming = false;
      e.fireT = CONFIG.gunnerAimTime;
      return;
    }
    e.fireT -= dt;
    e.aiming = e.fireT <= CONFIG.gunnerAimTime;
    if (e.fireT <= 0) {
      this.spawnEnemyRound(e, dir);
      e.fireT = CONFIG.gunnerAimTime + CONFIG.gunnerFireCd;
      e.aiming = false;
    }
  }

  /** One enemy round from a gunner's muzzle, with its own spread and the hostile tracer. */
  private spawnEnemyRound(e: Enemy, dir: Vec2): void {
    const muzzle = add(e.pos, scale(dir, e.r + 0.3));
    const a = Math.atan2(dir.y, dir.x) + (Math.random() * 2 - 1) * CONFIG.gunnerSpread;
    this.bullets.push({
      pos: muzzle,
      vel: scale(v2(Math.cos(a), Math.sin(a)), CONFIG.gunnerBulletSpeed),
      r: CONFIG.gunnerBulletR,
      life: CONFIG.gunnerBulletLife,
      damage: CONFIG.gunnerDamage,
      // The round's penetration level travels with the projectile (single source: the def), so the
      // player's plate resolves against exactly the ammo the gunner is firing.
      level: PROJECTILES.enemyRound.level,
      fromPlayer: false,
      alive: true,
      def: PROJECTILES.enemyRound,
    });
    this.spawnBurst(muzzle, 4, '#ff5a8a');
    this.shake = Math.max(this.shake, 0.05);
  }

  private edgePos(): Vec2 {
    const h = this.arenaHalf - 0.5;
    const side = Math.floor(Math.random() * 4);
    if (side === 0) return v2((Math.random() * 2 - 1) * h, h);
    if (side === 1) return v2((Math.random() * 2 - 1) * h, -h);
    if (side === 2) return v2(h, (Math.random() * 2 - 1) * h);
    return v2(-h, (Math.random() * 2 - 1) * h);
  }

  private currentWaveDone(): void {
    this.wave++;
    this.spawnQueue = this.waveTarget(this.wave);
    this.spawnTimer = 1.4;
  }

  private bulletsEveryDead(): boolean { return true; }

  private clampToArena(pos: Vec2, r: number): void {
    const h = this.arenaHalf - r;
    if (pos.x > h) pos.x = h; else if (pos.x < -h) pos.x = -h;
    if (pos.y > h) pos.y = h; else if (pos.y < -h) pos.y = -h;
  }

  // Directional splash: elongated fire sparks fan out around a normal (used by projectiles).
  // Public because projectiles.ts drives it through CombatContext.
  spawnSplash(pos: Vec2, normal: Vec2, n: number): void {
    const base = Math.atan2(normal.y, normal.x);
    for (let i = 0; i < n; i++) {
      const a = base + (Math.random() * 2 - 1) * 0.9;
      const sp = CONFIG.splashSpeedMin + Math.random() * CONFIG.splashSpeedVar; // fast, so streaks stretch
      const life = 0.3 + Math.random() * 0.35;       // long enough for the curl to read
      const color = FIRE_PALETTE[(Math.random() * FIRE_PALETTE.length) | 0];
      this.particles.push({
        pos: v2(pos.x, pos.y),
        vel: v2(Math.cos(a) * sp, Math.sin(a) * sp),
        y: 0.2, vy: 0, buoy: 0,
        life,
        max: life,
        size: 0.04 + Math.random() * 0.05,           // thin
        len: 0.55 + Math.random() * 0.5,             // elongated
        drag: CONFIG.sparkDrag,                      // = the old sparkDrag * curl(1)
        swirl: CONFIG.sparkCurl,                     // = the old sparkCurl * curl(1)
        puff: false, aspect: 1, flick: 0, solid: false,
        color,
        alive: true,
      });
    }
  }

  spawnBurst(pos: Vec2, n: number, color: string): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 4 + Math.random() * 12;
      const life = 0.3 + Math.random() * 0.35;
      this.particles.push({
        pos: v2(pos.x, pos.y),
        vel: v2(Math.cos(a) * sp, Math.sin(a) * sp),
        y: 0.2, vy: 0, buoy: 0,
        life,
        max: life,
        size: 0.05 + Math.random() * 0.07,
        len: 0.4 + Math.random() * 0.4,
        drag: CONFIG.sparkDrag * 0.35,               // subtle swirl on death bursts (old curl)
        swirl: CONFIG.sparkCurl * 0.35,
        puff: false, aspect: 1, flick: 0, solid: false,
        color,
        alive: true,
      });
    }
  }

  /**
   * The muzzle flash of one shot: the light state the renderer replays, plus the particles the
   * weapon's recipe asks for. Called by `fireWeapon()` with the SAME point and direction it is
   * about to spawn the projectiles from, so the flash and the rounds cannot drift apart — and once
   * per SHOT, so the dragon breath's 8 pellets still produce a single muzzle event.
   *
   * The recipes are data (`MuzzleFlashDef`), so this method contains no per-weapon branch: it walks
   * `def.layers` and interprets each one through `MUZZLE_PHYSICS`. A new ranged weapon is a new
   * layer list in muzzle.ts and nothing here changes.
   *
   * An unusable definition (a hand-built test weapon with no `muzzle` field, or dirty data) is a
   * SILENT no-op: the weapon must still fire. See muzzle.ts::isUsableMuzzleDef.
   */
  spawnMuzzleFlash(pos: Vec2, dir: Vec2, def: MuzzleFlashDef): void {
    if (!isUsableMuzzleDef(def)) return;
    const light = makeFxLight({
      x: pos.x, z: pos.y, y: MUZZLE_Y,
      // The weapon's NOMINAL aim, not a pellet's spread direction: the flash is the barrel's, and
      // the light is offset along this vector (see MuzzleLight.forward / fxlight.ts).
      dx: dir.x, dz: dir.y, forward: def.light.forward,
      color: def.light.color, intensity: def.light.intensity, distance: def.light.distance,
      life: def.light.life, falloff: def.light.falloff,
    });
    // `pushFxLight` owns the cap (fxlight.ts::FX_LIGHT_MAX, oldest dropped): real weapons can never
    // reach it, a dirty `life` could.
    if (light) pushFxLight(this.fxLights, light);

    const base = Math.atan2(dir.y, dir.x);
    for (const layer of def.layers) this.emitMuzzleLayer(layer, pos, base);
  }

  /** One layer of a muzzle flash -> `layer.count` particles. Counts are exact, jitter is not. */
  private emitMuzzleLayer(layer: MuzzleLayer, pos: Vec2, base: number): void {
    const phys = MUZZLE_PHYSICS[layer.physics];
    const off = layer.angle ?? 0;
    const len = layer.len ?? [0, 0];
    const vyRange = layer.vy ?? [0, 0];
    const ySpread = layer.ySpread ?? 0;
    for (let i = 0; i < layer.count; i++) {
      // EVEN layers are spread by INDEX (a 6-particle shockwave ring drawn with random angles is
      // visibly lopsided — the same reason GameSim.spawnExplosion distributes its ring evenly);
      // random layers jitter inside the cone, which is what makes a spark fan look alive.
      const a = layer.even
        ? base + off - layer.cone + ((i + 0.5) * 2 * layer.cone) / layer.count
        : base + off + (Math.random() * 2 - 1) * layer.cone;
      const sp = layer.speed[0] + Math.random() * (layer.speed[1] - layer.speed[0]);
      const life = layer.life[0] + Math.random() * (layer.life[1] - layer.life[0]);
      const size = layer.size[0] + Math.random() * (layer.size[1] - layer.size[0]);
      this.particles.push({
        pos: v2(pos.x, pos.y),
        vel: v2(Math.cos(a) * sp, Math.sin(a) * sp),
        // The muzzle is at chest height, NOT on the floor: a flash drawn at the ground would read as
        // an impact. `ySpread` is the only per-layer vertical scatter (smoke, fireball, debris).
        y: MUZZLE_Y + (Math.random() * 2 - 1) * ySpread,
        vy: vyRange[0] + Math.random() * (vyRange[1] - vyRange[0]),
        buoy: phys.buoy,
        life,
        max: life,
        // For streaks this is the WIDTH and `len` the length; for puffs `size` is the billboard's
        // edge and `len` is unused (0, like every other puff in the game).
        size,
        len: phys.puff ? 0 : len[0] + Math.random() * (len[1] - len[0]),
        drag: phys.drag,
        swirl: phys.swirl,
        puff: phys.puff,
        aspect: phys.aspect,
        flick: phys.puff ? Math.random() * Math.PI * 2 : 0,
        solid: phys.solid,
        // Additive layers are dimmed so overlapping sparks stay in hue; normal-blended layers
        // (smoke, debris) carry literal screen colours and must not be dimmed (dim = 1 there).
        color: dimHex(layer.colors[(Math.random() * layer.colors.length) | 0], layer.dim),
        alive: true,
      });
    }
  }

  /**
   * The RPG's explosion, in six layers (physics knobs in config.ts). Every layer is a plain
   * Particle in the SAME sim array, so the sim stays node-testable and the renderer needs no
   * per-weapon knowledge; only the additive/normal split (`solid`) routes them to one of the two
   * instanced pools.
   *
   *   1. flash     — one huge, very short bright puff: the detonation itself;
   *   2. fireball  — fat buoyant puffs from white-hot to orange, the body of the explosion;
   *   3. shockwave — a RADIAL ring of fast, hard-damped particles whose maximum radius traces
   *                  ROCKET_BLAST_RADIUS (it is SCALED by it below, not hand-tuned to it);
   *   4. embers    — fast streaks with gravity that arc up and fall (fireworks);
   *   5. smoke     — big dark puffs rising slowly for ~1.5s (normal-blended: additive cannot
   *                  draw dark pixels at all);
   *   6. debris    — small solid chunks thrown out, falling and expiring as they land.
   *
   * Why it reads nothing like the dragon-breath splash: that effect is a narrow fan of 7 thin
   * additive streaks aimed along the hit normal, plus rising flame tongues. This one is
   * omnidirectional, uses much fatter puffs, and adds two layers (smoke + debris) the splash
   * physically cannot produce.
   *
   * `radius` is the DAMAGE radius the effect has to depict; it defaults to the rocket's so the
   * rocket call site is unchanged, while the grenade passes its own smaller radius and the ring's
   * maximum radius follows automatically (that equality is asserted in scripts/verify-burn.mjs).
   */
  spawnExplosion(pos: Vec2, radius: number = ROCKET_BLAST_RADIUS): void {
    const TAU = Math.PI * 2;
    // EVERY SIZE AND SPEED BELOW IS EXPRESSED AT THE ORIGINAL 3.5-UNIT BLAST, then multiplied by
    // this. Why: the effect's whole job is to show the damage area, and hand-maintained numbers
    // drift the moment somebody retunes the radius (which is exactly what happened when the rocket
    // went to 5.25). With the scale derived from the radius PASSED IN, "视觉即伤害范围" is a property
    // of the code rather than a list of constants that happens to agree today — the ring radius is
    // asserted against it in scripts/verify-burn.mjs (and the grenade gets the same guarantee at
    // its own smaller radius for free).
    //
    // WHAT IS SCALED: horizontal spread, particle sizes, launch speeds, and the RING'S PARTICLE
    // COUNT (a ring drawn with a fixed number of particles gets visibly beady when its
    // circumference grows — the same failure the melee crescent avoids).
    // WHAT IS NOT: heights and vertical velocities. Vertical motion is tuned against the 2-unit
    // character and the ground, not against the blast radius; scaling it would float the smoke
    // above the camera's readable band for no gain.
    const S = radius / 3.5;

    // 0. the light — not a particle: one transient point light at the blast, so the detonation LIGHTS
    //    the room instead of merely being drawn on it. Without it (and with the ambient term at 0)
    //    a rocket landing in a dark corner leaves the scenery around the fireball completely unlit,
    //    which reads as a decal rather than as an explosion. Peak on this frame, then a 0.5s tail
    //    that tracks the fireball; intensity and distance scale with S like every other horizontal
    //    number, life and height deliberately do not (see CONFIG.blastLight*). This consumes NO
    //    randomness, which is why the behavior trace is byte-identical for this change.
    const light = makeFxLight({
      x: pos.x, z: pos.y, y: CONFIG.blastLightY,
      color: EXPLOSION_LIGHT_COLOR,
      intensity: CONFIG.blastLightIntensity * S,
      distance: CONFIG.blastLightDistance * S,
      life: CONFIG.blastLightLife,
      falloff: CONFIG.blastLightFalloff,
    });
    if (light) pushFxLight(this.fxLights, light);

    // 1. flash — one big puff, ~4 frames. Additive, so it blooms white without any shader.
    this.particles.push({
      pos: v2(pos.x, pos.y), vel: v2(0, 0),
      y: 0.55, vy: 0, buoy: 0,
      life: 0.07, max: 0.07, size: 2.4 * S, len: 0,
      drag: 0, swirl: 0,
      puff: true, aspect: 1, flick: 0, solid: false,
      color: '#fff8e0', alive: true,
    });

    // 2. fireball — fat, buoyant, bright. `aspect` stays near 1 so it reads as a ball of fire,
    // NOT as the 0.55-wide flame tongue used by the burn DoT.
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * TAU;
      const r = Math.random() * 0.55 * S;
      const sp = (1.5 + Math.random() * 4) * S;
      const life = 0.28 + Math.random() * 0.22;
      this.particles.push({
        pos: v2(pos.x + Math.cos(a) * r, pos.y + Math.sin(a) * r),
        vel: v2(Math.cos(a) * sp, Math.sin(a) * sp),
        y: 0.35 + Math.random() * 0.7,
        vy: 1.2 + Math.random() * 1.6,
        buoy: CONFIG.blastBuoy,
        life, max: life,
        size: (0.55 + Math.random() * 0.6) * S,
        len: 0,
        drag: 2.2, swirl: CONFIG.flameSwirl * 0.5,
        puff: true, aspect: 0.9 + Math.random() * 0.3, flick: Math.random() * TAU, solid: false,
        color: FIRE_CORE_PALETTE[(Math.random() * FIRE_CORE_PALETTE.length) | 0],
        alive: true,
      });
    }

    // 3. shockwave ring — equal angular spacing (not random) so it reads as a ring, with a small
    // per-particle speed jitter so the edge is not a perfect circle.
    const RING_N = Math.round(28 * S);
    for (let i = 0; i < RING_N; i++) {
      const a = (i / RING_N) * TAU + (Math.random() - 0.5) * 0.08;
      const sp = CONFIG.blastRingSpeed * S * (0.92 + Math.random() * 0.16);
      this.particles.push({
        pos: v2(pos.x + Math.cos(a) * 0.18, pos.y + Math.sin(a) * 0.18),
        vel: v2(Math.cos(a) * sp, Math.sin(a) * sp),
        y: 0.06, vy: 0, buoy: 0,
        life: CONFIG.blastRingLife, max: CONFIG.blastRingLife,
        size: 0.05 + Math.random() * 0.03,
        len: 0.5 + Math.random() * 0.25,
        drag: CONFIG.blastRingDrag, swirl: 0,
        puff: false, aspect: 1, flick: 0, solid: false,
        color: i % 2 === 0 ? '#fff0c0' : '#ffd27a',
        alive: true,
      });
    }

    // 4. embers — fireworks: fast, low drag, gravity pulls them back down into an arc.
    for (let i = 0; i < 16; i++) {
      const a = Math.random() * TAU;
      const sp = (18 + Math.random() * 22) * S;
      const life = 0.45 + Math.random() * 0.3;
      this.particles.push({
        pos: v2(pos.x, pos.y),
        vel: v2(Math.cos(a) * sp, Math.sin(a) * sp),
        y: 0.3 + Math.random() * 0.6,
        vy: 2.5 + Math.random() * 3.5,
        buoy: CONFIG.blastGravity,
        life, max: life,
        size: 0.04 + Math.random() * 0.03,
        len: 0.5 + Math.random() * 0.5,
        drag: CONFIG.blastEmberDrag, swirl: CONFIG.sparkCurl * 0.12,
        puff: false, aspect: 1, flick: 0, solid: false,
        color: FIRE_PALETTE[(Math.random() * FIRE_PALETTE.length) | 0],
        alive: true,
      });
    }

    // 5. smoke — dark, big, slow, long-lived. NORMAL blending (`solid: true`) because additive
    // blending cannot darken anything; this layer is the main reason the two-pool split exists.
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * TAU;
      const r = Math.random() * 0.9 * S;
      const life = 1.0 + Math.random() * 0.7;
      this.particles.push({
        pos: v2(pos.x + Math.cos(a) * r, pos.y + Math.sin(a) * r),
        vel: v2(Math.cos(a) * (0.6 + Math.random() * 1.6) * S, Math.sin(a) * (0.6 + Math.random() * 1.6) * S),
        y: 0.6 + Math.random() * 1.2,
        vy: 0.7 + Math.random() * 1.1,
        buoy: CONFIG.blastSmokeRise,
        life, max: life,
        size: (0.8 + Math.random() * 0.9) * S,
        len: 0,
        drag: 1.2, swirl: CONFIG.flameSwirl * 0.6,
        puff: true, aspect: 1, flick: Math.random() * TAU, solid: true,
        color: SMOKE_PALETTE[(Math.random() * SMOKE_PALETTE.length) | 0],
        alive: true,
      });
    }

    // 6. debris — small solid chunks with gravity; the life is short enough that they expire
    // around ground level instead of sinking through the floor (there is no ground collision).
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * TAU;
      const sp = (6 + Math.random() * 10) * S;
      const life = 0.45 + Math.random() * 0.3;
      this.particles.push({
        pos: v2(pos.x, pos.y),
        vel: v2(Math.cos(a) * sp, Math.sin(a) * sp),
        y: 0.3 + Math.random() * 0.9,
        vy: 1.5 + Math.random() * 3.5,
        buoy: CONFIG.blastGravity,
        life, max: life,
        size: (0.07 + Math.random() * 0.07) * S,
        len: 0.1 + Math.random() * 0.1,
        drag: 3, swirl: 0,
        puff: false, aspect: 1, flick: 0, solid: true,
        color: DEBRIS_PALETTE[(Math.random() * DEBRIS_PALETTE.length) | 0],
        alive: true,
      });
    }
  }

  /**
   * Show one melee sweep. Called by `fireWeapon()` with the SAME (reach, arc) it is about to test
   * against, so the drawn crescent is a literal picture of the damage cone rather than a separate,
   * easily-desynced art asset (same rule as the RPG shockwave tracing ROCKET_BLAST_RADIUS).
   *
   * The crescent's travel and fade are derived in slash.ts from `t`; this method only records the
   * swing. The slipstream is emitted from `update()` while the crescent lives, NOT in one burst
   * here — see `spawnSlashStreak`.
   */
  spawnSlash(aim: number, reach: number, arc: number, dir: 1 | -1, time: number): void {
    // Oldest-first eviction: by the time the cap is hit, the oldest crescent is one the player has
    // already read. (`cooldown` 0.5s vs `swingTime` 0.22s means the cap is unreachable in normal
    // play; it exists so a future fast melee weapon cannot grow the array without bound.)
    if (this.slashes.length >= CONFIG.slashMax) this.slashes.shift();
    this.slashes.push(makeSlash(this.player.pos.x, this.player.pos.y, aim, reach, arc, dir, time));
  }

  /**
   * The blade landing on an enemy: cold sparks along the impact normal plus a tight, hard-damped
   * ring around the victim.
   *
   * Deliberately NOT `spawnSplash` (the projectile impact): that is an orange fire fan, and a steel
   * hit has to read as a different event — which is most of what "the melee has no attack effect"
   * was about. The ring is the same trick as the RPG shockwave at a much smaller scale: a damped
   * particle travels `speed/drag` units, so the ring's radius is set by those two knobs.
   */
  spawnMeleeHit(pos: Vec2, normal: Vec2, sparks: number): void {
    const base = Math.atan2(normal.y, normal.x);
    for (let i = 0; i < sparks; i++) {
      const a = base + (Math.random() * 2 - 1) * 0.9;
      const sp = CONFIG.meleeImpactSpeed * (1.4 + Math.random() * 0.8);
      const life = 0.18 + Math.random() * 0.2;
      this.particles.push({
        pos: v2(pos.x, pos.y),
        vel: v2(Math.cos(a) * sp, Math.sin(a) * sp),
        y: CONFIG.slashStreakY * (0.6 + Math.random() * 0.5),
        vy: 0.5 + Math.random() * 1.6,
        buoy: -8,                                    // sparks fall; the floor clamp catches them
        life, max: life,
        size: 0.035 + Math.random() * 0.035,
        len: 0.5 + Math.random() * 0.4,
        drag: CONFIG.sparkDrag, swirl: CONFIG.sparkCurl,
        puff: false, aspect: 1, flick: 0, solid: false,
        color: SLASH_PALETTE[(Math.random() * SLASH_PALETTE.length) | 0],
        alive: true,
      });
    }
    const n = CONFIG.meleeImpactRing;
    for (let i = 0; i < n; i++) {
      // Equal angular spacing (not random) so it reads as a ring, with a small speed jitter so the
      // edge is not a perfect circle.
      const a = (i / n) * Math.PI * 2;
      const sp = CONFIG.meleeImpactSpeed * (0.9 + Math.random() * 0.2);
      const life = 0.16 + Math.random() * 0.1;
      this.particles.push({
        pos: v2(pos.x + Math.cos(a) * 0.25, pos.y + Math.sin(a) * 0.25),
        vel: v2(Math.cos(a) * sp, Math.sin(a) * sp),
        y: CONFIG.slashStreakY * 0.6, vy: 0, buoy: 0,
        life, max: life,
        size: 0.04 + Math.random() * 0.02,
        len: 0.4 + Math.random() * 0.25,
        drag: CONFIG.meleeImpactDrag, swirl: 0,
        puff: false, aspect: 1, flick: 0, solid: false,
        color: i % 2 === 0 ? '#ffffff' : '#9fe8ff',
        alive: true,
      });
    }
  }

  /**
   * One slipstream streak, emitted at the crescent's CURRENT leading edge.
   *
   * TANGENTIAL launch, not radial: the renderer orients every streak along its own velocity, so a
   * radial push would draw spokes (a fan) while a tangential one stretches each streak along the
   * arc — which is what reads as the blade smearing through the air. The radius jitter keeps the
   * trail from collapsing into a single thin line.
   */
  private spawnSlashStreak(s: SlashFx): void {
    // Same soft cap the burn flames respect, so a crowded arena cannot make a swing unbounded.
    if (this.particles.length >= CONFIG.flameParticleCap) return;
    const a = slashAngle(s);
    const r = s.reach * (0.66 + Math.random() * 0.32);
    // Tangent for an increasing angle is (-sin, cos); `dir` mirrors it for a counter-clockwise swing.
    const tx = -Math.sin(a) * s.dir;
    const tz = Math.cos(a) * s.dir;
    const sp = CONFIG.slashStreakSpeed * (0.75 + Math.random() * 0.5);
    const life = 0.11 + Math.random() * 0.12;
    this.particles.push({
      pos: v2(s.x + Math.cos(a) * r, s.z + Math.sin(a) * r),
      vel: v2(tx * sp, tz * sp),
      y: CONFIG.slashStreakY + (Math.random() - 0.5) * 0.22,
      vy: 0.4 + Math.random() * 0.9, buoy: 0,
      life, max: life,
      size: 0.028 + Math.random() * 0.03,
      len: 0.5 + Math.random() * 0.5,
      drag: CONFIG.slashStreakDrag, swirl: 0,
      puff: false, aspect: 1, flick: 0, solid: false,
      color: SLASH_PALETTE[(Math.random() * SLASH_PALETTE.length) | 0],
      alive: true,
    });
  }

  /**
   * One burn-flame puff: slow, buoyant, fat and camera-facing. Spawned continuously while an
   * enemy burns (see the burn pass in update()), so the plume reads as "on fire" rather than as
   * an impact. Uses the same particle pool as the sparks — no new mesh, no new draw call.
   *
   * `size` is in WORLD units and 1 unit is ~29 CSS px at the reference framing: the first version
   * used 0.10-0.19 u (3-5 px) and was invisible next to the 17-46 px splash streaks, which is why
   * the fire read as "long bars" (those were the sparks). `puff: true` makes the renderer draw a
   * square billboard instead of a velocity-stretched streak, and `flick` gives each puff its own
   * phase for the noise-driven brightness shimmer.
   */
  spawnBurnFlame(pos: Vec2): void {
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * 0.45;                 // spread around the body, not a point
    const sp = CONFIG.flameDriftMin + Math.random() * CONFIG.flameDriftVar;
    const life = CONFIG.flameLifeMin + Math.random() * CONFIG.flameLifeVar;
    this.particles.push({
      pos: v2(pos.x + Math.cos(a) * r, pos.y + Math.sin(a) * r),
      vel: v2(Math.cos(a) * sp, Math.sin(a) * sp),
      y: 0.4 + Math.random() * 0.9,                 // start around the torso/head
      vy: CONFIG.flameRiseMin + Math.random() * CONFIG.flameRiseVar,
      buoy: CONFIG.flameBuoy,
      life,
      max: life,
      size: CONFIG.flameSizeMin + Math.random() * CONFIG.flameSizeVar,   // 0.35-0.70 u = 10-20 px
      len: 0,                                       // unused for puffs (renderer draws a square)
      drag: CONFIG.flameDrag,
      swirl: CONFIG.flameSwirl,
      puff: true,
      aspect: CONFIG.flameAspect,
      flick: Math.random() * Math.PI * 2,
      solid: false,
      color: dimHex(FIRE_PALETTE[(Math.random() * FIRE_PALETTE.length) | 0], CONFIG.flameDim),
      alive: true,
    });
  }
}
