// 画面调性（tone）的纯模型 + 度量：光照 → toon 台阶 → 高度雾 → 调色 → sRGB 输出，
// 以及基于它的对比度/色相/可辨识度指标。
//
// WHY THIS EXISTS
// ---------------
// This project has no browser and no GPU, so "how does it look" has never been measurable — every art
// decision so far (floor grey, ambient light, fog) was made from real-device feedback AFTER shipping.
// The renderer is a fixed, small pipeline (three directional/hemisphere lights -> MeshToonMaterial's
// 4-step ramp -> fog -> output), so the *displayed* colour of a known surface is computable in Node.
// This module is that computation, and scripts/analyze-tone.mjs is the report. It replaces
// "screenshot and eyeball" with numbers for: luminance contrast, dominant-colour share, hue spread,
// and the perceptual separation (CIE Lab dE) of the gameplay-critical pairs.
//
// WHAT IT CANNOT SEE (be honest, do not over-claim):
//   * screen-space composition, silhouettes, motion, UI overlap — there is no rasteriser here;
//   * shadows (the key light's shadow map is ignored: every sample is treated as lit);
//   * the bullet point lights are NOT part of a tone baseline (a transient signal, not a look — adding
//     them to the SURFACES statistics would make the palette depend on whether a gun happened to be
//     firing). They are modelled on request instead, through `ShadeOptions.lights`, because the hue
//     they put on the floor is a correctness question and not only an art one (see TRANSIENT_LIGHTS);
//   * the character MESH texture's per-pixel detail — the character samples below use the dominant
//     colours measured from the atlas (documented per sample), not a per-pixel average;
//   * the toon ramp's `fwidth` smoothing (this uses the NearestFilter texel lookup the shared gradient
//     map actually performs — see rampStep()).
// It is a palette/lighting model, not a screenshot. Its value is that it is EXACT about the things it
// does model, so a change that is supposed to raise contrast or separate two gameplay reads can be
// proven to do so (or caught regressing) without a device.
//
// THE PIPELINE IT MIRRORS (three r160, vendored):
//   direct:   irradiance = rampLookup(dot(N, L)) * lightColor * intensity
//   transient: irradiance = rampLookup(dot(N, L)) * lightColor * intensity / distance^2   (point lights)
//   indirect: irradiance = hemisphere(sky, ground, N) * intensity   (NOT ramp-banded — see lighting.ts)
//   diffuse:  reflected = irradiance * BRDF_Lambert(albedo) = irradiance * albedo / PI
//   output:   linearToOutputTexel()  == sRGB encode (renderer.toneMapping is NoToneMapping: the
//             pipeline has NO tone mapping, so values above 1 clip channel-wise — that is exactly why
//             the additive bullets had to be red-dominant, and why the grade below works in output
//             space where clipping has already happened)
//
// ⚠️ TWO EX-CAVEATS, both now FIXED — this model describes BOTH render paths. They were the two
// halves of one incident (「龙息弹/RPG 的红光照到别的地方发绿」), and an earlier version of this note
// got the emphasis wrong: it blamed the post-processing pass for a defect that reproduced with the
// pass off, and it claimed the only residual difference was additive saturation.
//
//   1. FIXED — the grade's input domain. `linearToOutputTexel()` does not clamp, so this model's
//      `Math.min(1, ...)` at the encode was doing something the shader did NOT do: the shader fed the
//      grade super-white values and only clipped at the framebuffer. The model was therefore MORE
//      forgiving than the renderer, and it hid a real defect for as long as it existed — the lesson
//      (「a model that clamps where the renderer does not is a model that lies for it») is written up
//      in docs/TECHNICAL.md. The encode below deliberately does NOT clamp any more: the displayable
//      clamp happens once, at the END, exactly where the framebuffer and grade.ts apply it.
//
//   2. FIXED — the space the world look runs in. With the 「像素化」 pass on, the scene is composited
//      inside a render target and three forces a non-XR render target's output space to LINEAR, so the
//      fog mix and the grade used to run on linear values while the canvas path ran them on encoded
//      ones (postfx.ts's header has the full story, including the missing-conversion bug that made
//      every colour wrong until it was fixed). worldlook.ts now injects the whole look on the LEFT of
//      `#include <colorspace_fragment>` inside an explicit `LinearTosRGB -> look -> sRGB EOTF` wrap, so
//      display-space is display-space on both paths and this model — which has always modelled the
//      canvas path — describes the render-target path too.
//
// There is NO colour residual left between the two paths: the offscreen pass is display-referred too
// (postfx.ts::DISPLAY_REFERRED_COLORSPACE_CHUNK), so the vignette's multiply, the vision darkness and
// every additive glow composite in exactly the space this model assumes. Before that override they did
// not: with the reporter's settings the vignetted corners came out 32-62% brighter offscreen and a
// tracer up to 74/255 off — which is what 「像素化后颜色都变亮了」 was. verify-postfx.mjs asserts both
// the equality (now) and that regression (the guard).
import {
  AMBIENT_GROUND_COLOR, AMBIENT_SKY_COLOR, DIR_KEY_INTENSITY, DIR_WARM_INTENSITY, ambientIntensity,
} from './lighting.js';
import { fogFactor } from './fog.js';
import { gradeDisplay } from './grade.js';
import { LIGHT_OFFSET } from './shadow.js';

