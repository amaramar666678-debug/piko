// Minimal static server for the built island, so the DOM can be screenshotted
// without a Tauri build cycle. Dev tool; not part of the app.
//
// `--with-faces` also drops scripts/faces.html into dist and serves it, for the
// side-by-side character face check (see `npm run faces`).
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { copyFileSync, existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const ROOT = process.argv[2] || "dist";
const PORT = Number(process.argv[3] || 5199);
const WITH_FACES = process.argv.includes("--with-faces");

if (WITH_FACES) {
  // Serve scripts/faces.html at /faces.html without leaving it inside dist, so
  // the harness can never be picked up by a real Tauri bundle.
  await mkdir(ROOT, { recursive: true });
  copyFileSync("scripts/faces.html", join(ROOT, ".faces.html"));
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

createServer(async (req, res) => {
  const url = (req.url || "/").split("?")[0];
  if (url === "/faces.html") {
    const body = await readFile(join(ROOT, ".faces.html"));
    res.writeHead(200, { "content-type": TYPES[".html"] });
    res.end(body);
    return;
  }
  const rel = url === "/" ? "index.html" : normalize(url).replace(/^([/\\])+/, "");
  const file = join(ROOT, rel);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end("no");
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(PORT, () => console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}`));