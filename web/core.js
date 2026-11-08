/* Sigurno sidrište - zajednička logika za web aplikaciju i MCP server.
 * Radi i u pregledniku (import map za @turf/turf) i u Nodeu.
 *
 *   const engine = createEngine({ loadJSON });
 *   await engine.ready;
 *   await engine.checkSpot(lat, lon)          -> ocjena jedne točke
 *   await engine.findSpots(lat, lon, {...})    -> najbolja sidrišta u blizini
 *   await engine.geocode("Hvar")               -> {lat, lon, name}
 */
import * as turf from "@turf/turf";

export const LAYERS = ["substrate", "seagrass", "posidonia_grid", "biozones", "natura2000", "protected", "navmarks"];

export const HOLD = {
  3: { color: "#f2c14e", score: 100, word: "odlično" },
  2: { color: "#b5835a", score: 82, word: "dobro" },
  1: { color: "#9aa5b8", score: 55, word: "osrednje" },
  0: { color: "#3d405b", score: 20, word: "loše" },
};

// Smjer s kojeg puše -> hrvatski naziv vjetra i oznaka strane svijeta
export const WINDS = [
  { deg: 0, name: "tramontana", side: "S" },
  { deg: 45, name: "bura", side: "SI" },
  { deg: 90, name: "levant", side: "I" },
  { deg: 135, name: "jugo", side: "JI" },
  { deg: 180, name: "oštro", side: "J" },
  { deg: 225, name: "lebić", side: "JZ" },
  { deg: 270, name: "pulenat", side: "Z" },
  { deg: 315, name: "maestral", side: "SZ" },
];
// Podaci o brodu: gaz (m), lanac (m), duljina (m). Svako polje je neobavezno.
export function normBoat(b) {
  if (!b) return null;
  const num = (v, lo, hi) => { const x = parseFloat(v); return Number.isFinite(x) && x >= lo && x <= hi ? x : null; };
  const boat = { draft: num(b.draft, 0.3, 6), chain: num(b.chain, 10, 300), length: num(b.length, 3, 60) };
  return boat.draft || boat.chain || boat.length ? boat : null;
}

export const windOf = (deg) => WINDS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

const UA = "safe-anchor-hackathon/1.0";
const SHELTER_KM = 1.5;   // kopno bliže od ovoga u smjeru vjetra = zaklon
const RAY_KM = 2.0;
const HAZARD_M = 400;     // oznaka podvodne opasnosti bliže od ovoga = upozorenje

// Pravila po vrsti zaštićenog područja (Zaštićena područja RH, Bioportal / data.gov.hr)
const PROTECTED = {
  np: { penalty: 10, d: "Sidrenje je dopušteno samo gdje to odredi javna ustanova parka, obično uz plaćenu ulaznicu. Provjeri pravila parka prije dolaska." },
  park: { penalty: 5, d: "Plaća se ulaznica, a vrijede i pravila parka o sidrenju i zonama zaštite." },
  reserve: { penalty: 15, d: "Sidrenje i ribolov ovdje mogu biti zabranjeni ili ograničeni. Provjeri pravila prije dolaska." },
  landscape: { penalty: 0, d: "Zaštićena priroda - sidri obzirno, samo na pijesku. Mogu vrijediti lokalna pravila." },
  monument: { penalty: 0, d: "Zaštićena priroda - sidri obzirno, samo na pijesku. Mogu vrijediti lokalna pravila." },
  other: { penalty: 0, d: "Zaštićena priroda - sidri obzirno. Mogu vrijediti lokalna pravila." },
};

/* ---------- mala pomagala ---------- */
const fmt = (x) => String(Math.round(x * 10) / 10).replace(".", ",");
function indexed(fc) {
  for (const f of fc.features) f.bbox = turf.bbox(f);
  return fc;
}

function hits(fc, lon, lat) {
  if (!fc) return [];
  const pt = turf.point([lon, lat]);
  return fc.features.filter((f) =>
    lon >= f.bbox[0] && lon <= f.bbox[2] && lat >= f.bbox[1] && lat <= f.bbox[3] &&
    turf.booleanPointInPolygon(pt, f));
}

