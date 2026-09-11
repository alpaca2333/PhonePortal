// The arena's ART: which prop stands where. Pure — no three, no DOM, no Math.random — so
// scripts/verify-props.mjs can prove the placement rules without a browser.
//
// WHAT THIS MODULE OWNS
//   * PROPS: the catalog of vendored .glb props with their natural sizes (measured from the files,
//     not guessed — the test re-reads the .glb headers and fails if a number or a filename drifts);
//   * planArena(): the deterministic layout — floor tiles, perimeter walls, the prop cluster that
//     fills each cover footprint, and the scattered decorations.
//
// WHAT IT DELIBERATELY DOES NOT OWN: collision. `level.ts`'s OBSTACLES stay the single source of
// truth for what is solid, and this module only decides what the player SEES standing there. Two
// invariants follow, and both are asserted:
//   1. every cover prop fits INSIDE its obstacle's footprint. A prop that overhangs would be a lie
//      in the worst direction (bullets pass through the part the player can see);
//   2. no decoration lands inside a cover footprint, on the spawn clearance, or outside the room.
//
// WHY A SEEDED PRNG INSTEAD OF Math.random: the layout must be identical on every reload. A random
// scatter would also make the verification suite flaky and screenshots useless for comparison.
import { ARENA_HALF } from './config.js';
import type { Obstacle } from './level.js';

// ---------------------------------------------------------------------------------------------
// Theme constants. One place to retheme the arena.
// ---------------------------------------------------------------------------------------------

/**
 * Kenney's kit is authored around a 1-unit-tall human (its wall is 1.29 units). This app's
 * characters are normalized to 2.0 world units tall, so 2.2 makes the furniture read as furniture:
 * a chair seat lands at ~0.5, a door at ~2.2 and a room wall at ~2.97 — all measured against a
 * 2.0-tall skeleton, which is the only reference that matters.
 */
export const PROP_SCALE = 2.2;

/** World units per floor tile (the kit's floor is 1x1, so this is also its XZ scale). */
export const FLOOR_TILE = 4;

/**
 * Height the floor's TOP surface is put at. It must stay below VISION_Y (render.ts) or the darkness
 * overlay would be buried inside the floor, and well below the ground sparks (y = 0.2) so they are
 * not swallowed by the tiles: hence a flat slab (the kit's 0.05 thickness is squashed to this).
 */
export const FLOOR_TOP = 0.01;

/**
 * The room floor's albedo, replacing the kit's own colour (see PropDef.tint). An sRGB hex, written
 * the same way as every other colour constant in this app.
 *
 * WHY THE FLOOR NEEDS AN OVERRIDE AT ALL: in Kenney's kit the floor piece, the walls, the corners
 * and the windows all share ONE `wood` material (0.90, 0.60, 0.39 — the warm tan you see on the
 * walls). Recolouring the material would turn the walls grey too, so the theme declares a
 * replacement albedo per prop instead. The floor is the one surface the player stares at for the
 * whole match, which is why it is the one that gets a neutral one.
 *
 * WHY THIS SHADE: brightness first, then hue. The kit's wood albedo has a linear luminance of
 * 0.649; this grey is 0.240 (37% of it), i.e. HALF of the 0.481 that shipped before it. The shade
 * has been walked down by eye over three passes (0.588 "light grey" -> 0.481 "mid grey" -> here,
 * "twice as grey again"), so the numbers in that walk are worth keeping: each one still owes its
 * place to the same rule, that the floor's own albedo sets the room's exposure and the contrast of
 * everything drawn on it (shadows, the vision-darkening edge, the blood/ammo HUD is CSS and
 * unaffected) — going darker is a real art decision, not a free one, and past roughly this point the
 * cast shadows stop reading against the floor.
 * A dead-neutral grey (R=G=B) was rejected too: the key light is white but the fill is 0xffc890 and
 * the hemisphere sky is 0xcfe8ff, so a grey with a slight cool bias (+8/255 on blue here) reads as
 * neutral concrete under them, where a pure grey reads yellow. Retune in one line: 0xc6cacf is the
 * light grey, 0xb4b9be the mid one, 0x9aa0a6 a mid-dark one, 0xcfd3d7 the exact luminance of the
 * wood it replaces.
 */
export const FLOOR_TINT = 0x83878b;

/**
 * Scale of the COVER furniture — furniture standing in a cover pile — and the tallest it may get.
 *
 * WHY IT IS NOT `PROP_SCALE`: the kit's furniture is authored for a 1-unit human, so at PROP_SCALE a
 * sofa is 1.0 units tall against this app's 2.0-unit character — waist high. That is right for
 * scenery (a chair next to a wall is a chair) and wrong for the things the fight happens around:
 * the level declares its cover at 1.4-2.6 units, and the player reads "can I hide behind that?" off
 * the picture. So the piles are dressed ~45% larger than the same props used as decor, which puts
 * the typical piece at chest height (~1.5) and the tall pieces (bookcase, fridge, washer, half wall)
 * at 2.1-2.6. `COVER_MAX_H` stops any of them out-topping the room's own 2.97-unit walls (it also
 * keeps `planCasterHeight()` — and therefore the key light's shadow box — at the walls, unchanged).
 */
