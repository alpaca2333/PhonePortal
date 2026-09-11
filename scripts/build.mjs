/**
 * Build script (atomic).
 * 1. Compiles all TypeScript with tsc into dist.next/ (preserving the source tree)
 * 2. Copies static assets (html/css/json/etc.) from shell/, apps/, shared/ into dist.next/
 * 3. Swaps dist.next/ -> dist/ (rename on the same filesystem)
 *
 * Sub-apps are served from dist/apps/<id>/, the shell from dist/shell/.
 *
 * WHY atomic: a plain `rm dist && tsc` leaves the served directory wiped when tsc fails, so a
 * single typo takes the running site down (static files are read from disk per request). With
 * the swap, a failed build leaves the previous dist/ — and the running server — untouched, and
 * the dev watcher can keep serving while it reports the error.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, renameSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DIST = path.join(ROOT, "dist");
const NEXT = path.join(ROOT, "dist.next");   // sibling of dist/, never served
const TSC = path.join(ROOT, "node_modules", "typescript", "lib", "tsc.js");

rmSync(NEXT, { recursive: true, force: true });
mkdirSync(NEXT, { recursive: true });

console.log("[build] compiling TypeScript via tsc...");
// --outDir is passed as an absolute path so the script works from any cwd.
try {
  execFileSync(process.execPath, [TSC, "-p", path.join(ROOT, "tsconfig.json"), "--outDir", NEXT], { stdio: "inherit" });
} catch (err) {
  // Keep the output readable for the dev watcher (which calls this on every save): tsc has
  // already printed the diagnostics, so a one-line summary beats a raw stack trace.
  console.error("[build] tsc failed" + (err && err.status ? " (exit " + err.status + ")" : "") +
    " — dist/ left untouched, the previous build is still being served");
  process.exit(1);
}

const SKIP_EXT = new Set(["ts", "tsx"]);

function copyAssets(src, dst) {
  for (const name of readdirSync(src)) {
    if (name === "node_modules" || name === ".git" || name === ".DS_Store") continue;
    const s = path.join(src, name);
    const d = path.join(dst, name);
    const st = statSync(s);
    if (st.isDirectory()) {
      copyAssets(s, d);
      continue;
    }
    const ext = path.extname(name).slice(1).toLowerCase();
    if (SKIP_EXT.has(ext)) continue;
    mkdirSync(path.dirname(d), { recursive: true });
    cpSync(s, d);
  }
}

for (const dir of ["shell", "apps", "shared"]) {
  copyAssets(path.join(ROOT, dir), path.join(NEXT, dir));
}

// Swap the freshly built tree into place. Same filesystem -> atomic rename; the running server
// keeps serving requests throughout (it reads static files per request).
rmSync(DIST, { recursive: true, force: true });
renameSync(NEXT, DIST);

console.log("[build] done -> " + DIST);
