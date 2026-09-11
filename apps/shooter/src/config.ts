// Tunables shared by the sim, the weapon/projectile definitions and the renderer.
// Deliberately dependency-free (no imports at all): game.ts, weapons.ts, projectiles.ts and
// render.ts all import it, and a shared leaf module is what keeps that from becoming a cycle.
//
// What lives here vs. elsewhere:
//   - here: player/enemy/wave/particle numbers that are NOT specific to one weapon
//   - weapons.ts: cadence, pellets, spread, melee reach/arc
//   - projectiles.ts: projectile speed/radius/life/damage + visuals + on-hit behaviour
//   - render.ts: purely visual constants (mesh pool sizes, bar size, camera)

// Half-extent of the square arena in world units. 20 -> 38 (76x76, 3.6x the area) for the cover
// shooter rework: the old 40x40 could not hold a cover layout AND the long sightlines that make
// cover meaningful — at 40x40 the whole map was one screen at the default camera.
//
// ⚠️ THIS NUMBER IS LOAD-BEARING FOR BULLET LIFETIME. Bullets are culled at |pos| > ARENA_HALF + 2,
// so the arena sets how far a round can travel: at 20 the shotgun's volley died by the boundary
// after 21.5 units (0.341s, well inside the 0.6s cadence), at 38 it travels 40 units from the
// centre (0.635s, LONGER than the cadence) and up to ~77 units corner-to-corner. Consequences,
// all asserted in scripts/verify-ammo.mjs and documented in weapons.ts / projectiles.ts:
//   - the shotgun now has TWO volleys (16 pellets) in flight from the centre, 24 in the worst case
//     (the old "at most one volley / max 8 pellets" invariant is gone — it was a property of the
//     small map, not of the weapon);
//   - `life` stops being a pure safety net unless it covers the longest flight, which is why
//     flameShot.life and smgRound.life were raised (69 and 40 units were shorter than ~77).
export const ARENA_HALF = 38;