export const COVER_SCALE = 3.2;
export const COVER_MAX_H = 2.6;

/** Fraction of a cell one cover prop may occupy; the rest is the gap between pieces in a pile. */
const COVER_FIT = 0.95;
/** Clamp on the pieces in one pile, so a plan that "fills" a box with a hundred slivers is rejected. */
const COVER_MAX_INSTANCES = 14;
/**
 * Height floors for a pile, in world units against a 2.0-unit character.
 *
 * `COVER_TALL_H` is what the MAIN piece of a pile has to reach — the ask was chest height (~1.5) —
 * and it is what makes a pile read as cover rather than as furniture standing around. `COVER_MIN_H`
 * is the floor for the pieces that fill the cells around it (a bed, a desk, a low bookcase): they
 * may be shorter, because they are not what the eye sizes the obstacle by, and excluding them
 * outright left the room with 48 fridges in it. Anything below COVER_MIN_H — a cardboard box, a
 * coffee table — is scenery: it stays in the catalog and appears as scattered decor.
 */
export const COVER_TALL_H = 1.45;
const COVER_MIN_H = 1.0;
/** A pile is a pile, not a warehouse: the main piece's grid is capped at this many cells. */
const COVER_MAX_PILE = 6;

/** Target width of one perimeter wall segment; the actual width is adjusted to tile exactly. */
export const WALL_SEG = 2.3;

/** Decorations keep this far away from the spawn (the player must not start inside a lamp). */
export const DECOR_SPAWN_GAP = 4.5;

/** Decorations keep this far from every cover footprint, so nothing intersects the obstacles. */
export const DECOR_COVER_GAP = 0.45;

/** How many decorations to scatter (before the rejections; the final count is asserted). */
export const DECOR_TARGET = 46;

// ---------------------------------------------------------------------------------------------
// The catalog. Sizes are [width (X), height (Y), depth (Z)] in KENNEY units, measured from the
// NODE-TRANSFORMED geometry that the loader actually draws (scripts/lib/glb.mjs does the measuring,
// and it recentres exactly like assets.ts does).
//
// MEASURING THE RAW POSITION ACCESSOR IS WRONG, and was wrong here for 11 of these 49 props: a
// glTF mesh's accessor bounds are in the MESH's local space, and this kit puts real scale/rotation
// on the nodes (plantSmall is authored 2x with a 0.5 node scale, bedDouble rotates its children,
// the fridge is authored 1.5x with a 0.66 node scale). The raw numbers over-reported the trashcan
// and the bed by more than 2x and under-reported the fridge's depth by 5% — i.e. the layout math
// and the containment proof were both working from a size the renderer never draws. Every entry's
// file must exist in assets/props/ too, so a rename cannot silently 404 on a phone.
// ---------------------------------------------------------------------------------------------
export interface PropDef {
  /** file name inside assets/props (without .glb) */
  file: string;
  /** natural size in Kenney units: X (width), Y (height), Z (depth) */
  size: [number, number, number];
  /** true when the prop lies flat on the floor (rugs): it may overlap other decor */
  flat?: boolean;
  /**
   * Optional REPLACEMENT albedo (sRGB hex) for this prop, overriding the .glb's own material colour.
   * Only the floor uses it — see FLOOR_TINT for why (the kit shares one `wood` material between the
   * floors and the walls, so the material cannot be recoloured on its own).
   */
  tint?: number;
}

