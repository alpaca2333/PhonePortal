/**
 * Assembly layer: owns the DOM list state and drives the pipeline, and is the only module that knows
 * about both the pure rules and the browser APIs. Following the portal's convention, the settings
 * panel owns persistence and hands EFFECTIVE values back here; nothing else reaches for the server.
 *
 * THE PIPELINE, once, for the record:
 *   File → ArrayBuffer → FBXLoader.parse → { root, clips }
 *        → describeScene (report + height)
 *        → mergeScenes (pick the character, attach & rename the other files' clips)
 *        → resolveScale (units.ts) → GLTFExporter.parse → Blob
 *        → GLTFLoader.parse (self-check: what did we actually write?)
 *        → download link. No byte of it leaves the device.
 */
import { parseFbx, loadFbxFile, exportScene, selfCheck, downloadBlob, type SelfCheck } from './src/convert.js';
import { describeScene, type SceneReport } from './src/analyze.js';
import { mergeScenes, nameClipsForFile, renameClips, type LoadedFbx } from './src/merge.js';
import { formatBytes, outputFileName } from './src/names.js';
import { resolveScale, scaleLabel, type ScaleDecision } from './src/units.js';
import { createPanel, type PanelHandle } from './src/panel.js';
import { createPreview, type PreviewHandle } from './src/preview.js';
import type { ConvertSettings, PreviewSettings } from './src/settings.js';

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
      meta.textContent = [
        formatBytes(item.size),
        `${r.meshes} 网格${r.skinned ? `（${r.skinned} 蒙皮）` : ''}`,
        `${r.bones} 骨骼`,
        `${r.clips.length} 动作`,
        `高 ${r.size.y.toFixed(3)}`,
      ].join(' · ');
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

/** Parse one file and fold it into the list. Parsing happens on ADD, so the report is ready. */
async function addFile(file: File): Promise<void> {
  const item: Item = { id: nextId++, file, size: file.size, state: 'parsing' };
  items.push(item);
  renderList();
  log(`读取 ${file.name}（${formatBytes(file.size)}）…`);
  try {
    const loaded = await loadFbxFile(file);
    item.loaded = loaded;
    item.report = describeScene(loaded.root, loaded.clips);
    item.state = 'ready';
    const r = item.report;
    log(`解析完成：${r.meshes} 个网格、${r.bones} 根骨骼、${r.clips.length} 个动作片段、` +
      `包围盒 ${r.size.x.toFixed(2)}×${r.size.y.toFixed(2)}×${r.size.z.toFixed(2)}`, 'ok');
    if (r.clips.length === 0) log('这个文件里没有动画（只会导出模型）', 'warn');
    if (!previewSource) { previewSource = loaded; setPreview(loaded.root, loaded.clips); }
  } catch (err) {
    item.state = 'error';
    item.error = err instanceof Error ? err.message : String(err);
    log(`解析失败 ${file.name}：${item.error}`, 'error');
  }
  renderList();
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
const panel: PanelHandle = createPanel({
  els: {
    format: byId<HTMLSelectElement>('optFormat'),
    merge: byId<HTMLInputElement>('optMerge'),
    animations: byId<HTMLInputElement>('optAnim'),
    scale: byId<HTMLSelectElement>('optScale'),
    naming: byId<HTMLSelectElement>('optNaming'),
    convertReset: byId<HTMLButtonElement>('convertReset'),
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
});

// ---- conversion ------------------------------------------------------------------------------
interface Output {
  name: string;
  blob: Blob;
  clips: string[];
  scale: ScaleDecision;
  report: SceneReport;
  warnings: string[];
  check: SelfCheck | { error: string };
  from: string;
}

const outputs: Output[] = [];
const usedOutputNames = new Set<string>();

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

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'primary';
    btn.textContent = '下载 ' + out.name;
    btn.addEventListener('click', () => {
      downloadBlob(out.blob, out.name);
      log('已下载 ' + out.name, 'ok');
    });
    li.appendChild(btn);
    resultsEl.appendChild(li);
  }
}

