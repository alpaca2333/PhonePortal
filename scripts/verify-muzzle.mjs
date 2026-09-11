/**
 * CPU-side verification for the MUZZLE FLASHES (apps/shooter/src/muzzle.ts + the sim/renderer wiring).
 *
 * No GPU here, so the flash cannot be looked at. What CAN be proven is the part that usually rots:
 *
 *   1. THE RECIPES ARE SOUND: every ranged weapon carries its own definition, the definitions are
 *      distinguishable (no copy-paste), the physics presets are the SAME constants the sparks /
 *      flames / explosion already use (so retuning those cannot silently skip the muzzle), and
 *      normal-blended layers are never dimmed (additive dimming is for hue stability; a dimmed
 *      smoke puff is just a lie about its colour).
 *   2. THE INVARIANT BEHIND ALL THREE REQUESTS: `muzzleMaxLife(def) < weapon.cooldown` — the SMG's
 *      "一闪而过", the shotgun's "不要时长太长" and the RPG's "爆燃但不拖沓" are all the same
 *      arithmetic claim, and it is what guarantees a held trigger can never stack flashes into a
 *      permanent glow. The light's life is held to the same bound.
 *   3. WHAT ACTUALLY COMES OUT: firing each weapon once emits EXACTLY the recipe's particles, at the
 *      SAME point the projectiles left (asserted against a wrapped `spawnProjectile`), along the
 *      weapon's nominal aim rather than one pellet's spread direction, and ONCE per shot however many
 *      pellets there are. The layer structure is then checked in the output: the SMG's forward star,
 *      the shotgun's gravity-driven embers, the RPG's evenly spaced ring + REARWARD backblast cone +
 *      the two normal-blended layers additive cannot draw.
 *   4. IT CLEANS UP: the particles die, the light state drains to empty, `reset()` clears both (a
 *      flash surviving a restart would light the next run), the state array is capped for dirty
 *      definitions, and an unusable definition is a silent no-op rather than a crash.
 *   5. THE LIGHT IS WIRED AS DOCUMENTED: the decay curve is monotone and NaN-safe, every muzzle light
 *      outshines the tracer it launches, and the renderer assigns it from the SAME capped 8-light
 *      pool as the projectiles (muzzle first) so the scene's point-light count did not grow.
 *
 * Run:  npm run build && node scripts/verify-muzzle.mjs
 * Exit code is non-zero when any assertion fails.
 */
import { readFileSync } from 'node:fs';

const GAME = new URL('../dist/apps/shooter/src/game.js', import.meta.url);
const WEAPONS_URL = new URL('../dist/apps/shooter/src/weapons.js', import.meta.url);
const MUZZLE_URL = new URL('../dist/apps/shooter/src/muzzle.js', import.meta.url);

const { GameSim, CONFIG } = await import(GAME.href);
const { WEAPONS } = await import(WEAPONS_URL.href);
const {
  MUZZLE, MUZZLE_PARTICLE_BUDGET, MUZZLE_PHYSICS, MUZZLE_Y,
  isUsableMuzzleDef, muzzleMaxLife, muzzleParticleCount,
} = await import(MUZZLE_URL.href);
// The transient-light system every flashing effect shares (fxlight.ts): muzzle flashes AND explosions
// feed one capped list, which the renderer replays through one capped point-light pool.
const { FX_LIGHT_MAX, fxLightScale, makeFxLight, pushFxLight } = await import(
  new URL('../dist/apps/shooter/src/fxlight.js', import.meta.url).href);

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
const RANGED = ['smg', 'dragonBreath', 'rpg'];

/** Fresh sim on an EMPTY arena (this suite is about muzzle VFX, not the level or the weapons). */
function freshSim(weaponId) {
  const sim = new GameSim();
  sim.spawnQueue = 0;
  sim.spawnTimer = 0;
  sim.enemies = [];
  sim.obstacles = [];
  if (weaponId) sim.equipWeapon(weaponId);
  return sim;
}

function run(sim, seconds, input = idle, dt = DT) {
  const frames = Math.round(seconds / dt);
  for (let i = 0; i < frames; i++) { sim.update(dt, input); sim.spawnQueue = 0; }
}

/** Fire once (a fresh sim fires on its first update) and return the sim, mid-flight. */
function fireOnce(weaponId, aim = { x: 1, y: 0 }) {
  const sim = freshSim(weaponId);
  sim.player.ammo = 1e9;
  sim.update(DT, { move: { x: 0, y: 0 }, aim, firing: true, autoAim: false });
  sim.spawnQueue = 0;
  return sim;
}

