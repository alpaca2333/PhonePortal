/**
 * Deterministic behavior trace for apps/shooter (used to prove a refactor changed nothing).
 *
 * Seeds Math.random with a fixed PRNG, runs five scripted scenarios against the BUILT sim
 * (dist/apps/shooter/src/game.js), and prints one line per simulated frame. Because every
 * random draw is consumed in code order, two builds with identical behavior produce a
 * byte-identical trace — so a refactor can be checked with plain diff:
 *
 *   npm run build && node scripts/trace-shooter.mjs > before.txt
 *   ...refactor...
 *   npm run build && node scripts/trace-shooter.mjs > after.txt
 *   diff before.txt after.txt   # must be empty
 *
 * ⚠️ THIS GUARDS REFACTORS, NOT GAMEPLAY CHANGES. A deliberate behavior change (a new enemy kind,
 * a different arena size, extra sim state consumed in the RNG order) is SUPPOSED to change the
 * output; when that happens the reference baseline is simply re-captured. It was re-captured for the
 * cover-shooter rework (ARENA_HALF 20 -> 38, gunner AI, cover), which is also why every scenario
 * clears `sim.obstacles`: these scenarios pin simulation behaviour, and the layout is level data
 * owned by scripts/verify-cover.mjs.
 *
 * RE-CAPTURED AGAIN for the backpack / reserve-ammo / armour system. Three things changed the
 * fingerprint on purpose, and all three are visible in the line format:
 *   1. `V<reserve>` — a reload is now paid for out of the backpack, so the reserve is printed. Every
 *      scenario now tops the bag up first, because these traces pin CADENCE and would otherwise
 *      start measuring ammo starvation instead;
 *   2. `L<round level>` — the penetration level of the equipped weapon;
 *   3. `V<value>/L<level>` on enemies — spawned enemies wear plates by wave, and armour chip damage
 *      unfolds over time, which is exactly what a per-frame fingerprint is for.
 *
 * CONVERSELY, a change that leaves this output byte-identical is direct evidence that the
 * SIMULATION was not touched. The player-vision feature (apps/shooter/src/vision.ts: occlusion hiding + the
 * darkness overlay) is a pure render-layer filter built on the sim's own `lineBlocked`, and it was
 * verified exactly that way — an empty diff against the previous baseline.
 *
 * SCENARIO E (the aim assist) was added for the opposite reason: a SIM gameplay change that the
 * existing scenarios could not see, because B and C pass `autoAim: true` with a ZERO aim direction
 * and therefore take the legacy "nearest visible, no cone" branch. E supplies a real camera direction
 * (what the live input always does) and alternates firing/released, so the cone, the firing gate and
 * the 「停火后回正」 release all have a fingerprint. Adding it left the first 2100 lines (A-D)
 * byte-identical — which is itself the proof that the assist changed nothing else.
 *
 * Build first: this imports from dist/, not from the TypeScript sources.
 */
const DIST = new URL('../dist/apps/shooter/src/game.js', import.meta.url);
const WEAPONS_URL = new URL('../dist/apps/shooter/src/weapons.js', import.meta.url);
const ARMOR_URL = new URL('../dist/apps/shooter/src/armor.js', import.meta.url);

