#!/usr/bin/env node
/* eSidro - jedan server za sve:
 *   /            web aplikacija (web/)
 *   /api/find    ?lat&lon ili ?q=mjesto  -> najbolja sidrišta u blizini
 *   /api/check   ?lat&lon                -> procjena jedne točke
 *   /api/geocode ?q=mjesto
 *   /mcp         MCP (Streamable HTTP) za ChatGPT, Claude i druge AI asistente
 */
import http from "node:http";
// Lokalni tajni ključevi (npr. AISSTREAM_KEY) iz .env, ako postoji; .env je u .gitignore
try { process.loadEnvFile(); } catch { /* nema .env */ }
import { readFile, stat } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { WEB } from "./engine.js";
import { handleApi, handleMcp, handleReports, handleSos, send } from "./handlers.js";

const PORT = +process.env.PORT || 5173;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".geojson": "application/geo+json", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };

async function files(u, req, res) {
  let p = decodeURIComponent(u.pathname);
  if (p.endsWith("/")) p += "index.html";
  const file = path.normalize(path.join(WEB, p));
  if (!file.startsWith(WEB)) return send(res, 403, { error: "Zabranjeno" });
  try {
    let buf = await readFile(file);
    const type = TYPES[path.extname(file)] || "application/octet-stream";
    const headers = { "Content-Type": type,
      "Cache-Control": file.includes(`${path.sep}tiles${path.sep}`) && file.endsWith(".png") ? "public, max-age=604800"
        : file.includes(`${path.sep}data${path.sep}`) ? "public, max-age=3600" : "no-cache" };
    // Tekst (GeoJSON ~1,6 MB) šaljemo sažeto, kao što to radi i Vercel
    if (!type.startsWith("image/") && /\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
      const { mtimeMs } = await stat(file);
      const hit = gzCache.get(file);
      if (hit?.mtimeMs !== mtimeMs) gzCache.set(file, { mtimeMs, gz: gzipSync(buf) });
      buf = gzCache.get(file).gz;
      Object.assign(headers, { "Content-Encoding": "gzip", Vary: "Accept-Encoding" });
    }
    res.writeHead(200, headers);
    res.end(buf);
  } catch { send(res, 404, { error: "Nema datoteke" }); }
}
const gzCache = new Map();

http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (u.pathname === "/mcp" || u.pathname === "/api/mcp") return await handleMcp(req, res);
    if (u.pathname === "/api/sos") return await handleSos(req, res);
    if (u.pathname === "/api/reports") return await handleReports(req, res);
    if (u.pathname.startsWith("/api/")) return await handleApi(u.pathname.slice(5), req, res);
    return await files(u, req, res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 502, { error: e.message });
  }
}).listen(PORT, () => {
  console.log(`eSidro: http://localhost:${PORT}  ·  MCP: http://localhost:${PORT}/mcp`);
});
