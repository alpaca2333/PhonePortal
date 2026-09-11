/**
 * CPU-side verification for the magazine / reload system and the sub-machine gun.
 *
 * Rules under test:
 *   - every ranged weapon declares `magSize` (rounds, counted in SHOTS) and `reloadTime`;
 *     `magSize: 0` means "no magazine" (rpg) and must behave exactly like before this feature;
 *   - the magazine state lives on `Player` (shared weapon definitions are read-only data);
 *   - firing spends a round ONLY when `fireWeapon()` really fired (no aim direction -> no cost),
 *     an empty magazine auto-reloads, the reload blocks firing, and the reload refills on the
 *     frame it completes (so the first post-reload shot is not delayed by an extra cooldown);
 *   - the three knobs (magazine size, reload time, cadence) are independently configurable —
 *     asserted with a synthetic weapon registered just for this script;
 *   - the SMG fires 10 rounds/s at 100 u/s inside +/-6 degrees (widened from 3 on request) and
 *     deals 10 damage per hit.
 *
 * Run:  npm run build && node scripts/verify-ammo.mjs
 * Exit code is non-zero when any assertion fails.
 */
const GAME = new URL('../dist/apps/shooter/src/game.js', import.meta.url);
const WEAPONS_URL = new URL('../dist/apps/shooter/src/weapons.js', import.meta.url);
const PROJ = new URL('../dist/apps/shooter/src/projectiles.js', import.meta.url);
const HUD = new URL('../dist/apps/shooter/src/hud.js', import.meta.url);
const ITEMS = new URL('../dist/apps/shooter/src/items.js', import.meta.url);
const INVENTORY = new URL('../dist/apps/shooter/src/inventory.js', import.meta.url);

const { GameSim, CONFIG } = await import(GAME.href);
const { WEAPONS, DEFAULT_WEAPON, getWeapon, getWeaponOrNull, magSizeOf, ammoIdOf } = await import(WEAPONS_URL.href);
const { PROJECTILES } = await import(PROJ.href);
const { AMMO } = await import(ITEMS.href);
const { createInventory, reserveOf } = await import(INVENTORY.href);
const SMG = WEAPONS.smg;   // the cadence blocks below are outside the definitions block's scope
const { ammoReadout, reloadBarProgress } = await import(HUD.href);

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ' — ' + detail : ''));
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

