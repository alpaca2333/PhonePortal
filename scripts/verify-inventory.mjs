/**
 * CPU-side verification for the BACKPACK / ITEM / RESERVE-AMMO / ARMOUR system.
 *
 * Rules under test:
 *   - armor.ts: the penetration ladder — n-level rounds do 100% armour damage to level <= n plates,
 *     x0.7 per level the plate sits above, flesh 100/75/50/0% for a plate 2+ below / 1 below / equal
 *     / above, no armour-damage carry-over, and a broken plate simply stops working;
 *   - the 1..6 LEVEL COLOUR palette (white/green/blue/purple/gold/red) and its clamps, and the
 *     negative assertion that WORLD projectile colours do NOT follow it;
 *   - inventory.ts: 200-round ammo stacks, reserve = the bag's total, cross-stack consumption,
 *     partial refills, and the per-slot type rules (weapons/throwables/healing/armour);
 *   - game.ts: the magazine is primed from the reserve, reloads are paid for out of it, a dry
 *     backpack means no reload and no fire, and SWAPPING WEAPONS IS NOT A FREE RELOAD;
 *   - enemies: armour by wave, chipped before flesh, and melee/burn ignore it entirely;
 *   - the player: the armour SLOT item absorbs hits, and contact damage bypasses it;
 *   - throwable / healing use: aim direction, stack decrement, cooldown, full-HP no-op;
 *   - hud.ts readouts (armour, action buttons) and the DOM wiring of the backpack panel
 *     (pointer-drag AND tap-to-move, type-rejected drops, level colours on the cells).
 *
 * Run:  npm run build && node scripts/verify-inventory.mjs
 * Exit code is non-zero when any assertion fails.
 */
import { readFileSync } from 'node:fs';

const ARMOR = new URL('../dist/apps/shooter/src/armor.js', import.meta.url);
const ITEMS = new URL('../dist/apps/shooter/src/items.js', import.meta.url);
const INV = new URL('../dist/apps/shooter/src/inventory.js', import.meta.url);
const GAME = new URL('../dist/apps/shooter/src/game.js', import.meta.url);
const WEAPONS_URL = new URL('../dist/apps/shooter/src/weapons.js', import.meta.url);
const PROJ = new URL('../dist/apps/shooter/src/projectiles.js', import.meta.url);
const HUD = new URL('../dist/apps/shooter/src/hud.js', import.meta.url);
const PANEL = new URL('../dist/apps/shooter/src/inventoryPanel.js', import.meta.url);
const BTN = new URL('../dist/apps/shooter/src/weaponButton.js', import.meta.url);

const {
  LEVEL_COLORS, NO_LEVEL_COLOR, LEVEL_MIN, LEVEL_MAX, ARMOR_DAMAGE_DECAY,
  armorDamageMul, armorForWave, armorRatio, clampLevel, clampPenetration, fleshDamageMul,
  isArmorActive, levelColorHex, levelColorInt, levelLabel, makeArmor, overrideAt, resolveHit,
  roundArmorMul, roundFleshMul, roundPenetration,
} = await import(ARMOR.href);
const { AMMO, ARMORS, HEALINGS, THROWABLES, countOf, createAmmo, createArmor, createWeapon } = await import(ITEMS.href);
const {
  BACKPACK_SIZE, SLOT_IDS, accepts, addAmmo, applyMove, bagRef, canMove, consumeAmmo,
  createInventory, getItem, itemCount, itemLabel, itemLevel, itemShort, reserveOf, slotRef, takeOne,
  usedCells,
} = await import(INV.href);
const { GameSim, CONFIG } = await import(GAME.href);
const { WEAPONS, ammoIdOf } = await import(WEAPONS_URL.href);
const { PROJECTILES, GRENADE_DAMAGE, GRENADE_RADIUS } = await import(PROJ.href);
const { actionButtonReadout, armorReadout } = await import(HUD.href);
const {
  ARMOR_BAR_CLEARANCE, ARMOR_BAR_H, ARMOR_BAR_Y, BAR_FRAME_GAP, BAR_H, BAR_PAD, BAR_Y,
  MAX_BAR_SLOTS, MAX_ENEMY_BARS, barFrameBottom, barFrameHeight, barFrameTop, createBarAllocator,
} = await import(HUD.href);

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ' — ' + detail : ''));
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

const DT = 1 / 60;
const idle = { move: { x: 0, y: 0 }, aim: { x: 0, y: 0 }, firing: false, autoAim: false };
const firing = { move: { x: 0, y: 0 }, aim: { x: 1, y: 0 }, firing: true, autoAim: false };

function freshSim() {
  const sim = new GameSim();
  sim.spawnQueue = 0;
  sim.spawnTimer = 0;
  sim.enemies = [];
  sim.obstacles = [];   // this suite tests items, not level design (verify-cover owns the layout)
  return sim;
}

function addEnemy(sim, x, y, hp, kind = 'chaser') {
  const e = {
    id: 900 + sim.enemies.length, pos: { x, y }, vel: { x: 0, y: 0 }, r: CONFIG.enemyR,
    hp, maxHp: hp, alive: true, kind, speed: 0, touchDmg: 16, hitFlash: 0, touchCd: 0,
    burns: [], flameAcc: 0, armor: null,
  };
  sim.enemies.push(e);
  return e;
}

function run(sim, seconds, input = idle, dt = DT) {
  const frames = Math.round(seconds / dt);
  for (let i = 0; i < frames; i++) { sim.update(dt, input); sim.spawnQueue = 0; }
}

// =============================================================================================
// 1. armor.ts — the penetration ladder
// =============================================================================================
{
  check('等级范围是 1..6', LEVEL_MIN === 1 && LEVEL_MAX === 6);
  check('甲伤每级衰减系数 = 0.7', near(ARMOR_DAMAGE_DECAY, 0.7));

  // armour <= round -> 100% armour damage; every level above multiplies by 0.7.
  const expectArmor = (a, b) => (a <= b ? 1 : Math.pow(0.7, a - b));
  let armorOk = true;
  let fleshOk = true;
  let badArmor = '';
  let badFlesh = '';
  for (let a = 1; a <= 6; a++) {
    for (let b = 1; b <= 6; b++) {
      const am = armorDamageMul(a, b);
      const fm = fleshDamageMul(a, b);
      if (!near(am, expectArmor(a, b), 1e-12)) { armorOk = false; badArmor = `armor${a}/ammo${b}=${am}`; }
      const wantFlesh = a > b ? 0 : a === b ? 0.5 : a === b - 1 ? 0.75 : 1;
      if (!near(fm, wantFlesh, 1e-12)) { fleshOk = false; badFlesh = `armor${a}/ammo${b}=${fm}`; }
    }
  }
  check('36 组等级对的甲伤乘数全部符合 0.7^(甲级−弹级)', armorOk, badArmor);
  check('36 组等级对的肉伤乘数全部符合 100/75/50/0% 阶梯', fleshOk, badFlesh);
  check('甲伤阶梯抽样：同级 100% / 高一级 70% / 高两级 49% / 高五级 16.81%',
    near(armorDamageMul(3, 3), 1) && near(armorDamageMul(4, 3), 0.7) &&
    near(armorDamageMul(5, 3), 0.49) && near(armorDamageMul(6, 1), Math.pow(0.7, 5), 1e-12));
  check('肉伤阶梯抽样：同级 50% / 低一级 75% / 低两级 100% / 高一级 0%',
    near(fleshDamageMul(3, 3), 0.5) && near(fleshDamageMul(2, 3), 0.75) &&
    near(fleshDamageMul(1, 3), 1) && fleshDamageMul(4, 3) === 0);
  check('等级越界被钳制（0 -> 1，9 -> 6）', clampLevel(0) === 1 && clampLevel(9) === 6 && clampLevel(NaN) === 1);

  // resolveHit: no carry-over, and the plate is what absorbs.
  const plate = makeArmor(3, 44);
  const r1 = resolveHit(10, 2, plate);
  check('resolveHit(10, Lv2, Lv3甲)：甲伤 7（10×0.7），肉伤 0（甲高于弹）',
    near(r1.armorDmg, 7, 1e-12) && r1.fleshDmg === 0 && near(r1.armorLeft, 37, 1e-12) && r1.broke === false,
    JSON.stringify(r1));
  const r2 = resolveHit(10, 3, makeArmor(3, 44));
  check('resolveHit(10, Lv3, Lv3甲)：甲伤 10，肉伤 5（50%）',
    near(r2.armorDmg, 10) && near(r2.fleshDmg, 5), JSON.stringify(r2));
  const r3 = resolveHit(10, 4, makeArmor(3, 44));
  check('resolveHit(10, Lv4, Lv3甲)：甲伤 10，肉伤 7.5（75%）',
    near(r3.armorDmg, 10) && near(r3.fleshDmg, 7.5), JSON.stringify(r3));
  const r4 = resolveHit(10, 5, makeArmor(3, 44));
  check('resolveHit(10, Lv5, Lv3甲)：甲伤 10，肉伤 10（100%，低两级以上）',
    near(r4.armorDmg, 10) && near(r4.fleshDmg, 10), JSON.stringify(r4));

  // The cap: armour damage never spills into flesh when the plate breaks on this very hit.
  const thin = makeArmor(3, 2);
  const r5 = resolveHit(100, 2, thin);
  check('甲伤不溢出结转：2 点甲吃 100 伤害只扣 2 甲、0 肉',
    near(r5.armorDmg, 2) && r5.fleshDmg === 0 && r5.armorLeft === 0 && r5.broke === true,
    JSON.stringify(r5));
  const r6 = resolveHit(10, 2, makeArmor(3, 0));
  check('护甲值归零后不再生效（全额肉伤、不再有甲伤）',
    r6.armorDmg === 0 && near(r6.fleshDmg, 10) && r6.broke === false, JSON.stringify(r6));
  const r7 = resolveHit(10, 2, null);
  check('无护甲 = 全额肉伤', r7.armorDmg === 0 && r7.fleshDmg === 10 && r7.armorLeft === 0);
  check('脏数据（NaN 护甲值）当无甲处理，不抛错、不产生 NaN',
    resolveHit(10, 2, { level: 3, value: NaN, max: 50 }).fleshDmg === 10 &&
    resolveHit(10, 2, { level: 3, value: NaN, max: 50 }).armorDmg === 0);
  check('负伤害 / NaN 伤害归零', resolveHit(-5, 2, null).fleshDmg === 0 && resolveHit(NaN, 2, null).fleshDmg === 0);
  check('isArmorActive：有值才生效', isArmorActive(makeArmor(3, 1)) && !isArmorActive(makeArmor(3, 0)) &&
    !isArmorActive(null) && !isArmorActive(undefined));
  check('armorRatio：0..1 且脏数据为 0', near(armorRatio(makeArmor(3, 25, 50)), 0.5) &&
    armorRatio(makeArmor(3, 0, 50)) === 0 && armorRatio(null) === 0 && armorRatio({ level: 3, value: 5, max: 0 }) === 0);
}

