/* Sigurno sidrište - web sučelje. Sva logika je u core.js (dijeli se s MCP serverom). */
import { HOLD } from "./core.js";

const GRASS = "#2a9d5c";

// Sve žive provjere ide preko našeg servera (server/index.js), koji štedi i predmemorira pozive prema EMODnetu.
async function api(route, params) {
  const r = await fetch(`api/${route}?${new URLSearchParams(params)}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
const layer = async (name) => {
  const r = await fetch(`data/${name}.geojson`);
  if (!r.ok) throw new Error(`${name}: ${r.status}`);
  return r.json();
};
const engine = {
  ready: Promise.all(["substrate", "seagrass", "natura2000", "protected", "navmarks"].map(layer))
    .then(([substrate, seagrass, natura2000, protectedAreas, navmarks]) => ({ substrate, seagrass, natura2000, protectedAreas, navmarks })),
  checkSpot: (lat, lon) => api("check", { lat, lon }),
  findSpots: (lat, lon, { radiusKm }) => api("find", { lat, lon, r: radiusKm }),
  geocode: (q) => api("geocode", { q }).catch((e) => (/pronaći/.test(e.message) ? null : Promise.reject(e))),
};

const state = { layers: {}, marker: null, results: L.layerGroup(), req: 0, lastFind: null };
const body = document.getElementById("panel-body");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* ---------------- karta ---------------- */
const map = L.map("map", { zoomControl: false, minZoom: 6, maxBounds: [[41.5, 11.5], [46.6, 20.5]] })
  .setView([43.6, 15.9], 8);
L.control.zoom({ position: "topright", zoomInTitle: "Približi", zoomOutTitle: "Udalji" }).addTo(map);
L.control.scale({ position: "bottomright", imperial: false }).addTo(map);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);
state.layers.seamarks = L.tileLayer("https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png", {
  maxZoom: 18, attribution: '&copy; <a href="https://www.openseamap.org">OpenSeaMap</a>',
});
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
  const want = state.layerPrefs || { substrate: true, seagrass: true, seamarks: true };
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
  const prefs = state.layerPrefs || { substrate: true, seagrass: true, seamarks: true };
  body.querySelectorAll("[data-layer]").forEach((cb) => {
    cb.checked = !!prefs[cb.dataset.layer];
    cb.addEventListener("change", () => {
      state.layerPrefs = { ...prefs, ...Object.fromEntries([...body.querySelectorAll("[data-layer]")].map((c) => [c.dataset.layer, c.checked])) };
      syncLayers();
    });
  });
  body.querySelector("[data-action=find]").onclick = () => { const c = map.getCenter(); find(c.lat, c.lng); };
  clearPin();
  state.results.clearLayers();
  setHash(null);
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
  const windLine = w ? `Vjetar sada ${Math.round(w.speed)} čv, udari do ${Math.round(Math.max(w.gust, w.gustMax12 ?? 0))} čv${res.wind ? ` · najjače puše ${res.wind}` : ""}` : "";
  body.innerHTML = `${back()}<h2>${label ? esc(label) : "Sidrišta u blizini"}</h2>
    ${windLine ? `<p class="lead">${windLine}</p>` : ""}
    ${res.spots.length ? `<ol class="spots">${res.spots.map((s, i) => `
      <li><button type="button" data-i="${i}">
        <span class="num ${s.lvl}">${i + 1}</span>
        <span class="sp-main"><b>${s.title}</b><span>${[s.depth != null ? `${s.depth} m` : null, s.seabed?.toLowerCase(), s.shelter?.from.length ? `zaklon od: ${s.shelter.from.join(", ")}` : null].filter(Boolean).join(" · ")}</span></span>
        <span class="sp-side"><b>${s.score}</b><small>${s.distanceKm} km</small></span>
      </button></li>`).join("")}</ol>`
      : `<p class="tip">U krugu od 4 km nisam našao dobro sidrište (dno, dubina 3–18 m, zaklon). Pomakni kartu bliže obali ili uvali i pokušaj opet.</p>`}
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
  body.innerHTML = `${fromList ? `<button class="back" type="button" id="tolist">← Natrag na popis</button>` : back()}
    <div class="verdict ${s.lvl}">
      <div class="score" aria-label="Ocjena ${s.score} od 100">${s.score}</div>
      <div class="title">${s.title}</div>
      <div class="sub">${esc(s.reason)}</div>
    </div>
    ${s.chain ? `<p class="chain"><b>${s.chain} m</b> lanca${s.depth != null ? ` · ${s.depth} m dubine` : ""}</p>` : ""}
    <ul class="facts">${s.facts.map((f) => `
      <li class="fact"><span class="dot ${f.lvl}"></span><span class="k">${f.k}</span>
        <span class="v">${f.arrow != null ? `<span class="wind-arrow" style="transform:rotate(${f.arrow + 180}deg)">↑</span> ` : ""}${esc(f.v)}</span>
        <span class="d">${esc(f.d)}</span></li>`).join("")}
    </ul>
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
  const text = `${s.title} (${s.score}/100)${s.depth != null ? `, ${s.depth} m` : ""}${s.seabed ? `, ${s.seabed.toLowerCase()}` : ""}`;
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
const padTL = () => (isPhone() ? [20, 80] : [410, 80]);
function keepVisible(lat, lng) {
  if (!isPhone()) return;
  const size = map.getSize();
  const p = map.latLngToContainerPoint([lat, lng]);
  if (p.y > size.y * 0.42 || p.y < 70) map.panBy([p.x - size.x / 2, p.y - size.y * 0.24], { animate: true });
}

function toast(msg) {
  const t = Object.assign(document.createElement("div"), { className: "toast", textContent: msg });
  document.body.append(t);
  setTimeout(() => t.remove(), 3200);
}

function setHash(h) { history.replaceState(null, "", h ? `#${h}` : location.pathname); }

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
    (p) => find(p.coords.latitude, p.coords.longitude, "Oko tebe"),
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
window.__sidriste = { map, check, find };
