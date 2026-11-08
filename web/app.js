/* Sigurno sidrište - web sučelje. Sva logika je u core.js (dijeli se s MCP serverom). */
import { HOLD, windOf, normBoat, depthLabel } from "./core.js";

const GRASS = "#2a9d5c";

// Sve žive provjere ide preko našeg servera (server/index.js), koji štedi i predmemorira pozive prema EMODnetu.
// ?sim=bura ili ?sim=jugo u adresi stranice: simulirana prognoza za testiranje i demonstraciju
const SIM = new URLSearchParams(location.search).get("sim");
async function api(route, params) {
  const r = await fetch(`api/${route}?${new URLSearchParams({ ...params, ...(SIM && route !== "geocode" ? { sim: SIM } : {}) })}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
const layer = async (name) => {
  const r = await fetch(`data/${name}.geojson`);
  if (!r.ok) throw new Error(`${name}: ${r.status}`);
  return r.json();
};
/* ---------------- moj brod (sprema se samo u ovom pregledniku) ---------------- */
const BOAT_KEY = "sidriste.boat";
function loadBoat() { try { return normBoat(JSON.parse(localStorage.getItem(BOAT_KEY))); } catch { return null; } }
function saveBoat(b) { try { b ? localStorage.setItem(BOAT_KEY, JSON.stringify(b)) : localStorage.removeItem(BOAT_KEY); } catch { /* privatni način */ } }
const num1 = (x) => String(Math.round(x * 10) / 10).replace(".", ",");
const boatParams = () => {
  const b = state.boat;
  return b ? Object.fromEntries([["gaz", b.draft], ["lanac", b.chain], ["duljina", b.length]].filter(([, v]) => v)) : {};
};
const boatLine = (b) => [b.draft && `gaz ${num1(b.draft)} m`, b.chain && `lanac ${b.chain} m`, b.length && `duljina ${num1(b.length)} m`].filter(Boolean).join(" · ");

const engine = {
  ready: Promise.all(["substrate", "seagrass", "natura2000", "protected", "navmarks"].map(layer))
    .then(([substrate, seagrass, natura2000, protectedAreas, navmarks]) => ({ substrate, seagrass, natura2000, protectedAreas, navmarks })),
  checkSpot: (lat, lon) => api("check", { lat, lon, ...boatParams() }),
  findSpots: (lat, lon, { radiusKm }) => api("find", { lat, lon, r: radiusKm, ...boatParams() }),
  geocode: (q) => api("geocode", { q }).catch((e) => (/pronaći/.test(e.message) ? null : Promise.reject(e))),
};

const state = { layers: {}, marker: null, results: L.layerGroup(), req: 0, lastFind: null, boat: loadBoat(), me: null, meMarker: null };
const body = document.getElementById("panel-body");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* ---------------- karta ---------------- */
const map = L.map("map", { zoomControl: false, minZoom: 6, maxBounds: [[41.5, 11.5], [46.6, 20.5]] })
  .setView([43.6, 15.9], 8);
L.control.zoom({ position: "topright", zoomInTitle: "Približi", zoomOutTitle: "Udalji" }).addTo(map);
L.control.scale({ position: "bottomright", imperial: false }).addTo(map);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19, className: "chart-land", attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);
// Podloga kao pomorska karta: pojasevi dubine (0-2, 2-5, 5-10, 10-20, >20 m) i izobate iz EMODnet Bathymetry
const DEPTH_BANDS = `<StyledLayerDescriptor version="1.0.0" xmlns="http://www.opengis.net/sld"><NamedLayer><Name>emodnet:mean</Name><UserStyle><FeatureTypeStyle><Rule><RasterSymbolizer><ColorMap type="intervals">`
  + `<ColorMapEntry color="#ffffff" quantity="-20"/><ColorMapEntry color="#c6e3f7" quantity="-10"/><ColorMapEntry color="#9fcff0" quantity="-5"/>`
  + `<ColorMapEntry color="#74b7e8" quantity="-2"/><ColorMapEntry color="#4a9fe0" quantity="0.5"/><ColorMapEntry color="#000000" opacity="0" quantity="100000"/>`
  + `</ColorMap></RasterSymbolizer></Rule></FeatureTypeStyle></UserStyle></NamedLayer></StyledLayerDescriptor>`;
L.tileLayer.wms("https://ows.emodnet-bathymetry.eu/wms", {
  layers: "emodnet:mean", sld_body: DEPTH_BANDS, interpolations: "bicubic", format: "image/png", transparent: true,
  attribution: "EMODnet Bathymetry",
}).addTo(map);
L.tileLayer.wms("https://ows.emodnet-bathymetry.eu/wms", {
  layers: "emodnet:contours", format: "image/png", transparent: true,
}).addTo(map);
state.layers.seamarks = L.tileLayer("https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png", {
  maxZoom: 18, zIndex: 3, attribution: '&copy; <a href="https://www.openseamap.org">OpenSeaMap</a>',
});
// Zračni snimak: DGU digitalni ortofoto 1:5000 (data.gov.hr, otvorena dozvola). Svaki ciklus snima pola Hrvatske,
// pa se slažu dva. Veće pločice jer javna usluga stavlja vodeni žig na svaku sliku.
const dof = (years) => L.tileLayer.wms(`https://geoportal.dgu.hr/services/inspire/orthophoto_${years}/wms`, {
  layers: "OI.OrthoimageCoverage", format: "image/png", transparent: true, version: "1.3.0",
  tileSize: 1024, zoomOffset: -2, minZoom: 11, zIndex: 2,
  attribution: 'Ortofoto &copy; <a href="https://geoportal.dgu.hr">DGU</a>',
});
state.layers.aerial = L.layerGroup([dof("2021_2022"), dof("2023_2024")]);
state.layers.depth = L.tileLayer.wms("https://ows.emodnet-bathymetry.eu/wms", {
  layers: "emodnet:mean_multicolour", format: "image/png", transparent: true, opacity: 0.55, attribution: "EMODnet Bathymetry",
});
map.createPane("grass").style.zIndex = 420;
map.createPane("natura").style.zIndex = 410;
map.createPane("marks").style.zIndex = 640;
state.results.addTo(map);

