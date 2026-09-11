import * as THREE from 'three';
import { GameSim } from './game.js';
import { CONFIG, COVER_PALETTE, ENEMY_BULLET_COLOR, SLASH_GLOW_COLOR } from './config.js';
import { CharInstance, CharTemplate, spawnPrimitive, spawnFromTemplate } from './assets.js';
import { PLAYER_CHARACTER, ENEMY_CHARACTER } from './characters.js';
import { createToonMaterial, setGradeStrength, setHeightFogDensity } from './toon.js';
import { ammoIdOf, magSizeOf } from './weapons.js';
// Level colour = the shared 1..6 palette (white/green/blue/purple/gold/red). One source for the
// enemy armour strip, the HUD plate readout and the ammo level badge; see armor.ts for why world
// projectile colours deliberately do NOT use it.
import { NO_LEVEL_COLOR, armorRatio, levelColorHex, levelColorInt } from './armor.js';
// Camera height/back live in camera.ts so the 「画面」 setting and this renderer share one source
// of truth (see that file for the reference framing and the scale semantics).
import {
  CAMERA_SCALE_DEFAULT, CAMERA_YAW_DEFAULT, cameraEye, clampCameraScale, clampCameraYaw,
  orthoFrustumHeight,
} from './camera.js';
// Pure +Z-on-velocity rotation math (flames rise, sparks stay flat); kept out of this file so
// scripts/verify-burn.mjs can assert it against the vendored three.js.
import { streakQuaternion } from './streak.js';
// Swing-crescent motion (angle / fade / radius) is pure math shared with the sim's assertions —
// see slash.ts. The renderer never invents timing; it replays what that module computes.
import { buildCrescent, slashAlpha, slashAngle, slashRadiusScale } from './slash.js';
// Muzzle flashes: only the LIGHT half is replayed here (the particles are ordinary sim particles in
// the pools below). `MUZZLE_Y` is also the height the gunners' aim beams are drawn at, so "where the
// muzzle is" has one definition; the decay curve is shared with the explosions' light (fxlight.ts).
import { MUZZLE_Y } from './muzzle.js';
import { fxLightScale } from './fxlight.js';
import { noise2 } from './noise.js';
import {
  ammoReadout, actionButtonReadout, reloadBarProgress,
  ARMOR_BAR_H, ARMOR_BAR_Y, BAR_H, BAR_PAD, BAR_W, BAR_Y,
  PLAYER_ARMOR_BAR_Y, PLAYER_BAR_W, PLAYER_BAR_Y, PLAYER_RELOAD_BAR_Y,
  MAX_BAR_SLOTS, MAX_ENEMY_BARS, createBarAllocator,
} from './hud.js';
// Item vocabulary (short labels, level, stack count) for the action buttons; the same helpers the
// inventory panel uses, so the HUD and the backpack can never label an item differently.
import { countOf, isWeaponItem, itemLevel, itemShort } from './inventory.js';
// How self-lit a burning enemy is, from its burn-stack count (pure; see chartint.ts).
import { burnGlowFor } from './chartint.js';
import type { Item } from './inventory.js';
// Cover looks up the wall the aiming line stops at (firstCoverHit), and the vision module owns
// both the occlusion polygon that is DRAWN and the gating policy that is TESTED — see vision.ts for
// why the policy lives there rather than inline here.
import { firstCoverHit } from './level.js';
// The arena's art: the layout planner (pure) plus the theme constants. `FLOOR_TOP` is what the
// vision overlay and the ground effects are positioned against, so it is imported rather than
// re-derived here.
import {
  ArenaPlan, FLOOR_TOP, PROPS, PlacedProp, PropId, planArena, planCasterHeight,
} from './props.js';
// The key light's shadow box geometry (view-fitted + texel-snapped) — pure, and owned by shadow.ts
// precisely so it can be asserted in Node; see that file for the two artifacts it fixes.
import {
  LIGHT_OFFSET, SHADOW_HALF_MIN, SHADOW_MAP_SIZE, fitShadowBox,
} from './shadow.js';
// The 「像素化」 post-processing pass: the scene is drawn into a small render target and blitted to the
// canvas by a fullscreen quad (see postfx.ts for the block size, the shader and the stability snap).
import {
  DISPLAY_REFERRED_COLORSPACE_CHUNK, PIXEL_BLOCK_DEFAULT, PIXEL_MSAA_SAMPLES, clampPixelBlock,
  pixelTarget, snapCameraToBlockGrid, worldPerBlock, PIXEL_FRAGMENT_SHADER, PIXEL_VERTEX_SHADER,
} from './postfx.js';
// The `?diag=1` resolution chain (what the profiler prints). A type only: the maths lives in postfx.ts.
import type { ResolutionFacts } from './postfx.js';
// The 「调色」 card: a camera-child quad with the vignette baked into vertex colours (see vignette.ts
// for why geometry instead of a post pass). The falloff table is rebuilt when the setting changes; the
// card's SIZE is rebuilt on resize.
import {
  VIGNETTE_DIST, VIGNETTE_STRENGTH_DEFAULT, VIGNETTE_SEGMENTS,
  buildVignetteGrid, clampVignetteStrength, vignetteQuadSize,
} from './vignette.js';
// The ambient term's numbers (and the reasoning for why only the HEMISPHERE light is "ambient")
// live in lighting.ts, because the 光照 settings group owns the same numbers through settings.ts.
import {
  AMBIENT_GROUND_COLOR, AMBIENT_SCALE_DEFAULT, AMBIENT_SKY_COLOR,
  DIR_KEY_INTENSITY, DIR_WARM_INTENSITY, DIRECTIONAL_SCALE_DEFAULT,
  ambientIntensity, clampAmbientScale, clampDirectionalScale, directionalIntensity,
} from './lighting.js';
import { Vec2 } from './math2.js';

// Scratch vectors for the pixel-grid snap (module scope: the frame loop allocates nothing).
const _vRight = new THREE.Vector3();
const _vUp = new THREE.Vector3();
import {
  VISION_DIM_DEFAULT, VISION_FADE, VISION_SEEDS, VISION_VERTS_PER_SECTOR, VisionField,
  clampVisionDim, coverVisible, createVisionField, rebuildVision, visionFadeAt, visibleWithReveal,
  writeVisionGeometry,
} from './vision.js';

// The vertical FOV is fixed, so world-units-per-CSS-pixel = visibleWorldHeight / viewportHeight.
// On a short (landscape) viewport that makes everything look tiny: the same FOV squeezed into
// ~400px instead of ~800px halves the on-screen size of the character and the arena. So the
// camera dollies along its own view axis by `camZoom = viewportHeight / CAM_REF_H`: scaling the
// distance scales the whole projection, which keeps the 3/4 angle and framing identical — the
// world just appears bigger while you see less of it (same visible AREA, different shape).
// This is orthogonal to the user's 「摄像机高度」 setting: camZoom multiplies BOTH the height and
// the back offset (a pure dolly, pitch preserved), while the setting changes the height alone.
const CAM_REF_H = 800;      // viewport height (CSS px) that gets the reference framing
const CAM_ZOOM_MIN = 0.42;  // never closer than this (very short landscape windows)
const CAM_ZOOM_MAX = 1.15;  // never further than this (tall portrait screens)
const GROUND_SIZE = 170; // large light floor extends well beyond the 76x76 arena

// Dragon-breath projectiles: one InstancedMesh (single draw call) + a capped point-light pool.
// Per-projectile colour, size, glow and light now come from `bullet.def.visual` (projectiles.ts),
// so a new ammo type needs no change here. Only the glow sheath's opacity stays mesh-global —
// per-type opacity would need one mesh per type, which is not worth a draw call yet.
const MAX_BULLETS = 256;      // instanced pool size (safety cap)
// The scene's dynamic point lights: what a projectile needs per fragment, and what a muzzle flash
// borrows for a few frames. SHARED on purpose — see the assignment loop in sync() for the priority
// rule, and for why a separate muzzle pool would cost a shader program and not just fill rate.
const BULLET_LIGHTS = 8;      // capped point lights (per-fragment cost; not one per projectile)
const BULLET_GLOW_OPACITY = 0.45;
const MAX_PARTICLES = 2048;   // instanced spark/flame pool size (safety cap)
// Normal-blended pool for the two layers additive blending cannot draw: dark smoke and solid
// debris (see Particle.solid). Separate mesh = one more draw call, but only while such particles
// exist (count = 0 otherwise), and it is what makes the RPG explosion read as smoke + chunks
// instead of yet another pile of glowing sparks.
const MAX_SOLID_PARTICLES = 512;
const SOLID_OPACITY = 0.92;   // smoke/debris are opaque-ish; per-instance opacity is not available
// Melee swing crescent (slashed in slash.ts): ONE instanced mesh for every live swing, TWO
// instances each — the blade core plus a dim outer glow drawn just past the blade edge.
//
// WHY ITS OWN GEOMETRY, unlike every other effect in this game: the swing has to read as one
// continuous ribbon of light with a soft silhouette. Building it from streak particles (the only
// other primitive here) shows its beads up close and cannot hold a soft edge; that is the whole
// reason this effect is allowed a mesh.
//
// NO TEXTURE, NO CUSTOM SHADER: the falloff is BAKED into the geometry's vertex colours — a radial
// band envelope times an angular tail->leading-edge envelope. The material is additive and additive
// BLACK contributes nothing, so fading a vertex colour to black IS an alpha ramp. Same trick as the
// aiming line below (LASER_*), which fades to black along its length.
//
// Cost: 1 draw call while any swing is on screen, 0 otherwise (count = 0 means no draw at all).
const SLASH_CORE_SCALE = 1;          // blade edge lands exactly on the weapon's reach — never past it
const SLASH_GLOW_SCALE = 1.17;       // glow pass, drawn just outside the blade edge
const SLASH_GLOW_DIM = 0.34;         // glow brightness relative to the core
const SLASH_INNER = 0.34;            // crescent inner radius as a fraction of reach
const SLASH_ANG_SEG = 26;            // angular subdivisions (smoothness around the arc)
const SLASH_RAD_SEG = 4;             // radial subdivisions (smoothness of the soft edge)
const SLASH_Y = CONFIG.slashStreakY; // same height as the slipstream streaks (config.ts)
const MAX_SLASH_INSTANCES = CONFIG.slashMax * 2;
// Cover: one InstancedMesh for the whole static layout (1 draw call), written once at init. The
// obstacles never move, so unlike every other pool here this one is not touched per frame.
const COVER_Y_EPS = 0.001;   // sunk a hair into the floor so no seam shows at the base
// Aim beams: one instanced additive quad per TELEGRAPHING gunner, so the player can see incoming
// fire coming (see GameSim.updateGunner). A unit quad along +X scaled per instance, with vertex
// colours fading white -> black along its length — same trick as the player's aiming line, which is
// why it needs no texture and no shader. Its own mesh rather than folding into `laserMesh`: that one
// is a single Mesh with a fixed length, and rewriting it as an instanced pool would touch verified
// behaviour for no gain.
const MAX_AIM_BEAMS = 32;          // safety cap (maxEnemies is 60, but only a few aim at once)
const AIM_BEAM_WIDTH = 0.05;       // world units
const AIM_BEAM_Y = MUZZLE_Y;       // muzzle height on a 2.0-tall character (one source: muzzle.ts)
// Enemy health bars: two InstancedMeshes (dark frame + coloured fill) of unit quads,
// billboarded to the camera. Depth test is off so a bar stays readable when a character
// or another enemy overlaps it — the usual trade-off for gameplay readability.
//
// SINCE THE ARMOUR SYSTEM: an armoured enemy gets a SECOND, thinner strip just above its health
// bar, coloured by the plate's level (1 white .. 6 red) and filled by its remaining value. Slots
// are per BAR, not per enemy — and `createBarAllocator` (hud.ts) is what guarantees that, because
// reusing one index for both bars made the armour strip overwrite the health bar's FRAME (the health
// bar lost its dark background). See hud.ts for the capacity rule.
// ---------------------------------------------------------------------------------------------
// Vision (see vision.ts): the darkness drawn over what cover hides, plus how cover itself reacts.
//
// WHAT IS GATED, AND WHY IT IS FOUR THINGS AND NOT ONE: hiding the enemy character alone leaks its
// position three other ways — the aim beam still draws (a gunner whose line of sight just broke
// keeps `aiming` true, so the tell would shoot out of a wall), the health bar still draws (it is
// depth-test false, so it floats ON TOP of the darkness and points straight at the enemy), and its
// bullets' point lights still light up the dark ground. Particles are handled separately, by fade
// (they are effect, not information, and they need an O(log n) query, not a segment test).
//
// The overlay is ONE non-indexed mesh with 12 vertices per sector (three rings x two ends x two
// triangles) whose vertex alpha is written once at init and whose positions are rewritten each
// frame. Only the occluded region has geometry, so an unobstructed view pays nothing. Vertex alpha
// (a 4-component colour attribute) rather than a black tint with MultiplyBlending: multiply
// blending would put the tint through the linear->sRGB conversion on the way out, so the value you
// write is not the factor you get on screen. Normal blending with per-vertex alpha in a black
// material IS `dst *= (1 - alpha)`, with no colour-space trap.
const VISION_Y = 0.02;               // above the floor (-0.01) and the grid (0), below the sight (0.07)
const COVER_DIM_TAU = 0.18;          // seconds to ease a cover piece between lit and dim
const COVER_DIM_MUL = 0.42;          // brightness of a hidden cover piece (toon bands survive it)
// Aiming line ("laser sight"): a faint red beam along the direction shots would travel,
// drawn flat on the floor so it reads from the 3/4 camera. It is a single additive quad whose
// vertex colours fade to black along its length (additive black = invisible), which gives a
// soft tail without a texture, a second draw call or any occlusion test. Shown only while the
// player is actually aiming a RANGED weapon — see `sync()`.
const LASER_LEN = 9;          // world units (fixed; no raycast against enemies/walls)
const LASER_WIDTH = 0.06;     // world units at the muzzle
const LASER_Y = 0.07;         // just above the ground plane/grid
const LASER_COLOR = 0xff2a12; // red-dominant: additive clipping rule, see projectiles.ts
const LASER_OPACITY = 0.5;    // overall faintness
// The world-space bar GEOMETRY (widths, heights, frame padding, and the clearance between the health
// bar and the armour strip) lives in hud.ts, because "the two bars must not touch" is a rule that has
// to be asserted in Node — measuring the gap between FILL edges instead of FRAME edges is what made
// the armour strip overlap the health bar on a real device. See hud.ts::ARMOR_BAR_Y (enemy) and
// hud.ts::PLAYER_ARMOR_BAR_Y (player).
// The player's HEALTH bar, ARMOUR strip and RELOAD bar ride the SAME two InstancedMeshes as the enemy
// bars (so they add no draw call) and stack in one clear order above the player's own head
// (`PLAYER_BAR_Y` → `PLAYER_ARMOR_BAR_Y` → `PLAYER_RELOAD_BAR_Y`, each exactly one frame-gap apart).
// The player's bars are genuinely WIDER (`PLAYER_BAR_W`): fill length already carries the fraction and
// the armour colour already carries the plate level, so WIDTH is the one free channel left to say
// "this bar is mine".
const RELOAD_BAR_COLOR = 0x40c4ff;   // == --accent in styles.css
// Fill colour as the bar empties: green -> amber -> red.
function barFillColor(ratio: number): number {
  if (ratio > 0.6) return 0x46d16a;
  if (ratio > 0.3) return 0xf0b429;
  return 0xe6483a;
}
// Reused scratch objects for per-instance matrix writes (avoids per-frame allocation).
/**
 * The slash crescent as a UNIT geometry, wrapping slash.ts's pure vertex builder.
 *
 * The soft edges are baked into the vertex colours there (a radial band envelope times an angular
 * tail->leading-edge envelope) because this game ships no textures and no custom shaders — and the
 * material is additive, where black contributes nothing, so the gradient falls out for free.
 * See `buildCrescent` in slash.ts: the math lives in the pure module so `scripts/verify-melee.mjs`
 * can assert it without three or a canvas.
 */
