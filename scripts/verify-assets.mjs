/**
 * CPU-side verification for the EXTERNAL ASSET STORE — the "publish a converted GLB into a game's
 * folder" feature (`server/src/assets.ts`, the `/api/assets/*` + `/assets/*` routes in
 * `server/src/index.ts`, and `apps/fbx2glb/src/publish.ts` on the client).
 *
 * WHY A REAL SERVER IS STARTED HERE
 * ---------------------------------
 * Everything interesting about this feature is a boundary, and boundaries are where the app's usual
 * pure-function tests cannot reach: does an upload of a TRUNCATED file leave the previously published
 * asset byte-identical? Does an app that never declared an intake really refuse writes? Is a hostile
 * name (`..%2Fevil.glb`) rejected before it becomes a path? So the script spawns the built server on a
 * free port with `PORTAL_DATA_DIR` pointing at a throwaway directory (that env var exists for exactly
 * this: publishing into the user's live `data/` during a test would be rude, and a leftover test asset
 * in a game's library would be worse), drives it over HTTP, and asserts the state it leaves on disk.
 *
 * WHAT IS ASSERTED
 *   1. DISCOVERY: a manifest's `assets.accepts` is what makes an app a publish target; apps without it
 *      are invisible to the publisher and refuse writes with 415 (the converter never names a game).
 *   2. THE CONTRACT: publish → list → fetch → overwrite → delete, with byte-identical round trips, the
 *      right status codes (201 new / 200 replaced), `model/gltf-binary` on the way out, and the served
 *      URL being `/assets/<app>/<name>` while the file really lives in `data/assets/<app>/`.
 *   3. FAILURES ARE HARMLESS: a truncated GLB, a JSON/HTML body, an over-cap upload, a bad name and a
 *      missing app are all refused — and the asset that was already there is untouched (same bytes, same
 *      mtime) with no `.part` temp file left behind. This is what makes the converter's 「发布」 a plain
 *      overwrite instead of a read-modify-write dance.
 *   4. THE PLATFORM DID NOT MOVE: a sub-app's own vendored `apps/<id>/assets/` still serves from dist,
 *      side by side with the new external root (two different things with confusingly similar paths).
 *   5. CLIENT-SIDE RULES: name sanitising (CJK/space/length → ASCII, always publishable), target
 *      resolution (a stored app id that no longer exists falls back instead of publishing nowhere),
 *      the "this target does not take .glb" reason text, and the source-level promise that every URL
 *      the client uses is RELATIVE — a converted model can only ever be sent to this portal.
 *
 * NOT asserted (no browser here): the publish button's hit area, the progress/feel of a 30 MB upload on
 * a phone, and whether a game can actually load the published file (the game does not consume published
 * assets yet — that is a documented 待办 in apps/shooter/README.md).
 *
 * Run:  npm run dev            (or npm run build) so dist/ is current, then
 *       node scripts/verify-assets.mjs
 * Exit code is non-zero when any assertion fails.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readdirSync, rmSync, statSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
let failures = 0;
let checks = 0;
function check(ok, label, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : '  FAIL '} ${label}${detail ? ' — ' + detail : ''}`);
}
function section(title) { console.log('\n' + title); }

// =============================================================================================
// 0. 构建新鲜度（本脚本驱动的是 dist/ 里的服务端与客户端模块）
// =============================================================================================
section('0. dist 是否比源码新（避免对着旧构建做验证）');
{
  const pairs = [
    ['server/src/assets.ts', 'dist/server/src/assets.js'],
    ['server/src/index.ts', 'dist/server/src/index.js'],
    ['apps/fbx2glb/src/publish.ts', 'dist/apps/fbx2glb/src/publish.js'],
  ];
  for (const [src, out] of pairs) {
    const srcPath = path.join(ROOT, src);
    const outPath = path.join(ROOT, out);
    check(existsSync(outPath), out + ' 存在', out);
    if (existsSync(outPath)) {
      check(statSync(outPath).mtimeMs >= statSync(srcPath).mtimeMs, out + ' 比源码新', src);
    }
  }
}

// =============================================================================================
// 1. 纯规则：GLB 头校验（服务端唯一会“看懂”字节的地方）
// =============================================================================================
const assets = await import(new URL('../dist/server/src/assets.js', import.meta.url).href);
section('1. GLB 头校验：magic / 版本 / 声明长度');
{
  // 一个最小的合法 GLB：12 字节头 + 一个 4 对齐的 JSON chunk。
  const glbOf = (jsonText, { magic = 'glTF', version = 2, declaredDelta = 0 } = {}) => {
    const json = Buffer.from(jsonText);
    const pad = (4 - (json.length % 4)) % 4;
    const chunk = Buffer.concat([json, Buffer.from(' '.repeat(pad))]);
    const total = 12 + 8 + chunk.length;
    const head = Buffer.alloc(12);
    head.write(magic, 0, 'ascii');
    head.writeUInt32LE(version, 4);
    head.writeUInt32LE(total + declaredDelta, 8);
    const chunkHead = Buffer.alloc(8);
    chunkHead.writeUInt32LE(chunk.length, 0);
    chunkHead.write('JSON', 4, 'ascii');
    return Buffer.concat([head, chunkHead, chunk]);
  };
  const good = glbOf('{"asset":{"version":"2.0"}}');
  check(assets.checkGlbHeader(good.subarray(0, 12), good.length) === null, '合法 GLB 通过', String(good.length));
  check((assets.checkGlbHeader(glbOf('{"asset":{"version":"2.0"}}', { magic: 'XXXX' }).subarray(0, 12), 100) ?? '').includes('不是 GLB'),
    'magic 不对 → 拒绝');
  check((assets.checkGlbHeader(glbOf('{}', { version: 3 }).subarray(0, 12), 20) ?? '').includes('版本'),
    'glTF 1.0 的 GLB → 拒绝');
  check((assets.checkGlbHeader(glbOf('{"asset":{"version":"2.0"}}', { declaredDelta: -10 }).subarray(0, 12), good.length) ?? '')
    .includes('不完整'), '头里声明的长度与实收不符（上传被截断）→ 拒绝');
  check((assets.checkGlbHeader(Buffer.from('short'), 5) ?? '').includes('太短'), '连头都不全 → 拒绝');

  check(assets.assetExtension('a.GLB') === 'glb', '扩展名小写化', assets.assetExtension('a.GLB'));
  check(assets.assetExtension('noext') === '' && assets.assetExtension('a.') === '', '没有扩展名 → 空串');
  check(assets.assetUrl('shooter', 'hero.glb') === '/assets/shooter/hero.glb', '对外 URL 是逻辑路由，不是磁盘路径',
    assets.assetUrl('shooter', 'hero.glb'));
  check(assets.ASSETS_DIR === path.join(ROOT, 'data', 'assets'), '默认资产根是 data/assets（dist 之外）',
    assets.ASSETS_DIR);
  check(assets.MAX_ASSET_BYTES === 256 * 1024 * 1024, '默认上限 256MB', String(assets.MAX_ASSET_BYTES));
}

// =============================================================================================
// 2. 纯规则：名字与路径（拒绝要在变成路径之前发生）
// =============================================================================================
section('2. 名字 / 路径校验：目录穿越与脏名字');
{
  for (const okName of ['hero.glb', 'A1.glb', 'a_b-c.d.glb', 'x' .repeat(1) + '.glb']) {
    check(assets.isValidAssetName(okName), '接受 ' + okName, okName);
  }
  for (const badName of ['', '.hidden.glb', '../evil.glb', 'a/b.glb', 'a\\b.glb', 'a..b.glb', 'x'.repeat(65) + '.glb', '-lead.glb']) {
    check(!assets.isValidAssetName(badName), '拒绝 ' + JSON.stringify(badName.slice(0, 24)));
  }
  check(assets.assetPath('shooter', 'hero.glb') === path.join(assets.ASSETS_DIR, 'shooter', 'hero.glb'),
    '合法名字解析成 data/assets/<app>/<name>');
  check(assets.assetPath('shooter', '../settings.json') === null, '穿越用的名字拿不到路径');
  check(assets.assetPath('../../etc', 'passwd') === null, '穿越用的 app id 拿不到路径');
  check(assets.assetPath('shooter', 'a/b.glb') === null, '名字里带分隔符拿不到路径');
}

// =============================================================================================
// 3. manifest 契约：assets.accepts 归一化（决定谁能接收资产）
// =============================================================================================
section('3. manifest：assets.accepts 的归一化（谁可以接收发布资产）');
{
  const types = await import(new URL('../dist/shared/src/types.js', import.meta.url).href);
  const n = (raw) => types.normalizeManifest({ id: 'x', name: 'x', assets: raw }, 'x').assets;
  check(n({ accepts: ['glb'] })?.accepts.join() === 'glb', '正常声明保留');
  check(n({ accepts: ['GLB', '.glb', 'glb', ' glb '] })?.accepts.join() === 'glb',
    '大小写/点/空格/重复都归一成一项', JSON.stringify(n({ accepts: ['GLB', '.glb', 'glb', ' glb '] })));
  check(n({ accepts: ['gltf', 'glb'] })?.accepts.join() === 'gltf,glb', '多种扩展名按声明顺序保留');
  check(n({ accepts: [] }) === undefined, '空数组 = 不接收（而不是“全都接收”）');
  check(n({ accepts: ['not an ext!'] }) === undefined && n({ accepts: 'glb' }) === undefined &&
    n({ accepts: [42] }) === undefined && n(undefined) === undefined && n('glb') === undefined,
    '脏数据一律当作“不接收”，不抛错');
  const real = JSON.parse(readFileSync(path.join(ROOT, 'apps/shooter/manifest.json'), 'utf8'));
  const normalized = types.normalizeManifest(real, 'shooter');
  check(normalized.assets?.accepts.join() === 'glb', '射击子应用的 manifest 声明了接收 .glb',
    JSON.stringify(normalized.assets));
}

// =============================================================================================
// 4. 客户端纯规则：名字清洗 / 目标解析 / 文案（apps/fbx2glb/src/publish.ts）
// =============================================================================================
const pub = await import(new URL('../dist/apps/fbx2glb/src/publish.js', import.meta.url).href);
section('4. 发布客户端：名字清洗、目标解析、文案');
{
  check(pub.sanitizeAssetName('Ch15_nonPBR.fbx', 'glb') === 'Ch15_nonPBR.glb', 'ASCII 名照抄',
    pub.sanitizeAssetName('Ch15_nonPBR.fbx', 'glb'));
  check(pub.sanitizeAssetName('my hero v2.fbx', 'glb') === 'my-hero-v2.glb', '空格 → -',
    pub.sanitizeAssetName('my hero v2.fbx', 'glb'));
  check(pub.sanitizeAssetName('我的角色(最终版).fbx', 'glb') === 'model.glb',
    '纯中文名 → model.glb（名字要能进 URL 与游戏代码；日志会写出真实名字）',
    pub.sanitizeAssetName('我的角色(最终版).fbx', 'glb'));
  check(pub.sanitizeAssetName('..//..evil.fbx', 'glb') === 'evil.glb', '路径片段被剥掉',
    pub.sanitizeAssetName('..//..evil.fbx', 'glb'));
  check(pub.sanitizeAssetName('---.fbx', 'glb') === 'model.glb', '清完为空 → model');
  const long = pub.sanitizeAssetName('x'.repeat(200) + '.fbx', 'glb');
  check(long.length <= 64 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(long), '超长名截断到 64 字符以内且仍合法',
    long.length + ' 字符');
  check(pub.sanitizeAssetName('hero.fbx', 'GLTF ') === 'hero.gltf', '扩展名也会被清洗',
    pub.sanitizeAssetName('hero.fbx', 'GLTF '));
  check(pub.publishNameFor('sample.glb', '', 'glb') === 'sample.glb', '不填覆盖名 → 用产物名');
  check(pub.publishNameFor('sample.glb', 'player one', 'glb') === 'player-one.glb', '填了就用填的');
  check(pub.extensionOf('a.GLB') === 'glb' && pub.extensionOf('a') === '', '扩展名判定');

  const shooter = { id: 'shooter', name: '射击竞技场', accepts: ['glb'] };
  const cardgame = { id: 'cards', name: '卡牌', accepts: ['png'] };
  check(pub.resolveTarget('', [shooter, cardgame]) === shooter, '空设置（自动）→ 第一个目标');
  check(pub.resolveTarget('cards', [shooter, cardgame]) === cardgame, '设置了就听设置');
  check(pub.resolveTarget('gone', [shooter, cardgame]) === shooter, '设置里的应用不在了 → 回落到第一个（不重写存储）');
  check(pub.resolveTarget('shooter', []) === null, '没有目标 → null（按钮禁用）');
  check(pub.targetAccepts(shooter, 'glb') && !pub.targetAccepts(shooter, 'gltf') && !pub.targetAccepts(null, 'glb'),
    '接收扩展名判定');
  check((pub.blockedReason(null, 'glb') ?? '').includes('manifest'), '没有目标时说明原因（指向 manifest）',
    pub.blockedReason(null, 'glb'));
  const gltfTarget = { id: 'g', name: 'G', accepts: ['gltf'] };
  check((pub.blockedReason(gltfTarget, 'glb') ?? '').includes('转换选项'),
    '目标只收 .gltf 时给出可执行的建议（去转换选项改格式）', pub.blockedReason(gltfTarget, 'glb'));
  check((pub.blockedReason(cardgame, 'glb') ?? '').includes('.png') &&
    !(pub.blockedReason(cardgame, 'glb') ?? '').includes('转换选项'),
    '目标只收 .png 时不给做不到的建议（转换器根本导不出 png）', pub.blockedReason(cardgame, 'glb'));
  check(pub.blockedReason(shooter, 'glb') === null, '能发的时候没有理由');

  check(pub.formatAssetTime(0) === '', '时间 0 → 空串（不打印 1970）');
  check(/^\d\d-\d\d \d\d:\d\d$/.test(pub.formatAssetTime(Date.UTC(2026, 7, 14, 1, 31))), '时间格式 MM-DD HH:mm',
    pub.formatAssetTime(Date.UTC(2026, 7, 14, 1, 31)));
  check(pub.publishedSummary(null, []).includes('没有'), '没有目标时的摘要');
  check(pub.publishedSummary(shooter, []).includes('还没有'), '有目标但没有资产时的摘要');
  const summary = pub.publishedSummary(shooter, [{ name: 'a.glb', bytes: 2048, mtime: 0 }, { name: 'b.glb', bytes: 2048, mtime: 0 }]);
  check(summary.includes('2 个资产') && summary.includes('4.0 KB'), '摘要写清个数与总体积', summary);
  check(pub.publishResultText('a.glb', 4096, shooter, true, '/assets/shooter/a.glb').includes('覆盖'),
    '覆盖时明说（同名发布不是静默的）');
  check(pub.assetUrl('shooter', 'a.glb') === '/assets/shooter/a.glb', 'URL 构造');

  // 源码级：所有 url 都是同源的（绝不可能是别的服务器）
  const src = readFileSync(path.join(ROOT, 'apps/fbx2glb/src/publish.ts'), 'utf8');
  const urls = [...src.matchAll(/fetch\(\s*([^,)]+)/g)].map((m) => m[1].trim());
  check(urls.length >= 4, '客户端有 ' + urls.length + ' 个 fetch 调用点', urls.join(' | '));
  check(urls.every((u) => u.startsWith("'/api/")), '每一个都是同源的 /api/ 路由（相对地址）', urls.join(' | '));
  check(!/https?:\/\//.test(src), '源码里没有任何绝对 URL（模型不可能被发到别处）');
}

// =============================================================================================
// 5. 真实服务器：起一个临时实例（PORTAL_DATA_DIR 指向临时目录 + 1MB 上限）
// =============================================================================================
section('5. 真实服务器：发布 / 列表 / 读取 / 覆盖 / 删除');
const tmpRoot = mkdtempSync(path.join(ROOT, '.verify-assets-'));
const dataDir = path.join(tmpRoot, 'data');
let child = null;
let port = 0;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

const glbOf = (jsonText, { declaredDelta = 0 } = {}) => {
  const json = Buffer.from(jsonText);
  const pad = (4 - (json.length % 4)) % 4;
  const chunk = Buffer.concat([json, Buffer.from(' '.repeat(pad))]);
  const total = 12 + 8 + chunk.length;
  const head = Buffer.alloc(12);
  head.write('glTF', 0, 'ascii');
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(total + declaredDelta, 8);
  const chunkHead = Buffer.alloc(8);
  chunkHead.writeUInt32LE(chunk.length, 0);
  chunkHead.write('JSON', 4, 'ascii');
  return Buffer.concat([head, chunkHead, chunk]);
};

async function serverUp(base, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(base + '/api/portal');
      if (res.ok) return true;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

const serverLog = [];
try {
  port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  child = spawn(process.execPath, [path.join(ROOT, 'dist/server/src/index.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', PORTAL_DATA_DIR: dataDir, PORTAL_MAX_ASSET_MB: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (b) => serverLog.push(String(b)));
  child.stderr.on('data', (b) => serverLog.push(String(b)));
  const up = await serverUp(base);
  check(up, '临时服务器起来了（PORT=' + port + '，PORTAL_DATA_DIR=' + path.relative(ROOT, dataDir) + '）',
    up ? '' : serverLog.join(''));
  if (!up) throw new Error('server did not start');

  const assetDir = path.join(dataDir, 'assets', 'shooter');
  const filesIn = (dir) => { try { return readdirSync(dir); } catch { return []; } };
  const put = (name, body, type = 'model/gltf-binary') =>
    fetch(base + '/api/assets/shooter/' + name, { method: 'PUT', headers: { 'Content-Type': type }, body });

  // ---- 5.1 发现：谁能接收资产 ----
  const all = await (await fetch(base + '/api/assets')).json();
  check(all.root === 'data/assets', 'GET /api/assets 说明了资产根', String(all.root));
  check(all.apps.length === 1 && all.apps[0].id === 'shooter',
    '只有声明了 assets.accepts 的应用出现（' + all.apps.map((a) => a.id).join(',') + '）');
  check(all.apps[0].accepts.join() === 'glb' && all.apps[0].files.length === 0, '新库里没有资产');
  const listRes = await fetch(base + '/api/assets/shooter');
  check(listRes.status === 200, 'GET /api/assets/shooter → 200');
  const missingApp = await fetch(base + '/api/assets/nope');
  check(missingApp.status === 404, '未知应用 → 404', String(missingApp.status));

  // ---- 5.2 发布 → 列表 → 读取 ----
  const hero = glbOf('{"asset":{"version":"2.0"},"scenes":[{"nodes":[]}],"scene":0}');
  const putRes = await put('hero.glb', hero);
  const putBody = await putRes.json();
  check(putRes.status === 201, '首次发布 → 201', String(putRes.status));
  check(putBody.bytes === hero.length && putBody.replaced === false, '回包里带字节数与 replaced=false',
    JSON.stringify({ bytes: putBody.bytes, replaced: putBody.replaced }));
  check(putBody.url === '/assets/shooter/hero.glb', '回包里给出游戏要用的 URL', String(putBody.url));
  check(existsSync(path.join(assetDir, 'hero.glb')), '文件落在 <PORTAL_DATA_DIR>/assets/shooter/ 下（不是用户的 data/）',
    path.relative(ROOT, assetDir));
  const list = await (await fetch(base + '/api/assets/shooter')).json();
  check(list.files.length === 1 && list.files[0].name === 'hero.glb', '列表里有它',
    JSON.stringify(list.files.map((f) => f.name)));
  check(list.files[0].bytes === hero.length && typeof list.files[0].mtime === 'number', '列表带字节数与 mtime',
    JSON.stringify(list.files[0]));
  const got = await fetch(base + '/assets/shooter/hero.glb');
  const gotBytes = Buffer.from(await got.arrayBuffer());
  check(got.status === 200 && got.headers.get('content-type') === 'model/gltf-binary',
    'GET /assets/shooter/hero.glb → 200 + model/gltf-binary', got.status + ' ' + got.headers.get('content-type'));
  check(Buffer.compare(gotBytes, hero) === 0, '读回来的字节与发布的一模一样', gotBytes.length + ' vs ' + hero.length);
  check(!existsSync(path.join(ROOT, 'dist/assets/shooter/hero.glb')), '没有跑进 dist/（重新构建不会丢）');
  check(filesIn(assetDir).every((n) => !n.startsWith('.') && !n.endsWith('.part')), '临时文件没有留在目录里',
    filesIn(assetDir).join(','));

  // ---- 5.3 覆盖：同名原子替换 ----
  const hero2 = glbOf('{"asset":{"version":"2.0"},"extras":{"v":2},"scenes":[{"nodes":[]}],"scene":0}');
  const put2 = await put('hero.glb', hero2);
  const put2Body = await put2.json();
  check(put2.status === 200 && put2Body.replaced === true, '同名再发布 → 200 + replaced=true',
    put2.status + ' ' + JSON.stringify(put2Body.replaced));
  const got2 = Buffer.from(await (await fetch(base + '/assets/shooter/hero.glb')).arrayBuffer());
  check(Buffer.compare(got2, hero2) === 0, '内容被换成新的');
  check((await (await fetch(base + '/api/assets/shooter')).json()).files.length === 1, '列表里还是一个（没有多出副本）');

  // ---- 5.4 拒绝：坏名字 / 坏扩展名 / 没声明接收的应用 ----
  const noIntake = await fetch(base + '/api/assets/notes/x.glb', { method: 'PUT', body: hero });
  check(noIntake.status === 415, '没声明 assets.accepts 的应用 → 415', String(noIntake.status));
  const wrongExt = await put('hero.png', hero);
  check(wrongExt.status === 415 && (await wrongExt.json()).error.includes('.glb'),
    '扩展名不在 accepts 里 → 415（并说出只收什么）', String(wrongExt.status));
  const noExt = await put('hero', hero);
  check(noExt.status === 415, '没有扩展名 → 415', String(noExt.status));
  const traversal = await put('..%2Fevil.glb', hero);
  check(traversal.status === 400, '路径穿越的名字 → 400', String(traversal.status));
  check(!existsSync(path.join(dataDir, 'assets', 'evil.glb')), '穿越没有落下任何文件');
  const empty = await fetch(base + '/api/assets/shooter/empty.glb', { method: 'PUT', body: Buffer.alloc(0) });
  check(empty.status === 400, '空请求体 → 400', String(empty.status));

  // ---- 5.5 校验不过时，已发布的那个必须原封不动 ----
  const beforeStat = statSync(path.join(assetDir, 'hero.glb'));
  const truncated = await put('hero.glb', glbOf('{"asset":{"version":"2.0"}}', { declaredDelta: -10 }));
  check(truncated.status === 400 && (await truncated.json()).error.includes('不完整'),
    '被截断的 GLB → 400（并且说清是长度对不上）', String(truncated.status));
  const junk = await put('hero.glb', Buffer.from('<!doctype html><html>404</html>'));
  check(junk.status === 400 && (await junk.json()).error.includes('不是 GLB'), 'HTML 错误页 → 400', String(junk.status));
  const afterStat = statSync(path.join(assetDir, 'hero.glb'));
  check(afterStat.size === beforeStat.size && afterStat.mtimeMs === beforeStat.mtimeMs,
    '两次失败之后原资产字节与 mtime 都没变（失败的上传不会毁掉已发布的）');
  check(Buffer.compare(Buffer.from(await (await fetch(base + '/assets/shooter/hero.glb')).arrayBuffer()), hero2) === 0,
    '读回来还是上一版内容');
  check(filesIn(assetDir).every((n) => !n.endsWith('.part')), '失败的上传没有留下 .part 文件',
    filesIn(assetDir).join(','));

  // ---- 5.6 上限（子进程用 PORTAL_MAX_ASSET_MB=1 启动） ----
  const big = glbOf('{"asset":{"version":"2.0"},"pad":"' + 'x'.repeat(1_500_000) + '"}');
  const tooBig = await put('big.glb', big);
  const tooBigBody = await tooBig.json();
  check(tooBig.status === 413, '超过上限的上传 → 413（上限是 1MB 的测试实例）', String(tooBig.status));
  check(tooBigBody.error.includes('压缩贴图'), '413 的文案把用户指回压缩贴图（而不是只报错）', tooBigBody.error);
  check(!existsSync(path.join(assetDir, 'big.glb')), '被拒的大文件没有落盘');
  check(filesIn(assetDir).every((n) => !n.endsWith('.part')), '被拒的大文件也没留下 .part',
    filesIn(assetDir).join(','));

  // ---- 5.7 与应用自带的资产并存（两条不同的路径，别搞混） ----
  const vendored = await fetch(base + '/apps/shooter/assets/models/cyber_human.glb');
  // `.glb` was added to the server's MIME map for this feature, so the vendored file is now served as
  // model/gltf-binary too (it used to fall through to application/octet-stream) — a free improvement.
  check(vendored.status === 200 && (vendored.headers.get('content-type') ?? '') === 'model/gltf-binary',
    '子应用自带的 apps/shooter/assets/ 仍然从 dist/ 正常服务（与外部资产是两处）',
    vendored.status + ' ' + vendored.headers.get('content-type'));
  const hardcodedMissing = await fetch(base + '/assets/shooter/assets/models/cyber_human.glb');
  check(hardcodedMissing.status === 404, '外部资产根里没有自带资产（不是同一棵目录树）', String(hardcodedMissing.status));

  // ---- 5.8 穿越与直读 ----
  const esc = await fetch(base + '/assets/shooter/..%2F..%2Fsettings.json');
  check(esc.status === 404, '通过 /assets 读回 settings.json → 404', String(esc.status));
  const esc2 = await fetch(base + '/assets/..%2F..%2Fpackage.json');
  check(esc2.status === 404, '通过 app id 穿越 → 404', String(esc2.status));

  // ---- 5.9 删除 ----
  const del = await fetch(base + '/api/assets/shooter/hero.glb', { method: 'DELETE' });
  check(del.status === 200, 'DELETE → 200', String(del.status));
  check(!existsSync(path.join(assetDir, 'hero.glb')), '文件真的没了');
  check((await (await fetch(base + '/assets/shooter/hero.glb')).status) === 404, '再读 → 404');
  const del2 = await fetch(base + '/api/assets/shooter/hero.glb', { method: 'DELETE' });
  check(del2.status === 404, '再删 → 404', String(del2.status));
  check((await (await fetch(base + '/api/assets/shooter')).json()).files.length === 0, '列表空了');
  const method = await fetch(base + '/api/assets/shooter/hero.glb', { method: 'POST', body: hero });
  check(method.status === 405, 'POST 不允许 → 405（发布只走 PUT）', String(method.status));
} catch (err) {
  check(false, '服务器测试段没有抛错', err instanceof Error ? err.message : String(err));
} finally {
  if (child) {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
  rmSync(tmpRoot, { recursive: true, force: true });
  check(!existsSync(tmpRoot), '临时目录已清理');
}

// =============================================================================================
console.log(`\n${checks} 项断言，${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
