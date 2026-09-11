/**
 * `POST /api/fbx2glb/convert` — the sub-app's HTTP API: send an FBX, get a GLB back.
 *
 * WHY AN ENDPOINT ON THE PORTAL SERVER (and not a JS module other apps import): sub-apps must not
 * import each other (AGENTS.md), so the only honest cross-app contract is HTTP — the same rule the
 * external asset directory follows. That also makes the pipeline scriptable, which is the point on a
 * phone: `curl --data-binary @hero.fbx localhost:3000/api/fbx2glb/convert -o hero.glb` replaces
 * "pick a file in the picker, wait, tap download".
 *
 * THE CONVERSION ITSELF IS NOT IMPLEMENTED HERE. This module owns the HTTP concerns (validation,
 * streaming the upload to disk, queueing, the worker's lifetime, the response) and delegates the actual
 * work to `fbx2glbWorker.ts`, which runs the app's own modules. Nothing in this file knows what a bone
 * is — which is why it can be reasoned about (and tested) on its own.
 *
 * WHY THE UPLOAD STREAMS TO DISK: `data/tmp/` (gitignored, outside dist/, not watched) holds the FBX
 * while the worker reads it. Buffering a 100MB+ upload in the server process on a phone is the kind of
 * thing that turns one bad request into a dead portal; the same reasoning as the asset upload.
 *
 * ONE CONVERSION AT A TIME (serialized): a phone has a handful of cores and three's parse is
 * single-threaded CPU work — running four conversions concurrently would only make all four slower
 * while the game's asset requests wait. Requests queue instead of failing, and a conversion that hangs
 * is killed by a timeout (`CONVERT_TIMEOUT_MS`) so the queue always drains.
 */
import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Worker } from 'node:worker_threads';
import { DATA_DIR } from './settings.js';
import type { ConvertReport, WorkerJob, WorkerMessage, WorkerOptions } from './fbx2glbWorker.js';

/** Scratch space for one conversion (the uploaded FBX and the produced GLB). */
export const TMP_DIR = path.join(DATA_DIR, 'tmp');
/** Accepted `scale` values — the same three the page offers (units.ts owns their meaning). */
export const SCALE_MODES = ['auto', 'keep', 'cm'] as const;
/** Query parameters this endpoint understands. Asserted against the discovery endpoint by the tests. */
export const CONVERT_PARAMS = ['name', 'scale', 'animations', 'decimate', 'ratio', 'error', 'lockBorder', 'pack'] as const;

function envMb(name: string, fallback: number): number {
  const mb = Number(process.env[name]);
  if (!Number.isFinite(mb) || mb <= 0) return fallback * 1024 * 1024;
  return Math.min(Math.floor(mb), 4096) * 1024 * 1024;
}
/** Upload cap for the API. Smaller than the asset cap on purpose: this is the *source* FBX, whose
 *  in-memory expansion (three's scene graph) is several times its size. */
export const MAX_FBX_BYTES = envMb('PORTAL_MAX_FBX_MB', 128);
/** A conversion that does not finish in this long is killed and reported as 504. */
export const CONVERT_TIMEOUT_MS = 120_000;

export interface ConvertRequest {
  file: string;
  options: WorkerOptions;
}

type ParseResult = { ok: true; value: ConvertRequest } | { ok: false; error: string };

/** Keep the caller-supplied name harmless: it only ever appears in reports and error messages. */
function safeReportName(raw: string | null): string {
  const base = String(raw ?? '').split(/[/\\]/).pop() ?? '';
  const cleaned = base.replace(/[^A-Za-z0-9._ -]+/g, '-').replace(/^[-. ]+/, '').slice(0, 80);
  return cleaned === '' ? 'upload.fbx' : cleaned;
}

/**
 * Validate the query string. Deliberately STRICT about unknown parameters (a typo like `?decmate=1`
 * would otherwise silently convert with the defaults) and deliberately permissive about the numbers:
 * range clamping belongs to the app's own settings module, which the worker applies, so an
 * out-of-range `ratio` is snapped exactly like the UI and the effective value is in the response
 * headers instead of being a hard error.
 */
