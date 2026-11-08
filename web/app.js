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
// Samo Jadran: do kuda postoje pločice dubine (BOUNDS u scripts/build_depth_tiles.mjs)
const TILE_BOUNDS = L.latLngBounds([[41.5, 12.0], [46.5, 20.0]]);
// Koliko se smije vidjeti: zapadna granica uvučena da se ne vidi Tirensko more uz Rim
const VIEW_BOUNDS = L.latLngBounds([[41.5, 12.5], [46.5, 20.0]]);
// Početni prikaz: more od Istre do Dubrovnika, slobodno od panela (lijevo na računalu).
// Mobitel je preuzak za cijelu obalu, pa gleda Kvarner i sjevernu Dalmaciju iznad donjeg panela.
const START = L.latLngBounds([[42.4, 13.2], [45.6, 17.6]]);
const map = L.map("map", { zoomControl: false, maxBounds: VIEW_BOUNDS, maxBoundsViscosity: 1 });
// Najmanji zum: onaj na kojem cijeli ekran stane unutar Jadrana (ovisi o veličini ekrana)
const fitMinZoom = () => map.setMinZoom(Math.max(7, map.getBoundsZoom(VIEW_BOUNDS, true)));
fitMinZoom();
map.on("resize", fitMinZoom);
if (innerWidth <= 720) {
  map.setView([45.2, 14.5], 8);
  map.panBy([0, innerHeight * 0.5 - (120 + innerHeight * 0.5) / 2], { animate: false });
} else {
  map.fitBounds(START, { paddingTopLeft: [400, 130], paddingBottomRight: [20, 20] });
}
L.control.zoom({ position: "topright", zoomInTitle: "Približi", zoomOutTitle: "Udalji" }).addTo(map);
L.control.scale({ position: "bottomright", imperial: false }).addTo(map);

// Pregled (zum < 11): samo more, kopno jednobojno (pozadina #map). Od zuma 11 detaljna obala iz OSM-a.
const base = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  minZoom: 11, maxZoom: 19, className: "chart-land", attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

// Dubina: unaprijed izračunate statične pločice (scripts/build_depth_tiles.mjs), zum 7-12; bliže ih preglednik povećava.
// index.json je bitmapa postojećih pločica, pa se za kopno ništa ne traži sa servera.
const EMPTY = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const DepthTiles = L.TileLayer.extend({
  getTileUrl(c) {
    const t = this.options.index[c.z];
    const x = t ? c.x - t.x0 : -1, y = t ? c.y - t.y0 : -1, k = y * (t?.w ?? 0) + x;
    const has = t && x >= 0 && y >= 0 && x < t.w && y < t.h && (t.bytes[k >> 3] >> (k & 7)) & 1;
    return has ? L.TileLayer.prototype.getTileUrl.call(this, c) : EMPTY;
  },
});
// ?v= je oznaka izrade iz index.json: pločice se dugo pamte, a nova izrada dobije nove adrese
const depth = new DepthTiles("tiles/depth/{z}/{x}/{y}.png?v={v}", {
  index: {}, v: "", minZoom: 7, maxNativeZoom: 12, maxZoom: 19, bounds: TILE_BOUNDS, attribution: "EMODnet Bathymetry",
});
fetch("tiles/depth/index.json", { cache: "no-cache" }).then((r) => r.json()).then(({ v, zooms }) => {
  for (const t of Object.values(zooms)) t.bytes = Uint8Array.from(atob(t.bits), (ch) => ch.charCodeAt(0));
  Object.assign(depth.options, { index: zooms, v });
  if (!state.satellite) depth.addTo(map);
}).catch(() => toast("Karta dubine se nije učitala"));

// Satelit kao na Google kartama: gumb dolje desno mijenja kartu i satelitsku snimku
const satellite = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
  maxZoom: 19, attribution: "Snimke &copy; Esri, Maxar, Earthstar Geographics",
});
L.Control.SatToggle = L.Control.extend({
  options: { position: "bottomright" },
  onAdd() {
    const b = L.DomUtil.create("button", "sat-toggle");
    b.type = "button";
    L.DomEvent.disableClickPropagation(b);
    const draw = () => {
      b.classList.toggle("on", !!state.satellite);
      b.innerHTML = `<span>${state.satellite ? "Karta" : "Satelit"}</span>`;
      b.setAttribute("aria-label", state.satellite ? "Prikaži kartu" : "Prikaži satelitsku snimku");
    };
    b.onclick = () => {
      state.satellite = !state.satellite;
      for (const l of [depth, base]) state.satellite ? map.removeLayer(l) : l.addTo(map);
      state.satellite ? satellite.addTo(map) : map.removeLayer(satellite);
      document.getElementById("map").classList.toggle("sat", state.satellite);
      draw();
    };
    draw();
    return b;
  },
});
new L.Control.SatToggle().addTo(map);

