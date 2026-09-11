// Armour, penetration and the shared LEVEL COLOUR PALETTE. Pure maths + pure data — no DOM, no
// three, no game.ts — so the whole damage model is asserted in Node (scripts/verify-inventory.mjs)
// exactly like hud.ts / stick.ts / camera.ts.
//
// THE MODEL (user spec, Delta-Force-like, with per-ammo overrides):
//   * ammunition has TWO numbers and armour has one:
//       - `level`       (1..6)  — the round's DISPLAY label (HUD badge, inventory colour). Never
//                                 enters the damage maths (user decision);
//       - `penetration` (0..6)  — what the DEFAULT formulas below are fed. 0 = "cannot pierce at
//                                 all", which is lower than the armour ladder's own 1..6;
//       - armour `level` (1..6) — the plate's protection level.
//   * DEFAULT ARMOUR DAMAGE: a round whose penetration is `p` does 100% armour damage against
//     armour of level <= p. Every level the armour sits ABOVE the round multiplies the armour damage
//     by 0.7 (so +1 = 70%, +2 = 49%, ... +5 = 16.8%). Low-penetration rounds therefore always chip
//     high-level armour, just very slowly — the user picked the multiplicative rule over the
//     additive `1 - 0.3k` one, which would have made a 4-level gap completely immune.
//   * DEFAULT FLESH DAMAGE depends only on the gap between armour level and penetration:
//       armour <= penetration - 2  -> 100%
//       armour == penetration - 1  ->  75%
//       armour == penetration      ->  50%
//       armour  > penetration      ->   0%   (the plate stops the round outright)
//   * PER-AMMO OVERRIDE TABLES (`vsArmor` / `vsFlesh`, one entry per ARMOUR level 1..6) replace the
//     default formula entry by entry. A missing entry, a `null`, or a corrupt value falls back to
//     the default — so a half-written table is still valid and dirty data can never become NaN.
//     This is what lets e.g. the dragon-breath shell be labelled Lv4 while having penetration 0 and
//     an explicit "100% armour damage up to level 4, 80% at 5, 50% at 6" table.
//   * once `value` reaches 0 the plate no longer works: the next hit resolves as unarmoured.
//
// WHY THE SPLIT IS A PURE FUNCTION RETURNING NUMBERS INSTEAD OF MUTATING: the same rule has to run
// for enemies (whose armour lives on the enemy record) and for the player (whose armour lives on
// the inventory item in the armour slot). Returning `armorLeft` and letting the caller commit it
// keeps one implementation of the rule and no shared mutable state to desync.
//
// ARMOUR DAMAGE DOES NOT CARRY OVER: `armorDmg` is capped at the plate's remaining value, and the
// excess is discarded. A plate with 2 points left that eats a 100-damage round does not spill 98
// into flesh — the round is spent on the plate, and the NEXT round finds it broken.
//
// "NO PROFILE" MEANS "IGNORES ARMOUR": `resolveHit` accepts `undefined`/`null` in place of a round
// profile, and that is the path BURN, melee and enemy contact damage take (see game.ts). Burn damage
// being direct flesh is a deliberate rule, not an accident: the dragon-breath shell is a pure
// armour-shredder (0% flesh through any plate), so its DoT is the only flesh damage it deals until
// the plate breaks.

export const LEVEL_MIN = 1;
export const LEVEL_MAX = 6;
/** Penetration may be 0 — lower than the armour ladder, meaning "no piercing ability at all". */
export const PENETRATION_MIN = 0;
export const PENETRATION_MAX = 6;

/** Per-level armour damage multiplier lost for every level the armour is above the round. */
export const ARMOR_DAMAGE_DECAY = 0.7;

export interface ArmorState {
  /** 1..6 */
  level: number;
  /** remaining plate hit points; 0 or less = broken and no longer protects */
  value: number;
  /** starting value, for the HUD bar */
  max: number;
}

/**
 * One round's penetration profile. `ProjectileDef` (and therefore every bullet in flight, and every
 * `onHit` callback) structurally satisfies this, so the damage path can take the projectile itself.
 * A plain number is also accepted everywhere, and is read as `{ level: n, penetration: n }` — that
 * keeps every pre-override call site and test meaningful.
 */
export interface RoundProfile {
  /** 1..6 DISPLAY level: the HUD badge / inventory colour. Not used by the maths. */
  readonly level: number;
  /** 0..6 armour-interaction level fed to the default formulas. Defaults to `level`. */
  readonly penetration?: number;
  /** Optional per-ARMOUR-level armour damage multipliers (index 0 = armour level 1). */
  readonly vsArmor?: readonly (number | null)[];
  /** Optional per-ARMOUR-level flesh damage multipliers (index 0 = armour level 1). */
  readonly vsFlesh?: readonly (number | null)[];
}

