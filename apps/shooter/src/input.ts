// Twin-stick input: left joystick = move, right joystick = aim + fire.
// Also supports WASD + mouse as a desktop fallback (handy for testing).
//
// SCREEN SPACE vs WORLD SPACE: every source below (both sticks, WASD, the mouse offset) is sampled in
// SCREEN space — `+x` right, `+y` down — and the sim consumes `InputState.move/aim` as WORLD XZ. At
// camera yaw 0 those two happen to coincide (the camera looks down +Z), which is why the mapping used
// to be the identity. With the 「摄像机水平角度」 setting they do not, so all four sources go through
// `camera.ts::screenToWorld` at the END of `sample()` — this module is the screen/world boundary, and
// keeping the mapping here is what lets the simulation stay view-agnostic (and its trace unchanged).
import { Vec2, v2, clampLen } from './math2.js';
import { travelForSize, stickOffset, dirFromOffset, isManualAim } from './stick.js';
import { screenToWorld } from './camera.js';
import type { InputState } from './game.js';

class Joystick {
  private el: HTMLElement;
  private knob: HTMLElement;
  private pid = -1;
  private cx = 0; private cy = 0;
  private travel = 40; // px, re-measured from the element's rendered size (size is a setting)
  private offset: Vec2 = v2(0, 0);
  active = false;

  constructor(el: HTMLElement) {
    this.el = el;
    this.knob = el.querySelector('.knob') as HTMLElement;
    this.el.addEventListener('pointerdown', this.onDown.bind(this));
    this.el.addEventListener('pointermove', this.onMove.bind(this));
    this.el.addEventListener('pointerup', this.onUp.bind(this));
    this.el.addEventListener('pointercancel', this.onUp.bind(this));
  }

  /**
   * Re-read the element's box. Called on every pointer event, not just on pointer-down: the
   * settings panel can resize or move a stick while a finger is already down (multi-touch), and
   * a stale centre/travel would make the stick jump. The element never moves because of the drag
   * itself (the pointer is captured), so this is a no-op in normal play.
   */
  private measure(): void {
    const r = this.el.getBoundingClientRect();
    this.cx = r.left + r.width / 2;
    this.cy = r.top + r.height / 2;
    this.travel = travelForSize(r.width);
  }

  private onDown(e: PointerEvent): void {
    if (this.pid !== -1) return;
    e.preventDefault();
    this.pid = e.pointerId;
    this.el.setPointerCapture(e.pointerId);
    this.active = true;
    this.measure();
    this.setOff(e.clientX, e.clientY);
  }
  private onMove(e: PointerEvent): void {
    if (e.pointerId !== this.pid) return;
    e.preventDefault();
    this.measure();
    this.setOff(e.clientX, e.clientY);
  }
  private onUp(e: PointerEvent): void {
    if (e.pointerId !== this.pid) return;
    this.pid = -1; this.active = false;
    this.offset = v2(0, 0);
    this.knob.style.transform = 'translate(-50%,-50%)';
  }
  private setOff(dx: number, dy: number): void {
    const o = stickOffset(this.cx, this.cy, dx, dy, this.travel);
    this.offset = o;
    this.knob.style.transform = 'translate(calc(-50% + ' + o.x + 'px), calc(-50% + ' + o.y + 'px))';
  }
  dir(): Vec2 { return dirFromOffset(this.offset, this.travel); }
}

export class Input {
  private stickL: Joystick;
  private stickR: Joystick;
  private canvas: HTMLCanvasElement;
  private keys = new Set<string>();
  private mouse: Vec2 = v2(0, 0);
  private mouseDown = false;
  /** 「摄像机水平角度」 in degrees (see camera.ts); 0 = the shipped view, i.e. the identity mapping. */
  private camYaw = 0;

  constructor(stickLEl: HTMLElement, stickREl: HTMLElement, canvas: HTMLCanvasElement) {
    this.stickL = new Joystick(stickLEl);
    this.stickR = new Joystick(stickREl);
    this.canvas = canvas;
    window.addEventListener('keydown', e => { this.keys.add(e.code); });
    window.addEventListener('keyup', e => { this.keys.delete(e.code); });
    this.canvas.addEventListener('pointermove', e => {
      const r = this.canvas.getBoundingClientRect();
      this.mouse = v2(e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2);
    });
    this.canvas.addEventListener('pointerdown', e => { e.preventDefault(); this.mouseDown = true; });
    // A touch/pen drag on the canvas would otherwise leave `mouse` pointing at the last finger
    // position forever, so `sample()` keeps reporting an aim direction long after the finger is
    // gone — and game.ts then believes the player is still aiming (that is what froze the facing
    // while walking). Clear it on lift/cancel. A real mouse keeps its hover position, because
    // desktop aiming is positional and must survive a button release.
    const endPointer = (e: PointerEvent): void => {
      this.mouseDown = false;
      if (e.pointerType !== 'mouse') this.mouse = v2(0, 0);
    };
    window.addEventListener('pointerup', endPointer);
    window.addEventListener('pointercancel', endPointer);
  }

  /** Set by main.ts from the settings panel (same value the renderer poses the camera with). */
  setCameraYaw(deg: number): void {
    this.camYaw = deg;
  }

  sample(): InputState {
    let move: Vec2;
    if (this.stickL.active) {
      move = clampLen(this.stickL.dir(), 1);
    } else {
      move = clampLen(v2(
        (this.keys.has('KeyD') || this.keys.has('ArrowRight') ? 1 : 0) - (this.keys.has('KeyA') || this.keys.has('ArrowLeft') ? 1 : 0),
        (this.keys.has('KeyS') || this.keys.has('ArrowDown') ? 1 : 0) - (this.keys.has('KeyW') || this.keys.has('ArrowUp') ? 1 : 0),
      ), 1);
    }

    // Right stick: holding it always fires. Pushing past the deadzone (stick.ts::AIM_DEADZONE,
    // currently 0.6 of the travel) aims manually; holding it closer to the centre asks the sim
    // for auto-aim (nearest enemy). The threshold lives in the pure stick module so it is
    // asserted in scripts/verify-stick.mjs instead of being an untestable literal here.
    let aim: Vec2; let firing: boolean; let autoAim = false;
    if (this.stickR.active) {
      const d = clampLen(this.stickR.dir(), 1);
      const pushed = isManualAim(d);
      aim = pushed ? d : v2(0, 0);
      firing = true;
      autoAim = !pushed;
    } else {
      aim = clampLen(this.mouse, 1);
      firing = this.mouseDown && Math.hypot(this.mouse.x, this.mouse.y) > 12;
    }

    // Screen -> world LAST, so every source above is written in the axes the player sees (and the
    // keyboard fallback keeps matching the sticks). `screenToWorld` is the identity at yaw 0.
    const wMove = screenToWorld(move, this.camYaw);
    const wAim = screenToWorld(aim, this.camYaw);
    return { move: v2(wMove.x, wMove.z), aim: v2(wAim.x, wAim.z), firing, autoAim };
  }
}
