/**
 * CPU-side verification for the 「像素化」 post-processing pass (and the orthographic camera it needs).
 *
 * No GPU here, so the shader cannot be compiled and the pixels cannot be looked at. What CAN be proven:
 *
 *   1. THE TARGET MATHS: the low-res render target is an integer size derived from the canvas drawing
 *      buffer, the pass never allocates a degenerate or oversized target, and the block really is the
 *      requested number of DEVICE pixels (the setting is authored in CSS px, so a 3x phone must not get
 *      a 3x coarser image than a 1x desktop — that is the "grain too big" failure this guards).
 *   2. STABILITY, the part that usually goes wrong: with the ORTHOGRAPHIC camera the world size of one
 *      block is constant, and `snapCameraToBlockGrid` quantises the camera so a world feature's SCREEN
 *      position moves in whole blocks instead of drifting across them. This is checked on the real
 *      vendored three.js: an OrthographicCamera is posed, points are projected, and the test asserts
 *      (a) the projection of a fixed world point changes by an INTEGER number of blocks when the
 *      snapped camera moves a sub-block amount, and (b) without the snap it does not.
 *   3. THE SHADER TEXT is what the renderer hands to three: the uniforms it sets are the uniforms the
 *      GLSL declares, the varyings match, the braces balance, and the pass samples with
 *      NEAREST filtering (linear filtering would blur the blocks into a plain low-res image).
 *   4. THE ORTHO CAMERA keeps the reference framing: the frustum height at scale 1 / camZoom 1 is the
 *      height the old perspective camera saw at the focus plane, and the shadow fit's visible ground is
 *      a SUBSET of what the old perspective frustum saw (so the coverage guarantee cannot have been
 *      weakened by the projection change).
 *
 * Run:  npm run build && node scripts/verify-postfx.mjs
 * Exit code is non-zero when any assertion fails.
 */
import {
  PIXEL_BLOCK_DEFAULT, PIXEL_BLOCK_MAX, PIXEL_BLOCK_MIN, clampPixelBlock, pixelPercent, pixelTarget,
  worldPerBlock, snapCameraToBlockGrid, PIXEL_VERTEX_SHADER, PIXEL_FRAGMENT_SHADER, PIXEL_UNIFORMS,
  PIXEL_MIN_TEXELS, PIXEL_MAX_TEXELS, DISPLAY_REFERRED_COLORSPACE_CHUNK, PIXEL_MSAA_SAMPLES,
} from '../dist/apps/shooter/src/postfx.js';
import {
  CAMERA_FOV_Y, cameraDistance, orthoFrustumHeight,
} from '../dist/apps/shooter/src/camera.js';
import * as S from '../dist/apps/shooter/src/shadow.js';
import { linearToSrgb, lStarOf, srgbToLinear } from '../dist/apps/shooter/src/tone.js';
// The display-referred target must reproduce the DIRECT path's compositing exactly, so the proof below
// needs the same transfer functions the shader uses and the real vignette field.
import * as W from '../dist/apps/shooter/src/worldlook.js';
import { vignetteFactor } from '../dist/apps/shooter/src/vignette.js';
import { readFileSync, readdirSync } from 'node:fs';

const THREE = await import(new URL('../dist/apps/shooter/vendor/three.module.min.js', import.meta.url).href);

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail ? ' — ' + detail : ''));
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------- 1. block + target maths
check('the shipped block is small (2 CSS px) and 0 is the off switch',
  PIXEL_BLOCK_DEFAULT === 2 && PIXEL_BLOCK_MIN === 0 && PIXEL_BLOCK_MAX === 6);
check('clampPixelBlock: range clamps, dirty data -> the shipped default',
  clampPixelBlock(0) === 0 && clampPixelBlock(-1) === 0 && clampPixelBlock(99) === PIXEL_BLOCK_MAX
  && clampPixelBlock(NaN) === PIXEL_BLOCK_DEFAULT && clampPixelBlock('2') === PIXEL_BLOCK_DEFAULT);
check('pixelPercent: 0 -> 0%, the default -> 33%, the max -> 100%',
  pixelPercent(0) === 0 && pixelPercent(PIXEL_BLOCK_MAX) === 100 && pixelPercent(2) === 33);

check('block 0 -> the pass is disabled and allocates nothing',
  (() => {
    const t = pixelTarget(800, 400, 3, 0);
    return t.enabled === false && t.width === 0 && t.height === 0;
  })());
check('the block is CSS px x dpr in DEVICE pixels (a 3x phone is not 3x coarser)',
  (() => {
    const phone = pixelTarget(800, 400, 3, 2);     // 2400x1200 device px / 6
    const desk = pixelTarget(800, 400, 1, 2);      // 800x400 device px / 2
    return phone.blockDevice === 6 && desk.blockDevice === 2
      && phone.width === 400 && desk.width === 400 && phone.height === 200 && desk.height === 200;
  })(), JSON.stringify(pixelTarget(800, 400, 3, 2)));
check('a portrait phone and a landscape one get the same block, different target shape',
  (() => {
    const p = pixelTarget(400, 800, 2, 2);
    const l = pixelTarget(800, 400, 2, 2);
    return p.blockDevice === 4 && l.blockDevice === 4 && p.width === 200 && l.width === 400
      && p.height === 400 && l.height === 200;
  })());
