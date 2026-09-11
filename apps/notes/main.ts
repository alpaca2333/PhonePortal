const KEY = "portal.notes.v1";
type Note = { id: string; text: string; ts: number };
const root = document.getElementById("app")!;

function load(): Note[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "[]") as Note[]; } catch { return []; }
}
function save(n: Note[]): void { localStorage.setItem(KEY, JSON.stringify(n)); }
function fmt(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

let notes: Note[] = load();

function render(): void {
  const html =
    `<header><h1>📝 我的笔记</h1><p>共 ${notes.length} 条，保存在本机</p></header>` +
    `<div class="composer"><textarea id="text" placeholder="写点什么…" rows="2"></textarea><button id="add">添加</button></div>` +
    (notes.length === 0
      ? `<div class="list"><div class="empty">还没有笔记，写一条吧 ✍️</div></div>`
      : `<div class="list">${notes.map((n) =>
          `<div class="note" data-id="${n.id}"><div class="text">${n.text.replace(/</g, "&lt;")}</div><div class="meta"><span>${fmt(n.ts)}</span><button class="del">删除</button></div></div>`
        ).join("")}</div>`);

  root.innerHTML = html;

  const textarea = root.querySelector<HTMLTextAreaElement>("#text")!;
  const add = () => {
    const text = textarea.value.trim();
    if (!text) return;
    notes.unshift({ id: String(Date.now()) + Math.random().toString(16).slice(2), text, ts: Date.now() });
    save(notes);
    render();
  };
  root.querySelector("#add")?.addEventListener("click", add);
  textarea.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); add(); } });

  root.querySelectorAll<HTMLButtonElement>(".del").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.closest(".note")?.getAttribute("data-id");
      notes = notes.filter((n) => n.id !== id);
      save(notes);
      render();
    });
  });
}

render();
