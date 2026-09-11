/**
 * CPU-side verification for the GUNNER: the PvE cover-shooter enemy.
 *
 * Rules under test (these ARE the design brief — "敌人拿枪、见面瞄 0.5s、然后一梭子、尽量站在原地"):
 *   - MOVEMENT has three zones: approach outside `range + slack`, PLANT (velocity exactly zero)
 *     inside `range ± slack`, back off when the player closes inside `range - slack`. Plus: it only
 *     approaches while the player is within its `sight` budget, so it does not march across the map;
 *   - it HOLDS FIRE without line of sight. Cover is not an accuracy modifier, it is a switch: this
 *     is what makes ducking behind a crate a real answer;
 *   - the TRIGGER is telegraph -> BURST -> reload: `gunnerAimTime` of warning, then a whole magazine
 *     at the WEAPON's cadence, then the WEAPON's reload, then a fresh telegraph;
 *   - the weapon is REUSED, not re-declared: cadence / magazine / reload / spread / pellets all come
 *     off `WEAPONS[CONFIG.gunnerWeapon]`, and CONFIG must not carry second copies of those numbers;
 *   - breaking line of sight (or leaving the band) ABORTS the burst and rewinds to exactly ONE
 *     telegraph, so re-engaging always gives the player the full warning;
 *   - `aiming` (the beam the player reads) and `firing` (the burst) are mutually exclusive states;
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
const WEAPONS_URL = new URL('../dist/apps/shooter/src/weapons.js', import.meta.url);
const LEVEL = new URL('../dist/apps/shooter/src/level.js', import.meta.url);

const { GameSim } = await import(GAME.href);
const { CONFIG, ARENA_HALF } = await import(CONFIG_URL.href);
const { PROJECTILES } = await import(PROJ_URL.href);
const { WEAPONS } = await import(WEAPONS_URL.href);
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
const BAND = CONFIG.gunnerRange + CONFIG.gunnerRangeSlack;
const INNER = CONFIG.gunnerRange - CONFIG.gunnerRangeSlack;

// --- the trigger, as read off the WEAPON (never re-declared in the test either) ---------------
const GUN = WEAPONS[CONFIG.gunnerWeapon];
const AIM = CONFIG.gunnerAimTime;
const CADENCE = GUN.cooldown;
const MAG = GUN.magSize;
const RELOAD = GUN.reloadTime;
/** Seconds from engaging to the last round of the first burst. */
const BURST_SPAN = AIM + (MAG - 1) * CADENCE;
/** Seconds from the first round of one burst to the first round of the next. */
const BURST_CYCLE = BURST_SPAN + RELOAD + AIM;


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
    firing: false, weaponId: CONFIG.gunnerWeapon,
    ammo: opts.ammo !== undefined ? opts.ammo : GUN.magSize, reloadT: 0,
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
    let spawned = false;
    for (const b of sim.bullets) {
      if (b.fromPlayer || seen.has(b)) continue;
      seen.add(b);
      spawned = true;
    }
    // One entry per FRAME, not per bullet: a multi-pellet weapon puts several rounds in the air on
    // the same trigger pull, and what this helper measures is TRIGGER timing.
    if (spawned) times.push(sim.time);
  }
  return times;
}

