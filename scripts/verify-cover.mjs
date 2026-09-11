/**
 * CPU-side verification for COVER: the arena layout, the collision maths, and the rule that cover
 * stops bullets, blades and blasts.
 *
 * Rules under test:
 *   - the layout is legal: every piece inside the arena with margin, no pair overlapping, the origin
 *     (the player's spawn) clear, and NO SEALED POCKETS (a flood fill of the free space from the
 *     origin must reach essentially all of it — otherwise an enemy could spawn somewhere the player
 *     can never walk to and the wave would be unclearable);
 *   - circle-vs-AABB resolution pushes OUT along the axis of least penetration, which is what makes
 *     an entity slide along a wall instead of sticking, and is idempotent (a resting entity is not
 *     re-pushed every frame — that would be visible jitter);
 *   - segment-vs-AABB reports the ENTRY parameter so impacts land on the wall face, misses report
 *     -1, and the `SEGMENT_SKIN` shrink means grazing a wall you are leaning on is not a hit;
 *   - bullets are stopped by cover for BOTH sides, and the round is consumed on the wall;
 *   - the melee sweep and the rocket's blast respect line of sight, so cover protects against all
 *     four damage sources (enemy rounds, player rounds, sword, RPG AoE).
 *
 * Run:  npm run build && node scripts/verify-cover.mjs
 * Exit code is non-zero when any assertion fails.
 */
const GAME = new URL('../dist/apps/shooter/src/game.js', import.meta.url);
const LEVEL = new URL('../dist/apps/shooter/src/level.js', import.meta.url);
const MATH = new URL('../dist/apps/shooter/src/math2.js', import.meta.url);
const WEAPONS_URL = new URL('../dist/apps/shooter/src/weapons.js', import.meta.url);
const CONFIG_URL = new URL('../dist/apps/shooter/src/config.js', import.meta.url);

const { GameSim } = await import(GAME.href);
const { OBSTACLES, SEGMENT_SKIN, overlapsCover, resolveCover, firstCoverHit, lineBlocked } = await import(LEVEL.href);
const { circleAabbResolve, segmentAabbHit, nearestPointOnAabb } = await import(MATH.href);
const { WEAPONS } = await import(WEAPONS_URL.href);
const { CONFIG, ARENA_HALF } = await import(CONFIG_URL.href);

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ' — ' + detail : ''));
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

const DT = 1 / 60;
const idle = { move: { x: 0, y: 0 }, aim: { x: 0, y: 0 }, firing: false, autoAim: false };
const aimAt = (x, y) => ({ move: { x: 0, y: 0 }, aim: { x, y }, firing: true, autoAim: false });

/** Sim on the REAL layout (cover intact) unless a scenario passes its own. */
function freshSim(weaponId = 'dragonBreath', obstacles = OBSTACLES) {
  const sim = new GameSim();
  sim.spawnQueue = 0;
  sim.spawnTimer = 0;
  sim.enemies = [];
  sim.obstacles = obstacles;
  sim.equipWeapon(weaponId);
  return sim;
}

function addEnemy(sim, x, y, hp, kind = 'chaser') {
  sim.enemies.push({
    id: 900 + sim.enemies.length, pos: { x, y }, vel: { x: 0, y: 0 }, r: 0.7,
    hp, maxHp: hp, alive: true, kind, speed: 0, touchDmg: 16, hitFlash: 0, touchCd: 0,
    burns: [], flameAcc: 0, fireT: 0, aiming: false,
  });
  return sim.enemies[sim.enemies.length - 1];
}