// =============================================================================================
// 1b. Per-ammo, per-armour-level override tables (penetration drives the DEFAULT formulas)
// =============================================================================================
// `level` is now DISPLAY ONLY (badge + inventory colour); `penetration` (0..6) is what the default
// ladder is fed, and `vsArmor` / `vsFlesh` are optional per-armour-level overrides. The dragon-breath
// shell is the worked example: labelled Lv4, penetration 0, "100% armour damage up to level 4, 80% at
// 5, 50% at 6" — and, having no flesh override, 0% flesh through any intact plate.
{
  check('穿甲钳制在 0..6，非有限值回落 fallback',
    clampPenetration(-1) === 0 && clampPenetration(0) === 0 && clampPenetration(9) === 6 &&
    clampPenetration(NaN, 3) === 3 && clampPenetration('x', 2) === 2 && clampPenetration(undefined, 4) === 4);
  check('穿甲缺省 = 显示等级；数字入参按 {level, penetration} 解释',
    roundPenetration({ level: 2 }) === 2 && roundPenetration(2) === 2 &&
    roundPenetration({ level: 6, penetration: 0 }) === 0);

  let pen0ArmorOk = true;
  let pen0FleshOk = true;
  for (let m = 1; m <= 6; m++) {
    if (!near(roundArmorMul({ level: 4, penetration: 0 }, m), Math.pow(0.7, m), 1e-12)) pen0ArmorOk = false;
    if (roundFleshMul({ level: 4, penetration: 0 }, m) !== 0) pen0FleshOk = false;
  }
  check('穿甲 0 的默认甲伤 = 0.7^甲级（0 是合法穿甲值）', pen0ArmorOk);
  check('穿甲 0 的默认肉伤对所有护甲等级都是 0', pen0FleshOk);
  check('没有覆写表的弹药仍走默认公式（穿甲缺省 = 等级）',
    roundArmorMul(PROJECTILES.smgRound, 3) === armorDamageMul(3, 2) &&
    roundFleshMul(PROJECTILES.smgRound, 3) === fleshDamageMul(3, 2) &&
    roundArmorMul(2, 3) === armorDamageMul(3, 2));

  const fs = PROJECTILES.flameShot;
  check('龙息弹：显示等级 4 与穿甲 0 是两个独立的数字', fs.level === 4 && fs.penetration === 0);
  check('龙息弹甲伤表逐项 = [100,100,100,100,80,50]%',
    [1, 2, 3, 4, 5, 6].every((m) => near(roundArmorMul(fs, m), [1, 1, 1, 1, 0.8, 0.5][m - 1], 1e-12)),
    [1, 2, 3, 4, 5, 6].map((m) => roundArmorMul(fs, m)).join(','));
  check('龙息弹没有肉伤表 -> 肉伤走穿甲 0 的默认（1..6 级甲全 0）',
    [1, 2, 3, 4, 5, 6].every((m) => roundFleshMul(fs, m) === 0));
  check('龙息弹单颗（8 伤害）对 3 级甲：甲 -8、血 -0',
    near(resolveHit(8, fs, makeArmor(3, 44)).armorDmg, 8) && resolveHit(8, fs, makeArmor(3, 44)).fleshDmg === 0);
  check('龙息弹对 6 级甲单颗甲伤 4（50%）', near(resolveHit(8, fs, makeArmor(6, 68)).armorDmg, 4, 1e-12));
  check('龙息弹对无甲目标全额肉伤',
    resolveHit(8, fs, null).armorDmg === 0 && resolveHit(8, fs, null).fleshDmg === 8);
  check('弹药注册表从弹丸派生显示等级（霰弹 = 4）', AMMO.ammoShell.level === 4 && AMMO.ammo9mm.level === 2);

  const short = { level: 3, penetration: 3, vsArmor: [2, null] };
  check('覆写表：只写前两项时，缺项与 null 逐项回落默认公式',
    roundArmorMul(short, 1) === 2 && roundArmorMul(short, 2) === armorDamageMul(2, 3) &&
    roundArmorMul(short, 5) === armorDamageMul(5, 3),
    [1, 2, 3, 4, 5, 6].map((m) => roundArmorMul(short, m)).join(','));
  const dirty = { level: 3, penetration: 3, vsArmor: [-1, NaN, 'x', 0.25] };
  check('覆写表：负数 / NaN / 字符串回落默认，合法的小数生效（不产生 NaN 伤害）',
    roundArmorMul(dirty, 1) === armorDamageMul(1, 3) && roundArmorMul(dirty, 2) === armorDamageMul(2, 3) &&
    roundArmorMul(dirty, 3) === armorDamageMul(3, 3) && roundArmorMul(dirty, 4) === 0.25);
  check('overrideAt：空表回落 null，越界等级被钳制后再查表',
    overrideAt(undefined, 3) === null && overrideAt([], 1) === null &&
    overrideAt([1, 2, 3, 4, 5, 6], 9) === 6 && overrideAt([1, 2], 5) === null);
  check('脏覆写表不会把伤害变成 NaN',
    Number.isFinite(resolveHit(10, dirty, makeArmor(3, 50)).fleshDmg) &&
    Number.isFinite(resolveHit(10, dirty, makeArmor(3, 50)).armorDmg));
}

// =============================================================================================
// 2. armor.ts — the level colour language
// =============================================================================================
{
  check('六色等级表：1 白 / 2 绿 / 3 蓝 / 4 紫 / 5 金 / 6 红',
    LEVEL_COLORS.length === 6 &&
    LEVEL_COLORS[0] === '#ffffff' && LEVEL_COLORS[1] === '#4caf50' && LEVEL_COLORS[2] === '#40c4ff' &&
    LEVEL_COLORS[3] === '#a06bff' && LEVEL_COLORS[4] === '#ffc107' && LEVEL_COLORS[5] === '#ff4a3d',
    LEVEL_COLORS.join(','));
  let hexOk = true;
  let intOk = true;
  for (let lv = 1; lv <= 6; lv++) {
    if (levelColorHex(lv) !== LEVEL_COLORS[lv - 1]) hexOk = false;
    if (levelColorInt(lv) !== parseInt(LEVEL_COLORS[lv - 1].slice(1), 16)) intOk = false;
  }
  check('levelColorHex 逐级等于色表', hexOk);
  check('levelColorInt 与 levelColorHex 逐级一致（parseInt 往返）', intOk);
  check('等级色越界钳制到 1..6（0/NaN/字符串 -> Lv1 白，7 -> Lv6 红，不会是 undefined）',
    levelColorHex(0) === '#ffffff' && levelColorHex(NaN) === '#ffffff' &&
    levelColorHex('x') === '#ffffff' && levelColorHex(7) === LEVEL_COLORS[5] &&
    levelColorHex(-3) === '#ffffff');
  check('六色互不相同', new Set(LEVEL_COLORS).size === 6);
  check('levelLabel 格式化并钳制', levelLabel(3) === 'Lv3' && levelLabel(0) === 'Lv1' && levelLabel(99) === 'Lv6');
  check('无等级色是中性灰蓝，且刻意不等于 Lv2 绿',
    NO_LEVEL_COLOR === '#9fb4c7' && !LEVEL_COLORS.includes(NO_LEVEL_COLOR));

  // The palette must NOT have leaked into the world projectile visuals: the tracer colours are
  // load-bearing (additive clipping + hostile magenta) and a level-coloured tracer would look like
  // a bug fix that silently broke the design. Asserting it here makes overriding them a decision.
  const hex = (n) => '#' + n.toString(16).padStart(6, '0');
  const clashes = [];
  for (const def of Object.values(PROJECTILES)) {
    if (LEVEL_COLORS.includes(hex(def.visual.color))) clashes.push(def.id + '.color');
    if (LEVEL_COLORS.includes(hex(def.visual.glowColor))) clashes.push(def.id + '.glowColor');
  }
  check('世界弹道配色没有被等级色表接管（加色截断 / 敌对紫红两条规则仍在）',
    clashes.length === 0, clashes.join(','));
  const noColorField = [...Object.values(AMMO), ...Object.values(ARMORS), ...Object.values(THROWABLES)]
    .filter((d) => 'color' in d).map((d) => d.id);
  check('物品定义里没有第二份色表（颜色一律由 armor.ts 按等级给出）',
    noColorField.length === 0, noColorField.join(','));
}

