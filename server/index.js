#!/usr/bin/env node
/* Sigurno sidrište - jedan server za sve:
 *   /            web aplikacija (web/)
 *   /api/find    ?lat&lon ili ?q=mjesto  -> najbolja sidrišta u blizini
 *   /api/check   ?lat&lon                -> procjena jedne točke
 *   /api/geocode ?q=mjesto
 *   /mcp         MCP (Streamable HTTP) za ChatGPT, Claude i druge AI asistente
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { WEB } from "./engine.js";
import { handleApi, handleMcp, handleSos, send } from "./handlers.js";

const PORT = +process.env.PORT || 5173;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".geojson": "application/geo+json", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };

async function files(u, res) {
  let p = decodeURIComponent(u.pathname);
  if (p.endsWith("/")) p += "index.html";
  const file = path.normalize(path.join(WEB, p));
  if (!file.startsWith(WEB)) return send(res, 403, { error: "Zabranjeno" });
  try {
    const buf = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
      "Cache-Control": file.includes(`${path.sep}tiles${path.sep}`) && file.endsWith(".png") ? "public, max-age=604800"
        : file.includes(`${path.sep}data${path.sep}`) ? "public, max-age=3600" : "no-cache" });
    res.end(buf);
  } catch { send(res, 404, { error: "Nema datoteke" }); }
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (u.pathname === "/mcp" || u.pathname === "/api/mcp") return await handleMcp(req, res);
    if (u.pathname === "/api/sos") return await handleSos(req, res);
    if (u.pathname.startsWith("/api/")) return await handleApi(u.pathname.slice(5), req, res);
    return await files(u, res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 502, { error: e.message });
  }
}).listen(PORT, () => {
  console.log(`Sigurno sidrište: http://localhost:${PORT}  ·  MCP: http://localhost:${PORT}/mcp`);
});