export function parseConvertQuery(params: URLSearchParams): ParseResult {
  for (const key of params.keys()) {
    if (!(CONVERT_PARAMS as readonly string[]).includes(key)) {
      return { ok: false, error: `未知参数 ?${key}=（可用：${CONVERT_PARAMS.join(', ')}）` };
    }
  }
  const scale = params.get('scale') ?? 'auto';
  if (!(SCALE_MODES as readonly string[]).includes(scale)) {
    return { ok: false, error: `scale 只能是 ${SCALE_MODES.join(' / ')}（收到 ${JSON.stringify(scale)}）` };
  }
  const flags: Record<string, boolean> = { animations: true, decimate: false, lockBorder: true, pack: false };
  for (const [key, fallback] of Object.entries(flags)) {
    const raw = params.get(key);
    if (raw === null) { flags[key] = fallback; continue; }
    const v = raw.toLowerCase();
    if (v === '1' || v === 'true' || v === 'yes' || v === '') flags[key] = true;
    else if (v === '0' || v === 'false' || v === 'no') flags[key] = false;
    else return { ok: false, error: `${key} 只能是 1/0（收到 ${JSON.stringify(raw)}）` };
  }
  if (flags.pack) {
    return {
      ok: false,
      error: '服务器端没有 canvas，压贴图只能在 apps/fbx2glb 的页面里做；本 API 只做几何/蒙皮/动画（去掉 pack 参数即可）',
    };
  }
  const number = (key: string, fallback: number): number | null => {
    const raw = params.get(key);
    if (raw === null) return fallback;
    const v = Number(raw);
    return Number.isFinite(v) ? v : null;
  };
  const ratio = number('ratio', 0.5);
  const error = number('error', 0.01);
  if (ratio === null) return { ok: false, error: 'ratio 必须是数字（0.05–1）' };
  if (error === null) return { ok: false, error: 'error 必须是数字（0.001–0.15）' };
  return {
    ok: true,
    value: {
      file: safeReportName(params.get('name')),
      options: {
        scale: scale as WorkerOptions['scale'],
        animations: flags.animations!,
        decimate: { enabled: flags.decimate!, ratio, error, lockBorder: flags.lockBorder! },
      },
    },
  };
}

/**
 * Delete whatever is left in `data/tmp/` (called once at server startup).
 *
 * WHY A BOOT SWEEP IS NEEDED even though every request cleans up after itself: the cleanup runs in the
 * request's `finally`, so a process that DIES mid-conversion leaves its scratch files behind — and that
 * is not hypothetical here, it happened while developing this: `npm run dev` restarted the server
 * because a source file changed while a conversion was in flight, and a 10KB `*.fbx` stayed in
 * `data/tmp/` forever. At boot nothing can be in flight, so the directory is safe to empty.
 */
export async function cleanStaleTmp(): Promise<number> {
  let names: string[] = [];
  try {
    names = await fs.readdir(TMP_DIR);
  } catch {
    return 0; // no directory yet — nothing to clean
  }
  let removed = 0;
  for (const name of names) {
    // `readdir` never returns a separator, so this cannot escape TMP_DIR. Directories are left alone.
    try {
      const full = path.join(TMP_DIR, name);
      if ((await fs.stat(full)).isFile()) {
        await fs.unlink(full);
        removed++;
      }
    } catch {
      // vanished or not removable — the next sweep will try again
    }
  }
  return removed;
}

/** One conversion at a time (see the header). Never rejects: a failed job must not poison the queue. */
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const next = queue.then(job, job);
  queue = next.catch(() => {});
  return next;
}

type RunResult = { ok: true; report: ConvertReport } | { ok: false; status: number; error: string };

/** Run one conversion in a worker, with a hard timeout and guaranteed termination. */
function runWorker(job: WorkerJob): Promise<RunResult> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL('./fbx2glbWorker.js', import.meta.url), { workerData: job });
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    };
    timer = setTimeout(() => {
      finish({ ok: false, status: 504, error: `转换超时（超过 ${Math.round(CONVERT_TIMEOUT_MS / 1000)} 秒），已中止` });
    }, CONVERT_TIMEOUT_MS);
    worker.on('message', (msg: WorkerMessage) => {
      if (msg && msg.ok) finish({ ok: true, report: msg.report });
      else finish({ ok: false, status: msg?.status ?? 500, error: msg?.error ?? '未知错误' });
    });
    worker.on('error', (err: Error) => finish({ ok: false, status: 500, error: '转换进程崩溃：' + err.message }));
    worker.on('exit', (code) => finish({ ok: false, status: 500, error: '转换进程提前退出（code ' + code + '）' }));
  });
}