// Recipe readers (mirrors of the data, so the assertions below stay readable).
const physOf = (l) => MUZZLE_PHYSICS[l.physics];
const countWhere = (def, pred) => def.layers.filter(pred).reduce((n, l) => n + l.count, 0);
const maxSpeed = (def) => Math.max(...def.layers.map((l) => l.speed[1]));
const maxVy = (def) => Math.max(...def.layers.map((l) => (l.vy ? l.vy[1] : 0)));
const maxYSpread = (def) => Math.max(...def.layers.map((l) => l.ySpread ?? 0));
// Vertical motion in one frame is TWO terms, and the bound has to carry both: the sim integrates
// `pt.vy += pt.buoy * dt; pt.y += pt.vy * dt`, i.e. `rise = vy0*dt + buoy*dt^2`. Leaving the buoyancy
// term out made this check flaky (measured over 400 shots: the true maximum rise is 0.01383 for the
// SMG — vy 0.8 plus the flame layer's buoyancy 1.8 — against a bound of 0.01333, so any shot that
// rolled a `vy` near the top of its range failed).
const maxBuoy = (def) => Math.max(0, ...def.layers.map((l) => physOf(l).buoy ?? 0));

// ---------------------------------------------------------------- 1. recipes are sound
{
  check('every ranged weapon carries its own muzzle definition (melee has none)',
    RANGED.every((id) => WEAPONS[id].muzzle === MUZZLE[id]) && WEAPONS.sword.muzzle === undefined,
    RANGED.map((id) => (WEAPONS[id].muzzle ? WEAPONS[id].muzzle.id : 'MISSING')).join(','));
  check('the three recipes are distinguishable, not copies',
    new Set(RANGED.map((id) => MUZZLE[id].light.color)).size === 3 &&
    new Set(RANGED.map((id) => MUZZLE[id].layers.length)).size === 3 &&
    new Set(RANGED.map((id) => muzzleParticleCount(MUZZLE[id]))).size === 3,
    RANGED.map((id) => `${id}:${MUZZLE[id].layers.length}层/${muzzleParticleCount(MUZZLE[id])}颗/0x${MUZZLE[id].light.color.toString(16)}`).join(' '));
  check('the layer counts are the documented 3 / 4 / 6',
    MUZZLE.smg.layers.length === 3 && MUZZLE.dragonBreath.layers.length === 4 && MUZZLE.rpg.layers.length === 6,
    RANGED.map((id) => MUZZLE[id].layers.length).join('/'));
  check('the per-shot particle counts are the documented 9 / 19 / 31',
    muzzleParticleCount(MUZZLE.smg) === 9 && muzzleParticleCount(MUZZLE.dragonBreath) === 19 && muzzleParticleCount(MUZZLE.rpg) === 31,
    RANGED.map((id) => muzzleParticleCount(MUZZLE[id])).join('/'));
  check('no recipe exceeds the per-shot particle budget (a flash must not dent the 2048 pool)',
    RANGED.every((id) => muzzleParticleCount(MUZZLE[id]) <= MUZZLE_PARTICLE_BUDGET),
    `${Math.max(...RANGED.map((id) => muzzleParticleCount(MUZZLE[id])))} <= ${MUZZLE_PARTICLE_BUDGET}`);
  check('every colour is a #rrggbb literal from the shared palettes',
    RANGED.every((id) => MUZZLE[id].layers.every((l) => l.colors.every((c) => /^#[0-9a-f]{6}$/.test(c)))),
    JSON.stringify(MUZZLE.smg.layers[0].colors));
  check('every recipe passes the dirty-data gate (the recipes themselves are usable)',
    RANGED.every((id) => isUsableMuzzleDef(MUZZLE[id])));
  check('normal-blended layers are never dimmed (smoke/debris colours are literal on screen)',
    RANGED.every((id) => MUZZLE[id].layers.every((l) => !physOf(l).solid || l.dim === 1)),
    JSON.stringify(MUZZLE.rpg.layers.filter((l) => physOf(l).solid).map((l) => l.dim)));
  check('the SMG has NO normal-blended layer (10 rounds/s would stack smoke into a haze)',
    MUZZLE.smg.layers.every((l) => !physOf(l).solid));
  check('the RPG has BOTH normal-blended layers (the two additive blending cannot draw)',
    MUZZLE.rpg.layers.some((l) => l.physics === 'smoke') && MUZZLE.rpg.layers.some((l) => l.physics === 'debris'));
  check('the shotgun fires sparks as its dominant layer (the ask was 枪口火花)',
    countWhere(MUZZLE.dragonBreath, (l) => !physOf(l).puff) > 0.5 * muzzleParticleCount(MUZZLE.dragonBreath),
    `${countWhere(MUZZLE.dragonBreath, (l) => !physOf(l).puff)}/${muzzleParticleCount(MUZZLE.dragonBreath)} streaks`);
  check('only the RPG aims a layer backwards (the open-tube backblast)',
    MUZZLE.rpg.layers.some((l) => (l.angle ?? 0) > Math.PI / 2) &&
    !MUZZLE.smg.layers.some((l) => (l.angle ?? 0) > Math.PI / 2) &&
    !MUZZLE.dragonBreath.layers.some((l) => (l.angle ?? 0) > Math.PI / 2));
}

// ---------------------------------------------------------------- 2. the "not too long" invariant
{
  check('the muzzle height is chest height, not the ground (projectiles render at y=0.35)',
    MUZZLE_Y === 0.75 && MUZZLE_Y > 0.35);
  for (const id of RANGED) {
    const def = MUZZLE[id];
    const cd = WEAPONS[id].cooldown;
    check(`${id}: 最长粒子寿命 < 该武器 cadence（连发不会堆成常亮）`,
      muzzleMaxLife(def) < cd,
      `${muzzleMaxLife(def).toFixed(3)}s < ${cd}s (light ${def.light.life}s)`);
    check(`${id}: 光源寿命 < 该武器 cadence`,
      def.light.life < cd, `${def.light.life}s < ${cd}s`);
  }
  check('the SMG flash is over inside ONE cadence (0.09s of particles, 0.05s of light)',
    muzzleMaxLife(MUZZLE.smg) < 0.1 && MUZZLE.smg.light.life <= 0.05,
    `${muzzleMaxLife(MUZZLE.smg)}s / ${MUZZLE.smg.light.life}s`);
}

// ---------------------------------------------------------------- 3. physics presets stay in sync
{
  check('spark preset == the impact-spark physics (no second definition of a spark)',
    MUZZLE_PHYSICS.spark.puff === false && MUZZLE_PHYSICS.spark.solid === false &&
    MUZZLE_PHYSICS.spark.drag === CONFIG.sparkDrag && MUZZLE_PHYSICS.spark.swirl === CONFIG.sparkCurl);
  check('flame preset == the burn-flame physics, including the 0.55 narrow tongue',
    MUZZLE_PHYSICS.flame.puff === true && MUZZLE_PHYSICS.flame.aspect === CONFIG.flameAspect &&
    MUZZLE_PHYSICS.flame.buoy === CONFIG.flameBuoy && MUZZLE_PHYSICS.flame.drag === CONFIG.flameDrag &&
    MUZZLE_PHYSICS.flame.swirl === CONFIG.flameSwirl);
  check('ring preset == the explosion shockwave (hard-damped, travel = speed/drag)',
    MUZZLE_PHYSICS.ring.drag === CONFIG.blastRingDrag && MUZZLE_PHYSICS.ring.swirl === 0 &&
    MUZZLE_PHYSICS.ring.puff === false);
  check('smoke preset == the explosion smoke (slow buoyancy, normal-blended billboard)',
    MUZZLE_PHYSICS.smoke.solid === true && MUZZLE_PHYSICS.smoke.puff === true &&
    MUZZLE_PHYSICS.smoke.buoy === CONFIG.blastSmokeRise && MUZZLE_PHYSICS.smoke.drag === 1.2);
  check('debris preset == the explosion debris (gravity + normal blending)',
    MUZZLE_PHYSICS.debris.solid === true && MUZZLE_PHYSICS.debris.buoy === CONFIG.blastGravity &&
    MUZZLE_PHYSICS.debris.drag === 3);
  check('ember preset == the explosion embers (gravity, low drag, weak curl)',
    MUZZLE_PHYSICS.ember.solid === false && MUZZLE_PHYSICS.ember.buoy === CONFIG.blastGravity &&
    MUZZLE_PHYSICS.ember.drag === CONFIG.blastEmberDrag &&
    near(MUZZLE_PHYSICS.ember.swirl, CONFIG.sparkCurl * 0.12));
}

// ---------------------------------------------------------------- 4. what one shot actually emits
{
  for (const id of RANGED) {
    const def = MUZZLE[id];
    const sim = fireOnce(id);
    const parts = sim.particles;
    const muzzleOff = sim.player.r + WEAPONS[id].muzzleOffset;
    const mx = Math.cos(sim.player.aimAngle) * muzzleOff;
    const mz = Math.sin(sim.player.aimAngle) * muzzleOff;

    check(`${id}: one shot emits exactly the recipe's ${muzzleParticleCount(def)} particles`,
      parts.length === muzzleParticleCount(def), `${parts.length}`);
    check(`${id}: exactly one light per shot`, sim.fxLights.length === 1, String(sim.fxLights.length));
    check(`${id}: the flash's clock starts at 0 with the light's life`,
      sim.fxLights[0].t === 0 && sim.fxLights[0].max === def.light.life);
    check(`${id}: the layer split survives the sim (puff / streak / normal-blended counts)`,
      parts.filter((p) => p.puff).length === countWhere(def, (l) => physOf(l).puff) &&
      parts.filter((p) => !p.puff).length === countWhere(def, (l) => !physOf(l).puff) &&
      parts.filter((p) => p.solid).length === countWhere(def, (l) => physOf(l).solid),
      `${parts.filter((p) => p.puff).length}/${parts.filter((p) => !p.puff).length}/${parts.filter((p) => p.solid).length}`);
    // One integration step already ran inside update(), so the spawn point is within one frame of
    // straight-line motion at the layer's top speed. This is the tightest honest bound.
    check(`${id}: every particle is at the muzzle (one frame of travel at the layer's max speed)`,
      parts.every((p) => Math.hypot(p.pos.x - mx, p.pos.y - mz) <= maxSpeed(def) * DT + 1e-9),
      `max ${Math.max(...parts.map((p) => Math.hypot(p.pos.x - mx, p.pos.y - mz))).toFixed(4)} <= ${(maxSpeed(def) * DT).toFixed(4)}`);
    check(`${id}: every particle starts at muzzle HEIGHT (never on the floor at y=0.2)`,
      parts.every((p) => Math.abs(p.y - MUZZLE_Y) <=
        (maxVy(def) + maxBuoy(def) * DT) * DT + maxYSpread(def) + 1e-9) &&
      parts.every((p) => p.y > 0.4),
      `y ${Math.min(...parts.map((p) => p.y)).toFixed(3)}..${Math.max(...parts.map((p) => p.y)).toFixed(3)}`);
    check(`${id}: lifetimes, sizes and speeds are finite and inside their declared ranges`,
      parts.every((p) => Number.isFinite(p.pos.x) && Number.isFinite(p.vel.x) && Number.isFinite(p.y) &&
        Number.isFinite(p.vy) && Number.isFinite(p.size) && Number.isFinite(p.len) &&
        p.life > 0 && p.life <= muzzleMaxLife(def) + 1e-9 && p.alive === true));
    check(`${id}: puffs flicker individually, streaks do not`,
      parts.every((p) => (p.puff ? p.flick > 0 : p.flick === 0)));
  }
}

// ---------------------------------------------------------------- 5. the SMG star (distribution)
{
  // 200 shots of bearings, the same style as verify-ammo's 2000-shot spread check: the SHAPE of the
  // star is a distribution property, so asserting it on one lucky frame would be a coin flip.
  const sim = freshSim('smg');
  sim.player.ammo = 1e9;
  const seen = new Set();
  const groups = [];
  let maxAlive = 0;
  let shots = 0;
  const origSpawn = sim.spawnProjectile.bind(sim);
  sim.spawnProjectile = (d, p, dir) => { shots++; origSpawn(d, p, dir); };
  for (let i = 0; i < Math.round(20 / DT); i++) {
    sim.update(DT, firing);
    sim.spawnQueue = 0;
    const fresh = [];
    for (const pt of sim.particles) if (!seen.has(pt)) { seen.add(pt); fresh.push(pt); }
    if (fresh.length) groups.push(fresh);
    maxAlive = Math.max(maxAlive, sim.particles.length);
  }
  // The burst is a fixed 20s DURATION, so the shot count follows the cadence (13/s since the
  // 「射速提高 1.3 倍」 change) — the invariant under test is "one muzzle event per shot, 9 particles
  // each", NOT a hard-coded round count.
  const expectedShots = 1 + Math.floor(20 / WEAPONS.smg.cooldown + 1e-9);
  check(`20 秒连射 = 每次开火正好一组特效、每组正好 9 颗（≈${expectedShots} 发）`,
    Math.abs(shots - expectedShots) <= 1 && groups.length === shots && groups.every((g) => g.length === 9),
    `shots=${shots} groups=${groups.length} sizes=${[...new Set(groups.map((g) => g.length))].join(',')}`);
  const streaks = groups.flatMap((g) => g.filter((p) => !p.puff));
  // Bearings measured ONE integration step after spawn, i.e. after a frame of curl noise has already
  // bent the fast sparks — that is the look ("alive"), but it means a bound assertion here would be
  // measuring the noise field. The SPAWN-TIME cone is asserted separately below, at a timestep small
  // enough that one step is negligible (the lesson verify-melee.mjs records as "measure at spawn").
  const bearings = streaks.map((p) => Math.atan2(p.vel.y, p.vel.x));
  const cone = MUZZLE.smg.layers[2].cone;
  check('星芒覆盖整个锥角（不是全挤在瞄准线上）',
    Math.min(...bearings) <= -cone * 0.9 && Math.max(...bearings) >= cone * 0.9,
    `${Math.min(...bearings).toFixed(3)} .. ${Math.max(...bearings).toFixed(3)}`);
  check('星芒两侧都有（不是单边扇形）',
    bearings.filter((a) => a > 0).length > 100 && bearings.filter((a) => a < 0).length > 100,
    `${bearings.filter((a) => a > 0).length} 正 / ${bearings.filter((a) => a < 0).length} 负`);
  check('全自动连发不累积（同屏粒子永远不超过两发的量，实测峰值给在 detail）',
    maxAlive <= 18, `peak alive = ${maxAlive}`);

  // Spawn-time cone: 1/2000s steps, so a single step of drag+curl moves the bearing by ~0.002 rad
  // (measured over 200 trials the worst overshoot of the 0.55 cone was 0.0011).
  const tight = freshSim('smg');
  tight.update(1 / 2000, { move: { x: 0, y: 0 }, aim: { x: 1, y: 0 }, firing: true, autoAim: false });
  const spawnBounds = tight.particles.filter((p) => !p.puff).map((p) => Math.abs(Math.atan2(p.vel.y, p.vel.x)));
  check('出膛那一刻，每颗星芒都在配方声明的 ±cone 内（锥角不是事后凑的）',
    spawnBounds.length === 7 && spawnBounds.every((a) => a <= cone + 0.02),
    `max ${Math.max(...spawnBounds).toFixed(4)} <= ${(cone + 0.02).toFixed(3)}`);
}

// ---------------------------------------------------------------- 6. shotgun embers + RPG structure
{
  const shot = fireOnce('dragonBreath');
  const embers = shot.particles.filter((p) => p.buoy === CONFIG.blastGravity && !p.puff);
  check('龙息喷有一层带重力的余烬（弧线坠落 = 「灵动自然」的量化来源）',
    embers.length === 4 && embers.every((p) => p.vy > 0),
    `${embers.length} embers, vy ${embers.map((p) => p.vy.toFixed(2)).join(',')}`);
  check('龙息喷的火舌复用燃烧 DoT 的那把火（flame 物理 + 0.55 窄火舌）',
    shot.particles.filter((p) => p.puff && p.aspect === CONFIG.flameAspect).length === 4 &&
    shot.particles.filter((p) => p.buoy === CONFIG.flameBuoy).length === 4);
  check('龙息喷一次齐射 8 颗弹丸仍然只有一次枪口特效 + 8 颗散布弹丸',
    shot.bullets.length === 8 && shot.fxLights.length === 1,
    `${shot.bullets.length} pellets / ${shot.fxLights.length} flash`);

  const rpg = fireOnce('rpg');
  // The ring is the only additive streak layer with NO curl (hard-damped: travel ≈ speed/drag);
  // `!solid` keeps the debris layer (also swirl 0) out of this filter.
  const ring = rpg.particles.filter((p) => !p.puff && !p.solid && p.swirl === 0);
  const back = rpg.particles.filter((p) => !p.puff && p.swirl === CONFIG.sparkCurl);
  check('RPG 冲击环是 6 颗等角分布（不是随机扇形：6 颗随机画出来会明显歪）',
    ring.length === 6, String(ring.length));
  if (ring.length === 6) {
    const angs = ring.map((p) => Math.atan2(p.vel.y, p.vel.x)).sort((a, b) => a - b);
    const gaps = angs.map((a, i) => (i === 0 ? angs[0] + Math.PI * 2 - angs[5] : a - angs[i - 1]));
    check('RPG 冲击环的相邻夹角全部相等（等角分布，误差 < 1e-6）',
      gaps.every((g) => near(g, (Math.PI * 2) / 6, 1e-6)),
      gaps.map((g) => g.toFixed(6)).join(', '));
  }
  check('RPG 有一层向后的爆燃（火箭筒是开口筒，尾焰在身后）',
    back.length === 10 && back.every((p) => p.vel.x < 0),
    `${back.length} rearward streaks, max vx ${Math.max(...back.map((p) => p.vel.x)).toFixed(2)}`);
  check('RPG 的烟与碎片走正常混合（加色混合画不出深色）',
    rpg.particles.filter((p) => p.solid && p.puff).length === 4 &&
    rpg.particles.filter((p) => p.solid && !p.puff).length === 4);
  check('RPG 一次开火 = 31 颗粒子，全部在 0.5s 内结束',
    rpg.particles.length === 31 && rpg.particles.every((p) => p.life <= 0.5 + 1e-9));
}

// ---------------------------------------------------------------- 7. same point, same direction
{
  // Wrap the projectile spawn and compare it with the flash the weapon emitted in the SAME call.
  const sim = freshSim('dragonBreath');
  const spawns = [];
  const orig = sim.spawnProjectile.bind(sim);
  sim.spawnProjectile = (d, pos, dir) => { spawns.push({ pos: { x: pos.x, y: pos.y }, dir: { x: dir.x, y: dir.y } }); orig(d, pos, dir); };
  const aim = { x: 0, y: 1 };
  sim.update(DT, { move: { x: 0, y: 0 }, aim, firing: true, autoAim: false });
  const fx = sim.fxLights[0];
  const off = sim.player.r + WEAPONS.dragonBreath.muzzleOffset;
  check('枪口特效与弹丸出生点严格同点（同一个 Vec2，不是重算的公式）',
    fx && spawns.length === 8 && fx.x === spawns[0].pos.x && fx.z === spawns[0].pos.y,
    fx ? `flash (${fx.x},${fx.z}) vs pellet0 (${spawns[0].pos.x},${spawns[0].pos.y})` : 'no flash');
  check('枪口特效沿「瞄准方向」，不是某一颗弹丸的散布方向',
    near(fx.x, 0, 1e-12) && near(fx.z, off, 1e-12) &&
    near(Math.atan2(fx.dz, fx.dx), Math.PI / 2, 1e-12),
    `(${fx.x},${fx.z}) dir (${fx.dx},${fx.dz})`);
  const deviation = Math.max(...spawns.map((s) => Math.abs(Math.atan2(s.dir.y, s.dir.x) - Math.atan2(fx.dz, fx.dx))));
  check('弹丸确实带着散布离开（枪口特效没跟着某颗弹丸歪）', deviation > 0.05, `max ${deviation.toFixed(3)} rad`);
}

// ---------------------------------------------------------------- 8. lifecycle + defensive paths
{
  const sim = fireOnce('rpg');
  check('开火当帧确实有东西', sim.particles.length > 0 && sim.fxLights.length === 1);
  run(sim, 1.5);
  check('粒子与光源状态都会自己排空（没有留在数组里的僵尸）',
    sim.particles.length === 0 && sim.fxLights.length === 0,
    `particles=${sim.particles.length} lights=${sim.fxLights.length}`);

  const restart = fireOnce('smg');
  restart.reset();
  check('reset() 清空枪口状态（否则上一局的火光会照亮下一局）',
    restart.fxLights.length === 0 && restart.particles.length === 0);

  // Cap: push past FX_LIGHT_MAX and check which entries survived. An FxLight carries no recipe (it is
  // deliberately flattened so the renderer never needs to know what produced it), so the tag rides
  // the light's own colour.
  const capped = freshSim();
  const tag = (i) => ({ ...MUZZLE.smg, light: { ...MUZZLE.smg.light, color: 0x100000 + i } });
  for (let i = 0; i < FX_LIGHT_MAX + 4; i++) capped.spawnMuzzleFlash({ x: 0, y: 0 }, { x: 1, y: 0 }, tag(i));
  check('瞬时灯光列表有上限，且保留的是最新的（丢的是最旧的）',
    capped.fxLights.length === FX_LIGHT_MAX &&
    capped.fxLights.every((fx, i) => fx.color === 0x100000 + (i + 4)),
    `${capped.fxLights.length} kept, first=0x${capped.fxLights[0].color.toString(16)}`);

  // Dirty definitions must be silent no-ops, never throws and never NaN particles.
  const dirty = freshSim();
  const before = dirty.particles.length;
  const bad = [undefined, null, {}, 'smg', 42, { ...MUZZLE.smg, light: { ...MUZZLE.smg.light, life: NaN } },
    { ...MUZZLE.smg, layers: [{ ...MUZZLE.smg.layers[0], physics: 'plasma' }] },
    { ...MUZZLE.smg, layers: [{ ...MUZZLE.smg.layers[0], count: -3 }] }];
  let threw = null;
  for (const def of bad) {
    try { dirty.spawnMuzzleFlash({ x: 0, y: 0 }, { x: 1, y: 0 }, def); } catch (err) { threw = String(err); }
  }
  check('脏/缺失定义是静默 no-op（不抛错、不生成 NaN 粒子、不留下光源）',
    threw === null && dirty.particles.length === before && dirty.fxLights.length === 0,
    threw || `particles ${before} -> ${dirty.particles.length}`);

  // A hand-built weapon with no `muzzle` field at all must still fire (verify-ammo's `__probe` case).
  const { WEAPONS: W } = await import(WEAPONS_URL.href);
  W.__muzzleProbe = {
    id: '__muzzleProbe', name: '探针', kind: 'ranged', cooldown: 0.2, shake: 0, recoil: 0,
    projectile: WEAPONS.smg.projectile, ammoId: 'ammo9mm', pellets: 1, spread: 0,
    muzzleOffset: 0.2, magSize: 3, reloadTime: 0.5,
  };
  const probe = freshSim('__muzzleProbe');
  let probeThrew = null;
  try {
    run(probe, 0.05, firing);
  } catch (err) { probeThrew = String(err); }
  check('没有 muzzle 字段的合成武器照旧能开火（枪口特效只是可选装饰）',
    probeThrew === null && probe.bullets.length > 0 && probe.particles.length === 0 && probe.fxLights.length === 0,
    probeThrew || `bullets=${probe.bullets.length} particles=${probe.particles.length}`);
  delete W.__muzzleProbe;
}

// ---------------------------------------------------------------- 9. the light
{
  check('衰减曲线：起点 1、终点 0、严格单调下降',
    fxLightScale(0, 0.05, 2.8) === 1 && fxLightScale(0.05, 0.05, 2.8) === 0 &&
    fxLightScale(0.06, 0.05, 2.8) === 0 && fxLightScale(-1, 0.05, 2.8) === 1);
  const max = MUZZLE.rpg.light.life;
  let prev = 2;
  let mono = true;
  let inRange = true;
  for (let i = 0; i <= 200; i++) {
    const v = fxLightScale((i / 200) * max, max, MUZZLE.rpg.light.falloff);
    if (!(v < prev)) mono = false;
    if (!(v >= 0 && v <= 1)) inRange = false;
    prev = v;
  }
  check('衰减曲线在整段寿命上单调且落在 0..1', mono && inRange);
  check('高指数 = 一闪（SMG 的 0.05s 光源在 10% 寿命处就掉到 ~20% 以下）',
    fxLightScale(0.005, 0.05, 2.8) < 0.8 && fxLightScale(0.005, 0.05, 1.5) > fxLightScale(0.005, 0.05, 2.8),
    `${fxLightScale(0.005, 0.05, 2.8).toFixed(3)} vs ${fxLightScale(0.005, 0.05, 1.5).toFixed(3)}`);
  check('NaN / 零寿命输入不会外泄成 NaN uniform',
    fxLightScale(NaN, 0.05, 2) === 0 && fxLightScale(0, 0, 2) === 0 &&
    fxLightScale(0, 0.05, NaN) === 0 && fxLightScale(0, -1, 2) === 0);
  check('光源构造器：脏 spec 一律返回 null（NaN 位置 / 零寿命 / 负强度 / 非对象）',
    makeFxLight({ x: NaN, z: 0, y: 1, color: 1, intensity: 1, distance: 1, life: 1, falloff: 1 }) === null &&
    makeFxLight({ x: 0, z: Infinity, y: 1, color: 1, intensity: 1, distance: 1, life: 1, falloff: 1 }) === null &&
    makeFxLight({ x: 0, z: 0, y: 1, color: 1, intensity: 1, distance: 1, life: 0, falloff: 1 }) === null &&
    makeFxLight({ x: 0, z: 0, y: 1, color: 1, intensity: -1, distance: 1, life: 1, falloff: 1 }) === null &&
    makeFxLight({ x: 0, z: 0, y: 1, color: 1, intensity: 1, distance: 1, life: 1, falloff: NaN }) === null &&
    makeFxLight(null) === null && makeFxLight(undefined) === null);
  {
    const ok = makeFxLight({ x: 1, z: 2, y: 0.75, color: 0xff0000, intensity: 5, distance: 6, life: 0.4, falloff: 2 });
    check('光源构造器：合法 spec → t 从 0 开始，未给的 forward/dx/dz 默认 0（爆炸不偏移）',
      ok !== null && ok.t === 0 && ok.max === 0.4 && ok.forward === 0 && ok.dx === 0 && ok.dz === 0 &&
      ok.x === 1 && ok.z === 2 && ok.intensity === 5);
    const list = [];
    for (let i = 0; i < FX_LIGHT_MAX + 3; i++) {
      pushFxLight(list, makeFxLight({ x: i, z: 0, y: 1, color: 1, intensity: 1, distance: 1, life: 1, falloff: 1 }));
    }
    check('pushFxLight 就是那条上限规则（丢最旧、留最新）',
      list.length === FX_LIGHT_MAX && list[0].x === 3 && list[list.length - 1].x === FX_LIGHT_MAX + 2,
      `${list.length} kept, ${list[0].x}..${list[list.length - 1].x}`);
  }
  for (const id of RANGED) {
    const vis = WEAPONS[id].projectile.visual;
    const light = MUZZLE[id].light;
    check(`${id}: 枪口光比它自己发射的曳光弹更亮（≥1.5×）且照得更远`,
      light.intensity >= 1.5 * vis.lightIntensity && light.distance >= vis.lightDistance,
      `${light.intensity} vs tracer ${vis.lightIntensity} / d ${light.distance} vs ${vis.lightDistance}`);
    check(`${id}: 光沿瞄准方向前移（不给射手本人打 10Hz 白频闪）`,
      light.forward > 0 && light.forward <= 0.5, String(light.forward));
  }
}

// ---------------------------------------------------------------- 10. renderer wiring (source level)
{
  const src = (f) => readFileSync(new URL('../apps/shooter/src/' + f, import.meta.url), 'utf8');
  const render = src('render.ts');
  const muzzleSrc = src('muzzle.ts');
  const weaponsSrc = src('weapons.ts');

  check('AIM_BEAM_Y 与枪口高度同源（枪口高度只有一个定义）',
    render.includes('const AIM_BEAM_Y = MUZZLE_Y;'));
  const fxLoop = render.indexOf('const fxs = sim.fxLights');
  const bulletLoop = render.indexOf('for (let i = bulletArr.length - 1');
  check('渲染层从 sim.fxLights 重放全部瞬时光源，且它们优先于子弹',
    fxLoop > 0 && bulletLoop > fxLoop, `fxLights@${fxLoop} bullets@${bulletLoop}`);
  check('瞬时光源用同一条衰减曲线、同一个 8 盏池、同一套视野门控',
    render.includes('fxLightScale(fx.t, fx.max, fx.falloff)') &&
    render.includes('this.lightPool[li++]') && render.includes('if (!this.visibleAt(lx, lz)) continue;'));
  check('渲染层不再认识武器配方（FxLight 是扁平字段：枪口与爆炸走同一条路径）',
    render.includes('l.position.set(lx, fx.y, lz)') && render.includes('l.color.setHex(fx.color)') &&
    !render.includes('fx.def'));
  check('点光池没有分裂成两个（没有为枪口/爆炸另开池子 → 没有多一个 shader 变体）',
    !render.includes('bulletLights') && !render.includes('private fxLights') &&
    /\bBULLET_LIGHTS = 8\b/.test(render));
  check('reset() 关掉点光池', render.includes('for (const l of this.lightPool) l.visible = false;'));
  check('muzzle.ts 是纯叶子（只 import config.ts，没有 three / 没有 game.ts）',
    (muzzleSrc.match(/^import /gm) || []).length === 1 && muzzleSrc.includes("from './config.js';"),
    String((muzzleSrc.match(/^import .*/gm) || []).join(' | ')));
  const call = weaponsSrc.indexOf('ctx.spawnMuzzleFlash(muzzle, dir, w.muzzle)');
  const pelletLoop = weaponsSrc.indexOf('for (let i = 0; i < w.pellets; i++)');
  check('开火时先出枪口特效、再出弹丸，且枪口点只算一次（弹丸循环之外）',
    call > 0 && pelletLoop > call, `call@${call} loop@${pelletLoop}`);
}

// ---------------------------------------------------------------- report
console.log('verify-muzzle: ' + passed + ' checks passed, ' + failures.length + ' failed');
for (const f of failures) console.error('  FAIL ' + f);
if (failures.length) process.exit(1);
