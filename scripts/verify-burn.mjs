/**
 * CPU-side verification for the dragon-breath burn (damage over time) and the particle VFX
 * that belongs to it and to the RPG: flame tongues, the six-layer explosion, and the streak
 * orientation math.
 *
 * Rules under test:
 *   - every flameShot pellet that connects pushes one burn stack;
 *   - a stack deals 1 damage every 0.5s for 5s (10 ticks, 10 damage, 2 dps), and stacks are
 *     INDEPENDENT (each keeps its own 5s window instead of refreshing a shared one);
 *   - while an enemy burns, the sim emits slow buoyant flame particles continuously (rate scaled
 *     by stack count, capped), which rise and drift via curl noise;
 *   - the streak orientation math (streak.ts) matches three.js and reduces to the old yaw-only
 *     rotation for ground sparks.
 *
 * Run:  npm run build && node scripts/verify-burn.mjs
 * Exit code is non-zero when any assertion fails.
 */
const GAME = new URL('../dist/apps/shooter/src/game.js', import.meta.url);
const PROJ = new URL('../dist/apps/shooter/src/projectiles.js', import.meta.url);
const STREAK = new URL('../dist/apps/shooter/src/streak.js', import.meta.url);
const THREE_URL = new URL('../apps/shooter/vendor/three.module.min.js', import.meta.url);

const { GameSim, CONFIG } = await import(GAME.href);
const { BURN_DPS, BURN_DURATION, BURN_PERIOD, PROJECTILES, ROCKET_BLAST_RADIUS, ROCKET_BLAST_DAMAGE } =
  await import(PROJ.href);
const { streakQuaternion } = await import(STREAK.href);
const { noise2 } = await import(new URL('../dist/apps/shooter/src/noise.js', import.meta.url).href);
const { fxLightScale } = await import(new URL('../dist/apps/shooter/src/fxlight.js', import.meta.url).href);
const { EXPLOSION_LIGHT_COLOR, FIRE_CORE_PALETTE } = await import(new URL('../dist/apps/shooter/src/config.js', import.meta.url).href);
const THREE = await import(THREE_URL.href);

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ' — ' + detail : ''));
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

const idle = { move: { x: 0, y: 0 }, aim: { x: 0, y: 0 }, firing: false, autoAim: false };
const DT = 1 / 60;

function freshSim() {
  const sim = new GameSim();
  // Explicit: every test in this file is about the dragon-breath burn, and DEFAULT_WEAPON is
  // allowed to change (it is currently the SMG). Never rely on the default here.
  sim.equipWeapon('dragonBreath');
  sim.spawnQueue = 0;
  sim.spawnTimer = 0;
  sim.enemies = [];
  // Cover is part of the LEVEL, not of the weapon: this suite tests weapon mechanics, so it runs
  // on an empty arena. scripts/verify-cover.mjs owns the real layout (and asserts its properties).
  sim.obstacles = [];
  return sim;
}

function addEnemy(sim, x, y, hp, kind = 'chaser', speed = 0) {
  sim.enemies.push({
    id: 900 + sim.enemies.length, pos: { x, y }, vel: { x: 0, y: 0 }, r: 0.7,
    hp, maxHp: hp, alive: true, kind, speed, touchDmg: 16, hitFlash: 0, touchCd: 0, burns: [], flameAcc: 0,
  });
  return sim.enemies[sim.enemies.length - 1];
}

function run(sim, seconds, dt = DT) {
  const frames = Math.round(seconds / dt);
  for (let i = 0; i < frames; i++) { sim.update(dt, idle); sim.spawnQueue = 0; }
}

/** Damage applied per `period`-second bucket, measured from hp deltas. */
function damageBuckets(sim, enemy, seconds, period, dt = DT) {
  const count = Math.round(seconds / period);
  const buckets = new Array(count).fill(0);
  let prev = enemy.hp;
  const frames = Math.round(seconds / dt);
  for (let i = 0; i < frames; i++) {
    sim.update(dt, idle);
    sim.spawnQueue = 0;
    const dealt = prev - enemy.hp;
    if (dealt !== 0) buckets[Math.min(count - 1, Math.floor(sim.time / period + 1e-6))] += dealt;
    prev = enemy.hp;
  }
  return buckets;
}

/** Every hp change as { t, dmg } events. */
function tickEvents(sim, enemy, seconds, dt = DT) {
  const out = [];
  let prev = enemy.hp;
  const frames = Math.round(seconds / dt);
  for (let i = 0; i < frames; i++) {
    sim.update(dt, idle);
    sim.spawnQueue = 0;
    if (enemy.hp !== prev) { out.push({ t: sim.time, dmg: prev - enemy.hp }); prev = enemy.hp; }
  }
  return out;
}

// ---------------------------------------------------------------- constants
check('burn = 1 dmg per 0.5s tick, 5s duration',
  BURN_DPS === 1 && BURN_DURATION === 5 && BURN_PERIOD === 0.5,
  `${BURN_DPS}/${BURN_DURATION}/${BURN_PERIOD}`);

