/**
 * CPU-side verification for the shooter's user settings (joystick geometry + camera framing).
 *
 * There is no browser in this environment, so the *interactive* part of the settings panel can
 * only be confirmed on a device. What CAN be proven here is the part that actually decides
 * whether the controls keep working after a resize:
 *
 *   1. stick.ts  — travel/offset/direction math is size independent: |dir| <= 1 for any size,
 *                  exactly 1 at the rim, 0 at the centre, and the classic 148px feel (62.16px)
 *                  is unchanged.
 *   2. camera.ts — the 「摄像机高度」 multiplier reproduces the reference framing exactly at 1x
 *                  ({height:24, back:15}), and height/distance/pitch move monotonically with it.
 *   3. settings.ts — defaults are the intended ones (portrait 148/26 = the old CSS; landscape
 *                  min(96px,18vh)/8 = the current tuned default; camera 1.0x in both
 *                  orientations), overrides merge sparsely, out-of-range values are clamped so a
 *                  stick can never leave the screen, and unknown keys survive a save.
 *   4. lighting.ts — the 「环境光」 multiplier is linear on the base intensity, is clamped so a
 *                  dirty value can never reach the light, and the top of its range reproduces the
 *                  pre-change hardcoded 1.05 exactly (i.e. the change is reversible by the user).
 *   5. fog.ts     — the 「高度雾」 density: the shipped default is inside the range and well below the
 *                  max, 0 is an exact off switch, and dirty data falls back to the default instead of
 *                  throwing or reaching the shader (the GLSL side is scripts/verify-fog.mjs).
 *   6. grade.ts / vignette.ts — the 「调色」 keys: same sparse/clamp contract, both 0 = unprocessed
 *                  (a real rollback, not "a bit less"), and the leaf modules own the ranges
 *                  (the maths and the shader patch are scripts/verify-tone.mjs).
 *
 * Run:  npm run build && node scripts/verify-stick.mjs
 * Exit code is non-zero when any assertion fails.
 */
const STICK = new URL('../dist/apps/shooter/src/stick.js', import.meta.url);
const CAMERA = new URL('../dist/apps/shooter/src/camera.js', import.meta.url);
const SETTINGS = new URL('../dist/apps/shooter/src/settings.js', import.meta.url);

const { TRAVEL_RATIO, MIN_TRAVEL, AIM_DEADZONE, travelForSize, stickOffset, dirFromOffset, isManualAim } =
  await import(STICK.href);
const C = await import(CAMERA.href);
const S = await import(SETTINGS.href);

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail ? ' — ' + detail : ''));
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const len = (v) => Math.hypot(v.x, v.y);
/** Compare layouts by field, not by JSON key order. */
const sameLayout = (a, b) =>
  S.STICK_KEYS.every((k) => a[k] === b[k]) && Object.keys(a).length === Object.keys(b).length;

// ---------------------------------------------------------------- stick.ts
check('TRAVEL_RATIO is 0.42', TRAVEL_RATIO === 0.42);
check('MIN_TRAVEL is 8', MIN_TRAVEL === 8);
check('travelForSize(148) = 62.16 (old hardcoded feel)', near(travelForSize(148), 62.16), String(travelForSize(148)));
check('travelForSize(112) = 47.04', near(travelForSize(112), 47.04), String(travelForSize(112)));
check('travelForSize(0) floors at MIN_TRAVEL', travelForSize(0) === 8);
check('travelForSize(10) floors at MIN_TRAVEL', travelForSize(10) === 8);

const SIZES = [64, 84, 112, 148, 200, 240];
const ANGLES = [0, 0.5, 1, Math.PI / 2, 2, Math.PI, -1.2, -Math.PI + 0.01];
let monotonicOk = true, rimOk = true, beyondOk = true, centerOk = true, boundedOk = true, dirOk = true;

for (const size of SIZES) {
  const travel = travelForSize(size);
  const cx = 100 + size / 2;
  const cy = 200 + size / 2;

  // centre -> zero vector, zero direction
  const off0 = stickOffset(cx, cy, cx, cy, travel);
  const dir0 = dirFromOffset(off0, travel);
  if (!near(len(off0), 0) || !near(len(dir0), 0)) centerOk = false;

  // monotonically increasing length until the rim, then clamped
  let prev = -1;
  for (let f = 0; f <= 1.0001; f += 0.05) {
    const off = stickOffset(cx, cy, cx + travel * f, cy, travel);
    const l = len(off);
    if (l + 1e-12 < prev) monotonicOk = false;
    prev = l;
  }

  for (const a of ANGLES) {
    const cos = Math.cos(a), sin = Math.sin(a);
    // exactly at the rim: length == travel, direction == unit
    const rim = stickOffset(cx, cy, cx + travel * cos, cy + travel * sin, travel);
    const rimDir = dirFromOffset(rim, travel);
    if (!near(len(rim), travel, 1e-9) || !near(len(rimDir), 1, 1e-9)) rimOk = false;
    if (!near(Math.atan2(rimDir.y, rimDir.x) - a, 0, 1e-9)) dirOk = false;

    // far beyond the rim: still clamped to the rim
    const far = stickOffset(cx, cy, cx + travel * 3 * cos, cy + travel * 3 * sin, travel);
    if (!near(len(far), travel, 1e-9)) beyondOk = false;
    if (len(dirFromOffset(far, travel)) > 1 + 1e-9) boundedOk = false;
  }
}
check('centre reports zero offset and zero direction', centerOk);
check('offset length is monotonic in pointer distance', monotonicOk);
check('rim pointer yields length == travel and |dir| == 1', rimOk);
check('pointer beyond the rim stays clamped to travel', beyondOk);
check('|dir| never exceeds 1', boundedOk);
check('direction angle matches the pointer angle', dirOk);

// pseudo-random sweep: the hard invariant, checked on 5000 samples
let seed = 0x1234abcd;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
let sweepOk = true;
for (let i = 0; i < 5000; i++) {
  const size = 48 + rnd() * 192;
  const travel = travelForSize(size);
  const px = (rnd() - 0.5) * size * 4;
  const py = (rnd() - 0.5) * size * 4;
  const off = stickOffset(0, 0, px, py, travel);
  const dir = dirFromOffset(off, travel);
  if (len(off) > travel + 1e-9 || len(dir) > 1 + 1e-9) sweepOk = false;
}
check('5000 random samples: |offset| <= travel and |dir| <= 1', sweepOk);

// ---------------------------------------------------------------- right-stick auto-aim deadzone
check('AIM_DEADZONE is 0.6 (double the old 0.3)', AIM_DEADZONE === 0.6, String(AIM_DEADZONE));
check('centre and small pushes stay in auto-aim',
  !isManualAim({ x: 0, y: 0 }) && !isManualAim({ x: 0.3, y: 0 }) && !isManualAim({ x: 0.4, y: 0.4 }) &&
  !isManualAim({ x: 0.59, y: 0 }) && !isManualAim({ x: 0.6, y: 0 }));
check('pushes past the deadzone aim manually',
  isManualAim({ x: 0.61, y: 0 }) && isManualAim({ x: 1, y: 0 }) && isManualAim({ x: 0, y: -0.8 }) &&
  isManualAim({ x: 0.5, y: 0.5 }));
