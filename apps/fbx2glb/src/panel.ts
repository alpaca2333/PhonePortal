/**
 * The 转换选项 / 减面 / 贴图压缩 / 发布目标 / 预览 cards: DOM + persistence only. It owns no conversion
 * logic and never imports a renderer or the converter — it reads the controls, writes the matching
 * override into the stored raw object, and calls back with the EFFECTIVE values (AGENTS.md: the panel
 * does not reach into engine modules; the assembly layer, main.ts, forwards).
 *
 * Persistence follows the shooter's pattern: `GET/PUT /api/settings/fbx2glb` (never localStorage),
 * sparse overrides, unknown keys preserved, 400 ms debounce, and a visible 「保存失败（仅本地生效）」
 * state instead of a silent drop. Every settings card owns exactly one group and each group's
 * 「恢复默认」 clears only itself.
 *
 * The publish card's OPTIONS are deliberately not this module's business: the candidate apps come from
 * `/api/manifest` (main.ts fills the <select>), so here the stored VALUE is a bare app id and nothing
 * in this file knows which apps exist.
 */
import { loadSettings, saveSettings } from '../../../shared/src/settings.js';
import {
  type ConvertSettings, type DecimateSettings, type PreviewSettings, type PublishSettings,
  type RawSettings, type TexturePackSettings,
  DECIMATE_LIMITS, clearConvertGroup, clearDecimateGroup, clearPreviewGroup, clearPublishGroup,
  clearTextureGroup,
  createState, effectiveConvert, effectiveDecimate, effectivePreview, effectivePublish,
  effectiveTexture,
  hasConvertOverrides, hasDecimateOverrides, hasPreviewOverrides, hasPublishOverrides,
  hasTextureOverrides, orientationOf,
  writeConvertOverride, writeDecimateOverride, writePreviewOverride, writePublishOverride,
  writeTextureOverride,
  SPEED_MAX, SPEED_MIN, SPEED_STEP,
} from './settings.js';

/** Scope name = app id (each sub-app owns one scope; see docs/TECHNICAL.md §4). */
export const SETTINGS_SCOPE = 'fbx2glb';
/** Coalesce a burst of changes (a select change is one event, a slider drag is many). */
const SAVE_DEBOUNCE_MS = 400;

export interface PanelElements {
  format: HTMLSelectElement;
  decimate: HTMLInputElement;
  decimateRatio: HTMLInputElement;
  decimateRatioOut: HTMLElement;
  decimateError: HTMLInputElement;
  decimateErrorOut: HTMLElement;
  decimateLock: HTMLInputElement;
  decimateReset: HTMLButtonElement;
  pack: HTMLInputElement;
  packSize: HTMLSelectElement;
  packJpeg: HTMLInputElement;
  packReset: HTMLButtonElement;
  /** 发布目标（选项由 main.ts 从 /api/manifest 填，这里只负责值与落盘）。 */
  publishTarget: HTMLSelectElement;
  publishReset: HTMLButtonElement;
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
  /** Called on every decimation change, INCLUDING a slider drag (so the UI can preview the numbers). */
  onDecimateChange: (s: DecimateSettings) => void;
  /** Called on every texture-packing change. */
  onTextureChange: (s: TexturePackSettings) => void;
  /** Called on every publish-target change (so the UI can re-label buttons and re-list assets). */
  onPublishChange: (s: PublishSettings) => void;
}

export interface PanelHandle {
  /** Current effective settings (what a conversion should use). */
  convert(): ConvertSettings;
  preview(): PreviewSettings;
  decimate(): DecimateSettings;
  texture(): TexturePackSettings;
  publish(): PublishSettings;
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
  function decimate(): DecimateSettings { return effectiveDecimate(raw, orientation); }
  function texture(): TexturePackSettings { return effectiveTexture(raw, orientation); }
  function publish(): PublishSettings { return effectivePublish(raw, orientation); }

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

