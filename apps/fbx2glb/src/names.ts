/**
 * Clip / file naming rules — PURE string work, no three.js, no DOM.
 *
 * This is the part of the converter that decides what the exported animations are CALLED, and it is
 * the part that matters most in practice: a Mixamo download calls EVERY take `mixamo.com`, so a
 * naive merge produces a file whose six clips are all named `mixamo.com` — and a consumer that looks
 * clips up by name (the shooter's `requiredClips(idle/run/shoot/…)`) then silently plays the wrong
 * one, or nothing at all. Hence:
 *
 *   1. 「按文件名命名」(default) — the clip takes the FBX file's name, so the workflow is "download
 *      each animation, name the file after the animation" (`idle.fbx`, `run.fbx`, …) and the merged
 *      GLB already has the names the consumer asks for.
 *   2. 占位名检测 — Mixamo's `mixamo.com`, Blender's `Take 001`, an empty name: even in 「按文件里的
 *      名字」 mode these are useless, so they fall back to the file name too (because a name you did
 *      not choose is worse than a name you did).
 *   3. 去重 — identical candidates become `base`, `base-2`, `base-3` … A GLB with two clips of the
 *      same name is a file whose second clip can never be selected by name.
 *
 * Everything here is asserted by scripts/verify-fbx2glb.mjs, including the CJK case (the portal is
 * Chinese-first, so 「待机.fbx」 must survive as a clip name instead of being mangled to `__`).
 */

/** Characters that are illegal in a downloadable file name (`/ \ : * ? " < > |`). */
const ILLEGAL_FILE_CHARS = /[/\\:*?"<>|]/g;

/**
 * Take names that carry no information. Anchored and case-insensitive:
 *   mixamo.com / mixamo.com.001   — Mixamo's take name for every download
 *   Take 001 / Take001            — 3ds Max / FBX default
 *   Animation / Anim / Anim_001…  — generic exporters
 * Deliberately NOT included: anything else. Guessing further would rename clips a user meant to keep.
 */
const PLACEHOLDER_CLIP_NAME = /^\s*(mixamo\.com(\.\d+)?|take\s*0*\d+|anims?|anims?[_.\s-]?\d+|animation|animation[_.\s-]?\d+)\s*$/i;

/** The file's own name with the directory and the extension removed (`a/b/Big Idle.fbx` -> `Big Idle`). */
export function baseNameOf(fileName: string): string {
  const noDir = String(fileName ?? "").split(/[/\\]/).pop() ?? "";
  const dot = noDir.lastIndexOf(".");
  return (dot > 0 ? noDir.slice(0, dot) : noDir).trim();
}

/** Is this clip name a known-useless placeholder (see above)? */
export function isPlaceholderClipName(name: string): boolean {
  return PLACEHOLDER_CLIP_NAME.test(String(name ?? ""));
}

/**
 * Make a string safe to use BOTH as a clip name and as part of a download file name.
 * Whitespace collapses to `-`, illegal file characters become `-`, and a name that ends up empty
 * falls back to `clip`. CJK and other non-ASCII letters are preserved verbatim — the GLB stores
 * clip names as UTF-8 JSON and the download name goes through a Blob URL, so there is no reason to
 * ASCII-fold the portal's own language away.
 */
export function safeName(name: string, fallback = "clip"): string {
  const cleaned = String(name ?? "").replace(ILLEGAL_FILE_CHARS, "-").replace(/\s+/g, "-").replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return cleaned.length > 0 ? cleaned : fallback;
}

/** `file` mode → the file's name; `clip` mode → the clip's own name unless it is a placeholder. */
export interface ClipNameSource {
  /** The FBX file name the clip came from. */
  file: string;
  /** The clip name as it arrived from FBXLoader (often `mixamo.com`). */
  clip: string;
}

/** The name this clip WOULD get, before dedupe. Never empty. */
export function clipCandidate(src: ClipNameSource, mode: 'file' | 'clip'): string {
  const fromFile = safeName(baseNameOf(src.file), "clip");
  if (mode === 'file') return fromFile;
  const own = safeName(src.clip, "");
  if (own.length > 0 && !isPlaceholderClipName(own)) return own;
  return fromFile;
}

/**
 * Turn N candidate names into N unique names, in order: the first keeps the base, later duplicates
 * get `-2`, `-3`, … (`idle`, `idle-2`). Suffixes are appended to the SANITIZED base and the result is
 * re-checked, so a file literally named `idle-2.fbx` cannot collide with a deduped `idle`.
 */
export function uniqueNames(candidates: readonly string[]): string[] {
  const used = new Set<string>();
  const out: string[] = [];
  for (const raw of candidates) {
    const base = safeName(raw, "clip");
    let name = base;
    let n = 2;
    while (used.has(name)) {
      name = base + "-" + n;
      n++;
    }
    used.add(name);
    out.push(name);
  }
  return out;
}

/** Convenience: all candidates for one file's clips, in order, then deduped. */
export function planClipNames(sources: readonly ClipNameSource[], mode: 'file' | 'clip'): string[] {
  return uniqueNames(sources.map((s) => clipCandidate(s, mode)));
}

/**
 * Download file name for an exported asset: `<base>.<glb|gltf>`.
 * `suffix` marks the multi-file (non-merged) case (`hero.glb`, `run.glb`, …) — it is applied to the
 * file's base name, then the whole thing is sanitized again so a weird FBX name cannot escape the
 * download folder.
 */
export function outputFileName(base: string, ext: string, suffix = ""): string {
  const stem = safeName(baseNameOf(base), "model") + (suffix ? "-" + safeName(suffix, "") : "");
  return safeName(stem, "model") + "." + ext.replace(/^\./, "");
}

/** Human-readable byte size (binary units, one decimal above 1 KB). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return bytes + " B";
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 100 ? 0 : 1) + " " + units[i];
}
