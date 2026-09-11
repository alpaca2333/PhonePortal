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
 *   5. IT STAYS LOCAL. Source-level assertions that the app never touches localStorage, never uses
 *      XMLHttpRequest/FormData, and has exactly ONE fetch — its own bundled sample asset. The whole
 *      "your files never leave the device" promise is a grep away from being false.
 *
 * NOT asserted: that the preview renders, that touch orbit feels right, that a 10 MB Mixamo character
 * converts in an acceptable time on a phone. No browser here — those are 需真机确认 items in
 * apps/fbx2glb/README.md, like everywhere else in this portal.
 *
 * Run:  npm run dev            (or npm run build) so dist/ is current, then
 *       node scripts/verify-fbx2glb.mjs
 * Exit code is non-zero when any assertion fails.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
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

// three's FileLoader dispatches a ProgressEvent, which Node does not define either. Only the .gltf
// self-check reaches it (the binary path reads its buffer out of the GLB chunk with no fetch), so
// this shim exists purely to let the non-binary round trip be asserted here.
if (typeof globalThis.ProgressEvent === 'undefined') {
  globalThis.ProgressEvent = class ProgressEvent {
    constructor(type, init = {}) { this.type = type; Object.assign(this, init); }
  };
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
section('4. 设置：默认值 / 稀疏覆盖 / 脏数据 / 两组各自恢复默认');
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
  check(fetches.length === 1, '整个应用只有一处 fetch', fetches.join(' | '));
  check(fetches.every((f) => f.includes('./assets/sample.fbx')), '那一处 fetch 只取内置样例');

  const referenced = [...new Set([...js.matchAll(/vendor\/addons\/[A-Za-z0-9_/.\[\]-]+\.js/g)].map((m) => m[0]))];
  check(referenced.length >= 4, '源码里引用了 ' + referenced.length + ' 个 vendor addon');
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
    createElement: (tag) => { const el = makeElement(tag, ''); created.push(el); return el; },
    createElementNS: (_ns, tag) => { const el = makeElement(tag, ''); created.push(el); return el; },
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

  // fetch: the app's own sample asset + the settings API. Anything else is a bug (the app has exactly
  // one fetch, asserted in section 10).
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
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
    check(logText().includes('样例已载入'), '日志记录了样例载入');

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
    const downloadBtn = elements.get('results').children[0].children[elements.get('results').children[0].children.length - 1];
    const before = requests.length;
    downloadBtn.dispatch('click');
    await settle();
    check(requests.length === before, '点下载没有产生任何网络请求');
    check(logText().includes('已下载'), '日志记录了下载');
    const blob = objectUrls[objectUrls.length - 1];
    check(!!blob && blob.size > 1000, '下载的 Blob 有内容', blob ? names.formatBytes(blob.size) : 'none');

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
    check(elements.get('convertBtn').textContent.includes('GLTF'), '按钮文案跟着格式变', elements.get('convertBtn').textContent);

    // ---- 再转一次：扩展名跟着设置 ----
    elements.get('convertBtn').dispatch('click');
    await settle(120);
    const second = elements.get('results').children[0].textContent;
    check(second.includes('sample.gltf'), '第二次产物是 .gltf（设置真的生效了）', second.slice(0, 60));
    check(elements.get('results').children.length === 1, '重新转换会清空上一次的产物');

    // ---- 多文件 + 「不合并」：一个输入一个产物，各自按自己的文件名命名 ----
    const fi = elements.get('fileInput');
    fi.files = [new File([sampleBuffer.slice(0)], 'run.fbx', { type: 'application/octet-stream' })];
    fi.dispatch('change');
    await settle(80);
    check(elements.get('fileList').children.length === 2, '通过文件选择框再加一个文件',
      String(elements.get('fileList').children.length));
    check(elements.get('convertBtn').textContent.includes('合并并转换（2 个）'),
      '多个文件时按钮明说要合并', elements.get('convertBtn').textContent);

    elements.get('optMerge').checked = false;
    elements.get('optMerge').dispatch('change');
    await new Promise((r) => realSetTimeout(r, 600));
    elements.get('convertBtn').dispatch('click');
    await settle(150);
    check(elements.get('results').children.length === 2, '关掉合并 → 一个输入一个产物',
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
    check(['sample', 'sample-2', 'run', 'run-2'].every((n) => mergedText.includes(n)),
      '合并后四个动作名齐全且不重名', mergedText.slice(0, 140));

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
    check(elements.get('convertBtn').disabled === true, '清空后转换按钮再次禁用');
    globalThis.fetch = prevFetch;
  } finally {
    URL.createObjectURL = realCreateObjectURL;
    URL.revokeObjectURL = realRevoke;
  }
}

// =============================================================================================
console.log(`\n${checks} 项断言，${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