// ---------------------------------------------------------------- one stack
{
  const sim = freshSim();
  const e = addEnemy(sim, 15, 15, 1000);
  sim.applyBurn(e, BURN_DPS, BURN_DURATION, BURN_PERIOD);
  check('applyBurn pushes exactly one stack', e.burns.length === 1, String(e.burns.length));

  run(sim, 0.49);
  check('no tick before the first 0.5s period', e.hp === 1000, String(e.hp));

  const ticks = tickEvents(sim, e, 7);
  check('exactly 10 ticks', ticks.length === 10, JSON.stringify(ticks.map((k) => k.t.toFixed(3))));
  check('every tick deals exactly 1 damage', ticks.every((k) => k.dmg === 1), JSON.stringify(ticks));
  check('ticks land at +0.5s..+5.0s (within one frame)',
    ticks.every((k, i) => Math.abs(k.t - (i + 1) * 0.5) <= DT + 1e-6),
    ticks.map((k) => k.t.toFixed(4)).join(','));
  check('one stack totals 10 damage', e.hp === 990, String(e.hp));
  check('stack is removed after it expires', e.burns.length === 0, String(e.burns.length));
}

// ---------------------------------------------------------------- 8 stacks (a full volley)
{
  const sim = freshSim();
  const e = addEnemy(sim, 15, 15, 1000);
  for (let i = 0; i < 8; i++) sim.applyBurn(e, BURN_DPS, BURN_DURATION, BURN_PERIOD);
  check('8 hits -> 8 stacks', e.burns.length === 8, String(e.burns.length));
  const buckets = damageBuckets(sim, e, 5.5, 0.5);
  check('8 stacks deal 8 damage per 0.5s tick (16 dps)',
    JSON.stringify(buckets) === JSON.stringify([0, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8]), JSON.stringify(buckets));
  check('8 stacks total 80 damage', e.hp === 920, String(e.hp));
}

// ---------------------------------------------------------------- independence
{
  const sim = freshSim();
  const e = addEnemy(sim, 15, 15, 1000);
  sim.applyBurn(e, BURN_DPS, BURN_DURATION, BURN_PERIOD);   // A: ticks at 0.5..5.0
  run(sim, 1.25);
  sim.applyBurn(e, BURN_DPS, BURN_DURATION, BURN_PERIOD);   // B: ticks at 1.75..6.25
  const ticks = tickEvents(sim, e, 6);
  // after t=1.25: remaining A ticks 1.5,2,2.5,3,3.5,4,4.5,5 and all B ticks 1.75..6.25
  // A's first two ticks (0.5, 1.0) already fired before recording started -> 8 A + 10 B = 18
  const want = [1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.25, 3.5, 3.75, 4, 4.25, 4.5, 4.75, 5, 5.25, 5.75, 6.25];
  check('independent stacks interleave their own schedules',
    ticks.length === want.length && ticks.every((k, i) => Math.abs(k.t - want[i]) <= DT + 1e-6),
    ticks.map((k) => k.t.toFixed(3)).join(','));
  check('independent stacks deal 1 damage per tick (no merged timer)',
    ticks.every((k) => k.dmg === 1), JSON.stringify(ticks.slice(0, 4)));
  check('two stacks total 20 damage (A got 2 ticks before t=1.25)', e.hp === 980, String(e.hp));
}

// ---------------------------------------------------------------- frame-rate independence
{
  const a = freshSim();
  const ea = addEnemy(a, 15, 15, 1000);
  a.applyBurn(ea, BURN_DPS, BURN_DURATION, BURN_PERIOD);
  run(a, 5.05, DT);
  const b = freshSim();
  const eb = addEnemy(b, 15, 15, 1000);
  b.applyBurn(eb, BURN_DPS, BURN_DURATION, BURN_PERIOD);
  run(b, 5.05, 0.05);   // 20 fps: the worst case main.ts allows (dt clamped to 0.05)
  check('60 fps and 20 fps burn for the same total', ea.hp === eb.hp && ea.hp === 990, `${ea.hp} / ${eb.hp}`);
}

// ---------------------------------------------------------------- burn can kill
{
  const sim = freshSim();
  const e = addEnemy(sim, 15, 15, 3);
  sim.applyBurn(e, BURN_DPS, BURN_DURATION, BURN_PERIOD);
  run(sim, 1.55);
  check('a lethal tick kills the enemy', !e.alive && e.hp === 0, `alive=${e.alive} hp=${e.hp}`);
  check('burn kill still scores (chaser = 1)', sim.score === 1, String(sim.score));
  check('death clears the burn stacks', e.burns.length === 0, String(e.burns.length));
  const before = sim.particles.length;
  run(sim, 1);
  check('a dead enemy stops emitting flames', sim.particles.length <= before, `${before} -> ${sim.particles.length}`);
  const sim2 = freshSim();
  const e2 = addEnemy(sim2, 15, 15, 3, 'sprinter');
  sim2.applyBurn(e2, BURN_DPS, BURN_DURATION, BURN_PERIOD);
  run(sim2, 1.55);
  check('burn kill on a sprinter scores 2', sim2.score === 2, String(sim2.score));
}

