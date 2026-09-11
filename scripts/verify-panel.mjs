/**
 * CPU-side smoke test for the shooter settings panel's DOM wiring.
 *
 * There is no browser in this environment, so the *feel* of the panel (drag, scroll, hit targets)
 * can only be confirmed on a device. What CAN be proven here is that the built panel is wired up
 * correctly: it creates all six groups (操控 / 画面 / 视野 / 光照 / 雾 / 后期) as six PAGES with a tab
 * strip, the right number of sliders with the right limits, applies server overrides to the DOM,
 * pushes the camera height, camera yaw, vision, both light, fog and look values to their renderer
 * callbacks, and that each group's 「恢复默认」 clears ONLY its own group.
 *
 * The full-screen/paginated STRUCTURE is asserted twice over: once on the built DOM (fixed header
 * with the ✕ first, fixed tabs, exactly one visible page, the body as the only scrolling region) and
 * once on styles.css as text (the panel really is `inset:0`, the landscape media query no longer
 * shrinks the panel's type, the two-column stick page exists). The *feel* of those choices — safe
 * areas, thumb-sized drag targets — is a real-device question, as always.
 * It also pins the HUD weapon
 * button's DOM contract (src/weaponButton.ts): pointerdown-driven, no click listener, keyboard
 * activation on Enter/Space.
 *
 * How: a ~40-line DOM shim (createElement / getElementById / matchMedia / fetch / timers) is
 * installed on globalThis before importing dist/apps/shooter/src/settingsPanel.js. The shim records
 * every element and every listener, so the test can inspect the tree and dispatch events.
 *
 * Run:  npm run build && node scripts/verify-panel.mjs
 * Exit code is non-zero when any assertion fails.
 */
import { readFileSync } from 'node:fs';

const PANEL = new URL('../dist/apps/shooter/src/settingsPanel.js', import.meta.url);

// ---------------------------------------------------------------- DOM shim
const nodes = [];
function mkEl(tag) {
  const node = {
    tag,
    className: '', textContent: '', type: '', title: '', hidden: false, disabled: false,
    dataset: {}, children: [], listeners: {},
    style: { props: {}, setProperty(k, v) { this.props[k] = v; } },
    setAttribute(k, v) { this[k] = v; },
    classList: {
      set: new Set(),
      toggle(c, on) { on ? this.set.add(c) : this.set.delete(c); },
      contains(c) { return this.set.has(c); },
    },
    append(...kids) { for (const k of kids) this.children.push(k); },
    addEventListener(ev, fn) { (this.listeners[ev] ??= []).push(fn); },
    // `extra` lets a test pass a fake event payload (code/key/stopPropagation/...)
    dispatch(ev, extra) { for (const fn of this.listeners[ev] ?? []) fn({ target: this, ...extra }); },
  };
  nodes.push(node);
  return node;
}
const stage = mkEl('div');
globalThis.document = {
  createElement: mkEl,
  // only 'stage' is looked up by the panel; anything else gets a throwaway stub
  getElementById: (id) => (id === 'stage' ? stage : mkEl('div')),
  documentElement: { style: { props: {}, setProperty(k, v) { this.props[k] = v; } } },
};
globalThis.window = {
  innerWidth: 800, innerHeight: 400,           // landscape viewport
  matchMedia: () => ({ addEventListener() {} }),
  addEventListener() {},
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};
// Pretend the server already holds one override per group, so the merge path is exercised.
// `vision.dim: 0.3` is a SPARSE override of the 0.55 default — the panel must show the overridden
// value, and 「恢复默认」 must put it back to 0.55 rather than to 0.
// The two light keys are readouts anchored to different references: the ambient one is a percent of
// the PRE-SETTING 1.05 (0.6 x 0.14 = 0.084 -> 8%), the directional one a percent of the shipped sun
// (0.5 -> 50%). 3 -> 40% is the value the ambient shipped with for one round, so it is the most
// meaningful thing to assert on (see lighting.ts / verify-stick).
const SERVER = {
  scope: 'shooter',
  value: {
    camera: { landscape: { heightScale: 1.5, yaw: -45 } },
    stick: { landscape: { sizePx: 56 } },
    vision: { landscape: { dim: 0.3 } },
    light: { landscape: { ambient: 3, directional: 0.5 } },
    fog: { landscape: { density: 0.03 } },
    look: { landscape: { tone: 0.5, vignette: 1, pixel: 4 } },
  },
};
globalThis.fetch = async () => ({ ok: true, json: async () => SERVER });

