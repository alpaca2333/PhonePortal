/**
 * 画面调性报告（tone report）: the CPU-side stand-in for "look at a screenshot".
 *
 * This project has no browser and no GPU, so every art decision so far (floor grey, ambient level,
 * fog) was made from real-device feedback AFTER shipping. The renderer's pipeline is small and fixed
 * (key+warm directionals + hemisphere -> MeshToonMaterial's 4-step ramp -> height fog -> tone grade ->
 * sRGB output), so the DISPLAYED colour of a known surface is computable in Node.
 * apps/shooter/src/tone.ts is that model; this script is the report.
 *
 * It prints:
 *   1. the palette under the CURRENT settings (every surface's on-screen colour + luminance + L*);
 *   2. the tone metrics the art-direction scorecard cares about, translated to this scene's scale
 *      (luminance contrast, dominant-colour share, hue balance, entropy over the palette buckets);
 *   3. the perceptual separation (CIE76 dE) of the gameplay-critical pairs, because "can I see the
 *      enemy" is the one readability question a palette report can genuinely answer;
 *   4. a side-by-side of the grade off/on, so a grade change has to PROVE it moved the numbers
 *      instead of being asserted.
 *
 * Run:  npm run build && node scripts/analyze-tone.mjs
 *       node scripts/analyze-tone.mjs --directional 1 --ambient 0 --fog 0.016 --grade 1
 *       node scripts/analyze-tone.mjs --grade 0 --vignette 0 --aspect 2.16
 *
 * This is a REPORT, not a gate (scripts/verify-tone.mjs is the gate): it always exits 0 unless the
 * model itself throws. Every number it prints is reproducible; none of it is a screenshot.
 */
import {
  SURFACES, CRITICAL_PAIRS, analyze, shade, separations,
} from '../dist/apps/shooter/src/tone.js';
import * as G from '../dist/apps/shooter/src/grade.js';
import * as V from '../dist/apps/shooter/src/vignette.js';
import { AMBIENT_SCALE_DEFAULT, DIRECTIONAL_SCALE_DEFAULT } from '../dist/apps/shooter/src/lighting.js';
import { FOG_DENSITY_DEFAULT } from '../dist/apps/shooter/src/fog.js';

/** Tiny --flag value parser (no dependency, no surprises). */
function args() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    const hasValue = next !== undefined && !next.startsWith('--');
    const value = hasValue ? Number(next) : 1;
    if (hasValue) i++;
    if (Number.isFinite(value)) out[key] = value;
  }
  return out;
}

const flags = args();
const current = {
  ambient: flags.ambient ?? AMBIENT_SCALE_DEFAULT,
  directional: flags.directional ?? DIRECTIONAL_SCALE_DEFAULT,
  fog: flags.fog ?? FOG_DENSITY_DEFAULT,
};
const gradeOn = flags.grade ?? G.GRADE_STRENGTH_DEFAULT;
const vignette = flags.vignette ?? V.VIGNETTE_STRENGTH_DEFAULT;
const aspect = flags.aspect ?? 16 / 9;

const fmt = (n, digits = 3) => n.toFixed(digits);
const hex = (n) => '#' + n.toString(16).padStart(6, '0');
const pct = (n) => (n * 100).toFixed(1) + '%';
const shadeAll = (grade) => SURFACES.map((s) => shade(s, { ...current, grade, shadeUnlit: s.role === 'signal' }));

