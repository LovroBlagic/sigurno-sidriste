// MCP alati "Sigurnog sidrišta" - isti za stdio (Claude Desktop / Claude Code) i HTTP (/mcp).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { engine } from "../server/engine.js";
import { spotText } from "../web/core.js";

const WHERE = {
  mjesto: z.string().optional().describe("Naziv mjesta, otoka ili uvale u Hrvatskoj, npr. 'Hvar', 'Telašćica', 'uvala Stiniva'. Koristi ovo ili lat/lon."),
  lat: z.number().min(41.5).max(46.6).optional().describe("Geografska širina (WGS84)"),
  lon: z.number().min(12).max(20).optional().describe("Geografska dužina (WGS84)"),
};

async function resolve({ mjesto, lat, lon }) {
  if (lat != null && lon != null) return { lat, lon, name: null };
  if (!mjesto) throw new Error("Zadaj 'mjesto' ili 'lat' i 'lon'.");
  const g = await engine.geocode(mjesto);
  if (!g) throw new Error(`Ne mogu pronaći mjesto "${mjesto}" u Hrvatskoj.`);
  return g;
}

const fail = (e) => ({ isError: true, content: [{ type: "text", text: `Greška: ${e.message}` }] });

export function createMcpServer() {
  const server = new McpServer({ name: "sigurno-sidriste", version: "1.0.0" }, {
    instructions:
      "Alati za nautičare na hrvatskom Jadranu. Za pitanja tipa 'gdje mogu sidriti blizu X' koristi pronadi_sidriste; " +
      "za 'mogu li sidriti ovdje / na ovim koordinatama' koristi provjeri_tocku. Odgovaraj na jeziku korisnika, " +
      "navedi dubinu, dno, zaklon od vjetra i duljinu lanca, i uvijek napomeni da nikad ne sidre na posidoniju " +
      "te da je ovo pomoć pri planiranju, a ne navigacijska karta.",
  });

  server.registerTool("pronadi_sidriste", {
    title: "Pronađi sidrište",
    description:
      "Pronalazi do 5 najboljih mjesta za sidrenje u krugu oko mjesta ili koordinata na hrvatskom Jadranu. " +
      "Boduje dno (pijesak/mulj drži, stijene ne), izbjegava kartirane livade posidonije, traži dubinu 3-15 m " +
      "i zaklon od najjačeg vjetra prognoziranog za idućih 12 sati.",
    inputSchema: { ...WHERE, radius_km: z.number().min(1).max(8).default(4).describe("Polumjer pretrage u km") },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (args) => {
    try {
      const where = await resolve(args);
      const r = await engine.findSpots(where.lat, where.lon, { radiusKm: args.radius_km ?? 4, max: 5 });
      const w = r.weather;
      const head = [
        `Sidrišta ${where.name ? `kod: ${where.name}` : `oko ${where.lat.toFixed(4)}, ${where.lon.toFixed(4)}`} (krug ${r.radiusKm} km)`,
        w ? `Vjetar sada ${Math.round(w.speed)} čv, udari do ${Math.round(Math.max(w.gust, w.gustMax12 ?? 0))} čv u idućih 12 h${r.wind ? `, najjače puše ${r.wind}` : ""}.` : "Prognoza vjetra nije dostupna.",
      ];
      const body = r.spots.length
        ? r.spots.map((s, i) => `${i + 1}. ${spotText(s, { short: true })}\n   udaljenost ${s.distanceKm} km`).join("\n")
        : "Nisam našao dobro sidrište u ovom krugu (dno, dubina 3-18 m, zaklon). Probaj drugo mjesto ili veći polumjer.";
      return {
        content: [{ type: "text", text: `${head.join("\n")}\n\n${body}\n\nPomoć pri planiranju, ne navigacijska karta. Nikad ne sidri na posidoniju.` }],
        structuredContent: {
          mjesto: where.name, centar: r.center, vjetar: w,
          sidrista: r.spots.map(({ facts, weather, ...s }) => s),
        },
      };
    } catch (e) { return fail(e); }
  });

  server.registerTool("provjeri_tocku", {
    title: "Provjeri točku za sidrenje",
    description:
      "Detaljna procjena jedne točke: vrsta dna i koliko drži, posidonija, dubina, zaklon u 8 smjerova, " +
      "vjetar i valovi sada i idućih 12 h, Natura 2000, preporučena duljina lanca. Vraća ocjenu 0-100.",
    inputSchema: WHERE,
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (args) => {
    try {
      const where = await resolve(args);
      const s = await engine.checkSpot(where.lat, where.lon);
      return {
        content: [{ type: "text", text: (where.name ? `${where.name}\n` : "") + spotText(s) }],
        structuredContent: { mjesto: where.name, ...s },
      };
    } catch (e) { return fail(e); }
  });

  return server;
}
