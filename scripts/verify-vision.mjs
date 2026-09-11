/**
 * CPU-side verification for the PLAYER'S VISION (src/vision.ts): the occlusion polygon, the fade
 * curve, and — most importantly — the two gameplay invariants that make the feature fair.
 *
 * Rules under test:
 *   - the polygon agrees with `lineBlocked` (the SAME predicate the sim uses for the gunner fire
 *     gate and the melee sweep) on a 0.5-unit grid over the whole arena, from ten different player
 *     positions including wall-hugging ones and corridors. Points that disagree may differ only
 *     within a few millimetres of the true shadow edge: the polygon brackets each silhouette
 *     corner with a +-VISION_ANGLE_EPS ray pair, so a hairline wedge per corner is the honest
 *     approximation error, and the check MEASURES it rather than trusting it;
 *   - the sector distances are the same nearest-cover-hit the level module reports (no sampling
 *     drift), and the corner angles are taken from the SKIN-SHRUNK box (the bug this suite was
 *     written to catch: taking them from the raw footprint let a ~2-degree sector interpolate
 *     between "hit" and "miss" and leaked a shadow wedge tens of units wide);
 *   - without obstacles there is no darkness anywhere, and the polygon degrades to the seed ring;
 *   - no invisible shooters (segment blocking is symmetric, so an enemy that may fire is visible)
 *     and no blind hits (anything within VISION_REVEAL_R is visible, which is why that radius is
 *     asserted to exceed the contact threshold);
 *   - cover dimming judges the NEAREST point of a footprint, so the wall you are leaning on stays
 *     lit while the one behind it goes dark.
 *
 * Run:  npm run build && node scripts/verify-vision.mjs
 * Exit code is non-zero when any assertion fails.
 */
const VISION = new URL('../dist/apps/shooter/src/vision.js', import.meta.url);
const GAME = new URL('../dist/apps/shooter/src/game.js', import.meta.url);
const LEVEL = new URL('../dist/apps/shooter/src/level.js', import.meta.url);
const MATH = new URL('../dist/apps/shooter/src/math2.js', import.meta.url);
const CONFIG_URL = new URL('../dist/apps/shooter/src/config.js', import.meta.url);

const V = await import(VISION.href);
const { OBSTACLES, SEGMENT_SKIN, firstCoverHit, lineBlocked, overlapsCover } = await import(LEVEL.href);
const { nearestPointOnAabb, raySegmentHit } = await import(MATH.href);
const { CONFIG } = await import(CONFIG_URL.href);

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ' — ' + detail : ''));
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const RAD = 180 / Math.PI;
const DT = 1 / 60;   // the sim is frame-based; every scenario below steps one frame at a time

const CAP = V.VISION_SEEDS + 12 * OBSTACLES.length + 2;
const fieldFor = (origin, obstacles = OBSTACLES) => {
  const f = V.createVisionField(CAP);
  V.rebuildVision(f, origin, obstacles);
  return f;
};
const ORIGIN = { x: 0, y: 0 };

// ------------------------------------------------------------- constants / pool sizing
{
  check('种子角 16 / 查询半径 130 / 渐隐带 1.2 / 近身 6',
    V.VISION_SEEDS === 16 && V.VISION_QUERY_R === 130 && V.VISION_FADE === 1.2 && V.VISION_REVEAL_R === 6,
    `${V.VISION_SEEDS} ${V.VISION_QUERY_R} ${V.VISION_FADE} ${V.VISION_REVEAL_R}`);
  check('变暗滑杆：默认 0.55 在 0..0.85 之间，步进 0.05',
    V.VISION_DIM_DEFAULT === 0.55 && V.VISION_DIM_MIN === 0 && V.VISION_DIM_MAX === 0.85
    && V.VISION_DIM_STEP === 0.05
    && V.VISION_DIM_DEFAULT >= V.VISION_DIM_MIN && V.VISION_DIM_DEFAULT <= V.VISION_DIM_MAX,
    String(V.VISION_DIM_DEFAULT));
  // The fairness floor: VISION_REVEAL_R must cover everything that can touch the player, or a
  // corner-hugging chaser could deal contact damage while invisible.
  const contact = CONFIG.enemyR + CONFIG.playerR + 1.2;
  check('近身可见半径大于接触判定距离（不会零预警挨打）',
    V.VISION_REVEAL_R > contact, `${V.VISION_REVEAL_R} vs ${contact.toFixed(2)}`);
  check('近身可见半径小于枪手交战距离（不会把整场战斗都揭开）',
    V.VISION_REVEAL_R < CONFIG.gunnerRange, `${V.VISION_REVEAL_R} vs ${CONFIG.gunnerRange}`);
  check('池容量至少覆盖 种子 + 每块掩体 4 角 x 3 射线',
    CAP >= V.VISION_SEEDS + 12 * OBSTACLES.length, String(CAP));
}

// ------------------------------------------------------------------- raySegmentHit
{
  const a = { x: 2, y: -1 };
  const b = { x: 2, y: 1 };
  check('射线命中线段', near(raySegmentHit({ x: 0, y: 0 }, { x: 1, y: 0 }, a, b), 2, 1e-9),
    String(raySegmentHit({ x: 0, y: 0 }, { x: 1, y: 0 }, a, b)));
  check('射线平行于线段 -> 未命中',
    raySegmentHit({ x: 0, y: 0 }, { x: 0, y: 1 }, a, b) === -1);
  check('线段在射线背后 -> 未命中',
    raySegmentHit({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: -3, y: -1 }, { x: -3, y: 1 }) === -1);
  check('交点在线段延长线上 -> 未命中',
    raySegmentHit({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 3 }, { x: 2, y: 5 }) === -1);
  check('退化线段（两点重合）-> 未命中',
    raySegmentHit({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 0 }) === -1);
  // A grazing hit at an endpoint counts: this is what keeps the boundary continuous while walking
  // along a wall.
  check('擦过端点算命中', near(raySegmentHit({ x: 1, y: 1 }, { x: 1, y: -1 }, { x: 2, y: 0 }, { x: 3, y: 0 }), 1, 1e-9),
    String(raySegmentHit({ x: 1, y: 1 }, { x: 1, y: -1 }, { x: 2, y: 0 }, { x: 3, y: 0 })));
  check('射线长度按 dir 的尺度计（单位向量 -> 世界单位）',
    near(raySegmentHit({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 5, y: -2 }, { x: 5, y: 2 }), 5, 1e-9));
}

