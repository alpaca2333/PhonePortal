// The backpack UI: five equipment slots + a 20-cell bag, driven entirely by inventory.ts's model.
//
// OWNERSHIP: this module owns the DOM (a bag button, the panel, the drag ghost) the same way
// settingsPanel.ts owns the gear button and its panel. It NEVER mutates the inventory itself — every
// drop goes through `opts.onMove(from, to)`, which main.ts wires to `sim.moveItem()`. That is what
// keeps validation, the derived "which weapon is equipped" state and the magazine bookkeeping in one
// place (the sim), and lets a rejected drop simply snap back.
// It also never CACHES the model: the inventory arrives through `getInventory()` because a restart
// swaps the object (see the option's doc comment).
//
// DRAG AND DROP IS POINTER-BASED, NOT HTML5 DnD: the HTML5 drag events do not exist on touch
// devices at all, and this app is touch-first. `pointerdown` on a cell starts a session, the ghost
// follows the finger, and `pointerup` resolves the drop target with `document.elementFromPoint()`
// (the ghost sets `pointer-events:none`, so it never blocks the hit test).
// NOTE: the hit element is a cell's CHILD most of the time — see refUnder() below, which is where the
// "only a small area counts as a drop target" bug lived.
//
// TAP-TO-MOVE IS THE SAME SESSION: if the pointer barely moved, the tap SELECTS the source instead
// of dragging, and the next tap on a target completes the move. Dragging a cell onto a small target
// with a thumb is genuinely awkward, and this costs almost nothing to support.
import { levelColorHex, NO_LEVEL_COLOR } from './armor.js';
import {
  BACKPACK_SIZE, SLOT_IDS, SLOT_LABELS, canMove, getItem, itemCount, itemLabel, itemLevel,
  itemShort, usedCells,
} from './inventory.js';
import type { Inventory, ItemRef, SlotId } from './inventory.js';
import type { Item } from './items.js';

/** Movement (px) below which a pointer sequence counts as a tap (select) rather than a drag. */
const TAP_SLOP = 8;

export interface InventoryPanelOptions {
  /** Element the button/panel/ghost are appended to (`#stage`). */
  stage: HTMLElement;
  /**
   * The live model, read through a GETTER and NEVER written by this module.
   *
   * ⚠️ It must be a getter, not an object: `GameSim.reset()` REPLACES `sim.inventory` with a fresh
   * loadout, so a captured reference goes stale the moment the player restarts. That is exactly the
   * reported bug ("重新开始之后背包还是旧数据，而且无法拖动"): the panel kept painting — and, worse,
   * validating drops against — the dead inventory while `sim.moveItem()` mutated the new one, so the
   * display froze and a legal drag silently did nothing (or moved something else). Reading the current
   * object at every use makes the panel immune to any future swap.
   */
  getInventory: () => Inventory;
  /**
   * Commit a move. Return false to reject it (the panel then leaves everything as it was). Wired to
   * `sim.moveItem()`, so all the type rules and the magazine bookkeeping run there.
   */
  onMove: (from: ItemRef, to: ItemRef) => boolean;
  /** Open/close notifications, so the caller can pause the simulation. */
  onOpenChange?: (open: boolean) => void;
}