/** Export one scene and register the result (including the read-back self-check). */
async function emit(
  from: string, root: any, clips: readonly any[], c: ConvertSettings, warnings: readonly string[] = [],
): Promise<void> {
  const report = describeScene(root, clips);
  const decision = resolveScale(c.scaleMode, report.size.y);
  if (decision.autoApplied) {
    log(`测得高度 ${decision.height.toFixed(2)} 个单位 → 判定为厘米，导出时 ×${decision.scale}`, 'info');
  }
  const anim = c.animations ? clips : [];
  const out = await exportScene(root, { format: c.format, animations: anim, scale: decision.scale });
  const buffer = await out.blob.arrayBuffer();
  const check = await selfCheck(buffer);
  const name = uniqueFileName(from, c.format);
  outputs.push({
    name, blob: out.blob, clips: c.animations ? report.clips.map((x) => x.name) : [],
    scale: decision, report, warnings: [...warnings], check, from,
  });
  log(`写出 ${name}（${formatBytes(out.bytes)}）` +
    ('error' in check ? ` · 自检失败：${check.error}` : ` · 自检通过（${check.bones} 骨骼）`),
  'error' in check ? 'warn' : 'ok');
  renderResults();
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
      await emit(baseItem.file.name, outcome.root, outcome.clips, c, outcome.warnings);
      // Preview what was just exported (renamed clips included), so the names on screen are the names
      // in the file.
      previewSource = { file: baseItem.file.name, root: outcome.root, clips: outcome.clips };
      setPreview(outcome.root, outcome.clips);
    } else {
      // ---- one output per input --------------------------------------------------------------
      for (const item of ready) {
        const loaded = item.loaded!;
        const names = nameClipsForFile(item.file.name, loaded.clips, c.clipNaming);
        const clips = renameClips(loaded.clips, names);
        await emit(item.file.name, loaded.root, clips, c);
        // Yield so the log/result rows paint between files (a phone renders nothing otherwise).
        await new Promise((r) => setTimeout(r, 0));
      }
      const first = ready[0]!;
      previewSource = first.loaded!;
      setPreview(first.loaded!.root, first.loaded!.clips);
    }
  } catch (err) {
    log('转换失败：' + (err instanceof Error ? err.message : String(err)), 'error');
  } finally {
    busy = false;
    updateConvertState();
  }
}

// ---- wiring ----------------------------------------------------------------------------------
fileInput.addEventListener('change', () => {
  const files = Array.from(fileInput.files ?? []);
  fileInput.value = ''; // allow re-picking the same file
  void addAll(files);
});

async function addAll(files: readonly File[]): Promise<void> {
  if (files.length === 0) return;
  for (const file of files) {
    await addFile(file);
    // Yield between files so the list paints and a big FBX does not freeze the UI for its whole batch.
    await new Promise((r) => setTimeout(r, 0));
  }
}

// Drag & drop on the whole drop zone (a phone rarely drags, a desktop often does).
for (const type of ['dragenter', 'dragover']) {
  dropzone.addEventListener(type, (e) => { e.preventDefault(); dropzone.classList.add('over'); });
}
for (const type of ['dragleave', 'drop']) {
  dropzone.addEventListener(type, () => dropzone.classList.remove('over'));
}
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  const dt = (e as DragEvent).dataTransfer;
  if (!dt) return;
  void addAll(Array.from(dt.files ?? []));
});

sampleBtn.addEventListener('click', () => {
  void (async () => {
    try {
      log('载入内置样例（一个 2 骨骼蒙皮盒子 + 两个动作）…');
      const res = await fetch('./assets/sample.fbx', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buffer = await res.arrayBuffer();
      const loaded = await parseFbx(buffer, 'sample.fbx');
      const report = describeScene(loaded.root, loaded.clips);
      const file = new File([buffer], 'sample.fbx', { type: 'application/octet-stream' });
      items.push({ id: nextId++, file, size: buffer.byteLength, state: 'ready', loaded, report });
      log(`样例已载入：${report.bones} 根骨骼、${report.clips.length} 个动作`, 'ok');
      renderList();
      previewSource = loaded;
      setPreview(loaded.root, loaded.clips);
    } catch (err) {
      log('样例载入失败：' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  })();
});

clearBtn.addEventListener('click', () => {
  items.length = 0;
  outputs.length = 0;
  usedOutputNames.clear();
  previewSource = null;
  preview?.clear();
  renderClips();
  renderList();
  renderResults();
  log('已清空列表');
});

convertBtn.addEventListener('click', () => { void convert(); });

// ---- boot ------------------------------------------------------------------------------------
renderList();
renderResults();
renderClips();
log('选择 .fbx 文件即可开始；多个 Mixamo 动作文件可以合并成一个 glb。');