// -------------------------------------------------------------------- field structure
{
  const f = fieldFor(ORIGIN);
  check('真实布局下没有触发池上限截断（不会静默丢阴影）', f.raw <= f.cap && f.n === f.raw,
    `n=${f.n} raw=${f.raw} cap=${f.cap}`);
  check('扇区数不少于种子数', f.n >= V.VISION_SEEDS, String(f.n));
  check('角度从 0 开始且严格递增', f.angles[0] === 0
    && (() => { for (let i = 1; i < f.n; i++) if (!(f.angles[i] > f.angles[i - 1])) return false; return true; })(),
    String(f.angles[0]));
  let anglesOk = true;
  let dirsOk = true;
  let distOk = true;
  for (let i = 0; i < f.n; i++) {
    if (!(f.angles[i] >= 0 && f.angles[i] < 2 * Math.PI)) anglesOk = false;
    if (Math.abs(Math.hypot(f.dirX[i], f.dirY[i]) - 1) > 1e-6) dirsOk = false;
    if (!(f.dist[i] >= V.VISION_MIN_R && f.dist[i] <= V.VISION_QUERY_R)) distOk = false;
  }
  check('角度都在 [0, 2π)', anglesOk);
  check('方向向量都是单位长', dirsOk);
  check('边界距离都在 [VISION_MIN_R, VISION_QUERY_R]', distOk);
  check('原点处永远是可见的', V.visionFadeAt(f, 0, 0) === 1);

  // Every sector that is NOT an exact silhouette-corner ray must report the distance the level
  // module reports along that direction, and visibility must actually FLIP there.
  //
  // The exact corner rays are excluded on purpose: they are ill-conditioned by construction (the
  // ray grazes the padded corner, so a 1e-16 direction change swings the answer between "hit at 24
  // units" and "no hit"), and they are exactly the hairline wedges the grid check below measures.
  const cornerAngles = (origin) => {
    const out = [];
    for (const o of OBSTACLES) {
      const x0 = o.x - o.hw - SEGMENT_SKIN;
      const x1 = o.x + o.hw + SEGMENT_SKIN;
      const y0 = o.y - o.hh - SEGMENT_SKIN;
      const y1 = o.y + o.hh + SEGMENT_SKIN;
      for (const [cx, cy] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) {
        out.push(Math.atan2(cy - origin.y, cx - origin.x));
      }
    }
    return out;
  };
  const angleGap = (a, b) => {
    let d = Math.abs(a - b) % (2 * Math.PI);
    return d > Math.PI ? 2 * Math.PI - d : d;
  };
  const corners = cornerAngles(ORIGIN);
  let mismatch = 0;
  let worst = 0;
  let flipped = 0;
  let checked = 0;
  let fieldChecked = 0;
  for (let i = 0; i < f.n; i++) {
    const a = f.angles[i];
    if (corners.some((ca) => angleGap(a, ca) < V.VISION_ANGLE_EPS * 0.5)) continue;
    const far = { x: Math.cos(a) * V.VISION_QUERY_R, y: Math.sin(a) * V.VISION_QUERY_R };
    const hit = firstCoverHit(ORIGIN, far, OBSTACLES, SEGMENT_SKIN);
    const t = hit === null ? V.VISION_QUERY_R : Math.max(V.VISION_MIN_R, hit.t * V.VISION_QUERY_R);
    const d = Math.abs(t - f.dist[i]);
    if (d > worst) worst = d;
    if (d > 1e-3) mismatch++;
    if (f.dist[i] < V.VISION_QUERY_R - 0.5) {
      checked++;
      // Structured-direction cross-check at the MIDDLE of the sector. Sampling exactly on a sector
      // edge is avoided on purpose: `dist[i]` is defined for the sector's START angle, so a
      // float-level mis-assignment at the seam would silently test the neighbouring sector instead
      // (which is what produced a false failure when this check first sampled the start angle).
      const aMid = i + 1 < f.n
        ? (a + f.angles[i + 1]) / 2
        : (a + f.angles[0] + 2 * Math.PI) / 2;
      if (!corners.some((ca) => angleGap(aMid, ca) < 2 * V.VISION_ANGLE_EPS)) {
        const ux = Math.cos(aMid);
        const uy = Math.sin(aMid);
        let lo1 = 0;
        let hi1 = V.VISION_QUERY_R;
        for (let k = 0; k < 50; k++) {
          const mid = (lo1 + hi1) / 2;
          if (lineBlocked(ORIGIN, { x: ux * mid, y: uy * mid }, OBSTACLES)) hi1 = mid;
          else lo1 = mid;
        }
        let lo3 = 0;
        let hi3 = V.VISION_QUERY_R;
        for (let k = 0; k < 50; k++) {
          const mid = (lo3 + hi3) / 2;
          if (V.visionFadeAt(f, ux * mid, uy * mid) >= 1) lo3 = mid;
          else hi3 = mid;
        }
        if (hi1 <= 100) {
          fieldChecked++;
          if (Math.abs(hi1 - hi3) > 0.02) flipped++;
        }
      }
    }
  }
  check('非角点射线的扇区距离都等于 level.ts 的最近命中（误差 < 1e-3）', mismatch === 0,
    `${mismatch} 个不一致, 最大偏差 ${worst}`);
  check(`扇区中点方向的边界与 lineBlocked 一致（${fieldChecked} 个方向）`,
    fieldChecked > 40 && flipped === 0, `checked=${fieldChecked} 越界=${flipped}`);

  // WITHOUT obstacles there must be no darkness at all, and the polygon must still be a valid
  // polygon instead of the degenerate single 2π sector (whose chord would be a point).
  const empty = fieldFor(ORIGIN, []);
  check('无掩体：退化为种子环', empty.n === V.VISION_SEEDS, String(empty.n));
  let maxDev = 0;
  for (let i = 0; i < empty.n; i++) maxDev = Math.max(maxDev, Math.abs(empty.dist[i] - V.VISION_QUERY_R));
  check('无掩体：每个方向都到最远距离（屏幕上不会有暗区）', maxDev === 0, String(maxDev));
  check('无掩体：任意点都是可见的',
    V.visionFadeAt(empty, 12, -7) === 1 && V.visionFadeAt(empty, -30, 25) === 1);
  check('未构建过的字段默认全可见（n<2 的退化保护）',
    V.visionFadeAt(V.createVisionField(CAP), 5, 5) === 1);
}