export const PROPS = {
  // --- room shell -------------------------------------------------------------------------
  floorFull: { file: 'floorFull', size: [1, 0.05, 1], tint: FLOOR_TINT },
  wall: { file: 'wall', size: [1, 1.29, 0.05] },
  wallHalf: { file: 'wallHalf', size: [0.5, 1.29, 0.05] },
  wallCorner: { file: 'wallCorner', size: [0.55, 1.29, 0.55] },
  wallDoorway: { file: 'wallDoorway', size: [1, 1.29, 0.089] },
  wallWindow: { file: 'wallWindow', size: [1, 1.29, 0.089] },
  // --- cover: pieces that read as waist-high or taller solid mass --------------------------
  loungeSofaLong: { file: 'loungeSofaLong', size: [0.98, 0.46, 0.82] },
  loungeSofa: { file: 'loungeSofa', size: [0.98, 0.46, 0.41] },
  loungeSofaCorner: { file: 'loungeSofaCorner', size: [0.98, 0.46, 0.98] },
  loungeDesignSofa: { file: 'loungeDesignSofa', size: [1.12, 0.4, 0.41] },
  bookcaseClosedWide: { file: 'bookcaseClosedWide', size: [0.8, 0.79, 0.25] },
  bookcaseOpenLow: { file: 'bookcaseOpenLow', size: [0.4, 0.4, 0.25] },
  desk: { file: 'desk', size: [0.734, 0.384, 0.392] },
  table: { file: 'table', size: [0.841, 0.327, 0.447] },
  tableCoffee: { file: 'tableCoffee', size: [0.661, 0.23, 0.4] },
  cabinetTelevision: { file: 'cabinetTelevision', size: [0.8, 0.31, 0.25] },
  kitchenBar: { file: 'kitchenBar', size: [0.43, 0.42, 0.21] },
  kitchenFridgeLarge: { file: 'kitchenFridgeLarge', size: [0.52, 0.92, 0.406] },
  washerDryerStacked: { file: 'washerDryerStacked', size: [0.39, 0.94, 0.39] },
  trashcan: { file: 'trashcan', size: [0.208, 0.428, 0.234] },
  cardboardBoxClosed: { file: 'cardboardBoxClosed', size: [0.212, 0.281, 0.212] },
  cardboardBoxOpen: { file: 'cardboardBoxOpen', size: [0.372, 0.281, 0.212] },
  bedDouble: { file: 'bedDouble', size: [0.956, 0.375, 1.125] },
  bench: { file: 'bench', size: [0.4, 0.47, 0.2] },
  stoolBar: { file: 'stoolBar', size: [0.265, 0.435, 0.23] },
  // --- decorations -------------------------------------------------------------------------
  chair: { file: 'chair', size: [0.2, 0.47, 0.2] },
  sideTable: { file: 'sideTable', size: [0.534, 0.384, 0.22] },
  pottedPlant: { file: 'pottedPlant', size: [0.212, 0.654, 0.241] },
  plantSmall1: { file: 'plantSmall1', size: [0.095, 0.14, 0.095] },
  plantSmall2: { file: 'plantSmall2', size: [0.095, 0.14, 0.095] },
  rugRound: { file: 'rugRound', size: [0.92, 0.01, 0.92], flat: true },
  rugRectangle: { file: 'rugRectangle', size: [1.57, 0.01, 0.92], flat: true },
  rugSquare: { file: 'rugSquare', size: [0.904, 0.01, 0.92], flat: true },
  rugDoormat: { file: 'rugDoormat', size: [0.429, 0.01, 0.237], flat: true },
  lampRoundFloor: { file: 'lampRoundFloor', size: [0.152, 0.86, 0.176] },
  lampWall: { file: 'lampWall', size: [0.227, 0.093, 0.15] },
  lampRoundTable: { file: 'lampRoundTable', size: [0.152, 0.314, 0.176] },
  speaker: { file: 'speaker', size: [0.148, 0.636, 0.148] },
  radio: { file: 'radio', size: [0.315, 0.228, 0.098] },
  laptop: { file: 'laptop', size: [0.264, 0.162, 0.24] },
  computerScreen: { file: 'computerScreen', size: [0.393, 0.294, 0.104] },
  televisionModern: { file: 'televisionModern', size: [0.685, 0.455, 0.128] },
  televisionVintage: { file: 'televisionVintage', size: [0.41, 0.27, 0.27] },
  books: { file: 'books', size: [0.15, 0.104, 0.095] },
  pillow: { file: 'pillow', size: [0.23, 0.222, 0.088] },
  coatRack: { file: 'coatRack', size: [0.448, 0.28, 0.134] },
  toaster: { file: 'toaster', size: [0.188, 0.13, 0.1] },
  kitchenCoffeeMachine: { file: 'kitchenCoffeeMachine', size: [0.19, 0.177, 0.24] },
  bear: { file: 'bear', size: [0.39, 0.45, 0.247] },
} satisfies Record<string, PropDef>;

export type PropId = keyof typeof PROPS;

/** One instance in the plan. `yaw` is a multiple of 90 degrees; `scale` is uniform. */
export interface PlacedProp {
  id: PropId;
  x: number;
  z: number;
  yaw: 0 | 1 | 2 | 3;
  scale: number;
  /** Optional Y-scale override (uniform `scale` otherwise). Only floor tiles use it: they are
   * squashed to a flat slab so ground effects (sparks at y = 0.2, the darkness overlay) stay above
   * the floor instead of being buried inside a 0.2-unit-thick box. */
  sy?: number;
  /** index into the obstacle list (cover props only) — the renderer needs it for vision dimming */
  obstacle?: number;
}

export interface ArenaPlan {
  floor: PlacedProp[];
  walls: PlacedProp[];
  cover: PlacedProp[];
  decor: PlacedProp[];
}

// ---------------------------------------------------------------------------------------------
// Deterministic PRNG (mulberry32 — the same one scripts/trace-shooter.mjs uses, so a seeded layout
// is reproducible across machines and runs).
// ---------------------------------------------------------------------------------------------
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Yaw quarter-turns: 0..3 => 0/90/180/270 degrees. Only right angles, so a prop's rotated
 * footprint is still axis-aligned and can be proved to fit inside its obstacle. */
const yawSwap = (yaw: number): boolean => yaw % 2 === 1;

/** Footprint of a prop at `scale` and `yaw` (X extent, Z extent), in world units. */
export function propFootprint(id: PropId, scale: number, yaw: number): [number, number] {
  const s = PROPS[id].size;
  const w = s[0] * scale;
  const d = s[2] * scale;
  return yawSwap(yaw) ? [d, w] : [w, d];
}

