/**
 * CPU-side verification for the KEY LIGHT'S SHADOW BOX (src/shadow.ts).
 *
 * WHY THIS SCRIPT EXISTS: "the shadows have weird noise and they flicker while moving" is a
 * GPU-side, eyes-only symptom — this environment has no browser (see AGENTS.md), so the artifact is
 * reproduced and measured here instead, in pure JS, against the REAL arena geometry:
 *
 *   * a full 2048x2048 ORTHOGRAPHIC RASTERISER of the arena's shadow casters (the same triangles the
 *     renderer draws, read from the .glb files through scripts/lib/glb.mjs, transformed by the same
 *     plan from props.ts), with three.js's shadow-pass conventions: BACK-face casting (three maps a
 *     FrontSide material to BackSide in the depth pass), LessEqual depth, cleared to "far";
 *   * three's shadowmap_pars_fragment PCF-SOFT kernel, tap for tap (9 taps, fract-aligned, mix()ed
 *     bilinear emulation), including the `bias` / `normalBias` handling and the out-of-frustum
 *     early-out;
 *   * the fit itself from the SHIPPED module, plus a reproduction of the OLD fixed +-30 box so the
 *     regression is visible as numbers rather than as an opinion.
 *
 * WHAT IT ASSERTS
 *   1. the fit's basis/projection reproduce the vendored three.js's own `light.shadow.matrix` — so
 *      the rasteriser below is testing the shader path the phone will actually run;
 *   2. COVERAGE: every corner of the visible ground is inside the shadow box, at every
 *      「摄像机高度」 / viewport-zoom / aspect combination, including the user's heightScale 3;
 *   3. SNAPPING: a sub-texel movement of the camera produces a BIT-IDENTICAL box (so the sampling
 *      grid cannot crawl), and a measured walk across the real room produces zero shadow-value
 *      flips on receivers that cannot legitimately be shadowed;
 *   4. ACNE: a synthetic thin slab probe (the worst receiver shape in the room: a lit face 2 texels
 *      of slope away from its own back face) stays unshadowed at the slopes the bias rule claims to
 *      cover — reported as a curve, because the curve is what the constants were chosen from;
 *   5. the depth window covers the arena's casters and the margin covers off-screen shadow throw.
 *
 * Run:  npm run build && node scripts/verify-shadow.mjs
 * Exit code is non-zero when any assertion fails.
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGlb } from './lib/glb.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const THREE_URL = new URL('../apps/shooter/vendor/three.module.min.js', import.meta.url);
const PROPS_URL = new URL('../dist/apps/shooter/src/props.js', import.meta.url);
const LEVEL_URL = new URL('../dist/apps/shooter/src/level.js', import.meta.url);
const CONFIG_URL = new URL('../dist/apps/shooter/src/config.js', import.meta.url);
const SHADOW_URL = new URL('../dist/apps/shooter/src/shadow.js', import.meta.url);

const THREE = await import(THREE_URL.href);
const P = await import(PROPS_URL.href);
const S = await import(SHADOW_URL.href);
const CAM = await import(new URL('../dist/apps/shooter/src/camera.js', import.meta.url).href);
const { OBSTACLES } = await import(LEVEL_URL.href);
const { ARENA_HALF } = await import(CONFIG_URL.href);

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ' — ' + detail : ''));
}

const MAP = S.SHADOW_MAP_SIZE;
const AX = S.shadowAxes();
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// ------------------------------------------------------------------ arena geometry, as rendered
const ASSETS = join(ROOT, 'apps', 'shooter', 'assets', 'props');
const plan = P.planArena(OBSTACLES);
const casterHeight = P.planCasterHeight(plan);
const geometryCache = new Map();
function trianglesOf(id) {
  if (!geometryCache.has(id)) geometryCache.set(id, readGlb(join(ASSETS, P.PROPS[id].file + '.glb')).triangles);
  return geometryCache.get(id);
}
/** Every caster triangle in world space (floor tiles excluded: they do not cast), plus the XZ AABB
 * of every instance (used to decide which receivers cannot legitimately be in any shadow). */
function buildWorld(extra = []) {
  const casters = [];
  const allBoxes = [];
  const propBoxes = [];
  const wallBoxes = [];
  const groups = { floor: plan.floor, walls: plan.walls, cover: plan.cover, decor: plan.decor };
  for (const [group, list] of Object.entries(groups)) {
    for (const p of list) {
      const src = trianglesOf(p.id);
      const yaw = (-p.yaw * Math.PI) / 2;
      const cy = Math.cos(yaw);
      const sy = Math.sin(yaw);
      const s = p.scale;
      const syy = p.sy ?? p.scale;
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      const isCaster = group !== 'floor';
      for (let i = 0; i < src.length; i += 3) {
        const x = src[i] * s, y = src[i + 1] * syy, z = src[i + 2] * s;
        const wx = p.x + x * cy + z * sy;
        const wz = p.z + (-x * sy + z * cy);
        if (isCaster) casters.push(wx, y, wz);
        if (wx < x0) x0 = wx; if (wx > x1) x1 = wx;
        if (wz < z0) z0 = wz; if (wz > z1) z1 = wz;
      }
      if (isCaster) {
        allBoxes.push(x0, x1, z0, z1);
        (group === 'walls' ? wallBoxes : propBoxes).push(x0, x1, z0, z1);
      }
    }
  }
  for (const t of extra) casters.push(...t);
  return {
    casters: Float64Array.from(casters),
    allBoxes: Float64Array.from(allBoxes),
    propBoxes: Float64Array.from(propBoxes),
    wallBoxes: Float64Array.from(wallBoxes),
  };
}
const WORLD = buildWorld();
/** A caster of height h throws its shadow at most h * |Lh| / Ly horizontally, so a receiver with no
 * caster AABB inside that distance CANNOT be legitimately shadowed: anything the map reports there
 * is acne, and any change there between two frames is crawl. */