    const dec = decimate();
    els.decimate.checked = dec.enabled;
    els.decimateRatio.min = String(DECIMATE_LIMITS.ratio.min);
    els.decimateRatio.max = String(DECIMATE_LIMITS.ratio.max);
    els.decimateRatio.step = String(DECIMATE_LIMITS.ratio.step);
    els.decimateRatio.value = String(dec.ratio);
    els.decimateRatioOut.textContent = '保留 ' + Math.round(dec.ratio * 100) + '%';
    els.decimateError.min = String(DECIMATE_LIMITS.error.min);
    els.decimateError.max = String(DECIMATE_LIMITS.error.max);
    els.decimateError.step = String(DECIMATE_LIMITS.error.step);
    els.decimateError.value = String(dec.error);
    els.decimateErrorOut.textContent = '≤ ' + (dec.error * 100).toFixed(1) + '%';
    els.decimateLock.checked = dec.lockBorder;
    els.decimateReset.disabled = !hasDecimateOverrides(raw);
    // 关掉减面时把三个参数置灰：界面直接反映"这些数现在不影响任何东西"。
    for (const el of [els.decimateRatio, els.decimateError, els.decimateLock]) el.disabled = !dec.enabled;

    const tex = texture();
    els.pack.checked = tex.enabled;
    els.packSize.value = String(tex.maxSize);
    els.packJpeg.checked = tex.jpeg;
    els.packJpeg.disabled = !tex.enabled;
    els.packSize.disabled = !tex.enabled;
    els.packReset.disabled = !hasTextureOverrides(raw);

    const pub = publish();
    // The <option> list is filled in by main.ts from /api/manifest. Setting a value with no matching
    // option silently becomes "" in the DOM, which is exactly the 「自动」 fallback — and the SETTING the
    // panel hands out is unaffected (main.ts re-applies the stored value after it fills the list, via
    // refresh(); see the stale-id note in settings.ts).
    els.publishTarget.value = pub.target;
    els.publishReset.disabled = !hasPublishOverrides(raw);

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
    opts.onDecimateChange(decimate());
    opts.onTextureChange(texture());
    opts.onPublishChange(publish());
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

  els.publishTarget.addEventListener('change', () => change((r) => writePublishOverride(r, 'target', els.publishTarget.value)));
  els.pack.addEventListener('change', () => change((r) => writeTextureOverride(r, 'enabled', els.pack.checked)));
  els.packSize.addEventListener('change', () => change((r) => writeTextureOverride(r, 'maxSize', Number(els.packSize.value))));
  els.packJpeg.addEventListener('change', () => change((r) => writeTextureOverride(r, 'jpeg', els.packJpeg.checked)));
  els.decimate.addEventListener('change', () => change((r) => writeDecimateOverride(r, 'enabled', els.decimate.checked)));
  els.decimateLock.addEventListener('change', () => change((r) => writeDecimateOverride(r, 'lockBorder', els.decimateLock.checked)));
  // 两个滑杆：拖动时实时反馈（不落盘），松手才写 —— 和预览速度滑杆同一套做法。
  els.decimateRatio.addEventListener('input', () => {
    const v = Number(els.decimateRatio.value);
    if (!Number.isFinite(v)) return;
    els.decimateRatioOut.textContent = '保留 ' + Math.round(v * 100) + '%';
    opts.onDecimateChange({ ...decimate(), ratio: v });
  });
  els.decimateRatio.addEventListener('change', () => change((r) => writeDecimateOverride(r, 'ratio', Number(els.decimateRatio.value))));
  els.decimateError.addEventListener('input', () => {
    const v = Number(els.decimateError.value);
    if (!Number.isFinite(v)) return;
    els.decimateErrorOut.textContent = '≤ ' + (v * 100).toFixed(1) + '%';
    opts.onDecimateChange({ ...decimate(), error: v });
  });
  els.decimateError.addEventListener('change', () => change((r) => writeDecimateOverride(r, 'error', Number(els.decimateError.value))));

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
  els.decimateReset.addEventListener('click', () => resetGroup(clearDecimateGroup, '减面选项已恢复默认'));
  els.packReset.addEventListener('click', () => resetGroup(clearTextureGroup, '贴图压缩选项已恢复默认'));
  els.publishReset.addEventListener('click', () => resetGroup(clearPublishGroup, '发布目标已恢复为「自动」'));
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

  return { convert, preview, decimate, texture, publish, refresh, flush };
}
