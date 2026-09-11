/**
 * CPU-side verification for the GUNNER: the PvE cover-shooter enemy.
 *
 * Rules under test (these ARE the design brief — "敌人拿枪、攻击欲望低、尽量站在原地"):
 *   - MOVEMENT has three zones: approach outside `range + slack`, PLANT (velocity exactly zero)
 *     inside `range ± slack`, back off when the player closes inside `range - slack`. Plus: it only
 *     approaches while the player is within its `sight` budget, so it does not march across the map;
 *   - it HOLDS FIRE without line of sight. Cover is not an accuracy modifier, it is a switch: this
 *     is what makes ducking behind a crate a real answer;
 *   - LOW AGGRESSION is a long cycle (`aimTime + fireCd`) with a telegraph at the end of it, and the
 *     telegraph always precedes the shot by exactly `aimTime`;
 *   - breaking line of sight (or leaving the band) rewinds the cycle to exactly ONE telegraph, so
 *     re-engaging always gives the player the full warning;
 *   - enemy rounds are slow and hostile-coloured, they damage the player, they are consumed on a hit,
 *     and the player's i-frames cap the incoming rate (the de-facto DPS ceiling);
 *   - no friendly fire: an enemy round passes through other enemies;
 *   - spawns come from a ring around the PLAYER, never inside cover, never inside the arena wall,
 *     and never on top of the player.
 *
 * Run:  npm run build && node scripts/verify-gunner.mjs
 * Exit code is non-zero when any assertion fails.
 */
const GAME = new URL('../dist/apps/shooter/src/game.js', import.meta.url);
const CONFIG_URL = new URL('../dist/apps/shooter/src/config.js', import.meta.url);
const PROJ_URL = new URL('../dist/apps/shooter/src/projectiles.js', import.meta.url);
const LEVEL = new URL('../dist/apps/shooter/src/level.js', import.meta.url);

const { GameSim } = await import(GAME.href);
const { CONFIG, ARENA_HALF } = await import(CONFIG_URL.href);
const { PROJECTILES } = await import(PROJ_URL.href);
const { OBSTACLES, overlapsCover } = await import(LEVEL.href);

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ' — ' + detail : ''));
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

const DT = 1 / 60;
const idle = { move: { x: 0, y: 0 }, aim: { x: 0, y: 0 }, firing: false, autoAim: false };
const CYCLE = CONFIG.gunnerAimTime + CONFIG.gunnerFireCd;
const BAND = CONFIG.gunnerRange + CONFIG.gunnerRangeSlack;
const INNER = CONFIG.gunnerRange - CONFIG.gunnerRangeSlack;

/** Sim with an empty arena (AI behaviour) by default; pass obstacles for cover scenarios. */
function freshSim(obstacles = []) {
  const sim = new GameSim();
  sim.spawnQueue = 0;
  sim.spawnTimer = 0;
  sim.enemies = [];
  sim.obstacles = obstacles;
  sim.equipWeapon('smg');
  // THIS SUITE TESTS THE RAW DAMAGE / I-FRAME RULES, not the armour split: the starting loadout
  // equips a level-3 plate and the gunner round is also level 3, which would halve every number
  // below into something these assertions are not about. The plate is therefore cleared here, and
  // the armour model (level ladder, 50%/75%/100% flesh, plate break, chip damage) is asserted in
  // scripts/verify-inventory.mjs instead.
  sim.inventory.slots.armor = null;
  return sim;
}

/** A gunner `d` units from the player along +x, with the trigger already wound up. */
function addGunner(sim, d, opts = {}) {
  const e = {
    id: 900 + sim.enemies.length, pos: { x: d, y: 0 }, vel: { x: 0, y: 0 }, r: CONFIG.enemyR,
    hp: CONFIG.gunnerHp, maxHp: CONFIG.gunnerHp, alive: true, kind: 'gunner',
    speed: CONFIG.gunnerSpeed, touchDmg: CONFIG.touchDmg, hitFlash: 0, touchCd: 0,
    burns: [], flameAcc: 0,
    fireT: opts.fireT !== undefined ? opts.fireT : CONFIG.gunnerAimTime, aiming: false,
  };
  sim.enemies.push(e);
  return e;
}

