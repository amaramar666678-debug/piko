// Renders the overview's agent row with the "+" open, so the picker's layout and
// in-card placement can be checked without clicking inside a running app.
//
// The agent list is spelled out here rather than imported from core/state: that
// module pulls in the Tauri bridge, which throws in a plain browser page and
// leaves the harness blank.
const AGENTS = [
  { id: "integration_resend", name: "Resend", color: "#22C55E" },
  { id: "integration_n8n", name: "n8n", color: "#F29B38" },
  { id: "integration_vercel", name: "Vercel", color: "#7C5CFF" },
  { id: "integration_github", name: "GitHub", color: "#F4505E" },
  { id: "integration_notion", name: "Notion", color: "#8C8C8C" },
  { id: "integration_calcom", name: "Cal.com", color: "#C9956A" },
  { id: "integration_stripe", name: "Stripe", color: "#0570DE" },
];

const row = document.getElementById("row")!;

const IN_ROW = new Set(["integration_resend", "integration_n8n", "integration_vercel", "integration_github"]);
const available = AGENTS.filter((t) => !IN_ROW.has(t.id));

function pill(id: string, name: string, color: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "pill";
  el.style.borderColor = `${color}24`;
  const dot = document.createElement("span");
  dot.style.cssText = `width:14px;height:14px;border-radius:50%;background:${color};margin-left:7px`;
  const lbl = document.createElement("span");
  lbl.className = "lbl";
  lbl.style.cssText =
    "position:absolute;left:0;right:0;text-align:center;font:600 10px system-ui;color:#8b8f99;pointer-events:none";
  lbl.textContent = name;
  el.append(dot, lbl);
  el.title = id;
  return el;
}

const grid = document.createElement("div");
grid.className = "pill-grid";
for (const id of IN_ROW) {
  const t = AGENTS.find((x) => x.id === id)!;
  grid.append(pill(id, t.name, t.color));
}

const add = document.createElement("button");
add.className = "pill add";
add.textContent = "+";
add.title = "Add an agent";

const picker = document.createElement("div");
picker.className = "agent-picker";
for (const t of available) {
  const b = document.createElement("button");
  b.className = "agent-row";
  const i = document.createElement("i");
  i.style.background = t.color;
  const s = document.createElement("span");
  s.textContent = t.name;
  b.append(i, s);
  b.title = `Give ${t.name} a slot in the row`;
  picker.append(b);
}
const done = document.createElement("button");
done.className = "agent-picker-done";
done.textContent = "Done";
picker.append(done);

const wrapA = document.createElement("div");
wrapA.className = "pills";
wrapA.append(grid, add);
const wrapB = document.createElement("div");
wrapB.className = "pills";
wrapB.append(picker);

for (const [n, w] of [[0, wrapA], [1, wrapB]].entries()) {
  const label = document.createElement("div");
  label.style.cssText = "font:600 11px system-ui;color:#6b6f78;padding:6px 10px 2px";
  label.textContent = n === 0 ? "row with +" : "+ open (inline, inside the card)";
  w.style.cssText =
    "position:relative;display:flex;align-items:center;gap:6px;padding:0 8px;height:60px;background:#15171a;border-radius:12px;margin:6px 10px";
  row.append(label, w);
}

document.title = "ready";