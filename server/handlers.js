// Zajednički HTTP rukovatelji: koristi ih lokalni server (server/index.js) i Vercel funkcije (api/*.js).
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { engine } from "./engine.js";
import { createMcpServer } from "../mcp/tools.js";
import { simulatedWeather } from "../web/core.js";

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
    // ?sim=bura|jugo: simulirana prognoza za testiranje i demonstraciju (rezultat nosi weather.simulated = true)
    const weather = simulatedWeather(u.searchParams.get("sim")) ?? undefined;
    if (route === "check") return send(res, 200, await engine.checkSpot(where.lat, where.lon, { boat, weather }));
    if (route === "find") {
      const radiusKm = Math.min(8, Math.max(1, parseFloat(u.searchParams.get("r")) || 4));
      return send(res, 200, { name, ...(await engine.findSpots(where.lat, where.lon, { radiusKm, max: 5, boat, weather })) });
    }
    send(res, 404, { error: "Nepoznata ruta" });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 502, { error: e.message });
  }
}

/* ---------------- SOS (DEMO) ----------------
 * Samo demonstracija: zahtjev se zapiše u log servera i vrati se MAYDAY poruka za simulirano VHF emitiranje.
 * Ništa se ne prosljeđuje spasiocima, obalnoj straži ni na pravi radio. */
const NATURE = {
  voda: "TAKING ON WATER", pozar: "FIRE ON BOARD", covjek: "MAN OVERBOARD",
  nasukavanje: "AGROUND", kvar: "ENGINE FAILURE, DRIFTING", ostalo: "IN DISTRESS",
};
const DIGITS = ["ZERO", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINER"];
const spell = (s) => [...s].map((c) => (c === "." ? "DECIMAL" : DIGITS[+c])).join(" ");
// 44.9703 -> 44°58.2'N (radio: stupnjevi i minute s jednom decimalom)
function radioPos(v, pad, pos, neg) {
  const a = Math.round(Math.abs(v) * 600) / 600, d = Math.floor(a), m = ((a - d) * 60).toFixed(1).padStart(4, "0"); // zaokruži na 0,1' prije dijeljenja (bez 60.0')
  const deg = String(d).padStart(pad, "0"), side = v >= 0 ? pos : neg;
  return { text: `${deg}°${m}'${side}`, spoken: `${spell(deg)} DEGREES ${spell(m)} MINUTES ${{ N: "NORTH", S: "SOUTH", E: "EAST", W: "WEST" }[side]}` };
}

export async function handleSos(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Koristi POST" });
  try {
    const b = req.body !== undefined ? (typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body)
      : JSON.parse((await readBody(req)) || "{}");
    const lat = +b.lat, lon = +b.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return send(res, 400, { error: "Nedostaje položaj" });
    const nature = NATURE[b.nature] ? b.nature : "ostalo";
    const people = Math.min(99, Math.max(1, parseInt(b.people, 10) || 1));
    const vessel = String(b.vessel || "").replace(/[^\p{L}\p{N} .-]/gu, "").trim().slice(0, 30).toUpperCase() || "SIGURNO SIDRISTE";
    const la = radioPos(lat, 2, "N", "S"), lo = radioPos(lon, 3, "E", "W");
    const id = `DEMO-${Date.now().toString(36).toUpperCase()}`;
    const lines = (pos, persons) => [
      "MAYDAY, MAYDAY, MAYDAY", `THIS IS ${vessel}, ${vessel}, ${vessel}`, `MAYDAY ${vessel}`,
      `MY POSITION IS ${pos}`, NATURE[nature], persons, "I REQUIRE IMMEDIATE ASSISTANCE", "OVER",
    ];
    console.log(`[DEMO SOS] ${id} ${la.text} ${lo.text} ${nature}, ${people} osoba - NIJE proslijeđeno nikome`);
    send(res, 200, {
      demo: true, forwarded: false, id, receivedAt: new Date().toISOString(),
      position: `${la.text} ${lo.text}`, nature, people, vessel,
      mayday: lines(`${la.text} ${lo.text}`, `${people} PERSONS ON BOARD`),
      spoken: lines(`${la.spoken}, ${lo.spoken}`, `${spell(String(people))} PERSONS ON BOARD`),
    });
  } catch {
    if (!res.headersSent) send(res, 400, { error: "Neispravan zahtjev" });
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