/** Headers a non-browser caller reads INSTEAD of opening the file (curl -D- shows them). */
function reportHeaders(report: ConvertReport): Record<string, string> {
  const enc = (s: string): string => encodeURIComponent(s);
  return {
    'X-Fbx2Glb-Bytes': String(report.bytes),
    'X-Fbx2Glb-Meshes': String(report.meshes),
    'X-Fbx2Glb-Bones': String(report.bones),
    'X-Fbx2Glb-Clips': String(report.clips.length),
    'X-Fbx2Glb-Clip-Names': enc(report.clips.join(',')),
    'X-Fbx2Glb-Triangles': String(report.triangles),
    'X-Fbx2Glb-Height': report.scaledHeight.toFixed(3),
    'X-Fbx2Glb-Scale': String(report.scale) + (report.autoScale ? ' (auto)' : ''),
    // ASCII only: Node refuses to write a non-Latin1 header value, so no Chinese in headers.
    'X-Fbx2Glb-Decimate': report.decimate.meshes > 0
      ? `${report.decimate.before}->${report.decimate.after};meshes=${report.decimate.meshes};ms=${report.decimate.ms}`
      : 'off',
    // The honest answer to "did I lose the textures?": the API never has an image decoder.
    'X-Fbx2Glb-Textures': `requested=${report.textures.requested};dropped=${report.textures.dropped}`,
    'X-Fbx2Glb-Self-Check': report.selfCheck.ok ? 'ok' : 'failed',
    'X-Fbx2Glb-Warnings': enc(report.warnings.join(' | ')),
  };
}

function outputName(file: string): string {
  return file.replace(/\.[A-Za-z0-9]{1,8}$/, '') + '.glb';
}

type SendResult = { ok: true; bytes: number } | { ok: false; code: number; error: string };

/**
 * Stream a request body into a file with a hard cap. (Kept local instead of imported from assets.ts:
 * the asset store's version is part of that module's published contract, and the two have nothing in
 * common besides the loop — but if a third caller appears, this moves into its own module.)
 */
function receiveToFile(req: IncomingMessage, dest: string, maxBytes: number): Promise<SendResult> {
  return new Promise((resolve) => {
    const out = createWriteStream(dest);
    let size = 0;
    let over = false;
    let done = false;
    const finish = (r: SendResult): void => { if (!done) { done = true; resolve(r); } };
    const fail = (r: SendResult): void => {
      try { out.destroy(); } catch { /* already gone */ }
      void fs.unlink(dest).catch(() => {});
      finish(r);
    };
    out.on('error', (err) => {
      fail({ ok: false, code: 500, error: '写入临时文件失败：' + (err instanceof Error ? err.message : String(err)) });
    });
    req.on('data', (chunk: Buffer) => {
      if (over) return;
      size += chunk.length;
      if (size > maxBytes) { over = true; return; } // keep draining so the caller sees the 413
      if (!out.write(chunk)) {
        req.pause();
        out.once('drain', () => req.resume());
      }
    });
    req.on('end', () => {
      if (over) {
        return fail({
          ok: false, code: 413,
          error: `FBX 太大（上限 ${Math.floor(maxBytes / (1024 * 1024))} MB）。先用 Blender 之类导出成更小的 FBX，或用页面转换`,
        });
      }
      if (size === 0) return fail({ ok: false, code: 400, error: '请求体是空的（把 FBX 文件作为 body 发过来）' });
      out.end(() => finish({ ok: true, bytes: size }));
    });
    req.on('error', () => fail({ ok: false, code: 400, error: '请求中断' }));
    req.on('aborted', () => fail({ ok: false, code: 400, error: '请求中断' }));
  });
}

function sendJson(res: ServerResponse, code: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-cache' });
  res.end(body);
}

/**
 * Handle `POST /api/fbx2glb/convert`. Owns the response (it streams a possibly large GLB), so the route
 * table just calls it. Never throws: every failure becomes a JSON error with a status a caller can act
 * on (400 caller's fault, 413 too big, 504 too slow, 500 ours).
 */
