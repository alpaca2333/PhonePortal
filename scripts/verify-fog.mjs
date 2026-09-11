/**
 * CPU-side verification for the shooter's height fog (「加一点高度雾」).
 *
 * There is no GPU in this environment, so "does the fog LOOK right" (and even "does the patched GLSL
 * compile") can only be confirmed on a device. What CAN be proven here is everything up to that line,
 * which is most of the risk:
 *
 *   1. THE ANCHORS EXIST in the vendored three r160 build, exactly once, in every lit material:
 *      `#include <project_vertex>` (vertex) and `#include <colorspace_fragment>` (fragment). This is the
 *      failure mode that would otherwise be silent: `String.replace` on a renamed chunk is a no-op, and
 *      the fog would simply never appear.
 *   2. THE INJECTION LANDS WHERE THE MODEL SAYS: the mix is inserted on the LEFT of
 *      `colorspace_fragment` — the one line whose expansion depends on the render target (`srgb` for the
 *      canvas, `srgb-linear` for the pixelation pass) — inside worldlook.ts's explicit
 *      `LinearTosRGB -> look -> sRGB EOTF` wrap. So the mix really does see "what you see" display
 *      values on BOTH paths, which is why the fog colour is a raw hex value and not a THREE.Color. The
 *      wrap's inverse is hand-written (the vendored build has no display->linear function), so its
 *      accuracy against three's own `sRGBTransferOETF` is asserted here numerically.
 *   3. THE WORLD-POSITION MATH IS THE ENGINE'S OWN: the injected capture is compared, whitespace- and
 *      identifier-normalised, against `ShaderChunk.worldpos_vertex` — including the USE_BATCHING and
 *      USE_INSTANCING branches (props are InstancedMesh, so omitting that branch would fog them all as
 *      if they stood at the world origin).
 *   4. IT FAILS SAFE: a missing or duplicated anchor returns {ok:false} with the source untouched, and
 *      toon.ts applies nothing in that case (a HALF patch would not compile — a fragment body with no
 *      vertex-declared varyings).
 *   5. THE JS MATH IS THE GLSL MATH: `fogFactor()` is the reference implementation and is checked
 *      against hand-computed values, monotonicity in y/depth/density, the readability clamp, and 0.
 *   6. ONE PLACE BUILDS A LIT MATERIAL: `new THREE.MeshToonMaterial` may appear only in toon.ts, and
 *      `registerHeightFog` may be referenced only there — so a new prop/character cannot be added
 *      "toon but unfogged". Unlit effect materials are patched nowhere, by construction.
 *
 * Run:  npm run build && node scripts/verify-fog.mjs
 * Exit code is non-zero when any assertion fails.
 */
import { readFileSync, readdirSync } from 'node:fs';

const FOG = new URL('../dist/apps/shooter/src/fog.js', import.meta.url);
const THREE_URL = new URL('../dist/apps/shooter/vendor/three.module.min.js', import.meta.url);
const SRC_DIR = new URL('../apps/shooter/src/', import.meta.url);

const F = await import(FOG.href);
const W = await import(new URL('../dist/apps/shooter/src/worldlook.js', import.meta.url).href);
const G = await import(new URL('../dist/apps/shooter/src/grade.js', import.meta.url).href);
const THREE = await import(THREE_URL.href);

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail ? ' — ' + detail : ''));
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------- 1 + 2. anchors
const LIT = ['toon', 'basic', 'lambert', 'standard', 'physical'];
const count = (src, needle) => src.split(needle).length - 1;

check('the vendored three is the revision the patch was written against (r160)',
  String(THREE.REVISION) === '160', String(THREE.REVISION));
check('the two anchors exist as chunks',
  typeof THREE.ShaderChunk.project_vertex === 'string'
  && typeof THREE.ShaderChunk.colorspace_fragment === 'string');
check('the fragment anchor is defined in exactly one place per module (and the three agree)',
  F.FOG_FRAGMENT_ANCHOR === '#include <colorspace_fragment>'
  && G.GRADE_FRAGMENT_ANCHOR === F.FOG_FRAGMENT_ANCHOR
  && W.WORLD_LOOK_FRAGMENT_ANCHOR === F.FOG_FRAGMENT_ANCHOR,
  `${F.FOG_FRAGMENT_ANCHOR} / ${G.GRADE_FRAGMENT_ANCHOR} / ${W.WORLD_LOOK_FRAGMENT_ANCHOR}`);