export interface HitResult {
  /** armour points actually removed (never more than the plate had) */
  armorDmg: number;
  /** damage actually dealt to HP */
  fleshDmg: number;
  /** plate value after the hit */
  armorLeft: number;
  /** true when THIS hit is the one that took the plate to 0 */
  broke: boolean;
}

/** Clamp any input to a legal level. NaN / Infinity / strings fall back to level 1. */
export function clampLevel(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : LEVEL_MIN;
  return v < LEVEL_MIN ? LEVEL_MIN : v > LEVEL_MAX ? LEVEL_MAX : v;
}

/** Clamp a penetration value to 0..6. Non-finite input falls back to `fallback` (a legal value). */
export function clampPenetration(n: unknown, fallback = PENETRATION_MIN): number {
  const fb = typeof fallback === 'number' && Number.isFinite(fallback) ? fallback : PENETRATION_MIN;
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : fb;
  const c = v < PENETRATION_MIN ? PENETRATION_MIN : v > PENETRATION_MAX ? PENETRATION_MAX : v;
  return c;
}

/** One entry of an override table, or null when it is absent/corrupt and the default must apply. */
export function overrideAt(
  table: readonly (number | null)[] | undefined, armorLevel: number,
): number | null {
  if (!table) return null;
  const entry = table[clampLevel(armorLevel) - LEVEL_MIN];
  return typeof entry === 'number' && Number.isFinite(entry) && entry >= 0 ? entry : null;
}

/** The penetration this round is resolved with: explicit `penetration`, else its display level. */
export function roundPenetration(round: RoundProfile | number): number {
  if (typeof round === 'number') return clampPenetration(round, LEVEL_MIN);
  return clampPenetration(round.penetration, clampLevel(round.level));
}

/** Is this a plate that still works? (missing / broken / corrupt plates all return false) */
export function isArmorActive(armor: ArmorState | null | undefined): armor is ArmorState {
  return !!armor && Number.isFinite(armor.value) && armor.value > 0;
}

/**
 * DEFAULT armour damage multiplier: `penetration` against `armorLevel` armour — 1 at or below the
 * round's penetration, then x0.7 per level of armour ABOVE it. (The second parameter is a
 * PENETRATION level, 0..6, since the override work — it used to be the display level.)
 */
export function armorDamageMul(armorLevel: number, penetration: number): number {
  const diff = clampLevel(armorLevel) - clampPenetration(penetration);
  return diff <= 0 ? 1 : Math.pow(ARMOR_DAMAGE_DECAY, diff);
}

/**
 * DEFAULT flesh damage multiplier: `penetration` against `armorLevel` armour. Note this is
 * deliberately NOT a smooth function of the gap: it only distinguishes "below by one" (75%),
 * "equal" (50%) and "below by two or more" (100%), and above the round's penetration it is a hard
 * 0 — the plate stops the round even if it is only one level better.
 */
export function fleshDamageMul(armorLevel: number, penetration: number): number {
  const a = clampLevel(armorLevel);
  const b = clampPenetration(penetration);
  if (a > b) return 0;
  if (a === b) return 0.5;
  if (a === b - 1) return 0.75;
  return 1;
}

/**
 * Armour damage multiplier this ROUND deals to `armorLevel` armour: the explicit `vsArmor` entry
 * when it is usable, otherwise the default formula with the round's penetration.
 */
export function roundArmorMul(round: RoundProfile | number, armorLevel: number): number {
  const a = clampLevel(armorLevel);
  if (typeof round !== 'number') {
    const override = overrideAt(round.vsArmor, a);
    if (override !== null) return override;
  }
  return armorDamageMul(a, roundPenetration(round));
}

/**
 * Flesh damage multiplier this ROUND deals to `armorLevel` armour: the explicit `vsFlesh` entry when
 * it is usable, otherwise the default formula with the round's penetration (NOT its display level).
 */
export function roundFleshMul(round: RoundProfile | number, armorLevel: number): number {
  const a = clampLevel(armorLevel);
  if (typeof round !== 'number') {
    const override = overrideAt(round.vsFlesh, a);
    if (override !== null) return override;
  }
  return fleshDamageMul(a, roundPenetration(round));
}

/**
 * Resolve one hit against an armour plate. Pure: the caller commits `armor.value = armorLeft`.
 * A null / broken / corrupt plate — or no round profile at all — means the hit lands at full damage
 * with no armour interaction (that last case is the burn / melee / contact-damage path).
 */
