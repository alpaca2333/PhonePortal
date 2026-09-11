import type { PortalManifest, SubAppManifest } from "../shared/src/types.js";

const appRoot = document.getElementById("app")!;

let manifest: PortalManifest | null = null;

function esc(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}
function attrColor(a: SubAppManifest): string {
  return a.color?.match(/^#?[0-9a-f]{6}$/i) ? (a.color.startsWith("#") ? a.color : "#" + a.color) : "#4f6ff7";
}

async function loadManifest(): Promise<void> {
  try {
    const res = await fetch("/api/manifest");
    manifest = (await res.json()) as PortalManifest;
  } catch {
    manifest = null;
  }
}

// --- screen orientation (landscape) -------------------------------------------------
// `screen.orientation.lock()` only works from the TOP-LEVEL document (sub-apps live in an
// iframe) and only while that document is fullscreen; fullscreen in turn must be requested
// from a user gesture. That is why this is a button rather than something automatic.
// iOS Safari and Firefox do not implement lock() at all — the button is then disabled.
//
// TypeScript note: this project's lib.dom.d.ts declares `unlock()` but NOT `lock()`, so the
// one method we need is declared here instead of casting to `any` at every call site.
interface OrientationLockApi extends ScreenOrientation {
  lock(orientation: "landscape" | "portrait" | "any"): Promise<void>;
}

function orientationApi(): OrientationLockApi | null {
  if (typeof screen === "undefined" || !screen.orientation) return null;
  return screen.orientation as OrientationLockApi;
}

const orientationLockSupported = (): boolean => {
  const so = orientationApi();
  return !!so && typeof so.lock === "function";
};

let landscapeLocked = false;
let rotateBtn: HTMLButtonElement | null = null;

function syncLandscapeUi(): void {
  // While landscape is locked the appbar is hidden (CSS) so the app gets the whole viewport;
  // the small floating pill in the app view is then the only way back.
  document.body.classList.toggle("landscape-locked", landscapeLocked);
  if (rotateBtn) {
    rotateBtn.textContent = landscapeLocked ? "退出横屏" : "横屏";
    rotateBtn.classList.toggle("on", landscapeLocked);
  }
}

async function enterLandscape(): Promise<void> {
  const so = orientationApi();
  if (!so || typeof so.lock !== "function") return;
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
    await so.lock("landscape");
    landscapeLocked = true;
  } catch (err) {
    // Fullscreen can be refused (not a gesture / disallowed in this embedding) and the lock
    // throws NotSupportedError on iOS Safari and Firefox.
    console.warn("[shell] landscape lock failed:", err);
    landscapeLocked = false;
  }
  syncLandscapeUi();
}

async function exitLandscape(): Promise<void> {
  try { orientationApi()?.unlock(); } catch { /* never locked / unsupported */ }
  try { if (document.fullscreenElement) await document.exitFullscreen(); } catch { /* ignore */ }
  landscapeLocked = false;
  syncLandscapeUi();
}

function renderHome(): void {
  const portal = manifest?.portal ?? { name: "手机门户", version: "0.0.0", description: "" };
  const apps = manifest?.apps ?? [];

  let hero = `<header class="hero">
    <div class="hero-icon">🧭</div>
    <div class="hero-text">
      <h1>${esc(portal.name)}</h1>
      <p>${esc(portal.description ?? "本机运行的门户，聚合多个独立子应用")}</p>
    </div>
    <div class="hero-meta">v${esc(portal.version ?? "0.0.0")}</div>
  </header>`;

  if (apps.length === 0) {
    appRoot.innerHTML = hero + `
      <section class="empty">
        <p><b>还没有子应用</b></p>
        <p>在 apps/ 下创建目录并添加 manifest.json，即可自动出现在这里。</p>
      </section>`;
    return;
  }

  const cards = apps.map((a) => `
    <article class="card" data-id="${esc(a.id)}" style="--card-accent:${attrColor(a)}">
      <div class="card-icon">${esc(a.icon ?? "📦")}</div>
      <h2>${esc(a.name)}</h2>
      <p>${esc(a.description ?? "")}</p>
      <span class="card-open">打开 →</span>
    </article>`).join("");

  appRoot.innerHTML = hero + `
    <div class="section-title">我的应用</div>
    <main class="grid">${cards}</main>
    <div class="footer">手机门户 v${esc(portal.version ?? "0.0.0")} · 运行在本地设备</div>`;

  appRoot.querySelectorAll<HTMLElement>(".card").forEach((card) => {
    card.addEventListener("click", () => {
      const id = card.dataset.id;
      if (id) location.hash = "#/app/" + encodeURIComponent(id);
    });
  });
}

