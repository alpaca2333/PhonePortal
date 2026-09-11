/**
 * The headless half of the FBX→GLB converter: the app's OWN pipeline, run in a worker thread with the
 * handful of browser APIs it touches faked.
 *
 * WHY THE SAME MODULES AND NOT A SECOND IMPLEMENTATION: `apps/fbx2glb` already decided how to sniff the
 * format, match a rig, resolve the export scale and write the container. A server-side re-implementation
 * would drift from the page within one commit (and the page is the only place that can be verified with
 * a real browser). So this file adds NO conversion logic: it imports `dist/apps/fbx2glb/src/*.js` — the
 * exact files the page loads — and only supplies the environment they expect.
 *
 * WHY A WORKER THREAD: `server/src/fbx2glb.ts` must stay responsive (the game is loading assets from
 * the same server) and must survive a 200MB FBX blowing up three's heap. A crashed/OOM worker becomes a
 * 500 for that one request; the portal keeps serving. The parent terminates it as soon as the report
 * arrives, so nothing lingers.
 *
 * WHAT IS FAKED, AND WHY THAT IS THE HONEST ANSWER (see the module's docs in apps/fbx2glb/README.md):
 *   - `self` / `ProgressEvent` / `FileReader`: three reaches for them (GLTFExporter's binary path uses
 *     FileReader). `Blob.arrayBuffer()` backs both of its methods — the same shim the verify script uses.
 *   - `document.createElementNS('…','img')`: ImageLoader builds an <img>. **There is no image decoder and
 *     no canvas in Node, so every texture load fails on purpose** — the fake dispatches `error`, which is
 *     exactly the browser's "the texture file was not found" path. The pipeline then DROPS those slots
 *     (`dropPendingTextureSlots`) and reports how many, instead of exporting a file that lies.
 *     ⇒ Textures are a PAGE feature (canvas is what re-encodes them). The API does geometry, skin,
 *     animation and decimation — and says so in `X-Fbx2Glb-Textures`.
 *   - `three` itself: the app imports the bare specifier `three`, which the browser resolves through its
 *     import map and Node cannot. `registerHooks` maps it to the app's own vendored build, i.e. the same
 *     three r160 bytes the page runs (asserted by scripts/verify-fbx2glb.mjs §10).
 */
import { registerHooks } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';
// TYPE-ONLY imports from the app: they are erased at compile time, so the parent/server process never
// loads three, the DOM-touching modules or the app's module graph at all.
import type { ScaleMode } from '../../apps/fbx2glb/src/units.js';
import type { DecimateSettings } from '../../apps/fbx2glb/src/settings.js';

export interface WorkerOptions {
  /** See units.ts: auto = measure and apply cm→m, keep = ×1, cm = force ×0.01. */
  scale: ScaleMode;
  animations: boolean;
  decimate: DecimateSettings;
}

export interface WorkerJob {
  inPath: string;
  outPath: string;
  /** Name used in reports/errors (the client may pass one; it never touches the filesystem). */
  file: string;
  options: WorkerOptions;
}

export interface ConvertReport {
  bytes: number;
  file: string;
  meshes: number;
  bones: number;
  skinned: number;
  materials: number;
  triangles: number;
  clips: string[];
  unboundTracks: number;
  /** Height as measured in the source file, in source units. */
  height: number;
  /** Height as written to the GLB (after the export scale). */
  scaledHeight: number;
  scale: number;
  autoScale: boolean;
  /** `meshes` = how many meshes were actually rewritten (`decimate.applied`). */
  decimate: { enabled: boolean; before: number; after: number; ms: number; meshes: number };
  textures: { requested: number; provided: number; dropped: number; missing: string[] };
  selfCheck: { ok: boolean; error: string | null; bones: number; clips: string[] };
  warnings: string[];
}

export type WorkerMessage = { ok: true; report: ConvertReport } | { ok: false; status: number; error: string };

const THREE_URL = new URL('../../apps/fbx2glb/vendor/three.module.min.js', import.meta.url);
const APP = (name: string): string => new URL('../../apps/fbx2glb/src/' + name, import.meta.url).href;

// Must run BEFORE the app modules are imported (dynamic imports below): the hook is what makes the bare
// specifier `three` resolvable, and only this thread sees it.
registerHooks({
  // `any` on purpose: Node's ResolveHookSync context type is internal-ish and changes between minors;
  // this hook only inspects the specifier and forwards everything else untouched.
  resolve(specifier: string, context: any, next: any) {
    if (specifier === 'three') return { url: THREE_URL.href, shortCircuit: true };
    return next(specifier, context);
  },
});

/** An <img> that can never succeed: there is no decoder here (see the header). */
function unloadableImage(): any {
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const el: any = {
    width: 0, height: 0, naturalWidth: 0, naturalHeight: 0, complete: true, style: {},
    addEventListener(type: string, fn: (event: unknown) => void) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type)!.push(fn);
    },
    removeEventListener() {},
  };
  Object.defineProperty(el, 'src', {
    set() {
      // Async on purpose: three's ImageLoader attaches its handlers before assigning `src`, and a
      // synchronous callback would fire before the other handler is registered.
      setTimeout(() => {
        for (const fn of listeners.get('error') ?? []) fn.call(el, { type: 'error', target: el });
      }, 0);
    },
    get() { return ''; },
  });
  return el;
}

/** Never reached in practice (no image ever has pixels here) — but `getCanvas()` must not throw. */
function blankCanvas(): any {
  return {
    width: 1, height: 1, style: {},
    getContext: () => ({ translate() {}, scale() {}, drawImage() {}, putImageData() {} }),
    toBlob: (cb: (blob: Blob | null) => void) => cb(null),
  };
}