export interface InventoryPanel {
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  /** Re-read the model into the DOM (call after anything else changed the inventory). */
  refresh(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** `data-ref` -> ItemRef. The ONLY place the DOM ref encoding is decoded. */
function parseRef(raw: string | undefined): ItemRef | null {
  if (!raw) return null;
  const i = raw.indexOf(':');
  if (i < 0) return null;
  const where = raw.slice(0, i);
  const value = raw.slice(i + 1);
  if (where === 'slot') {
    return (SLOT_IDS as readonly string[]).includes(value) ? { where: 'slot', slot: value as SlotId } : null;
  }
  if (where === 'bag') {
    const index = Number(value);
    return Number.isInteger(index) && index >= 0 && index < BACKPACK_SIZE ? { where: 'bag', index } : null;
  }
  return null;
}

function encodeRef(ref: ItemRef): string {
  return ref.where === 'slot' ? 'slot:' + ref.slot : 'bag:' + ref.index;
}

function sameRef(a: ItemRef | null, b: ItemRef | null): boolean {
  if (!a || !b || a.where !== b.where) return false;
  return a.where === 'slot'
    ? (b as { where: 'slot'; slot: SlotId }).slot === a.slot
    : (b as { where: 'bag'; index: number }).index === a.index;
}

export function createInventoryPanel(opts: InventoryPanelOptions): InventoryPanel {
  const { stage, getInventory, onMove, onOpenChange } = opts;

  let open = false;
  /** Tap-to-move source (armed by a tap on a filled cell, cleared by the next tap or a drag). */
  let selected: ItemRef | null = null;
  let drag: { from: ItemRef; pointerId: number; startX: number; startY: number; moved: boolean } | null = null;
  let hot: ItemRef | null = null;   // cell currently highlighted as a drop target

  // ------------------------------------------------------------------ DOM skeleton
  const btn = el('button', 'inv-btn');
  btn.type = 'button';
  btn.title = '背包（B）';
  btn.textContent = '🎒';

  const panel = el('div', 'inv-panel hidden');
  const head = el('div', 'inv-head');
  const title = el('span', 'inv-title', '背包');
  const badge = el('span', 'inv-badge');
  const closeBtn = el('button', 'inv-close', '✕');
  closeBtn.type = 'button';
  head.append(title, badge, closeBtn);

  /** Every cell node, keyed by its encoded ref, so refresh() is a straight lookup. */
  const cells = new Map<string, HTMLElement>();
  const parts = new Map<string, { lv: HTMLElement; nm: HTMLElement; ct: HTMLElement }>();

  const slotsWrap = el('div', 'inv-slots');
  for (const slot of SLOT_IDS) {
    const cell = el('div', 'inv-cell inv-slotcell');
    const key = encodeRef({ where: 'slot', slot });
    cell.dataset.ref = key;
    const cap = el('span', 'inv-cap', SLOT_LABELS[slot]);
    const lv = el('span', 'inv-lv');
    const nm = el('span', 'inv-nm');
    const ct = el('span', 'inv-ct');
    cell.append(lv, nm, ct);
    const box = el('div', 'inv-slotbox');
    box.append(cell, cap);
    slotsWrap.append(box);
    cells.set(key, cell);
    parts.set(key, { lv, nm, ct });
  }

  const bagWrap = el('div', 'inv-bagwrap');
  const bagCap = el('span', 'inv-sec', '背包');
  const grid = el('div', 'inv-grid');
  for (let i = 0; i < BACKPACK_SIZE; i++) {
    const cell = el('div', 'inv-cell');
    const key = encodeRef({ where: 'bag', index: i });
    cell.dataset.ref = key;
    const lv = el('span', 'inv-lv');
    const nm = el('span', 'inv-nm');
    const ct = el('span', 'inv-ct');
    cell.append(lv, nm, ct);
    grid.append(cell);
    cells.set(key, cell);
    parts.set(key, { lv, nm, ct });
  }
  bagWrap.append(bagCap, grid);

  const foot = el('div', 'inv-foot', '拖动或用「点一下来源、再点一下目标」移动物品；只有对应类型能放进槽位');
  panel.append(head, slotsWrap, bagWrap, foot);

  const ghost = el('div', 'inv-ghost hidden');

  stage.append(btn, panel, ghost);

  // ------------------------------------------------------------------ rendering
  function paintCell(cell: HTMLElement, item: Item | null): void {
    const p = parts.get(cell.dataset.ref ?? '');
    if (!p) return;
    cell.classList.toggle('empty', !item);
    const lv = item ? itemLevel(item) : null;
    // Level badge is the shared 1..6 colour; items without a level (melee, healing, and anything
    // with no ammo) get the neutral colour so they never look like a level-2 green item.
    cell.style.setProperty('--lv', lv === null ? NO_LEVEL_COLOR : levelColorHex(lv));
    if (!item) {
      p.lv.textContent = '';
      p.nm.textContent = '';
      p.ct.textContent = '';
      return;
    }
    p.lv.textContent = lv === null ? '' : 'Lv' + lv;
    p.nm.textContent = itemShort(item);
    const count = itemCount(item);
    p.ct.textContent = count !== null
      ? '×' + count
      : (item.kind === 'weapon' && item.primed ? String(item.ammo) : '');
  }

  function refresh(): void {
    const inventory = getInventory();   // always the CURRENT model, never a captured one
    for (const slot of SLOT_IDS) {
      const ref = encodeRef({ where: 'slot', slot });
      const cell = cells.get(ref);
      if (cell) paintCell(cell, inventory.slots[slot]);
    }
    for (let i = 0; i < BACKPACK_SIZE; i++) {
      const cell = cells.get(encodeRef({ where: 'bag', index: i }));
      if (cell) paintCell(cell, inventory.bag[i] ?? null);
    }
    badge.textContent = usedCells(inventory) + '/' + BACKPACK_SIZE;
    // A selection armed before the model was swapped (a restart) can point at a cell that is empty
    // now. Drop it here, where the new model is already in hand: keeping it would leave a highlighted
    // cell that can never complete a move (canMove() on an empty source is false).
    if (selected && !getItem(inventory, selected)) selected = null;
    // Re-apply the selection / drop-target highlights (they survive a refresh).
    for (const [ref, cell] of cells) {
      cell.classList.toggle('sel', sameRef(parseRef(ref), selected));
      cell.classList.toggle('hot', sameRef(parseRef(ref), hot));
    }
  }

  function setHot(ref: ItemRef | null): void {
    if (sameRef(hot, ref)) return;
    hot = ref;
    for (const [key, cell] of cells) cell.classList.toggle('hot', sameRef(parseRef(key), hot));
  }

  function setSelected(ref: ItemRef | null): void {
    selected = ref;
    for (const [key, cell] of cells) cell.classList.toggle('sel', sameRef(parseRef(key), selected));
  }

  // ------------------------------------------------------------------ open / close
  function setOpen(next: boolean): void {
    if (open === next) return;
    open = next;
    panel.classList.toggle('hidden', !open);
    btn.classList.toggle('on', open);
    setSelected(null);
    setHot(null);
    if (open) refresh();
    if (onOpenChange) onOpenChange(open);
  }

  // ------------------------------------------------------------------ drag / tap
  /**
   * Resolve the pointer position to an ItemRef, by walking UP from the hit element to the nearest
   * element carrying `data-ref`.
   *
   * ⚠️ WHY THE WALK IS REQUIRED (real-device feedback: 「拖到另一个物品上判定不稳，只有一点点区域被
   * 判定为拖到」): the element under the finger is normally NOT the cell. A filled cell stacks three
   * spans (`.inv-lv` / `.inv-nm` / `.inv-ct`) that cover most of its area, so `elementFromPoint`
   * returns whichever span the finger is over — and reading `dataset.ref` off that span finds nothing.
   * The drop then only registered on the thin padding/border ring around the text (and always worked
   * on EMPTY cells, whose spans are zero-size). Reading the ref from the nearest `[data-ref]` ancestor
   * makes the WHOLE cell a drop target, which is what the user asked for.
   *
   * The old comment here claimed the children were `pointer-events:none`, which would have made the
   * direct read correct — they never were (styles.css now sets it too, as belt and braces). The Node
   * DOM shim could not catch the bug either, because it was returning the cell from
   * `elementFromPoint`: it now models the innermost child instead, and
   * scripts/verify-inventory.mjs drops onto an item's name span as a regression test.
   */
  function refUnder(x: number, y: number): ItemRef | null {
    const hit = document.elementFromPoint(x, y) as HTMLElement | null;
    const owner = hit && hit.closest ? (hit.closest('[data-ref]') as HTMLElement | null) : hit;
    return parseRef(owner?.dataset?.ref);
  }

  function moveGhost(x: number, y: number): void {
    ghost.style.left = x + 'px';
    ghost.style.top = y + 'px';
  }

  function endDrag(): void {
    drag = null;
    ghost.classList.add('hidden');
    setHot(null);
  }

  function onCellDown(e: PointerEvent, from: ItemRef): void {
    if (!getItem(getInventory(), from)) return;   // empty cell: nothing to pick up
    e.preventDefault();
    drag = { from, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, moved: false };
    const src = cells.get(encodeRef(from));
    // The floating ghost carries the item's short label so the drag reads as "this thing".
    const item = getItem(getInventory(), from);
    ghost.textContent = item ? itemLabel(item) : '';
    ghost.classList.remove('hidden');
    moveGhost(e.clientX, e.clientY);
    if (src && src.setPointerCapture) src.setPointerCapture(e.pointerId);
  }

  function onCellMove(e: PointerEvent): void {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (Math.abs(e.clientX - drag.startX) > TAP_SLOP || Math.abs(e.clientY - drag.startY) > TAP_SLOP) {
      drag.moved = true;
    }
    if (!drag.moved) return;
    moveGhost(e.clientX, e.clientY);
    const over = refUnder(e.clientX, e.clientY);
    // Highlight only a target the sim would actually accept (canMove is the same rule the sim
    // uses), so a red/invalid hover is impossible to mistake for a drop.
    setHot(over && !sameRef(over, drag.from) && canMove(getInventory(), drag.from, over) ? over : null);
  }

  function onCellUp(e: PointerEvent): void {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const from = drag.from;
    const moved = drag.moved;
    const over = refUnder(e.clientX, e.clientY);
    endDrag();
    if (!moved) {
      // A tap arms (or re-arms) tap-to-move instead of dragging.
      setSelected(sameRef(selected, from) ? null : from);
      return;
    }
    // Validate against the SAME rule the highlight used, so an illegal drop never even reaches the
    // sim (and nothing can move by accident if the sim is mid-change).
    if (over && !sameRef(over, from) && canMove(getInventory(), from, over)) onMove(from, over);
    setSelected(null);
    refresh();
  }

  /** A tap on a cell while something is selected is the second half of tap-to-move. */
  function completeMove(src: ItemRef, to: ItemRef): void {
    setSelected(null);
    if (canMove(getInventory(), src, to)) onMove(src, to);
    refresh();
  }

  // Wire every cell once. `pointerdown` decides drag vs tap; `click` is NEVER used (see
  // weaponButton.ts for why a second finger's tap does not produce one).
  for (const cell of cells.values()) {
    const ref = parseRef(cell.dataset.ref) as ItemRef;
    cell.addEventListener('pointerdown', (e: Event) => {
      // TAP-TO-MOVE, second tap: with something selected, pressing any OTHER cell completes the
      // move right here (filled target = swap, empty target = place). Doing it on pointerdown
      // rather than pointerup means the session below is never started, so the two paths cannot
      // both fire for one tap.
      if (selected && !sameRef(selected, ref)) {
        completeMove(selected, ref);
        return;
      }
      onCellDown(e as PointerEvent, ref);
    });
    cell.addEventListener('pointermove', (e: Event) => onCellMove(e as PointerEvent));
    // pointerup resolves a drag (or arms tap-to-move when the pointer barely moved). It is a no-op
    // when the move already completed on pointerdown, because no drag session was started.
    cell.addEventListener('pointerup', (e: Event) => onCellUp(e as PointerEvent));
    cell.addEventListener('pointercancel', (e: Event) => onCellUp(e as PointerEvent));
  }

  btn.addEventListener('pointerdown', (e: Event) => {
    e.stopPropagation();     // do not arm mouse aiming on the canvas behind the HUD
    setOpen(!open);
  });
  closeBtn.addEventListener('pointerdown', (e: Event) => {
    e.stopPropagation();
    setOpen(false);
  });

  refresh();
  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!open),
    isOpen: () => open,
    refresh,
  };
}
