/**
 * Settings schema for the FBX→GLB converter — PURE data + pure functions (no DOM, no fetch), so the
 * merge/validate/clamp rules are testable in Node (scripts/verify-fbx2glb.mjs), exactly like the
 * shooter's `settings.ts`.
 *
 * The server stores an opaque JSON object per scope; THIS module owns the schema. Stored values are
 * SPARSE OVERRIDES: an untouched key is absent and keeps the built-in default, and unknown keys are
 * preserved verbatim on save (AGENTS.md「设置与用户数据」).
 *
 * Two groups, scope `fbx2glb`:
 *   - `convert` → 转换选项: output format, merge, animations, unit scale, clip naming
 *   - `decimate` → 减面: on/off, keep ratio, error ceiling, silhouette lock
 *   - `texture`  → 贴图压缩: on/off, longest-edge cap, JPEG for opaque maps
 *   - `preview` → 预览: grid, bone display, playback speed
 *
 * ⚠️ THE `<orientation>` LEVEL IS PRESENT BUT HAS NO SEMANTICS HERE — and that is deliberate, so it
 * needs its reason on the record. AGENTS.md mandates the key path `scope.<组>.<方向>.<键>` because the
 * shooter's layout values genuinely differ per orientation. A converter has no such values: the
 * export format or the unit scale must NOT change when the phone is rotated, and storing them per
 * orientation would make 「转屏后导出格式变了」 a real bug. The resolution used here is to keep the
 * mandated path (so every app's storage shape stays uniform and the panel's merge path has no special
 * case) while having the panel WRITE BOTH orientations on every change — the two copies therefore
 * cannot diverge through the UI, and a hand-edited file with only one copy still reads
 * deterministically (the current orientation wins, the other falls back to the defaults).
 */

import { SCALE_MODES, type ScaleMode } from './units.js';
// 减面的范围/步长/默认值由 decimate.ts（真正消费这些数的地方）拥有，滑杆范围与实际钳制因此不可能漂移。
import {
  DECIMATE_LOCK_BORDER_DEFAULT, ERROR_DEFAULT, ERROR_MAX, ERROR_MIN, ERROR_STEP,
  RATIO_DEFAULT, RATIO_MAX, RATIO_MIN, RATIO_STEP,
} from './decimate.js';
// 贴图压缩的可选尺寸与默认值同样由消费方（texturepack.ts）拥有。
import { PACK_JPEG_DEFAULT, PACK_SIZE_DEFAULT, PACK_SIZE_OPTIONS } from './texturepack.js';

export type Orientation = 'portrait' | 'landscape';
export const ORIENTATIONS: readonly Orientation[] = ['portrait', 'landscape'];

export interface Viewport { width: number; height: number; }

/** Which copy of a setting the current viewport reads (see the note above). */
export function orientationOf(vp: Viewport): Orientation {
  return vp.width > vp.height ? 'landscape' : 'portrait';
}

/** The whole scope value as stored on the server. */
export type RawSettings = Record<string, unknown>;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Accept whatever the server holds (or a hand-edited file) and return a safe raw object. */
export function createState(raw: unknown): RawSettings {
  return isPlainObject(raw) ? raw : {};
}

// ---------------------------------------------------------------------------
// convert group
// ---------------------------------------------------------------------------

export const FORMATS = ['glb', 'gltf'] as const;
export type ExportFormat = (typeof FORMATS)[number];
export const CLIP_NAME_MODES = ['file', 'clip'] as const;
export type ClipNameMode = (typeof CLIP_NAME_MODES)[number];

export interface ConvertSettings {
  /** `glb` = one self-contained binary (default); `gltf` = JSON with an embedded base64 buffer. */
  format: ExportFormat;
  /** Merge every input file into one output (default); off = one output per input file. */
  merge: boolean;
  /** Export animation clips at all. Off produces a static model. */
  animations: boolean;
  /** Unit handling (see units.ts): auto / keep / cm→m. */
  scaleMode: ScaleMode;
  /** Clip naming: after the FILE (default) or after the clip's own name (see names.ts). */
  clipNaming: ClipNameMode;
}

export const CONVERT_GROUP = 'convert';
export const CONVERT_KEYS = ['format', 'merge', 'animations', 'scaleMode', 'clipNaming'] as const;
export type ConvertKey = (typeof CONVERT_KEYS)[number];

/**
 * Built-in defaults. `glb` + merge + animations reproduces the one workflow this app exists for
 * (Mixamo: one file per animation → one GLB with all clips), so an untouched install needs no clicks.
 */