export const CONFIG = {
  playerSpeed: 11,
  playerMaxHp: 100,
  playerR: 0.55,
  // Cooldown used when an attack could not happen (ranged weapon with no aim direction):
  // retry almost immediately instead of stalling for the full weapon cooldown.
  noAimRetry: 0.02,
  // ---------------------------------------------------------------------------------------
  // AIM ASSIST (「开火加个自动瞄准，但只瞄准当前摄像机朝向 15° 范围内，停火后回正」)
  //
  // While the trigger is held, the nearest VISIBLE enemy within this half-angle of the CAMERA's
  // forward direction is aimed at instead of straight ahead; releasing the trigger drops the override
  // and the facing returns to the camera direction on the next frame (the 「回正」 half of the request).
  //
  // 15 DEGREES IS A NUDGE, NOT A LOCK-ON. The player still has to put the camera roughly on target —
  // the assist only forgives a thumb that is a little off, which is the whole point of a touch
  // control with no crosshair. Raising it toward 45 would start to feel like the game aims for you;
  // 0 disables the assist entirely without touching any code path (the cone is then degenerate).
  // The cone is measured from the CAMERA direction every frame, never from last frame's assisted
  // direction — see the note in game.ts, that is what stops it ratcheting onto a target.
  autoAimConeDeg: 15,
  contactInvuln: 0.6,   // player i-frames after taking a hit
  hitFlashTime: 0.1,    // seconds an enemy's surface stays red after a hit (fades to normal)
  baseEnemyHp: 100,
  enemyR: 0.7,
  chaserSpeed: 6.5,
  sprinterSpeed: 9.5,
  sprinterHp: 55,
  touchDmg: 16,
  waveBase: 4,          // enemies in wave 1
  waveGrowth: 2,        // extra per wave
  spawnCadence: 0.55,   // seconds between spawns within a wave
  maxEnemies: 60,
  // Spark physics: drag slows sparks down, a curl-noise force makes them swirl.
  // sparkDrag was raised 3.2 -> 4.6 together with the higher splash launch speed, so
  // sparks leave the impact fast (reads as a violent burst) but still shed that speed
  // within ~0.5s instead of streaking halfway across the arena.
  sparkDrag: 4.6,       // per-second velocity damping (applied to curl particles)
  sparkCurl: 240,       // curl-noise acceleration strength for splash sparks
  splashSpeedMin: 26,   // spark launch speed at a pellet impact (world units/s)
  splashSpeedVar: 30,   // extra random speed on top of splashSpeedMin
  // Burn flames: the VFX for the dragon-breath DoT. Deliberately the opposite of sparks — slow,
  // buoyant, fat and short-lived-but-not-that-short, with a MUCH smaller curl force so they drift
  // instead of shooting sideways. Measured over 300 flames (node): lifetime 0.82-1.30s (avg
  // 1.05), rise 0.94-2.60 units (avg 1.70, ending at y~2.6 — above the 2.0-tall character),
  // horizontal drift 0.02-2.06 units (avg 0.51): a plume that visibly curls and dissipates.
  flameBuoy: 1.8,        // upward acceleration (u/s²)
  flameDrag: 1.0,        // per-second damping (sparkDrag is 4.6 — flames must keep drifting)
  // curl-noise force scale (u/s²; sparkCurl is 240). Measured |curl2| averages 0.119, so 14
  // gives ~1.7 u/s² of wander — about one world unit of lateral drift per lifetime, i.e. the
  // plume visibly curls instead of rising in a straight line.
  flameSwirl: 14,
  flameLifeMin: 0.8,     // lifetime window (s)
  flameLifeVar: 0.5,
  flameRiseMin: 0.4,     // initial upward speed (u/s)
  flameRiseVar: 0.5,
  flameDriftMin: 0.2,    // initial horizontal speed (u/s)
  flameDriftVar: 0.5,
  // Puff SIZE matters more than anything else here: at the reference framing 1 world unit is
  // ~29 CSS px, so the first version (0.10-0.19 u = 3-5 px) was invisible next to the 17-46 px
  // splash streaks — the only visible "fire" was the sparks. 0.35-0.70 u = 10-20 px reads as a
  // glowing blob at portrait framing (and roughly double that in landscape, where the camera
  // dollies closer).
  flameSizeMin: 0.35,
  flameSizeVar: 0.35,
  // Puffs are billboarded squares; `aspect` is width/height so a flame reads as a narrow
  // tongue instead of a square (0.55 = a bit more than half as wide as it is tall).
  flameAspect: 0.55,
  // Additive blending clips at 1.0 per channel, so overlapping puffs turn white. Dimming the
  // palette colour keeps the plume orange even when dozens of puffs stack.
  flameDim: 0.5,
  // Emission while burning: particles/second = flameRatePerStack x stack count — STRICTLY
  // PROPORTIONAL (no base rate), so 3 stacks = 24/s, which is what the previous version emitted
  // at 8 stacks. flameRateMax is only a safety valve (a 40-stack target would otherwise ask for
  // 320/s); normal play (<= 8 stacks from one volley) never reaches it.
  flameRateBase: 0,
  flameRatePerStack: 8,
  flameRateMax: 80,
  // Burn stacks at which the burning body's SELF-LIT tint is fully developed (see chartint.ts).
  // The dragon-breath applies one stack per pellet, so a full 8-pellet volley saturates it many times
  // over and a single stray pellet still reads as a smoulder. 0 = no glow at all.
  burnGlowStacks: 3,
  flameParticleCap: 1600, // soft cap on the sim's particle array (renderer pool is 2048)
  // ---------------------------------------------------------------------------------------
  // RPG explosion (layered VFX — see GameSim.spawnExplosion). Deliberately the opposite of the
  // dragon-breath splash in every axis: RADIAL instead of a directional fan, fat buoyant fire
  // instead of thin streaks, plus two layers additive blending cannot draw at all (dark smoke and
  // solid debris — they need the normal-blended pool, see Particle.solid).
  // ---------------------------------------------------------------------------------------
  // Shockwave ring: particles fired outward, then damped hard. A damped particle travels v0/drag
  // units in total, so speed/drag IS the ring radius — the ring literally traces the damage area.
  //
  // ⚠️ THESE ARE REFERENCE-SCALE VALUES (the original 3.5-unit blast). GameSim.spawnExplosion
  // multiplies both the speed and the particle count by `ROCKET_BLAST_RADIUS / 3.5`, so the ring's
  // maximum radius tracks the damage radius automatically when the rocket is retuned (5.25 now:
  // 28.5 * 1.5 / 8 = 5.34 ≈ ROCKET_BLAST_RADIUS). Do not "fix" the number here to match a new
  // radius — that would double-apply the scale; the equality is asserted in scripts/verify-burn.mjs.
  blastRingSpeed: 28.5,
  blastRingDrag: 8,
  blastRingLife: 0.5,
  blastBuoy: 2.5,          // fireball puffs rise (u/s²)
  blastEmberDrag: 6,       // ember arcs: travel ≈ speed/drag, keeps fireworks inside the blast
  blastGravity: -18,       // falling acceleration for embers + debris (negative buoyancy)
  blastSmokeRise: 0.5,     // smoke buoyancy (u/s²) — slow, so the plume lingers
  // The light the detonation throws. An explosion that only draws particles leaves the scenery
  // unlit — with the ambient term at 0 that turns a blast into a decal painted on a dark floor, so
  // this is what makes it an EVENT instead of a sprite. One transient point light per blast, sharing
  // the scene's capped point-light pool with the muzzle flashes (see fxlight.ts / render.ts::sync).
  //
  // ⚠️ REFERENCE-SCALE like blastRing*: intensity and distance are multiplied by `S` in
  // spawnExplosion, so the light's reach follows the damage radius (视觉即伤害范围). Life and height
  // are deliberately NOT scaled — the same rule the vertical particle numbers follow, because they
  // are tuned against the 2-unit-tall character and the ground. Rocket (S = 1.5): 90 / 22.5 units.
  // Grenade (S = 1.2): 72 / 18.
  //
  // The curve is a flash-with-a-tail: peak on the detonation frame, then `(1 - t/0.5)^2` — still 67%
  // when the 0.09s flash layer ends, and ~10% by the time the last fireball puff dies (0.34s), so
  // the light tracks the fireball rather than the (dark, 1.7s) smoke.
  blastLightIntensity: 60, // peak intensity at the reference 3.5-unit blast
  blastLightDistance: 15,  // reach at the reference blast (three's PointLight cutoff)
  blastLightLife: 0.5,     // seconds; the fireball is gone at 0.34s
  blastLightFalloff: 2,    // decay exponent over that life
  blastLightY: 0.8,        // height of the fireball's centre on a 2.0-tall character
  // ---------------------------------------------------------------------------------------
  // Melee swing crescent + its slipstream (see slash.ts, GameSim.spawnSlash and the sword in
  // weapons.ts). Per-weapon numbers (reach, arc, swingTime, swingAnimTime) live on the weapon;
  // everything here is shared by any future melee weapon.
  //
  // The honesty rule from the RPG shockwave applies here too: the crescent's outer radius
  // animates UP TO the weapon's `reach` and never past it, and the union of its angular
  // footprint across the swing is exactly the damage cone (asserted in verify-melee.mjs).
  // ---------------------------------------------------------------------------------------
  slashMax: 12,            // cap on live crescents (renderer pool = 2 instances each; also a safety valve)
  // Ease-out exponent of the sweep (see slash.ts::slashProgress). THE "力量感" KNOB.
  //   1   = constant speed (reads as a windshield wiper)
  //   3   = fast snap out of the wind-up, then a decelerating follow-through (current)
  //   > 4 = almost teleports; the sweep stops being readable
  slashEase: 3,
  slashHold: 0.34,         // fraction of the sweep held at full brightness before it dissolves
  slashRadiusStart: 0.82,  // crescent starts at this fraction of `reach` and expands to exactly 1.0
  slashSpan: 1.15,         // angular width of the crescent itself (radians, ~66°)
  // Slipstream: streaks shed along the blade's leading edge WHILE it travels (not a single burst at
  // spawn), so the trail visibly chases the sweep instead of appearing all at once.
  //
  // Counted PER SWING and spread evenly along the ARC, not per second: the sweep is deliberately
  // front-loaded (slashEase), so a per-second rate would starve the fast opening and dump every
  // streak into the slow settle. Driving the emitter with the progress delta keeps the trail's
  // density even along the arc at any frame rate and under any easing curve.
  slashStreakCount: 16,    // streaks emitted per swing
  slashStreakSpeed: 15,    // tangential launch speed (u/s) — tangential is what stretches them along the arc
  slashStreakDrag: 5.5,    // damping; travel ≈ speed/drag keeps the slipstream on the blade
  slashStreakY: 0.72,      // height of the crescent + streaks (chest height on a 2.0-tall skeleton)
  // Blade-on-enemy impact (GameSim.spawnMeleeHit): a tight ring plus cold sparks. Same damped-ring
  // maths as the RPG shockwave — travel ≈ speed/drag — at victim scale instead of blast scale.
  meleeImpactRing: 8,      // particles in the impact ring
  meleeImpactSpeed: 13,    // ring launch speed (u/s)
  meleeImpactDrag: 7,      // ring damping; 13/7 ≈ 1.9 units of travel, so it hugs the victim
  // ---------------------------------------------------------------------------------------
  // Gunner: the PvE cover-shooter enemy. Armed like the player — LITERALLY: it shoots a weapon from
  // the same `weapons.ts` table (`gunnerWeapon`), so its cadence, magazine size, reload time, spread,
  // pellet count and muzzle offset are the WEAPON's numbers and are deliberately not repeated here.
  // What this block owns is everything that is NOT the weapon: where it stands and how far it sees
  // (behaviour in game.ts::updateGunner) plus how hard a HOSTILE round hits.
  //
  // AGGRESSION (this round's request 「见面之后瞄准 0.5s 然后持续开枪一梭子」): the trigger is
  //   engage -> TELEGRAPH (gunnerAimTime) -> BURST (the weapon's cadence until the magazine is empty)
  //          -> RELOAD (the weapon's reloadTime) -> telegraph again.
  // With the SMG that is 0.5s of warning, ~2.3s of continuous fire (30 rounds at 13/s), 1.5s of
  // reload, repeat. Retuning the SMG retunes every gunner; there is no second copy of those numbers.
  //
  // HOW INCOMING DPS IS CAPPED (unchanged, and now the thing that makes a whole magazine safe to
  // ship): a hit sets `player.invuln = contactInvuln` (0.6s), and enemy rounds respect the SAME
  // timer, so no number of gunners and no fire rate can exceed damage/0.6 per second. A burst
  // therefore raises PRESSURE (there is no 3s gap to stroll through) and pushes REALISED damage up
  // towards that ceiling, but it does not move the ceiling itself — which is why this change needed
  // no new damage number and no "max simultaneous shooters" throttle.
  // ---------------------------------------------------------------------------------------
  gunnerHp: 90,            // slightly squishier than a chaser, since it shoots back
  gunnerSpeed: 3.2,        // slow: this is repositioning, not charging
  gunnerRange: 12,         // stops walking in at this distance (matches the cover ring in level.ts)
  gunnerRangeSlack: 3,     // hysteresis band, so it does not stutter on the boundary
  gunnerSight: 34,         // beyond this it holds fire entirely (it is not a sniper)
  gunnerAimTime: 0.5,      // telegraph before the FIRST round of a burst — the window to take cover
  gunnerWeapon: 'smg',     // which weapon it shoots (weapons.ts); re-used wholesale, see above
  gunnerDamage: 6,         // 100 HP / 6 = 17 hits; with i-frames that is ~10s in the open under fire
  gunnerBulletSpeed: 34,   // slow and visible, so rounds can actually be dodged and read
  gunnerBulletLife: 2.5,   // 85 units, longer than the ~77-unit worst-case flight (see ARENA_HALF)
  gunnerBulletR: 0.18,
  gunnerBackoff: 0.55,     // retreat speed as a fraction of gunnerSpeed when the player closes in
  // ---------------------------------------------------------------------------------------
  // Backpack / throwables / enemy armour (see armor.ts, items.ts, inventory.ts)
  // ---------------------------------------------------------------------------------------
  // Seconds between grenade throws. The item's stack and this cooldown are the only limits on the
  // throwable slot — there is no reload and no magazine for it.
  throwCooldown: 0.8,
  // ENEMY ARMOUR BY WAVE, as plain data for armor.ts::armorForWave (kept here, not in armor.ts,
  // because these are difficulty dials; armor.ts owns the RULE). A literal object rather than an
  // annotated `ArmorWaveProfile` on purpose: config.ts is the dependency-free tuning leaf and must
  // not gain an import just for a type.
  //   * gunners are plated from wave 1 — an unarmoured shooter would make the whole penetration
  //     ladder invisible for most of a run;
  //   * melee rushers only from wave 4, so the early waves stay about reading the gunfight;
  //   * a new level every 2 waves (wave 1 -> Lv1, 3 -> Lv2, 5 -> Lv3, ... 11 -> Lv6), and value
  //     grows with the level, so a late plate is both tougher to penetrate AND thicker.
  gunnerArmor: { startWave: 1, levelBase: 1, levelsPerWaves: 2, valueBase: 20, valuePerLevel: 8 },
  rusherArmor: { startWave: 4, levelBase: 1, levelsPerWaves: 2, valueBase: 12, valuePerLevel: 6 },
  // ---------------------------------------------------------------------------------------
  // Spawn ring. Enemies appear on a ring around the PLAYER, not at the arena edge: on a 76x76 map
  // edge spawns would be up to ~107 units away, so every wave would open with a long walk and the
  // shooter would spend the fight alone. The ring keeps encounters close while still spawning out
  // of sight. Positions are rejection-sampled (arena bounds + cover + not on top of the player).
  // ---------------------------------------------------------------------------------------
  spawnRingMin: 20,        // closest spawn distance from the player
  spawnRingMax: 34,        // furthest
  spawnTries: 12,          // rejection-sampling attempts before falling back to a clamped edge point
  spawnMinPlayerGap: 6,    // never spawn nearer than this to the player, whatever the ring says
  gunnerShare: 0.7,        // fraction of spawns that are gunners once the run is going (wave >= 2)
};

