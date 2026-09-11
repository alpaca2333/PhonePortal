/**
 * 自动减面（automatic decimation）—— 用 meshoptimizer 的 simplifier（`vendor/meshopt/`，MIT，
 * 单个自包含 ESM 文件、wasm 已内嵌、不发网络请求）。
 *
 * WHY meshoptimizer AND NOT three's OWN SimplifyModifier — measured, not assumed:
 *   * three r160 的 `examples/jsm/modifiers/SimplifyModifier.js` 第一件事就是
 *     `if (name !== 'position' && name !== 'uv' && name !== 'normal' …) geometry.deleteAttribute(name)`
 *     —— 它会把 **`skinIndex` / `skinWeight` 直接删掉**，蒙皮角色一减面就变成不会动的静态网格；
 *     它也不管 UV 缝合线（跨缝折叠 → 贴图拉花），并且丢掉多材质分组。
 *   * meshoptimizer 的 simplifier **只重写索引缓冲**：顶点缓冲原样保留，因此 `skinIndex`/
 *     `skinWeight`/`uv`/`normal` 天然仍然有效；再用 `simplifyWithAttributes` 把 uv 与蒙皮权重
 *     交给它当"属性"，它就会避免跨缝合线/权重突变处折叠。gltfpack 用的就是这条路。
 *
 * 两个必须记住的取舍：
 *   1. **目标面数是期望值，不是保证**：`target_error`（误差上限，界面上的「误差上限」）先到就先停。
 *      实测同一个模型，20% 的目标在 1% 误差下只减到 40%（详见 apps/fbx2glb/README.md 的实测表）。
 *   2. **索引重写之后还要压紧顶点**：不用的顶点仍然占文件体积，所以这里用同一张 remap 表把所有属性
 *      （position/normal/uv/uv1/skinIndex/skinWeight…）一起过滤 —— 一张表、所有属性，错一个就错位。
 *
 * 不做的：不重算法线（沿用原顶点法线，强减面后可能有轻微着色误差）、不处理 morph target
 * （有 morph 的网格直接跳过，因为 simplifier 不知道形变目标，减完形变就废了）、不跨材质分组折叠
 * （分组按各自的索引区间分别简化，材质边界因此被保留为硬边）。
 */
import * as THREE from 'three';

/** 保留比例的滑杆范围与默认值（settings.ts 直接引用，保证界面范围与实际钳制同源）。 */
export const RATIO_MIN = 0.05;
export const RATIO_MAX = 1;
export const RATIO_STEP = 0.05;
export const RATIO_DEFAULT = 0.5;
/** 误差上限（相对模型尺寸）：0.1% – 15%，默认 1%。先到就先停，所以调大它才会真的减到目标。 */
export const ERROR_MIN = 0.001;
export const ERROR_MAX = 0.15;
export const ERROR_STEP = 0.001;
export const ERROR_DEFAULT = 0.01;
/** 小于这个面数的网格不动它——12 面的盒子减半只会变成垃圾。 */
export const DECIMATE_MIN_TRIS = 64;
/** 「保护轮廓」：锁住边界边（开放边），避免把剪影折进去。 */
export const DECIMATE_LOCK_BORDER_DEFAULT = true;
/** uv 属性的折叠代价权重（meshopt 推荐 1）。 */
export const UV_WEIGHT = 1;
/** 蒙皮权重的折叠代价权重：权重在表面上是平滑的，所以给一个小值就够——它只需要阻止跨权重突变折叠。 */
export const SKIN_WEIGHT = 0.01;

export interface DecimateOptions {
  enabled: boolean;
  /** 保留比例 0.05–1（目标面数 = 原面数 × 比例）。 */
  ratio: number;
  /** 误差上限（相对模型尺寸的比例，0.001–0.15）。先到就先停。 */
  error: number;
  lockBorder: boolean;
}

export type SkipReason =
  | 'disabled'   // 功能没开
  | 'unavailable'// wasm 起不来 / 浏览器不支持
  | 'tiny'       // 网格面数低于下限
  | 'at-target'  // 目标 ≥ 原面数，没什么可减
  | 'no-index'   // 没有 position 属性
  | 'morph'      // 有 morph target，减面会毁掉形变
  | 'failed';    // simplifier 自己报错