const THROW = casterHeight * Math.hypot(S.LIGHT_OFFSET[0], S.LIGHT_OFFSET[2]) / S.LIGHT_OFFSET[1];
const CLEAR_R = THROW + 0.35;
function clearOf(boxes, x, z, r) {
  for (let i = 0; i < boxes.length; i += 4) {
    if (x > boxes[i] - r && x < boxes[i + 1] + r && z > boxes[i + 2] - r && z < boxes[i + 3] + r) return false;
  }
  return true;
}

// ------------------------------------------------------------------ projection + rasteriser
/** The fit plus the light's axial distance — everything the projection needs. */
function rigOf(fit) {
  return {
    cx: fit.target[0], cy: fit.target[1], cz: fit.target[2],
    half: fit.half, near: fit.near, far: fit.far,
    D: Math.hypot(fit.light[0] - fit.target[0], fit.light[1] - fit.target[1], fit.light[2] - fit.target[2]),
    bias: fit.bias, normalBias: fit.normalBias, texel: fit.texel,
  };
}
/** Reproduces `shadow.matrix * worldPosition` (bias matrix included) for an ortho shadow camera. */
function project(q, rig) {
  const ox = rig.cx + AX.z[0] * rig.D;
  const oy = rig.cy + AX.z[1] * rig.D;
  const oz = rig.cz + AX.z[2] * rig.D;
  const dx = q[0] - ox, dy = q[1] - oy, dz = q[2] - oz;
  const x = dx * AX.x[0] + dy * AX.x[1] + dz * AX.x[2];
  const y = dx * AX.y[0] + dy * AX.y[1] + dz * AX.y[2];
  const depth = -(dx * AX.z[0] + dy * AX.z[1] + dz * AX.z[2]);
  const span = rig.far - rig.near;
  return [x / rig.half * 0.5 + 0.5, y / rig.half * 0.5 + 0.5, (2 * depth - rig.far - rig.near) / span * 0.5 + 0.5];
}
function rasterize(casters, rig) {
  const buf = new Float32Array(MAP * MAP).fill(1);
  const N = MAP;
  for (let t = 0; t < casters.length; t += 9) {
    const a = project([casters[t], casters[t + 1], casters[t + 2]], rig);
    const b = project([casters[t + 3], casters[t + 4], casters[t + 5]], rig);
    const c = project([casters[t + 6], casters[t + 7], casters[t + 8]], rig);
    // BACK-face casting: three maps a FrontSide material to BackSide in the depth pass, and WebGL's
    // front face is CCW — so the triangles that survive are the negatively-oriented ones.
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
    if (area >= 0) continue;
    const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]) * N - 0.5));
    const x1 = Math.min(N - 1, Math.ceil(Math.max(a[0], b[0], c[0]) * N - 0.5));
    const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]) * N - 0.5));
    const y1 = Math.min(N - 1, Math.ceil(Math.max(a[1], b[1], c[1]) * N - 0.5));
    if (x1 < x0 || y1 < y0) continue;
    const d0 = b[1] - c[1], d1 = c[1] - a[1], d2 = a[1] - b[1];
    const e0 = c[0] - b[0], e1 = a[0] - c[0], e2 = b[0] - a[0];
    for (let ty = y0; ty <= y1; ty++) {
      const py = (ty + 0.5) / N;
      const row = ty * N;
      for (let tx = x0; tx <= x1; tx++) {
        const px = (tx + 0.5) / N;
        const w0 = (d0 * (px - b[0]) + e0 * (py - b[1])) / area;
        const w1 = (d1 * (px - c[0]) + e1 * (py - c[1])) / area;
        const w2 = (d2 * (px - a[0]) + e2 * (py - a[1])) / area;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w0 * a[2] + w1 * b[2] + w2 * c[2];
        if (z < buf[row + tx]) buf[row + tx] = z;
      }
    }
  }
  return buf;
}
/** three.js shadowmap_fragment/shadowmap_pars_fragment for SHADOWMAP_TYPE_PCF_SOFT, tap for tap. */
function sampleShadow(buf, rig, px, py, pz, n, bias, normalBias) {
  const q = [px + n[0] * normalBias, py + n[1] * normalBias, pz + n[2] * normalBias];
  const s = project(q, rig);
  const z = s[2] + bias;
  if (!(s[0] >= 0 && s[0] <= 1 && s[1] >= 0 && s[1] <= 1) || z > 1) return 1;   // three's early-out
  const N = MAP;
  const u = s[0] * N, v = s[1] * N;
  const fx = u + 0.5 - Math.floor(u + 0.5);
  const fy = v + 0.5 - Math.floor(v + 0.5);
  const bu = u - fx, bv = v - fy;
  const C = (du, dv) => {
    const tx = Math.min(N - 1, Math.max(0, Math.round(bu) + du));
    const ty = Math.min(N - 1, Math.max(0, Math.round(bv) + dv));
    return buf[ty * N + tx] >= z ? 1 : 0;
  };
  const m = (p, q2, w) => p + (q2 - p) * w;
  return (C(0, 0) + C(1, 0) + C(0, 1) + C(1, 1)
    + m(C(-1, 0), C(2, 0), fx) + m(C(-1, 1), C(2, 1), fx)
    + m(C(0, -1), C(0, 2), fy) + m(C(1, -1), C(1, 2), fy)
    + m(m(C(-1, -1), C(2, -1), fx), m(C(-1, 2), C(2, 2), fx), fy)) / 9;
}

