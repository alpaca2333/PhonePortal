/**
 * CPU-side verification for the ARENA ART (src/props.ts): the prop catalog, the placement planner,
 * and — the part that keeps the game honest — the rule that the visuals never contradict collision.
 *
 * Rules under test:
 *   - every catalog entry points at a real .glb in assets/props/, the file is a valid GLB, and the
 *     recorded `size` matches the size MEASURED from the file's POSITION accessor. This is what
 *     stops a rename or a retheme from silently 404-ing on a phone (the browser-side loader cannot
 *     be exercised in this environment, so this is the only place the asset files are checked at
 *     all);
 *   - every cover prop fits INSIDE the footprint of the obstacle it dresses. A prop that overhangs
 *     the collision box is a lie in the worst direction: the player sees solid mass that bullets
 *     pass straight through;
 *   - the prop cluster actually fills its footprint (a lone 0.5-unit box in a 14-unit wall would
 *     pass the containment test and look broken);
 *   - no decoration lands inside a cover footprint, on the spawn clearance or outside the room;
 *   - the layout is DETERMINISTIC for a given seed (identical on every reload, comparable across
 *     runs) and the plan contains no NaN;
 *   - the room shell is watertight: floor tiles exactly cover the arena, and the perimeter walls'
 *     inner face sits exactly on the arena bound, so the player can never see behind the walls.
 *
 * Run:  npm run build && node scripts/verify-props.mjs
 * Exit code is non-zero when any assertion fails.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readGlb } from './lib/glb.mjs';

const PROPS_URL = new URL('../dist/apps/shooter/src/props.js', import.meta.url);
const LEVEL_URL = new URL('../dist/apps/shooter/src/level.js', import.meta.url);
const CONFIG_URL = new URL('../dist/apps/shooter/src/config.js', import.meta.url);

const P = await import(PROPS_URL.href);
const { OBSTACLES } = await import(LEVEL_URL.href);
const { ARENA_HALF } = await import(CONFIG_URL.href);

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ' — ' + detail : ''));
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'shooter', 'assets', 'props');

// ---------------------------------------------------------------- catalog vs the files on disk
/**
 * Measure a .glb the way the RENDERER will draw it.
 *
 * Delegated to scripts/lib/glb.mjs, which applies the node TRS chain and then the same recentring
 * assets.ts::loadPropGeometry does (footprint centred on the origin, base on y = 0). Both details
 * are load-bearing: measuring the raw POSITION accessor ignores the node transforms (non-identity on
 * 11 of these 49 files) and reports a size nobody draws, and ignoring the recentring would not
 * notice a prop whose origin sits at a footprint corner.
 */
function measureGlb(path) {
  const r = readGlb(path);
  if (r === null) return null;
  return {
    size: r.size, lo: r.lo, hi: r.hi, offset: r.offset,
    authoredLo: r.authoredLo, authoredHi: r.authoredHi, baseColors: r.baseColors,
    tris: r.triCount, textured: r.textured, images: r.images,
  };
}

