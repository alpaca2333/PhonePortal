/**
 * Assembly layer: owns the DOM list state and drives the pipeline, and is the only module that knows
 * about both the pure rules and the browser APIs. Following the portal's convention, the settings
 * panel owns persistence and hands EFFECTIVE values back here; nothing else reaches for the server.
 *
 * THE PIPELINE, once, for the record:
 *   File → ArrayBuffer → FBXLoader.parse → { root, clips }
 *        → textures.ts resolves the FBX's external texture references against the image files the
 *          user supplied (blob: URLs through the loader's own resolveURL hook),
 *        → describeScene (report + height)
 *        → mergeScenes (pick the character, attach & rename the other files' clips)
 *        → resolveScale (units.ts) → GLTFExporter.parse → Blob
 *        → GLTFLoader.parse (self-check: what did we actually write?)
 *        → download link. No byte of the CONVERSION leaves the device: that path performs zero network
 *          requests (asserted). 「发布」 is the one explicit exception — it PUTs the finished Blob to the
 *          portal's own /api/assets/<app>/<name>, which stores it under data/assets/ for a game to load.
 */
import { parseFbx, loadFbxFile, exportScene, selfCheck, downloadBlob, glbImageBytes,
  type ParsedFbx, type SelfCheck } from './src/convert.js';
import { describeScene, type SceneReport } from './src/analyze.js';
import { mergeScenes, nameClipsForFile, renameClips, type LoadedFbx } from './src/merge.js';
import { formatBytes, outputFileName } from './src/names.js';
import { resolveScale, scaleLabel, type ScaleDecision } from './src/units.js';
import { createPanel, type PanelHandle } from './src/panel.js';
import { createPreview, type PreviewHandle } from './src/preview.js';
import type {
  ConvertSettings, DecimateSettings, PreviewSettings, PublishSettings, TexturePackSettings,
} from './src/settings.js';
import {
  decimateForExport, decimateSummaryText, type DecimateReport,
} from './src/decimate.js';
import { packTextures, packSummaryText, type PackReport } from './src/texturepack.js';
import {
  IMAGE_EXTENSIONS, externalCounts, isImageFileName, providedFileNames, reportNeedsTextures,
  textureSummaryText, type TextureReport,
} from './src/textures.js';
import {
  assetUrl, blockedReason, extensionOf, formatAssetTime, listPublished, loadPublishTargets,
  publishAsset, publishNameFor, publishResultText, publishedSummary, removePublished, resolveTarget,
  type PublishFile, type PublishTarget,
} from './src/publish.js';

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// ---- DOM -------------------------------------------------------------------------------------
const dropzone = byId<HTMLLabelElement>('dropzone');
const fileInput = byId<HTMLInputElement>('fileInput');
const sampleBtn = byId<HTMLButtonElement>('sampleBtn');
const clearBtn = byId<HTMLButtonElement>('clearBtn');
const fileListEl = byId<HTMLUListElement>('fileList');
const fileCountEl = byId<HTMLElement>('fileCount');
const convertBtn = byId<HTMLButtonElement>('convertBtn');
const logEl = byId<HTMLElement>('log');
const resultsEl = byId<HTMLUListElement>('results');
const resultCountEl = byId<HTMLElement>('resultCount');
const previewCanvas = byId<HTMLCanvasElement>('previewCanvas');
const previewFallback = byId<HTMLElement>('previewFallback');
const clipSelect = byId<HTMLSelectElement>('clipSelect');
const playBtn = byId<HTMLButtonElement>('playBtn');
const textureInput = byId<HTMLInputElement>('textureInput');
const texDropzone = byId<HTMLLabelElement>('texDropzone');
const textureListEl = byId<HTMLUListElement>('textureList');
const textureCountEl = byId<HTMLElement>('textureCount');
const sampleTexBtn = byId<HTMLButtonElement>('sampleTexBtn');
const pubTarget = byId<HTMLSelectElement>('pubTarget');
const pubName = byId<HTMLInputElement>('pubName');
const pubRefresh = byId<HTMLButtonElement>('pubRefresh');
const pubState = byId<HTMLElement>('pubState');
const pubList = byId<HTMLUListElement>('pubList');

// ---- log -------------------------------------------------------------------------------------
const MAX_LOG_LINES = 200;
function log(text: string, level: 'info' | 'warn' | 'error' | 'ok' = 'info'): void {
  const line = document.createElement('div');
  line.className = 'log-line ' + level;
  line.textContent = text;
  logEl.appendChild(line);
  while (logEl.childElementCount > MAX_LOG_LINES) logEl.removeChild(logEl.firstElementChild!);
  logEl.scrollTop = logEl.scrollHeight;
}

// ---- model list ------------------------------------------------------------------------------
interface Item {
  id: number;
  file: File;
  size: number;
  state: 'queued' | 'parsing' | 'ready' | 'error';
  loaded?: LoadedFbx;
  report?: SceneReport;
  /** What happened to this file's textures (see textures.ts) — drives the row + the log. */
  textures?: TextureReport;
  error?: string;
}

