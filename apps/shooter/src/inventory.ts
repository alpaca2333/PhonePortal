// The backpack model: cells, the five equipment slots, the stacking rules and the starting
// loadout. Pure — no DOM, no three, no game.ts — so every rule here is asserted in Node
// (scripts/verify-inventory.mjs) the same way hud.ts / stick.ts / camera.ts are.
//
// SHAPE
//   * `bag` is a fixed-size array of 20 cells (`null` = empty). Ammo stacks to 200 per cell (user
//     requirement), throwables/healing to 5, weapons and armour are one per cell.
//   * `slots` holds the five equipment slots. `accepts()` is the ONLY place the type rule lives:
//     weapons go in weapon slots, throwables in the throwable slot, healing in the healing slot,
//     armour in the armour slot, anything in the bag.
//   * `activeSlot` is which weapon slot is in the player's hands (primary/secondary only — the
//     throwable and healing slots are used through their buttons, never "equipped").
//
// THE MAGAZINE LIVES ON THE WEAPON ITEM (see items.ts): `ammo` + `primed` travel with the item, so
// moving weapons around the inventory can never silently lose or duplicate rounds. `primed: false`
// means "fill from the bag reserve the next time this weapon is equipped" — that is what stops a
// weapon swap from being a free reload.
//
// WHY THE DEFAULT LOADOUT IS BUILT HERE AND NOT PERSISTED: it is per-run state, exactly like the
// weapon choice the app already declines to persist (see apps/shooter/README.md). `reset()` builds
// a fresh one; nothing is written to the settings scope.
import {
  AMMO, ARMORS, HEALINGS, THROWABLES,
  countOf, createAmmo, createArmor, createHealing, createThrowable, createWeapon,
  isStackable, stackMaxOf,
} from './items.js';
import type { AmmoId, ArmorId, HealingId, Item, ThrowableId } from './items.js';
import { ammoIdOf, getWeaponOrNull } from './weapons.js';
import { levelLabel } from './armor.js';

/** Number of backpack cells. Public so the panel and the tests agree on the grid size. */
export const BACKPACK_SIZE = 20;

export type SlotId = 'primary' | 'secondary' | 'throwable' | 'healing' | 'armor';

export const SLOT_IDS: readonly SlotId[] = ['primary', 'secondary', 'throwable', 'healing', 'armor'];

/** Slot captions for the inventory panel (and the error text in tests). */
export const SLOT_LABELS: Record<SlotId, string> = {
  primary: '主武器',
  secondary: '副武器',
  throwable: '投掷物',
  healing: '治疗物',
  armor: '护甲',
};

/** A location inside the inventory: either an equipment slot or a bag cell index. */
export type ItemRef =
  | { where: 'slot'; slot: SlotId }
  | { where: 'bag'; index: number };

export const slotRef = (slot: SlotId): ItemRef => ({ where: 'slot', slot });
export const bagRef = (index: number): ItemRef => ({ where: 'bag', index });

export interface Inventory {
  bag: (Item | null)[];
  slots: Record<SlotId, Item | null>;
  activeSlot: 'primary' | 'secondary';
}

// ---------------------------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------------------------
/**
 * The starting loadout. Chosen so the whole feature is visible from the first second:
 *   * both weapon slots filled (primary = the SMG the game always started with, secondary = the
 *     shotgun), so the switch button has something to switch to;
 *   * spare weapons in the bag (rocket launcher, machete) to exercise "only weapons go in weapon
 *     slots" — the RPG's rockets are useless until it is dragged into a slot;
 *   * each ammo type in TWO cells (or one full cell) so both the stacking rule and "reload draws
 *     from the bag" are visible without ever running dry;
 *   * armour equipped AND a spare plate in the bag.
 *
 * AMMO IS DELIBERATELY GENEROUS — TESTING LOADOUT (real-device request: 「初始备弹多给一点，龙息弹
 * rpg 都给很多方便我测试」). Every ammo cell is at the 200-round cap: 9mm and shells get two full
 * cells (400 each), rockets one (200, i.e. 50x the 4 this used to ship with). Ammo is the one
 * resource that only ever DECREASES (there is no pickup system — see the README's known limits), so
 * a run used to end with an empty bag and no way to test the late-game weapons; this is the
 * zero-code way to keep every weapon testable. TO RESTORE THE TIGHT LOADOUT: 9mm 200 + 100, shells
 * 64, rockets 4 — that is the only change needed, and nothing else reads these numbers.
 */
export function createInventory(): Inventory {
  const bag: (Item | null)[] = new Array(BACKPACK_SIZE).fill(null);
  bag[0] = createWeapon('rpg');
  bag[1] = createWeapon('sword');
  bag[2] = createAmmo('ammo9mm', 200);
  bag[3] = createAmmo('ammo9mm', 200);
  bag[4] = createAmmo('ammoShell', 200);
  bag[5] = createAmmo('ammoShell', 200);
  bag[6] = createAmmo('ammoRocket', 200);
  bag[7] = createArmor('armorLight');
  bag[8] = createThrowable('frag', 2);
  bag[9] = createHealing('medkit', 2);
  return {
    bag,
    slots: {
      primary: createWeapon('smg'),
      secondary: createWeapon('dragonBreath'),
      throwable: createThrowable('frag', 3),
      healing: createHealing('medkit', 3),
      armor: createArmor('armorMedium'),
    },
    activeSlot: 'primary',
  };
}

