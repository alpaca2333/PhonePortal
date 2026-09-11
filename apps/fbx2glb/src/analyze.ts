/**
 * Scene analysis for the report the user sees — uses three (world matrices, bounding boxes), but no
 * DOM, so scripts/verify-fbx2glb.mjs can run it on a synthetic scene and on the real sample.fbx.
 *
 * WHY A REPORT AT ALL: this app's output is an invisible binary. The only way to know whether a
 * conversion did the right thing — before handing the file to a game — is to print what is actually
 * inside: how many bones, how tall the model came out, what the clips are called, and above all
 * whether every animation track RESOLVES to a node in the exported scene. That last number is the
 * one that catches the silent failure described in rig.ts (a merged clip whose tracks name bones the
 * character does not have plays nothing, and reports no error anywhere).
 */
import * as THREE from 'three';
import { splitTrackName } from './rig.js';

export interface ClipInfo {
  name: string;
  /** Seconds; `-1` from the loader becomes the real duration after `resetDuration()`. */
  duration: number;
  tracks: number;
  /** Track names that do not resolve to a node in the scene (see `unboundTracks`). */
  unbound: string[];
}

export interface SceneReport {
  nodes: number;
  meshes: number;
  skinned: number;
  bones: number;
  materials: number;
  textures: number;
  vertices: number;
  triangles: number;
  /** Bounding-box extent in world units (Y = height), before any export scaling. */
  size: { x: number; y: number; z: number };
  /** Sorted bone names, for the rig-compatibility check of a later merge. */
  boneNames: string[];
  clips: ClipInfo[];
}

/** Every Bone in the graph, in traversal order. */
export function collectBones(root: any): any[] {
  const out: any[] = [];
  root?.traverse?.((o: any) => { if (o.isBone) out.push(o); });
  return out;
}

/** Sorted (stable, locale-free) bone names — the identity of a rig. */
export function boneNamesOf(root: any): string[] {
  return collectBones(root).map((b) => String(b.name ?? "")).sort();
}

/**
 * World-space bounding-box size of everything with geometry.
 *
 * ⚠️ WHY THIS IS HAND-ROLLED INSTEAD OF `new Box3().setFromObject(root)` — a real trap found by
 * scripts/verify-fbx2glb.mjs. In three r160 a SkinnedMesh owns a CACHED `boundingBox`, and
 * `SkinnedMesh.computeBoundingBox()` computes it through `getVertexPosition()`, i.e. through
 * `bone.matrixWorld` — so the result is already in WORLD space. `Box3.expandByObject()` then
 * multiplies it by `object.matrixWorld` a second time. For an unscaled hierarchy that is invisible
 * (identity), but for a model under any scaled/translated parent the height comes out
 * `scale²`-ish: a 1.6-unit character exported ×0.01 measured 0.00016 instead of 0.016, which is
 * exactly the "did my units come out right?" question this report exists to answer.
 *
 * The rest-pose geometry box times the node's world matrix is what we actually mean here ("how big is
 * the model as authored/placed"), and it is the same measure the shooter's `normalizeModel()` uses.
 * Taking the REST pose on purpose also keeps the report stable while an animation plays.
 */
export function measureSize(root: any): { x: number; y: number; z: number } {
  const box = new THREE.Box3();
  if (!root) return { x: 0, y: 0, z: 0 };
  root.updateMatrixWorld?.(true);
  const local = new THREE.Box3();
  root.traverse?.((o: any) => {
    const geometry = o.geometry;
    if (!geometry) return;
    if (!geometry.boundingBox) geometry.computeBoundingBox?.();
    if (!geometry.boundingBox) return;
    local.copy(geometry.boundingBox).applyMatrix4(o.matrixWorld);
    box.union(local);
  });
  if (box.isEmpty() || !Number.isFinite(box.min.x) || !Number.isFinite(box.max.x)) {
    return { x: 0, y: 0, z: 0 };
  }
  const size = new THREE.Vector3();
  box.getSize(size);
  return { x: size.x, y: size.y, z: size.z };
}

/**
 * Track names of a clip that do not resolve to a node in `root`. Uses three's own
 * `PropertyBinding.findNode` — the exact resolver `AnimationMixer` uses when binding — so this is
 * not an approximation of "will it play", it is the same question asked early. Non-node tracks
 * (`.morphTargetInfluences` is a node track; anything else) are counted as bound so they cannot
 * produce false alarms.
 */
export function unboundTracks(root: any, clip: any): string[] {
  const out: string[] = [];
  for (const track of clip?.tracks ?? []) {
    const parts = splitTrackName(track?.name ?? "");
    if (!parts) continue;
    let node: any = null;
    try {
      node = THREE.PropertyBinding.findNode(root, parts.node);
    } catch {
      node = null;
    }
    if (!node) out.push(track.name);
  }
  return out;
}

/** One clip → its summary row (duration is recomputed from the tracks when the loader says -1). */
export function describeClip(root: any, clip: any): ClipInfo {
  let duration = Number(clip?.duration);
  if (!Number.isFinite(duration) || duration < 0) {
    duration = 0;
    for (const t of clip?.tracks ?? []) {
      const times = t?.times;
      if (times && times.length > 0) duration = Math.max(duration, times[times.length - 1] ?? 0);
    }
  }
  return {
    name: String(clip?.name ?? ""),
    duration,
    tracks: clip?.tracks?.length ?? 0,
    unbound: unboundTracks(root, clip),
  };
}

/** The full report shown under a converted file (and asserted by the verify script). */
export function describeScene(root: any, clips: readonly any[] = []): SceneReport {
  let nodes = 0, meshes = 0, skinned = 0, bones = 0, materials = 0, textures = 0, vertices = 0, triangles = 0;
  const materialSet = new Set<any>();
  const textureSet = new Set<any>();
  root?.traverse?.((o: any) => {
    nodes++;
    if (o.isBone) bones++;
    if (o.isMesh) {
      meshes++;
      const geo = o.geometry;
      const pos = geo?.attributes?.position;
      if (pos) vertices += Math.floor(pos.count);
      if (geo?.index) triangles += Math.floor(geo.index.count / 3);
      else if (pos) triangles += Math.floor(pos.count / 3);
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (!m) continue;
        materialSet.add(m);
        for (const key of Object.keys(m)) {
          const v = (m as any)[key];
          if (v && v.isTexture) textureSet.add(v);
        }
      }
    }
    if (o.isSkinnedMesh) skinned++;
  });
  materials = materialSet.size;
  textures = textureSet.size;
  return {
    nodes, meshes, skinned, bones, materials, textures, vertices, triangles,
    size: measureSize(root),
    boneNames: boneNamesOf(root),
    clips: (clips ?? []).map((c) => describeClip(root, c)),
  };
}