export const RECIPROCAL_PI = 1 / Math.PI;

/** The toon gradient map's 4-step ramp (the SINGLE source: toon.ts builds its DataTexture from this). */
export const TOON_RAMP: readonly number[] = [0.32, 0.55, 0.75, 0.95];

/**
 * `getGradientIrradiance()` with the shared NearestFilter gradient map: three samples it at
 * `dotNL * 0.5 + 0.5` in the 0..1 range of a 4-texel row, so the texel index is
 * `clamp(floor(coord * 4), 0, 3)` — note that a face perpendicular to the light (dotNL = 0) lands on
 * texel 2 (0.75), which is why toon scenes stay readable on the unlit side by default.
 */
export function rampStep(dotNL: number): number {
  const coord = dotNL * 0.5 + 0.5;
  const idx = Math.min(TOON_RAMP.length - 1, Math.max(0, Math.floor(coord * TOON_RAMP.length)));
  return TOON_RAMP[idx];
}

/** sRGB (0..1) -> linear. three does this for every material colour at construction time. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
/** linear -> sRGB (0..1). This is `linearToOutputTexel()` with SRGBColorSpace. */
export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}
/** 0xRRGGBB (an sRGB value as authored in code) -> linear triple. */
export function hexToLinear(hex: number): RGB {
  return [
    srgbToLinear(((hex >> 16) & 0xff) / 255),
    srgbToLinear(((hex >> 8) & 0xff) / 255),
    srgbToLinear((hex & 0xff) / 255),
  ];
}
/** linear triple -> 0xRRGGBB (for reporting what a sample looks like on screen). */
export function linearToHex(linear: RGB): number {
  const b = linear.map((c) => Math.round(Math.min(1, Math.max(0, linearToSrgb(c))) * 255));
  return (b[0] << 16) | (b[1] << 8) | b[2];
}

export type RGB = [number, number, number];

const norm = (v: RGB): RGB => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
/** The key light's direction as a unit vector (the renderer puts the light at LIGHT_OFFSET). */
export const KEY_DIR: RGB = norm([LIGHT_OFFSET[0], LIGHT_OFFSET[1], LIGHT_OFFSET[2]]);
/** The warm fill's direction (render.ts::addLights hardcodes this position). */
export const WARM_DIR: RGB = norm([-16, 12, -14]);
/** The warm fill's colour (render.ts::addLights). */
export const WARM_COLOR = 0xffc890;

export interface SurfaceSample {
  id: string;
  /** What this is, for the report. */
  label: string;
  /** Which gameplay read it belongs to: 'world' surfaces are the environment, 'actor' are characters
   *  (the pairs the readability metric separates are always world vs actor), 'signal' is effects. */
  role: 'world' | 'actor' | 'signal';
  /** Albedo, LINEAR (see the provenance note per entry). */
  albedo: RGB;
  /** World-space normal. */
  normal: RGB;
  /** Relative screen importance for the area-weighted statistics. */
  weight: number;
  /** Approximate distance from the camera (world units) for the fog term. */
  distance: number;
  /** Approximate height above the floor for the fog term. */
  height: number;
  /** How the albedo was obtained — this is a research artifact, so it must say where the number is from. */
  provenance: string;
}

/**
 * The measured scene palette. Every entry is a real value from the shipping code or from decoding the
 * assets; nothing here is invented. Frozen by verify-tone.mjs (albedos, weights, roles).
 */