// Najbliža Plovputova oznaka podvodne opasnosti unutar HAZARD_M
function nearestHazard(fc, lon, lat) {
  if (!fc) return null;
  const dLat = HAZARD_M / 111320, dLon = dLat / Math.cos((lat * Math.PI) / 180);
  let best = null;
  for (const f of fc.features) {
    if (!f.properties.danger) continue;
    const [x, y] = f.geometry.coordinates;
    if (Math.abs(x - lon) > dLon || Math.abs(y - lat) > dLat) continue;
    const m = turf.distance([lon, lat], [x, y]) * 1000;
    if (m <= HAZARD_M && (!best || m < best.m)) best = { m, bearing: turf.bearing([lon, lat], [x, y]), p: f.properties };
  }
  return best;
}

// Karta 1:250k ne dopire uvijek do obale - traži do ~1 km oko točke
function nearestSeabed(fc, lon, lat) {
  const direct = hits(fc, lon, lat);
  if (direct.length) return { f: direct[0], near: false };
  for (const km of [0.3, 0.6, 1.0]) {
    for (let b = 0; b < 360; b += 45) {
      const [x, y] = turf.destination([lon, lat], km, b).geometry.coordinates;
      const h = hits(fc, x, y);
      if (h.length) return { f: h[0], near: true };
    }
  }
  return null;
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const j = i++; out[j] = await fn(items[j], j); }
  }));
  return out;
}

const round = (x, n = 1) => Math.round(x * 10 ** n) / 10 ** n;
const list = (a) => (a.length <= 1 ? a.join("") : a.slice(0, -1).join(", ") + " i " + a.at(-1));

