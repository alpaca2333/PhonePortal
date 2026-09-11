const root = document.getElementById("app")!;

const WEEK = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

function renderClockHtml(): string {
  return `<header><h1>⏰ 时钟</h1><p>本机时间</p></header>
    <div class="clock-card">
      <div class="clock-time" id="time">--:--:--</div>
      <div class="clock-date" id="date"></div>
      <div class="clock-week" id="week"></div>
    </div>
    <div class="stop">
      <h2>秒表</h2>
      <div class="sw-display" id="sw">00:00.00</div>
      <div class="sw-controls">
        <button id="swStart">开始</button>
        <button id="swReset">归零</button>
      </div>
      <div class="laps" id="laps"></div>
    </div>`;
}

// ---- live clock ----
function updateClock(): void {
  const now = new Date();
  const t = root.querySelector("#time"); if (t) t.textContent = now.toLocaleTimeString("zh-CN", { hour12: false });
  const d = root.querySelector("#date"); if (d) d.textContent = now.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
  const w = root.querySelector("#week"); if (w) w.textContent = WEEK[now.getDay()]!;
}

// ---- stopwatch ----
let running = false, startAt = 0, elapsed = 0, raf = 0;
const fmtMs = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms));
  const mm = String(Math.floor(total / 60000)).padStart(2, "0");
  const ss = String(Math.floor((total % 60000) / 1000)).padStart(2, "0");
  const cs = String(Math.floor((total % 1000) / 10)).padStart(2, "0");
  return mm + ":" + ss + "." + cs;
};
function tick(): void {
  const now = performance.now();
  const total = elapsed + (running ? now - startAt : 0);
  const el = root.querySelector("#sw"); if (el) el.textContent = fmtMs(total);
  if (running) raf = requestAnimationFrame(tick);
}
function start(): void {
  startAt = performance.now(); running = true;
  const b = root.querySelector("#swStart"); if (b) b.textContent = "暂停";
  tick();
}
function pause(): void {
  elapsed += performance.now() - startAt; running = false;
  cancelAnimationFrame(raf);
  const b = root.querySelector("#swStart"); if (b) b.textContent = "继续";
}
function reset(): void {
  running = false; elapsed = 0; cancelAnimationFrame(raf);
  const el = root.querySelector("#sw"); if (el) el.textContent = "00:00.00";
  const b = root.querySelector("#swStart"); if (b) b.textContent = "开始";
  const laps = root.querySelector("#laps"); if (laps) laps.innerHTML = "";
}

root.innerHTML = renderClockHtml();
root.querySelector("#swStart")?.addEventListener("click", () => (running ? pause() : start()));
root.querySelector("#swReset")?.addEventListener("click", reset);
updateClock();
setInterval(updateClock, 1000);
