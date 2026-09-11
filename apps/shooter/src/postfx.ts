// 「像素化」 post-processing: the pass parameters, the fullscreen shader, and the STABILITY math —
// pure, so everything except "does the GPU accept the shader" can be asserted in Node
// (scripts/verify-postfx.mjs).
//
// WHAT IT DOES
// ------------
// The scene is rendered into a small render target (`ceil(viewport / block)` texels) and then drawn to
// the canvas by a fullscreen quad that samples that target with NEAREST filtering. Each texel of the
// small target covers a `block x block` square of the canvas, so the image is blocky by exactly that
// much — the standard, cheapest pixelation there is, and it costs one extra fullscreen draw.
//
// THE BLOCK IS MEASURED IN CSS PIXELS, NOT DEVICE PIXELS
// -----------------------------------------------------
// `PIXEL_BLOCK_DEFAULT = 2` means "one chunky pixel is 2 CSS px wide", and the renderer multiplies it
// by the DPR it actually uses. Defining it in device pixels instead would make the same setting look
// ~3x coarser on a desktop than on a 3x phone, which is exactly the "grain too big on my screen"
// complaint this is meant to avoid. Tests pin the device-pixel maths.
//
// WHY IT IS STABLE (the part that usually goes wrong)
// --------------------------------------------------
// A pixelation pass crawls if the world slides *sub-pixel* across the block grid: every block then
// re-picks its sample each frame and the edges shimmer. Two things prevent that here, and both are
// asserted in Node:
//
//   1. THE PROJECTION IS ORTHOGRAPHIC (see camera.ts). World units per pixel are CONSTANT across the
//      frame, so there is one block size to align to. Under the old perspective camera the same block
//      would cover a different world size at every depth, and no single snap could align it.
//   2. THE CAMERA IS SNAPPED TO THE BLOCK GRID (`snapCameraToBlockGrid`): its position is quantised
//      along the camera's own right/up axes to whole blocks, so a world feature's screen position moves
//      in whole blocks instead of drifting across them. The camera follows the player continuously, so
//      without this the whole image would crawl one sub-pixel at a time.
//
// One consequence to be aware of (it is the point, not a bug): with the snap on, the player advances
// across the screen in block-sized steps. That is what "pixel-perfect" motion looks like; the
// alternative is smooth motion with shimmering edges.
//
// THE OFFSCREEN TARGET IS DISPLAY-REFERRED (the colour-space decision, learned the hard way)
// ----------------------------------------------------------------------------------------
// three makes a (non-XR) render target's output space LINEAR, which is a *compositing* decision: every
// `dst`-space blend inside the target (the vignette's multiply, the vision darkness, every additive
// glow) then happens in linear light instead of on screen, and the difference is large — measured with
// the reporter's own settings, the corner/vignette regions came out 32-62% brighter and a tracer up to
// 74/255 off. So this pass overrides three's output conversion GLOBALLY
// (`DISPLAY_REFERRED_COLORSPACE_CHUNK`, installed by render.ts) to make every material write display
// values no matter which target it draws into; the target then composites exactly like the canvas and
// the blit is a plain copy. The earlier, narrower fix (convert in the blit) repaired the *stored*
// values but left every blend in the wrong space — see PIXEL_FRAGMENT_SHADER for both stories.

/** Chunky-pixel width in CSS pixels. 0 = the pass is off (no render target, no extra draw). */
export const PIXEL_BLOCK_DEFAULT = 2;
export const PIXEL_BLOCK_MIN = 0;
/** 6 CSS px is already a heavy retro look; the request was explicitly "not too big". */
export const PIXEL_BLOCK_MAX = 6;
export const PIXEL_BLOCK_STEP = 1;