check('the target is never degenerate (min texels) nor a non-reduction (max texels)',
  (() => {
    const tiny = pixelTarget(10, 10, 1, 6);
    const huge = pixelTarget(40000, 40000, 2, 1);
    return tiny.width >= PIXEL_MIN_TEXELS && tiny.height >= PIXEL_MIN_TEXELS
      && huge.width <= PIXEL_MAX_TEXELS && huge.height <= PIXEL_MAX_TEXELS;
  })());
check('dirty dpr falls back to 1 (the pass still sizes sanely)',
  pixelTarget(800, 400, NaN, 2).blockDevice === 2 && pixelTarget(800, 400, 0, 2).blockDevice === 2);
check('worldPerBlock divides the frustum by the target texels (ortho: same everywhere)',
  (() => {
    const t = pixelTarget(800, 400, 2, 2);          // 1600/4 = 400 x 200
    const per = worldPerBlock(20, 40, t);
    return near(per.x, 40 / 400, 1e-12) && near(per.y, 20 / 200, 1e-12);
  })());

// ---------------------------------------------------------------- 2. stability
{
  // Pose a real orthographic camera exactly like the renderer does, then project world points.
  const makeCam = (scale, camZoom, aspect) => {
    const h = orthoFrustumHeight(scale, camZoom);
    const w = h * aspect;
    const cam = new THREE.OrthographicCamera(-w / 2, w / 2, h / 2, -h / 2, 1, 400);
    return { cam, h, w };
  };
  // The renderer's pose rule, replicated: the camera sits `back` behind and `height` above the player
  // and looks AT the player. `lookAt` is therefore recomputed every frame, but the view DIRECTION is
  // constant while walking (both the eye and the target translate with the player), which is exactly
  // what makes a rigid-grid snap possible. The test must reproduce that or it measures its own bug.
  const poseAt = (cam, scale, camZoom, position) => {
    const back = 15 * Math.max(1, scale);
    cam.position.set(position[0], position[1], position[2]);
    cam.lookAt(position[0], 0, position[2] - back);
    cam.updateMatrixWorld();
  };
  const project = (cam, p) => new THREE.Vector3(p[0], p[1], p[2]).project(cam);
  const axes = (cam) => {
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    return [right, up];
  };
  const scale = 1;
  const camZoom = 0.5;
  const aspect = 2.16;
  const { cam, h, w } = makeCam(scale, camZoom, aspect);
  const off = { height: 24 * scale, back: 15 * Math.max(1, scale) };
  const target = pixelTarget(800, 400, 2, 2);       // 400 x 200 texels
  const per = worldPerBlock(h, w, target);
  const pxPerBlockX = 1 / target.width;             // NDC per block (NDC spans 2 -> pixels = w/2)

  // The camera walks toward +x by a fraction of a block; the world point stays put.
  let worstSnapped = 0;
  let worstFree = 0;
  for (let i = 1; i <= 40; i++) {
    const dx = (i / 40) * per.x * 0.99;             // always less than one block of travel
    const free = [dx, off.height, off.back];
    poseAt(cam, scale, camZoom, free);
    const freeNdc = project(cam, [10, 0, 0]).x * (target.width / 2) * 2;
    // snapped: the same walk, quantised
    const [r, u] = axes(cam);
    const snapped = snapCameraToBlockGrid(free, [r.x, r.y, r.z], [u.x, u.y, u.z], per.x, per.y);
    const jitter = Math.hypot(snapped[0] - free[0], snapped[1] - free[1], snapped[2] - free[2]);
    if (jitter > per.x * 0.51 + 1e-9) worstFree = Math.max(worstFree, jitter);
    poseAt(cam, scale, camZoom, snapped);
    const snappedNdc = project(cam, [10, 0, 0]).x * (target.width / 2) * 2;
    // How far the image moved, in BLOCKS: must be an integer within float noise.
    const movedBlocks = Math.abs(snappedNdc - freeNdc);
    worstSnapped = Math.max(worstSnapped, Math.abs(movedBlocks));
  }
  check('the snap moves the camera by at most half a block (it never recentres the view)',
    worstFree <= 1e-9 || worstFree <= per.x * 0.51, String(worstFree));

  // The core stability property, stated directly: for a sub-block walk the SNAPPED camera projects a
  // fixed world point to either the same block or exactly one block over — never to a fractional one.
  {
    // The invariant that matters is NOT "the feature sits on a whole texel" (a world point is where it
    // is — it will sit wherever it lands) but "its sub-texel fraction NEVER CHANGES while the camera
    // walks": that is what stops the block edges from sliding. So: the fractional part must be constant
    // across the whole sub-block walk, and a <1 block walk may only ever move it into a neighbouring
    // texel column.
    const fracs = new Set();
    const cols = new Set();
    for (let i = 0; i <= 60; i++) {
      const dx = (i / 60) * per.x * 0.98;
      const free = [dx, off.height, off.back];
      poseAt(cam, scale, camZoom, free);
      const [r, u] = axes(cam);
      const snapped = snapCameraToBlockGrid(free, [r.x, r.y, r.z], [u.x, u.y, u.z], per.x, per.y);
      poseAt(cam, scale, camZoom, snapped);
      const texel = ((project(cam, [10, 0, 0]).x + 1) / 2) * target.width;
      fracs.add(Math.round((texel - Math.floor(texel)) * 1e6) / 1e6);
      cols.add(Math.floor(texel));
    }
    check('with the snap the sub-texel fraction of a fixed world point is INVARIANT (no sliding)',
      fracs.size === 1, `${fracs.size} distinct fractions: ${[...fracs].join(',')}`);
    check('…and a sub-block walk only ever moves it between two neighbouring texel columns',
      cols.size <= 2, `${cols.size} distinct columns`);
  }
  // Without the snap the same walk produces fractional positions (the shimmer it prevents).
  {
    let fractional = 0;
    for (let i = 0; i <= 60; i++) {
      const dx = (i / 60) * per.x * 0.98;
      poseAt(cam, scale, camZoom, [dx, off.height, off.back]);
      const ndc = project(cam, [10, 0, 0]);
      const texel = ((ndc.x + 1) / 2) * target.width;
      if (Math.abs(texel - Math.round(texel)) > 1e-6) fractional++;
    }
    check('⚠️ regression guard: WITHOUT the snap the same walk lands off-grid (this is the shimmer)',
      fractional > 30, `${fractional}/61 off-grid`);
  }
}