// --------------------------------------------------------------------------- config sanity
{
  check('枪手血量 > 0', CONFIG.gunnerHp > 0, String(CONFIG.gunnerHp));
  check('预警足够长，玩家来得及看到并找掩体（>= 0.4s）', AIM >= 0.4, String(AIM));
  check('射程带是正的（range > slack）', CONFIG.gunnerRange > CONFIG.gunnerRangeSlack);
  check('视野大于射程带（否则永远进不了射程）', CONFIG.gunnerSight > BAND, `${CONFIG.gunnerSight} vs ${BAND}`);

  // --- the WEAPON is reused, not re-declared ------------------------------------------------
  // These two are the anti-duplication assertions: the old design carried its own cadence
  // (`gunnerFireCd`) and its own accuracy (`gunnerSpread`) in CONFIG. If either ever comes back,
  // the SMG has been forked into two tuning tables that can silently disagree.
  check('枪手开火节奏完全来自武器，CONFIG 不再自带 gunnerFireCd', !('gunnerFireCd' in CONFIG));
  check('枪手精度完全来自武器，CONFIG 不再自带 gunnerSpread', !('gunnerSpread' in CONFIG));
  check('gunnerWeapon 指向一把真实存在的武器', !!GUN, String(CONFIG.gunnerWeapon));
  check('枪手武器是远程武器', GUN && GUN.kind === 'ranged', GUN && GUN.kind);
  check('枪手武器有弹夹（一梭子 = 打空一个弹夹，无弹夹武器没有"一梭子"）', MAG > 0, String(MAG));
  check('枪手武器有换弹时间（弹夹打空后必须能回到满弹夹）', RELOAD > 0, String(RELOAD));

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
  check('复用武器不等于复用弹丸：敌人用的仍是敌方弹丸（否则玩家曳光无法区分）',
    GUN.projectile.id !== PROJECTILES.enemyRound.id,
    `${GUN.projectile.id} vs ${PROJECTILES.enemyRound.id}`);
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
  check('靠近速度不超过 gunnerSpeed（低移动欲望，不是冲锋）',
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
  check('超出视野就不追（低移动欲望：不会横穿地图）', beyond.pos.x === hx, `${hx} -> ${beyond.pos.x}`);
}

// ------------------------------------------------- telegraph -> burst -> reload (the new trigger)
{
  // The telegraph must precede the FIRST round of the burst by exactly gunnerAimTime.
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
    Math.abs(firstShotAt - AIM) <= 2 * DT,
    `${firstShotAt.toFixed(3)}s vs ${AIM}s`);
  check('预警期间没有子弹（预警不是装饰）', firstShotFrame > 0, String(firstShotFrame));

  // --- the BURST: one magazine, at the weapon's cadence ---------------------------------------
  // Sample to just past the middle of the reload: that window contains the WHOLE first magazine but
  // not the second one (which only starts after reload + a fresh telegraph).
  const burst = freshSim();
  addGunner(burst, CONFIG.gunnerRange);
  const times = enemyShotTimes(burst, BURST_SPAN + RELOAD * 0.5);
  check('一梭子确实打出整个弹夹', times.length === MAG, `${times.length} 发 / 弹夹 ${MAG}`);
  check('预警期间没有子弹（第一发前有完整预警）',
    times.length > 0 && Math.abs(times[0] - AIM) <= 2 * DT, times.length ? `${times[0].toFixed(3)}s` : '无');

  if (times.length >= 2) {
    // Spacing inside the burst == the weapon's cadence, not an average of the whole cycle.
    const intra = [];
    for (let i = 1; i < times.length; i++) intra.push(times[i] - times[i - 1]);
    const worst = Math.max(...intra.map((g) => Math.abs(g - CADENCE)));
    check('梭内每一发的间隔 = 武器射速（carry 余量，逐发不漂移）',
      worst <= DT + 1e-6, `最大偏差 ${worst.toFixed(4)}s vs cadence ${CADENCE.toFixed(4)}s`);
    const mean = intra.reduce((a, b) => a + b, 0) / intra.length;
    check('整梭平均射速 = 武器的 cooldown（长程精确，不被帧率量化）',
      Math.abs(mean - CADENCE) <= 1e-3, `实测 ${mean.toFixed(5)}s vs ${CADENCE.toFixed(5)}s`);
  }

  // --- the RELOAD gap, then a second full burst ------------------------------------------------
  // The gap between the LAST round of burst 1 and the FIRST round of burst 2 is the weapon's reload
  // plus the fresh telegraph — i.e. emptying a magazine costs the same warning as a first sight.
  const twoBursts = freshSim();
  addGunner(twoBursts, CONFIG.gunnerRange);
  const many = enemyShotTimes(twoBursts, BURST_CYCLE + 0.4);
  check('打空后出现第二梭（换弹 + 重新预警，不是打一发歇一会）',
    many.length >= MAG + 1, `${many.length} 发 / 应 >= ${MAG + 1}`);
  if (many.length >= MAG + 1) {
    const gap = many[MAG] - many[MAG - 1];
    check('梭间间隔 = 换弹时间 + 预警（换弹后必须重新预警）',
      Math.abs(gap - (RELOAD + AIM)) <= 2 * DT, `${gap.toFixed(3)}s vs ${(RELOAD + AIM).toFixed(3)}s`);
  }

  // --- aiming and firing are mutually exclusive, and both really happen ------------------------
  const flags = freshSim();
  const fg = addGunner(flags, CONFIG.gunnerRange);
  let sawFiring = false;
  let bothTrue = false;
  let aimingAfterBurst = false;
  for (let i = 0; i < Math.round((BURST_SPAN + 0.2) / DT); i++) {
    flags.update(DT, idle);
    flags.spawnQueue = 0;
    if (fg.firing) sawFiring = true;
    if (fg.aiming && fg.firing) bothTrue = true;
    if (sawFiring && fg.aiming) aimingAfterBurst = true;
  }
  check('预警后进入连发状态（firing）', sawFiring);
  check('预警与连发互斥（aiming 与 firing 不会同时为真）', !bothTrue);
  check('连发期间不再画预警光束（光束是预警，不是常驻激光）', !aimingAfterBurst);
  check('连发把弹夹打空后进入换弹（reloadT > 0）', fg.reloadT > 0, String(fg.reloadT));

  // --- the magazine actually gates the burst ---------------------------------------------------
  const half = freshSim();
  addGunner(half, CONFIG.gunnerRange, { ammo: 2 });
  const two = enemyShotTimes(half, 1.5);
  check('弹夹里只剩 2 发就只打 2 发（弹夹是资源，不是摆设）', two.length === 2, `${two.length} 发`);

  // --- sustained load: how many rounds a burst actually keeps in the air -----------------------
  // This became a BUDGET with the burst rework (the old one-shot cycle never had more than a couple
  // of rounds alive): the renderer draws bullets from a FIXED instanced pool and the sim walks every
  // live round each frame, so "one gunner = one bullet" no longer holds. Two invariants worth
  // pinning: a single gunner can never exceed its own magazine (the reload is a hard gate), and the
  // load scales with the number of shooters (i.e. the burst really is sustained pressure).
  {
    const peakRounds = (nGunners, seconds) => {
      const s = freshSim();
      s.player.hp = 1e9;                       // measure ROUND COUNT, not survival
      for (let i = 0; i < nGunners; i++) {
        const a = (i / nGunners) * Math.PI * 2;
        const g2 = addGunner(s, 0);
        g2.pos.x = Math.cos(a) * CONFIG.gunnerRange;
        g2.pos.y = Math.sin(a) * CONFIG.gunnerRange;
      }
      let peak = 0;
      let shots = 0;
      const seen = new Set();
      for (let i = 0; i < Math.round(seconds / DT); i++) {
        s.update(DT, idle);
        s.spawnQueue = 0;
        let live = 0;
        for (const b of s.bullets) {
          if (b.fromPlayer) continue;
          live++;
          if (!seen.has(b)) { seen.add(b); shots++; }
        }
        if (live > peak) peak = live;
      }
      return { peak, shots };
    };
    const one = peakRounds(1, 12);
    check('一名枪手 12s 内持续开火（连发真的把弹丸留在空中）', one.shots >= MAG, `${one.shots} 发`);
    check('单枪手同屏弹丸数不超过自己的弹夹（换弹是硬闸门）',
      one.peak <= MAG, `峰值 ${one.peak} / 弹夹 ${MAG}`);
    const three = peakRounds(3, 12);
    check('弹丸负荷随枪手数量近似线性上升（连发是可叠加的压力）',
      three.peak >= one.peak * 2, `1 名 ${one.peak} vs 3 名 ${three.peak}`);
  }

  // --- out of range / no LOS / dead player: nothing shoots ------------------------------------
  // Speed is pinned to 0 so the gunner cannot walk into the band and turn this into a test of
  // approach timing instead of the range gate.
  const tooFar = freshSim();
  const standoff = addGunner(tooFar, BAND + 3);
  standoff.speed = 0;
  check('超出射程带不开火', enemyShotTimes(tooFar, 2.0).length === 0, `${BAND + 3} 单位, speed=0`);
  check('对照组：枪手平时是会走位进射程的（速度 > 0）', CONFIG.gunnerSpeed > 0);

  // No line of sight: no shooting, and the telegraph drops immediately.
  const wall = [{ x: 6, y: 0, hw: 1, hh: 6, h: 2.5 }];
  const blocked = freshSim(wall);
  const hidden = addGunner(blocked, 10);
  run(blocked, 2.0);
  check('视线被掩体挡住就不开火（掩体是开关，不是精度修正）',
    blocked.bullets.filter((b) => !b.fromPlayer).length === 0,
    String(blocked.bullets.filter((b) => !b.fromPlayer).length));
  check('视线被挡时预警立刻取消（不会保留一个假的倒计时）', hidden.aiming === false);

  // Dead player: nothing shoots.
  const over = freshSim();
  addGunner(over, CONFIG.gunnerRange);
  over.player.alive = false;
  check('玩家已死时不开火', enemyShotTimes(over, 2.0).length === 0);
}