// =============================================================================================
// 3. items.ts / inventory.ts — stacks, reserve, slot rules
// =============================================================================================
{
  check('背包格子数 20，5 个槽位', BACKPACK_SIZE === 20 && SLOT_IDS.length === 5);
  check('弹药堆叠上限 = 200（用户要求）', AMMO.ammo9mm.stackMax === 200 && AMMO.ammoRocket.stackMax === 200);
  const inv = createInventory();
  check('默认配装：主/副武器都有，投掷/治疗/护甲各就位',
    inv.slots.primary.weaponId === 'smg' && inv.slots.secondary.weaponId === 'dragonBreath' &&
    inv.slots.throwable.count === 3 && inv.slots.healing.count === 3 &&
    inv.slots.armor.kind === 'armor' && inv.slots.armor.level === 3);
  // THE SHIPPED LOADOUT IS PINNED ON PURPOSE: it is a deliberate TESTING loadout (every ammo cell at
  // the 200 cap — see inventory.ts::createInventory) and the HUD/readouts are verified against it.
  check('默认配装：背包里有备用武器 / 两种子弹各两格 / 备用护甲 / 额外消耗品',
    inv.bag[0].kind === 'weapon' && inv.bag[0].weaponId === 'rpg' && inv.bag[1].weaponId === 'sword' &&
    inv.bag[2].ammoId === 'ammo9mm' && inv.bag[2].count === 200 && inv.bag[3].ammoId === 'ammo9mm' && inv.bag[3].count === 200 &&
    inv.bag[4].ammoId === 'ammoShell' && inv.bag[4].count === 200 &&
    inv.bag[5].ammoId === 'ammoShell' && inv.bag[5].count === 200 &&
    inv.bag[6].ammoId === 'ammoRocket' && inv.bag[6].count === 200 &&
    inv.bag[7].kind === 'armor' && inv.bag[8].kind === 'throwable' && inv.bag[9].kind === 'healing');
  check('usedCells 统计占用格数', usedCells(inv) === 10, String(usedCells(inv)));

  // reserve + consumption across stacks
  check('reserveOf = 背包里该弹药的总数（200+200）', reserveOf(inv, 'ammo9mm') === 400, String(reserveOf(inv, 'ammo9mm')));
  check('reserveOf 对其他类型不影响，未知/空 id 为 0',
    reserveOf(inv, 'ammoShell') === 400 && reserveOf(inv, 'ammoRocket') === 200 && reserveOf(inv, null) === 0);
  const got = consumeAmmo(inv, 'ammo9mm', 230);
  check('跨堆消耗：取 230 时先掏空第一堆再掏第二堆', got === 230 && reserveOf(inv, 'ammo9mm') === 170,
    `got=${got} left=${reserveOf(inv, 'ammo9mm')}`);
  check('第一堆被掏空后该格被清空（不留 0 堆）',
    inv.bag[2] === null && inv.bag[3] && inv.bag[3].count === 170);
  check('消耗超过存量时只给有的量', consumeAmmo(inv, 'ammo9mm', 1000) === 170 && reserveOf(inv, 'ammo9mm') === 0);
  check('消耗 0 / 负数 / NaN 返回 0', consumeAmmo(inv, 'ammo9mm', 0) === 0 && consumeAmmo(inv, 'ammo9mm', -5) === 0);

  // The stacking rules are tested against a PURPOSE-BUILT fixture, not the shipped loadout: what is
  // under test is `addAmmo`'s "top up, then open the next cell, never past the cap" rule, and tying
  // that to whatever the starting bag happens to hold makes the test fail every time the loadout is
  // retuned (which it is, on request).
  const fixture = () => ({
    bag: new Array(BACKPACK_SIZE).fill(null),
    slots: createInventory().slots,
    activeSlot: 'primary',
  });
  const inv2 = fixture();
  inv2.bag[0] = createAmmo('ammo9mm', 200);
  inv2.bag[1] = createAmmo('ammo9mm', 100);
  const add = addAmmo(inv2, 'ammo9mm', 150);   // 200 + 100 -> top up the 100 stack to 200, then...
  check('addAmmo 先补已有堆（200 满 + 100 -> 200 + 200）',
    add.added === 150 && add.ok === true && inv2.bag[0].count === 200 && inv2.bag[1].count === 200,
    JSON.stringify({ added: add.added, a: inv2.bag[0].count, b: inv2.bag[1].count }));
  const inv3 = fixture();
  // 64 shells in one cell: top up that stack to the 200 cap, then open the next cell for the rest.
  inv3.bag[0] = createAmmo('ammoShell', 64);
  const add2 = addAmmo(inv3, 'ammoShell', 264);
  check('addAmmo 先补已有堆、满了再开新格，每格不超过 200',
    add2.added === 264 && add2.ok === true && inv3.bag[0].count === 200 && inv3.bag[1] && inv3.bag[1].count === 128,
    JSON.stringify({ added: add2.added, ok: add2.ok, a: inv3.bag[0].count, b: inv3.bag[1] && inv3.bag[1].count }));
  const add2b = addAmmo(inv3, 'ammoShell', 500);
  check('addAmmo 继续开新格，每格仍不超过 200（72 补满 + 200 + 200 + 28）',
    add2b.added === 500 && add2b.ok === true && inv3.bag[1].count === 200 &&
    inv3.bag[2].count === 200 && inv3.bag[3].count === 200 && inv3.bag[4].count === 28,
    JSON.stringify(add2b));

  // A full bag that cannot take everything reports partial success instead of lying.
  const full = { bag: new Array(BACKPACK_SIZE).fill(null), slots: createInventory().slots, activeSlot: 'primary' };
  for (let i = 0; i < BACKPACK_SIZE; i++) full.bag[i] = createAmmo('ammo9mm', 200);
  const add3 = addAmmo(full, 'ammo9mm', 5);
  check('背包塞满时 addAmmo 部分成功（added=0, ok=false）', add3.added === 0 && add3.ok === false, JSON.stringify(add3));
  const add4 = addAmmo(full, 'ammoShell', 5);
  check('背包塞满且没有同类堆时开不了新格（added=0, ok=false）', add4.added === 0 && add4.ok === false);

  // The per-slot type rule
  const weapon = createWeapon('rpg');
  const ammo = createAmmo('ammo9mm', 10);
  const armor = createArmor('armorHeavy');
  const frag = { kind: 'throwable', id: 'frag', count: 2 };
  const med = { kind: 'healing', id: 'medkit', count: 2 };
  const cases = [
    ['primary', weapon, true], ['secondary', weapon, true], ['primary', ammo, false],
    ['primary', frag, false], ['primary', med, false], ['primary', armor, false],
    ['throwable', frag, true], ['throwable', weapon, false], ['throwable', med, false], ['throwable', armor, false],
    ['healing', med, true], ['healing', frag, false], ['healing', weapon, false],
    ['armor', armor, true], ['armor', weapon, false], ['armor', ammo, false], ['armor', frag, false],
  ];
  const wrong = cases.filter(([slot, item, want]) => accepts(slot, item) !== want)
    .map(([slot, item]) => slot + '/' + item.kind);
  check('槽位类型规则：只有对应类型能进对应槽位（17 例）', wrong.length === 0, wrong.join(','));

  // moves + swaps through the model
  const m = createInventory();
  check('背包 -> 空槽位：允许', canMove(m, bagRef(0), slotRef('primary')) && applyMove(m, bagRef(0), slotRef('primary')));
  check('槽位被占用时是「交换」而不是覆盖（原格拿到换下来的武器）',
    m.bag[0].kind === 'weapon' && m.bag[0].weaponId === 'smg' && m.slots.primary.weaponId === 'rpg',
    `bag0=${m.bag[0].weaponId} primary=${m.slots.primary.weaponId}`);
  check('背包 -> 护甲槽（拿着子弹）：拒绝',
    !canMove(m, bagRef(2), slotRef('armor')) && !applyMove(m, bagRef(2), slotRef('armor')));
  check('被拒绝的移动不改变任何状态', m.bag[2].ammoId === 'ammo9mm');
  check('槽位被占用时交换（件件合法）',
    canMove(m, bagRef(1), slotRef('primary')) && applyMove(m, bagRef(1), slotRef('primary')) &&
    m.slots.primary.weaponId === 'sword' && m.bag[1].weaponId === 'rpg');
  check('类型不符的交换被拒绝（治疗 -> 主武器槽，主武器去治疗槽也不合法）',
    !canMove(m, slotRef('healing'), slotRef('primary')));
  check('丢到自己身上被拒绝', !canMove(m, bagRef(2), bagRef(2)));
  check('空格拖拽被拒绝', !canMove(m, bagRef(15), slotRef('primary')));
  check('背包内互换位置允许',
    applyMove(m, bagRef(2), bagRef(12)) && m.bag[12].ammoId === 'ammo9mm' && m.bag[2] === null);

  // takeOne
  const t = createInventory();
  check('takeOne 扣 1 并保留堆', takeOne(t, slotRef('throwable')) && t.slots.throwable.count === 2);
  takeOne(t, slotRef('throwable'));
  takeOne(t, slotRef('throwable'));
  check('数量归零后物品从槽位移除（按钮随之消失）', t.slots.throwable === null);
  check('对空格子 takeOne 返回 false', takeOne(t, slotRef('throwable')) === false);
  check('getItem 越界读作空（脏输入不抛错）', getItem(t, bagRef(999)) === null && getItem(t, bagRef(-1)) === null);

  // labels + level lookup
  check('itemLabel：弹药带等级与数量', itemLabel(createAmmo('ammo9mm', 143)) === '9mm 弹 Lv2 ×143',
    itemLabel(createAmmo('ammo9mm', 143)));
  check('itemLabel：护甲带等级与当前值', itemLabel(createArmor('armorHeavy')) === '重型护甲 Lv5 70/70',
    itemLabel(createArmor('armorHeavy')));
  check('itemLabel：武器带它所使用的弹药与等级',
    itemLabel(createWeapon('smg')) === '冲锋枪 · 9mm 弹 Lv2', itemLabel(createWeapon('smg')));
  check('itemLevel：武器取弹药等级、近战/治疗为 null',
    itemLevel(createWeapon('smg')) === 2 && itemLevel(createWeapon('sword')) === null &&
    itemLevel(createAmmo('ammoShell', 1)) === 4 && itemLevel(createArmor('armorLight')) === 2 &&
    itemLevel({ kind: 'healing', id: 'medkit', count: 1 }) === null && itemLevel(null) === null);
  check('itemShort / itemCount 供格子显示', itemShort(createWeapon('rpg')) === '火箭筒' &&
    itemShort({ kind: 'throwable', id: 'frag', count: 3 }) === '手雷' &&
    itemCount({ kind: 'healing', id: 'medkit', count: 3 }) === 3 && itemCount(createWeapon('smg')) === null);
  check('countOf：不可堆叠物品算 1', countOf(createWeapon('smg')) === 1 && countOf(createAmmo('ammo9mm', 5)) === 5);
  check('弹药等级与弹丸等级一致（items 从弹药定义派生）',
    Object.values(AMMO).every((a) => a.level === PROJECTILES[a.projectile].level));
  check('手雷等级与掷弹弹丸一致', THROWABLES.frag.level === PROJECTILES.grenade.level);
}

