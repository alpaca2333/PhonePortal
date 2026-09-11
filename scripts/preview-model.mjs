/**
 * Offline MODEL PREVIEWER: render a shipped/prospective .glb (or .gltf + .bin) to a PNG sprite
 * sheet, with no browser, no GPU and no npm dependencies.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every art decision in this repo has been made blind: there is no browser in this environment, so
 * "does the model look right" has always ended up as a 真机确认 item in the README. That is fine for
 * a tint or a shadow, and it is NOT fine for choosing a character model — the last two attempts at
 * that were made from the pack's marketing image and from bounding-box numbers, and the head-size
 * complaint (「大头娃娃」) only got measured, not seen. This script closes that loop: it rasterises
 * the actual file the game loads, from four directions, so a model can be looked at before it ships.
 *
 * WHAT IT IS NOT: a renderer. Skinned meshes are drawn in their BIND POSE (the positions stored in the
 * file — three would apply the skeleton, which at rest is the same picture, and this script has no
 * animation clock), materials are flat-shaded from their glTF baseColorFactor with a lambert term
 * (no textures, no toon ramp, no outline, no shadow, no post). It answers "what shape is this, which
 * way is it facing, what is it holding" — not "what will the game look like".
 *
 * Usage:
 *   node scripts/preview-model.mjs --out sheet.png --size 360 apps/shooter/assets/models/*.glb
 *   (one row per file, four columns: front / left / back / top)
 * Exit code is non-zero when no file could be read.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { globSync } from 'node:fs';

// ---------------------------------------------------------------------------------------------
// glTF reading (dependency-free; same node-TRS math as scripts/lib/glb.mjs)
// ---------------------------------------------------------------------------------------------
const COMPONENT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NUM = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function loadModel(source) {
  const buf = typeof source === 'string' ? readFileSync(source) : source;
  if (buf.readUInt32LE(0) === 0x46546c67) {
    const jsonLength = buf.readUInt32LE(12);
    const json = JSON.parse(buf.subarray(20, 20 + jsonLength).toString('utf8'));
    let offset = 20 + jsonLength, bin = null;
    while (offset + 8 <= buf.length) {
      const length = buf.readUInt32LE(offset), type = buf.readUInt32LE(offset + 4);
      if (type === 0x004e4942) bin = buf.subarray(offset + 8, offset + 8 + length);
      offset += 8 + length + ((4 - (length % 4)) % 4);
    }
    return { json, bin, base: null };
  }
  // .gltf: the buffer is external and sits next to the file
  const json = JSON.parse(buf.toString('utf8'));
  const uri = json.buffers?.[0]?.uri;
  if (!uri) throw new Error('gltf with no external buffer; convert it to .glb first');
  return { json, bin: null, base: source.slice(0, source.lastIndexOf('/') + 1) + uri };
}

function readBin(model) {
  return model.bin ?? readFileSync(model.base);
}

function accessor(json, bin, index) {
  const acc = json.accessors[index];
  const view = json.bufferViews[acc.bufferView];
  const Type = COMPONENT[acc.componentType];
  const n = NUM[acc.type];
  const start = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const stride = view.byteStride ?? n * Type.BYTES_PER_ELEMENT;
  if (stride === n * Type.BYTES_PER_ELEMENT) {
    return { array: new Type(bin.buffer, bin.byteOffset + start, acc.count * n), n, count: acc.count };
  }
  // interleaved: de-interleave into a plain array
  const out = new Type(acc.count * n);
  const dv = new DataView(bin.buffer, bin.byteOffset + start);
  const get = { 5126: 'getFloat32', 5123: 'getUint16', 5125: 'getUint32' }[acc.componentType] ?? 'getFloat32';
  for (let i = 0; i < acc.count; i++) for (let c = 0; c < n; c++) out[i * n + c] = dv[get](i * stride + c * Type.BYTES_PER_ELEMENT, true);
  return { array: out, n, count: acc.count };
}

function compose(t, q, s) {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  const [sx, sy, sz] = s;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    t[0], t[1], t[2], 1,
  ];
}
const mul = (a, b) => {
  const r = new Array(16);
  for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[c * 4 + k];
    r[c * 4 + row] = s;
  }
  return r;
};
const apply = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];

/** Flat triangles in WORLD space, each tagged with its material colour and the node it came from. */
function collectTriangles(model, tint) {
  const { json } = model;
  const bin = readBin(model);
  const parents = new Array(json.nodes.length).fill(-1);
  json.nodes.forEach((node, i) => { for (const child of node.children ?? []) parents[child] = i; });
  const cache = new Map();
  const world = (i) => {
    if (cache.has(i)) return cache.get(i);
    const node = json.nodes[i];
    const local = compose(node.translation ?? [0, 0, 0], node.rotation ?? [0, 0, 0, 1], node.scale ?? [1, 1, 1]);
    const m = parents[i] < 0 ? local : mul(world(parents[i]), local);
    cache.set(i, m);
    return m;
  };
  const tris = [];
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  json.nodes.forEach((node, i) => {
    if (node.mesh === undefined) return;
    const m = world(i);
    for (const prim of json.meshes[node.mesh].primitives) {
      const pos = accessor(json, bin, prim.attributes.POSITION);
      const idx = prim.indices !== undefined ? accessor(json, bin, prim.indices).array : null;
      const mat = json.materials?.[prim.material];
      const base = mat?.pbrMetallicRoughness?.baseColorFactor ?? [0.8, 0.8, 0.8, 1];
      const t = tint;
      const color = [
        Math.min(255, Math.round(255 * Math.pow(Math.min(1, base[0] * t[0]), 1 / 2.2))),
        Math.min(255, Math.round(255 * Math.pow(Math.min(1, base[1] * t[1]), 1 / 2.2))),
        Math.min(255, Math.round(255 * Math.pow(Math.min(1, base[2] * t[2]), 1 / 2.2))),
      ];
      const count = idx ? idx.length : pos.count;
      const vertex = (k) => apply(m, [pos.array[k * 3], pos.array[k * 3 + 1], pos.array[k * 3 + 2]]);
      for (let t = 0; t < count; t += 3) {
        const a = vertex(idx ? idx[t] : t);
        const b = vertex(idx ? idx[t + 1] : t + 1);
        const c = vertex(idx ? idx[t + 2] : t + 2);
        for (const p of [a, b, c]) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
        tris.push({ a, b, c, color, node: node.name, material: mat?.name ?? '' });
      }
    }
  });
  return { tris, lo, hi };
}