export const SURFACES: readonly SurfaceSample[] = [
  {
    id: 'floor', label: '地砖（主题覆盖灰）', role: 'world',
    albedo: hexToLinear(0x83878b), normal: [0, 1, 0], weight: 0.46, distance: 26, height: 0,
    provenance: 'props.ts::FLOOR_TINT (the only PropDef.tint in the kit)',
  },
  {
    id: 'floor-near', label: '地砖（近处，雾更少）', role: 'world',
    albedo: hexToLinear(0x83878b), normal: [0, 1, 0], weight: 0.14, distance: 14, height: 0,
    provenance: 'same albedo, nearer camera — the fog term is the only difference',
  },
  {
    id: 'wall', label: '墙（Kenney wood 材质）', role: 'world',
    albedo: [0.90, 0.60, 0.39], normal: [-0.7, 0, -0.71], weight: 0.14, distance: 34, height: 1.5,
    provenance: 'the kit shares one `wood` material: baseColorFactor 0.90/0.60/0.39 (LINEAR, glTF)',
  },
  {
    id: 'cover-top', label: '掩体家具顶面（wood）', role: 'world',
    albedo: [0.90, 0.60, 0.39], normal: [0, 1, 0], weight: 0.13, distance: 24, height: 0.9,
    provenance: 'same wood material, seen from above (the player looks at furniture tops)',
  },
  {
    id: 'cover-side', label: '掩体家具侧面（wood, 背光）', role: 'world',
    albedo: [0.90, 0.60, 0.39], normal: [0.35, 0, -0.94], weight: 0.07, distance: 24, height: 0.6,
    provenance: 'same wood material, normal turned away from the key light',
  },
  {
    id: 'void', label: '房间外的近黑包围地板', role: 'world',
    albedo: hexToLinear(0x11161d), normal: [0, 1, 0], weight: 0.03, distance: 55, height: 0,
    provenance: 'render.ts::addGround colour',
  },
  {
    id: 'player', label: '玩家（skeleton_warrior 贴图主色）', role: 'actor',
    albedo: hexToLinear(0xb37152), normal: [0, 1, 0], weight: 0.012, distance: 24, height: 1.0,
    provenance: 'decoded from skeleton_warrior.glb atlas (2nd dominant cluster, 3.0% of texels)',
  },
  {
    id: 'enemy-gunner', label: '敌人·枪手（skeleton_minion 贴图主色）', role: 'actor',
    albedo: hexToLinear(0x9c5b45), normal: [0, 1, 0], weight: 0.012, distance: 30, height: 1.0,
    provenance: 'decoded from skeleton_minion.glb atlas (dominant cluster, 3.6% of texels)',
  },
  {
    id: 'enemy-rusher', label: '敌人·近战（minion 贴图，冲锋时一样）', role: 'actor',
    albedo: hexToLinear(0x9c5b45), normal: [0, 1, 0], weight: 0.008, distance: 22, height: 1.0,
    provenance: 'same model/atlas as the gunner — the roles differ by silhouette, not by colour',
  },
  {
    id: 'char-accent', label: '角色身上的黄色配件（贴图第三簇）', role: 'actor',
    albedo: hexToLinear(0xffd523), normal: [0, 1, 0], weight: 0.003, distance: 26, height: 1.2,
    provenance: 'decoded from both atlases (0.9% of texels) — the only saturated warm accent',
  },
  {
    id: 'tracer', label: '曳光弹 / 火焰（自发光，加色）', role: 'signal',
    albedo: hexToLinear(0xff7a00), normal: [0, 1, 0], weight: 0.002, distance: 22, height: 0.8,
    provenance: 'projectiles.ts visuals (unlit/additive — shown here at face value, not shaded)',
  },
];

// ---------------------------------------------------------------------------
// transient point lights (muzzle flashes, projectiles, explosions)
// ---------------------------------------------------------------------------
// These are the lights that made 「龙息弹/RPG 的红光照到别的地方发绿」 visible, so they belong in the
// model: a point light that sits ~0.5 units above the floor drives the surface it lights FAR out of
// gamut (the pellet's light puts the floor at ~2.9 in linear), and everything downstream of that —
// the encode, the fog, the grade — was written assuming a displayable value. The model has to be able
// to produce those numbers, or the failure they cause cannot be asserted in Node.
//
// The light is exactly three's: `intensity / max(distance^decay, 0.01)` (getDistanceAttenuation, decay
// 2 in render.ts, ignoring the cutoff window which is ~1 for d << cutoff), attenuated by the same toon
// ramp as the directionals — a POINT light goes through the gradient map too (lights_toon_fragment
// ::getGradientIrradiance), so a point light on a floor facing it lands on the 0.95 step.