function report(label, grade) {
  const samples = shadeAll(grade);
  const m = analyze(samples);
  console.log('\n=== ' + label + ' ===');
  console.log('  id             屏上颜色  亮度    L*    饱和   雾');
  for (const s of m.samples) {
    console.log(
      '  ' + s.id.padEnd(15) + hex(s.hex) + '   ' + fmt(s.luminance) + '  ' + fmt(s.lStar, 1).padStart(5)
      + '  ' + fmt(s.saturation) + '  ' + fmt(s.fog, 2) + '   ' + s.label,
    );
  }
  console.log('  --- 调性指标 ---');
  console.log('  平均亮度 ' + fmt(m.meanLuminance) + ' | p05 ' + fmt(m.p05) + ' / p50 ' + fmt(m.p50)
    + ' / p95 ' + fmt(m.p95) + ' | 对比度(p95-p5)*255 = ' + fmt(m.contrast, 1) + '   (记分卡下限 ~60)');
  console.log('  平均饱和 ' + fmt(m.meanSaturation) + ' | 主色占比 ' + pct(m.dominantShare)
    + '  (记分卡 >60% = 画面发空) | 桶数 ' + m.buckets + ' | 熵 ' + fmt(m.entropyBits, 2) + ' bit');
  console.log('  色相分布 暖 ' + pct(m.warmShare) + ' / 冷 ' + pct(m.coolShare) + ' / 中性 ' + pct(m.neutralShare));
  console.log('  --- 可辨识度（CIE76 ΔE；>=2.3 为可分辨）---');
  for (const p of separations(samples, CRITICAL_PAIRS)) {
    console.log('  ' + (p.readable ? 'OK  ' : 'LOW ') + p.a + ' vs ' + p.b
      + '  ΔE ' + fmt(p.dE, 1) + '  ΔL* ' + fmt(p.dL, 1));
  }
  return m;
}

console.log('画面调性报告 · ambient=' + current.ambient + ' directional=' + current.directional
  + ' · 雾 ' + current.fog + ' · 调性 ' + gradeOn + ' · 暗角 ' + vignette);
console.log('（这是调色板模型，不是截图：不含阴影、屏空间构图与逐像素细节，见 tone.ts 顶部说明）');

const off = report('调色 OFF（未分级）', 0);
const on = report('调色 ON（strength ' + gradeOn + '）', gradeOn);

console.log('\n=== 变化（ON - OFF）===');
const d = (a, b) => (b - a >= 0 ? '+' : '') + (b - a).toFixed(3);
console.log('  对比度 ' + d(off.contrast, on.contrast) + ' | 平均饱和 ' + d(off.meanSaturation, on.meanSaturation)
  + ' | 主色占比 ' + d(off.dominantShare, on.dominantShare) + ' | 熵 ' + d(off.entropyBits, on.entropyBits));
console.log('  色相  暖 ' + d(off.warmShare, on.warmShare) + ' / 冷 ' + d(off.coolShare, on.coolShare)
  + ' / 中性 ' + d(off.neutralShare, on.neutralShare));
{
  const a = separations(shadeAll(0), CRITICAL_PAIRS);
  const b = separations(shadeAll(gradeOn), CRITICAL_PAIRS);
  console.log('  可辨识度 ΔE 变化：');
  for (let i = 0; i < a.length; i++) {
    const diff = b[i].dE - a[i].dE;
    console.log('    ' + (diff >= 0 ? '↑' : '↓') + ' ' + a[i].a + ' vs ' + a[i].b
      + '  ' + a[i].dE.toFixed(1) + ' -> ' + b[i].dE.toFixed(1) + '  (' + (diff >= 0 ? '+' : '') + diff.toFixed(1) + ')');
  }
}

console.log('\n=== 暗角（strength ' + vignette + ', aspect ' + aspect.toFixed(2) + '）===');
{
  const grid = V.buildVignetteGrid({ aspect, strength: vignette });
  let minB = 1;
  let maxB = 0;
  for (let i = 0; i < grid.radii.length; i++) {
    minB = Math.min(minB, grid.colors[i * 3]);
    maxB = Math.max(maxB, grid.colors[i * 3]);
  }
  const size = V.vignetteQuadSize(52, aspect, 1);
  console.log('  中心系数 ' + fmt(maxB) + ' | 角落系数 ' + fmt(minB) + ' | 顶点 ' + grid.radii.length
    + ' | 三角 ' + grid.indices.length / 3 + ' | 1 次 draw call + 1 层全屏乘算填充');
  console.log('  中心 ' + fmt(V.vignetteBrightness(V.vignetteRadius(0, 0), vignette))
    + ' | 边缘中点 ' + fmt(V.vignetteBrightness(V.vignetteRadius(1, 0), vignette))
    + ' | 角落 ' + fmt(V.vignetteBrightness(V.vignetteRadius(1, 1), vignette))
    + ' | 画幅 ' + fmt(size.width, 2) + ' x ' + fmt(size.height, 2));
}

console.log('\n地砖屏上色（模型值，真机请对照）：'
  + hex(shadeAll(gradeOn).filter((s) => s.id === 'floor')[0].hex));