engine.ready.then((d) => {
  state.layers.substrate = L.geoJSON(d.substrate, {
    interactive: false,
    style: (f) => ({ color: HOLD[f.properties.hold]?.color || "#999", weight: 0, fillOpacity: 0.55 }),
  });
  state.layers.seagrass = L.geoJSON(d.seagrass, {
    pane: "grass", interactive: false, style: () => ({ color: GRASS, weight: 1.5, fillColor: GRASS, fillOpacity: 0.55 }),
  });
  state.layers.natura = L.geoJSON(d.natura2000, {
    pane: "natura", interactive: false, style: () => ({ color: "#7b2cbf", weight: 1.2, dashArray: "4 4", fillOpacity: 0.06 }),
  });
  state.layers.protected = L.geoJSON(d.protectedAreas, {
    pane: "natura", interactive: false, style: () => ({ color: "#1b7f4c", weight: 1.6, dashArray: "6 4", fillColor: "#1b7f4c", fillOpacity: 0.07 }),
  });
  const marks = L.canvas({ pane: "marks" });
  state.layers.navmarks = L.geoJSON(d.navmarks, {
    pointToLayer: (f, ll) => L.circleMarker(ll, {
      renderer: marks, bubblingMouseEvents: false, radius: f.properties.danger ? 5 : 3.5, weight: f.properties.danger ? 2 : 1,
      color: f.properties.danger ? "#111" : "#5b4a00", fillColor: f.properties.danger ? "#f2c14e" : "#fff", fillOpacity: 1,
    }).bindPopup(`<b>${esc(f.properties.name)}</b>${f.properties.danger ? "<br><i>oznaka podvodne opasnosti</i>" : ""}${f.properties.desc ? `<br><small>${esc(f.properties.desc)}</small>` : ""}<br><small>Izvor: Plovput</small>`),
  });
  syncLayers();
}).catch((e) => toast(`Slojevi karte se nisu učitali: ${e.message}`));

function syncLayers() {
  const want = state.layerPrefs || { substrate: false, seagrass: true, seamarks: true };
  for (const [k, layer] of Object.entries(state.layers)) {
    if (want[k]) layer.addTo(map); else map.removeLayer(layer);
  }
}