/** Shrink factor so a prop at `yaw` fits inside a `w` x `d` footprint, capped at the theme scale. */
function fitScale(id: PropId, w: number, d: number, yaw: number): number {
  const s = PROPS[id].size;
  const [fw, fd] = yawSwap(yaw) ? [s[2], s[0]] : [s[0], s[2]];
  return Math.min(PROP_SCALE, w / fw, d / fd);
}

/** Same, for a piece standing in a cover pile (see COVER_SCALE / COVER_MAX_H). */
function coverFitScale(id: PropId, w: number, d: number, yaw: number): number {
  const s = PROPS[id].size;
  const [fw, fd] = yawSwap(yaw) ? [s[2], s[0]] : [s[0], s[2]];
  return Math.min(COVER_SCALE, w / fw, d / fd, COVER_MAX_H / s[1]);
}

/** One way to tile a footprint with one prop: the grid, the scale, and how much area it fills. */
interface PilePlan {
  id: PropId;
  yaw: 0 | 1;
  cols: number;
  rows: number;
  stepX: number;
  stepZ: number;
  /** fraction of the footprint the pieces cover */
  fill: number;
}

/**
 * Every sensible way to tile a footprint of w x d with ONE prop type.
 *
 * WHY A SEARCH AND NOT "size the cell to the piece at COVER_SCALE": because most props are not the
 * shape of the box they have to dress, and a single guess leaves holes (a 0.98 x 0.41 sofa in a
 * 19 x 3.4 wall wants a different grid than in a 5.6 x 5.6 crate). The grid is searched over every
 * cols x rows up to COVER_MAX_INSTANCES; the piece is then fitted to its cell, capped by COVER_SCALE
 * and COVER_MAX_H, and pieces that would come out shorter than COVER_MIN_H are rejected outright.
 *
 * WHAT THIS FIXES: the reported "the obstacles are too small". The old rule sized the cells to the
 * largest of 2-3 randomly chosen kinds, so a 4x4 box that drew a bed got ONE cell, and with the
 * piece capped at its natural size that pile covered 2% of its own collision box — a lone stool in
 * an invisible 4x4 wall. Scoring every candidate by the area it actually covers cannot do that.
 */
function pilePlans(id: PropId, w: number, d: number): PilePlan[] {
  const s = PROPS[id].size;
  const out: PilePlan[] = [];
  for (const yaw of [0, 1] as const) {
    const [fw, fd] = yawSwap(yaw) ? [s[2], s[0]] : [s[0], s[2]];
    for (let cols = 1; cols <= COVER_MAX_INSTANCES; cols++) {
      for (let rows = 1; cols * rows <= COVER_MAX_INSTANCES; rows++) {
        const stepX = w / cols;
        const stepZ = d / rows;
        const scale = coverFitScale(id, stepX * COVER_FIT, stepZ * COVER_FIT, yaw);
        if (s[1] * scale < COVER_MIN_H - 1e-9) continue;
        out.push({
          id, yaw, cols, rows, stepX, stepZ,
          fill: (cols * rows * (fw * scale) * (fd * scale)) / (w * d),
        });
      }
    }
  }
  return out;
}

/**
 * The plan to use for one prop in one footprint: cover at least 90% of the best coverage available,
 * then use the FEWEST PIECES that does it, then the tallest piece.
 *
 * The "coverage first, piece count second" order is the whole point: maximising coverage alone
 * happily fills a 5.6 x 5.6 crate with ten slivers (a 96% fill of nonsense); requiring only that the
 * pile covers most of what the best arrangement would gives a dense, deliberate-looking stack — and
 * it is also the cheap one to draw, since every piece is an instance.
 */
function bestPilePlan(plans: readonly PilePlan[], h: (p: PilePlan) => number): PilePlan | null {
  for (const cap of [COVER_MAX_PILE, COVER_MAX_PILE * 2, COVER_MAX_INSTANCES]) {
    const ok = plans.filter((p) => p.cols * p.rows <= cap);
    if (ok.length === 0) continue;
    let maxFill = 0;
    for (const p of ok) if (p.fill > maxFill) maxFill = p.fill;
    const good = ok.filter((p) => p.fill >= maxFill * 0.9);
    // FILL first, height second: sorting by height first picked a 2.5-unit bookcase over a 1.5-unit
    // sofa for the long walls and left them 15% covered — the pile has to cover the collision box
    // before it impresses anyone with its silhouette.
    good.sort((a, b) => b.fill - a.fill || h(b) - h(a));
    return good[0];
  }
  return null;
}

/** World height of a plan's pieces (the renderer only needs it to report the pile's height). */
function planHeight(p: PilePlan): number {
  return PROPS[p.id].size[1] * coverFitScale(p.id, p.stepX * COVER_FIT, p.stepZ * COVER_FIT, p.yaw);
}

