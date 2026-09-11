/**
 * Merging several FBX files into ONE scene + clip library — the reason this app exists.
 *
 * The Mixamo reality: the site hands out one FBX per animation (Idle.fbx, Run.fbx, …), while a game
 * wants one self-contained character file carrying all of them (`CharacterDef.file` in the shooter is
 * a single .glb; verify-characters asserts it has no external URIs). Concatenating six FBX files is
 * therefore not a convenience feature — it is the only way to get from A to B without Blender.
 *
 * WHAT "MERGE" MEANS HERE: take the scene graph of ONE base file (the character — the one with a
 * skinned mesh and the most bones) and attach every other file's AnimationClips to it, renaming their
 * track targets through the bone map from rig.ts. Nothing is re-parented, no geometry is combined:
 * the other files contribute ANIMATION ONLY. That is exactly the shape the consumer needs (one
 * skeleton, N clips) and it keeps the merge lossless for the base.
 *
 * REFUSALS ARE LOUD: a file whose skeleton has less than `MIN_RIG_COVERAGE` of the base's bones is
 * skipped, and the reason is reported in the UI instead of producing a GLB with dead clips. Dropping
 * clips is recoverable; shipping a file that silently plays nothing is not.
 */
import * as THREE from 'three';
import { boneNamesOf } from './analyze.js';
import { checkRig, deriveBoneMap, remapTrackName } from './rig.js';
import { planClipNames, type ClipNameSource } from './names.js';
import type { ClipNameMode } from './settings.js';

/** One parsed FBX file. */
export interface LoadedFbx {
  /** Original file name (used for clip naming and the report). */
  file: string;
  /** The parsed scene graph (a Group from FBXLoader). */
  root: any;
  /** Its clips, in file order. */
  clips: any[];
}

export interface MergeOutcome {
  /** The scene to export. */
  root: any;
  /** All clips, renamed, with their tracks remapped onto the base rig. */
  clips: any[];
  /** The index (into the input array) of the file that supplied the scene graph. */
  baseIndex: number;
  /** Input indices whose clips were attached. */
  accepted: number[];
  /** Input indices that were refused (rig mismatch), with `warnings` explaining why. */
  skipped: number[];
  /** Human-readable notes for the log / report. */
  warnings: string[];
}

/**
 * How much of an incoming skeleton must exist in the base rig before its clips are attached.
 * 50% is deliberately permissive (a partly-supported rig still animates most of the body) but far
 * above the ~0% a genuinely different character pack scores.
 */
export const MIN_RIG_COVERAGE = 0.5;

/** How much of a rig a file must contribute to be considered "the character" for merging purposes. */
function baseScore(input: LoadedFbx): number {
  let skinned = 0;
  input.root?.traverse?.((o: any) => { if (o.isSkinnedMesh) skinned++; });
  // A skinned mesh is worth more than any number of extra bones: the character file is the one whose
  // mesh must be kept, and only that file can be the base of the merge.
  return (skinned > 0 ? 1_000_000 : 0) + boneNamesOf(input.root).length;
}

/** Pick the scene graph to keep: the file with a skinned mesh and the most bones (ties → first). */
export function pickBase(inputs: readonly LoadedFbx[]): number {
  let best = 0;
  let bestScore = -1;
  inputs.forEach((input, i) => {
    const score = baseScore(input);
    if (score > bestScore) { bestScore = score; best = i; }
  });
  return best;
}

/** Clone a clip with its track targets renamed through `map` (tracks that do not map are kept). */
function retargetClip(clip: any, map: ReadonlyMap<string, string>): any {
  const tracks = (clip?.tracks ?? []).map((t: any) => {
    const renamed = remapTrackName(t?.name ?? "", map);
    if (renamed === t?.name) return t;
    const clone = typeof t.clone === 'function' ? t.clone() : t;
    clone.name = renamed;
    return clone;
  });
  return new THREE.AnimationClip(String(clip?.name ?? ""), Number(clip?.duration ?? -1), tracks);
}