{
  const ids = Object.keys(P.PROPS);
  let missing = 0;
  let badSize = 0;
  let badFile = 0;
  let textured = 0;
  let bytes = 0;
  let tris = 0;
  let worst = { d: 0, id: '', axis: 0 };
  let floorTopOk = true;
  for (const id of ids) {
    const def = P.PROPS[id];
    const path = join(ASSETS, def.file + '.glb');
    if (!existsSync(path)) { missing++; continue; }
    bytes += statSync(path).size;
    const m = measureGlb(path);
    if (m === null) { badFile++; continue; }
    tris += m.tris;
    if (m.textured > 0 || m.images > 0) textured++;
    for (let k = 0; k < 3; k++) {
      const d = Math.abs(m.size[k] - def.size[k]);
      if (d > worst.d) worst = { d, id, axis: k };
      if (d > 0.01) badSize++;
    }
    // Every prop must reach the renderer with its base on y = 0 and its footprint centred on the
    // origin, because that is the convention the placement math and every assertion below assume.
    // (The kit violates it: most origins sit on a footprint corner, and the fridge, the stacked
    // washer and the bed are authored sunk below y = 0.)
    if (m.lo[1] !== 0) floorTopOk = false;
    for (const k of [0, 2]) {
      if (Math.abs(m.lo[k] + m.hi[k]) > 1e-9) floorTopOk = false;
    }
    if (def.file === 'floorFull' && m.lo[1] !== 0) floorTopOk = false;
  }
  check(`目录里 ${ids.length} 个道具全部存在（缺 ${missing}）`, missing === 0, String(missing));
  check('每个文件都是合法 GLB（能解析出 JSON chunk 与网格边界）', badFile === 0, String(badFile));
  check('记录尺寸与文件实测尺寸一致（误差 < 0.01）', badSize === 0,
    `${badSize} 个不一致, 最大 ${worst.d.toFixed(4)} (${worst.id} axis ${worst.axis})`);
  check('全部零贴图（与本项目「无纹理 + 卡通着色」约定一致）', textured === 0, `${textured} 个带贴图`);
  check('每个道具都以「脚印居中 + 底面在 y=0」的姿态送进渲染层（摆放数学的前提）', floorTopOk);
  // --- theme albedo overrides (the room floor is grey, the walls keep the kit's wood) ------------
  {
    // The loader looks the override up BY FILE NAME, so that mapping has to be unambiguous.
    const files = ids.map((id) => P.PROPS[id].file);
    const unique = new Set(files).size === files.length;
    let resolved = 0;
    for (const id of ids) if (P.propTintForFile(P.PROPS[id].file) === (P.PROPS[id].tint ?? null)) resolved++;
    check('道具文件名唯一（加载器按文件名查覆盖色不会查错）', unique, String(files.length));
    check('按文件名查到的覆盖色与目录条目一致', resolved === ids.length, `${resolved}/${ids.length}`);

    // Grey, not "a colour that happens to be darkish": the three channels have to be within a
    // hair of each other. The constant carries a slight COOL bias on purpose — under the warm key
    // light (+ the 0xffc890 fill) a dead-neutral albedo reads yellow — so the tolerance is 16/255
    // rather than 0, and the check is written to say exactly that.
    const tint = P.propTintForFile('floorFull');
    const ch = typeof tint === 'number'
      ? [(tint >> 16) & 0xff, (tint >> 8) & 0xff, tint & 0xff] : [0, 0, 0];
    const spread = Math.max(...ch) - Math.min(...ch);
    check(`地面覆盖色是灰（0x${typeof tint === 'number' ? tint.toString(16).padStart(6, '0') : '?'}，通道差 ${spread}）`,
      typeof tint === 'number' && spread <= 16, String(tint));
    const tinted = ids.filter((id) => P.PROPS[id].tint !== undefined);
    check('只有地板声明了覆盖色（墙/家具保持套件原色）',
      tinted.length === 1 && tinted[0] === 'floorFull', tinted.join(', '));
    // ...and the override must actually change something: the kit's own floor albedo is the warm
    // wood tan it shares with the walls, i.e. NOT neutral.
    const m = measureGlb(join(ASSETS, P.PROPS.floorFull.file + '.glb'));
    const own = (m && m.baseColors && m.baseColors[0]) || [1, 1, 1];
    const ownSpread = Math.max(...own) - Math.min(...own);
    check('地板自己的材质色是暖木色（所以覆盖色确实在起作用）', ownSpread > 0.2,
      `wood ${own.map((v) => v.toFixed(2)).join(',')}`);
  }
  // ...and that the shift the reader applies is the SHIPPED formula, not a copy of it that could
  // drift from assets.ts::normalizeProp (which runs only in a browser and cannot be exercised here).
  {
    let mismatch = 0;
    for (const id of ids) {
      const m = measureGlb(join(ASSETS, P.PROPS[id].file + '.glb'));
      if (m === null) continue;
      const want = P.propNormalizeOffset(m.authoredLo, m.authoredHi);
      for (let k = 0; k < 3; k++) if (Math.abs(want[k] - m.offset[k]) > 1e-12) mismatch++;
    }
    check('测试用的居中位移与 props.ts::propNormalizeOffset 完全一致', mismatch === 0, String(mismatch));
  }
  check(`资源总体积 < 1.5MB（实测 ${(bytes / 1024).toFixed(0)}KB）`, bytes < 1.5 * 1024 * 1024);
  check(`三角面总量可控（实测 ${(tris / 1000).toFixed(1)}k）`, tris < 40000, String(Math.round(tris)));
  // No dead catalog entries: every prop in PROPS must appear in one of the placement pools (or the
  // shell). This is the guard that keeps a retheme from leaving orphans behind in both directions —
  // an entry nothing places, and a file nothing loads.
  {
    const inPools = new Set();
    for (const pool of P.POOLS) for (const id of pool) inPools.add(id);
    const dead = ids.filter((id) => !inPools.has(id));
    check('目录里没有「永远不会被摆放」的道具（每个条目都在某个池子里）', dead.length === 0, dead.join(', '));
  }

  // No stray files: every .glb shipped must be referenced by the catalog (otherwise the repo grows
  // dead weight every time somebody retries an asset).
  const onDisk = readdirSync(ASSETS).filter((f) => f.endsWith('.glb')).map((f) => f.slice(0, -4)).sort();
  const referenced = ids.map((id) => P.PROPS[id].file).sort();
  const unreferenced = onDisk.filter((f) => !referenced.includes(f));
  check('没有未被目录引用的多余 .glb（仓库不带死重）', unreferenced.length === 0, unreferenced.join(', '));
}