/* ---------------- početni ekran ---------------- */
function showHome() {
  state.req++;
  body.replaceChildren(document.getElementById("home").content.cloneNode(true));
  body.querySelector("#legend").innerHTML = [3, 2, 1, 0].map((h) =>
    `<li><span class="sw" style="background:${HOLD[h].color}"></span>${["Stijene i kamenje", "Šljunak / krupno", "Mulj / muljeviti pijesak", "Pijesak"][h]}<small>${HOLD[h].word}</small></li>`).join("")
    + `<li><span class="sw grass"></span>Livada morske trave<small>zabranjeno</small></li>`;
  const prefs = state.layerPrefs || { substrate: false, seagrass: true, seamarks: true };
  body.querySelectorAll("[data-layer]").forEach((cb) => {
    cb.checked = !!prefs[cb.dataset.layer];
    cb.addEventListener("change", () => {
      state.layerPrefs = { ...prefs, ...Object.fromEntries([...body.querySelectorAll("[data-layer]")].map((c) => [c.dataset.layer, c.checked])) };
      syncLayers();
    });
  });
  body.querySelector("[data-action=find]").onclick = () => { const c = map.getCenter(); find(c.lat, c.lng); };
  renderBoat(body.querySelector("#boat"), false);
  clearPin();
  state.results.clearLayers();
  setHash(null);
}

const BOAT_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M12 4l6 10h-6M12 6l-5 8h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M3 16h18l-2.5 4h-13z" fill="currentColor"/></svg>`;

function renderBoat(el, editing) {
  const b = state.boat;
  if (!editing) {
    el.innerHTML = `<button type="button" class="boat-sum">${BOAT_SVG}
      <span><b>Moj brod</b><small>${b ? esc(boatLine(b)) : "Upiši gaz i lanac za ocjenu po mjeri tvog broda"}</small></span>
      <u>${b ? "Uredi" : "Dodaj"}</u></button>`;
    el.querySelector("button").onclick = () => renderBoat(el, true);
    return;
  }
  const v = (x) => (x ? String(x) : "");
  el.innerHTML = `<form class="boat-form">
      <label>Gaz <span><input name="draft" type="number" inputmode="decimal" step="0.1" min="0.3" max="6" placeholder="1.8" value="${v(b?.draft)}"> m</span></label>
      <label>Lanac <span><input name="chain" type="number" inputmode="numeric" step="5" min="10" max="300" placeholder="50" value="${v(b?.chain)}"> m</span></label>
      <label>Duljina <span><input name="length" type="number" inputmode="decimal" step="0.5" min="3" max="60" placeholder="12" value="${v(b?.length)}"> m</span></label>
      <div class="boat-actions"><button class="btn" type="submit">Spremi</button>
        ${b ? `<button class="btn ghost" type="button" data-clear>Obriši</button>` : ""}</div>
      <p class="hint">Gaz odbacuje preplitka mjesta, lanac preduboka, a duljina provjerava krug okretanja. Sprema se samo na ovom uređaju.</p>
    </form>`;
  const form = el.querySelector("form");
  form.querySelector("input").focus();
  form.onsubmit = (e) => {
    e.preventDefault();
    const raw = Object.fromEntries(new FormData(form));
    const nb = normBoat(raw);
    const bad = Object.entries(raw).filter(([k, x]) => x !== "" && !nb?.[k]).map(([k]) => ({ draft: "gaz", chain: "lanac", length: "duljina" }[k]));
    if (bad.length) return toast(`Provjeri: ${bad.join(", ")}`);
    state.boat = nb; saveBoat(nb);
    toast(nb ? "Brod spremljen - ocjene su sada po mjeri tvog broda" : "Podaci o brodu obrisani");
    renderBoat(el, false);
  };
  const clr = form.querySelector("[data-clear]");
  if (clr) clr.onclick = () => { state.boat = null; saveBoat(null); renderBoat(el, false); };
}