/**
 * MSAA samples requested for the offscreen target. 4 is the usual quality/cost point and matches the
 * canvas, which the renderer creates with `antialias: true`.
 *
 * WHY THIS IS A COLOUR QUESTION AND NOT A NICETY: coverage is brightness. A single-sample target gives
 * every texel a yes/no answer, so a feature thinner than one texel — a tracer streak, the aiming laser,
 * a cover beam, an outline shell, a spark — renders at FULL brightness when it covers the sample point
 * and not at all when it misses it. The canvas path, being multisampled, shows its true coverage
 * instead: a 0.6-texel-wide bright line reads ~60%, not 100% (measured difference on such a line:
 * +67% brighter offscreen, or the line vanishing entirely, depending on sub-texel alignment). With
 * 「环境光」 at 0 the thin additive effects *are* most of the bright content, which is exactly the
 * reported 「像素化后颜色都变亮了」 — so the two paths have to rasterise with the same rules.
 *
 * COST: the target has ~1/block^2 the pixels of the canvas, so 4 samples here is roughly what the
 * canvas already pays for its OWN antialiasing at device resolution (at block 2 that is a quarter of
 * the pixels with four samples each). It is a resolve blit per frame, and on WebGL1 / any driver
 * without multisampled renderbuffers three ignores `samples` silently — the pass then behaves exactly
 * as it did before the setting, so this can only ever improve the match, never break the fallback.
 */
export const PIXEL_MSAA_SAMPLES = 4;

/** Never render the small target below this many texels on either axis (a 1x1 target is useless). */
export const PIXEL_MIN_TEXELS = 24;
/** ...and never above this: the pass must stay a *reduction*, and a huge target would cost fill for
 *  nothing (the canvas is capped at DPR 2 by the renderer anyway). */
export const PIXEL_MAX_TEXELS = 2048;

export function clampPixelBlock(v: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return PIXEL_BLOCK_DEFAULT;
  if (v < PIXEL_BLOCK_MIN) return PIXEL_BLOCK_MIN;
  if (v > PIXEL_BLOCK_MAX) return PIXEL_BLOCK_MAX;
  return v;
}

/** Panel readout: percent of the coarsest block (0 is shown as 「关闭」). */
export function pixelPercent(block: number): number {
  return Math.round((clampPixelBlock(block) / PIXEL_BLOCK_MAX) * 100);
}

export interface PixelTarget {
  width: number;
  height: number;
  /** Device pixels per block actually used (block x dpr, rounded, at least 1). */
  blockDevice: number;
  /** True when the pass should run at all. */
  enabled: boolean;
}

/**
 * Size of the low-resolution render target for a viewport.
 *
 * `viewportW/H` are CSS pixels, `dpr` the capped device pixel ratio, `block` the setting in CSS px.
 * The canvas drawing buffer is `viewport * dpr`, so the block in device pixels is `block * dpr` and the
 * target is that buffer divided by it. Both axes are floored, so a block can end up covering a
 * fractionally different area horizontally and vertically; that error is bounded by one block
 * (documented, and the reason the target is derived from the canvas size rather than from an assumed
 * aspect).
 */
export function pixelTarget(viewportW: number, viewportH: number, dpr: number, block: number): PixelTarget {
  const b = clampPixelBlock(block);
  const scale = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  if (b <= 0) return { width: 0, height: 0, blockDevice: 1, enabled: false };
  const blockDevice = Math.max(1, Math.round(b * scale));
  const width = clampTexels(Math.floor((viewportW * scale) / blockDevice));
  const height = clampTexels(Math.floor((viewportH * scale) / blockDevice));
  return { width, height, blockDevice, enabled: true };
}

function clampTexels(v: number): number {
  if (!Number.isFinite(v) || v < PIXEL_MIN_TEXELS) return PIXEL_MIN_TEXELS;
  return Math.min(PIXEL_MAX_TEXELS, Math.floor(v));
}

/** World units covered by one block horizontally (ortho: the same everywhere, and on both axes it
 *  differs only by the floored target size). Used by the snap below and by the tests. Takes just the
 *  two texel counts, so the renderer can pass its cached size without rebuilding a PixelTarget. */