function makeSlashGeometry(span: number): THREE.BufferGeometry {
  const m = buildCrescent(span, SLASH_INNER, SLASH_ANG_SEG, SLASH_RAD_SEG);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(m.positions, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(m.colors, 3));
  g.setIndex(m.indices);
  return g;
}

const _bm = new THREE.Matrix4();
const _bq = new THREE.Quaternion();
const _bp = new THREE.Vector3();
const _bs = new THREE.Vector3(1, 1, 1);
const _by = new THREE.Vector3(0, 1, 0);
const _right = new THREE.Vector3();   // camera right axis (health-bar fill anchoring)
const _pq = new THREE.Quaternion();   // particle streak orientation
const _pp = new THREE.Vector3();      // particle position
const _ps = new THREE.Vector3(1, 1, 1); // particle / bar scale
const _pc = new THREE.Color();        // particle / bar instance color
const _vt: Vec2 = { x: 0, y: 0 };     // scratch target for the visibility policy (see visibleAt)
const _vm: Vec2 = { x: 0, y: 0 };     // scratch muzzle for the aiming-line clip
const _vf: Vec2 = { x: 0, y: 0 };     // scratch far end of the aiming line

// Model's rest pose faces +Z (verified from its eye/head geometry). The rotation.y yaw
// convention was verified against real three.js. Keep it hardcoded: GLTFLoader renames
// bones ('toes.l'->'toesl'), which is why auto-detection silently returned 0 before.
// If a future model looks 180° off use Math.PI; if +90° off use +/- Math.PI/2.
const MODEL_FORWARD_YAW = Math.PI / 2;

// Which clip each render state plays. The names live in src/characters.ts with the model file and the
// strip list (one record per character, validated at load), and are RE-EXPORTED here because this is
// where the states are consumed — and because the verify scripts import them from the built renderer,
// which is what keeps them from drifting from the names actually played below.
export const P_ANIM = PLAYER_CHARACTER.anims;
export const E_ANIM = ENEMY_CHARACTER.anims;

/**
 * One spawned enemy's render-side counterpart. `char` is NULL once the corpse has been released (see
 * `releaseView`): the view slot itself is kept forever because `sim.enemies` is index-aligned with
 * `enemyViews` — the sim never removes an enemy, it only flips `alive` — so the slot has to keep
 * existing even after there is nothing left to draw.
 */
interface EnemyView { char: CharInstance | null; dyingT: number; prevAlive: boolean; released: boolean; }

export class GameRenderer {
  private sim: GameSim;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.OrthographicCamera;
  private playerChar: CharInstance;
  private playerTemplate: CharTemplate | null = null;
  private enemyTemplate: CharTemplate | null = null;
  private enemyViews: EnemyView[] = [];
  private bulletMesh: THREE.InstancedMesh;
  private bulletGlowMesh: THREE.InstancedMesh;
  /**
   * The scene's DYNAMIC point-light pool (`BULLET_LIGHTS` slots) — shared by projectile lights and
   * every transient light (muzzle flashes, explosions), assigned in priority order each frame in
   * `sync()`. One pool, not two: the point-light count is per-fragment cost on every lit material
   * AND part of the shader program key, so a transient light gets a slot instead of a second pool.
   */
  private lightPool: THREE.PointLight[] = [];
  private particleMesh: THREE.InstancedMesh;
  private solidMesh: THREE.InstancedMesh;
  private slashMesh: THREE.InstancedMesh;
  private barBgMesh: THREE.InstancedMesh;
  private barFillMesh: THREE.InstancedMesh;
  private laserMesh: THREE.Mesh;
  /** Fallback cover (one instanced box per obstacle) if the prop .glb files fail to load. */
  private coverMesh: THREE.InstancedMesh | null = null;
  /** The arena layout — pure data from props.ts, built once (nothing here moves). */
  private plan: ArenaPlan;
  /** One InstancedMesh per prop used by the plan: ~40 draw calls for the whole room. */
  private propPools = new Map<PropId, THREE.InstancedMesh>();
  /** Which pool slot dresses which obstacle, so the vision pass can dim a cover pile. */
  private coverSlots = new Map<number, { id: PropId; slot: number }[]>();
  private aimBeamMesh: THREE.InstancedMesh;
  // --- vision (see the VISION_* block above) ---
  private visionMesh: THREE.Mesh;
  private visionGeo: THREE.BufferGeometry;
  // Zero-sized until initVision() replaces them. (THREE.* fields escape the strict-property
  // check because the ambient three shim types them as `any`; a real type like VisionField does
  // not, so it needs an initializer rather than a bare declaration.)
  private visionPos = new Float32Array(0); // position buffer, rewritten per frame
  private visionPosAttr: THREE.BufferAttribute;
  private visionField: VisionField = createVisionField(0);
  /** 0 = the feature is off: no overlay, no gating, and cover is left exactly as it was built. */
  private visionOn = false;
  private visionDim = VISION_DIM_DEFAULT;
  /** Per-enemy visibility for THIS frame, filled once and read by the character/beam/bar loops so
   * all three agree and the policy runs once per enemy instead of three times. */
  private enemyVis = new Uint8Array(0);
  /** Per-cover eased dimming (0 = lit, 1 = fully dim) and whether the palette is currently clean. */
  private coverDim = new Float32Array(0);
  private coverWritten = false;
  /** Key light; kept so its shadow camera can follow the player (see addLights). */
  private keyLight: THREE.DirectionalLight;
  /**
   * The ambient (hemisphere) light — the only light the 光照 setting touches, and the only one the
   * toon shader does not band (see lighting.ts for why that makes it "the ambient light").
   */
  private ambientLight: THREE.HemisphereLight;
  /** User's 「环境光」 multiplier; `ambientLight.intensity` is always `ambientIntensity(this)`. */
  private ambientScale = AMBIENT_SCALE_DEFAULT;
  /** The warm diagonal fill (the second directional light; the key light is `keyLight`). */
  private warmLight: THREE.DirectionalLight;
  /** User's 「方向光」 multiplier; it scales BOTH directionals (see lighting.ts for why one knob). */
  private directionalScale = DIRECTIONAL_SCALE_DEFAULT;
  /** The pixelation pass: a small target + the quad that blits it. Off = neither exists at all. */
  private pixelScene: THREE.Scene;
  private pixelCamera: THREE.OrthographicCamera;
  private pixelQuad: THREE.Mesh;
  private pixelMaterial: any;
  private pixelTargetRT: any = null;
  private pixelBlock = PIXEL_BLOCK_DEFAULT;
  private pixelSize = { width: 0, height: 0 };
  /**
   * The scene background, in BOTH spaces. `scene.background` is not drawn by a shader — a colour
   * background is a raw `clear()`, which bypasses the material pipeline entirely — so its bytes must
   * be written in whatever space the current target holds:
   *   * canvas: the ordinary colour; three converts it to the output space for us (sRGB) ✓;
   *   * the pixelation target: DISPLAY bytes, because the target is display-referred now
   *     (postfx.ts::DISPLAY_REFERRED_COLORSPACE_CHUNK). three would hand the clear the WORKING-space
   *     components there, i.e. an almost-black void (#0b0e14 -> 1,1,2), so render() swaps in this
   *     colour, whose stored components ARE the display bytes.
   */
  private readonly bgOnScreen = new THREE.Color(0x0b0e14);
  private readonly bgDisplay = new THREE.Color().setRGB(0x0b / 255, 0x0e / 255, 0x14 / 255);
  /** The vignette card (a camera child). Hidden entirely when the setting is 0 — no fill cost. */
  private vignetteMesh: THREE.Mesh;
  private vignetteStrength = VIGNETTE_STRENGTH_DEFAULT;
  private vignetteGeo: THREE.BufferGeometry;
  /** Tallest shadow caster in the plan; sizes the shadow box's off-screen margin (see shadow.ts). */
  private casterHeight = 0;
  /** Shadow box half-extent currently applied, so the projection matrix is only touched on change. */
  private shadowHalf = -1;
  private frames = 0;
  private camZoom = 1; // camera dolly factor from resize(); keeps on-screen size stable
  private camScale = CAMERA_SCALE_DEFAULT; // user's 「摄像机高度」 multiplier (see camera.ts)
  private camYaw = CAMERA_YAW_DEFAULT;     // user's 「摄像机水平角度」 in degrees (see camera.ts)
  private playerUpper = 0; // 0..1 upper-body aim blend while firing
  private lastSwing = 0;   // last swingCount seen; an increase restarts the one-shot slice clip
  private waveEl: HTMLElement;
  private scoreEl: HTMLElement;
  private fpsEl: HTMLElement;
  private weaponBtnEl: HTMLButtonElement;
  private ammoEl: HTMLElement;
  private ammoCountEl: HTMLElement;
  private ammoFillEl: HTMLElement;
  private ammoLevelEl: HTMLElement;
  private throwBtnEl: HTMLButtonElement;
  private healBtnEl: HTMLButtonElement;
  // Cached HUD strings: these change rarely (ammo) or never (weapon name), and writing
  // textContent every frame forces needless layout work on a 60fps loop.
  private hudWeapon = '';
  private hudAmmo = '';
  private hudLevel = '';
  private hudLevelColor = '';
  private hudThrow = '';
  private hudHeal = '';
  private fpsLastMs = 0;   // wall-clock anchor for the FPS average
  private fpsFrames = 0;

  constructor(sim: GameSim, canvas: HTMLCanvasElement) {
    // ⚠️ FIRST, and before any material can compile: make three's output conversion unconditional so
    // the OFFSCREEN pixelation pass composites in display space exactly like the screen does. See
    // postfx.ts::DISPLAY_REFERRED_COLORSPACE_CHUNK for why this is one global assignment rather than a
    // per-material patch (every material in the scene has to agree) and why the canvas path cannot
    // notice (for an sRGB canvas `linearToOutputTexel` IS `sRGBTransferOETF`).
    THREE.ShaderChunk.colorspace_fragment = DISPLAY_REFERRED_COLORSPACE_CHUNK;
    this.sim = sim;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene = new THREE.Scene();
    this.scene.background = this.bgOnScreen;    // render() swaps in bgDisplay while the target is bound
    // ORTHOGRAPHIC projection (see camera.ts::orthoFrustumHeight for why: a parallel projection is
    // what makes the pixelation pass stable, and it keeps the reference framing at the focus plane).
    // The frustum is set in resize(); near/far are generous because the room is 76 units across and
    // the camera sits up to ~85 units away — under ortho the depth range only has to contain the room.
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 400);
    this.addLights();
    this.addGround();
    // The layout is pure and depends only on the obstacle list (never on the player), so it is
    // built once and written into the GPU buffers once. The .glb files arrive later, through
    // setProps() — see main.ts::bootAssets.
    this.plan = planArena(sim.obstacles);
    this.casterHeight = planCasterHeight(this.plan);
    this.initBullets();
    this.initParticles();
    this.initSlashes();
    this.initAimBeams();
    this.initVision();
    this.initBars();
    this.initLaser();
    this.initVignette();
    this.initPixelPass();
    this.playerChar = spawnPrimitive('player');
    this.scene.add(this.playerChar.root);
    this.waveEl = document.getElementById('wave') as HTMLElement;
    this.scoreEl = document.getElementById('score') as HTMLElement;
    this.fpsEl = document.getElementById('fps') as HTMLElement;
    this.weaponBtnEl = document.getElementById('weaponBtn') as HTMLButtonElement;
    this.ammoEl = document.getElementById('ammo') as HTMLElement;
    this.ammoCountEl = document.getElementById('ammoCount') as HTMLElement;
    this.ammoFillEl = document.getElementById('ammoFill') as HTMLElement;
    this.ammoLevelEl = document.getElementById('ammoLevel') as HTMLElement;
    this.throwBtnEl = document.getElementById('throwBtn') as HTMLButtonElement;
    this.healBtnEl = document.getElementById('healBtn') as HTMLButtonElement;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /** The prop .glb files this arena needs (for main.ts to load through assets.ts). */
  propFiles(): string[] {
    const out = new Set<string>();
    for (const list of [this.plan.floor, this.plan.walls, this.plan.cover, this.plan.decor]) {
      for (const p of list) out.add(PROPS[p.id].file);
    }
    return [...out];
  }