// ---------------------------------------------------------------- run the panel
const { createSettingsPanel } = await import(PANEL.href);

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail ? ' — ' + detail : ''));
}

const cameraPushes = [];
const yawPushes = [];
const visionPushes = [];
const lightPushes = [];
const dirPushes = [];
const fogPushes = [];
const lookPushes = [];
createSettingsPanel({
  onOpenChange: () => {},
  onCameraChange: (s) => cameraPushes.push(s),
  onCameraYawChange: (y) => yawPushes.push(y),
  onVisionChange: (dim) => visionPushes.push(dim),
  onLightChange: (scale) => lightPushes.push(scale),
  onDirectionalChange: (scale) => dirPushes.push(scale),
  onFogChange: (density) => fogPushes.push(density),
  onLookChange: (look) => lookPushes.push(look),
});
await new Promise((r) => setTimeout(r, 30));   // let the boot loadSettings() settle

const groups = nodes.filter((n) => n.className === 'set-group');
const rows = nodes.filter((n) => n.className === 'set-row');
const ranges = nodes.filter((n) => n.className === 'set-range');
const resets = nodes.filter((n) => n.className.includes('set-group-reset'));
const camRange = ranges.find((r) => r.dataset.key === 'heightScale');
const camRow = rows.find((r) => r.children[1] === camRange);
const camOut = camRow && camRow.children[2];
const yawRange = ranges.find((r) => r.dataset.key === 'yaw');
const yawRow = rows.find((r) => r.children[1] === yawRange);
const yawOut = yawRow && yawRow.children[2];
const visRange = ranges.find((r) => r.dataset.key === 'dim');
const visRow = rows.find((r) => r.children[1] === visRange);
const visOut = visRow && visRow.children[2];
const lightRange = ranges.find((r) => r.dataset.key === 'ambient');
const lightRow = rows.find((r) => r.children[1] === lightRange);
const lightOut = lightRow && lightRow.children[2];
const dirRange = ranges.find((r) => r.dataset.key === 'directional');
const dirRow = rows.find((r) => r.children[1] === dirRange);
const dirOut = dirRow && dirRow.children[2];
const fogRange = ranges.find((r) => r.dataset.key === 'density');
const fogRow = rows.find((r) => r.children[1] === fogRange);
const fogOut = fogRow && fogRow.children[2];
const toneRange = ranges.find((r) => r.dataset.key === 'tone');
const toneRow = rows.find((r) => r.children[1] === toneRange);
const toneOut = toneRow && toneRow.children[2];
const vigRange = ranges.find((r) => r.dataset.key === 'vignette');
const vigRow = rows.find((r) => r.children[1] === vigRange);
const vigOut = vigRow && vigRow.children[2];
const pixRange = ranges.find((r) => r.dataset.key === 'pixel');
const pixRow = rows.find((r) => r.children[1] === pixRange);
const pixOut = pixRow && pixRow.children[2];
const stickVars = document.documentElement.style.props;

check('six group headers in order (操控, 画面, 视野, 光照, 雾, 后期)',
  groups.length === 6 && groups[0].children[0].textContent === '操控'
  && groups[1].children[0].textContent === '画面' && groups[2].children[0].textContent === '视野'
  && groups[3].children[0].textContent === '光照' && groups[4].children[0].textContent === '雾'
  && groups[5].children[0].textContent === '后期',
  groups.map((g) => g.children[0]?.textContent).join(','));
