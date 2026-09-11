import { GameSim } from './src/game.js';
import { GameRenderer } from './src/render.js';
import { Input } from './src/input.js';
import { loadCharTemplate, loadPropGeometries } from './src/assets.js';
import { createSettingsPanel } from './src/settingsPanel.js';
import { createInventoryPanel } from './src/inventoryPanel.js';
import { bindActionButton } from './src/weaponButton.js';
import { createDiag } from './src/diag.js';
import { PLAYER_CHARACTER, ENEMY_CHARACTER } from './src/characters.js';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const sim = new GameSim();
const renderer = new GameRenderer(sim, canvas);
const input = new Input(
  document.getElementById('stickL') as HTMLElement,
  document.getElementById('stickR') as HTMLElement,
  canvas,
);

// Two overlays can pause the simulation: the settings panel and the backpack. They are independent
// flags combined into one predicate — assigning a single `paused` variable from both callbacks was
// how one panel closing would resume the game while the other was still open.
let settingsOpen = false;
let inventoryOpen = false;
const paused = (): boolean => settingsOpen || inventoryOpen;

// Settings (摇杆 size/position via CSS variables, 摄像机高度 / 视野遮挡变暗 / 光照 / 高度雾 / 调色 via
// the renderer) live on the server. The panel owns the DOM and calls back; this file only reacts:
// freeze the simulation while the panel is open, and forward the renderer values.
createSettingsPanel({
  onOpenChange: (open) => { settingsOpen = open; },
  onCameraChange: (heightScale) => { renderer.setCameraHeightScale(heightScale); },
  // 「摄像机水平角度」: the renderer poses the camera with it, and the input layer maps the sticks
  // through it — both consumers get the SAME number here, which is what keeps "push up on the stick"
  // meaning "away from the camera" at any angle (see camera.ts::screenToWorld).
  onCameraYawChange: (yaw) => { renderer.setCameraYaw(yaw); input.setCameraYaw(yaw); },
  // 0 means "vision off" — GameRenderer.setVisionDim then hides the overlay and skips all gating.
  onVisionChange: (dim) => { renderer.setVisionDim(dim); },
  // Light multipliers (see lighting.ts): ambient ships OFF; the directional one scales both
  // directional lights together (0 = ambient only, 1 = the sun as it has always shipped).
  onLightChange: (scale) => { renderer.setAmbientScale(scale); },
  onDirectionalChange: (scale) => { renderer.setDirectionalScale(scale); },
  // Height fog: 0 is the off switch (the shader mix becomes a no-op) — see fog.ts / toon.ts.
  onFogChange: (density) => { renderer.setFogDensity(density); },
  // 调色: the grade is a uniform (0 = ungraded), the vignette a camera-child card (0 = hidden).
  onLookChange: ({ tone, vignette, pixel }) => {
    renderer.setGradeStrength(tone);
    renderer.setVignetteStrength(vignette);
    // The pixelation block (CSS px); 0 disables the post pass and releases its render target.
    renderer.setPixelBlock(pixel);
  },
});

// ---------------------------------------------------------------------------------------------
// Backpack
// ---------------------------------------------------------------------------------------------
// The panel owns its DOM and NEVER mutates the inventory: every drop goes through `sim.moveItem()`,
// so the type rules and the "which weapon is equipped / how full is its magazine" bookkeeping have
// exactly one implementation. Its changes are reflected in the HUD by the renderer on the next
// frame (which keeps running while the sim is paused).
const inventoryPanel = createInventoryPanel({
  stage: document.getElementById('stage') as HTMLElement,
  // A GETTER, not `sim.inventory`: reset() replaces the object with a fresh loadout, and a captured
  // reference would leave the panel rendering (and validating drops against) the previous run.
  getInventory: () => sim.inventory,
  onMove: (from, to) => sim.moveItem(from, to),
  onOpenChange: (open) => { inventoryOpen = open; },
});

const overlay = document.getElementById('overlay') as HTMLElement;
const finalEl = document.getElementById('final') as HTMLElement;
const restartBtn = document.getElementById('restart') as HTMLButtonElement;

// Weapon switching: the HUD button (and desktop `Q`) trades the PRIMARY and SECONDARY slots and
// nothing else — the throwable and healing slots have their own buttons. The sim owns the state
// (`switchWeapon()` keeps each weapon's own magazine); this file only decides WHEN.
// The choice is deliberately NOT persisted (see apps/shooter/README.md) — a page reload starts on
// the default loadout again.
// The button is wired in ./src/weaponButton.ts (pointerdown, not click — see that file for why a
// tap with a second finger while a stick is held never produced a click).
const weaponBtn = document.getElementById('weaponBtn') as HTMLButtonElement;
bindActionButton(weaponBtn, () => {
  if (paused()) return;
  sim.switchWeapon();
});