// ------------------------------------------------------- overlay geometry (the unseen part)
//
// There is no browser here, so this is the only place the DRAWN overlay is checked at all. Two
// kinds of assertion: the vertex layout (which the renderer's baked alpha array depends on, index
// by index), and — the one that actually matters — that the region covered by FULLY OPAQUE
// triangles is exactly the region `visionFadeAt` calls fully occluded.
const VISION_Y_TEST = 0.02;
{
  const f = fieldFor(ORIGIN);
  const pool = new Float32Array(f.cap * V.VISION_VERTS_PER_SECTOR * 3);
  const verts = V.writeVisionGeometry(f, pool, VISION_Y_TEST);
  check('顶点数 = 扇区数 x 12', verts === f.n * V.VISION_VERTS_PER_SECTOR, `${verts} vs ${f.n * 12}`);
  check('顶点数不超过池容量', verts <= f.cap * V.VISION_VERTS_PER_SECTOR);
  let yOk = true;
  // Float32 storage: compare with a tolerance, not for equality (0.02 is not representable).
  for (let i = 0; i < verts; i++) if (Math.abs(pool[i * 3 + 1] - VISION_Y_TEST) > 1e-6) yOk = false;
  check('所有顶点都在同一个高度上（贴着地面）', yOk);

  // The 12 radii of each sector, in the order the writer emits them. This pins the contract with
  // the renderer's alpha array: vertices 0, 1 and 3 are the alpha-0 boundary vertices, the rest
  // are alpha 1.
  const RQ = V.VISION_QUERY_R;
  let layoutOk = true;
  let layoutDetail = '';
  for (let i = 0; i < f.n && layoutOk; i++) {
    const j = i + 1 < f.n ? i + 1 : 0;
    const d0 = f.dist[i];
    const d1 = f.dist[j];
    const e0 = Math.min(d0 + V.VISION_FADE, RQ);
    const e1 = Math.min(d1 + V.VISION_FADE, RQ);
    const want = [d0, d1, e1, d0, e1, e0, e0, e1, RQ, e0, RQ, RQ];
    for (let v = 0; v < 12; v++) {
      const k = i * 12 + v;
      const r = Math.hypot(pool[k * 3] - f.originX, pool[k * 3 + 2] - f.originY);
      if (Math.abs(r - want[v]) > 1e-3) {
        layoutOk = false;
        layoutDetail = `扇区 ${i} 顶点 ${v}: ${r.toFixed(4)} != ${want[v].toFixed(4)}`;
        break;
      }
    }
  }
  check('每个扇区的 12 个顶点都落在正确的环上（与渲染层烘死的 alpha 顺序一致）', layoutOk, layoutDetail);

  // Rasterise the two FULLY OPAQUE triangles per sector (indices 6..11) and compare with the
  // field's own "fully occluded" region.
  const inTri = (px, pz, ax, az, bx, bz, cx, cz) => {
    const d1v = (px - bx) * (az - bz) - (ax - bx) * (pz - bz);
    const d2v = (px - cx) * (bz - cz) - (bx - cx) * (pz - cz);
    const d3v = (px - ax) * (cz - az) - (cx - ax) * (pz - az);
    return !(((d1v < 0) || (d2v < 0) || (d3v < 0)) && ((d1v > 0) || (d2v > 0) || (d3v > 0)));
  };
  const opaqueAt = (px, pz) => {
    for (let i = 0; i < f.n; i++) {
      const base = i * 12;
      for (const [t0, t1, t2] of [[6, 7, 8], [9, 10, 11]]) {
        const k0 = (base + t0) * 3;
        const k1 = (base + t1) * 3;
        const k2 = (base + t2) * 3;
        if (inTri(px, pz, pool[k0], pool[k0 + 2], pool[k1], pool[k1 + 2], pool[k2], pool[k2 + 2])) return true;
      }
    }
    return false;
  };
  let opaque = 0;
  let mismatchOpaque = 0;
  let worstEdge = 0;
  for (let x = -40; x <= 40; x += 1) {
    for (let z = -40; z <= 40; z += 1) {
      const r = Math.hypot(x, z);
      if (r < 0.5 || r > 90) continue;
      const drawn = opaqueAt(x, z);
      const want = V.visionFadeAt(f, x, z) === 0;
      if (want) opaque++;
      if (drawn === want) continue;
      mismatchOpaque++;
      // Only allowed right at the edge of the fully-dark region: the mesh bounds it with a chord,
      // the field with a radial ramp, so a few centimetres of disagreement are inherent.
      let lo = 0;
      let hi = V.VISION_QUERY_R;
      const ux = x / r;
      const uy = z / r;
      for (let k = 0; k < 40; k++) {
        const mid = (lo + hi) / 2;
        if (V.visionFadeAt(f, ux * mid, uy * mid) === 0) hi = mid;
        else lo = mid;
      }
      const edge = Math.abs(r - hi);
      if (edge > worstEdge) worstEdge = edge;
    }
  }
  check('存在被完全遮暗的区域（不是全亮）', opaque > 200, String(opaque));
  check('完全不透明的三角形覆盖的区域 = visionFadeAt 判定的完全遮挡区',
    mismatchOpaque === 0 || worstEdge <= 0.1,
    `不一致 ${mismatchOpaque} 个, 最大离边缘 ${worstEdge.toFixed(4)}`);

  // No obstacles: every ring lands on the rim, so nothing is drawn (no dark ring, no cost).
  const empty = fieldFor(ORIGIN, []);
  const pool2 = new Float32Array(empty.cap * V.VISION_VERTS_PER_SECTOR * 3);
  const verts2 = V.writeVisionGeometry(empty, pool2, VISION_Y_TEST);
  let maxR = 0;
  for (let i = 0; i < verts2; i++) maxR = Math.max(maxR, Math.hypot(pool2[i * 3], pool2[i * 3 + 2]));
  check('无掩体：所有顶点都在最远环上（三角形面积为零，什么都不画）',
    verts2 === empty.n * 12 && Math.abs(maxR - V.VISION_QUERY_R) < 1e-3,
    `verts=${verts2} maxR=${maxR}`);
  check('未构建的字段不写出任何顶点', V.writeVisionGeometry(V.createVisionField(CAP), pool2, 0) === 0);
}