  /**
   * Live renderer counters for the in-page profiler (`?diag=1`, see diag.ts) and for a DevTools
   * session. `programs` is the one that matters most: three compiles a program the first time a
   * material/geometry/light variant is drawn, and that compile is the classic multi-hundred-millisecond
   * mobile stall — a hitch whose frame shows a program-count increase is a compile, not a GC.
   */
  debugInfo(): { calls: number; triangles: number; programs: number; geometries: number; textures: number } {
    const info = this.renderer.info;
    return {
      calls: info.render.calls,
      triangles: info.render.triangles,
      programs: info.programs ? info.programs.length : 0,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
    };
  }

  /**
   * The render-resolution chain for the `?diag=1` readout (postfx.ts::resolutionChain). It only reads
   * numbers the renderer already owns, and the profiler asks for it at its 250 ms cadence at most — so
   * the per-frame cost is zero and a 60 fps HUD write is not traded for a diagnostic.
   *
   * WHY IT IS WORTH A READOUT AT ALL: "the landscape picture is lower resolution" cannot be answered
   * from the picture, because it mixes HOW MANY pixels are rendered with HOW MUCH WORLD each one
   * covers. Those two have different owners (the 「像素化」 setting vs the camera pose), so the profiler
   * prints both — plus the other orientation's last measurement, which is what turns "looks worse" into
   * a ratio.
   */
  debugResolution(): ResolutionFacts {
    const size = this.renderer.getSize(new THREE.Vector2());
    const canvas = this.renderer.domElement;
    return {
      viewportW: size.x,
      viewportH: size.y,
      // The ratio the renderer actually draws at — CAPPED, which is why `deviceDpr` is reported next
      // to it instead of being folded in: the cap is one of the things this line exists to expose.
      dpr: this.renderer.getPixelRatio(),
      deviceDpr: window.devicePixelRatio || 1,
      block: this.pixelBlock,
      // Pass on: the offscreen target (resizePixelTarget owns its size). Pass off: the canvas drawing
      // buffer IS the render target, and its texels are `dpr` device pixels each.
      targetW: this.pixelTargetRT ? this.pixelSize.width : canvas.width,
      targetH: this.pixelTargetRT ? this.pixelSize.height : canvas.height,
      frustumHeight: orthoFrustumHeight(this.camScale, this.camZoom),
      screenW: typeof screen !== 'undefined' && screen.width > 0 ? screen.width : size.x,
      screenH: typeof screen !== 'undefined' && screen.height > 0 ? screen.height : size.y,
    };
  }

  /**
   * Build the arena from the loaded prop geometries: one InstancedMesh per prop, written ONCE.
   *
   * WHY ONE POOL PER PROP AND NOT ONE PER OBSTACLE: every pool is a single draw call for every
   * instance of that prop anywhere in the room, so the whole room is ~40 draw calls instead of
   * ~800. It also keeps the vision pass cheap: dimming writes `instanceColor`, and the pool → slot
   * → obstacle index is precomputed in `coverSlots`.
   *
   * An empty `geoms` (the .glb files failed to load) falls back to the old instanced boxes, so a
   * broken asset still leaves a PLAYABLE arena instead of an invisible one.
   */
  setProps(geoms: Map<string, any>): void {
    if (geoms.size === 0) {
      this.initCoverFallback();
      return;
    }
    const mat = createToonMaterial({ vertexColors: true });
    const groups = new Map<PropId, PlacedProp[]>();
    for (const list of [this.plan.floor, this.plan.walls, this.plan.cover, this.plan.decor]) {
      for (const p of list) {
        const arr = groups.get(p.id);
        if (arr) arr.push(p); else groups.set(p.id, [p]);
      }
    }
    for (const [id, list] of groups) {
      const geo = geoms.get(PROPS[id].file);
      if (!geo) continue;   // one missing prop must not take the room down
      const mesh = new THREE.InstancedMesh(geo, mat, list.length);
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      // One draw call covers the whole room, so per-mesh culling would only ever discard the entire
      // room at once; the instanced pool is not worth a bounding sphere.
      mesh.frustumCulled = false;
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        // The floor tiles are the one prop that is not stood ON the floor: their own height has
        // already been squashed to FLOOR_TOP (see props.ts), so placing them at FLOOR_TOP would put
        // their TOP at 2*FLOOR_TOP and sink every other prop 1cm into them. Base 0 -> top FLOOR_TOP,
        // exactly what the constant claims, and every prop then sits flush on the surface.
        _bp.set(p.x, id === 'floorFull' ? 0 : FLOOR_TOP, p.z);
        // Right-angle turns only (the planner guarantees that), so the turn direction cannot matter
        // for the axis-aligned footprint containment the layout is verified against.
        _bq.setFromAxisAngle(_by, (-p.yaw * Math.PI) / 2);
        _bs.set(p.scale, p.sy ?? p.scale, p.scale);
        _bm.compose(_bp, _bq, _bs);
        mesh.setMatrixAt(i, _bm);
        _pc.setHex(0xffffff);
        mesh.setColorAt(i, _pc);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      // The floor does not cast (it would shadow everything under itself); walls and props do, which
      // is what gives the room its depth. Everything receives.
      mesh.castShadow = id !== 'floorFull';
      mesh.receiveShadow = true;
      this.scene.add(mesh);
      this.propPools.set(id, mesh);
    }
    // Index the cover instances by obstacle for the vision pass. The slot of an instance is its
    // position in its prop's pool, which is filled in exactly this order (floor -> walls -> cover ->
    // decor), so a running per-prop counter reproduces it without duplicating the grouping logic.
    const slotOf = new Map<PropId, number>();
    for (const list of [this.plan.floor, this.plan.walls, this.plan.cover, this.plan.decor]) {
      for (const p of list) {
        const slot = slotOf.get(p.id) ?? 0;
        slotOf.set(p.id, slot + 1);
        if (list !== this.plan.cover || p.obstacle === undefined) continue;
        const arr = this.coverSlots.get(p.obstacle);
        if (arr) arr.push({ id: p.id, slot });
        else this.coverSlots.set(p.obstacle, [{ id: p.id, slot }]);
      }
    }
  }

  /** Swap in real GLB characters once loaded (idempotent). */
  setAssets(player: CharTemplate | null, enemy: CharTemplate | null): void {
    this.playerTemplate = player;
    this.enemyTemplate = enemy;
    this.scene.remove(this.playerChar.root);
    this.playerChar.dispose();
    this.playerChar = player ? spawnFromTemplate(player) : spawnPrimitive('player');
    this.scene.add(this.playerChar.root);
    for (let i = 0; i < this.enemyViews.length; i++) {
      const v = this.enemyViews[i];
      // Release the primitive/previous clone first — this template swap is the one place a live
      // character is replaced wholesale, so the old clone's bindings must go back. A corpse that was
      // still playing its death animation loses the rest of it here (it is a one-off asset swap,
      // before/around the first seconds of a run), and finished corpses stay released.
      this.releaseView(v);
      const e = this.sim.enemies[i];
      if (!e || !e.alive) continue;
      v.char = this.makeEnemyChar(e);
      v.released = false;
      this.scene.add(v.char.root);
    }
  }

  private makeEnemyChar(e: any): CharInstance {
    if (this.enemyTemplate) return spawnFromTemplate(this.enemyTemplate);
    return spawnPrimitive('enemy', e && e.kind === 'sprinter');
  }

  resize(): void {
    const w = this.renderer.domElement.clientWidth || window.innerWidth;
    const h = this.renderer.domElement.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Keep the character's on-screen size roughly constant across orientations (see CAM_REF_H). Under
    // the ORTHOGRAPHIC camera this factor scales the FRUSTUM rather than dollying the camera: moving an
    // ortho camera does not change the image, so the old `height/back *= camZoom` would have done
    // nothing at all to the framing (and the landscape compensation would have silently died).
    this.camZoom = Math.max(CAM_ZOOM_MIN, Math.min(CAM_ZOOM_MAX, h / CAM_REF_H));
    this.updateOrthoFrustum();
    this.resizePixelTarget();
    // The vignette card must cover the new frustum (its SIZE depends on the aspect; its falloff
    // table does not — see vignette.ts::vignetteRadius for why that makes rotation pop-free).
    if (this.vignetteMesh) this.writeVignetteGrid();
  }

  /**
   * Apply the 「摄像机高度」 setting: a multiplier on the reference height (1 = the framing this
   * renderer used before the setting existed). Called by the settings panel through main.ts, and
   * safe to call every frame — it only stores a clamped number.
   */
  setCameraHeightScale(scale: number): void {
    this.camScale = clampCameraScale(scale);
    this.updateOrthoFrustum();      // the ortho frustum IS the framing under a parallel projection
    if (this.vignetteMesh) this.writeVignetteGrid();
    this.resizePixelTarget();
  }

  /**
   * Apply the 「摄像机水平角度」 setting: the camera ORBITS the player around +Y (see camera.ts).
   *
   * Nothing has to be rebuilt for this one: the orbit changes neither the pitch nor the distance, so
   * the ortho frustum, the vignette card's grid and the pixelation target are all unaffected. The
   * per-frame pose, the shadow-box fit and the input mapping read `camYaw` and follow automatically.
   */
  setCameraYaw(deg: number): void {
    this.camYaw = clampCameraYaw(deg);
  }

  /**
   * Apply the 「像素化」 block size (CSS px). 0 disables the pass completely: the renderer goes back to
   * drawing the scene straight to the canvas and the render target is released, so "off" costs nothing.
   */
  setPixelBlock(block: number): void {
    this.pixelBlock = clampPixelBlock(block);
    this.resizePixelTarget();
  }

