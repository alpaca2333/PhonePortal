/**
 * CPU-side verification for 画面调性: the tone model, the grade, the vignette, and the GLSL injection.
 *
 * There is no GPU here, so the shader cannot be compiled and the picture cannot be looked at. What CAN
 * be proven is the whole chain up to those two lines:
 *
 *   1. tone.ts   — the display model is internally consistent (ramp lookup, sRGB round-trip, fog, the
 *                  documented baseline floor colour) and the palette data is well formed;
 *   2. grade.ts  — the grade is an EXACT identity at strength 0, multiplicative (black stays black),
 *                  cools the darks, warms the lights, raises contrast, and the JS mirror matches the
 *                  GLSL it ships (same uniform names, declared == referenced, balanced);
 *   3. the measurement itself — the grade must improve every gameplay-critical separation and the
 *                  luminance contrast, and must not lift the black point. This is the assertion that
 *                  makes the grade defensible without a screenshot;
 *   4. vignette.ts — exact identity at strength 0, tint only where the falloff is, monotone falloff,
 *                  and the camera-child card's geometry really covers the frustum (checked by
 *                  projecting its corners with the vendored three);
 *   5. the patch  — the grade's anchor exists exactly once in every lit material's shader and the
 *                  patch fails safe when it does not.
 *
 * Run:  npm run build && node scripts/verify-tone.mjs
 * Exit code is non-zero when any assertion fails.
 */
import {
  SURFACES, CRITICAL_PAIRS, analyze, shade, separations, rampStep, srgbToLinear, linearToSrgb,
  hexToLinear, lStarOf, deltaE, TOON_RAMP,
} from '../dist/apps/shooter/src/tone.js';
// The namespace form as well, because the transient-light group needs the intermediate LINEAR value
// (`surfaceLinear`) and the encode, not only the finished samples.
import * as toneMod from '../dist/apps/shooter/src/tone.js';
import { TRANSIENT_LIGHTS, pointAttenuation } from '../dist/apps/shooter/src/tone.js';
import { MUZZLE, MUZZLE_Y } from '../dist/apps/shooter/src/muzzle.js';
import { CONFIG, EXPLOSION_LIGHT_COLOR } from '../dist/apps/shooter/src/config.js';
import { PROJECTILES, ROCKET_BLAST_RADIUS } from '../dist/apps/shooter/src/projectiles.js';
import * as G from '../dist/apps/shooter/src/grade.js';
import * as V from '../dist/apps/shooter/src/vignette.js';
import { AMBIENT_SCALE_DEFAULT, DIRECTIONAL_SCALE_DEFAULT } from '../dist/apps/shooter/src/lighting.js';
import { FOG_DENSITY_DEFAULT } from '../dist/apps/shooter/src/fog.js';

const THREE = await import(new URL('../dist/apps/shooter/vendor/three.module.min.js', import.meta.url).href);
import { readFileSync } from 'node:fs';

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail ? ' — ' + detail : ''));
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const nearRgb = (a, b, eps = 1e-9) => a.every((v, i) => near(v, b[i], eps));
const BASE = { directional: DIRECTIONAL_SCALE_DEFAULT, ambient: AMBIENT_SCALE_DEFAULT, fog: FOG_DENSITY_DEFAULT };

// ---------------------------------------------------------------- 1. the display model
check('the toon ramp is the 4-step ramp toon.ts builds its gradient map from',
  TOON_RAMP.length === 4 && TOON_RAMP[0] === 0.32 && TOON_RAMP[3] === 0.95);
check('rampStep: dotNL 1 -> 0.95, 0 -> 0.75, -1 -> 0.32 (the NearestFilter texel lookup)',
  rampStep(1) === 0.95 && rampStep(0) === 0.75 && rampStep(-1) === 0.32);
check('rampStep is monotonically non-decreasing',
  [-1, -0.5, 0, 0.5, 1].every((v, i, a) => i === 0 || rampStep(v) >= rampStep(a[i - 1])));
check('sRGB round-trip is exact enough for colour work',
  [0, 0.02, 0.2, 0.5, 0.8, 1].every((v) => near(linearToSrgb(srgbToLinear(v)), v, 1e-9)));
check('hexToLinear maps white to 1 and black to 0',
  nearRgb(hexToLinear(0xffffff), [1, 1, 1], 1e-9) && nearRgb(hexToLinear(0), [0, 0, 0], 1e-12));
check('L* is 0 / 53.39 / 100 for black / mid-grey / white',
  lStarOf([0, 0, 0]) === 0 && near(lStarOf([1, 1, 1]), 100, 1e-4)
  && near(lStarOf([0.5, 0.5, 0.5]), 53.39, 0.01), String(lStarOf([0.5, 0.5, 0.5])));
check('deltaE of a colour with itself is 0 and is symmetric-ish in magnitude',
  near(deltaE([0.5, 0.2, 0.1], [0.5, 0.2, 0.1]), 0, 1e-12)
  && near(deltaE([0.5, 0.2, 0.1], [0.1, 0.2, 0.5]), deltaE([0.1, 0.2, 0.5], [0.5, 0.2, 0.1]), 1e-9));