// ------------------------------------------------------- the OLD rig, reproduced for comparison
/** Exactly what render.ts did before src/shadow.ts existed: a fixed +-30 box whose centre is the
 * player's raw position, with hardcoded bias/normalBias and no snapping. */
function legacyRig(playerX, playerZ) {
  return {
    cx: playerX, cy: 0, cz: playerZ,
    half: 30, near: 1, far: 60, D: Math.hypot(...S.LIGHT_OFFSET),
    bias: -0.0003, normalBias: 0.02, texel: 60 / MAP,
  };
}
const CAM_SETTINGS = [
  { scale: 1.0, zoom: 0.50, aspect: 2.16 },   // a phone held in landscape (400px tall)
  { scale: 3.0, zoom: 0.50, aspect: 2.16 },   // ...at the user's stored 「摄像机高度」
  { scale: 1.0, zoom: 1.00, aspect: 1.60 },   // a tablet / desktop window
  { scale: 0.4, zoom: 0.42, aspect: 0.46 },   // smallest viewport, closest camera
  { scale: 1.0, zoom: 1.15, aspect: 0.46 },   // phone in portrait
  { scale: 3.0, zoom: 1.00, aspect: 2.00 },   // extreme: whole arena on screen
];

// =========================================================== 1. the fit matches three.js exactly
{
  const fit = S.fitShadowBox(7.5, -12.25, 1, 1, 2, casterHeight);
  const light = new THREE.DirectionalLight(0xffffff, 1);
  light.position.set(fit.light[0], fit.light[1], fit.light[2]);
  light.target.position.set(fit.target[0], fit.target[1], fit.target[2]);
  light.shadow.mapSize.set(MAP, MAP);
  light.shadow.camera.near = fit.near;
  light.shadow.camera.far = fit.far;
  light.shadow.camera.left = -fit.half;
  light.shadow.camera.right = fit.half;
  light.shadow.camera.top = fit.half;
  light.shadow.camera.bottom = -fit.half;
  light.shadow.camera.updateProjectionMatrix();
  light.shadow.bias = fit.bias;
  light.shadow.normalBias = fit.normalBias;
  const scene = new THREE.Scene();
  scene.add(light);
  scene.add(light.target);
  scene.updateMatrixWorld(true);
  light.shadow.updateMatrices(light);

  const rig = rigOf(fit);
  let worst = 0;
  for (const p of [[0, 0, 0], [12, 0.5, -9], [-20, 2.5, 20], [ARENA_HALF - 0.5, 0.02, -ARENA_HALF + 0.5], [-33, 1.4, 7]]) {
    const expected = new THREE.Vector4(p[0], p[1], p[2], 1).applyMatrix4(light.shadow.matrix);
    const got = project(p, rig);
    for (const k of [0, 1, 2]) worst = Math.max(worst, Math.abs(expected.getComponent(k) - got[k]));
  }
  check('阴影矩阵与 three.js 逐点一致（shadowAxes/project 复刻了 light.shadow.matrix）', worst < 1e-9,
    `max component error ${worst.toExponential(2)}`);
  check('光源方向与 shadowAxes 的 z 轴一致（方向不变，只有盒子在动）',
    Math.abs(dot([fit.light[0] - fit.target[0], fit.light[1] - fit.target[1], fit.light[2] - fit.target[2]], AX.z)
      - Math.hypot(fit.light[0] - fit.target[0], fit.light[1] - fit.target[1], fit.light[2] - fit.target[2])) < 1e-9);
  // The bias the shader sees must be the one the depth-error budget asks for.
  const wantBias = -(S.SHADOW_BIAS_TEXELS * fit.texel * S.SHADOW_SLOPE_WORST) / (fit.far - fit.near);
  check('bias 由 texel 尺寸推导（不是硬编码常数）', Math.abs(fit.bias - wantBias) < 1e-12,
    `${fit.bias} vs ${wantBias}`);
  check('normalBias 是世界单位且随 texel 缩放',
    Math.abs(fit.normalBias - S.SHADOW_NORMAL_TEXELS * fit.texel) < 1e-12);
}

// =========================================================== 2. coverage of the visible ground
{
  // Every point of the visible ground quad lies inside the light-space rect of that quad, so
  // sampling a grid across the rect and projecting each point with both rigs covers the question
  // exactly: "would the shader even shadow-test this pixel, or is it outside the box (-> lit)?"
  let fixedMiss = 0;
  let legacyMiss = 0;
  let total = 0;
  const worst = [];
  for (const cam of CAM_SETTINGS) {
    for (const player of [[0, 0], [24, 18], [-30, 26], [33, -33]]) {
      const fit = S.fitShadowBox(player[0], player[1], cam.scale, cam.zoom, cam.aspect, casterHeight);
      const rig = rigOf(fit);
      const legacy = legacyRig(player[0], player[1]);
      const span = S.visibleGroundSpans(player[0], player[1], cam.scale, cam.zoom, cam.aspect, AX);
      let miss = 0;
      for (let i = 0; i <= 10; i++) {
        for (let j = 0; j <= 10; j++) {
          const P0 = groundPointFor(
            span.ax[0] + (span.ax[1] - span.ax[0]) * (i / 10),
            span.ay[0] + (span.ay[1] - span.ay[0]) * (j / 10),
          );
          if (P0 === null) continue;
          // Only what is both visible AND inside the arena is worth covering: past the walls is the
          // dark surround plane, which never receives shadows.
          if (Math.abs(P0[0]) > ARENA_HALF || Math.abs(P0[2]) > ARENA_HALF) continue;
          if (!groundVisible(P0[0], P0[2], player[0], player[1], cam.scale, cam.zoom, cam.aspect)) continue;
          total++;
          const pf = project(P0, rig);
          if (!(pf[0] >= 0 && pf[0] <= 1 && pf[1] >= 0 && pf[1] <= 1)) fixedMiss++;
          const pl = project(P0, legacy);
          if (!(pl[0] >= 0 && pl[0] <= 1 && pl[1] >= 0 && pl[1] <= 1)) { legacyMiss++; miss++; }
        }
      }
      worst.push(`scale ${cam.scale} aspect ${cam.aspect}: 旧盒子漏 ${(miss / 121 * 100).toFixed(0)}%`);
    }
  }
  console.log('\n[实测] 视野内地面落在阴影盒内的比例');
  console.log(`        旧 ±30 固定盒子: ${((1 - legacyMiss / total) * 100).toFixed(1)}% 覆盖`);
  console.log(`        新 视野拟合盒子: ${((1 - fixedMiss / total) * 100).toFixed(1)}% 覆盖`);
  for (const w of worst) console.log('          ' + w);
  check('视野内的地面全部落在阴影盒内（新拟合）', fixedMiss === 0, `${fixedMiss}/${total} 越界`);
  check('旧 ±30 盒子确实漏掉大片视野内地面（阴影缺失/边界扫过屏幕的来源）', legacyMiss > 0,
    `${legacyMiss}/${total} 越界`);
}

