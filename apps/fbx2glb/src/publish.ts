/**
 * Publishing a converted GLB into another sub-app's EXTERNAL ASSET directory.
 *
 * THE ONLY MODULE IN THIS APP THAT WRITES TO THE SERVER, and the reason the app's 「文件不会上传」 claim
 * needs one careful sentence instead of a blanket one: converting, decimating and packing are still
 * 100% local (zero requests — asserted in scripts/verify-fbx2glb.mjs §10/§11), while pressing
 * 「发布」 sends the finished Blob to the portal's own `/api/assets/<appId>/<name>` and nowhere else.
 * Every URL in here is RELATIVE and same-origin on purpose: there is no host, no port and no
 * absolute URL, so the file cannot leave this device by accident (asserted at the source level).
 *
 * WHAT THE SERVER DOES WITH IT (server/src/assets.ts): validates the target app's declared intake,
 * streams the body to `data/assets/<appId>/` with a size cap, checks the GLB header, and only then
 * renames it into place. The browser therefore treats a publish as one request whose failure modes
 * (413 too big, 415 wrong type, 400 not a GLB / truncated) all come back as readable text.
 *
 * The module is DOM-free and side-effect-free so the rules below (name sanitising, target resolution,
 * summary text) are assertable in Node, like every other `src/*.ts` in this app.
 */
import { baseNameOf, formatBytes } from './names.js';

export interface PublishTarget {
  id: string;
  name: string;
  /** Extensions the app declared in its manifest (`assets.accepts`), lowercase without the dot. */
  accepts: string[];
}

export interface PublishFile {
  name: string;
  bytes: number;
  /** ms since epoch (server mtime). */
  mtime: number;
}

export type PublishResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Lowercase extension of a file name without the dot, or "" when there is none. */
export function extensionOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return m ? m[1]!.toLowerCase() : '';
}

/**
 * Turn any user-supplied name into a name the asset store accepts
 * (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, no "..", extension = the export format).
 *
 * WHY ASCII: the name ends up in a URL (`/assets/shooter/<name>.glb`) and in the game's code, so a
 * model called 「我的角色(最终版).fbx」 has to become something boring. Runs of illegal characters
 * collapse to a single `-`, and a name that would start with one (`-`/`.`/`_`) is trimmed, because the
 * store requires an alphanumeric first character. Empty results fall back to `model` — a silent
 * failure to publish would be worse than an ugly name, and the log always prints the real name used.
 */
export function sanitizeAssetName(source: string, ext: string): string {
  const e = ext.toLowerCase().replace(/[^a-z0-9]/g, '') || 'glb';
  const bare = baseNameOf(source);
  let out = bare
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/[^A-Za-z0-9]+$/, '');
  const maxBase = 64 - e.length - 1; // the store's limit counts the whole name including ".glb"
  if (out.length > maxBase) out = out.slice(0, maxBase).replace(/[^A-Za-z0-9]+$/, '');
  if (out === '') out = 'model';
  return out + '.' + e;
}

/**
 * The name a publish will use: the override field when the user typed one, otherwise the product's own
 * name. Both go through the same sanitiser, so the result is ALWAYS publishable — the UI shows what it
 * will be by writing the sanitised result back next to the button (see main.ts).
 */
export function publishNameFor(outputName: string, override: string, ext: string): string {
  const typed = override.trim();
  return sanitizeAssetName(typed === '' ? outputName : typed, ext);
}

/**
 * Which target a publish goes to: the stored setting when it still exists in the discovered list,
 * otherwise the first candidate, otherwise none. Pure, so the "an app was removed / renamed" case is
 * assertable without a server (see the settings.ts note on stale ids).
 */
export function resolveTarget(stored: string, targets: readonly PublishTarget[]): PublishTarget | null {
  if (targets.length === 0) return null;
  return targets.find((t) => t.id === stored) ?? targets[0]!;
}

/** Can this target hold a product with this extension? Drives the buttons' disabled state. */
export function targetAccepts(target: PublishTarget | null, ext: string): boolean {
  return target !== null && target.accepts.includes(ext.toLowerCase());
}

/** `08-14 09:31` — short enough for a phone-width row; no locale/ICU dependency (some builds lack it). */
export function formatAssetTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function publishResultText(name: string, bytes: number, target: PublishTarget, replaced: boolean, url: string): string {
  return `已发布 ${name}（${formatBytes(bytes)}）到「${target.name}」` +
    `${replaced ? '，覆盖了同名资产' : ''} · ${url}`;
}

/** One line for the 「已发布」 list header. */
export function publishedSummary(target: PublishTarget | null, files: readonly PublishFile[]): string {
  if (!target) return '没有接收发布资产的子应用';
  if (files.length === 0) return `「${target.name}」还没有发布过资产`;
  const bytes = files.reduce((n, f) => n + f.bytes, 0);
  return `「${target.name}」已有 ${files.length} 个资产 · 共 ${formatBytes(bytes)}`;
}

