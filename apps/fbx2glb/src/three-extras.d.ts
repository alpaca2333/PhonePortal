// Ambient additions to the shared `three` shim (apps/shooter/src/three.d.ts declares the rest; TS
// merges the two blocks). Only names THIS app uses are added, and each is added exactly once — a
// repeated `export const` in ambient module scope is a redeclaration error, not a merge.
declare module 'three' {
  /** Used to resolve animation track names against a scene graph (the mixer's own resolver). */
  export const PropertyBinding: any;
  /** Preview: draws the skeleton when 「显示骨骼」 is on. */
  export const SkeletonHelper: any;
  /** Preview: a plain fog so a huge (centimetre) model still reads as a silhouette. */
  export const Fog: any;
  /** Preview: loop mode for the per-clip actions. */
  export const LoopRepeat: any;
}