export interface MeshDecimation {
  name: string;
  before: number;
  after: number;
  vertsBefore: number;
  vertsAfter: number;
  /** 这个网格上花掉的毫秒数。 */
  ms: number;
  /** simplifier 返回的几何误差（相对值）。 */
  error: number;
  /** 非 null = 这个网格被跳过了，原因见上。 */
  skip: SkipReason | null;
}

export interface DecimateReport {
  /** wasm 可用吗。 */
  available: boolean;
  /** 实际减面的网格数。 */
  applied: number;
  trisBefore: number;
  trisAfter: number;
  vertsBefore: number;
  vertsAfter: number;
  ms: number;
  meshes: MeshDecimation[];
  /** 整体没减面时的原因（功能关闭 / wasm 不可用）。 */
  reason?: SkipReason;
}

const emptyReport = (reason: SkipReason, available: boolean): DecimateReport => ({
  available, applied: 0, trisBefore: 0, trisAfter: 0, vertsBefore: 0, vertsAfter: 0, ms: 0,
  meshes: [], reason,
});

let simplifierPromise: Promise<any | null> | null = null;

/**
 * 载入 vendored 的 simplifier（只载一次）。任何失败都**不抛**：返回 null，调用方降级成「不减面
 * 并告诉用户」。没有 WebAssembly 的老浏览器走的就是这条路。
 */
export function loadSimplifier(): Promise<any | null> {
  if (simplifierPromise === null) {
    const load = async (): Promise<any | null> => {
      try {
        // @ts-ignore - vendored meshoptimizer build, untyped (same escape hatch as the three addons)
        const mod = await import('../vendor/meshopt/meshopt_simplifier.js');
        const simplifier = mod?.MeshoptSimplifier;
        if (!simplifier || simplifier.supported === false) return null;
        await simplifier.ready;
        return simplifier;
      } catch {
        return null;
      }
    };
    simplifierPromise = load();
  }
  return simplifierPromise;
}

/** 目标面数（纯函数：UI 与报告都从它来，保证「说减到多少」和「实际减到多少」同一个来源）。 */
export function targetTriangles(before: number, ratio: number): number {
  const r = Number.isFinite(ratio) ? Math.min(1, Math.max(0.01, ratio)) : 1;
  return Math.max(1, Math.round(before * r));
}

/** 这个网格该不该减（纯函数，全部有断言）。 */
export function skipReasonFor(mesh: any, target: number): SkipReason | null {
  const geo = mesh?.geometry;
  if (!geo || !geo.getAttribute?.('position')) return 'no-index';
  if (geo.morphAttributes && Object.keys(geo.morphAttributes).length > 0) return 'morph';
  const tris = triangleCount(geo);
  if (tris < DECIMATE_MIN_TRIS) return 'tiny';
  if (target >= tris) return 'at-target';
  return null;
}

/** 三角面数（有索引就数索引，没有就按 position 三元组算）。 */
export function triangleCount(geometry: any): number {
  const pos = geometry?.getAttribute?.('position');
  if (!pos) return 0;
  if (geometry.index) return Math.floor(geometry.index.count / 3);
  return Math.floor(pos.count / 3);
}

/**
 * 把一棵蒙皮/静态场景克隆一份用于导出。`SkeletonUtils.clone` 会重建骨骼层级并把 `skeleton.bones`
 * 指向克隆出来的骨骼（名字不变 → 动画片段仍然按名字绑定），同时**共享 geometry 与 material**；
 * 我们随后只"替换"克隆体上的 geometry，所以原始模型（预览用的那个）一点都不会被改动。
 */
export async function cloneRig(root: any): Promise<any> {
  // @ts-ignore - vendored three addon, untyped
  const { clone } = await import('../vendor/addons/utils/SkeletonUtils.js');
  return clone(root);
}

interface SimplifyResult {
  geometry: any;
  before: number;
  after: number;
  vertsBefore: number;
  vertsAfter: number;
  error: number;
}

