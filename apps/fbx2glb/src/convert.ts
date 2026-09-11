/**
 * The two halves of the pipeline that touch three's loaders/exporters, plus the small amount of GLB
 * container math the export scale needs. Everything here is a thin, honest wrapper — the decisions
 * (naming, merging, scaling) live in the pure modules, and this file only does the I/O around them.
 *
 * BROWSER-ONLY by nature, but it also runs in Node (scripts/verify-fbx2glb.mjs drives it through the
 * real sample.fbx) as long as `FileReader` exists — GLTFExporter's binary path uses it. The app itself
 * runs in a real browser, so textures, canvas and FileReader all exist there; that is the whole reason
 * the converter is a web app instead of a CLI: FBXLoader needs `document`/`window.URL` for embedded
 * textures, and GLTFExporter needs a canvas to re-encode images.
 */
import type { LoadedFbx } from './merge.js';
import {
  applyTextureFallback, buildTextureIndex, createTextureSession, emptyTextureReport,
  finishTextureReport,
  type TextureIndex, type TextureReport,
} from './textures.js';

export interface ExportOptions {
  format: 'glb' | 'gltf';
  /** Clips to write into the file (empty array = static model). */
  animations: readonly any[];
  /** Uniform scale applied on export (see units.ts). 1 = untouched. */
  scale: number;
}

export interface ExportResult {
  blob: Blob;
  bytes: number;
  /** `model/gltf-binary` or `model/gltf+json`. */
  mime: string;
}

/** A parsed FBX plus everything we learned about its textures. */
export interface ParsedFbx extends LoadedFbx {
  textures: TextureReport;
  /** Present only when texture files were supplied; owns the blob: URLs (`dispose()` to revoke). */
  textureIndex: TextureIndex | null;
}

export interface ParseOptions {
  /** Image files the user supplied next to the FBX (matched by file name). */
  textures?: readonly { name: string; blob: Blob }[];
  /** How to turn a Blob into an image; overridable so the whole path runs headless in Node. */
  loadImage?: (blob: Blob) => Promise<any>;
  /** How long to wait for the loader's texture requests before giving up (see textures.ts). */
  textureTimeoutMs?: number;
}

export interface SelfCheck {
  /** Clips found in the written file, by name. */
  clipNames: string[];
  /** Bones in the written file. */
  bones: number;
  /** Height in metres as written (after the export scale). */
  height: number;
  meshes: number;
  skinned: number;
}

export interface GlbChunks {
  json: any;
  /** The BIN chunk, or null for a JSON-only GLB (legal, though our exporter never writes one). */
  bin: Uint8Array | null;
}

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

/** Parse a GLB into its JSON + BIN chunks. Bounds-checked: a truncated file throws, it does not lie. */
export function readGlb(buffer: ArrayBuffer): GlbChunks {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  if (buffer.byteLength < 12 || view.getUint32(0, true) !== GLB_MAGIC) throw new Error('不是 GLB 文件');
  const total = view.getUint32(8, true);
  if (total > buffer.byteLength) throw new Error('GLB 头声明的长度超过了文件本身');
  let offset = 12;
  let json: any = null;
  let bin: Uint8Array | null = null;
  while (offset + 8 <= total) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(body));
    else if (type === CHUNK_BIN) bin = body;
    offset += 8 + length;
  }
  if (!json) throw new Error('GLB 里没有 JSON chunk');
  return { json, bin };
}