export function convertDefaults(): ConvertSettings {
  return { format: 'glb', merge: true, animations: true, scaleMode: 'auto', clipNaming: 'file' };
}

/** One raw value → a valid setting, or undefined when it is not usable (dirty data is dropped, not thrown). */
function validConvertValue(key: ConvertKey, value: unknown): string | boolean | undefined {
  switch (key) {
    case 'format':
      return typeof value === 'string' && (FORMATS as readonly string[]).includes(value)
        ? (value as ExportFormat) : undefined;
    case 'scaleMode':
      return typeof value === 'string' && (SCALE_MODES as readonly string[]).includes(value)
        ? (value as ScaleMode) : undefined;
    case 'clipNaming':
      return typeof value === 'string' && (CLIP_NAME_MODES as readonly string[]).includes(value)
        ? (value as ClipNameMode) : undefined;
    case 'merge':
    case 'animations':
      return typeof value === 'boolean' ? value : undefined;
    default:
      return undefined;
  }
}

/** Sparse convert overrides for one orientation; unusable values are ignored, not clamped. */
export function readConvertOverrides(raw: RawSettings, o: Orientation): Partial<ConvertSettings> {
  const group = raw[CONVERT_GROUP];
  if (!isPlainObject(group)) return {};
  const src = group[o];
  if (!isPlainObject(src)) return {};
  const out: Partial<ConvertSettings> = {};
  for (const k of CONVERT_KEYS) {
    const v = validConvertValue(k, src[k]);
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/**
 * Set one convert override. WRITES BOTH ORIENTATIONS — see the header note: these values are not
 * orientation-dependent, and writing both is what keeps the mandated storage path from changing the
 * app's behaviour on rotation.
 */
export function writeConvertOverride(raw: RawSettings, key: ConvertKey, value: unknown): void {
  if (!isPlainObject(raw[CONVERT_GROUP])) raw[CONVERT_GROUP] = {};
  const group = raw[CONVERT_GROUP] as Record<string, unknown>;
  for (const o of ORIENTATIONS) {
    if (!isPlainObject(group[o])) group[o] = {};
    (group[o] as Record<string, unknown>)[key] = value;
  }
}

/** Drop every convert override (「恢复默认」), for both orientations, cleaning up empty containers. */
export function clearConvertGroup(raw: RawSettings): void {
  delete raw[CONVERT_GROUP];
}

/** Defaults merged with the sparse overrides of the current orientation. */
export function effectiveConvert(raw: RawSettings, o: Orientation): ConvertSettings {
  return { ...convertDefaults(), ...readConvertOverrides(raw, o) };
}

/** Is any convert value overridden in EITHER orientation? (drives 「恢复默认」's enabled state) */
export function hasConvertOverrides(raw: RawSettings): boolean {
  return ORIENTATIONS.some((o) => Object.keys(readConvertOverrides(raw, o)).length > 0);
}

// ---------------------------------------------------------------------------
// decimate group —— 自动减面
// ---------------------------------------------------------------------------
// 三个数 + 一个开关。`ratio` 是"想保留多少"，`error` 是"最多允许变形多少"——后者才是真正的限制项
// （误差先到就先停，所以 20% 的目标在 1% 误差下可能只减到 40%，实测见 apps/fbx2glb/README.md）。
export interface DecimateSettings {
  enabled: boolean;
  /** 保留比例（0.05–1）。 */
  ratio: number;
  /** 误差上限（相对模型尺寸，0.001–0.15）。 */
  error: number;
  /** 锁边界（保护剪影）。 */
  lockBorder: boolean;
}

export const DECIMATE_GROUP = 'decimate';
export const DECIMATE_KEYS = ['enabled', 'ratio', 'error', 'lockBorder'] as const;
export type DecimateKey = (typeof DECIMATE_KEYS)[number];

/** 滑杆范围/步长，来自 decimate.ts。 */
export const DECIMATE_LIMITS: Record<'ratio' | 'error', { min: number; max: number; step: number }> = {
  ratio: { min: RATIO_MIN, max: RATIO_MAX, step: RATIO_STEP },
  error: { min: ERROR_MIN, max: ERROR_MAX, step: ERROR_STEP },
};

/** 出厂默认：**关闭**——减面是有损的，不能默认改变别人的模型。 */
export function decimateDefaults(): DecimateSettings {
  return { enabled: false, ratio: RATIO_DEFAULT, error: ERROR_DEFAULT, lockBorder: DECIMATE_LOCK_BORDER_DEFAULT };
}

/** 钳制 + 按步长吸附（脏数据/手改文件都从这里过）。 */
export function clampDecimate(s: DecimateSettings): DecimateSettings {
  const snap = (v: number, lim: { min: number; max: number; step: number }, fallback: number): number => {
    if (!Number.isFinite(v)) return fallback;
    const clamped = v < lim.min ? lim.min : v > lim.max ? lim.max : v;
    return Math.round(clamped / lim.step) * lim.step;
  };
  return {
    enabled: s.enabled === true,
    ratio: snap(s.ratio, DECIMATE_LIMITS.ratio, RATIO_DEFAULT),
    error: snap(s.error, DECIMATE_LIMITS.error, ERROR_DEFAULT),
    lockBorder: s.lockBorder !== false,
  };
}

function validDecimateValue(key: DecimateKey, value: unknown): string | number | boolean | undefined {
  if (key === 'enabled' || key === 'lockBorder') return typeof value === 'boolean' ? value : undefined;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function readDecimateOverrides(raw: RawSettings, o: Orientation): Partial<DecimateSettings> {
  const group = raw[DECIMATE_GROUP];
  if (!isPlainObject(group)) return {};
  const src = group[o];
  if (!isPlainObject(src)) return {};
  const out: Partial<DecimateSettings> = {};
  for (const k of DECIMATE_KEYS) {
    const v = validDecimateValue(k, src[k]);
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** 写入两个方向（与 convert/preview 同理：这些值没有方向语义）。 */
export function writeDecimateOverride(raw: RawSettings, key: DecimateKey, value: unknown): void {
  if (!isPlainObject(raw[DECIMATE_GROUP])) raw[DECIMATE_GROUP] = {};
  const group = raw[DECIMATE_GROUP] as Record<string, unknown>;
  for (const o of ORIENTATIONS) {
    if (!isPlainObject(group[o])) group[o] = {};
    (group[o] as Record<string, unknown>)[key] = value;
  }
}

export function clearDecimateGroup(raw: RawSettings): void {
  delete raw[DECIMATE_GROUP];
}

/** 默认值 ⊕ 稀疏覆盖 ⊕ 钳制。 */
export function effectiveDecimate(raw: RawSettings, o: Orientation): DecimateSettings {
  return clampDecimate({ ...decimateDefaults(), ...readDecimateOverrides(raw, o) });
}

export function hasDecimateOverrides(raw: RawSettings): boolean {
  return ORIENTATIONS.some((o) => Object.keys(readDecimateOverrides(raw, o)).length > 0);
}

// ---------------------------------------------------------------------------
// texture group —— 压缩贴图
// ---------------------------------------------------------------------------
// 体积的真正开关：几何通常只有几 MB，8K 的 PNG 一张就 30–50MB。
export interface TexturePackSettings {
  enabled: boolean;
  /** 最长边上限（0 = 原样，不缩放）。 */
  maxSize: number;
  /** 不透明贴图转 JPEG（带 alpha / 法线贴图始终 PNG）。 */
  jpeg: boolean;
}

export const TEXTURE_GROUP = 'texture';
export const TEXTURE_KEYS = ['enabled', 'maxSize', 'jpeg'] as const;
export type TextureKey = (typeof TEXTURE_KEYS)[number];

/** 「最大边长」只接受预设值（0/512/1024/2048/4096），其它数值吸附到最近的合法值。 */
export function clampPackSize(v: number): number {
  if (!Number.isFinite(v)) return PACK_SIZE_DEFAULT;
  let best: number = PACK_SIZE_OPTIONS[0];
  for (const option of PACK_SIZE_OPTIONS) {
    if (Math.abs(option - v) < Math.abs(best - v)) best = option;
  }
  return best;
}

/** 出厂默认：**关闭**——压贴图是有损的。 */
export function textureDefaults(): TexturePackSettings {
  return { enabled: false, maxSize: PACK_SIZE_DEFAULT, jpeg: PACK_JPEG_DEFAULT };
}

export function clampTexture(s: TexturePackSettings): TexturePackSettings {
  return {
    enabled: s.enabled === true,
    maxSize: clampPackSize(s.maxSize),
    jpeg: s.jpeg !== false,
  };
}

function validTextureValue(key: TextureKey, value: unknown): string | number | boolean | undefined {
  if (key === 'maxSize') return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  return typeof value === 'boolean' ? value : undefined;
}

export function readTextureOverrides(raw: RawSettings, o: Orientation): Partial<TexturePackSettings> {
  const group = raw[TEXTURE_GROUP];
  if (!isPlainObject(group)) return {};
  const src = group[o];
  if (!isPlainObject(src)) return {};
  const out: Partial<TexturePackSettings> = {};
  for (const k of TEXTURE_KEYS) {
    const v = validTextureValue(k, src[k]);
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

export function writeTextureOverride(raw: RawSettings, key: TextureKey, value: unknown): void {
  if (!isPlainObject(raw[TEXTURE_GROUP])) raw[TEXTURE_GROUP] = {};
  const group = raw[TEXTURE_GROUP] as Record<string, unknown>;
  for (const o of ORIENTATIONS) {
    if (!isPlainObject(group[o])) group[o] = {};
    (group[o] as Record<string, unknown>)[key] = value;
  }
}

export function clearTextureGroup(raw: RawSettings): void {
  delete raw[TEXTURE_GROUP];
}

export function effectiveTexture(raw: RawSettings, o: Orientation): TexturePackSettings {
  return clampTexture({ ...textureDefaults(), ...readTextureOverrides(raw, o) });
}

export function hasTextureOverrides(raw: RawSettings): boolean {
  return ORIENTATIONS.some((o) => Object.keys(readTextureOverrides(raw, o)).length > 0);
}

// ---------------------------------------------------------------------------
// preview group
// ---------------------------------------------------------------------------

export interface PreviewSettings {
  /** Show the ground grid. */
  grid: boolean;
  /** Show the skeleton (three's SkeletonHelper). */
  bones: boolean;
  /** Playback rate of the previewed clip. */
  speed: number;
}

export const PREVIEW_GROUP = 'preview';
export const PREVIEW_KEYS = ['grid', 'bones', 'speed'] as const;
export type PreviewKey = (typeof PREVIEW_KEYS)[number];

export const SPEED_MIN = 0.1;
export const SPEED_MAX = 2;
export const SPEED_STEP = 0.1;
export const SPEED_DEFAULT = 1;

/** Same defaults as the shooter's sliders: the shipped look, nothing pre-toggled off. */
export function previewDefaults(): PreviewSettings {
  return { grid: true, bones: false, speed: SPEED_DEFAULT };
}

/** Clamp + snap a playback speed onto the slider's step grid. */
export function clampSpeed(v: number): number {
  if (!Number.isFinite(v)) return SPEED_DEFAULT;
  const clamped = v < SPEED_MIN ? SPEED_MIN : v > SPEED_MAX ? SPEED_MAX : v;
  return Math.round(clamped / SPEED_STEP) * SPEED_STEP;
}

function validPreviewValue(key: PreviewKey, value: unknown): string | number | boolean | undefined {
  if (key === 'speed') return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  return typeof value === 'boolean' ? value : undefined;
}

export function readPreviewOverrides(raw: RawSettings, o: Orientation): Partial<PreviewSettings> {
  const group = raw[PREVIEW_GROUP];
  if (!isPlainObject(group)) return {};
  const src = group[o];
  if (!isPlainObject(src)) return {};
  const out: Partial<PreviewSettings> = {};
  for (const k of PREVIEW_KEYS) {
    const v = validPreviewValue(k, src[k]);
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** Set one preview override in BOTH orientations (same reasoning as writeConvertOverride). */
export function writePreviewOverride(raw: RawSettings, key: PreviewKey, value: unknown): void {
  if (!isPlainObject(raw[PREVIEW_GROUP])) raw[PREVIEW_GROUP] = {};
  const group = raw[PREVIEW_GROUP] as Record<string, unknown>;
  for (const o of ORIENTATIONS) {
    if (!isPlainObject(group[o])) group[o] = {};
    (group[o] as Record<string, unknown>)[key] = value;
  }
}

export function clearPreviewGroup(raw: RawSettings): void {
  delete raw[PREVIEW_GROUP];
}

/** Defaults merged with the sparse overrides, then clamped (speed snapped to the step grid). */
export function effectivePreview(raw: RawSettings, o: Orientation): PreviewSettings {
  const merged = { ...previewDefaults(), ...readPreviewOverrides(raw, o) };
  return { grid: merged.grid, bones: merged.bones, speed: clampSpeed(merged.speed) };
}

export function hasPreviewOverrides(raw: RawSettings): boolean {
  return ORIENTATIONS.some((o) => Object.keys(readPreviewOverrides(raw, o)).length > 0);
}