// ---------------------------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------------------------
export function isWeaponItem(item: Item | null | undefined): item is Extract<Item, { kind: 'weapon' }> {
  return !!item && item.kind === 'weapon';
}

export function sameRef(a: ItemRef, b: ItemRef): boolean {
  if (a.where !== b.where) return false;
  return a.where === 'slot'
    ? (b as { where: 'slot'; slot: SlotId }).slot === a.slot
    : (b as { where: 'bag'; index: number }).index === a.index;
}

/** Read a cell. Out-of-range indices read as empty rather than throwing (dirty input). */
export function getItem(inv: Inventory, ref: ItemRef): Item | null {
  if (ref.where === 'slot') return inv.slots[ref.slot] ?? null;
  if (!Number.isInteger(ref.index) || ref.index < 0 || ref.index >= inv.bag.length) return null;
  return inv.bag[ref.index];
}

function setItem(inv: Inventory, ref: ItemRef, item: Item | null): void {
  if (ref.where === 'slot') { inv.slots[ref.slot] = item; return; }
  if (!Number.isInteger(ref.index) || ref.index < 0 || ref.index >= inv.bag.length) return;
  inv.bag[ref.index] = item;
}

/** How many cells are in use (the panel's "12/20" readout). */
export function usedCells(inv: Inventory): number {
  let n = 0;
  for (const c of inv.bag) if (c) n++;
  return n;
}

// ---------------------------------------------------------------------------------------------
// The slot type rule — the ONLY definition of "can this go there"
// ---------------------------------------------------------------------------------------------
export function accepts(slot: SlotId, item: Item): boolean {
  switch (slot) {
    case 'primary':
    case 'secondary': return item.kind === 'weapon';
    case 'throwable': return item.kind === 'throwable';
    case 'healing': return item.kind === 'healing';
    case 'armor': return item.kind === 'armor';
  }
}

function fitsIn(inv: Inventory, ref: ItemRef, item: Item): boolean {
  if (ref.where === 'bag') {
    return Number.isInteger(ref.index) && ref.index >= 0 && ref.index < inv.bag.length;
  }
  return accepts(ref.slot, item);
}

/**
 * Can `from` be dropped on `to`?
 *   * empty target: only the type rule matters;
 *   * occupied target: SWAP, but only when BOTH items fit their new home — so dragging a weapon
 *     onto a health kit rejects outright, and dragging a weapon from the bag onto the primary slot
 *     trades places with the weapon already there.
 * Dropping onto itself is always rejected (a no-op the caller can report as "invalid").
 */
export function canMove(inv: Inventory, from: ItemRef, to: ItemRef): boolean {
  if (sameRef(from, to)) return false;
  const moving = getItem(inv, from);
  if (!moving) return false;
  if (!fitsIn(inv, to, moving)) return false;
  const displaced = getItem(inv, to);
  if (displaced && !fitsIn(inv, from, displaced)) return false;
  return true;
}

/** Commit a move (place or swap). Mutates `inv`; returns false when `canMove` says no. */
export function applyMove(inv: Inventory, from: ItemRef, to: ItemRef): boolean {
  if (!canMove(inv, from, to)) return false;
  const moving = getItem(inv, from);
  const displaced = getItem(inv, to);
  setItem(inv, to, moving);
  setItem(inv, from, displaced);
  return true;
}

// ---------------------------------------------------------------------------------------------
// Ammo reserve: "备弹 = the total of this ammo type in the backpack"
// ---------------------------------------------------------------------------------------------
/** Total rounds of `ammoId` in the bag. Ammo can only live in the bag (no slot accepts it). */
export function reserveOf(inv: Inventory, ammoId: AmmoId | null): number {
  if (!ammoId) return 0;
  let n = 0;
  for (const c of inv.bag) {
    if (c && c.kind === 'ammo' && c.ammoId === ammoId) n += c.count;
  }
  return n;
}

/**
 * Remove up to `n` rounds of `ammoId` from the bag, lowest index first, emptying cells as they run
 * out. Returns how many were actually taken (never more than are there) — callers add that number
 * to a magazine, so a partial reserve produces a partial refill rather than a magic full one.
 */
export function consumeAmmo(inv: Inventory, ammoId: AmmoId, n: number): number {
  let need = Number.isFinite(n) ? Math.floor(n) : 0;
  if (need <= 0) return 0;
  let taken = 0;
  for (let i = 0; i < inv.bag.length && need > 0; i++) {
    const it = inv.bag[i];
    if (!it || it.kind !== 'ammo' || it.ammoId !== ammoId) continue;
    const take = it.count < need ? it.count : need;
    it.count -= take;
    need -= take;
    taken += take;
    if (it.count <= 0) inv.bag[i] = null;
  }
  return taken;
}