check('deadzone is direction independent (length, not axis)',
  isManualAim({ x: -0.7, y: 0 }) === isManualAim({ x: 0, y: 0.7 }) &&
  isManualAim({ x: 0, y: 0.7 }) === true);
{
  // tie the fraction to real pixels: at 0.6x travel the stick must still auto-aim, at 0.61x not
  const size = 148, travel = travelForSize(size);
  const dirAt = (f) => dirFromOffset(stickOffset(0, 0, travel * f, 0, travel), travel);
  check('0.6x travel = auto-aim, 0.61x travel = manual (in px too)',
    !isManualAim(dirAt(0.6)) && isManualAim(dirAt(0.61)));
}

// ---------------------------------------------------------------- settings.ts
const portraitVp = { width: 400, height: 800 };
const landscapeVp = { width: 800, height: 400 };

check('orientationOf(800,400) = landscape', S.orientationOf(800, 400) === 'landscape');
check('orientationOf(400,800) = portrait', S.orientationOf(400, 800) === 'portrait');
check('orientationOf(500,500) = portrait', S.orientationOf(500, 500) === 'portrait');

const dp = S.defaultsFor('portrait', portraitVp);
const dl = S.defaultsFor('landscape', landscapeVp);
check('portrait defaults = 148 / 26 (old CSS)', sameLayout(dp, { sizePx: 148, leftX: 26, leftY: 26, rightX: 26, rightY: 26 }), JSON.stringify(dp));
check('landscape defaults = min(96,18vh)=72 / 8', sameLayout(dl, { sizePx: 72, leftX: 8, leftY: 8, rightX: 8, rightY: 8 }), JSON.stringify(dl));
check('landscape default caps at 96 on tall viewports', S.defaultsFor('landscape', { width: 900, height: 900 }).sizePx === 96);

check('createState(null) = {}', JSON.stringify(S.createState(null)) === '{}');
check('createState([1]) = {}', JSON.stringify(S.createState([1])) === '{}');
check('createState("x") = {}', JSON.stringify(S.createState('x')) === '{}');

// sparse merge: untouched keys keep following the default
const raw = S.createState({ stick: { landscape: { sizePx: 96 } } });
const eff = S.effectiveFor(raw, 'landscape', landscapeVp);
check('override merges sparsely (size 96, insets stay 8)', sameLayout(eff, { sizePx: 96, leftX: 8, leftY: 8, rightX: 8, rightY: 8 }), JSON.stringify(eff));
check('portrait is unaffected by a landscape override', S.effectiveFor(raw, 'portrait', portraitVp).sizePx === 148);
check('hasStickOverrides true for landscape / false for portrait', S.hasStickOverrides(raw, 'landscape') && !S.hasStickOverrides(raw, 'portrait'));

// clamping: nothing may leave the screen or the slider range
const wild = S.createState({ stick: { landscape: { sizePx: 500, leftX: 999, rightX: -5, leftY: 999, rightY: -5 } } });
const we = S.effectiveFor(wild, 'landscape', landscapeVp);
check('size clamped to min(240, 0.5*vh) = 200', we.sizePx === 200, String(we.sizePx));
check('insets clamped to [0,160]', we.leftX === 160 && we.leftY === 160 && we.rightX === 0 && we.rightY === 0, JSON.stringify(we));
const tiny = S.effectiveFor(S.createState({ stick: { portrait: { sizePx: 10 } } }), 'portrait', portraitVp);
check('size clamped up to the 48px minimum', tiny.sizePx === 48, String(tiny.sizePx));
const small = S.effectiveFor(S.createState({ stick: { portrait: { sizePx: 240, leftX: 160 } } }), 'portrait', { width: 200, height: 300 });
check('tiny viewport: size <= 0.5*vh and inset keeps the stick on screen', small.sizePx === 150 && small.leftX === 50, JSON.stringify(small));

// hand-edited / hostile values are ignored, not fatal
const junk = S.effectiveFor(S.createState({ stick: { landscape: { sizePx: '96', leftX: 12, rightY: null } } }), 'landscape', landscapeVp);
check('non-numeric override ignored (size falls back to 72)', junk.sizePx === 72 && junk.leftX === 12, JSON.stringify(junk));

// forward compatibility: keys this build does not know must survive a save
const keep = S.createState({ stick: { landscape: { sizePx: 96 } }, future: { mode: 'x' } });
S.writeOverride(keep, 'portrait', 'leftX', 40);
const serialized = JSON.parse(JSON.stringify(keep));
check('unknown keys preserved on save', serialized.future?.mode === 'x', JSON.stringify(serialized));
check('writeOverride creates the orientation object', serialized.stick.portrait.leftX === 40, JSON.stringify(serialized.stick));

// reset cleans up after itself so the stored file stays tidy
S.clearStickOverrides(keep, 'portrait');
S.clearStickOverrides(keep, 'landscape');
check('clearStickOverrides removes emptied containers', keep.stick === undefined, JSON.stringify(keep));
check('clearStickOverrides keeps foreign keys', keep.future !== undefined);

// ---------------------------------------------------------------- camera.ts
check('CAM_H / CAM_BACK are 24 / 15 (reference framing)', C.CAM_H === 24 && C.CAM_BACK === 15);
check('camera scale limits are 0.4 / 3.0 / step 0.05 / default 1',
  C.CAMERA_SCALE_MIN === 0.4 && C.CAMERA_SCALE_MAX === 3.0 && C.CAMERA_SCALE_STEP === 0.05 && C.CAMERA_SCALE_DEFAULT === 1);

const ref = C.cameraOffset(1);
check('cameraOffset(1) = {24, 15} exactly (upgrade changes nothing)', ref.height === 24 && ref.back === 15, JSON.stringify(ref));
check('cameraPitchDeg(1) = 57.995 (atan2(24,15))', near(C.cameraPitchDeg(1), 57.9946168, 1e-6), String(C.cameraPitchDeg(1)));
check('cameraDistance(1) = 28.317', near(C.cameraDistance(1), Math.hypot(24, 15), 1e-12), String(C.cameraDistance(1)));

const low = C.cameraOffset(0.4);
check('cameraOffset(0.4) = {9.6, 15} (32.62 deg, much closer)', near(low.height, 9.6) && low.back === 15 && near(C.cameraPitchDeg(0.4), 32.6192431, 1e-6), JSON.stringify(low));
check('0.4x distance = 17.81 (character ~1.59x bigger than reference)', near(C.cameraDistance(0.4), Math.hypot(9.6, 15), 1e-12), String(C.cameraDistance(0.4)));
const high = C.cameraOffset(3.0);
// The 2024-… request: raising the camera must NOT tilt it toward top-down. It used to reach
// 78.23 deg here; the pitch is now pinned to the reference angle for every scale >= 1.
check('cameraOffset(3.0) = {72, 45} (the camera backs off to hold a 58 deg oblique angle)',
  near(high.height, 72) && near(high.back, 45) && near(C.cameraPitchDeg(3.0), 57.9946168, 1e-6), JSON.stringify(high));
check('3.0x distance = 84.85 (world looks ~0.334x smaller)', near(C.cameraDistance(3.0), Math.hypot(72, 45), 1e-12), String(C.cameraDistance(3.0)));
check('the pitch is EXACTLY the reference angle from 1.0x to 3.0x (25 samples)',
  Array.from({ length: 25 }, (_, i) => 1 + (2 * i) / 24)
    .every((sc) => near(C.cameraPitchDeg(sc), C.cameraPitchDeg(1), 1e-12)));
check('below the reference scale the back offset is held (the flat close-up end is unchanged)',
  [0.4, 0.6, 0.8, 0.95].every((sc) => C.cameraOffset(sc).back === 15
    && near(C.cameraPitchDeg(sc), (Math.atan2(24 * sc, 15) * 180) / Math.PI, 1e-12)));
