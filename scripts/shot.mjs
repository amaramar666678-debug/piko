// Screenshot the island in its expanded state, via CDP over Node's built-in
// WebSocket. Chrome's --screenshot alone cannot interact, and the panel is what
// has to be looked at.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const URL = process.argv[2] ?? "http://127.0.0.1:1420";
const OUT = process.argv[3] ?? "C:\\Users\\User\\AppData\\Local\\Temp\\panel.png";
const PORT = 9333;

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    `--remote-debugging-port=${PORT}`,
    "--user-data-dir=C:\\Users\\User\\AppData\\Local\\Temp\\cprof2",
    "--window-size=760,380",
    URL,
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error("devtools never came up");
}

let nextId = 1;
function rpc(ws, method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== id) return;
      ws.removeEventListener("message", onMsg);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

try {
  const page = await targets();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.addEventListener("open", r);
    ws.addEventListener("error", j);
  });

  await rpc(ws, "Page.enable");
  await rpc(ws, "Runtime.enable");

  // Optional: pretend to be inside Tauri with an invoke that resolves and nothing
  // behind it. `chatSend` then succeeds and no `chat-done` ever arrives, which is
  // the hung turn — the one state worth being able to look at from a browser.
  if (process.env.SHOT_STUB_TAURI) {
    await rpc(ws, "Page.addScriptToEvaluateOnNewDocument", {
      source: `
        window.__TAURI_INTERNALS__ = {
          invoke: () => Promise.resolve(undefined),
          transformCallback: (cb) => { const id = Math.random(); window[id] = cb; return id; },
          metadata: {},
        };
        window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
      `,
    });
    await rpc(ws, "Page.navigate", { url: URL });
    await sleep(2500);
  }
  await sleep(6000);

  const evalJs = async (expression) => {
    const r = await rpc(ws, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return r.result?.value;
  };

  // Tap the compact bubble: pointerdown then pointerup, which is what the island
  // reads as "not a drag, open the panel".
  const tap = `
    (() => {
      const el = document.getElementById("island");
      if (!el) return "no island";
      const opts = {bubbles: true, cancelable: true, pointerId: 1, isPrimary: true,
                    clientX: 380, clientY: 20, screenX: 380, screenY: 20};
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
      return "tapped";
    })()`;
  console.log("tap:", await evalJs(tap));
  await sleep(2500);

  // The panel auto-closes on a timer once it thinks the pointer has left, and
  // headless never moves the pointer, so anything opened above folds straight back
  // up. Park a mousemove inside the island for the length of the shot.
  await evalJs(`
    (() => {
      clearInterval(window.__shotHold);
      window.__shotHold = setInterval(() => {
        const el = document.getElementById("island");
        if (!el) return;
        const r = el.getBoundingClientRect();
        el.dispatchEvent(new MouseEvent("mousemove", {
          bubbles: true,
          clientX: r.left + r.width / 2,
          clientY: r.top + Math.min(20, r.height / 2),
        }));
      }, 80);
      return "holding";
    })()`);
  await sleep(900);

  // Then optionally walk a flow: a comma-separated list of button titles, clicked in
  // order. "New task,Take n8n out of the row" opens the screen and then removes an
  // agent, which is the only way to see what the screen does when the row has room.
  const flow = (process.argv[4] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const step of flow) {
    // "click:<selector>" presses inside a container rather than a titled button —
    // the only way to test what a press on plain content does.
    if (step.startsWith("click:")) {
      const sel = step.slice(6);
      console.log(
        "press",
        sel,
        ":",
        await evalJs(`
        (() => {
          const el = document.querySelector(${JSON.stringify(sel)});
          if (!el) return "no such element";
          const r = el.getBoundingClientRect();
          const opts = {bubbles: true, cancelable: true, clientX: r.left + r.width / 2,
                        clientY: r.top + r.height / 2};
          el.dispatchEvent(new MouseEvent("mousedown", opts));
          el.dispatchEvent(new MouseEvent("mouseup", opts));
          return "pressed";
        })()`),
      );
      await sleep(1200);
      continue;
    }
    console.log(
      "click",
      step,
      ":",
      await evalJs(`
      (() => {
        const b = [...document.querySelectorAll("button")]
          .find((n) => (n.getAttribute("title") || "").toLowerCase() === ${JSON.stringify(step.toLowerCase())});
        if (!b) return "no such button";
        b.dispatchEvent(new MouseEvent("click", {bubbles: true, cancelable: true}));
        return "clicked";
      })()`),
    );
    await sleep(1200);
  }
  const view = flow.length > 0;

  const geometry = await evalJs(`
    (() => {
      const q = (s) => document.querySelector(s);
      const box = (n) => n ? (({x,y,width,height}) =>
          ({x: Math.round(x), y: Math.round(y), w: Math.round(width), h: Math.round(height)})
        )(n.getBoundingClientRect()) : null;
      const isl = q("#island"), clip = q("#island-clip"), card = q(".view.on .card") || q(".card");
      return {
        mode: q("#island").className,
        island: {style: isl.getAttribute("style"), box: box(isl),
                 radius: getComputedStyle(isl).borderRadius},
        clip: {box: box(clip), radius: getComputedStyle(clip).borderRadius,
               overflow: getComputedStyle(clip).overflow},
        card: {box: box(card), radius: card ? getComputedStyle(card).borderRadius : null},
        content: box(q("#content")),
        header: box(q("#header")),
        // Which views the sync thinks are on, and in what order the header's halves
        // sit — both have been wrong on screen at least once.
        onViews: [...document.querySelectorAll(".view.on")].map((v) => v.className),
        headerOrder: q("#header")
          ? [...q("#header").children].map((c) => c.className || c.tagName)
          : null,
      };
    })()`);
  console.log(JSON.stringify(geometry, null, 2));

  const shot = await rpc(ws, "Page.captureScreenshot", { format: "png" });
  writeFileSync(OUT, Buffer.from(shot.data, "base64"));
  console.log("wrote", OUT);

  // Zoomed into the island's top-left corner and the card's, at 6x: at 1x a 20px
  // radius is a handful of pixels and impossible to judge.
  const zoom = async (name, x, y, w, h) => {
    const s = await rpc(ws, "Page.captureScreenshot", {
      format: "png",
      clip: { x, y, width: w, height: h, scale: 6 },
    });
    const p = OUT.replace(/\.png$/, `-${name}.png`);
    writeFileSync(p, Buffer.from(s.data, "base64"));
    console.log("wrote", p);
  };
  // The zoomed corners are for judging radii on the overview; a named view is
  // looked at whole.
  if (!view) {
    await zoom("island-tl", 30, 0, 110, 80);
    await zoom("card-tl", 42, 34, 90, 60);
  }
  ws.close();
} finally {
  chrome.kill();
}