// ---------------------------------------------------------------------------------------------
// Rasteriser: orthographic, z-buffered, flat lambert, one light from the camera's upper left
// ---------------------------------------------------------------------------------------------
function renderView(tris, lo, hi, size, dir, up) {
  // Camera basis: `dir` is the view direction (camera looks along it), `up` is the screen up axis.
  const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const d = norm(dir);
  const right = norm([d[2], 0, -d[0]]);              // horizontal, perpendicular to the view
  // screen-up = view direction × right (NOT right × view: that yields a vertically flipped image,
  // which is exactly the bug this line replaced — the first render of the cyberpunk character came
  // out upside-down and read as "the model is lying down").
  const upv = norm([
    d[1] * right[2] - d[2] * right[1],
    d[2] * right[0] - d[0] * right[2],
    d[0] * right[1] - d[1] * right[0],
  ]);
  void up;
  const centre = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  // Fit the projected extent of the bbox corners (so nothing is ever clipped).
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) {
    const p = [x - centre[0], y - centre[1], z - centre[2]];
    const u = p[0] * right[0] + p[1] * right[1] + p[2] * right[2];
    const v = p[0] * upv[0] + p[1] * upv[1] + p[2] * upv[2];
    minU = Math.min(minU, u); maxU = Math.max(maxU, u);
    minV = Math.min(minV, v); maxV = Math.max(maxV, v);
  }
  const span = Math.max(maxU - minU, maxV - minV) * 1.08 || 1;
  const scale = size / span;
  const pix = new Uint8Array(size * size * 3).fill(12);
  const zbuf = new Float32Array(size * size).fill(-Infinity);

  const project = (p) => {
    const q = [p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]];
    const u = q[0] * right[0] + q[1] * right[1] + q[2] * right[2];
    const v = q[0] * upv[0] + q[1] * upv[1] + q[2] * upv[2];
    const w = -(q[0] * d[0] + q[1] * d[1] + q[2] * d[2]);   // depth toward the camera
    return [size / 2 + u * scale, size / 2 - v * scale, w];
  };
  const light = norm([-0.35, 0.7, -0.62]);

  for (const tri of tris) {
    const [ax, ay, az] = project(tri.a);
    const [bx, by, bz] = project(tri.b);
    const [cx, cy, cz] = project(tri.c);
    // face normal in world space -> lambert with a small ambient floor
    const e1 = [tri.b[0] - tri.a[0], tri.b[1] - tri.a[1], tri.b[2] - tri.a[2]];
    const e2 = [tri.c[0] - tri.a[0], tri.c[1] - tri.a[1], tri.c[2] - tri.a[2]];
    let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const nl = Math.hypot(n[0], n[1], n[2]) || 1;
    n = [n[0] / nl, n[1] / nl, n[2] / nl];
    const lam = Math.abs(n[0] * light[0] + n[1] * light[1] + n[2] * light[2]);
    const shade = 0.28 + 0.72 * lam;
    const col = tri.color.map((c) => Math.min(255, Math.round(c * shade)));
    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const maxX = Math.min(size - 1, Math.ceil(Math.max(ax, bx, cx)));
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const maxY = Math.min(size - 1, Math.ceil(Math.max(ay, by, cy)));
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-9) continue;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) / area;
        const w1 = ((px - ax) * (cy - ay) - (py - ay) * (cx - ax)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const depth = w0 * cz + w1 * bz + w2 * az;
        const i = y * size + x;
        if (depth <= zbuf[i]) continue;
        zbuf[i] = depth;
        pix[i * 3] = col[0]; pix[i * 3 + 1] = col[1]; pix[i * 3 + 2] = col[2];
      }
    }
  }
  return { pix, size };
}

