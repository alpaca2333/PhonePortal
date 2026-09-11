// Settings UI for the shooter: a gear button (bottom centre, between the two sticks) that opens a
// FULL-SCREEN panel over the running game. The panel is PAGINATED — one tab per group:
//
//   操控 — the joystick size/position (applied through CSS variables, see applyStickLayout)
//   画面 — the camera height multiplier + horizontal angle (pushed to the renderer through callbacks)
//   视野 — the occlusion darkness (pushed through `onVisionChange`; 0 = off)
//   光照 — the ambient + directional multipliers (pushed through `onLightChange`/`onDirectionalChange`)
//   雾   — the height-fog density (pushed through `onFogChange`; 0 = off)
//   后期 — the tone grade + vignette + pixelation (pushed through `onLookChange`; 0 = unprocessed)
//
// Sliders apply immediately and the value is persisted to the server 400ms after the last change.
// Each page has its own 「恢复默认」 button, because a single footer button became ambiguous once
// there was more than one group: it could not express "reset only the camera".
//
// WHY FULL SCREEN AND PAGINATED (the request: 「页面应该充满整个屏幕…关闭按钮锚定在左上角不滚动…横屏竖屏的
// 字体应该一样大…一个栏目就是一页…摇杆的设置可以一行放两个拖动条」):
//   * the layout is `flex-column`: a fixed header (close button at its LEFT edge), a fixed tab strip,
//     and ONE scrolling body. Only the body scrolls, so the ✕ and the page tabs never move — that is
//     what "anchored and not scrolling" means structurally, and verify-panel asserts the tree shape.
//   * because the panel now owns the whole screen there is no reason for a landscape media query to
//     shrink its type any more (that query existed to fit a ~56vh box into a short viewport); the
//     stylesheet therefore defines the panel's type once and deletes the landscape copies.
//   * one page per group means no page has to scroll on a phone at all in portrait, and the tab strip
//     is the only navigation. The current page lives in memory only — which tab is showing is
//     transient UI state, NOT a user setting (AGENTS.md: if the user would not call it a setting, it
//     does not go to the server).
//   * the 操控 page lays its five sliders out two per row (`two-col`): the panel is now wide, and a
//     full-width row per inset wasted a screenful. Rows in that layout put the label on its own line
//     and the range + readout underneath, so half a phone's width is still a comfortable drag target.
//
// This module owns the DOM; ./settings.ts owns the schema and merge rules (pure, node-testable),
// ./camera.ts owns the framing geometry, ./vision.ts the darkness, ./lighting.ts the two lights and
// ./fog.ts the height fog, ./grade.ts and ./vignette.ts the finishing pass.
import { loadSettings, saveSettings } from '../../../shared/src/settings.js';
import {
  CAMERA_LIMITS, FIRE_BTN_SIZE_PX, FOG_LIMITS, LIGHT_LIMITS, LIMITS, LOOK_LIMITS, VISION_LIMITS,
  orientationOf, effectiveFor, effectiveCamera, effectiveVision, effectiveLight, effectiveFog,
  effectiveLook, lookPadSize, writeOverride, writeCameraOverride, writeVisionOverride,
  writeLightOverride, writeFogOverride, writeLookOverride, clearStickOverrides, clearCameraOverrides,
  clearVisionOverrides, clearLightOverrides, clearFogOverrides, clearLookOverrides,
  hasStickOverrides, hasCameraOverrides, hasVisionOverrides, hasLightOverrides, hasFogOverrides,
  hasLookOverrides, createState,
} from './settings.js';
import type { Orientation, RawSettings, StickKey, StickLayout, StickSliderKey, Viewport } from './settings.js';
// Display-only helpers, so the readouts are computed from the same constants the sliders and the
// renderer use (a percent that only exists in the panel would be a third copy of the model).
import { ambientPercentOfLegacy, directionalPercent } from './lighting.js';
import { fogPercent } from './fog.js';
import { gradePercent } from './grade.js';
import { vignettePercent } from './vignette.js';
import { pixelPercent } from './postfx.js';

/** Scope name in data/settings.json. One scope per sub-app. */
export const SETTINGS_SCOPE = 'shooter';

const SAVE_DEBOUNCE_MS = 400;

/** Every slider in the panel: the 操控 keys, camera, vision and lighting keys, fog and look. */
type SliderKey = StickKey | 'heightScale' | 'yaw' | 'dim' | 'ambient' | 'directional' | 'density'
  | 'tone' | 'vignette' | 'pixel';