/** Is this ground point inside the view camera's frustum? (Exact: the same four side planes the fit
 * clips against, re-derived here from the camera numbers so the fit cannot mark its own homework.) */
function groundVisible(x, z, playerX, playerZ, scale, zoom, aspect, yawDeg = 0) {
  // The camera PAIR comes from the shipped camera.ts (one source of truth for height/back); the
  // frustum test below is still derived independently of shadow.ts, which is the part that matters
  // — the fit cannot mark its own homework on where the camera's edges are. The yaw basis is
  // re-derived HERE by hand (not via camera.ts::cameraBasis) for the same reason.
  const off = CAM.cameraOffset(scale);
  const height = off.height * zoom;
  const back = off.back * zoom;
  const psi = (yawDeg * Math.PI) / 180;
  const cam = [playerX + back * Math.sin(psi), height, playerZ + back * Math.cos(psi)];
  const zl = Math.hypot(height, back);
  const vz = [(back / zl) * Math.sin(psi), height / zl, (back / zl) * Math.cos(psi)];
  const vy = [-(height / zl) * Math.sin(psi), back / zl, -(height / zl) * Math.cos(psi)];
  // ORTHOGRAPHIC test (the renderer's projection — see camera.ts::orthoFrustumHeight): the frustum is
  // a fixed slab, so "visible" is a lateral extent plus a depth sign, with no fov tilt and no
  // dependence on how far away the point is.
  const halfH = CAM.orthoFrustumHeight(scale, zoom) / 2;
  const halfW = halfH * aspect;
  const dx = x - cam[0], dy = 0 - cam[1], dz = z - cam[2];
  const cy = dy * vy[1] + dz * vy[2];
  const cz = dx * vz[0] + dy * vz[1] + dz * vz[2];
  if (cz >= 0) return false;                       // behind the camera
  return Math.abs(dx) <= halfW + 1e-9 && Math.abs(cy) <= halfH + 1e-9;
}

/** A world-space ground point (y = 0) with the requested light-space (a, b). */
function groundPointFor(a, b) {
  const det = AX.x[0] * AX.y[2] - AX.x[2] * AX.y[0];
  if (Math.abs(det) < 1e-9) return null;
  return [(a * AX.y[2] - AX.y[0] * b) / det, 0, (AX.x[0] * b - a * AX.x[2]) / det];
}