// Fire palette: saturated orange -> deep orange-red. The additive blend brightens
// overlaps toward hot yellow, which gives the flame its bright core naturally.
export const FIRE_PALETTE = ['#ff7f1f', '#ff5f1f', '#ff4a1f', '#ff3a1f', '#ff6a1f'];

// Explosion core: white-hot -> amber. Additive, so these stack into a white bloom at the centre.
export const FIRE_CORE_PALETTE = ['#fff8e0', '#ffe9a8', '#ffd070', '#ffb347'];

/**
 * Colour of the light an explosion throws. Warm white-hot rather than deep orange, and that is the
 * whole point: at the peak intensity the lit surfaces clip (the renderer runs NoToneMapping and the
 * toon ramp is already saturated), which is what turns the first frames white — the fireball's own
 * "white core → amber" read comes for free as the light decays, without needing a two-stop colour
 * ramp on the light itself.
 */
export const EXPLOSION_LIGHT_COLOR = 0xffcf8a;

// Smoke and debris are drawn with NORMAL blending (see Particle.solid), so unlike the fire
// palettes these are literal on-screen colours — dark enough to read as smoke against the
// blue-gray floor (0x4a5568) and the near-black background (0x0b0e14).
export const SMOKE_PALETTE = ['#4a4038', '#3a332c', '#5a4c42', '#2e2a26'];
export const DEBRIS_PALETTE = ['#8a7f70', '#6b6258', '#9a8f80', '#7a6a55'];