check('every surface has a documented provenance, a real role and a legal albedo',
  SURFACES.length >= 10 && SURFACES.every((s) => typeof s.provenance === 'string' && s.provenance.length > 10)
  && SURFACES.every((s) => ['world', 'actor', 'signal'].includes(s.role))
  && SURFACES.every((s) => s.albedo.every((c) => c >= 0 && c <= 1) && s.weight > 0 && s.distance > 0));
check('the surface weights are shares of one frame (sum ≈ 1)',
  near(SURFACES.reduce((a, s) => a + s.weight, 0), 1, 0.02),
  String(SURFACES.reduce((a, s) => a + s.weight, 0)));
check('every critical pair resolves (a typo would silently drop a readability check)',
  separations(SURFACES.map((s) => shade(s, BASE)), CRITICAL_PAIRS).length === CRITICAL_PAIRS.length);

// The baseline the rest of the assertions are relative to. Pinned deliberately: if this changes, the
// lighting/fog/palette changed too, and every number in the README has to be re-recorded.
{
  const floor = shade(SURFACES.find((s) => s.id === 'floor'), BASE);
  check('baseline: the floor renders as a near-neutral mid-dark grey (#46413f, L* ≈ 28)',
    near(floor.luminance, 0.259, 0.02) && near(floor.lStar, 28.1, 1.5) && floor.saturation < 0.15,
    `${floor.luminance.toFixed(3)} / L* ${floor.lStar.toFixed(1)} / S ${floor.saturation.toFixed(2)}`);
  const wall = shade(SURFACES.find((s) => s.id === 'wall'), BASE);
  check('baseline: the wooden wall reads clearly brighter than the floor (L* gap > 15)',
    wall.lStar - floor.lStar > 15, `${(wall.lStar - floor.lStar).toFixed(1)}`);
  const empty = shade(SURFACES.find((s) => s.id === 'enemy-gunner'), BASE);
  check('⚠️ the measured problem this pass fixes: characters sit at the floor\'s lightness',
    Math.abs(empty.lStar - floor.lStar) < 8,
    `ΔL* ${(empty.lStar - floor.lStar).toFixed(1)} (the separation is chroma-only)`);
  check('the fog cools the far floor and darkens it (fog colour is cooler than the floor)',
    (() => {
      const noFog = shade(SURFACES.find((s) => s.id === 'floor'), { ...BASE, fog: 0 });
      return floor.rgb[2] - floor.rgb[0] > noFog.rgb[2] - noFog.rgb[0] && floor.luminance < noFog.luminance;
    })());
  check('ambient 0 means ambient 0: turning the ambient up to the top of its slider lifts the floor',
    (() => {
      // The slider unit is AMBIENT_BASE = 0.14 intensity at scale 1, so this uses the top of the range
      // (7.5 x 0.14 = 1.05) — the scale where ambient light used to be the dominant term.
      const lifted = shade(SURFACES.find((s) => s.id === 'floor'), { ...BASE, ambient: 7.5 });
      return lifted.luminance > floor.luminance * 1.1;
    })(), String(shade(SURFACES.find((s) => s.id === 'floor'), { ...BASE, ambient: 7.5 }).luminance));
}

// ---------------------------------------------------------------- 2. the grade
check('GRADE strength 0 is the EXACT identity on every channel',
  nearRgb(G.gradeDisplay([0.3, 0.55, 0.8], 0), [0.3, 0.55, 0.8], 0)
  && nearRgb(G.gradeDisplay([0, 0, 0], 0), [0, 0, 0], 0));
check('the grade is MULTIPLICATIVE: black stays exactly black (the black point is not lifted)',
  nearRgb(G.gradeDisplay([0, 0, 0], 1), [0, 0, 0], 0));
check('the grade never returns values outside 0..1',
  [[0, 0, 0], [1, 1, 1], [0.9, 0.1, 0.05], [0.5, 0.5, 0.5]].every((c) =>
    G.gradeDisplay(c, 1).every((v) => v >= 0 && v <= 1)));
check('the darks go COOL: a dark pixel gains blue relative to red',
  (() => { const a = [0.12, 0.12, 0.12]; const b = G.gradeDisplay(a, 1);
    return (b[2] - b[0]) > (a[2] - a[0]) + 0.01; })(),
  JSON.stringify(G.gradeDisplay([0.12, 0.12, 0.12], 1)));
check('the lights stay WARM: a bright pixel gains red relative to blue',
  (() => { const a = [0.85, 0.85, 0.85]; const b = G.gradeDisplay(a, 1);
    return (b[0] - b[2]) > (a[0] - a[2]) + 0.01; })(),
  JSON.stringify(G.gradeDisplay([0.85, 0.85, 0.85], 1)));
check('contrast rises: the gap above/below the pivot widens',
  G.gradeDisplay([0.6, 0.6, 0.6], 1)[0] > 0.6 && G.gradeDisplay([0.25, 0.25, 0.25], 1)[0] < 0.25,
  `${G.gradeDisplay([0.6, 0.6, 0.6], 1)[0].toFixed(3)} / ${G.gradeDisplay([0.25, 0.25, 0.25], 1)[0].toFixed(3)}`);
