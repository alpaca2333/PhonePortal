/**
 * CPU-side verification for the melee rework: the 180° sweep, the extended reach, the swing
 * crescent and its slipstream.
 *
 * Rules under test (all of them are things a player would notice, not implementation trivia):
 *   - the sword damages the WHOLE front half: +/-90° inclusive, and nothing behind it;
 *   - reach is long enough to leave the character's silhouette (3.4, was 2.2) — a target 3.0 units
 *     away, which the old reach could not touch (2.2 + enemyR 0.7 = 2.9), is now hit;
 *   - one swing damages EVERY enemy in the cone (AoE), not just the nearest;
 *   - a swing alternates direction and bumps a counter the renderer edge-triggers on;
 *     `swingT` runs the body animation and decays to 0;
 *   - every melee swing spawns exactly one crescent carrying the weapon's OWN reach/arc, so the
 *     drawing cannot drift from the damage cone;
 *   - THE HONESTY INVARIANT: across the whole sweep, both edges of the crescent stay inside the
 *     damage cone, and the union of its footprint is exactly that cone — the outer radius animates
 *     up to `reach` and never past it;
 *   - the crescent is not stiff and HAS WEIGHT: the sweep is front-loaded and strictly decelerating
 *     (fast out of the wind-up, then a follow-through — NOT smoothstep, whose slow start read as
 *     "没有力量感"), brightness holds then dissolves, and the slipstream is spread evenly ALONG THE
 *     ARC with TANGENTIAL velocity (radial would draw spokes instead of a trail);
 *   - the crescent is a blade the attacker is HOLDING: its origin tracks the live attacker position
 *     instead of freezing at the swing's spawn point (a walking player used to leave it behind);
 *   - a blade hit spawns its own steel sparks + impact ring, distinct from a projectile's splash;
 *   - ranged weapons are untouched: no crescent, no swing state.
 *
 * Run:  npm run build && node scripts/verify-melee.mjs
 * Exit code is non-zero when any assertion fails.
 */
const GAME = new URL('../dist/apps/shooter/src/game.js', import.meta.url);
const WEAPONS_URL = new URL('../dist/apps/shooter/src/weapons.js', import.meta.url);
const SLASH = new URL('../dist/apps/shooter/src/slash.js', import.meta.url);
const CONFIG_URL = new URL('../dist/apps/shooter/src/config.js', import.meta.url);

const { GameSim } = await import(GAME.href);
const { WEAPONS, magSizeOf } = await import(WEAPONS_URL.href);
const {
  makeSlash, slashAlive, slashAlpha, slashAngle, slashProgress, slashRadiusScale, slashSpan,
  slashTailAngle, buildCrescent, CRESCENT_PEAK,
} = await import(SLASH.href);
const { CONFIG } = await import(CONFIG_URL.href);

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ' — ' + detail : ''));
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

const DT = 1 / 60;
const idle = { move: { x: 0, y: 0 }, aim: { x: 0, y: 0 }, firing: false, autoAim: false };
const aimAt = (a) => ({ move: { x: 0, y: 0 }, aim: { x: Math.cos(a), y: Math.sin(a) }, firing: true, autoAim: false });

const SWORD = WEAPONS.sword;
const ARC = SWORD.arc;
const HALF = ARC / 2;
const SPAN = slashSpan(ARC);

