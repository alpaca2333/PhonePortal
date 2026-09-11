/**
 * External asset store — assets PUBLISHED at runtime by one sub-app into another sub-app's folder.
 *
 * Today the only publisher is the FBX→GLB converter and the only receiver is the shooter, but nothing
 * here is specific to either: the receiver DECLARES its intake in its manifest
 * (`"assets": { "accepts": ["glb"] }`, see shared/src/types.ts), and the publisher discovers the
 * target list from `/api/manifest`. A new game therefore needs no server change.
 *
 * WHERE THE FILES LIVE — `data/assets/<appId>/<name>`, and why not somewhere more obvious:
 *   - NOT under `apps/<id>/assets/`: `scripts/dev-serve.mjs` polls `apps/` and rebuilds + restarts the
 *     server on ANY change, so every publish would cost a full tsc build and a server restart; worse,
 *     `scripts/build.mjs` copies `apps/` into `dist/`, so a 20 MB .glb would be re-copied on every
 *     build and re-copied again on the atomic `dist.next → dist` swap.
 *   - NOT under `dist/`: the build replaces `dist/` wholesale (rm + rename), so anything stored there
 *     is destroyed by the next rebuild — the exact reason settings live in `data/` too.
 *   - `data/` is gitignored, which is also the right default for multi-MB user content: GitHub hard-
 *     fails a push over 100 MB, so publishing a bought model must not be able to break the repo.
 *
 * The served URL is `/assets/<appId>/<name>` (deliberately NOT the on-disk path): it is a logical,
 * app-scoped route, so the storage layout can change without touching a single game.
 *
 * NAME/SAFETY RULES (all of them are asserted in scripts/verify-assets.mjs):
 *   - names must match ASSET_NAME_RE and may not contain ".." — the publisher sanitises to ASCII, so a
 *     CJK model name becomes `model.glb` rather than a URL-encoded minefield;
 *   - the extension must be one the app declared (the route checks it, not this module);
 *   - uploads stream to a hidden `.<name>.<rand>.part` and are renamed into place only after the GLB
 *     header validates, so a failed/aborted upload cannot damage the asset that is already there, and
 *     a reader never sees a half-written file;
 *   - list/delete only ever touch files matching the same name rules, so stray temp files are invisible.
 */