check('saturation rises: a saturated colour gains chroma, a neutral one stays nearly neutral',
  (() => {
    const c = [0.7, 0.35, 0.2];
    const g = G.gradeDisplay(c, 1);
    const chroma = (x) => Math.max(...x) - Math.min(...x);
    return chroma(g) > chroma(c) && chroma(G.gradeDisplay([0.5, 0.5, 0.5], 1)) < 0.08;
  })());
check('brightness order is preserved (no inversions across a grey ramp)',
  [0, 0.1, 0.2, 0.35, 0.5, 0.7, 0.9, 1].every((v, i, a) =>
    i === 0 || G.gradeDisplay([v, v, v], 1)[0] >= G.gradeDisplay([a[i - 1], a[i - 1], a[i - 1]], 1)[0] - 1e-9));
check('strength 2 extrapolates the same grade (the slider is a real multiplier, not a clamp)',
  (() => {
    const one = G.gradeDisplay([0.3, 0.45, 0.6], 1);
    const two = G.gradeDisplay([0.3, 0.45, 0.6], 2);
    const src = [0.3, 0.45, 0.6];
    return two.some((v, i) => Math.abs(v - src[i]) > Math.abs(one[i] - src[i]) + 1e-6);
  })());
check('clampGradeStrength: 0 legal, range clamps, dirty data -> the shipped default',
  G.clampGradeStrength(0) === 0 && G.clampGradeStrength(-1) === 0
  && G.clampGradeStrength(9) === G.GRADE_STRENGTH_MAX && G.clampGradeStrength(NaN) === G.GRADE_STRENGTH_DEFAULT
  && G.GRADE_STRENGTH_DEFAULT === 1);