/** Rename one file's clips (used by both the merge path and the one-file-per-output path). */
export function nameClipsForFile(file: string, clips: readonly any[], mode: ClipNameMode): string[] {
  const sources: ClipNameSource[] = clips.map((c) => ({ file, clip: String(c?.name ?? "") }));
  return planClipNames(sources, mode);
}

/**
 * Copy `clips` with new names (same tracks, no retargeting) — the non-merged path: each file keeps its
 * own scene, but its clips still get the naming rules applied.
 */
export function renameClips(clips: readonly any[], names: readonly string[]): any[] {
  return clips.map((clip, i) => new THREE.AnimationClip(
    String(names[i] ?? clip?.name ?? ""),
    Number(clip?.duration ?? -1),
    [...(clip?.tracks ?? [])],
  ));
}

/**
 * Merge `inputs` into one exported scene. `inputs` must be non-empty; a single input is a valid
 * (trivial) merge that still applies the clip renames.
 */
export function mergeScenes(inputs: readonly LoadedFbx[], mode: ClipNameMode): MergeOutcome {
  if (inputs.length === 0) {
    return { root: new THREE.Group(), clips: [], baseIndex: 0, accepted: [], skipped: [], warnings: ['没有可合并的文件'] };
  }
  const baseIndex = pickBase(inputs);
  const base = inputs[baseIndex]!;
  const baseBones = boneNamesOf(base.root);

  const warnings: string[] = [];
  const accepted: number[] = [baseIndex];
  const skipped: number[] = [];
  const maps = new Map<number, Map<string, string>>();
  maps.set(baseIndex, new Map(baseBones.map((b) => [b, b])));

  if (inputs.length > 1) {
    warnings.push(`以「${base.file}」为角色本体（骨架 ${baseBones.length} 根骨骼）`);
    if (baseIndex !== 0) warnings.push(`注意：它不是列表里的第一个文件`);
  }

  inputs.forEach((input, i) => {
    if (i === baseIndex) return;
    const bones = boneNamesOf(input.root);
    const check = checkRig(baseBones, bones);
    if (check.coverage < MIN_RIG_COVERAGE) {
      skipped.push(i);
      warnings.push(
        `跳过「${input.file}」：骨架不匹配（${check.matched}/${check.total} 根骨骼能在角色上找到，` +
        `需要 ≥ ${Math.round(MIN_RIG_COVERAGE * 100)}%）`,
      );
      return;
    }
    accepted.push(i);
    const { map, unmatchedExtra, remapped } = deriveBoneMap(baseBones, bones);
    maps.set(i, map);
    if (check.total > 0 && unmatchedExtra.length > 0) {
      warnings.push(`「${input.file}」有 ${unmatchedExtra.length} 根骨骼在角色上找不到，相关轨道可能不会播放`);
    }
    if (remapped.length > 0) {
      warnings.push(`「${input.file}」重映射了 ${remapped.length} 个骨骼名（例如 ${remapped[0]!.from} → ${remapped[0]!.to}）`);
    }
  });

  // Name every accepted clip across ALL accepted files at once, so two files with the same base name
  // (or two takes called `mixamo.com`) cannot produce two clips with the same name.
  const sources: ClipNameSource[] = [];
  for (const i of accepted) {
    for (const c of inputs[i]!.clips) sources.push({ file: inputs[i]!.file, clip: String(c?.name ?? "") });
  }
  const names = planClipNames(sources, mode);

  const clips: any[] = [];
  let n = 0;
  for (const i of accepted) {
    const map = maps.get(i)!;
    for (const clip of inputs[i]!.clips) {
      const retargeted = retargetClip(clip, map);
      retargeted.name = names[n]!;
      clips.push(retargeted);
      n++;
    }
  }

  if (clips.length === 0) warnings.push('这些文件里没有任何动画片段（只导出模型）');
  return { root: base.root, clips, baseIndex, accepted, skipped, warnings };
}