const CAMERA_SLIDER_KEY: SliderKey = 'heightScale';
const YAW_SLIDER_KEY: SliderKey = 'yaw';
/** 「摄像机灵敏度」 — stored in the 操控 group (see settings.ts::StickLayout). */
const YAW_SCALE_SLIDER_KEY: SliderKey = 'yawScaleDeg';
const VISION_SLIDER_KEY: SliderKey = 'dim';
const LIGHT_SLIDER_KEY: SliderKey = 'ambient';
const DIRECTIONAL_SLIDER_KEY: SliderKey = 'directional';
const FOG_SLIDER_KEY: SliderKey = 'density';
const TONE_SLIDER_KEY: SliderKey = 'tone';
const VIGNETTE_SLIDER_KEY: SliderKey = 'vignette';
const PIXEL_SLIDER_KEY: SliderKey = 'pixel';

export function currentViewport(): Viewport {
  return { width: window.innerWidth, height: window.innerHeight };
}

/**
 * Push a layout into CSS custom properties. Every stick geometry rule in styles.css reads these,
 * so this is the single place where the setting becomes visual. The knob travel is NOT set here:
 * input.ts measures the element's rendered box, so it follows any size automatically.
 */
export function applyStickLayout(l: StickLayout, vp: Viewport = currentViewport()): void {
  const s = document.documentElement.style;
  s.setProperty('--stick-size', l.sizePx + 'px');
  s.setProperty('--stick-lx', l.leftX + 'px');
  s.setProperty('--stick-ly', l.leftY + 'px');
  s.setProperty('--stick-rx', l.rightX + 'px');
  s.setProperty('--stick-ry', l.rightY + 'px');
  // The fire button's insets ride the same path: one place turns the 操控 layout into CSS, so the
  // button cannot end up positioned by a second, drifting rule.
  s.setProperty('--fire-rx', l.fireX + 'px');
  s.setProperty('--fire-ry', l.fireY + 'px');
  // The right stick is a look PAD: its size comes from the VIEWPORT (settings.ts::lookPadSize), not
  // from `sizePx`, which is why it is written here rather than being part of StickLayout.
  const pad = lookPadSize(vp);
  s.setProperty('--look-w', pad.w + 'px');
  s.setProperty('--look-h', pad.h + 'px');
}

/**
 * The 操控 rows. X/Y of one control are adjacent on purpose: with two sliders per row (`two-col`)
 * the pairs read as "left stick (X, Y)", "look pad (X, Y)", then the shared size on its own line.
 * `sizePx` is the LEFT stick only — the look pad is sized from the viewport (settings.ts::lookPadSize),
 * so its label must not promise otherwise.
 */
const STICK_ROWS: ReadonlyArray<{ key: StickSliderKey; label: string }> = [
  { key: 'leftX', label: '左摇杆 X（距左边）' },
  { key: 'leftY', label: '左摇杆 Y（距底边）' },
  { key: 'rightX', label: '视角区 X（距右边）' },
  { key: 'rightY', label: '视角区 Y（距底边）' },
  { key: 'sizePx', label: '左摇杆大小' },
];