check('fourteen slider rows (5 stick + camera height + camera yaw + vision + 2 light + fog + tone + '
  + 'vignette + pixel)', rows.length === 14, String(rows.length));
check('fourteen range inputs', ranges.length === 14, String(ranges.length));
check('one 恢复默认 button per group', resets.length === 6);
check('camera slider limits = 0.4 / 3 / 0.05',
  camRange.min === '0.4' && camRange.max === '3' && camRange.step === '0.05',
  `${camRange.min}/${camRange.max}/${camRange.step}`);
check('camera slider thumb reflects the server override (1.5)', camRange.value === '1.5', camRange.value);
check('camera readout formats as 1.50×', camOut && camOut.textContent === '1.50×', camOut && camOut.textContent);
check('boot applies the reference framing first, then the server value',
  cameraPushes[0] === 1 && cameraPushes.includes(1.5), JSON.stringify(cameraPushes));
check('yaw slider limits = -180 / 180 / 15 (25 positions, 0 = the shipped view)',
  yawRange.min === '-180' && yawRange.max === '180' && yawRange.step === '15',
  `${yawRange.min}/${yawRange.max}/${yawRange.step}`);
check('yaw slider thumb reflects the server override (-45) and the readout is a signed angle',
  yawRange.value === '-45' && yawOut.textContent === '-45°',
  `${yawRange.value} / ${yawOut && yawOut.textContent}`);
check('boot pushes the yaw default (0) first, then the server value',
  yawPushes[0] === 0 && yawPushes.includes(-45), JSON.stringify(yawPushes));
check('vision slider limits = 0 / 0.85 / 0.05',
  visRange.min === '0' && visRange.max === '0.85' && visRange.step === '0.05',
  `${visRange.min}/${visRange.max}/${visRange.step}`);
check('vision slider thumb reflects the server override (0.3)', visRange.value === '0.3', visRange.value);
check('vision readout formats as a percentage', visOut && visOut.textContent === '30%',
  visOut && visOut.textContent);
check('boot pushes the vision default first, then the server value',
  visionPushes[0] === 0.55 && visionPushes.includes(0.3), JSON.stringify(visionPushes));
check('ambient slider limits = 0 / 7.5 (derived) / 0.05',
  lightRange.min === '0' && lightRange.max === '7.5' && lightRange.step === '0.05',
  `${lightRange.min}/${lightRange.max}/${lightRange.step}`);
check('ambient slider thumb reflects the server override (3)', lightRange.value === '3', lightRange.value);
check('ambient readout is a percent of the pre-setting light (40%)',
  lightOut && lightOut.textContent === '40%', lightOut && lightOut.textContent);
check('boot pushes the ambient default (0 = off) first, then the server value',
  lightPushes[0] === 0 && lightPushes.includes(3), JSON.stringify(lightPushes));
check('directional slider limits = 0 / 2 / 0.05',
  dirRange.min === '0' && dirRange.max === '2' && dirRange.step === '0.05',
  `${dirRange.min}/${dirRange.max}/${dirRange.step}`);
check('directional slider thumb reflects the server override (0.5)', dirRange.value === '0.5', dirRange.value);
check('directional readout is a percent of the shipped sun (50%)',
  dirOut && dirOut.textContent === '50%', dirOut && dirOut.textContent);
check('boot pushes the directional default (1 = shipped sun) first, then the server value',
  dirPushes[0] === 1 && dirPushes.includes(0.5), JSON.stringify(dirPushes));
check('fog slider limits = 0 / 0.06 / 0.002',
  fogRange.min === '0' && fogRange.max === '0.06' && fogRange.step === '0.002',
  `${fogRange.min}/${fogRange.max}/${fogRange.step}`);
check('fog slider thumb reflects the server override (0.03)', fogRange.value === '0.03', fogRange.value);
check('fog readout is a percent of the max density (50%)',
  fogOut && fogOut.textContent === '50%', fogOut && fogOut.textContent);