state.layers.seamarks = L.tileLayer("https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png", {
  maxZoom: 18, zIndex: 3, attribution: '&copy; <a href="https://www.openseamap.org">OpenSeaMap</a>',
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

// Eksperimentalno: pliće od 4 m procijenjeno iz Sentinel-2, kalibrirano na ICESat-2 po blokovima od 15 km.
// Pločice postoje samo gdje je blok prošao provjeru točnosti (research/sdb/sdb_hr.py).
fetch("tiles/sdb/index.json", { cache: "no-cache" }).then((r) => r.json()).then(({ v, zooms, meta }) => {
  for (const t of Object.values(zooms)) t.bytes = Uint8Array.from(atob(t.bits), (ch) => ch.charCodeAt(0));
  state.layers.sdb = new DepthTiles("tiles/sdb/{z}/{x}/{y}.png?v={v}", {
    index: zooms, v, minZoom: 8, maxNativeZoom: 13, maxZoom: 19, bounds: TILE_BOUNDS, zIndex: 4, className: "sdb-layer",
    attribution: "Plićaci: Copernicus Sentinel-2, NASA ICESat-2 (eksperimentalno)",
  }).on("add", () => toast(`Narančasto: vjerojatno pliće od ${meta.shallow_below_m} m (satelit; u provjerenim područjima uhvati ≥${Math.round(meta.catch_min * 100)} % takvih mjesta). Nije za navigaciju.`));
  syncLayers();
}).catch(() => {});

function syncLayers() {
  const want = state.layerPrefs || { substrate: false, seagrass: true, seamarks: true, sightings: true };
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
  const prefs = state.layerPrefs || { substrate: false, seagrass: true, seamarks: true, sightings: true };
  body.querySelectorAll("[data-layer]").forEach((cb) => {
    cb.checked = !!prefs[cb.dataset.layer];
    cb.addEventListener("change", () => {
      state.layerPrefs = { ...prefs, ...Object.fromEntries([...body.querySelectorAll("[data-layer]")].map((c) => [c.dataset.layer, c.checked])) };
      syncLayers();
    });
  });
  body.querySelector("[data-action=find]").onclick = () => { const c = map.getCenter(); find(c.lat, c.lng); };
  renderBoat(body.querySelector("#boat"), false);
  renderObs(body.querySelector("#obs"));
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

/* ---------------- opažanja na moru (DEMO prijava: samo nadimak, bez lozinke) ---------------- */
// [naziv, boja, crtež 24x24] - jednostavni piktogrami, bez emojija
const ico = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const KINDS = {
  dupini: ["Dupini", "#1c5fb8", ico('<path d="M3 15c3-6 10-8 16-5l2-2v4"/><path d="M11 9.5l1.5-3.5 2 3"/><path d="M3 19c2-1 3-1 5 0s3 1 5 0 3-1 5 0"/>')],
  kornjaca: ["Kornjača", "#2b7a3b", ico('<path d="M4 14a7 5 0 0 1 14 0z"/><circle cx="20" cy="12.5" r="1.6"/><path d="M7 14l-1 3M15 14l1 3"/>')],
  meduze: ["Meduze", "#8a3fb0", ico('<path d="M5 11a7 7 0 0 1 14 0z"/><path d="M8 11c-1 3 1 5 0 8M12 11c-1 3 1 5 0 8M16 11c-1 3 1 5 0 8"/>')],
  morski_pas: ["Morski pas", "#4a5866", ico('<path d="M4 17c3-1 6-6 8-12 1 5 4 10 8 12"/><path d="M2 20c2-1 4-1 6 0s4 1 6 0 4-1 6 0"/>')],
  mrlja: ["Mrlja / onečišćenje", "#6b4f2a", ico('<path d="M12 3c3 5 6 8 6 12a6 6 0 0 1-12 0c0-4 3-7 6-12z"/>')],
  otpad: ["Plutajući otpad", "#c2410c", ico('<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.01"/>')],
  ostalo: ["Ostalo", "#6b7785", ico('<circle cx="12" cy="12" r="5"/>')],
};
const USER_SVG = ico('<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>');
const USER_KEY = "sidriste.user", MINE_KEY = "sidriste.mine";
const store = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch { /* privatni način */ } } };
state.user = store.get(USER_KEY, null);
state.layers.sightings = L.layerGroup();
const shown = new Set();
function timeAgo(iso) {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 2 ? "upravo" : m < 60 ? `prije ${m} min` : m < 1440 ? `prije ${Math.round(m / 60)} h` : `prije ${Math.round(m / 1440)} d`;
}
function addSighting(r) {
  if (shown.has(r.id) || !KINDS[r.kind]) return null;
  shown.add(r.id);
  const [name, color, svg] = KINDS[r.kind];
  return L.marker([r.lat, r.lon], {
    icon: L.divIcon({ className: "", html: `<div class="obs-pin" style="background:${color}">${svg}</div>`, iconSize: [28, 28], iconAnchor: [14, 14], popupAnchor: [0, -12] }),
    title: name, riseOnHover: true, bubblingMouseEvents: false,
  }).bindPopup(`<b class="obs-head"><i style="background:${color}">${svg}</i>${esc(name)}</b>${r.note ? `<br>${esc(r.note)}` : ""}<br><small>${esc(r.user)} · ${timeAgo(r.at)}</small>`)
    .addTo(state.layers.sightings);
}
// Svoja opažanja čuvamo i lokalno: demo server ih drži samo u memoriji
fetch("api/reports").then((r) => r.json()).then((j) => j.reports.forEach(addSighting)).catch(() => {})
  .finally(() => store.get(MINE_KEY, []).forEach(addSighting));
syncLayers();

function renderObs(el) {
  if (!el) return;
  if (!state.user) {
    el.innerHTML = `<button type="button" class="boat-sum">${KINDS.dupini[2]}
      <span><b>Opažanja na moru</b><small>Prijavi se i označi dupine, kornjače, meduze ili onečišćenje</small></span><u>Prijava</u></button>`;
    el.querySelector("button").onclick = () => {
      el.innerHTML = `<form class="boat-form obs-login">
          <label>Nadimak <input name="user" required maxlength="24" autocomplete="nickname" placeholder="npr. Ana_Bura"></label>
          <div class="boat-actions"><button class="btn" type="submit">Prijavi se</button><button class="btn ghost" type="button" data-cancel>Odustani</button></div>
          <p class="hint">Demo prijava: samo nadimak, bez lozinke i bez računa.</p>
        </form>`;
      const f = el.querySelector("form");
      f.user.focus();
      f.onsubmit = (e) => {
        e.preventDefault();
        const u = f.user.value.trim();
        if (!u) return;
        state.user = u; store.set(USER_KEY, u);
        toast(`Prijavljen si kao ${u}`);
        renderObs(el);
      };
      f.querySelector("[data-cancel]").onclick = () => renderObs(el);
    };
    return;
  }
  el.innerHTML = `<div class="obs-box">
      <p>${USER_SVG}<span><b>${esc(state.user)}</b><small>prijavljen (demo)</small></span><button type="button" class="linkish" data-out>Odjava</button></p>
      <button class="btn${state.marking ? " ghost" : ""}" type="button" data-mark>${state.marking ? "Odustani od označavanja" : "Označi opažanje na moru"}</button>
      ${state.marking ? `<p class="hint">Dodirni more na karti gdje si to vidio.</p>` : ""}
    </div>`;
  el.querySelector("[data-out]").onclick = () => { state.user = null; store.set(USER_KEY, null); setMarking(false); renderObs(el); };
  el.querySelector("[data-mark]").onclick = () => { setMarking(!state.marking); renderObs(el); };
}
function setMarking(on) {
  state.marking = on;
  document.getElementById("map").classList.toggle("marking", on);
  if (on) toast("Dodirni more gdje si to vidio");
}

function showObsForm(lat, lng) {
  setMarking(false);
  state.req++;
  pin(lat, lng, "obs");
  keepVisible(lat, lng);
  body.innerHTML = `${back()}
    <h2>Novo opažanje</h2>
    <p class="lead"><span class="mono">${degMin(lat, 2, "N", "S")} ${degMin(lng, 3, "E", "W")}</span><br>prijavljuje <b>${esc(state.user)}</b></p>
    <form class="obs-form">
      <div class="obs-kinds" role="radiogroup" aria-label="Što si vidio?">
        ${Object.entries(KINDS).map(([k, [n, c, svg]]) => `<label><input type="radio" name="kind" value="${k}" required><span><i style="background:${c}">${svg}</i>${esc(n)}</span></label>`).join("")}
      </div>
      <label class="obs-note">Bilješka (neobavezno)<textarea name="note" maxlength="200" rows="2" placeholder="npr. 5 dupina, plivaju prema jugu"></textarea></label>
      <div class="boat-actions"><button class="btn primary" type="submit">Spremi opažanje</button><button class="btn ghost" type="button" data-cancel>Odustani</button></div>
      <p class="hint">Demo: opažanje vide svi korisnici aplikacije.</p>
    </form>`;
  wireBack();
  const f = body.querySelector("form");
  f.querySelector("[data-cancel]").onclick = showHome;
  f.onsubmit = async (e) => {
    e.preventDefault();
    const btn = f.querySelector("[type=submit]");
    btn.disabled = true;
    try {
      const r = await fetch("api/reports", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat, lon: lng, kind: f.kind.value, note: f.note.value, user: state.user }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      store.set(MINE_KEY, [...store.get(MINE_KEY, []), j].slice(-50));
      if (!(state.layerPrefs || { sightings: true }).sightings) state.layerPrefs = { ...state.layerPrefs, sightings: true }, syncLayers();
      showHome();
      addSighting(j)?.openPopup();
      toast("Opažanje spremljeno - hvala!");
    } catch (err) { btn.disabled = false; toast(`Nije spremljeno: ${err.message}`); }
  };
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

/* ---------------- SOS: stvarne upute + DEMO slanje na server i simulirani VHF ---------------- */
const NATURES = [["voda", "Prodor vode"], ["pozar", "Požar"], ["covjek", "Čovjek u moru"],
  ["nasukavanje", "Nasukavanje"], ["kvar", "Kvar motora, brod pluta"], ["ostalo", "Drugo"]];

function showSos() {
  state.req++;
  stopVhf();
  const c = map.getCenter();
  const w = state.me ? { ...state.me, from: "GPS tvog broda" } : { lat: c.lat, lon: c.lng, from: "sredina karte - za GPS pritisni gumb za lokaciju" };
  pin(w.lat, w.lon, "bad");
  body.innerHTML = `${back()}
    <h2 class="sos-title">SOS - hitni slučaj na moru</h2>
    <div class="sos-real" role="alert">
      <b>Stvarna opasnost? Odmah:</b>
      <ol>
        <li><b>VHF kanal 16</b> - izgovori MAYDAY (postupak ispod)</li>
        <li><b>DSC</b> - drži crveni gumb DISTRESS na radiju 5 s</li>
        <li><a href="tel:195"><b>195</b></a> - traganje i spašavanje na moru (MRCC Rijeka)</li>
        <li><a href="tel:112"><b>112</b></a> - jedinstveni broj za hitne slučajeve</li>
      </ol>
    </div>
    <h3>MAYDAY na VHF 16 - opasnost za život ili brod</h3>
    <ol class="sos-steps">
      <li>„MAYDAY, MAYDAY, MAYDAY“</li>
      <li>„Ovdje je …“ ime broda 3×, pozivni znak ili MMSI</li>
      <li>„MAYDAY“ i ime broda još jednom</li>
      <li>Položaj: stupnjevi i minute, ili udaljenost i smjer od poznate točke</li>
      <li>Što se dogodilo i kakva pomoć treba</li>
      <li>Broj osoba na brodu</li>
      <li>„OVER“ - pa slušaj odgovor</li>
    </ol>
    <p class="tip">PAN-PAN ×3 umjesto MAYDAY kad je hitno, ali nema neposredne opasnosti za život (kvar, bolest).</p>
    <p class="coords">Položaj: ${degMin(w.lat, 2, "N", "S")} ${degMin(w.lon, 3, "E", "W")} · ${esc(w.from)}</p>
    <div class="sos-demo">
      <div class="demo-tag">DEMO - ništa se ne šalje spasiocima ni na pravi radio</div>
      <label>Ime broda <input id="sos-vessel" type="text" maxlength="30" value="Bura" autocomplete="off"></label>
      <label>Što se dogodilo <select id="sos-nature">${NATURES.map(([k, t]) => `<option value="${k}">${t}</option>`).join("")}</select></label>
      <label>Osoba na brodu <input id="sos-people" type="number" min="1" max="99" value="2" inputmode="numeric"></label>
      <button class="btn sos-hold" type="button" id="sos-send"><span class="fill"></span><span class="lbl">Drži 2 s za DEMO SOS</span></button>
      <div id="sos-result" aria-live="polite"></div>
    </div>`;
  $("back").onclick = () => { stopVhf(); showHome(); };
  holdToSend($("sos-send"), () => sendSos(w));
}

// Slanje tek nakon 2 s držanja, da se ne pošalje slučajnim dodirom
function holdToSend(btn, done) {
  let t = null;
  const start = (e) => { if (btn.disabled || t || e.repeat) return; btn.classList.add("holding"); t = setTimeout(() => { t = null; btn.classList.remove("holding"); done(); }, 2000); };
  const stop = () => { clearTimeout(t); t = null; btn.classList.remove("holding"); };
  btn.addEventListener("pointerdown", start);
  for (const ev of ["pointerup", "pointerleave", "pointercancel"]) btn.addEventListener(ev, stop);
  btn.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); start(e); } });
  btn.addEventListener("keyup", stop);
}