const items: Item[] = [];
let nextId = 1;
let busy = false;

function renderList(): void {
  fileListEl.textContent = '';
  const ready = items.filter((i) => i.state === 'ready').length;
  fileCountEl.textContent = items.length === 0
    ? '还没有文件'
    : `${items.length} 个文件 · ${ready} 个已解析`;
  for (const item of items) {
    const li = document.createElement('li');
    li.className = 'file-row ' + item.state;

    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = item.file.name;
    li.appendChild(name);

    const meta = document.createElement('span');
    meta.className = 'file-meta';
    if (item.state === 'parsing') meta.textContent = '解析中…';
    else if (item.state === 'error') meta.textContent = '解析失败：' + (item.error ?? '');
    else if (item.state === 'queued') meta.textContent = formatBytes(item.size) + ' · 排队中';
    else if (item.report) {
      const r = item.report;
      const tex = item.textures ? textureSummaryText(item.textures) : '';
      meta.textContent = [
        formatBytes(item.size),
        `${r.meshes} 网格${r.skinned ? `（${r.skinned} 蒙皮）` : ''}`,
        `${r.bones} 骨骼`,
        `${r.clips.length} 动作`,
        `高 ${r.size.y.toFixed(3)}`,
        tex,
      ].filter((x) => x !== '').join(' · ');
    }
    li.appendChild(meta);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'ghost small';
    remove.textContent = '✕';
    remove.title = '移除';
    remove.addEventListener('click', () => {
      const i = items.indexOf(item);
      if (i >= 0) items.splice(i, 1);
      renderList();
      updateConvertState();
    });
    li.appendChild(remove);
    fileListEl.appendChild(li);
  }
  updateConvertState();
}

function updateConvertState(): void {
  const ready = items.filter((i) => i.state === 'ready');
  convertBtn.disabled = busy || ready.length === 0;
  clearBtn.disabled = busy || items.length === 0;
  // `lastConvert` (not panel.convert()) because the panel calls back INTO this function while it is
  // still being constructed — reading the panel there would be a temporal-dead-zone error.
  const format = (lastConvert?.format ?? 'glb').toUpperCase();
  const merge = lastConvert?.merge ?? true;
  convertBtn.textContent = busy ? '转换中…'
    : ready.length > 1 && merge ? `合并并转换（${ready.length} 个）`
    : '转换为 ' + format;
}

/**
 * The image files the user supplied next to the FBX. Session state on purpose: a picked File cannot be
 * persisted (no file handles survive a reload), and the FBX list is session state for the same reason.
 */
const textureFiles: { name: string; blob: Blob; size: number }[] = [];

/** One texture's fate, in the log — so a wrong match is visible immediately, not after a download. */
function logTextureReport(name: string, report: TextureReport): void {
  const { external, filled } = externalCounts(report);
  if (external === 0 && report.withImage === 0) return;
  if (external === 0) {
    log(`${name}：贴图 ${report.withImage} 张（已嵌在 FBX 里或由 loader 直接解析）`);
  } else {
    for (const req of report.requested) {
      if (req.provided) {
        log(`${name}：贴图 ${req.wanted} ← 你提供的 ${req.provided}` +
          `${req.rule === 'stem' ? '（文件名不完全一致，按主干名匹配）' : ''}`, 'ok');
      } else {
        log(`${name}：贴图 ${req.wanted} 没有提供，产物里这个贴图槽会空着`, 'warn');
      }
    }
    void filled;
  }
  for (const p of report.placeholders) {
    log(`${name}：${p.material}.${p.slot} 是 three 不支持的贴图格式（.tga/.psd/.dds 占位），` +
      `提供同名的 .png/.jpg 可以补上`, 'warn');
  }
  if (report.fallback.length > 0) {
    log(`${name}：按名字回填了 ${report.fallback.length} 个占位贴图槽` +
      `（${report.fallback.map((f) => `${f.material}.${f.slot} ← ${f.from}`).join('、')}）`, 'ok');
  }
  if (report.timedOut) log(`${name}：等待贴图加载超时，未完成的贴图槽会保持为空`, 'warn');
  if (report.unused.length > 0) {
    log(`${name}：有 ${report.unused.length} 个贴图文件没被这个 FBX 引用（${report.unused.join('、')}）`, 'warn');
  }
}