export function worldPerBlock(
  frustumHeight: number, frustumWidth: number, target: { width: number; height: number },
): { x: number; y: number } {
  return {
    x: target.width > 0 ? frustumWidth / target.width : 1,
    y: target.height > 0 ? frustumHeight / target.height : 1,
  };
}

/**
 * Snap a camera position to the block grid: quantise its offset along the camera's own right/up axes
 * to whole blocks.
 *
 * WHY ALONG THE AXES: an orthographic camera's image translates by exactly `dot(delta, right)` /
 * `dot(delta, up)` pixels when the camera moves by `delta`, so quantising those two components to the
 * world size of one block makes every world feature land on the same block boundary every frame — the
 * image moves in whole blocks and cannot shimmer. The view axis is left alone (under ortho it does not
 * affect the image at all, only the depth range).
 *
 * `right` and `up` must be the camera's world axes (unit vectors); `quat`-derived in render.ts.
 */
export function snapCameraToBlockGrid(
  pos: readonly [number, number, number],
  right: readonly [number, number, number],
  up: readonly [number, number, number],
  blockX: number, blockY: number,
): [number, number, number] {
  const dot = (a: readonly [number, number, number], b: readonly [number, number, number]): number =>
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const bx = blockX > 0 ? blockX : 1;
  const by = blockY > 0 ? blockY : 1;
  const dr = dot(pos, right);
  const du = dot(pos, up);
  const shiftR = Math.round(dr / bx) * bx - dr;
  const shiftU = Math.round(du / by) * by - du;
  return [
    pos[0] + right[0] * shiftR + up[0] * shiftU,
    pos[1] + right[1] * shiftR + up[1] * shiftU,
    pos[2] + right[2] * shiftR + up[2] * shiftU,
  ];
}

// ---------------------------------------------------------------------------
// The one global override that makes the OFFSCREEN pass display-referred
// ---------------------------------------------------------------------------
/**
 * Replacement text for three's `ShaderChunk.colorspace_fragment`, installed once by render.ts BEFORE
 * any material compiles.
 *
 * WHAT IT REPLACES: the stock chunk is `gl_FragColor = linearToOutputTexel( gl_FragColor );`, and
 * `linearToOutputTexel` is generated PER PROGRAM from the program's output colour space: `LinearTosRGB`
 * for the canvas, the IDENTITY for a (non-XR) render target. That is the switch that made the same
 * shader produce display values on screen and linear values offscreen — and with a linear offscreen
 * buffer every `dst`-blend in the frame (vignette multiply, vision darkness, additive glows) composites
 * in linear light instead of on screen. See PIXEL_FRAGMENT_SHADER below for what that costs.
 *
 * WHAT IT DOES INSTEAD: always encode to sRGB, whatever the target. This is deliberately a GLOBAL
 * override rather than a per-material patch: the offscreen pass draws ~20 materials (toon, basic,
 * particles, bars, laser, beams, overlays) and *every* one of them has to agree, or the frame mixes
 * two spaces. `ShaderChunk` is a plain (unfrozen) object in the vendored build and three resolves
 * `#include <...>` from it at COMPILE time, so one assignment covers every non-raw material.
 *
 * WHY THE CANVAS PATH IS UNAFFECTED: for an sRGB canvas `linearToOutputTexel` IS `sRGBTransferOETF`
 * (asserted against the vendored build in verify-postfx.mjs), so the direct path computes exactly the
 * same bytes as before — the override only changes what happens when a render target is bound.
 *
 * ⚠️ THREE THINGS THIS GLOBAL OVERRIDE DOES NOT COVER, all verified against the vendored build:
 *   1. A RAW `clear()` BYPASSES ALL OF THIS (it never runs a shader), so `scene.background` needs the
 *      display-valued colour while the target is bound — see render.ts.
 *   2. A material with `rawShaderMaterial: true` has no colours-pace prefix, so it must never include
 *      this chunk (nothing in this app is raw).
 *   3. The POINT/SPOT-LIGHT DISTANCE SHADOW shader (`distanceRGBA_frag`) does include the chunk, and it
 *      writes PACKED DEPTH — encoding those bytes would corrupt the shadow comparison. This app has no
 *      point or spot shadow caster (the single key light is a DirectionalLight, whose `depth_frag` has
 *      no colours-pace include at all, asserted in verify-postfx.mjs), so the case never compiles. If a
 *      shadow-casting point light is ever added, exclude it from this override first.
 */