/** 简化几何体（不做 I/O、不改原对象；返回一个新的 BufferGeometry）。 */
export function simplifyGeometry(
  geometry: any,
  simplifier: any,
  targetTris: number,
  error: number,
  lockBorder: boolean,
): SimplifyResult {
  const pos = geometry.getAttribute('position');
  const vertsBefore = pos.count;
  const index = geometry.index
    ? Uint32Array.from(geometry.index.array as ArrayLike<number>)
    : Uint32Array.from({ length: vertsBefore }, (_, i) => i);
  const before = Math.floor(index.length / 3);
  const positions = Float32Array.from(pos.array as ArrayLike<number>);
  const stride = pos.itemSize;

  // 属性（uv + 蒙皮权重/索引）拼成一条交错缓冲：simplifier 只看数值，权重告诉它哪些"跳变"要避免。
  const parts: { attr: any; weight: number }[] = [];
  const uv = geometry.getAttribute('uv');
  if (uv) parts.push({ attr: uv, weight: UV_WEIGHT });
  const skinWeight = geometry.getAttribute('skinWeight');
  if (skinWeight) parts.push({ attr: skinWeight, weight: SKIN_WEIGHT });
  const skinIndex = geometry.getAttribute('skinIndex');
  if (skinIndex) parts.push({ attr: skinIndex, weight: SKIN_WEIGHT });
  const attrStride = parts.reduce((n, p) => n + p.attr.itemSize, 0);
  let attrs: Float32Array | null = null;
  if (attrStride > 0) {
    attrs = new Float32Array(vertsBefore * attrStride);
    for (let i = 0; i < vertsBefore; i++) {
      let o = i * attrStride;
      for (const p of parts) {
        for (let c = 0; c < p.attr.itemSize; c++) attrs[o++] = p.attr.array[i * p.attr.itemSize + c];
      }
    }
  }

  const flags: string[] = lockBorder ? ['LockBorder'] : [];
  // 多材质网格：按分组各自的索引区间分别简化，材质边界因此变成硬边（不会把两种材质的三角形折叠到
  // 一起）。单材质（0/1 组）直接整条索引跑一次。
  const groups = Array.isArray(geometry.groups) && geometry.groups.length > 1
    ? geometry.groups
    : [{ start: 0, count: index.length, materialIndex: 0 }];
  const outParts: Uint32Array[] = [];
  let error0 = 0;
  for (const group of groups) {
    const slice = index.subarray(group.start, group.start + group.count);
    const share = slice.length / index.length;
    const groupTarget = Math.max(3, Math.round(targetTris * share)) * 3;
    const [simplified, err] = attrs
      ? simplifier.simplifyWithAttributes(index, positions, stride, attrs, attrStride,
        parts.map((p) => p.weight), null, groupTarget, error, flags)
      : simplifier.simplify(index, positions, stride, groupTarget, error, flags);
    error0 = Math.max(error0, err);
    outParts.push(simplified);
  }
  const newIndexRaw = new Uint32Array(outParts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of outParts) { newIndexRaw.set(part, at); at += part.length; }

  // 压紧顶点：同一张 remap 表过滤**所有**属性，任何一个属性漏掉都会让蒙皮/UV 整体错位。
  const remap = new Int32Array(vertsBefore).fill(-1);
  let vertsAfter = 0;
  for (const i of newIndexRaw) if (remap[i] < 0) remap[i] = vertsAfter++;
  const out = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries<any>(geometry.attributes)) {
    const comps = attr.itemSize;
    const array = new (attr.array.constructor as any)(vertsAfter * comps);
    for (let i = 0; i < vertsBefore; i++) {
      const r = remap[i];
      if (r < 0) continue;
      for (let c = 0; c < comps; c++) array[r * comps + c] = attr.array[i * comps + c];
    }
    out.setAttribute(name, new THREE.BufferAttribute(array, comps, attr.normalized));
  }
  const newIndex = new Uint32Array(newIndexRaw.length);
  for (let i = 0; i < newIndexRaw.length; i++) newIndex[i] = remap[newIndexRaw[i]!]!;
  out.setIndex(new THREE.BufferAttribute(newIndex, 1));
  // 分组按新的索引长度重排（只有单组时 groups 为空，导出时等价）。
  if (Array.isArray(geometry.groups) && geometry.groups.length > 1) {
    let cursor = 0;
    const rebuilt = groups.map((g: any, i: number) => {
      const count = outParts[i]!.length;
      const group = { start: cursor, count, materialIndex: g.materialIndex ?? 0 };
      cursor += count;
      return group;
    });
    for (const g of rebuilt) out.addGroup(g.start, g.count, g.materialIndex);
  }
  return { geometry: out, before, after: Math.floor(newIndex.length / 3), vertsBefore, vertsAfter, error: error0 };
}