// ----------------------------------------------------------------- re-engage re-telegraphs
{
  const sim = freshSim();
  const g = addGunner(sim, CONFIG.gunnerRange, { fireT: 0.001 });  // this frame is the shot
  sim.update(DT, idle);
  check('临门一脚时会开火', sim.bullets.some((b) => !b.fromPlayer));
  check('开火后进入连发状态', g.firing === true);
  // Now break the engagement by teleporting the player far away, then bring them back.
  const firstShotCount = sim.bullets.filter((b) => !b.fromPlayer).length;
  sim.player.pos.x = -(ARENA_HALF - 5);
  run(sim, 0.5);
  check('脱战会中止连发（不会把梭子留到下次探头继续打）', g.firing === false);
  check('脱战会取消预警', g.aiming === false);
  sim.player.pos.x = 0;
  sim.player.pos.y = 0;
  g.pos.x = CONFIG.gunnerRange;   // back into the band
  g.pos.y = 0;
  let aimingSeen = false;
  let framesToShot = -1;
  for (let i = 0; i < 120; i++) {
    sim.update(DT, idle);
    sim.spawnQueue = 0;
    if (g.aiming) aimingSeen = true;
    if (sim.bullets.filter((b) => !b.fromPlayer).length > firstShotCount) { framesToShot = i; break; }
  }
  check('重新进入交战会先重新预警（脱战不保留进度）', aimingSeen);
  check('重新交战后仍要等满一个预警才开枪',
    framesToShot >= 0 && Math.abs((framesToShot + 1) * DT - AIM) <= 3 * DT,
    framesToShot < 0 ? '没开枪' : `${((framesToShot + 1) * DT).toFixed(3)}s`);
}

