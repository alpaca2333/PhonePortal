/**
 * Portal HTTP server — zero runtime dependencies.
 * Serves the built web root (dist/) plus the discovery API.
 */
import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DIST_ROOT, PORTAL, loadRegistry, getApp } from "./registry.js";
import { MAX_BODY, isValidScope, readAll, readScope, validateValue, writeScope } from "./settings.js";
import {
  ASSET_URL_PREFIX, assetExtension, findAsset, listAssets, removeAsset, storeAsset, streamAsset,
} from "./assets.js";
import { apiDescription, handleConvert } from "./fbx2glb.js";
import type { PortalManifest } from "../../shared/src/types.js";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const SHELL_INDEX = path.join(DIST_ROOT, "shell", "index.html");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  // Published external assets (data/assets/<appId>/, see server/src/assets.ts).
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
};

function send(res: http.ServerResponse, code: number, body: string | Buffer, type = "text/plain; charset=utf-8") {
  res.writeHead(code, {
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-cache",
  });
  res.end(body);
}

function sendJson(res: http.ServerResponse, code: number, value: unknown) {
  send(res, code, JSON.stringify(value), "application/json; charset=utf-8");
}

/** Serve a file from within a root, blocking path traversal. Returns true if handled. */
async function serveFile(res: http.ServerResponse, root: string, urlPath: string): Promise<boolean> {
  let rel: string;
  try {
    rel = decodeURIComponent(urlPath).replace(/^\/+/, "");
  } catch {
    return false;
  }
  let filePath = path.resolve(root, rel);
  if (filePath !== root && !filePath.startsWith(root + path.sep)) return false;
  try {
    const st = await fs.stat(filePath);
    if (st.isDirectory()) filePath = path.join(filePath, "index.html");
  } catch {
    return false;
  }
  try {
    const data = await fs.readFile(filePath);
    const type = MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
    send(res, 200, data, type);
    return true;
  } catch {
    return false;
  }
}