// ------------------------------------------------------------------- layout invariants
{
  check('布局不是空的', OBSTACLES.length > 0, String(OBSTACLES.length));
  check('布局数量合理（10-30 块）', OBSTACLES.length >= 10 && OBSTACLES.length <= 30, String(OBSTACLES.length));

  let insideAll = true;
  let heightOk = true;
  for (const o of OBSTACLES) {
    if (o.x - o.hw < -ARENA_HALF + 3 || o.x + o.hw > ARENA_HALF - 3
      || o.y - o.hh < -ARENA_HALF + 3 || o.y + o.hh > ARENA_HALF - 3) insideAll = false;
    if (!(o.h > 0.5 && o.h < 4)) heightOk = false;
  }
  check(`每块掩体都在场地内且距边界 ≥ 3（ARENA_HALF ${ARENA_HALF}）`, insideAll);
  check('掩体高度在 0.5-4 之间（视觉量，不参与碰撞）', heightOk);

  let anyOverlap = null;
  for (let i = 0; i < OBSTACLES.length; i++) {
    for (let j = i + 1; j < OBSTACLES.length; j++) {
      const a = OBSTACLES[i];
      const b = OBSTACLES[j];
      // AABB overlap test with the same strictness as the collision code.
      if (a.x - a.hw < b.x + b.hw && a.x + a.hw > b.x - b.hw
        && a.y - a.hh < b.y + b.hh && a.y + a.hh > b.y - b.hh) anyOverlap = `${i}/${j}`;
    }
  }
  check('没有任何两块掩体重叠（解算一次即可，不需要迭代）', anyOverlap === null, String(anyOverlap));

  // The player spawns at the origin; melee reach is 3.4 and the weapon suites place targets 2-5
  // units out, so the origin needs real clearance.
  let minEdge = Infinity;
  for (const o of OBSTACLES) {
    const dx = Math.max(0, Math.abs(0 - o.x) - o.hw);
    const dy = Math.max(0, Math.abs(0 - o.y) - o.hh);
    minEdge = Math.min(minEdge, Math.hypot(dx, dy));
  }
  check('出生点（原点）周围净空 ≥ 10 单位', minEdge >= 10, `最近内边缘 ${minEdge.toFixed(2)}`);

  // NO SEALED POCKETS: flood fill the free space from the origin on a coarse grid. If a region were
  // walled off, enemies could spawn there (the spawn ring is player-centred, so normally not, but
  // the fallback is an arena-edge point) and the wave could never be cleared.
  const CELL = 2;
  const N = Math.ceil((ARENA_HALF * 2) / CELL);
  const r = CONFIG.playerR;
  const free = (ix, iy) => {
    const x = -ARENA_HALF + CELL * (ix + 0.5);
    const y = -ARENA_HALF + CELL * (iy + 0.5);
    return !overlapsCover({ x, y }, r, OBSTACLES);
  };
  const seen = new Uint8Array(N * N);
  const start = Math.floor(N / 2) * N + Math.floor(N / 2);
  const stack = [start];
  seen[start] = 1;
  let reached = 0;
  let freeCount = 0;
  for (let iy = 0; iy < N; iy++) for (let ix = 0; ix < N; ix++) if (free(ix, iy)) freeCount++;
  while (stack.length > 0) {
    const cur = stack.pop();
    reached++;
    const ix = cur % N;
    const iy = (cur - ix) / N;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = ix + dx;
      const ny = iy + dy;
      if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
      const idx = ny * N + nx;
      if (seen[idx] || !free(nx, ny)) continue;
      seen[idx] = 1;
      stack.push(idx);
    }
  }
  check('自由空间是连通的（没有把某块区域封死）',
    freeCount > 0 && reached / freeCount > 0.98,
    `可达 ${reached} / 自由 ${freeCount}（${((reached / freeCount) * 100).toFixed(1)}%）`);

  // The player should still be able to leave the spawn and reach the map's corners.
  const corner = { x: ARENA_HALF - 4, y: ARENA_HALF - 4 };
  let cornerReachable = false;
  for (let iy = 0; iy < N && !cornerReachable; iy++) {
    for (let ix = 0; ix < N; ix++) {
      const x = -ARENA_HALF + CELL * (ix + 0.5);
      const y = -ARENA_HALF + CELL * (iy + 0.5);
      if (seen[iy * N + ix] && Math.hypot(x - corner.x, y - corner.y) < CELL * 1.5) cornerReachable = true;
    }
  }
  check('从出生点可达地图角落（不是被困在一角）', cornerReachable);
}