for (const name of LIT) {
  const lib = THREE.ShaderLib[name];
  const v = String(lib.vertexShader);
  const f = String(lib.fragmentShader);
  check(`ShaderLib.${name}: exactly one <project_vertex> and it really is a vertex include`,
    count(v, F.FOG_VERTEX_ANCHOR) === 1 && count(f, F.FOG_FRAGMENT_ANCHOR) === 1,
    `${count(v, F.FOG_VERTEX_ANCHOR)} vertex / ${count(f, F.FOG_FRAGMENT_ANCHOR)} fragment`);

  const pv = F.patchHeightFogVertexShader(v);
  const pf = W.patchWorldLookFragmentShader(f);
  check(`ShaderLib.${name}: both patches apply (ok === true)`, pv.ok && pf.ok, `${pv.ok}/${pf.ok}`);
  check(`ShaderLib.${name}: the varyings are declared and the capture is inserted`,
    pv.src.includes('varying float vHeightFogY;')
    && pv.src.includes('vHeightFogDepth = - mvPosition.z;')
    && pv.src.indexOf('hfWorldPosition') > pv.src.indexOf(F.FOG_VERTEX_ANCHOR),
    'anchors/varyings');
  check(`ShaderLib.${name}: the mix lands BEFORE the output-space include (== display space here)`,
    pf.src.includes('gl_FragColor.rgb = mix( gl_FragColor.rgb, uFogColor')
    && pf.src.indexOf('uFogColor, min') < pf.src.indexOf(F.FOG_FRAGMENT_ANCHOR),
    'mix position');
  // The fog's own contract: it must be handed a DISPLAY value, so the encode has to come before it, and
  // the decode after it (see worldlook.ts).
  check(`ShaderLib.${name}: the mix sits between the explicit encode and decode of the wrap`,
    pf.src.indexOf('LinearTosRGB( vec4( wlLinear, 1.0 ) )') < pf.src.indexOf('uFogColor, min')
    && pf.src.indexOf('uFogColor, min') < pf.src.indexOf('worldLookDisplayToLinear( wlDisplay )'));
}

