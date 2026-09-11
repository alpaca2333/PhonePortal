// WHO THE CHARACTERS ARE, in one place: the model file, the meshes the loader must delete, the clip
// that provides the aiming pose, and the clip every render state plays.
//
// WHY A MANIFEST AND NOT CONSTANTS IN render.ts / main.ts
// -------------------------------------------------------
// The three facts about a character live in three different layers — the FILE is loaded by main.ts,
// the ANIMATION NAMES are played by render.ts, and the STRIP list is applied by assets.ts. Splitting
// them across those files is how a character swap goes wrong silently: `play()` ignores an unknown
// clip name, and a wrong strip list only shows up as "the model is off-centre on a device". Here they
// are one record, so:
//   * `loadCharTemplate(def)` validates at load time that every mapped clip really exists in the file
//     it just parsed, and logs what it found (the app still runs — a missing clip is a no-op);
//   * `scripts/verify-characters.mjs` imports this module and asserts the same mapping against the
//     shipped .glb files, so a swap that breaks the mapping fails the suite instead of the game.
//
// The clip names below are EXACT glTF animation names, `CharacterArmature|` prefix included — that
// prefix is part of the name in the Quaternius packs.
//
// See apps/shooter/README.md「角色（Quaternius Cyberpunk）」for the source, the licence, why this pack
// (normal proportions + a real gun/aim/death clip set), and what was rejected.

/** A player state -> clip name. Empty string = "this pack has no clip for that state" (play() no-ops). */
export interface PlayerAnims {
  idle: string;
  run: string;
  shoot: string;
  death: string;
  /** Melee slice, played ALTERNATELY (`swingDir`) so a repeated attack does not read as one motion. */
  swingA: string;
  swingB: string;
}

export interface EnemyAnims {
  idle: string;
  walk: string;
  run: string;
  /** Melee chaser attack. */
  attack: string;
  /** Hit reaction. The robot has none (see the README) — the flash tint carries the feedback. */
  hit: string;
  death: string;
  /** Gunner telegraph pose, or '' when the pack has no aiming clip (the beam is then the only tell). */
  aim: string;
  shoot: string;
}

export interface CharacterDef<A> {
  /** File name under `apps/shooter/assets/models/`. */
  file: string;
  /**
   * Multiplier applied to every lit material's base colour at load (see toon.ts::tintCharacter).
   * The two sides use the SAME model, so this is what tells them apart — and it has to survive the
   * hit-flash/burn tint, which is why it is applied to the captured BASE colour, not on top of it.
   */
  tint?: readonly [number, number, number];
  /**
   * Mesh nodes the loader DELETES. Two reasons, both hard (see assets.ts::stripHeldItems):
   * the game draws no weapon models of its own, and a held item inflates the model's bounding box,
   * which `normalizeModel` centres on — so a held sword pushes the body off its own origin.
   */
  strip: readonly string[];
  /** Clip sampled for the upper-body aiming overlay (upper-body bones only); '' = no overlay. */
  aimPose: string;
  anims: A;
}

/**
 * Player: Quaternius "Cyberpunk" character. 22 clips, includes a proper gun set — `Idle_Gun_Pointing`
 * (the aim overlay source), `Gun_Shoot`, `Run_Shoot` — plus `Death`, `HitRecieve` and a sword slash.
 */
export const PLAYER_CHARACTER: CharacterDef<PlayerAnims> = {
  file: 'cyber_human.glb',
  strip: ['Sword'],
  // The aim overlay slerps ONLY the bones the aim clip actually animates onto the locomotion pose
  // (three tracks are sparse — this pack's clips animate 13-21 bones, not all 25). So the choice here
  // is really "which clip covers the most of UPPER_BONES": measured on the shipped file,
  // `Run_Shoot` covers 11 of 13, `Idle_Gun_Pointing` only 7 (it is a sparse clip: the un-covered
  // left arm would keep swinging its run animation while the right arm aims).
  aimPose: 'CharacterArmature|Run_Shoot',
  anims: {
    idle: 'CharacterArmature|Idle_Neutral',
    run: 'CharacterArmature|Run',
    shoot: 'CharacterArmature|Gun_Shoot',
    death: 'CharacterArmature|Death',
    // The pack ships exactly ONE sword swing, so the alternating pair is the slash plus the closest
    // fast strike it has. (Alternating is about "not looking canned"; two different clips is how the
    // old pack did it, and one clip + a punch still beats the same clip twice in a row.)
    swingA: 'CharacterArmature|Sword_Slash',
    swingB: 'CharacterArmature|Punch_Right',
  },
};

/**
 * Enemy: THE SAME model, tinted hostile red. Why not the pack's robots (「Enemy_2Legs_Gun」 /
 * 「Enemy_Flying_Gun」) — measured, not taste: normalized to the loader's 2.0-unit height their
 * splayed legs/arms make them **6.2-6.4 world units wide**, against an enemy hitbox of radius
 * `CONFIG.enemyR` (a 1.4-unit circle). A visual three times its own hitbox is a shooting-range lie:
 * players would aim at the legs and miss. Scaling the robot down until its width matches the hitbox
 * makes it a 0.5-unit knee-high prop (≈8 screen px) with its health bar floating two units above it.
 * The same model tinted red keeps the real footprint, keeps the full clip set, and keeps the gunner's
 * AIM POSE — which the robots could not provide at all (`aim`/`hit` would have had to stay empty).
 */
export const ENEMY_CHARACTER: CharacterDef<EnemyAnims> = {
  file: 'cyber_human.glb',
  strip: ['Sword'],
  // NO upper-body overlay for the enemy: `render.ts` only blends the aim layer for the PLAYER, so the
  // enemy's gunner telegraph is a full-body STATE clip instead (`anims.aim` below) — which is exactly
  // the right shape for it anyway ("the pose you see is the state that is about to fire").
  aimPose: '',
  // Hostile red. Multiplies the model's own colours (orange jacket -> deep red, grey -> warm), which
  // is the same "red = enemy" language the HUD (red health bar) and the tracers (magenta) already use.
  tint: [1.0, 0.34, 0.30],
  anims: {
    idle: 'CharacterArmature|Idle_Neutral',
    walk: 'CharacterArmature|Walk',
    run: 'CharacterArmature|Run',
    attack: 'CharacterArmature|Sword_Slash',
    hit: 'CharacterArmature|HitRecieve',
    death: 'CharacterArmature|Death',
    aim: 'CharacterArmature|Idle_Gun_Pointing',
    shoot: 'CharacterArmature|Gun_Shoot',
  },
};

/** Every clip name a character's states can ask for, minus the "no clip" entries. */
export function requiredClips<A extends Record<string, string>>(def: CharacterDef<A>): string[] {
  return [...new Set([...Object.values(def.anims), def.aimPose].filter((n): n is string => !!n))];
}
