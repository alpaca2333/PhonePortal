// Pure HUD decisions — no DOM, no three.js, no game.ts. render.ts turns these numbers into DOM
// writes and instance matrices; scripts/verify-ammo.mjs / verify-inventory.mjs assert them in Node.
// Same reasoning as stick.ts / camera.ts / streak.ts: anything that is "a rule" rather than "a
// drawing call" belongs in a leaf module so it can be verified without a browser.
//
// The only import is armor.ts (also a pure leaf) and it is deliberate: the level label and the
// level clamp must not be re-implemented here, or the HUD would eventually print `Lv10` for a
// corrupt value while the inventory printed `Lv6`.
import { clampLevel, levelLabel } from './armor.js';

export interface AmmoReadout {
  /**
   * What the ammo block says: `7/30 · 备弹 143`, `换弹中`, `备弹 4` (no magazine), or
   * `0/30 · 无备弹` when both the magazine and the backpack are empty.
   */
  text: string;
  /** 0..1 fraction for the HUD's magazine bar (reload progress while reloading) */
  ratio: number;
  /** true while a reload is running: drives the highlight class and the head-level bar */
  reloading: boolean;
  /** magazine AND backpack are empty — the HUD styles this one red */
  dry: boolean;
  /** weapon with no magazine (rpg): there is no magazine to draw a bar for */
  nobar: boolean;
  /** penetration level of the loaded ammo (1..6), or null for melee / no weapon */
  level: number | null;
}

export interface ArmorReadout {
  /** `Lv3 42/50`, `Lv3 已损坏`, or `无护甲` */
  text: string;
  /** 0..1 plate condition */
  ratio: number;
  /** plate exists but its value has hit 0: it no longer protects */
  broken: boolean;
  /** plate level (1..6), or null when there is no plate at all */
  level: number | null;
}

export interface ActionReadout {
  /** the slot is empty -> the on-screen button must not be shown at all */
  visible: boolean;
  /** on cooldown -> shown but dimmed */
  dim: boolean;
}

/** Clamp to 0..1 (also turns NaN into 0, so a bad number cannot produce `NaN%` in CSS). */
function clamp01(v: number): number {
  return v > 0 ? (v > 1 ? 1 : v) : 0;
}

/** Integer for display, so fractional armour damage never prints `42.399999999999999`. */
function int(v: number): number {
  return Number.isFinite(v) ? Math.round(v) : 0;
}

/**
 * Reload progress, 1 = the magazine is full again. Defensive by design: `reloadTotal` is 0
 * whenever no reload is running (and could be stale after a weapon swap), so anything
 * non-positive returns 0 instead of dividing by zero.
 */
export function reloadBarProgress(reloadTimer: number, reloadTotal: number): number {
  if (!(reloadTotal > 0)) return 0;
  return clamp01(1 - reloadTimer / reloadTotal);
}

/**
 * What the HUD shows for the current magazine AND the backpack reserve.
 *
 * `reserve` is 「备弹」: the total number of this weapon's rounds left in the backpack. `magSize <= 0`
 * means "no magazine" (melee weapons and the rpg): the text becomes the reserve itself and the
 * magazine bar is hidden, because there is no magazine to draw.
 *
 * While reloading the text is fixed and the bar becomes the reload progress, so the player can see
 * the reload ticking even with 0 rounds — and `dry` stays false, because a reload in progress is
 * proof the reserve was not empty when it started.
 */
export function ammoReadout(
  ammo: number,
  magSize: number,
  reloadTimer: number,
  reloadTotal: number,
  reserve = 0,
  level: number | null = null,
): AmmoReadout {
  const lv = level === null ? null : clampLevel(level);
  if (reloadTimer > 0) {
    return {
      text: '换弹中', ratio: reloadBarProgress(reloadTimer, reloadTotal),
      reloading: true, dry: false, nobar: magSize <= 0, level: lv,
    };
  }
  const have = int(reserve);
  if (magSize > 0) {
    const rounds = int(ammo);
    // `dry` is about the SUPPLY, not this magazine: an empty magazine with rounds in the bag is
    // just a reload away, while no rounds anywhere means the weapon is finished.
    const dry = rounds <= 0 && have <= 0;
    return {
      text: dry ? '0/' + magSize + ' · 无备弹' : rounds + '/' + magSize + ' · 备弹 ' + have,
      ratio: clamp01(ammo / magSize),
      reloading: false,
      dry,
      nobar: false,
      level: lv,
    };
  }
  const dry = have <= 0;
  return {
    text: dry ? '无备弹' : '备弹 ' + have,
    ratio: 1, reloading: false, dry, nobar: true, level: lv,
  };
}

/** The player's armour readout. A null plate (empty slot) is a real, non-broken state. */
export function armorReadout(armor: { level: number; value: number; max: number } | null): ArmorReadout {
  if (!armor) return { text: '无护甲', ratio: 0, broken: false, level: null };
  const lv = clampLevel(armor.level);
  if (!(armor.value > 0)) {
    return { text: levelLabel(lv) + ' 已损坏', ratio: 0, broken: true, level: lv };
  }
  return {
    text: levelLabel(lv) + ' ' + int(armor.value) + '/' + int(armor.max),
    ratio: clamp01(armor.value / armor.max),
    broken: false,
    level: lv,
  };
}