// --------------------------------------------------- grid cross-check vs lineBlocked
//
// THE central assertion of this suite. `isPointVisible` (the drawn darkness) must agree with
// `!lineBlocked` (the sim's own line of sight) everywhere except inside the hairline corner
// wedges, and the size of that exception is MEASURED in world units rather than assumed.
const ORIGINS = [
  [0, 0],           // spawn: the open middle
  [10.9, 0],        // parked against the cover ring's east wall
  [0, -10.9],       // parked against the ring's south wall
  [20, 20],         // past the quadrant crate
  [-25, 3],         // in the corridor beside a long wall
  [3, -25],         // behind the mid-field wall
  [30, 24.5],       // between a corner block and the outer wall
  [-33, -20],       // near the arena corner
  [12, 12],         // in the ring gap on the diagonal
  [7, -12],
];
/**
 * Distance from `p` to the TRUE visibility boundary: the padded box faces (the occluder's own
 * silhouette) plus the shadow rays extending outward from every padded corner. Used to prove that
 * any disagreement is a boundary artifact, not a structural hole.
 */
function distToBoundary(p, o, obstacles, pad) {
  let best = Infinity;
  for (const box of obstacles) {
    const x0 = box.x - box.hw - pad;
    const x1 = box.x + box.hw + pad;
    const y0 = box.y - box.hh - pad;
    const y1 = box.y + box.hh + pad;
    if (x1 <= x0 || y1 <= y0) continue;
    const cs = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    for (let i = 0; i < 4; i++) {
      const a = cs[i];
      const b = cs[(i + 1) % 4];
      const abx = b[0] - a[0];
      const aby = b[1] - a[1];
      const l2 = abx * abx + aby * aby;
      let t = ((p.x - a[0]) * abx + (p.y - a[1]) * aby) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(p.x - (a[0] + abx * t), p.y - (a[1] + aby * t));
      if (d < best) best = d;
    }
    for (const c of cs) {
      const dx = c[0] - o.x;
      const dy = c[1] - o.y;
      const l = Math.hypot(dx, dy);
      if (l < 1e-9) continue;
      const ux = dx / l;
      const uy = dy / l;
      const wx = p.x - c[0];
      const wy = p.y - c[1];
      if (wx * ux + wy * uy < 0) continue;   // behind the corner: not a shadow edge
      const d = Math.abs(wx * uy - wy * ux);
      if (d < best) best = d;
    }
  }
  return best;
}

const LAT_TOL = 0.01;   // world units; the theoretical wedge bound is 2*eps*QUERY_R = 0.026
{
  for (const step of [0.5, 0.25]) {
    const origins = step === 0.5 ? ORIGINS : ORIGINS.slice(0, 3);
    let over = 0;
    let under = 0;
    let far = 0;
    let worstLat = 0;
    let samples = 0;
    for (const [ox, oy] of origins) {
      const origin = { x: ox, y: oy };
      const f = fieldFor(origin);
      for (let x = -38; x <= 38; x += step) {
        for (let y = -38; y <= 38; y += step) {
          if (overlapsCover({ x, y }, 0, OBSTACLES)) continue;   // a point inside a wall is not a view
          samples++;
          const vis = V.isPointVisible(f, x, y);
          const los = !lineBlocked(origin, { x, y }, OBSTACLES);
          if (vis === los) continue;
          if (vis) under++;
          else over++;
          const lat = distToBoundary({ x, y }, origin, OBSTACLES, SEGMENT_SKIN);
          if (lat > worstLat) worstLat = lat;
          if (lat > LAT_TOL) far++;
        }
      }
    }
    const label = `网格 ${step}（${origins.length} 个视点, ${samples} 个采样）`;
    check(`${label}：与 lineBlocked 的不一致都在阴影边缘 ${LAT_TOL} 单位内`,
      far === 0, `越界 ${far}, 最大横向误差 ${worstLat.toFixed(5)}`);
    check(`${label}：不一致比例 < 0.05%`, (over + under) / samples < 5e-4,
      `${over + under}/${samples}`);
    // The residual has to be ROUNDING, not a policy. `under` is the dangerous direction — the polygon
    // claiming sight through cover — and it must be ~zero; `over` (darkness covering a sliver more
    // than lineBlocked does) is the safe one, and every sample of it is already proved to sit within
    // LAT_TOL of a shadow edge by the check above. This used to demand that BOTH directions be
    // non-zero, which is a statement about which way the rounding happens to fall for one particular
    // layout: re-laying out the cover moved all 16 residual samples to the safe side and turned that
    // into a failure. Assert the bound instead of the sign.
    check(`${label}：没有系统性泄漏（under ≤ 8 个采样且 < 0.002%）`,
      under <= 8 && under / samples < 2e-5,
      `over=${over} under=${under}`);
  }
}

// -------------------------------------------------------- corner angles come from the SKIN box
//
// REGRESSION for the bug this suite caught: the angular spans were built from the raw footprint
// while the rays clipped a box shrunk by SEGMENT_SKIN, so the sector straddling a silhouette
// corner interpolated "hit at 8 units" -> "miss at 130 units" across ~2 degrees and leaked a huge
// wedge of shadow. A lone box makes the two corner directions easy to tell apart.
{
  const box = { x: 10, y: 0, hw: 2, hh: 2, h: 1.4 };
  const f = fieldFor(ORIGIN, [box]);
  const corners = [[8, 2], [12, 2], [12, -2], [8, -2]];
  let worstCase = null;
  for (const [cx, cy] of corners) {
    const a = Math.atan2(cy, cx);
    const p = { x: Math.cos(a) * 40, y: Math.sin(a) * 40 };
    if (V.isPointVisible(f, p.x, p.y) !== !lineBlocked(ORIGIN, p, [box])) {
      worstCase = `角 (${cx},${cy})`;
    }
  }
  check('单块掩体：原始角点方向上的可见性与 lineBlocked 一致（pad 回归）',
    worstCase === null, String(worstCase));
  // …and the sector boundary really is pulled in by the skin: just inside the padded silhouette is
  // blocked, just outside is clear.
  const padCorner = Math.atan2(2 + 0.01, 8 - 0.01);
  const inside = { x: Math.cos(padCorner - 3e-3) * 40, y: Math.sin(padCorner - 3e-3) * 40 };
  const outside = { x: Math.cos(padCorner + 3e-3) * 40, y: Math.sin(padCorner + 3e-3) * 40 };
  check('单块掩体：padded 剪影内可见性为「被挡」', !V.isPointVisible(f, inside.x, inside.y));
  check('单块掩体：padded 剪影外可见性为「可见」', V.isPointVisible(f, outside.x, outside.y));
}

