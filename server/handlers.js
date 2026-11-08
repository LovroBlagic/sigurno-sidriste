// Zajednički HTTP rukovatelji: koristi ih lokalni server (server/index.js) i Vercel funkcije (api/*.js).
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { engine } from "./engine.js";
import { createMcpServer } from "../mcp/tools.js";

export const send = (res, code, obj, cache = "no-store") => {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", cache);
  res.end(JSON.stringify(obj));
};

function coords(u) {
  const lat = parseFloat(u.searchParams.get("lat")), lon = parseFloat(u.searchParams.get("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < 41.5 || lat > 46.6 || lon < 12 || lon > 20) return null;
  return { lat, lon };
}

const urlOf = (req) => new URL(req.url, `http://${req.headers.host || "localhost"}`);

// route: "find" | "check" | "geocode"
export async function handleApi(route, req, res) {
  const u = urlOf(req);
  try {
    if (route === "geocode") {
      const q = u.searchParams.get("q")?.trim();
      if (!q) return send(res, 400, { error: "Nedostaje q" });
      const g = await engine.geocode(q);
      return g ? send(res, 200, g, "public, max-age=86400") : send(res, 404, { error: `Ne mogu pronaći "${q}"` });
    }
    let where = coords(u);
    let name = null;
    if (!where && u.searchParams.get("q")) {
      const g = await engine.geocode(u.searchParams.get("q"));
      if (!g) return send(res, 404, { error: `Ne mogu pronaći "${u.searchParams.get("q")}"` });
      where = g; name = g.name;
    }
    if (!where) return send(res, 400, { error: "Zadaj lat i lon (unutar hrvatskog Jadrana) ili q" });
    const boat = { draft: u.searchParams.get("gaz"), chain: u.searchParams.get("lanac"), length: u.searchParams.get("duljina") };
    if (route === "check") return send(res, 200, await engine.checkSpot(where.lat, where.lon, { boat }));
    if (route === "find") {
      const radiusKm = Math.min(8, Math.max(1, parseFloat(u.searchParams.get("r")) || 4));
      return send(res, 200, { name, ...(await engine.findSpots(where.lat, where.lon, { radiusKm, max: 5, boat })) });
    }
    send(res, 404, { error: "Nepoznata ruta" });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 502, { error: e.message });
  }
}

const readBody = (req) => new Promise((ok, bad) => {
  let s = ""; req.on("data", (c) => { s += c; if (s.length > 1e6) req.destroy(); }); req.on("end", () => ok(s)); req.on("error", bad);
});

// MCP bez stanja: novi poslužitelj po zahtjevu, radi i na serverless platformama
export async function handleMcp(req, res) {
  try {
    let body;
    if (req.method === "POST") {
      if (req.body !== undefined) body = typeof req.body === "string" ? JSON.parse(req.body || "null") : req.body; // Vercel već pročita tijelo
      else body = JSON.parse((await readBody(req)) || "null");
    }
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: e.message }, id: null });
  }
}