check('boot pushes the fog default (0.016) first, then the server value',
  fogPushes[0] === 0.016 && fogPushes.includes(0.03), JSON.stringify(fogPushes));
check('tone slider limits = 0 / 2 / 0.05 and vignette = 0 / 1.5 / 0.05',
  toneRange.min === '0' && toneRange.max === '2' && toneRange.step === '0.05'
  && vigRange.min === '0' && vigRange.max === '1.5' && vigRange.step === '0.05',
  `${toneRange.min}/${toneRange.max} ${vigRange.min}/${vigRange.max}`);
check('look sliders reflect the server override (tone 0.5 -> 50%, vignette 1 -> 100%)',
  toneRange.value === '0.5' && toneOut.textContent === '50%'
  && vigRange.value === '1' && vigOut.textContent === '100%',
  `${toneRange.value}/${toneOut.textContent} ${vigRange.value}/${vigOut.textContent}`);
check('boot pushes the look defaults (tone 1, vignette 0.7, pixel 2) first, then the server values',
  lookPushes[0].tone === 1 && lookPushes[0].vignette === 0.7 && lookPushes[0].pixel === 2
  && lookPushes.some((l) => l.tone === 0.5 && l.vignette === 1 && l.pixel === 4),
  JSON.stringify(lookPushes.slice(0, 3)));
check('pixel slider limits = 0 / 6 / 1 and the readout shows the block in px',
  pixRange.min === '0' && pixRange.max === '6' && pixRange.step === '1'
  && pixRange.value === '4' && pixOut.textContent === '4 px',
  `${pixRange.min}/${pixRange.max}/${pixRange.step} ${pixRange.value} ${pixOut.textContent}`);
check('stick CSS variables written (size + 4 insets)',
  ['--stick-size', '--stick-lx', '--stick-ly', '--stick-rx', '--stick-ry'].every((k) => k in stickVars),
  JSON.stringify(stickVars));
check('server stick override applied (56px)', stickVars['--stick-size'] === '56px', stickVars['--stick-size']);

// 操控 reset must clear ONLY the stick group
resets[0].dispatch('click');
check('操控 reset -> stick back to the landscape default (72px), camera untouched (1.5)',
  stickVars['--stick-size'] === '72px' && cameraPushes.at(-1) === 1.5,
  `${stickVars['--stick-size']} / ${cameraPushes.at(-1)}`);

// dragging the camera slider must reach the renderer callback immediately
camRange.value = '1.4';
camRange.dispatch('input');
check('camera slider drag -> onCameraChange(1.4)', cameraPushes.at(-1) === 1.4, String(cameraPushes.at(-1)));

// dragging the yaw slider reaches the renderer callback immediately, and the sign is formatted
yawRange.value = '90';
yawRange.dispatch('input');
check('yaw slider drag -> onCameraYawChange(90) with a + sign in the readout',
  yawPushes.at(-1) === 90 && yawOut.textContent === '+90°',
  `${yawPushes.at(-1)} / ${yawOut.textContent}`);

// 画面 reset must clear BOTH camera keys (one group, one button) and nothing else
resets[1].dispatch('click');
check('画面 reset -> camera height back to 1.0 AND yaw back to 0°',
  cameraPushes.at(-1) === 1 && yawPushes.at(-1) === 0 && yawOut.textContent === '0°',
  `${cameraPushes.at(-1)} / ${yawPushes.at(-1)} / ${yawOut.textContent}`);
check('画面 reset leaves the vision value alone (0.3)', visionPushes.at(-1) === 0.3,
  String(visionPushes.at(-1)));

// dragging the vision slider must reach the renderer callback immediately
visRange.value = '0.7';
visRange.dispatch('input');
check('vision slider drag -> onVisionChange(0.7)', visionPushes.at(-1) === 0.7,
  String(visionPushes.at(-1)));
check('vision readout follows the drag (70%)', visOut.textContent === '70%', visOut.textContent);