/** Parse (or re-parse) one list entry. Parsing happens on ADD, so the report is ready before convert. */
async function parseInto(item: Item): Promise<void> {
  item.state = 'parsing';
  item.error = undefined;
  renderList();
  const previous = item.loaded as ParsedFbx | undefined;
  try {
    const loaded = await loadFbxFile(item.file, { textures: textureFiles });
    // A re-parse (textures changed) leaves the previous index's blob: URLs behind; release them.
    // Safe even while the old images are on screen: a decoded image does not need its URL any more.
    previous?.textureIndex?.dispose();
    item.loaded = loaded;
    item.textures = loaded.textures;
    item.report = describeScene(loaded.root, loaded.clips);
    item.state = 'ready';
    const r = item.report;
    log(`解析完成：${r.meshes} 个网格、${r.bones} 根骨骼、${r.clips.length} 个动作片段、` +
      `包围盒 ${r.size.x.toFixed(2)}×${r.size.y.toFixed(2)}×${r.size.z.toFixed(2)}`, 'ok');
    if (r.clips.length === 0) log('这个文件里没有动画（只会导出模型）', 'warn');
    logTextureReport(item.file.name, loaded.textures);
    if (!previewSource || previewSource.file === item.file.name) {
      previewSource = loaded;
      setPreview(loaded.root, loaded.clips);
    }
  } catch (err) {
    item.state = 'error';
    item.error = err instanceof Error ? err.message : String(err);
    log(`解析失败 ${item.file.name}：${item.error}`, 'error');
  }
  renderList();
  // The texture rows say whether each supplied file was actually used, which is only known AFTER a
  // parse — so they have to be re-rendered here, not just when the texture list changes.
  renderTextures();
}

async function addFile(file: File): Promise<void> {
  const item: Item = { id: nextId++, file, size: file.size, state: 'queued' };
  items.push(item);
  renderList();
  log(`读取 ${file.name}（${formatBytes(file.size)}）…`);
  await parseInto(item);
}

// ---- preview ---------------------------------------------------------------------------------
// WebGL is the app's only hard platform dependency: `createPreview` returns null without it, and the
// canvas is replaced by an explanation instead of a black rectangle.
let preview: PreviewHandle | null = null;
let previewSource: LoadedFbx | null = null;
try {
  preview = createPreview(previewCanvas, { onError: (m) => log('WebGL 不可用：' + m, 'warn') });
} catch (err) {
  log('预览初始化失败：' + (err instanceof Error ? err.message : String(err)), 'warn');
}
if (!preview) {
  previewFallback.hidden = false;
  previewCanvas.hidden = true;
  playBtn.disabled = true;
  clipSelect.disabled = true;
}

function renderClips(): void {
  const names = preview ? preview.clipNames() : [];
  clipSelect.textContent = '';
  if (names.length === 0) {
    const o = document.createElement('option');
    o.textContent = '（没有动作）';
    o.value = '';
    clipSelect.appendChild(o);
    clipSelect.disabled = true;
    return;
  }
  for (const n of names) {
    const o = document.createElement('option');
    o.value = n;
    o.textContent = n;
    clipSelect.appendChild(o);
  }
  clipSelect.disabled = false;
  clipSelect.value = preview?.currentClip() ?? names[0]!;
}

function setPreview(root: any, clips: readonly any[]): void {
  if (!preview) return;
  preview.setScene(root, clips);
  renderClips();
  playBtn.textContent = preview.isPlaying() ? '暂停' : '播放';
}

clipSelect.addEventListener('change', () => preview?.play(clipSelect.value));
playBtn.addEventListener('click', () => {
  if (!preview) return;
  preview.setPlaying(!preview.isPlaying());
  playBtn.textContent = preview.isPlaying() ? '暂停' : '播放';
});

// ---- settings panel --------------------------------------------------------------------------
let lastConvert: ConvertSettings | null = null;
let lastDecimate: DecimateSettings | null = null;
let lastTexture: TexturePackSettings | null = null;
let lastPublish: PublishSettings | null = null;
// Publish session state. Declared HERE (not next to the functions that use it) for the same reason
// `lastConvert` is: createPanel() below calls onPublishChange synchronously while it is still being
// constructed, so anything that callback touches must already be initialised — otherwise the module
// dies with "Cannot access 'x' before initialization" before the page can render a single control.
// (The DOM shim flow test in scripts/verify-fbx2glb.mjs caught exactly that on the first run.)
let publishTargets: PublishTarget[] = [];
let publishFiles: PublishFile[] = [];
let publishing = false;
/** Set while refreshTargets re-applies the stored target onto a fresh <option> list, so the panel's
 *  callback does not kick off a second, overlapping list request. */