// ---------------------------------------------------------------- per-tick red flash
{
  const sim = freshSim();
  const e = addEnemy(sim, 15, 15, 1000);
  sim.applyBurn(e, BURN_DPS, BURN_DURATION, BURN_PERIOD);
  // advance to the exact frame the first tick lands on (time accumulation can be a hair early)
  for (let i = 0; i < 120 && e.hp === 1000; i++) { sim.update(DT, idle); sim.spawnQueue = 0; }
  check('a burn tick sets the hit flash (visible pulse)',
    Math.abs(e.hitFlash - CONFIG.hitFlashTime) < 1e-9, String(e.hitFlash));
  check('one tick = one flash, not one per stack', e.hp === 999, String(e.hp));
}

// ---------------------------------------------------------------- only flameShot burns
{
  const sim = freshSim();
  const e = addEnemy(sim, 15, 15, 1000);
  PROJECTILES.rocket.onHit(sim, { pos: { x: 14.9, y: 15 }, vel: { x: -1, y: 0 }, r: 0.3, life: 1, damage: 60 }, e, { x: 14.9, y: 15 });
  check('rocket hits do not apply burn', e.burns.length === 0, String(e.burns.length));
  const e2 = addEnemy(sim, 17, 15, 1000);
  PROJECTILES.flameShot.onHit(sim, { pos: { x: 16.9, y: 15 }, vel: { x: -1, y: 0 }, r: 0.18, life: 1, damage: 8 }, e2, { x: 16.9, y: 15 });
  check('flameShot hits apply one stack each', e2.burns.length === 1, String(e2.burns.length));
}

// ---------------------------------------------------------------- end to end: one real volley
{
  const sim = freshSim();
  const e = addEnemy(sim, 3.2, 0, 1000);
  sim.update(DT, { move: { x: 0, y: 0 }, aim: { x: 1, y: 0 }, firing: true, autoAim: false });
  run(sim, 0.05);
  check('a full volley lands 8 pellets -> 8 burn stacks', e.burns.length === 8, String(e.burns.length));
  check('direct volley damage is 64 (8 x 8)', e.hp === 936, String(e.hp));
  run(sim, 5.1);
  check('after 5s the volley did 64 direct + 80 burn = 144', e.hp === 856, String(e.hp));
}

// ---------------------------------------------------------------- RPG explosion (layered VFX)
// Static layer properties are asserted on a FRESH explosion (before any sim.update, otherwise
// drag/life have already eaten into the values); the dynamic measurements (ring radius, ember
// arc, debris landing) each get their own fresh sim for the same reason.
function classifyExplosion(ps) {
  return {
    flash: ps.filter((p) => p.puff && !p.solid && p.size >= 2),
    fire: ps.filter((p) => p.puff && !p.solid && p.size < 2),
    ring: ps.filter((p) => !p.puff && !p.solid && p.y <= 0.06),
    embers: ps.filter((p) => !p.puff && !p.solid && p.y > 0.06),
    smoke: ps.filter((p) => p.puff && p.solid),
    debris: ps.filter((p) => !p.puff && p.solid),
  };
}
const isDark = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return ((n >> 16) & 255) <= 0x60 && ((n >> 8) & 255) <= 0x60 && (n & 255) <= 0x60;
};

{
  const sim = freshSim();
  sim.spawnExplosion({ x: 0, y: 0 });
  const ps = sim.particles;
  const L = classifyExplosion(ps);

  // The ring's particle count scales with the blast radius (28 at the original 3.5 units -> 42 at
  // 5.25) so the ring keeps its angular density instead of turning into beads on a longer
  // circumference. The other five layers keep their counts and scale their SIZES instead.
  check('爆炸分 6 层：1 闪光 + 12 火球 + 42 冲击环 + 16 余烬 + 10 烟 + 14 碎片',
    ps.length === 95 && L.flash.length === 1 && L.fire.length === 12 && L.ring.length === 42 &&
    L.embers.length === 16 && L.smoke.length === 10 && L.debris.length === 14,
    `${ps.length}: ${L.flash.length}/${L.fire.length}/${L.ring.length}/${L.embers.length}/${L.smoke.length}/${L.debris.length}`);

  // layer 3: shockwave ring (the "range" effect)
  const angles = L.ring.map((p) => Math.atan2(p.pos.y, p.pos.x)).sort((a, b) => a - b);
  let maxGap = 0;
  for (let i = 0; i < angles.length; i++) {
    const g = i === 0 ? angles[0] + Math.PI * 2 - angles[angles.length - 1] : angles[i] - angles[i - 1];
    maxGap = Math.max(maxGap, g);
  }
  check('冲击环按等角分布（是环，不是随机扇形）', maxGap < 0.35, maxGap.toFixed(3));
  check('冲击环贴地且无浮力/重力',
    L.ring.every((p) => p.y <= 0.06 && p.vy === 0 && p.buoy === 0 && !p.solid));
  check('冲击环用硬阻尼（总位移 = 速度/阻尼）',
    L.ring.every((p) => p.drag === CONFIG.blastRingDrag && p.drag > 0 && p.swirl === 0));

  // layer 1/2: flash + fireball
  check('闪光是一颗巨大、约 4 帧的亮粒子', L.flash[0].size >= 2 && L.flash[0].life <= 0.1,
    `size=${L.flash[0].size} life=${L.flash[0].life}`);
  check('火球是加色大公告板，且是圆的（aspect ≈ 1，不是 0.55 的火舌）',
    L.fire.every((p) => p.puff && !p.solid && p.size >= 0.8 && p.aspect >= 0.9 && p.aspect <= 1.2));
  check('火球上浮且用白热色板（加色叠成亮芯）',
    L.fire.every((p) => p.buoy === CONFIG.blastBuoy && p.buoy > 0 && FIRE_CORE_PALETTE.includes(p.color)),
    L.fire[0].color);

  // layer 4: embers (fireworks arcs)
  check('余烬是高速 streak + 重力（初速 ≥ 27、buoy < 0、寿命 ≥ 0.45s）',
    L.embers.every((p) => !p.puff && !p.solid && p.buoy === CONFIG.blastGravity && p.buoy < 0 &&
      Math.hypot(p.vel.x, p.vel.y) >= 27 && p.life >= 0.45));

  // layer 5: smoke (needs normal blending)
  check('烟是正常混合的大团、颜色足够深（加色混合画不出深色）',
    L.smoke.every((p) => p.solid && p.puff && p.size >= 1.2 && isDark(p.color)), L.smoke[0].color);
  check('烟升得慢、活得久（buoy > 0 且寿命 ≥ 1s）',
    L.smoke.every((p) => p.buoy === CONFIG.blastSmokeRise && p.buoy > 0 && p.life >= 1.0));

  // layer 6: debris (solid chunks)
  check('碎片是正常混合的实心小块 + 重力',
    L.debris.every((p) => p.solid && !p.puff && p.size <= 0.22 && p.buoy === CONFIG.blastGravity));

  check('爆炸是唯一带正常混合粒子的效果（烟 10 + 碎片 14 = 24 颗）',
    ps.filter((p) => p.solid).length === 24, String(ps.filter((p) => p.solid).length));
}