// 0 is the OFF switch, and it must read as「关闭」 rather than as "0%"
visRange.value = '0';
visRange.dispatch('input');
check('vision slider at 0 -> onVisionChange(0) and readout「关闭」',
  visionPushes.at(-1) === 0 && visOut.textContent === '关闭',
  `${visionPushes.at(-1)} / ${visOut.textContent}`);

// 视野 reset must clear ONLY the vision group
resets[2].dispatch('click');
check('视野 reset -> darkness back to the built-in 0.55 default', visionPushes.at(-1) === 0.55,
  String(visionPushes.at(-1)));
check('…and it left the stick and camera values untouched',
  stickVars['--stick-size'] === '72px' && cameraPushes.at(-1) === 1,
  `${stickVars['--stick-size']} / ${cameraPushes.at(-1)}`);
check('…and the ambient value alone (3), directional untouched (0.5)',
  lightPushes.at(-1) === 3 && dirPushes.at(-1) === 0.5,
  `${lightPushes.at(-1)} / ${dirPushes.at(-1)}`);

// dragging the ambient slider must reach the renderer callback immediately
lightRange.value = '0.75';
lightRange.dispatch('input');
check('ambient slider drag -> onLightChange(0.75)', lightPushes.at(-1) === 0.75,
  String(lightPushes.at(-1)));
check('ambient readout follows the drag (0.75 x 0.14 / 1.05 = 10%)', lightOut.textContent === '10%',
  lightOut.textContent);

// dragging the directional slider must reach the renderer callback immediately
dirRange.value = '1.5';
dirRange.dispatch('input');
check('directional slider drag -> onDirectionalChange(1.5)', dirPushes.at(-1) === 1.5,
  String(dirPushes.at(-1)));
check('directional readout follows the drag (150%)', dirOut.textContent === '150%', dirOut.textContent);

// 0 ambient is a legal look (directional lights only), NOT the「关闭」 wording used by 遮挡变暗
lightRange.value = '0';
lightRange.dispatch('input');
check('ambient slider at 0 -> onLightChange(0) and a numeric readout, not 「关闭」',
  lightPushes.at(-1) === 0 && lightOut.textContent === '0%',
  `${lightPushes.at(-1)} / ${lightOut.textContent}`);

// dragging the fog slider must reach the renderer callback immediately
fogRange.value = '0.012';
fogRange.dispatch('input');
check('fog slider drag -> onFogChange(0.012)', fogPushes.at(-1) === 0.012, String(fogPushes.at(-1)));
check('fog readout follows the drag (20%)', fogOut.textContent === '20%', fogOut.textContent);

// 0 is a real off switch here, so it reads as 「关闭」 (unlike the two light sliders)
fogRange.value = '0';
fogRange.dispatch('input');
check('fog slider at 0 -> onFogChange(0) and the readout says 「关闭」',
  fogPushes.at(-1) === 0 && fogOut.textContent === '关闭',
  `${fogPushes.at(-1)} / ${fogOut.textContent}`);

// dragging either look slider must reach the renderer callback immediately
toneRange.value = '1.5';
toneRange.dispatch('input');
check('tone slider drag -> onLookChange({tone 1.5, vignette 1})',
  lookPushes.at(-1).tone === 1.5 && lookPushes.at(-1).vignette === 1,
  JSON.stringify(lookPushes.at(-1)));
check('tone readout follows the drag (150%)', toneOut.textContent === '150%', toneOut.textContent);
vigRange.value = '0.2';
vigRange.dispatch('input');
check('vignette slider drag -> onLookChange uses only the new vignette',
  lookPushes.at(-1).tone === 1.5 && lookPushes.at(-1).vignette === 0.2,
  JSON.stringify(lookPushes.at(-1)));
check('vignette readout follows the drag (20%)', vigOut.textContent === '20%', vigOut.textContent);
// the pixel slider drags through to the callback, and 0 is the off switch
pixRange.value = '3';
pixRange.dispatch('input');
check('pixel slider drag -> onLookChange carries pixel 3 with the current tone/vignette',
  lookPushes.at(-1).pixel === 3 && lookPushes.at(-1).tone === 1.5 && lookPushes.at(-1).vignette === 0.2
  && pixOut.textContent === '3 px', JSON.stringify(lookPushes.at(-1)));