/** One page = one group. Order matches the shipped panel (操控 / 画面 / 视野 / 光照 / 雾 / 后期). */
interface PageDef { id: string; title: string; twoCol?: boolean }
const PAGES: readonly PageDef[] = [
  { id: 'stick', title: '操控', twoCol: true },
  { id: 'camera', title: '画面' },
  { id: 'vision', title: '视野' },
  { id: 'light', title: '光照' },
  { id: 'fog', title: '雾' },
  { id: 'look', title: '后期' },
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

interface SliderControl { input: HTMLInputElement; out: HTMLElement }

function makeSliderRow(label: string, key: SliderKey): { row: HTMLElement; control: SliderControl } {
  const row = el('label', 'set-row');
  const name = el('span', 'set-name', label);
  const input = el('input', 'set-range');
  input.type = 'range';
  input.dataset.key = key;
  const out = el('span', 'set-val', '');
  row.append(name, input, out);
  return { row, control: { input, out } };
}

/** A page's caption row: the group name plus that group's own 「恢复默认」 button. */
function makeGroupHead(title: string): { head: HTMLElement; reset: HTMLButtonElement } {
  const head = el('div', 'set-group');
  const name = el('span', 'set-group-name', title);
  const reset = el('button', 'set-reset set-group-reset', '恢复默认');
  reset.type = 'button';
  head.append(name, reset);
  return { head, reset };
}

export interface SettingsPanelOptions {
  /** Called whenever the panel opens/closes; main.ts uses it to pause the simulation. */
  onOpenChange?: (open: boolean) => void;
  /**
   * Called with the effective camera height multiplier whenever it changes (boot, slider drag,
   * orientation switch, reset). main.ts forwards it to GameRenderer.setCameraHeightScale — this
   * module deliberately knows nothing about the renderer.
   */
  onCameraChange?: (heightScale: number) => void;
  /**
   * Called with the effective camera horizontal angle in degrees on the same occasions. main.ts
   * forwards it to BOTH Input.setCameraYaw (the mapping) and GameRenderer.setCameraYaw (the pose),
   * which is why the panel does not need to know about either. This is the RESTING angle: the right
   * stick moves the camera relative to it (see camera.ts::stickYawTarget).
   */
  onCameraYawChange?: (yaw: number) => void;
  /**
   * Called with the effective right-stick camera sensitivity (yaw degrees at full deflection) on the
   * same occasions. Input-only: main.ts forwards it to Input.setYawScale.
   */
  onYawScaleChange?: (deg: number) => void;
  /**
   * The FIRE button element. When the panel is open it becomes the drag handle for its own position
   * (that is the requirement: "drag the button itself"): the panel adds `.placing` — which styles.css
   * lifts above the panel — and turns the pointer drag into `fireX`/`fireY` overrides through the
   * same `clampLayout` cap the sticks use. Optional so the panel still builds without it.
   */
  fireButton?: HTMLElement;
  /**
   * Called with the effective occlusion darkness whenever it changes, for the same reasons and on
   * the same occasions as `onCameraChange`. 0 means the feature is off (main.ts forwards it to
   * GameRenderer.setVisionDim, which then hides the overlay entirely).
   */
  onVisionChange?: (dim: number) => void;
  /**
   * Called with the effective ambient-light multiplier whenever it changes, for the same reasons and
   * on the same occasions as `onCameraChange`. main.ts forwards it to
   * GameRenderer.setAmbientScale, which multiplies it by the base intensity in ./lighting.ts.
   */
  onLightChange?: (scale: number) => void;
  /**
   * Called with the effective directional-light multiplier (it scales BOTH directional lights) on the
   * same occasions. main.ts forwards it to GameRenderer.setDirectionalScale.
   */
  onDirectionalChange?: (scale: number) => void;
  /**
   * Called with the effective height-fog density on the same occasions. main.ts forwards it to
   * GameRenderer.setFogDensity; 0 is the off switch (the shader mix becomes a no-op).
   */
  onFogChange?: (density: number) => void;
  /**
   * Called with the effective 调色 values on the same occasions: `tone` is the grade strength and
   * `vignette` the corner falloff. Both are 0 = unprocessed, which main.ts forwards to
   * GameRenderer.setGradeStrength / setVignetteStrength.
   */
  onLookChange?: (look: { tone: number; vignette: number; pixel: number }) => void;
}

export interface SettingsPanelHandle {
  /** Re-read the viewport / orientation and re-apply (call on resize / rotation). */
  refresh(): void;
  open(): void;
  close(): void;
  isOpen(): boolean;
}

export function createSettingsPanel(opts: SettingsPanelOptions = {}): SettingsPanelHandle {
  const stage = document.getElementById('stage') ?? document.body;

  let raw: RawSettings = {};
  let orientation: Orientation = orientationOf(window.innerWidth, window.innerHeight);
  let open = false;
  let dirty = false;
  let saveTimer: number | null = null;
  /** Slider currently under the finger; its value must not be written back mid-drag. */
  let draggingKey: SliderKey | null = null;
  /** Which page is showing. Deliberately NOT persisted: which tab you last looked at is UI state. */
  let pageIndex = 0;

  // --- DOM ---
  const gear = el('button', 'gear-btn', '⚙');
  gear.type = 'button';
  gear.title = '设置';
  gear.setAttribute('aria-label', '设置');
  gear.setAttribute('aria-expanded', 'false');

  const panel = el('section', 'settings-panel');
  panel.hidden = true;

  // Fixed header: the ✕ is the FIRST child (left edge), so it stays put while the body scrolls, and
  // the save status lives here rather than in a footer that would scroll away.
  const head = el('header', 'set-head');
  const closeBtn = el('button', 'set-close', '✕');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', '关闭设置');
  const title = el('div', 'set-title', '设置');
  const badge = el('div', 'set-badge', '');
  const status = el('span', 'set-status', '');
  head.append(closeBtn, title, badge, status);

  // Fixed tab strip: one tab per page.
  const tabBar = el('nav', 'set-tabs');
  tabBar.setAttribute('aria-label', '设置分组');
  const tabs: HTMLButtonElement[] = [];
  for (const p of PAGES) {
    const tab = el('button', 'set-tab', p.title);
    tab.type = 'button';
    tab.dataset.page = p.id;
    tab.setAttribute('role', 'tab');
    tabs.push(tab);
    tabBar.append(tab);
  }

  // The one scrolling region.
  const body = el('div', 'set-body');
  const hint = el('p', 'set-hint', '打开设置时游戏暂停 · 横屏与竖屏各自独立存储');
  const warn = el('p', 'set-warn', '');
  warn.hidden = true;
  body.append(hint, warn);

  // One section per group, each with its own caption+reset row and its own rows container.
  const pages: HTMLElement[] = [];
  const rowsBoxes = new Map<string, HTMLElement>();
  const groupResets = new Map<string, HTMLButtonElement>();
  for (const p of PAGES) {
    const page = el('section', 'set-page');
    page.dataset.page = p.id;
    page.setAttribute('role', 'tabpanel');
    const group = makeGroupHead(p.title);
    const rows = el('div', p.twoCol ? 'set-rows two-col' : 'set-rows');
    page.append(group.head, rows);
    body.append(page);
    pages.push(page);
    rowsBoxes.set(p.id, rows);
    groupResets.set(p.id, group.reset);
  }

  /** Add a slider row to a page. */
  const addRow = (page: string, label: string, key: SliderKey): SliderControl => {
    const built = makeSliderRow(label, key);
    rowsBoxes.get(page)?.append(built.row);
    return built.control;
  };

  panel.append(head, tabBar, body);
  stage.append(gear, panel);

  // 操控 page: the five stick geometry keys, the right-stick camera sensitivity, and (below the
  // sliders) the fire button, which is moved by DRAGGING IT rather than by a pair of sliders.
  const stickSliders = new Map<StickSliderKey, SliderControl>();
  for (const row of STICK_ROWS) stickSliders.set(row.key, addRow('stick', row.label, row.key));
  const yawScaleSlider = addRow('stick', '摄像机灵敏度（满行程）', YAW_SCALE_SLIDER_KEY);
  const fireHint = el('p', 'set-hint', '开火键：按住屏幕上的圆形按钮即可拖动位置（松手保存）');
  rowsBoxes.get('stick')?.append(fireHint);
  // 画面 page
  const cameraSlider = addRow('camera', '摄像机高度', CAMERA_SLIDER_KEY);
  const yawSlider = addRow('camera', '摄像机水平角度', YAW_SLIDER_KEY);
  // 视野 page
  const visionSlider = addRow('vision', '遮挡变暗', VISION_SLIDER_KEY);
  // 光照 page
  const lightSlider = addRow('light', '环境光', LIGHT_SLIDER_KEY);
  const dirSlider = addRow('light', '方向光', DIRECTIONAL_SLIDER_KEY);
  // 雾 page
  const fogSlider = addRow('fog', '高度雾', FOG_SLIDER_KEY);
  // 后期 page
  const toneSlider = addRow('look', '调性（分级强度）', TONE_SLIDER_KEY);
  const vigSlider = addRow('look', '暗角', VIGNETTE_SLIDER_KEY);
  const pixSlider = addRow('look', '像素化（每块 CSS px）', PIXEL_SLIDER_KEY);
  const stickGroup = { reset: groupResets.get('stick') as HTMLButtonElement };
  const cameraGroup = { reset: groupResets.get('camera') as HTMLButtonElement };
  const visionGroup = { reset: groupResets.get('vision') as HTMLButtonElement };
  const lightGroup = { reset: groupResets.get('light') as HTMLButtonElement };
  const fogGroup = { reset: groupResets.get('fog') as HTMLButtonElement };
  const lookGroup = { reset: groupResets.get('look') as HTMLButtonElement };

  /** Show one page (and mark its tab). The pages themselves are static, so this is all it takes. */
  function setPage(next: number): void {
    pageIndex = Math.max(0, Math.min(PAGES.length - 1, next));
    for (let i = 0; i < pages.length; i++) {
      pages[i].hidden = i !== pageIndex;
      tabs[i].classList.toggle('on', i === pageIndex);
      tabs[i].setAttribute('aria-selected', String(i === pageIndex));
    }
  }

  // --- state helpers ---
  const effective = (): StickLayout => effectiveFor(raw, orientation, currentViewport());
  const effectiveCam = (): number => effectiveCamera(raw, orientation).heightScale;
  const effectiveYaw = (): number => effectiveCamera(raw, orientation).yaw;
  const effectiveYawScale = (): number => effectiveFor(raw, orientation, currentViewport()).yawScaleDeg;
  const effectiveVis = (): number => effectiveVision(raw, orientation).dim;
  const effectiveAmb = (): number => effectiveLight(raw, orientation).ambient;
  const effectiveDir = (): number => effectiveLight(raw, orientation).directional;
  // NOT named `effectiveFog` — that is the imported merge function, and shadowing it here silently
  // turned the call below into infinite recursion of the local arrow (tsc caught it).
  const effectiveFogDensity = (): number => effectiveFog(raw, orientation).density;
  const effectiveLookValues = (): { tone: number; vignette: number; pixel: number } =>
    effectiveLook(raw, orientation);

  function apply(): void {
    applyStickLayout(effective(), currentViewport());
    opts.onCameraChange?.(effectiveCam());
    opts.onCameraYawChange?.(effectiveYaw());
    opts.onYawScaleChange?.(effectiveYawScale());
    opts.onVisionChange?.(effectiveVis());
    opts.onLightChange?.(effectiveAmb());
    opts.onDirectionalChange?.(effectiveDir());
    opts.onFogChange?.(effectiveFogDensity());
    opts.onLookChange?.(effectiveLookValues());
  }

  /**
   * Slider ranges depend on the current layout: the effective max for `sizePx` is capped by the
   * viewport height, and an inset can never push a stick off screen. Keeping the sliders in sync
   * with those caps means the thumb always reflects what is actually applied. The other sliders
   * use fixed limits, but share the same readout/drag-protection path.
   */
  function syncControls(): void {
    const vp = currentViewport();
    const layout = effective();
    const cam = effectiveCam();
    const yaw = effectiveYaw();
    const yawScale = effectiveYawScale();
    const vis = effectiveVis();
    const amb = effectiveAmb();
    const dir = effectiveDir();
    const fog = effectiveFogDensity();
    const look = effectiveLookValues();
    badge.textContent = orientation === 'landscape' ? '当前：横屏' : '当前：竖屏';
    stickGroup.reset.disabled = !hasStickOverrides(raw, orientation);
    // 画面 has TWO keys now (height + yaw) — one button clears both, like 光照.
    cameraGroup.reset.disabled = !hasCameraOverrides(raw, orientation);
    visionGroup.reset.disabled = !hasVisionOverrides(raw, orientation);
    lightGroup.reset.disabled = !hasLightOverrides(raw, orientation);
    fogGroup.reset.disabled = !hasFogOverrides(raw, orientation);
    lookGroup.reset.disabled = !hasLookOverrides(raw, orientation);

    const maxSize = Math.max(LIMITS.sizePx.min, Math.min(LIMITS.sizePx.max, vp.height * 0.5));
    for (const [key, c] of stickSliders) {
      let max = LIMITS[key].max;
      if (key === 'sizePx') max = maxSize;
      else if (key === 'leftX' || key === 'rightX') max = Math.min(max, Math.max(0, vp.width - layout.sizePx));
      else max = Math.min(max, Math.max(0, vp.height - layout.sizePx));
      c.input.min = String(LIMITS[key].min);
      c.input.max = String(Math.max(LIMITS[key].min, max));
      c.input.step = String(LIMITS[key].step);
      // Never write back the value of the slider the finger is currently on: assigning .value
      // mid-drag can fight the browser's own drag state (and would snap the thumb when a clamp
      // kicks in). The readout below still shows the value that is actually applied.
      if (key !== draggingKey) c.input.value = String(layout[key]);
      c.out.textContent = Math.round(layout[key]) + ' px';
    }

    const yslim = LIMITS.yawScaleDeg;
    yawScaleSlider.input.min = String(yslim.min);
    yawScaleSlider.input.max = String(yslim.max);
    yawScaleSlider.input.step = String(yslim.step);
    if (draggingKey !== YAW_SCALE_SLIDER_KEY) yawScaleSlider.input.value = String(yawScale);
    // Degrees, because that is the unit the player can reason about ("a full push turns me 90° 左右").
    yawScaleSlider.out.textContent = yawScale + '°';

    const clim = CAMERA_LIMITS.heightScale;
    cameraSlider.input.min = String(clim.min);
    cameraSlider.input.max = String(clim.max);
    cameraSlider.input.step = String(clim.step);
    if (draggingKey !== CAMERA_SLIDER_KEY) cameraSlider.input.value = String(cam);
    cameraSlider.out.textContent = cam.toFixed(2) + '×';

    const ylim = CAMERA_LIMITS.yaw;
    yawSlider.input.min = String(ylim.min);
    yawSlider.input.max = String(ylim.max);
    yawSlider.input.step = String(ylim.step);
    if (draggingKey !== YAW_SLIDER_KEY) yawSlider.input.value = String(yaw);
    // A plain angle: 0 is the shipped view (NOT an "off" state, so no「关闭」 wording), and the sign is
    // shown so the direction of rotation is learnable.
    yawSlider.out.textContent = yaw > 0 ? '+' + yaw + '°' : yaw + '°';

    const vlim = VISION_LIMITS.dim;
    visionSlider.input.min = String(vlim.min);
    visionSlider.input.max = String(vlim.max);
    visionSlider.input.step = String(vlim.step);
    if (draggingKey !== VISION_SLIDER_KEY) visionSlider.input.value = String(vis);
    // Percent, and the bottom of the range is named rather than shown as 0%: the player needs to
    // know that 0 is "off", not "a bit dimmer".
    visionSlider.out.textContent = vis <= 0 ? '关闭' : Math.round(vis * 100) + '%';

    const alim = LIGHT_LIMITS.ambient;
    lightSlider.input.min = String(alim.min);
    lightSlider.input.max = String(alim.max);
    lightSlider.input.step = String(alim.step);
    if (draggingKey !== LIGHT_SLIDER_KEY) lightSlider.input.value = String(amb);
    // Percent of the PRE-SETTING ambient intensity (the 1.05 that predates this setting), not of the
    // slider unit: 0% = off (what ships now), 40% = the 0.42 that shipped for one round, 100% = the
    // original. Anchoring the display to that fixed reference keeps the numbers meaningful even
    // though the unit and the shipped level both changed repeatedly. 0 is a legal look, so it reads as
    // a number rather than as the 「关闭」 wording 遮挡变暗 uses.
    lightSlider.out.textContent = ambientPercentOfLegacy(amb) + '%';

    const dlim = LIGHT_LIMITS.directional;
    dirSlider.input.min = String(dlim.min);
    dirSlider.input.max = String(dlim.max);
    dirSlider.input.step = String(dlim.step);
    if (draggingKey !== DIRECTIONAL_SLIDER_KEY) dirSlider.input.value = String(dir);
    // Percent of the sun the scene has always shipped (both directional lights move together).
    dirSlider.out.textContent = directionalPercent(dir) + '%';

    const flim = FOG_LIMITS.density;
    fogSlider.input.min = String(flim.min);
    fogSlider.input.max = String(flim.max);
    fogSlider.input.step = String(flim.step);
    if (draggingKey !== FOG_SLIDER_KEY) fogSlider.input.value = String(fog);
    // 0 is a real off switch here (the shader mix becomes a no-op), so it reads as 「关闭」 like 遮挡变暗
    // rather than as a percentage. Above that the number is a percent of the maximum density.
    fogSlider.out.textContent = fog <= 0 ? '关闭' : fogPercent(fog) + '%';

    const tlim = LOOK_LIMITS.tone;
    toneSlider.input.min = String(tlim.min);
    toneSlider.input.max = String(tlim.max);
    toneSlider.input.step = String(tlim.step);
    if (draggingKey !== TONE_SLIDER_KEY) toneSlider.input.value = String(look.tone);
    toneSlider.out.textContent = look.tone <= 0 ? '关闭' : gradePercent(look.tone) + '%';

    const vglim = LOOK_LIMITS.vignette;
    vigSlider.input.min = String(vglim.min);
    vigSlider.input.max = String(vglim.max);
    vigSlider.input.step = String(vglim.step);
    if (draggingKey !== VIGNETTE_SLIDER_KEY) vigSlider.input.value = String(look.vignette);
    vigSlider.out.textContent = look.vignette <= 0 ? '关闭' : vignettePercent(look.vignette) + '%';

    const plim = LOOK_LIMITS.pixel;
    pixSlider.input.min = String(plim.min);
    pixSlider.input.max = String(plim.max);
    pixSlider.input.step = String(plim.step);
    if (draggingKey !== PIXEL_SLIDER_KEY) pixSlider.input.value = String(look.pixel);
    // The block size is a pixel count, not a percentage: show the pixels, and 0 as the off switch.
    pixSlider.out.textContent = look.pixel <= 0 ? '关闭' : Math.round(look.pixel) + ' px';
  }

  function setStatus(text: string, isError = false): void {
    status.textContent = text;
    status.classList.toggle('error', isError);
  }

  async function flush(): Promise<void> {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (!dirty) return;
    dirty = false;
    setStatus('保存中…');
    const res = await saveSettings(SETTINGS_SCOPE, raw);
    if (res.ok) {
      setStatus('已保存到服务器');
    } else {
      dirty = true; // retry on the next change / next close
      setStatus('保存失败（仅本地生效）：' + res.error, true);
    }
  }

  function scheduleSave(): void {
    dirty = true;
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => { saveTimer = null; void flush(); }, SAVE_DEBOUNCE_MS);
  }

  function refresh(): void {
    orientation = orientationOf(window.innerWidth, window.innerHeight);
    apply();
    syncControls();
  }

  /** Wire one slider: write its override, apply immediately, re-sync, and schedule the save. */
  function bindSlider(key: SliderKey, control: SliderControl, write: (v: number) => void): void {
    control.input.addEventListener('input', () => {
      const v = Number(control.input.value);
      if (!Number.isFinite(v)) return;
      draggingKey = key;
      write(v);
      apply();
      // Stick size changes can move the inset caps, so refresh the whole row set, not just this row.
      syncControls();
      scheduleSave();
    });
    control.input.addEventListener('change', () => {
      draggingKey = null;
      syncControls();
    });
  }

  // --- events ---
  for (const [key, c] of stickSliders) {
    bindSlider(key, c, (v) => writeOverride(raw, orientation, key, v));
  }
  bindSlider(YAW_SCALE_SLIDER_KEY, yawScaleSlider,
    (v) => writeOverride(raw, orientation, 'yawScaleDeg', v));
  bindSlider(CAMERA_SLIDER_KEY, cameraSlider, (v) => writeCameraOverride(raw, orientation, 'heightScale', v));
  bindSlider(YAW_SLIDER_KEY, yawSlider, (v) => writeCameraOverride(raw, orientation, 'yaw', v));
  bindSlider(VISION_SLIDER_KEY, visionSlider, (v) => writeVisionOverride(raw, orientation, 'dim', v));
  bindSlider(LIGHT_SLIDER_KEY, lightSlider, (v) => writeLightOverride(raw, orientation, 'ambient', v));
  bindSlider(DIRECTIONAL_SLIDER_KEY, dirSlider, (v) => writeLightOverride(raw, orientation, 'directional', v));
  bindSlider(FOG_SLIDER_KEY, fogSlider, (v) => writeFogOverride(raw, orientation, 'density', v));
  bindSlider(TONE_SLIDER_KEY, toneSlider, (v) => writeLookOverride(raw, orientation, 'tone', v));
  bindSlider(VIGNETTE_SLIDER_KEY, vigSlider, (v) => writeLookOverride(raw, orientation, 'vignette', v));
  bindSlider(PIXEL_SLIDER_KEY, pixSlider, (v) => writeLookOverride(raw, orientation, 'pixel', v));

  const resetGroup = (clear: () => void) => () => {
    clear();
    apply();
    syncControls();
    scheduleSave();
  };
  stickGroup.reset.addEventListener('click', resetGroup(() => clearStickOverrides(raw, orientation)));
  cameraGroup.reset.addEventListener('click', resetGroup(() => clearCameraOverrides(raw, orientation)));
  visionGroup.reset.addEventListener('click', resetGroup(() => clearVisionOverrides(raw, orientation)));
  lightGroup.reset.addEventListener('click', resetGroup(() => clearLightOverrides(raw, orientation)));
  fogGroup.reset.addEventListener('click', resetGroup(() => clearFogOverrides(raw, orientation)));
  lookGroup.reset.addEventListener('click', resetGroup(() => clearLookOverrides(raw, orientation)));

  tabs.forEach((tab, i) => tab.addEventListener('click', () => setPage(i)));

  // --- fire button placement: drag the REAL HUD button ----------------------------------------
  // The panel is `inset:0` (z-index 30), so a button underneath it could never be dragged. While the
  // panel is open the button therefore carries `.placing`, which styles.css lifts above the panel
  // (z-index 40); the press is then a placement drag instead of a trigger (`fireButton.ts` ignores
  // presses made while `.placing` is set), so the same gesture cannot mean both things.
  //
  // The pointer is converted to RIGHT/BOTTOM INSETS — the same coordinate system as the stick insets
  // — so the stored value means the same thing in both orientations, and the grab offset is
  // preserved so the button does not jump under the finger.
  const fireEl = opts.fireButton ?? null;
  let fireDrag: { pointerId: number; grabX: number; grabY: number } | null = null;

  function fireDragFrom(clientX: number, clientY: number, grabX: number, grabY: number): void {
    const vp = currentViewport();
    const left = clientX - grabX;
    const top = clientY - grabY;
    // `apply()` re-clamps through `effective()` → `clampLayout`, so dragging into a corner parks the
    // whole button on screen instead of half of it hanging off the edge.
    writeOverride(raw, orientation, 'fireX', vp.width - (left + FIRE_BTN_SIZE_PX));
    writeOverride(raw, orientation, 'fireY', vp.height - (top + FIRE_BTN_SIZE_PX));
    apply();
    scheduleSave();
  }

  if (fireEl) {
    fireEl.addEventListener('pointerdown', (e: Event) => {
      if (!fireEl.classList.contains('placing')) return;   // not in placement mode -> it is the trigger
      const p = e as PointerEvent;
      e.preventDefault();
      e.stopPropagation();
      const r = fireEl.getBoundingClientRect();
      fireDrag = { pointerId: p.pointerId, grabX: p.clientX - r.left, grabY: p.clientY - r.top };
      if (fireEl.setPointerCapture) fireEl.setPointerCapture(p.pointerId);
    });
    fireEl.addEventListener('pointermove', (e: Event) => {
      const p = e as PointerEvent;
      if (!fireDrag || p.pointerId !== fireDrag.pointerId) return;
      e.preventDefault();
      fireDragFrom(p.clientX, p.clientY, fireDrag.grabX, fireDrag.grabY);
    });
    const endFireDrag = (e: Event): void => {
      const p = e as PointerEvent;
      if (!fireDrag || p.pointerId !== fireDrag.pointerId) return;
      fireDrag = null;
      // The position is an override now, so the 操控 reset button's enabled state must follow.
      syncControls();
    };
    fireEl.addEventListener('pointerup', endFireDrag);
    fireEl.addEventListener('pointercancel', endFireDrag);
  }

  function setOpen(next: boolean): void {
    open = next;
    panel.hidden = !next;
    gear.classList.toggle('on', next);
    gear.setAttribute('aria-expanded', String(next));
    // Placement mode is exactly "the panel is open": the button is above the panel and drag-only.
    if (fireEl) {
      fireEl.classList.toggle('placing', next);
      if (!next) fireDrag = null;
    }
    // The LOOK PAD (the right stick) is invisible during play and only becomes visible while the
    // panel is open, so its position can be adjusted against a real outline. The flag lives on
    // <html> next to the layout CSS variables — same owner, same lifetime as the panel.
    document.documentElement.classList.toggle('settings-open', next);
    if (next) {
      syncControls();
    } else {
      void flush();
    }
    opts.onOpenChange?.(next);
  }

  gear.addEventListener('click', () => setOpen(!open));
  closeBtn.addEventListener('click', () => setOpen(false));

  window.addEventListener('resize', refresh);
  const mq = window.matchMedia('(orientation: landscape)');
  mq.addEventListener('change', refresh);

  // --- boot ---
  setPage(0);       // the first tab; the pages exist before the first paint, so nothing jumps
  apply();          // built-in defaults first, so the sticks never render at an unstyled size
  syncControls();
  void (async () => {
    const res = await loadSettings<unknown>(SETTINGS_SCOPE);
    if (res.ok) {
      raw = createState(res.value);
      warn.hidden = true;
      setStatus(res.value === null ? '使用默认值' : '已从服务器加载');
    } else {
      warn.textContent = '未连接服务器，设置无法保存：' + res.error;
      warn.hidden = false;
      setStatus('离线：仅本地生效', true);
    }
    apply();
    syncControls();
  })();

  return {
    refresh,
    open: () => setOpen(true),
    close: () => setOpen(false),
    isOpen: () => open,
  };
}