// ------------------------------------------- the chord agrees with a bisection on lineBlocked
{
  const origin = { x: 4, y: -9 };
  const f = fieldFor(origin);
  const corners = (() => {
    const out = [];
    for (const o of OBSTACLES) {
      const x0 = o.x - o.hw - SEGMENT_SKIN;
      const x1 = o.x + o.hw + SEGMENT_SKIN;
      const y0 = o.y - o.hh - SEGMENT_SKIN;
      const y1 = o.y + o.hh + SEGMENT_SKIN;
      for (const [cx, cy] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) {
        out.push(Math.atan2(cy - origin.y, cx - origin.x));
      }
    }
    return out;
  })();
  let worst = 0;
  let n = 0;
  let tested = 0;
  // Deterministic pseudo-random directions (a fixed LCG — the suite must not be flaky).
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let k = 0; k < 400; k++) {
    const a = rnd() * 2 * Math.PI;
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    // True first blocked distance along this ray.
    let lo = 0;
    let hi = V.VISION_QUERY_R;
    for (let i = 0; i < 50; i++) {
      const mid = (lo + hi) / 2;
      if (lineBlocked(origin, { x: origin.x + ux * mid, y: origin.y + uy * mid }, OBSTACLES)) hi = mid;
      else lo = mid;
    }
    // The field's boundary along the same ray: the largest radius that is still fully visible.
    let lo2 = 0;
    let hi2 = V.VISION_QUERY_R;
    for (let i = 0; i < 50; i++) {
      const mid = (lo2 + hi2) / 2;
      if (V.visionFadeAt(f, origin.x + ux * mid, origin.y + uy * mid) >= 1) lo2 = mid;
      else hi2 = mid;
    }
    // Two radial differences are EXPECTED here and are not errors:
    //   * a direction within 2*eps of a silhouette corner — the hairline wedge;
    //   * a boundary out at the artificial QUERY_R rim, where the polygon's chord legitimately cuts
    //     inside the arc (the floor ends at +-85, so that region is off the floor and off screen).
    let nearCorner = false;
    for (const ca of corners) {
      let dd = Math.abs(a - ca) % (2 * Math.PI);
      if (dd > Math.PI) dd = 2 * Math.PI - dd;
      if (dd < 2 * V.VISION_ANGLE_EPS) { nearCorner = true; break; }
    }
    if (nearCorner || hi > 100) continue;
    tested++;
    const d = Math.abs(hi - hi2);
    if (d > worst) worst = d;
    if (d > 0.02) n++;
  }
  check(`随机方向（${tested} 个）上多边形边界与 lineBlocked 的二分边界一致（误差 < 0.02）`,
    tested > 250 && n === 0, `检测 ${tested} 个, ${n} 个越界, 最大 ${worst.toFixed(5)}`);
}

// ---------------------------------------------------------------------- fade curve
{
  const f = fieldFor(ORIGIN);
  // East of the origin the cover ring is at x = 12 - 1.2 = 10.8.
  check('边界内为 1', V.visionFadeAt(f, 5, 0) === 1);
  // `dist` lives in a Float32Array, so the fade end is exact only to ~1e-5: compare with a
  // tolerance rather than for equality (the value is genuinely 0 a hair further out).
  check('边界外一个渐隐带处为 0',
    V.visionFadeAt(f, 10.8 + V.VISION_FADE + 0.05, 0) === 0
    && V.visionFadeAt(f, 10.8 + V.VISION_FADE - 0.05, 0) > 0);
  // Monotone non-increasing as it walks outward through the shadow.
  let prev = 2;
  let mono = true;
  for (let d = 0; d <= 10.8 + V.VISION_FADE + 1; d += 0.05) {
    const v = V.visionFadeAt(f, d, 0);
    if (v > prev + 1e-9) mono = false;
    prev = v;
  }
  check('沿射线单调不增（不会忽明忽暗）', mono);
  check('渐隐带中点处于 0 与 1 之间', (() => {
    const mid = 10.8 + V.VISION_FADE * 0.5;
    const v = V.visionFadeAt(f, mid, 0);
    return v > 0.05 && v < 0.95;
  })(), String(V.visionFadeAt(f, 10.8 + V.VISION_FADE * 0.5, 0)));
  check('fade=0 时是二值的', V.visionFadeAt(f, 5, 0, 0) === 1 && V.visionFadeAt(f, 40, 0, 0) === 0);
  const x = 20.5;
  check('isPointVisible 与 visionFadeAt(fade=0) 一致',
    V.isPointVisible(f, x, 3) === (V.visionFadeAt(f, x, 3, 0) > 0));
}

