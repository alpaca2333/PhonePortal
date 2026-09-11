/**
 * 贴图压缩：**降分辨率 + 不透明贴图转 JPEG**。
 *
 * 为什么这个功能才是"文件体积"的开关：一个 264MB 的角色文件里，几何数据通常只有几 MB
 * （46k 面 + 139k 顶点 ≈ 8MB），剩下全是贴图 —— 8K 的 PNG 一张就能有 30–50MB。减面只降 GPU 负载，
 * 降分辨率与换编码格式才降体积。
 *
 * 两条机制，都靠 three 的 `GLTFExporter` 已有的钩子，不自己造导出器：
 *   1. **分辨率**：`GLTFExporter` 的 `options.maxTextureSize` 不能用来做这件事 —— 它把宽高**各自**
 *      `Math.min(dim, max)`，8192×2048 的贴图会被拉成 2048×2048（变形）。所以这里自己按**最长边**等比
 *      缩放到 canvas，再把 canvas 作为 `texture.image` 交给导出器（导出器只负责编码，不再缩放）。
 *   2. **编码**：导出器读 `texture.userData.mimeType` 决定编码成 PNG 还是 JPEG。默认是 PNG（照片类贴图
 *      体积巨大），所以不透明贴图设成 `image/jpeg`；带 alpha 的槽、法线贴图、以及材质标了 `transparent`
 *      的底色贴图保持 PNG（JPEG 的块状噪声在法线/透明边缘上最难看）。
 *
 * 两个容易被忽略的细节：
 *   * **共享图片只压一次**：同一张 image 被 `map` 与 `emissiveMap` 共用时，如果各压一遍就变成两张图、
 *     GLB 里也会嵌两份（体积直接翻倍）。这里按"源 image 对象"缓存压缩结果，共享关系原样保留。
 *   * **不改原模型**：和减面一样，这一步跑在导出用的克隆体上（`main.ts` 里先 clone 再减面再压贴图）。
 *
 * 不做：不做 quality 滑杆（导出器用 `canvas.toBlob(mime)` 编码，质量是浏览器默认值，外部指定不了；
 * 想精确控质量就得自己先编一遍、再让导出器编第二遍 —— 双重 JPEG，得不偿失）；不做 KTX2/WebP（导出器
 * 会把 webp 降级成 png，KTX2 需要额外的编码器与运行时扩展）。
 */
import { textureSlots } from './textures.js';
import { formatBytes } from './names.js';

/** 「最大边长」的可选值；0 = 原样（不缩放）。 */
export const PACK_SIZE_OPTIONS = [0, 512, 1024, 2048, 4096] as const;
export const PACK_SIZE_DEFAULT = 2048;
export const PACK_JPEG_DEFAULT = true;
/** `canvas.toBlob(..., 'image/jpeg')` 的质量；仅用于我们自己量尺寸，导出器编码时用的是浏览器默认值。 */
export const PACK_JPEG_QUALITY = 0.9;
/**
 * 一张 canvas 的像素上限（≈67MB 的 RGBA）。手机上把 8192×8192 原样搬进 canvas 再编码会直接吃掉 ~270MB
 * 内存，所以超过这个上限就**跳过并说明原因**，让用户把「最大边长」调小，而不是把页面拖到 OOM。
 */
export const MAX_PACK_PIXELS = 4096 * 4096;

export interface PackOptions {
  enabled: boolean;
  /** 最长边的上限，0 = 不缩放。 */
  maxSize: number;
  /** 不透明贴图是否转 JPEG。 */
  jpeg: boolean;
}

export type PackSkip = 'disabled' | 'unavailable' | 'no-image' | 'at-target' | 'too-big' | 'failed';

export interface PackedTexture {
  material: string;
  slot: string;
  name: string;
  beforeW: number;
  beforeH: number;
  afterW: number;
  afterH: number;
  /** 导出时使用的编码。 */
  mime: string;
  ms: number;
  /** 非 null = 没处理，原因见上。 */
  skip: PackSkip | null;
  /** true = 复用了同一张源图片已经压好的结果（没有重复压缩）。 */
  shared: boolean;
}