// dynamic: the shockwave ring's maximum radius traces ROCKET_BLAST_RADIUS
{
  // (a) The ring's TERMINAL radius is a property of the constants — speed * S / drag — so pin that
  // first, with no randomness in the loop at all. This is the actual "视觉即伤害范围" claim.
  const S = ROCKET_BLAST_RADIUS / 3.5;
  const terminal = (CONFIG.blastRingSpeed * S) / CONFIG.blastRingDrag;
  check('冲击环的终端半径 = 速度×S/阻尼，落在伤害半径的 ±10% 内（纯常数，不含随机）',
    Math.abs(terminal - ROCKET_BLAST_RADIUS) <= ROCKET_BLAST_RADIUS * 0.1,
    `${terminal.toFixed(3)} vs ${ROCKET_BLAST_RADIUS}`);

  // (b) ...and the ring that is actually DRAWN gets within a few percent of it. Do not assert this
  // tightly: the particles die while the exponential tail is still closing (the ring is only alive
  // for blastRingLife), and each particle's speed carries a +-8% Math.random() jitter, so the max
  // radius is ~96% of the blast radius with a small spread. MEASURED over 300 runs: 5.022..5.113
  // around R = 5.25. The old assertion here was |maxR - R| <= 0.2, i.e. a boundary at 5.05 — 4 of
  // those 300 runs failed it, which is a ~1.3% flaky test (it duly failed once during a full-suite
  // sweep). The band below is the measured range with margin on both sides; it still catches any
  // real drift in blastRingSpeed/blastRingDrag (10%+).
  const sim = freshSim();
  sim.spawnExplosion({ x: 0, y: 0 });
  const ring = classifyExplosion(sim.particles).ring;
  let maxR = 0;
  for (let i = 0; i < Math.round(CONFIG.blastRingLife / DT) + 4; i++) {
    sim.update(DT, idle);
    for (const p of ring) if (p.alive) maxR = Math.max(maxR, Math.hypot(p.pos.x, p.pos.y));
  }
  check('冲击环画出来的最大半径在伤害半径的 93%~103% 内（300 次实测 95.7%~97.4%）',
    maxR >= ROCKET_BLAST_RADIUS * 0.93 && maxR <= ROCKET_BLAST_RADIUS * 1.03,
    `${maxR.toFixed(3)} vs ${ROCKET_BLAST_RADIUS}`);
}