// ------------------------------------------------------------------ resolution maths
{
  const box = { x: 0, y: 0, hw: 2, hh: 1 };
  const r = 0.5;

  // Deep inside on the X axis: pushed out along X (the cheaper axis), ending clear.
  const a = { x: 1.9, y: 0 };
  const moved = circleAabbResolve(a, r, box);
  check('重叠时返回 true', moved === true);
  check('从 X 方向被推到边界外（沿最小穿透轴）', near(a.x, 2 + r, 1e-9) && near(a.y, 0, 1e-9), `${a.x},${a.y}`);

  // Same, on the Y axis.
  const b = { x: 0, y: 0.9 };
  circleAabbResolve(b, r, box);
  check('从 Y 方向被推到边界外', near(b.y, 1 + r, 1e-9) && near(b.x, 0, 1e-9), `${b.x},${b.y}`);

  // Idempotent: an entity resting exactly on the boundary must NOT be moved again, or it would
  // jitter every frame while pressed against cover.
  const rest = { x: 2 + r, y: 0 };
  check('刚好贴在面上不算碰撞（第二次解算不再移动）', circleAabbResolve(rest, r, box) === false);
  check('贴面位置保持不变', near(rest.x, 2 + r) && near(rest.y, 0));

  // SLIDE: pressing into a wall FACE while moving along it must keep the tangential component.
  // (The point must penetrate one axis clearly more than the other — an exact tie has no "tangent",
  // and is covered separately below.)
  const slider = { x: 1.9, y: 0.2 };
  circleAabbResolve(slider, r, box);
  check('贴墙滑行时切向坐标不被改动（能沿墙走）',
    near(slider.x, 2 + r, 1e-9) && near(slider.y, 0.2, 1e-9), `${slider.x},${slider.y}`);

  // Exact-corner ties must still be deterministic: the same input always resolves the same way, so
  // an entity cannot oscillate between two pushes frame to frame.
  const tieA = { x: 1.9, y: 0.9 };
  const tieB = { x: 1.9, y: 0.9 };
  circleAabbResolve(tieA, r, box);
  circleAabbResolve(tieB, r, box);
  check('角点等穿透时解算结果确定（不会两帧来回抖）',
    tieA.x === tieB.x && tieA.y === tieB.y, `${tieA.x},${tieA.y} vs ${tieB.x},${tieB.y}`);

  // From the very centre, one call must be enough to get out.
  const deep = { x: 0, y: 0 };
  circleAabbResolve(deep, r, box);
  check('从掩体正中出发一次解算就能出来（不会卡在里面）', !overlapsCover(deep, r, [box]), `${deep.x},${deep.y}`);

  // resolveCover over the whole real layout: a sane point stays put.
  const clear = { x: 0, y: 0 };
  check('空旷处不会被解算移动', resolveCover(clear, r, OBSTACLES) === false);
}

// ----------------------------------------------------------------- segment maths
{
  const box = { x: 0, y: 0, hw: 1, hh: 1 };
  const hitT = segmentAabbHit({ x: -5, y: 0 }, { x: 5, y: 0 }, box);
  check('穿过盒子的线段返回入口参数 0<t<1', hitT > 0 && hitT < 1, String(hitT));
  check('入口参数对应墙面（-5 + t*10 = -1 → t = 0.4）', near(hitT, 0.4, 1e-9), String(hitT));

  check('完全错开的线段返回 -1', segmentAabbHit({ x: -5, y: 5 }, { x: 5, y: 5 }, box) === -1);
  check('从盒内出发返回 0（贴着墙开枪立刻算命中）', segmentAabbHit({ x: 0, y: 0 }, { x: 5, y: 0 }, box) === 0);
  check('零长线段在盒内返回 0', segmentAabbHit({ x: 0, y: 0 }, { x: 0, y: 0 }, box) === 0);
  check('零长线段在盒外返回 -1', segmentAabbHit({ x: 9, y: 9 }, { x: 9, y: 9 }, box) === -1);

  // The SEGMENT_SKIN rule: a line running exactly along a face is a HIT with an exact test but a
  // MISS with the skin, which is what stops a player leaning on a wall from destroying their own
  // rounds (collision parks them exactly on that face).
  // box is x,y in [-1,1]; the TOP face is y = +1.
  const alongFace = segmentAabbHit({ x: -1, y: 1 }, { x: 1, y: 1 }, box, 0);
  check('精确判定下"贴着面平行飞过"算命中（这就是需要 skin 的原因）', alongFace >= 0, String(alongFace));
  const alongSkin = segmentAabbHit({ x: -1, y: 1 }, { x: 1, y: 1 }, box, SEGMENT_SKIN);
  check('加 skin 后"贴着面平行飞过"不算命中', alongSkin === -1, String(alongSkin));
  const throughMiddle = segmentAabbHit({ x: -1, y: 0 }, { x: 1, y: 0 }, box, SEGMENT_SKIN);
  check('skin 不会放过真正穿过掩体的线段', throughMiddle >= 0, String(throughMiddle));
  check('skin 是收缩而不是放大', SEGMENT_SKIN < 0, String(SEGMENT_SKIN));

  // firstCoverHit returns the NEAREST box when several are in line.
  const near1 = { x: 3, y: 0, hw: 0.5, hh: 3, h: 2 };
  const far1 = { x: 7, y: 0, hw: 0.5, hh: 3, h: 2 };
  const hit = firstCoverHit({ x: 0, y: 0 }, { x: 10, y: 0 }, [far1, near1]);
  check('firstCoverHit 返回最近的一块（与数组顺序无关）', hit !== null && hit.box === near1, String(hit && hit.box === near1));
  check('无遮挡时返回 null', firstCoverHit({ x: 0, y: 0 }, { x: 0, y: 10 }, [near1, far1]) === null);
}