// ---------------------------------------------------------------- 2b. the grade's input DOMAIN
// 「龙息弹/RPG 的红光照到别的地方发绿」(reported twice, and it reproduces with the 「像素化」 pass BOTH
// on and off). Cause: `linearToOutputTexel()` does not clamp, so a surface 0.5 units under a transient
// point light reaches the grade SUPER-WHITE (~2.9 linear / ~1.6 encoded). For 「调性」 > 1 the grade's
// final `mix( before, after, s )` is an extrapolation, and `after` is clamped to 1 while `before` is
// not — so away from `after` means the brightest channel is pushed DOWN at s x (before - 1) while the
// others move up. Red light on a grey floor came out GREEN. The fix is the domain clamp in grade.ts.
{
  // The pre-fix kernel, verbatim: the same math with `rgb` in place of the clamped `base`. It has to
  // stay here as the regression guard, because "the input is clamped" is only meaningful if NOT
  // clamping it demonstrably produces the reported colour.
  const preFix = (rgb, strength) => {
    const s = G.clampGradeStrength(strength);
    if (s === 0) return [rgb[0], rgb[1], rgb[2]];
    const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
    const l = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    const t0 = clamp01((l(rgb) - G.GRADE_TINT_LO) / (G.GRADE_TINT_HI - G.GRADE_TINT_LO));
    const t = t0 * t0 * (3 - 2 * t0);
    const mixv = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
    const tint = mixv(G.GRADE_SHADOW_TINT, G.GRADE_HIGHLIGHT_TINT, t);
    let c = rgb.map((v, i) => v * tint[i]);
    c = c.map((v) => (v - G.GRADE_PIVOT) * G.GRADE_CONTRAST + G.GRADE_PIVOT);
    const l2 = l(c);
    c = c.map((v) => l2 + (v - l2) * G.GRADE_SATURATION).map(clamp01);
    if (s === 1) return c;
    return rgb.map((v, i) => v + (c[i] - v) * s);
  };
  // The floor exactly under the dragon-breath pellet's light: 2.9 in linear, ~1.6 after the encode.
  const hdrLinear = toneMod.surfaceLinear(
    toneMod.SURFACES.find((s) => s.id === 'floor-near'),
    { ambient: 7.5, directional: 2, lights: [{ light: { color: 0xff4a12, intensity: 10, distance: 9 }, distance: 0.5, dotNL: 1 }] },
  );
  check('⭐ the reported case: the unclamped pipeline turns the pellet\'s red light GREEN at 「调性」 2',
    preFix(hdrLinear.map(toneMod.linearToSrgb), 2)[1] > preFix(hdrLinear.map(toneMod.linearToSrgb), 2)[0],
    `linear ${hdrLinear.map((v) => v.toFixed(2))} -> encoded ${hdrLinear.map((v) => toneMod.linearToSrgb(v).toFixed(2))} -> `
    + `pre-fix ${preFix(hdrLinear.map(toneMod.linearToSrgb), 2).map((v) => v.toFixed(3))}`);
  check('the domain clamp removes it: the same input is clamped to the displayable range first',
    nearRgb(G.gradeDisplay(hdrLinear.map(toneMod.linearToSrgb), 2),
      G.gradeDisplay([1, toneMod.linearToSrgb(hdrLinear[1]), toneMod.linearToSrgb(hdrLinear[2])], 2), 1e-12)
    && G.gradeDisplay(hdrLinear.map(toneMod.linearToSrgb), 2)[0] > G.gradeDisplay(hdrLinear.map(toneMod.linearToSrgb), 2)[1],
    `${G.gradeDisplay(hdrLinear.map(toneMod.linearToSrgb), 2).map((v) => v.toFixed(3))}`);
  check('…and the clamp is a DOMAIN clamp: out-of-range inputs are folded in, not extrapolated',
    nearRgb(G.gradeDisplay([2.9, -0.4, 7], 1), G.gradeDisplay([1, 0, 1], 1), 1e-12)
    && nearRgb(G.gradeDisplay([2.9, -0.4, 7], 2), G.gradeDisplay([1, 0, 1], 2), 1e-12)
    && nearRgb(G.gradeDisplay([2.9, -0.4, 7], 0), [1, 0, 1], 1e-12));
  // The GLSL must clamp at the ENTRY and then never touch `gl_FragColor.rgb` again: the final mix has
  // to use the clamped base, or the extrapolation is back.
  const bodyLines = G.GRADE_FRAGMENT_BODY.split('\n').map((s) => s.trim());
  check('the GLSL body clamps `gl_FragColor.rgb` into `gBase` once, and mixes from `gBase`',
    bodyLines[1] === 'vec3 gBase = clamp( gl_FragColor.rgb, 0.0, 1.0 );'
    && bodyLines[bodyLines.length - 2] === 'gl_FragColor.rgb = mix( gBase, gCol, uGradeStrength );'
    && bodyLines.filter((s) => s.includes('gl_FragColor.rgb')).length === 2);
}
{
  // Every transient light in the game that lands on the scenery, over the whole range of distances and
  // angles a player can be at, at every 「调性」. `nearestFloor` is the light's own height (the worst
  // case) and the sweep opens out from there to well past the light's reach. The reporter's live
  // settings are used for the sun/ambient so a failure message quotes the numbers the device shows.
  const floor = SURFACES.find((s) => s.id === 'floor-near');
  const LIGHTSET = { ambient: 7.5, directional: 2 };
  const lit = (L, grade, d, dotNL) => shade(floor, {
    ...LIGHTSET, grade, lights: [{ light: L, distance: d, dotNL }],
  });
  let worst = null;
  for (const L of TRANSIENT_LIGHTS) {
    for (let s = 0; s <= 2.0001; s += 0.05) {
      for (let d = L.nearestFloor; d <= 12; d += 0.1) {
        for (const dotNL of [1, 0.75, 0.5, 0.25]) {
          // `shade` returns the DISPLAYED colour (the framebuffer clamps the grade's extrapolation at
          // 「调性」 > 1), which is the value the eye gets.
          const t = lit(L, s, d, dotNL);
          if (!worst || t.rgb[1] - t.rgb[0] > worst.inv) {
            worst = { inv: t.rgb[1] - t.rgb[0], id: L.id, s, d, dotNL, rgb: t.rgb };
          }
        }
      }
    }
  }
  check('no transient light in the game can turn a lit floor green (R >= G at every distance/angle/「调性」)',
    worst.inv <= 0, worst && `${worst.id} at d=${worst.d.toFixed(1)} dotNL=${worst.dotNL} 「调性」${worst.s.toFixed(2)}: G-R=${worst.inv.toFixed(3)} ${worst.rgb.map((v) => v.toFixed(3))}`);
  const pellet = lit(TRANSIENT_LIGHTS.find((L) => L.id === 'pellet-dragon'), 2, 0.5, 1);
  const blast = lit(TRANSIENT_LIGHTS.find((L) => L.id === 'blast-rpg'), 2, 0.8, 1);
  check('the two reported lights on the floor at 「调性」 2 are warm, not green',
    pellet.rgb[0] > pellet.rgb[1] && blast.rgb[0] >= blast.rgb[1],
    `龙息弹 ${pellet.rgb.map((v) => v.toFixed(3))} / RPG 爆炸 ${blast.rgb.map((v) => v.toFixed(3))}`);
  // The documented RESIDUE (grade.ts's header): the split tone rotates the dark end, so a DIM, fully
  // saturated yellow surface can still come out marginally green-dominant — and it already does at the
  // default strength, i.e. it is the authored cool-shadow tint rather than the slider. Bounded here so
  // it cannot grow silently; the check above is the one that matters (no real light reaches it).
  const residueAt = (s) => {
    let q = null;
    for (let r = 0; r <= 1.0001; r += 0.05) for (let g = 0; g <= 1.0001; g += 0.05) for (let b = 0; b <= 1.0001; b += 0.05) {
      if (g > r || b > g) continue;                     // WARM inputs only (R >= G >= B)
      const out = G.gradeDisplay([r, g, b], s);
      if (!q || out[1] - out[0] > q.inv) q = { inv: out[1] - out[0], rgb: [r, g, b], out };
    }
    return q;
  };
  const res2 = residueAt(2), res1 = residueAt(1);
  check('the residual cool-shadow hue rotation stays bounded (documented: 0.026 at 「调性」 1, 0.06 at 2)',
    res1.inv <= 0.03 && res2.inv <= 0.06,
    `s=1 ${res1.inv.toFixed(3)} on ${res1.rgb.map((v) => v.toFixed(2))}, s=2 ${res2.inv.toFixed(3)} on ${res2.rgb.map((v) => v.toFixed(2))} -> ${res2.out.map((v) => v.toFixed(3))}`);
  // The table is a copy of numbers that live in three other modules: assert it against them, or a
  // retuned recipe would leave the correctness test asserting a light that no longer exists.
  const byId = (id) => TRANSIENT_LIGHTS.find((L) => L.id === id);
  const S_BLAST = ROCKET_BLAST_RADIUS / 3.5;
  check('the transient-light table still matches muzzle.ts / projectiles.ts / config.ts',
    byId('pellet-dragon').color === PROJECTILES.flameShot.visual.lightColor
    && byId('pellet-dragon').intensity === PROJECTILES.flameShot.visual.lightIntensity
    && byId('pellet-dragon').distance === PROJECTILES.flameShot.visual.lightDistance
    && byId('pellet-dragon').nearestFloor === 0.5
    && byId('muzzle-dragon').color === MUZZLE.dragonBreath.light.color
    && byId('muzzle-dragon').intensity === MUZZLE.dragonBreath.light.intensity
    && byId('muzzle-dragon').distance === MUZZLE.dragonBreath.light.distance
    && byId('muzzle-dragon').nearestFloor === MUZZLE_Y
    && byId('muzzle-rpg').color === MUZZLE.rpg.light.color
    && byId('muzzle-rpg').intensity === MUZZLE.rpg.light.intensity
    && byId('muzzle-rpg').distance === MUZZLE.rpg.light.distance
    && byId('smg-round').color === PROJECTILES.smgRound.visual.lightColor
    && byId('blast-rpg').color === EXPLOSION_LIGHT_COLOR
    && byId('blast-rpg').intensity === CONFIG.blastLightIntensity * S_BLAST
    && byId('blast-rpg').distance === CONFIG.blastLightDistance * S_BLAST
    && byId('blast-rpg').nearestFloor === CONFIG.blastLightY);
  check('the point-light attenuation is three\'s decay-2 law (1/d^2, floored at 0.01)',
    near(pointAttenuation(0.5), 4, 1e-12) && near(pointAttenuation(2), 0.25, 1e-12)
    && near(pointAttenuation(0), 100, 1e-9) && near(pointAttenuation(NaN), pointAttenuation(0.1), 1e-12));
}