export const DISPLAY_REFERRED_COLORSPACE_CHUNK = 'gl_FragColor = sRGBTransferOETF( gl_FragColor );';

// ---------------------------------------------------------------------------
// GLSL (a fullscreen quad that draws the small target 1:1; two uniforms, no lighting)
// ---------------------------------------------------------------------------
/**
 * Vertex: standard clip-space quad. `position` is a PlaneGeometry's own attribute in [-1,1], so the
 * camera matrices are deliberately unused — this pass must not move with any camera.
 */
export const PIXEL_VERTEX_SHADER = [
  'varying vec2 vPixelUv;',
  'void main() {',
  '  vPixelUv = uv;',
  '  gl_Position = vec4( position.xy, 0.0, 1.0 );',
  '}',
].join('\n');

/**
 * Fragment: one NEAREST sample of the small target, blitted 1:1 with NO conversion.
 *
 * ⚠️ THE PASS BEING A PURE COPY IS THE WHOLE COLOUR STORY HERE, AND IT IS THE *SECOND* SOLUTION TO
 * THE SAME ROOT CAUSE.
 *
 * three.js applies a material's `linearToOutputTexel` conversion only when it renders to the CANVAS;
 * a (non-XR) render target is forced to LINEAR output (`outputColorSpace: currentRenderTarget === null
 * ? renderer.outputColorSpace : (rt.isXRRenderTarget ? rt.texture.colorSpace : 'srgb-linear')`). That
 * default is a *compositing* decision, and for this game it is the wrong one: everything the frame
 * contains — the world look (fog + grade), the vignette, the vision darkness and every additive glow —
 * was authored against the SCREEN's values, so `dst`-space blends (multiply, alpha, additive) must
 * happen in display space. Inside a linear target they happen in linear light instead, and the errors
 * are large and one-directional:
 *
 *   * multiplicative darkeners come out WEAKER: with the user's vignette 1.5 / vision 0.25 the corners
 *     are 32-39% brighter and a vision-dimmed corner 49-62% brighter than the direct path — i.e. the
 *     pixelated frame reads washed out / "all colours got brighter" (the actual report);
 *   * additive glows come out DIMMER and less washed out: a tracer over a lit floor is off by up to
 *     74/255 (the authored glow is added in display space, so adding it in linear light and encoding
 *     afterwards loses most of it).
 *
 * So the fix is NOT a conversion in this shader (the first fix, which repaired the *stored values* but
 * left every blend in the wrong space). It is to make the OFFSCREEN PASS DISPLAY-REFERRED: every
 * material writes display values no matter which target it draws into, so the target composites exactly
 * like the canvas and this blit is a plain copy. That is done with ONE global override —
 * `DISPLAY_REFERRED_COLORSPACE_CHUNK` below, installed by render.ts — plus a display-valued clear
 * colour for the background (a raw `clear()` bypasses the shader pipeline entirely, see render.ts).
 *
 * WHY THIS IS SAFE FOR THE CANVAS PATH: the chunk it replaces expands to
 * `gl_FragColor = linearToOutputTexel( gl_FragColor )`, and for an sRGB canvas `linearToOutputTexel`
 * IS `sRGBTransferOETF` — so the direct path keeps computing exactly the same bytes. The override only
 * changes what happens when a render target is bound, which is where the bug was.
 *
 * THE EARLIER INCIDENT (kept because it explains why the guard rails below exist): the very first
 * version of this pass copied the target with no conversion at all while the target really did hold
 * LINEAR values, and the whole frame was wrong — mid-tones crushed and hues distorted. Measured on the
 * shipped palette with tone.ts's transfer functions: floor gray `#83878b -> #3a3e42` (L* 56 -> 26),
 * lvl2 green `#4caf50 -> #126d14`, lvl5 gold `#ffc107 -> #ff8801`, pellet core `#ff4200 -> #ff0e00`
 * (the dragon-breath pellet lost its white-hot core). That is why `verify-postfx.mjs` asserts, in both
 * directions, WHICH SPACE THE TARGET HOLDS: the target must be display-referred (the scene pass
 * encodes) and this shader must not convert again.
 *
 * DO NOT "fix" a future colour problem by flagging the target texture as sRGB: three would allocate an
 * SRGB8_ALPHA8 texture whose sampler hardware-decodes on read, which would double-convert the display
 * values the scene pass now writes (and, worse, it makes the pipeline depend on whether the driver
 * also converts on framebuffer *write* — a behaviour this environment cannot test).
 */