export async function handleConvert(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const parsed = parseConvertQuery(url.searchParams);
  if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });
  const { file, options } = parsed.value;

  const stem = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const inPath = path.join(TMP_DIR, stem + '.fbx');
  const outPath = path.join(TMP_DIR, stem + '.glb');
  try {
    await fs.mkdir(TMP_DIR, { recursive: true });
    const upload = await receiveToFile(req, inPath, MAX_FBX_BYTES);
    if (!upload.ok) return sendJson(res, upload.code, { error: upload.error });

    const run = await enqueue(() => runWorker({ inPath, outPath, file, options }));
    if (!run.ok) {
      const detail = /不是 FBX|不是 glTF|既不是|无法识别/.test(run.error)
        ? run.error + '（这个接口只接受 FBX；.glb/.gltf 请直接用 /api/assets/<应用>/ 发布）'
        : run.error;
      return sendJson(res, run.status, { error: detail });
    }
    const report = run.report;
    const stat = await fs.stat(outPath);
    const name = outputName(file);
    res.writeHead(200, {
      'Content-Type': 'model/gltf-binary',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-cache',
      'X-Fbx2Glb-Input-Bytes': String(upload.bytes),
      'X-Fbx2Glb-Output-Name': name,
      ...reportHeaders(report),
    });
    const stream = createReadStream(outPath);
    stream.on('error', () => { try { res.destroy(); } catch { /* already gone */ } });
    stream.pipe(res);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) sendJson(res, 500, { error: '转换失败：' + message });
    else { try { res.destroy(); } catch { /* already gone */ } }
  } finally {
    // Cleanup runs after the response has been piped, which is safe: the read stream keeps its own
    // handle... except on Linux unlink-while-reading is fine (the fd stays valid). Do it in a
    // `setImmediate` so the pipe is done with the path in the common case.
    setImmediate(() => {
      void fs.unlink(inPath).catch(() => {});
      void fs.unlink(outPath).catch(() => {});
      void fs.rmdir(TMP_DIR).catch(() => {});
    });
  }
}

/** `GET /api/fbx2glb` — machine-readable description of the endpoint (the docs point here). */
export function apiDescription(): unknown {
  return {
    app: 'fbx2glb',
    endpoint: 'POST /api/fbx2glb/convert',
    body: 'FBX 文件本身（binary 或 ASCII，裸字节；不是 base64/JSON/multipart）',
    response: 'GLB 二进制（Content-Type: model/gltf-binary，带 Content-Disposition），元数据走响应头',
    params: {
      name: '报告中使用的文件名（默认 upload.fbx）',
      scale: 'auto | keep | cm（默认 auto：量出高度 > 20 就 ×0.01）',
      animations: '1/0，是否写入动画（默认 1）',
      decimate: '1/0，是否减面（默认 0）',
      ratio: '减面保留比例（0.05–1，默认 0.5；越界按页面同样的规则吸附）',
      error: '减面误差上限（0.001–0.15，默认 0.01）',
      lockBorder: '1/0，减面是否锁边界保护剪影（默认 1）',
      pack: '只能传 0；传 1 会被 400 拒绝（服务器端没有 canvas，压贴图只在页面里做）',
    },
    headers: [
      'X-Fbx2Glb-Bytes', 'X-Fbx2Glb-Meshes', 'X-Fbx2Glb-Bones', 'X-Fbx2Glb-Clips',
      'X-Fbx2Glb-Clip-Names', 'X-Fbx2Glb-Triangles', 'X-Fbx2Glb-Height', 'X-Fbx2Glb-Scale',
      'X-Fbx2Glb-Decimate', 'X-Fbx2Glb-Textures', 'X-Fbx2Glb-Self-Check', 'X-Fbx2Glb-Warnings',
    ],
    limits: {
      maxFbxBytes: MAX_FBX_BYTES,
      timeoutMs: CONVERT_TIMEOUT_MS,
      concurrency: 1,
    },
    unsupported: [
      '贴图：服务器端没有图片解码器/canvas，所有贴图槽都会被去掉（X-Fbx2Glb-Textures 会报数）——要带贴图请在页面里转换',
      '压贴图（pack=1）、合并多个 FBX、.glb/.gltf 输入：都只在页面里做',
    ],
  };
}