// ---------------------------------------------------------------------------------------------
// PNG writing (truecolour, 8-bit, no dependencies beyond zlib)
// ---------------------------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function writePng(path, width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;   // filter: none
    rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0)),
  ]));
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------
const VIEWS = [
  { name: 'front', dir: [0, 0, -1] },     // camera in front, looking at -Z  => shows the model's +Z side
  { name: 'left', dir: [-1, 0, 0] },
  { name: 'back', dir: [0, 0, 1] },
  { name: 'top', dir: [0, -1, 0] },
];

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const size = Number(flag('size', 360)) || 360;
// `--tint r,g,b` renders the model the way characters.ts tints it (a multiplier on each material's
// base colour), so the red enemy can be looked at instead of imagined.
const globalTint = (flag('tint', '') || '').split(',').map(Number).filter((v) => Number.isFinite(v));
const out = flag('out', 'model-preview.png');
const FLAGS = ['--size', '--out', '--tint'];
const flagValues = new Set(FLAGS.map((f) => argv.indexOf(f)).filter((i) => i >= 0).map((i) => i + 1));
const patterns = argv.filter((a, i) => !a.startsWith('--') && !flagValues.has(i));
const files = (patterns.length ? patterns : ['apps/shooter/assets/models/*.glb'])
  .flatMap((p) => (p.includes('*') ? globSync(p) : [p]));
if (files.length === 0) { console.error('no model files matched'); process.exit(1); }

const rows = [];
for (const file of files) {
  // Per-file tint: `name.glb@1,0.34,0.3` renders that model the way characters.ts tints it.
  const at = file.lastIndexOf('@');
  const tintList = at >= 0 ? file.slice(at + 1).split(',').map(Number) : [];
  const modelPath = at >= 0 ? file.slice(0, at) : file;
  const tint = tintList.length === 3 && tintList.every(Number.isFinite) ? tintList
    : globalTint.length === 3 ? globalTint : [1, 1, 1];
  const model = loadModel(modelPath);
  const { tris, lo, hi } = collectTriangles(model, tint);
  const clips = (model.json.animations ?? []).length;
  const wearing = [...new Set(tris.map((t) => `${t.node}[${t.material}]`))].join(' ');
  console.log(`${file}: ${tris.length} triangles, ${(tris.length * 3)} verts-ish, bbox `
    + `x ${lo[0].toFixed(2)}..${hi[0].toFixed(2)} y ${lo[1].toFixed(2)}..${hi[1].toFixed(2)} z ${lo[2].toFixed(2)}..${hi[2].toFixed(2)} `
    + `(h=${(hi[1] - lo[1]).toFixed(2)}) clips=${clips}`);
  console.log('  parts: ' + wearing);
  rows.push(VIEWS.map((v) => renderView(tris, lo, hi, size, v.dir, [0, 1, 0])));
  console.log('  views: ' + VIEWS.map((v) => v.name).join(', '));
}

const sheetW = size * VIEWS.length, sheetH = size * rows.length;
const sheet = Buffer.alloc(sheetW * sheetH * 3).fill(12);
rows.forEach((views, r) => views.forEach((img, c) => {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const src = (y * size + x) * 3;
      const dst = ((r * size + y) * sheetW + c * size + x) * 3;
      sheet[dst] = img.pix[src]; sheet[dst + 1] = img.pix[src + 1]; sheet[dst + 2] = img.pix[src + 2];
    }
  }
}));
writePng(out, sheetW, sheetH, sheet);
console.log(`wrote ${out} (${sheetW}x${sheetH}, rows = files in the order above, columns = ${VIEWS.map((v) => v.name).join('/')})`);