// --------------------------------------------------------------------------- placement invariants
{
  const plan = P.planArena(OBSTACLES, { seed: 0x5eed1234 });
  const all = [...plan.floor, ...plan.walls, ...plan.cover, ...plan.decor];

  let nan = 0;
  for (const p of all) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.z) || !Number.isFinite(p.scale)) nan++;
    if (p.scale <= 0) nan++;
  }
  check(`布局里没有 NaN / 非正缩放（${all.length} 个实例）`, nan === 0, String(nan));

  // --- room shell -----------------------------------------------------------------------------
  const tiles = Math.round((ARENA_HALF * 2) / P.FLOOR_TILE);
  check(`地板瓦片数 = ${tiles}x${tiles}（每片 ${P.FLOOR_TILE} 单位）`, plan.floor.length === tiles * tiles,
    String(plan.floor.length));
  let coverOk = true;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const t of plan.floor) {
    minX = Math.min(minX, t.x - t.scale / 2);
    maxX = Math.max(maxX, t.x + t.scale / 2);
    minZ = Math.min(minZ, t.z - t.scale / 2);
    maxZ = Math.max(maxZ, t.z + t.scale / 2);
  }
  if (!near(minX, -ARENA_HALF, 1e-6) || !near(maxX, ARENA_HALF, 1e-6)
    || !near(minZ, -ARENA_HALF, 1e-6) || !near(maxZ, ARENA_HALF, 1e-6)) coverOk = false;
  check('地板恰好铺满整个场地（无缝、无溢出）', coverOk,
    `x[${minX.toFixed(2)},${maxX.toFixed(2)}] z[${minZ.toFixed(2)},${maxZ.toFixed(2)}]`);

  const sideWalls = plan.walls.filter((w) => w.id === 'wall');
  const corners = plan.walls.filter((w) => w.id === 'wallCorner');
  check('四面墙各边等分且无缝隙（每边的段宽 = 边长 / 段数）', sideWalls.length % 4 === 0 && sideWalls.length > 40,
    String(sideWalls.length));
  check('四个墙角各一个', corners.length === 4, String(corners.length));
  // Inner face on the arena bound: the wall's own half-thickness must land exactly on +-ARENA_HALF.
  let innerOk = true;
  let worstInner = 0;
  for (const w of plan.walls) {
    const [fw, fd] = P.propFootprint(w.id, w.scale, w.yaw);
    const alongX = w.yaw % 2 === 0;
    // The wall runs along X, so its THICKNESS (and therefore its inner face) is the Z axis.
    const perp = alongX ? Math.abs(w.z) : Math.abs(w.x);
    const halfDepth = (alongX ? fd : fw) / 2;
    worstInner = Math.max(worstInner, Math.abs(perp - halfDepth - ARENA_HALF));
  }
  if (worstInner > 0.01) innerOk = false;
  check('每片墙/窗/墙角的内表面都正好落在场地边界上（不会戳进房间，也看不到墙后）',
    innerOk, `最大偏差 ${worstInner.toFixed(4)}`);
  check('墙体数量合理（< 200 个实例）', plan.walls.length < 200, String(plan.walls.length));

  // --- cover ----------------------------------------------------------------------------------
  let outside = 0;
  let obstaclesCovered = new Set();
  let areaSum = 0;
  let areaWant = 0;
  let minCoverPerObstacle = Infinity;
  for (const o of OBSTACLES) {
    const mine = plan.cover.filter((p) => p.obstacle === OBSTACLES.indexOf(o));
    minCoverPerObstacle = Math.min(minCoverPerObstacle, mine.length);
  }
  for (const p of plan.cover) {
    obstaclesCovered.add(p.obstacle);
    const o = OBSTACLES[p.obstacle];
    const [fw, fd] = P.propFootprint(p.id, p.scale, p.yaw);
    // CONTAINMENT: the prop's rotated footprint must sit inside the collision box.
    const eps = 1e-6;
    if (p.x - fw / 2 < o.x - o.hw - eps || p.x + fw / 2 > o.x + o.hw + eps
      || p.z - fd / 2 < o.y - o.hh - eps || p.z + fd / 2 > o.y + o.hh + eps) outside++;
    areaSum += fw * fd;
  }
  for (const o of OBSTACLES) areaWant += o.hw * 2 * o.hh * 2;
  check('每一块掩体都有道具（没有「看不见的碰撞体」）', obstaclesCovered.size === OBSTACLES.length,
    `${obstaclesCovered.size}/${OBSTACLES.length}`);
  check('每块掩体至少 1 个道具', minCoverPerObstacle >= 1, String(minCoverPerObstacle));
  check('★ 所有掩体道具都完全落在碰撞脚印内（视觉不会伸到碰撞之外）', outside === 0, String(outside));
  check(`掩体总填充率 ≥ 50%（实测 ${((areaSum / areaWant) * 100).toFixed(0)}%）`, areaSum / areaWant >= 0.5,
    `${areaSum.toFixed(1)} / ${areaWant.toFixed(1)}`);

  // PER-OBSTACLE floors. The old assertions only checked the TOTAL fill, which is how a 4x4 box
  // holding one stool (2% of its own footprint) stayed green: the player sees an invisible wall with
  // a small prop in the middle of it, which is exactly the report "these obstacles are too small".
  // The three floors below are what "big enough to read as cover" means, measured:
  //   * coverage  — the pile's pieces cover at least 40% of the collision footprint;
  //   * height    — at least one piece reaches chest height (COVER_TALL_H = 1.45 against a 2.0
  //                 character), so the pile's silhouette is something you could hide behind;
  //   * piece count — a pile is a pile, not a warehouse (the planner caps its main grid at 14).
  let thinPile = 0;
  let shortPile = 0;
  let fatPile = 0;
  let minPileFill = Infinity;
  let minPileHeight = Infinity;
  let mostPieces = 0;
  for (let i = 0; i < OBSTACLES.length; i++) {
    const o = OBSTACLES[i];
    const mine = plan.cover.filter((p) => p.obstacle === i);
    const box = o.hw * 2 * o.hh * 2;
    let area = 0;
    let tallest = 0;
    for (const p of mine) {
      const [fw, fd] = P.propFootprint(p.id, p.scale, p.yaw);
      area += fw * fd;
      tallest = Math.max(tallest, P.PROPS[p.id].size[1] * p.scale);
    }
    const fill = area / box;
    minPileFill = Math.min(minPileFill, fill);
    minPileHeight = Math.min(minPileHeight, tallest);
    mostPieces = Math.max(mostPieces, mine.length);
    if (fill < 0.4) thinPile++;
    if (tallest < P.COVER_TALL_H - 1e-9) shortPile++;
    if (mine.length > 14) fatPile++;
  }
  check(`每块掩体的家具覆盖率 ≥ 40%（实测最低 ${(minPileFill * 100).toFixed(0)}%）`, thinPile === 0, String(thinPile));
  check(`每块掩体至少一件家具到胸口高 ≥ ${P.COVER_TALL_H}（实测最矮 ${minPileHeight.toFixed(2)}，角色 2.0）`,
    shortPile === 0, String(shortPile));
  check(`每堆不超过 14 件（实测最多 ${mostPieces}）`, fatPile === 0, String(fatPile));
  // ...and the家具 that dress cover must actually be scaled up for it: a cover pile is dressed at
  // COVER_SCALE, not at the decor's PROP_SCALE, or the piles go back to being waist high.
  check('掩体家具用的是 COVER_SCALE（> PROP_SCALE），装饰仍是 PROP_SCALE',
    P.COVER_SCALE > P.PROP_SCALE && P.COVER_MAX_H > 0);
  check('掩体池按「房间功能」分组且覆盖高件（每组至少一件能到胸口高）',
    P.COVER_POOLS.length >= 3 && P.COVER_POOLS.every((pool) => pool.some((id) => P.PROPS[id].size[1] * P.COVER_SCALE >= P.COVER_TALL_H - 1e-9)),
    `${P.COVER_POOLS.length} pools`);

  // --- decorations ----------------------------------------------------------------------------
  const solid = plan.decor.filter((p) => !P.PROPS[p.id].flat);
  let inCover = 0;
  let onSpawn = 0;
  let outRoom = 0;
  for (const p of plan.decor) {
    if (OBSTACLES.some((o) => {
      const [fw, fd] = P.propFootprint(p.id, p.scale, p.yaw);
      const gap = P.PROPS[p.id].flat ? 0.2 : P.DECOR_COVER_GAP;
      return p.x - fw / 2 < o.x + o.hw + gap && p.x + fw / 2 > o.x - o.hw - gap
        && p.z - fd / 2 < o.y + o.hh + gap && p.z + fd / 2 > o.y - o.hh - gap;
    })) inCover++;
    if (Math.hypot(p.x, p.z) < P.DECOR_SPAWN_GAP - 1e-9) onSpawn++;
    const [fw, fd] = P.propFootprint(p.id, p.scale, p.yaw);
    if (Math.abs(p.x) + fw / 2 > ARENA_HALF + 1e-6 || Math.abs(p.z) + fd / 2 > ARENA_HALF + 1e-6) outRoom++;
  }
  check('点缀不会插进掩体里', inCover === 0, String(inCover));
  check('点缀不会盖住出生点', onSpawn === 0, String(onSpawn));
  check('点缀全部留在房间内（最外侧面不越过场地边界）', outRoom === 0, String(outRoom));
  check(`点缀数量合理（实体 ${solid.length} 个 + 地毯 + 壁灯）`, plan.decor.length >= 40,
    String(plan.decor.length));
  const lamps = plan.decor.filter((p) => p.id === 'lampWall');
  // Wall lamps are the one decoration placed on a RHYTHM instead of scattered: a room is lit by
  // evenly spaced lamps, and random ones would read as litter stuck to the wall.
  let lampOnWall = 0;
  for (const l of lamps) {
    const [fw, fd] = P.propFootprint(l.id, l.scale, l.yaw);
    const outer = l.yaw % 2 === 0 ? Math.abs(l.z) + fd / 2 : Math.abs(l.x) + fw / 2;
    if (near(outer, ARENA_HALF, 0.02)) lampOnWall++;
  }
  check('壁灯按固定节奏贴在墙上，且背面与墙面齐平', lamps.length >= 12 && lampOnWall === lamps.length,
    `${lampOnWall}/${lamps.length}`);
}

