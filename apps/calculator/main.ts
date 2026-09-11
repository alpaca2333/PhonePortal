type Tok = { type: "num"; value: number } | { type: "op"; value: Op };
type Op = "+" | "-" | "×" | "÷" | "%" | "(" | ")";

const root = document.getElementById("app")!;
let tokens: Tok[] = [];
let cur: string | null = null;
let curNeg = false;
let lastWasOp = false;

function fmt(n: number): string {
  if (!isFinite(n)) return "错误";
  const s = Math.round(n * 1e10) / 1e10;
  return String(s);
}
function exprString(): string {
  let s = tokens.map((t) => (t.type === "num" ? fmt(t.value) : t.value)).join("");
  if (cur !== null) s += (curNeg ? "-" : "") + cur;
  return s || "0";
}
function setDisplay(): void {
  const exp = root.querySelector("#expr"); if (exp) exp.textContent = exprString();
  const res = root.querySelector("#res"); if (res) res.textContent = " ";
}
function finalizeCurrent(): void {
  if (cur === null) return;
  const v = parseFloat(cur);
  tokens.push({ type: "num", value: curNeg ? -v : v });
  cur = null; curNeg = false; lastWasOp = false;
}
function pushOp(op: Op): void {
  if (cur !== null) { finalizeCurrent(); }
  const top = tokens[tokens.length - 1];
  if (top?.type === "op" && (top.value === "+" || top.value === "-" || top.value === "×" || top.value === "÷")) {
    tokens[tokens.length - 1] = { type: "op", value: op };
  } else {
    tokens.push({ type: "op", value: op });
  }
  lastWasOp = true;
}
function inputDigit(d: string): void {
  if (cur === null) { cur = d === "." ? "0." : d; }
  else {
    if (d === "." && cur.includes(".")) return;
    if (cur === "0" && d !== ".") cur = d;
    else if (cur.startsWith("0.") === false && cur === "0" && d !== ".") cur = d;
    else cur += d;
  }
  lastWasOp = false;
  setDisplay();
}
// handle 0 -> digit replacement cleanly
function inputDigit2(d: string): void {
  if (d === ".") {
    if (cur === null) cur = "0.";
    else if (!cur.includes(".")) cur += ".";
    lastWasOp = false; setDisplay(); return;
  }
  if (cur === null) { cur = d; }
  else if (cur === "0") { cur = d; }
  else { cur += d; }
  lastWasOp = false;
  setDisplay();
}
function percent(): void {
  if (cur !== null) {
    const v = parseFloat(cur) / 100;
    tokens.push({ type: "num", value: curNeg ? -v : v });
    cur = null; curNeg = false; lastWasOp = false;
  } else {
    const top = tokens[tokens.length - 1];
    if (top?.type === "num") tokens[tokens.length - 1] = { type: "num", value: top.value / 100 };
  }
  setDisplay();
}
function toggleSign(): void {
  if (cur !== null) { curNeg = !curNeg; }
  else {
    const top = tokens[tokens.length - 1];
    if (top?.type === "num") tokens[tokens.length - 1] = { type: "num", value: -top.value };
    else if (top?.type === "op" && top.value === "-" && tokens.length >= 2) {
      // unary minus already handled via parser; toggle easier on numbers
    }
  }
  setDisplay();
}
function backspace(): void {
  if (cur !== null && cur.length > 0) { cur = cur.slice(0, -1); if (cur === "" || cur === "-") { cur = null; } }
  else if (cur === null) { const t = tokens.pop(); if (t && t.type === "num") { cur = fmt(Math.abs(t.value)); curNeg = t.value < 0; } }
  setDisplay();
}
function evaluate(t: Tok[]): number {
  if (t.length === 0) return 0;
  let pos = 0;
  const peek = () => t[pos];
  const next = () => t[pos++]!;
  const num = (v: number): Tok => ({ type: "num", value: v });
  function expr(): number {
    let left = term();
    while (peek() && (peek().value === "+" || peek().value === "-")) {
      const op = next().value as "+" | "-";
      const right = term();
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }
  function term(): number {
    let left = factor();
    while (peek() && (peek().value === "×" || peek().value === "÷")) {
      const op = next().value as "×" | "÷";
      const right = factor();
      left = op === "×" ? left * right : (right === 0 ? NaN : left / right);
    }
    return left;
  }
  function factor(): number {
    let neg = false;
    if (peek()?.value === "-") { next(); neg = true; }
    const tk = peek();
    if (!tk) return NaN;
    let val: number;
    if (tk.type === "num") { next(); val = tk.value; }
    else if (tk.value === "(") { next(); val = expr(); if (peek()?.value === ")") next(); }
    else return NaN;
    if (peek()?.value === "%") { next(); val = val / 100; }
    return neg ? -val : val;
  }
  const r = expr();
  return r;
}
function equals(): void {
  if (cur !== null) finalizeCurrent();
  if (tokens.length === 0) return;
  const top = tokens[tokens.length - 1];
  if (top?.type === "op") tokens.pop();
  const result = evaluate(tokens);
  tokens = [{ type: "num", value: result }];
  cur = null; curNeg = false; lastWasOp = false;
  const exp = root.querySelector("#expr"); if (exp) exp.textContent = "";
  const res = root.querySelector("#res"); if (res) res.textContent = fmt(result);
}
function clearAll(): void { tokens = []; cur = null; curNeg = false; lastWasOp = false; const exp = root.querySelector("#expr"); if (exp) exp.textContent = ""; const res = root.querySelector("#res"); if (res) res.textContent = "0"; }

const BUTTONS: { label: string; type: string }[] = [
  { label: "C", type: "fn" }, { label: "⌫", type: "fn" }, { label: "%", type: "fn" }, { label: "÷", type: "op" },
  { label: "7", type: "num" }, { label: "8", type: "num" }, { label: "9", type: "num" }, { label: "×", type: "op" },
  { label: "4", type: "num" }, { label: "5", type: "num" }, { label: "6", type: "num" }, { label: "-", type: "op" },
  { label: "1", type: "num" }, { label: "2", type: "num" }, { label: "3", type: "num" }, { label: "+", type: "op" },
  { label: "±", type: "fn" }, { label: "0", type: "num" }, { label: ".", type: "num" }, { label: "=", type: "eq" },
];

function render(): void {
  root.innerHTML = `<header><h1>🧮 计算器</h1><p>内置表达式解析，无需网络</p></header>
    <div class="display"><div class="expr" id="expr"></div><div class="result" id="res">0</div></div>
    <div class="keys" id="keys"></div>`;
  const keys = root.querySelector("#keys")!;
  for (const b of BUTTONS) {
    const btn = document.createElement("button");
    btn.className = "key " + b.type;
    btn.textContent = b.label;
    btn.addEventListener("click", () => handle(b.label));
    keys.appendChild(btn);
  }
}
function handle(label: string): void {
  if (/^[0-9]$/.test(label)) { inputDigit2(label); return; }
  switch (label) {
    case ".": inputDigit2("."); break;
    case "+": case "-": case "×": case "÷": pushOp(label); setDisplay(); break;
    case "%": percent(); break;
    case "±": toggleSign(); break;
    case "⌫": backspace(); break;
    case "C": clearAll(); break;
    case "=": equals(); break;
  }
}
render();