function run(sim, seconds, input = idle) {
  const frames = Math.round(seconds / DT);
  for (let i = 0; i < frames; i++) { sim.update(DT, input); sim.spawnQueue = 0; }
}

/** Times (sim seconds) at which a NEW enemy round appeared, sampled per frame. */
function enemyShotTimes(sim, seconds) {
  const seen = new Set();
  const times = [];
  const frames = Math.round(seconds / DT);
  for (let i = 0; i < frames; i++) {
    sim.update(DT, idle);
    sim.spawnQueue = 0;
    for (const b of sim.bullets) {
      if (b.fromPlayer || seen.has(b)) continue;
      seen.add(b);
      times.push(sim.time);
    }
  }
  return times;
}

// --------------------------------------------------------------------------- config sanity
{
  check('枪手血量 > 0', CONFIG.gunnerHp > 0, String(CONFIG.gunnerHp));
  check('冷却明显长于预警（低攻击欲望：预警只是临门一脚）',
    CONFIG.gunnerFireCd > CONFIG.gunnerAimTime, `${CONFIG.gunnerFireCd} vs ${CONFIG.gunnerAimTime}`);
  check('预警足够长，玩家来得及看到并找掩体（>= 0.4s）', CONFIG.gunnerAimTime >= 0.4, String(CONFIG.gunnerAimTime));
  check('射程带是正的（range > slack）', CONFIG.gunnerRange > CONFIG.gunnerRangeSlack);
  check('视野大于射程带（否则永远进不了射程）', CONFIG.gunnerSight > BAND, `${CONFIG.gunnerSight} vs ${BAND}`);

  // "Dodgeable" is about GUNFIRE, so the comparison excludes the THROWN grenade (20 u/s): it is
  // lobbed ordnance with a fuse, not a bullet the player has to out-run, and including it would make
  // this assertion say something it was never about.
  const gunfire = Object.values(PROJECTILES).filter((p) => p.id !== 'enemyRound' && p.id !== 'grenade');
  const slowestPlayer = Math.min(...gunfire.map((p) => p.speed));
  check('敌人子弹比玩家最慢的枪弹还慢（可躲）',
    PROJECTILES.enemyRound.speed < slowestPlayer,
    `${PROJECTILES.enemyRound.speed} vs ${slowestPlayer}`);
  check('敌人子弹是敌方阵营（fromPlayer 由 sim 决定，def 独立于玩家武器）',
    PROJECTILES.enemyRound.id === 'enemyRound' && PROJECTILES.enemyRound.damage > 0,
    PROJECTILES.enemyRound.id);
  check('敌人子弹 life 覆盖最坏飞行距离（> 2*ARENA_HALF / speed）',
    PROJECTILES.enemyRound.life > (2 * ARENA_HALF) / PROJECTILES.enemyRound.speed,
    `${PROJECTILES.enemyRound.life}s vs ${((2 * ARENA_HALF) / PROJECTILES.enemyRound.speed).toFixed(2)}s`);
  check('生成环在枪手自己的射程带之外（出生后必须走位，不能一出生就开火）',
    CONFIG.spawnRingMin > BAND, `${CONFIG.spawnRingMin} vs ${BAND}`);
  check('生成环在场地内（min 和 max 都 < 场地半边长）',
    CONFIG.spawnRingMax < ARENA_HALF, `${CONFIG.spawnRingMax} vs ${ARENA_HALF}`);
}