// ---------------------------------------------------------------------------------------------
// Cover furniture, grouped by the ROOM FICTION each pile belongs to.
//
// One pool is drawn per obstacle (seeded), and the pile planner then picks the member that covers
// that footprint best, so a pile is internally consistent and different obstacles look like
// different corners of the same house. This replaced two shape-based pools ("long" vs "chunky")
// because shape turned out to be the wrong axis to vary on: with the fill-maximising planner every
// long wall and every crate converged on the same two or three lounge pieces, i.e. a room furnished
// wall-to-wall with identical sofas.
//
// A pool may hold pieces too short to be a pile's MAIN piece (COVER_TALL_H) — they are still useful
// as the filler cells around it. Entries that cannot reach COVER_MIN_H are simply never chosen, so
// the assertions are about the pile that comes out, not about the pool.
// ---------------------------------------------------------------------------------------------
export const SHELL_PROPS: readonly PropId[] = ['floorFull', 'wall', 'wallHalf', 'wallCorner', 'wallWindow', 'wallDoorway'];
/** Lounge: sofas and low tables. */
export const LOUNGE_COVER: readonly PropId[] = [
    'loungeSofa', 'loungeSofaCorner', 'loungeSofaLong', 'loungeDesignSofa',
    'tableCoffee', 'table', 'sideTable', 'bench',
];
/** Kitchen / utility: the tall white goods plus the bar stools. */
export const KITCHEN_COVER: readonly PropId[] = [
    'kitchenFridgeLarge', 'washerDryerStacked', 'kitchenBar', 'stoolBar', 'trashcan',
    'cardboardBoxClosed', 'cardboardBoxOpen',
];
/** Study / storage: shelves and desks. */
export const STUDY_COVER: readonly PropId[] = [
    'bookcaseClosedWide', 'bookcaseOpenLow', 'desk', 'cabinetTelevision', 'chair', 'books',
];
/** Bedroom: the bed and its surroundings. */
export const BEDROOM_COVER: readonly PropId[] = [
    'bedDouble', 'bench', 'lampRoundTable', 'sideTable', 'pillow',
];
export const COVER_POOLS: readonly (readonly PropId[])[] = [
    LOUNGE_COVER, KITCHEN_COVER, STUDY_COVER, BEDROOM_COVER,
];

/** Scattered scenery (not cover). */
export const DECOR: readonly PropId[] = [
    'chair', 'sideTable', 'pottedPlant', 'plantSmall1', 'plantSmall2', 'lampRoundFloor', 'lampRoundTable',
    'speaker', 'radio', 'laptop', 'computerScreen', 'televisionModern', 'televisionVintage',
    'books', 'pillow', 'coatRack', 'toaster', 'kitchenCoffeeMachine', 'bear', 'trashcan',
    'tableCoffee',
    'cardboardBoxClosed', 'cardboardBoxOpen', 'stoolBar',
];
export const FLAT_DECOR: readonly PropId[] = ['rugRound', 'rugRectangle', 'rugSquare', 'rugDoormat'];
/** Mounted on the walls on a fixed rhythm (see planArena), not scattered. */
export const WALL_DECOR: readonly PropId[] = ['lampWall'];
/**
 * Every pool, for the verification suite: it asserts that the union of these plus the shell covers
 * the whole catalog, so a prop cannot sit in assets/props/ (and in PROPS) without ever being used.
 */
export const POOLS: readonly (readonly PropId[])[] = [
    SHELL_PROPS, ...COVER_POOLS, DECOR, FLAT_DECOR, WALL_DECOR,
];

/**
 * Fill one obstacle's footprint with a cluster of props.
 *
 * The cluster is a grid of cells, sized for the prop that will stand in them, centred in the
 * footprint, with only right-angle rotations. Every instance is proved (by construction and by the
 * test) to lie inside the footprint: the grid divides the footprint exactly, the piece is fitted to
 * COVER_FIT of its cell, and the jitter cannot reach the cell edge (COVER_FIT/2 + jitter < 0.5).
 *
 * TWO KINDS PER PILE WHEN THE SECOND ONE CAN PAY FOR ITSELF: a pile of eight identical sofas reads
 * as a showroom, but mixing in a prop that leaves half its cell empty reopens the holes this
 * function exists to close — so the second kind is only used for the cells it covers at least 80%
 * as well as the primary one. Which primary a given footprint gets is drawn from the plans that are
 * within 90% of the best coverage, so different obstacles end up with different furniture.
 */
