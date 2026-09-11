/**
 * Shared, node-aware .glb reader for the Node-side verification scripts.
 *
 * WHY THIS EXISTS (the pitfall it encodes): a glTF mesh's POSITION accessor bounds are in the
 * MESH's local space. What the browser draws is those positions pushed through the node hierarchy's
 * TRS chain. Kenney's kits put real transforms on those nodes — 11 of the 49 props in
 * apps/shooter/assets/props/ have a scale (pottedPlant's pot is 2x, plantSmall is 0.5x), a rotation
 * (bedDouble/washerDryerStacked) or both on a child node. Measuring the raw accessor min/max — which
 * is what `scripts/verify-props.mjs` used to do, and how the catalog's numbers were originally
 * taken — therefore reports a size the renderer never draws: it over-reported the desk, the bed and
 * the trashcan by up to 2x, and under-reported the fridge's depth by 5%, i.e. it made the catalog
 * claim a containment guarantee it was not actually checking.
 *
 * The triangles are returned in the space the RENDERER draws them in, which is not the authored
 * space: assets.ts::loadPropGeometry recentres every prop on its footprint centre and stands it on
 * y = 0 (see normalizeProp there — the kit's origins are at a footprint corner, and a few props are
 * authored sunk). Measuring or casting with raw coordinates would therefore describe geometry that
 * never appears on screen, so the same recentring is applied here.
 *
 * The same geometry is needed by scripts/verify-shadow.mjs, which rasterises the arena into a
 * simulated shadow map, so both scripts import this one reader: the sizes the catalog is asserted
 * against and the triangles the shadow test casts with are then the same data by construction.
 *
 * Deliberately dependency-free (no three.js import): the glTF subset here is what these assets use
 * (a GLB container, TRS-only nodes, non-interleaved float POSITION, indexed or non-indexed
 * primitives, index widths 8/16/32).
 */

import { readFileSync } from 'node:fs';

const COMPONENT = {
  5120: Int8Array, 5121: Uint8Array, 5122: Int16Array,
  5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array,
};
const NUM_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

/** three's Matrix4.compose: column-major 4x4 array from translation/rotation/scale. */
function compose(t, q, s) {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const [sx, sy, sz] = s;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    t[0], t[1], t[2], 1,
  ];
}

/** three's Matrix4.multiplyMatrices(a, b), column-major. */
function mul(a, b) {
  const r = new Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      r[col * 4 + row] = a[row] * b[col * 4] + a[4 + row] * b[col * 4 + 1]
        + a[8 + row] * b[col * 4 + 2] + a[12 + row] * b[col * 4 + 3];
    }
  }
  return r;
}


function parseContainer(buf) {
  if (buf.length < 20 || buf.readUInt32LE(0) !== GLB_MAGIC) return null;
  const jsonLen = buf.readUInt32LE(12);
  if (buf.readUInt32LE(16) !== CHUNK_JSON) return null;
  const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
  let bin = null;
  for (let off = 20 + jsonLen; off + 8 <= buf.length;) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    if (type === CHUNK_BIN) bin = buf.subarray(off + 8, off + 8 + len);
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  return { json, bin };
}

/**
 * Read one .glb.
 *
 * @returns null when the file is not a readable GLB, otherwise:
 *   triangles  flat Float64Array, 9 numbers per triangle, in the space the renderer draws: node
 *              transforms applied, footprint centred on the origin, base on y = 0, units = Kenney
 *              units (i.e. matched to assets.ts::loadPropGeometry);
 *   size/lo/hi the bounding box of that triangle soup (size is translation-invariant, so it is also
 *              the model's natural size);
 *   offset     the translation applied to get from the authored coordinates to the rendered ones
 *              (must equal props.ts::propNormalizeOffset of authoredLo/authoredHi);
 *   authoredLo/authoredHi  the bounds before that shift, for that assertion;
 *   triCount   triangles after node transforms;
 *   textured   primitives carrying a baseColorTexture; images: embedded image count;
 *   baseColors the LINEAR baseColorFactor of every primitive's material (glTF stores them linear,
 *              and so does the renderer) — lets a test prove that a theme tint is doing real work;
 *   bytes      file size.
 */