// ------------------------------------------------------------------------ movement zones
{
  // Approach: far away, clear line -> closes in at gunnerSpeed.
  const approaching = freshSim();
  const far = addGunner(approaching, 30);
  const d0 = Math.hypot(far.pos.x, far.pos.y);
  run(approaching, 1);
  const d1 = Math.hypot(far.pos.x, far.pos.y);
  check('远距离会缓慢靠近', d1 < d0 - CONFIG.gunnerSpeed * 0.8,
    `${d0.toFixed(2)} -> ${d1.toFixed(2)}（期望约 ${(d0 - CONFIG.gunnerSpeed).toFixed(2)}）`);
  check('靠近速度不超过 gunnerSpeed（低攻击欲望，不是冲锋）',
    d0 - d1 <= CONFIG.gunnerSpeed * 1.05, `实际 ${(d0 - d1).toFixed(3)}/s`);

  // Plant: inside the band the gunner's velocity is EXACTLY zero and it does not drift.
  const planted = freshSim();
  const mid = addGunner(planted, CONFIG.gunnerRange);
  const px = mid.pos.x;
  const py = mid.pos.y;
  run(planted, 1.5);
  check('射程带内速度恰好为 0（「尽量站在原地」的核心）',
    mid.vel.x === 0 && mid.vel.y === 0, `${mid.vel.x},${mid.vel.y}`);
  check('射程带内位置完全不动', mid.pos.x === px && mid.pos.y === py, `${mid.pos.x},${mid.pos.y}`);

  // Back off: the player closes inside range - slack.
  const backing = freshSim();
  const close = addGunner(backing, INNER - 2);
  const before = Math.hypot(close.pos.x, close.pos.y);
  run(backing, 1);
  const after = Math.hypot(close.pos.x, close.pos.y);
  check('玩家贴脸时会缓慢后撤（不是站桩挨打）', after > before, `${before.toFixed(2)} -> ${after.toFixed(2)}`);
  check('后撤速度低于靠近速度（后撤是让步，不是逃跑）',
    (after - before) < CONFIG.gunnerSpeed * 1.05, `实际 ${(after - before).toFixed(3)}/s`);

  // Beyond sight it holds ground rather than walking the whole map.
  // NOTE: both actors have to start INSIDE the arena — otherwise the arena clamp moves the gunner on
  // the first frame and the test measures clamping instead of the AI (this caught itself once).
  const holding = freshSim();
  holding.player.pos.x = -20;
  const beyond = addGunner(holding, 20);          // 40 units apart, > gunnerSight
  const hx = beyond.pos.x;
  run(holding, 1);
  check('前提成立：两者距离确实超过 gunnerSight',
    Math.hypot(beyond.pos.x - holding.player.pos.x, beyond.pos.y - holding.player.pos.y) > CONFIG.gunnerSight);
  check('超出视野就不追（低攻击欲望：不会横穿地图）', beyond.pos.x === hx, `${hx} -> ${beyond.pos.x}`);
}

// ------------------------------------------------------------------- firing and telegraph
{
  // The telegraph must precede the shot by exactly gunnerAimTime.
  const sim = freshSim();
  addGunner(sim, CONFIG.gunnerRange, { fireT: CONFIG.gunnerAimTime });
  let sawAiming = false;
  let firstShotFrame = -1;
  for (let i = 0; i < 120 && firstShotFrame < 0; i++) {
    sim.update(DT, idle);
    sim.spawnQueue = 0;
    const g = sim.enemies[0];
    if (g.aiming) sawAiming = true;
    if (sim.bullets.some((b) => !b.fromPlayer)) firstShotFrame = i;
  }
  check('开火前会出现预警状态（aiming）', sawAiming);
  const firstShotAt = (firstShotFrame + 1) * DT;
  check('第一枪恰好发生在预警结束（≈ gunnerAimTime）',
    Math.abs(firstShotAt - CONFIG.gunnerAimTime) <= 2 * DT,
    `${firstShotAt.toFixed(3)}s vs ${CONFIG.gunnerAimTime}s`);
  check('预警期间没有子弹（预警不是装饰）', firstShotFrame > 0, String(firstShotFrame));

  // Cadence: one shot per aimTime + fireCd.
  const cadence = freshSim();
  addGunner(cadence, CONFIG.gunnerRange);
  const times = enemyShotTimes(cadence, CYCLE * 2.2);
  check('至少打出 2 枪（节奏可测）', times.length >= 2, String(times.length));
  if (times.length >= 2) {
    const gap = times[1] - times[0];
    check('开火间隔 = 预警 + 冷却（低攻击欲望的节拍）',
      Math.abs(gap - CYCLE) <= 2 * DT, `${gap.toFixed(3)}s vs ${CYCLE}s`);
    check('开火频率远低于玩家武器（不是对枪）',
      1 / gap < 1 / CONFIG.gunnerFireCd, `${(1 / gap).toFixed(2)} 发/秒`);
  }
  check('两轮内不会狂喷子弹（同屏敌方子弹很少）',
    cadence.bullets.filter((b) => !b.fromPlayer).length <= 2,
    String(cadence.bullets.filter((b) => !b.fromPlayer).length));

  // Out of range: no shooting. Speed is pinned to 0 so the gunner cannot walk into the band and
  // turn this into a test of approach timing instead of the range gate.
  const tooFar = freshSim();
  const standoff = addGunner(tooFar, BAND + 3);
  standoff.speed = 0;
  check('超出射程带不开火', enemyShotTimes(tooFar, CYCLE).length === 0, `${BAND + 3} 单位, speed=0`);
  check('对照组：枪手平时是会走位进射程的（速度 > 0）', CONFIG.gunnerSpeed > 0);

  // No line of sight: no shooting, and the telegraph drops immediately.
  const wall = [{ x: 6, y: 0, hw: 1, hh: 6, h: 2.5 }];
  const blocked = freshSim(wall);
  const hidden = addGunner(blocked, 10);
  run(blocked, CYCLE * 1.2);
  check('视线被掩体挡住就不开火（掩体是开关，不是精度修正）',
    blocked.bullets.filter((b) => !b.fromPlayer).length === 0,
    String(blocked.bullets.filter((b) => !b.fromPlayer).length));
  check('视线被挡时预警立刻取消（不会保留一个假的倒计时）', hidden.aiming === false);

  // Dead player: nothing shoots.
  const over = freshSim();
  addGunner(over, CONFIG.gunnerRange);
  over.player.alive = false;
  check('玩家已死时不开火', enemyShotTimes(over, CYCLE).length === 0);
}