// Udaljenost i smjer od mog broda (GPS) do točke
function fromMe(lat, lon) {
  if (!state.me) return null;
  const R = 6371, toR = Math.PI / 180;
  const dLat = (lat - state.me.lat) * toR, dLon = (lon - state.me.lon) * toR;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(state.me.lat * toR) * Math.cos(lat * toR) * Math.sin(dLon / 2) ** 2;
  const km = 2 * R * Math.asin(Math.sqrt(a));
  const y = Math.sin(dLon) * Math.cos(lat * toR);
  const x = Math.cos(state.me.lat * toR) * Math.sin(lat * toR) - Math.sin(state.me.lat * toR) * Math.cos(lat * toR) * Math.cos(dLon);
  const brg = (Math.atan2(y, x) / toR + 360) % 360;
  const nm = km / 1.852;
  return { km, brg, text: `${km < 1 ? `${Math.round(km * 1000)} m` : `${num1(km)} km`} (${num1(nm)} NM) ${windOf(brg).side} od tebe` };
}

function setMe(lat, lon, acc) {
  state.me = { lat, lon };
  const icon = L.divIcon({ className: "", html: `<div class="me">${BOAT_SVG}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] });
  if (state.meMarker) state.meMarker.setLatLng([lat, lon]);
  else state.meMarker = L.marker([lat, lon], { icon, keyboard: false, zIndexOffset: 900, title: "Tvoj brod" }).addTo(map);
  state.meMarker.bindTooltip(`Tvoj brod${acc ? ` (±${Math.round(acc)} m)` : ""}`);
  updateBar(map.getCenter(), false);
}

/* ---------------- traka s podacima (kao na ploteru) ---------------- */
const $ = (id) => document.getElementById(id);
// 43.1702 -> 43°10,212'N (stupnjevi i decimalne minute, kao na pomorskim kartama)
const degMin = (v, pad, pos, neg) => {
  const a = Math.abs(v), d = Math.floor(a);
  return `${String(d).padStart(pad, "0")}°${((a - d) * 60).toFixed(3).padStart(6, "0").replace(".", ",")}'${v >= 0 ? pos : neg}`;
};
function updateBar(ll, cursor) {
  $("db-pos-k").textContent = cursor ? "KURSOR" : "SREDINA";
  $("db-lat").textContent = degMin(ll.lat, 2, "N", "S");
  $("db-lon").textContent = degMin(ll.lng, 3, "E", "W");
  const m = fromMe(ll.lat, ll.lng);
  const nm = m && m.km / 1.852;
  $("db-dist").textContent = m ? `${nm.toFixed(nm < 10 ? 2 : 1).replace(".", ",")} NM` : "-";
  $("db-brg").textContent = m ? `${String(Math.round(m.brg) % 360).padStart(3, "0")}°` : "-";
}
function barWind(w) {
  if (!w) return;
  $("db-wind").innerHTML = `${Math.round(w.speed)} čv <span class="wind-arrow" style="transform:rotate(${w.dir + 180}deg)">↑</span>`;
  $("db-wind").parentElement.title = `Vjetar sada: ${windOf(w.dir).name}, ${Math.round(w.speed)} čv`;
}
// Na računalu prati miš, na mobitelu sredinu karte
let cursorOn = false;
if (matchMedia("(hover: hover)").matches) {
  map.on("mousemove", (e) => { cursorOn = true; updateBar(e.latlng, true); });
  map.on("mouseout", () => { cursorOn = false; updateBar(map.getCenter(), false); });
}
map.on("move", () => { if (!cursorOn) updateBar(map.getCenter(), false); });
updateBar(map.getCenter(), false);

/* ---------------- vrijeme: upozorenje i prognoza po 3 h ---------------- */
function alertBox(al, forList) {
  if (!al) return "";
  const when = al.inHours ? `oko ${al.time} (za ${al.inHours} h)` : "sada";
  return `<div class="alert ${al.level === "olujni" ? "bad" : "ok"}" role="alert">
    <b>${al.level === "olujni" ? "Olujni" : "Jak"} vjetar: ${al.name} do ${al.gust} čv ${when}</b>
    <span>${forList ? `Pokazujem samo mjesta zaklonjena od ${al.side}. Ako nijedno ne odgovara, potraži luku ili marinu i stigni prije vjetra.`
      : `Sidri samo gdje je kopno između tebe i vjetra (${al.side}). Pusti 7:1 lanca i dežuraj noću.`}</span></div>`;
}
function windStrip(w) {
  if (!w?.hourly?.length) return "";
  return `<div class="wstrip" aria-label="Udari vjetra idućih 24 sata">${w.hourly.map((h) => `
    <div class="${h.gust >= 34 ? "bad" : h.gust >= 25 ? "ok" : ""}"><small>${h.t}</small>
      <span class="wind-arrow" style="transform:rotate(${h.dir + 180}deg)">↑</span><b>${h.gust}</b></div>`).join("")}
    </div><p class="wstrip-cap">Udari vjetra (čv) idućih 24 h · strelica pokazuje kamo puše${w.simulated ? "" : " · Open-Meteo"}</p>
    ${w.simulated ? `<p class="sim">SIMULACIJA - prognoza je izmišljena za demonstraciju načina rada za loše vrijeme</p>` : ""}`;
}

/* ---------------- traženje sidrišta ---------------- */
async function find(lat, lng, label) {
  const req = ++state.req;
  clearPin();
  state.results.clearLayers();
  const circle = L.circle([lat, lng], { radius: 4000, color: "#1d4e6e", weight: 1.5, dashArray: "6 6", fillOpacity: 0.04, interactive: false });
  state.results.addLayer(circle);
  map.fitBounds(circle.getBounds(), { paddingTopLeft: padTL(), paddingBottomRight: [20, 20] });
  body.innerHTML = `${back()}<h2>${label ? esc(label) : "Tražim sidrišta"}</h2>
    <div class="loading"><div class="spinner"></div><span id="prog">Mjerim dubine i tražim zaklon u krugu od 4 km…</span></div>
    <div class="bar indet"><div></div></div>`;
  wireBack();

  let res;
  try {
    res = await engine.findSpots(lat, lng, { radiusKm: 4 });
  } catch (e) {
    if (req === state.req) body.innerHTML = `${back()}<p class="tip">Pretraga nije uspjela: ${esc(e.message)}</p>`, wireBack();
    return;
  }
  if (req !== state.req) return;
  state.lastFind = { lat, lng, label, res };
  setHash(`f=${lat.toFixed(4)},${lng.toFixed(4)}`);
  renderFind(res, label);
}

function renderFind(res, label) {
  state.results.eachLayer((l) => { if (l instanceof L.Marker) state.results.removeLayer(l); });
  res.spots.forEach((s, i) => {
    state.results.addLayer(L.marker([s.lat, s.lon], {
      icon: L.divIcon({ className: "", html: `<div class="num ${s.lvl}">${i + 1}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] }),
    }).on("click", () => showSpot(s, true)));
  });
  const w = res.weather;
  barWind(w);
  const windLine = w ? `Vjetar sada ${Math.round(w.speed)} čv, udari do ${Math.round(Math.max(w.gust, w.gustMax24 ?? w.gustMax12 ?? 0))} čv u 24 h${res.wind ? ` · najjače puše ${res.wind}` : ""}${res.widened ? ` · krug proširen na ${res.radiusKm} km` : ""}` : "";
  body.innerHTML = `${back()}<h2>${label ? esc(label) : "Sidrišta u blizini"}</h2>
    ${alertBox(res.alert, true)}
    ${windLine ? `<p class="lead">${windLine}</p>` : ""}
    ${windStrip(w)}
    ${res.boat ? `<p class="boat-tag">${BOAT_SVG}Za tvoj brod: ${esc(boatLine(res.boat))}</p>` : ""}
    ${res.spots.length ? `<ol class="spots">${res.spots.map((s, i) => `
      <li><button type="button" data-i="${i}">
        <span class="num ${s.lvl}">${i + 1}</span>
        <span class="sp-main"><b>${s.title}</b><span>${[depthLabel(s), s.seabed?.toLowerCase(), s.shelter?.from.length ? `zaklon od: ${s.shelter.from.join(", ")}` : null].filter(Boolean).join(" · ")}</span></span>
        <span class="sp-side"><b>${s.score}</b><small>${state.me ? esc(fromMe(s.lat, s.lon).text.replace(" od tebe", "")) : `${s.distanceKm} km`}</small></span>
      </button></li>`).join("")}</ol>`
      : res.alert ? `<p class="tip">U krugu od ${res.radiusKm} km nema mjesta zaklonjenog od ${res.alert.side}. Potraži luku ili marinu i stigni prije vjetra.</p>`
      : `<p class="tip">U krugu od 4 km nisam našao dobro sidrište (dno, dubina ${(res.depthRange || [3, 18]).map(num1).join("–")} m, zaklon). Pomakni kartu bliže obali ili uvali i pokušaj opet.${res.boat?.chain && res.depthRange?.[1] < 10 ? ` S ${res.boat.chain} m lanca možeš sidriti najdublje oko ${num1(res.depthRange[1])} m.` : ""}</p>`}
    <p class="hint">Dodirni broj na karti ili u popisu za detalje.</p>`;
  wireBack();
  body.querySelectorAll("[data-i]").forEach((b) => b.onclick = () => showSpot(res.spots[+b.dataset.i], true));
}

/* ---------------- jedna točka ---------------- */
async function check(lat, lng) {
  const req = ++state.req;
  state.results.clearLayers();
  state.lastFind = null;
  pin(lat, lng, "wait");
  keepVisible(lat, lng);
  body.innerHTML = `${back()}<div class="loading"><div class="spinner"></div>Čitam dno, dubinu, zaklon i vjetar…</div>`;
  wireBack();
  let s;
  try { s = await engine.checkSpot(lat, lng); } catch (e) {
    if (req === state.req) { body.innerHTML = `${back()}<p class="tip">Provjera nije uspjela: ${esc(e.message)}</p>`; wireBack(); }
    return;
  }
  if (req !== state.req) return;
  setHash(`p=${lat.toFixed(4)},${lng.toFixed(4)}`);
  showSpot(s, false);
}

function showSpot(s, fromList) {
  if (fromList) { map.setView([s.lat, s.lon], Math.max(map.getZoom(), 14)); keepVisible(s.lat, s.lon); }
  pin(s.lat, s.lon, s.lvl);
  barWind(s.weather);
  body.innerHTML = `${fromList ? `<button class="back" type="button" id="tolist">← Natrag na popis</button>` : back()}
    <div class="verdict ${s.lvl}">
      <div class="score" aria-label="Ocjena ${s.score} od 100">${s.score}</div>
      <div class="title">${s.title}</div>
      <div class="sub">${esc(s.reason)}</div>
    </div>
    ${s.chain ? `<p class="chain"><b>${s.chain} m</b> lanca${s.depth != null ? ` · ${depthLabel(s)} dubine` : ""}</p>` : ""}
    ${alertBox(s.weather?.alert, false)}
    ${state.me ? `<p class="from-me">${BOAT_SVG}${esc(fromMe(s.lat, s.lon).text)}</p>` : ""}
    <ul class="facts">${s.facts.map((f) => `
      <li class="fact"><span class="dot ${f.lvl}"></span><span class="k">${f.k}</span>
        <span class="v">${f.arrow != null ? `<span class="wind-arrow" style="transform:rotate(${f.arrow + 180}deg)">↑</span> ` : ""}${esc(f.v)}</span>
        <span class="d">${esc(f.d)}</span></li>`).join("")}
    </ul>
    ${windStrip(s.weather)}
    ${s.tips.filter((t) => !t.startsWith("Pusti")).map((t) => `<p class="tip">${esc(t)}</p>`).join("")}
    <div class="actions">
      <button class="btn ghost" type="button" id="share">Podijeli</button>
      <a class="btn ghost" href="https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}" target="_blank" rel="noopener">Navigacija</a>
    </div>
    <p class="sources">Dno: EMODnet Geology · Morska trava: EMODnet Seabed Habitats, UNEP-WCMC, HAOP · Dubina: EMODnet Bathymetry · Zaštićena područja i Natura 2000: Bioportal · Oznake: Plovput (data.gov.hr) · Vrijeme: Open-Meteo · Mjesta: OpenStreetMap.
    Pomoć pri planiranju, ne navigacijska karta - uvijek provjeri službenu kartu, dubinomjer i <a href="https://meteo.hr/prognoze.php?section=prognoze_specp&param=jadran" target="_blank" rel="noopener">pomorsku prognozu DHMZ-a</a>.</p>`;
  if (fromList) document.getElementById("tolist").onclick = () => renderFind(state.lastFind.res, state.lastFind.label);
  else wireBack();
  document.getElementById("share").onclick = () => share(s);
}

async function share(s) {
  const url = `${location.origin}${location.pathname}#p=${s.lat.toFixed(4)},${s.lon.toFixed(4)}`;
  const text = `${s.title} (${s.score}/100)${s.depth != null ? `, ${depthLabel(s)}` : ""}${s.seabed ? `, ${s.seabed.toLowerCase()}` : ""}`;
  try {
    if (navigator.share) await navigator.share({ title: "Sigurno sidrište", text, url });
    else { await navigator.clipboard.writeText(`${text}\n${url}`); toast("Poveznica kopirana"); }
  } catch { /* korisnik odustao */ }
}

/* ---------------- pomagala ---------------- */
const back = () => `<button class="back" type="button" id="back">← Početak</button>`;
function wireBack() { const b = document.getElementById("back"); if (b) b.onclick = showHome; }

function pin(lat, lng, lvl) {
  const icon = L.divIcon({ className: "", html: `<div class="pin ${lvl}"></div>`, iconSize: [22, 22], iconAnchor: [11, 11] });
  if (state.marker) state.marker.setLatLng([lat, lng]).setIcon(icon);
  else state.marker = L.marker([lat, lng], { icon, keyboard: false, zIndexOffset: 1000 }).addTo(map);
}
function clearPin() { if (state.marker) { map.removeLayer(state.marker); state.marker = null; } }

const isPhone = () => window.innerWidth <= 720;
const barH = () => $("databar").offsetHeight;
const padTL = () => (isPhone() ? [20, 80 + barH()] : [410, 80 + barH()]);
function keepVisible(lat, lng) {
  if (!isPhone()) return;
  const size = map.getSize();
  const p = map.latLngToContainerPoint([lat, lng]);
  if (p.y > size.y * 0.42 || p.y < 70 + barH()) map.panBy([p.x - size.x / 2, p.y - size.y * 0.24], { animate: true });
}

function toast(msg) {
  const t = Object.assign(document.createElement("div"), { className: "toast", textContent: msg });
  document.body.append(t);
  setTimeout(() => t.remove(), 3200);
}

function setHash(h) { history.replaceState(null, "", `${location.pathname}${location.search}${h ? `#${h}` : ""}`); }

/* ---------------- događaji ---------------- */
map.on("click", (e) => check(e.latlng.lat, e.latlng.lng));

document.getElementById("search").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = document.getElementById("q").value.trim();
  if (!q) return;
  document.getElementById("q").blur();
  // "43.88, 15.18" -> izravno koordinate
  const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,; ]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (m) return find(+m[1], +m[2]);
  try {
    const g = await engine.geocode(q);
    if (!g) return toast(`Ne mogu pronaći "${q}"`);
    find(g.lat, g.lon, g.name);
  } catch { toast("Pretraga mjesta trenutno ne radi"); }
});

document.getElementById("locate").addEventListener("click", () => {
  if (!navigator.geolocation) return toast("Preglednik ne podržava lokaciju");
  navigator.geolocation.getCurrentPosition(
    (p) => { setMe(p.coords.latitude, p.coords.longitude, p.coords.accuracy); find(p.coords.latitude, p.coords.longitude, "Oko tebe"); },
    () => toast("Ne mogu dobiti tvoju lokaciju"),
    { enableHighAccuracy: true, timeout: 10000 },
  );
});

// Poveznice: #p=lat,lon (jedna točka) ili #f=lat,lon (pretraga)
const h = location.hash.match(/^#([pf])=(-?[\d.]+),(-?[\d.]+)/);
showHome();
if (h) {
  const [lat, lng] = [+h[2], +h[3]];
  map.setView([lat, lng], 13);
  engine.ready.then(() => (h[1] === "p" ? check(lat, lng) : find(lat, lng)));
}

// Za demo snimke i otklanjanje grešaka
window.__sidriste = { map, check, find, setMe, state };