/** The peak values of one transient light, i.e. an `FxLight`/`ProjectileVisual` as the sim stores it. */
export interface TransientLight {
  /** authored sRGB hex, exactly as `PointLight.color.setHex(...)` receives it */
  color: number;
  /** PEAK intensity (`fxLightScale` only ever scales it down from here) */
  intensity: number;
  /** three's PointLight cutoff (the `distance` of the pool light) */
  distance: number;
}

/** One transient light reaching a surface: the light plus the geometry of that surface. */
export interface LitTransient {
  light: TransientLight;
  /** world distance from the light to the surface (the light's height, for the floor below it) */
  distance: number;
  /** dot(normal, lightDir); defaults to 1 (a floor with the light straight above it) */
  dotNL?: number;
}

/** three's `getDistanceAttenuation` with decay 2, without the cutoff window (callers are inside it). */
export function pointAttenuation(distance: number, decay = 2): number {
  const d = Number.isFinite(distance) && distance > 0 ? distance : 0.1;
  return 1 / Math.max(Math.pow(d, decay), 0.01);
}

/** The LINEAR radiance a transient point light adds to one surface: ramp * intensity * atten * albedo/PI. */
export function pointLightLinear(s: SurfaceSample, light: TransientLight, distance: number, dotNL = 1): RGB {
  const irr = rampStep(dotNL) * light.intensity * pointAttenuation(distance);
  const c = hexToLinear(light.color);
  return [c[0] * irr * s.albedo[0] * RECIPROCAL_PI,
          c[1] * irr * s.albedo[1] * RECIPROCAL_PI,
          c[2] * irr * s.albedo[2] * RECIPROCAL_PI];
}

/** A transient light plus the provenance the numbers were read from — frozen by verify-tone.mjs. */
export interface TransientLightFixture extends TransientLight {
  id: string;
  label: string;
  /** Distance to the NEAREST floor point, i.e. the light's own height: the worst case. */
  nearestFloor: number;
  provenance: string;
}

/**
 * Every transient light that lights the SCENERY, at its real peak. The ones that matter are the warm
 * reds/oranges (a red light pushed out of gamut is what used to come back green); the values are
 * asserted against muzzle.ts / projectiles.ts / config.ts in verify-tone.mjs so a retuned recipe
 * cannot silently leave this table behind.
 */
export const TRANSIENT_LIGHTS: readonly TransientLightFixture[] = [
  {
    id: 'pellet-dragon', label: '龙息弹弹丸', color: 0xff6a1c, intensity: 10, distance: 9, nearestFloor: 0.5,
    provenance: 'projectiles.ts::PROJECTILES.flameShot.visual (render.ts draws a projectile light at y=0.5)',
  },
  {
    id: 'muzzle-dragon', label: '龙息弹枪口', color: 0xff5a14, intensity: 18, distance: 10, nearestFloor: 0.75,
    provenance: 'muzzle.ts::MUZZLE.dragonBreath.light (MUZZLE_Y = 0.75)',
  },
  {
    id: 'muzzle-rpg', label: 'RPG 枪口', color: 0xffa050, intensity: 40, distance: 15, nearestFloor: 0.75,
    provenance: 'muzzle.ts::MUZZLE.rpg.light (MUZZLE_Y = 0.75)',
  },
  {
    id: 'blast-rpg', label: 'RPG 爆炸火球', color: 0xffcf8a, intensity: 90, distance: 22.5, nearestFloor: 0.8,
    provenance: 'CONFIG.blastLightIntensity(60) x ROCKET_BLAST_RADIUS/3.5(5.25/3.5=1.5); distance x1.5; y=blastLightY',
  },
  {
    id: 'smg-round', label: 'SMG 弹丸', color: 0xffa030, intensity: 6, distance: 6, nearestFloor: 0.5,
    provenance: 'projectiles.ts::PROJECTILES.smgRound.visual (render.ts draws a projectile light at y=0.5)',
  },
];