// ----------------------------------------------------------------- re-engage re-telegraphs
{
  const sim = freshSim();
  const g = addGunner(sim, CONFIG.gunnerRange, { fireT: 0.001 });  // this frame is the shot
  sim.update(DT, idle);
  check('临门一脚时会开火', sim.bullets.some((b) => !b.fromPlayer));
  // Now break the engagement by teleporting the player far away, then bring them back.
  const firstShotCount = sim.bullets.filter((b) => !b.fromPlayer).length;
  sim.player.pos.x = -(ARENA_HALF - 5);
  run(sim, 0.5);
  sim.player.pos.x = 0;
  sim.player.pos.y = 0;
  g.pos.x = CONFIG.gunnerRange;   // back into the band
  g.pos.y = 0;
  let aimingSeen = false;
  let framesToShot = -1;
  for (let i = 0; i < 60; i++) {
    sim.update(DT, idle);
    sim.spawnQueue = 0;
    if (g.aiming) aimingSeen = true;
    if (sim.bullets.filter((b) => !b.fromPlayer).length > firstShotCount) { framesToShot = i; break; }
  }
  check('重新进入交战会先重新预警（脱战不保留进度）', aimingSeen);
  check('重新交战后仍要等满一个预警才开枪',
    framesToShot >= 0 && Math.abs((framesToShot + 1) * DT - CONFIG.gunnerAimTime) <= 3 * DT,
    framesToShot < 0 ? '没开枪' : `${((framesToShot + 1) * DT).toFixed(3)}s`);
}

// -------------------------------------------------------------------- rounds hurt the player
{
  const sim = freshSim();
  sim.player.pos.x = 0;
  // 6 units, not 10: the shipped spread (+-0.09 rad) puts a round at most 0.09*6 = 0.54 units off
  // centre, comfortably inside the 0.73 hit radius. At 10 units the offset is 0.9 and every damage
  // assertion below would flip a coin on whether the round lands at all.
  const g = addGunner(sim, 6);
  // Fire one round and let it fly; the player stands still.
  const hp0 = sim.player.hp;
  g.fireT = 0.001;
  sim.update(DT, idle);
  check('开火产生了敌方子弹', sim.bullets.some((b) => !b.fromPlayer));
  // Step frame by frame and inspect the state ON THE HIT FRAME: the i-frame timer (0.6s) and the
  // blood particles (0.3-0.65s) have both expired by the end of a blanket `run(1.2s)`, so checking
  // afterwards would silently assert the opposite of what it claims.
  let hitFrame = -1;
  for (let i = 0; i < 120; i++) {
    sim.update(DT, idle);
    sim.spawnQueue = 0;
    if (sim.player.hp < hp0) { hitFrame = i; break; }
  }
  check('敌方子弹命中玩家会扣血', hitFrame >= 0, `${hp0} -> ${sim.player.hp}`);
  check('扣血量 = gunnerDamage', near(hp0 - sim.player.hp, CONFIG.gunnerDamage, 1e-9),
    String(hp0 - sim.player.hp));
  check('命中当帧就触发受击特效', sim.particles.length > 0, String(sim.particles.length));
  check('命中当帧玩家进入无敌帧', sim.player.invuln > 0, String(sim.player.invuln));
  check('子弹命中后被消耗（不会留在身体里二次命中）',
    sim.bullets.filter((b) => !b.fromPlayer).length === 0,
    String(sim.bullets.filter((b) => !b.fromPlayer).length));
  run(sim, CONFIG.contactInvuln + 0.1);
  check('无敌帧会正常过期（不是永久免疫）', sim.player.invuln === 0, String(sim.player.invuln));
}