pixRange.value = '0';
pixRange.dispatch('input');
check('pixel at 0 -> readout 「关闭」 (the whole post pass is off)',
  lookPushes.at(-1).pixel === 0 && pixOut.textContent === '关闭',
  `${lookPushes.at(-1).pixel} / ${pixOut.textContent}`);

// 0 for either key is the "unprocessed" switch and reads as 「关闭」.
toneRange.value = '0';
toneRange.dispatch('input');
check('tone at 0 -> readout 「关闭」 (the grade is exactly off)', lookPushes.at(-1).tone === 0
  && toneOut.textContent === '关闭', `${lookPushes.at(-1).tone} / ${toneOut.textContent}`);

// 光照 reset must clear BOTH light keys (one group, one 「恢复默认」) and nothing else
resets[3].dispatch('click');
check('光照 reset -> ambient back to the built-in 0 (0% = off)', lightPushes.at(-1) === 0,
  String(lightPushes.at(-1)));
check('光照 reset -> directional back to the built-in 1 (100%)', dirPushes.at(-1) === 1,
  String(dirPushes.at(-1)));
check('…and it left the stick, camera, vision, fog and look values untouched',
  stickVars['--stick-size'] === '72px' && cameraPushes.at(-1) === 1 && visionPushes.at(-1) === 0.55
  && fogPushes.at(-1) === 0 && lookPushes.at(-1).tone === 0,
  `${stickVars['--stick-size']} / ${cameraPushes.at(-1)} / ${visionPushes.at(-1)} / ${fogPushes.at(-1)} / ${JSON.stringify(lookPushes.at(-1))}`);

// 调色 reset must clear ONLY the look group (both keys, one button)
resets[5].dispatch('click');   // 后期
check('后期 reset -> tone 1, vignette 0.7 and pixel back to the shipped 2',
  lookPushes.at(-1).tone === 1 && lookPushes.at(-1).vignette === 0.7 && lookPushes.at(-1).pixel === 2,
  JSON.stringify(lookPushes.at(-1)));
check('…and it left the stick, camera, vision, light and fog values untouched',
  stickVars['--stick-size'] === '72px' && cameraPushes.at(-1) === 1 && visionPushes.at(-1) === 0.55
  // the fog was dragged to 0 earlier in this test and the look reset must not touch it
  && lightPushes.at(-1) === 0 && dirPushes.at(-1) === 1 && fogPushes.at(-1) === 0,
  `${stickVars['--stick-size']} / ${cameraPushes.at(-1)} / ${visionPushes.at(-1)} / ${lightPushes.at(-1)} / ${fogPushes.at(-1)}`);

// 雾 reset must clear ONLY the fog group
resets[4].dispatch('click');
check('雾 reset -> density back to the built-in 0.016 (27%)', fogPushes.at(-1) === 0.016,
  String(fogPushes.at(-1)));
check('…and it left the stick, camera, vision and both light values untouched',
  stickVars['--stick-size'] === '72px' && cameraPushes.at(-1) === 1 && visionPushes.at(-1) === 0.55
  && lightPushes.at(-1) === 0 && dirPushes.at(-1) === 1,
  `${stickVars['--stick-size']} / ${cameraPushes.at(-1)} / ${visionPushes.at(-1)} / ${lightPushes.at(-1)} / ${dirPushes.at(-1)}`);