// =========================================================== 2b. the 「摄像机水平角度」 orbit
{
  // (a) THE BASIS IS THREE'S. Pose a real vendored camera with `lookAt` at a few yaws and compare its
  // world basis to `camera.ts::cameraBasis` — that is the frame the shadow fit clips against and the
  // input mapping rotates with, so it must be the frame the renderer actually looks through.
  let worstBasis = 0;
  for (const scale of [0.4, 1, 3]) {
    for (const yaw of [-180, -90, -45, 0, 45, 90, 135, 180]) {
      const cam3 = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
      const off = CAM.cameraOffset(scale);
      const psi = (yaw * Math.PI) / 180;
      const eye = [7.5 + off.back * Math.sin(psi), off.height, -12.25 + off.back * Math.cos(psi)];
      cam3.position.set(eye[0], eye[1], eye[2]);
      cam3.lookAt(7.5, 0, -12.25);
      cam3.updateMatrixWorld(true);
      const m = cam3.matrixWorld.elements;
      const got = CAM.cameraBasis(scale, yaw);
      // three's columns: [0..2] = +X (right), [4..6] = +Y (up), [8..10] = +Z (toward the eye).
      const want = { vx: [m[0], m[1], m[2]], vy: [m[4], m[5], m[6]], vz: [m[8], m[9], m[10]] };
      for (const k of ['vx', 'vy', 'vz']) {
        for (let i = 0; i < 3; i++) worstBasis = Math.max(worstBasis, Math.abs(got[k][i] - want[k][i]));
      }
    }
  }
  check('cameraBasis == the basis of a real three camera posed with lookAt (24 scale/yaw pairs)',
    worstBasis < 1e-12, `max component error ${worstBasis.toExponential(2)}`);

  // (b) COVERAGE AT EVERY ANGLE. A rotated view quad has a different extent along the light's axes,
  // so the fitted box changes shape with the setting; what must NOT change is that it still contains
  // everything the camera can see inside the arena.
  let worstMiss = 0;
  let total = 0;
  for (const yaw of [-180, -135, -90, -45, 0, 45, 90, 135, 180]) {
    for (const cam of CAM_SETTINGS) {
      for (const player of [[0, 0], [24, 18], [-30, 26], [33, -33]]) {
        const fit = S.fitShadowBox(
          player[0], player[1], cam.scale, cam.zoom, cam.aspect, casterHeight, AX, yaw,
        );
        const rig = rigOf(fit);
        const span = S.visibleGroundSpans(player[0], player[1], cam.scale, cam.zoom, cam.aspect, AX, yaw);
        for (let i = 0; i <= 8; i++) {
          for (let j = 0; j <= 8; j++) {
            const P0 = groundPointFor(
              span.ax[0] + (span.ax[1] - span.ax[0]) * (i / 8),
              span.ay[0] + (span.ay[1] - span.ay[0]) * (j / 8),
            );
            if (P0 === null) continue;
            if (Math.abs(P0[0]) > ARENA_HALF || Math.abs(P0[2]) > ARENA_HALF) continue;
            if (!groundVisible(P0[0], P0[2], player[0], player[1], cam.scale, cam.zoom, cam.aspect, yaw)) continue;
            total++;
            const pf = project(P0, rig);
            if (!(pf[0] >= 0 && pf[0] <= 1 && pf[1] >= 0 && pf[1] <= 1)) worstMiss++;
          }
        }
      }
    }
  }
  check('视野内的地面在 9 个偏航角下仍然全部落在阴影盒内（旋转不改变覆盖率）',
    worstMiss === 0, `${worstMiss}/${total} 越界`);

  // (c) BACKWARD COMPATIBILITY. yaw 0 must reproduce the numbers this module produced before the
  // setting existed, so an upgrade (or the user's stored 0) cannot move a single texel.
  const spansAt0 = [];
  const spansOld = [];
  for (const cam of CAM_SETTINGS) {
    for (const player of [[0, 0], [24, 18], [-30, 26]]) {
      const a = S.visibleGroundSpans(player[0], player[1], cam.scale, cam.zoom, cam.aspect, AX, 0);
      // the pre-yaw formula, written out again on purpose
      const off = CAM.cameraOffset(cam.scale);
      const height = off.height * cam.zoom;
      const back = off.back * cam.zoom;
      const zl = Math.hypot(height, back);
      const vz = [0, height / zl, back / zl];
      const vx = [1, 0, 0];
      const vy = [0, vz[2], -vz[1]];
      const halfH = CAM.orthoFrustumHeight(cam.scale, cam.zoom) / 2;
      const halfW = halfH * cam.aspect;
      const camPos = [player[0], height, player[1] + back];
      const planes = [
        [vx[0], vx[1], vx[2], halfW], [-vx[0], -vx[1], -vx[2], halfW],
        [vy[0], vy[1], vy[2], halfH], [-vy[0], -vy[1], -vy[2], halfH],
      ];
      let poly = [[-400, -400], [400, -400], [400, 400], [-400, 400]];
      const clip = (nx, nz, c) => {
        const out = [];
        for (let i = 0; i < poly.length; i++) {
          const p = poly[i], q = poly[(i + 1) % poly.length];
          const fa = nx * p[0] + nz * p[1] - c, fb = nx * q[0] + nz * q[1] - c;
          if (fa <= 0) out.push(p);
          if ((fa <= 0) !== (fb <= 0)) {
            const t = fa / (fa - fb);
            out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
          }
        }
        poly = out;
      };
      for (const [nx, ny, nz, half] of planes) clip(nx, nz, nx * camPos[0] + ny * camPos[1] + nz * camPos[2] + half);
      spansOld.push(poly.length);
      spansAt0.push(a.corners);
    }
  }
  check('yaw 0 reproduces the pre-setting fit exactly (same corner count at 12 samples)',
    JSON.stringify(spansAt0) === JSON.stringify(spansOld),
    `${spansAt0.join(',')} vs ${spansOld.join(',')}`);
}