// ----------------------------------------------------- no invisible shooter / no blind hit
{
  // Symmetry of the blocking predicate is what makes "he can shoot me" imply "I can see him".
  let seed = 987654321;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const rp = () => ({ x: (rnd() * 2 - 1) * 38, y: (rnd() * 2 - 1) * 38 });
  let asym = 0;
  let visibleShooter = 0;
  let shooters = 0;
  for (let i = 0; i < 4000; i++) {
    const a = rp();
    const b = rp();
    if (lineBlocked(a, b, OBSTACLES) !== lineBlocked(b, a, OBSTACLES)) asym++;
    if (overlapsCover(a, CONFIG.playerR, OBSTACLES, 0.4)) continue;
    if (overlapsCover(b, CONFIG.enemyR, OBSTACLES, 0.4)) continue;
    const canFire = !lineBlocked(b, a, OBSTACLES);       // game.ts: updateGunner's gate
    if (!canFire) continue;
    shooters++;
    if (V.visibleWithReveal(a, b, OBSTACLES)) visibleShooter++;
  }
  check('lineBlocked 对称（a 挡 b ⇔ b 挡 a）', asym === 0, String(asym));
  check('任何能开火的枪手都对玩家可见（没有隐形枪手）',
    shooters > 200 && visibleShooter === shooters, `${visibleShooter}/${shooters}`);
  // …and the converse direction is the near reveal radius, NOT line of sight: an enemy right
  // behind a wall you are standing next to is still drawn, because it can touch you.
  const wall = [{ x: 3, y: 0, hw: 0.4, hh: 6, h: 1.8 }];
  const player = { x: 0, y: 0 };
  const closeBehind = { x: 4.2, y: 0 };   // 1.2 units behind the wall at x = 3, i.e. inside VISION_REVEAL_R
  const farBehind = { x: 20, y: 0 };      // behind the same wall, but far away
  check('墙后近身的敌人仍然可见（近身半径）',
    lineBlocked(player, closeBehind, wall) && V.visibleWithReveal(player, closeBehind, wall));
  check('墙后远处的敌人不可见',
    lineBlocked(player, farBehind, wall) && !V.visibleWithReveal(player, farBehind, wall));
  check('开阔处的敌人可见', V.visibleWithReveal(player, { x: 0, y: 20 }, wall));
}

// ------------------------------------------------- auto-aim targets exactly what is drawn
//
// The SIM half of the same rule. `GameSim.nearestVisibleEnemy` must use `visibleWithReveal`, so
// right-stick auto-aim can never lock onto an enemy that is not on screen — and never refuses one
// that is. These assertions pin BOTH directions, because each one is a bug the player would feel:
// an invisible crosshair target, or an enemy on screen the stick ignores.
{
  const { GameSim } = await import(GAME.href);
  // One wall at x = 4 spanning z in [-6, 6]: a target at (8, 0) is hidden and far, one at (5.2, 0)
  // is hidden but inside VISION_REVEAL_R, one at (0, 5) is in the open.
  const wall = [{ x: 4, y: 0, hw: 0.5, hh: 6, h: 1.8 }];
  const freshSim = () => {
    const sim = new GameSim();
    sim.spawnQueue = 0;
    sim.spawnTimer = 0;
    sim.enemies = [];
    sim.obstacles = wall;
    sim.equipWeapon('dragonBreath');
    return sim;
  };
  const addEnemy = (sim, x, y) => {
    sim.enemies.push({
      id: 900 + sim.enemies.length, pos: { x, y }, vel: { x: 0, y: 0 }, r: 0.7,
      hp: 100, maxHp: 100, alive: true, kind: 'chaser', speed: 0, touchDmg: 16, hitFlash: 0,
      touchCd: 0, burns: [], flameAcc: 0, fireT: 0, aiming: false,
    });
    return sim.enemies[sim.enemies.length - 1];
  };
  const liveBullets = (sim) => sim.bullets.filter((b) => b.alive).length;

  // (1) hidden and far: nothing to lock onto, and firing must not burn ammo
  {
    const sim = freshSim();
    const far = addEnemy(sim, 8, 0);
    check('墙后远处的敌人不算「最近可见」', sim.nearestVisibleEnemy({ x: 0, y: 0 }) === null);
    check('…而且它确实被挡住（不是碰巧在射程外）', lineBlocked({ x: 0, y: 0 }, far.pos, wall));
    const ammo0 = sim.player.ammo;
    sim.update(DT, { move: { x: 0, y: 0 }, aim: { x: 0, y: 0 }, firing: true, autoAim: true });
    check('自动瞄准没有可见目标时不消耗弹药', sim.player.ammo === ammo0, String(sim.player.ammo));
    check('自动瞄准没有可见目标时不产生弹丸', liveBullets(sim) === 0, String(liveBullets(sim)));
  }

  // (2) one hidden, one in the open: lock the visible one, even though both are alive
  {
    const sim = freshSim();
    addEnemy(sim, 8, 0);
    const open = addEnemy(sim, 0, 5);
    check('有可见目标时自动瞄准选它（跳过墙后的）',
      sim.nearestVisibleEnemy({ x: 0, y: 0 }) === open);
    sim.update(DT, { move: { x: 0, y: 0 }, aim: { x: 0, y: 0 }, firing: true, autoAim: true });
    check('朝向真的指向可见目标', near(sim.player.aimAngle, Math.PI / 2, 1e-6),
      String(sim.player.aimAngle));
    check('自动瞄准对可见目标照常开火', liveBullets(sim) === 8, String(liveBullets(sim)));
  }

  // (3) hidden but CLOSE: the near-reveal radius is part of the shared rule, so it is targetable
  //     (and, by the renderer's identical predicate, drawn on screen)
  {
    const sim = freshSim();
    const close = addEnemy(sim, 5.2, 0);
    check('墙后近身（< VISION_REVEAL_R）的敌人被挡住', lineBlocked({ x: 0, y: 0 }, close.pos, wall));
    check('…但仍然可以自动瞄准（近身可见半径，与渲染层同一条规则）',
      sim.nearestVisibleEnemy({ x: 0, y: 0 }) === close);
    sim.update(DT, { move: { x: 0, y: 0 }, aim: { x: 0, y: 0 }, firing: true, autoAim: true });
    check('近身被挡的目标也照常开火', liveBullets(sim) === 8, String(liveBullets(sim)));
  }

  // (4) the filter is the ONLY difference: remove the wall and the same enemy becomes targetable
  {
    const sim = freshSim();
    const far = addEnemy(sim, 8, 0);
    sim.obstacles = [];
    check('拆掉墙后同一个敌人才可以被锁定', sim.nearestVisibleEnemy({ x: 0, y: 0 }) === far);
  }

  // (5) MANUAL aim is deliberately NOT filtered: shooting a wall is the player's business
  {
    const sim = freshSim();
    addEnemy(sim, 8, 0);
    sim.update(DT, { move: { x: 0, y: 0 }, aim: { x: 1, y: 0 }, firing: true, autoAim: false });
    check('手动瞄准不受视野过滤（对着墙也能开火）', liveBullets(sim) === 8, String(liveBullets(sim)));
  }

  // (6) randomized: the picked enemy is visible AND no closer visible enemy exists
  {
    const sim = new GameSim();
    sim.spawnQueue = 0;
    sim.spawnTimer = 0;
    sim.enemies = [];
    let seed = 424242;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    let picked = 0;
    let wrongPick = 0;
    let invisiblePick = 0;
    for (let k = 0; k < 300; k++) {
      sim.enemies = [];
      for (let j = 0; j < 5; j++) {
        addEnemy(sim, (rnd() * 2 - 1) * 20, (rnd() * 2 - 1) * 20);
      }
      const p = { x: (rnd() * 2 - 1) * 25, y: (rnd() * 2 - 1) * 25 };
      if (overlapsCover(p, CONFIG.playerR, OBSTACLES, 0.4)) continue;
      const got = sim.nearestVisibleEnemy(p);
      if (got === null) continue;
      picked++;
      if (!V.visibleWithReveal(p, got.pos, OBSTACLES)) invisiblePick++;
      const dGot = Math.hypot(got.pos.x - p.x, got.pos.y - p.y);
      for (const e of sim.enemies) {
        if (e === got) continue;
        if (!V.visibleWithReveal(p, e.pos, OBSTACLES)) continue;
        if (Math.hypot(e.pos.x - p.x, e.pos.y - p.y) < dGot - 1e-9) wrongPick++;
      }
    }
    check('随机 300 组：锁定的目标本身一定可见', picked > 150 && invisiblePick === 0,
      `picked=${picked} invisible=${invisiblePick}`);
    check('随机 300 组：不存在「更近且可见」的敌人被跳过', wrongPick === 0, String(wrongPick));
  }
}

