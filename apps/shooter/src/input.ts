// Touch controls: left joystick = move, right LOOK PAD = CAMERA YAW, plus a standalone FIRE button.
// Also supports WASD + a pointer drag as a desktop fallback (handy for testing).
//
// THE RIGHT CONTROL IS NOT AN AIM STICK AND NOT A JOYSTICK. It is a large transparent rectangle with
// exactly one usable axis (horizontal) and one job: turning the camera. It also has NO BALL — see
// `StickOrigin` in stick.ts: the finger's LANDING POINT is the zero, so pressing anywhere in the pad
// starts from a reading of 0 instead of from wherever that point happens to sit relative to the
// rectangle's centre (that centre-origin version made the view snap on every touch).
// Pressing captures the yaw at that moment (camera.ts::stickYawTarget) and dragging moves the view
// relative to that anchor; releasing FREEZES the angle where it was.
// Two consequences that the rest of the app depends on:
//
//   1. The player ALWAYS faces the camera's forward direction. `sample()` reports that direction as
//      `aim` (literally screen-up mapped onto the ground), and game.ts assigns it to `aimAngle`
//      unconditionally. There is no "facing follows the movement" case any more, and no auto-aim in
//      the live input: the FIRE button shoots where the camera looks.
//   2. Everything screen-shaped goes through `screenToWorld` — so the yaw must be updated BEFORE the
//      move/aim vectors are mapped. That ordering is the whole reason the yaw lives at the top of
//      `sample()`.
//
// The desktop fallback already worked this way (a drag is measured from where the button went down),
// so the pad and the mouse now share one behaviour: the gesture is always relative.
//
// SCREEN SPACE vs WORLD SPACE: every source below is sampled in SCREEN space — `+x` right, `+y` down
// — and the sim consumes `InputState.move/aim` as WORLD XZ. `camera.ts::screenToWorld` is that
// boundary, applied once, here, which is what keeps the simulation view-agnostic (and its trace
// unchanged by camera work).
import { Vec2, v2, clampLen } from './math2.js';
import { PRESS_TRAVEL_PX, travelForSize, stickOffset, dirFromOffset, axisLockOffset } from './stick.js';
import type { StickAxis, StickOrigin } from './stick.js';
import {
  YAW_SCALE_DEFAULT, clampYawScale, lookYawFromPixels, screenToWorld, stickYawTarget,
} from './camera.js';
import type { InputState } from './game.js';

class Joystick {
  private el: HTMLElement;
  /** Absent on the look pad: there is no ball to move (see the header). */
  private knob: HTMLElement | null;
  private pid = -1;
  /** The active origin in viewport px: the element's centre, or the press point ('press' mode). */
  private ox = 0; private oy = 0;
  private travel = 40; // px
  private offset: Vec2 = v2(0, 0);
  private axis: StickAxis;
  private origin: StickOrigin;
  active = false;

  constructor(el: HTMLElement, axis: StickAxis = 'both', origin: StickOrigin = 'centre') {
    this.el = el;
    this.axis = axis;
    this.origin = origin;
    // `null` on the look pad — a missing knob must not break the control, it just means the
    // reading has no visual to drive.
    this.knob = el.querySelector('.knob');
    this.el.addEventListener('pointerdown', this.onDown.bind(this));
    this.el.addEventListener('pointermove', this.onMove.bind(this));
    this.el.addEventListener('pointerup', this.onUp.bind(this));
    this.el.addEventListener('pointercancel', this.onUp.bind(this));
  }

  /**
   * Re-read the element's box. Called on every pointer event in FIXED-BASE mode, not just on
   * pointer-down: the settings panel can resize or move a stick while a finger is already down
   * (multi-touch), and a stale centre/travel would make the stick jump. The element never moves
   * because of the drag itself (the pointer is captured), so this is a no-op in normal play.
   */
  private measure(): void {
    const r = this.el.getBoundingClientRect();
    this.ox = r.left + r.width / 2;
    this.oy = r.top + r.height / 2;
    this.travel = travelForSize(r.width);
  }