function renderApp(id: string): void {
  const app = manifest?.apps.find((a) => a.id === id);
  if (!app) {
    appRoot.innerHTML = `<section class="empty"><p>未找到子应用 ${esc(id)}</p><a href="#/" class="card-open">← 返回首页</a></section>`;
    return;
  }
  const entry = app.entry ?? `/apps/${encodeURIComponent(app.id)}/`;
  const wantsLandscape = app.orientation === "landscape";
  const lockOk = orientationLockSupported();
  const rotateHtml = wantsLandscape
    ? `<button class="rotate-btn" id="rotateBtn"${lockOk ? "" : ` disabled title="此浏览器不支持屏幕方向锁定（iOS Safari / Firefox）"`}>横屏</button>`
    : "";
  appRoot.innerHTML = `
    <div class="appview">
      <header class="appbar">
        <button class="goback" id="backBtn">← 返回</button>
        <div class="appbar-title">${esc(app.icon ?? "📦")} ${esc(app.name)}</div>
        ${rotateHtml}
        <a class="open-new" href="${esc(entry)}" target="_blank" rel="noopener">新标签 ↗</a>
      </header>
      <iframe class="appframe" title="${esc(app.name)}" src="${esc(entry)}" allow="geolocation; camera; microphone"></iframe>
      <button class="exit-landscape" id="exitLandscapeBtn" aria-label="退出横屏">退出横屏</button>
    </div>`;
  appRoot.querySelector<HTMLButtonElement>("#backBtn")?.addEventListener("click", () => {
    location.hash = "#/";
  });
  // Only visible while landscape is locked (CSS), i.e. exactly when the appbar is hidden.
  appRoot.querySelector<HTMLButtonElement>("#exitLandscapeBtn")?.addEventListener("click", () => {
    void exitLandscape();
  });
  rotateBtn = appRoot.querySelector<HTMLButtonElement>("#rotateBtn");
  if (rotateBtn && lockOk) {
    rotateBtn.addEventListener("click", () => {
      void (landscapeLocked ? exitLandscape() : enterLandscape());
    });
  }
  syncLandscapeUi();
}

function route(): void {
  const hash = location.hash || "#/";
  const m = hash.match(/^#\/app\/([^/?#]+)/);
  // Leaving an app drops fullscreen + the orientation lock, so the home grid is never
  // stuck sideways.
  if (!m && landscapeLocked) void exitLandscape();
  if (m) {
    renderApp(decodeURIComponent(m[1]!));
  } else {
    renderHome();
  }
  window.scrollTo(0, 0);
}

async function main(): Promise<void> {
  await loadManifest();
  window.addEventListener("hashchange", route);
  // Page-zoom lock, third layer (the other two are the viewport meta + `html{touch-action}` in
  // shell/index.html / styles.css). iOS Safari ignores `user-scalable=no` since iOS 10 and offers
  // no meta way to cancel pinch; `gesturestart` is Safari's proprietary pinch hook and the only
  // way to cancel it from script. Android/Firefox never fire this event, so this line is a no-op
  // there (they are covered by the meta + touch-action). Without it, a two-thumb grip on the
  // sticks can pinch-zoom the portal page mid-game on an iPhone/iPad.
  document.addEventListener("gesturestart", (e: Event) => e.preventDefault());
  // The user can leave fullscreen with the system gesture / ESC; keep the button in sync.
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement && landscapeLocked) {
      try { orientationApi()?.unlock(); } catch { /* ignore */ }
      landscapeLocked = false;
      syncLandscapeUi();
    }
  });
  route();
}

void main();