export interface ShadeOptions {
  /** 「方向光」 multiplier (settings key light.directional). */
  directional?: number;
  /** 「环境光」 multiplier (settings key light.ambient). */
  ambient?: number;
  /** 「高度雾」 density (settings key fog.density). */
  fog?: number;
  /** 「调性」 grade strength (settings key look.tone); 0 = the ungraded image. */
  grade?: number;
  /** Unlit/additive surfaces (the tracer/flame) bypass the lighting model. */
  shadeUnlit?: boolean;
  /**
   * Emissive colour added on top of the shaded result (linear), mirroring three's
   * `totalEmissiveRadiance`. Used to model a BURNING character's self-lit tint — the fix for
   * 「龙息弹外面一圈是红色亮光、中间反而变黑」(see chartint.ts).
   */
  emissive?: RGB;
  /**
   * Transient point lights reaching this surface (muzzle flash / projectile / blast). Opt-in on
   * purpose: they are gameplay-timed signals, so including them in a baseline would make the palette
   * statistics depend on whether a gun happened to be firing. They are here for the CORRECTNESS
   * assertions (hue stability under an out-of-gamut light) — see TRANSIENT_LIGHTS.
   */
  lights?: readonly LitTransient[];
}

/** The fog colour in output space, i.e. the raw bytes (see toon.ts for why it is not a Color). */
export const FOG_DISPLAY_RGB: RGB = [0x25 / 255, 0x30 / 255, 0x3d / 255];

export interface ToneSample {
  id: string;
  label: string;
  role: SurfaceSample['role'];
  /** The colour as it reaches the framebuffer, sRGB 0..1. */
  rgb: RGB;
  hex: number;
  /** Relative luminance (Rec.709) of the displayed colour, 0..1. */
  luminance: number;
  /** HSV saturation of the displayed colour. */
  saturation: number;
  /** CIE L* (0..100) — the perceptual lightness used by the separation metric. */
  lStar: number;
  /** How much fog was mixed in (0..1). */
  fog: number;
  weight: number;
}

/**
 * A surface's LINEAR radiance before the encode: the two directionals through the toon ramp, the
 * hemisphere fill, the optional emissive, and any transient point lights. Exported because the
 * interesting failures live on this side of the encode (an out-of-gamut value is what breaks a
 * display-space grade), so the tests need it without re-deriving the lighting model.
 */
export function surfaceLinear(s: SurfaceSample, opts: ShadeOptions = {}): RGB {
  if (opts.shadeUnlit) {
    return [s.albedo[0], s.albedo[1], s.albedo[2]];   // additive/unlit effects are drawn at face value
  }
  const directional = opts.directional ?? 1;
  const ambient = opts.ambient ?? 0;
  const n = s.normal;
  // The key light travels FROM KEY_DIR, so the surface's dotNL uses -dir (three passes
  // `directLight.direction` = the direction the light travels, and dot(N, -L) is the diffuse term).
  const dotKey = -(n[0] * KEY_DIR[0] + n[1] * KEY_DIR[1] + n[2] * KEY_DIR[2]);
  const dotWarm = -(n[0] * WARM_DIR[0] + n[1] * WARM_DIR[1] + n[2] * WARM_DIR[2]);
  const keyIrr = rampStep(dotKey) * DIR_KEY_INTENSITY * directional;
  const warmIrr = rampStep(dotWarm) * DIR_WARM_INTENSITY * directional;
  const warmLin = hexToLinear(WARM_COLOR).map((c) => c * warmIrr);
  // Hemisphere: `mix(ground, sky, 0.5 + 0.5*normal.y) * intensity` (indirect, NOT ramp-banded).
  const sky = hexToLinear(AMBIENT_SKY_COLOR);
  const ground = hexToLinear(AMBIENT_GROUND_COLOR);
  const w = 0.5 + 0.5 * n[1];
  const hemiScale = ambientIntensity(ambient) * RECIPROCAL_PI;
  const irr: RGB = [
    keyIrr + warmLin[0] + (ground[0] + (sky[0] - ground[0]) * w) * hemiScale,
    keyIrr + warmLin[1] + (ground[1] + (sky[1] - ground[1]) * w) * hemiScale,
    keyIrr + warmLin[2] + (ground[2] + (sky[2] - ground[2]) * w) * hemiScale,
  ];
  let linear: RGB = [
    (irr[0] * s.albedo[0]) * RECIPROCAL_PI,
    (irr[1] * s.albedo[1]) * RECIPROCAL_PI,
    (irr[2] * s.albedo[2]) * RECIPROCAL_PI,
  ];
  // Emissive is ADDED after the lighting, exactly like `totalEmissiveRadiance` in three — this is
  // what makes a self-lit surface readable no matter how little light reaches it.
  if (opts.emissive) linear = [
    linear[0] + opts.emissive[0], linear[1] + opts.emissive[1], linear[2] + opts.emissive[2],
  ];
  // Transient point lights are added last, as three accumulates every direct light into the same
  // diffuse term. This is the term that can push a surface far past 1.0 (see TRANSIENT_LIGHTS).
  if (opts.lights) for (const l of opts.lights) {
    const add = pointLightLinear(s, l.light, l.distance, l.dotNL ?? 1);
    linear = [linear[0] + add[0], linear[1] + add[1], linear[2] + add[2]];
  }
  return linear;
}