/** Serialize JSON + BIN back into a GLB (4-byte aligned chunks: JSON padded with spaces, BIN with 0). */
export function writeGlb(json: any, bin: Uint8Array | null): ArrayBuffer {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const binPad = bin ? (4 - (bin.length % 4)) % 4 : 0;
  const total = 12 + 8 + jsonBytes.length + jsonPad + (bin ? 8 + bin.length + binPad : 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  let offset = 12;
  view.setUint32(offset, jsonBytes.length + jsonPad, true);
  view.setUint32(offset + 4, CHUNK_JSON, true);
  out.set(jsonBytes, offset + 8);
  out.fill(0x20, offset + 8 + jsonBytes.length, offset + 8 + jsonBytes.length + jsonPad);
  offset += 8 + jsonBytes.length + jsonPad;
  if (bin) {
    view.setUint32(offset, bin.length + binPad, true);
    view.setUint32(offset + 4, CHUNK_BIN, true);
    out.set(bin, offset + 8);
    offset += 8 + bin.length + binPad;
  }
  return out.buffer as ArrayBuffer;
}

/**
 * Apply a uniform export scale by wrapping the scene's ROOT NODE in a new parent node.
 *
 * ⚠️ WHY THIS IS DONE IN THE JSON AND NOT BY SCALING A `Group` AROUND THE SCENE — a real bug found by
 * scripts/verify-fbx2glb.mjs: the exporter writes `boneInverses[i] × bindMatrix` as the glTF inverse
 * bind matrices while the vertex data and the bone hierarchy keep their original numbers. A scale
 * added as a real parent node therefore lands in TWO places at once — the skin math (which sees the
 * scaled bone world matrices) and the node transform — and a 1.6-unit model came out 0.00016 instead
 * of 0.016, i.e. scaled twice. Wrapping the FINISHED glTF is exact by construction: a uniform scale
 * above the whole graph multiplies every skinned vertex exactly once, because the joint matrices and
 * the bind matrices live in the same space. It also keeps the exporter's inputs untouched, so nothing
 * about the skin can depend on whether a scale was requested.
 */
export function wrapSceneRoot(json: any, scale: number): void {
  if (!Number.isFinite(scale) || scale === 1) return;
  const scenes = json?.scenes;
  if (!Array.isArray(scenes) || scenes.length === 0) return;
  const scene = scenes[json.scene ?? 0] ?? scenes[0];
  if (!scene) return;
  if (!Array.isArray(json.nodes)) json.nodes = [];
  json.nodes.push({
    name: 'scale' + scale,
    scale: [scale, scale, scale],
    children: Array.isArray(scene.nodes) ? scene.nodes : [],
  });
  scene.nodes = [json.nodes.length - 1];
}

/** The same operation on a finished GLB (parse → wrap → re-serialize). */
export function scaleGlb(buffer: ArrayBuffer, scale: number): ArrayBuffer {
  if (!Number.isFinite(scale) || scale === 1) return buffer;
  const { json, bin } = readGlb(buffer);
  wrapSceneRoot(json, scale);
  return writeGlb(json, bin);
}

/**
 * Turn a Blob into something three can use as a texture image. A plain `HTMLImageElement` on purpose
 * (not `createImageBitmap`): it is what three's own `ImageLoader` produces, so the fallback route and
 * the loader route end up with the same kind of object — including `flipY`, which an ImageBitmap
 * cannot honour.
 */
export async function imageFromBlob(blob: Blob): Promise<any> {
  if (typeof Image === 'undefined' || typeof document === 'undefined') {
    throw new Error('这个环境没有 Image/HTMLImageElement，无法解码贴图');
  }
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('贴图解码失败'));
      img.src = url;
    });
  } finally {
    // The decoded image stays valid after the URL is revoked; uploading it does not re-fetch.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

/**
 * 输入格式探测。目的很具体：只丢一个"其实不是 FBX"的文件进来时，`FBXLoader` 只会说
 * 「Cannot find the version number for the file given.」——那句话对用户毫无信息量。
 * 探测本身是纯字节/字符串判断，可以断言。
 */
export function sniffFormat(buffer: ArrayBuffer): 'glb' | 'gltf' | 'fbx-binary' | 'fbx-ascii' | 'unknown' {
  const bytes = new Uint8Array(buffer);
  if (new TextDecoder().decode(bytes.subarray(0, 4)) === 'glTF') return 'glb';
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 64)));
  if (head.startsWith('Kaydara FBX Binary')) return 'fbx-binary';
  const text = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 4096)));
  if (/^\s*\{/.test(text) && text.includes('"asset"')) return 'gltf';
  if (text.includes('FBXHeaderExtension') || text.startsWith('; FBX')) return 'fbx-ascii';
  return 'unknown';
}

/**
 * Parse one FBX buffer into a scene + clips, and resolve its textures.
 *
 * `path` is left empty: an EXTERNAL texture reference has no directory to resolve against, which is
 * what the texture index is for (textures.ts). A `LoadingManager` therefore always goes in, even with
 * no files supplied, because the set of names the loader asks for IS the report the user needs
 * (「缺 sample_body_diffuse.png」).
 */