async function sendSos(w) {
  const btn = $("sos-send"), out = $("sos-result");
  btn.disabled = true;
  out.innerHTML = `<div class="loading"><div class="spinner"></div>Šaljem DEMO SOS na server…</div>`;
  try {
    const r = await fetch("api/sos", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat: w.lat, lon: w.lon, vessel: $("sos-vessel").value, nature: $("sos-nature").value, people: $("sos-people").value }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    out.innerHTML = `<ul class="sos-log">
        <li class="ok">Server primio poruku · ${esc(j.id)} · ${new Date(j.receivedAt).toLocaleTimeString("hr-HR")}</li>
        <li class="ok">Položaj ${esc(j.position)} · ${j.people} os.</li>
        <li class="no">Proslijeđeno spasiocima: ne (demo)</li>
        <li id="vhf-state">VHF kanal 16: spremno</li>
      </ul>
      <pre class="mayday">${j.mayday.map((l) => `<span>${esc(l)}</span>`).join("\n")}</pre>
      <button class="btn primary" type="button" id="vhf">Emitiraj na VHF 16 (simulacija)</button>`;
    $("vhf").onclick = () => (state.vhf ? stopVhf() : playVhf(j.spoken));
    playVhf(j.spoken);
  } catch (e) {
    out.innerHTML = `<p class="tip">DEMO SOS nije poslan: ${esc(e.message)}</p>`;
    btn.disabled = false;
  }
}