/** One surface's displayed colour: lighting -> ramp -> fog -> (optional grade) -> sRGB. */
export function shade(s: SurfaceSample, opts: ShadeOptions = {}): ToneSample {
  const fogDensity = opts.fog ?? 0;
  const linear = surfaceLinear(s, opts);
  // Fog and the grade both work in OUTPUT space (see fog.ts / grade.ts) — so the encode happens
  // first, then fog, then the grade, exactly in the order the shader applies them. NOTE the encode
  // does NOT clamp: three's `LinearTosRGB` does not either, and the displayable clamp belongs at the
  // very END (where the framebuffer does it, and where the grade now clamps its own input) — clamping
  // here instead would make the model MORE forgiving than the renderer for a super-white pixel that
  // also sits in fog, which is exactly the class of mistake that hid the red-to-green defect.
  let rgb: RGB = [
    linearToSrgb(linear[0]),
    linearToSrgb(linear[1]),
    linearToSrgb(linear[2]),
  ];
  const f = fogDensity > 0 ? fogFactor(s.distance, s.height, fogDensity) : 0;
  if (f > 0) rgb = mix(rgb, FOG_DISPLAY_RGB, f);
  if ((opts.grade ?? 0) > 0) rgb = gradeDisplay(rgb, opts.grade as number);
  // What the framebuffer actually holds. The grade extrapolates past 0..1 on purpose at 「调性」 > 1
  // (that is what the knob is), and the framebuffer clips it — so the DISPLAYED colour is the clamped
  // one, and every consumer of ToneSample ("The colour as it reaches the framebuffer, sRGB 0..1")
  // must see that. Without this, a model sweep would report "green" for a pixel whose red is clipped
  // at 1 and whose green is 1.04, i.e. a colour that displays as plain warm white.
  rgb = [Math.min(1, Math.max(0, rgb[0])), Math.min(1, Math.max(0, rgb[1])), Math.min(1, Math.max(0, rgb[2]))];
  return sample(s, rgb, f);
}

export function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function sample(s: SurfaceSample, rgb: RGB, fog = 0): ToneSample {
  const [r, g, b] = rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return {
    id: s.id,
    label: s.label,
    role: s.role,
    rgb,
    hex: (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255),
    luminance: 0.2126 * r + 0.7152 * g + 0.0722 * b,
    saturation: max <= 0 ? 0 : (max - min) / max,
    lStar: lStarOf(rgb),
    fog,
    weight: s.weight,
  };
}

// ---------------------------------------------------------------------------
// CIE Lab (for the perceptual separation metric)
// ---------------------------------------------------------------------------
const pivotRgb = (c: number): number => (c > 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92);

/**
 * CIE L* (0..100) from a DISPLAY sRGB triple, i.e. three's post-`linearToOutputTexel` value. Used for
 * the separation metric because equal steps in L* are roughly equal steps in perceived lightness,
 * which is what decides whether a character reads against the floor.
 */
export function lStarOf(rgb: RGB): number {
  const [r, g, b] = rgb.map(pivotRgb) as RGB;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  return y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y;
}

