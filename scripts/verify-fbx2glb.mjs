/**
 * CPU-side verification for the FBX→GLB converter sub-app (apps/fbx2glb).
 *
 * WHY THIS EXISTS
 * ---------------
 * The app's entire promise is "FBX in, GLB out, animations intact", and this repository has no
 * browser, so nothing else in the suite can check it: the other scripts either read finished .glb
 * assets (verify-characters) or test pure geometry. Here the REAL pipeline runs in Node — the same
 * vendored FBXLoader/GLTFExporter the page loads, over the same sample.fbx the page ships — so the
 * following can be asserted and not merely claimed:
 *
 *   1. THE LOADER UNDERSTANDS SKIN + ANIMATION. sample.fbx is a hand-written ASCII FBX (2 bones, a
 *      box skinned to them, a material, and two takes literally called `mixamo.com`); the test asserts
 *      what came out: 1 skinned mesh, 2 bones, 2 clips, the right track names.
 *   2. THE MERGE ACTUALLY RE-TARGETS. The interesting failure of merging several Mixamo files is
 *      silent: clips whose track names match no node in the exported scene play NOTHING and raise no
 *      error anywhere. So the test merges files with drifted bone names (`mixamorig5Hips`) and asserts
 *      that after merging, `unboundTracks` is empty — i.e. every track resolves.
 *   3. THE OUTPUT IS SELF-CONTAINED. The written GLB is parsed back twice: with our own container
 *      reader (magic/version/chunk alignment/no `uri` anywhere/skins/animations target joints) and
 *      with three's GLTFLoader (the app's own self-check). A .gltf export is asserted to embed its
 *      buffer as a base64 data URI.
 *   4. THE RULES ARE THE ONES DOCUMENTED. Naming (Mixamo's `mixamo.com` placeholder, dedupe, CJK),
 *      unit heuristics (100-unit Mixamo characters vs metre-scale props), the rig matcher's refusal to
 *      guess on ambiguity, and the settings schema (defaults, clamps, sparse overrides, unknown-key
 *      preservation) are all pinned here.
 *   5. IT STAYS LOCAL — EXCEPT FOR THE BUTTON YOU PRESS. Source-level assertions that the app never
 *      touches localStorage, never uses XMLHttpRequest/FormData, and that every fetch target is either
 *      its own bundled sample asset or a RELATIVE /api/ route of this portal (no absolute URL exists in
 *      the source). The conversion path itself is asserted to make zero asset requests: a publish only
 *      happens when the user clicks 发布, and then exactly one PUT goes out.
 *
 * NOT asserted: that the preview renders, that touch orbit feels right, that a 10 MB Mixamo character
 * converts in an acceptable time on a phone. No browser here — those are 需真机确认 items in
 * apps/fbx2glb/README.md, like everywhere else in this portal.
 *
 * Run:  npm run dev            (or npm run build) so dist/ is current, then
 *       node scripts/verify-fbx2glb.mjs
 * Exit code is non-zero when any assertion fails.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';

const APP = new URL('../apps/fbx2glb/', import.meta.url);
const DIST_APP = new URL('../dist/apps/fbx2glb/', import.meta.url);

// `dist/apps/fbx2glb/src/*.js` import the bare specifier 'three' (the browser resolves it through the
// app's <script type="importmap">; Node has no import map). This hook is that map, pointed at the SAME
// vendored build the page loads — same trick as scripts/verify-characters.mjs.
const VENDOR = new URL('../dist/apps/fbx2glb/vendor/three.module.min.js', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'three') return { url: VENDOR, shortCircuit: true };
    return next(specifier, context);
  },
});

// GLTFExporter's binary path (and its texture path) uses FileReader, which Node does not provide.
// Blob.arrayBuffer() covers both methods it calls. This shim exists ONLY for the test: in the browser
// the real thing is there (which is exactly why this app is a web page and not a CLI).
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class FileReaderShim {
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then((b) => { this.result = b; this.onloadend && this.onloadend(); });
    }
    readAsDataURL(blob) {
      blob.arrayBuffer().then((b) => {
        this.result = 'data:' + (blob.type || 'application/octet-stream') + ';base64,' +
          Buffer.from(b).toString('base64');
        this.onloadend && this.onloadend();
      });
    }
  };
}

// GLTFLoader reaches for the global `self` (the browser/worker global) when it has to turn an embedded
// image bufferView into an object URL; Node has no `self`. Only the textured round trip needs it.
if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;

// three's FileLoader dispatches a ProgressEvent, which Node does not define either. Only the .gltf
// self-check reaches it (the binary path reads its buffer out of the GLB chunk with no fetch), so
// this shim exists purely to let the non-binary round trip be asserted here.
if (typeof globalThis.ProgressEvent === 'undefined') {
  globalThis.ProgressEvent = class ProgressEvent {
    constructor(type, init = {}) { this.type = type; Object.assign(this, init); }
  };
}

// Headless stand-ins for the two browser APIs the texture path needs — an <img> that fires `load` for
// blob:/data: URLs, and a canvas whose `toBlob` hands back real PNG bytes. Both are modelled on the
// details that actually matter: a dispatched DOM event calls its listener with the ELEMENT as `this`
// (three's ImageLoader reads `this` inside its handler), and the canvas only has to survive
// `drawImage` + `toBlob`.
const SAMPLE_PNG = readFileSync(new URL('../apps/fbx2glb/assets/sample_body_diffuse.png', import.meta.url));
function fakeImage() {
  const el = {
    width: 4, height: 4, listeners: new Map(),
    addEventListener(t, f) { if (!this.listeners.has(t)) this.listeners.set(t, []); this.listeners.get(t).push(f); },
    removeEventListener() {},
  };
  Object.defineProperty(el, 'src', {
    get() { return this._src; },
    set(v) {
      this._src = v;
      setTimeout(() => {
        const ok = String(v).startsWith('blob:') || String(v).startsWith('data:');
        for (const f of this.listeners.get(ok ? 'load' : 'error') ?? []) f.call(el, { type: ok ? 'load' : 'error' });
      }, 0);
    },
  });
  return el;
}
const FAKE_CANVAS_LOG = [];
function fakeCanvas() {
  const entry = { width: 0, height: 0, draws: [] };
  FAKE_CANVAS_LOG.push(entry);
  const ctx = {
    translate() {}, scale() {}, putImageData() {},
    drawImage(image, ...args) { entry.draws.push({ image, args }); },
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  };
  const canvas = {
    get width() { return entry.width; },
    set width(v) { entry.width = v; },
    get height() { return entry.height; },
    set height(v) { entry.height = v; },
    getContext: () => ctx,
    toBlob: (cb, mime) => cb(new Blob([SAMPLE_PNG], { type: mime || 'image/png' })),
    toDataURL: (mime) => 'data:' + (mime || 'image/png') + ';base64,' + Buffer.from(SAMPLE_PNG).toString('base64'),
  };
  entry.canvas = canvas;
  return canvas;
}

const THREE = await import(VENDOR);
const names = await import(new URL('../dist/apps/fbx2glb/src/names.js', import.meta.url).href);
const units = await import(new URL('../dist/apps/fbx2glb/src/units.js', import.meta.url).href);
const rig = await import(new URL('../dist/apps/fbx2glb/src/rig.js', import.meta.url).href);
const settings = await import(new URL('../dist/apps/fbx2glb/src/settings.js', import.meta.url).href);
const analyze = await import(new URL('../dist/apps/fbx2glb/src/analyze.js', import.meta.url).href);
const merge = await import(new URL('../dist/apps/fbx2glb/src/merge.js', import.meta.url).href);
const convert = await import(new URL('../dist/apps/fbx2glb/src/convert.js', import.meta.url).href);

let failures = 0;
let checks = 0;
function check(ok, label, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : '  FAIL '} ${label}${detail ? ' — ' + detail : ''}`);
}
function section(title) { console.log('\n' + title); }
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// =============================================================================================
// 0. 构建新鲜度：本脚本读 dist/，陈旧的 dist 只会测到上一个版本
// =============================================================================================
section('0. dist 是否比源码新（避免对着旧构建做验证）');
{
  const newestSource = (dir) => {
    let newest = 0;
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const url = new URL(name.name + (name.isDirectory() ? '/' : ''), dir);
      if (name.isDirectory()) newest = Math.max(newest, newestSource(url));
      else {
        const ext = name.name.split('.').pop();
        if (['ts', 'html', 'css', 'json', 'fbx', 'png'].includes(ext)) {
          newest = Math.max(newest, statSync(url).mtimeMs);
        }
      }
    }
    return newest;
  };
  const sourceTime = newestSource(APP);
  const builtTime = statSync(new URL('../dist/apps/fbx2glb/main.js', import.meta.url)).mtimeMs;
  check(builtTime >= sourceTime, 'dist/apps/fbx2glb 比 apps/fbx2glb 新（npm run dev 的 watcher 已完成重建）',
    'source=' + new Date(sourceTime).toISOString() + ' built=' + new Date(builtTime).toISOString() +
    (builtTime < sourceTime ? ' → 等 watcher 构建完（或 npm run build）后重跑' : ''));
}

// =============================================================================================
// 1. 命名规则 (names.ts)
// =============================================================================================
section('1. 命名：Mixamo 占位名 / 去重 / CJK / 下载文件名');
{
  check(names.baseNameOf('a/b/Big Idle.fbx') === 'Big Idle', 'baseNameOf 去掉目录与扩展名', names.baseNameOf('a/b/Big Idle.fbx'));
  check(names.baseNameOf('x.FBX') === 'x', 'baseNameOf 大小写无关');
  check(names.baseNameOf('noext') === 'noext', 'baseNameOf 没有扩展名');
  check(names.baseNameOf('.hidden') === '.hidden', 'baseNameOf 前导点不算扩展名');
  check(names.baseNameOf('') === '', 'baseNameOf 空串');

  check(names.isPlaceholderClipName('mixamo.com'), 'mixamo.com 是占位名');
  check(names.isPlaceholderClipName('mixamo.com.001'), 'mixamo.com.001 是占位名');
  check(names.isPlaceholderClipName('Take 001'), 'Take 001 是占位名');
  check(names.isPlaceholderClipName('take001'), 'take001 是占位名');
  check(names.isPlaceholderClipName('Animation'), 'Animation 是占位名');
  check(!names.isPlaceholderClipName('Idle'), 'Idle 不是占位名');
  check(!names.isPlaceholderClipName('mixamo.compose'), 'mixamo.compose 不是占位名（不能过度匹配）');
  check(!names.isPlaceholderClipName(''), '空名字不算占位名（由别处兜底）');

  check(names.safeName('a b') === 'a-b', 'safeName 空格→连字符', names.safeName('a b'));
  check(names.safeName('a/b\\c:d*e?f"g<h>i|j') === 'a-b-c-d-e-f-g-h-i-j', 'safeName 去掉文件名非法字符');
  check(names.safeName('  待机  ') === '待机', 'safeName 保留 CJK', names.safeName('  待机  '));
  check(names.safeName('', 'clip') === 'clip', 'safeName 空串用兜底');
  check(names.safeName('...') === 'clip', 'safeName 全是点的名字用兜底');

  check(names.clipCandidate({ file: 'idle.fbx', clip: 'mixamo.com' }, 'file') === 'idle',
    '按文件名命名');
  check(names.clipCandidate({ file: 'idle.fbx', clip: 'mixamo.com' }, 'clip') === 'idle',
    '按动作名命名时占位名退回文件名');
  check(names.clipCandidate({ file: 'idle.fbx', clip: 'Run' }, 'clip') === 'Run',
    '按动作名命名时保留真名字');
  check(names.clipCandidate({ file: 'idle.fbx', clip: '' }, 'clip') === 'idle',
    '空动作名退回文件名');

  check(JSON.stringify(names.uniqueNames(['idle', 'idle', 'idle'])) === JSON.stringify(['idle', 'idle-2', 'idle-3']),
    '重复名字加 -2/-3');
  check(JSON.stringify(names.uniqueNames(['idle', 'idle-2', 'idle'])) === JSON.stringify(['idle', 'idle-2', 'idle-3']),
    '去重结果不会和已有名字撞车');
  const planned = names.planClipNames([
    { file: 'idle.fbx', clip: 'mixamo.com' },
    { file: 'run.fbx', clip: 'mixamo.com' },
    { file: 'jump.fbx', clip: 'mixamo.com' },
  ], 'file');
  check(JSON.stringify(planned) === JSON.stringify(['idle', 'run', 'jump']),
    '工作流：文件命名 idle/run/jump → 动作名就是 idle/run/jump', planned.join(','));
  const cjk = names.planClipNames([{ file: '待机.fbx', clip: 'mixamo.com' }], 'file');
  check(cjk[0] === '待机', 'CJK 文件名直接做动作名', cjk[0]);

  check(names.outputFileName('a/b/hero.fbx', 'glb') === 'hero.glb', '下载名：GLB');
  check(names.outputFileName('hero.fbx', 'gltf', 'run') === 'hero-run.gltf', '下载名：带后缀');
  check(names.outputFileName('a b?.fbx', 'glb') === 'a-b.glb', '下载名也做净化', names.outputFileName('a b?.fbx', 'glb'));

  check(names.formatBytes(0) === '0 B', 'formatBytes 0');
  check(names.formatBytes(1023) === '1023 B', 'formatBytes <1KB');
  check(names.formatBytes(1024) === '1.0 KB', 'formatBytes 1KB');
  check(names.formatBytes(1536 * 1024) === '1.5 MB', 'formatBytes MB', names.formatBytes(1536 * 1024));
  check(names.formatBytes(NaN) === '—', 'formatBytes 脏数据不印 NaN');
}

// =============================================================================================
// 2. 单位缩放 (units.ts)
// =============================================================================================
section('2. 单位缩放：厘米模型 vs 米制模型');
{
  check(units.looksLikeCentimetres(160), '160 单位 → 厘米');
  check(!units.looksLikeCentimetres(1.8), '1.8 单位 → 不是厘米');
  check(!units.looksLikeCentimetres(20), '阈值 20 本身不算厘米（含等号的一侧写死在测试里）');
  check(units.looksLikeCentimetres(20.1), '20.1 单位 → 厘米');
  check(!units.looksLikeCentimetres(NaN), 'NaN 不算厘米');
  check(!units.looksLikeCentimetres(-5), '负高度不算厘米');

  const auto = units.resolveScale('auto', 160);
  check(auto.scale === 0.01 && auto.autoApplied, 'auto + 160 → ×0.01 且标记为自动');
  check(auto.height === 160, '决定里带上测量值', String(auto.height));
  const autoM = units.resolveScale('auto', 1.8);
  check(autoM.scale === 1 && !autoM.autoApplied, 'auto + 1.8 → ×1（不把道具放大成巨人）');
  check(units.resolveScale('keep', 160).scale === 1, 'keep 忽略测量值');
  check(units.resolveScale('cm', 1.8).scale === 0.01, 'cm 强制 ×0.01');
  check(!units.resolveScale('cm', 1.8).autoApplied, '强制厘米不算「自动判定」');
  check(units.resolveScale('auto', 0).scale === 1, '空场景（高 0）→ ×1');
  check(units.scaleLabel(1) === '×1' && units.scaleLabel(0.01) === '×0.01', '缩放标签');
}

// =============================================================================================
// 3. 骨架匹配 (rig.ts)
// =============================================================================================
section('3. 骨架匹配：精确 → 归一化（有歧义就拒绝猜）');
{
  check(rig.coreName('mixamorig:Hips') === 'mixamorighips', 'coreName 去掉冒号', rig.coreName('mixamorig:Hips'));
  check(rig.coreName('mixamorig5Hips') === 'mixamorighips', 'coreName 去掉中间数字');
  check(rig.coreName('Hips001') === 'hips', 'coreName 去掉 Blender 的 .001（净化后是 001）');
  check(rig.coreName('Spine_1') === 'spine', 'coreName 去掉下划线');
  check(rig.coreName('骨骼1') === '骨骼', 'coreName 保留 CJK');

  const split = rig.splitTrackName('mixamorigHips.quaternion');
  check(split && split.node === 'mixamorigHips' && split.property === 'quaternion', 'splitTrackName 基本拆分');
  const dotted = rig.splitTrackName('Armature.001.Hips.position');
  check(dotted && dotted.node === 'Armature.001.Hips' && dotted.property === 'position',
    'splitTrackName 从右往左拆（节点名里可以有点）', dotted && dotted.node);
  const morph = rig.splitTrackName('Body.morphTargetInfluences[2]');
  check(morph && morph.property === 'morphTargetInfluences[2]', 'splitTrackName 认得 morph 轨道');
  check(rig.splitTrackName('noSuffix') === null, 'splitTrackName 不是节点轨道就返回 null');

  const same = rig.deriveBoneMap(['Hips', 'Spine'], ['Hips', 'Spine']);
  check(same.identity.length === 2 && same.remapped.length === 0 && same.unmatchedExtra.length === 0,
    '同名骨骼走精确匹配');
  check(same.map.get('Hips') === 'Hips', '精确匹配的映射是恒等');

  const drift = rig.deriveBoneMap(['Hips', 'Spine'], ['Hips001', 'Spine001']);
  check(drift.remapped.length === 2 && drift.unmatchedExtra.length === 0, 'Hips001 → Hips 归一化匹配',
    JSON.stringify(drift.remapped));
  check(drift.map.get('Hips001') === 'Hips', '归一化映射指向基础骨架的名字');

  const prefixed = rig.deriveBoneMap(['mixamorigHips', 'mixamorigSpine'], ['mixamorig5Hips', 'mixamorig5Spine']);
  check(prefixed.unmatchedExtra.length === 0 && prefixed.remapped.length === 2,
    '第二套 Mixamo 绑定（mixamorig5*）能匹配上');

  const ambiguous = rig.deriveBoneMap(['Spine1', 'Spine2'], ['Spine01', 'Spine02']);
  check(ambiguous.unmatchedExtra.length === 2 && ambiguous.ambiguous.length === 1,
    '一根核心名对应多根骨骼时拒绝映射并报告歧义', JSON.stringify(ambiguous.ambiguous));

  const stranger = rig.deriveBoneMap(['Hips', 'Spine'], ['Tail', 'Wing']);
  check(stranger.unmatchedExtra.length === 2, '完全不同的骨架全部未匹配');

  check(rig.remapTrackName('Hips001.quaternion', drift.map) === 'Hips.quaternion',
    'remapTrackName 改名', rig.remapTrackName('Hips001.quaternion', drift.map));
  check(rig.remapTrackName('Hips.quaternion', drift.map) === 'Hips.quaternion', '未匹配的轨道保持原样');
  check(rig.remapTrackName('Body.morphTargetInfluences[0]', drift.map) === 'Body.morphTargetInfluences[0]',
    '非骨骼轨道保持原样');

  check(rig.checkRig(['Hips'], ['Hips']).coverage === 1, 'checkRig 全覆盖');
  check(near(rig.checkRig(['Hips'], ['Hips', 'Tail']).coverage, 0.5), 'checkRig 半覆盖 = 0.5');
  check(rig.checkRig(['Hips'], []).coverage === 1, '没有骨骼的文件视为「不冲突」');
  check(rig.checkRig(['Hips'], ['Tail']).coverage === 0, '完全不同 → 0');
  check(rig.checkRig(['Hips'], ['Tail']).unmatched[0] === 'Tail', 'checkRig 列出未匹配的骨骼');
}

// =============================================================================================
// 4. 设置 schema (settings.ts)
// =============================================================================================
section('4. 设置：默认值 / 稀疏覆盖 / 脏数据 / 每组各自恢复默认');
{
  check(settings.orientationOf({ width: 800, height: 600 }) === 'landscape', '横屏判定');
  check(settings.orientationOf({ width: 600, height: 800 }) === 'portrait', '竖屏判定');
  check(settings.orientationOf({ width: 600, height: 600 }) === 'portrait', '正方形算竖屏');

  const d = settings.convertDefaults();
  check(d.format === 'glb' && d.merge === true && d.animations === true &&
    d.scaleMode === 'auto' && d.clipNaming === 'file',
    '转换默认值 = 一条命令就能跑通 Mixamo 工作流', JSON.stringify(d));

  check(settings.createState(null) && Object.keys(settings.createState(null)).length === 0, 'createState(null) → {}');
  check(Object.keys(settings.createState([1, 2])).length === 0, 'createState(数组) → {}');
  check(settings.createState({ a: 1 }).a === 1, 'createState 保留对象');

  const empty = {};
  check(JSON.stringify(settings.effectiveConvert(empty, 'portrait')) === JSON.stringify(d),
    '空存储 → 默认值');

  const raw = {};
  settings.writeConvertOverride(raw, 'format', 'gltf');
  check(raw.convert.portrait.format === 'gltf' && raw.convert.landscape.format === 'gltf',
    '写入时两个方向都写（这些值没有方向语义，见 settings.ts 顶部注释）');
  check(settings.effectiveConvert(raw, 'portrait').format === 'gltf', '读当前方向拿到覆盖值');
  check(settings.hasConvertOverrides(raw), 'hasConvertOverrides 为真');

  // A hand-edited file with only ONE orientation: the other one must fall back to the defaults rather
  // than to a half-merged state.
  const oneSided = { convert: { portrait: { format: 'gltf' } } };
  check(settings.effectiveConvert(oneSided, 'portrait').format === 'gltf' &&
    settings.effectiveConvert(oneSided, 'landscape').format === 'glb',
    '只写一个方向的旧数据：另一个方向回落默认值');

  const dirty = { convert: { portrait: { format: 'gltf2', merge: 'yes', scaleMode: 5, clipNaming: null, animations: false } } };
  const eff = settings.effectiveConvert(dirty, 'portrait');
  check(eff.format === 'glb' && eff.merge === true && eff.scaleMode === 'auto' && eff.clipNaming === 'file',
    '脏数据被丢弃而不是抛错', JSON.stringify(eff));
  check(eff.animations === false, '同一组里的合法值仍然生效');

  const keep = { convert: { portrait: { format: 'gltf' } }, future: { x: 1 } };
  settings.writeConvertOverride(keep, 'merge', false);
  check(keep.future && keep.future.x === 1, '保存时未知键原样保留');
  settings.clearConvertGroup(keep);
  check(keep.convert === undefined && keep.future.x === 1, '恢复默认只清自己那组');
  check(!settings.hasConvertOverrides(keep), '清空后 hasConvertOverrides 为假');

  // publish 组：目标应用的 id 只能按「形状」校验（应用列表来自 /api/manifest，存储里不可能有权威）
  check(settings.publishDefaults().target === '', '发布目标默认「自动」（空串），不写死任何游戏');
  const pubRaw = {};
  settings.writePublishOverride(pubRaw, 'target', 'shooter');
  check(pubRaw.publish.portrait.target === 'shooter' && pubRaw.publish.landscape.target === 'shooter',
    '发布目标也两个方向都写');
  check(settings.effectivePublish(pubRaw, 'portrait').target === 'shooter', '读回发布目标');
  check(settings.effectivePublish({ publish: { portrait: { target: '../etc' } } }, 'portrait').target === '',
    '形状不对的 id（脏数据）回落到「自动」，不抛错');
  check(settings.effectivePublish({ publish: { portrait: { target: 42 } } }, 'portrait').target === '',
    '非字符串的 id 同样回落');
  check(settings.hasPublishOverrides(pubRaw), 'hasPublishOverrides 为真');
  const pubKeep = { publish: { portrait: { target: 'shooter' } }, future: { y: 2 } };
  settings.clearPublishGroup(pubKeep);
  check(pubKeep.publish === undefined && pubKeep.future.y === 2, '发布组「恢复默认」只清自己那组');
  check(!settings.hasPublishOverrides(pubKeep), '清空后 hasPublishOverrides 为假');
  check(settings.APP_ID_RE.test('shooter') && !settings.APP_ID_RE.test('-x') && !settings.APP_ID_RE.test('a/b'),
    '应用 id 形状与服务器 SCOPE_RE 一致');

  check(settings.clampSpeed(0.05) === 0.1, '速度下限钳制');
  check(settings.clampSpeed(99) === 2, '速度上限钳制');
  check(settings.clampSpeed(NaN) === 1, 'NaN → 默认速度');
  check(near(settings.clampSpeed(1.66), 1.7), '速度按 0.1 步进吸附', String(settings.clampSpeed(1.66)));

  const p = settings.previewDefaults();
  check(p.grid === true && p.bones === false && p.speed === 1, '预览默认值：网格开、骨骼关、速度 1');
  const praw = {};
  settings.writePreviewOverride(praw, 'bones', true);
  check(praw.preview.portrait.bones === true && praw.preview.landscape.bones === true,
    '预览键同样两个方向都写');
  check(settings.effectivePreview(praw, 'landscape').bones === true, '读回预览覆盖值');
  check(settings.effectivePreview({ preview: { portrait: { speed: 99 } } }, 'portrait').speed === 2,
    '预览速度也会被钳制');
  check(settings.hasPreviewOverrides(praw), 'hasPreviewOverrides 为真');
  settings.clearPreviewGroup(praw);
  check(!settings.hasPreviewOverrides(praw), '预览组恢复默认');
}

// =============================================================================================
// 5. 场景分析 (analyze.ts) —— 合成场景 + 未绑定轨道
// =============================================================================================
section('5. 场景分析：计数 / 尺寸 / 未绑定轨道');
{
  const root = new THREE.Group();
  root.name = 'root';
  const hips = new THREE.Bone();
  hips.name = 'mixamorigHips';
  const spine = new THREE.Bone();
  spine.name = 'mixamorigSpine';
  hips.add(spine);
  root.add(hips);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), new THREE.MeshStandardMaterial());
  mesh.position.set(0, 1, 0);
  root.add(mesh);
  root.updateMatrixWorld(true);

  const bound = new THREE.AnimationClip('bound', -1, [
    new THREE.QuaternionKeyframeTrack('mixamorigSpine.quaternion', [0, 2], [0, 0, 0, 1, 0, 0, 0, 1]),
  ]);
  const report = analyze.describeScene(root, [bound]);
  check(report.meshes === 1, '网格计数', String(report.meshes));
  check(report.bones === 2, '骨骼计数', String(report.bones));
  check(report.materials === 1, '材质计数', String(report.materials));
  check(report.vertices === 24, '顶点数（BoxGeometry 1×2×1）', String(report.vertices));
  check(report.triangles === 12, '三角形数', String(report.triangles));
  check(near(report.size.y, 2), '包围盒高度', String(report.size.y));
  check(JSON.stringify(report.boneNames) === JSON.stringify(['mixamorigHips', 'mixamorigSpine']),
    '骨骼名排序稳定', report.boneNames.join(','));
  check(report.clips.length === 1 && report.clips[0].tracks === 1, '片段摘要');
  check(report.clips[0].unbound.length === 0, '能解析的轨道不算未绑定');
  check(near(report.clips[0].duration, 2), 'duration = -1 时从轨道时间重算', String(report.clips[0].duration));

  const unboundClip = new THREE.AnimationClip('bad', 1, [
    new THREE.QuaternionKeyframeTrack('Nope.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
    new THREE.QuaternionKeyframeTrack('mixamorigHips.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
  ]);
  check(analyze.unboundTracks(root, unboundClip).length === 1, '找不到节点的轨道被数出来');
  check(analyze.unboundTracks(root, unboundClip)[0] === 'Nope.quaternion', '并且报出是哪一条');

  const empty = analyze.describeScene(new THREE.Group(), []);
  check(empty.meshes === 0 && empty.bones === 0 && empty.size.y === 0, '空场景不报错、尺寸为 0');
}

// =============================================================================================
// 6. 真实样例文件：FBXLoader 解析
// =============================================================================================
section('6. 样例 FBX（apps/fbx2glb/assets/sample.fbx）经真实 FBXLoader');
const sampleBytes = readFileSync(new URL('../dist/apps/fbx2glb/assets/sample.fbx', import.meta.url));
const sampleBuffer = sampleBytes.buffer.slice(sampleBytes.byteOffset, sampleBytes.byteOffset + sampleBytes.byteLength);
let sample = null;
{
  const text = sampleBytes.toString('utf8');
  check(text.startsWith('; FBX 7.4.0 project file'), '样例是 ASCII FBX 7.4');
  check((text.match(/AnimationStack:/g) || []).length === 2, '样例里有两个 AnimationStack');
  check((text.match(/AnimStack::mixamo\.com/g) || []).length === 2, '两个 take 都叫 mixamo.com（真实 Mixamo 的行为）');
  check(text.includes('SubDeformer::ClusterSpine'), '样例带蒙皮 cluster');
  check(sampleBytes.length < 20 * 1024, '样例保持很小（' + names.formatBytes(sampleBytes.length) + '）');

  sample = await convert.parseFbx(sampleBuffer, 'sample.fbx');
  const r = analyze.describeScene(sample.root, sample.clips);
  check(r.skinned === 1, '解析出 1 个蒙皮网格', String(r.skinned));
  check(r.meshes === 1, '解析出 1 个网格');
  check(r.bones === 2, '解析出 2 根骨骼', String(r.bones));
  check(r.materials >= 1, '解析出材质', String(r.materials));
  check(r.clips.length === 2, '解析出 2 个动作片段', String(r.clips.length));
  check(near(r.size.y, 1.6, 1e-4), '包围盒高度 1.6（米制样例，不该被缩放）', String(r.size.y));
  check(sample.clips[0].name === 'mixamo.com' && sample.clips[1].name === 'mixamo.com',
    '两个片段的原始名字就是占位名');
  const trackKinds = sample.clips.flatMap((c) => c.tracks.map((t) => t.name));
  check(trackKinds.includes('mixamorigSpine.quaternion'), '旋转轨道按骨骼名+属性命名', trackKinds.join(','));
  check(trackKinds.includes('mixamorigHips.position'), '位移轨道也认得出来');
  check(sample.clips.every((c) => near(c.duration, 1, 1e-3)), '两个片段都是 1 秒', sample.clips.map((c) => c.duration).join(','));
  check(analyze.unboundTracks(sample.root, sample.clips[0]).length === 0, '样例片段的轨道都能绑定');
}

// =============================================================================================
// 7. 合并 (merge.ts)：挑角色 / 命名 / 重定向 / 拒绝不匹配的骨架
// =============================================================================================
section('7. 合并：一个角色 + 多个动作文件');
let merged = null;
{
  // The documented workflow: one file per animation, named after the animation.
  const idle = { file: 'idle.fbx', root: sample.root, clips: [sample.clips[0]] };
  const run = { file: 'run.fbx', root: sample.root, clips: [sample.clips[1]] };
  merged = merge.mergeScenes([idle, run], 'file');
  check(merged.baseIndex === 0, '骨架相同的文件里取第一个当角色');
  check(merged.accepted.length === 2 && merged.skipped.length === 0, '两个文件都被接受');
  check(JSON.stringify(merged.clips.map((c) => c.name)) === JSON.stringify(['idle', 'run']),
    '合并后的动作名就是文件名', merged.clips.map((c) => c.name).join(','));
  check(merged.clips.every((c) => analyze.unboundTracks(sample.root, c).length === 0),
    '合并后的轨道全部能绑定（这是最容易静默失败的地方）');

  // Two files that each carry the SAME two takes: names must not collide.
  const dupA = { file: 'hero.fbx', root: sample.root, clips: [...sample.clips] };
  const dupB = { file: 'hero.fbx', root: sample.root, clips: [...sample.clips] };
  const dup = merge.mergeScenes([dupA, dupB], 'file');
  check(JSON.stringify(dup.clips.map((c) => c.name)) === JSON.stringify(['hero', 'hero-2', 'hero-3', 'hero-4']),
    '同名文件/同名 take 也不会产生重名动作', dup.clips.map((c) => c.name).join(','));

  // Drifted rig: the second file calls the bones mixamorig5Hips/mixamorig5Spine. Its tracks must be
  // re-targeted onto the base rig, or the merged clip plays nothing.
  const altRoot = new THREE.Group();
  const altHips = new THREE.Bone(); altHips.name = 'mixamorig5Hips';
  const altSpine = new THREE.Bone(); altSpine.name = 'mixamorig5Spine';
  altHips.add(altSpine);
  altRoot.add(altHips);
  const altClip = new THREE.AnimationClip('mixamo.com', 0.5, [
    new THREE.QuaternionKeyframeTrack('mixamorig5Spine.quaternion', [0, 0.5], [0, 0, 0, 1, 0, 0.3, 0, 0.95]),
  ]);
  const drifted = merge.mergeScenes([
    { file: 'idle.fbx', root: sample.root, clips: [sample.clips[0]] },
    { file: 'wave.fbx', root: altRoot, clips: [altClip] },
  ], 'file');
  check(drifted.accepted.length === 2, '骨架名字漂移的文件仍被接受（覆盖率 100%）');
  const wave = drifted.clips.find((c) => c.name === 'wave');
  check(!!wave, '重定向的文件贡献了自己的动作');
  check(wave && wave.tracks[0].name === 'mixamorigSpine.quaternion',
    '漂移的骨骼名被重定向到角色骨架', wave && wave.tracks[0].name);
  check(wave && analyze.unboundTracks(sample.root, wave).length === 0, '重定向后能绑定到角色');

  // A completely different pack: refused, loudly, instead of shipping dead clips.
  const alienRoot = new THREE.Group();
  const alienA = new THREE.Bone(); alienA.name = 'Bip01Pelvis';
  const alienB = new THREE.Bone(); alienB.name = 'Bip01Head';
  alienA.add(alienB);
  alienRoot.add(alienA);
  const alien = merge.mergeScenes([
    { file: 'idle.fbx', root: sample.root, clips: [sample.clips[0]] },
    { file: 'alien.fbx', root: alienRoot, clips: [new THREE.AnimationClip('mixamo.com', 1, [])] },
  ], 'file');
  check(alien.skipped.length === 1 && alien.skipped[0] === 1, '骨架对不上的文件被跳过');
  check(alien.clips.length === 1, '被跳过的文件不贡献动作');
  check(alien.warnings.some((w) => w.includes('跳过') && w.includes('alien.fbx')),
    '并且给出可读的原因', alien.warnings.find((w) => w.includes('跳过')));

  // The base need not be the first file: the one WITH the skinned mesh wins.
  const propOnly = { file: 'prop.fbx', root: new THREE.Group(), clips: [] };
  const picked = merge.pickBase([propOnly, { file: 'hero.fbx', root: sample.root, clips: [] }]);
  check(picked === 1, '带蒙皮网格的文件被选为角色本体', String(picked));
  check(merge.mergeScenes([propOnly, { file: 'hero.fbx', root: sample.root, clips: [sample.clips[0]] }], 'file')
    .warnings.some((w) => w.includes('不是列表里的第一个文件')), '角色不是第一个文件时会提示');

  // Non-merged path: rename only, tracks untouched.
  const renamed = merge.renameClips([sample.clips[0]], merge.nameClipsForFile('idle.fbx', [sample.clips[0]], 'file'));
  check(renamed[0].name === 'idle', '不合并时也套用命名规则');
  check(renamed[0].tracks[0].name === sample.clips[0].tracks[0].name, '不合并时不改轨道名');

  check(merge.MIN_RIG_COVERAGE === 0.5, '最小骨架覆盖率写死为 0.5');
}

// =============================================================================================
// 8. 端到端：合并后的场景 → GLB → 读回自检
// =============================================================================================
section('8. 端到端：写出 GLB / glTF，再读回来');
let glbBuffer = null;
{
  const out = await convert.exportScene(merged.root, {
    format: 'glb', animations: merged.clips, scale: 1,
  });
  check(out.mime === 'model/gltf-binary', 'GLB 的 MIME', out.mime);
  glbBuffer = await out.blob.arrayBuffer();
  check(out.bytes === glbBuffer.byteLength, 'bytes 与实际长度一致');
  check(glbBuffer.byteLength > 1000, '产物不是空壳', names.formatBytes(glbBuffer.byteLength));

  const buf = Buffer.from(glbBuffer);
  check(buf.readUInt32LE(0) === 0x46546c67, 'GLB magic');
  check(buf.readUInt32LE(4) === 2, 'GLB 版本 2');
  check(buf.readUInt32LE(8) === buf.length, 'GLB header 总长度与实际一致',
    buf.readUInt32LE(8) + ' vs ' + buf.length);
  const jsonLength = buf.readUInt32LE(12);
  check(buf.readUInt32LE(16) === 0x4e4f534a, '第一个 chunk 是 JSON');
  const json = JSON.parse(buf.subarray(20, 20 + jsonLength).toString('utf8'));
  let binChunk = null;
  let offset = 20 + jsonLength;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32LE(offset);
    const type = buf.readUInt32LE(offset + 4);
    if (type === 0x004e4942) binChunk = buf.subarray(offset + 8, offset + 8 + length);
    check(length % 4 === 0, 'chunk 长度 4 字节对齐', String(length));
    offset += 8 + length;
  }
  check(offset === buf.length, 'chunk 恰好铺满文件（不多不少）');
  check(!!binChunk && binChunk.length > 0, 'BIN chunk 存在且非空');

  check(json.asset && json.asset.version === '2.0', 'glTF 2.0');
  check(String(json.asset.generator).includes('GLTFExporter'), 'generator 记录了导出器', String(json.asset.generator));
  check(json.buffers.length === 1 && json.buffers[0].uri === undefined,
    '二进制导出：单一 buffer 且没有 uri（自包含）');
  check(json.buffers[0].byteLength === binChunk.length, 'buffer.byteLength 与 BIN chunk 一致');
  check(!JSON.stringify(json).includes('"uri"'), '整份 JSON 里没有任何 uri（无外链）');
  check(!json.images, '没有图片（样例没有贴图）');
  check(json.meshes.length === 1, '1 个 mesh', String(json.meshes.length));
  check(json.skins.length === 1 && json.skins[0].joints.length === 2, '1 个 skin、2 个关节',
    JSON.stringify(json.skins.map((s) => s.joints.length)));
  const prim = json.meshes[0].primitives[0];
  check(!!prim.attributes.JOINTS_0 && !!prim.attributes.WEIGHTS_0, '图元带蒙皮属性');
  check(prim.attributes.POSITION !== undefined && prim.attributes.NORMAL !== undefined, '图元带位置与法线');
  check(json.animations.length === 2, '2 个动画', String(json.animations.length));
  check(JSON.stringify(json.animations.map((a) => a.name)) === JSON.stringify(['idle', 'run']),
    '动画名字就是合并后的动作名', json.animations.map((a) => a.name).join(','));
  const jointSet = new Set(json.skins[0].joints);
  const targets = json.animations.flatMap((a) => a.channels.map((c) => c.target.node));
  check(targets.length > 0, '动画有通道');
  check(targets.every((t) => jointSet.has(t)), '每条动画通道都指向骨架关节',
    targets.filter((t) => !jointSet.has(t)).length + ' 条不在关节里');
  const nodeNames = json.nodes.map((n) => n.name);
  check(nodeNames.includes('mixamorigHips') && nodeNames.includes('mixamorigSpine'), '节点名沿用骨骼名');
  check(json.accessors.length > 0 && json.bufferViews.length > 0, 'accessor/bufferView 都在');
  check(json.materials && json.materials.length === 1, '材质被写出');

  // ---- the GLB container math the export scale rides on (readGlb / writeGlb / wrapSceneRoot) ----
  const chunks = convert.readGlb(glbBuffer);
  check(!!chunks.json && !!chunks.bin, 'readGlb 取到 JSON 与 BIN 两个 chunk');
  check(chunks.json.asset.version === '2.0', 'readGlb 返回的 JSON 能解析');
  const roundTrip = convert.writeGlb(chunks.json, chunks.bin);
  const again = convert.readGlb(roundTrip);
  check(JSON.stringify(again.json) === JSON.stringify(chunks.json), 'writeGlb → readGlb 往返 JSON 不变');
  check(!!again.bin && !!chunks.bin && again.bin.length >= chunks.bin.length, 'BIN 往返不丢字节');
  check(roundTrip.byteLength % 4 === 0, '写出的 GLB 总长 4 字节对齐');
  check(convert.scaleGlb(glbBuffer, 1) === glbBuffer, 'scale = 1 时原样返回（不重写字节）');
  const scaledJson = convert.readGlb(convert.scaleGlb(glbBuffer, 0.5));
  const wrapNode = scaledJson.json.nodes[scaledJson.json.nodes.length - 1];
  check(JSON.stringify(wrapNode.scale) === '[0.5,0.5,0.5]', 'scaleGlb 加的是均匀缩放节点', JSON.stringify(wrapNode.scale));
  check(scaledJson.json.scenes[0].nodes.length === 1 &&
    scaledJson.json.scenes[0].nodes[0] === scaledJson.json.nodes.length - 1,
    '场景根被换成包裹节点（原来的根成为它的子节点）');
  check(!!scaledJson.bin && !!chunks.bin &&
    Buffer.compare(Buffer.from(scaledJson.bin), Buffer.from(chunks.bin)) === 0,
    '缩放没有改动 BIN 一个字节（缩放只发生在节点上）');
  const notGlb = (() => { try { convert.readGlb(new Uint8Array([1, 2, 3, 4]).buffer); return null; } catch (e) { return e; } })();
  check(!!notGlb, '非 GLB 输入抛错', notGlb && notGlb.message);
  const truncated = (() => { try { convert.readGlb(glbBuffer.slice(0, 40)); return null; } catch (e) { return e; } })();
  check(!!truncated, '被截断的 GLB 抛错，而不是返回半个场景', truncated && truncated.message);

  const selfCheck = await convert.selfCheck(glbBuffer);
  check(!('error' in selfCheck), 'three 的 GLTFLoader 能重新读回产物',
    'error' in selfCheck ? selfCheck.error : '');
  if (!('error' in selfCheck)) {
    check(JSON.stringify(selfCheck.clipNames) === JSON.stringify(['idle', 'run']),
      '读回的动作名一致', selfCheck.clipNames.join(','));
    check(selfCheck.bones === 2, '读回 2 根骨骼', String(selfCheck.bones));
    check(selfCheck.skinned === 1, '读回 1 个蒙皮网格', String(selfCheck.skinned));
    check(near(selfCheck.height, 1.6, 1e-3), '读回高度 1.6', String(selfCheck.height));
  }

  // Scale: the auto decision applied to a centimetre model must be visible in the written file.
  // This is the assertion that caught the parent-Group scaling bug: scaling a skinned scene through a
  // real parent node scaled it TWICE (0.00016 instead of 0.016), see convert.ts::wrapSceneRoot.
  const scaled = await convert.exportScene(merged.root, { format: 'glb', animations: [], scale: 0.01 });
  const scaledCheck = await convert.selfCheck(await scaled.blob.arrayBuffer());
  check(!('error' in scaledCheck) && near(scaledCheck.height, 1.6 * 0.01, 1e-4),
    '×0.01 后写出的高度是 1.6 厘米（只缩放了一次）',
    'error' in scaledCheck ? scaledCheck.error : String(scaledCheck.height));
  check(!('error' in selfCheck) && !('error' in scaledCheck) &&
    near(scaledCheck.height * 100, selfCheck.height, 0.01),
    '缩放后的高度正好是原来的 1/100');
  check(scaledCheck.clipNames.length === 0, '关掉动画就是静态模型');

  // The non-binary format must embed its buffer, or the .gltf would not be self-contained.
  const gltf = await convert.exportScene(merged.root, { format: 'gltf', animations: merged.clips, scale: 1 });
  const gltfText = await gltf.blob.text();
  const gltfJson = JSON.parse(gltfText);
  check(gltfJson.buffers[0].uri.startsWith('data:'), '.gltf 的 buffer 是内嵌 data URI',
    String(gltfJson.buffers[0].uri).slice(0, 32));
  check(gltfJson.animations.length === 2, '.gltf 里也有两个动画');
  const gltfCheck = await convert.selfCheck(new TextEncoder().encode(gltfText).buffer);
  check(!('error' in gltfCheck) && JSON.stringify(gltfCheck.clipNames) === JSON.stringify(['idle', 'run']),
    'gltf（JSON）也能被 GLTFLoader 读回', 'error' in gltfCheck ? gltfCheck.error : gltfCheck.clipNames.join(','));

  // `loadFbxFile` is the path the UI actually uses (a picked/dropped File, not an ArrayBuffer).
  const asFile = await convert.loadFbxFile(new File([sampleBuffer], 'idle.fbx', { type: 'application/octet-stream' }));
  check(asFile.file === 'idle.fbx' && asFile.clips.length === 2, 'loadFbxFile 走 File 也是同一条管线');
  const bogus = await convert.parseFbx(new TextEncoder().encode('not an fbx').buffer, 'x.fbx')
    .then(() => null, (e) => e);
  check(!!bogus, '非 FBX 输入会抛错（由调用方展示给用户）', bogus && bogus.message);
}

// =============================================================================================
// 9. 设置 API 契约（未知键在保存时保留）
// =============================================================================================
section('9. 设置 API：PUT 整个 scope、保留未知键、失败不抛错');
{
  const shared = await import(new URL('../dist/shared/src/settings.js', import.meta.url).href);
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200, json: async () => ({ value: { convert: { portrait: { format: 'gltf' } } } }) };
  };
  try {
    const payload = { convert: { portrait: { format: 'gltf' }, landscape: { format: 'gltf' } }, unknownKey: 42 };
    const saved = await shared.saveSettings('fbx2glb', payload);
    check(saved.ok, 'saveSettings 成功路径');
    check(calls.length === 1 && calls[0].url === '/api/settings/fbx2glb', '打到 /api/settings/fbx2glb',
      calls[0] && calls[0].url);
    check(calls[0].init.method === 'PUT', '用 PUT');
    const body = JSON.parse(calls[0].init.body);
    check(body.unknownKey === 42, '未知键原样提交（旧客户端不会抹掉新键）');
    check(body.convert.landscape.format === 'gltf', '两个方向都提交');

    const loaded = await shared.loadSettings('fbx2glb');
    check(loaded.ok && loaded.value.convert.portrait.format === 'gltf', 'loadSettings 读回 scope');
    check(calls[1].url === '/api/settings/fbx2glb', '读也用同一个 URL');

    globalThis.fetch = async () => { throw new Error('offline'); };
    const failed = await shared.saveSettings('fbx2glb', {});
    check(!failed.ok && failed.error.includes('offline'), '离线时返回错误而不是抛错（UI 显示「仅本地生效」）');
  } finally {
    globalThis.fetch = realFetch;
  }
}

// =============================================================================================
// 10. 源码 / 产物不变量：不上传、没有 localStorage、DOM 契约、vendor 一致
// =============================================================================================
section('10. 产物不变量：本地转换、DOM 契约、vendor');
{
  const html = readFileSync(new URL('../dist/apps/fbx2glb/index.html', import.meta.url), 'utf8');
  const jsFiles = [
    new URL('../dist/apps/fbx2glb/main.js', import.meta.url),
    ...readdirSync(new URL('../dist/apps/fbx2glb/src/', import.meta.url))
      .filter((f) => f.endsWith('.js'))
      .map((f) => new URL('../dist/apps/fbx2glb/src/' + f, import.meta.url)),
  ];
  const js = jsFiles.map((f) => readFileSync(f, 'utf8')).join('\n');

  check(/<script type="importmap">/.test(html), 'index.html 声明了 importmap');
  check(/"three":\s*"\.\/vendor\/three\.module\.min\.js"/.test(html), 'importmap 把 three 指到 vendored 构建');
  check(existsSync(new URL('../dist/apps/fbx2glb/vendor/three.module.min.js', import.meta.url)), 'vendored three 存在');

  // Both shapes count: the `byId(...)` helper (main.ts) and any direct getElementById call.
  const ids = [...js.matchAll(/getElementById\(['"]([^'"]+)['"]\)|byId\(['"]([^'"]+)['"]\)/g)]
    .map((m) => m[1] ?? m[2]);
  const uniqueIds = [...new Set(ids)];
  const missing = uniqueIds.filter((id) => !new RegExp('id="' + id + '"').test(html));
  check(uniqueIds.length >= 20, '查到足够多的 DOM 契约（' + uniqueIds.length + ' 个 id）');
  check(missing.length === 0, 'JS 里取的每个 id 都在 index.html 里', missing.join(','));

  // Comments are stripped first: several files explain in prose that they do NOT use localStorage,
  // and a naive grep cannot tell an explanation from a call.
  const codeOnly = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
  check(!/localStorage\s*[.[]/.test(codeOnly), '不使用 localStorage（设置必须走服务器）');
  check(!/XMLHttpRequest/.test(codeOnly), '不使用 XMLHttpRequest');
  check(!/new\s+FormData|new\s+Blob\(\[\s*form/.test(codeOnly), '不使用 FormData（没有上传路径）');
  const fetches = [...js.matchAll(/fetch\(([^)]*)/g)].map((m) => m[1].trim());
  check(fetches.length > 0 && fetches.length <= 8, 'fetch 调用点屈指可数（' + fetches.length + '）', fetches.join(' | '));
  // Two kinds are allowed, and nothing else: the app's own bundled sample assets, and the portal's
  // relative /api/ routes (settings + the publish action). Absolute URLs are forbidden outright — that
  // is the assertion that keeps "your model can only ever be sent to this device's own server" true.
  check(fetches.every((f) => f.includes("'./assets/") || f.startsWith("'/api/")),
    '每一处 fetch 要么是自带样例资源、要么是同源的 /api/ 路由', fetches.join(' | '));
  check(fetches.every((f) => !/https?:/.test(f)), '没有任何绝对地址（源码级不可能把模型发到别处）', fetches.join(' | '));
  const htmlOfPublish = html;
  check(/发布/.test(htmlOfPublish) && /id="pubTarget"/.test(htmlOfPublish), '页面里有发布卡片');

  const referenced = [...new Set([...js.matchAll(/vendor\/(?:addons\/[A-Za-z0-9_/.\[\]-]+|meshopt\/[A-Za-z0-9_.-]+)\.js/g)].map((m) => m[0]))];
  check(referenced.length >= 5, '源码里引用了 ' + referenced.length + ' 个 vendor 模块（three addon + meshoptimizer）',
    referenced.join(' '));
  const absent = referenced.filter((p) => !existsSync(new URL('../dist/apps/fbx2glb/' + p, import.meta.url)));
  check(absent.length === 0, '引用到的 vendor addon 都在 dist 里', absent.join(','));

  const md5 = (buf) => createHash('md5').update(buf).digest('hex');
  const ourThree = md5(readFileSync(new URL('../dist/apps/fbx2glb/vendor/three.module.min.js', import.meta.url)));
  const shooterThree = md5(readFileSync(new URL('../dist/apps/shooter/vendor/three.module.min.js', import.meta.url)));
  check(ourThree === shooterThree, '两个子应用 vendored 的是同一份 three（版本一致）', ourThree);

  const manifest = JSON.parse(readFileSync(new URL('../dist/apps/fbx2glb/manifest.json', import.meta.url), 'utf8'));
  check(manifest.id === 'fbx2glb', 'manifest.id 与目录名一致（注册表按目录名扫描）');
  check(manifest.order === 6, '排序号 6（排在射击之后）');
  check(typeof manifest.icon === 'string' && manifest.icon.length > 0, '有图标');
  check(!manifest.orientation, '不声明屏幕方向（转换器横竖都能用）');
}

// =============================================================================================
// 11. 真实装配层：用 DOM shim 启动 dist/main.js，走一遍「载入样例 → 转换 → 下载」
// =============================================================================================
// The pure modules above cannot prove that the PAGE is wired: an id typo, a wrong element type or a
// boot-order mistake (the panel reads back into `main.ts` while it is still being constructed — a real
// temporal-dead-zone crash that this section now guards) only shows up when the module actually runs.
// The same run also drives 「发布」 end to end against an in-memory asset API, so the one feature that
// writes to the server is proven to (a) send exactly one PUT of the real product Blob, (b) name the
// target from the manifest, (c) refuse a format the target does not accept, and (d) never fire during
// a conversion.
// The shim below is deliberately faithful to the handful of DOM APIs the app uses; element ids and
// tags are taken FROM index.html, so a control that stops existing fails here too.
section('11. 装配层：DOM shim 启动真实 main.js，跑完整用户流程');
{
  const htmlText = readFileSync(new URL('../dist/apps/fbx2glb/index.html', import.meta.url), 'utf8');
  const elementIds = [...htmlText.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g)].map((m) => ({ tag: m[1], id: m[2] }));
  check(elementIds.length >= 25, 'index.html 里解析出 ' + elementIds.length + ' 个带 id 的元素');

  function makeElement(tag, id) {
    let text = '';
    const el = {
      tagName: String(tag).toUpperCase(), id, children: [], parentNode: null,
      style: {}, dataset: {}, className: '', value: '', checked: false, disabled: false,
      hidden: false, min: '', max: '', step: '', type: '', href: '', download: '', rel: '',
      title: '', files: [], scrollTop: 0, scrollHeight: 0, childElementCount: 0,
      listeners: new Map(),
      classList: {
        _set: new Set(),
        add(...c) { c.forEach((x) => this._set.add(x)); },
        remove(...c) { c.forEach((x) => this._set.delete(x)); },
        contains(c) { return this._set.has(c); },
        toggle(c, on) { if (on === undefined) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); } else if (on) this._set.add(c); else this._set.delete(c); },
      },
      addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); },
      removeEventListener() {},
      appendChild(child) { this.children.push(child); child.parentNode = this; this.childElementCount = this.children.length; return child; },
      removeChild(child) { const i = this.children.indexOf(child); if (i >= 0) this.children.splice(i, 1); this.childElementCount = this.children.length; return child; },
      remove() { if (this.parentNode) this.parentNode.removeChild(this); },
      get firstElementChild() { return this.children[0] ?? null; },
      setAttribute(k, v) { this[k] = v; },
      getAttribute(k) { return this[k] ?? null; },
      removeAttribute(k) { delete this[k]; },
      getContext() { return null; },
      click() { this.dispatch('click'); },
      focus() {}, blur() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
      dispatch(type, extra = {}) {
        const event = { type, target: this, preventDefault() {}, stopPropagation() {}, ...extra };
        for (const fn of this.listeners.get(type) ?? []) fn(event);
      },
    };
    Object.defineProperty(el, 'textContent', {
      get() { return this.children.length > 0 ? this.children.map((c) => c.textContent).join('') : text; },
      set(v) { text = String(v); this.children.length = 0; this.childElementCount = 0; },
    });
    return el;
  }

  const elements = new Map(elementIds.map(({ tag, id }) => [id, makeElement(tag, id)]));
  const created = [];
  globalThis.document = {
    getElementById: (id) => elements.get(id) ?? null,
    // canvas + img are the two real browser APIs the export/texture path uses; everything else is a
    // plain element stub.
    createElement: (tag) => (tag === 'canvas' ? fakeCanvas() : (() => { const el = makeElement(tag, ''); created.push(el); return el; })()),
    createElementNS: (_ns, tag) => (tag === 'img' ? fakeImage() : (() => { const el = makeElement(tag, ''); created.push(el); return el; })()),
    documentElement: makeElement('html', ''),
    body: makeElement('body', ''),
    addEventListener() {},
  };
  globalThis.window = {
    innerWidth: 800, innerHeight: 600, devicePixelRatio: 1,
    setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a),
    addEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  };

  // fetch: the app's own sample asset, the settings API, and the publish API. Anything else is a bug
  // (section 10 asserts the source can only reach those). The asset API is modelled in memory — INCLUDING
  // its overwrite semantics (`replaced`) — because the UI's messages depend on that field.
  // The REAL fetch, kept so this section can put it back: it installs a recording shim below, and
  // leaving that shim installed would break every later section that needs the network (every
  // unexpected URL makes it throw) — which is exactly what §15's temporary server tripped over.
  const outerFetch = globalThis.fetch;
  const requests = [];
  const published = {};        // appId -> [{ name, bytes, mtime }]
  const assetPuts = [];        // every PUT to /api/assets/*, with its body
  const assetDeletes = [];
  const TARGET_APPS = [
    { id: 'shooter', name: '射击竞技场', assets: { accepts: ['glb'] } },
    { id: 'cards', name: '卡牌游戏', assets: { accepts: ['png'] } },
    { id: 'notes', name: '随手记' }, // no `assets` at all: must never be offered as a target
  ];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    const u = String(url);
    if (u === '/api/manifest') {
      return { ok: true, status: 200, json: async () => ({ apps: TARGET_APPS }) };
    }
    if (u.startsWith('/api/assets/')) {
      const rest = u.slice('/api/assets/'.length);
      const slash = rest.indexOf('/');
      const appId = slash < 0 ? rest : rest.slice(0, slash);
      const name = slash < 0 ? '' : rest.slice(slash + 1);
      const list = published[appId] ?? (published[appId] = []);
      if (init.method === 'PUT') {
        assetPuts.push({ url: u, appId, name, body: init.body, type: (init.headers ?? {})['Content-Type'] });
        const at = list.findIndex((f) => f.name === name);
        const replaced = at >= 0;
        const entry = { name, bytes: init.body?.size ?? 0, mtime: Date.now() };
        if (replaced) list[at] = entry; else list.push(entry);
        return { ok: true, status: replaced ? 200 : 201, json: async () => ({ app: appId, name, bytes: entry.bytes, replaced, url: '/assets/' + appId + '/' + name }) };
      }
      if (init.method === 'DELETE') {
        assetDeletes.push(u);
        const at = list.findIndex((f) => f.name === name);
        if (at >= 0) list.splice(at, 1);
        return { ok: true, status: 200, json: async () => ({ app: appId, name, deleted: true }) };
      }
      return { ok: true, status: 200, json: async () => ({ app: { id: appId, name: appId }, accepts: [], files: list }) };
    }
    if (String(url).includes('sample-textured.fbx')) {
      const bytes = readFileSync(new URL('../dist/apps/fbx2glb/assets/sample-textured.fbx', import.meta.url));
      return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    }
    if (String(url).includes('sample_body_diffuse.png')) {
      return { ok: true, status: 200, blob: async () => new Blob([SAMPLE_PNG], { type: 'image/png' }) };
    }
    if (String(url).includes('sample.fbx')) {
      return { ok: true, status: 200, arrayBuffer: async () => sampleBuffer.slice(0) };
    }
    if (String(url).includes('/api/settings/')) {
      return { ok: true, status: 200, json: async () => ({ value: null }) };
    }
    throw new Error('unexpected fetch: ' + url);
  };
  const realCreateObjectURL = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  const objectUrls = [];
  URL.createObjectURL = (blob) => { const u = 'blob:test/' + objectUrls.length; objectUrls.push(blob); return u; };
  URL.revokeObjectURL = () => {};
  const realSetTimeout = globalThis.setTimeout;

  const tick = () => new Promise((r) => realSetTimeout(r, 0));
  const settle = async (n = 40) => { for (let i = 0; i < n; i++) await tick(); };
  const logText = () => elements.get('log').children.map((c) => c.textContent).join('\n');

  try {
    await import(new URL('../dist/apps/fbx2glb/main.js', import.meta.url).href);
    await settle();
    check(elements.get('saveState').textContent.includes('默认值'), '启动后从服务器读到「没有存过设置」→ 使用默认值',
      elements.get('saveState').textContent);
    check(elements.get('convertBtn').disabled === true, '没有文件时转换按钮是禁用的');
    check(elements.get('previewFallback').hidden === false && elements.get('previewCanvas').hidden === true,
      '没有 WebGL 时显示降级说明并隐藏画布（createPreview 返回 null）');

    // ---- 载入样例 ----
    elements.get('sampleBtn').dispatch('click');
    await settle();
    check(elements.get('fileList').children.length === 1, '样例出现在文件列表里');
    const fileMeta = elements.get('fileList').children[0].children[1].textContent;
    check(fileMeta.includes('2 动作') && fileMeta.includes('2 骨骼'), '列表行报告骨骼/动作数', fileMeta);
    check(elements.get('convertBtn').disabled === false, '有可解析文件后转换按钮可用');
    check(logText().includes('sample.fbx') && logText().includes('解析完成'), '日志记录了样例的读取与解析');

    // ---- 转换（默认：GLB + 合并 + 按文件名） ----
    elements.get('convertBtn').dispatch('click');
    await settle(120);
    check(elements.get('results').children.length === 1, '产出一行结果', String(elements.get('results').children.length));
    const resultText = elements.get('results').children[0].textContent;
    check(resultText.includes('sample.glb'), '产物名来自输入文件名 + 设置的扩展名', resultText.slice(0, 60));
    check(resultText.includes('动作：sample、sample-2'),
      '默认按文件名命名 + 去重（同一个文件里的两个 take → sample / sample-2）', resultText.slice(0, 120));
    check(resultText.includes('自检通过'), '产物行带自检结果', resultText.slice(0, 200));
    check(!resultText.includes('轨道找不到节点'), '自检报告里没有「轨道绑定不上」的告警');
    check(objectUrls.length === 0, '转换本身不创建下载 URL（只有真的点下载才创建，产物一直握在 Blob 里）');

    // ---- 点下载：走的是 Blob URL，不是网络 ----
    // Found by LABEL, not by child index: the row also carries a 发布 button now (index-based lookup
    // would silently grab the wrong one).
    const buttonsIn = (el) => {
      const out = [];
      const walk = (n) => { for (const c of n.children ?? []) { if (c.tagName === 'BUTTON') out.push(c); walk(c); } };
      walk(el);
      return out;
    };
    const rowOf = (prefix) => elements.get('results').children
      .find((r) => r.children[0].children[0].textContent.startsWith(prefix));
    const btnByLabel = (el, re) => buttonsIn(el).find((b) => re.test(b.textContent));
    const before = requests.length;
    btnByLabel(rowOf('sample'), /^下载/).dispatch('click');
    await settle();
    check(requests.length === before, '点下载没有产生任何网络请求');
    check(logText().includes('已下载'), '日志记录了下载');
    const blob = objectUrls[objectUrls.length - 1];
    check(!!blob && blob.size > 1000, '下载的 Blob 有内容', blob ? names.formatBytes(blob.size) : 'none');

    // ---- 发布到游戏：一键写进目标应用的外部资产目录 ----
    check(assetPuts.length === 0, '转换 + 下载全程没有发过任何发布请求（发布是显式动作）', String(assetPuts.length));
    check(requests.filter((r) => r.url === '/api/manifest').length === 1,
      '启动时读一次 /api/manifest 来发现目标应用（转换器不写死任何游戏）',
      String(requests.filter((r) => r.url === '/api/manifest').length));
    elements.get('pubRefresh').dispatch('click');
    await settle(20);
    check(elements.get('pubTarget').children.length === 3,
      '目标下拉 = 「自动」+ 两个声明接收资产的应用（没声明的 notes 不出现）',
      elements.get('pubTarget').children.map((o) => o.value).join(','));
    check(elements.get('pubTarget').value === '', '默认停在「自动」', elements.get('pubTarget').value);
    check(elements.get('pubState').textContent.includes('射击竞技场'),
      '「自动」解析成第一个目标（射击竞技场）', elements.get('pubState').textContent);
    check(elements.get('pubList').children.length === 0, '还没发布过 → 列表为空');
    const pubBtn = btnByLabel(rowOf('sample'), /^发布到/);
    check(!!pubBtn && pubBtn.disabled === false, 'GLB 产物上的「发布」按钮可用', pubBtn ? pubBtn.textContent : 'missing');
    check(btnByLabel(rowOf('sample'), /^发布到/).title.includes('data/assets/shooter/'),
      '按钮提示里给出将写入的目录', btnByLabel(rowOf('sample'), /^发布到/).title);
    pubBtn.dispatch('click');
    await settle(20);
    check(assetPuts.length === 1, '点一次发布 = 一次 PUT', String(assetPuts.length));
    check(assetPuts[0].url === '/api/assets/shooter/sample.glb', 'URL 是 /api/assets/<应用>/<产物名>.glb',
      assetPuts[0].url);
    check(assetPuts[0].type === 'model/gltf-binary', '按 GLB 二进制发（不是 base64 塞进 JSON）', assetPuts[0].type);
    check(assetPuts[0].body && assetPuts[0].body.size > 1000 && assetPuts[0].body === blob,
      '发出去的就是那个产物 Blob 本身（没有重新编码）', String(assetPuts[0].body && assetPuts[0].body.size));
    check(logText().includes('已发布 sample.glb') && logText().includes('/assets/shooter/sample.glb'),
      '日志写出实际资产名与游戏要用的 URL', logText().slice(-220));
    check(elements.get('pubList').children.length === 1 && elements.get('pubList').children[0].textContent.includes('sample.glb'),
      '已发布列表出现 1 行');
    check(elements.get('pubState').textContent.includes('1 个资产'), '状态行给出个数与总体积',
      elements.get('pubState').textContent);
    // 同名再发布：服务器回 replaced=true，UI 必须说出来（否则「我覆盖了什么」是隐形的）
    btnByLabel(rowOf('sample'), /^发布到/).dispatch('click');
    await settle(20);
    check(assetPuts.length === 2 && logText().includes('覆盖了同名资产'), '同名发布会明说「覆盖」');
    check(elements.get('pubList').children.length === 1, '覆盖不会在列表里多出一行');
    // 删除
    const delBtn = buttonsIn(elements.get('pubList').children[0]).find((b) => b.textContent === '✕');
    check(!!delBtn, '已发布行上有删除按钮');
    delBtn.dispatch('click');
    await settle(20);
    check(assetDeletes.length === 1 && assetDeletes[0] === '/api/assets/shooter/sample.glb',
      '删除打到同一个 URL 的 DELETE', assetDeletes.join(','));
    check(elements.get('pubList').children.length === 0, '删除后列表空了');
    check(logText().includes('已删除已发布资产 shooter/sample.glb'), '日志记录了删除', logText().slice(-160));

    // ---- 外部贴图：经由「载入样例（外部贴图）」走一遍 UI ----
    const logBefore = logText().length;
    elements.get('sampleTexBtn').dispatch('click');
    await settle(200);
    check(elements.get('textureList').children.length === 1, '样例贴图出现在贴图列表里',
      String(elements.get('textureList').children.length));
    check(elements.get('textureCount').textContent.includes('1 张图片'), '贴图计数更新',
      elements.get('textureCount').textContent);
    const texRow = elements.get('fileList').children.map((r) => r.textContent).find((t) => t.includes('sample-textured.fbx')) ?? '';
    check(texRow.includes('已补 1'), '文件行写明外部贴图已补上', texRow.slice(0, 140));
    check(texRow.includes('缺') === false, '没有「缺贴图」的提示', texRow.slice(0, 140));
    const texLog = logText().slice(logBefore);
    check(texLog.includes('← 你提供的 sample_body_diffuse.png'), '日志写出「谁补了谁」', texLog.slice(0, 200));
    check(elements.get('textureList').children[0].textContent.includes('已用于贴图'), '贴图行被标记为已使用',
      elements.get('textureList').children[0].textContent);

    // ---- 改设置：写两个方向 + 防抖后 PUT 整个 scope ----
    const puts = [];
    const prevFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      requests.push({ url: String(url), init });
      if (init.method === 'PUT') puts.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ value: null }) };
    };
    const formatSel = elements.get('optFormat');
    formatSel.value = 'gltf';
    formatSel.dispatch('change');
    check(puts.length === 0, '改选项不会立刻发请求（400ms 防抖）');
    await new Promise((r) => realSetTimeout(r, 600));
    check(puts.length === 1, '防抖后只发一次 PUT', String(puts.length));
    check(puts[0]?.convert?.portrait?.format === 'gltf' && puts[0]?.convert?.landscape?.format === 'gltf',
      'PUT 里两个方向都是新值（值没有方向语义，见 settings.ts）', JSON.stringify(puts[0]?.convert));
    check(elements.get('saveState').textContent.includes('已保存'), '状态行显示已保存', elements.get('saveState').textContent);

    // ---- 发布目标也是一个设置项：落盘 + 只影响界面（换目标不改任何转换参数） ----
    const putsBeforeTarget = puts.length;
    elements.get('pubTarget').value = 'cards';
    elements.get('pubTarget').dispatch('change');
    await new Promise((r) => realSetTimeout(r, 600));
    check(puts.length === putsBeforeTarget + 1 &&
      puts[puts.length - 1]?.publish?.portrait?.target === 'cards' &&
      puts[puts.length - 1]?.publish?.landscape?.target === 'cards',
      '换目标会落盘（两个方向都写）', JSON.stringify(puts[puts.length - 1]?.publish));
    check(elements.get('pubState').textContent.includes('卡牌游戏'), '界面立刻切到新目标',
      elements.get('pubState').textContent);
    const cardsBtn = btnByLabel(rowOf('sample'), /^发布到/);
    check(cardsBtn.disabled === true && cardsBtn.textContent.includes('卡牌游戏'),
      '换成不收 .glb 的目标后按钮禁用（并重新标了目标名）', cardsBtn.textContent);
    check(rowOf('sample').textContent.includes('只接收 .png'), '行内写出禁用原因（手机上 title 提示看不见）',
      rowOf('sample').textContent.slice(-120));
    elements.get('publishReset').dispatch('click');
    await new Promise((r) => realSetTimeout(r, 600));
    check(elements.get('pubTarget').value === '', '「恢复默认」把目标退回「自动」', elements.get('pubTarget').value);
    check(puts[puts.length - 1]?.publish === undefined, '「恢复默认」把 publish 整组从存储里删掉',
      JSON.stringify(puts[puts.length - 1]));
    check(btnByLabel(rowOf('sample'), /^发布到/).disabled === false, '回到自动目标后按钮又可用');

    // ---- 再转一次：扩展名跟着设置 ----
    elements.get('convertBtn').dispatch('click');
    await settle(120);
    const second = elements.get('results').children[0].textContent;
    check(second.includes('sample.gltf'), '第二次产物是 .gltf（设置真的生效了）', second.slice(0, 60));
    check(elements.get('results').children.length === 1, '重新转换会清空上一次的产物');
    const gltfPub = btnByLabel(rowOf('sample'), /^发布到/);
    check(gltfPub.disabled === true && rowOf('sample').textContent.includes('只接收 .glb'),
      '.gltf 产物发布不了只收 .glb 的目标（禁用 + 说明，不是发出去再报错）',
      rowOf('sample').textContent.slice(-140));
    check(assetPuts.length === 2, '禁用状态下点了也没有请求（这里没点，数量不变）', String(assetPuts.length));

    // ---- 减面卡片：设置 → 落盘 → 导出 → 日志 ----
    check(elements.get('optDecimate').checked === false, '减面默认关闭（有损操作不默认开启）');
    check(elements.get('optDecimateRatio').disabled === true, '关闭时参数置灰：界面直接反映「这些数现在不起作用」');
    check(elements.get('decimateReset').disabled === true, '没有覆盖项时「恢复默认」置灰');
    const putsBeforeDecimate = puts.length;
    elements.get('optDecimate').checked = true;
    elements.get('optDecimate').dispatch('change');
    await new Promise((r) => realSetTimeout(r, 600));
    check(puts.length === putsBeforeDecimate + 1, '改减面开关会落盘（防抖后一次）');
    check(puts[puts.length - 1]?.decimate?.portrait?.enabled === true &&
      puts[puts.length - 1]?.decimate?.landscape?.enabled === true, 'PUT 里两个方向都写了 true',
      JSON.stringify(puts[puts.length - 1]?.decimate));
    check(elements.get('optDecimateRatio').disabled === false, '打开后参数可用');
    const putsBeforeDrag = puts.length;
    elements.get('optDecimateRatio').value = '0.25';
    elements.get('optDecimateRatio').dispatch('input');
    check(elements.get('optDecimateRatioOut').textContent.includes('25%'), '拖动时读数实时更新',
      elements.get('optDecimateRatioOut').textContent);
    check(puts.length === putsBeforeDrag, '拖动过程中不落盘（松手才写）');
    elements.get('optDecimateRatio').dispatch('change');
    await new Promise((r) => realSetTimeout(r, 600));
    check(puts[puts.length - 1]?.decimate?.portrait?.ratio === 0.25, '松手后写入比例',
      JSON.stringify(puts[puts.length - 1]?.decimate));
    elements.get('convertBtn').dispatch('click');
    await settle(150);
    check(logText().includes('没有网格需要减面'), '日志解释了为什么没减（样例只有 12 面的盒子，低于下限）',
      logText().slice(-180));
    elements.get('decimateReset').dispatch('click');
    await new Promise((r) => realSetTimeout(r, 600));
    check(elements.get('optDecimate').checked === false, '恢复默认把减面关回去');
    check(elements.get('optDecimateRatio').value === '0.5', '比例回到 0.5（默认）',
      elements.get('optDecimateRatio').value);

    // ---- 贴图压缩卡片：开关 → 落盘 → 导出 → 日志 ----
    check(elements.get('optPack').checked === false, '贴图压缩默认关闭（有损操作）');
    check(elements.get('optPackSize').value === '2048', '默认最大边长 2048',
      elements.get('optPackSize').value);
    check(elements.get('optPackSize').disabled === true && elements.get('packReset').disabled === true,
      '关闭时参数与「恢复默认」都置灰');
    const putsBeforePack = puts.length;
    elements.get('optPack').checked = true;
    elements.get('optPack').dispatch('change');
    await new Promise((r) => realSetTimeout(r, 600));
    check(puts.length === putsBeforePack + 1 &&
      puts[puts.length - 1]?.texture?.portrait?.enabled === true &&
      puts[puts.length - 1]?.texture?.landscape?.enabled === true, '开关落盘（两个方向都写）',
      JSON.stringify(puts[puts.length - 1]?.texture));
    check(elements.get('optPackSize').disabled === false, '打开后可以选尺寸');
    elements.get('optPackSize').value = '512';
    elements.get('optPackSize').dispatch('change');
    await new Promise((r) => realSetTimeout(r, 600));
    check(puts[puts.length - 1]?.texture?.portrait?.maxSize === 512, '改尺寸会落盘',
      JSON.stringify(puts[puts.length - 1]?.texture));
    elements.get('convertBtn').dispatch('click');
    await settle(150);
    check(logText().includes('贴图压缩'), '日志里有贴图压缩的结论（样例没有大贴图，会说明没需要处理的）',
      logText().slice(-200));
    elements.get('packReset').dispatch('click');
    await new Promise((r) => realSetTimeout(r, 600));
    check(elements.get('optPack').checked === false && elements.get('optPackSize').value === '2048',
      '恢复默认回到「关闭 + 2048」', elements.get('optPackSize').value);

    // ---- 多文件 + 「不合并」：一个输入一个产物，各自按自己的文件名命名 ----
    const filesBefore = elements.get('fileList').children.length;
    const fi = elements.get('fileInput');
    fi.files = [new File([sampleBuffer.slice(0)], 'run.fbx', { type: 'application/octet-stream' })];
    fi.dispatch('change');
    await settle(80);
    check(elements.get('fileList').children.length === filesBefore + 1, '通过文件选择框再加一个文件',
      filesBefore + ' → ' + elements.get('fileList').children.length);
    check(elements.get('convertBtn').textContent.includes(`合并并转换（${filesBefore + 1} 个）`),
      '多个文件时按钮明说要合并', elements.get('convertBtn').textContent);

    elements.get('optMerge').checked = false;
    elements.get('optMerge').dispatch('change');
    await new Promise((r) => realSetTimeout(r, 600));
    check(elements.get('convertBtn').textContent.includes('转换为 GLTF'),
      '关掉合并后按钮改成单个产物的说法（扩展名跟随设置）', elements.get('convertBtn').textContent);
    elements.get('convertBtn').dispatch('click');
    await settle(150);
    check(elements.get('results').children.length === filesBefore + 1, '关掉合并 → 一个输入一个产物',
      String(elements.get('results').children.length));
    const outNames = elements.get('results').children.map((row) => row.children[0].children[0].textContent);
    check(outNames.some((n) => /^sample\.(glb|gltf)$/.test(n)) && outNames.some((n) => /^run\.(glb|gltf)$/.test(n)),
      '两个产物各按自己的文件名命名（扩展名跟随设置）', outNames.join(','));
    const rows = elements.get('results').children;
    const rowText = (prefix) => rows.find((r) => r.children[0].children[0].textContent.startsWith(prefix))?.textContent ?? '';
    check(rowText('sample').includes('sample、sample-2') && rowText('run').includes('run、run-2'),
      '每个产物只含自己文件里的动作（并按文件名去重命名）',
      rowText('sample').slice(0, 80) + ' | ' + rowText('run').slice(0, 80));

    elements.get('optMerge').checked = true;
    elements.get('optMerge').dispatch('change');
    await new Promise((r) => realSetTimeout(r, 600));
    elements.get('convertBtn').dispatch('click');
    await settle(150);
    check(elements.get('results').children.length === 1, '重新打开合并 → 又只剩一个产物');
    const mergedText = elements.get('results').children[0].textContent;
    check(['sample', 'sample-2', 'sample-textured', 'run', 'run-2'].every((n) => mergedText.includes(n)),
      '合并后每个输入的动作名齐全且不重名', mergedText.slice(0, 160));

    // ---- 拖拽：按扩展名分流（FBX 与图片混着拖进来） ----
    const filesBeforeDrop = elements.get('fileList').children.length;
    const texturesBeforeDrop = elements.get('textureList').children.length;
    elements.get('dropzone').dispatch('drop', {
      dataTransfer: {
        files: [
          new File([sampleBuffer.slice(0)], 'dropped-run.fbx', { type: 'application/octet-stream' }),
          new File([SAMPLE_PNG], 'dropped_body.png', { type: 'image/png' }),
        ],
      },
    });
    await settle(150);
    check(elements.get('fileList').children.length === filesBeforeDrop + 1, '拖进来的 .fbx 进 FBX 列表',
      filesBeforeDrop + ' → ' + elements.get('fileList').children.length);
    check(elements.get('textureList').children.length === texturesBeforeDrop + 1, '拖进来的图片进贴图列表',
      texturesBeforeDrop + ' → ' + elements.get('textureList').children.length);

    // ---- 读不到子应用列表：发布降级为禁用，而不是崩或静默 ----
    const onlineFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('offline'); };
    elements.get('pubRefresh').dispatch('click');
    await settle(20);
    check(logText().includes('读不到子应用列表，发布不可用'), '离线刷新会在日志里说明原因', logText().slice(-180));
    check(btnByLabel(rowOf('sample'), /^发布到/) === undefined ||
      btnByLabel(rowOf('sample'), /^发布到/).disabled === true,
      '没有目标时发布按钮是禁用的');
    globalThis.fetch = onlineFetch;

    // ---- 恢复默认清空整组 ----
    const putsBeforeReset = puts.length;
    elements.get('convertReset').dispatch('click');
    await new Promise((r) => realSetTimeout(r, 600));
    check(elements.get('optFormat').value === 'glb', '恢复默认把格式退回 glb');
    check(elements.get('convertReset').disabled === true, '恢复默认后按钮自己变灰（没有覆盖项了）');
    check(puts.length === putsBeforeReset + 1, '恢复默认会真的再发一次 PUT（否则改动只活在内存里）',
      putsBeforeReset + ' → ' + puts.length);
    check(puts[puts.length - 1]?.convert === undefined, '恢复默认把 convert 整组从存储里删掉',
      JSON.stringify(puts[puts.length - 1]));

    // ---- 清空 ----
    elements.get('clearBtn').dispatch('click');
    await settle();
    check(elements.get('fileList').children.length === 0 && elements.get('results').children.length === 0,
      '清空会同时清掉文件列表与产物');
    check(elements.get('textureList').children.length === 0, '清空也会清掉贴图列表');
    check(elements.get('convertBtn').disabled === true, '清空后转换按钮再次禁用');
    globalThis.fetch = prevFetch;
  } finally {
    URL.createObjectURL = realCreateObjectURL;
    URL.revokeObjectURL = realRevoke;
    globalThis.fetch = outerFetch;
  }
}

// =============================================================================================
// 12. 外部贴图：贴图与 FBX 分体时的匹配、加载与内嵌
// =============================================================================================
// The case this section exists for: an FBX whose material points at `sample_body_diffuse.png` as a
// SIBLING FILE. Dropping the .fbx alone gives the loader nothing to resolve against; supplying the
// image must (a) be matched by name, (b) go through the loader's own texture pipeline so the flags
// (sRGB on the colour map, FBX wrap modes) are the loader's, not a second opinion, and (c) end up
// EMBEDDED in the exported GLB, or the file is not self-contained any more.
section('12. 外部贴图：名字匹配 → 材质槽 → 内嵌进 GLB');
{
  const textures = await import(new URL('../dist/apps/fbx2glb/src/textures.js', import.meta.url).href);
  const pngBytes = SAMPLE_PNG;
  const pngBlob = new Blob([pngBytes], { type: 'image/png' });

  // ---- 12.1 纯规则 ----
  check(textures.baseFileName('a\\b\\c.png') === 'c.png', '反斜杠路径也只取文件名', textures.baseFileName('a\\b\\c.png'));
  check(textures.nameKey(' "C:\\T\\Body_Diffuse.PNG" ') === 'body_diffuse.png', '匹配键：去路径/引号/空格 + 小写',
    textures.nameKey(' "C:\\T\\Body_Diffuse.PNG" '));
  check(textures.stemKey('Body_Diffuse.PNG') === 'body_diffuse', '主干名去掉扩展名');
  check(textures.extensionOf('a/b/c.PNG') === 'png', '扩展名小写化');
  check(textures.extensionOf('noext') === '', '没有扩展名就是空串');
  check(textures.isImageFileName('x.jpg') && textures.isImageFileName('X.JPEG') && !textures.isImageFileName('x.fbx') &&
    !textures.isImageFileName('x.tga'), '图片扩展名判定（.tga 不在可解码列表里）');

  const index = textures.buildTextureIndex([
    { name: 'textures/Body_Diffuse.PNG', blob: pngBlob },
    { name: 'other.png', blob: pngBlob },
  ]);
  check(textures.matchTexture(index, 'body_diffuse.png')?.rule === 'name', '按名字匹配（忽略路径与大小写）');
  check(textures.matchTexture(index, 'Body_Diffuse.tga')?.rule === 'stem', '扩展名不同时按主干名匹配（.tga → .png）');
  check(textures.matchTexture(index, 'nope.png') === null, '配不上就是 null（不会乱配）');
  check(textures.matchTexture(index, '') === null, '空引用不匹配');
  const dupIndex = textures.buildTextureIndex([
    { name: 'a.png', blob: new Blob(['first']) },
    { name: 'A.PNG', blob: new Blob(['second']) },
  ]);
  check(textures.matchTexture(dupIndex, 'a.png')?.entry.source === 'a.png', '重名文件以第一个为准（结果不依赖选择顺序）');

  // ---- 12.2 URL 重写：把引用换成 blob: URL，让 loader 自己加载 ----
  const report = textures.emptyTextureReport();
  const session = textures.createTextureSession(index, report);
  const manager = session.manager;
  const resolved = manager.resolveURL('body_diffuse.png');
  check(typeof resolved === 'string' && resolved.startsWith('blob:'), '外部引用被换成 blob: URL（loader 自己加载）', resolved);
  check(report.requested.length === 1 && report.requested[0].provided === 'textures/Body_Diffuse.PNG',
    '报告记录了「谁补了谁」', JSON.stringify(report.requested[0]));
  const dataUrl = 'data:image/png;base64,AAAA';
  check(manager.resolveURL(dataUrl) === dataUrl, '内嵌 data: URL 原样通过（不能被改写）');
  const blobUrl = 'blob:http://x/y';
  check(manager.resolveURL(blobUrl) === blobUrl, '已经是 blob: 的原样通过');
  check(manager.resolveURL('missing.png') === 'missing.png', '没配上的原样返回（浏览器会 404，报告里记为缺）');
  check(report.requested.length === 2 && report.requested[1].provided === null, '缺的那张也进了报告');
  manager.resolveURL('body_diffuse.png');
  check(report.requested.length === 2, '同一个名字问多少次都只记一条');

  // ---- 12.3 槽位扫描与分类（合成场景） ----
  const scene = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial();
  mat.name = 'SynthMat';
  const empty = new THREE.Texture();
  empty.name = 'synth_diffuse.tga';
  mat.map = empty;
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat));
  check(textures.textureSlots(scene).length === 1, '扫描到 1 个纹理槽', String(textures.textureSlots(scene).length));
  check(textures.pendingTextureSlots(scene).length === 1, '没有像素的槽算「待补」');
  const synthReport = textures.emptyTextureReport();
  await textures.applyTextureFallback(scene, index, synthReport, async () => ({ width: 8, height: 8 }));
  check(synthReport.fallback.length === 0, '索引里没有合成名对应的文件 → 不回填');
  const synthIndex = textures.buildTextureIndex([{ name: 'synth_diffuse.png', blob: pngBlob }]);
  await textures.applyTextureFallback(scene, synthIndex, synthReport, async () => ({ width: 8, height: 8 }));
  check(synthReport.fallback.length === 1 && synthReport.fallback[0].rule === 'stem',
    '占位槽按主干名回填（.tga 引用 + .png 文件）', JSON.stringify(synthReport.fallback));
  check(mat.map.image !== null && mat.map.version > 0, '回填后贴图有了像素并标记了更新（version 自增）',
    'image=' + (mat.map.image !== null) + ' version=' + mat.map.version);
  check(textures.finishTextureReport(scene, synthIndex, synthReport).withImage === 1, '终判：1 个槽有像素');

  // ---- 12.4 真样例（不带贴图）：必须报告缺哪一张 ----
  const texBytes = readFileSync(new URL('../dist/apps/fbx2glb/assets/sample-textured.fbx', import.meta.url));
  const texBuffer = texBytes.buffer.slice(texBytes.byteOffset, texBytes.byteOffset + texBytes.byteLength);
  const bare = await convert.parseFbx(texBuffer.slice(0), 'sample-textured.fbx', { textureTimeoutMs: 3000 });
  check(textures.externalCounts(bare.textures).external === 1, '识别出 1 个外部贴图引用',
    JSON.stringify(textures.externalCounts(bare.textures)));
  check(bare.textures.requested[0]?.wanted === 'sample_body_diffuse.png', '引用名就是文件名',
    bare.textures.requested[0]?.wanted);
  check(textures.externalCounts(bare.textures).filled === 0, '没提供时为 0 张已补');
  check(bare.textures.missing.length === 1, '报告里 1 个槽为空', JSON.stringify(bare.textures.missing));
  check(textures.reportNeedsTextures(bare.textures), '「还缺贴图」为真（这会触发补图后的重新解析）');
  check(textures.textureSummaryText(bare.textures).includes('缺 1'), '摘要里写明缺几张',
    textures.textureSummaryText(bare.textures));
  // 缺贴图的槽必须被「摘掉」而不是留着：GLTFExporter 对没有像素的贴图会**整个导出失败**
  // （`No valid image data found`，实测），所以 "没配上的槽会空着" 这句文档要由代码来成立。
  check(bare.textures.dropped === 1, '缺贴图的槽在导出前被摘掉（否则导出器会直接抛错）',
    String(bare.textures.dropped));
  const bareMat = bare.root.getObjectByName('Body').material;
  check(bareMat.map === null, '材质上不再挂着没有像素的贴图对象', String(bareMat.map));
  check(textures.textureSlots(bare.root).length === 0, '场景里已经没有空贴图槽');
  check(bare.textures.missing.length === 1, '但报告仍然记得缺的是哪一个（摘掉 ≠ 忘掉）',
    JSON.stringify(bare.textures.missing));
  check(bare.clips.length === 2, '贴图缺失不影响动画解析');
  // 真正的回归门：这一条在修复前会红（导出器 throw），现在必须能导出、且产物里没有图。
  {
    const bareOut = await convert.exportScene(bare.root, { format: 'glb', animations: [], scale: 1 });
    const bareBuffer = await bareOut.blob.arrayBuffer();
    const bareJson = convert.readGlb(bareBuffer).json;
    check(!bareJson.images || bareJson.images.length === 0, '缺贴图的模型照样导出成功，只是产物里没有图',
      JSON.stringify(bareJson.images ?? null));
    check(!!bareJson.materials && bareJson.materials.length === 1, '材质本身还在（用材质自己的颜色）',
      String(bareJson.materials && bareJson.materials.length));
  }

  // ---- 12.5 真样例（带贴图）：loader 自己加载 → 内嵌进 GLB ----
  // Headless stand-ins for the two browser APIs this path needs: an <img> that fires load for
  // blob:/data: URLs, and a canvas whose toBlob hands back real PNG bytes. Everything else (FBXLoader,
  // the loading manager, GLTFExporter's image path) is the real thing.
  const realDocument = globalThis.document;
  globalThis.document = {
    createElementNS: (_ns, tag) => (tag === 'img' ? fakeImage() : { style: {} }),
    createElement: (tag) => (tag === 'canvas' ? fakeCanvas() : { style: {}, appendChild() {}, remove() {} }),
    body: { appendChild() {}, removeChild() {} },
    documentElement: { classList: { add() {}, remove() {}, toggle() {}, contains: () => false } },
    getElementById: () => null,
    addEventListener() {},
  };
  try {
    const withTex = await convert.parseFbx(texBuffer.slice(0), 'sample-textured.fbx', {
      textures: [{ name: 'sample_body_diffuse.png', blob: pngBlob }],
      textureTimeoutMs: 3000,
    });
    check(!withTex.textures.timedOut, '等待贴图没有超时（loader 真的把它加载完了）');
    check(textures.externalCounts(withTex.textures).filled === 1, '1 张外部贴图已补上');
    check(withTex.textures.missing.length === 0, '不再有缺的槽');
    check(withTex.textures.fallback.length === 0, '走的是主路线（loader 自己加载），不需要按名回填');
    check(withTex.textures.dropped === 0, '提供了贴图时什么都不摘（槽真的有像素）', String(withTex.textures.dropped));
    const map = withTex.root.getObjectByName('Body').material.map;
    check(!!map && map.image !== null && map.image !== undefined, '材质槽拿到了真实图像对象');
    check(map.colorSpace === THREE.SRGBColorSpace, '颜色贴图的 sRGB 标记由 FBXLoader 设置（不是我们另写一套）');
    check(map.wrapS === THREE.RepeatWrapping && map.wrapT === THREE.RepeatWrapping,
      '包裹模式来自 FBX 的 wrap 设置');
    check(map.flipY === true, 'flipY 与内嵌贴图路径一致（同一个 loader 代码）');
    check(textures.providedFileNames(withTex.textures)[0] === 'sample_body_diffuse.png', '报告列出补图来源');
    check(!textures.reportNeedsTextures(withTex.textures), '补齐后不再需要重新解析');

    // export it and look INSIDE the written GLB
    const out = await convert.exportScene(withTex.root, {
      format: 'glb', animations: withTex.clips, scale: 1,
    });
    const buf = Buffer.from(await out.blob.arrayBuffer());
    const jsonLength = buf.readUInt32LE(12);
    const json = JSON.parse(buf.subarray(20, 20 + jsonLength).toString('utf8'));
    check((json.images ?? []).length === 1, 'GLB 内嵌了 1 张图片', JSON.stringify((json.images ?? []).map((i) => i.mimeType)));
    check(json.images[0].mimeType === 'image/png', 'MIME 是 image/png', json.images[0].mimeType);
    check(json.images[0].bufferView !== undefined && json.images[0].uri === undefined,
      '图片是 bufferView（真正嵌进 BIN），不是外部 uri');
    check(!JSON.stringify(json).includes('"uri"'), '整份 JSON 依然没有 uri（自包含）');
    check((json.textures ?? []).length >= 1 && (json.samplers ?? []).length >= 1, '写出了 texture + sampler');
    const bodyMat = json.materials.find((m) => m.name === 'BodyMat');
    check(!!bodyMat?.pbrMetallicRoughness?.baseColorTexture, '材质真的挂上了 baseColorTexture',
      JSON.stringify(bodyMat?.pbrMetallicRoughness));
    check(bodyMat.pbrMetallicRoughness.baseColorTexture.index === 0, 'baseColorTexture 指向那张图');
    const binChunk = (() => {
      let offset = 20 + jsonLength;
      while (offset + 8 <= buf.length) {
        const length = buf.readUInt32LE(offset);
        const type = buf.readUInt32LE(offset + 4);
        if (type === 0x004e4942) return buf.subarray(offset + 8, offset + 8 + length);
        offset += 8 + length;
      }
      return null;
    })();
    check(!!binChunk && binChunk.includes(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
      'BIN chunk 里能找到 PNG 魔数（图片字节真的在文件里）');
    const check2 = await convert.selfCheck(await out.blob.arrayBuffer());
    check(!('error' in check2) && check2.bones === 2 && JSON.stringify(check2.clipNames) === JSON.stringify(['mixamo.com', 'mixamo.com']),
      '带贴图的产物照样能被 GLTFLoader 读回', 'error' in check2 ? check2.error : JSON.stringify(check2));
  } finally {
    globalThis.document = realDocument;
  }
}

// =============================================================================================
// 13. 自动减面：meshoptimizer（保蒙皮/UV）+ 只重写索引 + 压紧顶点
// =============================================================================================
// WHY THIS SECTION IS SHAPED THIS WAY: three 自带的 SimplifyModifier 会 `deleteAttribute` 掉
// skinIndex/skinWeight（角色一减面就变成不会动的静态网格），所以这里用的是 vendored meshoptimizer。
// 它只重写索引，因此蒙皮/UV 天然有效——但"不用的顶点仍然占体积"，所以要自己压紧；压紧必须用**同一张
// remap 表**过滤所有属性，而这类错位在 three 里是"静默画错"（不会抛错、不会有几何报错），只能靠断言抓：
//   * 每个属性过滤后的 count 必须都等于新顶点数；
//   * 索引不能越界；
//   * 蒙皮权重每个顶点仍然和为 1（错位就会破坏这个和）；
//   * 原模型必须一点没变（减面跑在克隆体上）。
section('13. 自动减面');
{
  const decimate = await import(new URL('../dist/apps/fbx2glb/src/decimate.js', import.meta.url).href);

  // ---- 13.1 纯规则 ----
  check(decimate.targetTriangles(1000, 0.5) === 500, '目标面数 = 原面数 × 比例');
  check(decimate.targetTriangles(1000, 1) === 1000, '比例 1 → 不减');
  check(decimate.targetTriangles(10, 0.05) === 1, '极小网格的目标至少 1 面（不会变成 0）');
  check(decimate.targetTriangles(1000, 99) === 1000, '脏比例被钳到 1');
  const idxGeo = new THREE.BufferGeometry();
  idxGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(36), 3)); // 12 顶点
  check(decimate.triangleCount(idxGeo) === 4, '无索引时按 position 三元组数面', String(decimate.triangleCount(idxGeo)));
  idxGeo.setIndex([0, 1, 2, 1, 2, 3]);
  check(decimate.triangleCount(idxGeo) === 2, '有索引时按索引数面');
  const tinyMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  check(decimate.skipReasonFor(tinyMesh, 6) === 'tiny', '小于下限的网格跳过（12 面的盒子不该被减）');
  check(decimate.skipReasonFor({ geometry: undefined }, 6) === 'no-index', '没有几何体 → 跳过');
  const morphGeo = new THREE.BoxGeometry(1, 1, 1);
  morphGeo.morphAttributes.position = [new THREE.Float32BufferAttribute(new Float32Array(morphGeo.getAttribute('position').count * 3), 3)];
  check(decimate.skipReasonFor({ geometry: morphGeo }, 6) === 'morph', '有 morph target → 跳过（减面会毁掉形变）');
  const bigGeo = new THREE.SphereGeometry(1, 40, 30);
  check(decimate.skipReasonFor({ geometry: bigGeo }, 200) === null, '够大且目标更小 → 该减');
  check(decimate.skipReasonFor({ geometry: bigGeo }, decimate.triangleCount(bigGeo) + 1) === 'at-target',
    '目标不小于原面数 → 跳过');

  // ---- 13.2 真减面：合成的高模蒙皮网格（带 uv + skinIndex/skinWeight + 动画片段） ----
  const sphereGeo = new THREE.SphereGeometry(1, 64, 48);
  const vcount = sphereGeo.getAttribute('position').count;
  const skinIndices = new Uint16Array(vcount * 4);
  const skinWeights = new Float32Array(vcount * 4);
  for (let i = 0; i < vcount; i++) {
    skinIndices[i * 4] = 0; skinIndices[i * 4 + 1] = 1;
    skinWeights[i * 4] = 0.5; skinWeights[i * 4 + 1] = 0.5;
  }
  sphereGeo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
  sphereGeo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
  const boneA = new THREE.Bone(); boneA.name = 'mixamorigHips';
  const boneB = new THREE.Bone(); boneB.name = 'mixamorigSpine'; boneB.position.set(0, 0.8, 0);
  boneA.add(boneB);
  const skinned = new THREE.SkinnedMesh(sphereGeo, new THREE.MeshStandardMaterial({ name: 'BodyMat' }));
  skinned.name = 'Body';
  skinned.add(boneA);
  skinned.bind(new THREE.Skeleton([boneA, boneB]));
  const rig = new THREE.Group();
  rig.add(skinned);
  const clip = new THREE.AnimationClip('idle', 1, [
    new THREE.QuaternionKeyframeTrack('mixamorigHips.quaternion', [0, 1], [0, 0, 0, 1, 0, 0.2, 0, 0.98]),
  ]);
  const trisBefore = decimate.triangleCount(sphereGeo);
  check(trisBefore > 5000, '合成网格够大（' + trisBefore + ' 面）');

  const { root: thinned, report } = await decimate.decimateForExport(rig, {
    enabled: true, ratio: 0.5, error: 0.01, lockBorder: true,
  });
  check(report.available, 'meshoptimizer 的 wasm 起来了（vendor 的内嵌 wasm，不走网络）');
  check(report.applied === 1, '减了 1 个网格', String(report.applied));
  check(report.trisAfter < trisBefore * 0.75 && report.trisAfter > trisBefore * 0.25,
    `面数落在目标附近：${trisBefore} → ${report.trisAfter}`);
  check(decimate.triangleCount(skinned.geometry) === trisBefore,
    '原模型的几何体一点没变（减面只发生在克隆体上）');
  check(thinned !== rig, '返回的是克隆体');
  const thinMesh = thinned.getObjectByName('Body');
  check(!!thinMesh && thinMesh.isSkinnedMesh, '克隆出来的仍然是 SkinnedMesh');
  check(thinMesh.geometry.getAttribute('skinIndex') && thinMesh.geometry.getAttribute('skinWeight'),
    '蒙皮属性被保留（three 自带的 SimplifyModifier 会把这些 delete 掉）');
  const vertsAfter = thinMesh.geometry.getAttribute('position').count;
  const counts = Object.entries(thinMesh.geometry.attributes)
    .map(([name, a]) => name + ':' + a.count).join(' ');
  const allMatch = Object.values(thinMesh.geometry.attributes).every((a) => a.count === vertsAfter);
  check(allMatch, '所有属性都按同一张 remap 表压紧（数量一致）', counts);
  check(!!thinMesh.geometry.getAttribute('uv'), 'uv 被保留');
  const maxIndex = Math.max(...thinMesh.geometry.index.array);
  check(maxIndex < vertsAfter, '索引没有越界', maxIndex + ' < ' + vertsAfter);
  // 权重和 = 1：只要 skinIndex/skinWeight 的压紧错位，这个和立刻就不对了
  const w = thinMesh.geometry.getAttribute('skinWeight');
  let worstSum = 0;
  for (let i = 0; i < vertsAfter; i++) {
    const sum = w.array[i * 4] + w.array[i * 4 + 1] + w.array[i * 4 + 2] + w.array[i * 4 + 3];
    worstSum = Math.max(worstSum, Math.abs(1 - sum));
  }
  check(worstSum < 1e-3, '每个顶点蒙皮权重和仍然是 1（属性没有错位）', 'max |1-sum| = ' + worstSum.toExponential(1));
  let thinBones = 0, thinSkinned = 0;
  thinned.traverse((o) => { if (o.isBone) thinBones++; if (o.isSkinnedMesh) thinSkinned++; });
  check(thinBones === 2 && thinSkinned === 1, '骨骼层级完整', `bones=${thinBones} skinned=${thinSkinned}`);
  check(analyze.unboundTracks(thinned, clip).length === 0, '减面后动画片段仍然能绑定到骨骼');
  check(report.meshes[0].ms >= 0 && report.meshes[0].error >= 0, '报告里有耗时与几何误差',
    JSON.stringify(report.meshes[0]));
  check(decimate.decimateSummaryText(report).includes('→'), '摘要写出 before → after',
    decimate.decimateSummaryText(report));

  // ---- 13.3 减面后的产物仍然可读回，且真的变小 ----
  const outPlain = await convert.exportScene(rig, { format: 'glb', animations: [clip], scale: 1 });
  const outThin = await convert.exportScene(thinned, { format: 'glb', animations: [clip], scale: 1 });
  check(outThin.bytes < outPlain.bytes, '减面后的 GLB 更小',
    names.formatBytes(outPlain.bytes) + ' → ' + names.formatBytes(outThin.bytes));
  const checkThin = await convert.selfCheck(await outThin.blob.arrayBuffer());
  check(!('error' in checkThin), 'GLTFLoader 能读回减面后的产物', 'error' in checkThin ? checkThin.error : '');
  if (!('error' in checkThin)) {
    check(checkThin.skinned === 1 && checkThin.bones === 2, '读回后仍然是 1 个蒙皮网格 + 2 根骨骼',
      JSON.stringify(checkThin));
    check(JSON.stringify(checkThin.clipNames) === JSON.stringify(['idle']), '动作也还在');
  }
  const thinJson = convert.readGlb(await outThin.blob.arrayBuffer()).json;
  const prim = thinJson.meshes[0].primitives[0];
  check(!!prim.attributes.JOINTS_0 && !!prim.attributes.WEIGHTS_0 && !!prim.attributes.TEXCOORD_0,
    'glTF 里 JOINTS/WEIGHTS/TEXCOORD 都在', JSON.stringify(Object.keys(prim.attributes)));
  const thinTris = thinJson.accessors[prim.indices].count / 3;
  check(thinTris < trisBefore, 'glTF 里的三角面数确实变少了', Math.round(thinTris) + ' < ' + trisBefore);

  // ---- 13.4 多材质分组：整份网格简化一次 + 按顶点重算材质归属 ----
  // 真机回归门：用户那个 264 个分组的模型原来报「46297 → 12222408 面（−-26300%）」。两个原因都在这里钉住：
  // ① 每个分组曾经把**整条索引**交给 simplifier（于是每份都是整网格的副本，拼起来 ×264）；
  // ② 就算参数传对，"按材质切开各自减"也不可行——材质缝对 LockBorder 来说是边界边，小组几乎减不动。
  // 现在整份网格只简化一次（材质缝是内部边），材质归属事后按顶点重算并重新分桶成分组。
  const buildGrouped = (groupCount) => {
    const geo = new THREE.SphereGeometry(1, 60, 40);           // 4720 面
    geo.clearGroups();
    const total = geo.index.count;
    if (groupCount > 1) {
      const per = Math.floor(total / groupCount / 3) * 3;
      for (let g = 0; g < groupCount; g++) {
        const start = g * per;
        const count = g === groupCount - 1 ? total - start : per;
        geo.addGroup(start, count, g % 3);
      }
    }
    const n = geo.getAttribute('position').count;
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(n * 4), 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(n * 4).fill(0.5), 4));
    const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial());
    mesh.name = 'G';
    const bone = new THREE.Bone(); bone.name = 'Hips';
    mesh.add(bone); mesh.bind(new THREE.Skeleton([bone]));
    const rig = new THREE.Group(); rig.add(mesh);
    return { rig, mesh, tris: decimate.triangleCount(geo) };
  };
  for (const groupCount of [1, 3, 8, 264]) {
    const { rig, tris } = buildGrouped(groupCount);
    const { root: thinnedRig, report: gr } = await decimate.decimateForExport(rig, {
      enabled: true, ratio: 0.5, error: 0.01, lockBorder: true,
    });
    const gmesh = thinnedRig.getObjectByName('G');
    const gindex = gmesh.geometry.index;
    const inBand = gr.trisAfter > tris * 0.3 && gr.trisAfter < tris * 0.75;
    check(gr.applied === 1 && inBand, `${groupCount} 个分组：减到 ${tris} → ${gr.trisAfter} 面（目标 50%）`);
    check(gr.trisAfter < gr.trisBefore, `${groupCount} 个分组：面数只减不增（真机 bug 是 ×264）`);
    const groups = gmesh.geometry.groups ?? [];
    if (groupCount > 1) {
      const sum = groups.reduce((n, g) => n + g.count, 0);
      check(sum === gindex.count, `${groupCount} 个分组：分组长度之和 = 索引长度（无重叠、无空洞）`,
        `${sum} vs ${gindex.count}`);
      check(groups.length > 0 && groups.every((g) => g.count > 0 && g.count % 3 === 0),
        `${groupCount} 个分组：每个分组都非空且是整三角形`, JSON.stringify(groups.slice(0, 3)));
      check(groups.every((g) => [0, 1, 2].includes(g.materialIndex)),
        `${groupCount} 个分组：材质号仍取自原集合`, JSON.stringify([...new Set(groups.map((g) => g.materialIndex))]));
      const maxG = Math.max(...gindex.array);
      check(maxG < gmesh.geometry.getAttribute('position').count, `${groupCount} 个分组：索引不越界`);
    } else {
      check(groups.length <= 1, '单材质网格不写多余的分组');
    }
  }

  // ---- 13.5 「减面不能变多」这条不变量本身（假 simplifier 直接触发） ----
  const guardGeo = buildGrouped(4).mesh.geometry;
  const growStub = {
    simplify: (idx) => [new Uint32Array(idx.length * 3), 0],
    simplifyWithAttributes: (idx) => [new Uint32Array(idx.length * 3), 0],
  };
  const grew = decimate.simplifyGeometry(guardGeo, growStub, 100, 0.01, true);
  check(grew.grew === true && grew.geometry === guardGeo && grew.after === grew.before,
    'simplifier 返回更多索引时：整体放弃、原样返回原几何体', JSON.stringify({ grew: grew.grew, after: grew.after }));
  const throwStub = {
    simplify: () => { throw new Error('assert'); },
    simplifyWithAttributes: () => { throw new Error('assert'); },
  };
  const failed = decimate.simplifyGeometry(guardGeo, throwStub, 100, 0.01, true);
  check(failed.grew === true && failed.geometry === guardGeo, 'simplifier 抛错时也不崩、不变形');
  const grewReport = {
    available: true, applied: 0, trisBefore: 1000, trisAfter: 1000, vertsBefore: 100, vertsAfter: 100,
    ms: 0, reason: 'grew',
    meshes: [{ name: 'x', before: 1000, after: 1000, vertsBefore: 100, vertsAfter: 100, ms: 0, error: 0, skip: 'grew' }],
  };
  check(!decimate.decimateSummaryText(grewReport).includes('-'),
    '「减面变多」的报告里不会再出现负数百分比', decimate.decimateSummaryText(grewReport));
  check(decimate.decimateSummaryText(grewReport).includes('保持原样'), '并且说明了是保持原样',
    decimate.decimateSummaryText(grewReport));
  const served = decimate.simplifyGeometry(guardGeo, growStub, 100, 0.01, true);
  check(served.before === served.after, '被放弃时 before/after 一致（报告不会出现 −0% 之类）');

  // ---- 13.4 关闭 / 降级路径 ----
  const offRes = await decimate.decimateForExport(rig, { enabled: false, ratio: 0.5, error: 0.01, lockBorder: true });
  check(offRes.root === rig && offRes.report.applied === 0 && offRes.report.reason === 'disabled',
    '功能关闭时原样返回，不做任何改动');
  check(decimate.decimateSummaryText(offRes.report) === '', '关闭时摘要为空（界面不显示这一行）');
  const tinyRes = await decimate.decimateForExport(tinyMesh, { enabled: true, ratio: 0.5, error: 0.01, lockBorder: true });
  check(tinyRes.report.applied === 0 && tinyRes.report.reason === 'tiny',
    '只有小网格时报告「都小于下限」，而不是假装减过', JSON.stringify(tinyRes.report.reason));
  check(decimate.decimateSummaryText(tinyRes.report).includes('小于'), '摘要解释了为什么没减',
    decimate.decimateSummaryText(tinyRes.report));

  // ---- 13.7 输入格式探测：不是 FBX 时要给一句能读的话 ----
  check(convert.sniffFormat(sampleBuffer.slice(0)) === 'fbx-ascii', '样例被识别为 ASCII FBX');
  const glbHeader = new Uint8Array(20);
  glbHeader.set(new TextEncoder().encode('glTF'), 0);
  check(convert.sniffFormat(glbHeader.buffer) === 'glb', 'glTF 魔数被识别');
  const gltfText = new TextEncoder().encode('  { "asset": { "version": "2.0" } }').buffer;
  check(convert.sniffFormat(gltfText) === 'gltf', 'JSON 的 .gltf 被识别');
  const junk = new TextEncoder().encode('hello world').buffer;
  check(convert.sniffFormat(junk) === 'unknown', '其它内容归为 unknown');
  const glbError = await convert.parseFbx(glbHeader.buffer.slice(0), 'x.glb').then(() => null, (e) => e);
  check(!!glbError && /glTF\/GLB/.test(glbError.message), '把 .glb 丢进来时给出可读的报错（而不是 FBXLoader 的原文）',
    glbError && glbError.message);
  const junkError = await convert.parseFbx(junk, 'x.bin').then(() => null, (e) => e);
  check(!!junkError && /无法识别/.test(junkError.message), '陌生格式也有可读的报错', junkError && junkError.message);

  // ---- 13.6 设置 schema ----
  check(JSON.stringify(settings.decimateDefaults()) ===
    JSON.stringify({ enabled: false, ratio: 0.5, error: 0.01, lockBorder: true }),
    '减面默认关闭（有损操作不该默认改别人的模型）', JSON.stringify(settings.decimateDefaults()));
  const draw = {};
  settings.writeDecimateOverride(draw, 'enabled', true);
  check(draw.decimate.portrait.enabled === true && draw.decimate.landscape.enabled === true,
    '减面设置也是两个方向都写');
  check(settings.effectiveDecimate(draw, 'portrait').enabled === true, '读回减面覆盖值');
  check(settings.hasDecimateOverrides(draw), 'hasDecimateOverrides 为真');
  const clamped = settings.effectiveDecimate({ decimate: { portrait: { ratio: 9, error: -1, lockBorder: 'x' } } }, 'portrait');
  check(clamped.ratio === 1 && clamped.error === 0.001 && clamped.lockBorder === true,
    '脏数据被钳制/回落到默认', JSON.stringify(clamped));
  const snapped = settings.effectiveDecimate({ decimate: { portrait: { ratio: 0.52 } } }, 'portrait');
  check(Math.abs(snapped.ratio - 0.5) < 1e-9, '比例按步长吸附', String(snapped.ratio));
  settings.clearDecimateGroup(draw);
  check(!settings.hasDecimateOverrides(draw), '减面组恢复默认');
}

// =============================================================================================
// 14. 压缩贴图：等比降分辨率 + 不透明贴图转 JPEG
// =============================================================================================
// 这一节回答"文件到底为什么变小"。两条机制各自的坑都钉在这里：
//   * **等比**：three 导出器自己的 `maxTextureSize` 是宽高各自 `Math.min`，8192×2048 会被拉成方形；
//     我们按最长边等比缩到 canvas，所以必须断言"非正方形贴图的比例不变"。
//   * **编码**：导出器读 `texture.userData.mimeType`。不透明贴图给 jpeg，带 alpha / 法线贴图保持 png。
//   * **共享图片只压一次**：否则同一张图被 map/emissiveMap 共用时会在 GLB 里嵌两份，体积翻倍。
section('14. 压缩贴图');
{
  const pack = await import(new URL('../dist/apps/fbx2glb/src/texturepack.js', import.meta.url).href);

  // ---- 14.1 纯规则 ----
  const same = pack.targetSizeFor(2048, 2048, 2048);
  check(!same.scaled && same.width === 2048, '已经在目标尺寸内 → 不缩放');
  const square = pack.targetSizeFor(8192, 8192, 2048);
  check(square.scaled && square.width === 2048 && square.height === 2048, '正方形贴图缩到 2048×2048');
  const wide = pack.targetSizeFor(8192, 2048, 2048);
  check(wide.scaled && wide.width === 2048 && wide.height === 512,
    '非正方形贴图等比缩放（8192×2048 → 2048×**512**，不是导出器那种 2048×2048）',
    `${wide.width}×${wide.height}`);
  const tall = pack.targetSizeFor(2048, 8192, 1024);
  check(tall.width === 256 && tall.height === 1024, '竖图同理（2048×8192 → 256×1024）',
    `${tall.width}×${tall.height}`);
  check(pack.targetSizeFor(4096, 4096, 0).width === 4096, 'maxSize = 0 → 原样');
  check(pack.targetSizeFor(0, 0, 2048).scaled === false, '没有尺寸信息不缩放（不产生 0×0）');
  check(pack.mimeFor('map', { transparent: false }, true) === 'image/jpeg', '不透明底色贴图 → JPEG');
  check(pack.mimeFor('map', { transparent: true }, true) === 'image/png', '标了 transparent 的材质 → PNG（要保住 alpha）');
  check(pack.mimeFor('normalMap', {}, true) === 'image/png', '法线贴图 → PNG（JPEG 块状噪声最明显）');
  check(pack.mimeFor('alphaMap', {}, true) === 'image/png', 'alphaMap → PNG');
  check(pack.mimeFor('emissiveMap', {}, true) === 'image/jpeg', '自发光贴图 → JPEG');
  check(pack.mimeFor('map', {}, false) === 'image/png', '关掉 JPEG 开关 → 全部 PNG');

  // ---- 14.2 设置 schema ----
  check(JSON.stringify(settings.textureDefaults()) === JSON.stringify({ enabled: false, maxSize: 2048, jpeg: true }),
    '贴图压缩默认关闭（有损操作）', JSON.stringify(settings.textureDefaults()));
  check(settings.clampPackSize(3000) === 2048 && settings.clampPackSize(NaN) === 2048, '尺寸吸附到最近的预设值');
  check(settings.effectiveTexture({ texture: { portrait: { maxSize: 999, enabled: true } } }, 'portrait').maxSize === 1024,
    '脏尺寸被吸附（999 → 1024）');
  const traw = {};
  settings.writeTextureOverride(traw, 'maxSize', 512);
  check(traw.texture.portrait.maxSize === 512 && traw.texture.landscape.maxSize === 512, '贴图设置两个方向都写');
  check(settings.hasTextureOverrides(traw), 'hasTextureOverrides 为真');
  settings.clearTextureGroup(traw);
  check(!settings.hasTextureOverrides(traw), '贴图组恢复默认');

  // ---- 14.3 真压缩：canvas shim 记录尺寸与绘制来源 ----
  const image = { width: 4096, height: 2048, name: 'body_diffuse' };
  const normalImage = { width: 4096, height: 2048, name: 'body_normal' };
  const mat = new THREE.MeshStandardMaterial();
  mat.name = 'BodyMat';
  const mapTex = new THREE.Texture(image);
  mapTex.name = 'body_diffuse';
  const emisTex = new THREE.Texture(image);      // 与 map 共用同一张 image
  emisTex.name = 'body_diffuse';
  const normTex = new THREE.Texture(normalImage);
  normTex.name = 'body_normal';
  mat.map = mapTex;
  mat.emissiveMap = emisTex;
  mat.normalMap = normTex;
  const scene2 = new THREE.Group();
  scene2.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat));

  FAKE_CANVAS_LOG.length = 0;
  const packReport = await pack.packTextures(scene2, { enabled: true, maxSize: 1024, jpeg: true });
  check(packReport.packed === 3, '3 个槽都被处理', String(packReport.packed));
  check(mapTex.image !== image && mapTex.image.width === 1024 && mapTex.image.height === 512,
    '底色贴图缩到 1024×512 并换成 canvas', `${mapTex.image.width}×${mapTex.image.height}`);
  check(emisTex.image === mapTex.image, '共用同一张图的另一个槽复用同一个压缩结果（不重复压缩、不重复内嵌）');
  check(mat.map.userData.mimeType === 'image/jpeg' && mat.normalMap.userData.mimeType === 'image/png',
    '编码按槽位决定：底色 jpeg、法线 png',
    `${mat.map.userData.mimeType} / ${mat.normalMap.userData.mimeType}`);
  check(image.width === 4096 && image.height === 2048, '源图片对象没有被改动（只改 texture 指向）');
  check(packReport.entries.filter((e) => e.shared).length === 1, '报告里标出 1 张是复用');
  check(FAKE_CANVAS_LOG.length === 2, '只创建了 2 个 canvas（共享图片压一次，正常贴图例外）',
    String(FAKE_CANVAS_LOG.length));
  check(FAKE_CANVAS_LOG.every((c) => c.draws.length === 1), '每个 canvas 恰好画一次');
  check(FAKE_CANVAS_LOG[0].draws[0].image === image, '画进去的是源图片');
  const summary = pack.packSummaryText(packReport);
  check(summary.includes('4096×2048 → 1024×512') && summary.includes('jpeg/png'), '摘要写出分辨率与编码',
    summary);

  // ---- 14.4 导出：GLB 里的图片数、编码与字节数 ----
  const packedOut = await convert.exportScene(scene2, { format: 'glb', animations: [], scale: 1 });
  const packedBuffer = await packedOut.blob.arrayBuffer();
  const packedJson = convert.readGlb(packedBuffer).json;
  check(packedJson.images.length === 2, 'GLB 里只有 2 张图（共享图片没有变成两份）',
    String(packedJson.images.length));
  check(packedJson.images.map((i) => i.mimeType).sort().join(',') === 'image/jpeg,image/png',
    '导出器按 userData.mimeType 分别编码', packedJson.images.map((i) => i.mimeType).join(','));
  // 每个图片的 bufferView 会补到 4 字节对齐，所以是 ceil(81/4)*4 = 84 一份
  const paddedPng = Math.ceil(SAMPLE_PNG.length / 4) * 4;
  check(convert.glbImageBytes(packedBuffer) === 2 * paddedPng,
    '图片字节数可以从 GLB 直接数出来（不需要再编码一遍）', String(convert.glbImageBytes(packedBuffer)));
  const packedCheck = await convert.selfCheck(packedBuffer);
  check(!('error' in packedCheck), '压完贴图的产物照样能被 GLTFLoader 读回',
    'error' in packedCheck ? packedCheck.error : '');

  // ---- 14.4b 内存护栏：原样转码需要超大 canvas 时跳过并说明 ----
  const hugeMat = new THREE.MeshStandardMaterial();
  hugeMat.map = new THREE.Texture({ width: 8192, height: 8192 });
  const hugeMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), hugeMat);
  const hugeReport = await pack.packTextures(hugeMesh, { enabled: true, maxSize: 0, jpeg: true });
  check(hugeReport.packed === 0 && hugeReport.reason === 'too-big',
    '8192² 且不缩放：跳过而不是申请一张 ~270MB 的 canvas（手机上会 OOM）',
    JSON.stringify({ packed: hugeReport.packed, reason: hugeReport.reason }));
  check(pack.packSummaryText(hugeReport).includes('最大边长'), '并且告诉用户该怎么改',
    pack.packSummaryText(hugeReport));
  const downsized = await pack.packTextures(hugeMesh, { enabled: true, maxSize: 2048, jpeg: true });
  check(downsized.packed === 1, '把最大边长设成 2048 就能压了', String(downsized.packed));

  // ---- 14.5 跳过 / 降级 ----
  const noImage = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  const noImageReport = await pack.packTextures(noImage, { enabled: true, maxSize: 1024, jpeg: true });
  check(noImageReport.packed === 0 && noImageReport.reason === 'no-image', '没有贴图的模型：明确说没有可处理的贴图',
    JSON.stringify(noImageReport.reason));
  const smallMat = new THREE.MeshStandardMaterial();
  smallMat.map = new THREE.Texture({ width: 256, height: 256 });
  const smallMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), smallMat);
  const smallReport = await pack.packTextures(smallMesh, { enabled: true, maxSize: 2048, jpeg: false });
  check(smallReport.packed === 0 && smallReport.reason === 'at-target',
    '又小又不转码 → 不动它（并且说明原因）', JSON.stringify(smallReport.reason));
  const offReport = await pack.packTextures(scene2, { enabled: false, maxSize: 1024, jpeg: true });
  check(offReport.enabled === false && offReport.packed === 0 && pack.packSummaryText(offReport) === '',
    '功能关闭时不做任何处理，摘要为空');
  const savedDocument = globalThis.document;
  try {
    delete globalThis.document;
    const unavailable = await pack.packTextures(scene2, { enabled: true, maxSize: 1024, jpeg: true });
    check(unavailable.available === false && unavailable.reason === 'unavailable',
      '没有 canvas 的环境（Node）降级为「不可用」而不是崩', JSON.stringify(unavailable.reason));
    check(pack.packSummaryText(unavailable).includes('不可用'), '摘要里说明不可用');
  } finally {
    globalThis.document = savedDocument;
  }
}

// =============================================================================================
// 15. HTTP API：POST 一个 FBX，拿回一个 GLB（server/src/fbx2glb.ts + fbx2glbWorker.ts）
// =============================================================================================
// 这一节起一个**真实服务器**（PORT=<空闲端口> + PORTAL_DATA_DIR 指向临时目录 + 1MB 的 FBX 上限），
// 因为这条链的另一半根本不在浏览器里：路由、上传落盘、worker 线程、响应头、清理，只有真的发一次请求
// 才谈得上验证。转换本身用的还是本仓库自己的模块（worker 里跑的就是 §6/§11 那套），所以这里断的是
// 「HTTP 层有没有说真话」：状态码、响应头、返回的字节是不是真的能被读回、以及失败时会不会留下垃圾。
section('15. HTTP API：FBX 进，GLB 出');
{
  // ---- 15.1 纯规则：参数解析（不启服务器也能钉） ----
  const api = await import(new URL('../dist/server/src/fbx2glb.js', import.meta.url).href);
  const q = (query) => api.parseConvertQuery(new URLSearchParams(query));
  check(api.SCALE_MODES.join() === 'auto,keep,cm', 'scale 的三个取值与页面一致', api.SCALE_MODES.join());
  const defaults = q('');
  check(defaults.ok && defaults.value.options.scale === 'auto' && defaults.value.options.animations === true &&
    defaults.value.options.decimate.enabled === false && defaults.value.options.decimate.lockBorder === true,
    '默认参数 = 页面的出厂默认（auto 缩放 + 导出动画 + 不减面）', JSON.stringify(defaults));
  check(defaults.ok && defaults.value.file === 'upload.fbx', '默认报告名 upload.fbx');
  const named = q('name=hero%20v2.fbx&scale=cm&animations=0&decimate=1&ratio=0.25&error=0.02&lockBorder=0');
  check(named.ok && named.value.file === 'hero v2.fbx' && named.value.options.scale === 'cm' &&
    named.value.options.animations === false && named.value.options.decimate.ratio === 0.25 &&
    named.value.options.decimate.error === 0.02 && named.value.options.decimate.lockBorder === false,
    '显式参数原样落到请求上', JSON.stringify(named.ok ? named.value : named));
  check(!q('decmate=1').ok, '未知参数 → 报错（宁可不转，也不要悄悄用默认值转）',
    q('decmate=1').error);
  check(!q('scale=metre').ok, 'scale 取值不对 → 报错');
  check(!q('animations=maybe').ok, '布尔参数只认 1/0/true/false', q('animations=maybe').error);
  check(!q('ratio=abc').ok, 'ratio 不是数字 → 报错');
  check(!q('pack=1').ok && q('pack=1').error.includes('canvas'), 'pack=1 → 明确拒绝（服务器端没有 canvas）',
    q('pack=1').error);
  check(q('pack=0').ok, 'pack=0 只是「不压」，允许通过');
  const dirty = q('name=' + encodeURIComponent('../../etc/passwd'));
  check(dirty.ok && !dirty.value.file.includes('/'), '报告名里的路径被剥掉（它只出现在报告与错误信息里）',
    dirty.ok ? dirty.value.file : dirty.error);

  // ---- 15.2 起真实服务器 ----
  const fsMod = await import('node:fs');
  const net = await import('node:net');
  const { spawn } = await import('node:child_process');
  const tmpRoot = fsMod.mkdtempSync(new URL('../.verify-fbx2glb-api-', import.meta.url).pathname);
  // Plant a stale scratch file BEFORE the server starts: that is exactly what a conversion killed by a
  // dev-watcher restart leaves behind (it happened for real), and the boot sweep must remove it.
  fsMod.mkdirSync(tmpRoot + '/tmp', { recursive: true });
  fsMod.writeFileSync(tmpRoot + '/tmp/stale-from-a-crashed-conversion.fbx', 'stale');
  const port = await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
  const base = 'http://127.0.0.1:' + port;
  const serverLog = [];
  const child = spawn(process.execPath, [new URL('../dist/server/src/index.js', import.meta.url).pathname], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', PORTAL_DATA_DIR: tmpRoot, PORTAL_MAX_FBX_MB: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (b) => serverLog.push(String(b)));
  child.stderr.on('data', (b) => serverLog.push(String(b)));
  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      try { up = (await fetch(base + '/api/portal')).ok; } catch { await new Promise((r) => setTimeout(r, 150)); }
    }
    check(up, '临时服务器起来了（PORT=' + port + '，PORTAL_DATA_DIR 指向临时目录）', up ? '' : serverLog.join(''));
    check(!fsMod.existsSync(tmpRoot + '/tmp/stale-from-a-crashed-conversion.fbx'),
      '启动时清掉上次遗留的临时文件（服务器死在转换中途留下的那些）',
      fsMod.readdirSync(tmpRoot + '/tmp').join(','));
    if (!up) throw new Error('server did not start');

    // 自描述端点：参数列表必须与解析器认识的参数**完全一致**（否则文档就漂了）
    const desc = await (await fetch(base + '/api/fbx2glb')).json();
    check(desc.endpoint === 'POST /api/fbx2glb/convert', 'GET /api/fbx2glb 说明入口', String(desc.endpoint));
    check(Object.keys(desc.params).sort().join() === [...api.CONVERT_PARAMS].sort().join(),
      '自描述的参数列表 = 解析器接受的参数（两处不可能漂）',
      Object.keys(desc.params).join() + ' vs ' + api.CONVERT_PARAMS.join());
    check(desc.limits.maxFbxBytes === 1024 * 1024 && desc.limits.concurrency === 1,
      '自描述里写明上限与并发度', JSON.stringify(desc.limits));
    check(Array.isArray(desc.unsupported) && desc.unsupported.some((u) => u.includes('贴图')),
      '自描述里明确写出「贴图不支持」', (desc.unsupported ?? []).join(' | ').slice(0, 80));

    // ---- 15.3 真样例：FBX 进，GLB 出（并把产物读回来） ----
    const res = await fetch(base + '/api/fbx2glb/convert?name=idle.fbx', {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: sampleBuffer.slice(0),
    });
    check(res.status === 200, 'POST 样例 → 200', String(res.status));
    check(res.headers.get('content-type') === 'model/gltf-binary', 'Content-Type 是 model/gltf-binary',
      String(res.headers.get('content-type')));
    check((res.headers.get('content-disposition') ?? '').includes('idle.glb'), '带 Content-Disposition（curl -OJ 能直接落盘）',
      String(res.headers.get('content-disposition')));
    const glbBytes = new Uint8Array(await res.arrayBuffer());
    check(glbBytes.length === Number(res.headers.get('x-fbx2glb-bytes')), '响应头里的字节数 = 实际收到的字节数',
      glbBytes.length + ' vs ' + res.headers.get('x-fbx2glb-bytes'));
    const glbBuffer = glbBytes.buffer.slice(glbBytes.byteOffset, glbBytes.byteOffset + glbBytes.byteLength);
    const glbJson = convert.readGlb(glbBuffer).json;
    check(glbJson.meshes?.length === 1 && glbJson.skins?.[0]?.joints?.length === 2,
      '产物是个真 GLB：1 网格 + 2 关节', JSON.stringify({ meshes: glbJson.meshes?.length, joints: glbJson.skins?.[0]?.joints?.length }));
    check(glbJson.animations?.length === 2, '2 个动画都被写进去了', String(glbJson.animations?.length));
    check((glbJson.animations ?? []).map((a) => a.name).join() === 'idle,idle-2',
      '动作按**文件名**命名并去重（Mixamo 每个 take 都叫 mixamo.com，不改名第二个动作永远取不到）',
      JSON.stringify((glbJson.animations ?? []).map((a) => a.name)));
    check(Number(res.headers.get('x-fbx2glb-bones')) === 2 && Number(res.headers.get('x-fbx2glb-clips')) === 2,
      '响应头报告骨骼数与动作数', res.headers.get('x-fbx2glb-bones') + ' / ' + res.headers.get('x-fbx2glb-clips'));
    check(res.headers.get('x-fbx2glb-self-check') === 'ok', '服务器自己把产物读回来过（自检 ok）',
      String(res.headers.get('x-fbx2glb-self-check')));
    check(decodeURIComponent(res.headers.get('x-fbx2glb-clip-names')) === 'idle,idle-2',
      '动作名也在响应头里（caller 不用打开文件就知道里面有什么）',
      String(res.headers.get('x-fbx2glb-clip-names')));
    check(Number(res.headers.get('x-fbx2glb-input-bytes')) === sampleBuffer.byteLength,
      '响应头报告输入字节数', String(res.headers.get('x-fbx2glb-input-bytes')));

    // ---- 15.4 带贴图的 FBX：贴图会被摘掉，而且**如实报告** ----
    // (§12 的 texBuffer 在它自己的块作用域里，这里重新读一份 —— 这一节要能单独跑。)
    const texBytes = readFileSync(new URL('../dist/apps/fbx2glb/assets/sample-textured.fbx', import.meta.url));
    const texFbx = texBytes.buffer.slice(texBytes.byteOffset, texBytes.byteOffset + texBytes.byteLength);
    const texRes = await fetch(base + '/api/fbx2glb/convert?name=hero.fbx', {
      method: 'POST', body: texFbx.slice(0),
    });
    check(texRes.status === 200, '带外部贴图的 FBX 也能转（贴图槽被摘掉，而不是整个失败）', String(texRes.status));
    check(texRes.headers.get('x-fbx2glb-textures') === 'requested=1;dropped=1',
      '响应头如实报告「要了 1 张、丢了 1 张」——服务器端没有解码器，这一条就是它不能说谎的地方',
      String(texRes.headers.get('x-fbx2glb-textures')));
    const texWarn = decodeURIComponent(texRes.headers.get('x-fbx2glb-warnings') ?? '');
    check(texWarn.includes('贴图') && texWarn.includes('页面'), '告警里直接告诉调用方「要带贴图请用页面」', texWarn.slice(0, 90));
    const texJson = convert.readGlb(new Uint8Array(await texRes.arrayBuffer()).buffer).json;
    check(!texJson.images || texJson.images.length === 0, '产物里确实没有图（不是「有图但坏了」）',
      JSON.stringify(texJson.images ?? null));

    // ---- 15.5 失败路径：每一类都有自己的状态码，而且不留垃圾 ----
    const post = (body, query = '') => fetch(base + '/api/fbx2glb/convert' + query, { method: 'POST', body });
    const junk = await post(Buffer.from('<!doctype html>not an fbx at all'));
    check(junk.status === 400 && (await junk.json()).error.includes('既不是 FBX'),
      '垃圾 body → 400（并且说明它是什么）', String(junk.status));
    const glbIn = await post(Buffer.from(glbBytes));
    const glbErr = await glbIn.json();
    check(glbIn.status === 400 && glbErr.error.includes('/api/assets'),
      '.glb 输入 → 400，并指路「要发布就用 /api/assets」（不是把 GLB 硬塞给 FBXLoader）', glbErr.error.slice(0, 90));
    const empty = await post(Buffer.alloc(0));
    check(empty.status === 400, '空 body → 400', String(empty.status));
    const badParam = await post(sampleBuffer.slice(0), '?nope=1');
    check(badParam.status === 400 && (await badParam.json()).error.includes('未知参数'),
      '未知参数 → 400（服务器侧同样严格）', String(badParam.status));
    const pack = await post(sampleBuffer.slice(0), '?pack=1');
    check(pack.status === 400 && (await pack.json()).error.includes('canvas'), 'pack=1 → 400', String(pack.status));
    const tooBig = await post(Buffer.alloc(1_500_000, 0x41));
    check(tooBig.status === 413 && (await tooBig.json()).error.includes('上限'),
      '超过上限的 body → 413（测试实例的上限是 1MB）', String(tooBig.status));
    const getRes = await fetch(base + '/api/fbx2glb/convert');
    check(getRes.status === 405, 'GET 这个路径 → 405', String(getRes.status));
    const slash = await fetch(base + '/api/fbx2glb/nope', { method: 'POST', body: 'x' });
    check(slash.status === 404, '别的子路径 → 404', String(slash.status));
    const tmpDir = new URL('../' + tmpRoot.split('/').pop() + '/tmp/', new URL('file://' + tmpRoot + '/'));
    let leftovers = [];
    try { leftovers = fsMod.readdirSync(tmpDir.pathname); } catch { leftovers = []; }
    check(leftovers.length === 0, '所有请求（含失败的那些）都没有在 data/tmp 留下文件', leftovers.join(','));

    // ---- 15.6 队列：两个并发请求都成功（串行执行，而不是互相踩） ----
    const [a, b] = await Promise.all([
      post(sampleBuffer.slice(0), '?name=first.fbx'),
      post(sampleBuffer.slice(0), '?name=second.fbx'),
    ]);
    check(a.status === 200 && b.status === 200, '两个并发请求都拿到 200（排队，不是拒绝也不是互相覆盖）',
      a.status + ' / ' + b.status);
    const aNames = decodeURIComponent(a.headers.get('x-fbx2glb-clip-names') ?? '');
    const bNames = decodeURIComponent(b.headers.get('x-fbx2glb-clip-names') ?? '');
    check(aNames === 'first,first-2' && bNames === 'second,second-2',
      '两个请求的产物互不干扰（各自按自己的文件名命名）', aNames + ' | ' + bNames);
  } catch (err) {
    check(false, 'HTTP API 这一段没有抛错', err instanceof Error ? err.message : String(err));
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    fsMod.rmSync(tmpRoot, { recursive: true, force: true });
    check(!fsMod.existsSync(tmpRoot), '临时目录已清理');
  }
}

// =============================================================================================
console.log(`\n${checks} 项断言，${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