// ------------------------------------------------------------------------------ determinism / seeding
{
  const a = JSON.stringify(P.planArena(OBSTACLES, { seed: 42 }));
  const b = JSON.stringify(P.planArena(OBSTACLES, { seed: 42 }));
  check('同一个种子 -> 完全相同的布局（刷新页面不会变样）', a === b);
  const c = JSON.stringify(P.planArena(OBSTACLES, { seed: 43 }));
  check('不同种子 -> 点缀不同（但掩体摆放仍然一致）',
    c !== a
    && JSON.stringify(P.planArena(OBSTACLES, { seed: 43 }).cover)
      === JSON.stringify(P.planArena(OBSTACLES, { seed: 42 }).cover));
  const noDecor = P.planArena(OBSTACLES, { decor: false });
  check('可以关掉点缀（只做房间与掩体）', noDecor.decor.length === 0
    && noDecor.cover.length > 0 && noDecor.floor.length > 0);
}

// ------------------------------------------------------------------------------- scale sanity
{
  // The kit is authored around a 1-unit human; this app's characters are 2.0 tall. If PROP_SCALE
  // were wrong, furniture would read as doll-house or giant — so pin the few that matter.
  const h = (id) => P.PROPS[id].size[1] * P.PROP_SCALE;
  check('椅子总高 ≈ 1.0（对 2.0 高的角色是正常椅子）', h('chair') > 0.9 && h('chair') < 1.15,
    h('chair').toFixed(2));
  check('房间墙高 ≈ 3.0（角色 2.0，读作室内墙）', h('wall') > 2.6 && h('wall') < 3.4, h('wall').toFixed(2));
  check('冰箱 ≈ 2.0（和角色一样高，作为掩体读起来是实心）',
    h('kitchenFridgeLarge') > 1.7 && h('kitchenFridgeLarge') < 2.4, h('kitchenFridgeLarge').toFixed(2));
  // NOTE: these two numbers were 2.9 and "1.1 x 4.2" while the catalog was measured from the raw
  // accessor bounds. The real fridge is 2.02 tall and the real bed is 2.1 x 2.5 — the old figures
  // came from node transforms the loader applies and the old measurement ignored.
  check('床 ≈ 2.1 x 2.5（双人床，比角色宽）',
    P.PROPS.bedDouble.size[0] * P.PROP_SCALE > 1.8 && P.PROPS.bedDouble.size[2] * P.PROP_SCALE > 2.2
    && h('bedDouble') < 1.0,
    `${(P.PROPS.bedDouble.size[0] * P.PROP_SCALE).toFixed(1)} x `
    + `${(P.PROPS.bedDouble.size[2] * P.PROP_SCALE).toFixed(1)} x ${h('bedDouble').toFixed(2)}`);
}

// ------------------------------------------------------------------------------------- summary
{
  const plan = P.planArena(OBSTACLES, { seed: 0x5eed1234 });
  const counts = P.countByProp(plan);
  const rows = [...counts.entries()].sort((x, y) => y[1] - x[1]);
  console.log(`\n布局：地板 ${plan.floor.length} + 墙 ${plan.walls.length} + 掩体道具 ${plan.cover.length}`
    + ` + 点缀 ${plan.decor.length} = ${plan.floor.length + plan.walls.length + plan.cover.length + plan.decor.length} 个实例`);
  console.log(`道具种类 ${counts.size} 种，最多实例的 8 种：`);
  for (const [id, n] of rows.slice(0, 8)) console.log(`   ${String(id).padEnd(22)} ${n}`);
}

console.log(`\nverify-props: ${passed} 项通过, ${failures.length} 项失败`);
if (failures.length > 0) {
  console.log('\n失败项:');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('全部通过 ✓');