// ---------------------------------------------------------------- 3. the measurement
{
  const off = analyze(SURFACES.map((s) => shade(s, { ...BASE, grade: 0, shadeUnlit: s.role === 'signal' })));
  const on = analyze(SURFACES.map((s) => shade(s, { ...BASE, grade: 1, shadeUnlit: s.role === 'signal' })));
  check('the grade RAISES the palette contrast (p95-p5)', on.contrast > off.contrast + 5,
    `${off.contrast.toFixed(1)} -> ${on.contrast.toFixed(1)}`);
  check('the scene gains a COOL counterpart (>20% of the frame) without losing its warm half',
    on.coolShare > off.coolShare + 0.2 && off.coolShare < 0.1 && on.warmShare > 0.25,
    `cool ${(off.coolShare * 100).toFixed(1)}% -> ${(on.coolShare * 100).toFixed(1)}%, warm ${(on.warmShare * 100).toFixed(1)}%`);
  check('the untouched baseline is warm/neutral-dominant (the finding this pass addresses)',
    off.coolShare < 0.1 && off.warmShare > 0.4);
  const pairsOff = separations(SURFACES.map((s) => shade(s, { ...BASE, grade: 0, shadeUnlit: s.role === 'signal' })), CRITICAL_PAIRS);
  const pairsOn = separations(SURFACES.map((s) => shade(s, { ...BASE, grade: 1, shadeUnlit: s.role === 'signal' })), CRITICAL_PAIRS);
  check('the grade never makes a gameplay read WORSE (every critical ΔE is non-decreasing)',
    pairsOff.every((p, i) => pairsOn[i].dE >= p.dE - 0.001),
    pairsOff.map((p, i) => `${p.a.split('（')[0]}:${p.dE.toFixed(1)}->${pairsOn[i].dE.toFixed(1)}`).join(' '));
  check('…and it measurably improves the two reads that matter most (player/floor, gunner/floor)',
    pairsOn[0].dE > pairsOff[0].dE + 1 && pairsOn[1].dE > pairsOff[1].dE + 1,
    `${pairsOff[0].dE.toFixed(1)}->${pairsOn[0].dE.toFixed(1)}, ${pairsOff[1].dE.toFixed(1)}->${pairsOn[1].dE.toFixed(1)}`);
  check('the darkest surface does not get LIGHTER with the grade (multiplicative tint, no lift)',
    (() => {
      const a = shade(SURFACES.find((s) => s.id === 'void'), { ...BASE, grade: 0 });
      const b = shade(SURFACES.find((s) => s.id === 'void'), { ...BASE, grade: 1 });
      return b.luminance <= a.luminance;
    })());
  check('⚠️ documented open finding: player vs enemy is still a weak read after the grade',
    pairsOn[5].dE < 10,
    `ΔE ${pairsOn[5].dE.toFixed(1)} (both characters share one texture atlas — next pass: role-coded rim)`)
}