export function readGlb(source) {
  const buf = typeof source === 'string' ? readFileSync(source) : source;
  const parsed = parseContainer(buf);
  if (parsed === null) return null;
  const { json, bin } = parsed;
  const accessor = (index) => {
    const acc = json.accessors[index];
    const view = json.bufferViews[acc.bufferView];
    const Type = COMPONENT[acc.componentType];
    const n = NUM_COMPONENTS[acc.type];
    const base = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    return { arr: new Type(bin.buffer, bin.byteOffset + base, acc.count * n), n, count: acc.count };
  };

  // World matrix per node: a glTF node's transform is its own TRS, then its parents', then the
  // scene root's (three composes parent * child, see Matrix4.compose/multiplyMatrices above).
  const parents = new Array((json.nodes ?? []).length).fill(-1);
  (json.nodes ?? []).forEach((node, i) => {
    for (const child of node.children ?? []) parents[child] = i;
  });
  const worldCache = new Map();
  const worldOf = (index) => {
    if (worldCache.has(index)) return worldCache.get(index);
    const node = json.nodes[index];
    const local = compose(node.translation ?? [0, 0, 0], node.rotation ?? [0, 0, 0, 1], node.scale ?? [1, 1, 1]);
    const parent = parents[index];
    const world = parent < 0 ? local : mul(worldOf(parent), local);
    worldCache.set(index, world);
    return world;
  };

  const roots = json.scenes?.[json.scene ?? 0]?.nodes ?? (json.nodes ?? []).map((_, i) => i);
  const tri = [];
  const baseColors = [];
  let triCount = 0;
  let textured = 0;
  const eachMesh = (index, visit) => {
    const node = json.nodes[index];
    if (node.mesh !== undefined) visit(json.meshes[node.mesh], worldOf(index));
    for (const child of node.children ?? []) eachMesh(child, visit);
  };
  for (const root of roots) {
    eachMesh(root, (mesh, m) => {
      for (const prim of mesh.primitives ?? []) {
        const material = prim.material !== undefined ? json.materials?.[prim.material] : undefined;
        if (material?.pbrMetallicRoughness?.baseColorTexture !== undefined) textured++;
        const factor = material?.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1, 1];
        baseColors.push([factor[0], factor[1], factor[2]]);
        const pos = accessor(prim.attributes.POSITION);
        const idx = prim.indices !== undefined ? accessor(prim.indices) : null;
        const count = idx ? idx.count : pos.count;
        for (let i = 0; i + 2 < count; i += 3) {
          for (let k = 0; k < 3; k++) {
            const v = idx ? idx.arr[i + k] : i + k;
            const x = pos.arr[v * 3], y = pos.arr[v * 3 + 1], z = pos.arr[v * 3 + 2];
            tri.push(
              m[0] * x + m[4] * y + m[8] * z + m[12],
              m[1] * x + m[5] * y + m[9] * z + m[13],
              m[2] * x + m[6] * y + m[10] * z + m[14],
            );
          }
          triCount++;
        }
      }
    });
  }
  if (triCount === 0) return null;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tri.length; i++) {
    const axis = i % 3;
    if (tri[i] < lo[axis]) lo[axis] = tri[i];
    if (tri[i] > hi[axis]) hi[axis] = tri[i];
  }
  const size = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  // Same recentring assets.ts::normalizeProp applies: centre the footprint, stand it on y = 0.
  const authoredLo = lo.slice();
  const authoredHi = hi.slice();
  const offset = [-(lo[0] + hi[0]) / 2, -lo[1], -(lo[2] + hi[2]) / 2];
  for (let i = 0; i < tri.length; i++) tri[i] += offset[i % 3];
  const nlo = [lo[0] + offset[0], lo[1] + offset[1], lo[2] + offset[2]];
  const nhi = [hi[0] + offset[0], hi[1] + offset[1], hi[2] + offset[2]];
  return {
    triangles: Float64Array.from(tri), size, lo: nlo, hi: nhi, offset, authoredLo, authoredHi, triCount,
    baseColors, textured, images: (json.images ?? []).length, bytes: buf.length,
  };
}