const mid = C.cameraOffset(1.8);
check('cameraOffset(1.8) = {43.2, 27} (backs off too: pitch stays at the reference 58 deg)',
  near(mid.height, 43.2) && near(mid.back, 27) && near(C.cameraPitchDeg(1.8), 57.9946168, 1e-6), JSON.stringify(mid));

check('clampCameraScale(5) = 3.0', C.clampCameraScale(5) === 3.0);
check('clampCameraScale(0.1) = 0.4', C.clampCameraScale(0.1) === 0.4);
check('clampCameraScale(NaN/Infinity/-Infinity) = 1',
  C.clampCameraScale(NaN) === 1 && C.clampCameraScale(Infinity) === 1 && C.clampCameraScale(-Infinity) === 1);
check('cameraOffset junk scale falls back to the reference framing', C.cameraOffset(NaN).height === 24);

// monotonic sweep across the whole slider range: height and distance always grow, the pitch grows
// up to the reference framing and then HOLDS (that hold is the point of the change)
let camMono = true;
let prevH = -1, prevD = -1, prevP = -1;
for (let i = 0; i <= 24; i++) {
  const s = 0.4 + (2.6 * i) / 24;
  const o = C.cameraOffset(s);
  const d = C.cameraDistance(s);
  const p = C.cameraPitchDeg(s);
  if (o.height <= prevH && i > 0) camMono = false;
  if (d <= prevD && i > 0) camMono = false;
  if (p < prevP - 1e-12) camMono = false;                 // never tilts back down
  if (s <= 1) {
    if (o.back !== 15) camMono = false;                   // flat end: back held
  } else {
    if (!near(o.back, 15 * s, 1e-12)) camMono = false;     // oblique end: back scales with height
    if (!near(p, C.cameraPitchDeg(1), 1e-12)) camMono = false;
  }
  prevH = o.height; prevD = d; prevP = p;
}
check('25 samples: height/distance always grow; pitch climbs to the reference angle then holds',
  camMono);
check('camera height is linear in the scale (24 * scale)', near(C.cameraOffset(1.25).height, 30, 1e-12), String(C.cameraOffset(1.25).height));

// ---------------------------------------------------------------- camera yaw (「摄像机水平角度」)
// The orbit must be a pure rotation of the shipped pose: yaw 0 reproduces the hardcoded numbers (the
// upgrade changes nothing), the pitch/distance/height are the 「摄像机高度」's business and stay put,
// and the basis stays orthonormal at every angle. Everything the renderer, the shadow fit and the
// input mapping use comes from these three functions.
check('yaw limits are -180 / 180 / step 15 / default 0',
  C.CAMERA_YAW_MIN === -180 && C.CAMERA_YAW_MAX === 180 && C.CAMERA_YAW_STEP === 15 && C.CAMERA_YAW_DEFAULT === 0);
check('clampCameraYaw clamps the range and falls back to 0 on dirty data',
  C.clampCameraYaw(999) === 180 && C.clampCameraYaw(-999) === -180 && C.clampCameraYaw(15) === 15
  && C.clampCameraYaw(NaN) === 0 && C.clampCameraYaw(Infinity) === 0 && C.clampCameraYaw('90') === 0);
check('cameraYawRad: 0 -> 0, 180 -> pi, 90 -> pi/2 (and 360 clamps to 180 first)',
  C.cameraYawRad(0) === 0 && near(C.cameraYawRad(180), Math.PI, 1e-12)
  && near(C.cameraYawRad(90), Math.PI / 2, 1e-12) && near(C.cameraYawRad(360), Math.PI, 1e-12));

const eye0 = C.cameraEye(1, 0);
check('cameraEye(1, 0) = [0, 24, 15] exactly (the pose this renderer hardcoded)',
  eye0[0] === 0 && eye0[1] === 24 && eye0[2] === 15, JSON.stringify(eye0));

// A rotation: the distance to the player must not change with the yaw, at any scale.
let yawRigid = true;
for (const sc of [0.4, 1, 1.8, 3]) {
  for (let yaw = -180; yaw <= 180; yaw += 15) {
    const e = C.cameraEye(sc, yaw);
    if (!near(Math.hypot(e[0], e[1], e[2]), C.cameraDistance(sc), 1e-12)) yawRigid = false;
    if (!near(e[1], C.cameraOffset(sc).height, 1e-12)) yawRigid = false;          // pitch/height fixed
    if (!near(Math.hypot(e[0], e[2]), C.cameraOffset(sc).back, 1e-12)) yawRigid = false; // back held
  }
}
check('the yaw is a pure orbit: 25 angles x 4 scales keep the height, the back offset and the distance',
  yawRigid);

// The basis must be the one three's lookAt(up=+Y) builds, and at yaw 0 it must equal the triple
// shadow.ts used to hardcode: vx = [1,0,0], vy = [0, vz.z, -vz.y].
const b0 = C.cameraBasis(1, 0);
check('cameraBasis(1, 0) reproduces the shipped hardcoded basis [1,0,0] / [0, vz.z, -vz.y]',
  near(b0.vx[0], 1, 1e-12) && near(b0.vx[1], 0, 1e-12) && near(b0.vx[2], 0, 1e-12)
  && near(b0.vy[0], 0, 1e-12) && near(b0.vy[1], b0.vz[2], 1e-12) && near(b0.vy[2], -b0.vz[1], 1e-12)
  && near(b0.vz[1], 24 / Math.hypot(24, 15), 1e-12) && near(b0.vz[2], 15 / Math.hypot(24, 15), 1e-12),
  JSON.stringify(b0));
let yawOrtho = true;
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
for (const sc of [0.4, 1, 3]) {
  for (let yaw = -180; yaw <= 180; yaw += 15) {
    const { vx, vy, vz } = C.cameraBasis(sc, yaw);
    for (const v of [vx, vy, vz]) if (!near(Math.hypot(...v), 1, 1e-12)) yawOrtho = false;
    if (!near(dot3(vx, vy), 0, 1e-12) || !near(dot3(vx, vz), 0, 1e-12) || !near(dot3(vy, vz), 0, 1e-12)) yawOrtho = false;
    // The eye must sit along +vz from the player, at the camera's distance.
    const e = C.cameraEye(sc, yaw);
    const d = C.cameraDistance(sc);
    if (!near(e[0], vz[0] * d, 1e-12) || !near(e[1], vz[1] * d, 1e-12) || !near(e[2], vz[2] * d, 1e-12)) yawOrtho = false;
  }
}
check('cameraBasis is orthonormal at 25 angles x 3 scales, and the eye lies along vz',
  yawOrtho);

// Screen -> world: the identity at yaw 0 (the mapping that shipped), and at any yaw the screen axes
// must land on the camera's own basis (right = vx on the ground, screen-down = -vy projected).
let stwOk = true;
for (let yaw = -180; yaw <= 180; yaw += 15) {
  const right = C.screenToWorld({ x: 1, y: 0 }, yaw);
  const down = C.screenToWorld({ x: 0, y: 1 }, yaw);
  const { vx, vy } = C.cameraBasis(1, yaw);
  if (!near(right.x, vx[0], 1e-12) || !near(right.z, vx[2], 1e-12)) stwOk = false;
  // screen-down is the ground projection of -vy, normalized: the vy's horizontal part points UP the
  // screen, and the ground projection keeps its direction.
  const hl = Math.hypot(vy[0], vy[2]);
  if (!near(down.x, -vy[0] / hl, 1e-12) || !near(down.z, -vy[2] / hl, 1e-12)) stwOk = false;
  if (!near(Math.hypot(down.x, down.z), 1, 1e-12)) stwOk = false;
}
check('screenToWorld maps screen-right onto vx and screen-down onto the ground projection of -vy '
  + '(25 angles)', stwOk);