function fillCover(
  o: Obstacle, index: number, rnd: () => number, out: PlacedProp[],
): void {
  const w = o.hw * 2;
  const d = o.hh * 2;
  // Every piece in the pile has to clear the scenery floor; the MAIN piece has to reach chest height.
  //
  // FAMILY IS A PREFERENCE, NOT A CONSTRAINT. Drawing one furniture family per obstacle and planning
  // only inside it gave lovely variety and a 28% fill — the room got *smaller* obstacles, which is
  // the opposite of the point. So: coverage is computed across every family, and the drawn family
  // only breaks ties among the arrangements that already cover within 15% of the best. Where the
  // family cannot pay for itself, coverage wins.
  const all: PilePlan[] = [];
  for (const ids of COVER_POOLS) for (const id of ids) all.push(...pilePlans(id, w, d));
  const tall = all.filter((p) => planHeight(p) >= COVER_TALL_H - 1e-9);
  if (tall.length === 0) return;   // no prop in the catalog can dress this footprint (cannot happen: asserted)
  let maxFill = 0;
  for (const p of tall) if (p.fill > maxFill) maxFill = p.fill;
  const near = tall.filter((p) => p.fill >= maxFill * 0.85);
  const family = COVER_POOLS[(rnd() * COVER_POOLS.length) | 0];
  const inFamily = near.filter((p) => family.includes(p.id));
  const preferred = inFamily.length > 0 ? inFamily : near;
  // `bestPilePlan` again, so the pile-count cap still applies: taking the highest coverage outright
  // filled the long walls with fourteen small pieces each (a "cover pile" of 213 instances).
  const primary = bestPilePlan(preferred, planHeight);
  if (primary === null) return;
  const bestFill = primary.fill;
  // Draw the main piece from the arrangements that share its grid and cover nearly as well, so the
  // room is not one repeated pile.
  const candidates = preferred.filter((p) => p.fill >= bestFill * 0.9
    && p.cols === primary.cols && p.rows === primary.rows);
  // Tallest first, then let the RNG pick among the top few: variety across obstacles, never at the
  // cost of the pile being chest high.
  candidates.sort((a, b) => planHeight(b) - planHeight(a) || b.fill - a.fill);
  const top = candidates.slice(0, Math.min(3, candidates.length));
  const chosen = top[(rnd() * top.length) | 0];

  // A second kind, only if it fills its cells nearly as well as the first.
  const secondPool = all.filter((p) => p.id !== chosen.id && p.fill >= chosen.fill * 0.8);
  const secondary = secondPool.length > 0 ? secondPool[(rnd() * secondPool.length) | 0] : null;

  const { cols, rows, stepX, stepZ } = chosen;
  const nk = secondary ? 2 : 1;
  for (let cx = 0; cx < cols; cx++) {
    for (let cz = 0; cz < rows; cz++) {
      const which = nk === 2 && (cx + cz) % 2 === 1 ? secondary! : chosen;
      const scale = coverFitScale(which.id, stepX * COVER_FIT, stepZ * COVER_FIT, which.yaw);
      // Centre of this cell, with a jitter that can never reach the cell edge:
      // COVER_FIT/2 + 0.02 = 0.495 < 0.5.
      const jx = (rnd() - 0.5) * stepX * 0.04;
      const jz = (rnd() - 0.5) * stepZ * 0.04;
      out.push({
        id: which.id,
        x: o.x - w / 2 + stepX * (cx + 0.5) + jx,
        z: o.y - d / 2 + stepZ * (cz + 0.5) + jz,
        yaw: which.yaw,
        scale,
        obstacle: index,
      });
    }
  }
}

/** Overlap test between a placed prop's rotated footprint and an axis-aligned box, plus margin. */
function hitsBox(p: PlacedProp, box: { x: number; y: number; hw: number; hh: number }, gap: number): boolean {
    const [fw, fd] = propFootprint(p.id, p.scale, p.yaw);
    return p.x - fw / 2 < box.x + box.hw + gap && p.x + fw / 2 > box.x - box.hw - gap
        && p.z - fd / 2 < box.y + box.hh + gap && p.z + fd / 2 > box.y - box.hh - gap;
}
/**
 * Does a placed prop stay inside the room? Measured on the prop's OWN footprint against the wall's
 * inner face — a fixed margin (the first version used 0.5 units) lets anything wider than 1 unit
 * poke through the wall, which is exactly what a 3.5-unit bed does.
 */
function insideRoom(p: PlacedProp, margin = 0.05): boolean {
    const [fw, fd] = propFootprint(p.id, p.scale, p.yaw);
    const lim = ARENA_HALF - margin;
    return p.x - fw / 2 >= -lim && p.x + fw / 2 <= lim && p.z - fd / 2 >= -lim && p.z + fd / 2 <= lim;
}
/**
 * The whole arena layout. Deterministic for a given (obstacles, seed).
 *
 * `decorTarget` is a WISH, not a promise: placement is rejection-sampled, so the caller should
 * expect slightly fewer (the test asserts a sane count instead of an exact one).
 */