// dynamic: the detonation LIGHTS the room (the transient light, not a particle)
//
// WHY THIS IS ASSERTED AT ALL: with the ambient term at 0 an explosion that only draws particles
// leaves the scenery around it unlit, so the blast reads as a decal on a dark floor. The light is
// what makes it an event — and "亮一下然后逐渐熄灭" plus "和特效匹配" are both checkable: the peak is
// on the detonation frame, and the decay is calibrated against the FIREBALL's lifetime (0.34s), not
// the 1.7s of dark smoke behind it.
{
  const S = ROCKET_BLAST_RADIUS / 3.5;
  const sim = freshSim();
  const particlesBefore = sim.particles.length;
  sim.spawnExplosion({ x: 2.5, y: -1.5 });
  const lights = sim.fxLights;
  check('爆炸推入恰好一个瞬时光源，就在爆心（且不产生任何粒子：光源不是粒子）',
    lights.length === 1 && lights[0].x === 2.5 && lights[0].z === -1.5 &&
    particlesBefore === 0 && sim.particles.length === 95,
    `${lights.length} light, ${sim.particles.length} particles`);
  const L0 = lights[0];
  check('爆炸光源：峰值在第一帧（t = 0）、forward = 0（就坐在爆心上，不像枪口光那样前移）',
    L0.t === 0 && L0.forward === 0 && L0.dx === 0 && L0.dz === 0 &&
    L0.max === CONFIG.blastLightLife && L0.falloff === CONFIG.blastLightFalloff &&
    L0.y === CONFIG.blastLightY && L0.color === EXPLOSION_LIGHT_COLOR,
    `t=${L0.t} y=${L0.y} life=${L0.max} falloff=${L0.falloff}`);
  check('爆炸光源的强度/距离按伤害半径缩放（视觉即伤害范围，与冲击环同一条规矩）',
    near(L0.intensity, CONFIG.blastLightIntensity * S) && near(L0.distance, CONFIG.blastLightDistance * S),
    `${L0.intensity} / ${L0.distance} (S=${S})`);

  // The colour is the fireball's warm white-hot, and it is DELIBERATELY not one of the muzzle hues:
  // at the peak the lit surfaces clip (NoToneMapping + a saturated toon ramp), which is what turns
  // the first frames white — the white-core->amber read comes from the decay, not from a colour ramp.
  check('爆炸光源的颜色 = 白热暖色（与火球同族，且与三把枪的枪口色都不同）',
    L0.color === EXPLOSION_LIGHT_COLOR && L0.color === 0xffcf8a);

  // Decay against the effect's real timeline: flash layer 0.07s, last fireball puff 0.34s.
  const at = (t) => L0.intensity * fxLightScale(t, L0.max, L0.falloff);
  // 0.07s = the explosion's own flash layer (spawnExplosion, layer 1). Hardcoded on purpose: this
  // asserts the LIGHT against the effect it belongs to, so borrowing that layer's literal here is
  // what makes a future retune of one without the other show up as a red check.
  const FLASH_LAYER_LIFE = 0.07;
  check('亮一下：第 1 帧就是峰值，闪光层结束时仍然 > 50%（不是一上来就暗）',
    near(fxLightScale(0, L0.max, L0.falloff), 1) && at(FLASH_LAYER_LIFE) / L0.intensity > 0.5,
    `${(at(FLASH_LAYER_LIFE) / L0.intensity).toFixed(3)} at ${FLASH_LAYER_LIFE}s`);
  check('逐渐熄灭：火球最后一颗死时（0.34s）已掉到 20% 以下，光源寿命结束时精确为 0',
    at(0.34) / L0.intensity < 0.2 && at(L0.max) === 0 && at(L0.max * 2) === 0,
    `${(at(0.34) / L0.intensity).toFixed(3)} at 0.34s`);
  check('衰减全程单调下降（不会闪第二次）',
    (() => {
      let prev = 2;
      for (let i = 0; i <= 100; i++) {
        const v = fxLightScale((i / 100) * L0.max, L0.max, L0.falloff);
        if (!(v < prev || (v === 0 && prev === 0))) return false;
        prev = v;
      }
      return true;
    })());

  // Sim-side lifecycle: the light's clock advances with the sim and it is gone after its life.
  const life = CONFIG.blastLightLife;
  run(sim, life * 0.5);
  check('光源时钟跟着模拟走（半个寿命时 t ≈ 一半）',
    sim.fxLights.length === 1 && near(sim.fxLights[0].t, life * 0.5, DT + 1e-9),
    sim.fxLights.length ? sim.fxLights[0].t.toFixed(3) : 'gone');
  run(sim, life);
  check('寿命结束后光源从列表里消失（不会留下常亮的灯）', sim.fxLights.length === 0);

  // Scale check with the grenade (the SAME effect at a smaller radius, so it must light less).
  const gren = freshSim();
  gren.spawnExplosion({ x: 0, y: 0 }, 4.2);
  check('同一效果的更小半径（手雷 4.2）→ 更弱的爆光（线性缩放）',
    near(gren.fxLights[0].intensity, CONFIG.blastLightIntensity * 1.2) &&
    gren.fxLights[0].intensity < L0.intensity,
    `${gren.fxLights[0].intensity} < ${L0.intensity}`);

  // Two blasts in flight = two lights, newest last (the renderer walks the list backwards).
  gren.spawnExplosion({ x: 9, y: 9 });
  check('同时存在的两次爆炸 = 两盏灯（列表保留两盏，渲染层从新到旧取用）',
    gren.fxLights.length === 2 && gren.fxLights[1].x === 9 && gren.fxLights[1].z === 9);
}