check('screenToWorld is the identity at yaw 0 (the shipped mapping cannot change)',
  (() => { const w = C.screenToWorld({ x: 0.5, y: -0.25 }, 0);
    return near(w.x, 0.5, 1e-12) && near(w.z, -0.25, 1e-12); })(),
  JSON.stringify(C.screenToWorld({ x: 0.5, y: -0.25 }, 0)));
check('screenToWorld rotates by the yaw and preserves length',
  (() => { const w = C.screenToWorld({ x: 0, y: 1 }, 90);
    return near(w.x, 1, 1e-12) && near(w.z, 0, 1e-12); })(),
  JSON.stringify(C.screenToWorld({ x: 0, y: 1 }, 90)));

// ---------------------------------------------------------------- camera settings (画面 group)
check('cameraDefaultsFor() = 1.0x / 0deg for both orientations',
  S.cameraDefaultsFor('portrait').heightScale === 1 && S.cameraDefaultsFor('landscape').heightScale === 1
  && S.cameraDefaultsFor('portrait').yaw === 0 && S.cameraDefaultsFor('landscape').yaw === 0);
check('CAMERA_LIMITS mirror camera.ts (0.4/3.0/0.05 and -180/180/15)',
  S.CAMERA_LIMITS.heightScale.min === C.CAMERA_SCALE_MIN && S.CAMERA_LIMITS.heightScale.max === C.CAMERA_SCALE_MAX &&
  S.CAMERA_LIMITS.heightScale.step === C.CAMERA_SCALE_STEP
  && S.CAMERA_LIMITS.yaw.min === C.CAMERA_YAW_MIN && S.CAMERA_LIMITS.yaw.max === C.CAMERA_YAW_MAX
  && S.CAMERA_LIMITS.yaw.step === C.CAMERA_YAW_STEP, JSON.stringify(S.CAMERA_LIMITS));
check('effectiveCamera default = 1 x / 0 deg in both orientations',
  S.effectiveCamera({}, 'portrait').heightScale === 1 && S.effectiveCamera({}, 'landscape').heightScale === 1
  && S.effectiveCamera({}, 'portrait').yaw === 0 && S.effectiveCamera({}, 'landscape').yaw === 0);

const camRaw = S.createState({ camera: { landscape: { heightScale: 1.35 } } });
check('camera override merges (landscape 1.35)', S.effectiveCamera(camRaw, 'landscape').heightScale === 1.35);
check('portrait camera unaffected by a landscape override', S.effectiveCamera(camRaw, 'portrait').heightScale === 1);
check('hasCameraOverrides true for landscape / false for portrait',
  S.hasCameraOverrides(camRaw, 'landscape') && !S.hasCameraOverrides(camRaw, 'portrait'));

check('camera override clamped down to 3.0',
  S.effectiveCamera(S.createState({ camera: { portrait: { heightScale: 99 } } }), 'portrait').heightScale === 3.0);
check('camera override clamped up to 0.4',
  S.effectiveCamera(S.createState({ camera: { portrait: { heightScale: 0.01 } } }), 'portrait').heightScale === 0.4);
check('non-numeric camera override ignored (falls back to 1)',
  S.effectiveCamera(S.createState({ camera: { portrait: { heightScale: '1.5' } } }), 'portrait').heightScale === 1);
check('null camera override ignored',
  S.effectiveCamera(S.createState({ camera: { portrait: { heightScale: null } } }), 'portrait').heightScale === 1);
check('camera override with NaN ignored',
  S.effectiveCamera(S.createState({ camera: { portrait: { heightScale: NaN } } }), 'portrait').heightScale === 1);

// --- the yaw key: same sparse/merge/clamp contract, and one 「恢复默认」 clears BOTH camera keys ---
const yawRaw = S.createState({ camera: { landscape: { yaw: 45 } } });
check('yaw override merges (landscape 45) and leaves the height at its default',
  S.effectiveCamera(yawRaw, 'landscape').yaw === 45 && S.effectiveCamera(yawRaw, 'landscape').heightScale === 1);
check('portrait yaw unaffected by a landscape override', S.effectiveCamera(yawRaw, 'portrait').yaw === 0);
check('the two camera keys are INDEPENDENT: writing the yaw leaves heightScale alone',
  (() => { const r = S.createState({ camera: { landscape: { heightScale: 2 } } });
    S.writeCameraOverride(r, 'landscape', 'yaw', -90);
    const e = S.effectiveCamera(r, 'landscape');
    return e.heightScale === 2 && e.yaw === -90; })());
check('yaw override clamped to the slider range',
  S.effectiveCamera(S.createState({ camera: { portrait: { yaw: 999 } } }), 'portrait').yaw === 180
  && S.effectiveCamera(S.createState({ camera: { portrait: { yaw: -999 } } }), 'portrait').yaw === -180);
check('dirty yaw override ignored (NaN / string / null all fall back to 0)',
  S.effectiveCamera(S.createState({ camera: { portrait: { yaw: NaN } } }), 'portrait').yaw === 0
  && S.effectiveCamera(S.createState({ camera: { portrait: { yaw: '90' } } }), 'portrait').yaw === 0
  && S.effectiveCamera(S.createState({ camera: { portrait: { yaw: null } } }), 'portrait').yaw === 0);
check('hasCameraOverrides is true for a yaw-only override (the 画面 恢复默认 must be enabled)',
  S.hasCameraOverrides(yawRaw, 'landscape') && !S.hasCameraOverrides(yawRaw, 'portrait'));
check('clearCameraOverrides clears BOTH camera keys (one group, one button)',
  (() => { const r = S.createState({ camera: { landscape: { heightScale: 2, yaw: 90 }, portrait: { yaw: 30 } } });
    S.clearCameraOverrides(r, 'landscape');
    return r.camera.landscape === undefined && r.camera.portrait.yaw === 30
      && S.effectiveCamera(r, 'landscape').heightScale === 1
      && S.effectiveCamera(r, 'landscape').yaw === 0; })());

// the two groups must not clobber each other
const both = S.createState({ stick: { landscape: { sizePx: 96 } }, future: { mode: 'x' } });
S.writeCameraOverride(both, 'landscape', 'heightScale', 1.2);
const bothJson = JSON.parse(JSON.stringify(both));
check('writeCameraOverride keeps stick overrides and foreign keys',
  bothJson.stick.landscape.sizePx === 96 && bothJson.camera.landscape.heightScale === 1.2 && bothJson.future.mode === 'x',
  JSON.stringify(bothJson));
S.clearCameraOverrides(both, 'landscape');
check('clearCameraOverrides removes only the camera group', both.camera === undefined && both.stick !== undefined && both.future !== undefined,
  JSON.stringify(both));
S.clearStickOverrides(both, 'landscape');
check('clearing both groups leaves only foreign keys', both.stick === undefined && both.camera === undefined && both.future !== undefined,
  JSON.stringify(both));

// ---------------------------------------------------------------- vision settings (视野 group)
// Same contract as the camera group: sparse overrides, per-orientation storage, clamping instead of
// throwing on dirty data, and a reset that touches nothing else. The numbers themselves come from
// vision.ts, so these assertions also pin that the slider range matches the renderer's clamp.
const VZ = await import(new URL('../dist/apps/shooter/src/vision.js', import.meta.url).href);
check('VISION_LIMITS mirror vision.ts (0/0.85/0.05) and default 0.55',
  S.VISION_LIMITS.dim.min === VZ.VISION_DIM_MIN && S.VISION_LIMITS.dim.max === VZ.VISION_DIM_MAX
  && S.VISION_LIMITS.dim.step === VZ.VISION_DIM_STEP && VZ.VISION_DIM_DEFAULT === 0.55,
  JSON.stringify(S.VISION_LIMITS));
