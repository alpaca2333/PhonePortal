// The item catalogue: ammunition, armour plates, throwables and healing. Pure data + a few pure
// helpers — no DOM, no three — so the inventory model (inventory.ts) and the tests can work
// against a single registry instead of scattering literals.
//
// DEPENDENCY NOTE: this module reads `level` / damage / radius / fuse straight off the
// corresponding `ProjectileDef`, so "the bullet level the game actually fires" and "the level the
// inventory prints" cannot drift apart — there is no second number to keep in sync. That is why
// items.ts sits ON TOP of projectiles.ts (`items -> projectiles -> math2/config`), while
// weapons.ts only takes the `AmmoId` union from here as a TYPE (`import type`, erased at runtime,
// so there is no cycle at all).
import { PROJECTILES } from './projectiles.js';
import type { ProjectileId } from './projectiles.js';

/** Every ammo cell stacks to the same cap. User requirement: 子弹单格能堆叠 200 发. */
export const AMMO_STACK_MAX = 200;

// ---------------------------------------------------------------------------------------------
// Ammunition
// ---------------------------------------------------------------------------------------------
export type AmmoId = 'ammo9mm' | 'ammoShell' | 'ammoRocket';

export interface AmmoDef {
  readonly id: AmmoId;
  readonly name: string;
  /** very short label for the inventory grid cell */
  readonly short: string;
  /** which projectile this ammo loads; its `level` is the bullet level (single source of truth) */
  readonly projectile: ProjectileId;
  readonly level: number;
  readonly stackMax: number;
}

export const AMMO: Record<AmmoId, AmmoDef> = {
  ammo9mm: {
    id: 'ammo9mm', name: '9mm 弹', short: '9mm',
    projectile: 'smgRound', level: PROJECTILES.smgRound.level, stackMax: AMMO_STACK_MAX,
  },
  ammoShell: {
    id: 'ammoShell', name: '12 号霰弹', short: '12号',
    projectile: 'flameShot', level: PROJECTILES.flameShot.level, stackMax: AMMO_STACK_MAX,
  },
  ammoRocket: {
    id: 'ammoRocket', name: '火箭弹', short: '火箭',
    projectile: 'rocket', level: PROJECTILES.rocket.level, stackMax: AMMO_STACK_MAX,
  },
};

export function isAmmoId(v: unknown): v is AmmoId {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(AMMO, v);
}

// ---------------------------------------------------------------------------------------------
// Armour plates
// ---------------------------------------------------------------------------------------------
export type ArmorId = 'armorLight' | 'armorMedium' | 'armorHeavy' | 'armorAssault';

export interface ArmorDef {
  readonly id: ArmorId;
  readonly name: string;
  readonly short: string;
  /** plate level 1..6 (see armor.ts for what a level does) */
  readonly level: number;
  /** starting / maximum plate value */
  readonly value: number;
}

export const ARMORS: Record<ArmorId, ArmorDef> = {
  armorLight: { id: 'armorLight', name: '轻型护甲', short: '轻甲', level: 2, value: 40 },
  armorMedium: { id: 'armorMedium', name: '中型护甲', short: '中甲', level: 3, value: 50 },
  armorHeavy: { id: 'armorHeavy', name: '重型护甲', short: '重甲', level: 5, value: 70 },
  armorAssault: { id: 'armorAssault', name: '突击护甲', short: '突甲', level: 6, value: 90 },
};

export function isArmorId(v: unknown): v is ArmorId {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(ARMORS, v);
}

// ---------------------------------------------------------------------------------------------
// Throwables
// ---------------------------------------------------------------------------------------------
export type ThrowableId = 'frag';

export interface ThrowableDef {
  readonly id: ThrowableId;
  readonly name: string;
  readonly short: string;
  readonly projectile: ProjectileId;
  readonly level: number;
  readonly stackMax: number;
}

export const THROWABLE_STACK_MAX = 5;

export const THROWABLES: Record<ThrowableId, ThrowableDef> = {
  frag: {
    id: 'frag', name: '破片手雷', short: '手雷',
    projectile: 'grenade', level: PROJECTILES.grenade.level, stackMax: THROWABLE_STACK_MAX,
  },
};