// dynamic: embers really arc (rise to a peak, then fall)
//
// AGGREGATE over every ember, deliberately: an earlier version tracked `embers[0]` alone and
// asserted that it completed the arc, which is a lottery on the RNG stream — an ember whose
// lifetime ends while it is still falling never "lands", so the assertion passed or failed
// depending on how many random draws the layers before it consumed. Adding particles to the ring
// reshuffled that stream and turned this red without anything being wrong. Measured over 40
// blasts: all 16 embers rise, 9-16 of 16 complete the arc, and every blast has at least one ember
// ending below its start; the bounds below sit outside that whole range.
{
  const sim = freshSim();
  sim.spawnExplosion({ x: 0, y: 0 });
  const embers = classifyExplosion(sim.particles).embers;
  const y0 = embers.map((p) => p.y);
  const rose = embers.map(() => false);
  const fell = embers.map(() => false);
  const below = embers.map(() => false);
  for (let i = 0; i < 120; i++) {
    sim.update(DT, idle);
    for (let k = 0; k < embers.length; k++) {
      const p = embers[k];
      if (!p.alive) continue;
      if (p.y > y0[k] + 0.15) rose[k] = true;
      if (rose[k] && p.y < y0[k] + 0.05) fell[k] = true;
      if (p.y < y0[k]) below[k] = true;
    }
  }
  const roseN = rose.filter(Boolean).length;
  const fellN = fell.filter(Boolean).length;
  check('余烬全部先上升（重力把烟花拉回来之前）', roseN === embers.length,
    `${roseN}/${embers.length}`);
  check('多数余烬在寿命内划完抛物线（落到起点附近）', fellN >= 8, `${fellN}/${embers.length}`);
  check('至少一颗余烬明确落到起点以下（是重力，不是匀速上升）',
    below.some(Boolean), String(below.filter(Boolean).length));
}

// dynamic: debris lands instead of sinking through the floor, and stays near the blast
{
  const sim = freshSim();
  sim.spawnExplosion({ x: 0, y: 0 });
  const debris = classifyExplosion(sim.particles).debris;
  let minY = 9, travel = 0;
  for (let i = 0; i < 150; i++) {
    sim.update(DT, idle);
    for (const p of debris) {
      if (!p.alive) continue;
      minY = Math.min(minY, p.y);
      travel = Math.max(travel, Math.hypot(p.pos.x, p.pos.y));
    }
  }
  check('碎片不会穿到地板以下（落地钳制）', minY >= 0.049, minY.toFixed(3));
  check('碎片飞散距离留在爆炸范围附近（≤ 8.1 单位 = 最大初速 x1.5 / 阻尼）',
    travel <= 8.1, travel.toFixed(2));
}

// the whole point: it must not look like the dragon-breath splash
{
  const sim = freshSim();
  sim.spawnSplash({ x: 0, y: 0 }, { x: 1, y: 0 }, 7);
  sim.spawnBurst({ x: 0, y: 0 }, 6, '#ffcf6a');
  sim.spawnBurnFlame({ x: 0, y: 0 });
  check('龙息溅射/爆裂/火焰永远只用加色粒子（solid 恒为 false）',
    sim.particles.length > 0 && sim.particles.every((p) => p.solid === false));
}

// balance: the requested retune (伤害 -30% / 半径 +50%), pinned so it cannot drift silently
{
  check('火箭平衡：直击 42 = 60x0.7、爆炸 49 = 70x0.7、半径 5.25 = 3.5x1.5',
    near(PROJECTILES.rocket.damage, 60 * 0.7) && near(ROCKET_BLAST_DAMAGE, 70 * 0.7)
    && near(ROCKET_BLAST_RADIUS, 3.5 * 1.5),
    `${PROJECTILES.rocket.damage} / ${ROCKET_BLAST_DAMAGE} / ${ROCKET_BLAST_RADIUS}`);
  check('点杀总伤害 130 -> 91（-30%），覆盖面积 x2.25',
    near(PROJECTILES.rocket.damage + ROCKET_BLAST_DAMAGE, 130 * 0.7),
    String(PROJECTILES.rocket.damage + ROCKET_BLAST_DAMAGE));
}

// blast damage profile, measured through the real `onHit` (linear falloff from the epicentre)
{
  const sim = freshSim();
  const stub = { pos: { x: 10, y: 0 }, vel: { x: 1, y: 0 }, r: 0.3, life: 1, damage: 42 };
  // The blast is centred 0.1 units BACK along the incoming direction -> (9.9, 0).
  const BX = 9.9;
  const centre = addEnemy(sim, BX, 0, 1000);
  const half = addEnemy(sim, BX + ROCKET_BLAST_RADIUS * 0.5, 0, 1000);
  const outside = addEnemy(sim, BX + ROCKET_BLAST_RADIUS + 0.7 + 0.5, 0, 1000);
  PROJECTILES.rocket.onHit(sim, stub, null, { x: 10, y: 0 });
  check('爆炸中心伤害 = ROCKET_BLAST_DAMAGE（49）', near(centre.hp, 1000 - 49, 1e-9), String(centre.hp));
  check('半半径处伤害减半（线性衰减 = 24.5）', near(half.hp, 1000 - 24.5, 1e-9), String(half.hp));
  check('半径 + 目标体积之外完全不吃伤害（容差 0.5）', outside.hp === 1000, String(outside.hp));
}

// wiring: rocket.onHit must use it
{
  const sim = freshSim();
  let calls = 0, at = null;
  sim.spawnExplosion = (p) => { calls++; at = { x: p.x, y: p.y }; };
  const target = addEnemy(sim, 3, 0, 1000);
  PROJECTILES.rocket.onHit(sim, { pos: { x: 2.9, y: 0 }, vel: { x: -1, y: 0 }, r: 0.3, life: 1, damage: 42 },
    target, { x: 2.9, y: 0 });
  // The blast is centred 0.1 units BACK along the incoming direction (see rocket.onHit): an impact
  // on cover lies exactly on the wall face, and a line-of-sight query that STARTS on a box boundary
  // is ambiguous (the slab test reports t = 0 whether the segment then enters the box or leaves it).
  // This stub's velocity is -x, so "back" is +x: 2.9 -> 3.0.
  check('rocket 命中恰好调用一次 spawnExplosion，位置沿来向回退 0.1',
    calls === 1 && at && near(at.x, 3.0) && near(at.y, 0), `calls=${calls} at=${JSON.stringify(at)}`);
}