  private onDown(e: PointerEvent): void {
    if (this.pid !== -1) return;
    e.preventDefault();
    this.pid = e.pointerId;
    this.el.setPointerCapture(e.pointerId);
    this.active = true;
    if (this.origin === 'press') {
      // THE PRESS POINT IS THE ZERO. Not the element's centre: the pad is a big transparent
      // rectangle, and a centre origin meant every touch started at a large offset — the view
      // snapped on press before the finger moved (「每次按右边区域都会有朝向跳变」).
      this.ox = e.clientX;
      this.oy = e.clientY;
      this.travel = PRESS_TRAVEL_PX;
    } else {
      this.measure();
    }
    this.setOff(e.clientX, e.clientY);   // 'press' mode: exactly (0,0) on the frame you land
  }
  private onMove(e: PointerEvent): void {
    if (e.pointerId !== this.pid) return;
    e.preventDefault();
    // A fixed-base stick re-measures (the panel may have resized it mid-drag); a press-anchored one
    // must NOT — its origin is wherever the finger landed, and re-measuring would move it.
    if (this.origin === 'centre') this.measure();
    this.setOff(e.clientX, e.clientY);
  }
  private onUp(e: PointerEvent): void {
    if (e.pointerId !== this.pid) return;
    this.pid = -1; this.active = false;
    this.offset = v2(0, 0);
    if (this.knob) this.knob.style.transform = 'translate(-50%,-50%)';
  }
  private setOff(dx: number, dy: number): void {
    // `axisLockOffset` keeps the look pad on the horizontal axis it actually reads — see stick.ts.
    const o = axisLockOffset(stickOffset(this.ox, this.oy, dx, dy, this.travel), this.axis);
    this.offset = o;
    if (this.knob) {
      this.knob.style.transform = 'translate(calc(-50% + ' + o.x + 'px), calc(-50% + ' + o.y + 'px))';
    }
  }
  dir(): Vec2 { return dirFromOffset(this.offset, this.travel); }
}

export class Input {
  private stickL: Joystick;
  private stickR: Joystick;
  private canvas: HTMLCanvasElement;
  private keys = new Set<string>();
  /** FIRE button state, mirrored from ./fireButton.ts (hold = shoot). */
  private fireHeld = false;
  /**
   * Live camera yaw in degrees. Seeded from the 「摄像机水平角度」 setting (the RESTING angle) and
   * moved by the right stick. NOT persisted: only the resting angle and the sensitivity are
   * settings, because writing the server on every stick frame would be absurd — see apps/shooter/README.md.
   */
  private camYaw = 0;
  /** 「摄像机灵敏度」: yaw degrees at full stick deflection (see camera.ts). */
  private yawScale = YAW_SCALE_DEFAULT;
  /** Yaw captured when the right stick went down — the anchor of the current gesture. */
  private yawAnchor = 0;
  /** Desktop fallback: a pointer drag on the canvas turns the view (no right stick on a keyboard). */
  private yawDragPid = -1;
  private yawDragStartX = 0;
  private yawDragStartYaw = 0;