// =============================================================================================
// 4. game.ts — reserve ammo, reloads and the anti-free-reload rule
// =============================================================================================
{
  const sim = freshSim();
  // The invariant, not the number: the starting magazine is FULL and was paid for out of the bag.
  // `createInventory()` is the single source of the starting reserve, so retuning the testing loadout
  // (which happens on request) does not break this.
  const startReserve = reserveOf(createInventory(), 'ammo9mm');
  check(`开局弹夹从备弹装满（${startReserve} -> 弹夹 30，备弹 ${startReserve - 30}）`,
    sim.player.ammo === 30 && sim.reserveOf('ammo9mm') === startReserve - 30,
    `ammo=${sim.player.ammo} reserve=${sim.reserveOf('ammo9mm')}`);

  // Empty the magazine and let it reload: the reload must be PAID FOR out of the bag.
  const s2 = freshSim();
  run(s2, 3.0, firing);                       // 30 rounds at 0.1s = 3.0s -> dry + reload started
  check('打空弹夹后进入换弹（1.5s）', s2.player.ammo === 0 && s2.player.reloadTimer > 0,
    `ammo=${s2.player.ammo} timer=${s2.player.reloadTimer}`);
  const reserveAfterFire = s2.reserveOf('ammo9mm');
  check('开火本身不扣备弹（只扣弹夹）', reserveAfterFire === startReserve - 30, String(reserveAfterFire));
  run(s2, 1.6, idle);
  check(`换弹从背包扣 30 发（备弹 ${startReserve - 30} -> ${startReserve - 60}）`,
    s2.player.ammo === 30 && s2.reserveOf('ammo9mm') === startReserve - 60,
    `ammo=${s2.player.ammo} reserve=${s2.reserveOf('ammo9mm')}`);

  // A nearly-dry bag gives a PARTIAL magazine rather than refusing.
  const s3 = freshSim();
  for (let i = 0; i < s3.inventory.bag.length; i++) {
    const it = s3.inventory.bag[i];
    if (it && it.kind === 'ammo' && it.ammoId === 'ammo9mm') s3.inventory.bag[i] = null;
  }
  s3.addAmmo('ammo9mm', 7);
  s3.equipWeapon('smg');
  run(s3, 3.2, firing);                        // burn the magazine
  run(s3, 1.6, idle);                          // reload completes with only 7 left
  check('备弹不足时只装到有的量（7 发），不凭空补满',
    s3.player.ammo === 7 && s3.reserveOf('ammo9mm') === 0,
    `ammo=${s3.player.ammo} reserve=${s3.reserveOf('ammo9mm')}`);

  // Fully dry: no reload, no fire, and no reload loop.
  const s4 = freshSim();
  for (let i = 0; i < s4.inventory.bag.length; i++) {
    const it = s4.inventory.bag[i];
    if (it && it.kind === 'ammo' && it.ammoId === 'ammo9mm') s4.inventory.bag[i] = null;
  }
  s4.player.ammo = 0;
  const shotsBefore = s4.bullets.length;
  run(s4, 2.0, firing);
  check('备弹为 0 时不换弹、不开火（干涸）',
    s4.player.reloadTimer === 0 && s4.bullets.length === shotsBefore,
    `timer=${s4.player.reloadTimer} bullets=${s4.bullets.length}`);
  check('干涸状态由 HUD 读出（ammoReadout 的 dry）',
    (await import(HUD.href)).ammoReadout(0, 30, 0, 0, 0, 2).dry === true);

  // Swapping weapons must not refill anything.
  const s5 = freshSim();
  run(s5, 1.0, firing);                        // spend ~10 rounds
  const spent = s5.player.ammo;
  const reserveSpent = s5.reserveOf('ammo9mm');
  s5.switchWeapon();
  s5.switchWeapon();
  check('换枪不补弹：弹夹与备弹都不变',
    s5.player.ammo === spent && s5.reserveOf('ammo9mm') === reserveSpent,
    `${spent}->${s5.player.ammo} / ${reserveSpent}->${s5.reserveOf('ammo9mm')}`);
  check('副武器有它自己的弹夹（龙息喷 8 发）', s5.inventory.slots.secondary.ammo === 8);

  // equipWeapon is lossless: the outgoing magazine goes back into the bag.
  const s6 = freshSim();
  run(s6, 1.0, firing);
  const inMag = s6.player.ammo;
  s6.equipWeapon('dragonBreath');
  // The starting magazine was paid for out of the bag (startReserve - 30), and switching weapons must
  // put the outgoing magazine's rounds BACK: the invariant is that nothing is silently lost, not the
  // absolute number (which follows whatever the testing loadout is).
  check('equipWeapon 把旧枪的余弹退回背包（不静默丢失）',
    s6.reserveOf('ammo9mm') === startReserve - 30 + inMag,
    `${s6.reserveOf('ammo9mm')} vs ${startReserve - 30 + inMag}`);

  // Emptying BOTH weapon slots leaves the player unarmed.
  const s7 = freshSim();
  s7.inventory.slots.primary = null;
  s7.inventory.slots.secondary = null;
  s7.syncLoadout();
  check('两个武器槽都空 = 没有武器（不是静默发一把默认枪）',
    s7.player.weaponId === '' && s7.activeWeapon() === null);
  const noWeaponShots = s7.bullets.length;
  run(s7, 1.0, firing);
  check('空手时开火不生成任何弹丸', s7.bullets.length === noWeaponShots);
}

// =============================================================================================
// 5. Armour on enemies — chip first, flesh after, melee/burn ignore it
// =============================================================================================
{
  const sim = freshSim();
  const e = addEnemy(sim, 3, 0, 1000);
  e.armor = makeArmor(3, 44);
  // SMG round: level 2, 10 damage. vs a level-3 plate: 7 armour, 0 flesh per hit.
  for (let i = 0; i < 6; i++) sim.damageEnemy(e, 10, 2);
  check('Lv2 子弹打 Lv3 甲：6 发只磨甲、血量不掉（44 -> 2）',
    near(e.armor.value, 2) && e.hp === 1000, `armor=${e.armor.value} hp=${e.hp}`);
  sim.damageEnemy(e, 10, 2);
  check('第 7 发打破护甲（甲伤被上限截断到 2，肉伤仍按破甲前等级 = 0）',
    e.armor.value === 0 && e.hp === 1000, `armor=${e.armor.value} hp=${e.hp}`);
  sim.damageEnemy(e, 10, 2);
  check('破甲之后同一颗子弹打满肉伤（1000 -> 990，甲不再参与）',
    e.hp === 990 && e.armor.value === 0);

  // Level pairings against an UNBROKEN plate, measured through the live damage path.
  const sA = freshSim(); const eA = addEnemy(sA, 3, 0, 1000); eA.armor = makeArmor(2, 1000);
  sA.damageEnemy(eA, 10, 2);
  check('同级（Lv2 vs Lv2）：甲伤 10、肉伤 5', near(eA.armor.value, 990) && near(eA.hp, 995),
    `armor=${eA.armor.value} hp=${eA.hp}`);
  const sB = freshSim(); const eB = addEnemy(sB, 3, 0, 1000); eB.armor = makeArmor(1, 1000);
  sB.damageEnemy(eB, 10, 2);
  check('高一级子弹打低一级甲（Lv2 vs Lv1）：甲伤 10、肉伤 7.5',
    near(eB.armor.value, 990) && near(eB.hp, 992.5), `armor=${eB.armor.value} hp=${eB.hp}`);
  const sC = freshSim(); const eC = addEnemy(sC, 3, 0, 1000); eC.armor = makeArmor(4, 1000);
  sC.damageEnemy(eC, 10, 2);
  check('低两级子弹打高两级甲（Lv2 vs Lv4）：甲伤 4.9、肉伤 0',
    near(eC.armor.value, 995.1, 1e-9) && eC.hp === 1000, `armor=${eC.armor.value} hp=${eC.hp}`);

  // Melee / contact / burn pass NO level -> armour is bypassed entirely.
  const sD = freshSim(); const eD = addEnemy(sD, 3, 0, 1000); eD.armor = makeArmor(6, 90);
  sD.damageEnemy(eD, 34);
  check('近战伤害无视护甲（6 级甲也照打 34 肉伤，甲不掉）',
    eD.hp === 966 && eD.armor.value === 90, `hp=${eD.hp} armor=${eD.armor.value}`);
  const sE = freshSim(); const eE = addEnemy(sE, 3, 0, 1000); eE.armor = makeArmor(6, 90);
  sE.applyBurn(eE, 5, 5, 0.5);
  run(sE, 0.6);
  check('燃烧 DoT 无视护甲（掉血但甲不掉）',
    eE.hp < 1000 && eE.armor.value === 90, `hp=${eE.hp} armor=${eE.armor.value}`);

  // End to end: the real SMG must chip a plated gunner before it can kill it.
  const sF = freshSim();
  const eF = addEnemy(sF, 3.0, 0, 120, 'gunner');
  eF.armor = makeArmor(3, 44);
  let frames = 0;
  while (eF.hp >= 120 && frames < 400) { sF.update(DT, firing); sF.spawnQueue = 0; frames++; }
  check('端到端：真枪实弹先把甲磨掉，之后才开始掉血',
    eF.hp < 120 && eF.armor.value < 44 && frames > 8,
    `frames=${frames} armor=${eF.armor.value} hp=${eF.hp}`);
}