/**
 * Human-readable reason a product cannot be published to this target (or null when it can).
 * The suggestion is only offered when it is ACTIONABLE: the converter exports glb/gltf, so pointing a
 * user at 「转换选项」 makes sense for those two and would be a lie for anything else (a target that
 * only takes .png cannot be satisfied by this app at all).
 */
export function blockedReason(target: PublishTarget | null, ext: string): string | null {
  if (!target) return '没有子应用在 manifest 里声明接收发布资产（assets.accepts）';
  if (targetAccepts(target, ext)) return null;
  const list = target.accepts.map((e) => '.' + e).join(' / ');
  const fix = target.accepts.find((e) => e === 'glb' || e === 'gltf');
  return `「${target.name}」只接收 ${list}，当前产物是 .${ext}` +
    (fix ? ` —— 在「转换选项」里把导出格式改成 ${fix.toUpperCase()} 再发布` : ' —— 这个目标收不了转换器的任何产物格式');
}

// ---------------------------------------------------------------------------
// server calls — every URL is relative (same origin), never absolute
// ---------------------------------------------------------------------------

async function readError(res: { status: number; json?: () => Promise<unknown> }): Promise<string> {
  let detail = 'HTTP ' + res.status;
  try {
    const body = (await res.json?.()) as { error?: string } | undefined;
    if (body && typeof body.error === 'string') detail += ' — ' + body.error;
  } catch {
    // non-JSON error body; the status alone is enough
  }
  return detail;
}

interface ManifestApp { id?: unknown; name?: unknown; assets?: { accepts?: unknown } | null }

/**
 * Discover the apps that accept published assets. `/api/manifest` is the portal's own discovery API,
 * so the converter never names a game: adding `"assets": { "accepts": ["glb"] }` to a new app's
 * manifest is the entire integration.
 */
export async function loadPublishTargets(): Promise<PublishResult<PublishTarget[]>> {
  try {
    const res = await fetch('/api/manifest', { cache: 'no-store' });
    if (!res.ok) return { ok: false, error: await readError(res) };
    const data = (await res.json()) as { apps?: ManifestApp[] };
    const targets: PublishTarget[] = [];
    for (const app of data.apps ?? []) {
      const accepts = Array.isArray(app.assets?.accepts)
        ? app.assets!.accepts!.filter((e): e is string => typeof e === 'string')
        : [];
      if (accepts.length === 0) continue;
      if (typeof app.id !== 'string') continue;
      // The server normalises the manifest before serving it, so `accepts` is already clean; the
      // filters above only exist so a hand-rolled response cannot crash the page.
      targets.push({ id: app.id, name: typeof app.name === 'string' ? app.name : app.id, accepts });
    }
    return { ok: true, value: targets };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** What is already published for one app (the game can call the same endpoint to discover assets). */
export async function listPublished(appId: string): Promise<PublishResult<PublishFile[]>> {
  try {
    const res = await fetch('/api/assets/' + encodeURIComponent(appId), { cache: 'no-store' });
    if (!res.ok) return { ok: false, error: await readError(res) };
    const data = (await res.json()) as { files?: PublishFile[] };
    const files = Array.isArray(data.files) ? data.files : [];
    return { ok: true, value: files.filter((f) => typeof f?.name === 'string') };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Send one product. The body is the finished Blob — no re-encoding, no base64 (a 30 MB GLB would grow
 * by a third), which is also why the server reads the body as a stream rather than JSON.
 */
export async function publishAsset(
  appId: string, name: string, blob: Blob,
): Promise<PublishResult<{ name: string; bytes: number; replaced: boolean; url: string }>> {
  try {
    const res = await fetch('/api/assets/' + encodeURIComponent(appId) + '/' + encodeURIComponent(name), {
      method: 'PUT',
      headers: { 'Content-Type': 'model/gltf-binary' },
      body: blob,
    });
    if (!res.ok) return { ok: false, error: await readError(res) };
    const data = (await res.json()) as { name?: string; bytes?: number; replaced?: boolean; url?: string };
    return {
      ok: true,
      value: {
        name: typeof data.name === 'string' ? data.name : name,
        bytes: typeof data.bytes === 'number' ? data.bytes : blob.size,
        replaced: data.replaced === true,
        url: typeof data.url === 'string' ? data.url : assetUrl(appId, name),
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function removePublished(appId: string, name: string): Promise<PublishResult<true>> {
  try {
    const res = await fetch('/api/assets/' + encodeURIComponent(appId) + '/' + encodeURIComponent(name), {
      method: 'DELETE',
    });
    if (!res.ok) return { ok: false, error: await readError(res) };
    return { ok: true, value: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The URL a game loads the asset from. Shown in the UI/log so it can be pasted into game code. */
export function assetUrl(appId: string, name: string): string {
  return '/assets/' + appId + '/' + name;
}