/** Hue in degrees (0 = red, 30 = orange, 60 = yellow) from a 0xRRGGBB integer. */
function hueOf(hex) {
  const r = ((hex >> 16) & 255) / 255, g = ((hex >> 8) & 255) / 255, b = (hex & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return 0;
  const h = max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  return h < 0 ? h + 360 : h;
}

/**
 * The hue a projectile actually shows: the additive pass draws the core at full intensity plus the
 * sheath at `BULLET_GLOW_OPACITY` (render.ts), so the composite — not the raw `color` — is what the
 * player sees. Clipped at 1.0 per channel, exactly like additive blending does.
 */
function compositeHue(coreHex, glowHex, opacity = 0.45) {
  const ch = (hex) => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
  const [r, g, b] = ch(coreHex);
  const [gr, gg, gb] = ch(glowHex);
  const mix = (c, gc) => Math.min(1, c + opacity * gc);
  const byte = (c) => Math.round(c * 255);
  return hueOf((byte(mix(r, gr)) << 16) | (byte(mix(g, gg)) << 8) | byte(mix(b, gb)));
}

const DT = 1 / 60;
const idle = { move: { x: 0, y: 0 }, aim: { x: 0, y: 0 }, firing: false, autoAim: false };
const firing = { move: { x: 0, y: 0 }, aim: { x: 1, y: 0 }, firing: true, autoAim: false };

/** Fresh sim with a chosen weapon (explicit — DEFAULT_WEAPON is a moving target by design). */
function freshSim(weaponId = DEFAULT_WEAPON) {
  const sim = new GameSim();
  sim.spawnQueue = 0;
  sim.spawnTimer = 0;
  sim.enemies = [];
  // Cover is part of the LEVEL, not of the weapon: this suite tests weapon mechanics, so it runs
  // on an empty arena. scripts/verify-cover.mjs owns the real layout (and asserts its properties).
  sim.obstacles = [];
  sim.equipWeapon(weaponId);
  return sim;
}

function addEnemy(sim, x, y, hp, kind = 'chaser', speed = 0) {
  sim.enemies.push({
    id: 900 + sim.enemies.length, pos: { x, y }, vel: { x: 0, y: 0 }, r: 0.7,
    hp, maxHp: hp, alive: true, kind, speed, touchDmg: 16, hitFlash: 0, touchCd: 0, burns: [], flameAcc: 0,
  });
  return sim.enemies[sim.enemies.length - 1];
}

function run(sim, seconds, input = idle, dt = DT) {
  const frames = Math.round(seconds / dt);
  for (let i = 0; i < frames; i++) { sim.update(dt, input); sim.spawnQueue = 0; }
}

/**
 * Record one entry per PROJECTILE spawn (sim time + direction), by wrapping the context method
 * the weapon calls. Same monkey-patching style as verify-burn's spawnBurnFlame probe.
 */
function trackShots(sim) {
  const shots = [];
  const orig = sim.spawnProjectile.bind(sim);
  sim.spawnProjectile = (def, pos, dir) => { shots.push({ t: sim.time, dir: { x: dir.x, y: dir.y } }); orig(def, pos, dir); };
  return shots;
}

/** Collapse per-projectile spawns into per-shot times (a shotgun volley = 8 projectiles). */
function shotTimes(shots) {
  const out = [];
  for (const s of shots) if (out.length === 0 || Math.abs(s.t - out[out.length - 1]) > 1e-12) out.push(s.t);
  return out;
}

/** Assert a list of sim times equals `expected` offsets from the first entry (frame-rate safe). */
function checkSpacing(label, times, expected) {
  if (times.length !== expected.length) {
    check(label, false, `got ${times.length} shots [${times.map((t) => t.toFixed(3)).join(', ')}]`);
    return;
  }
  const t0 = times[0];
  const bad = times.findIndex((t, i) => Math.abs(t - t0 - expected[i]) > DT + 1e-6);
  check(label, bad === -1,
    bad === -1 ? undefined : `shot ${bad}: +${(times[bad] - t0).toFixed(4)}s, expected +${expected[bad]}s`);
}

// ------------------------------------------------------------------ definitions
{
  const shot = WEAPONS.dragonBreath;
  check('散弹枪 cooldown = 0.6s', near(shot.cooldown, 0.6));
  check('散弹枪 magSize = 8', shot.magSize === 8, String(shot.magSize));
  check('散弹枪 reloadTime = 1.5s', near(shot.reloadTime, 1.5));
  check('散弹枪仍是每次 8 颗弹丸', shot.pellets === 8, String(shot.pellets));
  check('龙息弹飞行速度 = 63 u/s（−30%，原 90）', PROJECTILES.flameShot.speed === 63, String(PROJECTILES.flameShot.speed));

  // --- 龙息弹弹丸的外观（用户手感反馈：「子弹太粗了…也有点太红了，橙一点」）------------------------
  // The drawn pellet is a unit box scaled per instance by `size` (core) with an additive sheath at
  // `size * glowScale` around it (render.ts); the SHEATH width is what reads as "how thick". These
  // assertions pin the tuned numbers so a later "let's make the pellet pop" change cannot silently
  // undo the request — they are ranges, not exact values, so the look can still be nudged.
  {
    const v = PROJECTILES.flameShot.visual;
    const sheath = v.size[0] * v.glowScale[0];
    const smgSheath = PROJECTILES.smgRound.visual.size[0] * PROJECTILES.smgRound.visual.glowScale[0];
    check('龙息弹弹丸够细（绘制宽度 = size×glowScale ≤ 0.21 世界单位，且不粗于冲锋枪曳光）',
      sheath <= 0.21 && sheath <= smgSheath + 1e-9,
      `鞘宽 ${sheath.toFixed(3)} vs 冲锋枪 ${smgSheath.toFixed(3)}`);
    check('龙息弹弹丸偏橙而不是偏红（核心色相 17–28°，落在武器自身的火焰色带 15.7–36° 内）',
      hueOf(v.color) >= 17 && hueOf(v.color) <= 28,
      `核心色相 ${hueOf(v.color).toFixed(1)}°`);
    check('龙息弹的点光跟着一起变橙（不是留着旧的偏红 0xff4a12 不换）',
      hueOf(v.lightColor) >= 17 && hueOf(v.lightColor) <= 28 && v.lightColor !== 0xff4a12,
      `点光色相 ${hueOf(v.lightColor).toFixed(1)}°`);
    // Measured, not asserted as taste: `compositeHue` is the colour the additive pass actually
    // produces for one pellet (core + 0.45 x sheath), which is what the player sees in flight. It
    // must land in the orange band — the old palette composited to 24.0 degrees (red-orange).
    const single = compositeHue(v.color, v.glowColor);
    check('单发弹丸在屏幕上的合成色（核心 + 0.45×鞘）落在 28–38° 的橙色区间，不再偏红',
      single >= 28 && single <= 38, `合成色相 ${single.toFixed(1)}°（旧值 24.0°）`);
    // The accepted trade-off of that shift, pinned so it stays a KNOWN one: two overlapping pellets
    // (they do overlap near the muzzle) clip toward yellow, which is inherent to additive blending.
    // Three or more of ANY warm colour whose green is >= 0.34 clip to pure yellow — so this asserts
    // the boundary honestly instead of claiming the stack is unchanged.
    const two = compositeHue(v.color, v.glowColor, 0.45 * 2);
    check('两发叠加仍然偏橙（< 50°），不会立刻跳到黄',
      two < 50, `两发合成色相 ${two.toFixed(1)}°`);
  }

  const smg = WEAPONS.smg;
  check('冲锋枪已注册且是远程武器', !!smg && smg.kind === 'ranged');
  check('冲锋枪 cooldown = 0.1/1.3 ≈ 0.0769s（13 发/秒 = 780 发/分；真机要求「射速提高 1.3 倍」，原 10 发/秒 = 600）',
    near(smg.cooldown, 0.1 / 1.3, 1e-12) && Math.abs(60 / smg.cooldown - 780) < 1e-9,
    `${smg.cooldown.toFixed(6)}s -> ${(60 / smg.cooldown).toFixed(2)} rpm`);
  check('冲锋枪 magSize = 30', smg.magSize === 30, String(smg.magSize));
  check('冲锋枪 reloadTime = 1.5s', near(smg.reloadTime, 1.5));
  check('冲锋枪每次 1 颗弹丸', smg.pellets === 1, String(smg.pellets));
  check('冲锋枪散布 = 6 度（半角，即 ±6°；真机要求「扩大一倍」，原 ±3°）',
    near(smg.spread, (6 * Math.PI) / 180, 1e-12), String(smg.spread));
  check('冲锋枪子弹 = smgRound @ 100 u/s', smg.projectile.id === 'smgRound' && smg.projectile.speed === 100,
    smg.projectile.id + ' @ ' + smg.projectile.speed);
  check('冲锋枪单发伤害 = 10', smg.projectile.damage === 10, String(smg.projectile.damage));

  check('火箭筒无弹夹（仍然不换弹）', WEAPONS.rpg.magSize === 0 && WEAPONS.rpg.reloadTime === 0,
    `magSize=${WEAPONS.rpg.magSize} reloadTime=${WEAPONS.rpg.reloadTime}`);
  check('magSizeOf：远程取 magSize，近战为 0',
    magSizeOf(smg) === 30 && magSizeOf(WEAPONS.dragonBreath) === 8 && magSizeOf(WEAPONS.rpg) === 0 && magSizeOf(WEAPONS.sword) === 0);

  // ---- weapon -> backpack ammo link (+ the level that link carries) ----
  // There is no WEAPON_ORDER cycle any more: the HUD button trades the PRIMARY and SECONDARY slots
  // and nothing else (user requirement), so what matters now is that every ranged weapon names the
  // ammo type that feeds its magazine, and that the ammo's level IS the round's level.
  for (const w of [smg, WEAPONS.dragonBreath, WEAPONS.rpg]) {
    const id = ammoIdOf(w);
    check(`${w.name} 指定了背包弹药类型`, !!id && id in AMMO, String(id));
    check(`${w.name} 的弹药等级 = 弹丸等级（${w.projectile.id} Lv${w.projectile.level}）`,
      !!id && AMMO[id].level === w.projectile.level && AMMO[id].projectile === w.projectile.id,
      `${id} Lv${id ? AMMO[id].level : '?'} vs ${w.projectile.id} Lv${w.projectile.level}`);
  }
  check('近战没有弹药类型（ammoIdOf 返回 null）', ammoIdOf(WEAPONS.sword) === null);
  check('子弹单格堆叠上限 = 200（用户要求）',
    AMMO.ammo9mm.stackMax === 200 && AMMO.ammoShell.stackMax === 200 && AMMO.ammoRocket.stackMax === 200,
    String(AMMO.ammo9mm.stackMax));

  // ---- the starting loadout ----
  {
    const sim = freshSim();
    check('开局手持主武器（冲锋枪）并已从备弹装满弹夹',
      sim.player.weaponId === 'smg' && sim.player.ammo === 30 && sim.inventory.activeSlot === 'primary',
      `weapon=${sim.player.weaponId} ammo=${sim.player.ammo}`);
    check('开局副武器槽是龙息喷（切换按钮才有东西可切）',
      sim.inventory.slots.secondary !== null && sim.inventory.slots.secondary.weaponId === 'dragonBreath');
    // Derived from the shipped (testing) loadout rather than hard-coded: the invariant is "the reserve
    // readout equals what the bag holds, minus the 30 rounds that filled the starting magazine".
    const bag = createInventory();
    const bag9 = reserveOf(bag, 'ammo9mm'), bagShell = reserveOf(bag, 'ammoShell'), bagRocket = reserveOf(bag, 'ammoRocket');
    check(`开局备弹 = 背包弹药总数（${bag9} 装填 30 之后剩 ${bag9 - 30}）`,
      sim.reserveOf('ammo9mm') === bag9 - 30 && sim.reserveOf('ammoShell') === bagShell && sim.reserveOf('ammoRocket') === bagRocket,
      `9mm=${sim.reserveOf('ammo9mm')} shell=${sim.reserveOf('ammoShell')} rocket=${sim.reserveOf('ammoRocket')}`);
    check('getWeaponOrNull：空 id / 未知 id 都不是武器（空槽位不能静默变成默认枪）',
      getWeaponOrNull('') === null && getWeaponOrNull('bogus') === null && getWeaponOrNull('smg').id === 'smg');
    check('getWeapon 仍然对未知 id 兜底（数据查询的老行为不变）', getWeapon('bogus').id === DEFAULT_WEAPON);
    check('DEFAULT_WEAPON 仍是冲锋枪', DEFAULT_WEAPON === 'smg');
  }

  // ---- primary <-> secondary switching ----
  {
    const sim = freshSim();
    check('switchWeapon 切到副武器（龙息喷，弹夹 8）',
      sim.switchWeapon() === true && sim.player.weaponId === 'dragonBreath' && sim.player.ammo === 8,
      `weapon=${sim.player.weaponId} ammo=${sim.player.ammo}`);
    check('再切回主武器，弹夹保留（换枪不白送子弹）',
      sim.switchWeapon() === true && sim.player.weaponId === 'smg' && sim.player.ammo === 30);
    // Fire one round, switch away and back: the magazine must come back with 29, not 30.
    sim.update(DT, firing);
    sim.update(DT, firing);          // fireTimer was reset by the switch -> the first update fires
    const afterFire = sim.player.ammo;
    sim.switchWeapon();
    sim.switchWeapon();
    check('打掉的子弹不会因为换枪而补回来',
      afterFire < 30 && sim.player.ammo === afterFire,
      `afterFire=${afterFire} afterSwap=${sim.player.ammo}`);
    // A sim whose secondary slot is emptied can no longer switch.
    sim.inventory.slots.secondary = null;
    check('副武器槽为空时切换是空操作', sim.switchWeapon() === false && sim.player.weaponId === 'smg');
  }
}

// ------------------------------------------------------------------ 龙息弹减速后的弹道不变量
{
  // measured speed: one frame of free flight must be exactly speed/60
  const sim = freshSim('dragonBreath');
  sim.update(DT, firing);
  const b = sim.bullets[0];
  const p0 = { x: b.pos.x, y: b.pos.y };
  sim.update(DT, idle);
  const step = Math.hypot(b.pos.x - p0.x, b.pos.y - p0.y);
  check('龙息弹每帧前进 1.05 单位（63/60，实测）', near(step, 63 / 60, 1e-9), String(step));

  // ARENA SIZE SETS THE ON-SCREEN PELLET COUNT (ARENA_HALF 20 -> 38; see config.ts). These numbers
  // are asserted rather than left in a comment because they drift silently with the map — which is
  // exactly what happened: the old "at most one volley / max 8 pellets" invariant was a property of
  // the 40x40 arena, not of the weapon.
  const ARENA_CULL = 38 + 2;                  // bullets are culled past |pos| > ARENA_HALF + 2
  const shotSpeed = WEAPONS.dragonBreath.projectile.speed;
  const muzzle = 0.55 + WEAPONS.dragonBreath.muzzleOffset;

  const sim2 = freshSim('dragonBreath');
  sim2.update(DT, firing);
  let cleared = -1;
  for (let i = 0; i < 200; i++) {
    sim2.update(DT, idle);
    if (sim2.bullets.length === 0) { cleared = i + 1; break; }
  }
  // The culler must be the BOUNDARY, not `life` — that is the whole reason `life` was raised to
  // 1.6s (101 units) for the bigger map. If life ever became the culler again, rounds would vanish
  // in mid-air instead of hitting anything.
  const flightSeconds = cleared / 60;
  const expectedSeconds = (ARENA_CULL - muzzle) / shotSpeed;
  check('一次齐射的出界时间 ≈ 场地边界的飞行时间（不是被 life 收掉）',
    cleared > 0 && Math.abs(flightSeconds - expectedSeconds) <= 2 / 60,
    `cleared=${cleared} 帧 (${flightSeconds.toFixed(3)}s)，期望 ${expectedSeconds.toFixed(3)}s`);
  check('出界由边界决定：飞行时间短于 life',
    flightSeconds < WEAPONS.dragonBreath.projectile.life, `${flightSeconds.toFixed(3)}s`);

  // From the CENTRE the flight is now longer than the cadence, so two volleys coexist.
  const sim3 = freshSim('dragonBreath');
  let peak = 0;
  for (let i = 0; i < 240; i++) { sim3.update(DT, firing); sim3.spawnQueue = 0; peak = Math.max(peak, sim3.bullets.length); }
  check('居中持续开火：同屏弹丸峰值 = 16（两个齐射，不再是 8）', peak === 16, String(peak));
  check('居中时出界时间已长于冷却（这就是 16 的原因）',
    flightSeconds > WEAPONS.dragonBreath.cooldown,
    `${flightSeconds.toFixed(3)}s vs ${WEAPONS.dragonBreath.cooldown}s`);

  // Worst case: hugging one wall and firing across the map — 77.45 units at 63 u/s = 1.23s, so
  // THREE volleys overlap at the 0.6s cadence. (It was 16 on the 40x40 map.)
  const sim4 = freshSim('dragonBreath');
  sim4.player.pos.x = -(38 - 0.55);
  let peak4 = 0;
  for (let i = 0; i < 600; i++) {
    sim4.update(DT, firing);
    sim4.spawnQueue = 0;
    peak4 = Math.max(peak4, sim4.bullets.length);
  }
  check('最坏情况（贴一侧朝对面打）同屏 = 24（三个齐射）', peak4 === 24, String(peak4));
  check('同屏弹丸仍远低于渲染池上限（MAX_BULLETS 256）', peak4 < 256, String(peak4));
}

// ------------------------------------------------------------------ 散弹枪弹夹
{
  const sim = freshSim('dragonBreath');
  check('新开局满弹夹（散弹枪 8 发）', sim.player.ammo === 8 && sim.player.reloadTimer === 0 && sim.player.reloadTotal === 0,
    `ammo=${sim.player.ammo}`);
  check('新开局的默认武器是冲锋枪且满弹夹',
    freshSim().player.weaponId === 'smg' && freshSim().player.ammo === 30);

  const shots = trackShots(sim);
  run(sim, 2.95, firing);
  checkSpacing('散弹枪齐射间隔 0.6s', shotTimes(shots), [0, 0.6, 1.2, 1.8, 2.4]);
  check('每次齐射 8 颗弹丸', shots.length === 5 * 8, String(shots.length));
  check('5 次齐射后弹夹剩 3 发', sim.player.ammo === 3, String(sim.player.ammo));
  check('未打空时不换弹', sim.player.reloadTimer === 0, String(sim.player.reloadTimer));
}

{
  // Empty the magazine, then keep the trigger held through the reload.
  const sim = freshSim('dragonBreath');
  const shots = trackShots(sim);
  // Frame-by-frame so the assertions can look at the exact frame the magazine ran dry.
  let emptiedAt = -1;
  for (let i = 0; i < 300; i++) {
    sim.update(DT, firing);
    sim.spawnQueue = 0;
    if (sim.player.ammo === 0) { emptiedAt = i; break; }
  }
  const times = shotTimes(shots);
  check('8 次齐射打空弹夹', times.length === 8 && sim.player.ammo === 0, `shots=${times.length} ammo=${sim.player.ammo}`);
  check('打空那一帧立刻进入换弹（reloadTimer = reloadTotal = 1.5）',
    near(sim.player.reloadTimer, 1.5) && near(sim.player.reloadTotal, 1.5),
    `timer=${sim.player.reloadTimer} total=${sim.player.reloadTotal}`);
  check('第 8 次齐射发生在 +4.2s', near(times[7] - times[0], 4.2, DT + 1e-6), String(times[7] - times[0]));

  const before = shots.length;
  run(sim, 1.3, firing);              // still reloading (started at +4.2, ends at +5.7)
  check('换弹期间按住扳机不生成任何弹丸', shots.length === before, `+${shots.length - before}`);
  check('换弹期间弹药仍为 0', sim.player.ammo === 0, String(sim.player.ammo));

  run(sim, 0.5, firing);              // +6.0s: reload done at +5.7, so the 9th volley lands there
  const after = shotTimes(shots);
  checkSpacing('换弹结束当帧即可开火（4.2 + 1.5 = 5.7s）', after, [0, 0.6, 1.2, 1.8, 2.4, 3.0, 3.6, 4.2, 5.7]);
  check('换弹后弹夹重新装满（再打 1 发 = 7）', sim.player.ammo === 7, String(sim.player.ammo));
  check('第 8 次齐射就是打空的那一帧（没有多等一帧）',
    near(times[7], (emptiedAt + 1) * DT, 1e-12), `shot@${times[7].toFixed(4)} empty@${((emptiedAt + 1) * DT).toFixed(4)}`);
}

{
  // Refill must be observable with the trigger released (no shot hides it).
  const sim = freshSim('dragonBreath');
  run(sim, 4.3, firing);
  run(sim, 1.6, idle);
  check('松开扳机时换弹照样完成并补满', sim.player.ammo === 8 && sim.player.reloadTimer === 0 && sim.player.reloadTotal === 0,
    `ammo=${sim.player.ammo} timer=${sim.player.reloadTimer}`);
}

{
  // Frame-rate independence: the same 6s of trigger-held fire must produce the same volleys.
  const counts = [];
  for (const dt of [1 / 60, 1 / 20]) {
    const sim = freshSim('dragonBreath');
    const shots = trackShots(sim);
    run(sim, 6.0, firing, dt);
    counts.push(shotTimes(shots).length);
  }
  check('20fps 与 60fps 的齐射次数一致（换弹与射速都与帧率无关）', counts[0] === counts[1],
    `60fps=${counts[0]} 20fps=${counts[1]}`);
}

// ------------------------------------------------------------------ 冲锋枪
// CADENCE IS DERIVED FROM `smg.cooldown` THROUGHOUT — the rate is a tunable (it has been raised
// twice on request) and hard-coded shot counts/timestamps would break on every retune.
{
  const COIL = SMG.cooldown;                       // 0.1/1.3 = 0.0769s
  const MAG = SMG.magSize;
  const dryAt = (MAG - 1) * COIL;                  // when the magazine's LAST round leaves
  const sim = freshSim();
  sim.equipWeapon('smg');
  const shots = trackShots(sim);
  run(sim, dryAt + 0.2, firing);
  const times = shotTimes(shots);
  check(`冲锋枪 13 发/秒：打空 ${MAG} 发弹夹用时 ${dryAt.toFixed(3)}s 内恰好 ${MAG} 发`,
    times.length === MAG, `${times.length} (dryAt=${dryAt.toFixed(3)}s)`);
  checkSpacing(`冲锋枪射击间隔 = cooldown（${COIL.toFixed(4)}s）`, times, times.map((_, i) => i * COIL));
  check(`${MAG} 发打空弹夹并自动换弹`,
    sim.player.ammo === 0 && sim.player.reloadTimer > 0 && near(sim.player.reloadTotal, 1.5),
    `ammo=${sim.player.ammo} timer=${sim.player.reloadTimer}`);
}

{
  // Reload cycle: the LAST magazine round lands at (MAG-1)*cooldown, the 1.5s reload runs after it,
  // and the magazine refills on that frame — so the next shot comes at dryAt + 1.5s + one cooldown.
  const COIL = SMG.cooldown;
  const MAG = SMG.magSize;
  const dryAt = (MAG - 1) * COIL;
  const sim = freshSim();
  sim.equipWeapon('smg');
  const shots = trackShots(sim);
  const window = dryAt + 1.5 + 2.2 * COIL;
  run(sim, window, firing);
  const times = shotTimes(shots);
  // The magazine's last round is `dryAt`; the reload ends 1.5s later and the next round leaves on a
  // frame boundary at/after that (the sim fires at most once per frame, hence the one-frame slack).
  const resumes = times.length > MAG ? times[MAG] - times[0] : NaN;
  check(`冲锋枪换弹 1.5s 后继续：第 ${MAG + 1} 发落在打空 + 1.5s（±1 帧）`,
    Number.isFinite(resumes) && Math.abs(resumes - (dryAt + 1.5)) <= DT + 1e-6,
    `resumes at +${Number.isFinite(resumes) ? resumes.toFixed(4) : 'n/a'}s, expected +${(dryAt + 1.5).toFixed(4)}s`);
  const tail = times.slice(MAG);
  check(`换弹后的连射间隔仍是 cooldown（${COIL.toFixed(4)}s）`,
    tail.length >= 2 && tail.every((t, i) => i === 0 || Math.abs(t - tail[0] - i * COIL) <= DT + 1e-6),
    `[${tail.map((t) => t.toFixed(3)).join(', ')}]`);
}

{
  // FRAME-RATE INDEPENDENCE (the invariant the overshoot-carrying fire timer exists for): a cadence
  // that is not a whole number of frames must still average the same rate. Resetting `fireTimer` to
  // the cooldown would quantise 0.0769s UP to 5 frames at 60fps (12/s = 720rpm) and to 3 frames at
  // 30fps (600rpm) — i.e. the requested 1.3x would silently be 1.2x.
  const COIL = SMG.cooldown;
  const counts = [30, 60, 120].map((fps) => {
    const dt = 1 / fps;
    const sim = freshSim();
    sim.equipWeapon('smg');
    const shots = trackShots(sim);
    const seconds = 10;
    for (let i = 0; i < Math.round(seconds / dt); i++) {
      sim.update(dt, firing);
      sim.spawnQueue = 0;
      sim.player.ammo = 1e6;                        // measure cadence, not the magazine
      sim.player.reloadTimer = 0;
    }
    return shots.length;
  });
  check('射速与帧率无关：30/60/120fps 下 10 秒内打出同样多的子弹（余量跨帧结转）',
    new Set(counts).size === 1, `counts=${counts.join('/')} (expected ${1 + Math.floor(10 / COIL + 1e-9)})`);
  check('实测 10 秒 ≈ 13 发/秒（780 发/分，含 t=0 的第一发）',
    Math.abs(counts[0] - (1 + Math.floor(10 / COIL + 1e-9))) <= 1,
    `${counts[0]} shots -> ${(counts[0] * 60 / 10).toFixed(0)} rpm incl. the t=0 shot`);
}

{
  // Bullet speed measured from the sim, not read from the definition.
  const sim = freshSim();
  sim.equipWeapon('smg');
  sim.update(DT, firing);
  const b = sim.bullets[0];
  check('冲锋枪开火生成 1 颗子弹', sim.bullets.length === 1, String(sim.bullets.length));
  const p0 = { x: b.pos.x, y: b.pos.y };
  sim.update(DT, idle);
  const dist = Math.hypot(b.pos.x - p0.x, b.pos.y - p0.y);
  check('子弹飞行速度实测 = 100 u/s', near(dist / DT, 100, 1e-6), String(dist / DT));
}

{
  // Spread: a long burst, all inside +/-6 degrees, non-degenerate, roughly uniform. The burst is a
  // fixed DURATION (200s) so the sample count follows the cadence — pinning an exact shot count here
  // would make this test fail every time the rate is retuned.
  const sim = freshSim();
  sim.equipWeapon('smg');
  sim.player.ammo = 1e9;              // test-only: keep firing without reloading
  const shots = trackShots(sim);
  run(sim, 200, firing);
  const angles = shots.map((s) => Math.atan2(s.dir.y, s.dir.x));
  const spread = WEAPONS.smg.spread;
  const maxAbs = Math.max(...angles.map(Math.abs));
  check('200 秒连射全部落在 ±6° 内', angles.length >= 2000 && maxAbs <= spread + 1e-12,
    `n=${angles.length} max=${((maxAbs * 180) / Math.PI).toFixed(4)}°`);
  const meanAbs = angles.reduce((s, a) => s + Math.abs(a), 0) / angles.length;
  check('散布是均匀分布（均值 |角度| ≈ 半角/2）', Math.abs(meanAbs - spread / 2) < spread * 0.05,
    `mean=${((meanAbs * 180) / Math.PI).toFixed(4)}° expected≈${(((spread / 2) * 180) / Math.PI).toFixed(4)}°`);
  const sd = Math.sqrt(angles.reduce((s, a) => s + (a - 0) * (a - 0), 0) / angles.length);
  check('散布非退化（标准差 > 0.4 × 半角）', sd > spread * 0.4, String(sd));
}

{
  // SMG impact: a small puff, no burn stacks.
  const sim = freshSim();
  const e = addEnemy(sim, 3, 0, 1000);
  const bullet = { pos: { x: 2.9, y: 0 }, vel: { x: 300, y: 0 }, r: 0.12, life: 0.4, damage: 10 };
  PROJECTILES.smgRound.onHit(sim, bullet, e, { x: 2.9, y: 0 });
  check('冲锋枪命中不叠燃烧层', e.burns.length === 0, String(e.burns.length));
  check('冲锋枪命中产生冲击粒子', sim.particles.length === 6, String(sim.particles.length));
}

{
  // Time to kill a 100 HP chaser with 10 damage rounds. The death frame includes the bullet's
  // flight time (2.4 units at 100 u/s = 0.024s), hence the +3 frames of slack.
  const sim = freshSim('smg');
  const e = addEnemy(sim, 3.2, 0, 100);
  let frames = 0;
  while (e.alive && frames < 300) { sim.update(DT, firing); sim.spawnQueue = 0; frames++; }
  // 10 rounds at 10 damage, i.e. 9 cadence gaps, plus the bullet's flight (2.4 units at 100 u/s) —
  // so the expected time is DERIVED from the cadence, not hard-coded (the rate is a tunable).
  const ttk = 9 * WEAPONS.smg.cooldown;
  check(`冲锋枪击杀 100HP 追击者 = 10 发 / ${ttk.toFixed(3)}s（+飞行时间）`,
    e.hp <= 0 && frames * DT >= ttk - 1e-9 && frames * DT <= ttk + 3 * DT,
    `frames=${frames} t=${(frames * DT).toFixed(4)} expected≈${ttk.toFixed(3)}s`);
}

{
  // Sustained output per magazine cycle (documented balance numbers).
  const smg = WEAPONS.smg;
  const shot = WEAPONS.dragonBreath;
  const smgDps = (smg.magSize * smg.projectile.damage) / (smg.magSize * smg.cooldown + smg.reloadTime);
  const perVolley = shot.pellets * shot.projectile.damage;
  const shotDps = (shot.magSize * perVolley) / (shot.magSize * shot.cooldown + shot.reloadTime);
  check(`冲锋枪持续 dps ≈ ${smgDps.toFixed(1)}（30×10 /（30×${smg.cooldown.toFixed(4)} + 1.5））`,
    near(smgDps, 300 / (smg.magSize * smg.cooldown + smg.reloadTime), 1e-9), smgDps.toFixed(3));
  check('散弹枪持续直击 dps ≈ 81.3（8×64 / 6.3s）', near(shotDps, 81.27, 0.01), shotDps.toFixed(3));
}

// ------------------------------------------------------------------ 后坐力 / 镜头抖动
// 「枪械添加后坐力，开枪时有镜头抖动」: `shake` (the random rattle) already existed per weapon; this
// section covers the RECOIL added on top — a directional kick opposite the shot line, accumulated and
// decayed by the sim, which the renderer adds to the camera pose (see game.ts::addRecoil and the
// camera-pose assertion in verify-postfx.mjs).
{
  const ids = ['smg', 'dragonBreath', 'rpg'];
  check('每把远程武器都声明了 recoil（数字、非负）',
    ids.every((id) => Number.isFinite(getWeapon(id).recoil) && getWeapon(id).recoil >= 0),
    ids.map((id) => id + '=' + getWeapon(id).recoil).join(' '));
  check('后坐力按武器重量排序：RPG 0.90 > 龙息 0.30 > 冲锋枪 0.10 > 0（重枪踢得更狠）',
    getWeapon('rpg').recoil > getWeapon('dragonBreath').recoil
    && getWeapon('dragonBreath').recoil > getWeapon('smg').recoil
    && getWeapon('smg').recoil > 0);
  check('近战（砍刀）不踢镜头：recoil 0（本轮只做枪械）', getWeapon('sword').recoil === 0);

  // One shot, aimed at +X: the kick must point the other way, and be that weapon's magnitude minus the
  // one frame of decay the sim applies in the same update().
  {
    const sim = freshSim('rpg');
    run(sim, DT, firing);
    check('RPG 开火 → 镜头沿射击反方向被推开（x 为负、z 为 0）',
      sim.recoilX < 0 && sim.recoilZ === 0, `${sim.recoilX} , ${sim.recoilZ}`);
    const decayed = getWeapon('rpg').recoil * Math.pow(0.001, DT);
    check('…幅度 = recoil × 一帧衰减（0.90 × 0.891 = 0.802）',
      near(sim.recoilX, -decayed, 1e-9), `${sim.recoilX} vs ${-decayed}`);
  }

  // Aiming the other way flips the kick: it tracks the shot, not the world.
  {
    const sim = freshSim('rpg');
    run(sim, DT, { move: { x: 0, y: 0 }, aim: { x: -1, y: 0 }, firing: true, autoAim: false });
    check('换个方向开枪 → 推力跟着转（aim -X → recoilX 为正）', sim.recoilX > 0,
      String(sim.recoilX));
  }

  // Recovery: gone in well under a second, and a burst settles at a bounded push rather than drifting.
  {
    const sim = freshSim('smg');
    run(sim, 0.5, firing);
    const during = Math.hypot(sim.recoilX, sim.recoilZ);
    run(sim, 1.0, idle);
    check('松开扳机 1 秒后后坐力回到 0（精确清零，不留亚像素漂移）',
      sim.recoilX === 0 && sim.recoilZ === 0, `${sim.recoilX} , ${sim.recoilZ}`);
    check('冲锋枪连射的稳态推挤有界（0.05–0.3 世界单位，不会把相机走丢）',
      during > 0.05 && during < 0.3, during.toFixed(3));
  }

  // A refused shot must not kick: no ammo left (dragon breath, 8 shells then a 1.5s reload).
  {
    const sim = freshSim('dragonBreath');
    sim.player.ammo = 0;
    sim.inventory = { ...sim.inventory };
    run(sim, DT, firing);
    check('打空（无弹可射）时不产生后坐力', sim.recoilX === 0 && sim.recoilZ === 0,
      `${sim.recoilX} , ${sim.recoilZ}`);
  }

  // The API itself must survive dirt: a zero / non-finite direction or amount must be ignored, never
  // propagated into the camera pose as a NaN.
  {
    const sim = freshSim('smg');
    sim.addRecoil(NaN, 1, 0);
    sim.addRecoil(0.5, 0, 0);
    sim.addRecoil(0.5, NaN, 1);
    sim.addRecoil(-1, 1, 0);      // negative amount just kicks the other way
    check('脏数据不会进相机位姿：NaN/零方向被忽略，负值允许',
      Number.isFinite(sim.recoilX) && Number.isFinite(sim.recoilZ) && near(sim.recoilX, -1, 1e-12)
      && sim.recoilZ === 0, `${sim.recoilX} , ${sim.recoilZ}`);
    sim.addRecoil(99, 1, 0);
    sim.addRecoil(99, 1, 0);
    check('累加幅度有硬上限（RECOIL_MAX = 2 世界单位）',
      Math.hypot(sim.recoilX, sim.recoilZ) <= 2 + 1e-9,
      String(Math.hypot(sim.recoilX, sim.recoilZ)));
  }

  // The aim itself is untouched: the stick owns the aim, the recoil only moves the camera.
  {
    const sim = freshSim('smg');
    run(sim, 0.35, firing);
    check('后坐力不改瞄准方向（aimAngle 仍由摇杆决定）',
      near(sim.player.aimAngle, 0, 1e-9), String(sim.player.aimAngle));
  }
}

// ------------------------------------------------------------------ 三参数可独立配置
{
  // A synthetic weapon proves magSize / reloadTime / cooldown are DATA, not hardcoded per
  // weapon. Registered at runtime and removed again — `getWeapon()` reads the registry live.
  WEAPONS.__probe = {
    id: '__probe', name: '探针', kind: 'ranged', cooldown: 0.2, shake: 0, recoil: 0,
    projectile: PROJECTILES.smgRound, ammoId: 'ammo9mm', pellets: 1, spread: 0, muzzleOffset: 0.2,
    magSize: 3, reloadTime: 0.5,
  };
  const sim = freshSim();
  sim.equipWeapon('__probe');
  check('equipWeapon 把探针弹夹填满（3 发）', sim.player.ammo === 3, String(sim.player.ammo));
  const shots = trackShots(sim);
  run(sim, 1.45, firing);
  checkSpacing('探针：3 发 × 0.2s + 0.5s 换弹 = 0.2/0.4/0.9/1.1/1.3',
    shotTimes(shots), [0, 0.2, 0.4, 0.9, 1.1, 1.3]);
  delete WEAPONS.__probe;
  check('探针已从注册表移除', !('__probe' in WEAPONS));
}

// ------------------------------------------------------------------ 换武器 / 无弹夹 / 重置
{
  const sim = freshSim('dragonBreath');
  run(sim, 4.3, firing);              // shotgun empty -> reloading
  check('换枪前正在换弹', sim.player.reloadTimer > 0);
  sim.equipWeapon('smg');
  check('换枪补满新弹夹并取消换弹',
    sim.player.weaponId === 'smg' && sim.player.ammo === 30 && sim.player.reloadTimer === 0 && sim.fireTimer === 0,
    `ammo=${sim.player.ammo} timer=${sim.player.reloadTimer}`);
}

{
  // rpg: magSize 0 -> no magazine, no reload. SINCE THE RESERVE SYSTEM every shot spends one rocket
  // straight out of the backpack, and an empty reserve means the trigger does nothing at all.
  // Cadence is unchanged while rockets last.
  const sim = freshSim();
  sim.equipWeapon('rpg');
  sim.addAmmo('ammoRocket', 20);       // plenty, so the cadence assertion measures cadence
  const before = sim.reserveOf('ammoRocket');
  const shots = trackShots(sim);
  run(sim, 10.0, firing);
  const times = shotTimes(shots);
  check('火箭筒永不换弹', sim.player.reloadTimer === 0 && sim.player.ammo === 0 && sim.player.reloadTotal === 0);
  checkSpacing('火箭筒射速仍是 1.6s', times, times.map((_, i) => i * 1.6));
  check('火箭筒每发扣 1 发备弹（备弹 = 背包里的火箭弹）',
    before - sim.reserveOf('ammoRocket') === times.length,
    `${before} -> ${sim.reserveOf('ammoRocket')} / ${times.length} shots`);
}

{
  // Magazine-less weapon with an EMPTY reserve: no shots at all, and no reload loop grinding away.
  const sim = freshSim();
  sim.equipWeapon('rpg');
  for (let i = 0; i < sim.inventory.bag.length; i++) {
    const it = sim.inventory.bag[i];
    if (it && it.kind === 'ammo' && it.ammoId === 'ammoRocket') sim.inventory.bag[i] = null;
  }
  const shots = trackShots(sim);
  run(sim, 5.0, firing);
  check('火箭弹打光后不开火', shots.length === 0, String(shots.length));
  check('无备弹时不会进入换弹循环（startReload 前置 reserveOf > 0）',
    sim.player.reloadTimer === 0 && sim.player.reloadTotal === 0, String(sim.player.reloadTimer));
}

{
  // Melee: no magazine, swings as before.
  const sim = freshSim();
  sim.equipWeapon('sword');
  const e = addEnemy(sim, 2.0, 0, 100);
  sim.update(DT, firing);
  check('近战不进入换弹状态', sim.player.reloadTimer === 0 && sim.player.ammo === 0);
  check('近战照常挥砍（0.5s 冷却 + 34 伤害）', near(sim.fireTimer, 0.5, DT + 1e-6) && e.hp === 66,
    `fireTimer=${sim.fireTimer} hp=${e.hp}`);
}

{
  // No aim direction: a ranged weapon must not spend a round (fireWeapon returns false).
  const sim = freshSim('dragonBreath');
  const shots = trackShots(sim);
  run(sim, 1.0, { move: { x: 0, y: 0 }, aim: { x: 0, y: 0 }, firing: true, autoAim: false });
  check('无瞄准方向不消耗弹药、不生成弹丸', shots.length === 0 && sim.player.ammo === 8,
    `shots=${shots.length} ammo=${sim.player.ammo}`);
  check('无瞄准方向走短重试（noAimRetry）', near(sim.fireTimer, CONFIG.noAimRetry, DT + 1e-6), String(sim.fireTimer));
}

{
  const sim = freshSim('dragonBreath');
  run(sim, 3.0, firing);
  sim.reset();
  check('reset() 回到默认武器（冲锋枪）+ 满弹夹',
    sim.player.weaponId === DEFAULT_WEAPON && sim.player.ammo === magSizeOf(WEAPONS[DEFAULT_WEAPON]) &&
    sim.player.reloadTimer === 0 && sim.player.reloadTotal === 0,
    `weapon=${sim.player.weaponId} ammo=${sim.player.ammo}`);
}

{
  // 100 HP chaser still dies to 2 shotgun volleys (the death frame includes bullet flight:
  // 2.4 units at 90 u/s = 0.027s, so allow a few frames of slack).
  const sim = freshSim('dragonBreath');
  const e = addEnemy(sim, 3.2, 0, 100);
  let frames = 0;
  while (e.alive && frames < 300) { sim.update(DT, firing); sim.spawnQueue = 0; frames++; }
  check('散弹枪击杀 100HP 追击者仍是 2 次齐射 / 0.6s（+飞行时间）',
    e.hp <= 0 && frames * DT >= 0.6 - 1e-9 && frames * DT <= 0.6 + 4 * DT,
    `frames=${frames} t=${(frames * DT).toFixed(4)}`);
}

// ------------------------------------------------------------------ HUD 读数（纯函数 hud.ts）
{
  // The reserve is now part of every ammo string («备弹 N»), the level rides along as a number the
  // renderer turns into a colour, and a magazine-less weapon has no magazine bar at all.
  const full = ammoReadout(8, 8, 0, 0, 143, 3);
  check('HUD：满弹夹显示 8/8 · 备弹 143 且条满',
    full.text === '8/8 · 备弹 143' && near(full.ratio, 1) && full.reloading === false &&
    full.dry === false && full.nobar === false && full.level === 3, JSON.stringify(full));
  const part = ammoReadout(3, 8, 0, 0, 10, 2);
  check('HUD：3/8 · 备弹 10，条宽 37.5%',
    part.text === '3/8 · 备弹 10' && near(part.ratio, 0.375) && part.reloading === false, JSON.stringify(part));
  const rel = ammoReadout(0, 30, 1.5, 1.5, 0, 2);
  check('HUD：换弹开始显示「换弹中」且条为 0',
    rel.text === '换弹中' && near(rel.ratio, 0) && rel.reloading === true && rel.dry === false,
    JSON.stringify(rel));
  const mid = ammoReadout(0, 30, 0.75, 1.5, 12, 2);
  check('HUD：换弹到一半条为 50%', near(mid.ratio, 0.5) && mid.reloading === true, JSON.stringify(mid));
  const almost = ammoReadout(0, 30, 0.001, 1.5, 12, 2);
  check('HUD：换弹快结束时条接近满且被钳制在 1 以内',
    almost.ratio > 0.99 && almost.ratio <= 1, String(almost.ratio));
  const dry = ammoReadout(0, 30, 0, 0, 0, 2);
  check('HUD：弹夹与备弹都空 = 0/30 · 无备弹（dry 标记供样式变红）',
    dry.text === '0/30 · 无备弹' && dry.dry === true && dry.reloading === false, JSON.stringify(dry));
  check('HUD：弹夹空但还有备弹不算 dry（换一次弹就能打）',
    ammoReadout(0, 30, 0, 0, 7, 2).dry === false);
  const nomag = ammoReadout(0, 0, 0, 0, 4, 5);
  check('HUD：无弹夹武器显示备弹数并隐藏弹夹条（不再显示 ∞）',
    nomag.text === '备弹 4' && nomag.nobar === true && nomag.dry === false && near(nomag.ratio, 1),
    JSON.stringify(nomag));
  const nomagDry = ammoReadout(0, 0, 0, 0, 0, 5);
  check('HUD：无弹夹 + 无备弹 = 无备弹', nomagDry.text === '无备弹' && nomagDry.dry === true,
    JSON.stringify(nomagDry));
  check('HUD：没有等级的武器 level = null（近战 / 空手）',
    ammoReadout(0, 0, 0, 0, 0, null).level === null);
  check('HUD：等级越界被钳制在 1..6',
    ammoReadout(0, 0, 0, 0, 0, 9).level === 6 && ammoReadout(0, 0, 0, 0, 0, 0).level === 1);
  check('HUD：reloadTotal 为 0 时不除零', reloadBarProgress(0.5, 0) === 0 && reloadBarProgress(0.5, -1) === 0);
  check('HUD：换弹进度端点与钳制',
    reloadBarProgress(1.5, 1.5) === 0 && reloadBarProgress(0, 1.5) === 1 &&
    reloadBarProgress(0.75, 1.5) === 0.5 && reloadBarProgress(-1, 1.5) === 1 && reloadBarProgress(9, 1.5) === 0);
}

// ------------------------------------------------------------------ report
console.log(`\nverify-ammo: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error('  FAIL  ' + f);
  process.exit(1);
}