export function planArena(
  obstacles: readonly Obstacle[],
  opts: { seed?: number; decorTarget?: number; decor?: boolean } = {},
): ArenaPlan {
    const seed = opts.seed ?? 0x5eed1234;
    const rnd = makeRng(seed); // decorations: varies with the seed
    // The cover piles are LEVEL DESIGN, so they get their own fixed stream: a different decor seed
    // must not reshuffle the barricades (the layout the player learns has to stay put).
    const rndCover = makeRng(0xc0ffee);
    const decorTarget = opts.decorTarget ?? DECOR_TARGET;
    const wantDecor = opts.decor !== false;
    const bg = Math.max(0.4, ARENA_HALF - 0.75);
    // --- floor: a tiled slab covering the play area exactly -------------------------------------
    const floor: PlacedProp[] = [];
    const tiles = Math.max(1, Math.round((ARENA_HALF * 2) / FLOOR_TILE));
    const tile = (ARENA_HALF * 2) / tiles;
    for (let i = 0; i < tiles; i++) {
        for (let j = 0; j < tiles; j++) {
            floor.push({
                // The kit's floor piece is 1 x 0.05 x 1: scaling Y so the TOP lands on FLOOR_TOP keeps the
                // slab flat (sparks sit at y = 0.2 and the darkness overlay at VISION_Y, both above it).
                id: 'floorFull',
                x: -ARENA_HALF + tile * (i + 0.5),
                z: -ARENA_HALF + tile * (j + 0.5),
                yaw: 0,
                scale: tile,
                sy: FLOOR_TOP / PROPS.floorFull.size[1],
            });
        }
    }
    // --- perimeter: walls outside the play area, inner face exactly on the arena bound ----------
    const walls: PlacedProp[] = [];
    const perSide = Math.max(2, Math.round((ARENA_HALF * 2) / WALL_SEG));
    const seg = (ARENA_HALF * 2) / perSide;
    const wallScale = seg / PROPS.wall.size[0];
    // Every piece is pushed out by ITS OWN half depth, so each one's inner face lands exactly on
    // ARENA_HALF. A window (0.089 thick) is nearly twice a wall (0.05), and a corner is 0.55 — using
    // one shared offset left the corners protruding ~0.6 units into the room, where the player can
    // walk into them.
    const offsetFor = (id: PropId): number => ARENA_HALF + (PROPS[id].size[2] * wallScale) / 2;
    const wallOff = offsetFor('wall');
    const winOff = offsetFor('wallWindow');
    for (let k = 0; k < perSide; k++) {
        const t = -ARENA_HALF + seg * (k + 0.5);
        // A window every fifth segment, on the two long sides: a room with no openings reads as a box.
        // Every 5th segment is a window, every 11th a doorway: a sealed box reads as a texture-less
        // box, and a door tells the player which way out is.
        const side = k % 11 === 5 ? 'wallDoorway' : (k % 5 === 2 ? 'wallWindow' : 'wall');
        const off = side === 'wall' ? wallOff : offsetFor(side);
        walls.push({ id: side, x: t, z: off, yaw: 0, scale: wallScale });
        walls.push({ id: side, x: t, z: -off, yaw: 0, scale: wallScale });
        walls.push({ id: side, x: off, z: t, yaw: 1, scale: wallScale });
        walls.push({ id: side, x: -off, z: t, yaw: 1, scale: wallScale });
    }
    const cornerOff = offsetFor('wallCorner');
    for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
            walls.push({ id: 'wallCorner', x: sx * cornerOff, z: sz * cornerOff, yaw: 0, scale: wallScale });
        }
    }
    // --- cover: one prop cluster per obstacle --------------------------------------------------
    const cover: PlacedProp[] = [];
    for (let i = 0; i < obstacles.length; i++) {
        const before = cover.length;
        fillCover(obstacles[i], i, rndCover, cover);
        // A footprint too small for the chosen prop still gets one instance, shrunk to fit.
        if (cover.length === before) {
            const id = 'cardboardBoxClosed';
            cover.push({ id, x: obstacles[i].x, z: obstacles[i].y, yaw: 0, scale: fitScale(id, obstacles[i].hw * 2, obstacles[i].hh * 2, 0), obstacle: i });
        }
    }
    // --- decorations: seeded scatter with keep-outs --------------------------------------------
    const decor: PlacedProp[] = [];
    if (wantDecor) {
        const placed = [];
        // Rugs first: they are flat, so they may sit under everything else and never block placement.
        const rugCount = 6;
        for (let k = 0; k < rugCount; k++) {
            const id = FLAT_DECOR[(rnd() * FLAT_DECOR.length) | 0];
            for (let attempt = 0; attempt < 24; attempt++) {
                const p: PlacedProp = {
                    id,
                    x: (rnd() * 2 - 1) * (ARENA_HALF - 3),
                    z: (rnd() * 2 - 1) * (ARENA_HALF - 3),
                    yaw: ((rnd() * 4) | 0) as 0 | 1 | 2 | 3,
                    scale: PROP_SCALE,
                };
                if (Math.hypot(p.x, p.z) < DECOR_SPAWN_GAP)
                    continue;
                if (!insideRoom(p))
                    continue;
                if (obstacles.some((o) => hitsBox(p, o, 0.2)))
                    continue;
                decor.push(p);
                break;
            }
        }
        let guard = 0;
        while (decor.length < decorTarget + rugCount && guard < decorTarget * 12) {
            guard++;
            const id = DECOR[(rnd() * DECOR.length) | 0];
            const p: PlacedProp = {
                id,
                x: (rnd() * 2 - 1) * (ARENA_HALF - 3),
                z: (rnd() * 2 - 1) * (ARENA_HALF - 3),
                yaw: ((rnd() * 4) | 0) as 0 | 1 | 2 | 3,
                scale: PROP_SCALE,
            };
            if (Math.hypot(p.x, p.z) < DECOR_SPAWN_GAP)
                continue;
            if (!insideRoom(p, 0.5))
                continue;
            if (obstacles.some((o) => hitsBox(p, o, DECOR_COVER_GAP)))
                continue;
            // Keep decor from interpenetrating itself (rugs excluded: they overlap by design).
            let clash = false;
            for (const q of placed) {
                const need = 0.75 * (PROPS[p.id].size[0] + PROPS[q.id].size[0]) * PROP_SCALE * 0.5;
                if (Math.hypot(p.x - q.x, p.z - q.z) < need) {
                    clash = true;
                    break;
                }
            }
            if (clash)
                continue;
            placed.push(p);
            decor.push(p);
        }
        // Wall lamps: a regular rhythm on the inside face of each wall (not random — a lamp every few
        // metres is how a room is actually lit, and random ones would look like litter on the wall).
        const lampEvery = 12;
        // Mounted ON the inner face: the offset uses the lamp's footprint AT THAT ROTATION, so the back
        // panel is flush with the wall and nothing pokes through. (A fixed 0.06 offset did poke through
        // by 0.23 units; a single "depth" constant is wrong too, because turning the lamp 90 degrees
        // swaps which axis is its depth.)
        const lampAt = (yaw: number): number => {
            const [fw, fd] = propFootprint('lampWall', PROP_SCALE, yaw);
            return yaw % 2 === 0 ? ARENA_HALF - fd / 2 : ARENA_HALF - fw / 2;
        };
        for (let t = -ARENA_HALF + lampEvery / 2; t < ARENA_HALF; t += lampEvery) {
            decor.push({ id: 'lampWall', x: t, z: lampAt(2), yaw: 2, scale: PROP_SCALE });
            decor.push({ id: 'lampWall', x: t, z: -lampAt(0), yaw: 0, scale: PROP_SCALE });
            decor.push({ id: 'lampWall', x: lampAt(1), z: t, yaw: 1, scale: PROP_SCALE });
            decor.push({ id: 'lampWall', x: -lampAt(3), z: t, yaw: 3, scale: PROP_SCALE });
        }
    }
    return { floor, walls, cover, decor };
}