// --- deterministic PRNG (mulberry32) so every run replays identically ---
let _seed = 0x9e3779b9;
Math.random = () => {
  _seed |= 0;
  _seed = (_seed + 0x6d2b79f5) | 0;
  let t = Math.imul(_seed ^ (_seed >>> 15), 1 | _seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const { GameSim } = await import(DIST.href);
const { ammoIdOf } = await import(WEAPONS_URL.href);
const { roundPenetration } = await import(ARMOR_URL.href);

const r = (n) => (Object.is(n, -0) ? 0 : Number(n.toFixed(6)));
const vec = (v) => r(v.x) + ',' + r(v.y);

function line(sim, frame) {
  const p = sim.player;
  const bullets = sim.bullets.map((b) => vec(b.pos) + '|' + r(b.life) + '|' + r(b.damage)).join(';');
  const parts = sim.particles.map((pt) => vec(pt.pos) + '|' + r(pt.life) + '|' + pt.color).join(';');
  // Enemy armour rides the fingerprint too (`V<value>/L<level>`): the whole point of the armour
  // system is that chip damage and the flesh/plate split happen over TIME, and a per-frame trace is
  // the only thing that catches a regression in that schedule. `V-` = no plate.
  const enemies = sim.enemies.map((e) => (e.alive ? 'A' : 'D') + r(e.hp) + '@' + vec(e.pos) + '|' + r(e.hitFlash) +
    (e.armor ? '|V' + r(e.armor.value) + '/L' + e.armor.level : '|V-')).join(';');
  return [
    // `sim.fireTimer` (NOT `p.fireTimer` — the Player object carries a stale, never-updated
    // `fireTimer` field, so printing that one always wrote 0 and hid the whole attack cadence
    // from this trace). With the real timer the volley spacing is directly readable.
    frame, r(p.pos.x), r(p.pos.y), r(p.hp), r(p.aimAngle), r(sim.fireTimer), p.moving ? 1 : 0, p.firing ? 1 : 0,
    // Magazine state: ammo left + reload timer, so a cadence/reload regression shows up as a
    // fingerprint change instead of hiding inside "the bullet count looks plausible".
    // `V<reserve>` is the BACKPACK reserve for the equipped weapon: it makes the "reload is paid for
    // out of the bag" rule part of the fingerprint.
    // `L<level>` is the DISPLAY level and `P<penetration>` the armour-interaction level fed to the
    // default ladder — two different numbers since the per-ammo override work, and only P changes
    // what a round does to a plate (the dragon-breath shell is L4/P0), so both are printed.
    'A' + r(p.ammo) + '|R' + r(p.reloadTimer) + '|' + p.weaponId +
      '|V' + sim.reserveOf(ammoIdOf(sim.activeWeapon())) +
      '|L' + (sim.activeWeapon() ? sim.activeWeapon().projectile.level : '-') +
      '|P' + (sim.activeWeapon() ? roundPenetration(sim.activeWeapon().projectile) : '-'),
    'B' + sim.bullets.length + '[' + bullets + ']',
    'P' + sim.particles.length + '[' + parts + ']',
    'E' + sim.enemies.length + '[' + enemies + ']',
    // `K<shake>` is the random rattle amplitude, `C<x>,<z>` the directional camera recoil the last
    // shots pushed the view by (weapons.ts' per-weapon kick, decayed in game.ts). Both are render-only
    // state: they are printed so a cadence/feel change is visible in the fingerprint.
    'S' + sim.score + '|W' + sim.wave + '|K' + r(sim.shake) + '|C' + r(sim.recoilX) + ',' + r(sim.recoilZ),
  ].join(' ');
}

function addEnemy(sim, x, y, hp, kind, speed) {
  sim.enemies.push({
    id: 900 + sim.enemies.length, pos: { x, y }, vel: { x: 0, y: 0 }, r: 0.7,
    hp, maxHp: hp, alive: true, kind, speed, touchDmg: 16, hitFlash: 0, touchCd: 0, burns: [], flameAcc: 0,
  });
}

// --- scenario A: fully controlled (no wave spawning, fixed enemies, scripted aim) ---
{
  const sim = new GameSim();
  // Empty arena: this trace pins SIMULATION behaviour, and the cover layout is level data that
  // scripts/verify-cover.mjs owns. (The arena SIZE still affects it — bullets are culled at the
  // boundary — so the reference baseline was regenerated when the map grew to 76x76.)
  sim.obstacles = [];
  sim.equipWeapon('dragonBreath');   // explicit: the scenarios must not follow DEFAULT_WEAPON
  // Deep reserve: these scenarios pin CADENCE, not starvation. Without it the shotgun would run the
  // backpack dry part-way through and the trace would start measuring "is there ammo left".
  sim.addAmmo('ammoShell', 600);
  sim.spawnQueue = 0;
  sim.spawnTimer = 0;
  sim.enemies = [];
  addEnemy(sim, 3.2, 0, 100, 'chaser', 6.5);
  addEnemy(sim, -4.5, 2.0, 55, 'sprinter', 9.5);
  addEnemy(sim, 15, 15, 1e9, 'chaser', 0);   // immortal dummy: keeps the wave counter from advancing
  const FRAMES = 300;
  for (let i = 0; i < FRAMES; i++) {
    const a = (i / FRAMES) * Math.PI * 2;
    const input = {
      move: { x: Math.cos(a * 0.5) * 0.8, y: Math.sin(a * 0.5) * 0.8 },
      aim: { x: Math.cos(a), y: Math.sin(a) },
      firing: i % 120 < 100,
      autoAim: false,
    };
    sim.update(1 / 60, input);
    sim.spawnQueue = 0;
    console.log('A ' + line(sim, i));
  }
}

// --- scenario B: real game loop with wave spawning and auto-aim (shotgun) ---
{
  const sim = new GameSim();
  // Empty arena: this trace pins SIMULATION behaviour, and the cover layout is level data that
  // scripts/verify-cover.mjs owns. (The arena SIZE still affects it — bullets are culled at the
  // boundary — so the reference baseline was regenerated when the map grew to 76x76.)
  sim.obstacles = [];
  sim.equipWeapon('dragonBreath');
  sim.addAmmo('ammoShell', 600);      // see scenario A: cadence, not starvation
  const FRAMES = 900;
  for (let i = 0; i < FRAMES; i++) {
    const a = i / 90;
    const input = {
      move: { x: Math.cos(a), y: Math.sin(a) },
      aim: { x: 0, y: 0 },
      firing: true,
      autoAim: true,
    };
    sim.update(1 / 60, input);
    console.log('B ' + line(sim, i));
    if (sim.over) break;
  }
}

// --- scenario C: same loop with the SMG equipped (10 rounds/s, 30-round magazine) ---
// Added with the magazine feature: the 0.1s cadence, the 30-round magazine and the 1.5s reload
// are exactly the kind of thing a per-frame fingerprint catches and a "does it shoot?" test does
// not. `equipWeapon()` is the same entry point the in-game button uses.
{
  const sim = new GameSim();
  // Empty arena: this trace pins SIMULATION behaviour, and the cover layout is level data that
  // scripts/verify-cover.mjs owns. (The arena SIZE still affects it — bullets are culled at the
  // boundary — so the reference baseline was regenerated when the map grew to 76x76.)
  sim.obstacles = [];
  sim.equipWeapon('smg');
  sim.addAmmo('ammo9mm', 600);        // see scenario A: cadence, not starvation
  const FRAMES = 600;
  for (let i = 0; i < FRAMES; i++) {
    const a = i / 75;
    const input = {
      move: { x: Math.cos(a), y: Math.sin(a) },
      aim: { x: 0, y: 0 },
      firing: true,
      autoAim: true,
    };
    sim.update(1 / 60, input);
    console.log('C ' + line(sim, i));
    if (sim.over) break;
  }
}

// --- scenario D: the RPG, so the explosion VFX (81 particles, 6 layers, lots of Math.random
// draws per hit) is inside the fingerprint instead of only being covered by layer assertions.
{
  const sim = new GameSim();
  // Empty arena: this trace pins SIMULATION behaviour, and the cover layout is level data that
  // scripts/verify-cover.mjs owns. (The arena SIZE still affects it — bullets are culled at the
  // boundary — so the reference baseline was regenerated when the map grew to 76x76.)
  sim.obstacles = [];
  sim.equipWeapon('rpg');
  sim.addAmmo('ammoRocket', 20);      // rockets are finite now: keep the explosion VFX in the trace
  sim.spawnQueue = 0;
  sim.spawnTimer = 0;
  sim.enemies = [];
  addEnemy(sim, 3.0, 0, 100000, 'chaser', 0);
  addEnemy(sim, 5.5, 0.4, 100000, 'chaser', 0);
  const FRAMES = 300;                  // 5s = 3 rockets at the 1.6s cadence
  for (let i = 0; i < FRAMES; i++) {
    const input = {
      move: { x: 0, y: 0 },
      aim: { x: 1, y: 0 },
      firing: true,
      autoAim: false,
    };
    sim.update(1 / 60, input);
    sim.spawnQueue = 0;
    console.log('D ' + line(sim, i));
  }
}

// --- scenario E: the AIM ASSIST (cone + release), so the new targeting rule is inside the
// fingerprint instead of only being covered by verify-vision's assertions.
// WHY IT IS A SEPARATE SCENARIO: B and C also pass `autoAim: true`, but with a ZERO aim direction —
// that takes the historical "nearest visible, no cone" branch, so they would stay byte-identical even
// if the assist broke completely. This one supplies a real camera direction (which is what the live
// input always does), so a regression in the cone, in the firing gate or in the 「回正」 release has
// nowhere to hide.
{
  const sim = new GameSim();
  sim.obstacles = [];                  // angles, not cover: the visibility half is scenario B/C's job
  sim.equipWeapon('smg');
  sim.addAmmo('ammo9mm', 600);
  sim.spawnQueue = 0;
  sim.spawnTimer = 0;
  sim.enemies = [];
  // Two immortals at the SAME distance, 10° and 25° off the camera's +X forward. 10° is inside the
  // 15° cone (so the facing snaps to it), 25° is outside (so it must be ignored no matter how long
  // the trigger is held — that is the anti-ratchet property).
  const R = 15;
  const at = (deg) => [R * Math.cos((deg * Math.PI) / 180), R * Math.sin((deg * Math.PI) / 180)];
  const [x1, y1] = at(10);
  const [x2, y2] = at(25);
  addEnemy(sim, x1, y1, 1000000000, 'chaser', 0);
  addEnemy(sim, x2, y2, 1000000000, 'chaser', 0);
  const FRAMES = 600;                  // 10s: four 150-frame cycles
  for (let i = 0; i < FRAMES; i++) {
    const input = {
      move: { x: 0, y: 0 },
      aim: { x: 1, y: 0 },             // the camera looks along +X (what input.ts reports live)
      // 100 frames firing (locked on the 10° enemy) then 50 released (facing back at +X = 「回正」),
      // so BOTH halves of the rule are in the fingerprint.
      firing: i % 150 < 100,
      autoAim: true,
    };
    sim.update(1 / 60, input);
    sim.spawnQueue = 0;
    console.log('E ' + line(sim, i));
  }
}