// ------------------------------------------- the aim assist is a 15-degree nudge, firing only
//
// 「给开火加个自动瞄准，但是只瞄准当前摄像机朝向 15° 范围内，停火后回正」. Three rules, and each one
// is a different way to get it wrong:
//   * the cone is measured from the CAMERA direction and re-measured every frame — measuring from the
//     assisted direction would let it ratchet onto a target frame by frame;
//   * the assist only runs WHILE FIRING, and releasing must put the facing back on the camera
//     (「回正」) with no state to unwind;
//   * it is a nudge, not a lock-on: a target outside the cone must be ignored even when it is the
//     closest thing on screen, and the visibility filter still applies inside the cone.
{
  const { GameSim } = await import(GAME.href);
  const openSim = () => {
    const sim = new GameSim();
    sim.spawnQueue = 0;
    sim.spawnTimer = 0;
    sim.enemies = [];
    sim.obstacles = [];            // no cover here: these assertions are about ANGLES
    sim.equipWeapon('smg');
    return sim;
  };
  const foe = (sim, dist, thetaDeg, hp = 1e9) => {
    const t = (thetaDeg * Math.PI) / 180;
    sim.enemies.push({
      id: 900 + sim.enemies.length, pos: { x: dist * Math.cos(t), y: dist * Math.sin(t) },
      vel: { x: 0, y: 0 }, r: 0.7, hp, maxHp: hp, alive: true, kind: 'chaser', speed: 0,
      touchDmg: 0, hitFlash: 0, touchCd: 0, burns: [], flameAcc: 0, fireT: 0, aiming: false,
    });
  };
  const FWD = { x: 1, y: 0 };      // the camera looks along +X (yaw 0 -> screen up is -Z, but any
                                   // unit vector works here: the cone is relative to it)
  const step = (sim, firing) =>
    sim.update(DT, { move: { x: 0, y: 0 }, aim: FWD, firing, autoAim: true });
  const facingDeg = (sim) => (sim.player.aimAngle * 180) / Math.PI;

  check('assist: the cone constant is the requested 15 degrees',
    CONFIG.autoAimConeDeg === 15, String(CONFIG.autoAimConeDeg));

  // (1) inside the cone, while firing: the facing snaps to the target (not merely "stays forward")
  {
    const sim = openSim();
    foe(sim, 15, 10);
    step(sim, true);
    check('assist: an enemy 10° off the camera IS locked while firing',
      Math.abs(facingDeg(sim) - 10) < 1e-9, String(facingDeg(sim)));
  }
  // (2) just inside vs just outside the boundary
  {
    const inside = openSim();
    foe(inside, 15, 14);
    step(inside, true);
    const outside = openSim();
    foe(outside, 15, 15.5);
    step(outside, true);
    check('assist: 14° locks, 15.5° does not (the boundary is the cone, not a rounded guess)',
      Math.abs(facingDeg(inside) - 14) < 1e-9 && Math.abs(facingDeg(outside)) < 1e-9,
      `${facingDeg(inside)} / ${facingDeg(outside)}`);
  }
  {
    const sim = openSim();
    foe(sim, 15, 20);
    step(sim, true);
    check('assist: a target 20° off is ignored — the player still aims the camera', 
      Math.abs(facingDeg(sim)) < 1e-9, String(facingDeg(sim)));
  }
  // (3) "nearest" means nearest INSIDE the cone: a closer enemy outside must not steal the lock
  {
    const sim = openSim();
    foe(sim, 5, 25);               // closest, but out of the cone
    foe(sim, 15, 5);               // farther, but in front
    step(sim, true);
    check('assist: the nearer enemy OUTSIDE the cone does not beat the one inside it',
      Math.abs(facingDeg(sim) - 5) < 1e-9, String(facingDeg(sim)));
  }
  // (4) 回正: releasing the trigger drops the override, with no extra state
  {
    const sim = openSim();
    foe(sim, 15, 10);
    step(sim, true);
    const locked = facingDeg(sim);
    step(sim, false);
    check('assist: releasing the trigger returns the facing to the camera direction',
      Math.abs(locked - 10) < 1e-9 && Math.abs(facingDeg(sim)) < 1e-9,
      `locked=${locked} released=${facingDeg(sim)}`);
    check('assist: …and it stays released while the trigger is up',
      (() => { for (let i = 0; i < 30; i++) step(sim, false); return Math.abs(facingDeg(sim)) < 1e-9; })(),
      String(facingDeg(sim)));
  }
  // (5) ANTI-RATCHET: the cone is the CAMERA's, so a target just outside can never creep in.
  // This is the assertion that fails if the reference is fed last frame's assisted direction.
  {
    const sim = openSim();
    foe(sim, 15, 28);              // outside, and would be inside a cone centred on an assisted 14°
    for (let i = 0; i < 120; i++) step(sim, true);
    check('assist: a target outside the cone never ratchets in, even held for 2s',
      Math.abs(facingDeg(sim)) < 1e-9, String(facingDeg(sim)));
  }
  // (6) visibility still applies INSIDE the cone (the assist is not a wallhack)
  {
    const sim = new GameSim();
    sim.spawnQueue = 0;
    sim.spawnTimer = 0;
    sim.enemies = [];
    sim.obstacles = [{ x: 6, y: 0, hw: 1, hh: 6, h: 2.5 }];
    sim.equipWeapon('smg');
    foe(sim, 15, 0);               // dead ahead, but behind the wall
    step(sim, true);
    check('assist: an enemy inside the cone but behind cover is NOT locked',
      Math.abs(facingDeg(sim)) < 1e-9, String(facingDeg(sim)));
  }
  // (7) and the assist actually steers the bullets, not just the sprite
  {
    const sim = openSim();
    foe(sim, 15, 10);
    step(sim, true);
    const b = sim.bullets.find((x) => !x.fromPlayer && x.alive) ?? sim.bullets[0];
    const bulletDeg = (Math.atan2(b.vel.y, b.vel.x) * 180) / Math.PI;
    check('assist: rounds leave along the assisted direction (within the weapon spread)',
      Math.abs(bulletDeg - 10) <= 6.5, `${bulletDeg.toFixed(2)}° vs 10° ± 6° spread`);
  }
}

