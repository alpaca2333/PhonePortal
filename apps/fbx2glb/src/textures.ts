/**
 * The "texture and FBX arrived as separate files" path.
 *
 * WHY THIS MODULE EXISTS: an FBX usually references its textures by NAME (`body_diffuse.png`), either
 * embedded (base64/blob inside the file) or as a sibling file on disk. Dropping the .fbx alone gives
 * the second kind nothing to resolve against — the loader asks the PAGE for `body_diffuse.png`, which
 * is a 404 — and the converted GLB then comes out with materials whose texture slots are empty. The
 * user is holding the missing file; the app just has to connect the two.
 *
 * HOW THE CONNECTION IS MADE (two routes, because FBXLoader has two):
 *   1. PRIMARY — a `LoadingManager.setURLModifier` hook. FBXLoader resolves every external texture to
 *      a bare file name (it strips the directory itself) and hands it to three's `ImageLoader`, which
 *      calls `manager.resolveURL(url)` first. Answering that call with a `blob:` URL of the user's
 *      file means THREE ITSELF loads the image: no 404, and — the reason this route exists instead of
 *      patching textures afterwards — every loader-side convention (sRGB colour space on
 *      `DiffuseColor`, `RepeatWrapping` from the FBX wrap modes, `flipY`, `needsUpdate`) is applied by
 *      exactly the code that applies it for an embedded texture. One source of truth for texture
 *      flags, not two.
 *   2. FALLBACK — a post-parse pass over slots that are still empty. Needed because FBXLoader
 *      silently creates a PLACEHOLDER (and never calls the manager at all) when the referenced
 *      extension is one three has no decoder for (`tga`, `psd`, `dds`) — common in 3ds-Max-era
 *      exports. Those slots are matched by the texture's own name instead, so `body_diffuse.tga` in
 *      the FBX can still be satisfied by a `body_diffuse.png` the user supplies.
 *
 * MATCHING RULES (pure, asserted in scripts/verify-fbx2glb.mjs): exact file name, case-insensitively,
 * ignoring any directory part — then the same comparison without the extension (the .tga→.png case).
 * Deliberately NO "assign whatever is left" fallback: a wrong texture on a slot is worse than an empty
 * one, and the report names exactly which file is still missing.
 *
 * `textures.ts` never touches `document`: the image DECODER is injected (`loadImage`), so every rule in
 * here runs in Node (and the browser supplies `new Image()`).
 */
import * as THREE from 'three';

/** How a provided file was matched to a reference. */
export type MatchRule = 'name' | 'stem';

/** The image formats the browser can decode and `GLTFExporter` can re-encode into a GLB. */
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'avif'] as const;

/** Extensions FBXLoader turns into an empty placeholder (three ships no decoder for them). */
export const PLACEHOLDER_EXTENSIONS = ['tga', 'psd', 'dds'] as const;

/**
 * Material slots FBXLoader can fill (see its `parseParameters` switch), plus the two PBR maps a
 * hand-authored FBX might carry. Anything outside this list is ignored on purpose: a report must not
 * claim a texture is "missing" from a slot nothing ever fills.
 */
export const TEXTURE_SLOTS = [
  'map', 'bumpMap', 'normalMap', 'aoMap', 'displacementMap', 'emissiveMap',
  'specularMap', 'alphaMap', 'envMap', 'metalnessMap', 'roughnessMap',
] as const;

/** Is this file name something we should treat as a texture when files are dropped? */
export function isImageFileName(name: string): boolean {
  return (IMAGE_EXTENSIONS as readonly string[]).includes(extensionOf(name));
}

