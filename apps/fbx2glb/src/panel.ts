/**
 * The 转换选项 / 预览 cards: DOM + persistence only. It owns no conversion logic and never imports a
 * renderer or the converter — it reads the controls, writes the matching override into the stored raw
 * object, and calls back with the EFFECTIVE values (AGENTS.md: the panel does not reach into engine
 * modules; the assembly layer, main.ts, forwards).
 *
 * Persistence follows the shooter's pattern: `GET/PUT /api/settings/fbx2glb` (never localStorage),
 * sparse overrides, unknown keys preserved, 400 ms debounce, and a visible 「保存失败（仅本地生效）」
 * state instead of a silent drop. Two groups, each with its own 「恢复默认」 that clears only itself.
 */
import { loadSettings, saveSettings } from '../../../shared/src/settings.js';
import {
  type ConvertSettings, type PreviewSettings, type RawSettings,
  clearConvertGroup, clearPreviewGroup, createState, effectiveConvert, effectivePreview,
  hasConvertOverrides, hasPreviewOverrides, orientationOf,
  writeConvertOverride, writePreviewOverride,
  SPEED_MAX, SPEED_MIN, SPEED_STEP,
} from './settings.js';

/** Scope name = app id (each sub-app owns one scope; see docs/TECHNICAL.md §4). */
export const SETTINGS_SCOPE = 'fbx2glb';
/** Coalesce a burst of changes (a select change is one event, a slider drag is many). */
const SAVE_DEBOUNCE_MS = 400;

export interface PanelElements {
  format: HTMLSelectElement;
  merge: HTMLInputElement;
  animations: HTMLInputElement;
  scale: HTMLSelectElement;
  naming: HTMLSelectElement;
  convertReset: HTMLButtonElement;
  grid: HTMLInputElement;
  bones: HTMLInputElement;
  speed: HTMLInputElement;
  speedOut: HTMLElement;
  previewReset: HTMLButtonElement;
  status: HTMLElement;
}

export interface PanelOptions {
  els: PanelElements;
  onConvertChange: (s: ConvertSettings) => void;
  onPreviewChange: (s: PreviewSettings) => void;
}

export interface PanelHandle {
  /** Current effective settings (what a conversion should use). */
  convert(): ConvertSettings;
  preview(): PreviewSettings;
  /** Re-read the viewport orientation and re-apply (a hand-edited file may differ per orientation). */
  refresh(): void;
  /** Flush any pending save (used before a long conversion, so the value is not lost on navigation). */
  flush(): Promise<void>;
}

export function createPanel(opts: PanelOptions): PanelHandle {
  const { els } = opts;
  let raw: RawSettings = {};
  let orientation = orientationOf({ width: window.innerWidth, height: window.innerHeight });
  let dirty = false;
  let saveTimer: number | null = null;

  function convert(): ConvertSettings { return effectiveConvert(raw, orientation); }
  function preview(): PreviewSettings { return effectivePreview(raw, orientation); }

  function setStatus(text: string, isError = false): void {
    els.status.textContent = text;
    els.status.classList.toggle('error', isError);
  }

  /** Push the current values into the controls (also used right after 「恢复默认」). */
  function syncControls(): void {
    const c = convert();
    els.format.value = c.format;
    els.merge.checked = c.merge;
    els.animations.checked = c.animations;
    els.scale.value = c.scaleMode;
    els.naming.value = c.clipNaming;
    els.convertReset.disabled = !hasConvertOverrides(raw);

    const p = preview();
    els.grid.checked = p.grid;
    els.bones.checked = p.bones;
    els.speed.min = String(SPEED_MIN);
    els.speed.max = String(SPEED_MAX);
    els.speed.step = String(SPEED_STEP);
    els.speed.value = String(p.speed);
    els.speedOut.textContent = "×" + p.speed.toFixed(1);
    els.previewReset.disabled = !hasPreviewOverrides(raw);
  }

  function apply(): void {
    opts.onConvertChange(convert());
    opts.onPreviewChange(preview());
  }

  async function flush(): Promise<void> {
    if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null; }
    if (!dirty) return;
    dirty = false;
    setStatus('保存中…');
    const res = await saveSettings(SETTINGS_SCOPE, raw);
    if (res.ok) setStatus('已保存到服务器');
    else {
      dirty = true; // retry on the next change
      setStatus('保存失败（仅本地生效）：' + res.error, true);
    }
  }

  function scheduleSave(): void {
    dirty = true;
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => { saveTimer = null; void flush(); }, SAVE_DEBOUNCE_MS);
  }

  /** Every control funnels through here: write the override, re-render, notify, schedule the save. */
  function change(write: (raw: RawSettings) => void): void {
    write(raw);
    syncControls();
    apply();
    scheduleSave();
  }

  els.format.addEventListener('change', () => change((r) => writeConvertOverride(r, 'format', els.format.value)));
  els.merge.addEventListener('change', () => change((r) => writeConvertOverride(r, 'merge', els.merge.checked)));
  els.animations.addEventListener('change', () => change((r) => writeConvertOverride(r, 'animations', els.animations.checked)));
  els.scale.addEventListener('change', () => change((r) => writeConvertOverride(r, 'scaleMode', els.scale.value)));
  els.naming.addEventListener('change', () => change((r) => writeConvertOverride(r, 'clipNaming', els.naming.value)));

  els.grid.addEventListener('change', () => change((r) => writePreviewOverride(r, 'grid', els.grid.checked)));
  els.bones.addEventListener('change', () => change((r) => writePreviewOverride(r, 'bones', els.bones.checked)));
  els.speed.addEventListener('input', () => {
    const v = Number(els.speed.value);
    if (!Number.isFinite(v)) return;
    // The speed is previewed live but stored only on `change`: a drag would otherwise write ~20 times.
    els.speedOut.textContent = "×" + v.toFixed(1);
    opts.onPreviewChange({ ...preview(), speed: v });
  });
  els.speed.addEventListener('change', () => change((r) => writePreviewOverride(r, 'speed', Number(els.speed.value))));

  /**
   * 「恢复默认」 clears ONE group (both orientations, since a value here has no orientation
   * semantics) and PERSISTS the cleared state. The `dirty = true` matters: `flush()` is a no-op when
   * nothing is pending, so without it the reset would only exist in memory until the next unrelated
   * change — the user would see the defaults come back, reload, and find their old values again.
   * (Caught by the DOM-shim flow test in scripts/verify-fbx2glb.mjs.)
   */
  function resetGroup(clear: (r: RawSettings) => void, message: string): void {
    clear(raw);
    syncControls();
    apply();
    dirty = true;
    void flush();
    setStatus(message);
  }

  els.convertReset.addEventListener('click', () => resetGroup(clearConvertGroup, '转换选项已恢复默认'));
  els.previewReset.addEventListener('click', () => resetGroup(clearPreviewGroup, '预览选项已恢复默认'));

  const refresh = (): void => {
    orientation = orientationOf({ width: window.innerWidth, height: window.innerHeight });
    syncControls();
    apply();
  };
  window.addEventListener('resize', refresh);

  // --- boot: defaults first (so a conversion started immediately is well defined), then the server --
  syncControls();
  apply();
  void (async () => {
    const res = await loadSettings<unknown>(SETTINGS_SCOPE);
    if (res.ok) {
      raw = createState(res.value);
      setStatus(res.value === null ? '使用默认值' : '已从服务器加载设置');
    } else {
      setStatus('未连接服务器，设置无法保存：' + res.error, true);
    }
    syncControls();
    apply();
  })();

  return { convert, preview, refresh, flush };
}