// Simulirano VHF emitiranje: preglednik izgovori MAYDAY na engleskom (jezik pomorskog radija),
// red po red sa stankom; položaj sporije. Trenutni red je istaknut u ispisu.
function playVhf(lines) {
  if (!("speechSynthesis" in window)) return toast("Preglednik ne podržava govor - poruka je ispisana iznad");
  stopVhf();
  const voices = speechSynthesis.getVoices();
  const voice = voices.find((v) => v.lang === "en-GB" && /natural|google|daniel|serena/i.test(v.name))
    ?? voices.find((v) => v.lang === "en-GB") ?? voices.find((v) => v.lang.startsWith("en")) ?? null;
  const spans = [...document.querySelectorAll(".mayday span")];
  state.vhf = true;
  vhfUi(true);
  lines.forEach((text, i) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-GB"; u.voice = voice;
    u.rate = /position/i.test(text) ? 0.7 : 0.85; // koordinate polako
    u.onstart = () => spans.forEach((s, k) => s.classList.toggle("now", k === i));
    if (i === lines.length - 1) u.onend = () => { state.vhf = false; vhfUi(false); };
    u.onerror = () => { state.vhf = false; vhfUi(false); };
    speechSynthesis.speak(u);
  });
}
function stopVhf() {
  if (state.vhf) { state.vhf = false; speechSynthesis.cancel(); }
  vhfUi(false);
}
function vhfUi(on) {
  const s = document.getElementById("vhf-state"), b = document.getElementById("vhf");
  if (!on) document.querySelectorAll(".mayday span.now").forEach((x) => x.classList.remove("now"));
  if (s) { s.className = on ? "tx" : ""; s.textContent = on ? "VHF kanal 16: EMITIRA (simulacija)…" : "VHF kanal 16: simulacija gotova - na pravom radiju sad slušaj odgovor"; }
  if (b) b.textContent = on ? "Zaustavi emitiranje" : "Ponovi emitiranje (simulacija)";
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
map.on("click", (e) => (state.marking && state.user ? showObsForm : check)(e.latlng.lat, e.latlng.lng));
document.getElementById("sos").addEventListener("click", showSos);

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