/** Prop counts by id, for the verification summary and for sizing the renderer's pools. */
export function countByProp(plan: ArenaPlan): Map<PropId, number> {
  const out = new Map<PropId, number>();
  for (const list of [plan.floor, plan.walls, plan.cover, plan.decor]) {
    for (const p of list) out.set(p.id, (out.get(p.id) ?? 0) + 1);
  }
  return out;
}

/**
 * The albedo override the loader must bake for a prop FILE, or null to keep the .glb's own colour.
 *
 * Looked up by file name because that is what assets.ts::loadPropGeometry receives; the catalog's
 * files are unique (verify-props.mjs asserts the mapping is 1:1), so this cannot pick the wrong prop.
 */
export function propTintForFile(file: string): number | null {
  for (const id of Object.keys(PROPS) as PropId[]) {
    // Typed as PropDef rather than read off the literal: PROPS is declared with `satisfies`, so its
    // inferred type is a union of the 45 literal entries and only a few of them carry `tint`.
    const def: PropDef = PROPS[id];
    if (def.file === file) return def.tint ?? null;
  }
  return null;
}

/**
 * The translation that puts a prop's ORIGIN at the centre of its footprint with its base on y = 0 —
 * the convention every placement in this module assumes (see the catalog note above).
 *
 * WHY IT IS A FUNCTION AND NOT FOUR LINES IN THE LOADER: the kit's models keep their origin at a
 * footprint corner (and three of them are authored sunk below y = 0), so this shift is what makes
 * the placement math true. It is applied to the geometry in assets.ts::normalizeProp, applied to the
 * measurement in scripts/lib/glb.mjs, and asserted against both in scripts/verify-props.mjs — one
 * formula, three users, no chance of them drifting apart.
 */
export function propNormalizeOffset(
  lo: readonly [number, number, number], hi: readonly [number, number, number],
): [number, number, number] {
  return [-(lo[0] + hi[0]) / 2, -lo[1], -(lo[2] + hi[2]) / 2];
}

/** The y a prop instance should be placed at (the kit's models sit on their own base). */
export function propBaseY(): number {
  return FLOOR_TOP;
}

/**
 * Height of the tallest prop in a plan, in world units.
 *
 * The key light's shadow box has to include every caster whose shadow can reach the view, and the
 * depth window has to include its top (see shadow.ts::fitShadowBox), so the renderer measures this
 * from the plan instead of guessing: retheme the room and the shadow box follows.
 */
export function planCasterHeight(plan: ArenaPlan): number {
  let tallest = 0;
  for (const list of [plan.floor, plan.walls, plan.cover, plan.decor]) {
    for (const p of list) {
      const h = PROPS[p.id].size[1] * (p.sy ?? p.scale);
      if (h > tallest) tallest = h;
    }
  }
  return tallest;
}