// ------------------------------------------------------------- cover dimming rule
{
  // The LONGEST wall in the layout, whatever it currently measures: pinning the old 1 x 7 numbers
  // here turned a level edit into a vision failure.
  const longWall = OBSTACLES.reduce((a, b) => (Math.max(b.hw, b.hh) > Math.max(a.hw, a.hh) ? b : a));
  check('找到长墙样本', longWall !== undefined);
  const p = { x: longWall.x - longWall.hw - 0.55, y: longWall.y };
  // The nearest point of the wall the player is leaning on is on its near face, and it is visible.
  const np = nearestPointOnAabb(p, longWall);
  check('最近点在盒子的近侧面上', np.x === longWall.x - longWall.hw && np.y === longWall.y,
    JSON.stringify(np));
  check('贴着的长墙仍然亮着（用最近点而不是中心点判定）',
    V.coverVisible(p, longWall, OBSTACLES));
  const centre = { x: longWall.x, y: longWall.y };
  check('…而用中心点判定会得到「不可见」（这就是不能用中心点的原因）',
    lineBlocked(p, centre, OBSTACLES));
  // A wall hidden behind another one goes dark.
  const pair = [{ x: 3, y: 0, hw: 1, hh: 3, h: 2 }, { x: 9, y: 0, hw: 1, hh: 3, h: 2 }];
  check('被前一块掩体完全挡住的掩体变暗',
    !V.coverVisible({ x: 0, y: 0 }, pair[1], pair)
    && V.coverVisible({ x: 0, y: 0 }, pair[0], pair));
  // nearestPointOnAabb basics.
  const box = { x: 5, y: 5, hw: 1, hh: 1 };
  check('盒外的点 -> 钳到最近的角/面',
    JSON.stringify(nearestPointOnAabb({ x: 0, y: 0 }, box)) === JSON.stringify({ x: 4, y: 4 }),
    JSON.stringify(nearestPointOnAabb({ x: 0, y: 0 }, box)));
  check('盒内的点 -> 返回自身',
    JSON.stringify(nearestPointOnAabb({ x: 5.2, y: 4.9 }, box)) === JSON.stringify({ x: 5.2, y: 4.9 }));
  check('盒上的点 -> 返回自身',
    JSON.stringify(nearestPointOnAabb({ x: 4, y: 5.5 }, box)) === JSON.stringify({ x: 4, y: 5.5 }));
  check('write-through out 参数被复用（渲染层免分配）', (() => {
    const out = { x: 0, y: 0 };
    const r = nearestPointOnAabb({ x: 0, y: 0 }, box, out);
    return r === out && out.x === 4 && out.y === 4;
  })());
}

// ---------------------------------------------------------------- moving player sanity
{
  // Walking across the arena must never produce a NaN or an empty polygon: the field is rebuilt
  // every frame, so a single bad frame is a black screen or a shadowless one.
  let bad = 0;
  let minN = Infinity;
  let maxN = 0;
  const f = V.createVisionField(CAP);
  for (let k = 0; k < 240; k++) {
    const a = (k / 240) * Math.PI * 2;
    const origin = { x: Math.cos(a) * 24, y: Math.sin(a) * 24 };
    if (overlapsCover(origin, CONFIG.playerR, OBSTACLES)) continue;
    V.rebuildVision(f, origin, OBSTACLES);
    if (f.n < minN) minN = f.n;
    if (f.n > maxN) maxN = f.n;
    if (!(f.n >= V.VISION_SEEDS)) bad++;
    for (let i = 0; i < f.n; i++) {
      if (!Number.isFinite(f.dist[i]) || !Number.isFinite(f.angles[i])) bad++;
    }
    if (!(V.visionFadeAt(f, origin.x, origin.y) === 1)) bad++;
  }
  check('绕场一周 240 个位置全部重建出有效多边形（无 NaN / 无空多边形）', bad === 0, String(bad));
  // The sector count must stay inside the pool at every position — an overflow would silently
  // drop a shadow boundary (the pool is sized from the layout, so this is the guard that a future
  // level with more cover fails LOUDLY here instead of visually).
  check('每个位置重建后扇区数都不超过池容量', maxN <= CAP && minN >= V.VISION_SEEDS,
    `min=${minN} max=${maxN} cap=${CAP}`);
}

// ------------------------------------------------------------------------- summary
console.log(`\nverify-vision: ${passed} 项通过, ${failures.length} 项失败`);
if (failures.length > 0) {
  console.log('\n失败项:');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('全部通过 ✓');