check('visionDefaultsFor() = 0.55 for both orientations',
  S.visionDefaultsFor('portrait').dim === 0.55 && S.visionDefaultsFor('landscape').dim === 0.55);
check('effectiveVision default = 0.55 in both orientations',
  S.effectiveVision({}, 'portrait').dim === 0.55 && S.effectiveVision({}, 'landscape').dim === 0.55);
check('the built-in default is inside the slider range',
  VZ.VISION_DIM_DEFAULT >= VZ.VISION_DIM_MIN && VZ.VISION_DIM_DEFAULT <= VZ.VISION_DIM_MAX);

const visRaw = S.createState({ vision: { landscape: { dim: 0.3 } } });
check('vision override merges (landscape 0.3)', S.effectiveVision(visRaw, 'landscape').dim === 0.3);
check('portrait vision unaffected by a landscape override', S.effectiveVision(visRaw, 'portrait').dim === 0.55);
check('hasVisionOverrides true for landscape / false for portrait',
  S.hasVisionOverrides(visRaw, 'landscape') && !S.hasVisionOverrides(visRaw, 'portrait'));
// 0 is a legal value, not a missing one: it is the OFF switch.
check('an explicit 0 survives the merge (it means "off", not "unset")',
  S.effectiveVision(S.createState({ vision: { portrait: { dim: 0 } } }), 'portrait').dim === 0
  && S.hasVisionOverrides(S.createState({ vision: { portrait: { dim: 0 } } }), 'portrait'));

// Dirty data: clamp, never throw (the server does not validate business schemas).
check('vision override above the range clamps down to 0.85',
  S.effectiveVision(S.createState({ vision: { portrait: { dim: 5 } } }), 'portrait').dim === 0.85);
check('vision override below the range clamps up to 0',
  S.effectiveVision(S.createState({ vision: { portrait: { dim: -2 } } }), 'portrait').dim === 0);
check('vision override of the wrong type is ignored -> default',
  S.effectiveVision(S.createState({ vision: { portrait: { dim: '0.9' } } }), 'portrait').dim === 0.55);
check('vision override of null ignored -> default',
  S.effectiveVision(S.createState({ vision: { portrait: { dim: null } } }), 'portrait').dim === 0.55);
check('vision override of NaN ignored -> default',
  S.effectiveVision(S.createState({ vision: { portrait: { dim: NaN } } }), 'portrait').dim === 0.55);
check('a non-object vision group is ignored',
  S.effectiveVision(S.createState({ vision: 'x' }), 'portrait').dim === 0.55
  && S.effectiveVision(S.createState({ vision: [1] }), 'portrait').dim === 0.55);
check('clampVisionDim is the same clamp the renderer uses',
  VZ.clampVisionDim(5) === 0.85 && VZ.clampVisionDim(-1) === 0 && VZ.clampVisionDim(NaN) === 0.55);

// The three groups must not clobber each other.
const trio = S.createState({
  stick: { landscape: { sizePx: 96 } }, camera: { landscape: { heightScale: 1.2 } }, future: { mode: 'x' },
});
S.writeVisionOverride(trio, 'landscape', 'dim', 0.4);
const trioJson = JSON.parse(JSON.stringify(trio));
check('writeVisionOverride keeps the other two groups and foreign keys',
  trioJson.stick.landscape.sizePx === 96 && trioJson.camera.landscape.heightScale === 1.2
  && trioJson.vision.landscape.dim === 0.4 && trioJson.future.mode === 'x', JSON.stringify(trioJson));
S.clearVisionOverrides(trio, 'landscape');
check('clearVisionOverrides removes only the vision group',
  trio.vision === undefined && trio.stick !== undefined && trio.camera !== undefined
  && trio.future !== undefined, JSON.stringify(trio));
S.clearVisionOverrides(trio, 'landscape');
check('clearVisionOverrides is idempotent', trio.vision === undefined);
S.clearCameraOverrides(trio, 'landscape');
S.clearStickOverrides(trio, 'landscape');
check('clearing all three groups leaves only foreign keys',
  trio.stick === undefined && trio.camera === undefined && trio.vision === undefined
  && trio.future !== undefined, JSON.stringify(trio));

// Defaults point at constants from the leaf module, so the settings tests themselves can never
// agree with a hard-coded copy that has drifted.
check('VISION_LIMITS come from vision.ts, not from a copy',
  S.VISION_LIMITS.dim.max === VZ.VISION_DIM_MAX && S.VISION_LIMITS.dim.min === VZ.VISION_DIM_MIN);

// ---------------------------------------------------------------- lighting (光照 group)
// The ambient-light multiplier. The numbers come from lighting.ts, so these assertions pin three
// things at once: the panel's range matches the renderer's clamp, the shipped default is the tuned
// one (NOT the pre-change 1.05), and the user can still get the old look back by dragging to the top
// — which is what makes the change safe to ship without a browser in the loop. The top of the range
// is DERIVED from the base, so these assertions are also what stops a re-tune of AMBIENT_BASE from
// silently shrinking the reachable range (the trap described at AMBIENT_SCALE_MAX).
const LT = await import(new URL('../dist/apps/shooter/src/lighting.js', import.meta.url).href);
check('LIGHT_LIMITS mirror lighting.ts (0/' + LT.AMBIENT_SCALE_MAX + '/0.05) and the default is 0 (off)',
  S.LIGHT_LIMITS.ambient.min === LT.AMBIENT_SCALE_MIN && S.LIGHT_LIMITS.ambient.max === LT.AMBIENT_SCALE_MAX
  && S.LIGHT_LIMITS.ambient.step === LT.AMBIENT_SCALE_STEP && LT.AMBIENT_SCALE_DEFAULT === 0,
  JSON.stringify(S.LIGHT_LIMITS));
check('both built-in scales sit inside their slider ranges',
  LT.AMBIENT_SCALE_DEFAULT >= LT.AMBIENT_SCALE_MIN && LT.AMBIENT_SCALE_DEFAULT <= LT.AMBIENT_SCALE_MAX
  && LT.DIRECTIONAL_SCALE_DEFAULT >= LT.DIRECTIONAL_SCALE_MIN
  && LT.DIRECTIONAL_SCALE_DEFAULT <= LT.DIRECTIONAL_SCALE_MAX);
// "把环境光改成 0": the ambient light is OFF as shipped (the scene is directional-lit only).
check('the shipped ambient is exactly 0 (off)',
  LT.AMBIENT_SCALE_DEFAULT === 0 && LT.ambientIntensity(LT.AMBIENT_SCALE_DEFAULT) === 0,
  String(LT.ambientIntensity(LT.AMBIENT_SCALE_DEFAULT)));
check('ambientIntensity(1) = AMBIENT_BASE (the constant IS the shipped level)',
  LT.ambientIntensity(1) === LT.AMBIENT_BASE, String(LT.ambientIntensity(1)));
check('the slider unit is still weaker than the pre-setting intensity',
  LT.ambientIntensity(1) < LT.AMBIENT_LEGACY_INTENSITY, String(LT.ambientIntensity(1)));
// The 1/3 request itself: 0.42 (the value this pass lowered) / 3 = 0.14, exactly.
check('AMBIENT_BASE is exactly one third of the previous 0.42 (the "降低到 1/3" request)',
  near(LT.AMBIENT_BASE, 0.42 / 3, 1e-12) && near(LT.ambientIntensity(1), 0.14, 1e-12),
  String(LT.AMBIENT_BASE));