/** Lower-cased extension without the dot ('' when there is none). */
export function extensionOf(name: string): string {
  const base = baseFileName(String(name ?? ''));
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** Last path segment, slashes or backslashes (`a\b\c.png` → `c.png`). */
export function baseFileName(path: string): string {
  return String(path ?? '').split(/[/\\]/).pop() ?? '';
}

/** Match key for the full name: last segment, quotes/whitespace stripped, lower-cased. */
export function nameKey(name: string): string {
  // Order matters: a quoted path is usually written WITH surrounding spaces, so trim before and
  // after stripping the quotes (otherwise `"a.png" ` keeps a trailing quote in the key).
  return baseFileName(name).trim().replace(/^["']|["']$/g, '').trim().toLowerCase();
}

/** Match key for the stem (name without its extension). */
export function stemKey(name: string): string {
  const key = nameKey(name);
  const dot = key.lastIndexOf('.');
  return dot > 0 ? key.slice(0, dot) : key;
}

interface IndexEntry {
  /** The file name the user supplied (for the report). */
  source: string;
  blob: Blob;
  key: string;
  stem: string;
  /** Lazily created `blob:` URL, reused for every reference to this file. */
  url: string | null;
}

export interface TextureIndex {
  entries: IndexEntry[];
  byName: Map<string, IndexEntry>;
  byStem: Map<string, IndexEntry>;
  /** Revoke every object URL this index handed out (called when the file list is cleared). */
  dispose(): void;
}

/** Build the name/stem lookup table from the files the user supplied. */
export function buildTextureIndex(files: readonly { name: string; blob: Blob }[]): TextureIndex {
  const entries: IndexEntry[] = [];
  const byName = new Map<string, IndexEntry>();
  const byStem = new Map<string, IndexEntry>();
  for (const f of files) {
    const source = String(f?.name ?? '');
    const key = nameKey(source);
    if (key.length === 0 || !f?.blob) continue;
    const entry: IndexEntry = { source, blob: f.blob, key, stem: stemKey(source), url: null };
    entries.push(entry);
    // First file wins on a duplicated name: the report still lists both, and letting the second
    // silently override the first would make the result depend on picker order.
    if (!byName.has(key)) byName.set(key, entry);
    if (entry.stem.length > 0 && !byStem.has(entry.stem)) byStem.set(entry.stem, entry);
  }
  return {
    entries, byName, byStem,
    dispose(): void {
      for (const e of entries) {
        if (e.url !== null) { try { URL.revokeObjectURL(e.url); } catch { /* already gone */ } e.url = null; }
      }
    },
  };
}

/** Resolve one reference against the index: exact name first, then extension-insensitive. */
export function matchTexture(index: TextureIndex, wanted: string): { entry: IndexEntry; rule: MatchRule } | null {
  const key = nameKey(wanted);
  if (key.length === 0) return null;
  const exact = index.byName.get(key);
  if (exact) return { entry: exact, rule: 'name' };
  const stem = stemKey(key);
  const loose = stem.length > 0 ? index.byStem.get(stem) : undefined;
  return loose ? { entry: loose, rule: 'stem' } : null;
}

/** The object URL for an entry, created once (and revoked by `index.dispose()`). */
function urlOf(entry: IndexEntry): string {
  if (entry.url === null) entry.url = URL.createObjectURL(entry.blob);
  return entry.url;
}

/**
 * What happened while textures were resolved — this is what the UI reports. Every number here is
 * exact (counted from real events), never inferred: "external" from the loader's own requests,
 * "fallback" from slots this module filled, "pending" from slots that still have no pixels.
 */
export interface TextureReport {
  /** External references the loader asked for, in request order and deduplicated by name. */
  requested: { wanted: string; provided: string | null; rule: MatchRule | null }[];
  /** Slots filled by route 2 (placeholder extensions). */
  fallback: { material: string; slot: string; from: string; rule: MatchRule }[];
  /** Slots holding pixels at the end. */
  withImage: number;
  /** Slots still empty at the end, classified: no decoder vs missing file. */
  placeholders: { material: string; slot: string; name: string }[];
  missing: { material: string; slot: string; name: string }[];
  /** Supplied files that nothing referenced. */
  unused: string[];
  /** The loader did not finish in time (a texture that never resolves). */
  timedOut: boolean;
}

export function emptyTextureReport(): TextureReport {
  return { requested: [], fallback: [], withImage: 0, placeholders: [], missing: [], unused: [], timedOut: false };
}

/** How many external references this FBX asked for / how many of them we answered. */
export function externalCounts(report: TextureReport): { external: number; filled: number } {
  const external = report.requested.length;
  return { external, filled: report.requested.filter((r) => r.provided !== null).length };
}

/** Every distinct file name that ended up supplying a texture (both routes). */
export function providedFileNames(report: TextureReport): string[] {
  const names = new Set<string>();
  for (const r of report.requested) if (r.provided) names.add(r.provided);
  for (const f of report.fallback) names.add(f.from);
  return [...names];
}

/**
 * One parse's texture wiring: the manager to hand to `new FBXLoader(...)`, the `done()` promise that
 * says when its requests have settled, and the report they filled in.
 *
 * ⚠️ WHY THIS IS A SESSION AND NOT TWO FUNCTIONS — the real bug this shape prevents: the loads START
 * inside `loader.parse()` (synchronously), so a `settle()` called afterwards that installs `onLoad` at
 * that point can miss the completion entirely, and a "did anything start?" flag read afterwards is
 * already too late. Here `onLoad` is armed when the session is created, i.e. before the parse, so the
 * ordering cannot bite. (Symptom when it did: the report said "1 texture provided" while the material
 * slot stayed empty, because the image landed a tick later.)
 */
export interface TextureSession {
  /** Pass to `new FBXLoader(session.manager)`. */
  manager: any;
  /** Resolves once every request the loader started has finished — or the timeout expired. */
  done(timeoutMs?: number): Promise<{ timedOut: boolean }>;
  /** The report the URL modifier fills in (same object the caller passed). */
  report: TextureReport;
}

/**
 * Build the session. The URL modifier answers the loader's texture references with the user's files;
 * `done()` waits for whatever it started. `LoadingManager` keeps its counters in a closure in three
 * r160 (they are not instance fields), so "nothing was requested" is tracked by our own `onStart`
 * flag — and a timeout keeps a texture that never resolves from hanging the conversion: the report
 * says so and the export proceeds with whatever did load.
 */
export function createTextureSession(index: TextureIndex, report: TextureReport): TextureSession {
  const manager = new THREE.LoadingManager();
  const seen = new Set<string>();
  let started = false;
  let settled = false;
  let resolveDone: ((v: { timedOut: boolean }) => void) | null = null;
  const settle = (timedOut: boolean): void => {
    if (settled) return;
    settled = true;
    resolveDone?.({ timedOut });
  };
  manager.onStart = () => { started = true; };
  manager.onLoad = () => settle(false);
  manager.setURLModifier((url: string) => {
    const raw = String(url ?? '');
    if (raw.length === 0) return raw;
    started = true;
    // Embedded data / already-resolved blob URLs pass through untouched.
    if (raw.startsWith('data:') || raw.startsWith('blob:')) return raw;
    const key = nameKey(raw);
    const hit = matchTexture(index, raw);
    // Record each distinct reference once, even when several materials ask for the same file.
    if (!seen.has(key)) {
      seen.add(key);
      report.requested.push({
        wanted: raw,
        provided: hit ? hit.entry.source : null,
        rule: hit ? hit.rule : null,
      });
    }
    return hit ? urlOf(hit.entry) : raw;
  });

  return {
    manager,
    report,
    done(timeoutMs = 15000): Promise<{ timedOut: boolean }> {
      return new Promise((resolve) => {
        if (settled) { resolve({ timedOut: false }); return; }
        resolveDone = resolve;
        // Nothing was requested at all: `onLoad` would never fire, so do not wait for the timeout.
        queueMicrotask(() => { if (!started) settle(false); });
        setTimeout(() => settle(true), timeoutMs);
      });
    },
  };
}

export interface TextureSlotRef {
  material: any;
  materialName: string;
  slot: string;
  texture: any;
  /** Best guess at the file the FBX wanted: FBXLoader keeps the Texture node's own name here. */
  wanted: string;
}

/** Every filled texture slot in the scene, with the material it belongs to. */
export function textureSlots(root: any): TextureSlotRef[] {
  const out: TextureSlotRef[] = [];
  const seen = new Set<any>();
  root?.traverse?.((o: any) => {
    const materials = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const material of materials) {
      if (!material || seen.has(material)) continue;
      seen.add(material);
      for (const slot of TEXTURE_SLOTS) {
        const texture = material[slot];
        if (texture && texture.isTexture) {
          out.push({
            material, materialName: String(material.name ?? ''), slot, texture,
            wanted: String(texture.name ?? '') || slot,
          });
        }
      }
    }
  });
  return out;
}

/** Slots whose texture object exists but never got pixels (placeholder, failed load, or unprovided). */
export function pendingTextureSlots(root: any): TextureSlotRef[] {
  return textureSlots(root).filter((s) => s.texture.image === null || s.texture.image === undefined);
}

/**
 * Second route (see the header): fill still-empty slots from the index, matched by the texture's own
 * name. `loadImage` turns a Blob into something three/`GLTFExporter` can draw (a browser `Image`).
 */
export async function applyTextureFallback(
  root: any,
  index: TextureIndex,
  report: TextureReport,
  loadImage: (blob: Blob) => Promise<any>,
): Promise<void> {
  for (const slot of pendingTextureSlots(root)) {
    const hit = matchTexture(index, slot.wanted);
    if (!hit) continue; // classified later by `finishTextureReport` (placeholder vs missing)
    try {
      const image = await loadImage(hit.entry.blob);
      slot.texture.image = image;
      slot.texture.needsUpdate = true;
      report.fallback.push({ material: slot.materialName, slot: slot.slot, from: hit.entry.source, rule: hit.rule });
    } catch {
      // An image the browser cannot decode: leave it pending so the report can say so.
    }
  }
}

/** Final pass: classify what is still empty, and which supplied files nothing referenced. */
export function finishTextureReport(root: any, index: TextureIndex, report: TextureReport): TextureReport {
  const pending = pendingTextureSlots(root);
  const undecodable = (name: string): boolean =>
    (PLACEHOLDER_EXTENSIONS as readonly string[]).includes(extensionOf(name));
  report.withImage = textureSlots(root).length - pending.length;
  report.placeholders = pending
    .filter((s) => undecodable(s.wanted))
    .map((s) => ({ material: s.materialName, slot: s.slot, name: s.wanted }));
  report.missing = pending
    .filter((s) => !undecodable(s.wanted))
    .map((s) => ({ material: s.materialName, slot: s.slot, name: s.wanted }));
  const used = new Set(providedFileNames(report).map(nameKey));
  report.unused = index.entries.filter((e) => !used.has(e.key)).map((e) => e.source);
  return report;
}

/**
 * Does this file still have something to gain from more texture files? Drives the "textures changed →
 * re-parse only what needs it" rule in main.ts (a Mixamo-sized FBX parse is not free).
 */
export function reportNeedsTextures(report: TextureReport): boolean {
  const { external, filled } = externalCounts(report);
  return filled < external || report.missing.length > 0 || report.placeholders.length > 0;
}

/** One-line summary for a file row / log line. Empty string when the file has no textures at all. */
export function textureSummaryText(report: TextureReport): string {
  const { external, filled } = externalCounts(report);
  const parts: string[] = [];
  if (external === 0) {
    if (report.withImage > 0) parts.push(`内嵌 ${report.withImage}`);
  } else {
    parts.push(`外部引用 ${external}`, `已补 ${filled}`);
    const stillMissing = [...report.missing, ...report.placeholders];
    if (stillMissing.length > 0) {
      parts.push(`缺 ${stillMissing.length}（${[...new Set(stillMissing.map((m) => m.name))].join('、')}）`);
    }
  }
  if (report.fallback.length > 0) parts.push(`按名回填 ${report.fallback.length}`);
  if (report.timedOut) parts.push('等待超时');
  return parts.join(' · ');
}