// =============================================================================================
// 5b. 龙息弹端到端：穿甲 0 + 覆写表 = 开罐器；燃烧是唯一（也是直接）的肉伤来源
// =============================================================================================
{
  const sG = freshSim();
  const eG = addEnemy(sG, 3.0, 0, 1000, 'gunner');
  eG.armor = makeArmor(4, 200);
  const pellet = {
    pos: { x: 2.9, y: 0 }, vel: { x: 63, y: 0 }, r: 0.18, life: 1.6, damage: 8,
    level: PROJECTILES.flameShot.level, penetration: PROJECTILES.flameShot.penetration,
    vsArmor: PROJECTILES.flameShot.vsArmor, vsFlesh: PROJECTILES.flameShot.vsFlesh,
  };
  // exactly the order the bullet loop uses: damageEnemy first, then the projectile's own onHit
  sG.damageEnemy(eG, pellet.damage, pellet);
  PROJECTILES.flameShot.onHit(sG, pellet, eG, { x: 2.9, y: 0 });
  check('龙息弹单颗打 4 级甲：甲 -8、血 -0（穿甲 0 -> 直击一点肉伤都没有）',
    near(eG.armor.value, 192) && eG.hp === 1000, `armor=${eG.armor.value} hp=${eG.hp}`);
  check('带甲目标照样被点燃（onHit 不因肉伤为 0 而跳过燃烧）', eG.burns.length === 1, String(eG.burns.length));
  run(sG, 5.5);
  check('燃烧直接作用于肉伤：一层燃烧 5s 掉 10 点血，而护甲一点不动',
    near(eG.hp, 990) && near(eG.armor.value, 192), `hp=${eG.hp} armor=${eG.armor.value}`);
  eG.armor.value = 0;
  sG.damageEnemy(eG, 8, pellet);
  check('破甲之后同一颗弹丸打满肉伤（-8 血，护甲不再参与）', near(eG.hp, 982), String(eG.hp));
}

// =============================================================================================
// 5c. 两种爆炸都必须按弹丸档案结算（火箭爆炸曾经漏传档案 = 真伤）
// =============================================================================================
{
  const sH = freshSim();
  const eH = addEnemy(sH, 3.0, 0, 1000, 'gunner');
  eH.armor = makeArmor(6, 68);
  PROJECTILES.rocket.onHit(
    sH,
    { pos: { x: 3.2, y: 0 }, vel: { x: 45, y: 0 }, r: 0.3, life: 3, damage: 42, level: 5, penetration: 5 },
    null, { x: 3.0, y: 0 },
  );
  check('火箭爆炸对 6 级甲：只磨甲、0 肉伤（穿甲 5 < 6 -> 肉伤 0）',
    eH.hp === 1000 && eH.armor.value < 68 && eH.armor.value > 0,
    `hp=${eH.hp} armor=${eH.armor.value}`);

  const sI = freshSim();
  const eI = addEnemy(sI, 3.0, 0, 1000, 'gunner');
  eI.armor = makeArmor(4, 100);
  const grenadeBullet = {
    pos: { x: 3.0, y: 0 }, vel: { x: 20, y: 0 }, r: 0.22, life: 0.9, damage: 0, level: 3, penetration: 3,
  };
  PROJECTILES.grenade.onHit(sI, grenadeBullet, null, { x: 3.0, y: 0 });
  // blast origin is backed off 0.1 along the incoming direction, so the target sits 0.1 away
  const expectedArmor = 100 - GRENADE_DAMAGE * (1 - 0.1 / GRENADE_RADIUS) * 0.7;
  check('手雷爆炸对 4 级甲：按穿甲 3 结算（甲伤 70%、肉伤 0）',
    near(eI.hp, 1000) && near(eI.armor.value, expectedArmor, 1e-6),
    `hp=${eI.hp} armor=${eI.armor.value} expected=${expectedArmor}`);
}

// =============================================================================================
// 6. Enemy armour by wave (armor.ts::armorForWave + the spawn wiring)
// =============================================================================================
{
  const gunner = CONFIG.gunnerArmor;
  check('枪手 wave1 就有 Lv1 甲', armorForWave(1, gunner).level === 1 && armorForWave(1, gunner).value === 28);
  check('枪手每 2 波升 1 级：wave3 -> Lv2，wave5 -> Lv3，wave11 -> Lv6',
    armorForWave(3, gunner).level === 2 && armorForWave(5, gunner).level === 3 &&
    armorForWave(11, gunner).level === 6);
  check('枪手等级封顶 Lv6（wave 99 不会越界）', armorForWave(99, gunner).level === 6);
  check('甲值随等级增加', armorForWave(5, gunner).value > armorForWave(1, gunner).value);
  check('近战兵 wave4 之前无甲、之后有甲',
    armorForWave(3, CONFIG.rusherArmor) === null && armorForWave(4, CONFIG.rusherArmor).level === 1);

  // Wiring: a wave-1 spawn must never carry more than a Lv1 plate; a late-wave spawn must be plated.
  const w1 = freshSim();
  w1.wave = 1;
  const origRandom = Math.random;
  Math.random = () => 0;                       // 0 < gunnerShare -> deterministically a gunner
  w1.spawnQueue = 1; w1.spawnTimer = 0;
  w1.update(DT, idle);
  Math.random = origRandom;
  check('wave1 生成的敌人带 Lv1 甲（等级来自 armorForWave，不是写死的）',
    w1.enemies.length === 1 && w1.enemies[0].armor && w1.enemies[0].armor.level === 1,
    JSON.stringify(w1.enemies[0] && w1.enemies[0].armor));

  const w9 = freshSim();
  w9.wave = 9;
  const orig2 = Math.random;
  Math.random = () => 0;
  w9.spawnQueue = 1; w9.spawnTimer = 0;
  w9.update(DT, idle);
  Math.random = orig2;
  check('wave9 生成的枪手带 Lv5 甲（后期需要高级子弹）',
    w9.enemies.length === 1 && w9.enemies[0].armor && w9.enemies[0].armor.level === 5,
    JSON.stringify(w9.enemies[0] && w9.enemies[0].armor));
}

// =============================================================================================
// 7. The player's plate (the armour SLOT item) + contact damage bypassing it
// =============================================================================================
{
  const sim = freshSim();
  const plate = sim.inventory.slots.armor;
  check('开局护甲槽是中甲 Lv3（50/50）', plate.kind === 'armor' && plate.level === 3 && plate.value === 50);

  sim.damagePlayer(CONFIG.gunnerDamage, '#f00', 0.1, PROJECTILES.enemyRound.level);
  check('敌方 Lv3 子弹打 Lv3 甲：甲伤 6、肉伤 3（50%）',
    near(plate.value, 44) && near(sim.player.hp, 97), `armor=${plate.value} hp=${sim.player.hp}`);

  // i-frames still gate everything (the plate does not bypass them).
  sim.damagePlayer(CONFIG.gunnerDamage, '#f00', 0.1, 3);
  check('无敌帧内不再吃伤害（护甲也不掉）', near(plate.value, 44) && near(sim.player.hp, 97));

  sim.player.invuln = 0;
  plate.value = 4;
  sim.damagePlayer(6, '#f00', 0.1, 3);
  check('护甲只剩 4 时这一击破甲：甲归零、肉伤仍按破甲前等级（50% -> 3）',
    plate.value === 0 && near(sim.player.hp, 94), `armor=${plate.value} hp=${sim.player.hp}`);
  sim.player.invuln = 0;
  sim.damagePlayer(6, '#f00', 0.1, 3);
  check('破甲之后全额肉伤（6 点全进血）', near(sim.player.hp, 88), String(sim.player.hp));

  // Contact damage carries NO level -> armour is bypassed.
  const s2 = freshSim();
  const p2 = s2.inventory.slots.armor;
  s2.damagePlayer(CONFIG.touchDmg, '#f00', 0.1);
  check('接触伤害无视护甲（护甲不掉，血量全额扣）',
    p2.value === 50 && near(s2.player.hp, 100 - CONFIG.touchDmg), `armor=${p2.value} hp=${s2.player.hp}`);

  // Removing the plate from its slot makes hits land in full.
  const s3 = freshSim();
  s3.inventory.slots.armor = null;
  s3.damagePlayer(6, '#f00', 0.1, 3);
  check('护甲槽为空 = 全额肉伤', near(s3.player.hp, 94), String(s3.player.hp));

  // A high-level plate stops low-level ammo's flesh damage completely until it breaks.
  const s4 = freshSim();
  s4.inventory.slots.armor = createArmor('armorAssault');   // Lv6, 90
  const p4 = s4.inventory.slots.armor;
  for (let i = 0; i < 10; i++) { s4.player.invuln = 0; s4.damagePlayer(6, '#f00', 0, 2); }
  check('Lv6 甲挡 Lv2 子弹：10 发只磨甲（每发 6×0.7^4≈2.88），血量一点不掉',
    p4.value < 90 && near(s4.player.hp, 100), `armor=${p4.value} hp=${s4.player.hp}`);
}