check('…which is 13.3% of the pre-setting 1.05 (the scene is now essentially directional-lit)',
  near(LT.AMBIENT_BASE / LT.AMBIENT_LEGACY_INTENSITY, 0.1333333333, 1e-9),
  String(LT.AMBIENT_BASE / LT.AMBIENT_LEGACY_INTENSITY));
check('the top of the slider reproduces the pre-setting intensity exactly',
  near(LT.ambientIntensity(LT.AMBIENT_SCALE_MAX), LT.AMBIENT_LEGACY_INTENSITY, 1e-12),
  String(LT.ambientIntensity(LT.AMBIENT_SCALE_MAX)));
check('the slider max is derived from the base, and still reaches the previous 0.42 (MAX >= 3)',
  LT.AMBIENT_SCALE_MAX >= 3 && near(LT.ambientIntensity(3), 0.42, 1e-12),
  'MAX=' + LT.AMBIENT_SCALE_MAX + ' at 3x=' + LT.ambientIntensity(3));
check('ambientIntensity(0) = 0 (directional lights only, not "no light")',
  LT.ambientIntensity(0) === 0, String(LT.ambientIntensity(0)));
check('clampAmbientScale(99) = MAX / (-1) = 0 / (NaN, ±Infinity) = the shipped default',
  LT.clampAmbientScale(99) === LT.AMBIENT_SCALE_MAX && LT.clampAmbientScale(-1) === 0
  && LT.clampAmbientScale(NaN) === LT.AMBIENT_SCALE_DEFAULT && LT.clampAmbientScale(Infinity) === LT.AMBIENT_SCALE_DEFAULT
  && LT.clampAmbientScale(-Infinity) === LT.AMBIENT_SCALE_DEFAULT);
check('dirty ambient falls back to the shipped level (= off), it does not invent a value',
  LT.ambientIntensity(NaN) === LT.AMBIENT_SCALE_DEFAULT && LT.ambientIntensity('0.5') === LT.AMBIENT_SCALE_DEFAULT);
check('ambientIntensity is linear and monotonically increasing in the scale',
  [0.25, 0.5, 1, 1.5, 2, 3].every((s, i, arr) =>
    near(LT.ambientIntensity(s), LT.AMBIENT_BASE * s, 1e-12) && (i === 0 || s > arr[i - 1])));

check('lightDefaultsFor() = ambient 0 (off) + directional 1 for both orientations',
  S.lightDefaultsFor('portrait').ambient === 0 && S.lightDefaultsFor('landscape').ambient === 0
  && S.lightDefaultsFor('portrait').directional === 1 && S.lightDefaultsFor('landscape').directional === 1);
check('effectiveLight defaults = ambient 0 / directional 1 in both orientations',
  S.effectiveLight({}, 'portrait').ambient === 0 && S.effectiveLight({}, 'landscape').ambient === 0
  && S.effectiveLight({}, 'portrait').directional === 1 && S.effectiveLight({}, 'landscape').directional === 1);
// The readout is anchored to the pre-setting 1.05, not to the slider unit, so these three numbers
// keep meaning the same thing forever: off / the 0.42 that shipped for a round / the original.
check('ambientPercentOfLegacy: 0 -> 0%, 3 -> 40%, MAX(7.5) -> 100%',
  LT.ambientPercentOfLegacy(0) === 0 && LT.ambientPercentOfLegacy(3) === 40
  && LT.ambientPercentOfLegacy(LT.AMBIENT_SCALE_MAX) === 100,
  [0, 3, LT.AMBIENT_SCALE_MAX].map((v) => LT.ambientPercentOfLegacy(v)).join(','));

const lightRaw = S.createState({ light: { landscape: { ambient: 0.6 } } });
check('light override merges (landscape 0.6)', S.effectiveLight(lightRaw, 'landscape').ambient === 0.6);
check('portrait light unaffected by a landscape override (still off)', S.effectiveLight(lightRaw, 'portrait').ambient === 0);
check('hasLightOverrides true for landscape / false for portrait',
  S.hasLightOverrides(lightRaw, 'landscape') && !S.hasLightOverrides(lightRaw, 'portrait'));
// 0 is legal and means "directional lights only", so it must survive as an override.
check('an explicit 0 survives the merge (it means "no ambient fill", not "unset")',
  S.effectiveLight(S.createState({ light: { portrait: { ambient: 0 } } }), 'portrait').ambient === 0
  && S.hasLightOverrides(S.createState({ light: { portrait: { ambient: 0 } } }), 'portrait'));

check('an explicit ambient 0 is honoured as an override, not as "unset"',
  S.effectiveLight(S.createState({ light: { portrait: { ambient: 0 } } }), 'portrait').ambient === 0
  && S.hasLightOverrides(S.createState({ light: { portrait: { ambient: 0 } } }), 'portrait'));
check('light override above the range clamps down to the derived MAX (7.5)',
  S.effectiveLight(S.createState({ light: { portrait: { ambient: 99 } } }), 'portrait').ambient === LT.AMBIENT_SCALE_MAX
  && LT.AMBIENT_SCALE_MAX === 7.5, String(S.effectiveLight(S.createState({ light: { portrait: { ambient: 99 } } }), 'portrait').ambient));
check('light override below the range clamps up to 0',
  S.effectiveLight(S.createState({ light: { portrait: { ambient: -3 } } }), 'portrait').ambient === 0);
check('light override of the wrong type / null / NaN is ignored -> the shipped default (0)',
  S.effectiveLight(S.createState({ light: { portrait: { ambient: '0.5' } } }), 'portrait').ambient === 0
  && S.effectiveLight(S.createState({ light: { portrait: { ambient: null } } }), 'portrait').ambient === 0
  && S.effectiveLight(S.createState({ light: { portrait: { ambient: NaN } } }), 'portrait').ambient === 0
  && S.effectiveLight(S.createState({ light: { portrait: { directional: 'x' } } }), 'portrait').directional === 1);
check('a non-object light group is ignored',
  S.effectiveLight(S.createState({ light: 'x' }), 'portrait').ambient === 0
  && S.effectiveLight(S.createState({ light: [1] }), 'portrait').ambient === 0);
check('clampAmbientScale is the same clamp the renderer uses',
  S.LIGHT_LIMITS.ambient.max === LT.AMBIENT_SCALE_MAX
  && LT.clampAmbientScale(99) === LT.AMBIENT_SCALE_MAX && LT.clampAmbientScale(4) === 4);

// --- directional light: one multiplier over BOTH directionals (keys + warm fill) ---
check('DIRECTIONAL_LIMITS mirror lighting.ts (0/2/0.05) and the default is 1',
  S.LIGHT_LIMITS.directional.min === LT.DIRECTIONAL_SCALE_MIN
  && S.LIGHT_LIMITS.directional.max === LT.DIRECTIONAL_SCALE_MAX
  && S.LIGHT_LIMITS.directional.step === LT.DIRECTIONAL_SCALE_STEP
  && LT.DIRECTIONAL_SCALE_DEFAULT === 1, JSON.stringify(S.LIGHT_LIMITS.directional));
check('directionalIntensity(1) reproduces the shipped sun on BOTH lights (1.4 / 1.0)',
  LT.directionalIntensity(LT.DIR_KEY_INTENSITY, 1) === 1.4
  && LT.directionalIntensity(LT.DIR_WARM_INTENSITY, 1) === 1.0,
  LT.directionalIntensity(LT.DIR_KEY_INTENSITY, 1) + ' / ' + LT.directionalIntensity(LT.DIR_WARM_INTENSITY, 1));