/** Full CIE L*a*b* (D65) so pairs can be compared with a colour-difference, not just lightness. */
export function labOf(rgb: RGB): RGB {
  const [r, g, b] = rgb.map(pivotRgb) as RGB;
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE76 colour difference. ~2.3 is the classic "just noticeable" threshold. */
export function deltaE(a: RGB, b: RGB): number {
  const la = labOf(a);
  const lb = labOf(b);
  return Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
}

// ---------------------------------------------------------------------------
// Report metrics
// ---------------------------------------------------------------------------
export interface ToneMetrics {
  samples: ToneSample[];
  /** Area-weighted mean relative luminance (0..1). */
  meanLuminance: number;
  /** Area-weighted p5/p50/p95 of relative luminance. */
  p05: number; p50: number; p95: number;
  /** (p95 - p5) * 255 — the scorecard's `luminance.contrast` analogue (its floor is ~60). */
  contrast: number;
  /** Mean HSV saturation across surfaces. */
  meanSaturation: number;
  /** Share of the weighted area in the most common 6x6x6 colour bucket (scorecard: >0.6 = sparse). */
  dominantShare: number;
  /** Shannon entropy (bits) over those buckets, weighted (scorecard floor ~3.0; bounded by log2(#surfaces)). */
  entropyBits: number;
  /** Distinct populated buckets (a "how many notes are playing" sanity number). */
  buckets: number;
  /** Hue histogram share for the three hue families (warm >= 345 or < 70, cool 170..270, else neutral). */
  warmShare: number; coolShare: number; neutralShare: number;
}

export function analyze(samples: ToneSample[]): ToneMetrics {
  const total = samples.reduce((a, s) => a + s.weight, 0) || 1;
  const sorted = [...samples].sort((a, b) => a.luminance - b.luminance);
  const pick = (q: number): number => {
    let acc = 0;
    for (const s of sorted) {
      acc += s.weight / total;
      if (acc >= q) return s.luminance;
    }
    return sorted[sorted.length - 1].luminance;
  };
  const buckets = new Map<number, number>();
  for (const s of samples) {
    const key = (Math.round(s.rgb[0] * 5) << 6) | (Math.round(s.rgb[1] * 5) << 3) | Math.round(s.rgb[2] * 5);
    buckets.set(key, (buckets.get(key) ?? 0) + s.weight / total);
  }
  let entropy = 0;
  let dominant = 0;
  for (const share of buckets.values()) {
    if (share > 0) entropy -= share * Math.log2(share);
    if (share > dominant) dominant = share;
  }
  let warm = 0;
  let cool = 0;
  let neutral = 0;
  for (const s of samples) {
    const [r, g, b] = s.rgb;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const share = s.weight / total;
    if (max - min < 0.035) { neutral += share; continue; }
    let h = 0;
    if (max === r) h = ((g - b) / (max - min)) % 6;
    else if (max === g) h = (b - r) / (max - min) + 2;
    else h = (r - g) / (max - min) + 4;
    h = ((h * 60) + 360) % 360;
    if (h >= 170 && h <= 270) cool += share;
    else if (h >= 345 || h < 70) warm += share;
    else neutral += share;
  }
  return {
    samples,
    meanLuminance: samples.reduce((a, s) => a + s.luminance * s.weight, 0) / total,
    p05: pick(0.05), p50: pick(0.5), p95: pick(0.95),
    contrast: (pick(0.95) - pick(0.05)) * 255,
    meanSaturation: samples.reduce((a, s) => a + s.saturation * s.weight, 0) / total,
    dominantShare: dominant,
    entropyBits: entropy,
    buckets: buckets.size,
    warmShare: warm, coolShare: cool, neutralShare: neutral,
  };
}

/** One gameplay-critical pair's perceptual separation. */
export interface Separation {
  a: string;
  b: string;
  dE: number;
  dL: number;
  /** True when the pair is at or above the ~2.3 JND, i.e. they are not the same colour on screen. */
  readable: boolean;
}

export function separations(samples: ToneSample[], pairs: ReadonlyArray<readonly [string, string]>): Separation[] {
  const by = new Map(samples.map((s) => [s.id, s]));
  const out: Separation[] = [];
  for (const [a, b] of pairs) {
    const sa = by.get(a);
    const sb = by.get(b);
    if (!sa || !sb) continue;
    const dE = deltaE(sa.rgb, sb.rgb);
    out.push({
      a: sa.label, b: sb.label, dE, dL: sb.lStar - sa.lStar, readable: dE >= 2.3,
    });
  }
  return out;
}

/** The pairs whose readability decides whether the game is playable. */
export const CRITICAL_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['player', 'floor'],
  ['enemy-gunner', 'floor'],
  ['enemy-rusher', 'floor'],
  ['enemy-gunner', 'wall'],
  ['cover-top', 'floor'],
  ['player', 'enemy-gunner'],
  ['tracer', 'floor'],
];