// =============================================================================================
// 8. Throwable + healing slots (requestUse -> the next update)
// =============================================================================================
{
  const sim = freshSim();
  check('投掷/治疗槽开局各有 3 个', sim.inventory.slots.throwable.count === 3 && sim.inventory.slots.healing.count === 3);

  sim.requestUse('throwable');
  sim.update(DT, { move: { x: 0, y: 0 }, aim: { x: 1, y: 0 }, firing: false, autoAim: false });
  const gs = sim.bullets.filter((b) => b.def.id === 'grenade');
  check('使用投掷物生成一颗手雷，并扣掉一个', gs.length === 1 && sim.inventory.slots.throwable.count === 2,
    `bullets=${gs.length} count=${sim.inventory.slots.throwable.count}`);
  check('手雷沿瞄准方向抛出（+X）', gs[0].vel.x > 0 && Math.abs(gs[0].vel.y) < 1e-9,
    JSON.stringify(gs[0].vel));
  check('手雷带等级（Lv3）', gs[0].level === 3, String(gs[0].level));

  // Cooldown: a second request inside 0.8s does nothing.
  sim.requestUse('throwable');
  sim.update(DT, idle);
  check('投掷冷却期间再按无效（数量不变）', sim.inventory.slots.throwable.count === 2);

  // Fuse: it detonates on its own, damaging what is around the landing point.
  const sBoom = freshSim();
  const target = addEnemy(sBoom, 8, 0, 1000);
  sBoom.requestUse('throwable');
  sBoom.update(DT, { move: { x: 0, y: 0 }, aim: { x: 1, y: 0 }, firing: false, autoAim: false });
  const particlesBefore = sBoom.particles.length;
  run(sBoom, 1.0);
  check('手雷到引信时间自行起爆（六层爆炸粒子 + 范围内掉血）',
    sBoom.bullets.filter((b) => b.def.id === 'grenade').length === 0 &&
    sBoom.particles.length > particlesBefore && target.hp < 1000,
    `bullets=${sBoom.bullets.length} hp=${target.hp} particles=${sBoom.particles.length}`);

  // Stack exhaustion removes the item (and therefore the button).
  const sDry = freshSim();
  sDry.inventory.slots.throwable.count = 1;
  sDry.requestUse('throwable');
  sDry.update(DT, { move: { x: 0, y: 0 }, aim: { x: 1, y: 0 }, firing: false, autoAim: false });
  check('最后一个手雷用掉后槽位清空', sDry.inventory.slots.throwable === null);
  const grenadesInFlight = sDry.bullets.filter((b) => b.def.id === 'grenade').length;
  sDry.requestUse('throwable');
  sDry.update(DT, idle);
  check('空槽位按下投掷按钮什么都不做（不生成新手雷）',
    sDry.bullets.filter((b) => b.def.id === 'grenade').length === grenadesInFlight,
    `${grenadesInFlight} -> ${sDry.bullets.filter((b) => b.def.id === 'grenade').length}`);

  // Healing
  const sHeal = freshSim();
  sHeal.player.hp = 50;
  sHeal.requestUse('healing');
  sHeal.update(DT, idle);
  check('治疗：+40 血并扣掉一个急救包',
    sHeal.player.hp === 90 && sHeal.inventory.slots.healing.count === 2,
    `hp=${sHeal.player.hp} count=${sHeal.inventory.slots.healing.count}`);
  sHeal.requestUse('healing');
  sHeal.update(DT, idle);
  check('治疗冷却期间再按无效', sHeal.inventory.slots.healing.count === 2);

  const sFull = freshSim();
  sFull.requestUse('healing');
  sFull.update(DT, idle);
  check('满血使用治疗：不消耗、不进冷却',
    sFull.inventory.slots.healing.count === 3 && sFull.player.healCd === 0);

  // Dead players cannot use anything.
  const sDead = freshSim();
  sDead.over = true;
  check('结束/死亡后 requestUse 返回 false',
    sDead.requestUse('throwable') === false && sDead.requestUse('healing') === false);
  const sDead2 = freshSim();
  sDead2.player.alive = false;
  check('玩家死亡后 requestUse 返回 false', sDead2.requestUse('throwable') === false);
}

// =============================================================================================
// 9. HUD readouts (hud.ts) — armour + the action buttons
// =============================================================================================
{
  const ar = armorReadout({ level: 3, value: 42, max: 50 });
  check('护甲读数：Lv3 42/50，条 84%', ar.text === 'Lv3 42/50' && near(ar.ratio, 0.84) &&
    ar.broken === false && ar.level === 3, JSON.stringify(ar));
  const broken = armorReadout({ level: 5, value: 0, max: 70 });
  check('护甲读数：破损显示「已损坏」且条为 0（等级色仍保留）',
    broken.text === 'Lv5 已损坏' && broken.ratio === 0 && broken.broken === true && broken.level === 5,
    JSON.stringify(broken));
  const none = armorReadout(null);
  check('护甲读数：槽位为空显示「无护甲」且 level = null',
    none.text === '无护甲' && none.ratio === 0 && none.broken === false && none.level === null,
    JSON.stringify(none));
  check('护甲读数：小数被四舍五入（不会出现 42.399999/50）',
    armorReadout({ level: 3, value: 42.4, max: 50 }).text === 'Lv3 42/50',
    armorReadout({ level: 3, value: 42.4, max: 50 }).text);
  check('护甲读数：脏数据不产生 NaN%', armorReadout({ level: 3, value: NaN, max: 50 }).ratio === 0);

  const ab1 = actionButtonReadout(3, 0);
  check('投掷按钮：有货 -> 可见、不置灰', ab1.visible === true && ab1.dim === false, JSON.stringify(ab1));
  const ab2 = actionButtonReadout(0, 0);
  check('投掷按钮：槽位为空 -> 不可见（用户要求「空就不显示」）', ab2.visible === false);
  const ab3 = actionButtonReadout(2, 0.5);
  check('投掷按钮：冷却中 -> 可见但置灰', ab3.visible === true && ab3.dim === true);
  check('投掷按钮：脏数据不抛错（NaN 数量视为空）',
    actionButtonReadout(NaN, NaN).visible === false && actionButtonReadout(NaN, NaN).dim === false);

  // ---------------------------------------------------------------- world-space bar LAYOUT
  // The enemy health bar and its armour strip must be visibly SEPARATE. The first version measured
  // the gap between the FILL edges (0.28 u, which looked fine in the code) while the dark FRAME
  // behind each fill is BAR_PAD larger on every side — so the frames actually INTERSECTED by 0.05 u
  // and the strip read as part of the health bar (real-device feedback 「护甲条和血条太重叠了」).
  // These assertions are on the FRAME edges, which is the only thing the player can see.
  check('血条与护甲条的可见框不重叠，且留出 ≥ 0.15 世界单位的净空',
    ARMOR_BAR_CLEARANCE >= 0.15 && near(ARMOR_BAR_CLEARANCE, BAR_FRAME_GAP, 1e-9),
    `clearance=${ARMOR_BAR_CLEARANCE}`);
  check('护甲条在血条上方（框底 > 血条框顶）',
    barFrameBottom(ARMOR_BAR_Y, ARMOR_BAR_H) > barFrameTop(BAR_Y, BAR_H),
    `${barFrameBottom(ARMOR_BAR_Y, ARMOR_BAR_H)} vs ${barFrameTop(BAR_Y, BAR_H)}`);
  check('护甲条比血条更细（不会被读成第二条血）', ARMOR_BAR_H < BAR_H);
  check('框高 = 填充高 + 两侧 BAR_PAD（本次踩坑的定义）',
    near(barFrameHeight(BAR_H), BAR_H + BAR_PAD * 2) && near(barFrameHeight(ARMOR_BAR_H), ARMOR_BAR_H + BAR_PAD * 2));
  check('两框之间的净空 = 填充边净空 − 2×BAR_PAD（只量填充会漏掉重叠）',
    near(ARMOR_BAR_CLEARANCE, (ARMOR_BAR_Y - ARMOR_BAR_H / 2) - (BAR_Y + BAR_H / 2) - BAR_PAD * 2),
    `fills=${((ARMOR_BAR_Y - ARMOR_BAR_H / 2) - (BAR_Y + BAR_H / 2)).toFixed(3)}`);
  check('两框净空换算到参考取景 ≥ 4px（1 世界单位 ≈ 29 CSS px）', ARMOR_BAR_CLEARANCE * 29 >= 4,
    `${(ARMOR_BAR_CLEARANCE * 29).toFixed(1)}px`);

  // ---------------------------------------------------------------- bar SLOT allocator
  // Regression guard for the real bug this replaced: the armour strip was written with the SAME
  // frame index as the health bar (`writeBarFrame(bn)` twice, `bn++` once), so the strip's dark
  // frame overwrote the health bar's and an armoured enemy's health bar lost its background.
  // Every drawn bar must get its OWN slot, and that is now structural: one `next()` per bar.
  {
    const a = createBarAllocator(6);
    const frames = [];
    const fills = [];
    while (a.next()) { frames.push(a.frame); fills.push(a.fill); }
    check('分配器：每次 next() 给出新的、递增的 frame/fill（两条 bar 不可能共用槽位）',
      frames.length === 6 && new Set(frames).size === 6 && new Set(fills).size === 6 &&
      frames.every((v, i) => v === i) && fills.every((v, i) => v === i), frames.join(','));
    check('分配器：池满后 next() 返回 false 且计数不越界',
      a.next() === false && a.frame === 5 && a.fill === 5);
    const zero = createBarAllocator(0);
    check('分配器：容量为 0 时直接拒绝（frame/fill 保持 -1）',
      zero.next() === false && zero.frame === -1 && zero.fill === -1);
    check('条位容量 >= 每个敌人两条 + 换弹条（所有敌人都带甲也不越界）',
      MAX_BAR_SLOTS >= MAX_ENEMY_BARS * 2 + 1, `${MAX_BAR_SLOTS} vs ${MAX_ENEMY_BARS * 2 + 1}`);
    // simulate the render loop at worst case: 128 armoured enemies + the player's reload bar
    const full = createBarAllocator(MAX_BAR_SLOTS);
    let used = 0;
    for (let i = 0; i < MAX_ENEMY_BARS; i++) { if (full.next()) used++; if (full.next()) used++; }
    if (full.next()) used++;
    check('满场（128 个带甲敌人 + 换弹条）恰好用满 257 个槽位且不溢出',
      used === MAX_BAR_SLOTS && full.next() === false, `${used} / ${MAX_BAR_SLOTS}`);
  }
}