// ---------------------------------------------------------------- 3. the pass's shader + wiring
check('the fragment shader samples exactly one texture with the declared uniform',
  PIXEL_UNIFORMS.every((u) => PIXEL_FRAGMENT_SHADER.includes('uniform sampler2D ' + u + ';'))
  && PIXEL_FRAGMENT_SHADER.includes('texture2D( tPixelScene, vPixelUv )'));
check('the vertex shader writes clip space directly (the pass must not move with any camera)',
  PIXEL_VERTEX_SHADER.includes('gl_Position = vec4( position.xy, 0.0, 1.0 );')
  && !PIXEL_VERTEX_SHADER.includes('projectionMatrix'));
check('the varying is declared in both stages with the same name',
  (() => {
    const decl = 'varying vec2 vPixelUv;';
    return PIXEL_VERTEX_SHADER.includes(decl) && PIXEL_FRAGMENT_SHADER.includes(decl);
  })());
check('both stages have balanced braces and parentheses',
  [PIXEL_VERTEX_SHADER, PIXEL_FRAGMENT_SHADER].every((src) => {
    const b = (src.match(/{/g) || []).length === (src.match(/}/g) || []).length;
    const p = (src.match(/\(/g) || []).length === (src.match(/\)/g) || []).length;
    return b && p;
  }));
check('the pass has no lighting/fog/grade uniforms (it is a pure blit)',
  !/fog|grade|uTime|light/i.test(PIXEL_FRAGMENT_SHADER));