let suppressPublishCallback = false;
// Also declared up here (same reason): the publish callback renders the product rows, and that reads
// the product list — which used to be declared further down, in the conversion section.
const outputs: Output[] = [];
const usedOutputNames = new Set<string>();
const panel: PanelHandle = createPanel({
  els: {
    format: byId<HTMLSelectElement>('optFormat'),
    merge: byId<HTMLInputElement>('optMerge'),
    animations: byId<HTMLInputElement>('optAnim'),
    scale: byId<HTMLSelectElement>('optScale'),
    naming: byId<HTMLSelectElement>('optNaming'),
    convertReset: byId<HTMLButtonElement>('convertReset'),
    decimate: byId<HTMLInputElement>('optDecimate'),
    decimateRatio: byId<HTMLInputElement>('optDecimateRatio'),
    decimateRatioOut: byId<HTMLElement>('optDecimateRatioOut'),
    decimateError: byId<HTMLInputElement>('optDecimateError'),
    decimateErrorOut: byId<HTMLElement>('optDecimateErrorOut'),
    decimateLock: byId<HTMLInputElement>('optDecimateLock'),
    decimateReset: byId<HTMLButtonElement>('decimateReset'),
    pack: byId<HTMLInputElement>('optPack'),
    packSize: byId<HTMLSelectElement>('optPackSize'),
    packJpeg: byId<HTMLInputElement>('optPackJpeg'),
    packReset: byId<HTMLButtonElement>('packReset'),
    publishTarget: pubTarget,
    publishReset: byId<HTMLButtonElement>('publishReset'),
    grid: byId<HTMLInputElement>('optGrid'),
    bones: byId<HTMLInputElement>('optBones'),
    speed: byId<HTMLInputElement>('optSpeed'),
    speedOut: byId<HTMLElement>('optSpeedOut'),
    previewReset: byId<HTMLButtonElement>('previewReset'),
    status: byId<HTMLElement>('saveState'),
  },
  onConvertChange: (s) => {
    lastConvert = s;
    updateConvertState();
  },
  onPreviewChange: (s: PreviewSettings) => {
    preview?.setGrid(s.grid);
    preview?.setBones(s.bones);
    preview?.setSpeed(s.speed);
  },
  // 减面只在导出时发生（而且是在克隆体上），所以这里不需要往任何模块转发，只记下当前值供按钮文案/
  // 转换流程读取。拖动滑杆时的实时回调走的是同一个入口。
  onDecimateChange: (s: DecimateSettings) => { lastDecimate = s; updateConvertState(); },
  // 贴图压缩同样只在导出时发生（在克隆体上），这里只记下当前值。
  onTextureChange: (s: TexturePackSettings) => { lastTexture = s; },
  // 发布目标只影响界面（按钮文案、已发布列表、目标目录），不参与转换 —— 记下来并刷新界面。
  onPublishChange: (s: PublishSettings) => { lastPublish = s; onPublishTargetChanged(); },
});

// ---- conversion ------------------------------------------------------------------------------
interface Output {
  name: string;
  blob: Blob;
  clips: string[];
  scale: ScaleDecision;
  report: SceneReport;
  /** 这次导出的减面结果（功能关闭时 applied = 0）。 */
  decimate: DecimateReport;
  /** 这次导出的贴图压缩结果。 */
  pack: PackReport;
  warnings: string[];
  check: SelfCheck | { error: string };
  from: string;
}

function uniqueFileName(base: string, ext: string, suffix = ''): string {
  const first = outputFileName(base, ext, suffix);
  if (!usedOutputNames.has(first)) { usedOutputNames.add(first); return first; }
  let n = 2;
  let name = first;
  while (usedOutputNames.has(name)) {
    name = outputFileName(base, ext, suffix + '-' + n);
    n++;
  }
  usedOutputNames.add(name);
  return name;
}