export const PIXEL_FRAGMENT_SHADER = [
  'uniform sampler2D tPixelScene;',
  'varying vec2 vPixelUv;',
  'void main() {',
  '  gl_FragColor = texture2D( tPixelScene, vPixelUv );',
  '}',
].join('\n');

/** Names the renderer must provide as uniforms (asserted in verify-postfx.mjs). */
export const PIXEL_UNIFORMS = ['tPixelScene'] as const;

// ---------------------------------------------------------------------------
// The RESOLUTION CHAIN (`?diag=1`): how many texels this viewport renders, and how much world
// each of them covers. Kept pure and separate from diag.ts so the numbers can be asserted in Node.
// ---------------------------------------------------------------------------
/**
 * WHY THIS EXISTS (a real report): 「横屏分辨率明显比竖屏低」 is un-answerable from the picture alone,
 * because "resolution" mixes two independent quantities:
 *   1. HOW MANY PIXELS are rendered — `viewport / block` texels, a function of the viewport area and
 *      the 「像素化」 setting only (with the pass off it is the canvas, i.e. `viewport * dpr`);
 *   2. HOW MUCH WORLD each pixel covers — `frustumHeight / viewportHeight`, a function of the CAMERA
 *      POSE only (the `camZoom` dolly cancels the viewport height out).
 * Rotating the phone cannot change (1) unless the block differs per orientation, and cannot change (2)
 * unless the camera height differs (or `camZoom` hit its clamp). Printing both, in one line, with the
 * other orientation's last measurement next to it, turns a subjective comparison into two numbers.
 *
 * `dpr` is the ratio the RENDERER uses (capped, see render.ts); `deviceDpr` is the device's own, which
 * is what "percent of native" must be measured against — capping is exactly the kind of information
 * this line is supposed to expose, not hide.
 */
export interface ResolutionFacts {
  /** CSS px, the canvas' own box (not the window: they differ behind the shell's appbar). */
  viewportW: number;
  viewportH: number;
  /** The pixel ratio the renderer actually draws at (already capped by render.ts). */
  dpr: number;
  /** The device's own ratio (window.devicePixelRatio), i.e. what native means here. */
  deviceDpr: number;
  /** 「像素化」 block in CSS px; 0 = the pass is off and the canvas is drawn directly. */
  block: number;
  /** Texels actually rendered: the offscreen target, or the canvas drawing buffer when it is off. */
  targetW: number;
  targetH: number;
  /** Vertical size of the orthographic view volume, world units (camera.ts::orthoFrustumHeight). */
  frustumHeight: number;
  /** The panel's own size in CSS px (screen.width/height) — the "native" reference. */
  screenW: number;
  screenH: number;
}