export interface PackReport {
  enabled: boolean;
  /** 这个环境有没有 canvas（浏览器有，Node 里没有 → 降级）。 */
  available: boolean;
  packed: number;
  skipped: number;
  ms: number;
  entries: PackedTexture[];
  reason?: PackSkip;
  /** 产物 GLB 里图片占的字节数（导出后由调用方填；`null` = 没测或不是 GLB）。 */
  imageBytes: number | null;
}

const emptyReport = (reason: PackSkip, available: boolean, enabled: boolean): PackReport =>
  ({ enabled, available, packed: 0, skipped: 0, ms: 0, entries: [], reason, imageBytes: null });

/**
 * 等比缩放到最长边 ≤ maxSize（纯函数）。
 *
 * ⚠️ 这里刻意**不是** three 导出器那种"宽高各自取 min"：那种做法在非正方形贴图上会改变宽高比
 * （8192×2048 会被拉成 2048×2048）。
 */
export function targetSizeFor(
  width: number, height: number, maxSize: number,
): { width: number; height: number; scaled: boolean } {
  const w = Math.max(1, Math.floor(Number.isFinite(width) ? width : 0));
  const h = Math.max(1, Math.floor(Number.isFinite(height) ? height : 0));
  if (!Number.isFinite(maxSize) || maxSize <= 0) return { width: w, height: h, scaled: false };
  const longest = Math.max(w, h);
  if (longest <= maxSize) return { width: w, height: h, scaled: false };
  const factor = maxSize / longest;
  return { width: Math.max(1, Math.round(w * factor)), height: Math.max(1, Math.round(h * factor)), scaled: true };
}

/** 某个槽该用哪种编码（纯函数：界面提示与导出行为同源）。 */
export function mimeFor(slot: string, material: any, jpeg: boolean): 'image/jpeg' | 'image/png' {
  if (!jpeg) return 'image/png';
  // 带 alpha 的槽 / 材质声明了透明 / 法线贴图：保持 PNG（JPEG 的块状噪声在这三处最明显）。
  if (slot === 'alphaMap') return 'image/png';
  if (slot === 'normalMap') return 'image/png';
  if (material && material.transparent === true) return 'image/png';
  return 'image/jpeg';
}

/**
 * 就地压缩 `root` 上的贴图（**请传入导出用的克隆体**；原模型的 texture 对象不会被改）。
 * 返回逐槽报告；任何一张贴图失败都不影响其它贴图，也不会让导出失败。
 */
