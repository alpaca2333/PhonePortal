// Tap-to-activate wiring for the HUD's discrete action buttons: the weapon-slot switch, the
// throwable and the healing slot. Deliberately a leaf module (no imports, no three, no game.ts) so
// the DOM contract can be asserted in Node with the DOM shim in scripts/verify-panel.mjs — main.ts
// itself imports the renderer and cannot be loaded there.
//
// WHY `pointerdown` AND NOT `click`: `click` is synthesised by the browser's gesture recogniser.
// On touch screens a tap with a SECOND finger (the first one is already held on a joystick, and
// `input.ts` has called `setPointerCapture()` on that stick element) is frequently not turned into
// a `click` at all — the reported symptom was exactly "holding a stick, tapping the weapon button
// does nothing". `pointerdown` is dispatched per pointer, immediately, and needs no synthesis.
//
// WHY NOT BOTH `pointerdown` AND `click`: on mouse (and on touch screens that DO synthesise a
// click) both events arrive for one tap, which would activate twice per tap. De-duplicating them
// needs a timer/flag; handling pointer for pointers and keys for the keyboard instead makes a
// double-fire structurally impossible. Keyboard activation (Enter/Space on the focused button)
// is handled explicitly, so the controls stay reachable without a pointer.
//
// ONE IMPLEMENTATION FOR ALL THREE BUTTONS: they are all "a discrete action fired by a tap", and
// having two copies of this reasoning is how one of them silently drifts back to `click`.
export function bindActionButton(button: HTMLElement, onActivate: () => void): void {
  button.addEventListener('pointerdown', (e: Event) => {
    // Stop the press from reaching anything behind the HUD (the canvas' pointerdown arms mouse
    // aiming) — the button is its own control.
    e.stopPropagation();
    onActivate();
  });

  button.addEventListener('keydown', (e: Event) => {
    const k = e as KeyboardEvent;
    if (k.code === 'Enter' || k.code === 'Space' || k.key === 'Enter' || k.key === ' ') {
      k.preventDefault();   // Space would otherwise scroll / re-activate on keyup
      onActivate();
    }
  });
}

/** The weapon-slot switch is just another action button; kept as a named export for its callers. */
export function bindWeaponSwitch(button: HTMLElement, onCycle: () => void): void {
  bindActionButton(button, onCycle);
}