// --------------------------------------------------------------------- i-frames cap the DPS
{
  const sim = freshSim();
  const hp0 = sim.player.hp;
  sim.player.pos.x = 0;
  sim.player.pos.y = 0;
  // Three gunners firing in the same frame: only ONE hit may land (0.6s of i-frames).
  for (const d of [6, 7, 8]) addGunner(sim, d, { fireT: 0.001 });   // close enough that spread cannot miss
  sim.update(DT, idle);
  const rounds = sim.bullets.filter((b) => !b.fromPlayer).length;
  check('三名枪手同帧开火（压力测试前提）', rounds >= 2, String(rounds));
  run(sim, 1.5);
  check('无敌帧把同批次命中压成一次伤害',
    near(hp0 - sim.player.hp, CONFIG.gunnerDamage, 1e-9), `实际扣 ${hp0 - sim.player.hp}`);

  // The cap is a RATE: with damage dmg and 0.6s i-frames, DPS can never exceed dmg/0.6 per shooter
  // batch. Assert the observed damage over a long window stays under that ceiling.
  const long = freshSim();
  long.player.pos.x = 0;
  long.player.pos.y = 0;
  for (const d of [6, 7, 8]) addGunner(long, d);
  const before = long.player.hp;
  run(long, CYCLE * 2);
  const ceiling = (CONFIG.gunnerDamage / CONFIG.contactInvuln) * CYCLE * 2 + CONFIG.gunnerDamage;
  check('长时间承伤不超过无敌帧给出的理论上限',
    before - long.player.hp <= ceiling,
    `扣 ${(before - long.player.hp).toFixed(1)} / 上限 ${ceiling.toFixed(1)}`);
}

// ------------------------------------------------------------------ player death + friendly fire
{
  const dying = freshSim();
  dying.player.hp = CONFIG.gunnerDamage;    // one round is lethal
  const g = addGunner(dying, 6, { fireT: 0.001 });
  dying.update(DT, idle);
  run(dying, 1.2);
  check('致命命中会让玩家死亡并结束游戏',
    dying.player.alive === false && dying.over === true,
    `alive=${dying.player.alive} over=${dying.over}`);
  check('死亡后血量被夹到 0（不会是负数）', dying.player.hp === 0, String(dying.player.hp));
  void g;

  // No friendly fire: put a chaser directly between a gunner and the player.
  const friendly = freshSim();
  const blocker = {
    id: 1, pos: { x: 5, y: 0 }, vel: { x: 0, y: 0 }, r: CONFIG.enemyR,
    hp: 100, maxHp: 100, alive: true, kind: 'chaser', speed: 0, touchDmg: 16,
    hitFlash: 0, touchCd: 0, burns: [], flameAcc: 0, fireT: 0, aiming: false,
  };
  friendly.enemies.push(blocker);
  addGunner(friendly, 10, { fireT: 0.001 });
  friendly.update(DT, idle);
  run(friendly, 1.5);
  check('敌方子弹穿过友军，不造成友军伤害', blocker.hp === 100, String(blocker.hp));
}