export function resolveHit(
  damage: number, round: RoundProfile | number | null | undefined, armor: ArmorState | null,
): HitResult {
  const dmg = Number.isFinite(damage) && damage > 0 ? damage : 0;
  if (!isArmorActive(armor) || round === null || round === undefined) {
    // No plate, a broken plate, a corrupt record, or damage that carries no penetration profile:
    // the hit lands in full. `armorLeft` is reported as 0 so a caller that blindly commits it
    // writes a sane value rather than NaN.
    return { armorDmg: 0, fleshDmg: dmg, armorLeft: 0, broke: false };
  }
  const a = clampLevel(armor.level);
  const rawArmor = dmg * roundArmorMul(round, a);
  const armorDmg = Math.min(armor.value, rawArmor);
  const armorLeft = armor.value - armorDmg;
  return {
    armorDmg,
    fleshDmg: dmg * roundFleshMul(round, a),
    armorLeft: armorLeft < 0 ? 0 : armorLeft,
    broke: armorLeft <= 0,
  };
}

/** A fresh, full plate. `value` defaults to the definition's own value. */
export function makeArmor(level: number, value: number, max = value): ArmorState {
  const lv = clampLevel(level);
  const v = Number.isFinite(value) && value > 0 ? value : 0;
  const m = Number.isFinite(max) && max > 0 ? max : v;
  return { level: lv, value: v, max: m };
}

/** 0..1 for the HUD bar (a broken or corrupt plate reads 0, never NaN). */
export function armorRatio(armor: ArmorState | null | undefined): number {
  if (!armor || !Number.isFinite(armor.value) || !Number.isFinite(armor.max) || armor.max <= 0) return 0;
  const r = armor.value / armor.max;
  return r > 0 ? (r > 1 ? 1 : r) : 0;
}

// ---------------------------------------------------------------------------------------------
// Enemy armour by wave
// ----------------------------------------------------------------------------
// Tuning lives in config.ts as plain data; this function is the pure rule that turns "which wave"
// into "what plate". A profile that has not started yet returns null (no armour at all), which is
// how wave-1 melee enemies stay unarmoured.
export interface ArmorWaveProfile {
  /** first wave this kind wears a plate */
  startWave: number;
  /** plate level on `startWave` */
  levelBase: number;
  /** how many waves each extra level takes */
  levelsPerWaves: number;
  /** plate value at level 1 */
  valueBase: number;
  /** extra value per level */
  valuePerLevel: number;
}

export function armorForWave(wave: number, p: ArmorWaveProfile): ArmorState | null {
  if (!Number.isFinite(wave) || wave < p.startWave) return null;
  const per = p.levelsPerWaves > 0 ? p.levelsPerWaves : 1;
  const steps = Math.floor((wave - p.startWave) / per);
  const level = clampLevel(p.levelBase + steps);
  const value = p.valueBase + p.valuePerLevel * level;
  return makeArmor(level, value);
}

// ---------------------------------------------------------------------------------------------
// THE LEVEL COLOUR PALETTE — the single source of truth for "what colour is level N"
// ---------------------------------------------------------------------------------------------
// 1 white / 2 green / 3 blue / 4 purple / 5 gold / 6 red. Used by the inventory cells, the HUD
// ammo + armour readouts and the enemy armour bar (see armor.barColor / render.ts).
//
// ⚠️ DELIBERATELY NOT USED FOR WORLD PROJECTILE VISUALS. The tracer palettes in projectiles.ts are
// load-bearing for two other rules: (1) the materials are additive and clip at 1.0 per channel, so
// a high-level "gold" tracer would wash out to white while a green one would fight the fire
// palette; (2) hostile magenta is the only cue that a round is incoming. scripts/verify-inventory
// asserts that no ProjectileDef.visual colour matches a level colour, so overriding them stays a
// conscious decision instead of a silent drift.
export const LEVEL_COLORS: readonly string[] = [
  '#ffffff', // 1 白
  '#4caf50', // 2 绿
  '#40c4ff', // 3 蓝
  '#a06bff', // 4 紫
  '#ffc107', // 5 金
  '#ff4a3d', // 6 红
];

/** Level name for the UI (「Lv3」), clamped like every other level entry point. */
export function levelLabel(level: unknown): string {
  return 'Lv' + clampLevel(level);
}

/** CSS colour for a level. Out-of-range / NaN falls back to level 1 (white), never undefined. */
export function levelColorHex(level: unknown): string {
  return LEVEL_COLORS[clampLevel(level) - LEVEL_MIN];
}

/** Numeric 0xRRGGBB form for three.js instance colours / materials. */
export function levelColorInt(level: unknown): number {
  return parseInt(levelColorHex(level).slice(1), 16);
}

/** Neutral colour for items that have no level (healing). Deliberately NOT level-2 green. */
export const NO_LEVEL_COLOR = '#9fb4c7';