// ------------------------------------------------------------- nearest-point maths
//
// `nearestPointOnAabb` decides whether a piece of cover is lit (see vision.ts::coverVisible), so it
// is verified against a brute-force walk of the box perimeter rather than against itself.
{
  const boxes = [
    { x: 0, y: 0, hw: 1, hh: 3 },        // a long wall
    { x: -22.5, y: 7.25, hw: 4, hh: 0.8 },
    { x: 9, y: -9, hw: 0.4, hh: 0.4 },   // a small pillar
  ];
  let seed = 20240607;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let worstGap = 0;
  let offBox = 0;
  let outsideOk = true;
  let insideOk = true;
  for (let k = 0; k < 120; k++) {
    const p = { x: (rnd() * 2 - 1) * 40, y: (rnd() * 2 - 1) * 40 };
    const box = boxes[k % boxes.length];
    const q = nearestPointOnAabb(p, box);
    // The result must sit on the box (clamped per axis).
    if (q.x < box.x - box.hw - 1e-12 || q.x > box.x + box.hw + 1e-12
      || q.y < box.y - box.hh - 1e-12 || q.y > box.y + box.hh + 1e-12) offBox++;
    // Brute force: the best distance over 800 perimeter samples cannot beat it.
    let best = Infinity;
    const per = 2 * (2 * box.hw + 2 * box.hh);
    for (let t = 0; t < 800; t++) {
      const s = (t / 800) * per;
      let sx; let sy;
      if (s < 2 * box.hw) { sx = box.x - box.hw + s; sy = box.y - box.hh; }
      else if (s < 2 * box.hw + 2 * box.hh) { sx = box.x + box.hw; sy = box.y - box.hh + (s - 2 * box.hw); }
      else if (s < 4 * box.hw + 2 * box.hh) { sx = box.x + box.hw - (s - 2 * box.hw - 2 * box.hh); sy = box.y + box.hh; }
      else { sx = box.x - box.hw; sy = box.y + box.hh - (s - 4 * box.hw - 2 * box.hh); }
      const d = Math.hypot(p.x - sx, p.y - sy);
      if (d < best) best = d;
    }
    const got = Math.hypot(p.x - q.x, p.y - q.y);
    const gap = got - best;
    if (gap > worstGap) worstGap = gap;
    // Inside the box the nearest point is the query itself; outside it must be on the boundary.
    const inside = p.x > box.x - box.hw && p.x < box.x + box.hw && p.y > box.y - box.hh && p.y < box.y + box.hh;
    if (inside && (q.x !== p.x || q.y !== p.y)) insideOk = false;
    if (!inside && got < 1e-9) outsideOk = false;
  }
  check('最近点始终落在盒子上', offBox === 0, String(offBox));
  check('最近点不差于 800 点周界暴力采样', worstGap <= 1e-3, `最大差距 ${worstGap.toFixed(6)}`);
  check('盒外的查询，最近点在盒面上（距离 > 0）', outsideOk);
  check('盒内的查询，最近点就是它自己', insideOk);
  check('out 参数被写穿复用（渲染层每帧免分配）', (() => {
    const out = { x: 0, y: 0 };
    const r = nearestPointOnAabb({ x: -5, y: 2 }, boxes[0], out);
    return r === out && out.x === -1 && out.y === 2;
  })());
}