// --------------------------------------------------------------------------- spawn ring
{
  const sim = freshSim(OBSTACLES);
  sim.wave = 3;
  sim.spawnTimer = 0;
  // Spawning is paced by CONFIG.spawnCadence (0.55s), so a realistic sample needs ~20s of sim time.
  // The player is made effectively unkillable first: gunners WILL shoot during those 20 seconds, and
  // a dead player sets `over`, after which update() returns early and spawning stops — the test would
  // measure the player's death instead of the spawn ring.
  sim.player.hp = 1e9;
  sim.spawnQueue = 40;
  // Record each enemy's position ON ITS SPAWN FRAME, not at the end of the run: enemies walk toward
  // the player, so by the end of a 25-second window the early ones are standing at their preferred
  // range (~12 units) and checking "did it spawn in the ring?" against their final position measures
  // their AI instead of the spawner. (Spawning is the LAST step of update(), so an enemy does not
  // move on the frame it appears.)
  const spawned = [];
  for (let i = 0; i < 1500; i++) {
    const n = sim.enemies.length;
    sim.update(DT, idle);
    if (sim.enemies.length > n) {
      const e = sim.enemies[sim.enemies.length - 1];
      spawned.push({ x: e.pos.x, y: e.pos.y, r: e.r, kind: e.kind });
    }
  }
  check('生成器真的产出了足够多的样本', spawned.length >= 25, String(spawned.length));

  const inArena = spawned.every((e) => Math.abs(e.x) <= ARENA_HALF && Math.abs(e.y) <= ARENA_HALF);
  check('所有生成点都在场地内', inArena);

  const inCover = spawned.filter((e) => overlapsCover({ x: e.x, y: e.y }, e.r, OBSTACLES));
  check('没有任何敌人生成在掩体内部', inCover.length === 0, String(inCover.length));

  // Ring placement: with the player at the origin the ring is entirely inside the arena, so the
  // rejection sampler should essentially always succeed — the fallback is a rare safety net.
  const inRing = spawned.filter((e) => {
    const d = Math.hypot(e.x - sim.player.pos.x, e.y - sim.player.pos.y);
    return d >= CONFIG.spawnRingMin - 1 && d <= CONFIG.spawnRingMax + 1;
  });
  check('绝大多数生成点落在玩家周围的环形带内',
    inRing.length / spawned.length >= 0.9, `${inRing.length}/${spawned.length}`);

  const tooClose = spawned.filter((e) => Math.hypot(e.x, e.y) < CONFIG.spawnMinPlayerGap - 1e-9);
  check('没有敌人贴脸生成', tooClose.length === 0, String(tooClose.length));

  const gunners = spawned.filter((e) => e.kind === 'gunner').length;
  const share = gunners / spawned.length;
  check(`枪手占比落在 gunnerShare (${CONFIG.gunnerShare}) 附近（±0.25）`,
    Math.abs(share - CONFIG.gunnerShare) <= 0.25, `实际 ${share.toFixed(2)}（${gunners}/${spawned.length}）`);
  check('存在近战少数派（掩体射击需要被迫离开掩体的压力）',
    spawned.some((e) => e.kind !== 'gunner'), '全是枪手');

  // Even jammed into a corner the sampler must never return a point inside cover.
  const corner = freshSim(OBSTACLES);
  corner.player.pos.x = ARENA_HALF - 1;
  corner.player.pos.y = ARENA_HALF - 1;
  corner.player.hp = 1e9;
  corner.wave = 3;
  corner.spawnTimer = 0;
  corner.spawnQueue = 40;
  const cornerSpawned = [];
  for (let i = 0; i < 1200; i++) {
    const n = corner.enemies.length;
    corner.update(DT, idle);
    if (corner.enemies.length > n) {
      const e = corner.enemies[corner.enemies.length - 1];
      cornerSpawned.push({ x: e.pos.x, y: e.pos.y, r: e.r });
    }
  }
  check('玩家挤在角落时也会产出样本', cornerSpawned.length >= 10, String(cornerSpawned.length));
  check('玩家挤在角落时也不会生成到掩体里或场地外',
    cornerSpawned.every((e) => !overlapsCover({ x: e.x, y: e.y }, e.r, OBSTACLES)
      && Math.abs(e.x) <= ARENA_HALF && Math.abs(e.y) <= ARENA_HALF),
    String(cornerSpawned.length));
}

// ------------------------------------------------------------------------- summary
console.log(`\nverify-gunner: ${passed} 项通过, ${failures.length} 项失败`);
if (failures.length > 0) {
  console.log('\n失败项:');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('全部通过 ✓');