/** Fresh sim with a chosen weapon; no waves, no enemies (the caller adds its own). */
function freshSim(weaponId = 'sword') {
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

/** One frame with the trigger held — `equipWeapon` zeroes fireTimer, so the first one attacks. */
function swingOnce(sim, angle) {
  sim.update(DT, aimAt(angle));
  sim.spawnQueue = 0;
}

// ---------------------------------------------------------------- weapon data
{
  check('砍刀仍是近战武器', SWORD.kind === 'melee');
  check('砍刀 arc = π（精确 180°）', near(SWORD.arc, Math.PI, 1e-12), String(SWORD.arc));
  check('砍刀 reach = 3.4（原 2.2，真机反馈"距离太近"）', near(SWORD.reach, 3.4), String(SWORD.reach));
  check('砍刀没有弹夹', magSizeOf(SWORD) === 0, String(magSizeOf(SWORD)));
  check('砍刀 swingTime > 0 且 < cooldown（刃口扫完但还没到下一刀）',
    SWORD.swingTime > 0 && SWORD.swingTime < SWORD.cooldown,
    `swingTime=${SWORD.swingTime} cooldown=${SWORD.cooldown}`);
  check('砍刀 swingAnimTime ∈ [swingTime, cooldown)（动画能收尾且不与下一刀重叠）',
    SWORD.swingAnimTime >= SWORD.swingTime && SWORD.swingAnimTime < SWORD.cooldown,
    `swingAnimTime=${SWORD.swingAnimTime}`);
}

// ------------------------------------------------- damage cone: 180° inclusive, nothing behind
{
  // Places one enemy at `deg` relative to the facing (+X) and reports whether it took damage.
  const hitAt = (deg, dist) => {
    const sim = freshSim('sword');
    const a = (deg * Math.PI) / 180;
    const e = addEnemy(sim, Math.cos(a) * dist, Math.sin(a) * dist, 100);
    swingOnce(sim, 0);
    return e.hp < e.maxHp;
  };
  const D = 2.5;

  check('正前方 0° 命中', hitAt(0, D));
  check('+45° 命中', hitAt(45, D));
  check('-45° 命中', hitAt(-45, D));
  check('+89° 命中', hitAt(89, D));
  check('-89° 命中', hitAt(-89, D));
  check('+90° 命中（180° 含边界）', hitAt(90, D));
  check('-90° 命中（180° 含边界）', hitAt(-90, D));
  check('+91° 不命中（锥外）', !hitAt(91, D));
  check('-91° 不命中（锥外）', !hitAt(-91, D));
  check('正后方 180° 不命中', !hitAt(180, D));
  check('侧后方 135° 不命中', !hitAt(135, D));
}

// ------------------------------------------------------------ reach (the actual complaint)
{
  const sim = freshSim('sword');
  const e = addEnemy(sim, 3.0, 0, 100);
  swingOnce(sim, 0);
  // 3.0 units is beyond the OLD limit (2.2 reach + 0.7 enemyR = 2.9) — this is the regression guard
  // for "距离太近".
  check('距离 3.0 的目标现在能砍到（旧 reach 的极限是 2.9）', e.hp < e.maxHp, `hp=${e.hp}`);

  const inside = freshSim('sword');
  const ei = addEnemy(inside, SWORD.reach + 0.7 - 0.05, 0, 100);
  swingOnce(inside, 0);
  check('刚好在 reach + enemyR 之内 → 命中', ei.hp < ei.maxHp);

  const outside = freshSim('sword');
  const eo = addEnemy(outside, SWORD.reach + 0.7 + 0.05, 0, 100);
  swingOnce(outside, 0);
  check('刚好在 reach + enemyR 之外 → 不命中', eo.hp === eo.maxHp);
}

// ------------------------------------------------------------------- AoE + killing
{
  const sim = freshSim('sword');
  const angles = [-80, -40, 0, 40, 80];
  const victims = angles.map((d) => addEnemy(sim, Math.cos((d * Math.PI) / 180) * 2.6, Math.sin((d * Math.PI) / 180) * 2.6, 100));
  const behind = addEnemy(sim, -2.6, 0, 100);
  swingOnce(sim, 0);
  check('一刀同时命中锥内 5 个敌人（AoE）', victims.every((e) => e.hp < e.maxHp),
    victims.map((e) => e.hp).join(','));
  check('每个目标各扣 34（damage 数据未改）', victims.every((e) => e.hp === 66),
    victims.map((e) => e.hp).join(','));
  check('锥外的敌人不掉血', behind.hp === 100, String(behind.hp));

  const killSim = freshSim('sword');
  const doomed = addEnemy(killSim, 2.0, 0, 34);
  const bystander = addEnemy(killSim, -2.5, 0, 100);  // keeps the wave from advancing
  swingOnce(killSim, 0);
  check('34 HP 的敌人在一刀内死亡', doomed.alive === false);
  check('击杀加分（resolveDeath 走通）', killSim.score > 0, String(killSim.score));
  check('旁观者不受影响', bystander.hp === 100);
}

// --------------------------------------------------------- swing state + alternation
{
  const sim = freshSim('sword');
  const p = sim.player;
  check('初始 swingDir = +1', p.swingDir === 1, String(p.swingDir));
  check('初始 swingCount = 0', p.swingCount === 0, String(p.swingCount));
  check('初始 swingT = 0', p.swingT === 0, String(p.swingT));

  swingOnce(sim, 0);
  check('一次挥砍 swingCount = 1', p.swingCount === 1, String(p.swingCount));
  check('一次挥砍后 swingDir 翻转为 -1（下一刀反向）', p.swingDir === -1, String(p.swingDir));
  check('swingT 被置为 swingAnimTime（同帧已扣掉一帧）',
    near(p.swingT, SWORD.swingAnimTime - DT, 1e-9), String(p.swingT));
  check('swingT 当帧仍 > 0（动画确实接管了身体）', p.swingT > 0);

  run(sim, SWORD.swingAnimTime, idle);
  check('swingAnimTime 之后 swingT 归零', p.swingT === 0, String(p.swingT));

  // Hold the trigger and confirm the cooldown gates the next swing, then that it fires.
  const c = freshSim('sword');
  swingOnce(c, 0);
  check('按住开火：冷却中不会提前挥第二刀', c.player.swingCount === 1, String(c.player.swingCount));
  run(c, SWORD.cooldown * 0.5, aimAt(0));
  check('半个冷却后仍只有 1 刀', c.player.swingCount === 1, String(c.player.swingCount));
  run(c, SWORD.cooldown, aimAt(0));
  check('冷却走完后按住开火会挥出第二刀', c.player.swingCount === 2, String(c.player.swingCount));
  check('第二刀把方向翻回 +1（交替）', c.player.swingDir === 1, String(c.player.swingDir));

  // Melee needs no aim vector — only the facing — so it must still swing while walking.
  const walk = freshSim('sword');
  walk.update(DT, { move: { x: 1, y: 0 }, aim: { x: 0, y: 0 }, firing: true, autoAim: false });
  check('没有瞄准方向也能挥砍（近战只需朝向）', walk.player.swingCount === 1, String(walk.player.swingCount));
}

// ------------------------------------------------------------ one crescent per swing
{
  const sim = freshSim('sword');
  swingOnce(sim, 0.3);
  check('一次挥砍恰好生成 1 个新月', sim.slashes.length === 1, String(sim.slashes.length));
  const s = sim.slashes[0];
  check('新月半径 = 武器 reach（两边不会各写一份）', near(s.reach, SWORD.reach), String(s.reach));
  check('新月弧度 = 武器 arc（两边不会各写一份）', near(s.arc, SWORD.arc), String(s.arc));
  check('新月时长 = 武器 swingTime', near(s.max, SWORD.swingTime), String(s.max));
  check('新月起点 = 玩家位置', near(s.x, sim.player.pos.x) && near(s.z, sim.player.pos.y));
  check('新月方向 = 本次挥砍实际使用的 dir（+1）', s.dir === 1, String(s.dir));
  // The sim advances the crescent in the SAME update that spawned it (the fire block runs before
  // the slash pass), exactly like a projectile takes its first step on its spawn frame.
  check('新月当帧就走了一步（t = 1 帧）', near(s.t, DT, 1e-12), String(s.t));

  run(sim, SWORD.swingTime + DT * 2, idle);
  check('swingTime 之后新月被回收（不会泄漏）', sim.slashes.length === 0, String(sim.slashes.length));

  // A long-lived sweep makes the cap observable; `slashMax` is the guard against a future fast
  // melee weapon growing this array without bound.
  const cap = freshSim('sword');
  for (let i = 0; i < CONFIG.slashMax + 6; i++) cap.spawnSlash(0, SWORD.reach, SWORD.arc, 1, 5);
  check(`新月数量被 CONFIG.slashMax (${CONFIG.slashMax}) 限制`, cap.slashes.length === CONFIG.slashMax,
    String(cap.slashes.length));
}

// ---------------------------------- the crescent follows the attacker (regression: it used to freeze)
{
  const sim = freshSim('sword');
  swingOnce(sim, 0);
  const s = sim.slashes[0];
  const x0 = s.x;
  const z0 = s.z;
  check('新月原点 = 生成时的角色位置', near(x0, sim.player.pos.x) && near(z0, sim.player.pos.y), `${x0},${z0}`);

  // Walk mid-swing. At playerSpeed 11 a 0.17s swing covers ~1.9 units — a large fraction of the
  // 3.4 reach — so a frozen crescent was left visibly behind. This is the reported bug.
  const walk = { move: { x: 1, y: 0 }, aim: { x: 1, y: 0 }, firing: false, autoAim: false };
  run(sim, DT * 4, walk);
  check('新月跟着角色移动（不再留在原地）', s.x > x0 + 0.3, `x ${x0} -> ${s.x}`);
  check('新月每帧的原点 == 角色当前位置',
    near(s.x, sim.player.pos.x) && near(s.z, sim.player.pos.y),
    `slash(${s.x.toFixed(3)},${s.z.toFixed(3)}) player(${sim.player.pos.x.toFixed(3)},${sim.player.pos.y.toFixed(3)})`);

  // ...but the streaks it already shed are WORLD-space particles: a motion trail is left behind, it
  // is not dragged along with the blade.
  const streak = sim.particles[0];
  const before = { x: streak.pos.x, y: streak.pos.y };
  run(sim, DT, walk);
  check('已喷出的气流留在世界空间（不被拖着走）',
    !near(streak.pos.x, sim.player.pos.x) && !near(streak.pos.y, sim.player.pos.y),
    `streak(${streak.pos.x.toFixed(2)},${streak.pos.y.toFixed(2)}) player(${sim.player.pos.x.toFixed(2)},${sim.player.pos.y.toFixed(2)})`);
  check('气流只按自身速度移动（一帧内位移 < 1 单位）',
    Math.abs(streak.pos.x - before.x) < 1 && Math.abs(streak.pos.y - before.y) < 1,
    `Δ=(${(streak.pos.x - before.x).toFixed(3)},${(streak.pos.y - before.y).toFixed(3)})`);
}

// ------------------------------------------- crescent motion (slash.ts, pure arithmetic)
{
  const max = SWORD.swingTime;
  const aim = 0.6;
  const probe = makeSlash(0, 0, aim, SWORD.reach, ARC, 1, max);

  check('progress(0) = 0', near(slashProgress(0, max), 0));
  check('progress(max) = 1', near(slashProgress(max, max), 1));
  check('progress 在 max 之外被钳制', near(slashProgress(max * 3, max), 1) && near(slashProgress(-1, max), 0));

  // ---- SPEED CURVE: fast out of the wind-up, then decelerating. This is the "力量感" spec ----
  // A smoothstep (ease-IN-out) curve used to live here and read as a timid swing; the slow start was
  // most of the complaint. The shape is now pinned in three ways: front-loaded, strictly
  // decelerating, and never linear.
  const P = (u) => slashProgress(max * u, max);
  check('前 1/4 时间走完一半以上弧（起步就是全力，不是缓慢加速）', P(0.25) > 0.5, String(P(0.25)));
  check('半程走完 80% 以上弧', P(0.5) > 0.8, String(P(0.5)));
  check('不是线性（半程明显超过 50%）', P(0.5) - 0.5 > 0.2, String(P(0.5)));

  // Average slope over successive 10% windows must decrease STRICTLY — that is "从快到慢".
  const slope = (a, b) => (P(b) - P(a)) / (b - a);
  const sIn = slope(0, 0.1);
  const sMid = slope(0.45, 0.55);
  const sOut = slope(0.9, 1);
  check('斜率逐段递减（从快到慢的力量曲线）', sIn > sMid && sMid > sOut,
    `${sIn.toFixed(3)} > ${sMid.toFixed(3)} > ${sOut.toFixed(3)}`);
  check('起步最快（第一段斜率明显高于中段）', sIn > sMid * 2, `${sIn.toFixed(3)} vs ${sMid.toFixed(3)}`);
  check('收尾慢（后 10% 时间只走不到 5% 弧 = 跟随收势）', 1 - P(0.9) < 0.05, String(1 - P(0.9)));

  let mono = true;
  let prev = -1;
  for (let i = 0; i <= 100; i++) {
    const v = P(i / 100);
    if (v < prev - 1e-12) mono = false;
    prev = v;
  }
  check('progress 单调不减（不会倒着扫）', mono);

  // The easing exponent is a live knob, so prove it is really wired into the formula rather than
  // just reading it: exponent 1 must be exactly linear, and a larger exponent more front-loaded.
  check('CONFIG.slashEase = 3（当前的力量曲线）', CONFIG.slashEase === 3, String(CONFIG.slashEase));
  const savedEase = CONFIG.slashEase;
  try {
    CONFIG.slashEase = 1;
    check('slashEase = 1 → 完全线性（旋钮确实接在公式上）',
      near(slashProgress(max * 0.25, max), 0.25) && near(slashProgress(max * 0.5, max), 0.5),
      String(slashProgress(max * 0.25, max)));
    const at2 = slashProgress(max * 0.25, max);
    CONFIG.slashEase = 2;
    const at3 = slashProgress(max * 0.25, max);
    CONFIG.slashEase = 3;
    const at4 = slashProgress(max * 0.25, max);
    check('指数越大越前倾（2 < 3 < 4 阶）', at2 < at3 && at3 < at4,
      `${at2.toFixed(3)} < ${at3.toFixed(3)} < ${at4.toFixed(3)}`);
  } finally {
    CONFIG.slashEase = savedEase;
  }
  check('测试后 slashEase 已还原', CONFIG.slashEase === 3, String(CONFIG.slashEase));

  // ---- the honesty invariant: both edges inside the cone, at every sampled moment ----
  let inCone = true;
  let minTail = Infinity;
  let maxLead = -Infinity;
  for (let i = 0; i <= 240; i++) {
    probe.t = (i / 240) * max;
    const lead = slashAngle(probe);
    const tail = slashTailAngle(probe);
    if (!(lead >= aim - HALF - 1e-9 && lead <= aim + HALF + 1e-9)) inCone = false;
    if (!(tail >= aim - HALF - 1e-9 && tail <= aim + HALF + 1e-9)) inCone = false;
    minTail = Math.min(minTail, tail);
    maxLead = Math.max(maxLead, lead);
  }
  check('新月两个边始终在伤害锥内（不画打不到的地方）', inCone);
  check('整个扫掠的并集正好铺满伤害锥：尾端到起始边',
    near(minTail, aim - HALF, 1e-9), `${minTail} vs ${aim - HALF}`);
  check('整个扫掠的并集正好铺满伤害锥：刃口到终止边',
    near(maxLead, aim + HALF, 1e-9), `${maxLead} vs ${aim + HALF}`);

  probe.t = 0;
  check('t=0 刃口 = 起始边 + 一个新月宽（尾端才落在起始边上）',
    near(slashAngle(probe), aim - HALF + SPAN, 1e-9), String(slashAngle(probe)));
  probe.t = max;
  check('t=max 刃口正好到终止边', near(slashAngle(probe), aim + HALF, 1e-9), String(slashAngle(probe)));

  // ---- direction alternation really mirrors the sweep ----
  const rev = makeSlash(0, 0, aim, SWORD.reach, ARC, -1, max);
  rev.t = 0;
  check('反向挥砍：t=0 尾端落在锥的另一侧起始边', near(slashTailAngle(rev), aim + HALF, 1e-9), String(slashTailAngle(rev)));
  rev.t = max;
  check('反向挥砍：t=max 刃口到达 aim - half', near(slashAngle(rev), aim - HALF, 1e-9), String(slashAngle(rev)));

  // ---- fade ----
  const fade = makeSlash(0, 0, 0, SWORD.reach, ARC, 1, max);
  fade.t = 0;
  check('alpha(0) = 1（起手最亮）', near(slashAlpha(fade), 1));
  fade.t = max * CONFIG.slashHold;
  check('alpha 在 hold 之前保持 1（扫掠途中不提前变暗）', near(slashAlpha(fade), 1));
  fade.t = max;
  check('alpha(max) = 0（正好在结束时消失）', near(slashAlpha(fade), 0));
  let fadeMono = true;
  let fp = 1.0001;
  for (let i = 0; i <= 100; i++) {
    fade.t = (i / 100) * max;
    const v = slashAlpha(fade);
    if (v > fp + 1e-12) fadeMono = false;
    fp = v;
  }
  check('alpha 单调不增', fadeMono);

  // ---- radius: grows outward but NEVER past reach ----
  const rad = makeSlash(0, 0, 0, SWORD.reach, ARC, 1, max);
  rad.t = 0;
  check('半径起点 = slashRadiusStart', near(slashRadiusScale(rad), CONFIG.slashRadiusStart), String(slashRadiusScale(rad)));
  rad.t = max;
  check('半径终点 = 1.0（正好落在 reach 上）', near(slashRadiusScale(rad), 1), String(slashRadiusScale(rad)));
  let radiusOk = true;
  let radMono = true;
  let rp = -1;
  for (let i = 0; i <= 100; i++) {
    rad.t = (i / 100) * max;
    const v = slashRadiusScale(rad);
    if (v > 1 + 1e-12) radiusOk = false;
    if (v < rp - 1e-12) radMono = false;
    rp = v;
  }
  check('半径永不超出 reach（不夸大射程）', radiusOk);
  check('半径单调外扩（刃口是甩出去的，不是原地转）', radMono);

  // ---- narrow-arc weapons degrade gracefully ----
  check('窄弧武器的新月宽度被钳到 arc', near(slashSpan(0.5), CONFIG.slashSpan > 0.5 ? 0.5 : CONFIG.slashSpan));
  check('180° 武器的新月宽度 = config.slashSpan', near(slashSpan(Math.PI), CONFIG.slashSpan));

  const alive = makeSlash(0, 0, 0, 1, ARC, 1, max);
  alive.t = max - 1e-6;
  check('slashAlive 在 max 之前为真', slashAlive(alive));
  alive.t = max;
  check('slashAlive 在 max 处为假', !slashAlive(alive));
}

// ------------------------------------------------------- slipstream (the "not stiff" part)
{
  const whiff = freshSim('sword');
  swingOnce(whiff, 0);
  const first = whiff.particles.length;
  check('挥砍当帧就喷出气流粒子', first > 0, String(first));

  // Tangential, not radial: the renderer stretches every streak along its own velocity, so radial
  // emission would draw spokes (a fan) instead of a trail.
  const s0 = whiff.slashes[0];
  let tangential = true;
  let dirOk = true;
  let seen = 0;
  for (const pt of whiff.particles) {
    const rx = pt.pos.x - s0.x;
    const rz = pt.pos.y - s0.z;
    const rl = Math.hypot(rx, rz);
    const vl = Math.hypot(pt.vel.x, pt.vel.y);
    if (rl < 1e-6 || vl < 1e-6) continue;
    seen++;
    const dot = Math.abs((rx / rl) * (pt.vel.x / vl) + (rz / rl) * (pt.vel.y / vl));
    if (dot > 0.35) tangential = false;
    // 2D cross product sign: > 0 for a counter-clockwise (dir = +1) sweep.
    const cross = rx * pt.vel.y - rz * pt.vel.x;
    if (s0.dir === 1 ? cross <= 0 : cross >= 0) dirOk = false;
  }
  check('气流速度是切向的（不是放射状的光栅）', tangential && seen > 0, `${seen} 个粒子`);
  check('气流方向与本次挥砍方向一致', dirOk && seen > 0);
  check('气流半径落在刃口附近（不是从圆心射出）',
    whiff.particles.every((pt) => Math.hypot(pt.pos.x - s0.x, pt.pos.y - s0.z) >= s0.reach * 0.6));

  // Emitted continuously WHILE the blade travels, not in one burst at spawn: with a front-loaded
  // curve nearly everything is emitted in the first few frames, but the count must still keep
  // rising after the spawn frame (a true one-shot burst would peak on frame 0 and only decay).
  const counts = [whiff.particles.length];
  for (let i = 0; i < 26; i++) {
    whiff.update(DT, idle);
    whiff.spawnQueue = 0;
    counts.push(whiff.particles.length);
  }
  const peak = Math.max(...counts);
  const at = counts.indexOf(peak);
  check('气流不是起手一次性喷完（峰值不在生成帧）', at > 0, `peak=${peak} at frame ${at}`);

  // The count is PER SWING and spread by arc distance, so the total is `slashStreakCount` no matter
  // how long the sweep takes or which easing curve is in use.
  //
  // Measured at SPAWN, not at the end of the window: the streaks fly off tangentially at ~15 u/s, so
  // their final bearing relative to the player says nothing about where the blade shed them. Each
  // particle is first observed one frame after it spawns, i.e. after a single integration step.
  const spawnAngle = new Map();
  const tally = freshSim('sword');
  swingOnce(tally, 0);
  for (let i = 0; i < 14; i++) {
    for (const pt of tally.particles) {
      if (!spawnAngle.has(pt)) {
        spawnAngle.set(pt, Math.atan2(pt.pos.y - tally.player.pos.y, pt.pos.x - tally.player.pos.x));
      }
    }
    tally.update(DT, idle);
    tally.spawnQueue = 0;
  }
  check('每次挥砍喷出的气流条数 = slashStreakCount（与时长/帧率无关）',
    Math.abs(spawnAngle.size - CONFIG.slashStreakCount) <= 2,
    `${spawnAngle.size} vs ${CONFIG.slashStreakCount}`);

  const spawnAngles = [...spawnAngle.values()];
  const span = Math.max(...spawnAngles) - Math.min(...spawnAngles);
  // The LEADING edge travels `arc - span` (the crescent's own body covers the rest of the cone), so
  // that travel is the scale to compare against.
  const leadTravel = ARC - SPAN;
  check('气流沿刃口全程铺开（不是堆在收尾处）', span > leadTravel * 0.7,
    `跨度 ${span.toFixed(2)} rad / 刃口行程 ${leadTravel.toFixed(2)} rad`);

  run(whiff, 1.2, idle);
  check('气流粒子最终全部消亡（不会留下来堆积）', whiff.particles.length === 0, String(whiff.particles.length));

  // The leading edge must actually MOVE across the arc while emitting.
  const moving = freshSim('sword');
  swingOnce(moving, 0);
  const angles = [];
  for (let i = 0; i < 16; i++) {
    if (moving.slashes.length === 0) break;
    angles.push(slashAngle(moving.slashes[0]));
    moving.update(DT, idle);
    moving.spawnQueue = 0;
  }
  check('喷出气流时刃口角在扫掠（轨迹跟着刀走）',
    angles.length > 2 && Math.abs(angles[angles.length - 1] - angles[0]) > 0.3,
    angles.map((a) => a.toFixed(2)).join(','));
}

// ------------------------------------------------------------- blade impact feedback
{
  const whiff = freshSim('sword');
  swingOnce(whiff, 0);
  const whiffCount = whiff.particles.length;

  const hit = freshSim('sword');
  addEnemy(hit, 2.0, 0, 100);
  swingOnce(hit, 0);
  const hitCount = hit.particles.length;

  // Same slipstream on both (1 streak on the swing frame), so the difference is exactly the steel
  // sparks plus the impact ring — proving the melee hit has its own effect rather than reusing the
  // projectile splash.
  check('命中额外喷出「火花 + 冲击环」', hitCount - whiffCount === SWORD.sparks + CONFIG.meleeImpactRing,
    `hit=${hitCount} whiff=${whiffCount}, 期望差 ${SWORD.sparks + CONFIG.meleeImpactRing}`);

  // The ring and the sparks are inspected BEFORE any update(): with no integration step yet there
  // is no drag and no movement, so the ring still sits at exactly its spawn radius and the two
  // layers separate cleanly by position (sparks start at the impact point, the ring 0.25 out).
  const probe = freshSim('sword');
  const victim = { x: 1.5, y: -0.5 };
  probe.spawnMeleeHit(victim, { x: 1, y: 0 }, SWORD.sparks);
  const ring = probe.particles.filter((pt) =>
    near(Math.hypot(pt.pos.x - victim.x, pt.pos.y - victim.y), 0.25, 1e-9));
  check('冲击环粒子数 = meleeImpactRing', ring.length === CONFIG.meleeImpactRing,
    `${ring.length} vs ${CONFIG.meleeImpactRing}`);
  check('火花 = sparks 个，从受击点出发',
    probe.particles.length - ring.length === SWORD.sparks,
    String(probe.particles.length - ring.length));

  check('所有冲击环粒子都从受击点放射（速度朝外）',
    ring.every((pt) => {
      const rx = pt.pos.x - victim.x;
      const rz = pt.pos.y - victim.y;
      const rl = Math.hypot(rx, rz);
      const vl = Math.hypot(pt.vel.x, pt.vel.y);
      return (rx / rl) * (pt.vel.x / vl) + (rz / rl) * (pt.vel.y / vl) > 0.999;
    }));

  // Even angular spacing (not random): sorted gaps must all be 2π/n. This is what makes it read as
  // a ring rather than as more sparks.
  const gaps = ring
    .map((pt) => Math.atan2(pt.pos.y - victim.y, pt.pos.x - victim.x))
    .sort((a, b) => a - b)
    .map((a, i, arr) => (i === 0 ? a + Math.PI * 2 - arr[arr.length - 1] : a - arr[i - 1]));
  const want = (Math.PI * 2) / CONFIG.meleeImpactRing;
  check('冲击环等角分布（每份 2π/环粒子数）',
    gaps.length === CONFIG.meleeImpactRing && gaps.every((g) => near(g, want, 1e-9)),
    gaps.map((g) => g.toFixed(4)).join(','));
}

// ------------------------------------- crescent geometry (pure vertex data, no three/canvas)
// This is the part of the effect that would otherwise only fail as "the slash looks a bit off" on
// a real device: a mirrored envelope, a NaN, or a yaw sign error. render.ts wraps exactly this
// builder in a BufferGeometry, so asserting it here covers the shipped mesh.
{
  const SPAN_ARG = slashSpan(ARC);
  const INNER = 0.34;
  const ANG_SEG = 12;
  const RAD_SEG = 3;
  const cols = ANG_SEG + 1;
  const rows = RAD_SEG + 1;
  const m = buildCrescent(SPAN_ARG, INNER, ANG_SEG, RAD_SEG);

  check('顶点数 = (角分段+1) × (径分段+1)', m.positions.length / 3 === rows * cols,
    String(m.positions.length / 3));
  check('颜色数与顶点数一致', m.colors.length === m.positions.length);
  check('索引数 = 6 × 四边形数', m.indices.length === 6 * ANG_SEG * RAD_SEG, String(m.indices.length));
  check('所有索引都是范围内整数', m.indices.every((i) => Number.isInteger(i) && i >= 0 && i < rows * cols));
  check('每个顶点都被引用（网格铺满，没有空洞）', new Set(m.indices).size === rows * cols);
  check('顶点/颜色没有 NaN', m.positions.every(Number.isFinite) && m.colors.every(Number.isFinite));
  check('整条缎带都在 y = 0 平面（水平挥砍）',
    m.positions.filter((_, i) => i % 3 === 1).every((y) => y === 0));

  const posAt = (r, a) => [
    m.positions[(r * cols + a) * 3], m.positions[(r * cols + a) * 3 + 1], m.positions[(r * cols + a) * 3 + 2],
  ];
  const lead = posAt(RAD_SEG, ANG_SEG);   // outer radius, leading edge
  const tail = posAt(RAD_SEG, 0);         // outer radius, tail

  check('刃口顶点在局部角 0（+X 方向）', near(Math.atan2(lead[2], lead[0]), 0, 1e-12));
  check('尾端顶点在局部角 -span', near(Math.atan2(tail[2], tail[0]), -SPAN_ARG, 1e-9),
    String(Math.atan2(tail[2], tail[0])));
  // The instance scale carries `reach`, so the OUTER radius must be exactly 1 — that is what makes
  // "the blade edge lands on the weapon's reach" true by construction.
  check('外缘半径正好 = 1（实例缩放才能等于 reach）', near(Math.hypot(lead[0], lead[2]), 1, 1e-12),
    String(Math.hypot(lead[0], lead[2])));
  check('内缘半径 = inner 参数', near(Math.hypot(posAt(0, ANG_SEG)[0], posAt(0, ANG_SEG)[2]), INNER, 1e-12));

  // Radial envelope, sampled at the leading edge (where the angular envelope is 1, so the colour
  // there is the radial envelope alone).
  const radialAt = (r) => m.colors[(r * cols + ANG_SEG) * 3];
  check('径向包络在内缘为 0（内侧是软边）', near(radialAt(0), 0, 1e-12), String(radialAt(0)));
  check('径向包络在外缘为 0（外侧是软边）', near(radialAt(RAD_SEG), 0, 1e-12), String(radialAt(RAD_SEG)));
  const peakRow = [...Array(rows).keys()].reduce((b, r) => (radialAt(r) > radialAt(b) ? r : b), 0);
  const peakRt = peakRow / RAD_SEG;
  const nearestToPeak = [...Array(rows).keys()]
    .reduce((b, r) => (Math.abs(r / RAD_SEG - CRESCENT_PEAK) < Math.abs(b / RAD_SEG - CRESCENT_PEAK) ? r : b), 0);
  check(`径向最亮的环落在 CRESCENT_PEAK (${CRESCENT_PEAK}) 附近`, peakRow === nearestToPeak,
    `peak row ${peakRow} (rt=${peakRt})`);
  check('径向包络中段是亮的（不是一条空带）', radialAt(peakRow) > 0.9, String(radialAt(peakRow)));

  // Angular envelope, normalised by the radial value at that row so it can be read directly.
  const midRow = peakRow;
  const radialMid = radialAt(midRow);
  const angAt = (a) => m.colors[(midRow * cols + a) * 3] / radialMid;
  check('角向包络在尾端为 0（拖尾消散）', near(angAt(0), 0, 1e-9), String(angAt(0)));
  check('角向包络在刃口为 1（刃口最亮）', near(angAt(ANG_SEG), 1, 1e-9), String(angAt(ANG_SEG)));
  let angMono = true;
  let ap = -1;
  for (let a = 0; a <= ANG_SEG; a++) {
    const v = angAt(a);
    if (v < ap - 1e-12) angMono = false;
    ap = v;
  }
  check('角向包络从尾端到刃口单调变亮', angMono);

  // The renderer composes rotation.y = -angle. Verify that convention maps the crescent's local +X
  // (its leading edge) onto the world direction slashAngle() reports. A sign error here would
  // mirror every swing — the slash would be drawn on the wrong side of the player, which no
  // amount of sim-side testing would catch.
  const rotY = (x, z, theta) => [
    x * Math.cos(theta) + z * Math.sin(theta),
    -x * Math.sin(theta) + z * Math.cos(theta),
  ];
  for (const A of [0, 0.9, -2.1, Math.PI]) {
    const w = rotY(1, 0, -A);
    check(`yaw = -angle 把刃口送到 (cos ${A.toFixed(2)}, sin ${A.toFixed(2)})`,
      near(w[0], Math.cos(A), 1e-12) && near(w[1], Math.sin(A), 1e-12), `${w[0]},${w[1]}`);
  }

  // Degenerate parameters must not produce NaN (a 1x1 mesh is the smallest legal one).
  const tiny = buildCrescent(0.5, 0.2, 1, 1);
  check('退化参数（1×1 段）不产生 NaN',
    tiny.positions.every(Number.isFinite) && tiny.colors.every(Number.isFinite));
  check('退化参数下索引仍合法（4 个顶点）',
    tiny.indices.every((i) => i >= 0 && i < 4) && tiny.positions.length / 3 === 4);

  // The geometry is unit-sized, so the reach honesty reduces to the radius scale being 1 at the end.
  const end = makeSlash(0, 0, 0, SWORD.reach, ARC, 1, SWORD.swingTime);
  end.t = SWORD.swingTime;
  check('扫掠结束时外缘半径正好 = reach（几何 × 半径缩放）',
    near(SWORD.reach * slashRadiusScale(end), SWORD.reach, 1e-12));
}

// --------------------------------------------------------- ranged weapons untouched
{
  const sim = freshSim('smg');
  swingOnce(sim, 0);
  check('远程武器不生成新月', sim.slashes.length === 0, String(sim.slashes.length));
  check('远程武器不推进 swingCount', sim.player.swingCount === 0, String(sim.player.swingCount));
  check('远程武器不设置 swingT', sim.player.swingT === 0, String(sim.player.swingT));
  check('远程武器仍然发射子弹', sim.bullets.length > 0, String(sim.bullets.length));

  const rpg = freshSim('rpg');
  const e = addEnemy(rpg, 5, 0, 100);
  swingOnce(rpg, 0);
  check('火箭筒不产生新月', rpg.slashes.length === 0);
  check('火箭筒目标未被近战误伤', e.hp === 100, String(e.hp));
}

// ------------------------------------------------------------------------- summary
console.log(`\nverify-melee: ${passed} 项通过, ${failures.length} 项失败`);
if (failures.length > 0) {
  console.log('\n失败项:');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('全部通过 ✓');