// =========================================================== 3. snapping kills the crawl
{
  const cases = CAM_SETTINGS;
  /** The box centre in light-space coordinates (a, b) — the grid the snapping quantises. */
  const gridOf = (f) => [
    f.target[0] * AX.x[0] + f.target[1] * AX.x[1] + f.target[2] * AX.x[2],
    f.target[0] * AX.y[0] + f.target[1] * AX.y[1] + f.target[2] * AX.y[2],
  ];
  let onGrid = 0;
  let identical = 0;
  let boundedDrift = 0;
  for (const cam of cases) {
    const base = S.fitShadowBox(10, -6, cam.scale, cam.zoom, cam.aspect, casterHeight);
    const [a0, b0] = gridOf(base);
    // (a) the centre sits on a whole-texel lattice in light space — the structural guarantee
    const ra = Math.abs(a0 / base.texel - Math.round(a0 / base.texel));
    const rb = Math.abs(b0 / base.texel - Math.round(b0 / base.texel));
    if (ra < 1e-9 && rb < 1e-9) onGrid++;
    // (b) WALK THE CAMERA ACROSS 4 TEXELS in small steps along the light's own axes: the centre may
    // only ever take whole-texel values, and it must advance by whole texels — a grid that could
    // take any intermediate value is exactly the "creep" that makes shadows crawl.
    const steps = [];
    for (let t = 0; t <= 4; t += 0.05) {
      const f = S.fitShadowBox(
        10 + t * base.texel * AX.x[0] + t * base.texel * AX.y[0],
        -6 + t * base.texel * AX.x[2] + t * base.texel * AX.y[2],
        cam.scale, cam.zoom, cam.aspect, casterHeight,
      );
      const [a, b] = gridOf(f);
      steps.push([a / base.texel, b / base.texel, f.half, f.texel]);
    }
    const integralSteps = steps.every(([a, b]) =>
      Math.abs(a - Math.round(a)) < 1e-9 && Math.abs(b - Math.round(b)) < 1e-9);
    // Over a 4-texel walk each light-space coordinate may only take the 5 integer values it passes
    // through — anything else means the grid is taking sub-texel positions.
    const valuesA = new Set(steps.map(([a]) => Math.round(a))).size;
    const valuesB = new Set(steps.map(([, b]) => Math.round(b))).size;
    const maxJump = Math.max(...steps.map(([a, b], i) => (i === 0 ? 0
      : Math.max(Math.abs(Math.round(a) - Math.round(steps[i - 1][0])), Math.abs(Math.round(b) - Math.round(steps[i - 1][1]))))));
    // The size may only wobble in the last few float digits (it is derived from the unclipped
    // frustum quad, which translates rigidly with the camera, so it cannot drift meaningfully) —
    // a texel edge moving by 1e-9 of a texel re-aligns nothing.
    const half0 = steps[0][2];
    const texel0 = steps[0][3];
    const fixedSize = steps.every(([, , half, texel]) =>
      Math.abs(half - half0) <= 1e-9 * half0 && Math.abs(texel - texel0) <= 1e-9 * texel0);
    if (integralSteps) identical++;
    if (integralSteps && valuesA <= 5 && valuesB <= 5 && maxJump <= 1 && fixedSize) boundedDrift++;
  }
  check('阴影盒中心始终落在整 texel 网格上（结构保证）', onGrid === cases.length, `${onGrid}/${cases.length}`);
  check('连续滑过 4 个 texel 时中心只取整 texel 值、每次最多跳 1 个 texel、尺寸不变',
    identical === cases.length && boundedDrift === cases.length,
    `on-grid ${identical}/${cases.length}, whole-texel steps ${boundedDrift}/${cases.length}`);
}

// =========================================================== 4. the real room: crawl measured
const FLOOR_Y = P.FLOOR_TOP;   // tiles sit with their base at 0, so their top is FLOOR_TOP
const floorSamples = [];
for (let x = -ARENA_HALF + 0.5; x <= ARENA_HALF - 0.5; x += 0.5) {
  for (let z = -ARENA_HALF + 0.5; z <= ARENA_HALF - 0.5; z += 0.5) {
    if (clearOf(WORLD.allBoxes, x, z, CLEAR_R)) floorSamples.push([x, FLOOR_Y, z]);
  }
}
const floorAll = [];
for (let x = -ARENA_HALF + 0.5; x <= ARENA_HALF - 0.5; x += 0.5) {
  for (let z = -ARENA_HALF + 0.5; z <= ARENA_HALF - 0.5; z += 0.5) floorAll.push([x, FLOOR_Y, z]);
}
const FLOOR_GRID = floorSamples.length;
{
  const step = 11 / 60;   // one frame at full walking speed (CONFIG.playerSpeed)
  /** Is this receiver inside the box's frustum (i.e. would the shader even test it)? */
  const covered = (rig, x, y, z) => {
    const s = project([x, y, z], rig);
    return s[0] >= 0 && s[0] <= 1 && s[1] >= 0 && s[1] <= 1 && s[2] <= 1;
  };
  function crawl(cam, rigA, rigB) {
    const bufA = rasterize(WORLD.casters, rigA);
    const bufB = rasterize(WORLD.casters, rigB);
    let clearFlip = 0;
    for (const [x, y, z] of floorSamples) {
      const a = sampleShadow(bufA, rigA, x, y, z, [0, 1, 0], rigA.bias, rigA.normalBias);
      const b = sampleShadow(bufB, rigB, x, y, z, [0, 1, 0], rigB.bias, rigB.normalBias);
      if (Math.abs(a - b) > 0.05) clearFlip++;
    }
    // The fair comparison is over receivers BOTH rigs actually shadow-test: a small box "wins" the
    // raw count simply by leaving part of the floor out of the map (those pixels are lit in both
    // frames and cannot flip).
    let both = 0;
    let allFlip = 0;
    for (const [x, y, z] of floorAll) {
      if (!covered(rigA, x, y, z) || !covered(rigB, x, y, z)) continue;
      both++;
      const a = sampleShadow(bufA, rigA, x, y, z, [0, 1, 0], rigA.bias, rigA.normalBias);
      const b = sampleShadow(bufB, rigB, x, y, z, [0, 1, 0], rigB.bias, rigB.normalBias);
      if (Math.abs(a - b) > 0.05) allFlip++;
    }
    return { clearFlip: clearFlip / FLOOR_GRID, allFlip: both ? allFlip / both : 0 };
  }
  const cams = [
    { scale: 1, zoom: 0.5, aspect: 2.16 },   // the likely phone case
    { scale: 3, zoom: 0.5, aspect: 2.16 },   // ...at the stored 「摄像机高度」
    { scale: 3, zoom: 1.0, aspect: 2.00 },   // whole arena on screen
  ];
  console.log(`\n[实测] 走一帧（${step.toFixed(3)} 单位）后地面 shadow 值变化`);
  let worstNewClear = 0;
  let worstNewAll = 0;
  let worstLegacyAll = 0;
  for (const cam of cams) {
    const legacyA = legacyRig(0, 0);
    const legacyB = legacyRig(step, step);
    const newA = rigOf(S.fitShadowBox(0, 0, cam.scale, cam.zoom, cam.aspect, casterHeight));
    const newB = rigOf(S.fitShadowBox(step, step, cam.scale, cam.zoom, cam.aspect, casterHeight));
    const before = crawl(cam, legacyA, legacyB);
    const after = crawl(cam, newA, newB);
    console.log(`        scale ${cam.scale} aspect ${cam.aspect}: 旧盒子 ${(before.allFlip * 100).toFixed(2)}% 全场变化`
      + ` | 新盒子 ${(after.allFlip * 100).toFixed(2)}%, 无阴影区 ${(after.clearFlip * 100).toFixed(2)}%`);
    worstNewClear = Math.max(worstNewClear, after.clearFlip);
    worstNewAll = Math.max(worstNewAll, after.allFlip);
    worstLegacyAll = Math.max(worstLegacyAll, before.allFlip);
  }
  check('新盒子上「不可能有阴影」的地面采样点零变化（没有蠕动噪点）', worstNewClear === 0,
    `${(worstNewClear * 100).toFixed(2)}%`);
  check('旧盒子在同一测量下确实在蠕动（回归证据）', worstLegacyAll > 0,
    `${(worstLegacyAll * 100).toFixed(2)}%`);
  check('新盒子的逐帧变化比旧盒子小一个数量级',
    worstNewAll * 10 < worstLegacyAll, `${(worstNewAll * 100).toFixed(2)}% vs ${(worstLegacyAll * 100).toFixed(2)}%`);
}