// ---------------------------------------------------------------- the panel STRUCTURE
// Full screen + one page per group + a ✕ that cannot scroll away: the three things the user asked
// for, asserted on the built tree (the *look* of them is a device question).
{
  const panelNode = nodes.find((n) => n.className === 'settings-panel');
  const headNode = nodes.find((n) => n.className === 'set-head');
  const tabBarNode = nodes.find((n) => n.className === 'set-tabs');
  const bodyNode = nodes.find((n) => n.className === 'set-body');
  const pageNodes = nodes.filter((n) => n.className === 'set-page');
  const tabNodes = nodes.filter((n) => n.className === 'set-tab');

  check('the panel is a fixed header + fixed tabs + ONE scrolling body, in that order',
    panelNode && panelNode.children.length === 3
    && panelNode.children[0] === headNode && panelNode.children[1] === tabBarNode
    && panelNode.children[2] === bodyNode,
    panelNode && panelNode.children.map((c) => c.className).join(','));
  check('the ✕ is the FIRST child of the header (top-left) and the save status is in the header too',
    headNode.children[0] === nodes.find((n) => n.className === 'set-close')
    && headNode.children.some((c) => c.className === 'set-status')
    && !panelNode.children.some((c) => c.className === 'set-foot'),
    headNode.children.map((c) => c.className).join(','));
  check('six pages, one per group, named 操控/画面/视野/光照/雾/后期',
    pageNodes.length === 6
    && pageNodes.map((p) => p.dataset.page).join(',') === 'stick,camera,vision,light,fog,look',
    pageNodes.map((p) => p.dataset.page).join(','));
  check('six tabs, one per page, carrying the page id',
    tabNodes.length === 6
    && tabNodes.map((t) => t.dataset.page).join(',') === 'stick,camera,vision,light,fog,look',
    tabNodes.map((t) => t.dataset.page).join(','));
  check('every page lives inside the scrolling body (hint/warn first)',
    pageNodes.every((p) => bodyNode.children.includes(p))
    && bodyNode.children[0].className === 'set-hint'
    && bodyNode.children[1].className === 'set-warn');
  check('exactly ONE page is visible on boot and it is the first one',
    pageNodes.filter((p) => !p.hidden).length === 1 && pageNodes[0].hidden === false);
  check('the visible page starts selected in the tab strip',
    tabNodes[0].classList.contains('on') && tabNodes[0]['aria-selected'] === 'true'
    && !tabNodes[1].classList.contains('on'));

  // switching pages: click a tab, and only that page is shown / selected
  tabNodes[3].dispatch('click');
  check('clicking a tab switches to that page and un-hides ONLY it',
    pageNodes[3].hidden === false && pageNodes.filter((p) => !p.hidden).length === 1
    && tabNodes[3]['aria-selected'] === 'true' && tabNodes[0]['aria-selected'] === 'false',
    `${pageNodes.map((p) => (p.hidden ? '.' : 'X')).join('')} / ${tabNodes.map((t) => (t.classList.contains('on') ? 'X' : '.')).join('')}`);
  // …and the controls of the hidden pages are untouched: the 操控 sliders still work
  const stickRange = ranges.find((r) => r.dataset.key === 'sizePx');
  stickRange.value = '60';
  stickRange.dispatch('input');
  check('a hidden page\'s slider still applies (the pages are hidden, not unmounted)',
    stickVars['--stick-size'] === '60px', stickVars['--stick-size']);
  tabNodes[0].dispatch('click');

  // 操控 is the two-per-row page
  const stickRows = nodes.find((n) => n.className === 'set-rows two-col');
  check('the 操控 page\'s rows container is the two-column one, the others are not',
    stickRows !== undefined
    && stickRows.children.filter((c) => c.className === 'set-row').length === 5
    && nodes.filter((n) => n.className === 'set-rows').length === 5,
    String(nodes.filter((n) => n.className === 'set-rows').length));
}