/**
 * 导出用的减面：克隆一棵场景树，把每个够大的网格换成简化后的几何体。
 *
 * **不改动传入的 root**（预览用的那份），返回新的 root。返回值里的 `report` 就是界面要显示的东西。
 */
export async function decimateForExport(
  root: any,
  opts: DecimateOptions,
): Promise<{ root: any; report: DecimateReport }> {
  if (!opts?.enabled) return { root, report: emptyReport('disabled', true) };
  const simplifier = await loadSimplifier();
  if (!simplifier) return { root, report: emptyReport('unavailable', false) };

  const cloned = await cloneRig(root);
  const report: DecimateReport = emptyReport('disabled', true);
  report.reason = undefined;
  const meshes: any[] = [];
  cloned?.traverse?.((o: any) => { if (o.isMesh) meshes.push(o); });

  for (const mesh of meshes) {
    const tris = triangleCount(mesh.geometry);
    const target = targetTriangles(tris, opts.ratio);
    const skip = skipReasonFor(mesh, target);
    const before = tris;
    if (skip) {
      report.meshes.push({
        name: String(mesh.name || 'mesh'), before, after: before,
        vertsBefore: mesh.geometry?.getAttribute?.('position')?.count ?? 0,
        vertsAfter: mesh.geometry?.getAttribute?.('position')?.count ?? 0,
        ms: 0, error: 0, skip,
      });
      continue;
    }
    const t = Date.now();
    try {
      const r = simplifyGeometry(mesh.geometry, simplifier, target, opts.error, opts.lockBorder);
      const ms = Date.now() - t;
      mesh.geometry = r.geometry;
      report.meshes.push({
        name: String(mesh.name || 'mesh'), before: r.before, after: r.after,
        vertsBefore: r.vertsBefore, vertsAfter: r.vertsAfter, ms, error: r.error, skip: null,
      });
      report.applied++;
    } catch {
      report.meshes.push({
        name: String(mesh.name || 'mesh'), before, after: before,
        vertsBefore: mesh.geometry?.getAttribute?.('position')?.count ?? 0,
        vertsAfter: mesh.geometry?.getAttribute?.('position')?.count ?? 0,
        ms: Date.now() - t, error: 0, skip: 'failed',
      });
    }
  }

  for (const m of report.meshes) {
    report.trisBefore += m.before;
    report.trisAfter += m.after;
    report.vertsBefore += m.vertsBefore;
    report.vertsAfter += m.vertsAfter;
    report.ms += m.ms;
  }
  if (report.applied === 0) {
    // 全都是 tiny/at-target：不是错误，但要告诉用户为什么没变。
    report.reason = report.meshes.every((m) => m.skip === 'tiny') && report.meshes.length > 0
      ? 'tiny' : report.reason ?? 'at-target';
  }
  return { root: cloned, report };
}

/** 报告 → 一行文字（界面与日志共用，保证"说出来的数"和"报出来的数"同源）。 */
export function decimateSummaryText(report: DecimateReport): string {
  if (report.applied === 0) {
    switch (report.reason) {
      case 'disabled': return '';
      case 'unavailable': return '减面不可用（这个浏览器没有 WebAssembly）';
      case 'tiny': return '没有网格需要减面（都小于 ' + DECIMATE_MIN_TRIS + ' 面）';
      case 'at-target': return '没有网格需要减面（目标不低于原面数）';
      default: return '没有网格被减面';
    }
  }
  const cut = report.trisBefore > 0
    ? Math.round((1 - report.trisAfter / report.trisBefore) * 100) : 0;
  return `减面：${report.trisBefore} → ${report.trisAfter} 面（−${cut}%）、` +
    `顶点 ${report.vertsBefore} → ${report.vertsAfter}、${report.ms} ms`;
}