export async function packTextures(root: any, opts: PackOptions): Promise<PackReport> {
  const enabled = opts?.enabled === true;
  if (!enabled) return emptyReport('disabled', true, false);
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    return emptyReport('unavailable', false, true);
  }

  const report = emptyReport('disabled', true, true);
  report.reason = undefined;
  // 源 image 对象 → 已经压好的结果：同一张图被多个槽用到时只压一次，且压缩后仍然**共享同一个对象**
  // （导出器按 image 对象去重，否则会在 GLB 里嵌两份）。
  const cache = new Map<any, { image: any; width: number; height: number }>();
  const t0 = Date.now();

  for (const { material, materialName, slot, texture } of textureSlots(root)) {
    const image = texture.image;
    const beforeW = Math.max(0, Math.floor(image?.width ?? 0));
    const beforeH = Math.max(0, Math.floor(image?.height ?? 0));
    const mime = mimeFor(slot, material, opts.jpeg);
    const name = String(texture.name || image?.name || slot);
    const start = Date.now();

    if (!image || beforeW === 0 || beforeH === 0) {
      report.entries.push({
        material: materialName, slot, name, beforeW, beforeH, afterW: beforeW, afterH: beforeH,
        mime, ms: 0, skip: 'no-image', shared: false,
      });
      report.skipped++;
      continue;
    }

    const target = targetSizeFor(beforeW, beforeH, opts.maxSize);
    // 既不用缩小、也没要求转码 → 没什么可做（导出器本来就会写 PNG）。
    if (!target.scaled && mime === 'image/png') {
      report.entries.push({
        material: materialName, slot, name, beforeW, beforeH, afterW: beforeW, afterH: beforeH,
        mime, ms: 0, skip: 'at-target', shared: false,
      });
      report.skipped++;
      continue;
    }

    if (target.width * target.height > MAX_PACK_PIXELS) {
      report.entries.push({
        material: materialName, slot, name, beforeW, beforeH, afterW: beforeW, afterH: beforeH,
        mime, ms: Date.now() - start, skip: 'too-big', shared: false,
      });
      report.skipped++;
      continue;
    }

    const cached = cache.get(image);
    if (cached) {
      texture.image = cached.image;
      texture.userData.mimeType = mime;
      texture.needsUpdate = true;
      report.entries.push({
        material: materialName, slot, name, beforeW, beforeH,
        afterW: cached.width, afterH: cached.height, mime, ms: Date.now() - start, skip: null, shared: true,
      });
      report.packed++;
      continue;
    }

    try {
      const canvas = document.createElement('canvas');
      canvas.width = target.width;
      canvas.height = target.height;
      const ctx = canvas.getContext?.('2d');
      if (!ctx) throw new Error('no 2d context');
      ctx.imageSmoothingEnabled = true;
      if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(image, 0, 0, target.width, target.height);
      // 读一个像素：万一贴图是跨域的（canvas 被污染），toBlob 会抛 SecurityError，那会在导出器里
      // 变成"整个导出失败"。在这里先探一下，改成"跳过这一张"。
      ctx.getImageData(0, 0, 1, 1);
      texture.image = canvas;
      texture.userData.mimeType = mime;
      texture.needsUpdate = true;
      cache.set(image, { image: canvas, width: target.width, height: target.height });
      report.entries.push({
        material: materialName, slot, name, beforeW, beforeH,
        afterW: target.width, afterH: target.height, mime, ms: Date.now() - start, skip: null, shared: false,
      });
      report.packed++;
    } catch {
      report.entries.push({
        material: materialName, slot, name, beforeW, beforeH, afterW: beforeW, afterH: beforeH,
        mime, ms: Date.now() - start, skip: 'failed', shared: false,
      });
      report.skipped++;
    }
  }

  report.ms = Date.now() - t0;
  if (report.packed === 0) {
    const all = (kind: PackSkip): boolean => report.entries.length > 0 && report.entries.every((e) => e.skip === kind);
    report.reason = report.entries.length === 0 ? 'no-image'
      : all('at-target') ? 'at-target'
        : all('no-image') ? 'no-image'
          : all('too-big') ? 'too-big' : 'failed';
  }
  return report;
}

/** 报告 → 一行文字（界面与日志共用）。 */
export function packSummaryText(report: PackReport): string {
  if (!report.enabled) return '';
  if (!report.available) return '贴图压缩不可用（这个环境没有 canvas）';
  const done = report.entries.filter((e) => e.skip === null);
  if (done.length === 0) {
    switch (report.reason) {
      case 'no-image': return '贴图压缩：这个模型没有可处理的贴图';
      case 'at-target': return '贴图压缩：没有需要处理的贴图（都在目标尺寸内，且不需要转码）';
      case 'too-big': return `贴图压缩：贴图太大，原样转码要一张超过 ${MAX_PACK_PIXELS / 1e6} 百万像素的 canvas` +
        `（手机上会吃掉几百 MB 内存）——把「最大边长」调到 4096 或更小`;
      case 'failed': return '贴图压缩：贴图处理失败（格式不支持或画布被跨域污染）';
      default: return '贴图压缩：没有需要处理的贴图';
    }
  }
  const dims = [...new Set(done.map((e) => `${e.beforeW}×${e.beforeH} → ${e.afterW}×${e.afterH}`))];
  const mimes = [...new Set(done.map((e) => e.mime.replace('image/', '')))];
  const shared = done.filter((e) => e.shared).length;
  const bytes = report.imageBytes !== null ? `、产物里图片共 ${formatBytes(report.imageBytes)}` : '';
  return `贴图压缩：${done.length} 张（${dims.slice(0, 3).join('、')}${dims.length > 3 ? ' 等' : ''}，` +
    `${mimes.join('/')}${shared > 0 ? `，其中 ${shared} 张复用已压结果` : ''}）${bytes}、${report.ms} ms`;
}