// Throwable / healing: used straight from their on-screen buttons (hidden by the renderer while the
// slot is empty). The sim defers the actual use to the next frame so the throw can follow the aim
// direction that frame resolves — see GameSim.requestUse.
const throwBtn = document.getElementById('throwBtn') as HTMLButtonElement;
const healBtn = document.getElementById('healBtn') as HTMLButtonElement;
bindActionButton(throwBtn, () => { if (!paused()) sim.requestUse('throwable'); });
bindActionButton(healBtn, () => { if (!paused()) sim.requestUse('healing'); });

// Desktop convenience (same handlers as the buttons). Not routed through input.ts: these are all
// discrete actions, not per-frame input state.
window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (e.code === 'KeyQ') { if (!paused()) sim.switchWeapon(); }
  else if (e.code === 'KeyG') { if (!paused()) sim.requestUse('throwable'); }
  else if (e.code === 'KeyH') { if (!paused()) sim.requestUse('healing'); }
  else if (e.code === 'KeyB') inventoryPanel.toggle();
});

// Kick off async asset loading. Both halves degrade instead of failing:
//   * the ARENA PROPS are the room itself (floor, walls, cover, decorations) — loaded first, and a
//     failure falls back to the instanced-box cover so the arena is ugly but still PLAYABLE;
//   * the CHARACTERS fall back to primitives, as they always have.
// `assetsLoading` is read by the hitch profiler: a stall while this is true is (usually) a .glb being
// fetched + parsed + merged on the main thread, which is a different diagnosis from a GC pause.
let assetsLoading = true;
async function bootAssets(): Promise<void> {
  try {
    const geoms = await loadPropGeometries(renderer.propFiles());
    renderer.setProps(geoms);
    console.log('[shooter] arena props loaded (' + geoms.size + ' kinds)');
  } catch (err) {
    console.warn('[shooter] prop load failed; falling back to box cover', err);
    renderer.setProps(new Map());
  }
  try {
    // The two characters (file + clip mapping + strip list) live in src/characters.ts — one record
    // per character, validated at load and asserted against the shipped .glb by verify-characters.
    const [player, enemy] = await Promise.all([
      loadCharTemplate(PLAYER_CHARACTER),
      loadCharTemplate(ENEMY_CHARACTER),
    ]);
    renderer.setAssets(player, enemy);
    console.log('[shooter] GLB characters loaded (player + enemy)');
  } catch (err) {
    console.warn('[shooter] GLB load failed; using primitives', err);
  }
  assetsLoading = false;
}
bootAssets();

// ---------------------------------------------------------------------------------------------
// Hitch profiler — OFF unless the URL asks for it (`?diag=1`), see src/diagcore.ts + src/diag.ts.
// A phone has no DevTools console, so this is how "突然卡半秒" gets attributed on the device that
// actually stutters: per-frame phase timings, heap deltas (GC), three's program count (shader
// compile), long tasks, and the entity counts that say what the game was doing.
// ---------------------------------------------------------------------------------------------
const diag = createDiag({
  info: () => renderer.debugInfo(),
  // …plus the render-resolution chain (viewport → dpr → 「像素化」块 → 渲染 texel 数 → 世界/CSSpx), which
  // is what turns 「横屏比竖屏糊」 from an impression into two comparable numbers on the device itself.
  resolution: () => renderer.debugResolution(),
  counts: () => ({
    enemies: sim.enemies.length,
    bullets: sim.bullets.length,
    particles: sim.particles.length,
    loading: assetsLoading,
  }),
});
if (diag.enabled) {
  (window as any).__SHOOTER_DIAG__ = diag;
  console.log('[shooter/diag] 已开启：点右上角读数看卡顿明细，或 __SHOOTER_DIAG__.report() / .json()');
}
// The always-available snapshot (skill playbook shape): cheap reads, no per-frame cost.
(window as any).__THREE_GAME_DIAGNOSTICS__ = {
  info: () => renderer.debugInfo(),
  get state() {
    return {
      wave: sim.wave, score: sim.score, over: sim.over,
      enemies: sim.enemies.length, alive: sim.enemies.filter((e) => e.alive).length,
      bullets: sim.bullets.length, particles: sim.particles.length,
      loading: assetsLoading,
    };
  },
};

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  diag.beginFrame(now);
  if (!sim.over && !paused()) {
    diag.begin('sim');
    sim.update(dt, input.sample());
    diag.end('sim');
  }
  diag.begin('sync');
  renderer.sync(dt);
  diag.end('sync');
  diag.begin('render');
  renderer.render();
  diag.end('render');
  diag.endFrame();
  if (sim.over && overlay.classList.contains('hidden')) {
    finalEl.textContent = '得分 ' + sim.score + ' · 撑到第 ' + sim.wave + ' 波';
    overlay.classList.remove('hidden');
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

restartBtn.addEventListener('click', () => {
  sim.reset();
  renderer.reset();
  // reset() REPLACES sim.inventory with a fresh loadout, so the panel must re-read it. That re-read
  // works because the panel holds the getter, not the object — see the note in its options.
  inventoryPanel.refresh();
  overlay.classList.add('hidden');
});