// Colour of the burst spawned when an enemy dies (used by GameSim.resolveDeath).
export const DEATH_BURST_COLOR = '#ff5a35';

// Melee slash: cold steel, not fire. A sword sweep must read as "not a gun" at a glance, so this
// palette deliberately shares nothing with FIRE_PALETTE — it runs white -> the UI accent cyan
// (#40c4ff, == --accent in styles.css) so the swing also ties back to the reload bar / HUD chrome.
// Additive blending means these stack toward white at the leading edge, which is where the blade
// actually is: the gradient falls out of the blend for free.
export const SLASH_PALETTE = ['#ffffff', '#eaf8ff', '#cdf1ff', '#9fe8ff'];
/** Outer-glow tint of the crescent (the dim second pass drawn just past the blade edge). */
export const SLASH_GLOW_COLOR = '#40c4ff';

// Cover palette: cool desaturated stone/concrete that reads as "solid" against the blue-gray floor
// (0x4a5568) without competing with the warm muzzle fire and the cyan slash for attention. Cover
// must look like terrain, not like an effect — that is why these are the only materials in the game
// with no emissive component at all. Toon-shaded, so each value is a flat band rather than a
// gradient; three tints give the layout visual variety without three separate materials.
export const COVER_PALETTE = [0x8a94a6, 0x77808f, 0x9aa3b2];

/** Enemy tracer colour — hostile magenta, deliberately far from the player's amber (0xffb020). */
export const ENEMY_BULLET_COLOR = 0xff2a6a;