// ---------------------------------------------------------------- flame VFX
{
  const sim = freshSim();
  const e = addEnemy(sim, 15, 15, 100000);
  for (let i = 0; i < 8; i++) sim.applyBurn(e, BURN_DPS, BURN_DURATION, BURN_PERIOD);
  let emitted = 0;
  const orig = sim.spawnBurnFlame.bind(sim);
  sim.spawnBurnFlame = (pos) => { emitted++; orig(pos); };

  run(sim, 2);
  check('burning emits flame particles continuously', emitted > 0 && sim.particles.length > 0,
    `emitted=${emitted} alive=${sim.particles.length}`);
  check('emission rate is strictly proportional: 8 stacks = 64/s over 2s',
    emitted >= 122 && emitted <= 134, `emitted=${emitted}`);

  const flames = sim.particles;
  check('flames are buoyant and start above the ground',
    flames.every((p) => p.vy > 0 && p.buoy === CONFIG.flameBuoy && p.y >= 0.4),
    JSON.stringify(flames.slice(0, 2)));
  check('flames use flame drag/swirl (drift), not spark drag/swirl (snap)',
    flames.every((p) => p.drag === CONFIG.flameDrag && p.swirl === CONFIG.flameSwirl),
    JSON.stringify(flames.slice(0, 2)));
  check('flames are 0.35-0.70 u camera-facing puffs (10-20 px, not 3-5 px streaks)',
    flames.every((p) => p.puff === true && p.size >= 0.35 && p.size <= 0.70 &&
      p.life > 0 && p.life <= CONFIG.flameLifeMin + CONFIG.flameLifeVar + 1e-9),
    JSON.stringify(flames.slice(0, 2)));
  check('flames are narrow tongues, not squares (aspect 0.55)',
    flames.every((p) => p.aspect === CONFIG.flameAspect && p.aspect < 1),
    String(flames[0] && flames[0].aspect));
  check('flames carry a per-puff flicker phase', flames.every((p) => p.flick >= 0 && p.flick <= Math.PI * 2 + 1e-9));
  check('flame colour is dimmed so additive overlaps stay orange (all channels <= 50%)',
    flames.every((p) => {
      const n = parseInt(p.color.slice(1), 16);
      return ((n >> 16) & 255) <= 129 && ((n >> 8) & 255) <= 129 && (n & 255) <= 129;
    }), flames[0] && flames[0].color);

  // track ONE flame by object reference across frames (the array is compacted, the object is not)
  const one = flames[flames.length - 1];
  const y0 = one.y, p0 = { x: one.pos.x, y: one.pos.y };
  let rose = true, prevY = one.y;
  for (let i = 0; i < Math.round(1.4 / DT); i++) {
    sim.update(DT, idle);
    if (one.alive) { if (one.y < prevY - 1e-9) rose = false; prevY = one.y; }
  }
  const drift = Math.hypot(one.pos.x - p0.x, one.pos.y - p0.y);
  check('a flame rises monotonically over its life', rose && prevY > y0, `${y0.toFixed(3)} -> ${prevY.toFixed(3)}`);
  check('a flame drifts sideways via curl noise but stays near the target',
    drift > 0.02 && drift < 2.5, drift.toFixed(3));

  // one stack emits slower than eight
  const sim2 = freshSim();
  const e2 = addEnemy(sim2, 15, 15, 100000);
  sim2.applyBurn(e2, BURN_DPS, BURN_DURATION, BURN_PERIOD);
  let emitted2 = 0;
  const orig2 = sim2.spawnBurnFlame.bind(sim2);
  sim2.spawnBurnFlame = (pos) => { emitted2++; orig2(pos); };
  run(sim2, 2);
  check('1 stack emits 8/s (proportional, no base rate)', emitted2 >= 14 && emitted2 <= 18, `emitted=${emitted2}`);

  // the calibration the user asked for: 3 stacks == the previous 8-stack rate (24/s)
  const sim2b = freshSim();
  const e2b = addEnemy(sim2b, 15, 15, 100000);
  for (let i = 0; i < 3; i++) sim2b.applyBurn(e2b, BURN_DPS, BURN_DURATION, BURN_PERIOD);
  let emitted2b = 0;
  const orig2b = sim2b.spawnBurnFlame.bind(sim2b);
  sim2b.spawnBurnFlame = (pos) => { emitted2b++; orig2b(pos); };
  run(sim2b, 2);
  check('3 stacks emit 24/s (same as the previous 8-stack rate)', emitted2b >= 44 && emitted2b <= 52, `emitted=${emitted2b}`);

  // the cap clamps the rate even at 40 stacks
  const sim3 = freshSim();
  const e3 = addEnemy(sim3, 15, 15, 100000);
  for (let i = 0; i < 40; i++) sim3.applyBurn(e3, BURN_DPS, BURN_DURATION, BURN_PERIOD);
  let emitted3 = 0;
  const orig3 = sim3.spawnBurnFlame.bind(sim3);
  sim3.spawnBurnFlame = (pos) => { emitted3++; orig3(pos); };
  run(sim3, 1);
  check('40 stacks are held by the safety cap flameRateMax (80/s)', emitted3 <= CONFIG.flameRateMax + 1, `emitted=${emitted3}`);

  // no burn -> no flames
  const sim4 = freshSim();
  addEnemy(sim4, 15, 15, 1000);
  let emitted4 = 0;
  const orig4 = sim4.spawnBurnFlame.bind(sim4);
  sim4.spawnBurnFlame = (pos) => { emitted4++; orig4(pos); };
  run(sim4, 1);
  check('no burn -> no flame emission', emitted4 === 0, String(emitted4));

  // global particle cap
  const cap = CONFIG.flameParticleCap;
  CONFIG.flameParticleCap = 20;
  const sim5 = freshSim();
  const e5 = addEnemy(sim5, 15, 15, 100000);
  for (let i = 0; i < 8; i++) sim5.applyBurn(e5, BURN_DPS, BURN_DURATION, BURN_PERIOD);
  run(sim5, 3);
  check('flameParticleCap bounds the sim particle array', sim5.particles.length <= 20, String(sim5.particles.length));
  CONFIG.flameParticleCap = cap;
}

