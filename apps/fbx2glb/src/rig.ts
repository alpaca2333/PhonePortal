/**
 * Bone-name matching for merging several FBX files into one GLB — PURE string work, no three.js.
 *
 * THE PROBLEM: three's AnimationMixer binds an animation track to a node BY NAME. So merging clips
 * from file B onto the character from file A only works if B's tracks name the same nodes A has. Two
 * Mixamo downloads of the same character do (`mixamorigHips` …), but re-exports drift — Blender adds
 * `.001` (`Hips001` after three's sanitizer), a second Mixamo rig is `mixamorig5Hips`, Maya gives
 * `Hips_1`. A blind concatenation "succeeds" (the GLB is valid, the clips are in it) and then plays
 * NOTHING on the consumer side: three silently ignores tracks whose node it cannot resolve. That
 * failure has no error message anywhere, which is why it gets a whole module and a test.
 *
 * THE RULE: match exactly first, then fall back to a normalised "core" name (lowercase, letters and
 * digits only, digits dropped): `mixamorig5Hips` → `mixamorighips`, `Hips001` → `hips`. A core is
 * only used when it identifies exactly ONE unused bone on each side — `Spine1`/`Spine2` both
 * normalise to `spine`, and mapping them by core would silently bind the wrong bone, so ambiguity is
 * reported instead of guessed.
 */

/** Normalised comparison key: lowercase, drop every non-alphanumeric (CJK kept), drop digits. */
export function coreName(name: string): string {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .replace(/\d+/g, "");
}

/** `<node>.<property>` — the property half of a three animation track name. */
const TRACK_SUFFIX = /\.(position|quaternion|scale|morphTargetInfluences(?:\[\d+\])?)$/;

/** Split a track name into the animated node's name and the property suffix (null if not a node track). */
export function splitTrackName(trackName: string): { node: string; property: string } | null {
  const name = String(trackName ?? "");
  const m = TRACK_SUFFIX.exec(name);
  if (!m) return null;
  const property = m[1]!;
  return { node: name.slice(0, name.length - m[0].length), property };
}

export interface BoneMapResult {
  /** extra-name → base-name, including the exact matches (identity entries). */
  map: Map<string, string>;
  /** Extra bones that matched a base bone by exact name. */
  identity: string[];
  /** Extra bones that needed normalisation, with what they were matched to. */
  remapped: { from: string; to: string }[];
  /** Extra bones with no counterpart in the base rig. */
  unmatchedExtra: string[];
  /** Core names that were ambiguous on either side (mapping refused on purpose). */
  ambiguous: string[];
}

/**
 * Build the extra→base bone-name map. `baseNames` come from the character that will be exported,
 * `extraNames` from the file whose clips are being attached.
 */
export function deriveBoneMap(baseNames: readonly string[], extraNames: readonly string[]): BoneMapResult {
  const baseSet = new Set(baseNames);
  const map = new Map<string, string>();
  const identity: string[] = [];
  const remapped: { from: string; to: string }[] = [];
  const unmatchedExtra: string[] = [];
  const ambiguous: string[] = [];

  // 1. exact name matches: never second-guessed
  const pending: string[] = [];
  for (const extra of extraNames) {
    if (baseSet.has(extra)) {
      map.set(extra, extra);
      identity.push(extra);
    } else {
      pending.push(extra);
    }
  }

  // 2. normalised matches, only where the core identifies exactly one bone on each side
  const coreOf = (names: readonly string[]): Map<string, string[]> => {
    const groups = new Map<string, string[]>();
    for (const n of names) {
      const c = coreName(n);
      if (c.length === 0) continue;
      const list = groups.get(c);
      if (list) list.push(n);
      else groups.set(c, [n]);
    }
    return groups;
  };
  const usedBase = new Set(identity);
  const baseCores = coreOf(baseNames.filter((n) => !usedBase.has(n)));
  const extraCores = coreOf(pending);
  for (const extra of pending) {
    const c = coreName(extra);
    const baseCandidates = (baseCores.get(c) ?? []).filter((n) => !usedBase.has(n));
    const extraCandidates = extraCores.get(c) ?? [];
    if (baseCandidates.length === 1 && extraCandidates.length === 1) {
      const to = baseCandidates[0]!;
      map.set(extra, to);
      usedBase.add(to);
      remapped.push({ from: extra, to });
    } else {
      unmatchedExtra.push(extra);
      if (baseCandidates.length > 1 || extraCandidates.length > 1) ambiguous.push(c);
    }
  }

  return { map, identity, remapped, unmatchedExtra, ambiguous: [...new Set(ambiguous)] };
}

/** Rename a track to its base-rig node name; returns the original name when it is not node-mapped. */
export function remapTrackName(trackName: string, map: ReadonlyMap<string, string>): string {
  const parts = splitTrackName(trackName);
  if (!parts) return trackName;
  const mapped = map.get(parts.node);
  if (mapped === undefined || mapped === parts.node) return trackName;
  return mapped + "." + parts.property;
}

export interface RigCheck {
  /** How many bones the incoming file declares. */
  total: number;
  /** How many of them exist in the base rig (exact or normalised). */
  matched: number;
  /** matched / total, 1 when the file has no bones at all. */
  coverage: number;
  /** Bones that will not animate anything on the base rig. */
  unmatched: string[];
}

/**
 * How much of an incoming file's skeleton exists in the base rig. A file with no bones at all counts
 * as fully covered: its clips may still target plain objects (a camera move, a prop spin), which the
 * caller accepts and reports separately.
 */
export function checkRig(baseNames: readonly string[], extraNames: readonly string[]): RigCheck {
  if (extraNames.length === 0) return { total: 0, matched: 0, coverage: 1, unmatched: [] };
  const { unmatchedExtra, map } = deriveBoneMap(baseNames, extraNames);
  const matched = extraNames.length - unmatchedExtra.length;
  return { total: extraNames.length, matched, coverage: matched / extraNames.length, unmatched: unmatchedExtra };
}
