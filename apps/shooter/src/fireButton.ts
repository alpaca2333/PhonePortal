// Hold-to-fire wiring for the standalone FIRE button.
//
// WHY A SEPARATE MODULE: firing is the one control whose state is CONTINUOUS (held = shoot every
// frame) rather than a discrete action, so it cannot reuse `weaponButton.ts::bindActionButton` —
// that one activates once per `pointerdown` and has no notion of a release. Keeping this a leaf
// (no imports, no three, no game.ts) is what lets `scripts/verify-panel.mjs` drive it through the
// DOM shim, exactly like the other buttons.
//
// WHY `pointerdown`/`pointerup` AND NOT `click`: the same real-device reason as weaponButton.ts — with
// the left stick already holding a pointer capture, a second finger's tap frequently never becomes a
// `click` at all. On top of that, firing must START on press and STOP on release, which a `click`
// cannot express.
//
// POINTER CAPTURE: the press captures the pointer, so a finger that drifts off the circle keeps
// firing (the button stays the target of every move/up). Without it, a small slip would release the
// trigger mid-burst, which reads as a dropped input rather than as a feature.
//
// THE STUCK-TRIGGER CASE: a pointer can be lost — `pointercancel` when the OS takes the gesture over,
// or the settings panel opening while the finger is down. Either would leave the player firing
// forever, so `reset()` exists and `main.ts` calls it whenever the game pauses.
export interface FireButtonHandle {
  /** True while the button is held. Sampled once per frame by `input.ts`. */
  isHeld(): boolean;
  /** Force the trigger up (pause, panel open, restart). */
  reset(): void;
  /** The element itself, so callers (the settings panel's drag) do not look it up a second time. */
  readonly element: HTMLElement;
  /** Observe held-state changes — used to mirror it into `Input`. */
  onChange(cb: (held: boolean) => void): void;
}

export function bindFireButton(button: HTMLElement): FireButtonHandle {
  let held = false;
  const listeners: Array<(held: boolean) => void> = [];

  const set = (next: boolean): void => {
    if (held === next) return;
    held = next;
    button.classList.toggle('on', held);
    for (const cb of listeners) cb(held);
  };

  button.addEventListener('pointerdown', (e: Event) => {
    // While the settings panel is open the button is its DRAG HANDLE (see settingsPanel.ts), not the
    // trigger: the panel owns the press. The game is paused then anyway, but this keeps the two
    // gestures from both claiming the same pointer.
    if (button.classList.contains('placing')) return;
    // Stop the press reaching the canvas (its own pointerdown starts a yaw drag — see input.ts).
    e.stopPropagation();
    set(true);
    const p = e as PointerEvent;
    if (typeof p.pointerId === 'number' && button.setPointerCapture) button.setPointerCapture(p.pointerId);
  });
  button.addEventListener('pointerup', () => set(false));
  button.addEventListener('pointercancel', () => set(false));

  // Keyboard activation (Enter/Space), so the control is usable without a pointer. `preventDefault`
  // on keydown stops Space from scrolling and from re-activating on keyup.
  const isActivation = (e: Event): boolean => {
    const k = e as KeyboardEvent;
    return k.code === 'Enter' || k.code === 'Space' || k.key === 'Enter' || k.key === ' ';
  };
  button.addEventListener('keydown', (e: Event) => {
    if (!isActivation(e)) return;
    e.preventDefault();
    set(true);
  });
  button.addEventListener('keyup', (e: Event) => {
    if (isActivation(e)) set(false);
  });

  return {
    isHeld: () => held,
    reset: () => set(false),
    element: button,
    onChange: (cb) => { listeners.push(cb); },
  };
}