function installShims(): void {
  const g = globalThis as any;
  if (typeof g.self === 'undefined') g.self = g;
  if (typeof g.ProgressEvent === 'undefined') {
    g.ProgressEvent = class ProgressEvent {
      type: string;
      constructor(type: string, init: Record<string, unknown> = {}) {
        this.type = type;
        Object.assign(this, init);
      }
    };
  }
  if (typeof g.FileReader === 'undefined') {
    g.FileReader = class FileReaderShim {
      result: unknown = null;
      onloadend: (() => void) | null = null;
      readAsArrayBuffer(blob: Blob) {
        blob.arrayBuffer().then((b) => { this.result = b; this.onloadend?.(); });
      }
    };
  }
  if (typeof g.document === 'undefined') {
    g.document = {
      createElementNS: (_ns: string, tag: string) => (tag === 'img' ? unloadableImage() : { style: {} }),
      createElement: (tag: string) => (tag === 'canvas' ? blankCanvas() : { style: {}, appendChild() {}, remove() {} }),
      body: { appendChild() {}, removeChild() {} },
      documentElement: { classList: { add() {}, remove() {}, toggle() {}, contains: () => false } },
      getElementById: () => null,
      addEventListener() {},
    };
  }
}

async function convert(job: WorkerJob): Promise<ConvertReport> {
  const convertMod = await import(APP('convert.js'));
  const { describeScene } = await import(APP('analyze.js'));
  const { resolveScale } = await import(APP('units.js'));
  const { decimateForExport } = await import(APP('decimate.js'));
  const { clampDecimate } = await import(APP('settings.js'));
  const { nameClipsForFile, renameClips } = await import(APP('merge.js'));

  const raw = await readFile(job.inPath);
  const buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  const warnings: string[] = [];

  const parsed = await convertMod.parseFbx(buffer, job.file, { textures: [] });
  // The page's non-merged path, exactly: clips are named after the FILE (Mixamo calls every take
  // `mixamo.com`, so without this the output has two identically-named clips and a consumer that looks
  // clips up by name — the game does — can never reach the second one).
  const clips = renameClips(parsed.clips, nameClipsForFile(job.file, parsed.clips, 'file'));
  const textureReport = parsed.textures;
  if (textureReport.dropped > 0) {
    warnings.push(
      `服务器端没有图片解码器：${textureReport.dropped} 个贴图槽没有像素，已从产物里去掉` +
      `（要带贴图的 GLB 请在 apps/fbx2glb 页面里转换）`,
    );
  }
  if (textureReport.timedOut) warnings.push('等待贴图加载超时（产物里这些槽同样被去掉）');

  // The same clamp the settings panel uses, so an out-of-range value snaps/severities exactly like the
  // UI instead of being silently ignored — and the clamped value is what the report/headers show.
  const dOptions = clampDecimate(job.options.decimate);
  const { root, report: decimate } = await decimateForExport(parsed.root, dOptions);
  const scene = describeScene(root, clips);
  const decision = resolveScale(job.options.scale, scene.size.y);
  const output = await convertMod.exportScene(root, {
    format: 'glb',
    animations: job.options.animations ? clips : [],
    scale: decision.scale,
  });
  const glb = await output.blob.arrayBuffer();
  await writeFile(job.outPath, Buffer.from(glb));

  // Self-check the FINISHED file (the page does the same): it is the only statement about what was
  // actually written that we trust.
  const check = await convertMod.selfCheck(glb);
  const selfCheck = 'error' in check
    ? { ok: false, error: check.error, bones: 0, clips: [] as string[] }
    : { ok: true, error: null, bones: check.bones, clips: check.clipNames };
  if (!selfCheck.ok) warnings.push('自检失败：产物读不回来（' + selfCheck.error + '）');

  const before = decimate.meshes.reduce((n: number, m: any) => n + m.before, 0);
  const after = decimate.meshes.reduce((n: number, m: any) => n + m.after, 0);
  const ms = decimate.meshes.reduce((n: number, m: any) => n + m.ms, 0);
  return {
    bytes: glb.byteLength,
    file: job.file,
    meshes: scene.meshes,
    bones: scene.bones,
    skinned: scene.skinned,
    materials: scene.materials,
    triangles: scene.triangles,
    clips: scene.clips.map((c: any) => String(c.name)),
    unboundTracks: scene.clips.reduce((n: number, c: any) => n + c.unbound.length, 0),
    height: scene.size.y,
    scaledHeight: scene.size.y * decision.scale,
    scale: decision.scale,
    autoScale: decision.autoApplied,
    decimate: { enabled: dOptions.enabled, before, after, ms, meshes: decimate.applied },
    textures: {
      requested: textureReport.requested.length,
      provided: textureReport.requested.filter((r: any) => r.provided !== null).length,
      dropped: textureReport.dropped,
      missing: textureReport.missing.map((m: any) => `${m.material}.${m.slot}`),
    },
    selfCheck,
    warnings,
  };
}

(async () => {
  try {
    installShims();
    const report = await convert(workerData as WorkerJob);
    parentPort?.postMessage({ ok: true, report } satisfies WorkerMessage);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A readable, caller-caused failure (not an FBX / no geometry / bad option) is a 400-class answer;
    // anything else is our bug. The distinction is made by message, because that is what the app's
    // pipeline produces — see sniffFormat's errors in convert.ts.
    const bad = /不是 FBX|不是 glTF|既不是|无法识别|没有几何|空的|GLB 头|解析失败/.test(message);
    parentPort?.postMessage({ ok: false, status: bad ? 400 : 500, error: message } satisfies WorkerMessage);
  }
})();