// ---------------------------------------------------------------- 3b. the burn glow (dragon breath)
// The complaint this fixes: 「龙息弹显示的有点怪，外面一圈是红色亮光，中间反而变黑了」. The fire is
// unlit additive geometry and the ambient light is 0, so a burning enemy's body used to be a black hole
// inside a bright ring. The glow is asserted here as colour math AND as a measured luminance jump.
{
  const C = await import('../dist/apps/shooter/src/chartint.js');
  check('burnGlowFor: 0 / negative / NaN stacks -> 0, full stacks -> 1, above -> clamped',
    C.burnGlowFor(0) === 0 && C.burnGlowFor(-2) === 0 && C.burnGlowFor(NaN) === 0
    && C.burnGlowFor(C.BURN_GLOW_STACKS) === 1 && C.burnGlowFor(C.BURN_GLOW_STACKS * 5) === 1
    && near(C.burnGlowFor(1), 1 / C.BURN_GLOW_STACKS, 1e-12));
  check('burnGlowFor is monotone in the stack count (more stacks = more glow)',
    [0, 1, 2, 3, 4].every((n, i, a) => i === 0 || C.burnGlowFor(n) >= C.burnGlowFor(a[i - 1])));
  check('charTint with no flash and no burn returns the base EXACTLY (an idle enemy is untouched)',
    (() => {
      const base = [0.42, 0.25, 0.11];
      const em = [0, 0, 0];
      const out = C.charTint(base, em, 0, 0);
      return out.color.every((v, i) => v === base[i]) && out.emissive.every((v, i) => v === em[i]);
    })());
  check('the flash-only tint is exactly what shipped before (no regression in the hit flash)',
    (() => {
      const base = [0.42, 0.25, 0.11];
      const em = [0.02, 0.01, 0];
      for (const t of [0.25, 0.5, 1]) {
        const out = C.charTint(base, em, t, 0);
        const stay = 1 - t;
        const fc = C.rgbFromHex(C.HIT_FLASH_COLOR);
        if (out.color.some((v, i) => !near(v, base[i] * stay + fc[i] * t, 1e-12))) return false;
        if (out.emissive.some((v, i) => !near(v, em[i] * (1 - t * C.HIT_FLASH_EMISSIVE) + fc[i] * t * C.HIT_FLASH_EMISSIVE, 1e-12))) return false;
      }
      return true;
    })());
  check('the burn tint moves the colour toward the fire and raises the emissive monotonically',
    (() => {
      const base = [0.42, 0.25, 0.11];
      const em = [0, 0, 0];
      let lastE = -1;
      for (const b of [0.25, 0.5, 0.75, 1]) {
        const out = C.charTint(base, em, 0, b);
        const lum = 0.2126 * out.emissive[0] + 0.7152 * out.emissive[1] + 0.0722 * out.emissive[2];
        if (lum <= lastE) return false;
        lastE = lum;
        if (out.color[0] <= base[0]) return false;      // hotter = redder
      }
      return true;
    })());
  check('a hit on a burning enemy still reads (the flash is applied after the burn)',
    (() => {
      const base = [0.42, 0.25, 0.11];
      const burning = C.charTint(base, [0, 0, 0], 0, 1);
      const hit = C.charTint(base, [0, 0, 0], 1, 1);
      const fc = C.rgbFromHex(C.HIT_FLASH_COLOR);
      const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      // At flashT = 1 the COLOUR is exactly the flash red, whatever the burn was doing, and the hit is
      // at least as self-lit as the burn alone — i.e. a hit stays readable on a burning enemy.
      return hit.color.every((v, i) => near(v, fc[i], 1e-12))
        && lum(hit.emissive) >= lum(burning.emissive);
    })());
  check('every tint output stays inside 0..1 (no NaN, no negative radiance)',
    [[0, 0], [0.5, 0.5], [1, 1], [0, 1], [1, 0]].every(([f, b]) =>
      C.charTint([0.9, 0.5, 0.2], [0.1, 0.05, 0], f, b).color.every((v) => v >= 0 && v <= 1)
      && C.charTint([0.9, 0.5, 0.2], [0.1, 0.05, 0], f, b).emissive.every((v) => v >= 0 && v <= 1)));

  // THE MEASUREMENT: the burning body must stop being a black hole. Same albedo, same lighting, plus
  // the emissive the glow adds — its displayed luminance must clear the floor it stands on.
  const enemyBase = SURFACES.find((s) => s.id === 'enemy-gunner');
  const plain = shade(enemyBase, { ...BASE, grade: 1 });
  const glow = C.charTint([0.42, 0.25, 0.11], [0, 0, 0], 0, 1);
  const burning = shade(enemyBase, { ...BASE, grade: 1, emissive: glow.emissive });
  const floor = shade(SURFACES.find((s) => s.id === 'floor'), { ...BASE, grade: 1 });
  check('a fully burning enemy is much brighter than the same enemy unlit (the body self-lights)',
    burning.luminance > plain.luminance * 2, `${plain.luminance.toFixed(3)} -> ${burning.luminance.toFixed(3)}`);
  check('…and it now reads clearly ABOVE the floor instead of as a black shape on it',
    burning.luminance > floor.luminance * 1.5 && plain.luminance < floor.luminance,
    `floor ${floor.luminance.toFixed(3)} / plain ${plain.luminance.toFixed(3)} / burning ${burning.luminance.toFixed(3)}`);
  check('…while staying short of white (the fire quads in front of it must still be the brightest)',
    burning.luminance < 0.9, String(burning.luminance));
  // The renderer must actually drive it from the sim's burn stacks.
  {
    const render = readFileSync(new URL('../apps/shooter/src/render.ts', import.meta.url), 'utf8');
    // The corpse branch reads the character through a local (`const char = v.char`) since the released
    // -view work in that loop (see render.ts::releaseView), so both spellings are accepted here.
    check('render.ts drives the glow from the sim burn stacks and clears it for corpses',
      /setBurnGlow\(burnGlowFor\(e\.burns\.length, CONFIG\.burnGlowStacks\)\)/.test(render)
      && /(?:v\.char|char)\.setBurnGlow\(0\)/.test(render));
  }
}