function renderResults(): void {
  resultsEl.textContent = '';
  resultCountEl.textContent = outputs.length === 0 ? '还没有产物' : `${outputs.length} 个文件`;
  for (const out of outputs) {
    const li = document.createElement('li');
    li.className = 'result-row';

    const head = document.createElement('div');
    head.className = 'result-head';
    const name = document.createElement('span');
    name.className = 'result-name';
    name.textContent = out.name;
    head.appendChild(name);
    const size = document.createElement('span');
    size.className = 'result-size';
    size.textContent = formatBytes(out.blob.size);
    head.appendChild(size);
    li.appendChild(head);

    const detail = document.createElement('div');
    detail.className = 'result-meta';
    const parts = [
      out.clips.length > 0 ? `动作：${out.clips.join('、')}` : '无动作',
      `缩放 ${scaleLabel(out.scale.scale)}${out.scale.autoApplied ? '（自动：判定为厘米）' : ''}`,
      `高 ${(out.report.size.y * out.scale.scale).toFixed(3)}`,
    ];
    detail.textContent = parts.join(' · ');
    li.appendChild(detail);

    const packText = packSummaryText(out.pack);
    if (packText !== '') {
      const line = document.createElement('div');
      line.className = 'result-meta' + (out.pack.packed > 0 ? ' good' : '');
      line.textContent = packText;
      li.appendChild(line);
    }

    const decimateText = decimateSummaryText(out.decimate);
    if (decimateText !== '') {
      const line = document.createElement('div');
      line.className = 'result-meta' + (out.decimate.applied > 0 ? ' good' : '');
      line.textContent = decimateText;
      li.appendChild(line);
    }

    if (out.clips.length > 0) {
      const unbound = out.report.clips.reduce((n, c) => n + c.unbound.length, 0);
      const note = document.createElement('div');
      note.className = 'result-meta ' + (unbound > 0 ? 'bad' : 'good');
      note.textContent = unbound === 0
        ? '✓ 所有动画轨道都能找到对应的节点'
        : `⚠ 有 ${unbound} 条轨道找不到节点，播放时会被忽略`;
      li.appendChild(note);
    }

    const checkLine = document.createElement('div');
    checkLine.className = 'result-meta';
    checkLine.textContent = 'error' in out.check
      ? '自检失败：' + out.check.error
      : `自检通过：重新读回得到 ${out.check.meshes} 网格、${out.check.bones} 骨骼、` +
        `动作 ${out.check.clipNames.join('、') || '（无）'}、高 ${out.check.height.toFixed(3)}`;
    li.appendChild(checkLine);

    for (const w of out.warnings) {
      const warn = document.createElement('div');
      warn.className = 'result-meta warn-text';
      warn.textContent = '· ' + w;
      li.appendChild(warn);
    }

    const actions = document.createElement('div');
    actions.className = 'btn-row';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'primary';
    btn.textContent = '下载 ' + out.name;
    btn.addEventListener('click', () => {
      downloadBlob(out.blob, out.name);
      log('已下载 ' + out.name, 'ok');
    });
    actions.appendChild(btn);

    // 一键发布：目标 = 设置里的（默认「自动」= 第一个声明接收资产的子应用）。禁用时把原因写在行里
    // ——手机上 title 提示是看不见的。
    const ext = extensionOf(out.name);
    const target = activeTarget();
    const blocked = blockedReason(target, ext);
    const pubBtn = document.createElement('button');
    pubBtn.type = 'button';
    pubBtn.className = 'primary';
    pubBtn.textContent = target ? '发布到 ' + target.name : '发布到游戏';
    pubBtn.disabled = blocked !== null;
    if (target) {
      pubBtn.title = `写入 data/assets/${target.id}/` +
        `（游戏里按 ${assetUrl(target.id, publishNameFor(out.name, pubName.value, ext))} 读取）`;
    }
    pubBtn.addEventListener('click', () => { void publishOutput(out); });
    actions.appendChild(pubBtn);
    li.appendChild(actions);

    if (blocked !== null) {
      const why = document.createElement('div');
      why.className = 'result-meta warn-text';
      why.textContent = '· 发布不可用：' + blocked;
      li.appendChild(why);
    }
    resultsEl.appendChild(li);
  }
}

/**
 * Export one scene and register the result (including the read-back self-check).
 *
 * 减面发生在这里，而且发生在**克隆体**上：`decimateForExport` 不改动传入的 root，所以预览用的那份
 * 模型（以及重复点「转换」）不会越减越少。返回的 root 会被用于测量与导出。
 */
async function emit(
  from: string, root: any, clips: readonly any[], c: ConvertSettings, warnings: readonly string[] = [],
): Promise<{ decimate: DecimateReport; pack: PackReport; root: any }> {
  const d = lastDecimate ?? { enabled: false, ratio: 0.5, error: 0.01, lockBorder: true };
  const t = lastTexture ?? { enabled: false, maxSize: 2048, jpeg: true };
  const { root: decimatedRoot, report: decimate } = await decimateForExport(root, d);
  if (d.enabled) {
    const text = decimateSummaryText(decimate);
    log(text !== '' ? text : '减面：没有网格被改动', decimate.applied > 0 ? 'ok' : 'warn');
    for (const m of decimate.meshes) {
      if (m.skip === null) {
        log(`  · ${m.name}：${m.before} → ${m.after} 面，顶点 ${m.vertsBefore} → ${m.vertsAfter}，` +
          `${m.ms} ms，误差 ${m.error.toExponential(1)}`);
      } else if (m.skip !== 'tiny' && m.skip !== 'at-target') {
        log(`  · ${m.name}：跳过（${m.skip}）`, 'warn');
      }
    }
  }
  // 贴图压缩在克隆体上就地改 texture（分辨率 + 编码），所以放在减面之后、导出之前。
  const pack = await packTextures(decimatedRoot, t);
  if (t.enabled) {
    const text = packSummaryText(pack);
    log(text !== '' ? text : '贴图压缩：没有可处理的贴图', pack.packed > 0 ? 'ok' : 'warn');
    for (const e of pack.entries) {
      if (e.skip === null) {
        log(`  · ${e.material}.${e.slot}（${e.name}）：${e.beforeW}×${e.beforeH} → ${e.afterW}×${e.afterH}` +
          `，${e.mime.replace('image/', '')}${e.shared ? '（复用已压结果）' : ''}，${e.ms} ms`);
      }
    }
  }
  const exportRoot = decimatedRoot;
  const report = describeScene(exportRoot, clips);
  const decision = resolveScale(c.scaleMode, report.size.y);
  if (decision.autoApplied) {
    log(`测得高度 ${decision.height.toFixed(2)} 个单位 → 判定为厘米，导出时 ×${decision.scale}`, 'info');
  }
  const anim = c.animations ? clips : [];
  const out = await exportScene(exportRoot, { format: c.format, animations: anim, scale: decision.scale });
  const buffer = await out.blob.arrayBuffer();
  // 产物里图片占多少字节（直接数 GLB 的 bufferView，不用再编码一遍）
  pack.imageBytes = c.format === 'glb' ? glbImageBytes(buffer) : null;
  const check = await selfCheck(buffer);
  const name = uniqueFileName(from, c.format);
  outputs.push({
    name, blob: out.blob, clips: c.animations ? report.clips.map((x) => x.name) : [],
    scale: decision, report, decimate, pack, warnings: [...warnings], check, from,
  });
  log(`写出 ${name}（${formatBytes(out.bytes)}）` +
    ('error' in check ? ` · 自检失败：${check.error}` : ` · 自检通过（${check.bones} 骨骼）`),
  'error' in check ? 'warn' : 'ok');
  renderResults();
  return { decimate, pack, root: exportRoot };
}

