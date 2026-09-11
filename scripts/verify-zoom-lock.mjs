/**
 * CPU-side verification for the PAGE ZOOM LOCK (双击放大 / 双指缩放).
 *
 * Why this script exists: page zoom scales the TOP-LEVEL document's visual viewport, so it can only
 * be stopped by the shell — a sub-app's own `<meta viewport>` / `touch-action` is powerless inside
 * the portal's iframe. That is a subtle rule (the shooter's `*{touch-action:none}` looks like it
 * should be enough, and it is not), so a future edit could "clean up" the shell rules and silently
 * bring back double-tap zoom. These assertions pin the three layers down.
 *
 * Rules under test:
 *   1. shell/index.html pins maximum-scale=1 + user-scalable=no (no runtime JS needed; the hardest
 *      guarantee, and the only one Chrome Android cannot ignore except via force-enable-zoom);
 *   2. shell/styles.css sets `touch-action: manipulation` on <html> (kills double-tap zoom for the
 *      whole top-level document: touch-action is intersected with ancestors) and `touch-action:none`
 *      on `.appframe` (the frame-owner element offers no gesture either way);
 *   3. shell/main.ts cancels Safari's proprietary `gesturestart` (iOS ignores user-scalable=no);
 *   4. the built dist/ copies carry all of the above (the shell is served from dist/, and the dev
 *      watcher rebuilds on save — this catches "edited source but dist is stale");
 *   5. the shooter keeps its OWN two layers, because when it is opened standalone
 *      (/apps/shooter/) IT is the top-level document and the shell is not in the picture.
 *
 * Run:  npm run build && node scripts/verify-zoom-lock.mjs
 * Exit code is non-zero when any assertion fails.
 */
import { readFileSync } from "node:fs";

const src = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? " — " + detail : ""));
}

// ------------------------------------------------------------------ 1. shell viewport meta
const shellHtml = src("shell/index.html");
const shellMeta = /<meta\s+name="viewport"\s+content="([^"]*)"/i.exec(shellHtml)?.[1] ?? "";
check("shell/index.html 有 viewport meta", shellMeta !== "", shellMeta);
for (const token of ["width=device-width", "initial-scale=1", "maximum-scale=1", "user-scalable=no", "viewport-fit=cover"]) {
  check(`shell viewport 含 ${token}`, shellMeta.includes(token), shellMeta);
}
check("shell viewport 没有 user-scalable=yes", !/user-scalable\s*=\s*yes/i.test(shellMeta), shellMeta);

// ------------------------------------------------------------------ 2. shell CSS layers
const shellCss = src("shell/styles.css");
// `html { ... touch-action: manipulation }` — match the rule, not a comment mentioning it.
check("shell CSS: html 上是 touch-action: manipulation", /(^|[\s,;{}])html\s*\{[^}]*touch-action:\s*manipulation[^}]*\}/.test(shellCss));
const appframeBlock = /\.appframe\s*\{([^}]*)\}/.exec(shellCss)?.[1] ?? "";
check("shell CSS: .appframe 上是 touch-action: none", /touch-action:\s*none/.test(appframeBlock), appframeBlock.trim().slice(0, 80));
// The lock must not be scoped to a class / state: it is the document-wide default.
check("shell CSS: html 规则不是条件性的（没有 .zoom-lock 前缀）", !/html[^{}]*\.zoom-lock\s*\{/.test(shellCss));

// ------------------------------------------------------------------ 3. iOS gesture guard
const shellMain = src("shell/main.ts");
check("shell/main.ts 注册了 gesturestart", /addEventListener\(\s*["']gesturestart["']/.test(shellMain));
check("shell/main.ts 在 gesturestart 里 preventDefault", /gesturestart["'][\s\S]{0,120}?preventDefault\(\)/.test(shellMain));

// ------------------------------------------------------------------ 4. built artefacts
const distHtml = src("dist/shell/index.html");
check("dist/shell/index.html 与源码同样锁定缩放", /maximum-scale=1/.test(distHtml) && /user-scalable=no/.test(distHtml));
const distCss = src("dist/shell/styles.css");
check("dist/shell/styles.css 带两层 touch-action", /touch-action:\s*manipulation/.test(distCss) && /touch-action:\s*none/.test(distCss));
check("dist/shell/main.js 带 gesturestart", /gesturestart/.test(src("dist/shell/main.js")));

// ------------------------------------------------------------------ 5. standalone app layers
const shooterHtml = src("apps/shooter/index.html");
check("shooter 单开时自己的 viewport 也锁（user-scalable=no）", /user-scalable=no/.test(shooterHtml));
check("shooter 单开时自己也有 touch-action:none", /touch-action:none/.test(src("apps/shooter/styles.css")));

// ------------------------------------------------------------------ summary
console.log(`\nverify-zoom-lock: ${passed} 项通过, ${failures.length} 项失败`);
if (failures.length > 0) {
  console.log("\n失败项:");
  for (const f of failures) console.log("  ✗ " + f);
  process.exit(1);
}
console.log("全部通过 ✓（真机仍需确认：双击不再放大、摇杆两指不触发缩放）");
