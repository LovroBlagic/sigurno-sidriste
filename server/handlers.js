// Zajednički HTTP rukovatelji: koristi ih lokalni server (server/index.js) i Vercel funkcije (api/*.js).
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { engine } from "./engine.js";
import { createMcpServer } from "../mcp/tools.js";
import { simulatedWeather } from "../web/core.js";
import { hasKey, vesselsIn } from "./vessels.js";

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
    if (route === "vessels") {
      // ?bbox=s,w,n,e (kadar karte); bez ključa 503 pa web prikazuje VesselFinder prozor
      if (!hasKey()) return send(res, 503, { error: "AIS nije podešen (AISSTREAM_KEY)" });
      const [s, w, n, e] = (u.searchParams.get("bbox") || "").split(",").map(Number);
      if (![s, w, n, e].every(Number.isFinite) || n - s > 3 || e - w > 4) return send(res, 400, { error: "Zadaj bbox=s,w,n,e (najviše 3x4 stupnja)" });
      return send(res, 200, { vessels: await vesselsIn({ s, w, n, e }) });
    }
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
    if (route === "topo") return send(res, 200, await engine.topoAt(where.lon, where.lat), "public, max-age=86400");
    // ?water=1|0: je li točka more prema OSM obali (web aplikacija to čita iz OSM pločice)
    const w = u.searchParams.get("water");
    const water = w === "1" ? true : w === "0" ? false : undefined;
    if (route === "check") return send(res, 200, await engine.checkSpot(where.lat, where.lon, { boat, weather, water }));
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
// Za govor: znamenka po znamenka sa zarezima (sintetizator napravi stanku), malim slovima da ih ne sriče
const DIGITS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "niner"];
const spell = (s) => [...s].map((c) => (c === "." ? "decimal" : DIGITS[+c])).join(", ");
// 44.9703 -> 44°58.2'N (radio: stupnjevi i minute s jednom decimalom)
function radioPos(v, pad, pos, neg) {
  const a = Math.round(Math.abs(v) * 600) / 600, d = Math.floor(a), m = ((a - d) * 60).toFixed(1).padStart(4, "0"); // zaokruži na 0,1' prije dijeljenja (bez 60.0')
  const deg = String(d).padStart(pad, "0"), side = v >= 0 ? pos : neg;
  return { text: `${deg}°${m}'${side}`, spoken: `${spell(deg)} degrees, ${spell(m)} minutes ${{ N: "north", S: "south", E: "east", W: "west" }[side]}` };
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
    const vessel = String(b.vessel || "").replace(/[^\p{L}\p{N} .-]/gu, "").trim().slice(0, 30).toUpperCase() || "BURA";
    const la = radioPos(lat, 2, "N", "S"), lo = radioPos(lon, 3, "E", "W");
    const id = `DEMO-${Date.now().toString(36).toUpperCase()}`;
    const v = vessel.toLowerCase();
    const mayday = [
      "MAYDAY, MAYDAY, MAYDAY", `THIS IS ${vessel}, ${vessel}, ${vessel}`, `MAYDAY ${vessel}`,
      `MY POSITION IS ${la.text} ${lo.text}`, NATURE[nature], `${people} PERSONS ON BOARD`, "I REQUIRE IMMEDIATE ASSISTANCE", "OVER",
    ];
    // isti redovi za govor; položaj u dva dijela (širina, pa dužina) da se lakše razumije
    const spoken = [
      "Mayday, mayday, mayday.", `This is ${v}, ${v}, ${v}.`, `Mayday, ${v}.`,
      `My position is: ${la.spoken}. ... ${lo.spoken}.`, `${NATURE[nature].toLowerCase()}.`,
      `${spell(String(people))} persons on board.`, "I require immediate assistance.", "Over.",
    ];
    console.log(`[DEMO SOS] ${id} ${vessel} ${la.text} ${lo.text} ${nature}, ${people} osoba - NIJE proslijeđeno nikome`);
    send(res, 200, {
      demo: true, forwarded: false, id, receivedAt: new Date().toISOString(),
      position: `${la.text} ${lo.text}`, nature, people, vessel, mayday, spoken,
    });
  } catch {
    if (!res.headersSent) send(res, 400, { error: "Neispravan zahtjev" });
  }
}

/* ---------------- OPAŽANJA NA MORU (DEMO) ----------------
 * Prijavljeni (demo, samo nadimak) korisnici označe dupine, kornjače, meduze, onečišćenje...
 * Čuva se samo u memoriji servera (na Vercelu se gubi kad se funkcija ugasi); nema prave prijave. */
export const KINDS = ["dupini", "kornjaca", "meduze", "morski_pas", "mrlja", "otpad", "ostalo"];
const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const SEED = () => [
  { id: "seed-1", lat: 44.985, lon: 14.455, kind: "dupini", note: "Skupina od 5-6 dobrih dupina, plivali prema Krku", user: "Ana_Bura", at: ago(2) },
  { id: "seed-2", lat: 44.552, lon: 14.39, kind: "dupini", note: "Dupini kod rta, mama s mladim", user: "Lošinjac", at: ago(7) },
  { id: "seed-3", lat: 43.505, lon: 16.38, kind: "meduze", note: "Puno klobučnjaka uz obalu", user: "Marko", at: ago(5) },
  { id: "seed-4", lat: 43.07, lon: 16.21, kind: "otpad", note: "Plutajuća paleta, opasno noću", user: "skiper_Ivo", at: ago(3) },
  { id: "seed-5", lat: 44.12, lon: 14.86, kind: "kornjaca", note: "Glavata želva na površini", user: "Ana_Bura", at: ago(26) },
];
const reports = SEED();
const clean = (v, n) => String(v ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, n);

export async function handleReports(req, res) {
  if (req.method === "GET") return send(res, 200, { demo: true, reports: reports.slice(-200) });
  if (req.method !== "POST") return send(res, 405, { error: "Koristi GET ili POST" });
  try {
    const b = req.body !== undefined ? (typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body)
      : JSON.parse((await readBody(req)) || "{}");
    const lat = +b.lat, lon = +b.lon, user = clean(b.user, 24);
    if (!user) return send(res, 401, { error: "Prijavi se za označavanje" });
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < 41.5 || lat > 46.6 || lon < 12 || lon > 20) return send(res, 400, { error: "Točka nije na Jadranu" });
    if (!KINDS.includes(b.kind)) return send(res, 400, { error: "Nepoznata vrsta opažanja" });
    const r = { id: `r-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, lat: +lat.toFixed(5), lon: +lon.toFixed(5),
      kind: b.kind, note: clean(b.note, 200), user, at: new Date().toISOString() };
    reports.push(r);
    if (reports.length > 500) reports.splice(0, reports.length - 500);
    console.log(`[OPAŽANJE] ${r.user}: ${r.kind} ${r.lat},${r.lon}`);
    send(res, 201, r);
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
