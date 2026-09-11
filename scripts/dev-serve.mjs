/**
 * Dev supervisor — this is `npm run dev`.
 *
 *   node scripts/dev-serve.mjs        # build once, start the server, poll source, repeat
 *
 * On any change under server/ apps/ shell/ shared/ scripts/ (debounced) it rebuilds and restarts
 * the server child process. Ctrl-C / SIGTERM stops the child and exits.
 *
 * WHY POLLING (mtime scan) INSTEAD OF fs.watch:
 *   - `fs.watch({recursive:true})` on this Termux/Android build stops delivering events *silently*
 *     after a while: the supervisor stays alive, the inotify watches are still registered
 *     (/proc/<pid>/fdinfo showed 70 active watches) and the process sits in do_epoll_wait, but
 *     `touch`-ing any source file no longer triggers anything. Observed twice (once with the
 *     FSWatcher kept in a module-level array, so it is not a GC problem): edits simply stop being
 *     seen, which looks exactly like "my change did not take effect".
 *   - A standalone recursive watcher survived an 80 s stress probe, so this is a platform/Node
 *     interaction that is hard to pin down — not something worth depending on.
 *   - The source tree is tiny (~60 files), so a full stat scan every DEV_POLL_MS (default 800 ms)
 *     costs a few dozen stat calls per second and is completely deterministic: our own code
 *     decides when a change happened, nothing is left to kernel/Node event delivery.
 *   - Polling also catches deletions and renames, which the recursive watcher reports poorly.
 *   - `node --watch --watch-path=...` is documented as macOS/Windows only, and `node --watch`
 *     would restart this supervisor on every save (build + spawn order would be out of our hands).
 *   - Never watch dist/: the build replaces it, so watching it would see files vanish mid-build.
 *
 * Failure behaviour: build.mjs is atomic (dist.next/ -> dist/), so a broken build leaves the
 * previous dist/ and the running server untouched — a typo never takes the site down. Fix the
 * error and save any file to retry.
 */
import { execFileSync, spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const BUILD = path.join(ROOT, "scripts", "build.mjs");
const SERVER = path.join(ROOT, "dist", "server", "src", "index.js");
const SOURCE_DIRS = ["server", "apps", "shell", "shared", "scripts"].map((d) => path.join(ROOT, d));
const DEBOUNCE_MS = 200;
/** How often the source tree is scanned. 800 ms keeps edit→rebuild latency imperceptible. */
const POLL_MS = Number(process.env.DEV_POLL_MS ?? 800);

/**
 * Should this path be ignored? Editors write temp/swap files next to the real file (the DSH
 * edit tool writes `.<name>.<pid>.<uuid>.tmpdir`), and every one of those would otherwise
 * trigger a full rebuild + server restart. Ignore anything hidden, plus backup/swap/temp
 * suffixes, plus build output.
 */
function ignored(rel) {
  if (!rel) return false;
  const parts = rel.split(/[/\\]/);
  if (parts.some((p) => p.startsWith("."))) return true;          // hidden files/dirs
  if (parts.some((p) => p === "node_modules" || p === "dist" || p === "dist.next")) return true;
  const base = parts[parts.length - 1];
  return base.endsWith("~") || /\.(swp|swx|tmp|tmpdir)$/i.test(base);
}

/** Recursively record `<relative path> -> mtimeMs:size` for every non-ignored file. */
function scan(sig, dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;                                    // directory vanished mid-scan
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(ROOT, abs);
    if (ignored(rel)) continue;
    if (entry.isDirectory()) {
      scan(sig, abs);
      continue;
    }
    try {
      const st = statSync(abs);
      sig.set(rel, st.mtimeMs + ":" + st.size);
    } catch {
      // file disappeared between readdir and stat — the next poll sees it as removed
    }
  }
}

function snapshot() {
  const sig = new Map();
  for (const dir of SOURCE_DIRS) scan(sig, dir);
  return sig;
}

/** First path that differs between two signatures (changed, added or removed), else null. */
function firstDifference(prev, next) {
  for (const [rel, stamp] of next) {
    if (prev.get(rel) !== stamp) return rel;
  }
  for (const rel of prev.keys()) {
    if (!next.has(rel)) return rel;
  }
  return null;
}

let child = null;
let shuttingDown = false;
let debounce = null;

const log = (msg) => console.log("[dev] " + msg);

/** Run the build. Returns false when tsc failed (dist/ and the running server are untouched). */
function build() {
  try {
    execFileSync(process.execPath, [BUILD], { stdio: "inherit", cwd: ROOT });
    return true;
  } catch {
    log("build FAILED — keeping the previous dist/ and the running server; fix and save again");
    return false;
  }
}

function start() {
  const port = process.env.PORT ?? "3000";
  log("starting server (PORT=" + port + ")");
  const c = spawn(process.execPath, [SERVER], { stdio: "inherit", cwd: ROOT, env: process.env });
  child = c;
  c.on("exit", (code, signal) => {
    if (shuttingDown || child !== c) return;   // expected stop / already superseded
    child = null;
    log("server exited (code=" + code + " signal=" + signal + ") — waiting for changes");
  });
}

/** SIGTERM the child, escalate to SIGKILL if it lingers, then call `done`. */
function stopChild(done) {
  const c = child;
  child = null;
  if (!c) { done(); return; }
  c.once("exit", done);
  c.kill("SIGTERM");
  const t = setTimeout(() => { try { c.kill("SIGKILL"); } catch { /* already gone */ } }, 1500);
  t.unref?.();
}

/** Rebuild, then restart — in that order, so the site is never down because of a bad build. */
function cycle(reason) {
  if (shuttingDown) return;
  log("change detected (" + reason + ") — rebuilding");
  if (reason.startsWith("scripts/")) {
    // build.mjs is re-spawned per build, so its changes take effect at once; this supervisor's
    // own code is already loaded, so it keeps the old logic until the next manual restart.
    log("note: scripts/ changed — restart `npm run dev` to reload the supervisor itself");
  }
  if (!build()) return;
  stopChild(() => { if (!shuttingDown) start(); });
}

function schedule(file) {
  const rel = file ? path.relative(ROOT, file) : "";
  if (process.env.DEV_DEBUG) log("change " + JSON.stringify(rel));
  if (ignored(rel)) return;
  clearTimeout(debounce);
  debounce = setTimeout(() => cycle(rel || "source"), DEBOUNCE_MS);
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("received " + signal + " — stopping");
  clearTimeout(debounce);
  stopChild(() => process.exit(0));
  const t = setTimeout(() => process.exit(0), 2000);   // safety net
  t.unref?.();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// --- the poll loop (see the file header for why this is not fs.watch) ---
let signature = snapshot();
log("polling " + SOURCE_DIRS.length + " source dirs every " + POLL_MS + "ms (" + signature.size +
  " files): " + SOURCE_DIRS.map((d) => path.relative(ROOT, d)).join(", "));

setInterval(() => {
  if (shuttingDown) return;
  const next = snapshot();
  const changed = firstDifference(signature, next);
  // Take the new signature even when nothing is ignored-filtered away, so a change is reported
  // exactly once. A file that changes again during the rebuild is caught by the next poll.
  signature = next;
  if (changed) schedule(changed);
}, POLL_MS);

if (build()) start();