// ---------------------------------------------------------------- the panel CSS (structure is data)
// These are the parts of the request that CSS owns; without an assertion a later `max-height` or a
// re-added landscape override would silently undo them.
{
  const css = readFileSync(new URL('../apps/shooter/styles.css', import.meta.url), 'utf8');
  const rule = (sel) => {
    const i = css.indexOf(sel + '{');
    return i === -1 ? '' : css.slice(i + sel.length + 1, css.indexOf('}', i));
  };
  // Comments stripped: the block carries a comment that NAMES the rules it deliberately omits.
  const cssRules = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const landscape = (() => {
    const i = cssRules.indexOf('@media (orientation:landscape){');
    if (i === -1) return '';
    let d = 0;
    for (let k = i; k < cssRules.length; k++) {
      if (cssRules[k] === '{') d++;
      else if (cssRules[k] === '}' && --d === 0) return cssRules.slice(i, k + 1);
    }
    return '';
  })();
  check('the settings panel fills the screen and hides properly when closed',
    /inset:0/.test(rule('.settings-panel'))
    && /display:flex/.test(rule('.settings-panel'))
    && /display:none/.test(rule('.settings-panel[hidden]')),
    rule('.settings-panel').slice(0, 60));
  check('…with the body as the only scrolling region and the header/tabs pinned above it',
    /overflow-y:auto/.test(rule('.set-body')) && /flex:1/.test(rule('.set-body'))
    && /flex:none/.test(rule('.set-head')) && /flex:none/.test(rule('.set-tabs')));
  check('the two-column stick page is a real 2-column grid and its rows stack the label above the range',
    /grid-template-columns:repeat\(2/.test(rule('.set-rows.two-col'))
    && /grid-template-areas:"name name" "range val"/.test(rule('.set-rows.two-col .set-row')),
    rule('.set-rows.two-col').slice(0, 60));
  check('landscape no longer shrinks the settings panel\'s typography (or its box) — the fonts are the '
    + 'same in both orientations',
    landscape.length > 0 && !/\.settings-panel|\.set-(head|title|badge|close|hint|warn|group|row|name|range|val|reset|status|body|tab)/.test(landscape),
    landscape.slice(0, 40));
}

// ---------------------------------------------------------------- weapon button wiring
// The button lives in main.ts (which imports the renderer, so it cannot be loaded here), but its
// DOM contract is a leaf module: pointerdown for pointers (a second finger while a stick is held
// never produced a click), keydown for the keyboard, and deliberately NO click listener.
{
  const { bindWeaponSwitch } = await import(new URL('../dist/apps/shooter/src/weaponButton.js', import.meta.url).href);
  const btn = mkEl('button');
  let cycles = 0;
  bindWeaponSwitch(btn, () => { cycles++; });
  const bound = Object.keys(btn.listeners);

  check('weapon button binds pointerdown + keydown and NOT click',
    bound.includes('pointerdown') && bound.includes('keydown') && !bound.includes('click'),
    bound.join(','));

  let stopped = false;
  btn.dispatch('pointerdown', { stopPropagation: () => { stopped = true; } });
  check('pointerdown switches immediately (no click synthesis needed) and stops propagation',
    cycles === 1 && stopped, `cycles=${cycles} stopped=${stopped}`);

  btn.dispatch('pointerdown', { stopPropagation() {} });
  check('a second tap (second finger, stick held) switches again', cycles === 2, String(cycles));

  btn.dispatch('click');
  check('a synthesised click cannot double-switch (no click listener)', cycles === 2, String(cycles));

  btn.dispatch('keydown', { code: 'Enter', key: 'Enter', preventDefault() {} });
  check('Enter activates once', cycles === 3, String(cycles));

  let prevented = false;
  btn.dispatch('keydown', { code: 'Space', key: ' ', preventDefault: () => { prevented = true; } });
  check('Space activates once and preventDefaults (no page scroll)', cycles === 4 && prevented,
    `cycles=${cycles} prevented=${prevented}`);

  btn.dispatch('keydown', { code: 'KeyA', key: 'a', preventDefault() {} });
  check('other keys do nothing', cycles === 4, String(cycles));
}

// ---------------------------------------------------------------- report
console.log('verify-panel: ' + passed + ' checks passed, ' + failures.length + ' failed');
for (const f of failures) console.error('  FAIL ' + f);
if (failures.length) process.exit(1);