import { promises as fs, createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { DATA_DIR } from "./settings.js";

/** Root of every published asset. Sibling of `dist/`, inside the gitignored `data/`. */
export const ASSETS_DIR = path.join(DATA_DIR, "assets");
/** Logical URL prefix: `/assets/<appId>/<name>`. */
export const ASSET_URL_PREFIX = "/assets/";

/** App ids are scope-like: same shape the settings API accepts. */
export const ASSET_APP_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/i;
/** One file name: starts alphanumeric, no separators, dotfiles and `*.part` can never match. */
export const ASSET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Upload cap. Overridable for testing (`PORTAL_MAX_ASSET_MB`) and clamped to a sane band so a typo
 * cannot disable the limit: NaN/negative falls back to the default, and an absurd value is capped.
 * Publishing an unoptimised 264 MB model into a phone game is exactly what the converter's texture
 * compression exists to prevent, hence the error message points at it.
 */
function maxAssetBytes(): number {
  const DEFAULT_MB = 256;
  const HARD_MAX_MB = 4096;
  const mb = Number(process.env.PORTAL_MAX_ASSET_MB);
  if (!Number.isFinite(mb) || mb <= 0) return DEFAULT_MB * 1024 * 1024;
  return Math.min(Math.floor(mb), HARD_MAX_MB) * 1024 * 1024;
}
export const MAX_ASSET_BYTES = maxAssetBytes();

export interface AssetFile {
  name: string;
  bytes: number;
  /** Modification time in ms since epoch (the client renders it; the test only checks it is a number). */
  mtime: number;
}

export function isValidAssetName(name: string): boolean {
  // ".." cannot traverse on its own (the regex forbids separators) but there is no reason to allow
  // a name that looks like a path fragment — future code must not have to reason about it.
  return ASSET_NAME_RE.test(name) && !name.includes("..");
}

/** Lowercase extension without the dot, or "" when there is none. */
export function assetExtension(name: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return m ? m[1]!.toLowerCase() : "";
}

export function assetDir(appId: string): string {
  return path.join(ASSETS_DIR, appId);
}

/** Absolute path for one asset, or null when the app id / name is not acceptable. */
export function assetPath(appId: string, name: string): string | null {
  if (!ASSET_APP_RE.test(appId) || !isValidAssetName(name)) return null;
  const dir = assetDir(appId);
  const full = path.resolve(dir, name);
  // Belt and braces: the two regexes already forbid path separators, so this can only ever fire if
  // someone loosens them later — and then it fires instead of serving /etc/passwd.
  if (!full.startsWith(dir + path.sep)) return null;
  return full;
}

export function assetUrl(appId: string, name: string): string {
  // Both halves are ASCII by construction (ASSET_APP_RE / ASSET_NAME_RE), so no encoding is needed.
  return ASSET_URL_PREFIX + appId + "/" + name;
}

/** `glTF` as a little-endian uint32 — the first 4 bytes of every GLB. */
export const GLB_MAGIC = 0x46546c67;

/**
 * Validate a GLB header. Returns an error message, or null when the file looks complete.
 *
 * WHY THE SERVER CHECKS AT ALL (the client already re-reads its own output): the upload is a raw body
 * from a browser that may be on a phone with a flaky connection, and the failure that matters is a
 * TRUNCATED file — a game that loads a half-written 30 MB model fails much later and much more
 * confusingly. The declared total length in the header makes that checkable in 12 bytes, and the
 * magic catches the second realistic mistake: publishing a `.gltf` (JSON) or an HTML error page.
 */
export function checkGlbHeader(head: Buffer, totalBytes: number): string | null {
  if (head.length < 12) return "文件太短（" + totalBytes + " 字节），不是 GLB";
  if (head.readUInt32LE(0) !== GLB_MAGIC) {
    return "不是 GLB（缺少 glTF 头）。若导出格式选的是 glTF(JSON)，请改成 GLB —— 发布的资产必须是单文件二进制";
  }
  const version = head.readUInt32LE(4);
  if (version !== 2) return "GLB 版本 " + version + "，只支持 glTF 2.0";
  const declared = head.readUInt32LE(8);
  if (declared !== totalBytes) {
    return "文件不完整：GLB 头声明 " + declared + " 字节，实际收到 " + totalBytes + " 字节（上传中断？）";
  }
  return null;
}

/** Read the first 12 bytes of a file and run checkGlbHeader against its real size. */
export async function verifyGlbFile(filePath: string, totalBytes: number): Promise<string | null> {
  let head = Buffer.alloc(0);
  try {
    const fh = await fs.open(filePath, "r");
    try {
      const buf = Buffer.alloc(12);
      const { bytesRead } = await fh.read(buf, 0, 12, 0);
      head = buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  } catch (err) {
    return "读取临时文件失败：" + (err instanceof Error ? err.message : String(err));
  }
  return checkGlbHeader(head, totalBytes);
}

/** Every stored asset of one app, sorted by name. A missing directory is an empty list, not an error. */
export async function listAssets(appId: string): Promise<AssetFile[]> {
  if (!ASSET_APP_RE.test(appId)) return [];
  let entries;
  try {
    entries = await fs.readdir(assetDir(appId), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: AssetFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !isValidAssetName(entry.name)) continue; // hides `.<name>.<rand>.part`
    const full = assetPath(appId, entry.name);
    if (!full) continue;
    try {
      const st = await fs.stat(full);
      out.push({ name: entry.name, bytes: st.size, mtime: Math.round(st.mtimeMs) });
    } catch {
      // vanished between readdir and stat — the next list call simply will not see it
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** One stored asset, or null when it does not exist (or the inputs are unsafe). */
export async function findAsset(appId: string, name: string): Promise<{ path: string; bytes: number; mtime: number } | null> {
  const full = assetPath(appId, name);
  if (!full) return null;
  try {
    const st = await fs.stat(full);
    if (!st.isFile()) return null;
    return { path: full, bytes: st.size, mtime: Math.round(st.mtimeMs) };
  } catch {
    return null;
  }
}

export type ReceiveResult = { ok: true; bytes: number } | { ok: false; code: number; error: string };

/**
 * Stream one upload into `tmpPath` with a hard byte cap.
 *
 * STREAMING, NOT `readFile`-style buffering: the cap is 256 MB by default and this runs on a phone —
 * buffering the whole body would need that much RSS per concurrent upload. When the cap is exceeded we
 * stop writing (and unlink) but keep DRAINING the request: destroying the socket would kill the
 * response too, so the client would see a network error instead of the 413 that explains itself.
 */
export function receiveAsset(req: IncomingMessage, tmpPath: string, maxBytes: number): Promise<ReceiveResult> {
  return new Promise((resolve) => {
    const out = createWriteStream(tmpPath);
    let size = 0;
    let over = false;
    let done = false;
    const finish = (r: ReceiveResult): void => {
      if (done) return;
      done = true;
      resolve(r);
    };
    const fail = (r: ReceiveResult): void => {
      try { out.destroy(); } catch { /* already gone */ }
      void fs.unlink(tmpPath).catch(() => {});
      finish(r);
    };
    out.on("error", (err) => {
      fail({ ok: false, code: 500, error: "写入失败：" + (err instanceof Error ? err.message : String(err)) });
    });
    req.on("data", (chunk: Buffer) => {
      if (over) return;
      size += chunk.length;
      if (size > maxBytes) {
        over = true; // keep draining, stop buffering — see the note above
        return;
      }
      if (!out.write(chunk)) {
        req.pause();
        out.once("drain", () => req.resume());
      }
    });
    req.on("end", () => {
      if (over) {
        return fail({
          ok: false, code: 413,
          error: "文件太大（上限 " + Math.floor(maxBytes / (1024 * 1024)) + " MB）。先在转换器里压缩贴图与减面再发布",
        });
      }
      if (size === 0) return fail({ ok: false, code: 400, error: "空请求体（没有收到任何字节）" });
      out.end(() => finish({ ok: true, bytes: size }));
    });
    req.on("error", () => fail({ ok: false, code: 400, error: "请求中断" }));
    req.on("aborted", () => fail({ ok: false, code: 400, error: "请求中断" }));
  });
}

export type StoreResult =
  | { ok: true; bytes: number; replaced: boolean; url: string }
  | { ok: false; code: number; error: string };

/**
 * Receive, validate and atomically publish one asset.
 *
 * The order matters and is the whole safety story: stream to a hidden temp file → verify → `rename`
 * (atomic on the same filesystem). A rejected upload leaves the previously published file EXACTLY as
 * it was, which is what lets the converter's 「发布」 button be a plain overwrite instead of a
 * read-modify-write dance.
 */
export async function storeAsset(req: IncomingMessage, appId: string, name: string): Promise<StoreResult> {
  const full = assetPath(appId, name);
  if (!full) return { ok: false, code: 400, error: "非法的资产名（只允许字母/数字/._-，且不以 . 开头）" };
  const dir = assetDir(appId);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err) {
    return { ok: false, code: 500, error: "无法创建目录：" + (err instanceof Error ? err.message : String(err)) };
  }
  const replaced = await findAsset(appId, name) !== null;
  const tmp = path.join(dir, "." + name + "." + process.pid.toString(36) + Math.random().toString(36).slice(2, 8) + ".part");
  const received = await receiveAsset(req, tmp, MAX_ASSET_BYTES);
  if (!received.ok) return received;
  // Only .glb gets a header check today. A future intake (say png) must bring its own verifier rather
  // than silently trusting the bytes — see the module header.
  if (assetExtension(name) === "glb") {
    const bad = await verifyGlbFile(tmp, received.bytes);
    if (bad) {
      await fs.unlink(tmp).catch(() => {});
      return { ok: false, code: 400, error: bad };
    }
  }
  try {
    await fs.rename(tmp, full);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    return { ok: false, code: 500, error: "落盘失败：" + (err instanceof Error ? err.message : String(err)) };
  }
  return { ok: true, bytes: received.bytes, replaced, url: assetUrl(appId, name) };
}

/** Delete one asset. Returns false when it was not there (the route turns that into a 404). */
export async function removeAsset(appId: string, name: string): Promise<boolean> {
  const full = assetPath(appId, name);
  if (!full) return false;
  try {
    await fs.unlink(full);
  } catch {
    return false;
  }
  // Best effort: leave no empty per-app folder behind. Ignored on purpose — a concurrent publish must
  // not turn this into an error (ENOTEMPTY) and the reader already treats a missing dir as empty.
  await fs.rmdir(assetDir(appId)).catch(() => {});
  return true;
}

/**
 * Serve one asset by streaming it.
 *
 * NOT `fs.readFile`: the cap allows 256 MB assets and this is a phone — a stream keeps one copy of the
 * bytes in flight instead of one per request. No `Range` support on purpose (glTF loaders fetch whole
 * files; a partial-file protocol would be dead weight here).
 */
export function streamAsset(res: ServerResponse, filePath: string, size: number, type: string): void {
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": size,
    "Cache-Control": "no-cache",
  });
  const stream = createReadStream(filePath);
  stream.on("error", () => {
    // Headers are already out; the only honest thing left is to cut the response (the client sees a
    // truncated body, which the GLB length check above is designed to catch on the way back in).
    try { res.destroy(); } catch { /* already gone */ }
  });
  stream.pipe(res);
}
