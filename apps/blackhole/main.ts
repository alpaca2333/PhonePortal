// Black hole sub-app: Schwarzschild geodesic ray tracing.
// Tries WebGL2 first, then WebGL1 (GLSL ES 1.00). If neither is available or the
// shader fails to link, it shows a CPU pre-rendered image so the black hole is
// always visible.
// Physics: photons follow d2x/dlam2 = -1.5*rs*L2*x/r^5 (conserved L2=|x cross v|^2),
// validated to reproduce b_crit = 3*sqrt(3)/2 * rs (~2.6 rs).
const app = document.getElementById("app") as HTMLDivElement;

// ---------- GLSL (WebGL2 / GLSL ES 3.00) ----------
const VERT: string = `#version 300 es
layout(location=0) in vec2 aPos;
void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAG: string = `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uTime;
uniform float uCamRadius;
uniform float uInclination;
uniform float uFov;
uniform float uDiskInner;
uniform float uDiskOuter;
uniform float uDiskThickness;
uniform float uTHot;
uniform float uBrightness;
uniform float uAnim;
uniform float uShowDisk;
uniform float uMaxSteps;

out vec4 outColor;

const float RS = 1.0;

float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*0.1031); p3 += dot(p3, p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
float hash13(vec3 p){ p = fract(p*0.1031); p += dot(p, p.zyx+31.32); return fract((p.x+p.y)*p.z); }
float vnoise(vec3 p){
  vec3 i = floor(p); vec3 f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(mix(hash13(i),hash13(i+vec3(1,0,0)),f.x),
                 mix(hash13(i+vec3(0,1,0)),hash13(i+vec3(1,1,0)),f.x), f.y),
             mix(mix(hash13(i+vec3(0,0,1)),hash13(i+vec3(1,0,1)),f.x),
                 mix(hash13(i+vec3(0,1,1)),hash13(i+vec3(1,1,1)),f.x), f.y), f.z);
}
float fbm(vec3 p){ float s = 0.0; float a = 0.5; for(int i=0;i<4;i++){ s += a*vnoise(p); p *= 2.02; a *= 0.5; } return s; }
vec2 cubemap(vec3 d){
  vec3 a = abs(d);
  if(a.x>=a.y && a.x>=a.z) return d.yz/(a.x);
  else if(a.y>=a.x && a.y>=a.z) return d.xz/(a.y);
  else return d.xy/(a.z);
}
vec3 blackbody(float temp){
  temp = temp/100.0;
  float r,g,b;
  if(temp <= 66.0){
    r = 1.0;
    g = clamp(99.4708025861*log(temp)-161.1195681661, 0.0, 255.0)/255.0;
    b = (temp <= 19.0) ? 0.0 : clamp(138.5177312231*log(temp-10.0)-305.0447927307, 0.0, 255.0)/255.0;
  } else {
    r = clamp(329.698727446*pow(temp-60.0,-0.1332047592), 0.0, 255.0)/255.0;
    g = clamp(288.1221695283*pow(temp-60.0,-0.0755148492), 0.0, 255.0)/255.0;
    b = 1.0;
  }
  return vec3(r,g,b);
}
vec3 starfield(vec2 uv){
  vec3 col = vec3(0.0);
  vec2 P = uv*24.0;
  vec2 id = floor(P);
  for(int x=-1;x<=1;x++){
    for(int y=-1;y<=1;y++){
      vec2 o = vec2(float(x), float(y));
      vec2 cell = id + o;
      float h = hash12(cell);
      if(h < 0.86) continue;
      vec2 sp = cell + 0.5 + 0.45*(vec2(hash12(cell+7.0), hash12(cell+13.0))-0.5);
      float d = length(P - sp);
      float sz = 0.05 + 0.06*hash12(cell+3.0);
      float bright = 0.4 + 0.6*hash12(cell+5.0);
      float tint = hash12(cell+11.0);
      vec3 c = mix(vec3(0.9,0.93,1.0), vec3(1.0,0.85,0.7), step(0.8,tint));
      float m = smoothstep(sz, sz*0.15, d);
      col += m*bright*c;
    }
  }
  return col;
}
vec3 background(vec3 dir){
  vec3 col = vec3(0.0);
  col += starfield(cubemap(dir));
  float band = exp(-pow((dir.y*0.7 + dir.z*0.9)*3.0, 2.0));
  col += vec3(0.10,0.08,0.14)*band*(0.3 + 0.7*fbm(dir*2.5));
  col += vec3(0.012,0.015,0.025);
  return col;
}
vec3 diskColor(vec3 p, vec3 rayDir){
  float r = length(p);
  float phi = atan(p.y, p.x);
  float beta = clamp(sqrt(0.5*RS/r), 0.0, 0.99);
  vec3 tang = normalize(vec3(-sin(phi), cos(phi), 0.0));
  vec3 bvec = beta*tang;
  vec3 ndir = normalize(rayDir);
  float gamm = inversesqrt(max(0.05, 1.0 - beta*beta));
  float denom = max(0.12, 1.0 - dot(bvec, ndir));
  float g = sqrt(max(0.0, 1.0 - RS/r)) / (gamm*denom);
  float T_eff = uTHot*pow(uDiskInner/max(r, uDiskInner), 0.75);
  float T_obs = T_eff*g;
  float bright = pow(g, 3.0) * pow(T_eff/uTHot, 4.0);
  float omega = sqrt(0.5*RS/(r*r*r));
  float ang = phi - omega*uTime*uAnim;
  float n = fbm(vec3(cos(ang), sin(ang), r*0.15))*3.0;
  bright *= (0.72 + 0.28*n);
  bright = clamp(bright*uBrightness, 0.0, 3.5);
  return blackbody(clamp(T_obs, 1200.0, 42000.0))*bright;
}
vec3 accel(vec3 p, float L2){
  float r2 = dot(p,p);
  return (-1.5*RS*L2/pow(r2,2.5))*p;
}
vec3 trace(vec3 p, vec3 v){
  float L2 = length(cross(p,v)); L2 = L2*L2;
  vec3 col = vec3(0.0);
  float trans = 1.0;
  bool escaped = false;
  float r2 = dot(p,p);
  const float ESCAPE = 24.0;
  for(int i=0;i<400;i++){
    if(float(i) > uMaxSteps) break;
    if(r2 < 1.0) break;
    if(r2 > ESCAPE*ESCAPE && dot(p,v) > 0.0){ escaped = true; break; }
    float r = sqrt(r2);
    float dt = clamp(0.03*r, 0.02, 0.6);
    vec3 a1 = accel(p,L2);
    vec3 p1 = p + 0.5*dt*v; vec3 v1 = v + 0.5*dt*a1;
    vec3 a2 = accel(p1,L2);
    vec3 p2 = p + 0.5*dt*v1; vec3 v2 = v + 0.5*dt*a2;
    vec3 a3 = accel(p2,L2);
    vec3 p3 = p + dt*v2; vec3 v3 = v + 0.5*dt*a3;
    vec3 a4 = accel(p3,L2);
    vec3 pn = p + (dt/6.0)*(v + 2.0*(v1+v2) + v3);
    vec3 vn = v + (dt/6.0)*(a1 + 2.0*(a2+a3) + a4);
    if(uShowDisk > 0.5 && trans > 0.003){
      if(r > uDiskInner*0.95 && r < uDiskOuter*1.05){
        float h = uDiskThickness * r;
        float vert = exp(-(p.z*p.z)/(2.0*h*h));
        if(vert > 0.003){
          float rise = smoothstep(uDiskInner*0.95, uDiskInner*1.05, r);
          float fall = 1.0 - smoothstep(uDiskOuter*0.8, uDiskOuter, r);
          float rad = clamp(rise*fall, 0.0, 1.0);
          float em = vert*rad*dt*0.55;
          if(em > 0.0){
            col += trans * em * diskColor(p, v);
            trans *= (1.0 - min(0.5, em*0.5));
          }
        }
      }
    }
    p = pn; v = vn; r2 = dot(p,p);
  }
  if(escaped) col += trans*background(normalize(v));
  return col;
}
void main(){
  vec2 uv = gl_FragCoord.xy/uResolution;
  vec2 ndc = 2.0*uv - 1.0;
  ndc.x *= uResolution.x/uResolution.y;
  float elev = uInclination;
  vec3 camPos = uCamRadius*vec3(cos(elev), 0.0, sin(elev));
  vec3 f = normalize(-camPos);
  vec3 uhp = abs(dot(f, vec3(0.0,0.0,1.0))) < 0.99 ? vec3(0.0,0.0,1.0) : vec3(0.0,1.0,0.0);
  vec3 right = normalize(cross(f, uhp));
  vec3 up = cross(right, f);
  float th = tan(0.5*uFov);
  vec3 dir = normalize(f + ndc.x*th*right + ndc.y*th*up);
  vec3 col = trace(camPos, dir);
  col = col/(1.0 + col);
  col = pow(col, vec3(1.0/2.2));
  col += (hash12(gl_FragCoord.xy) - 0.5)/255.0;
  outColor = vec4(col, 1.0);
}
`;

// GLSL 3.00 -> 1.00 (WebGL1) conversions
function toGLSL1vert(s: string): string {
  return s.replace("#version 300 es\n", "").replace("layout(location=0) in vec2 aPos;", "attribute vec2 aPos;");
}
function toGLSL1(s: string): string {
  return s.replace("#version 300 es\n", "").replace("out vec4 outColor;", "").replace("outColor = vec4(col, 1.0);", "gl_FragColor = vec4(col, 1.0);");
}

function boot() {
// ---------- UI ----------
const header = document.createElement("header");
header.className = "bh-header";
const icon = document.createElement("div"); icon.className = "icon"; icon.textContent = "🕳️";
const headText = document.createElement("div");
const h1 = document.createElement("h1"); h1.textContent = "黑洞";
const sub = document.createElement("p"); sub.textContent = "Schwarzschild 测地线光线追踪 · 引力透镜 + 吸积盘";
headText.append(h1, sub);
header.append(icon, headText);

const stage = document.createElement("div"); stage.className = "bh-stage";
const canvas = document.createElement("canvas");
const badge = document.createElement("div"); badge.className = "bh-badge"; badge.textContent = "实时光线追踪 · 帧率取决于设备";
stage.append(canvas, badge);
const fpsEl = document.createElement("div"); fpsEl.className = "bh-fps"; fpsEl.textContent = "— fps";
stage.append(fpsEl);

const controls = document.createElement("div"); controls.className = "bh-controls";
const cTitle = document.createElement("div"); cTitle.className = "bh-title"; cTitle.textContent = "参数 · 物理";
controls.append(cTitle);

const state: { inclination: number; fov: number; brightness: number; outer: number; camRadius: number; thickness: number; anim: boolean; quality: number } = {
  inclination: 0.21, fov: 1.05, brightness: 1.0, outer: 8.5, camRadius: 12.0, thickness: 0.06, anim: true, quality: 0.6,
};

let running = false, raf = 0, t0 = performance.now(), elapsed = 0, fpsFrames = 0, fpsLast = performance.now();

function slider(label: string, min: number, max: number, step: number, value: number, onInput: (v: number) => void, fmt: (v: number) => string): HTMLInputElement {
  const row = document.createElement("label"); row.className = "bh-row";
  const name = document.createElement("span"); name.className = "bh-label"; name.textContent = label;
  const input = document.createElement("input"); input.type = "range";
  input.min = String(min); input.max = String(max); input.step = String(step); input.value = String(value);
  const val = document.createElement("span"); val.className = "bh-val"; val.textContent = fmt(value);
  input.addEventListener("input", () => { const v = Number(input.value); val.textContent = fmt(v); onInput(v); });
  row.append(name, input, val);
  controls.append(row);
  return input;
}

const camSlider = slider("距离", 6, 30, 0.5, state.camRadius, (v) => { state.camRadius = v; if (!running) render(); }, (v) => v.toFixed(1) + " rs");
const incSlider = slider("倾角", 0, 85, 1, Math.round(state.inclination * 180 / Math.PI), (v) => { state.inclination = v * Math.PI / 180; if (!running) render(); }, (v) => v.toFixed(0) + "°");
const fovSlider = slider("视场角", 30, 95, 1, Math.round(state.fov * 180 / Math.PI), (v) => { state.fov = v * Math.PI / 180; if (!running) render(); }, (v) => v.toFixed(0) + "°");
const briSlider = slider("盘亮度", 0.2, 3, 0.05, state.brightness, (v) => { state.brightness = v; if (!running) render(); }, (v) => v.toFixed(2));
const outSlider = slider("盘外径", 4, 14, 0.25, state.outer, (v) => { state.outer = v; if (!running) render(); }, (v) => v.toFixed(2) + " rs");
const thickSlider = slider("厚度", 0.02, 0.25, 0.01, state.thickness, (v) => { state.thickness = v; if (!running) render(); }, (v) => v.toFixed(2));

const animRow = document.createElement("div"); animRow.className = "bh-toggle";
const animLabel = document.createElement("span"); animLabel.textContent = "吸积盘运动";
const animCheck = document.createElement("input"); animCheck.type = "checkbox"; animCheck.checked = state.anim;
animCheck.addEventListener("change", () => { state.anim = animCheck.checked; if (state.anim) { fpsFrames = 0; fpsLast = performance.now(); fpsEl.textContent = "…"; start(); } else { state.anim = false; running = false; render(); fpsEl.textContent = "暂停"; } });
animRow.append(animLabel, animCheck);

const qRow = document.createElement("div"); qRow.className = "bh-toggle";
const qLabel = document.createElement("span"); qLabel.textContent = "画质";
const qBtnRow = document.createElement("div"); qBtnRow.className = "bh-btns"; qBtnRow.style.flex = "1";
const qLow = document.createElement("button"); qLow.textContent = "流畅";
const qHigh = document.createElement("button"); qHigh.textContent = "精细";
qLow.setAttribute("class", "active");
function setQuality(q: number) { state.quality = q; qLow.setAttribute("class", q < 0.75 ? "active" : ""); qHigh.setAttribute("class", q >= 0.75 ? "active" : ""); if (!running) render(); }
qLow.addEventListener("click", () => setQuality(0.5));
qHigh.addEventListener("click", () => setQuality(0.85));
qBtnRow.append(qLow, qHigh);
qRow.append(qLabel, qBtnRow);

controls.append(animRow, qRow);

const resetBtn = document.createElement("button"); resetBtn.textContent = "重置视角";
resetBtn.addEventListener("click", () => {
  state.camRadius = 12.0; state.inclination = 0.21; state.fov = 1.05; state.brightness = 1.0; state.outer = 8.5; state.thickness = 0.06;
  camSlider.value = "12"; incSlider.value = "12"; fovSlider.value = "60"; briSlider.value = "1"; outSlider.value = "8.5"; thickSlider.value = "0.06";
  if (!running) render();
});
const resetRow = document.createElement("div"); resetRow.className = "bh-btns"; resetRow.style.marginTop = "10px";
resetRow.append(resetBtn);
controls.append(resetRow);

const foot = document.createElement("div"); foot.className = "bh-foot";
foot.textContent = "物理：光子按 Schwarzschild 度规积分。临界碰撞参数 b_crit = 3√3/2 · rs（≈2.6 rs）形成黑洞阴影；吸积盘按 Keplerian 速度产生多普勒增亮/蓝移与引力红移，光子环由透镜自然涌现。";
app.append(header, stage, controls, foot);

// ---------- WebGL (WebGL2 then WebGL1, then image fallback) ----------
function showImageFallback(msg: string) {
  const img = document.createElement("img");
  img.className = "bh-fallback-img";
  img.src = "./preview.png";
  img.alt = "黑洞（CPU 预渲染）";
  stage.appendChild(img);
  canvas.style.display = "none";
  badge.textContent = "已显示 CPU 预渲染图";
  fpsEl.style.display = "none";
  const note = document.createElement("div"); note.className = "bh-note";
  note.textContent = msg;
  stage.appendChild(note);
}

const attrs = { antialias: false, depth: false, stencil: false, alpha: false };
let gl: WebGLRenderingContext | WebGL2RenderingContext | null = canvas.getContext("webgl2", attrs) as WebGL2RenderingContext | null;
let isWebGL2 = !!gl;
if (!gl) gl = canvas.getContext("webgl", attrs) as WebGLRenderingContext | null;
if (!gl) gl = canvas.getContext("experimental-webgl", attrs) as WebGLRenderingContext | null;
if (!gl) { showImageFallback("此设备/浏览器不支持 WebGL，已显示 CPU 预渲染的黑洞图。"); return; }

const GL = gl;
function compile(type: number, src: string): WebGLShader {
  const sh = GL.createShader(type)!;
  GL.shaderSource(sh, src);
  GL.compileShader(sh);
  if (!GL.getShaderParameter(sh, GL.COMPILE_STATUS)) {
    throw new Error(GL.getShaderInfoLog(sh) || "compile failed");
  }
  return sh;
}
function buildProgram(vs: string, fs: string): WebGLProgram | null {
  try {
    const v = compile(GL.VERTEX_SHADER, vs);
    const f = compile(GL.FRAGMENT_SHADER, fs);
    const prog = GL.createProgram()!;
    GL.attachShader(prog, v); GL.attachShader(prog, f);
    GL.linkProgram(prog);
    if (!GL.getProgramParameter(prog, GL.LINK_STATUS)) return null;
    return prog;
  } catch { return null; }
}

let vsSrc = VERT, fsSrc = FRAG;
if (!isWebGL2) { vsSrc = toGLSL1vert(VERT); fsSrc = toGLSL1(FRAG); }
let prog = buildProgram(vsSrc, fsSrc);
if (!prog && !isWebGL2) prog = buildProgram(vsSrc, fsSrc.replace("precision highp float;", "precision mediump float;"));
if (!prog) { showImageFallback("GPU 着色器编译/链接失败，已显示 CPU 预渲染的黑洞图。"); return; }
GL.useProgram(prog);

const quad = GL.createBuffer();
GL.bindBuffer(GL.ARRAY_BUFFER, quad);
GL.bufferData(GL.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), GL.STATIC_DRAW);
const aPos = GL.getAttribLocation(prog, "aPos");
GL.enableVertexAttribArray(aPos);
GL.vertexAttribPointer(aPos, 2, GL.FLOAT, false, 0, 0);

const U = {
  res: GL.getUniformLocation(prog, "uResolution"),
  time: GL.getUniformLocation(prog, "uTime"),
  cam: GL.getUniformLocation(prog, "uCamRadius"),
  inc: GL.getUniformLocation(prog, "uInclination"),
  fov: GL.getUniformLocation(prog, "uFov"),
  inner: GL.getUniformLocation(prog, "uDiskInner"),
  outer: GL.getUniformLocation(prog, "uDiskOuter"),
  thick: GL.getUniformLocation(prog, "uDiskThickness"),
  thot: GL.getUniformLocation(prog, "uTHot"),
  bri: GL.getUniformLocation(prog, "uBrightness"),
  anim: GL.getUniformLocation(prog, "uAnim"),
  show: GL.getUniformLocation(prog, "uShowDisk"),
  steps: GL.getUniformLocation(prog, "uMaxSteps"),
};

const dpr = Math.min(window.devicePixelRatio || 1, 2);
function render() {
  const w = Math.max(1, Math.round(stage.clientWidth * state.quality * dpr));
  const h = Math.max(1, Math.round(stage.clientHeight * state.quality * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  GL.viewport(0, 0, w, h);
  GL.uniform2f(U.res, w, h);
  GL.uniform1f(U.time, elapsed);
  GL.uniform1f(U.cam, state.camRadius);
  GL.uniform1f(U.inc, state.inclination);
  GL.uniform1f(U.fov, state.fov);
  GL.uniform1f(U.inner, 3.0);
  GL.uniform1f(U.outer, state.outer);
  GL.uniform1f(U.thick, state.thickness);
  GL.uniform1f(U.thot, 6500.0);
  GL.uniform1f(U.bri, state.brightness);
  GL.uniform1f(U.anim, state.anim ? 1.0 : 0.0);
  GL.uniform1f(U.show, 1.0);
  GL.uniform1f(U.steps, state.quality >= 0.75 ? 320.0 : 200.0);
  GL.clearColor(0, 0, 0, 1);
  GL.clear(GL.COLOR_BUFFER_BIT);
  GL.drawArrays(GL.TRIANGLES, 0, 3);
}

function frame() {
  if (!running) return;
  const now = performance.now();
  const d = Math.min(0.1, (now - t0) / 1000);
  t0 = now;
  elapsed += d;
  render();
  fpsFrames++;
  if (now - fpsLast >= 500) {
    fpsEl.textContent = Math.round(fpsFrames * 1000 / (now - fpsLast)) + " fps";
    fpsFrames = 0;
    fpsLast = now;
  }
  raf = requestAnimationFrame(frame);
}
function start() {
  if (running) return;
  running = true;
  t0 = performance.now();
  frame();
}

window.addEventListener("resize", () => { if (!running) render(); });
canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); showImageFallback("WebGL 上下文丢失，已显示 CPU 预渲染的黑洞图。"); });

  render();
  if (state.anim) start();
}
void boot();