// The anchor is the colours-space include itself: three expands it per render target, so it is the only
// line where "which space am I in" is decided — and the whole world look now sits on its left.
{
  const f = String(THREE.ShaderLib.toon.fragmentShader);
  const includes = f.split('\n').filter((l) => l.includes('#include')).map((l) => l.trim());
  check('colorspace_fragment appears exactly once and is NOT the last include (the world look is not '
    + 'the last pass any more — it must precede the conversion)',
    includes.filter((i) => i === '#include <colorspace_fragment>').length === 1
    && includes[includes.length - 1] !== '#include <colorspace_fragment>',
    includes.join(' '));
  check('three converts to the output colour space inside the shader (not via the framebuffer)',
    String(THREE.ShaderChunk.colorspace_fragment) === 'gl_FragColor = linearToOutputTexel( gl_FragColor );');
  check('the vendored build generates `linearToOutputTexel` from `LinearTosRGB` for sRGB output, and '
    + 'that function IS in the non-raw fragment prefix (the forward half of the wrap reuses it)',
    /vec4 LinearTosRGB\( in vec4 value \) \{\s*return sRGBTransferOETF\( value \);/.test(String(THREE.ShaderChunk.colorspace_pars_fragment))
    && /colorspace_pars_fragment,ll\("linearToOutputTexel"/.test(
      readFileSync(THREE_URL, 'utf8')));
  check('the vendored build has NO display->linear function (the half this patch has to hand-write)',
    !/(sRGBTransferEOTF|sRGBToLinear)\s*\(/.test(String(THREE.ShaderChunk.colorspace_pars_fragment)));
  // The hand-written inverse, against three's own OETF: the round trip must be far below one 8-bit step
  // (the canvas path does encode -> look -> decode -> three encodes again, so an error here would be
  // baked into every lit pixel on screen).
  check('the hand-written sRGB EOTF inverts three\'s `sRGBTransferOETF` to better than 1/255 over 0..1',
    W.worldLookRoundTripError() < 1 / 255, String(W.worldLookRoundTripError()));
  check('…and it agrees with the standard sRGB curve at the reference points',
    near(W.worldLookDisplayToLinear(0), 0, 1e-12) && near(W.worldLookDisplayToLinear(1), 1, 1e-9)
    && near(W.worldLookDisplayToLinear(0.5), 0.214041140482, 1e-6)
    && near(W.worldLookDisplayToLinear(0.04045), 0.0031308, 1e-7),
    `${W.worldLookDisplayToLinear(0.5)} / ${W.worldLookDisplayToLinear(0.04045)}`);
  check('the GLSL of the wrap is what the JS mirror mirrors (same branch point and exponent)',
    W.WORLD_LOOK_FRAGMENT_DECLS.includes('pow( ( c + 0.055 ) / 1.055, vec3( 2.4 ) )')
    && W.WORLD_LOOK_FRAGMENT_DECLS.includes('step( vec3( 0.04045 ), c )')
    && W.WORLD_LOOK_FRAGMENT_DECLS.includes('c / 12.92'));
  check('the encode is three\'s own `LinearTosRGB` with NO clamp (so the canvas path is bit-identical '
    + 'to what it was), and the DECODE clamps (pow() needs a bounded, non-negative input)',
    W.WORLD_LOOK_ENCODE_BODY.includes('gl_FragColor.rgb = LinearTosRGB( gl_FragColor ).rgb;')
    && !W.WORLD_LOOK_ENCODE_BODY.includes('clamp(')
    && W.WORLD_LOOK_DECODE_BODY.includes('clamp( gl_FragColor.rgb, 0.0, 1.0 )'));
}

// ---------------------------------------------------------------- 2b. the two paths must AGREE
// The whole point of injecting on the left of `colorspace_fragment` inside the encode/decode wrap: the
// same surface must come out the same whether the scene goes straight to the canvas or through the
// pixelation pass's render target. Both pipelines are modelled here exactly as the shader now runs
// them, and compared on the DISPLAYED (framebuffer-clamped) bytes. The old placement (after the
// colorspace include) is kept as a regression guard, so the metric is proven to measure something.
{
  const FOG_RGB = [0x25 / 255, 0x30 / 255, 0x3d / 255];
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const shown = (a) => a.map(clamp01);
  const mixv = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  const oetf = (v) => W.worldLookLinearToDisplay(v);         // three's LinearTosRGB
  const eotf = (d) => W.worldLookDisplayToLinear(d);         // the hand-written inverse
  const q8 = (v) => Math.round(clamp01(v) * 255) / 255;      // 8-bit UNORM render target
  // NEW (this patch): encode -> fog -> grade -> decode, then three's own output include. The encode is
  // three's own `LinearTosRGB` and is deliberately UNCLAMPED — exactly what the canvas path did before
  // this wrap existed, which is what makes "the direct path did not move" provable below.
  const encode = (L) => L.map((v) => oetf(v));
  const look = (d, f, s) => G.gradeDisplay(mixv(d, FOG_RGB, f), s);
  const newPath = (L, f, s, viaTarget) => {
    const d = look(encode(L), f, s).map(clamp01);
    const lin = d.map((v) => (viaTarget ? q8(eotf(v)) : eotf(v)));
    return shown(lin.map(oetf));                             // the include (+ the blit for the target)
  };
  // OLD: the look ran after the include, i.e. on linear values when a render target was bound. (`look`
  // applies the fog itself, so these pass it the raw value — double-fogging here was a bug in the first
  // version of this model, and it produced a spectacular "old path is black" number.)
  const oldPath = (L, f, s, viaTarget) => {
    if (viaTarget) return shown(look(L, f, s).map((v) => oetf(clamp01(v))));
    return shown(look(L.map(oetf), f, s));
  };
  const bytesEqual = (a, b) => a.every((v, i) => Math.round(clamp01(v) * 255) === Math.round(clamp01(b[i]) * 255));
  const G_ = [0.05, 0.1, 0.16, 0.25, 0.5, 0.9];
  const LINEAR = [];
  for (const v of G_) LINEAR.push([v, v, v]);
  LINEAR.push([0.816, 0.498, 0.304], [0.159, 0.139, 0.126]);
  const HDR = [[1.4, 1.4, 1.4], [3, 3, 3], [9, 9, 9], [2.905, 0.34, 0.145], [9.811, 6.567, 2.917]];
  const depths = [3, 20, 40, 70];
  const strengths = [0, 1, 1.5, 2];
  let worst = 0, worstAt = null, oldWorst = 0, oldAt = null;
  let canvasSame = 0, canvasTotal = 0, canvasWorst = 0, canvasAt = null;
  for (const L of LINEAR.concat(HDR)) for (const depth of depths) for (const s of strengths) {
    const f = F.fogFactor(depth, 0, F.FOG_DENSITY_DEFAULT);
    const a = newPath(L, f, s, false), b = newPath(L, f, s, true);
    const d = Math.max(...a.map((v, i) => Math.abs(v - b[i])));
    if (d > worst) { worst = d; worstAt = { L, depth, s, a, b }; }
    const oa = oldPath(L, f, s, false), ob = oldPath(L, f, s, true);
    const od = Math.max(...oa.map((v, i) => Math.abs(v - ob[i])));
    if (od > oldWorst) { oldWorst = od; oldAt = { L, depth, s }; }
    // The DIRECT path must not have moved (byte-identical): the wrap encloses the look and three then
    // re-encodes with the very function this model used, so the only difference is the encode/decode
    // round trip (|error| ~1e-5, i.e. below the 1/255 the framebuffer sees).
    const cd = Math.max(...oa.map((v, i) => Math.abs(v - a[i])));
    canvasTotal++;
    if (bytesEqual(oa, a)) canvasSame++;
    if (cd > canvasWorst) { canvasWorst = cd; canvasAt = { L, depth, s, old: oa, now: a }; }
  }
  check('the two render paths agree on the displayed colour (world look is space-invariant), to within '
    + 'the 8-bit linear render target\'s own quantisation',
    worst <= 3.5 / 255,
    `worst ${(worst * 255).toFixed(1)}/255 at ${worstAt && JSON.stringify({ L: worstAt.L, depth: worstAt.depth, s: worstAt.s, canvas: worstAt.a.map((v) => v.toFixed(3)), target: worstAt.b.map((v) => v.toFixed(3)) })}`);
  check('…and the DIRECT (canvas) path is byte-identical on EVERY sample, super-white ones included: '
    + 'this round changed the space the look runs in without changing what the canvas already showed',
    canvasSame === canvasTotal && canvasWorst <= 1 / 255,
    `${canvasSame}/${canvasTotal} byte-equal, worst ${(canvasWorst * 255).toFixed(2)}/255 at ${canvasAt && JSON.stringify({ L: canvasAt.L, depth: canvasAt.depth, s: canvasAt.s })}`);
  check('⚠️ regression guard: with the OLD placement (after the colorspace include) the same samples '
    + 'differed by up to ~34/255, so the metric above measures something real',
    oldWorst > 20 / 255,
    `worst ${(oldWorst * 255).toFixed(1)}/255 at ${oldAt && JSON.stringify({ L: oldAt.L, depth: oldAt.depth, s: oldAt.s })}`);
}

// ---------------------------------------------------------------- 3. world-position math
{
  const engine = String(THREE.ShaderChunk.worldpos_vertex)
    .replace(/^#if[^\n]*\n/, '')     // the outer #if condition line
    .replace(/\n#endif\s*$/, '')     // …and its matching #endif
    .replace(/\bworldPosition\b/g, 'hfWorldPosition')
    .replace(/\s+/g, '');
  const mine = F.FOG_VERTEX_BODY.replace(/\s+/g, '');
  check('the injected world-position expression is the engine\'s own worldpos_vertex formula',
    mine.includes(engine), engine.slice(0, 60));
  check('…including the instancing branch (props are InstancedMesh, so it is load-bearing)',
    mine.includes('#ifdefUSE_INSTANCINGhfWorldPosition=instanceMatrix*hfWorldPosition;#endif'));
  check('…and the batching branch the vendored r160 added',
    mine.includes('#ifdefUSE_BATCHINGhfWorldPosition=batchingMatrix*hfWorldPosition;#endif'));
  check('the fog depth uses the same quantity three\'s own fog does (-mvPosition.z)',
    mine.includes('vHeightFogDepth=-mvPosition.z;')
    && String(THREE.ShaderChunk.fog_vertex).replace(/\s+/g, '').includes('vFogDepth=-mvPosition.z;'));
}

// ---------------------------------------------------------------- 4. fail-safe patching
{
  const noAnchor = F.patchHeightFogVertexShader('void main() {}');
  check('a missing vertex anchor -> ok:false and the source is returned untouched',
    noAnchor.ok === false && noAnchor.src === 'void main() {}');
  const dupAnchor = F.patchHeightFogVertexShader(F.FOG_VERTEX_ANCHOR + '\n' + F.FOG_VERTEX_ANCHOR);
  check('a duplicated vertex anchor -> ok:false (ambiguous injection point)',
    dupAnchor.ok === false && dupAnchor.src.includes(F.FOG_VERTEX_ANCHOR + '\n' + F.FOG_VERTEX_ANCHOR));
  const noFrag = W.patchWorldLookFragmentShader('void main() {}');
  check('a missing fragment anchor -> ok:false and the source is returned untouched',
    noFrag.ok === false && noFrag.src === 'void main() {}');
  const dupFrag = W.patchWorldLookFragmentShader(
    W.WORLD_LOOK_FRAGMENT_ANCHOR + '\n' + W.WORLD_LOOK_FRAGMENT_ANCHOR);
  check('a duplicated fragment anchor -> ok:false (ambiguous injection point, no half patch)',
    dupFrag.ok === false);
}

// ---------------------------------------------------------------- 5. the math
check('the shipped density is inside the slider range and is a subtle default (not the max)',
  F.FOG_DENSITY_DEFAULT > F.FOG_DENSITY_MIN && F.FOG_DENSITY_DEFAULT < F.FOG_DENSITY_MAX / 2,
  String(F.FOG_DENSITY_DEFAULT));
check('clampFogDensity: 0 is legal (off), the range clamps, dirty data -> the shipped default',
  F.clampFogDensity(0) === 0 && F.clampFogDensity(-1) === 0
  && F.clampFogDensity(99) === F.FOG_DENSITY_MAX
  && F.clampFogDensity(NaN) === F.FOG_DENSITY_DEFAULT
  && F.clampFogDensity(Infinity) === F.FOG_DENSITY_DEFAULT
  && F.clampFogDensity('0.02') === F.FOG_DENSITY_DEFAULT);
check('fogPercent: 0 -> 0%, default -> ~27%, max -> 100%',
  F.fogPercent(0) === 0 && F.fogPercent(F.FOG_DENSITY_MAX) === 100
  && F.fogPercent(F.FOG_DENSITY_DEFAULT) === Math.round((F.FOG_DENSITY_DEFAULT / F.FOG_DENSITY_MAX) * 100),
  String(F.fogPercent(F.FOG_DENSITY_DEFAULT)));

check('fogHeightScale(0) = 1 exactly (the density constant IS the floor density)',
  F.fogHeightScale(F.FOG_BASE_Y) === 1);
check('…and below the base it stays 1 (nothing is "more fogged than the floor")',
  F.fogHeightScale(-5) === 1);
check('fogHeightScale(2) = exp(-0.36) = 0.6977 (a character keeps ~70% of the floor density)',
  near(F.fogHeightScale(F.FOG_BASE_Y + 2), Math.exp(-F.FOG_HEIGHT_FALLOFF * 2), 1e-12)
  && near(F.fogHeightScale(2), 0.697676326071031, 1e-12), String(F.fogHeightScale(2)));
check('fogHeightScale decreases with height',
  [0, 1, 2, 3, 5].every((y, i, a) => i === 0 || F.fogHeightScale(y) < F.fogHeightScale(a[i - 1])));
check('fogHeightScale with no falloff is plain 1 (falloff = 0 is distance fog)',
  near(Math.exp(-0 * 3), 1, 1e-12));

check('fogFactor(0 density) = 0 at any depth/height (the off switch is exact)',
  F.fogFactor(0, 0, 0) === 0 && F.fogFactor(60, 0, 0) === 0 && F.fogFactor(60, 3, 0) === 0);
check('fogFactor matches the hand-computed reference at the floor, 40 units out',
  near(F.fogFactor(40, 0, 0.016), 1 - Math.exp(-Math.pow(0.016 * 40, 2)), 1e-12)
  && near(F.fogFactor(40, 0, 0.016), 0.33600, 1e-4), String(F.fogFactor(40, 0, 0.016)));
check('…and at head height (2 units up) it is less: 0.180756 vs 0.3360',
  near(F.fogFactor(40, 2, 0.016), 0.180756334939, 1e-9)
  && F.fogFactor(40, 2, 0.016) < F.fogFactor(40, 0, 0.016),
  String(F.fogFactor(40, 2, 0.016)));
check('fogFactor increases with depth', [5, 15, 25, 35, 45].every((z, i, a) =>
  i === 0 || F.fogFactor(z, 0, 0.016) > F.fogFactor(a[i - 1], 0, 0.016)));
check('fogFactor increases with density', [0.005, 0.01, 0.016, 0.03].every((d, i, a) =>
  i === 0 || F.fogFactor(40, 0, d) > F.fogFactor(40, 0, a[i - 1])));
check('fogFactor decreases with height at a fixed depth', [0, 1, 2, 3].every((y, i, a) =>
  i === 0 || F.fogFactor(40, y, 0.016) < F.fogFactor(40, a[i - 1], 0.016)));
check('the readability clamp caps the fog at FOG_MAX_OPACITY (distant floor and enemies stay legible)',
  F.FOG_MAX_OPACITY === 0.6 && F.fogFactor(200, 0, 0.06) === F.FOG_MAX_OPACITY
  && near(F.fogFactor(200, 0, 0.06), 0.6, 1e-12), String(F.fogFactor(200, 0, 0.06)));
check('the default density never reaches the clamp inside the arena (max ~45 units)',
  F.fogFactor(45, 0, F.FOG_DENSITY_DEFAULT) < F.FOG_MAX_OPACITY,
  String(F.fogFactor(45, 0, F.FOG_DENSITY_DEFAULT)));
check('the fog is strong enough to be VISIBLE at the far edge with the shipped default (>15%)',
  F.fogFactor(45, 0, F.FOG_DENSITY_DEFAULT) > 0.15, String(F.fogFactor(45, 0, F.FOG_DENSITY_DEFAULT)));

// ---------------------------------------------------------------- declared == referenced
{
  const body = F.FOG_FRAGMENT_BODY;
  const declared = new Set(F.FOG_UNIFORMS.concat(F.FOG_VARYINGS));
  const used = new Set((body.match(/[uv][A-Za-z]*Fog[A-Za-z]*|vHeightFog[A-Za-z]*/g) || []));
  const missing = [...used].filter((n) => !declared.has(n));
  check('every uniform/varying the fragment body references is declared (and names match fog.ts)',
    missing.length === 0, missing.join(','));
  check('the fragment declarations declare exactly the exported uniform + varying names',
    F.FOG_FRAGMENT_DECLS.includes('uniform vec3 uFogColor;')
    && F.FOG_UNIFORMS.every((u) => F.FOG_FRAGMENT_DECLS.includes('uniform float ' + u + ';')
      || F.FOG_FRAGMENT_DECLS.includes('uniform vec3 ' + u + ';'))
    && F.FOG_VARYINGS.every((v) => F.FOG_FRAGMENT_DECLS.includes('varying float ' + v + ';')
      && F.FOG_VERTEX_DECLS.includes('varying float ' + v + ';')));
  const balanced = (s) => {
    let depth = 0;
    for (const ch of s.replace(/\/\/[^\n]*/g, '')) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      if (depth < 0) return false;
    }
    return depth === 0;
  };
  check('the injected GLSL bodies have balanced braces',
    balanced(F.FOG_VERTEX_BODY) && balanced(F.FOG_FRAGMENT_BODY));
  // Every `(` needs a `)` — the classic typo in hand-written GLSL.
  check('the injected GLSL bodies have balanced parentheses',
    [F.FOG_VERTEX_BODY, F.FOG_FRAGMENT_BODY, F.FOG_FRAGMENT_DECLS].every((s) =>
      (s.match(/\(/g) || []).length === (s.match(/\)/g) || []).length));
  check('the injected bodies carry no `#include` and no stray `#endif`',
    !F.FOG_VERTEX_BODY.includes('#include') && !F.FOG_FRAGMENT_BODY.includes('#include')
    && (F.FOG_VERTEX_BODY.match(/#ifdef/g) || []).length === (F.FOG_VERTEX_BODY.match(/#endif/g) || []).length);
}

// ---------------------------------------------------------------- 6. one construction site
{
  const files = readdirSync(SRC_DIR).filter((f) => f.endsWith('.ts'));
  const read = (f) => readFileSync(new URL(f, SRC_DIR), 'utf8');
  const ctors = files.filter((f) => read(f).includes('new THREE.MeshToonMaterial'));
  check('the only place that constructs a lit material is toon.ts',
    ctors.length === 1 && ctors[0] === 'toon.ts', ctors.join(','));
  const fogRefs = files.filter((f) => read(f).includes('registerWorldLook'));
  check('the only file referencing registerWorldLook is toon.ts (unlit materials are never patched)',
    fogRefs.length === 1 && fogRefs[0] === 'toon.ts', fogRefs.join(','));
  const toon = read('toon.ts');
  check('createToonMaterial applies the world-look patch (a new prop cannot be "toon but unfogged")',
    /export function createToonMaterial[\s\S]{0,400}?registerWorldLook\(/.test(toon));
  // The raw `#include <project_vertex>` string legitimately also appears in toon.ts: the outline hull
  // (addOutline) inserts its vertex offset at the same anchor and predates this feature. That is fine
  // ONLY because outlines are unlit and therefore never fog-patched — what must never happen is a
  // second copy of the FOG body, so that is what is asserted.
  const anchorRefs = files.filter((f) => read(f).includes('#include <project_vertex>')).sort();
  check('the raw anchor string is used only by fog.ts and by the pre-existing outline hull in toon.ts',
    anchorRefs.length === 2 && anchorRefs[0] === 'fog.ts' && anchorRefs[1] === 'toon.ts',
    anchorRefs.join(','));
  const bodyRefs = files.filter((f) => read(f).includes('vHeightFogY = hfWorldPosition.y;'));
  check('the injected GLSL body exists in exactly one file (no duplicated copy to drift)',
    bodyRefs.length === 1 && bodyRefs[0] === 'fog.ts', bodyRefs.join(','));
  check('the fog colour is NOT built with THREE.Color (it is mixed in output space)',
    toon.includes('FOG_COLOR >> 16') && !/new THREE\.Color\(\s*FOG_COLOR\s*\)/.test(toon));
  check('the shared density uniform is a single object, so one assignment drives every material',
    /const FOG_UNIFORMS = \{[\s\S]*uFogDensity: \{ value: 0 \}/.test(toon)
    && /setHeightFogDensity[\s\S]{0,200}?FOG_UNIFORMS\.uFogDensity\.value = clampFogDensity/.test(toon));

  // THE CLONE TRAP, proved against the real three rather than asserted from memory: Material.clone()
  // drops the instance-level onBeforeCompile (so the patch disappears) but keeps userData (so the
  // material still looks patched). Characters are material clones, so without the re-register in
  // cloneInstanceMaterials they would be the only unfogged things on screen.
  {
    const src = new THREE.MeshToonMaterial();
    src.onBeforeCompile = () => { /* marker function */ };
    src.userData.__worldLook = true;
    const copy = src.clone();
    check('three r160: Material.clone() does NOT carry onBeforeCompile (the trap is real)',
      copy.onBeforeCompile !== src.onBeforeCompile, String(copy.onBeforeCompile === src.onBeforeCompile));
    check('three r160: …but it DOES deep-copy userData (so the clone still looks patched)',
      copy.userData !== src.userData && copy.userData.__worldLook === true,
      JSON.stringify(copy.userData));
    check('cloneInstanceMaterials clears the stale marker and re-registers the patch',
      /cloneInstanceMaterials[\s\S]*?delete c\.userData\.__worldLook[\s\S]*?registerWorldLook\(c\)/.test(toon));
    check('registerWorldLook() itself is guarded against double patching (one patch per material)',
      /registerWorldLook\(material: any\)[\s\S]{0,200}?material\.userData\.__worldLook\) return material/.test(toon));
  }
}

// ---------------------------------------------------------------- report
console.log('verify-fog: ' + passed + ' checks passed, ' + failures.length + ' failed');
for (const f of failures) console.error('  FAIL ' + f);
if (failures.length) process.exit(1);