  /**
   * Create the pass's scene: a single quad whose material samples the small target. The quad is drawn
   * with an identity-ish ortho camera in a scene of its own, so this pass cannot interfere with the
   * game scene (and vice versa).
   */
  private initPixelPass(): void {
    this.pixelScene = new THREE.Scene();
    this.pixelCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.pixelMaterial = new THREE.ShaderMaterial({
      uniforms: { tPixelScene: { value: null } },
      vertexShader: PIXEL_VERTEX_SHADER,
      fragmentShader: PIXEL_FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false,
    });
    this.pixelQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.pixelMaterial);
    this.pixelQuad.frustumCulled = false;
    this.pixelScene.add(this.pixelQuad);
    this.resizePixelTarget();
  }

  /** (Re)allocate the small target for the current viewport + block size. */
  private resizePixelTarget(): void {
    const size = this.renderer.getSize(new THREE.Vector2());
    const dpr = this.renderer.getPixelRatio();
    const target = pixelTarget(size.x || 1, size.y || 1, dpr, this.pixelBlock);
    if (!target.enabled) {
      if (this.pixelTargetRT) {
        this.pixelTargetRT.dispose();
        this.pixelTargetRT = null;
      }
      this.pixelSize = { width: 0, height: 0 };
      return;
    }
    this.pixelSize = { width: target.width, height: target.height };
    if (!this.pixelTargetRT) {
      // ⚠️ NO `colorSpace` HERE, ON PURPOSE — and it is the OPPOSITE reason to the one this comment
      // used to give. This texture holds DISPLAY-referred bytes (every material writes display values
      // now: postfx.ts::DISPLAY_REFERRED_COLORSPACE_CHUNK), so the blit must copy them verbatim.
      // Flagging the texture as sRGB would make the sampler hardware-decode them (treating display
      // bytes as linear) and the frame would come out dark — and it would also make this pipeline
      // depend on whether the driver converts on framebuffer *write*, which is exactly the kind of
      // untestable behaviour this project refuses to rely on.
      this.pixelTargetRT = new THREE.WebGLRenderTarget(target.width, target.height, {
        // NEAREST is the whole effect: with linear filtering the blocks would be blurred together.
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        generateMipmaps: false,
        depthBuffer: true,
        stencilBuffer: false,
        // Same COVERAGE rules as the canvas (`antialias: true` above): without this a thin bright
        // effect snaps to full brightness or disappears instead of contributing its true coverage, and
        // the pixelated view reads brighter than the direct one. See PIXEL_MSAA_SAMPLES.
        samples: PIXEL_MSAA_SAMPLES,
      });
    } else {
      this.pixelTargetRT.setSize(target.width, target.height);
    }
  }

  /**
   * Re-fit the key light's shadow box for this frame (see src/shadow.ts).
   *
   * Called every frame, but only ever touches the shadow camera's projection matrix: the box moves
   * with the VIEW, not with the player, so while the player walks nothing here changes at all — the
   * texel grid stays frozen in world space and the shadow edges stay put. That is the whole point.
   */
  private updateShadowFit(playerX: number, playerZ: number): void {
    const fit = fitShadowBox(
      playerX, playerZ, this.camScale, this.camZoom, this.camera.aspect, this.casterHeight,
      undefined, this.camYaw,
    );
    this.keyLight.position.set(fit.light[0], fit.light[1], fit.light[2]);
    this.keyLight.target.position.set(fit.target[0], fit.target[1], fit.target[2]);
    this.keyLight.target.updateMatrixWorld();
    const cam = this.keyLight.shadow.camera;
    if (fit.half !== this.shadowHalf) {
      cam.left = -fit.half;
      cam.right = fit.half;
      cam.top = fit.half;
      cam.bottom = -fit.half;
      this.shadowHalf = fit.half;
    }
    // near/far are anchored on the box centre (which shifts with the view), so they are refreshed
    // unconditionally. They only rescale the shadow depth: `bias` is converted with the same span,
    // so the depth COMPARISON is unchanged by them (see the note in shadow.ts).
    cam.near = fit.near;
    cam.far = fit.far;
    cam.updateProjectionMatrix();
    this.keyLight.shadow.bias = fit.bias;
    this.keyLight.shadow.normalBias = fit.normalBias;
  }

  private addLights(): void {
    // Ambient fill. Created at the built-in scale so a renderer constructed without a settings
    // panel still renders the shipped look; setAmbientScale is the only writer after this.
    const amb = new THREE.HemisphereLight(
      AMBIENT_SKY_COLOR, AMBIENT_GROUND_COLOR, ambientIntensity(this.ambientScale),
    );
    this.ambientLight = amb;
    this.scene.add(amb);
    // Key light: also the shadow caster. Its shadow BOX is not fixed here — it is re-fitted every
    // frame to what the camera can actually see, and snapped to whole shadow-map texels. Both parts
    // matter and both were bug fixes (noise + crawl): see src/shadow.ts, which owns the geometry and
    // documents the two artifacts this replaced. Everything below that cannot vary per frame is set
    // once here.
    // Intensity = the shipped base x the 「方向光」 scale, so a renderer built without a settings
    // panel renders the shipped sun and setDirectionalScale is the only writer after this.
    const dir = new THREE.DirectionalLight(
      0xffffff, directionalIntensity(DIR_KEY_INTENSITY, this.directionalScale),
    );
    dir.position.set(...LIGHT_OFFSET);
    dir.castShadow = true;
    dir.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    dir.shadow.camera.near = 1;
    dir.shadow.camera.far = 60;
    dir.shadow.camera.left = -SHADOW_HALF_MIN;
    dir.shadow.camera.right = SHADOW_HALF_MIN;
    dir.shadow.camera.top = SHADOW_HALF_MIN;
    dir.shadow.camera.bottom = -SHADOW_HALF_MIN;
    dir.shadow.camera.updateProjectionMatrix();
    dir.shadow.bias = -0.0003;
    dir.shadow.normalBias = 0.02;
    this.keyLight = dir;
    this.scene.add(dir);
    this.scene.add(dir.target);
    // Warm diagonal fill light from the opposite corner (late-afternoon sun); no shadow to keep cost down.
    const warm = new THREE.DirectionalLight(
      0xffc890, directionalIntensity(DIR_WARM_INTENSITY, this.directionalScale),
    );
    warm.position.set(-16, 12, -14);
    this.warmLight = warm;
    this.scene.add(warm);
  }

  private addGround(): void {
    // A dark surround plane, mostly hidden by the room's walls: it fills the horizon behind them so
    // the arena reads as a lit interior floating in darkness rather than a floor that stops.
    //
    // IT USED TO BE THE BRIGHT OUTDOOR FLOOR (0x4a5568) WITH A GridHelper ON TOP — both are gone
    // with the indoor theme: the grid was an outdoor readability aid that fought with real floor
    // tiles, and a bright plane outside the walls lit up the whole horizon behind them.
    const geo = new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE);
    geo.rotateX(-Math.PI / 2);
    // The surround plane is LIT, so it takes the height fog like the room does: the void behind the
    // walls fades into the fog colour, which is what makes the horizon read as mist instead of a cut.
    const ground = new THREE.Mesh(geo, createToonMaterial({ color: 0x11161d }));
    ground.position.y = -0.02;   // just under the floor tiles (their top is FLOOR_TOP)
    ground.receiveShadow = false;
    this.scene.add(ground);
  }

  private initBullets(): void {
    // Unit box + per-instance scale, so one pool can draw every ammo type at its own size
    // (see `bullet.def.visual.size`). White base material: the actual colour is per instance.
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.bulletMesh = new THREE.InstancedMesh(geo, mat, MAX_BULLETS);
    this.bulletMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.bulletMesh.frustumCulled = false;
    this.bulletMesh.count = 0;
    this.scene.add(this.bulletMesh);
    // Glow sheath around every projectile: same geometry + same per-instance transform,
    // just scaled up and drawn additively at low opacity. One extra draw call total.
    const glowMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: BULLET_GLOW_OPACITY,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.bulletGlowMesh = new THREE.InstancedMesh(geo, glowMat, MAX_BULLETS);
    this.bulletGlowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.bulletGlowMesh.frustumCulled = false;
    this.bulletGlowMesh.count = 0;
    this.scene.add(this.bulletGlowMesh);
    for (let i = 0; i < BULLET_LIGHTS; i++) {
      // Colour/intensity/distance are re-set per frame from the projectile def or the muzzle recipe;
      // the initial values are just the dragon-breath ones so a first frame before sync() looks right.
      const l = new THREE.PointLight(0xff4a12, 10, 9, 2);
      l.visible = false;
      this.scene.add(l);
      this.lightPool.push(l);
    }
  }

  private initParticles(): void {
    // Sparks are thin additive streaks. Unit box + per-instance scale (w, w, length),
    // oriented so the box's local +Z axis lies along the particle velocity. Additive
    // blending + no depthWrite makes overlapping sparks glow like fire.
    //
    // TWO pools, routed by `Particle.solid`:
    //   * additive  — fire, sparks, burn flames, explosion fireball/ring/embers (the original
    //                 look, unchanged);
    //   * normal    — smoke and solid debris. Additive cannot darken, so these need their own
    //                 material; both pools share the same unit box and per-instance colour.
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.particleMesh = new THREE.InstancedMesh(geo, mat, MAX_PARTICLES);
    this.particleMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.particleMesh.frustumCulled = false;
    this.particleMesh.count = 0;
    // Additive after normal: glow goes on top of the smoke it is lighting up.
    this.particleMesh.renderOrder = 2;
    this.scene.add(this.particleMesh);

    const solidMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: SOLID_OPACITY,
      depthWrite: false,
    });
    this.solidMesh = new THREE.InstancedMesh(geo, solidMat, MAX_SOLID_PARTICLES);
    this.solidMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.solidMesh.frustumCulled = false;
    this.solidMesh.count = 0;
    this.solidMesh.renderOrder = 1;
    this.scene.add(this.solidMesh);
  }

  private initSlashes(): void {
    // vertexColors (the baked envelope) + instanceColor (the per-instance tint) MULTIPLY in three,
    // which is what makes the two passes free: the core is the crescent tinted bright, the glow is
    // the same geometry scaled past the blade edge and tinted dim, and `slashAlpha()` becomes a
    // brightness fade on the instance colour.
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,     // a translucent additive ribbon must not occlude what is behind it
      side: THREE.DoubleSide,
    });
    this.slashMesh = new THREE.InstancedMesh(makeSlashGeometry(CONFIG.slashSpan), mat, MAX_SLASH_INSTANCES);
    this.slashMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.slashMesh.frustumCulled = false; // instances are placed in sync(), not in this mesh's bounds
    this.slashMesh.count = 0;
    // Over the sparks (2) so the blade edge stays crisp, under the health bars (10).
    this.slashMesh.renderOrder = 3;
    this.scene.add(this.slashMesh);
  }

  /**
   * Cover: the whole static layout as ONE instanced unit box.
   *
   * WHY INSTANCED AND NOT ONE MESH PER OBSTACLE: 20 obstacles would be 20 draw calls for geometry
   * that never moves. One InstancedMesh with a per-instance matrix (position + non-uniform scale)
   * and a per-instance colour costs a single draw call, and the layout only has to be uploaded once
   * — the only pool in this file that is NOT rewritten every frame.
   *
   * Toon-shaded like the ground and the characters (same shared gradient map), and both a shadow
   * caster and receiver: cover that does not cast a shadow reads as a decal painted on the floor,
   * which would undercut the whole "this thing is solid" message.
   *
   * THIS IS NOW ONLY THE FALLBACK: the arena is built from real Kenney props (setProps), and these
   * boxes appear only when the prop .glb files fail to load — an invisible arena would be far worse
   * than an ugly one. Kept deliberately small for that reason.
   */
  private initCoverFallback(): void {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = createToonMaterial({ color: 0xffffff });
    const list = this.sim.obstacles;
    this.coverMesh = new THREE.InstancedMesh(geo, mat, Math.max(1, list.length));
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      _bp.set(o.x, o.h * 0.5 - COVER_Y_EPS, o.y);
      _bq.identity();
      _bs.set(o.hw * 2, o.h, o.hh * 2);
      _bm.compose(_bp, _bq, _bs);
      this.coverMesh.setMatrixAt(i, _bm);
      _pc.setHex(COVER_PALETTE[i % COVER_PALETTE.length]);
      this.coverMesh.setColorAt(i, _pc);
    }
    this.coverMesh.count = list.length;
    this.coverMesh.castShadow = true;
    this.coverMesh.receiveShadow = true;
    this.coverMesh.instanceMatrix.needsUpdate = true;
    if (this.coverMesh.instanceColor) this.coverMesh.instanceColor.needsUpdate = true;
    this.scene.add(this.coverMesh);
  }

  /**
   * Vision: the darkness overlay — ONE mesh, 12 vertices per angular sector, positions rewritten
   * every frame.
   *
   * WHY THE POOL IS SIZED FROM THE LAYOUT: the field emits one sector per seed angle plus three
   * rays per padded corner (the +-VISION_ANGLE_EPS brackets), so a level with more cover needs more
   * sectors. Sizing from `obstacles.length` means a future layout either fits or fails the
   * `raw <= cap` assertion in scripts/verify-vision.mjs — the alternative (a magic constant) would
   * silently drop a shadow when someone adds cover.
   *
   * VERTEX ALPHA IS BAKED AT INIT and never touched again; only positions change per frame. Alpha
   * is 0 on the boundary ring and 1 one VISION_FADE further out, which is the soft edge: the
   * darkness ramps IN as it leaves the occluder, so the transition never reads as a hard aliased
   * line while everything past the band is fully dark.
   */
  private initVision(): void {
    const cap = VISION_SEEDS + 12 * this.sim.obstacles.length + 2;
    this.visionField = createVisionField(cap);
    const verts = cap * VISION_VERTS_PER_SECTOR;
    this.visionPos = new Float32Array(verts * 3);
    const col = new Float32Array(verts * 4);
    // rgb stays 0 (black); only alpha varies. Index order matches the 12 `pt()` calls in
    // writeVisionGeometry: A(0) B(0) D(1) | A(0) D(1) C(1) | C(1) D(1) F(1) | C(1) F(1) E(1).
    const alphas = [0, 0, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1];
    for (let i = 0; i < cap; i++) {
      const base = i * VISION_VERTS_PER_SECTOR * 4;
      for (let v = 0; v < VISION_VERTS_PER_SECTOR; v++) col[base + v * 4 + 3] = alphas[v];
    }
    this.visionGeo = new THREE.BufferGeometry();
    this.visionPosAttr = new THREE.BufferAttribute(this.visionPos, 3);
    this.visionGeo.setAttribute('position', this.visionPosAttr);
    this.visionGeo.setAttribute('color', new THREE.BufferAttribute(col, 4));
    this.visionGeo.setDrawRange(0, 0);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      vertexColors: true,
      transparent: true,
      depthWrite: false,        // it darkens what is already drawn; it must never occlude anything
      side: THREE.DoubleSide,   // the quads lie in XZ, so their geometric normal points down
    });
    this.visionMesh = new THREE.Mesh(this.visionGeo, mat);
    this.visionMesh.frustumCulled = false;   // positions are written in sync(), outside any bounds
    // Drawn BEFORE every additive effect (laser, beams, sparks, crescents, bars) so muzzle fire and
    // explosions still glow inside the dark region instead of being flattened by it.
    this.visionMesh.renderOrder = -1;
    this.scene.add(this.visionMesh);
    this.setVisionDim(this.visionDim);
  }

  /**
   * Apply the 「遮挡变暗」 setting (see vision.ts for the slider contract). 0 turns the whole feature
   * off: no overlay, no gating, cover back on its palette — the documented rollback and the
   * performance escape hatch. Safe to call every frame; called from main.ts via the settings panel
   * and once from initVision so a renderer with no panel still behaves like the shipped default.
   */
  setVisionDim(dim: number): void {
    const d = clampVisionDim(dim);
    this.visionDim = d;
    this.visionOn = d > 0;
    this.visionMesh.material.opacity = d;
    if (!this.visionOn) {
      this.visionMesh.visible = false;
      this.restoreCover();
    }
  }

  /**
   * Apply the 「环境光」 setting: a multiplier on the ambient (hemisphere) intensity. Clamped here,
   * so a dirty stored value can never reach the light. Safe to call every frame; called from main.ts
   * through the settings panel.
   *
   * 0 is NOT an off-switch for a feature (unlike setVisionDim): it is a legal look — only the two
   * directional lights remain, i.e. the highest-contrast version of the scene — so there is no
   * `visible = false` path and the light always stays in the scene.
   */
  setAmbientScale(scale: number): void {
    this.ambientScale = clampAmbientScale(scale);
    this.ambientLight.intensity = ambientIntensity(this.ambientScale);
  }

  /**
   * Apply the 「方向光」 setting: one multiplier over BOTH directional lights. Clamped here, so a dirty
   * stored value can never reach the lights. Safe to call every frame; called from main.ts through the
   * settings panel.
   *
   * Both are written together on purpose — the key:warm ratio is the form/shape information, and
   * moving only one of them would change the warm/cool balance instead of the overall sun strength
   * (see lighting.ts). 0 is legal: it leaves whatever the ambient slider provides.
   */
  setDirectionalScale(scale: number): void {
    this.directionalScale = clampDirectionalScale(scale);
    this.keyLight.intensity = directionalIntensity(DIR_KEY_INTENSITY, this.directionalScale);
    this.warmLight.intensity = directionalIntensity(DIR_WARM_INTENSITY, this.directionalScale);
  }

  /**
   * Apply the 「高度雾」 setting. The fog is a shader patch on every LIT material (see toon.ts) with a
   * single shared density uniform, so this is one assignment and needs no recompile: 0 makes the mix
   * a no-op, which is also the documented off switch / rollback.
   *
   * Unlit effect materials (bullets, glow, particles, crescents, bars, laser, beams, the vision
   * overlay, outline hulls) are deliberately NOT patched: they are UI-ish accents whose whole job is
   * to stay crisp, and the additive ones (glow/flames) would be dimmed by a mix toward a dark colour.
   */
  setFogDensity(density: number): void {
    setHeightFogDensity(density);
  }

  /**
   * Apply the 「调性」 grade strength (see grade.ts). One shared uniform, no recompile: 0 restores
   * exactly the ungraded image, which is the documented escape hatch if the grade reads wrong.
   */
  setGradeStrength(strength: number): void {
    setGradeStrength(strength);
  }

  /**
   * Apply the 「暗角」 strength. 0 hides the card completely so it costs nothing; any other value just
   * rewrites the vertex-colour table (361 vertices) — no shader change, no recompile.
   */
  setVignetteStrength(strength: number): void {
    this.vignetteStrength = clampVignetteStrength(strength);
    this.vignetteMesh.visible = this.vignetteStrength > 0;
    if (this.vignetteStrength > 0) this.writeVignetteGrid();
  }

  private initVignette(): void {
    this.vignetteGeo = new THREE.BufferGeometry();
    this.vignetteGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    this.vignetteGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(2), 2));
    this.vignetteGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(3), 3));
    // MultiplyBlending: dst * src, where src is the per-vertex brightness. It is NOT lit and NOT
    // fogged (an unlit screen effect — see toon.ts for the rule), and depthTest is off so the card
    // never fights the scene's depth buffer. renderOrder 5 puts it above the transparent effects
    // (bullets/particles/vision overlay) but BELOW the world-space bars (10/11) and the HUD, so the
    // health/armour strips are not dimmed by the vignette.
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true, blending: THREE.MultiplyBlending, depthTest: false, depthWrite: false,
      fog: false, transparent: true,
    });
    this.vignetteMesh = new THREE.Mesh(this.vignetteGeo, mat);
    this.vignetteMesh.frustumCulled = false;
    this.vignetteMesh.renderOrder = 5;
    // It goes in the SCENE, not as a camera child: three only renders what it walks from `scene`, and
    // the camera is not part of the scene — a camera-child mesh would have its matrix updated and then
    // never be drawn (a silent "the vignette does nothing" bug). syncVignette() instead copies the
    // camera's world transform onto it every frame, which is the same trick the world-space bars use.
    this.scene.add(this.vignetteMesh);
    this.writeVignetteGrid();
    this.vignetteMesh.visible = this.vignetteStrength > 0;
  }

  /**
   * Park the vignette card in front of the camera in WORLD space, one frame after the camera moved.
   * Copying position+quaternion and stepping back along the view axis is all a screen-space card
   * needs, and it keeps the geometry a plain world-space mesh (no camera-child rendering traps).
   */
  private syncVignette(): void {
    if (!this.vignetteMesh.visible) return;
    this.vignetteMesh.position.copy(this.camera.position);
    this.vignetteMesh.quaternion.copy(this.camera.quaternion);
    this.vignetteMesh.translateZ(-VIGNETTE_DIST);
  }

  /**
   * Snap the camera to the pixelation block grid (see postfx.ts::snapCameraToBlockGrid for why this is
   * what makes the pass stable). Runs right after the camera pose is set and before anything that
   * depends on it, and does nothing when the pass is off — so with the pass disabled the camera keeps
   * its exact smooth position and the image is bit-identical to the pre-pass build.
   */
  private snapCameraToPixelGrid(): void {
    if (!this.pixelTargetRT) return;
    const frustumHeight = orthoFrustumHeight(this.camScale, this.camZoom);
    const per = worldPerBlock(frustumHeight, frustumHeight * this.camera.aspect, this.pixelSize);
    _vRight.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    _vUp.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
    const p = this.camera.position;
    const snapped = snapCameraToBlockGrid(
      [p.x, p.y, p.z], [_vRight.x, _vRight.y, _vRight.z], [_vUp.x, _vUp.y, _vUp.z], per.x, per.y,
    );
    this.camera.position.set(snapped[0], snapped[1], snapped[2]);
  }

  /** Rebuild the vertex table (positions depend on the viewport aspect, colours on the strength). */
  private writeVignetteGrid(): void {
    const grid = buildVignetteGrid({
      segments: VIGNETTE_SEGMENTS, dist: VIGNETTE_DIST, aspect: this.aspect(),
      strength: this.vignetteStrength, scale: this.camScale, camZoom: this.camZoom,
    });
    const pos = this.vignetteGeo.getAttribute('position');
    const uv = this.vignetteGeo.getAttribute('uv');
    const col = this.vignetteGeo.getAttribute('color');
    if (pos.count !== grid.positions.length / 3) {
      this.vignetteGeo.setAttribute('position', new THREE.BufferAttribute(grid.positions, 3));
      this.vignetteGeo.setAttribute('uv', new THREE.BufferAttribute(grid.uvs, 2));
      this.vignetteGeo.setAttribute('color', new THREE.BufferAttribute(grid.colors, 3));
      this.vignetteGeo.setIndex(new THREE.BufferAttribute(grid.indices, 1));
    } else {
      (pos.array as Float32Array).set(grid.positions);
      (uv.array as Float32Array).set(grid.uvs);
      (col.array as Float32Array).set(grid.colors);
      pos.needsUpdate = true;
      uv.needsUpdate = true;
      col.needsUpdate = true;
    }
  }

  /**
   * The orthographic view volume: vertical size from camera.ts (which derives it from the pose, so the
   * framing at the focus plane matches the old perspective look), horizontal from the aspect.
   */
  private updateOrthoFrustum(): void {
    const height = orthoFrustumHeight(this.camScale, this.camZoom);
    const width = height * this.camera.aspect;
    this.camera.left = -width / 2;
    this.camera.right = width / 2;
    this.camera.top = height / 2;
    this.camera.bottom = -height / 2;
    this.camera.updateProjectionMatrix();
  }

  /** Viewport aspect (the card's size depends on it; the falloff table does not). */
  private aspect(): number {
    const size = new THREE.Vector2();
    this.renderer.getSize(size);
    return size.y > 0 ? size.x / size.y : 1;
  }

  /**
   * Put every cover instance back to full brightness (vision off, or a scene reset).
   *
   * Props carry their colour in the VERTEX colours now, so "restore" is a white instance colour —
   * `instanceColor` multiplies the baked colour, and white is the identity.
   */
  private restoreCover(): void {
    for (const slots of this.coverSlots.values()) {
      for (const s of slots) {
        const mesh = this.propPools.get(s.id);
        if (!mesh) continue;
        _pc.setHex(0xffffff);
        mesh.setColorAt(s.slot, _pc);
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    }
    if (this.coverMesh) {
      for (let i = 0; i < this.coverMesh.count; i++) {
        _pc.setHex(COVER_PALETTE[i % COVER_PALETTE.length]);
        this.coverMesh.setColorAt(i, _pc);
      }
      if (this.coverMesh.instanceColor) this.coverMesh.instanceColor.needsUpdate = true;
    }
    this.coverWritten = false;
  }

  /**
   * Is this world position inside the player's view? The POLICY lives in vision.ts
   * (`visibleWithReveal`) rather than here so scripts/verify-vision.mjs can assert it in Node
   * against the sim's own line-of-sight query — including the near-radius fairness floor.
   */
  private visibleAt(x: number, z: number): boolean {
    if (!this.visionOn) return true;
    _vt.x = x;
    _vt.y = z;
    return visibleWithReveal(this.sim.player.pos, _vt, this.sim.obstacles);
  }

  /** Upload the overlay geometry for this frame (the maths is vision.ts::writeVisionGeometry,
   * which scripts/verify-vision.mjs rasterises and checks against `visionFadeAt`). */
  private writeVisionGeometry(): void {
    const verts = writeVisionGeometry(this.visionField, this.visionPos, VISION_Y);
    this.visionGeo.setDrawRange(0, verts);
    if (verts > 0) this.visionPosAttr.needsUpdate = true;
  }

  /**
   * Per-frame vision pass. MUST run before the entity loops in sync(): they read `visibleAt()` and
   * the `enemyVis` mask this fills in.
   */
  private syncVision(p: any, dt: number): void {
    if (!this.visionOn) return;
    rebuildVision(this.visionField, p.pos, this.sim.obstacles);
    this.writeVisionGeometry();
    this.visionMesh.visible = true;
    this.syncCoverDimming(p, dt);
  }

  /**
   * Ease each cover piece between lit and dim.
   *
   * WHY EASED AND NOT A HARD FLIP: the visibility test is binary, and a wall's classification
   * changes the instant a shadow boundary sweeps across its nearest point — which pops. Cover is
   * scenery, not information, so a ~0.2s ramp removes the pop at no cost in readability. Enemies
   * get the opposite treatment on purpose (hard on/off): a half-faded enemy would leave the player
   * unable to tell whether it can be shot.
   */
  private syncCoverDimming(p: any, dt: number): void {
    const list = this.sim.obstacles;
    // One entry per obstacle: the prop path always has instances for every obstacle, and the
    // fallback box pool was sized from the layout at init.
    const count = this.coverMesh ? Math.min(list.length, this.coverMesh.count) : list.length;
    if (count === 0) return;
    if (this.coverDim.length < count) this.coverDim = new Float32Array(count);
    const k = 1 - Math.exp(-Math.max(0, dt) / COVER_DIM_TAU);
    let changed = false;
    for (let i = 0; i < count; i++) {
      const target = coverVisible(p.pos, list[i], list) ? 0 : 1;
      let next = this.coverDim[i] + (target - this.coverDim[i]) * k;
      if (Math.abs(target - next) < 1e-3) next = target;   // settle, so a resting scene stops writing
      if (next !== this.coverDim[i]) changed = true;
      this.coverDim[i] = next;
    }
    if (!changed && this.coverWritten) return;
    // Write the dim multiplier into every instance that dresses an obstacle. The pools are per PROP,
    // so a changed obstacle usually touches one or two of them; `dirty` uploads each pool once.
    const dirty = new Set<THREE.InstancedMesh>();
    for (let i = 0; i < count; i++) {
      const mul = 1 - this.coverDim[i] * (1 - COVER_DIM_MUL);
      const slots = this.coverSlots.get(i);
      if (!slots) continue;
      for (const s of slots) {
        const mesh = this.propPools.get(s.id);
        if (!mesh) continue;
        _pc.setHex(0xffffff).multiplyScalar(mul);
        mesh.setColorAt(s.slot, _pc);
        dirty.add(mesh);
      }
    }
    for (const mesh of dirty) {
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    if (this.coverMesh) {
      // Fallback path: the single instanced-box pool carries the palette in its instance colours.
      for (let i = 0; i < count; i++) {
        const mul = 1 - this.coverDim[i] * (1 - COVER_DIM_MUL);
        _pc.setHex(COVER_PALETTE[i % COVER_PALETTE.length]).multiplyScalar(mul);
        this.coverMesh.setColorAt(i, _pc);
      }
      if (this.coverMesh.instanceColor) this.coverMesh.instanceColor.needsUpdate = true;
    }
    this.coverWritten = true;
  }

  /**
   * Aim beams: one instanced additive quad per TELEGRAPHING gunner.
   *
   * Gameplay, not decoration — a 2.0-unit character doing an aiming animation is not readable at the
   * default camera distance, and a PvE shooter in which damage arrives with no warning is just
   * unfair. The beam is the warning: it appears for exactly `CONFIG.gunnerAimTime` before the shot
   * (driven by the sim's `Enemy.aiming`, so the tell and the shot can never disagree).
   *
   * The quad runs from local x=0 to x=1 with vertex colours white -> black along that axis; the
   * instance scale carries the actual distance. Additive + black = invisible, so the beam fades out
   * toward the player with no texture and no shader — the same trick as the player's aiming line.
   */
  private initAimBeams(): void {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([
      0, 0, -0.5, 1, 0, -0.5, 1, 0, 0.5,
      0, 0, -0.5, 1, 0, 0.5, 0, 0, 0.5,
    ], 3));
    // Bright at the muzzle, gone at the target end.
    geo.setAttribute('color', new THREE.Float32BufferAttribute([
      1, 1, 1, 0, 0, 0, 0, 0, 0,
      1, 1, 1, 0, 0, 0, 1, 1, 1,
    ], 3));
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,   // flat quad on XZ; its geometric normal points down
      depthWrite: false,
    });
    this.aimBeamMesh = new THREE.InstancedMesh(geo, mat, MAX_AIM_BEAMS);
    this.aimBeamMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.aimBeamMesh.frustumCulled = false;
    this.aimBeamMesh.count = 0;
    this.aimBeamMesh.renderOrder = 2;
    this.scene.add(this.aimBeamMesh);
  }

  private initBars(): void {
    // One shared unit quad for every enemy bar. The frame keeps a fixed size; the fill is
    // scaled to `BAR_W * ratio` and offset along the camera's right axis so it shrinks
    // from the right edge (a centred quad would shrink toward the middle instead).
    const geo = new THREE.PlaneGeometry(1, 1);
    const bgMat = new THREE.MeshBasicMaterial({
      color: 0x0b0e14, transparent: true, opacity: 0.72, depthTest: false, depthWrite: false,
    });
    const fillMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, depthTest: false, depthWrite: false,
    });
    this.barBgMesh = new THREE.InstancedMesh(geo, bgMat, MAX_BAR_SLOTS);
    this.barFillMesh = new THREE.InstancedMesh(geo, fillMat, MAX_BAR_SLOTS);
    for (const m of [this.barBgMesh, this.barFillMesh]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.count = 0;
      this.scene.add(m);
    }
    this.barBgMesh.renderOrder = 10;
    this.barFillMesh.renderOrder = 11; // the fill must draw after its own frame
  }

  /**
   * Write one bar FRAME (the dark backing) into the shared frame pool at slot `i`.
   *
   * Frames and fills are indexed SEPARATELY (`bn` / `fn` in sync()) because one enemy needs two of
   * each once it wears armour — its health bar and its armour strip — and a single shared index
   * would make the armour strip overwrite the health bar's frame.
   * `_right` must already hold this frame's camera right axis (see sync()).
   */
  private writeBarFrame(i: number, x: number, z: number, y: number, w = BAR_W, h = BAR_H): void {
    _bp.set(x, y, z);
    _ps.set(w + BAR_PAD * 2, h + BAR_PAD * 2, 1);
    _bm.compose(_bp, this.camera.quaternion, _ps);
    this.barBgMesh.setMatrixAt(i, _bm);
  }

  /**
   * Write one coloured FILL into the shared fill pool at slot `i`. `ratio` fills from the bar's
   * LEFT edge (0 = empty, 1 = full) — the quad is centred, so the position is offset along the
   * camera's right axis to keep the left edge pinned. Enemy health bars, the enemy armour strip and
   * the player's reload bar all go through here, which is why the extras cost no draw call.
   */
  private writeBarFill(
    i: number, x: number, z: number, y: number, ratio: number, fill: number, w = BAR_W, h = BAR_H,
  ): void {
    const r = ratio > 0 ? (ratio > 1 ? 1 : ratio) : 0;
    const fw = w * r;
    _bp.set(x, y, z);
    _bp.addScaledVector(_right, (fw - w) * 0.5);
    _ps.set(fw, h, 1);
    _bm.compose(_bp, this.camera.quaternion, _ps);
    this.barFillMesh.setMatrixAt(i, _bm);
    _pc.setHex(fill);
    this.barFillMesh.setColorAt(i, _pc);
  }

  /**
   * Sync one on-screen action button (throwable / healing) from its slot item. Returns the new
   * text so the caller can keep the per-frame DOM writes minimal (same pattern as the weapon name
   * and the ammo text).
   *
   * The rule — "no item, no button; on cooldown, dimmed" — lives in hud.ts::actionButtonReadout and
   * is asserted in Node; this method only writes it out.
   *
   * `--lv` is a CSS custom property rather than an inline colour: the border AND the level dot need
   * the level colour, so one property keeps the shape in styles.css and the colour here.
   */
  private syncActionButton(
    btn: HTMLButtonElement, item: Item | null, cooldown: number, cache: string,
  ): string {
    const r = actionButtonReadout(item ? countOf(item) : 0, cooldown);
    btn.classList.toggle('hidden', !r.visible);
    btn.classList.toggle('cd', r.dim);
    const text = item ? itemShort(item) + ' ×' + countOf(item) : '';
    if (cache !== text) btn.textContent = text;
    const lv = itemLevel(item);
    btn.style.setProperty('--lv', lv === null ? NO_LEVEL_COLOR : levelColorHex(lv));
    return text;
  }

  private initLaser(): void {
    // One quad in local XZ, pointing along +X: (0,0) -> (LASER_LEN,0), width LASER_WIDTH.
    // Vertex colours go white at the muzzle to black at the tip; the material is additive, so
    // black contributes nothing and the beam fades out with no texture or shader.
    const hw = LASER_WIDTH * 0.5;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      0, 0, -hw, LASER_LEN, 0, -hw, LASER_LEN, 0, hw,
      0, 0, -hw, LASER_LEN, 0, hw, 0, 0, hw,
    ]), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array([
      1, 1, 1, 0, 0, 0, 0, 0, 0,
      1, 1, 1, 0, 0, 0, 1, 1, 1,
    ]), 3));
    const mat = new THREE.MeshBasicMaterial({
      color: LASER_COLOR,
      vertexColors: true,
      transparent: true,
      opacity: LASER_OPACITY,
      blending: THREE.AdditiveBlending,
      // The quad lies flat on XZ and its winding puts the geometric normal at -Y (downward),
      // so FrontSide would backface-cull it from the overhead camera. DoubleSide keeps it
      // visible from any angle; the material is unlit, so there is no shading cost.
      side: THREE.DoubleSide,
      depthWrite: false,   // never occludes anything; still depth-tested against the ground
    });
    this.laserMesh = new THREE.Mesh(geo, mat);
    this.laserMesh.frustumCulled = false;
    this.laserMesh.visible = false;
    this.scene.add(this.laserMesh);
  }

  private ensureViews(): void {
    const sim = this.sim;
    while (this.enemyViews.length < sim.enemies.length) {
      const i = this.enemyViews.length;
      const e = sim.enemies[i];
      const char = this.makeEnemyChar(e);
      this.scene.add(char.root);
      this.enemyViews.push({ char, dyingT: 0, prevAlive: e.alive, released: false });
    }
  }

  /**
   * Give a finished corpse's render resources back.
   *
   * WHY THIS EXISTS (real-device report: 「有时候会突然卡个半秒」, and it got worse the longer a run
   * went): an enemy is never removed from `sim.enemies`, so its `EnemyView` — and with it the whole
   * character clone and its `AnimationMixer` — used to live for the rest of the run. Measured by
   * scripts/verify-spawn-cost.mjs: **1.79 MB retained per enemy** before this was added, i.e. ~180 MB
   * after 100 kills, which is what turns a late wave into a multi-hundred-millisecond major GC pause
   * rather than a dropped frame. A view is never recycled (a new enemy is always appended), so once
   * the 0.9 s death animation is over the corpse is already invisible (`show` is false) and there is
   * nothing left to keep.
   *
   * The SLOT stays: `enemyViews[i]` must keep lining up with `enemies[i]`. Only the character goes.
   */
  private releaseView(v: EnemyView): void {
    if (!v.char) return;
    this.scene.remove(v.char.root);
    v.char.dispose();   // mixer.uncacheRoot: drops this instance's interpolants + property bindings
    v.char = null;
    v.released = true;
  }

  sync(dt: number): void {
    this.ensureViews();
    const sim = this.sim;
    const p = sim.player;

    // --- vision, FIRST: everything below reads `visibleAt()` / the `enemyVis` mask it prepares ---
    this.syncVision(p, dt);

    // --- player ---
    const pc = this.playerChar;
    pc.root.position.set(p.pos.x, 0, p.pos.y);
    pc.root.rotation.y = MODEL_FORWARD_YAW - p.aimAngle;
    // Aiming line: only while the player is actually aiming a RANGED weapon — that is the
    // only time `p.aimAngle` is the aim direction (otherwise it follows the movement). It
    // starts at the weapon's own muzzle offset so it matches where projectiles spawn.
    const weapon = sim.activeWeapon();
    const ranged = weapon && weapon.kind === 'ranged' ? weapon : null;
    const showLaser = p.alive && p.aiming && ranged !== null;
    this.laserMesh.visible = showLaser;
    if (showLaser && ranged) {
      const off = p.r + ranged.muzzleOffset;
      const mx = p.pos.x + Math.cos(p.aimAngle) * off;
      const mz = p.pos.y + Math.sin(p.aimAngle) * off;
      this.laserMesh.position.set(mx, LASER_Y, mz);
      // local +X maps to world (cos a, 0, sin a) under rotation.y = -a
      this.laserMesh.rotation.y = -p.aimAngle;
      // Stop the sight at the first wall it meets. The quad is built 0..LASER_LEN along +X with its
      // vertex colours fading to black at the far end, so scaling x IS "the sight ends here" — and
      // without it the beam would keep pointing through cover that the bullet cannot pass (the old
      // documented behaviour: "fixed 9 units, no raycast against walls").
      _vm.x = mx;
      _vm.y = mz;
      _vf.x = mx + Math.cos(p.aimAngle) * LASER_LEN;
      _vf.y = mz + Math.sin(p.aimAngle) * LASER_LEN;
      const blocked = firstCoverHit(_vm, _vf, this.sim.obstacles);
      this.laserMesh.scale.x = blocked === null ? 1 : Math.max(0.05, blocked.t);
    }
    // Melee swing: while `swingT` runs, the FULL BODY plays the slice clip and the upper-body aim
    // layer is suppressed — a slice is a whole-body motion, and layering an aim pose on top of it
    // looks broken. The clip restarts on the `swingCount` EDGE, not every frame: `play()` ignores a
    // repeated name (see assets.ts), so re-calling it each frame would pin the animation at frame 0.
    const melee = weapon?.kind === 'melee';
    const swinging = melee && p.swingT > 0;
    if (!p.alive) {
      pc.play(P_ANIM.death);
    } else if (swinging) {
      if (p.swingCount !== this.lastSwing) {
        this.lastSwing = p.swingCount;
        // Alternate the clip with the sweep direction, so the body turns the way the blade goes.
        pc.play(p.swingDir === 1 ? P_ANIM.swingA : P_ANIM.swingB, 0.06, true);
      }
    } else if (pc.hasUpperBody) {
      // Legs keep moving from the locomotion clip; shooting is layered on the upper body.
      pc.play(p.moving ? P_ANIM.run : P_ANIM.idle);
    } else if (p.firing) {
      pc.play(P_ANIM.shoot);
    } else if (p.moving) {
      pc.play(P_ANIM.run);
    } else {
      pc.play(P_ANIM.idle);
    }
    pc.update(dt);
    // Layer the aiming pose on the upper body while firing (legs still animate from the clip).
    // Suppressed during a melee swing, which owns the whole body.
    const upperTarget = (p.alive && p.firing && !swinging) ? 1 : 0;
    this.playerUpper += (upperTarget - this.playerUpper) * Math.min(1, dt * 14);
    if (pc.hasUpperBody) pc.setUpperBlend(this.playerUpper, dt);
    pc.root.scale.setScalar(p.invuln > 0 ? 1 + Math.sin(this.frames * 0.6) * 0.08 : 1);

    // --- enemies ---
    // Visibility is evaluated ONCE per enemy here and cached, because three separate loops below
    // need it (the character, its aiming beam, its health bar) and a leak in ANY of them reveals
    // the enemy's position. Bars are the worst offender: they are depth-test false, so an ungated
    // one floats on top of the darkness and points straight at the enemy.
    if (this.enemyVis.length < sim.enemies.length) this.enemyVis = new Uint8Array(sim.enemies.length);
    for (let i = 0; i < sim.enemies.length; i++) {
      const e = sim.enemies[i];
      this.enemyVis[i] = this.visibleAt(e.pos.x, e.pos.y) ? 1 : 0;
    }
    for (let i = 0; i < sim.enemies.length; i++) {
      const e = sim.enemies[i];
      const v = this.enemyViews[i];
      const wasAlive = v.prevAlive;
      if (wasAlive && !e.alive) { v.dyingT = 0.9; v.char?.play(E_ANIM.death); }
      v.prevAlive = e.alive;
      if (v.dyingT > 0) v.dyingT -= dt;
      // The death animation is over: hand the character (and its ~1.8 MB of animation bindings) back
      // and never touch this view again — see releaseView. Checked BEFORE the visibility gate, because
      // a corpse that died out of sight must still be released.
      if (v.released) continue;
      if (!e.alive && v.dyingT <= 0) { this.releaseView(v); continue; }
      const char = v.char;
      if (!char) continue;   // defensive: a released view can never get here (guarded above)
      // A hidden enemy is hidden for its death animation too (and `visible = false` also removes it
      // from the shadow pass, so it cannot leak through a shadow on the floor either).
      const show = (e.alive || v.dyingT > 0) && this.enemyVis[i] === 1;
      char.root.visible = show;
      if (!show) continue;
      char.root.position.set(e.pos.x, 0, e.pos.y);
      char.root.rotation.y = MODEL_FORWARD_YAW - Math.atan2(p.pos.y - e.pos.y, p.pos.x - e.pos.x);
      if (e.alive) {
        const d = Math.hypot(p.pos.x - e.pos.x, p.pos.y - e.pos.y);
        const speed = Math.hypot(e.vel.x, e.vel.y);
        if (e.hitFlash > 0) char.play(E_ANIM.hit);
        else if (e.kind === 'gunner') {
          // Gunner states, in priority order. `aiming` is the sim's pre-burst telegraph and `firing`
          // is the burst itself, so the pose the player sees is literally the state that is about to
          // shoot / is shooting — a tell that cannot lie.
          // Deliberately NOT the melee `attack` clip: a gunner within arm's reach is still shooting.
          if (e.aiming) char.play(E_ANIM.aim);
          else if (e.firing) char.play(E_ANIM.shoot);
          else if (speed > 0.2) char.play(E_ANIM.walk);
          else char.play(E_ANIM.idle);
        } else if (d < e.r + p.r + 1.2) char.play(E_ANIM.attack);
        else char.play(e.kind === 'sprinter' ? E_ANIM.run : E_ANIM.walk);
        char.root.scale.setScalar(e.hitFlash > 0 ? 1.2 : 1);
        // Surface turns red on a hit and fades back to normal over CONFIG.hitFlashTime.
        // hitFlash counts down from CONFIG.hitFlashTime, so the ratio is a 1 -> 0 ramp.
        char.setHitFlash(e.hitFlash > 0 ? Math.min(1, e.hitFlash / CONFIG.hitFlashTime) : 0);
        // BURN GLOW: while an enemy burns it is tinted self-lit, proportional to its burn stacks
        // (see chartint.ts for the bug this fixes — unlit additive flames around a black silhouette
        // read as a bright fire ring with a hole in the middle, because nothing lit the body).
        char.setBurnGlow(burnGlowFor(e.burns.length, CONFIG.burnGlowStacks));
      } else {
        // The sim stops decrementing hitFlash once an enemy is dead, so without this a
        // corpse would stay fully red for the whole death animation. A corpse also stops glowing:
        // `resolveDeath` clears `burns`, and this keeps the last frame's glow from sticking.
        char.setHitFlash(0);
        char.setBurnGlow(0);
      }
      char.update(dt);
    }

    // --- gunner aim beams: the telegraph, one instanced quad per aiming enemy ---
    // Driven by the sim's `Enemy.aiming`, which is the PRE-BURST telegraph only (mid-burst the sim
    // clears it and the tracers do the talking), so the beam stays a warning rather than becoming a
    // permanent laser. Brightness ramps up across the telegraph, which turns the beam itself into a
    // countdown the player can read without watching the enemy.
    let beamN = 0;
    for (let i = 0; i < sim.enemies.length && beamN < MAX_AIM_BEAMS; i++) {
      const e = sim.enemies[i];
      if (!e.alive || !e.aiming) continue;
      // MUST be gated: a gunner can have line of sight to the player while sitting outside the
      // player's own vision (behind the camera cone), and an ungated beam would point at an enemy
      // the player cannot see — the same leak the health bars had to be gated for.
      if (this.enemyVis[i] !== 1) continue;
      const dx = p.pos.x - e.pos.x;
      const dz = p.pos.y - e.pos.y;
      const dist = Math.hypot(dx, dz);
      if (dist < 1e-3) continue;
      const a = Math.atan2(dz, dx);
      const off = e.r + 0.3;                       // start at the muzzle, not inside the body
      const len = Math.max(0.2, dist - off);
      // local +X maps to world (cos a, 0, sin a) under rotation.y = -a — the laser's convention.
      _bq.setFromAxisAngle(_by, -a);
      _bp.set(e.pos.x + Math.cos(a) * off, AIM_BEAM_Y, e.pos.y + Math.sin(a) * off);
      _bs.set(len, 1, AIM_BEAM_WIDTH);
      _bm.compose(_bp, _bq, _bs);
      this.aimBeamMesh.setMatrixAt(beamN, _bm);
      const ramp = 1 - Math.max(0, e.fireT) / Math.max(1e-6, CONFIG.gunnerAimTime);
      _pc.setHex(ENEMY_BULLET_COLOR).multiplyScalar(0.35 + 0.65 * ramp);
      this.aimBeamMesh.setColorAt(beamN, _pc);
      beamN++;
    }
    this.aimBeamMesh.count = beamN;
    this.aimBeamMesh.instanceMatrix.needsUpdate = true;
    if (this.aimBeamMesh.instanceColor) this.aimBeamMesh.instanceColor.needsUpdate = true;

    // --- projectiles: core + glow InstancedMesh (2 draw calls) + capped point-light pool ---
    // The look of each projectile comes from `b.def.visual`, so a new ammo type needs no
    // renderer change: colour via instanceColor, size via per-instance scale, light via the
    // capped pool. N ammo types in flight still cost the same 2 draw calls.
    const bulletArr = sim.bullets;
    let n = 0;
    for (let i = 0; i < bulletArr.length && n < MAX_BULLETS; i++) {
      const b = bulletArr[i];
      if (!b.alive) continue;
      if (!this.visibleAt(b.pos.x, b.pos.y)) continue;
      const vis = b.def.visual;
      _bq.setFromAxisAngle(_by, Math.atan2(b.vel.x, b.vel.y));
      _bp.set(b.pos.x, 0.35, b.pos.y);
      _bs.set(vis.size[0], vis.size[1], vis.size[2]);
      _bm.compose(_bp, _bq, _bs);
      this.bulletMesh.setMatrixAt(n, _bm);
      _pc.setHex(vis.color);
      this.bulletMesh.setColorAt(n, _pc);
      _bs.set(vis.size[0] * vis.glowScale[0], vis.size[1] * vis.glowScale[1], vis.size[2] * vis.glowScale[2]);
      _bm.compose(_bp, _bq, _bs);
      this.bulletGlowMesh.setMatrixAt(n, _bm);
      _pc.setHex(vis.glowColor);
      this.bulletGlowMesh.setColorAt(n, _pc);
      n++;
    }
    this.bulletMesh.count = n;
    this.bulletMesh.instanceMatrix.needsUpdate = true;
    if (this.bulletMesh.instanceColor) this.bulletMesh.instanceColor.needsUpdate = true;
    this.bulletGlowMesh.count = n;
    this.bulletGlowMesh.instanceMatrix.needsUpdate = true;
    if (this.bulletGlowMesh.instanceColor) this.bulletGlowMesh.instanceColor.needsUpdate = true;
    // --- the dynamic point-light pool: transient lights FIRST, then the projectiles ---
    // ONE pool for everything (BULLET_LIGHTS slots, per-fragment cost). Sharing rather than growing
    // it is the right call because a transient light is a 0.05-0.5s EVENT that needs one slot, and
    // the number of lights in the scene is part of three's shader program key (another pool would
    // mean another program variant, not just a slightly slower frame).
    //
    // PRIORITY: newest first. That single rule covers both producers — a shot's muzzle light, and the
    // explosion light of a rocket fired a moment earlier, which is deliberately newer (it happens
    // later) and therefore wins the slot while both are alive. A projectile that loses its slot for
    // those frames still draws its glow sheath, and only the most recent bullets ever had a light
    // anyway. At the SMG's 10 shots/s one slot is the muzzle light about half the time, so the pool
    // effectively holds 7 projectile lights while firing it.
    let li = 0;
    const fxs = sim.fxLights;
    for (let i = fxs.length - 1; i >= 0 && li < BULLET_LIGHTS; i--) {
      const fx = fxs[i];
      // A muzzle light sits slightly AHEAD of the barrel (FxLight.forward): a point light 0.8 units
      // from the shooter saturates the toon ramp on the player's own body, which at 10 shots/second
      // is a strobe on your own character. An explosion passes 0 and sits exactly on the blast.
      const lx = fx.x + fx.dx * fx.forward;
      const lz = fx.z + fx.dz * fx.forward;
      // Same leak rule as the projectile lights: a light in the occluded region would brighten the
      // darkness that is supposed to hide it.
      if (!this.visibleAt(lx, lz)) continue;
      const l = this.lightPool[li++];
      l.visible = true;
      l.position.set(lx, fx.y, lz);
      l.color.setHex(fx.color);
      // Decayed by the shared curve, NOT by a per-frame value the sim would have to store: the entry
      // carries only `t`, so a light and the effect that spawned it cannot desync.
      l.intensity = fx.intensity * fxLightScale(fx.t, fx.max, fx.falloff);
      l.distance = fx.distance;
    }
    // Cap real point lights to the most recent projectiles (per-fragment lighting cost).
    for (let i = bulletArr.length - 1; i >= 0 && li < BULLET_LIGHTS; i--) {
      const b = bulletArr[i];
      if (!b.alive) continue;
      // A hidden round must not light the dark region up: the point light is part of the leak
      // surface, not a cosmetic extra.
      if (!this.visibleAt(b.pos.x, b.pos.y)) continue;
      const vis = b.def.visual;
      const l = this.lightPool[li++];
      l.visible = true;
      l.position.set(b.pos.x, 0.5, b.pos.y);
      l.color.setHex(vis.lightColor);
      l.intensity = vis.lightIntensity;
      l.distance = vis.lightDistance;
    }
    for (; li < BULLET_LIGHTS; li++) this.lightPool[li].visible = false;
    // --- camera follow + shake + recoil ---
    const shake = sim.shake;
    const sx = (Math.random() - 0.5) * shake * 2;
    const sz = (Math.random() - 0.5) * shake * 2;
    // Recoil (weapons.ts kicks it on every shot): a decaying world-space offset applied as a PURE
    // TRANSLATION — the camera and its look-at target move together, so the frame shifts by exactly
    // that many world units instead of tilting. It is added to the same lateral axes the shake uses,
    // which is what makes it visible under an orthographic camera (moving an ortho camera along its
    // view axis would change nothing at all). The pixelation snap runs afterwards, so the kick lands on
    // whole blocks like every other camera move.
    const rx = sim.recoilX;
    const rz = sim.recoilZ;
    // camScale / camYaw = user settings (the pose), camZoom = viewport-height dolly (frustum only).
    // `cameraEye` is the single definition of where the camera sits: yaw 0 gives the (0, height, back)
    // offset this renderer hardcoded, and any other yaw orbits that pose around the player. The shake
    // offsets stay on the world axes (they are a screen-space wobble of the whole view either way).
    const eye = cameraEye(this.camScale, this.camYaw);
    // camZoom is NOT applied to the pose any more — it lives in the frustum (updateOrthoFrustum).
    this.camera.position.set(
      p.pos.x + eye[0] + sx + rx, eye[1], p.pos.y + eye[2] + sz + rz,
    );
    // The shake only tilts (half of its offset in the target), while the recoil is applied to BOTH ends
    // in full — that difference is exactly "rattle" vs "shove".
    this.camera.lookAt(p.pos.x + sx * 0.5 + rx, 0, p.pos.y + sz * 0.5 + rz);
    this.camera.updateMatrixWorld();
    this.snapCameraToPixelGrid();
    this.syncVignette();
    // Key light: re-fit its shadow box to what this camera can see, snapped to whole texels (see
    // src/shadow.ts for why both parts matter — they are the noise and the crawl fixes). The light's
    // DIRECTION never changes, so no shading angle does; only the box moves.
    this.updateShadowFit(p.pos.x, p.pos.y);

    // --- particles: two InstancedMeshes (additive fire/sparks + normal-blended smoke/debris) ---
    // Shapes:
    //   * streaks (puff=false): thin boxes stretched along the 3D velocity (see streak.ts);
    //   * puffs   (puff=true):  billboards facing the camera. Burn flames use aspect 0.55 (a
    //     narrow tongue) and shimmer with the SAME noise field that swirls them (noise2);
    //     explosion fireball/smoke use aspect ~1 so they read as round blobs.
    // `solid` picks the pool (see Particle.solid). Must run AFTER the camera update above,
    // otherwise the billboards lag one frame behind the camera.
    const parts = sim.particles;
    let pn = 0;   // additive pool cursor
    let sn = 0;   // normal-blended pool cursor
    for (let i = 0; i < parts.length; i++) {
      const pt = parts[i];
      const solid = pt.solid;
      if (solid ? sn >= MAX_SOLID_PARTICLES : pn >= MAX_PARTICLES) continue;
      // Particles fade OUT across the soft edge instead of switching off, because they have no
      // gameplay meaning (so the cost of a hard cut is pure popping) — and because the query is a
      // binary search on the same sector table, not a per-particle segment test against 20 boxes.
      // This is also what stops a death burst behind cover from announcing where an enemy died.
      const vf = this.visionOn ? visionFadeAt(this.visionField, pt.pos.x, pt.pos.y, VISION_FADE) : 1;
      if (vf <= 0) continue;
      const fade = pt.life / pt.max;                    // 1 -> 0
      const W = Math.max(0.02, pt.size * (0.5 + 0.5 * fade));
      if (pt.puff) {
        // X/Y are the billboard's screen axes; aspect < 1 is narrower than tall.
        _pq.copy(this.camera.quaternion);
        _pp.set(pt.pos.x, pt.y, pt.pos.y);
        _ps.set(W * pt.aspect, W, W);
        _bm.compose(_pp, _pq, _ps);
        const flicker = 0.55 + 0.5 * noise2(pt.pos.x * 2.2, pt.pos.y * 2.2, sim.time * 2.6 + pt.flick);
        _pc.setHex(parseInt(pt.color.slice(1), 16)).multiplyScalar(flicker);
      } else {
        // 3D speed so a rising particle would stretch correctly; identical to the old 2D speed
        // for ground sparks (vy = 0).
        const sp = Math.hypot(pt.vel.x, pt.vel.y, pt.vy);
        const stretch = 0.6 + Math.min(1.9, sp * 0.045);  // longer when moving fast
        const L = Math.max(0.06, pt.len * stretch * (0.35 + 0.65 * fade));
        // Orient the box's length axis along the full 3D velocity. With vy = 0 this is exactly
        // the previous yaw-only rotation — see streak.ts.
        const q = streakQuaternion(pt.vel.x, pt.vy, pt.vel.y);
        _pq.set(q[0], q[1], q[2], q[3]);
        _pp.set(pt.pos.x, pt.y, pt.pos.y);
        _ps.set(W, W, L);
        _bm.compose(_pp, _pq, _ps);
        _pc.setHex(parseInt(pt.color.slice(1), 16));
      }
      if (vf < 1) _pc.multiplyScalar(vf);
      const mesh = solid ? this.solidMesh : this.particleMesh;
      const slot = solid ? sn : pn;
      mesh.setMatrixAt(slot, _bm);
      mesh.setColorAt(slot, _pc);
      if (solid) sn++; else pn++;
    }
    this.particleMesh.count = pn;
    this.particleMesh.instanceMatrix.needsUpdate = true;
    if (this.particleMesh.instanceColor) this.particleMesh.instanceColor.needsUpdate = true;
    this.solidMesh.count = sn;
    this.solidMesh.instanceMatrix.needsUpdate = true;
    if (this.solidMesh.instanceColor) this.solidMesh.instanceColor.needsUpdate = true;

    // --- melee crescents: ONE InstancedMesh, two instances per live swing ---
    // A pure replay of slash.ts: the leading edge comes from `slashAngle`, brightness from
    // `slashAlpha`, radius from `slashRadiusScale` (which stops at exactly 1.0, so the blade edge
    // lands on the weapon's reach and never claims range the hit test did not grant). The sweep
    // direction is already baked into the angle, so alternating swings visibly travel opposite ways.
    const slashes = sim.slashes;
    let sn2 = 0;
    for (let i = 0; i < slashes.length && sn2 + 1 < MAX_SLASH_INSTANCES; i++) {
      const s = slashes[i];
      const alpha = slashAlpha(s);
      if (alpha <= 0.002) continue;              // fully faded: skip rather than draw black
      const r = s.reach * slashRadiusScale(s);
      // local +X maps to world (cos a, 0, sin a) under rotation.y = -a — same convention as the
      // aiming line above.
      _bq.setFromAxisAngle(_by, -slashAngle(s));
      _bp.set(s.x, SLASH_Y, s.z);
      for (let pass = 0; pass < 2; pass++) {
        const k = pass === 0 ? SLASH_CORE_SCALE : SLASH_GLOW_SCALE;
        _bs.set(r * k, 1, r * k);
        _bm.compose(_bp, _bq, _bs);
        this.slashMesh.setMatrixAt(sn2, _bm);
        // Core = white tint so the baked vertex envelope does all the shaping; glow = the UI accent
        // cyan, dimmed. Both are multiplied by the fade, which is the whole opacity story.
        if (pass === 0) _pc.setHex(0xffffff).multiplyScalar(alpha);
        else _pc.setHex(parseInt(SLASH_GLOW_COLOR.slice(1), 16)).multiplyScalar(alpha * SLASH_GLOW_DIM);
        this.slashMesh.setColorAt(sn2, _pc);
        sn2++;
      }
    }
    this.slashMesh.count = sn2;
    this.slashMesh.instanceMatrix.needsUpdate = true;
    if (this.slashMesh.instanceColor) this.slashMesh.instanceColor.needsUpdate = true;

    // --- enemy health bars (+ armour strips) + the player's reload bar (2 draw calls total) ---
    // Must run AFTER the camera update above so `camera.quaternion` holds this frame's
    // orientation; the bars are screen-aligned billboards (they copy the camera's rotation
    // rather than each turning to face the camera individually — cheaper and stable).
    //
    // EVERY bar takes its slot from the allocator, one `next()` per bar. That is what keeps the
    // armour strip from reusing the health bar's FRAME index (the bug that cost the health bar its
    // dark background) and it is asserted in Node — see hud.ts::createBarAllocator.
    _right.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const bars = createBarAllocator(MAX_BAR_SLOTS);
    let drawn = 0;
    for (let i = 0; i < sim.enemies.length && drawn < MAX_ENEMY_BARS; i++) {
      const e = sim.enemies[i];
      if (!e.alive) continue;                       // dying enemies drop their bar at once
      if (this.enemyVis[i] !== 1) continue;         // …and so do enemies behind cover
      if (!bars.next()) break;                      // pools full: stop drawing, never wrap around
      const ratio = e.maxHp > 0 ? Math.max(0, Math.min(1, e.hp / e.maxHp)) : 0;
      this.writeBarFrame(bars.frame, e.pos.x, e.pos.y, BAR_Y);
      this.writeBarFill(bars.fill, e.pos.x, e.pos.y, BAR_Y, ratio, barFillColor(ratio));
      // Armour strip: same width, thinner, just above the health bar, COLOURED BY THE PLATE'S LEVEL
      // (1 white .. 6 red) and filled by its remaining value. Gated by the same vision flag as the
      // health bar — a plate bar floating over the darkness would point straight at a hidden enemy.
      if (e.armor && e.armor.value > 0 && bars.next()) {
        const ar = armorRatio(e.armor);
        this.writeBarFrame(bars.frame, e.pos.x, e.pos.y, ARMOR_BAR_Y, BAR_W, ARMOR_BAR_H);
        this.writeBarFill(bars.fill, e.pos.x, e.pos.y, ARMOR_BAR_Y, ar, levelColorInt(e.armor.level), BAR_W, ARMOR_BAR_H);
      }
      drawn++;
    }
    // --- the PLAYER's head bars: health, armour strip, then reload (same pool, no extra draw call) --
    // The plate lives in the armour SLOT of the backpack, so chipping it in the damage path shows up
    // here with no extra plumbing. All three are gated on `p.alive`: a corpse with a full health bar
    // would read as "still in the fight", and `reloadTimer` freezes on death (update() returns early
    // once `sim.over`), so without the gate a body would keep a permanently half-full reload bar.
    const plate = sim.inventory.slots.armor;
    if (p.alive) {
      const hpRatio = p.maxHp > 0 ? Math.max(0, Math.min(1, p.hp / p.maxHp)) : 0;
      if (bars.next()) {
        this.writeBarFrame(bars.frame, p.pos.x, p.pos.y, PLAYER_BAR_Y, PLAYER_BAR_W);
        this.writeBarFill(bars.fill, p.pos.x, p.pos.y, PLAYER_BAR_Y, hpRatio, barFillColor(hpRatio), PLAYER_BAR_W);
      }
      // Armour strip, COLOURED BY THE PLATE'S LEVEL (1 white .. 6 red) exactly like the enemy one.
      // Drawn whenever a plate is EQUIPPED, including at 0 value — a deliberate difference from the
      // enemy rule (`value > 0`): this bar is the only armour readout in the game now (the top-left
      // chip is gone), so "plate shot empty" must be distinguishable from "no plate at all". The
      // empty frame is that distinction; the colour of the fill is the level, never a health colour.
      if (plate && plate.kind === 'armor' && bars.next()) {
        this.writeBarFrame(bars.frame, p.pos.x, p.pos.y, PLAYER_ARMOR_BAR_Y, PLAYER_BAR_W, ARMOR_BAR_H);
        this.writeBarFill(bars.fill, p.pos.x, p.pos.y, PLAYER_ARMOR_BAR_Y, armorRatio(plate),
          levelColorInt(plate.level), PLAYER_BAR_W, ARMOR_BAR_H);
      }
      if (p.reloadTimer > 0 && bars.next()) {
        this.writeBarFrame(bars.frame, p.pos.x, p.pos.y, PLAYER_RELOAD_BAR_Y, PLAYER_BAR_W);
        this.writeBarFill(bars.fill, p.pos.x, p.pos.y, PLAYER_RELOAD_BAR_Y,
          reloadBarProgress(p.reloadTimer, p.reloadTotal), RELOAD_BAR_COLOR, PLAYER_BAR_W);
      }
    }
    // `bars.frame` / `bars.fill` are -1 when nothing was drawn, so +1 is the instance count.
    const barCount = bars.fill + 1;
    this.barBgMesh.count = barCount;
    this.barBgMesh.instanceMatrix.needsUpdate = true;
    this.barFillMesh.count = barCount;
    this.barFillMesh.instanceMatrix.needsUpdate = true;
    if (this.barFillMesh.instanceColor) this.barFillMesh.instanceColor.needsUpdate = true;

    // --- HUD ---
    // No health/armour DOM writes here on purpose: both are WORLD-SPACE bars above the character's
    // head now (the block above), so the top-left corner only carries the wave counter. One readout
    // per fact — a second copy in the DOM is what would eventually disagree with the head bar.
    this.waveEl.textContent = '第 ' + sim.wave + ' 波';
    this.scoreEl.textContent = String(sim.score);
    // Weapon + magazine + backpack reserve. All of it is derived from sim state, so switching
    // weapons (or dragging a different one into a slot) needs no HUD code: the name, the count,
    // the reserve and the reload bar all follow the inventory.
    // The WEAPON BUTTON is the primary/secondary switch and nothing else; it is hidden while both
    // weapon slots are empty and dimmed when there is no second weapon to switch to.
    const w = sim.activeWeapon();
    const equipped = sim.inventory.slots[sim.inventory.activeSlot];
    const name = w ? w.name : '空手';
    if (this.hudWeapon !== name) {
      this.hudWeapon = name;
      this.weaponBtnEl.textContent = name;
    }
    this.weaponBtnEl.classList.toggle('hidden', !w);
    this.weaponBtnEl.classList.toggle('solo', !!w && !isWeaponItem(sim.inventory.slots[
      sim.inventory.activeSlot === 'primary' ? 'secondary' : 'primary'
    ]));
    const hud = ammoReadout(
      p.ammo, w ? magSizeOf(w) : 0, p.reloadTimer, p.reloadTotal,
      w ? sim.reserveOf(ammoIdOf(w)) : 0, itemLevel(equipped),
    );
    if (this.hudAmmo !== hud.text) {
      this.hudAmmo = hud.text;
      this.ammoCountEl.textContent = hud.text;
    }
    this.ammoFillEl.style.width = hud.ratio * 100 + '%';
    this.ammoEl.classList.toggle('reloading', hud.reloading);
    // Ammo level badge — the SAME colour language as the armour strip, so "green vs blue" reads as
    // "level 2 vs level 3" everywhere in the HUD.
    this.ammoLevelEl.classList.toggle('hidden', hud.level === null);
    if (hud.level !== null) {
      const lvText = 'Lv' + hud.level;
      if (this.hudLevel !== lvText) {
        this.hudLevel = lvText;
        this.ammoLevelEl.textContent = lvText;
      }
      const lvColor = levelColorHex(hud.level);
      if (this.hudLevelColor !== lvColor) {
        this.hudLevelColor = lvColor;
        this.ammoLevelEl.style.color = lvColor;
        this.ammoLevelEl.style.borderColor = lvColor;
      }
    }
    // Throwable / healing buttons: shown only while their slot holds something (user requirement),
    // dimmed while on cooldown. `actionButtonReadout` owns that rule (pure, asserted in Node).
    this.hudThrow = this.syncActionButton(this.throwBtnEl, sim.inventory.slots.throwable, p.throwCd, this.hudThrow);
    this.hudHeal = this.syncActionButton(this.healBtnEl, sim.inventory.slots.healing, p.healCd, this.hudHeal);
    // FPS badge (top-right). Measured from the real clock, NOT from the `dt` argument:
    // main.ts clamps dt to 0.05s, so a dt-based average would silently floor at 20 FPS and
    // never report anything lower. Averaged over ~0.5s so the number is readable.
    const nowMs = performance.now();
    if (this.fpsLastMs === 0) {
      this.fpsLastMs = nowMs;   // the very first frame only anchors the window (it has no
    } else {                    // elapsed time yet, so counting it would bias the first sample)
      this.fpsFrames++;
      const span = nowMs - this.fpsLastMs;
      if (span >= 500) {
        this.fpsEl.textContent = Math.round((this.fpsFrames * 1000) / span) + ' FPS';
        this.fpsFrames = 0;
        this.fpsLastMs = nowMs;
      }
    }
    this.frames++;
  }

  /**
   * Draw one frame. With the 「像素化」 pass enabled the scene goes into the small target first and then
   * a fullscreen quad blits it to the canvas (NEAREST, so one target texel = one block of canvas
   * pixels); with the pass off this is a plain single-pass render, i.e. exactly what shipped before.
   */
  render(): void {
    if (!this.pixelTargetRT) {
      this.scene.background = this.bgOnScreen;
      this.renderer.render(this.scene, this.camera);
      return;
    }
    // The target is DISPLAY-REFERRED (postfx.ts::DISPLAY_REFERRED_COLORSPACE_CHUNK), so the clear
    // colour has to be display bytes too — a colour background is a raw clear and never runs a shader.
    this.scene.background = this.bgDisplay;
    this.renderer.setRenderTarget(this.pixelTargetRT);
    this.renderer.render(this.scene, this.camera);
    this.scene.background = this.bgOnScreen;
    this.renderer.setRenderTarget(null);
    // The blit is a plain copy now: the scene pass already wrote display values, and the target is a
    // plain (non-sRGB) texture, so any conversion here would double-encode the frame.
    this.pixelMaterial.uniforms.tPixelScene.value = this.pixelTargetRT.texture;
    this.renderer.render(this.pixelScene, this.pixelCamera);
  }

  reset(): void {
    for (const v of this.enemyViews) this.releaseView(v);
    this.enemyViews = [];
    this.bulletMesh.count = 0;
    this.bulletGlowMesh.count = 0;
    this.particleMesh.count = 0;
    this.solidMesh.count = 0;
    this.slashMesh.count = 0;
    this.barBgMesh.count = 0;
    this.barFillMesh.count = 0;
    this.laserMesh.visible = false;
    this.laserMesh.scale.x = 1;
    // Vision is per-frame state: drop the mask and put cover back on its palette (the user's
    // 「遮挡变暗」 setting is NOT reset — that is a setting, not a round of play).
    this.enemyVis.fill(0);
    this.visionMesh.visible = false;
    if (this.visionOn) {
      this.coverDim.fill(0);
      this.restoreCover();
    }
    // The sim's swingCount restarts at 0 on reset, so the renderer's edge tracker must too —
    // otherwise the first swing of the next run would look like "no change" and play no clip.
    this.lastSwing = 0;
    this.playerUpper = 0;
    for (const l of this.lightPool) l.visible = false;
  }
}