/* ---------- motor ---------- */
export function createEngine({ loadJSON, fetchImpl = globalThis.fetch.bind(globalThis), isBrowser = typeof window !== "undefined" }) {
  const data = {};
  const headers = isBrowser ? {} : { "User-Agent": UA };
  // Najviše 6 istodobnih poziva po servisu, 2 ponovna pokušaja i predmemorija od 30 min,
  // da ne preopteretimo EMODnet (inače vraća greške i blokira).
  const active = new Map();
  const queue = new Map();
  const cache = new Map();
  const MAX_PER_HOST = 6;
  const acquire = (host) => new Promise((res) => {
    if ((active.get(host) || 0) < MAX_PER_HOST) { active.set(host, (active.get(host) || 0) + 1); res(); }
    else { if (!queue.has(host)) queue.set(host, []); queue.get(host).push(res); }
  });
  const release = (host) => {
    const q = queue.get(host);
    if (q?.length) q.shift()();
    else active.set(host, active.get(host) - 1);
  };
  const getJSON = async (url) => {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.t < 30 * 60e3) return hit.v;
    const host = new URL(url).host;
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      await acquire(host);
      try {
        const r = await fetchImpl(url, { headers });
        if (r.status === 429 || r.status >= 500) { lastErr = new Error(`${host}: HTTP ${r.status}`); continue; }
        if (!r.ok) throw new Error(`${host}: HTTP ${r.status}`);
        const v = await r.json();
        if (cache.size > 5000) cache.clear();
        cache.set(url, { t: Date.now(), v });
        return v;
      } catch (e) {
        lastErr = e;
        if (/HTTP 4\d\d/.test(e.message) && !/429/.test(e.message)) throw e;
      } finally { release(host); }
    }
    throw lastErr;
  };

  const ready = Promise.all(LAYERS.map((n) => loadJSON(`${n}.geojson`))).then((fcs) => {
    LAYERS.forEach((n, i) => { data[n] = indexed(fcs[i]); });
    return data;
  });

  /* --- žive usluge --- */
  async function depthAt(lon, lat) {
    const d = await getJSON(`https://rest.emodnet-bathymetry.eu/depth_sample?geom=${encodeURIComponent(`POINT(${lon} ${lat})`)}`);
    if (d == null || d.avg == null) return null;
    // API vraća nadmorsku visinu (negativno = ispod mora). Bez izmjere: avg 0, ali postoji izglađena procjena.
    if (d.avg < 0) return { depth: -d.avg, estimated: !!d.interpolationType };
    if (d.avg === 0 && (d.elementarySurfaces ?? 0) <= 0 && d.smoothed < 0) return { depth: -d.smoothed, estimated: true };
    return { depth: -d.avg, land: true };
  }

  async function profile(lon0, lat0, lon1, lat1) {
    const g = `LINESTRING(${lon0} ${lat0},${lon1} ${lat1})`;
    return getJSON(`https://rest.emodnet-bathymetry.eu/depth_profile?geom=${encodeURIComponent(g)}`); // 1000 uzoraka, + = kopno
  }

  const weatherCache = new Map();
  async function weatherAt(lon, lat) {
    const key = `${lat.toFixed(1)},${lon.toFixed(1)}`;
    const hit = weatherCache.get(key);
    if (hit && Date.now() - hit.t < 15 * 60e3) return hit.v;
    const q = `latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`;
    const [w, m] = await Promise.all([
      getJSON(`https://api.open-meteo.com/v1/forecast?${q}&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m` +
        `&hourly=wind_gusts_10m,wind_direction_10m&forecast_hours=12&wind_speed_unit=kn&timezone=Europe%2FZagreb`),
      getJSON(`https://marine-api.open-meteo.com/v1/marine?${q}&current=wave_height,wave_period`).catch(() => null),
    ]);
    const g = w.hourly?.wind_gusts_10m || [];
    const i = g.length ? g.indexOf(Math.max(...g)) : -1;
    const v = {
      speed: w.current.wind_speed_10m, dir: w.current.wind_direction_10m, gust: w.current.wind_gusts_10m,
      gustMax12: i >= 0 ? g[i] : null,
      gustMaxTime: i >= 0 ? w.hourly.time[i].slice(11, 16) : null,
      gustMaxDir: i >= 0 ? w.hourly.wind_direction_10m[i] : null,
      wave: m?.current?.wave_height ?? null, wavePeriod: m?.current?.wave_period ?? null,
    };
    weatherCache.set(key, { t: Date.now(), v });
    return v;
  }

  // 8 zraka od 2 km: koliko je daleko kopno u svakom smjeru
  async function shelterRays(lon, lat) {
    const rays = await Promise.all(WINDS.map(async (w) => {
      const [x, y] = turf.destination([lon, lat], RAY_KM, w.deg).geometry.coordinates;
      try {
        const p = await profile(lon, lat, x, y);
        const k = p.findIndex((e, idx) => idx > 5 && e != null && e > 0);
        return k < 0 ? null : (k / (p.length - 1)) * RAY_KM;
      } catch { return undefined; }
    }));
    return rays; // km do kopna po smjeru, null = otvoreno, undefined = nema podataka
  }

  /* --- ocjena --- */
  function assess(ctx) {
    const facts = [];
    const tips = [];
    let score = 50;
    let blocker = null;

    // Dno
    if (ctx.seabed) {
      const p = ctx.seabed.f.properties;
      score = HOLD[p.hold]?.score ?? 50;
      facts.push({
        id: "seabed", k: "Dno", v: p.label, lvl: p.hold >= 2 ? "good" : p.hold === 1 ? "ok" : "bad",
        d: `${p.note} (EMODnet ${p.scale}${ctx.seabed.near ? ", najbliže kartirano dno unutar 1 km" : ""})`,
      });
    } else {
      facts.push({ id: "seabed", k: "Dno", v: "nije kartirano", lvl: "na", d: "Nema podataka o dnu. Provjeri kartu i pogledaj dno prije spuštanja sidra." });
    }

    // Morska trava
    if (ctx.grass.length) {
      const kind = ctx.grass[0].properties.kind;
      const name = /posidonia/i.test(kind) ? "livada posidonije" : /cymodocea/i.test(kind) ? "livada čvoraste morske resine" : "livada morske trave";
      blocker = `Ovdje je ${name} - sidro je uništava`;
      facts.push({ id: "seagrass", k: "Morska trava", v: "kartirana livada", lvl: "bad", d: `${name[0].toUpperCase() + name.slice(1)}. Zaštićeno stanište: sidro i lanac čupaju desetljeća rasta. Veži se na plutaču ili se pomakni na čisti pijesak.` });
    } else if (ctx.infralittoral) {
      score -= 8;
      facts.push({ id: "seagrass", k: "Morska trava", v: "moguća", lvl: "ok", d: "Plitko, osvijetljeno dno gdje raste posidonija, a nisu sve livade kartirane. Spusti sidro samo na svijetli pijesak, nikad na tamne mrlje." });
    } else {
      facts.push({ id: "seagrass", k: "Morska trava", v: "nije kartirana", lvl: "good", d: "Ovdje nije kartirana livada." });
    }
    if (ctx.posGrid && !ctx.grass.length) tips.push("Hrvatska prijavljuje posidoniju u ovom području - pogledaj dno prije sidrenja.");

    // Dubina
    let depth = ctx.depth?.depth ?? null;
    if (ctx.depthError) {
      facts.push({ id: "depth", k: "Dubina", v: "nedostupno", lvl: "na", d: "Servis za dubinu nije odgovorio. Koristi dubinomjer." });
      depth = null;
    } else if (ctx.depth?.land) {
      blocker = blocker || "Ova točka je na kopnu ili tik uz obalu";
      facts.push({ id: "depth", k: "Dubina", v: "-", lvl: "bad", d: "Model dubine ovdje pokazuje kopno. Odaberi točku malo dalje od obale." });
      depth = null;
    } else if (depth == null || depth <= 0) {
      facts.push({ id: "depth", k: "Dubina", v: "nema podataka", lvl: "na", d: "Nema podataka o dubini. Koristi kartu i dubinomjer." });
      depth = null;
    } else {
      let lvl = "good", d = "Ugodna dubina za sidrenje.";
      const draft = ctx.boat?.draft;
      if (draft && depth < draft + 1) { lvl = "bad"; d = `Preplitko za tvoj brod (gaz ${fmt(draft)} m) - treba barem ${fmt(draft + 1)} m.`; score -= 45; blocker = blocker || `Preplitko za tvoj brod (gaz ${fmt(draft)} m)`; }
      else if (draft && depth < draft + 2) { lvl = "ok"; d = `Malo vode ispod kobilice (gaz ${fmt(draft)} m).`; score -= 12; }
      else if (!draft && depth < 2) { lvl = "bad"; d = "Preplitko za većinu kobilica."; score -= 45; blocker = blocker || "Preplitko"; }
      else if (!draft && depth < 3) { lvl = "ok"; d = "Plitko - provjeri gaz broda."; score -= 12; }
      else if (depth <= 15) { lvl = "good"; }
      else if (depth <= 25) { lvl = "ok"; d = "Duboko - trebat ćeš puno lanca."; score -= 22; }
      else if (depth <= 35) { lvl = "bad"; d = "Vrlo duboko. Većina jahti nema dovoljno lanca."; score -= 35; }
      else { lvl = "bad"; d = "Preduboko za sidrenje."; score -= 60; blocker = blocker || "Preduboko za sidrenje"; }
      facts.push({
        id: "depth", k: "Dubina", v: `${ctx.depth.estimated ? "≈" : ""}${depth.toFixed(1)} m`, lvl,
        d: d + (ctx.depth.estimated ? " (Procjena - ovdje nema izmjere. Provjeri dubinomjerom.)" : " (Prosjek EMODnet mreže ~115 m - provjeri dubinomjerom.)"),
      });
    }

    // Vjetar, valovi, zaklon
    const w = ctx.weather;
    const windy = w && (w.gust >= 20 || (w.gustMax12 ?? 0) >= 25);
    if (w) {
      const now = windOf(w.dir);
      let lvl = "good", d = "Slab vjetar.";
      if (w.gust >= 30 || (w.gustMax12 ?? 0) >= 35) { lvl = "bad"; d = "Jaki udari - sidrenje je rizično, potraži zaštićenu luku."; score -= 30; }
      else if (windy) { lvl = "ok"; d = "Svjež vjetar - budi u zaklonu i pusti više lanca."; score -= 12; }
      if (now.name === "bura" && w.gust >= 15) d += " Bura dolazi na snažne refule s planina i može naglo ojačati.";
      if (now.name === "jugo" && w.speed >= 12) d += " Jugo kroz dan diže veliko more - izbjegavaj uvale otvorene prema jugoistoku.";
      facts.push({ id: "wind", k: "Vjetar sada", v: `${Math.round(w.speed)} čv ${now.side} (${now.name}) · udari ${Math.round(w.gust)}`, arrow: w.dir, lvl, d });
      if (w.gustMax12 != null) {
        const nx = windOf(w.gustMaxDir);
        facts.push({
          id: "forecast", k: "Idućih 12 h", v: `udari do ${Math.round(w.gustMax12)} čv`,
          lvl: w.gustMax12 >= 35 ? "bad" : w.gustMax12 >= 25 ? "ok" : "good",
          d: `Najjače oko ${w.gustMaxTime}, ${nx.name} (${nx.side}).`,
        });
      }
      if (w.wave != null) {
        const wl = w.wave >= 1.5 ? "bad" : w.wave >= 0.8 ? "ok" : "good";
        if (wl === "bad") score -= 15; else if (wl === "ok") score -= 5;
        facts.push({ id: "waves", k: "Valovi", v: `${w.wave.toFixed(1)} m${w.wavePeriod ? ` · ${Math.round(w.wavePeriod)} s` : ""}`, lvl: wl, d: wl === "good" ? "Mirno more." : "Na sidru će ljuljati ako je uvala otvorena." });
      }
    } else if (ctx.weatherError) {
      facts.push({ id: "wind", k: "Vjetar", v: "nedostupno", lvl: "na", d: "Prognoza nije dostupna. Provjeri pomorsku prognozu DHMZ-a." });
    }

    let shelter = null;
    if (ctx.rays && depth) {
      const from = [], open = [];
      WINDS.forEach((wd, i) => {
        const r = ctx.rays[i];
        if (r === undefined) return;
        (r !== null && r <= SHELTER_KM ? from : open).push(wd);
      });
      shelter = { from: from.map((x) => x.name), open: open.map((x) => x.side) };
      // Je li točka zaklonjena od najjačeg vjetra u idućih 12 h?
      let lvl = "good", d;
      const ref = w ? windOf(w.gustMaxDir ?? w.dir) : null;
      const refGust = w ? Math.max(w.gust, w.gustMax12 ?? 0) : 0;
      if (ref) {
        const i = WINDS.indexOf(ref);
        const side = [i, (i + 1) % 8, (i + 7) % 8].map((k) => ctx.rays[k]);
        const covered = side.filter((r) => r != null && r <= SHELTER_KM).length;
        if (covered >= 2) d = `Zaklonjeno od vjetra koji dolazi (${ref.name}).`;
        else if (refGust >= 15) {
          lvl = refGust >= 25 ? "bad" : "ok"; score -= refGust >= 25 ? 30 : 20;
          d = `Otvoreno prema ${ref.side} - ${ref.name} će ulaziti ravno u sidrište.`;
        } else { lvl = "ok"; d = `Otvoreno prema ${ref.side}, ali vjetar je zasad slab.`; }
      }
      const head = from.length ? `zaklon od: ${list(from.map((x) => x.name))}` : "nema zaklona";
      facts.push({ id: "shelter", k: "Zaklon", v: `${from.length}/8 strana`, lvl, d: `${d ? d + " " : ""}Kopno unutar ${SHELTER_KM} km - ${head}.` });
    }

    if (ctx.protected.length) {
      // najstroža kategorija ako se područja preklapaju
      const order = ["np", "reserve", "park", "landscape", "monument", "other"];
      const p = ctx.protected.map((f) => f.properties).sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))[0];
      const rule = PROTECTED[p.kind] || PROTECTED.other;
      score -= rule.penalty;
      facts.push({ id: "protected", k: "Zaštićeno područje", v: `${p.label} ${p.name}`, lvl: rule.penalty ? "ok" : "good", d: rule.d });
    }

    if (ctx.hazard) {
      const h = ctx.hazard;
      score -= 8;
      facts.push({
        id: "hazard", k: "Oznaka opasnosti", v: `${h.p.name}, ${Math.round(h.m / 10) * 10} m ${windOf(h.bearing).side}`, lvl: "ok",
        d: `Plovput ovdje označava podvodnu opasnost (pličinu ili hrid)${h.p.desc ? `: ${h.p.desc.toLowerCase()}` : ""}. Prilazi polako i drži se podalje od oznake.`,
      });
    }

    if (ctx.natura.length) {
      const n = ctx.natura[0].properties;
      facts.push({ id: "natura", k: "Natura 2000", v: n.code, lvl: "ok", d: `Natura 2000 područje za ptice "${n.name}". Budi tih, ne iskrcavaj se blizu gnijezda; mogu vrijediti lokalna pravila sidrenja.` });
    }

    let chain = null;
    if (depth && !blocker) {
      const ratio = windy ? 7 : 5;
      chain = Math.ceil((depth + 1.5) * ratio);
      const boat = ctx.boat;
      const after = Math.max(0, facts.findIndex((f) => f.id === "depth")) + 1;
      if (boat?.chain && boat.chain < chain) {
        const calm = Math.ceil((depth + 1.5) * 4);
        const maxDepth = Math.floor(boat.chain / ratio - 1.5);
        if (boat.chain >= calm) {
          score -= 10;
          facts.splice(after, 0, { id: "chain", k: "Tvoj lanac", v: `imaš ${boat.chain} m, treba ${chain} m`, lvl: "ok",
            d: `Dovoljno samo za mirno vrijeme (4:1). Ako zapuše, premjesti se na mjesto pliće od ${maxDepth} m.` });
        } else {
          score -= 30;
          facts.splice(after, 0, { id: "chain", k: "Tvoj lanac", v: `imaš ${boat.chain} m, treba ${chain} m`, lvl: "bad",
            d: `Lanac je prekratak za ovu dubinu - sidro neće dobro držati. Potraži mjesto pliće od ${Math.max(2, maxDepth)} m.` });
        }
      } else if (boat?.chain) {
        facts.splice(after, 0, { id: "chain", k: "Tvoj lanac", v: `imaš ${boat.chain} m, treba ${chain} m`, lvl: "good", d: "Lanca imaš dovoljno." });
      }
      tips.unshift(`Pusti barem ${chain} m lanca (${ratio}:1 za ${windy ? "vjetrovitu noć" : "mirno vrijeme"}, mjereno od pramca).`);

      // Krug okretanja: vodoravni dio lanca + duljina broda, usporedi s udaljenošću do kopna
      if (boat?.length && ctx.rays) {
        const use = Math.min(boat.chain ?? chain, chain);
        const swing = Math.round(Math.sqrt(Math.max(0, use ** 2 - (depth + 1.5) ** 2)) + boat.length);
        const near = ctx.rays.filter((r) => r != null).map((r) => r * 1000);
        const minLand = near.length ? Math.round(Math.min(...near)) : null;
        if (minLand != null && minLand < swing) {
          score -= 10;
          facts.splice(after + 1, 0, { id: "swing", k: "Krug okretanja", v: `~${swing} m, kopno ${minLand} m`, lvl: "ok",
            d: `Na ${use} m lanca brod od ${fmt(boat.length)} m okreće se u krugu od oko ${swing} m, a kopno je bliže. Pomakni se dalje od obale ili veži krmu za kopno.` });
        } else if (minLand != null) {
          facts.splice(after + 1, 0, { id: "swing", k: "Krug okretanja", v: `~${swing} m`, lvl: "good", d: `Kopno je ${minLand} m daleko - dovoljno mjesta za okretanje.` });
        }
      }
    }

    score = Math.max(0, Math.min(100, Math.round(score)));
    if (blocker) score = Math.min(score, 10);
    const lvl = blocker ? "bad" : score >= 70 ? "good" : score >= 45 ? "ok" : "bad";
    const title = blocker ? "Ne sidri ovdje" : lvl === "good" ? "Dobro mjesto za sidrenje" : lvl === "ok" ? "Sidri uz oprez" : "Loše mjesto za sidrenje";
    const issues = facts.filter((f) => f.lvl === "bad" || f.lvl === "ok").map((f) => f.k.toLowerCase()).slice(0, 3);
    const serious = facts.filter((f) => (f.lvl === "bad" || f.lvl === "ok") && f.id !== "seagrass").map((f) => f.k.toLowerCase());
    const reason = blocker || (lvl === "good"
      ? (serious.length ? `Dobro drži; pazi na: ${list(serious.slice(0, 2))}.` : "Dobro drži, ugodna dubina i zaklon.")
      : issues.length ? `Pazi na: ${list(issues)}.` : "Pogledaj dno prije spuštanja sidra.");

    return {
      score, lvl, title, reason, facts, tips, chain,
      depth: depth != null ? round(depth) : null,
      seabed: ctx.seabed?.f.properties.label ?? null,
      shelter,
    };
  }

  /* --- javni API --- */
  function local(lon, lat) {
    return {
      seabed: nearestSeabed(data.substrate, lon, lat),
      grass: hits(data.seagrass, lon, lat),
      posGrid: hits(data.posidonia_grid, lon, lat).length > 0,
      infralittoral: hits(data.biozones, lon, lat).some((f) => f.properties.zone === "Infralittoral"),
      natura: hits(data.natura2000, lon, lat),
      protected: hits(data.protected, lon, lat),
      hazard: nearestHazard(data.navmarks, lon, lat),
    };
  }

  async function checkSpot(lat, lon, { weather, rays: knownRays, boat } = {}) {
    await ready;
    const ctx = local(lon, lat);
    ctx.boat = normBoat(boat);
    const [depth, wx, rays] = await Promise.allSettled([
      depthAt(lon, lat),
      weather ? Promise.resolve(weather) : weatherAt(lon, lat),
      knownRays ? Promise.resolve(knownRays) : shelterRays(lon, lat),
    ]);
    ctx.depth = depth.status === "fulfilled" ? depth.value : null;
    ctx.depthError = depth.status === "rejected";
    ctx.weather = wx.status === "fulfilled" ? wx.value : null;
    ctx.weatherError = wx.status === "rejected";
    ctx.rays = rays.status === "fulfilled" ? rays.value : null;
    return { lat: round(lat, 5), lon: round(lon, 5), ...assess(ctx), weather: ctx.weather, ...(ctx.boat ? { boat: ctx.boat } : {}) };
  }

  /**
   * Pretraži krug oko točke: mreža dubina (~250 m), odbaci posidoniju, stijene i preduboko,
   * boduj dno + dubinu + zaklon od prognoziranog vjetra, pa detaljno provjeri najbolje.
   */
  async function findSpots(lat, lon, { radiusKm = 4, max = 5, onProgress, boat } = {}) {
    await ready;
    boat = normBoat(boat);
    // raspon dubina za kandidate: gaz + 1,5 m do dubine za koju lanac doseže barem 4:1 (najviše 18 m)
    const minD = Math.max(3, boat?.draft ? boat.draft + 1.5 : 3);
    const maxD = Math.max(minD, Math.min(18, boat?.chain ? boat.chain / 4 - 1.5 : 18));
    radiusKm = Math.max(1, Math.min(8, radiusKm));
    const step = radiusKm <= 3 ? 0.2 : 0.25;
    const n = Math.round((2 * radiusKm) / step) + 1;
    const dLat = radiusKm / 111.32;
    const dLon = radiusKm / (111.32 * Math.cos((lat * Math.PI) / 180));
    const lat0 = lat - dLat, lon0 = lon - dLon, lon1 = lon + dLon;
    const weather = await weatherAt(lon, lat).catch(() => null);

    let done = 0;
    const grid = await pool([...Array(n).keys()], 8, async (r) => {
      const y = lat0 + (2 * dLat * r) / (n - 1);
      let p;
      try { p = await profile(lon0, y, lon1, y); } catch { p = null; }
      onProgress?.(++done / n);
      if (!p) return new Array(n).fill(undefined);
      return Array.from({ length: n }, (_, c) => {
        const e = p[Math.round((c * (p.length - 1)) / (n - 1))];
        return e == null ? undefined : -e; // dubina; <= 0 kopno
      });
    });
    const at = (r, c) => (r < 0 || c < 0 || r >= n || c >= n ? undefined : grid[r][c]);
    const coord = (r, c) => [lon0 + (2 * dLon * c) / (n - 1), lat0 + (2 * dLat * r) / (n - 1)];
    const land = (d) => d !== undefined && d <= 0;

    const ref = weather ? windOf(weather.gustMaxDir ?? weather.dir) : null;
    const refI = ref ? WINDS.indexOf(ref) : -1;
    const shelterSteps = Math.round(SHELTER_KM / step);
    const cands = [];
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      const d = grid[r][c];
      if (d === undefined || d < minD || d > maxD) continue;
      const [x, y] = coord(r, c);
      const distKm = turf.distance([lon, lat], [x, y]);
      if (distKm > radiusKm) continue;
      if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => land(at(r + a, c + b)))) continue; // ne tik uz obalu

      // zaklon u 8 smjerova iz mreže: km do kopna (null = otvoreno unutar 2 km)
      const rays = WINDS.map((wd) => {
        const a = (wd.deg * Math.PI) / 180;
        const diag = Math.abs(Math.sin(a) * Math.cos(a)) > 0.1 ? Math.SQRT2 : 1;
        for (let s = 1; s * step * diag <= RAY_KM; s++) {
          const v = at(r + Math.round(Math.cos(a) * s), c + Math.round(Math.sin(a) * s));
          if (v === undefined && (r + Math.round(Math.cos(a) * s) < 0 || r + Math.round(Math.cos(a) * s) >= n || c + Math.round(Math.sin(a) * s) < 0 || c + Math.round(Math.sin(a) * s) >= n)) return undefined;
          if (land(v)) return round(s * step * diag, 2);
        }
        return null;
      });
      const cover = rays.map((x) => x != null && x <= SHELTER_KM);
      if (cover.filter(Boolean).length < 3) continue; // otvoreno more, nije sidrište

      const L = local(x, y);
      if (L.grass.length) continue;
      const hold = L.seabed?.f.properties.hold;
      if (hold === 0) continue;

      let s = hold == null ? 15 : hold * 13;               // dno 0-39
      s += d >= 4 && d <= 12 ? 30 : d <= 15 ? 20 : 8;       // dubina
      s += cover.filter(Boolean).length * 2;                // općenita zatvorenost
      if (refI >= 0) {
        const side = [refI, (refI + 1) % 8, (refI + 7) % 8].filter((k) => cover[k]).length;
        s += side * 8;                                      // zaklon od prognoziranog vjetra
      }
      s -= distKm * 2;
      cands.push({ x, y, s, d, rays });
    }

    cands.sort((a, b) => b.s - a.s);
    const picked = [];
    for (const cd of cands) {
      if (picked.every((p) => turf.distance([p.x, p.y], [cd.x, cd.y]) > 0.6)) picked.push(cd);
      if (picked.length >= max + 3) break;
    }
    const checked = await Promise.all(picked.map((p) => checkSpot(p.y, p.x, { weather, rays: p.rays, boat })));
    const spots = checked
      .map((s) => ({ ...s, distanceKm: round(turf.distance([lon, lat], [s.lon, s.lat]), 1) }))
      .filter((s) => s.lvl !== "bad")
      .sort((a, b) => b.score - a.score || a.distanceKm - b.distanceKm)
      .slice(0, max);
    return { center: { lat, lon }, radiusKm, weather, wind: ref?.name ?? null, scanned: cands.length, depthRange: [round(minD, 1), round(maxD, 1)], ...(boat ? { boat } : {}), spots };
  }

  async function geocode(query) {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=hr&accept-language=hr&q=${encodeURIComponent(query)}`;
    const r = await getJSON(url);
    if (!r.length) return null;
    return { lat: +r[0].lat, lon: +r[0].lon, name: r[0].display_name.split(",").slice(0, 2).join(",") };
  }

  return { ready, data, checkSpot, findSpots, geocode, weatherAt };
}

/* ---------- tekstualni sažetak (za MCP / dijeljenje) ---------- */
export function spotText(s, { short = false } = {}) {
  const head = `${s.title} - ${s.score}/100 (${s.lat.toFixed(4)}° N, ${s.lon.toFixed(4)}° E)`;
  const link = `https://www.google.com/maps?q=${s.lat},${s.lon}`;
  if (short) {
    const bits = [s.depth != null ? `${s.depth} m` : null, s.seabed?.toLowerCase(),
      s.shelter?.from.length ? `zaklon od: ${list(s.shelter.from)}` : null].filter(Boolean);
    return `${head}\n   ${bits.join(" · ")}${s.chain ? ` · lanac ${s.chain} m` : ""}\n   ${link}`;
  }
  return [head, s.reason, "", ...s.facts.map((f) => `- ${f.k}: ${f.v} - ${f.d}`),
    ...(s.tips.length ? ["", ...s.tips.map((t) => `Savjet: ${t}`)] : []), "", link].join("\n");
}