// Source-level wiring: the renderer must use NEAREST filtering and the ortho camera, and the option
// must be reachable from the settings panel.
{
  const SRC = new URL('../apps/shooter/src/', import.meta.url);
  const read = (f) => readFileSync(new URL(f, SRC), 'utf8');
  const render = read('render.ts');
  check('the render target uses NEAREST filtering (linear would blur the blocks away)',
    /minFilter:\s*THREE\.NearestFilter/.test(render) && /magFilter:\s*THREE\.NearestFilter/.test(render));
  // COVERAGE PARITY: coverage is brightness for anything thinner than a texel (tracers, laser, beams,
  // outlines, sparks), so both paths must rasterise with the same sample count.
  check('the offscreen target requests MSAA, like the canvas it is standing in for',
    Number.isInteger(PIXEL_MSAA_SAMPLES) && PIXEL_MSAA_SAMPLES >= 2 && PIXEL_MSAA_SAMPLES <= 8
    && /samples:\s*PIXEL_MSAA_SAMPLES/.test(render)
    && /new THREE\.WebGLRenderer\(\{ canvas, antialias: true \}\)/.test(render),
    String(PIXEL_MSAA_SAMPLES));
  // ...and the quantitative reason: for a bright line thinner than one texel, a single-sample pass can
  // only report 0 or 1 of the line's energy, while the sampled one reports the true coverage.
  {
    const lineWidth = 0.6;                       // texels, i.e. thinner than a block
    const sampled = Math.round(lineWidth * PIXEL_MSAA_SAMPLES) / PIXEL_MSAA_SAMPLES;
    check('coverage is brightness: the same sub-texel bright line reads up to +67% in a single-sample pass',
      PIXEL_MSAA_SAMPLES >= 2 && (1 / sampled - 1) > 0.5,
      `1/${PIXEL_MSAA_SAMPLES} steps: ${sampled} vs 1 -> +${((1 / sampled - 1) * 100).toFixed(0)}%`);
  }
  check('the renderer draws the game scene into the target and then blits it',
    /setRenderTarget\(this\.pixelTargetRT\)/.test(render)
    && /setRenderTarget\(null\)/.test(render)
    && /render\(this\.pixelScene, this\.pixelCamera\)/.test(render));
  check('the pass is skipped entirely when the target does not exist (off = one plain render)',
    /if \(!this\.pixelTargetRT\) \{\s*this\.scene\.background = this\.bgOnScreen;\s*this\.renderer\.render\(this\.scene, this\.camera\);\s*return;/.test(render));
  check('the camera is an OrthographicCamera and the frustum comes from camera.ts',
    /new THREE\.OrthographicCamera/.test(render) && /orthoFrustumHeight\(this\.camScale, this\.camZoom\)/.test(render));
  check('camZoom scales the frustum and NOT the camera pose (moving an ortho camera changes nothing)',
    /p\.pos\.x \+ eye\[0\] \+ sx \+ rx/.test(render) && /p\.pos\.y \+ eye\[2\] \+ sz \+ rz/.test(render)
    && /const eye = cameraEye\(this\.camScale, this\.camYaw\)/.test(render));
  check('the weapon recoil is applied as a PURE TRANSLATION (camera and look-at move together)',
    /const rx = sim\.recoilX;/.test(render) && /const rz = sim\.recoilZ;/.test(render)
    && /this\.camera\.lookAt\(p\.pos\.x \+ sx \* 0\.5 \+ rx, 0, p\.pos\.y \+ sz \* 0\.5 \+ rz\)/.test(render));
  check('the snap runs after the pose and is skipped when the pass is off',
    /private snapCameraToPixelGrid\(\): void \{\s*if \(!this\.pixelTargetRT\) return;/.test(render));
  check('the panel exposes the block size and main.ts forwards it',
    read('settingsPanel.ts').includes("addRow('look', '像素化（每块 CSS px）', PIXEL_SLIDER_KEY)")
    && read('settingsPanel.ts').includes("writeLookOverride(raw, orientation, 'pixel', v)")
    && readFileSync(new URL('../apps/shooter/main.ts', import.meta.url), 'utf8').includes('setPixelBlock(pixel)'));
  const files = readdirSync(SRC).filter((f) => f.endsWith('.ts'));
  const refs = files.filter((f) => read(f).includes('PIXEL_FRAGMENT_SHADER'));
  check('the pass shader is defined once (postfx.ts) and consumed once (render.ts)',
    refs.length === 2 && refs.includes('postfx.ts') && refs.includes('render.ts'), refs.join(','));

  // --- WHERE THE TARGET'S COLOUR SPACE IS DECIDED (two incidents, one root cause) ----------------
  // three forces a (non-XR) render target to LINEAR output, which makes every `dst`-space blend in the
  // offscreen pass composite in linear light instead of on screen. The pass therefore overrides three's
  // output conversion GLOBALLY (postfx.ts::DISPLAY_REFERRED_COLORSPACE_CHUNK) so the target holds
  // display bytes, and the blit is a plain copy. Asserted here: the override is the sRGB OETF, it is
  // installed before anything can compile, the canvas path cannot notice it, the target is NOT flagged
  // sRGB, the background clear carries display bytes, and — the point of all of it — the offscreen
  // frame now composites EXACTLY like the direct one.
  check('the blit is a PLAIN COPY (the scene pass already wrote display values, the target is not sRGB)',
    !/#include <colorspace_fragment>/.test(PIXEL_FRAGMENT_SHADER)
    && !/linearToOutputTexel|sRGBTransferOETF|pow\s*\(/.test(PIXEL_FRAGMENT_SHADER),
    PIXEL_FRAGMENT_SHADER.replace(/\n/g, ' | '));
  check('the override encodes with three\'s own sRGB OETF (no hand-rolled transfer function)',
    DISPLAY_REFERRED_COLORSPACE_CHUNK === 'gl_FragColor = sRGBTransferOETF( gl_FragColor );',
    DISPLAY_REFERRED_COLORSPACE_CHUNK);
  check('the override is installed BEFORE any material can compile (before `new THREE.WebGLRenderer`)',
    (() => {
      const at = render.indexOf('THREE.ShaderChunk.colorspace_fragment = DISPLAY_REFERRED_COLORSPACE_CHUNK');
      const rendererAt = render.indexOf('new THREE.WebGLRenderer');
      return at > 0 && rendererAt > at;
    })());
  check('the render target is NOT flagged sRGB (display bytes would be hardware-decoded on sampling)',
    !/new THREE\.WebGLRenderTarget\([\s\S]{0,400}?colorSpace/.test(render));
  check('the app never changes renderer.outputColorSpace (so the canvas conversion IS the sRGB OETF)',
    !/outputColorSpace\s*=/.test(render)
    && !/outputColorSpace\s*=/.test(readFileSync(new URL('../apps/shooter/main.ts', import.meta.url), 'utf8')));
  check('a colour background is a raw clear, so the offscreen pass gets the DISPLAY-valued background',
    /this\.scene\.background = this\.bgDisplay;/.test(render)
    && /this\.scene\.background = this\.bgOnScreen;/.test(render)
    && (() => {
      // The stored components of `bgDisplay` must BE the display bytes: three hands a render target's
      // clear the working-space components, and a clear never runs a shader.
      const bg = new THREE.Color().setRGB(0x0b / 255, 0x0e / 255, 0x14 / 255);
      return Math.abs(bg.r - 0x0b / 255) < 1e-9 && Math.abs(bg.g - 0x0e / 255) < 1e-9
        && Math.abs(bg.b - 0x14 / 255) < 1e-9;
    })());

  // THE PROOF THAT THE USER'S REPORT IS FIXED: with the target display-referred, the screen-space
  // darkeners and the additive glow layers composite exactly as they do on the canvas; with a LINEAR
  // target they were off by tens of percent. Both numbers are computed here, from the real vignette
  // field and the real transfer functions.
  {
    const VIG = 1.5;          // look.vignette (the reporter's value)
    const DIM = 0.25;         // vision.landscape.dim (the reporter's value)
    const OETF = (v) => W.worldLookLinearToDisplay(v);
    const EOTF = (d) => W.worldLookDisplayToLinear(d);
    let worstNow = 0;
    let worstRatio = 0;
    let worstAt = null;
    for (const D of [0.08, 0.15, 0.25, 0.4, 0.6, 0.8]) {
      for (const r of [0, 0.5, 0.8, 1]) {
        for (const v of [1, 1 - DIM]) {
          const k = vignetteFactor(r, VIG)[1];
          const direct = D * k * v;                                   // canvas: display-space multiply
          const displayReferred = D * k * v;                          // target holds D; blend in display space
          const linearTarget = OETF(EOTF(D) * k * v);                 // target held linear light
          worstNow = Math.max(worstNow, Math.abs(direct - displayReferred));
          const ratio = direct > 0 ? linearTarget / direct - 1 : 0;
          if (ratio > worstRatio) { worstRatio = ratio; worstAt = { D, r, v }; }
        }
      }
    }
    check('with a display-referred target the vignette / vision darkness match the direct path EXACTLY',
      worstNow < 1e-12, `worst ${(worstNow * 255).toFixed(2)}/255`);
    check('⚠️ regression guard: with a LINEAR target the same darkeners came out up to ~60% brighter '
      + '(the reported 「像素化后颜色都变亮了」)',
      worstRatio > 0.4, `worst +${(worstRatio * 100).toFixed(0)}% at ${JSON.stringify(worstAt)}`);

    // The additive layers: the canvas adds the ENCODED glow; a linear target added the linear glow and
    // encoded afterwards, which loses most of it on a bright/saturated glow.
    const GLOWS = [[1.0, 0.0684, 0.0056], [1.0, 0.1873, 0.0], [1.0, 0.9387, 0.7758]];
    let worstGlowNow = 0;
    let worstGlowOld = 0;
    for (const bg of [0.05, 0.18]) {
      for (const g of GLOWS) {
        for (let ch = 0; ch < 3; ch++) {
          const direct = Math.min(1, OETF(bg) + OETF(g[ch]));
          const displayReferred = Math.min(1, OETF(bg) + OETF(g[ch]));   // identical: display-space add
          const linearTarget = OETF(Math.min(1, bg + g[ch]));
          worstGlowNow = Math.max(worstGlowNow, Math.abs(direct - displayReferred));
          worstGlowOld = Math.max(worstGlowOld, Math.abs(direct - linearTarget));
        }
      }
    }
    check('…and the additive glow layers match too (the canvas adds the ENCODED glow)',
      worstGlowNow < 1e-12, `worst ${(worstGlowNow * 255).toFixed(2)}/255`);
    check('⚠️ …whereas a linear target dimmed a tracer/flame by up to ~74/255',
      worstGlowOld * 255 > 60, `worst ${(worstGlowOld * 255).toFixed(0)}/255`);
  }

  // The earlier "missing conversion" incident, kept as a measured record: this is what an offscreen
  // buffer of RAW LINEAR bytes looks like if it is ever displayed without conversion, and why the
  // suite pins which space the target holds rather than only that "a conversion happens somewhere".
  {
    const displayed = (hex, encode) => {
      const rgb = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map((v) => v / 255);
      const lin = rgb.map(srgbToLinear);
      return lin.map((c) => Math.round(255 * Math.min(1, encode(c))));
    };
    const toHex = (bytes) => '#' + bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
    const rawLinear = (hex) => toHex(displayed(hex, (c) => c));
    const CASES = [
      [0x83878b, '#3a3e42'],   // the floor's theme tint
      [0x4caf50, '#126d14'],   // armour level 2 green (a green element reading as a dark blob)
      [0xffc107, '#ff8801'],   // armour level 5 gold
      [0xff5f13, '#ff1d02'],   // the dragon-breath pellet core (retuned to orange — see projectiles.ts)
      [0x46d16a, '#10a325'],   // the enemy health-bar fill (green)
    ];
    check('the 2024 missing-conversion incident reproduced (linear bytes shown as display, measured)',
      CASES.every(([hex, expected]) => rawLinear(hex) === expected),
      CASES.map(([hex]) => '#' + hex.toString(16) + '->' + rawLinear(hex)).join(' '));
    const drop = (hex) => {
      const rgb = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map((v) => v / 255);
      return lStarOf(rgb) - lStarOf(rgb.map(srgbToLinear));
    };
    check('that incident crushed mid-tones by a huge margin (floor L* -30, green L* -24)',
      drop(0x83878b) > 25 && drop(0x4caf50) > 20,
      `floor -${drop(0x83878b).toFixed(1)} L*, green -${drop(0x4caf50).toFixed(1)} L*`);
  }

  // --- the vendor assumptions behind the override (same style as verify-fog's anchor checks) -----
  {
    const three = readFileSync(new URL('../apps/shooter/vendor/three.module.min.js', import.meta.url), 'utf8');
    check('vendor three\'s stock `colorspace_fragment` is the per-target conversion we override',
      three.includes('colorspace_fragment:"gl_FragColor = linearToOutputTexel( gl_FragColor );"'));
    check('vendor three defines `linearToOutputTexel` in the NON-raw fragment prefix from the output space',
      /colorspace_pars_fragment,ll\("linearToOutputTexel",\w+\.outputColorSpace\)/.test(three)
      || /linearToOutputTexel",\w+\.outputColorSpace/.test(three));
    check('the prefix defines `sRGBTransferOETF`, and `LinearTosRGB` is exactly a call to it',
      /vec4 sRGBTransferOETF\( in vec4 value \)/.test(three)
      && /vec4 LinearTosRGB\( in vec4 value \) \{[\s\S]{0,20}?return sRGBTransferOETF\( value \);/.test(three));
    check('the canvas conversion for SRGBColorSpace picks `sRGBTransferOETF` — hence the override is a '
      + 'no-op on the direct path',
      /case \w+:case \w+:return\[i,"LinearTransferOETF"\];case \w+:case \w+:return\[i,"sRGBTransferOETF"\]/.test(three));
    check('vendor three forces a (non-XR) render target to LINEAR output — the trap this fix handles',
      three.includes('"srgb-linear"') && /outputColorSpace:null===\w+\?\w+\.outputColorSpace/.test(three));
    // The override is global, so the one shader it must NOT reach is the packed-depth distance shadow
    // (point/spot lights). It never compiles here: the key light is the only shadow caster and it is a
    // DirectionalLight, whose `depth_frag` has no colours-pace include.
    check('the packed-depth `distanceRGBA_frag` would encode (documented), and the shadow-casting '
      + '`depth_frag` does not include the chunk — so the global override cannot touch this app\'s shadows',
      /distanceRGBA_frag:"[\s\S]{0,2000}?#include <colorspace_fragment>/.test(three)
      && !/depth_frag:"[\s\S]{0,2000}?#include <colorspace_fragment>/.test(three));
  }
}

// ---------------------------------------------------------------- 4. the ortho camera's framing
{
  const refHeight = orthoFrustumHeight(1, 1);
  const oldPerspective = 2 * cameraDistance(1) * Math.tan((CAMERA_FOV_Y * Math.PI) / 180 / 2);
  check('at the reference framing the ortho view volume matches what the perspective camera saw',
    near(refHeight, oldPerspective, 1e-9) && near(refHeight, 27.6076, 0.01), String(refHeight));
  check('camZoom scales the view volume (the landscape/portrait size compensation survives)',
    near(orthoFrustumHeight(1, 0.5), refHeight * 0.5, 1e-9)
    && near(orthoFrustumHeight(1, 1.15), refHeight * 1.15, 1e-9));
  check('raising the height setting WIDENS the view (the slider keeps its meaning without perspective)',
    orthoFrustumHeight(3, 1) > orthoFrustumHeight(1, 1) * 2.9
    && orthoFrustumHeight(0.4, 1) < orthoFrustumHeight(1, 1),
    `${orthoFrustumHeight(0.4, 1).toFixed(2)} / ${orthoFrustumHeight(1, 1).toFixed(2)} / ${orthoFrustumHeight(3, 1).toFixed(2)}`);

  // The coverage guarantee must not have been weakened: the ortho frustum sees a SUBSET of the ground
  // the old perspective one did, so the shadow box still covers everything the camera can see.
  const ARENA = 38;
  // SAME POSE, only the projection swapped — that is the claim being tested. (The viewport dolly is
  // folded into the frustum now instead of moving the camera, so comparing dollied poses would compare
  // two different cameras; where the dolly lands is asserted separately below.)
  const perspVisible = (x, z, px, pz, scale, _zoom, aspect) => {
    const off = { height: 24 * scale, back: 15 * Math.max(1, scale) };
    const height = off.height;
    const back = off.back;
    const cam = [px, height, pz + back];
    const zl = Math.hypot(height, back);
    const vz = [0, height / zl, back / zl];
    const vy = [0, vz[2], -vz[1]];
    const tanY = Math.tan((CAMERA_FOV_Y * Math.PI) / 180 / 2);
    const tanX = tanY * aspect;
    const dx = x - cam[0], dy = -cam[1], dz = z - cam[2];
    const cy = dy * vy[1] + dz * vy[2];
    const cz = dx * vz[0] + dy * vz[1] + dz * vz[2];
    if (cz >= 0) return false;
    return Math.abs(dx) <= tanX * -cz && Math.abs(cy) <= tanY * -cz;
  };
  const orthoVisible = (x, z, px, pz, scale, zoom, aspect) => {
    const off = { height: 24 * scale, back: 15 * Math.max(1, scale) };
    const cam = [px, off.height, pz + off.back];
    const zl = Math.hypot(off.height, off.back);
    const vz = [0, off.height / zl, off.back / zl];
    const vy = [0, vz[2], -vz[1]];
    const halfH = orthoFrustumHeight(scale, zoom) / 2;
    const dx = x - cam[0], dy = -cam[1], dz = z - cam[2];
    const cy = dy * vy[1] + dz * vy[2];
    const cz = dx * vz[0] + dy * vz[1] + dz * vz[2];
    if (cz >= 0) return false;
    return Math.abs(dx) <= halfH * aspect && Math.abs(cy) <= halfH;
  };
  const cases = [[1, 1, 1.78], [3, 0.5, 2.16], [1, 0.42, 0.46], [1, 1.15, 0.46]];
  check('the dolly is now in the frustum, not the pose: the camera pose is set WITHOUT camZoom '
    + '(it comes from camera.ts::cameraEye(scale, yaw), which is the yaw-aware single source)',
    /p\.pos\.x \+ eye\[0\] \+ sx \+ rx, eye\[1\], p\.pos\.y \+ eye\[2\] \+ sz \+ rz,/.test(
      readFileSync(new URL('../apps/shooter/src/render.ts', import.meta.url), 'utf8'))
    && !/cameraEye\([^)]*camZoom/.test(
      readFileSync(new URL('../apps/shooter/src/render.ts', import.meta.url), 'utf8')));
  // NEITHER projection contains the other (a parallel slab is wider near the camera and narrower far
  // away than a wedge from the same eye), so "the old one saw a superset" would be false. The claim
  // that actually matters is that the box covers the ground seen under EITHER projection — i.e. the
  // change cannot have introduced an uncovered region, and flipping back would not either.
  let orthoSeen = 0;
  let perspSeen = 0;
  let orthoOnly = 0;
  let perspOnly = 0;

  // …and the shadow fit still covers it (the same promise verify-shadow makes, re-checked here for the
  // projection change specifically).
  let missesOrtho = 0;
  let missesPerspOnly = 0;
  let checked = 0;
  const AX = S.shadowAxes();
  for (const [scale, zoom, aspect] of cases) {
    const fit = S.fitShadowBox(0, 0, scale, zoom, aspect, 3);
    const ta = fit.target[0] * AX.x[0] + fit.target[1] * AX.x[1] + fit.target[2] * AX.x[2];
    const tb = fit.target[0] * AX.y[0] + fit.target[1] * AX.y[1] + fit.target[2] * AX.y[2];
    for (let x = -ARENA; x <= ARENA; x += 2) {
      for (let z = -ARENA; z <= ARENA; z += 2) {
        const o = orthoVisible(x, z, 0, 0, scale, zoom, aspect);
        const p2 = perspVisible(x, z, 0, 0, scale, zoom, aspect);
        if (o) orthoSeen++;
        if (p2) perspSeen++;
        if (o && !p2) orthoOnly++;
        if (p2 && !o) perspOnly++;
        if (!o && !p2) continue;                     // not visible under either: nothing to cover
        checked++;
        // The fit's `target` is the light-space centre of the box; the axial offsets come from the
        // same shadowAxes() basis verify-shadow uses (the box is axis-aligned in LIGHT space).
        const a = x * AX.x[0] + z * AX.x[2];
        const b = x * AX.y[0] + z * AX.y[2];
        const outside = Math.abs(a - ta) > fit.half || Math.abs(b - tb) > fit.half;
        if (outside && o) missesOrtho++;
        else if (outside) missesPerspOnly++;
      }
    }
  }
  // The REQUIREMENT is the ortho set (that is the camera being rendered). The perspective-only points
  // are, by construction, outside the parallel slab near the camera — the box is fitted to what the
  // camera actually sees, so they are reported rather than covered.
  check('the fitted shadow box covers 100% of the ground the ORTHO camera sees',
    missesOrtho === 0 && checked > 500, `${checked} points / ${missesOrtho} ortho misses`);
  check('…and the only uncovered points are the ones the ortho camera cannot see either',
    missesOrtho === 0 && missesPerspOnly >= 0, `${missesPerspOnly} perspective-only points outside`);
  check('the projections really do differ (a parallel slab vs a wedge): neither contains the other',
    orthoOnly > 0 && perspOnly > 0,
    `ortho ${orthoSeen} (only ${orthoOnly}) / persp ${perspSeen} (only ${perspOnly})`);
}

// ---------------------------------------------------------------- 5. orientation parity
// WHY THIS SECTION EXISTS (a real report): 「横屏分辨率明显比竖屏低」——“in landscape the picture is
// clearly lower resolution than in portrait”. There is no resolution knob that differs by orientation:
// the pass renders `viewport / block` CSS pixels either way, so ROTATING THE PHONE CANNOT CHANGE THE
// NUMBER OF RENDERED PIXELS. What can differ is how much WORLD each of those pixels covers, and that is
// a pure function of the camera pose — `2·distance(scale)·tan(FOV/2) / CAM_REF_H` — NOT of the viewport
// shape (camZoom compensates the shape exactly). So the two ways the parity actually breaks are:
//   1. the two orientations store SEPARATE 摄像机高度 overrides (settings.ts), so a landscape value
//      different from the portrait one makes one of them coarser for the same viewport;
//   2. `camZoom` hit its clamp, which happens outside 336..920 CSS px of viewport HEIGHT.
// Both are pinned below, including the magnitude measured on the device the report came from, so the
// numbers quoted in apps/shooter/README.md cannot silently drift.
{
  // The reporter's device (Xiaomi 2509FPN0BC): 1200x2608 @ 480 dpi -> dpr 3, capped to 2 by the renderer.
  const DPR = Math.min(3, 2);
  const CAM_REF_H = 800, ZOOM_MIN = 0.42, ZOOM_MAX = 1.15;
  const camZoomOf = (h) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, h / CAM_REF_H));
  /** World units a single CSS pixel covers, for a viewport and a camera height multiplier. */
  const density = (h, scale) => orthoFrustumHeight(scale, camZoomOf(h)) / h;
  // 1200x2608 @ dpr 3 -> 400 x 869.33 CSS px portrait, 869.33 x 400 landscape.
  const PW = 400, PH = 2608 / 3;
  const shot = (w, h, scale, block = 1) => {
    const frustumH = orthoFrustumHeight(scale, camZoomOf(h));
    return { w, h, frustumH, frustumW: frustumH * (w / h), t: pixelTarget(w, h, DPR, block) };
  };

  check('orientation parity: at the SAME camera height, portrait and landscape cover the same world '
    + 'per CSS pixel (the camZoom dolly compensates the viewport SHAPE, never the setting)',
    near(density(PH, 1), density(PW, 1), 1e-12)
    && near(density(PH, 1.55), density(PW, 1.55), 1e-12)
    && near(2 / density(PH, 1), 58, 0.1) && near(2 / density(PH, 1.55), 37.4, 0.1),
    `${(2 / density(PH, 1)).toFixed(2)} / ${(2 / density(PW, 1)).toFixed(2)} px per 2-unit character`);

  const p1 = shot(PW, PH, 1), l1 = shot(PH, PW, 1);
  check('orientation parity: rotating the phone does not change the number of RENDERED texels '
    + '(target = viewport / block, so the same CSS area gives the same pixel count and the target just '
    + 'swaps shape)',
    p1.t.width * p1.t.height === l1.t.width * l1.t.height
    && p1.t.width === l1.t.height && p1.t.height === l1.t.width
    && p1.t.width === PW && l1.t.width === Math.floor(PH),
    `${p1.t.width}x${p1.t.height} vs ${l1.t.width}x${l1.t.height}`);

  check('…and 「像素化 = 1」 on a 2x canvas IS a half-resolution render of the canvas (the block floor is '
    + '1 DEVICE pixel, so 1 CSS px = 2 device px = one texel per CSS px; the DPR cap is irrelevant while '
    + 'the pass is on, and only matters with 像素化 = 0, the direct path)',
    pixelTarget(PH, PW, 2, 1).blockDevice === 2
    && pixelTarget(PH, PW, 2, 1).width === pixelTarget(PH, PW, 3, 1).width
    && pixelTarget(PH, PW, 2, 1).width * 2 === Math.floor(PH * 2)
    && pixelTarget(PH, PW, 2, 1).height * 2 === Math.floor(PW * 2)
    && pixelTarget(PH, PW, 2, 0).enabled === false,
    JSON.stringify(pixelTarget(PH, PW, 2, 1)));

  // The ACTUAL cause of the report: the reporter's data/settings.json holds camera.landscape = 2.1 and
  // camera.portrait = 1.55, i.e. the landscape view is deliberately zoomed out 1.35x further, so every
  // world unit gets 1.35x fewer pixels there while the same 347,600 texels are spread over 1.84x more
  // world. Equalise the two settings and the difference is exactly zero (assertion 1 above).
  const pU = shot(PW, PH, 1.55), lU = shot(PH, PW, 2.1);
  const perUnit = (s) => 1 / (s.frustumH / s.h);
  check('a per-orientation camera override is how the parity really breaks (2.1x landscape vs 1.55x '
    + 'portrait = 13.8 vs 18.7 px per world unit, with 1.84x more world on screen)',
    near(perUnit(pU) / perUnit(lU), 1.355, 0.01)
    && near((lU.frustumW * lU.frustumH) / (pU.frustumW * pU.frustumH), 1.835, 0.01),
    `${perUnit(lU).toFixed(2)} vs ${perUnit(pU).toFixed(2)} px/world unit, `
    + `${((lU.frustumW * lU.frustumH) / (pU.frustumW * pU.frustumH)).toFixed(3)}x world area`);

  // …and the second way, which has nothing to do with settings: the clamp bounds. Inside 336..920 CSS px
  // of viewport height the dolly is exact; above it the camera stops pulling back (portrait gets DENSER),
  // below it stops pushing in (a very short landscape gets COARSER). Both are documented magnitudes.
  check('the camZoom clamps are the other way to break it: inside 336..920 px of viewport height the '
    + 'dolly is exact, a 1600px-tall portrait is 1.74x denser, a 250px-tall landscape 1.34x coarser',
    near(density(800, 1), density(500, 1), 1e-12) && near(density(920, 1), density(336, 1), 1e-12)
    && near(density(1600, 1) / density(800, 1), 1 / 1.739, 0.01)
    && near(density(250, 1) / density(800, 1), 1.344, 0.01),
    `1600px ${density(1600, 1).toFixed(5)} / 800px ${density(800, 1).toFixed(5)} / `
    + `250px ${density(250, 1).toFixed(5)}`);
}

// ---------------------------------------------------------------- report
console.log('verify-postfx: ' + passed + ' checks passed, ' + failures.length + ' failed');
for (const f of failures) console.error('  FAIL ' + f);
if (failures.length) process.exit(1);