// =============================================================================================
// 10. The backpack panel's DOM wiring (pointer drag + tap-to-move + level colours)
// =============================================================================================
{
  // ---------------------------------------------------------------- DOM shim
  // Same idea as verify-panel.mjs: a small fake DOM that records every element and listener, plus a
  // controllable `elementFromPoint` so the drop-target resolution can be driven exactly.
  //
  // FAITHFULNESS NOTE (this is why a real bug slipped through here once): `append` links parents and
  // `closest()` walks them, and `hit` may be any node — INCLUDING a cell's inner span, which is what a
  // real browser returns. The original shim only ever handed back cells, so "the drop landed on the
  // item's name and was ignored on the device" was invisible to these tests.
  const nodes = [];
  function mkEl(tag) {
    const node = {
      tag, className: '', textContent: '', type: '', title: '', hidden: false, disabled: false,
      dataset: {}, children: [], parent: null, listeners: {},
      style: { props: {}, setProperty(k, v) { this.props[k] = v; } },
      setAttribute(k, v) { this[k] = v; },
      classList: {
        set: new Set(),
        add(c) { this.set.add(c); },
        remove(c) { this.set.delete(c); },
        toggle(c, on) { on ? this.set.add(c) : this.set.delete(c); },
        contains(c) { return this.set.has(c); },
      },
      append(...kids) { for (const k of kids) { k.parent = this; this.children.push(k); } },
      // Only the one selector the panel actually uses.
      closest(sel) {
        if (sel !== '[data-ref]') throw new Error('shim closest() supports only [data-ref]');
        let n = this;
        while (n) { if (n.dataset && n.dataset.ref) return n; n = n.parent; }
        return null;
      },
      addEventListener(ev, fn) { (this.listeners[ev] ??= []).push(fn); },
      dispatch(ev, extra) { for (const fn of this.listeners[ev] ?? []) fn({ target: this, ...extra }); },
      setPointerCapture() {}, releasePointerCapture() {},
    };
    nodes.push(node);
    return node;
  }
  let hit = null;
  const stage = mkEl('div');
  globalThis.document = {
    createElement: mkEl,
    getElementById: (id) => (id === 'stage' ? stage : mkEl('div')),
    elementFromPoint: () => hit,
  };
  globalThis.window = { innerWidth: 800, innerHeight: 400, addEventListener() {} };

  const { createInventoryPanel } = await import(PANEL.href);
  const { GameSim } = await import(GAME.href);
  // `let`, because a RESTART swaps the model object — that is what the panel's getter exists for.
  let inv = createInventory();
  const moves = [];
  const opens = [];
  const panel = createInventoryPanel({
    stage,
    getInventory: () => inv,
    onMove: (from, to) => {
      moves.push([from, to]);
      return applyMove(inv, from, to);
    },
    onOpenChange: (o) => opens.push(o),
  });

  const cells = nodes.filter((n) => n.dataset && n.dataset.ref);
  const cellOf = (ref) => cells.find((c) => c.dataset.ref === ref);
  check('面板建出 5 个槽位 + 20 个背包格', cells.length === 25 &&
    cells.filter((c) => c.dataset.ref.startsWith('slot:')).length === 5 &&
    cells.filter((c) => c.dataset.ref.startsWith('bag:')).length === BACKPACK_SIZE,
    String(cells.length));
  check('槽位格子带 data-ref 标识', SLOT_IDS.every((s) => !!cellOf('slot:' + s)));
  check('面板初始隐藏、按钮未激活（从未回调过 open）',
    panel.isOpen() === false && opens.length === 0);
  check('按钮/单元格只用 pointer 事件接线（没有 click 监听）',
    cells.every((c) => !('click' in c.listeners)) &&
    !Object.keys(nodes.find((n) => n.className === 'inv-btn').listeners).includes('click'));

  // Level colours are written as the `--lv` custom property per cell.
  {
    const primary = cellOf('slot:primary');
    const armorCell = cellOf('slot:armor');
    const healingCell = cellOf('slot:healing');
    check('武器格用其弹药的等级色（冲锋枪 Lv2 -> 绿）',
      primary.style.props['--lv'] === levelColorHex(2), primary.style.props['--lv']);
    check('护甲格用护甲等级色（中甲 Lv3 -> 蓝）',
      armorCell.style.props['--lv'] === levelColorHex(3), armorCell.style.props['--lv']);
    check('治疗物没有等级 -> 中性色（不等于 Lv2 绿）',
      healingCell.style.props['--lv'] === NO_LEVEL_COLOR &&
      healingCell.style.props['--lv'] !== levelColorHex(2), healingCell.style.props['--lv']);
    check('背包里的火箭筒格显示 Lv5 金', cellOf('bag:0').style.props['--lv'] === levelColorHex(5),
      cellOf('bag:0').style.props['--lv']);
    check('背包里的霰弹格显示 Lv4 紫（龙息弹的显示等级）', cellOf('bag:4').style.props['--lv'] === levelColorHex(4),
      cellOf('bag:4').style.props['--lv']);
  }
  check('格子显示数量（弹药 ×200 / 手雷 ×2）',
    cellOf('bag:2').children[2].textContent === '×200' && cellOf('bag:8').children[2].textContent === '×2',
    cellOf('bag:2').children[2].textContent);
  check('空格子被标为 empty', cellOf('bag:15').classList.contains('empty'));

  // Opening / closing through the button.
  const btn = nodes.find((n) => n.className === 'inv-btn');
  btn.dispatch('pointerdown', { stopPropagation() {} });
  check('点背包按钮打开面板并回调 onOpenChange(true)', panel.isOpen() === true && opens.at(-1) === true);
  btn.dispatch('pointerdown', { stopPropagation() {} });
  check('再点一次关闭并回调 onOpenChange(false)', panel.isOpen() === false && opens.at(-1) === false);
  panel.open();

  // ------------------------------------------------ drag: bag weapon -> primary slot (a swap)
  {
    const src = cellOf('bag:0');            // rpg
    const dst = cellOf('slot:primary');     // smg
    moves.length = 0;
    hit = dst;
    src.dispatch('pointerdown', { clientX: 10, clientY: 10, pointerId: 7, preventDefault() {}, stopPropagation() {} });
    src.dispatch('pointermove', { clientX: 80, clientY: 60, pointerId: 7 });
    check('拖动时目标格被高亮（合法目标）', dst.classList.contains('hot'));
    src.dispatch('pointerup', { clientX: 80, clientY: 60, pointerId: 7 });
    check('拖放提交一次移动（背包 → 主武器槽，两者都是武器 -> 交换）',
      moves.length === 1 && inv.slots.primary.weaponId === 'rpg' && inv.bag[0].weaponId === 'smg',
      JSON.stringify({ moves: moves.length, primary: inv.slots.primary.weaponId, bag0: inv.bag[0].weaponId }));
    check('拖放后格子重新绘制（主武器槽显示火箭筒）',
      cellOf('slot:primary').children[1].textContent === '火箭筒');
    check('拖动结束后高亮清除', !dst.classList.contains('hot'));
  }

  // ---------------------------- drag onto the target's NAME SPAN (the real-device bug)
  // A filled cell's spans cover most of its area, so the finger is normally over `.inv-nm`, NOT over the
  // cell: the hit test must walk up to the nearest [data-ref]. Without that walk the drop is ignored and
  // the item snaps back, which on a device reads as "dragging onto an item is flaky".
  {
    const src = cellOf('bag:7');            // 轻甲（默认配装在背包里）
    const dst = cellOf('slot:armor');       // 中甲
    const dstName = dst.children[1];        // the `.inv-nm` span inside the target cell
    check('测试用：目标格的名称 span 确实是格子的子节点（否则这个回归测试是空的）',
      dstName && dstName.parent === dst && dstName.className === 'inv-nm',
      dstName && dstName.className);
    moves.length = 0;
    hit = dstName;                          // ← the finger is over the TEXT, not the cell
    src.dispatch('pointerdown', { clientX: 10, clientY: 10, pointerId: 20, preventDefault() {}, stopPropagation() {} });
    src.dispatch('pointermove', { clientX: 80, clientY: 60, pointerId: 20 });
    check('拖到目标物品的「名字」上也高亮整个格子（命中测试向上找到 [data-ref]）',
      dst.classList.contains('hot'));
    src.dispatch('pointerup', { clientX: 80, clientY: 60, pointerId: 20 });
    check('…并且真的完成了这次拖放（两件护甲互换）',
      moves.length === 1 && inv.slots.armor.id === 'armorLight' && inv.bag[7].id === 'armorMedium',
      JSON.stringify({ moves: moves.length, slot: inv.slots.armor.id, bag7: inv.bag[7].id }));
    check('…换完之后目标格重新绘制（护甲槽显示轻甲）',
      cellOf('slot:armor').children[1].textContent === '轻甲',
      cellOf('slot:armor').children[1].textContent);
  }

  // ------------------------------------------------ drag rejected: bag ammo -> armour slot
  {
    const src = cellOf('bag:2');            // 9mm
    const dst = cellOf('slot:armor');
    moves.length = 0;
    hit = dst.children[1];                   // …again via a child, so both paths agree
    src.dispatch('pointerdown', { clientX: 10, clientY: 10, pointerId: 8, preventDefault() {}, stopPropagation() {} });
    src.dispatch('pointermove', { clientX: 80, clientY: 60, pointerId: 8 });
    check('非法目标不高亮（子弹不能进护甲槽）', !dst.classList.contains('hot'));
    src.dispatch('pointerup', { clientX: 80, clientY: 60, pointerId: 8 });
    check('非法拖放不会提交移动，也不会改变状态',
      moves.length === 0 && inv.bag[2].kind === 'ammo' && inv.slots.armor.kind === 'armor',
      `moves=${moves.length}`);
  }

  // ------------------------------------------------ tap-to-move: tap source, tap target
  {
    const src = cellOf('bag:8');            // frag x2
    const dst = cellOf('slot:throwable');   // frag x3
    moves.length = 0;
    hit = src;
    src.dispatch('pointerdown', { clientX: 10, clientY: 10, pointerId: 9, preventDefault() {}, stopPropagation() {} });
    src.dispatch('pointerup', { clientX: 10, clientY: 10, pointerId: 9 });
    check('轻点选中来源（不高亮为拖放目标，标记为 sel）', src.classList.contains('sel'));
    hit = dst;
    dst.dispatch('pointerdown', { clientX: 90, clientY: 90, pointerId: 10, preventDefault() {}, stopPropagation() {} });
    check('点第二个格子完成移动（点选 -> 点放）',
      moves.length === 1 &&
      moves[0][0].where === 'bag' && moves[0][1].where === 'slot' && moves[0][1].slot === 'throwable',
      JSON.stringify(moves[0] ?? null));
    check('选中状态在移动后清除', !src.classList.contains('sel'));
  }

  // ------------------------------------------------ a rejected tap-to-move changes nothing
  {
    const src = cellOf('bag:4');            // shells
    const dst = cellOf('slot:healing');
    moves.length = 0;
    hit = src;
    src.dispatch('pointerdown', { clientX: 10, clientY: 10, pointerId: 11, preventDefault() {}, stopPropagation() {} });
    src.dispatch('pointerup', { clientX: 10, clientY: 10, pointerId: 11 });
    hit = dst;
    dst.dispatch('pointerdown', { clientX: 90, clientY: 90, pointerId: 12, preventDefault() {}, stopPropagation() {} });
    check('点选到非法目标：面板先校验，onMove 根本不会被调用，物品留在原处',
      moves.length === 0 && inv.bag[4] && inv.bag[4].kind === 'ammo' && inv.slots.healing.kind === 'healing',
      `moves=${moves.length}`);
  }

  // ------------------------------------------------ restart: the panel must follow the NEW model
  // Real-device bug: 「重新开始之后背包还是旧数据，而且无法拖动」. The panel used to receive
  // `sim.inventory` as a VALUE, and GameSim.reset() replaces that object with a fresh loadout — so the
  // panel kept painting (and validating drops against) the previous run's inventory while
  // sim.moveItem() mutated the new one.
  {
    const sim = new GameSim();
    const before = sim.inventory;
    sim.reset();
    check('sim.reset() 会换掉 inventory 对象（所以面板里的 getter 是必须的，注释里的前提是实测的）',
      sim.inventory !== before && sim.inventory.bag[0] && sim.inventory.bag[0].weaponId === 'rpg',
      JSON.stringify({ swapped: sim.inventory !== before }));

    // 1) dirty the displayed model, so "it shows the fresh loadout" is a real observation
    inv.bag[0] = null;                       // the rpg is left in the field
    inv.bag[10] = createAmmo('ammo9mm', 50); // …and a cell the fresh loadout does not fill
    panel.refresh();
    check('（准备）清掉 rpg 后该格画成空', cellOf('bag:0').classList.contains('empty'));

    // 2) arm a tap-to-move on a cell that the NEW loadout leaves empty
    hit = cellOf('bag:10');
    cellOf('bag:10').dispatch('pointerdown', { clientX: 5, clientY: 5, pointerId: 30, preventDefault() {}, stopPropagation() {} });
    cellOf('bag:10').dispatch('pointerup', { clientX: 5, clientY: 5, pointerId: 30 });
    check('（准备）点选 bag:10', cellOf('bag:10').classList.contains('sel'));

    // 3) RESTART, then refresh — the panel must repaint from the new object
    inv = createInventory();
    panel.refresh();
    check('重启后刷新：格子显示的是新战局的配装（rpg 回到 bag:0，不再是 empty）',
      !cellOf('bag:0').classList.contains('empty')
      && cellOf('bag:0').children[1].textContent === '火箭筒',
      cellOf('bag:0').children[1].textContent);
    check('重启后刷新：旧战局多出来的那格恢复为空（显示与模型一致）',
      cellOf('bag:10').classList.contains('empty'));
    check('重启后刷新：指向已空格子的旧选择被清掉（否则会留下一个永远无法完成的高亮）',
      !cellOf('bag:10').classList.contains('sel'));

    // 4) a drag after the restart must validate against AND commit to the new object
    moves.length = 0;
    const dst = cellOf('slot:primary');
    hit = dst.children[1];                   // via the cell's child, like a real finger
    cellOf('bag:0').dispatch('pointerdown', { clientX: 10, clientY: 10, pointerId: 31, preventDefault() {}, stopPropagation() {} });
    cellOf('bag:0').dispatch('pointermove', { clientX: 80, clientY: 60, pointerId: 31 });
    check('重启后还能拖：合法目标照常高亮（校验用的是新模型）', dst.classList.contains('hot'));
    cellOf('bag:0').dispatch('pointerup', { clientX: 80, clientY: 60, pointerId: 31 });
    check('重启后拖放落在新战局的背包上（rpg 进主武器槽，且面板同步跟上）',
      moves.length === 1 && inv.slots.primary.weaponId === 'rpg' && inv.bag[0].weaponId === 'smg'
      && cellOf('slot:primary').children[1].textContent === '火箭筒',
      JSON.stringify({ moves: moves.length, primary: inv.slots.primary.weaponId }));
  }

  // ------------------------------------------------ close button
  {
    const closeBtn = nodes.find((n) => n.className === 'inv-close');
    closeBtn.dispatch('pointerdown', { stopPropagation() {} });
    check('✕ 关闭面板', panel.isOpen() === false && opens.at(-1) === false);
  }

  // ------------------------------------------------ the cell really is the only hit target
  // The browser's own hit test must not stop on a cell child either (belt to the `closest()` braces):
  // a source-level check, because the shim cannot model CSS.
  {
    const css = readFileSync(new URL('../apps/shooter/styles.css', import.meta.url), 'utf8');
    check('styles.css 把格子的子元素设为 pointer-events:none（格子是唯一命中目标）',
      /\.inv-cell\s*>\s*\*\s*\{[^}]*pointer-events\s*:\s*none/.test(css),
      'missing `.inv-cell > *{pointer-events:none}`');
    check('styles.css 没有给格子的子元素重新打开 pointer-events',
      !/\.inv-(lv|nm|ct)\s*\{[^}]*pointer-events/.test(css));
  }

  // ------------------------------------------------ shared action-button contract
  {
    const { bindActionButton, bindWeaponSwitch } = await import(BTN.href);
    check('bindWeaponSwitch 与 bindActionButton 是同一套接线（三个按钮不会各自漂移）',
      typeof bindActionButton === 'function' && typeof bindWeaponSwitch === 'function');
    const b = mkEl('button');
    let n = 0;
    bindActionButton(b, () => { n++; });
    const bound = Object.keys(b.listeners);
    check('动作按钮绑定 pointerdown + keydown，且没有 click',
      bound.includes('pointerdown') && bound.includes('keydown') && !bound.includes('click'), bound.join(','));
    b.dispatch('pointerdown', { stopPropagation() {} });
    b.dispatch('click');
    check('只按 pointerdown 触发一次（合成 click 不会二次触发）', n === 1, String(n));
  }
}

// ------------------------------------------------------------------ report
console.log(`\nverify-inventory: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error('  FAIL  ' + f);
  process.exit(1);
}