  constructor(stickLEl: HTMLElement, stickREl: HTMLElement, canvas: HTMLCanvasElement) {
    this.stickL = new Joystick(stickLEl, 'both');
    // Right = the LOOK PAD: horizontal only, and PRESS-ANCHORED (the finger's landing point is the
    // zero, so entering the pad cannot move the view by itself).
    this.stickR = new Joystick(stickREl, 'x', 'press');
    this.canvas = canvas;
    // The anchor is captured on the press itself, in a listener of our own rather than inside
    // Joystick: the anchor is a CAMERA concept, and Joystick stays a generic geometry widget.
    stickREl.addEventListener('pointerdown', () => { this.yawAnchor = this.camYaw; });
    window.addEventListener('keydown', e => { this.keys.add(e.code); });
    window.addEventListener('keyup', e => { this.keys.delete(e.code); });

    // Desktop look: horizontal drag on the canvas. It replaced the old "mouse position = aim
    // direction" mapping, which cannot survive "the character always faces the camera forward" —
    // there would be two competing notions of where the gun points.
    canvas.addEventListener('pointerdown', (e: PointerEvent) => {
      if (this.yawDragPid !== -1) return;
      e.preventDefault();
      this.yawDragPid = e.pointerId;
      if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
      this.yawDragStartX = e.clientX;
      this.yawDragStartYaw = this.camYaw;
    });
    canvas.addEventListener('pointermove', (e: PointerEvent) => {
      if (e.pointerId !== this.yawDragPid) return;
      // Same sign rule as the pad (see camera.ts::lookYawFromPixels): dragging right turns right.
      this.camYaw = lookYawFromPixels(this.yawDragStartYaw, e.clientX - this.yawDragStartX);
    });
    const endYawDrag = (e: PointerEvent): void => {
      if (e.pointerId === this.yawDragPid) this.yawDragPid = -1;
    };
    canvas.addEventListener('pointerup', endYawDrag);
    canvas.addEventListener('pointercancel', endYawDrag);
  }

  /** Set the RESTING yaw (the 「摄像机水平角度」 slider). The stick then moves relative to it. */
  setCameraYaw(deg: number): void {
    this.camYaw = Number.isFinite(deg) ? deg : 0;
  }

  /** The yaw actually in use this frame — `main.ts` pushes it to the renderer every frame. */
  cameraYaw(): number {
    return this.camYaw;
  }

  /** 「摄像机灵敏度」 from the settings panel. */
  setYawScale(deg: number): void {
    this.yawScale = clampYawScale(deg);
  }

  /** FIRE button held state, mirrored from ./fireButton.ts. */
  setFireHeld(held: boolean): void {
    this.fireHeld = held;
  }

  sample(): InputState {
    // --- the camera first: everything downstream is expressed in the axes the player SEES ---------
    if (this.stickR.active) {
      this.camYaw = stickYawTarget(this.yawAnchor, this.stickR.dir().x, this.yawScale);
    }

    let move: Vec2;
    if (this.stickL.active) {
      move = clampLen(this.stickL.dir(), 1);
    } else {
      move = clampLen(v2(
        (this.keys.has('KeyD') || this.keys.has('ArrowRight') ? 1 : 0) - (this.keys.has('KeyA') || this.keys.has('ArrowLeft') ? 1 : 0),
        (this.keys.has('KeyS') || this.keys.has('ArrowDown') ? 1 : 0) - (this.keys.has('KeyW') || this.keys.has('ArrowUp') ? 1 : 0),
      ), 1);
    }

    // `aim` is the camera's FORWARD direction on the ground: screen-up mapped through the yaw. The
    // character faces it unconditionally (game.ts) and the FIRE button shoots along it, so "where I
    // look", "where I face" and "where the bullets go" are one vector by construction.
    const fwd = screenToWorld({ x: 0, y: -1 }, this.camYaw);
    const aim = v2(fwd.x, fwd.z);

    // `autoAim` is CONSTANT TRUE: the touch scheme wants the aim assist, and the SIM decides when it
    // applies (while the trigger is held, and only for a visible enemy within
    // CONFIG.autoAimConeDeg of the camera direction — see game.ts). Which target, and whether there
    // is one at all, is a game rule, so it stays in the simulation where it can be asserted.
    const firing = this.fireHeld || this.keys.has('KeyF');

    // Screen -> world LAST for movement, so the keyboard fallback keeps matching the stick.
    const wMove = screenToWorld(move, this.camYaw);
    return { move: v2(wMove.x, wMove.z), aim, firing, autoAim: true };
  }
}