check('both directionals scale by the SAME factor (the key:warm ratio is preserved)',
  [0.5, 1, 1.5, 2].every((sc) =>
    near(LT.directionalIntensity(LT.DIR_KEY_INTENSITY, sc) / LT.directionalIntensity(LT.DIR_WARM_INTENSITY, sc),
      1.4, 1e-12)));
check('directionalIntensity(0) = 0 on both (ambient-only lighting is legal)',
  LT.directionalIntensity(LT.DIR_KEY_INTENSITY, 0) === 0
  && LT.directionalIntensity(LT.DIR_WARM_INTENSITY, 0) === 0);
check('clampDirectionalScale(9) = 2 / (-1) = 0 / (NaN, ±Infinity) = 1',
  LT.clampDirectionalScale(9) === 2 && LT.clampDirectionalScale(-1) === 0
  && LT.clampDirectionalScale(NaN) === 1 && LT.clampDirectionalScale(Infinity) === 1
  && LT.clampDirectionalScale(-Infinity) === 1);
check('directionalPercent: 0 -> 0%, 1 -> 100%, 2 -> 200%',
  LT.directionalPercent(0) === 0 && LT.directionalPercent(1) === 100 && LT.directionalPercent(2) === 200);

const dirRaw = S.createState({ light: { landscape: { directional: 0.5 } } });
check('directional override merges (landscape 0.5)', S.effectiveLight(dirRaw, 'landscape').directional === 0.5);
check('portrait directional unaffected by a landscape override',
  S.effectiveLight(dirRaw, 'portrait').directional === 1);
check('a directional override does not disturb the ambient default (still 0)',
  S.effectiveLight(dirRaw, 'landscape').ambient === 0);
check('directional override above the range clamps to 2',
  S.effectiveLight(S.createState({ light: { portrait: { directional: 9 } } }), 'portrait').directional === 2);
check('directional override of the wrong type / null / NaN is ignored -> default 1',
  S.effectiveLight(S.createState({ light: { portrait: { directional: '0.5' } } }), 'portrait').directional === 1
  && S.effectiveLight(S.createState({ light: { portrait: { directional: null } } }), 'portrait').directional === 1
  && S.effectiveLight(S.createState({ light: { portrait: { directional: NaN } } }), 'portrait').directional === 1);

// --- height fog (雾 group) ---
const FG = await import(new URL('../dist/apps/shooter/src/fog.js', import.meta.url).href);
check('FOG_LIMITS mirror fog.ts (0/0.06/0.002) and the default is the shipped haze',
  S.FOG_LIMITS.density.min === FG.FOG_DENSITY_MIN && S.FOG_LIMITS.density.max === FG.FOG_DENSITY_MAX
  && S.FOG_LIMITS.density.step === FG.FOG_DENSITY_STEP
  && S.FOG_LIMITS.density.min === 0 && S.FOG_LIMITS.density.max === 0.06
  && FG.FOG_DENSITY_DEFAULT === 0.016, JSON.stringify(S.FOG_LIMITS.density));
check('fogDefaultsFor() / effectiveFog default = 0.016 in both orientations',
  S.fogDefaultsFor('portrait').density === 0.016 && S.fogDefaultsFor('landscape').density === 0.016
  && S.effectiveFog({}, 'portrait').density === 0.016 && S.effectiveFog({}, 'landscape').density === 0.016);
check('the shipped density is inside the slider range and is not the max',
  FG.FOG_DENSITY_DEFAULT >= FG.FOG_DENSITY_MIN && FG.FOG_DENSITY_DEFAULT < FG.FOG_DENSITY_MAX);

const fogRaw = S.createState({ fog: { landscape: { density: 0.03 } } });
check('fog override merges (landscape 0.03)', S.effectiveFog(fogRaw, 'landscape').density === 0.03);
check('portrait fog unaffected by a landscape override', S.effectiveFog(fogRaw, 'portrait').density === 0.016);
check('hasFogOverrides true for landscape / false for portrait',
  S.hasFogOverrides(fogRaw, 'landscape') && !S.hasFogOverrides(fogRaw, 'portrait'));
// 0 is the OFF switch, and it must survive as an override rather than reading as "unset".
check('an explicit fog density of 0 survives the merge (it means "off", not "unset")',
  S.effectiveFog(S.createState({ fog: { portrait: { density: 0 } } }), 'portrait').density === 0
  && S.hasFogOverrides(S.createState({ fog: { portrait: { density: 0 } } }), 'portrait'));
check('fog override above the range clamps to 0.06',
  S.effectiveFog(S.createState({ fog: { portrait: { density: 9 } } }), 'portrait').density === 0.06);
check('fog override below the range clamps to 0',
  S.effectiveFog(S.createState({ fog: { portrait: { density: -1 } } }), 'portrait').density === 0);
check('fog override of the wrong type / null / NaN is ignored -> the shipped default',
  S.effectiveFog(S.createState({ fog: { portrait: { density: '0.03' } } }), 'portrait').density === 0.016
  && S.effectiveFog(S.createState({ fog: { portrait: { density: null } } }), 'portrait').density === 0.016
  && S.effectiveFog(S.createState({ fog: { portrait: { density: NaN } } }), 'portrait').density === 0.016);
check('a non-object fog group is ignored',
  S.effectiveFog(S.createState({ fog: 'x' }), 'portrait').density === 0.016
  && S.effectiveFog(S.createState({ fog: [1] }), 'portrait').density === 0.016);
check('fogPercent is the panel readout (0 -> 0%, default -> 27%, max -> 100%)',
  FG.fogPercent(0) === 0 && FG.fogPercent(0.06) === 100 && FG.fogPercent(0.016) === 27,
  String(FG.fogPercent(0.016)));

// --- 调色 group (tone grade + vignette) ---
const GR = await import(new URL('../dist/apps/shooter/src/grade.js', import.meta.url).href);
const VG = await import(new URL('../dist/apps/shooter/src/vignette.js', import.meta.url).href);
check('LOOK_LIMITS mirror grade.ts / vignette.ts (0–2 / 0–1.5, step 0.05) and the defaults are 1 / 0.7',
  S.LOOK_LIMITS.tone.min === GR.GRADE_STRENGTH_MIN && S.LOOK_LIMITS.tone.max === GR.GRADE_STRENGTH_MAX
  && S.LOOK_LIMITS.tone.step === GR.GRADE_STRENGTH_STEP
  && S.LOOK_LIMITS.vignette.min === VG.VIGNETTE_STRENGTH_MIN
  && S.LOOK_LIMITS.vignette.max === VG.VIGNETTE_STRENGTH_MAX
  && S.LOOK_LIMITS.vignette.step === VG.VIGNETTE_STRENGTH_STEP
  && GR.GRADE_STRENGTH_DEFAULT === 1 && VG.VIGNETTE_STRENGTH_DEFAULT === 0.7,
  JSON.stringify(S.LOOK_LIMITS));
check('the built-in look values sit inside their slider ranges',
  [S.LOOK_LIMITS.tone, S.LOOK_LIMITS.vignette].every((l) => l.min === 0 && l.max > 0));
check('lookDefaultsFor() / effectiveLook default = tone 1, vignette 0.7, pixel 2 CSS px',
  S.lookDefaultsFor('portrait').tone === 1 && S.lookDefaultsFor('landscape').vignette === 0.7
  && S.lookDefaultsFor('portrait').pixel === 2 && S.lookDefaultsFor('landscape').pixel === 2
  && S.effectiveLook({}, 'portrait').tone === 1 && S.effectiveLook({}, 'landscape').vignette === 0.7
  && S.effectiveLook({}, 'portrait').pixel === 2);