// ---------------------------------------------------------------- 4. the vignette
check('VIGNETTE strength 0 is EXACTLY the identity on every channel (no leftover tint)',
  nearRgb(V.vignetteFactor(0, 0), [1, 1, 1], 0) && nearRgb(V.vignetteFactor(1, 0), [1, 1, 1], 0)
  && nearRgb(V.vignetteFactor(0.5, 0), [1, 1, 1], 0));
check('the tint only applies where the falloff is: the centre stays exactly 1 at any strength',
  nearRgb(V.vignetteFactor(0, 1), [1, 1, 1], 0) && nearRgb(V.vignetteFactor(V.VIGNETTE_INNER, 1), [1, 1, 1], 0));
check('the corner carries the tint and the floor: factor = tint * FLOOR at strength 1',
  nearRgb(V.vignetteFactor(1, 1), [
    V.VIGNETTE_FLOOR * V.VIGNETTE_TINT[0], V.VIGNETTE_FLOOR * V.VIGNETTE_TINT[1],
    V.VIGNETTE_FLOOR * V.VIGNETTE_TINT[2],
  ], 1e-12), JSON.stringify(V.vignetteFactor(1, 1)));
check('the falloff is monotone (darker outward) and the corners are the darkest point',
  [0, 0.2, 0.4, 0.6, 0.8, 1].every((r, i, a) => i === 0 || V.vignetteFactor(r, 1)[0] <= V.vignetteFactor(a[i - 1], 1)[0] + 1e-12));
check('vignetteRadius puts the centre at 0 and the screen corner at exactly 1',
  V.vignetteRadius(0, 0) === 0 && near(V.vignetteRadius(1, 1), 1, 1e-12)
  && V.vignetteRadius(1, 0) < 1 && V.vignetteRadius(0, 1) < 1);
check('clampVignetteStrength: 0 legal, range clamps, dirty data -> the shipped default',
  V.clampVignetteStrength(0) === 0 && V.clampVignetteStrength(-1) === 0
  && V.clampVignetteStrength(9) === V.VIGNETTE_STRENGTH_MAX
  && V.clampVignetteStrength(NaN) === V.VIGNETTE_STRENGTH_DEFAULT);
{
  const aspect = 2.16;
  const grid = V.buildVignetteGrid({ aspect, strength: 1 });
  check('the card has a full grid (19x19 vertices, 648 triangles)',
    grid.radii.length === 19 * 19 && grid.indices.length / 3 === 18 * 18 * 2,
    `${grid.radii.length} verts / ${grid.indices.length / 3} tris`);
  // Project the card's corners with the VENDORED three, through the ORTHOGRAPHIC camera the renderer
  // now uses: they must land exactly on the frustum edges.
  {
    const H = V.vignetteQuadSize(1, 1, aspect).height;
    const W = H * aspect;
    const cam = new THREE.OrthographicCamera(-W / 2, W / 2, H / 2, -H / 2, 1, 400);
    const size = V.vignetteQuadSize(1, 1, aspect);
    const corner = new THREE.Vector3(size.width / 2, size.height / 2, -V.VIGNETTE_DIST).project(cam);
    const mid = new THREE.Vector3(0, 0, -V.VIGNETTE_DIST).project(cam);
    check('the vignette card exactly covers the orthographic view volume',
      near(Math.abs(corner.x), 1, 1e-6) && near(Math.abs(corner.y), 1, 1e-6) && near(mid.x, 0, 1e-9) && near(mid.y, 0, 1e-9),
      `projected corner ${corner.x.toFixed(4)},${corner.y.toFixed(4)}`);
  }
  check('the grid is centred on the view axis (z = -dist) and symmetric in x',
    near(grid.positions[2], -V.VIGNETTE_DIST, 1e-9)
    && near(grid.positions[0], -grid.positions[(18) * 3], 1e-9),
    `${grid.positions[0]} / ${grid.positions[18 * 3]}`);
  check('a rebuilt grid at a different strength is still the identity at 0',
    V.buildVignetteGrid({ aspect, strength: 0 }).colors.every((c) => c === 1));
}