/** Read a request body with a hard size cap. Never throws; reports 413 / 400 style failures. */
type BodyResult = { ok: true; body: string } | { ok: false; code: number; error: string };
function readBody(req: http.IncomingMessage, max: number): Promise<BodyResult> {
  return new Promise((resolve) => {
    let size = 0;
    let tooLarge = false;
    const chunks: Buffer[] = [];
    let done = false;
    const finish = (r: BodyResult): void => {
      if (done) return;
      done = true;
      resolve(r);
    };
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        // Keep draining (destroying the socket would kill the response too) but stop buffering.
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) finish({ ok: false, code: 413, error: "body too large (max " + max + " bytes)" });
      else finish({ ok: true, body: Buffer.concat(chunks).toString("utf8") });
    });
    req.on("error", () => finish({ ok: false, code: 400, error: "request aborted" }));
    req.on("aborted", () => finish({ ok: false, code: 400, error: "request aborted" }));
  });
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function colorHex(c?: string): string {
  if (c && /^#?[0-9a-f]{6}$/i.test(c)) return c.startsWith("#") ? c : "#" + c;
  return "#4f6ff7";
}
function renderShellHome(registry: PortalManifest): string {
  const apps = registry.apps;
  const hero = `<header class="hero"><div class="hero-icon">🧭</div><div class="hero-text"><h1>${escHtml(registry.portal.name)}</h1><p>${escHtml(registry.portal.description ?? "")}</p></div><div class="hero-meta">v${escHtml(registry.portal.version ?? "0.0.0")}</div></header>`;
  if (apps.length === 0) return hero + `<section class="empty"><p><b>还没有子应用</b></p><p>在 apps/ 下创建目录并添加 manifest.json，即可自动出现在这里。</p></section>`;
  const cards = apps.map((a) => `<article class="card" style="--card-accent:${colorHex(a.color)}"><div class="card-icon">${escHtml(a.icon ?? "📦")}</div><h2>${escHtml(a.name)}</h2><p>${escHtml(a.description ?? "")}</p><a class="card-open" href="${escHtml(a.entry ?? "/apps/" + a.id + "/")}">打开 →</a></article>`).join("");
  return hero + `<div class="section-title">我的应用</div><main class="grid">${cards}</main><div class="footer">手机门户 v${escHtml(registry.portal.version ?? "0.0.0")} · 运行在本地设备</div>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    // --- API: full manifest ---
    if (pathname === "/api/manifest") {
      const registry = await loadRegistry();
      return sendJson(res, 200, registry);
    }

    // --- API: single app ---
    const appMatch = pathname.match(/^\/api\/apps\/([^/]+)\/?$/);
    if (appMatch) {
      const app = await getApp(decodeURIComponent(appMatch[1]!));
      if (!app) return sendJson(res, 404, { error: "not found" });
      return sendJson(res, 200, app);
    }

    // --- API: portal meta ---
    if (pathname === "/api/portal") {
      return sendJson(res, 200, { portal: PORTAL, registered: await loadRegistry().then((r) => r.apps.length) });
    }

    // --- API: persisted user settings (data/settings.json; see server/src/settings.ts) ---
    // Deliberately outside dist/: the build swaps dist/ wholesale, so user data must not live there.
    if (pathname === "/api/settings") {
      if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      return sendJson(res, 200, await readAll());
    }
    const settingsMatch = pathname.match(/^\/api\/settings\/([^/]+)\/?$/);
    if (settingsMatch) {
      let scope: string;
      try {
        scope = decodeURIComponent(settingsMatch[1]!);
      } catch {
        return sendJson(res, 400, { error: "invalid scope encoding" });
      }
      if (!isValidScope(scope)) return sendJson(res, 400, { error: "invalid scope (want /^[a-z0-9][a-z0-9._-]{0,31}$/i)" });
      if (req.method === "GET") {
        return sendJson(res, 200, { scope, value: await readScope(scope) });
      }
      if (req.method === "PUT") {
        const body = await readBody(req, MAX_BODY);
        if (!body.ok) return sendJson(res, body.code, { error: body.error });
        let parsed: unknown;
        try {
          parsed = JSON.parse(body.body);
        } catch {
          return sendJson(res, 400, { error: "invalid JSON" });
        }
        const invalid = validateValue(parsed);
        if (invalid) return sendJson(res, 400, { error: invalid });
        await writeScope(scope, parsed);
        return sendJson(res, 200, { scope, value: parsed });
      }
      return sendJson(res, 405, { error: "method not allowed" });
    }

    // --- API: published external assets (data/assets/<appId>/; see server/src/assets.ts) -----------
    // A sub-app DECLARES its intake in its manifest (`"assets": { "accepts": ["glb"] }`), so writing
    // into an app that never asked for it is refused instead of silently filling a directory nobody
    // reads. Listing is public knowledge by design: the receiving game reads it to discover what it
    // can load, and the converter reads it to show what is already published.
    if (pathname === "/api/assets") {
      if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      const registry = await loadRegistry();
      const apps = [];
      for (const app of registry.apps) {
        const accepts = app.assets?.accepts ?? [];
        if (accepts.length === 0) continue; // only apps that accept published assets
        apps.push({ id: app.id, name: app.name, accepts, files: await listAssets(app.id) });
      }
      return sendJson(res, 200, { root: "data/assets", apps });
    }
    const assetListMatch = pathname.match(/^\/api\/assets\/([^/]+)\/?$/);
    if (assetListMatch) {
      let appId: string;
      try {
        appId = decodeURIComponent(assetListMatch[1]!);
      } catch {
        return sendJson(res, 400, { error: "invalid app id encoding" });
      }
      const app = await getApp(appId);
      if (!app) return sendJson(res, 404, { error: "unknown app: " + appId });
      if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      return sendJson(res, 200, {
        app: { id: app.id, name: app.name },
        accepts: app.assets?.accepts ?? [],
        files: await listAssets(appId),
      });
    }
    const assetItemMatch = pathname.match(/^\/api\/assets\/([^/]+)\/([^/]+)$/);
    if (assetItemMatch) {
      let appId: string;
      let name: string;
      try {
        appId = decodeURIComponent(assetItemMatch[1]!);
        name = decodeURIComponent(assetItemMatch[2]!);
      } catch {
        return sendJson(res, 400, { error: "invalid asset path encoding" });
      }
      if (req.method === "DELETE") {
        const removed = await removeAsset(appId, name);
        if (!removed) return sendJson(res, 404, { error: "no such asset: " + name });
        return sendJson(res, 200, { app: appId, name, deleted: true });
      }
      if (req.method !== "PUT") return sendJson(res, 405, { error: "method not allowed" });
      const app = await getApp(appId);
      if (!app) return sendJson(res, 404, { error: "unknown app: " + appId });
      const accepts = app.assets?.accepts ?? [];
      if (accepts.length === 0) {
        return sendJson(res, 415, { error: "子应用 " + appId + " 没有在 manifest 里声明 assets.accepts，不能接收发布资产" });
      }
      const ext = assetExtension(name);
      if (ext === "" || !accepts.includes(ext)) {
        return sendJson(res, 415, {
          error: "只接受 " + accepts.map((e) => "." + e).join(" / ") + "（收到 " + (ext === "" ? "没有扩展名" : "." + ext) + "）",
        });
      }
      const stored = await storeAsset(req, appId, name);
      if (!stored.ok) return sendJson(res, stored.code, { error: stored.error });
      // 201 = a new asset, 200 = an existing name replaced (the converter's 「发布」 button overwrites).
      return sendJson(res, stored.replaced ? 200 : 201, {
        app: appId, name, bytes: stored.bytes, replaced: stored.replaced, url: stored.url,
      });
    }

    // --- API: the FBX→GLB converter's own endpoint (see server/src/fbx2glb.ts) ---------------------
    // A sub-app may expose a server-side API for OTHER sub-apps to call — the only cross-app channel
    // that does not violate "sub-apps never import each other". The conversion runs the app's own
    // modules in a worker thread; the response is the finished GLB, streamed from data/tmp/.
    if (pathname === "/api/fbx2glb") {
      if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      return sendJson(res, 200, apiDescription());
    }
    if (pathname === "/api/fbx2glb/convert") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed (用 POST，body 就是 FBX 文件本身)" });
      return handleConvert(req, res);
    }

    // --- Serve published assets: /assets/<appId>/<name> -> data/assets/<appId>/<name> ---------------
    // Deliberately distinct from the per-app `apps/<id>/assets/` (which is vendored source, copied
    // into dist/ by the build): this route never touches dist/ and survives every rebuild.
    if (pathname.startsWith(ASSET_URL_PREFIX)) {
      if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      let appId = "";
      let name = "";
      try {
        const rest = pathname.slice(ASSET_URL_PREFIX.length);
        const cut = rest.indexOf("/");
        if (cut > 0) {
          appId = decodeURIComponent(rest.slice(0, cut));
          name = decodeURIComponent(rest.slice(cut + 1));
        }
      } catch {
        return send(res, 404, "Not found");
      }
      if (!name.includes("/")) {
        const file = await findAsset(appId, name);
        if (file) {
          streamAsset(res, file.path, file.bytes, MIME["." + assetExtension(name)] ?? "application/octet-stream");
          return;
        }
      }
      return send(res, 404, "Not found");
    }

    // --- Portal shell at root: server-rendered so it works even without JS ---
    if (pathname === "/" || pathname === "/index.html") {
      try {
        const html = await fs.readFile(SHELL_INDEX, "utf8");
        const registry = await loadRegistry();
        const body = renderShellHome(registry);
        const injected = html.replace('<div id="app"></div>', '<div id="app">' + body + '</div>');
        send(res, 200, injected, "text/html; charset=utf-8");
        return;
      } catch {
        const ok = await serveFile(res, DIST_ROOT, "/shell/index.html");
        if (ok) return;
        return send(res, 404, "Portal has not been built yet. Run 'npm run build' first.", "text/plain; charset=utf-8");
      }
    }

    // --- Static assets anywhere under dist (shell, apps, shared) ---
    const served = await serveFile(res, DIST_ROOT, pathname);
    if (served) return;

    return send(res, 404, "Not found", "text/plain; charset=utf-8");
  } catch (err) {
    console.error("[server] error:", err);
    try { send(res, 500, "Internal Server Error", "text/plain; charset=utf-8"); } catch {}
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  ${PORTAL.name}  v${PORTAL.version}`);
  console.log(`  ▶ Portal shell  : http://localhost:${PORT}`);
  console.log(`  ▶ Manifest API  : http://localhost:${PORT}/api/manifest`);
  console.log(`  ▶ Bound on      : ${HOST}:${PORT}\n`);
});