export async function parseFbx(buffer: ArrayBuffer, file: string, opts: ParseOptions = {}): Promise<ParsedFbx> {
  const format = sniffFormat(buffer);
  if (format === 'glb' || format === 'gltf') {
    throw new Error(file + ' 是 glTF/GLB 文件，不是 FBX —— 本应用目前只接受 FBX（.glb 输入还没做）');
  }
  if (format === 'unknown') {
    throw new Error(file + ' 既不是 FBX 也不是 glTF（无法识别的格式）');
  }
  // @ts-ignore - vendored three addon, untyped (same escape hatch as apps/shooter/src/assets.ts)
  const { FBXLoader } = await import('../vendor/addons/loaders/FBXLoader.js');
  const index = opts.textures && opts.textures.length > 0 ? buildTextureIndex(opts.textures) : null;
  const report = emptyTextureReport();
  // The session (and therefore its `onLoad` hook) exists BEFORE the parse: the loader starts its
  // texture requests synchronously inside `parse()`.
  const session = createTextureSession(index ?? buildTextureIndex([]), report);
  const loader = new FBXLoader(session.manager);
  const root = loader.parse(buffer, '');
  const clips = Array.isArray(root?.animations) ? root.animations : [];
  const settle = await session.done(opts.textureTimeoutMs);
  report.timedOut = settle.timedOut;
  if (index) await applyTextureFallback(root, index, report, opts.loadImage ?? imageFromBlob);
  finishTextureReport(root, index ?? buildTextureIndex([]), report);
  return { file, root, clips, textures: report, textureIndex: index };
}

/** Read a picked/dropped File and parse it. */
export async function loadFbxFile(file: File, opts: ParseOptions = {}): Promise<ParsedFbx> {
  const buffer = await file.arrayBuffer();
  return parseFbx(buffer, file.name, opts);
}

/** Export a scene to a Blob. The scale is applied to the FINISHED file (see wrapSceneRoot). */
export async function exportScene(root: any, opts: ExportOptions): Promise<ExportResult> {
  // @ts-ignore - vendored three addon, untyped
  const { GLTFExporter } = await import('../vendor/addons/exporters/GLTFExporter.js');
  const binary = opts.format !== 'gltf';
  const result: any = await new Promise((resolve, reject) => {
    new GLTFExporter().parse(root, resolve, reject, {
      binary,
      animations: [...opts.animations],
      onlyVisible: false,
    });
  });
  if (binary) {
    const raw: ArrayBuffer = result instanceof Blob ? await result.arrayBuffer() : result;
    const bytes = scaleGlb(raw, opts.scale);
    const blob = new Blob([bytes], { type: 'model/gltf-binary' });
    return { blob, bytes: blob.size, mime: 'model/gltf-binary' };
  }
  // The JSON path embeds the buffer as a base64 data URI, so the .gltf stays a single file.
  const json = result;
  wrapSceneRoot(json, opts.scale);
  const blob = new Blob([JSON.stringify(json)], { type: 'model/gltf+json' });
  return { blob, bytes: blob.size, mime: 'model/gltf+json' };
}

/**
 * Read the file we just wrote back with three's GLTFLoader and report what is inside it. This is the
 * app's self-check: the exported GLB is a binary blob, and the only trustworthy statement about it is
 * "a fresh loader parsed it and found these clips/joints". Failures are returned, not thrown.
 */
export async function selfCheck(buffer: ArrayBuffer): Promise<SelfCheck | { error: string }> {
  try {
    // @ts-ignore - vendored three addon, untyped
    const { GLTFLoader } = await import('../vendor/addons/loaders/GLTFLoader.js');
    const loader = new GLTFLoader();
    const gltf: any = await new Promise((resolve, reject) => {
      loader.parse(buffer, '', resolve, reject);
    });
    const scene = gltf.scene;
    let meshes = 0, skinned = 0, bones = 0;
    scene?.traverse?.((o: any) => {
      if (o.isBone) bones++;
      if (o.isMesh) meshes++;
      if (o.isSkinnedMesh) skinned++;
    });
    const { measureSize } = await import('./analyze.js');
    return {
      clipNames: (gltf.animations ?? []).map((c: any) => String(c.name)),
      bones, meshes, skinned,
      height: measureSize(scene).y,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Trigger a browser download for a produced Blob (no server round trip: the bytes stay local). */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick: Safari needs the URL to survive the click.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