// ------------------------------------------------------- bullets are stopped by cover
{
  // A minimal test arena: one wall at x = 6 spanning z in [-6, 6].
  const wall = [{ x: 6, y: 0, hw: 1, hh: 6, h: 2.5 }];

  const blocked = freshSim('dragonBreath', wall);
  const behind = addEnemy(blocked, 9, 0, 100);
  blocked.update(DT, aimAt(1, 0));
  for (let i = 0; i < 30; i++) blocked.update(DT, aimAt(1, 0));
  check('掩体后面的敌人完全不吃伤害', behind.hp === 100, String(behind.hp));
  check('子弹被墙吃掉（不会穿过去继续飞）', blocked.bullets.length === 0, String(blocked.bullets.length));
  check('打在墙上会喷火花', blocked.particles.length > 0, String(blocked.particles.length));

  // Control: the same shot with the wall removed must land.
  const open = freshSim('dragonBreath', []);
  const front = addEnemy(open, 9, 0, 100);
  open.update(DT, aimAt(1, 0));
  for (let i = 0; i < 30; i++) open.update(DT, aimAt(1, 0));
  check('没有墙时同样的射击能打中（对照组）', front.hp < 100, String(front.hp));

  // An enemy IN FRONT of the wall is still hittable — cover protects what is behind it, not
  // everything in the direction of fire.
  const inFront = freshSim('dragonBreath', wall);
  const visible = addEnemy(inFront, 3, 0, 100);
  inFront.update(DT, aimAt(1, 0));
  for (let i = 0; i < 30; i++) inFront.update(DT, aimAt(1, 0));
  check('掩体前面的敌人照常被打中', visible.hp < 100, String(visible.hp));

  // Enemy rounds obey the same rule: a gunner behind a wall cannot hit the player.
  const player = freshSim('smg', wall);
  const gunner = addEnemy(player, 9, 0, 100, 'gunner');
  gunner.fireT = CONFIG.gunnerAimTime;   // one telegraph away from firing
  const hp0 = player.player.hp;
  for (let i = 0; i < 90; i++) player.update(DT, idle);
  check('隔着掩体的枪手打不到玩家', player.player.hp === hp0, `${hp0} -> ${player.player.hp}`);
  check('隔着掩体的枪手也不会开火（没有子弹）', player.bullets.every((b) => b.fromPlayer), 'found enemy rounds');
}

// ------------------------------------------- melee sweeps respect cover (no cutting through walls)
{
  const wall = [{ x: 3, y: 0, hw: 0.6, hh: 4, h: 2.5 }];
  const blocked = freshSim('sword', wall);
  // 3.9 is inside reach + enemyR (3.4 + 0.7 = 4.1) yet behind the wall at x = 3.
  const behind = addEnemy(blocked, 3.9, 0, 100);
  blocked.update(DT, aimAt(1, 0));
  check('墙后的敌人在砍刀射程内也不掉血（刀不能穿墙）', behind.hp === 100, String(behind.hp));

  const open = freshSim('sword', []);
  const reachable = addEnemy(open, 3.9, 0, 100);
  open.update(DT, aimAt(1, 0));
  check('没有墙时同样的挥砍命中（对照组）', reachable.hp < 100, String(reachable.hp));
}

// ----------------------------------------------- the RPG detonates on cover, blast respects LOS
{
  const wall = [{ x: 6, y: 0, hw: 1, hh: 6, h: 2.5 }];
  const sim = freshSim('rpg', wall);
  // In front of the blast point (5,0) and off to the side, so the rocket itself misses it.
  const front = addEnemy(sim, 4.5, 3, 1000);
  // Directly behind the wall: inside the 3.5 blast radius but with no line of sight.
  const behind = addEnemy(sim, 7.5, 0, 1000);
  sim.update(DT, aimAt(1, 0));
  for (let i = 0; i < 60; i++) sim.update(DT, idle);
  check('火箭撞墙会爆炸（火箭弹不在墙上凭空消失）', sim.particles.length > 0, String(sim.particles.length));
  check('爆炸照亮了墙前侧的目标', front.hp < 1000, String(front.hp));
  check('爆炸不会绕过墙角打到墙后侧的目标', behind.hp === 1000, String(behind.hp));
}

// ------------------------------------------------------------------------- summary
console.log(`\nverify-cover: ${passed} 项通过, ${failures.length} 项失败`);
if (failures.length > 0) {
  console.log('\n失败项:');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('全部通过 ✓');