async function convert(): Promise<void> {
  if (busy) return;
  const c = panel.convert();
  const ready = items.filter((i) => i.state === 'ready' && i.loaded);
  if (ready.length === 0) {
    log('先选择至少一个 .fbx 文件（或点「载入样例」）', 'warn');
    return;
  }
  busy = true;
  updateConvertState();
  outputs.length = 0;
  usedOutputNames.clear();
  renderResults();
  await panel.flush();
  try {
    if (c.merge) {
      // ---- merged: one character + every file's clips -----------------------------------------
      const outcome = mergeScenes(ready.map((i) => i.loaded!), c.clipNaming);
      for (const w of outcome.warnings) log(w, outcome.skipped.length > 0 ? 'warn' : 'info');
      const baseItem = ready[outcome.baseIndex]!;
      log(`合并完成：${outcome.accepted.length} 个文件、${outcome.clips.length} 个动作 ` +
        `（${outcome.clips.map((x) => x.name).join('、') || '无'}）`, 'ok');
      const emitted = await emit(baseItem.file.name, outcome.root, outcome.clips, c, outcome.warnings);
      // Preview what was just exported — renamed clips AND the decimated meshes — so the picture on
      // screen is the file on disk.
      previewSource = { file: baseItem.file.name, root: emitted.root, clips: outcome.clips };
      setPreview(emitted.root, outcome.clips);
    } else {
      // ---- one output per input --------------------------------------------------------------
      for (const item of ready) {
        const loaded = item.loaded!;
        const names = nameClipsForFile(item.file.name, loaded.clips, c.clipNaming);
        const clips = renameClips(loaded.clips, names);
        const emitted = await emit(item.file.name, loaded.root, clips, c);
        if (item === ready[0]) { previewSource = { ...loaded, root: emitted.root }; setPreview(emitted.root, clips); }
        // Yield so the log/result rows paint between files (a phone renders nothing otherwise).
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  } catch (err) {
    log('转换失败：' + (err instanceof Error ? err.message : String(err)), 'error');
  } finally {
    busy = false;
    updateConvertState();
  }
}

// ---- publish (external assets; see src/publish.ts and server/src/assets.ts) -------------------
// The published LIST belongs to the server (refetched, never cached) and the candidate apps belong to
// /api/manifest. The state itself is declared up with the panel's, because the panel calls back INTO
// this module while it is still being constructed (see the note there).
/** The target a publish would go to right now: stored setting if it still exists, else the first. */
function activeTarget(): PublishTarget | null {
  return resolveTarget(lastPublish?.target ?? '', publishTargets);
}

function fillTargetOptions(): void {
  // The <option> list is rebuilt from the manifest on every refresh; the 「自动」 entry always exists so
  // the stored value '' is always selectable (see the panel's note about values with no option).
  pubTarget.textContent = '';
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = publishTargets.length > 1 ? '自动（第一个接收资产的子应用）' : '自动';
  pubTarget.appendChild(auto);
  for (const t of publishTargets) {
    const o = document.createElement('option');
    o.value = t.id;
    o.textContent = `${t.name}（${t.accepts.map((e) => '.' + e).join('/')}）`;
    pubTarget.appendChild(o);
  }
}

function renderPublished(): void {
  pubList.textContent = '';
  const target = activeTarget();
  pubState.textContent = publishedSummary(target, publishFiles);
  if (!target) return;
  for (const file of publishFiles) {
    const li = document.createElement('li');
    // `pub-row` (not `ready`) on purpose: 「ready」 would add the file list's ✓ to the name, which means
    // "parsed" there and nothing at all here.
    li.className = 'file-row pub-row';
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = file.name;
    li.appendChild(name);
    const meta = document.createElement('span');
    meta.className = 'file-meta';
    const when = formatAssetTime(file.mtime);
    meta.textContent = `${formatBytes(file.bytes)}${when === '' ? '' : ' · ' + when} · ${assetUrl(target.id, file.name)}`;
    li.appendChild(meta);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ghost small';
    del.textContent = '✕';
    del.title = '删除这个已发布的资产（游戏里如果引用了它就会读不到）';
    del.addEventListener('click', () => { void deletePublished(target, file.name); });
    li.appendChild(del);
    pubList.appendChild(li);
  }
}

async function refreshPublished(): Promise<void> {
  const target = activeTarget();
  if (!target) {
    publishFiles = [];
    renderPublished();
    return;
  }
  const res = await listPublished(target.id);
  if (!res.ok) {
    publishFiles = [];
    renderPublished();
    pubState.textContent = '读不到已发布列表：' + res.error;
    return;
  }
  publishFiles = res.value;
  renderPublished();
}

/** Re-read /api/manifest, rebuild the target options and the published list. */
async function refreshTargets(): Promise<void> {
  const res = await loadPublishTargets();
  if (res.ok) {
    publishTargets = res.value;
    if (publishTargets.length === 0) {
      log('没有任何子应用声明接收发布资产（manifest 里的 assets.accepts），发布按钮会保持禁用', 'warn');
    } else {
      log('发布目标：' + publishTargets.map((t) => `${t.name}（${t.accepts.map((e) => '.' + e).join('/')}）`).join('、'));
    }
  } else {
    publishTargets = [];
    log('读不到子应用列表，发布不可用：' + res.error, 'warn');
  }
  fillTargetOptions();
  // Re-apply the stored target now that the options exist (a value with no matching option would
  // silently read as 「自动」). Suppressed callback: this function does the same follow-up work itself.
  suppressPublishCallback = true;
  try {
    panel.refresh();
  } finally {
    suppressPublishCallback = false;
  }
  renderResults();
  await refreshPublished();
}

/** The panel's publish-target callback (also fires while the panel is being constructed). */
function onPublishTargetChanged(): void {
  if (suppressPublishCallback) return;
  renderResults();
  void refreshPublished();
}

async function publishOutput(out: Output): Promise<void> {
  if (publishing) return;
  const target = activeTarget();
  const ext = extensionOf(out.name);
  const blocked = blockedReason(target, ext);
  if (blocked !== null || !target) {
    log('没法发布：' + (blocked ?? '没有接收资产的子应用'), 'warn');
    return;
  }
  const name = publishNameFor(out.name, pubName.value, ext);
  publishing = true;
  pubState.textContent = '发布中…';
  const res = await publishAsset(target.id, name, out.blob);
  publishing = false;
  if (!res.ok) {
    log(`发布 ${name} 失败：` + res.error, 'error');
    pubState.textContent = '发布失败：' + res.error;
    await refreshPublished();
    return;
  }
  log(publishResultText(res.value.name, res.value.bytes, target, res.value.replaced, res.value.url), 'ok');
  log(`（文件在 data/assets/${target.id}/，重新构建不会丢；游戏里按 ${res.value.url} 读取）`);
  await refreshPublished();
}

async function deletePublished(target: PublishTarget, name: string): Promise<void> {
  const res = await removePublished(target.id, name);
  if (!res.ok) {
    log(`删除 ${name} 失败：` + res.error, 'error');
    return;
  }
  log(`已删除已发布资产 ${target.id}/${name}`, 'ok');
  await refreshPublished();
}

pubRefresh.addEventListener('click', () => { void refreshTargets(); });
// The product rows' tooltip shows the URL the file WILL be published to, and that name comes from this
// field — so typing here has to re-render them, or the hint would quietly describe the wrong file.
pubName.addEventListener('input', () => renderResults());

// ---- wiring ----------------------------------------------------------------------------------
fileInput.addEventListener('change', () => {
  const files = Array.from(fileInput.files ?? []);
  fileInput.value = ''; // allow re-picking the same file
  void addAll(files);
});

textureInput.addEventListener('change', () => {
  const files = Array.from(textureInput.files ?? []);
  textureInput.value = '';
  void addTextures(files);
});

async function addAll(files: readonly File[]): Promise<void> {
  if (files.length === 0) return;
  for (const file of files) {
    await addFile(file);
    // Yield between files so the list paints and a big FBX does not freeze the UI for its whole batch.
    await new Promise((r) => setTimeout(r, 0));
  }
}

/**
 * Add image files to the texture list, then RE-PARSE every FBX that was still missing something.
 * Textures are matched while the FBX is parsed (textures.ts), so "I forgot the textures, now I have
 * them" has to run the parse again — and only the files that actually need it, because a Mixamo-sized
 * FBX parse is not free.
 */
async function addTextures(files: readonly File[]): Promise<void> {
  let added = 0;
  for (const file of files) {
    if (!isImageFileName(file.name)) {
      log(`${file.name} 不是图片（支持 ${IMAGE_EXTENSIONS.join('/')}），已忽略`, 'warn');
      continue;
    }
    const entry = { name: file.name, blob: file as Blob, size: file.size };
    const at = textureFiles.findIndex((t) => t.name.toLowerCase() === file.name.toLowerCase());
    if (at >= 0) textureFiles[at] = entry;
    else textureFiles.push(entry);
    added++;
  }
  if (added === 0) return;
  renderTextures();
  const stale = items.filter((i) => i.state === 'ready' && i.textures && reportNeedsTextures(i.textures!));
  if (stale.length > 0) {
    log(`贴图已更新，重新解析 ${stale.length} 个还在缺贴图的 FBX…`);
    for (const item of stale) {
      await parseInto(item);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
}

function renderTextures(): void {
  textureListEl.textContent = '';
  textureCountEl.textContent = textureFiles.length === 0 ? '还没有贴图' : `${textureFiles.length} 张图片`;
  const used = new Set<string>();
  for (const item of items) {
    if (!item.textures) continue;
    for (const name of providedFileNames(item.textures)) used.add(name.toLowerCase());
  }
  for (const tf of textureFiles) {
    const li = document.createElement('li');
    li.className = 'file-row ready';
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = tf.name;
    li.appendChild(name);
    const meta = document.createElement('span');
    meta.className = 'file-meta';
    meta.textContent = formatBytes(tf.size) +
      (used.has(tf.name.toLowerCase()) ? ' · 已用于贴图' : ' · 还没被任何 FBX 引用');
    li.appendChild(meta);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'ghost small';
    remove.textContent = '✕';
    remove.title = '移除';
    remove.addEventListener('click', () => {
      const at = textureFiles.indexOf(tf);
      if (at >= 0) textureFiles.splice(at, 1);
      renderTextures();
    });
    li.appendChild(remove);
    textureListEl.appendChild(li);
  }
  updateConvertState();
}

/** Drag & drop: route by extension, textures FIRST so a single drop of FBX + images parses once. */
function bindDropzone(el: HTMLElement, onFiles: (files: File[]) => void): void {
  for (const type of ['dragenter', 'dragover']) {
    el.addEventListener(type, (e) => { e.preventDefault(); el.classList.add('over'); });
  }
  for (const type of ['dragleave', 'drop']) {
    el.addEventListener(type, () => el.classList.remove('over'));
  }
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    const dt = (e as DragEvent).dataTransfer;
    if (!dt) return;
    onFiles(Array.from(dt.files ?? []));
  });
}

bindDropzone(dropzone, (files) => {
  const fbx = files.filter((f) => f.name.toLowerCase().endsWith('.fbx'));
  const images = files.filter((f) => isImageFileName(f.name));
  const other = files.filter((f) => !fbx.includes(f) && !images.includes(f));
  if (other.length > 0) {
    log(`忽略了 ${other.length} 个既不是 .fbx 也不是图片的文件：${other.map((f) => f.name).join('、')}`, 'warn');
  }
  void (async () => {
    if (images.length > 0) await addTextures(images);
    if (fbx.length > 0) await addAll(fbx);
  })();
});

bindDropzone(texDropzone, (files) => { void addTextures(files); });

/**
 * The built-in samples. There are two on purpose: the plain one shows the minimal pipeline, and the
 * textured one references `sample_body_diffuse.png` as an EXTERNAL file — the exact situation the
 * texture list exists for — so the whole feature can be seen on a device without hunting for a
 * Blender export. Note this is the ONLY place the app fetches anything: its own bundled assets.
 */
async function loadSample(fbxName: string, textureName: string | null): Promise<void> {
  try {
    log(`载入内置样例 ${fbxName}${textureName ? '（含外部贴图引用）' : ''}…`);
    if (textureName) {
      const texRes = await fetch('./assets/' + textureName, { cache: 'no-store' });
      if (!texRes.ok) throw new Error('贴图 HTTP ' + texRes.status);
      const texBlob = await texRes.blob();
      await addTextures([new File([texBlob], textureName, { type: texBlob.type || 'image/png' })]);
    }
    const res = await fetch('./assets/' + fbxName, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buffer = await res.arrayBuffer();
    await addFile(new File([buffer], fbxName, { type: 'application/octet-stream' }));
  } catch (err) {
    log(`样例载入失败：${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}

sampleBtn.addEventListener('click', () => { void loadSample('sample.fbx', null); });
sampleTexBtn.addEventListener('click', () => { void loadSample('sample-textured.fbx', 'sample_body_diffuse.png'); });

clearBtn.addEventListener('click', () => {
  for (const item of items) (item.loaded as ParsedFbx | undefined)?.textureIndex?.dispose();
  items.length = 0;
  textureFiles.length = 0;
  outputs.length = 0;
  usedOutputNames.clear();
  previewSource = null;
  preview?.clear();
  renderClips();
  renderTextures();
  renderList();
  renderResults();
  log('已清空列表（已发布到游戏的资产不受影响，在下面的列表里单独删）');
});

convertBtn.addEventListener('click', () => { void convert(); });

// ---- boot ------------------------------------------------------------------------------------
renderList();
renderTextures();
renderResults();
renderClips();
log('选择 .fbx 文件即可开始；多个 Mixamo 动作文件可以合并成一个 glb。');
// Publish targets come from the portal's own manifest API, so this app never names a game.
void refreshTargets();
log('FBX 的贴图如果是外部文件（Blender/3ds Max 导出常见），把那些图片也一起选进来，按文件名自动匹配。');