/**
 * State of one on-screen action button (throwable / healing).
 *
 * The user requirement is exactly this: a slot with nothing in it must not draw a button at all,
 * and a button that cannot be used right now stays visible but dimmed (hiding it would make the
 * HUD jump every time a cooldown started).
 */
export function actionButtonReadout(count: number, cooldown: number): ActionReadout {
  const n = Number.isFinite(count) ? count : 0;
  return { visible: n > 0, dim: Number.isFinite(cooldown) ? cooldown > 0 : false };
}

// ---------------------------------------------------------------------------------------------
// World-space bar LAYOUT (enemy health bar + its armour strip, and the player's reload strip)
// ---------------------------------------------------------------------------------------------
// WHY THESE NUMBERS LIVE IN A PURE MODULE INSTEAD OF render.ts: they are geometry RULES, and the one
// that matters — the two enemy bars must not touch — is invisible in code review but obvious on a
// device. The first version measured the gap between the FILL edges, while the dark FRAME drawn
// behind each fill is `BAR_PAD` larger on EVERY side; the frames therefore overlapped by 0.05 world
// units and the armour strip read as part of the health bar (real-device feedback: 「护甲条和血条太
// 重叠了」). Measuring frame edge to frame edge, and asserting it in Node, is what stops that from
// coming back.
//
// The strip's COLOUR is the plate's LEVEL (armor.ts::levelColorHex) — that is the whole point: the
// player can tell at a glance whether the gun they are holding can penetrate it.
export const BAR_W = 1.15;         // fill width in world units (both bars share it)
export const BAR_H = 0.13;         // health fill height
export const BAR_PAD = 0.05;       // dark frame border around a fill (on EVERY side)
export const ARMOR_BAR_H = 0.06;   // armour fill height — deliberately thinner than the health bar
export const BAR_Y = 2.3;          // health bar centre height above the enemy's feet (chars are 2.0)
/** Clear world units required between the health bar's frame and the armour strip's frame. */
export const BAR_FRAME_GAP = 0.18;

/** Visible frame height for a fill of height `fillH` (the frame is BAR_PAD bigger on every side). */
export function barFrameHeight(fillH: number): number {
  return fillH + BAR_PAD * 2;
}

/** Top edge of the visible frame of a bar centred at `y`. */
export function barFrameTop(y: number, fillH: number): number {
  return y + barFrameHeight(fillH) / 2;
}

/** Bottom edge of the visible frame of a bar centred at `y`. */
export function barFrameBottom(y: number, fillH: number): number {
  return y - barFrameHeight(fillH) / 2;
}

/** Centre height of the armour strip: exactly BAR_FRAME_GAP clear of the health bar's FRAME. */
export const ARMOR_BAR_Y = barFrameTop(BAR_Y, BAR_H) + BAR_FRAME_GAP + barFrameHeight(ARMOR_BAR_H) / 2;

/** Actual clear space between the two frames (negative would mean they intersect). */
export const ARMOR_BAR_CLEARANCE = barFrameBottom(ARMOR_BAR_Y, ARMOR_BAR_H) - barFrameTop(BAR_Y, BAR_H);

// ---------------------------------------------------------------------------------------------
// World-space bar SLOT ALLOCATION
// ---------------------------------------------------------------------------------------------
// Every bar written to the pools is ONE frame instance plus ONE fill instance. The bug this exists
// to prevent: the health bar and the armour strip were written with the SAME index
// (`writeBarFrame(bn, …)` twice while `bn` was incremented once), so the armour strip's dark frame
// overwrote the health bar's — an armoured enemy's health bar lost its background and its fill
// floated over the world (real-device feedback: 「显示护甲条的时候，血条就丢失背景了」).
//
// WHY AN ALLOCATOR INSTEAD OF JUST `+1`: "each drawn bar takes its own slot" is a RULE, and a rule
// belongs in a pure module this repo can assert in Node (see scripts/verify-inventory.mjs —
// consecutive `next()` calls must hand out distinct, increasing slots). A hand-maintained index is
// exactly the kind of thing that silently regresses the next time a bar is added.
export const MAX_ENEMY_BARS = 128;                       // enemies that get bars at all
export const MAX_BAR_SLOTS = MAX_ENEMY_BARS * 2 + 1;    // health + armour per enemy, + reload bar

export interface BarAllocator {
  /** frame-pool index of the bar most recently taken (`next()` returned true); -1 = none yet */
  readonly frame: number;
  /** fill-pool index of the bar most recently taken; -1 = none yet */
  readonly fill: number;
  /** Reserve one bar's slots. False when the pools are full: the caller must stop drawing. */
  next(): boolean;
}

/** A fresh allocator over `capacity` slots per pool (one bar = one frame + one fill). */
export function createBarAllocator(capacity: number = MAX_BAR_SLOTS): BarAllocator {
  const cap = Number.isFinite(capacity) && capacity > 0 ? Math.floor(capacity) : 0;
  // Closure state + getters: the counters are read-only to callers (they cannot be written except
  // through `next()`), which is the whole point of routing every bar through this object.
  let frame = -1;
  let fill = -1;
  return {
    get frame() { return frame; },
    get fill() { return fill; },
    next() {
      if (frame + 1 >= cap || fill + 1 >= cap) return false;
      frame += 1;
      fill += 1;
      return true;
    },
  };
}
