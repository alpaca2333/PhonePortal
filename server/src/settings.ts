/**
 * Server-side settings store — the single place user settings are persisted.
 *
 * WHY A FILE OUTSIDE dist/: `npm run build` swaps dist/ atomically (rm dist + rename dist.next),
 * so anything stored under dist/ is destroyed on every save. `data/` is a sibling of dist/ and is
 * not watched by scripts/dev-serve.mjs, so writing settings never triggers a rebuild loop.
 *
 * Layout: one JSON object, scope -> value (a scope is usually a sub-app id):
 *   { "shooter": { "stick": { "landscape": { "sizePx": 96 } } } }
 * A PUT replaces the whole scope value; the client is expected to send the complete object it
 * owns. Values are deliberately schema-free on the server (apps own their own schemas) but are
 * strictly validated as JSON data so a hand-edited file can never inject code or blow up memory.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { ROOT } from "./registry.js";

export const DATA_DIR = path.join(ROOT, "data");
export const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

/** Scope names are app ids: URL-safe, no dots-only, bounded length. */
export const SCOPE_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/i;
/** A single scope's value may not exceed this many bytes when serialized. */
export const MAX_BODY = 8 * 1024;
/** Keys must stay simple so the file remains greppable and mergeable. */
const KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_DEPTH = 6;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function isValidScope(scope: string): boolean {
  return SCOPE_RE.test(scope);
}

/**
 * Validate a settings value. Returns an error message, or null when acceptable.
 * Rules: plain object at the root, JSON-safe leaves only, bounded depth/size, no proto keys.
 */
export function validateValue(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "value must be a JSON object";
  }
  const walk = (node: unknown, depth: number): string | null => {
    if (depth > MAX_DEPTH) return "value is nested too deeply (max " + MAX_DEPTH + ")";
    if (node === null || typeof node === "string" || typeof node === "boolean") return null;
    if (typeof node === "number") return Number.isFinite(node) ? null : "numbers must be finite";
    if (Array.isArray(node)) {
      for (const item of node) {
        const err = walk(item, depth + 1);
        if (err) return err;
      }
      return null;
    }
    if (typeof node !== "object") return "unsupported value type: " + typeof node;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (!KEY_RE.test(k)) return "invalid key: " + JSON.stringify(k);
      if (FORBIDDEN_KEYS.has(k)) return "reserved key: " + k;
      const err = walk(v, depth + 1);
      if (err) return err;
    }
    return null;
  };
  return walk(value, 1);
}

/** Read the whole store. A missing or corrupt file degrades to {} (never throws). */
export async function readAll(): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await fs.readFile(SETTINGS_FILE, "utf8");
  } catch {
    return {}; // no file yet — first run
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.warn("[settings] " + SETTINGS_FILE + " is not a JSON object; ignoring it");
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    console.warn("[settings] " + SETTINGS_FILE + " is corrupt; ignoring it:", err instanceof Error ? err.message : err);
    return {};
  }
}

/** Read one scope's value, or null when it was never saved. */
export async function readScope(scope: string): Promise<unknown | null> {
  const all = await readAll();
  return Object.prototype.hasOwnProperty.call(all, scope) ? all[scope] : null;
}

// Writes are serialized: two concurrent PUTs would otherwise read-modify-write the same file
// and one of them would silently disappear.
let queue: Promise<unknown> = Promise.resolve();

/**
 * Persist one scope. The write is atomic (tmp file + rename), so a reader always sees either the
 * previous file or the complete new one — never a half-written JSON document.
 */
export function writeScope(scope: string, value: unknown): Promise<void> {
  const run = async (): Promise<void> => {
    const all = await readAll();
    all[scope] = value;
    await fs.mkdir(DATA_DIR, { recursive: true });
    const tmp = SETTINGS_FILE + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(all, null, 2) + "\n", "utf8");
    await fs.rename(tmp, SETTINGS_FILE);
  };
  const next = queue.then(run, run);
  // Keep the chain alive even when a write fails, otherwise one rejection poisons every later write.
  queue = next.catch(() => {});
  return next;
}