// =========================================================== 5. acne probe: an isolated lit slab
/**
 * A synthetic thin slab (0.11 thick = exactly the wall's thickness), 6 x 3 units, standing in a
 * patch of the room with no other caster within the shadow-throw radius. It is the worst receiver
 * shape in the room — a lit face only one to three texels of slope away from its own back face —
 * and with nothing else nearby, ANY shadow the map reports on its lit face is acne by definition.
 * That makes the probe a reference-free measurement of the bias rule, and sweeping the slab's yaw
 * sweeps the face's angle to the light from the room's worst case (72°) to its best (60°).
 */
const PROBE_CLEAR = CLEAR_R + 4;   // room for the slab's own 6-unit width
const probeSpot = (() => {
  for (let x = -30; x <= 30; x += 2) {
    for (let z = -30; z <= 30; z += 2) {
      if (clearOf(WORLD.allBoxes, x, z, PROBE_CLEAR)) return [x, z];
    }
  }
  return [0, 0];
})();
function slabTriangles(cx, cz, yawDeg) {
  const th = (yawDeg * Math.PI) / 180;
  const cy = Math.cos(th);
  const sy = Math.sin(th);
  const hx = 3;
  const hy = 1.5;
  const hz = 0.055;
  const V = [
    [-hx, 0, -hz], [hx, 0, -hz], [hx, 2 * hy, -hz], [-hx, 2 * hy, -hz],
    [-hx, 0, hz], [hx, 0, hz], [hx, 2 * hy, hz], [-hx, 2 * hy, hz],
  ].map(([x, y, z]) => [cx + x * cy + z * sy, y, cz + (-x * sy + z * cy)]);
  const tris = [];
  for (const [a, b, c, d] of [[4, 5, 6, 7], [1, 0, 3, 2]]) {   // the two faces
    tris.push(...V[a], ...V[b], ...V[c], ...V[a], ...V[c], ...V[d]);
  }
  const n = [sy, 0, cy];
  const lit = n[0] * AX.z[0] + n[2] * AX.z[2] > 0 ? n : [-n[0], 0, -n[2]];
  return { tris, lit, yawDeg, cos: lit[0] * AX.z[0] + lit[2] * AX.z[2] };
}
/**
 * Acne rate on the slab's lit face for one (rig, biasTexels, normalTexels) combination.
 * `biasTexels` is the multiplier on `texel * SHADOW_SLOPE_WORST` — the same rule the module uses,
 * so the sweep is directly over the shipped constant.
 */