export interface ResolutionChain extends ResolutionFacts {
  orientation: 'portrait' | 'landscape';
  texels: number;
  /** The panel's pixels at the DEVICE ratio: what a 1:1 render would cost. */
  nativeTexels: number;
  /** `texels / nativeTexels`, in percent. 100% = native, ~44% = DPR capped at 2 on a 3x screen. */
  percentOfNative: number;
  /** CSS px per world unit (== target texels per world unit: one texel per CSS px per block). */
  pxPerWorldUnit: number;
  worldPerCssPx: number;
  /** True when 「像素化」 is off (nothing is downscaled; the dpr cap is the only limit). */
  direct: boolean;
}

/** The numbers behind the readout, all derived and NaN-proof (a readout must never print NaN). */
export function resolutionChain(f: ResolutionFacts): ResolutionChain {
  const viewportW = Number.isFinite(f.viewportW) && f.viewportW > 0 ? f.viewportW : 0;
  const viewportH = Number.isFinite(f.viewportH) && f.viewportH > 0 ? f.viewportH : 0;
  const dpr = Number.isFinite(f.dpr) && f.dpr > 0 ? f.dpr : 1;
  const deviceDpr = Number.isFinite(f.deviceDpr) && f.deviceDpr > 0 ? f.deviceDpr : dpr;
  const targetW = Number.isFinite(f.targetW) && f.targetW > 0 ? f.targetW : 0;
  const targetH = Number.isFinite(f.targetH) && f.targetH > 0 ? f.targetH : 0;
  const frustumHeight = Number.isFinite(f.frustumHeight) && f.frustumHeight > 0 ? f.frustumHeight : 0;
  const screenW = Number.isFinite(f.screenW) && f.screenW > 0 ? f.screenW : viewportW;
  const screenH = Number.isFinite(f.screenH) && f.screenH > 0 ? f.screenH : viewportH;
  // Clamped exactly like the renderer clamps it (setPixelBlock), so the readout cannot print `块NaN`
  // for a value the renderer would never actually use.
  const block = clampPixelBlock(f.block);
  const texels = targetW * targetH;
  const nativeTexels = screenW * screenH * deviceDpr * deviceDpr;
  const worldPerCssPx = viewportH > 0 ? frustumHeight / viewportH : 0;
  return {
    ...f, viewportW, viewportH, dpr, deviceDpr, targetW, targetH, screenW, screenH, block,
    orientation: viewportW > viewportH ? 'landscape' : 'portrait',
    texels,
    nativeTexels,
    percentOfNative: nativeTexels > 0 ? (texels / nativeTexels) * 100 : 0,
    worldPerCssPx,
    pxPerWorldUnit: worldPerCssPx > 0 ? 1 / worldPerCssPx : 0,
    direct: block <= 0,
  };
}

/**
 * The one-line readout. `other` is the SAME measurement taken in the other orientation (diag.ts keeps
 * the last one it saw), which is the whole point: rotating the phone once should be enough to see
 * WHICH of the two quantities changed and by how much.
 */
export function resolutionText(c: ResolutionChain, other?: ResolutionChain | null): string {
  const ratio = other && other.pxPerWorldUnit > 0 && c.pxPerWorldUnit > 0
    ? ` (${other.orientation === 'portrait' ? '竖屏' : '横屏'}的 `
      + `${Math.round((c.pxPerWorldUnit / other.pxPerWorldUnit) * 100)}%)`
    : '';
  const dprText = c.deviceDpr > c.dpr ? `dpr${c.dpr}/设备${c.deviceDpr}` : `dpr${c.dpr}`;
  const blockText = c.direct ? '后处理关' : `块${c.block}css`;
  const pct = c.percentOfNative > 0 ? ` (原生${c.percentOfNative.toFixed(0)}%)` : '';
  return `分辨率 ${c.viewportW.toFixed(0)}×${c.viewportH.toFixed(0)}css · ${dprText} · ${blockText}`
    + ` → ${c.targetW}×${c.targetH}tex${pct} · ${c.pxPerWorldUnit.toFixed(1)}px/世界单位${ratio}`;
}
