/* Brodovi uživo (AIS) iz aisstream.io. Ključ: varijabla okruženja AISSTREAM_KEY (besplatan na aisstream.io).
 * aisstream ne dopušta spajanje iz preglednika, pa server drži pozicije i šalje samo ono što je u kadru karte.
 *   - lokalni server (dugo živi): jedna stalna veza za cijeli Jadran, pozicije se skupljaju u memoriji
 *   - Vercel (funkcija živi kratko): za svaki zahtjev kratka veza za kadar karte, rezultati se pamte dok je instanca topla
 */
const URL_WS = "wss://stream.aisstream.io/v0/stream";
const ADRIATIC = [[[46.6, 12.0], [41.5, 20.0]]];
const TYPES = ["PositionReport", "StandardClassBPositionReport", "ExtendedClassBPositionReport", "ShipStaticData", "StaticDataReport"];
const MAX_AGE = 20 * 60e3; // pozicija starija od 20 min se ne prikazuje

const ships = new Map(); // MMSI -> { mmsi, name, lat, lon, cog, sog, heading, t }
let live = null;

export const hasKey = () => !!process.env.AISSTREAM_KEY;

export function ingest(msg) {
  const meta = msg.MetaData || {};
  const mmsi = meta.MMSI;
  if (!mmsi) return;
  const s = ships.get(mmsi) || { mmsi };
  const name = (meta.ShipName || "").trim();
  if (name) s.name = name;
  const body = msg.Message?.[msg.MessageType] || {};
  if (msg.MessageType === "ShipStaticData" && body.Type != null) s.type = body.Type;
  if (/PositionReport$/.test(msg.MessageType) && body.Latitude != null && Math.abs(body.Latitude) <= 90) {
    Object.assign(s, {
      lat: body.Latitude, lon: body.Longitude,
      cog: body.Cog < 360 ? body.Cog : null, sog: body.Sog < 102.3 ? body.Sog : null,
      heading: body.TrueHeading < 360 ? body.TrueHeading : null, t: Date.now(),
    });
  }
  ships.set(mmsi, s);
}

function connect(boxes, onClose) {
  const ws = new WebSocket(URL_WS);
  ws.onopen = () => ws.send(JSON.stringify({ APIKey: process.env.AISSTREAM_KEY, BoundingBoxes: boxes, FilterMessageTypes: TYPES }));
  ws.onmessage = async (e) => {
    try { ingest(JSON.parse(typeof e.data === "string" ? e.data : await new Response(e.data).text())); } catch { /* neispravna poruka */ }
  };
  ws.onclose = onClose;
  ws.onerror = () => { try { ws.close(); } catch { /* već zatvoreno */ } };
  return ws;
}

// Lokalni server: jedna stalna veza, ponovno spajanje nakon prekida
function ensureLive() {
  if (live) return;
  live = connect(ADRIATIC, () => { live = null; setTimeout(ensureLive, 10e3); });
}

// Vercel: kratko slušanje kadra karte
const listen = (box, ms) => new Promise((done) => {
  const ws = connect([box], done);
  setTimeout(() => { try { ws.close(); } catch { done(); } }, ms);
});

export async function vesselsIn({ s, w, n, e }) {
  if (process.env.VERCEL) await listen([[n, w], [s, e]], 4000);
  else ensureLive();
  const now = Date.now();
  const out = [];
  for (const v of ships.values()) {
    if (v.t == null || now - v.t > MAX_AGE) continue;
    if (v.lat < s || v.lat > n || v.lon < w || v.lon > e) continue;
    out.push({ ...v, age: Math.round((now - v.t) / 1000) });
  }
  return out.slice(0, 1500);
}