/**
 * Put rounds back into the bag: top up existing matching stacks first, then open new cells, each
 * capped at the ammo's stack size. Reports partial success instead of failing outright, so a caller
 * that must not lose rounds can check `ok`.
 */
export function addAmmo(inv: Inventory, ammoId: AmmoId, n: number): { added: number; ok: boolean } {
  const want = Number.isFinite(n) ? Math.floor(n) : 0;
  if (want <= 0) return { added: 0, ok: true };
  const cap = AMMO[ammoId] ? AMMO[ammoId].stackMax : 1;
  let left = want;
  let added = 0;
  for (let i = 0; i < inv.bag.length && left > 0; i++) {
    const it = inv.bag[i];
    if (!it || it.kind !== 'ammo' || it.ammoId !== ammoId) continue;
    const room = cap - it.count;
    if (room <= 0) continue;
    const put = room < left ? room : left;
    it.count += put;
    left -= put;
    added += put;
  }
  for (let i = 0; i < inv.bag.length && left > 0; i++) {
    if (inv.bag[i]) continue;
    const put = cap < left ? cap : left;
    inv.bag[i] = createAmmo(ammoId, put);
    left -= put;
    added += put;
  }
  return { added, ok: added === want };
}

/**
 * Spend one unit of a stack (throw a grenade / use a medkit). Removes the item when the stack hits
 * zero. Returns false when the cell is already empty (or holds a non-stackable item).
 */
export function takeOne(inv: Inventory, ref: ItemRef): boolean {
  const it = getItem(inv, ref);
  if (!it) return false;
  if (isStackable(it)) {
    it.count -= 1;
    if (it.count <= 0) setItem(inv, ref, null);
    return true;
  }
  setItem(inv, ref, null);
  return true;
}

// ---------------------------------------------------------------------------------------------
// Labels — the panel and the HUD read these so the item vocabulary lives in one place
// ---------------------------------------------------------------------------------------------
/** The item's penetration level, or null when it has none (melee weapons, healing). */
export function itemLevel(item: Item | null): number | null {
  if (!item) return null;
  switch (item.kind) {
    case 'weapon': {
      const id = ammoIdOf(getWeaponOrNull(item.weaponId));
      return id ? AMMO[id].level : null;
    }
    case 'ammo': return AMMO[item.ammoId] ? AMMO[item.ammoId].level : null;
    case 'throwable': return THROWABLES[item.id] ? THROWABLES[item.id].level : null;
    case 'armor': return item.level;
    case 'healing': return null;
  }
}

/** Full label, e.g. `9mm 弹 Lv2 ×143` / `中型护甲 Lv3 42/50` / `冲锋枪 · 9mm 弹 Lv2`. */
export function itemLabel(item: Item | null): string {
  if (!item) return '';
  switch (item.kind) {
    case 'weapon': {
      const w = getWeaponOrNull(item.weaponId);
      if (!w) return item.weaponId;
      const id = ammoIdOf(w);
      return id ? w.name + ' · ' + AMMO[id].name + ' ' + levelLabel(AMMO[id].level) : w.name;
    }
    case 'ammo': {
      const d = AMMO[item.ammoId];
      return d ? d.name + ' ' + levelLabel(d.level) + ' ×' + item.count : '?';
    }
    case 'throwable': {
      const d = THROWABLES[item.id];
      return d ? d.name + ' ' + levelLabel(d.level) + ' ×' + item.count : '?';
    }
    case 'healing': {
      const d = HEALINGS[item.id];
      return d ? d.name + ' ×' + item.count : '?';
    }
    case 'armor': {
      const d = ARMORS[item.id];
      return (d ? d.name : item.id) + ' ' + levelLabel(item.level) + ' ' + item.value + '/' + item.max;
    }
  }
}

/** Very short cell caption (the grid prints the count and the level badge separately). */
export function itemShort(item: Item | null): string {
  if (!item) return '';
  switch (item.kind) {
    case 'weapon': {
      const w = getWeaponOrNull(item.weaponId);
      return w ? w.name : item.weaponId;
    }
    case 'ammo': return AMMO[item.ammoId] ? AMMO[item.ammoId].short : '?';
    case 'throwable': return THROWABLES[item.id] ? THROWABLES[item.id].short : '?';
    case 'healing': return HEALINGS[item.id] ? HEALINGS[item.id].short : '?';
    case 'armor': return ARMORS[item.id] ? ARMORS[item.id].short : '?';
  }
}

/** The count printed on a cell (`null` for single items, which print nothing). */
export function itemCount(item: Item | null): number | null {
  return item && isStackable(item) ? item.count : null;
}

// Re-exported so callers building test fixtures do not need a second import from items.ts.
export { countOf, createAmmo, createArmor, createHealing, createThrowable, createWeapon, stackMaxOf };
export type { AmmoId, ArmorId, HealingId, ThrowableId, Item };