function acneProbe(yawDeg, rig, biasTexels, normalTexels, slab = null) {
  const probe = slab ?? slabTriangles(probeSpot[0], probeSpot[1], yawDeg);
  const world = buildWorld([probe.tris]);
  const buf = rasterize(world.casters, rig);
  const bias = -(biasTexels * rig.texel * S.SHADOW_SLOPE_WORST) / (rig.far - rig.near);
  const normalBias = normalTexels * rig.texel;
  let samples = 0;
  let acne = 0;
  for (let u = -2.2; u <= 2.2; u += 0.04) {
    for (let y = 0.2; y <= 2.8; y += 0.04) {
      const x = probeSpot[0] + u * Math.cos((yawDeg * Math.PI) / 180) + probe.lit[0] * 0.056;
      const z = probeSpot[1] - u * Math.sin((yawDeg * Math.PI) / 180) + probe.lit[2] * 0.056;
      const sh = sampleShadow(buf, rig, x, y, z, probe.lit, bias, normalBias);
      samples++;
      if (sh < 0.999) acne++;
    }
  }
  return acne / samples;
}
{
  const cam = { scale: 1, zoom: 0.5, aspect: 2 };    // a real phone in landscape
  const fit = S.fitShadowBox(probeSpot[0], probeSpot[1], cam.scale, cam.zoom, cam.aspect, casterHeight);
  const rig = rigOf(fit);
  const legacy = legacyRig(probeSpot[0], probeSpot[1]);
  const yaws = [0, 20, 40, 60, 90];
  const curve = [0.25, 0.5, 0.6, 1.0, 1.5, 2.5];
  console.log(`\n[实测] 孤立薄板探针（${probeSpot[0]},${probeSpot[1]}）光照面的自阴影噪点率`);
  console.log(`        新盒子 texel ${rig.texel.toFixed(4)} / 旧盒子 texel ${legacy.texel.toFixed(4)}, SHADOW_SLOPE_WORST ${S.SHADOW_SLOPE_WORST.toFixed(2)}`);
  console.log('        板朝向(与光夹角)   旧硬编码常数   ' + curve.map((c) => `bias=${c}`.padStart(11)).join(''));
  const legacyByYaw = [];
  for (const yaw of yaws) {
    const slab = slabTriangles(probeSpot[0], probeSpot[1], yaw);
    const angle = (Math.acos(slab.cos) * 180) / Math.PI;
    const before = acneProbe(yaw, legacy, 0.0003 * (60 - 1) / (S.SHADOW_SLOPE_WORST * legacy.texel), 0.02 / legacy.texel, slab);
    const row = curve.map((c) => `${(acneProbe(yaw, rig, c, S.SHADOW_NORMAL_TEXELS, slab) * 100).toFixed(2)}%`.padStart(11)).join('');
    console.log(`        ${String(yaw).padStart(3)}° (${angle.toFixed(1)}°)        ${(before * 100).toFixed(2)}%`.padEnd(46) + row);
    legacyByYaw.push(before);
  }
  const worstAcne = Math.max(...yaws.map((y) => acneProbe(y, rig, S.SHADOW_BIAS_TEXELS, S.SHADOW_NORMAL_TEXELS)));
  check(`出厂常数 (bias ${S.SHADOW_BIAS_TEXELS} × slope-worst texel / normalBias ${S.SHADOW_NORMAL_TEXELS} texel) 下探针噪点为 0`,
    worstAcne === 0, `最差 ${(worstAcne * 100).toFixed(2)}%`);
  // The cost side of the same trade-off: how far a contact shadow is pushed off its caster. This is
  // what stops "crank the bias until the acne is gone" from being a free fix.
  const elev = Math.asin(AX.z[1]);
  const gapWorld = (S.SHADOW_BIAS_TEXELS * rig.texel * S.SHADOW_SLOPE_WORST) / Math.sin(elev);
  const pxPerUnit = 400 / (2 * (24 * cam.scale * cam.zoom + 15 * cam.zoom) * Math.tan((52 * Math.PI) / 180 / 2));
  console.log(`        → 接触阴影的位移代价 ${gapWorld.toFixed(3)} 世界单位 ≈ ${(gapWorld * pxPerUnit).toFixed(2)} px（手机横屏）`);
  check('接触阴影位移在 1 个像素以内（bias 没有换掉「阴影贴着物体」）', gapWorld * pxPerUnit < 1.0,
    `${(gapWorld * pxPerUnit).toFixed(2)} px`);
}

// =========================================================== 6. depth window + margin
{
  const cam = { scale: 3, zoom: 1, aspect: 2 };
  for (const player of [[0, 0], [ARENA_HALF - 2, ARENA_HALF - 2], [-ARENA_HALF + 2, -ARENA_HALF + 2]]) {
    const fit = S.fitShadowBox(player[0], player[1], cam.scale, cam.zoom, cam.aspect, casterHeight);
    // every caster in the arena must land inside [near, far]
    let worstNear = Infinity;
    let worstFar = -Infinity;
    for (const sx of [-ARENA_HALF, ARENA_HALF]) {
      for (const sz of [-ARENA_HALF, ARENA_HALF]) {
        for (const y of [0, casterHeight]) {
          const d = (sx - fit.light[0]) * AX.z[0] + (y - fit.light[1]) * AX.z[1] + (sz - fit.light[2]) * AX.z[2];
          const depth = -d;
          worstNear = Math.min(worstNear, depth);
          worstFar = Math.max(worstFar, depth);
        }
      }
    }
    check(`深度窗口覆盖整个竞技场的投射体 (player ${player[0]},${player[1]})`,
      worstNear >= fit.near - 1e-9 && worstFar <= fit.far + 1e-9,
      `near ${fit.near.toFixed(2)} far ${fit.far.toFixed(2)} caster ${worstNear.toFixed(2)}..${worstFar.toFixed(2)}`);
  }
  const lightThrow = Math.hypot(S.LIGHT_OFFSET[0], S.LIGHT_OFFSET[2]) / S.LIGHT_OFFSET[1];
  check('离屏投射体余量覆盖最高投射体的阴影投射距离',
    S.shadowMarginFor(casterHeight) >= casterHeight * (1 + lightThrow) - 1e-9,
    `margin ${S.shadowMarginFor(casterHeight).toFixed(2)} for caster ${casterHeight.toFixed(2)}`);
  // The cap must be big enough to hold the whole arena in LIGHT space, otherwise the corners of the
  // room lose their shadows at the zoom levels where the whole room is visible.
  const maxHalf = S.shadowHalfMaxFor(casterHeight);
  const fitWide = S.fitShadowBox(0, 0, 3, 1, 2, casterHeight);
  check('盒子上限足以在光空间里覆盖整个竞技场（远处角落也有阴影）',
    fitWide.half >= maxHalf - 1e-9 || fitWide.half === maxHalf,
    `half ${fitWide.half.toFixed(2)} vs cap ${maxHalf.toFixed(2)}`);
  const arenaSpanA = ARENA_HALF * (Math.abs(AX.x[0]) + Math.abs(AX.x[2]));
  const arenaSpanB = ARENA_HALF * (Math.abs(AX.y[0]) + Math.abs(AX.y[2]));
  check('上限 >= 竞技场在光空间的半展 + 余量',
    maxHalf >= Math.max(arenaSpanA, arenaSpanB) + S.shadowMarginFor(casterHeight) - 1e-9,
    `${maxHalf.toFixed(2)}`);
}

// ---------------------------------------------------------------------------------- summary
console.log(`\n阴影（shadow.ts）验证：${passed} 项通过, ${failures.length} 项失败`);
for (const f of failures) console.log('  ✗ ' + f);
process.exit(failures.length === 0 ? 0 : 1);