// ---------------------------------------------------------------- spark regression
{
  const sim = freshSim();
  sim.spawnSplash({ x: 0, y: 0 }, { x: 1, y: 0 }, 3);
  check('splash sparks keep sparkDrag/sparkCurl, stay flat and stay streaks (no regression)',
    sim.particles.every((p) => p.drag === CONFIG.sparkDrag && p.swirl === CONFIG.sparkCurl &&
      p.y === 0.2 && p.vy === 0 && p.puff === false && p.aspect === 1),
    JSON.stringify(sim.particles[0]));
  const sim2 = freshSim();
  sim2.spawnBurst({ x: 0, y: 0 }, 3, '#ff5a35');
  check('death bursts keep their 0.35x swirl factor',
    sim2.particles.every((p) => near(p.drag, CONFIG.sparkDrag * 0.35) && near(p.swirl, CONFIG.sparkCurl * 0.35)),
    JSON.stringify(sim2.particles[0]));
}

// ---------------------------------------------------------------- flicker noise
{
  let lo = 1, hi = 0, varies = false;
  const first = noise2(3, 4, 0);
  for (let i = 0; i < 500; i++) {
    const v = noise2(Math.random() * 40 - 20, Math.random() * 40 - 20, Math.random() * 10);
    lo = Math.min(lo, v); hi = Math.max(hi, v);
    if (Math.abs(v - first) > 1e-6) varies = true;
  }
  check('noise2 stays in 0..1 and varies', lo >= 0 && hi <= 1 && varies, `${lo.toFixed(3)}..${hi.toFixed(3)}`);
}

// ---------------------------------------------------------------- streak orientation math
{
  const dirs = [[1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0.3, 0.7, -0.2], [-0.5, 0.5, 0.5]];
  let allOk = true;
  for (const [x, y, z] of dirs) {
    const q = streakQuaternion(x, y, z);
    const mine = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(q[0], q[1], q[2], q[3]));
    const ref = new THREE.Vector3(0, 0, 1).applyQuaternion(
      new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(x, y, z).normalize()));
    const unit = new THREE.Vector3(x, y, z).normalize();
    if (mine.distanceTo(ref) > 1e-9 || mine.distanceTo(unit) > 1e-9) allOk = false;
  }
  check('streakQuaternion maps +Z onto the velocity (matches three.js setFromUnitVectors)', allOk);

  // vy = 0 must reproduce the old yaw-only rotation setFromAxisAngle(Y, atan2(vx, vz))
  let legacyOk = true;
  for (const [vx, vz] of [[1, 0], [0, 1], [-1, 0], [0.4, 0.9], [-0.7, 0.2]]) {
    const q = streakQuaternion(vx, 0, vz);
    const mine = new THREE.Quaternion(q[0], q[1], q[2], q[3]);
    const ref = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(vx, vz));
    const a = new THREE.Vector3(0, 0, 1).applyQuaternion(mine);
    const b = new THREE.Vector3(0, 0, 1).applyQuaternion(ref);
    if (a.distanceTo(b) > 1e-9) legacyOk = false;
  }
  check('ground sparks (vy = 0) still use the legacy yaw orientation', legacyOk);
  check('degenerate velocity -> identity quaternion',
    JSON.stringify(streakQuaternion(0, 0, 0)) === JSON.stringify([0, 0, 0, 1]) &&
    JSON.stringify(streakQuaternion(NaN, 0, 0)) === JSON.stringify([0, 0, 0, 1]));
}

// ---------------------------------------------------------------- report
console.log('verify-burn: ' + passed + ' checks passed, ' + failures.length + ' failed');
for (const f of failures) console.error('  FAIL ' + f);
if (failures.length) process.exit(1);
