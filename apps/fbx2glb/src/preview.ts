/**
 * The preview viewport — the only part of this app that needs WebGL, which means the only part that
 * canNOT be verified in this environment (no browser; see docs/TECHNICAL.md §5). Everything it does
 * is therefore conservative and degrading: if the WebGL context cannot be created, `createPreview`
 * returns null and the app hides the canvas and says 「本设备不支持 WebGL，预览不可用（转换不受影响）」
 * rather than leaving a dead black rectangle.
 *
 * It also shows WHY a preview matters for this app: the whole point of a converter is to find out
 * whether the model is 100x too big, faces the wrong way, or lost its animations — questions a report
 * of numbers can answer only partially, and a picture answers at once.
 */
import * as THREE from 'three';

export interface PreviewHandle {
  /** Show a model (and its clips). Replaces whatever was shown before. */
  setScene(root: any, clips: readonly any[]): void;
  clear(): void;
  /** Clip names currently playable, in file order. */
  clipNames(): string[];
  /** Switch clip (no-op for an unknown name). */
  play(name: string): void;
  /** Name of the clip being played, or null. */
  currentClip(): string | null;
  setPlaying(on: boolean): void;
  isPlaying(): boolean;
  setGrid(on: boolean): void;
  setBones(on: boolean): void;
  setSpeed(v: number): void;
  dispose(): void;
}

/**
 * Build the preview on `canvas`. Returns null when WebGL is unavailable — the caller MUST handle that
 * (it is the app's only hard dependency on a GPU) and must not treat it as an error.
 */
export function createPreview(canvas: HTMLCanvasElement, opts: { onError?: (message: string) => void } = {}): PreviewHandle | null {
  let renderer: any;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  } catch (err) {
    opts.onError?.(err instanceof Error ? err.message : String(err));
    return null;
  }
  renderer.setPixelRatio?.(Math.min(2, globalThis.devicePixelRatio || 1));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x10151c);
  scene.fog = new THREE.Fog(0x10151c, 8, 60);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 5000);
  camera.position.set(2.4, 1.8, 3.2);

  const rootGroup = new THREE.Group();
  scene.add(rootGroup);

  scene.add(new THREE.HemisphereLight(0xdfefff, 0x22303d, 1.1));
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.4);
  keyLight.position.set(3, 6, 4);
  scene.add(keyLight);
  const rimLight = new THREE.DirectionalLight(0x88bbff, 0.5);
  rimLight.position.set(-4, 2, -3);
  scene.add(rimLight);

  const grid = new THREE.GridHelper(10, 20, 0x3d556b, 0x24313d);
  scene.add(grid);

  // ---- state ---------------------------------------------------------------------------------
  let model: any = null;
  let mixer: any = null;
  let helper: any = null;
  let controls: any = null;
  const actions = new Map<string, any>();
  let clipNames: string[] = [];
  let current: string | null = null;
  let playing = true;
  let speed = 1;
  let wantBones = false;
  let raf = 0;
  const clock = new THREE.Clock();

  // OrbitControls: optional. A failure only means the camera cannot be dragged — and the import is
  // asynchronous, so it is attached (and re-targeted) whenever it arrives.
  let controlsTarget: any = null;
  // @ts-ignore - vendored three addon, untyped
  import('../vendor/addons/controls/OrbitControls.js').then((mod: any) => {
    if (!mod?.OrbitControls) return;
    controls = new mod.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 0.05;
    controls.maxDistance = 500;
    if (controlsTarget) { controls.target.copy(controlsTarget); controls.update(); }
  }).catch(() => { /* drag-to-orbit is optional */ });

  function applyBones(): void {
    if (helper) { scene.remove(helper); helper = null; }
    if (!wantBones || !model) return;
    try {
      helper = new THREE.SkeletonHelper(model);
      scene.add(helper);
    } catch { helper = null; }
  }

  /** Point the camera (and the fog, and the grid) at the model that was just loaded. */
  function frameModel(): void {
    if (!model) return;
    const box = new THREE.Box3().setFromObject(model);
    if (!Number.isFinite(box.min.x) || !Number.isFinite(box.max.x)) return;
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const radius = Math.max(size.x, size.y, size.z, 0.1);
    camera.position.set(center.x + radius * 1.3, center.y + radius * 0.9, center.z + radius * 1.7);
    camera.near = Math.max(0.001, radius / 500);
    camera.far = radius * 200;
    camera.updateProjectionMatrix();
    controlsTarget = center.clone();
    if (controls) { controls.target.copy(center); controls.update(); }
    // The fog and the grid are sized to the model: a 180-unit (centimetre) model would otherwise sit
    // entirely inside the fog, and a 0.2-unit prop entirely outside the grid.
    scene.fog.near = radius * 2;
    scene.fog.far = radius * 24;
    grid.scale.setScalar(Math.max(1, radius / 2));
    grid.position.set(center.x, box.min.y, center.z);
  }

  function tick(): void {
    raf = requestAnimationFrame(tick);
    const dt = Math.min(0.1, clock.getDelta());
    if (mixer) mixer.update(dt * speed);
    controls?.update?.();
    renderer.render(scene, camera);
  }
  tick();

  const resize = (): void => {
    const w = Math.max(1, canvas.clientWidth || canvas.width || 1);
    const h = Math.max(1, canvas.clientHeight || canvas.height || 1);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  };
  resize();
  try {
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resize).observe(canvas);
    else globalThis.addEventListener?.('resize', resize);
  } catch { /* a non-resizing preview still renders */ }

  return {
    setScene(root: any, clips: readonly any[]): void {
      if (model) rootGroup.remove(model);
      if (helper) { scene.remove(helper); helper = null; }
      actions.clear();
      mixer = null;
      current = null;
      clipNames = [];
      model = root;
      if (model) rootGroup.add(model);
      if (model) {
        mixer = new THREE.AnimationMixer(model);
        mixer.timeScale = speed;
        // One action per clip, built ONCE (the same discipline as the shooter's spawn path: building
        // actions per frame is what makes a phone stutter).
        (clips ?? []).forEach((clip: any, i: number) => {
          const name = String(clip?.name ?? i);
          clipNames.push(name);
          try {
            const action = mixer.clipAction(clip);
            action.setLoop?.(THREE.LoopRepeat ?? 2201, Infinity);
            actions.set(name, action);
          } catch { /* a clip that cannot be bound is simply not previewable */ }
        });
        const first = clipNames.find((n) => actions.has(n));
        if (first) { current = first; if (playing) actions.get(first)!.play(); }
      }
      applyBones();
      frameModel();
      resize();
    },
    clear(): void {
      this.setScene(null, []);
    },
    clipNames(): string[] { return [...clipNames]; },
    currentClip(): string | null { return current; },
    play(name: string): void {
      const action = actions.get(name);
      if (!action || !mixer) return;
      mixer.stopAllAction();
      current = name;
      action.paused = !playing;
      action.play();
    },
    setPlaying(on: boolean): void {
      playing = on;
      for (const action of actions.values()) {
        action.paused = !on;
        if (on) action.play();
      }
    },
    isPlaying(): boolean { return playing; },
    setGrid(on: boolean): void { grid.visible = on; },
    setBones(on: boolean): void { wantBones = on; applyBones(); },
    setSpeed(v: number): void {
      speed = Number.isFinite(v) && v > 0 ? v : 1;
      if (mixer) mixer.timeScale = speed;
    },
    dispose(): void {
      cancelAnimationFrame(raf);
      try { controls?.dispose?.(); } catch { /* ignore */ }
      renderer.dispose?.();
    },
  };
}