// -------------------------------------------------------------------- rounds hurt the player
{
  const sim = freshSim();
  sim.player.pos.x = 0;
  // 6 units, not 10: the weapon's spread (a 6-degree half-angle on the SMG) puts a round at most
  // 6*tan(6°) = 0.63 units off centre, comfortably inside the 0.73 hit radius. At 10 units the offset
  // is 1.05 and every damage assertion below would flip a coin on whether the round lands at all.
  //
  // `ammo: 1` on purpose: this block is about ONE round's lifecycle (damage, i-frame, consumption),
  // and a gunner mid-burst would keep putting new rounds in the air — "the bullet was consumed" and
  // "the i-frames expired" would then be assertions about a burst in progress instead. One round,
  // then the 1.5s reload keeps the sky clear for the whole 1.2s window below.
  const g = addGunner(sim, 6, { ammo: 1 });
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
  // Within the i-frame window the whole simultaneous batch must collapse to ONE tick. 0.4s < 0.6s,
  // so nothing may land a second time inside it — that is the "batch collapses" claim. (Under the
  // BURST design the gunners do keep firing, so a longer window deliberately takes more damage; the
  // RATE ceiling is what the next block asserts.)
  run(sim, 0.4);
  check('无敌帧把同批次命中压成一次伤害',
    near(hp0 - sim.player.hp, CONFIG.gunnerDamage, 1e-9), `实际扣 ${hp0 - sim.player.hp}`);

  // The cap is a RATE: with damage dmg and 0.6s i-frames, incoming DPS can never exceed dmg/0.6 no
  // matter HOW LONG the enemy keeps firing — which is exactly why the burst needed no new damage
  // number. Measure over a window longer than a full burst cycle (telegraph + magazine + reload), so
  // it contains continuous fire rather than one volley.
  const long = freshSim();
  long.player.pos.x = 0;
  long.player.pos.y = 0;
  // Measure the incoming RATE: survival is asserted in the death block below, and at these numbers a
  // long window would otherwise kill the player and stop the sim.
  long.player.hp = 1e9;
  for (const d of [6, 7, 8]) addGunner(long, d);
  const before = long.player.hp;
  const WINDOW = Math.max(8, BURST_CYCLE * 2);
  run(long, WINDOW);
  const taken = before - long.player.hp;
  const ideal = (CONFIG.gunnerDamage / CONFIG.contactInvuln) * WINDOW;
  check('长时间承伤不超过无敌帧给出的理论上限（连发不改变上限）',
    taken <= ideal + CONFIG.gunnerDamage,
    `扣 ${taken.toFixed(1)} / 上限 ${(ideal + CONFIG.gunnerDamage).toFixed(1)}`);
  // ...and the REVERSE, which is the observable meaning of "攻击欲望提高": sustained fire now keeps
  // the player permanently inside i-frames, so realised damage climbs towards that ceiling instead of
  // leaving 3-second holes in it.
  check('连发把实际承伤推向上限（不再是一发一歇，留出 3s 空档）',
    taken >= ideal * 0.5, `扣 ${taken.toFixed(1)} / 理论上限 ${ideal.toFixed(1)}`);
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