check('LOOK_LIMITS.pixel mirrors postfx.ts (0-6, step 1) - the block is small by default',
  S.LOOK_LIMITS.pixel.min === 0 && S.LOOK_LIMITS.pixel.max === 6 && S.LOOK_LIMITS.pixel.step === 1);
check('a pixel override merges, and 0 survives as the off switch',
  S.effectiveLook(S.createState({ look: { landscape: { pixel: 5 } } }), 'landscape').pixel === 5
  && S.effectiveLook(S.createState({ look: { portrait: { pixel: 0 } } }), 'portrait').pixel === 0
  && S.hasLookOverrides(S.createState({ look: { portrait: { pixel: 0 } } }), 'portrait'));
check('pixel overrides clamp and dirty values fall back to the shipped 2',
  S.effectiveLook(S.createState({ look: { portrait: { pixel: 99 } } }), 'portrait').pixel === 6
  && S.effectiveLook(S.createState({ look: { portrait: { pixel: -3 } } }), 'portrait').pixel === 0
  && S.effectiveLook(S.createState({ look: { portrait: { pixel: 'x' } } }), 'portrait').pixel === 2
  && S.effectiveLook(S.createState({ look: { portrait: { pixel: NaN } } }), 'portrait').pixel === 2);

const lookRaw = S.createState({ look: { landscape: { tone: 0.4, vignette: 0 } } });
check('look overrides merge (landscape tone 0.4, vignette 0)',
  S.effectiveLook(lookRaw, 'landscape').tone === 0.4 && S.effectiveLook(lookRaw, 'landscape').vignette === 0);
check('portrait look unaffected by a landscape override',
  S.effectiveLook(lookRaw, 'portrait').tone === 1 && S.effectiveLook(lookRaw, 'portrait').vignette === 0.7);
check('hasLookOverrides true for landscape / false for portrait',
  S.hasLookOverrides(lookRaw, 'landscape') && !S.hasLookOverrides(lookRaw, 'portrait'));
// 0 means "unprocessed" for both keys, and it must survive as an override rather than reading as unset.
check('an explicit 0 for either look key survives the merge (0 = unprocessed, not "unset")',
  S.effectiveLook(S.createState({ look: { portrait: { tone: 0, vignette: 0 } } }), 'portrait').tone === 0
  && S.effectiveLook(S.createState({ look: { portrait: { tone: 0, vignette: 0 } } }), 'portrait').vignette === 0
  && S.hasLookOverrides(S.createState({ look: { portrait: { tone: 0 } } }), 'portrait'));
check('look overrides clamp (tone 9 -> 2, vignette -1 -> 0)',
  S.effectiveLook(S.createState({ look: { portrait: { tone: 9 } } }), 'portrait').tone === 2
  && S.effectiveLook(S.createState({ look: { portrait: { vignette: -1 } } }), 'portrait').vignette === 0);
check('dirty look values are ignored -> the shipped defaults (0 is distinguished from junk)',
  S.effectiveLook(S.createState({ look: { portrait: { tone: 'x' } } }), 'portrait').tone === 1
  && S.effectiveLook(S.createState({ look: { portrait: { tone: null } } }), 'portrait').tone === 1
  && S.effectiveLook(S.createState({ look: { portrait: { vignette: NaN } } }), 'portrait').vignette === 0.7
  && S.effectiveLook(S.createState({ look: 'x' }), 'portrait').tone === 1);

// The six groups must not clobber each other.
const quad = S.createState({
  stick: { landscape: { sizePx: 96 } }, camera: { landscape: { heightScale: 1.2 } },
  vision: { landscape: { dim: 0.4 } }, future: { mode: 'x' },
});
S.writeLightOverride(quad, 'landscape', 'ambient', 0.7);
// Both keys of the lighting group must survive each other's writes (they are independent dials that
// happen to share a group and a 「恢复默认」 button).
S.writeLightOverride(quad, 'landscape', 'directional', 0.5);
const quadJson = JSON.parse(JSON.stringify(quad));
check('writeLightOverride keeps the other three groups, the sibling key and foreign keys',
  quadJson.stick.landscape.sizePx === 96 && quadJson.camera.landscape.heightScale === 1.2
  && quadJson.vision.landscape.dim === 0.4 && quadJson.light.landscape.ambient === 0.7
  && quadJson.light.landscape.directional === 0.5
  && quadJson.future.mode === 'x', JSON.stringify(quadJson));
check('effectiveLight reads both keys at once (ambient 0.7 / directional 0.5)',
  S.effectiveLight(quad, 'landscape').ambient === 0.7 && S.effectiveLight(quad, 'landscape').directional === 0.5);
S.writeFogOverride(quad, 'landscape', 'density', 0.04);
const quadFogJson = JSON.parse(JSON.stringify(quad));
check('writeFogOverride keeps the other groups and foreign keys',
  quadFogJson.light.landscape.ambient === 0.7 && quadFogJson.light.landscape.directional === 0.5
  && quadFogJson.fog.landscape.density === 0.04 && quadFogJson.stick.landscape.sizePx === 96
  && quadFogJson.future.mode === 'x', JSON.stringify(quadFogJson));
S.writeLookOverride(quad, 'landscape', 'tone', 0.5);
S.writeLookOverride(quad, 'landscape', 'vignette', 0.9);
S.writeLookOverride(quad, 'landscape', 'pixel', 3);
const quadLookJson = JSON.parse(JSON.stringify(quad));
check('writeLookOverride keeps the other groups and foreign keys',
  quadLookJson.fog.landscape.density === 0.04 && quadLookJson.look.landscape.tone === 0.5
  && quadLookJson.look.landscape.vignette === 0.9 && quadLookJson.look.landscape.pixel === 3
  && quadLookJson.stick.landscape.sizePx === 96
  && quadLookJson.future.mode === 'x', JSON.stringify(quadLookJson));
S.clearLookOverrides(quad, 'landscape');
check('clearLookOverrides removes only the look group (all three keys, one button)',
  quad.look === undefined && quad.fog !== undefined && quad.light !== undefined
  && quad.future !== undefined, JSON.stringify(quad));
S.clearFogOverrides(quad, 'landscape');
check('clearFogOverrides removes only the fog group',
  quad.fog === undefined && quad.light !== undefined && quad.stick !== undefined
  && quad.future !== undefined, JSON.stringify(quad));
S.clearLightOverrides(quad, 'landscape');
check('clearLightOverrides removes only the lighting group',
  quad.light === undefined && quad.stick !== undefined && quad.camera !== undefined
  && quad.vision !== undefined && quad.future !== undefined, JSON.stringify(quad));
S.clearLightOverrides(quad, 'landscape');
check('clearLightOverrides is idempotent', quad.light === undefined);
S.clearVisionOverrides(quad, 'landscape');
S.clearCameraOverrides(quad, 'landscape');
S.clearStickOverrides(quad, 'landscape');
check('clearing all six groups leaves only foreign keys',
  quad.stick === undefined && quad.camera === undefined && quad.vision === undefined
  && quad.light === undefined && quad.fog === undefined && quad.look === undefined
  && quad.future !== undefined, JSON.stringify(quad));

// ---------------------------------------------------------------- report
console.log('verify-stick: ' + passed + ' checks passed, ' + failures.length + ' failed');
for (const f of failures) console.error('  FAIL ' + f);
if (failures.length) process.exit(1);