export function isThrowableId(v: unknown): v is ThrowableId {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(THROWABLES, v);
}

// ---------------------------------------------------------------------------------------------
// Healing
// ----------------------------------------------------------------------------
// Healing deliberately has NO level: the spec's 1..6 ladder is about penetration, and giving a
// medkit a colour from that ladder would collide with level-2 green in the inventory. It is drawn
// in a neutral grey-blue with a cross marker instead (see armor.NO_LEVEL_COLOR).
export type HealingId = 'medkit';

export interface HealingDef {
  readonly id: HealingId;
  readonly name: string;
  readonly short: string;
  /** HP restored per use (clamped to maxHp at use time) */
  readonly heal: number;
  /** seconds before the next use */
  readonly cooldown: number;
  readonly stackMax: number;
}

export const HEALING_STACK_MAX = 5;

export const HEALINGS: Record<HealingId, HealingDef> = {
  medkit: { id: 'medkit', name: '急救包', short: '急救', heal: 40, cooldown: 2.0, stackMax: HEALING_STACK_MAX },
};

export function isHealingId(v: unknown): v is HealingId {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(HEALINGS, v);
}

// ---------------------------------------------------------------------------------------------
// The item union
// ---------------------------------------------------------------------------------------------
// `weaponId` is a plain string rather than the `WeaponId` union on purpose: weapons.ts owns that
// union and imports this module (type-only), so referring to it here would close the loop.
// inventory.ts validates it against the live WEAPONS registry instead.
//
// THE MAGAZINE LIVES ON THE WEAPON ITEM (`ammo` + `primed`), not on the player and not on the slot:
// a weapon carried around the inventory keeps its rounds, a swap trades whole weapons (mag and
// all), and there is no "return the magazine to the backpack" edge case to get wrong.
export type Item =
  | { kind: 'weapon'; weaponId: string; ammo: number; primed: boolean }
  | { kind: 'ammo'; ammoId: AmmoId; count: number }
  | { kind: 'throwable'; id: ThrowableId; count: number }
  | { kind: 'healing'; id: HealingId; count: number }
  | { kind: 'armor'; id: ArmorId; level: number; value: number; max: number };

export type ItemKind = Item['kind'];

/** How many of this item fit in one cell. `Infinity` never happens: every kind has a cap. */
export function stackMaxOf(item: Item): number {
  switch (item.kind) {
    case 'ammo': return AMMO[item.ammoId].stackMax;
    case 'throwable': return THROWABLES[item.id].stackMax;
    case 'healing': return HEALINGS[item.id].stackMax;
    default: return 1;   // weapons and armour are one per cell
  }
}

/** A stackable item — one of the kinds that carries a `count`. */
export type StackItem = Extract<Item, { count: number }>;

/** Is this item a stack (does it have a count that can be split/merged)? Narrows the type. */
export function isStackable(item: Item): item is StackItem {
  return item.kind === 'ammo' || item.kind === 'throwable' || item.kind === 'healing';
}

export function countOf(item: Item): number {
  return isStackable(item) ? item.count : 1;
}

// ---------------------------------------------------------------------------------------------
// Constructors — the only place items are built, so a definition change (stack cap, plate value)
// cannot leave a stale literal behind in the default loadout or a test.
// ---------------------------------------------------------------------------------------------
export function createAmmo(ammoId: AmmoId, count: number): Item {
  return { kind: 'ammo', ammoId, count };
}

export function createThrowable(id: ThrowableId, count: number): Item {
  return { kind: 'throwable', id, count };
}

export function createHealing(id: HealingId, count: number): Item {
  return { kind: 'healing', id, count };
}

export function createArmor(id: ArmorId): Item {
  const d = ARMORS[id];
  return { kind: 'armor', id, level: d.level, value: d.value, max: d.value };
}

/** A weapon item with an EMPTY, unprimed magazine (`primed: false` = fill from reserve on equip). */
export function createWeapon(weaponId: string): Item {
  return { kind: 'weapon', weaponId, ammo: 0, primed: false };
}