// ---------------------------------------------------------------- 5. the GLSL patch
// The world look (fog + grade) is injected on the LEFT of `#include <colorspace_fragment>` — the single
// line whose expansion depends on the render target — inside worldlook.ts's explicit encode/decode wrap.
// That is what makes it run in DISPLAY space on both render paths (the fog colour and every grade
// number are authored as "what you see" values). verify-fog.mjs asserts the anchor mechanics and the
// transfer-function accuracy; this block asserts the grade's order inside the composed string.
const W = await import('../dist/apps/shooter/src/worldlook.js');
const F = await import('../dist/apps/shooter/src/fog.js');
check('the grade and the fog share one anchor, and worldlook.ts owns the same string',
  G.GRADE_FRAGMENT_ANCHOR === '#include <colorspace_fragment>'
  && F.FOG_FRAGMENT_ANCHOR === G.GRADE_FRAGMENT_ANCHOR
  && W.WORLD_LOOK_FRAGMENT_ANCHOR === G.GRADE_FRAGMENT_ANCHOR);
{
  const libs = ['toon', 'basic', 'lambert', 'standard', 'physical'];
  for (const name of libs) {
    const src = String(THREE.ShaderLib[name].fragmentShader);
    const p = W.patchWorldLookFragmentShader(src);
    check(`ShaderLib.${name}: the world-look patch applies (anchor present exactly once)`, p.ok);
    // The declarations are PREPENDED (they have to be at global scope, before main()) while the bodies
    // land before the anchor, so the ordering assertion has to look at the BODY.
    check(`ShaderLib.${name}: the graded source declares every uniform it references`,
      G.GRADE_UNIFORMS.every((u) => p.src.includes('uniform float ' + u + ';') || p.src.includes('uniform vec3 ' + u + ';'))
      && p.src.indexOf('float gLum = dot') < p.src.indexOf(G.GRADE_FRAGMENT_ANCHOR)
      && p.src.indexOf('float gLum = dot') > p.src.indexOf(G.GRADE_FRAGMENT_DECLS));
  }
  const balanced = (s) => {
    let d = 0;
    for (const ch of s.replace(/\/\/[^\n]*/g, '')) {
      if (ch === '{') d++;
      else if (ch === '}') d--;
      if (d < 0) return false;
    }
    return d === 0;
  };
  check('the grade body has balanced braces and parentheses',
    balanced(G.GRADE_FRAGMENT_BODY)
    && (G.GRADE_FRAGMENT_BODY.match(/\(/g) || []).length === (G.GRADE_FRAGMENT_BODY.match(/\)/g) || []).length);
  check('a missing / duplicated anchor fails safe (no half patch)',
    W.patchWorldLookFragmentShader('void main(){}').ok === false
    && W.patchWorldLookFragmentShader(
      W.WORLD_LOOK_FRAGMENT_ANCHOR + '\n' + W.WORLD_LOOK_FRAGMENT_ANCHOR).ok === false);
  // The COMPOSED shader (what toon.ts actually builds, through this one function) must be, in order:
  // encode -> fog -> grade -> decode -> the output-space include, and must declare the union of the
  // uniform sets + the fog varyings.
  {
    const raw = String(THREE.ShaderLib.toon.fragmentShader);
    const composed = W.patchWorldLookFragmentShader(raw);
    const source = composed.src;
    const at = (needle) => source.indexOf(needle);
    const order = [
      at('vec3 worldLookDisplayToLinear( vec3 c )'),        // the declarations come first (global scope)
      at('LinearTosRGB( gl_FragColor )'),                   // encode: linear -> display (unclamped)
      at('uFogColor, min'),                                 // fog, in display space
      at('float gLum = dot'),                               // grade, in display space, after the fog
      at('worldLookDisplayToLinear( wlDisplay )'),          // decode: display -> linear
      at(G.GRADE_FRAGMENT_ANCHOR),                          // three's own output conversion, once
    ];
    check('the composed shader anchors on exactly one output-space include',
      order[5] > 0 && source.split(G.GRADE_FRAGMENT_ANCHOR).length - 1 === 1, order.join('<'));
    check('the composed order is: declarations < encode < fog < grade < decode < output-space include',
      order[0] === 0 && order.every((v, i) => i === 0 || v > order[i - 1]), order.join(' < '));
    check('…and the composed shader declares the union of both uniform sets',
      [...F.FOG_UNIFORMS, ...G.GRADE_UNIFORMS].every((u) =>
        source.includes('uniform float ' + u + ';') || source.includes('uniform vec3 ' + u + ';')));
    check('the two display-space operators really are inside the wrap (fog and grade both)',
      order[1] < order[2] && order[2] < order[3] && order[3] < order[4]);
    // The trap that bit once: the order must not be left to chained `String.replace` calls. There is now
    // exactly ONE place that writes it down, and the app must go through it.
    const src = (f) => readFileSync(new URL('../apps/shooter/src/' + f, import.meta.url), 'utf8');
    check('the injected order is written down in exactly one place (worldlook.ts) and toon.ts uses it',
      src('worldlook.ts').includes("WORLD_LOOK_ENCODE_BODY + '\\n' + FOG_FRAGMENT_BODY + '\\n' + GRADE_FRAGMENT_BODY + '\\n'")
      && src('toon.ts').includes('patchWorldLookFragmentShader')
      && !src('toon.ts').includes('FOG_FRAGMENT_BODY')
      && !src('fog.ts').includes('export function patchHeightFogFragmentShader')
      && !src('grade.ts').includes('export function patchGradeFragmentShader'));
  }
}

// ---------------------------------------------------------------- report
console.log('verify-tone: ' + passed + ' checks passed, ' + failures.length + ' failed');
for (const f of failures) console.error('  FAIL ' + f);
if (failures.length) process.exit(1);
