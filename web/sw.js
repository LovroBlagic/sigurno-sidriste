/* eSidro - rad bez interneta (service worker).
 *  - aplikacija i naši slojevi spremaju se pri prvom otvaranju, pa se stranica otvara i bez signala
 *  - kod, stil i podaci: prvo mreža (uvijek najnovija verzija), bez mreže spremljena kopija
 *  - naše pločice dubine: iz spremišta (imaju verziju u adresi)
 *  - pločice tuđih karata (OSM, OpenSeaMap, satelit): spremaju se samo one koje je korisnik već gledao;
 *    ništa se ne preuzima unaprijed (pravila korištenja OSM pločica to ne dopuštaju)
 *  - /api/* (pretraga, provjera, prijave): uvijek mreža; bez nje aplikacija koristi spremljene rezultate
 */
const VERSION = "v1";
const SHELL = `esidro-shell-${VERSION}`, TILES = `esidro-tiles-${VERSION}`, EXT = `esidro-ext-${VERSION}`;
const EXT_MAX = 1500; // najviše tuđih pločica u spremištu

const PRECACHE = [
  "./", "index.html", "app.js", "core.js", "geo.js", "style.css", "manifest.json", "icon.svg", "icon-192.png",
  ...["substrate", "seagrass", "posidonia_grid", "biozones", "natura2000", "protected", "navmarks"].map((n) => `data/${n}.geojson`),
  "tiles/depth/index.json", "tiles/sdb/index.json", "tiles/sdbd/index.json",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => Promise.all(PRECACHE.map((u) => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith("esidro-") && ![SHELL, TILES, EXT].includes(k)).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const EXT_TILE = /(^|\.)(tile\.openstreetmap\.org|tiles\.openseamap\.org|server\.arcgisonline\.com)$/;
const STATIC_CDN = /(^|\.)(cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)$/;

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const same = url.origin === location.origin;
  if (same && (url.pathname.startsWith("/api/") || url.pathname === "/mcp")) return; // uvijek mreža
  if (same && url.pathname.startsWith("/tiles/") && !url.pathname.endsWith("index.json")) return e.respondWith(cacheFirst(req, TILES));
  if (same) return e.respondWith(networkFirst(req));
  if (EXT_TILE.test(url.hostname)) return e.respondWith(cacheFirst(req, EXT, EXT_MAX));
  if (STATIC_CDN.test(url.hostname)) return e.respondWith(cacheFirst(req, SHELL));
});

async function networkFirst(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(req, { ignoreSearch: true }) || (req.mode === "navigate" ? await cache.match("index.html") : null);
    return hit || new Response("Bez interneta", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
}

async function cacheFirst(req, name, max) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok || res.type === "opaque") {
      await cache.put(req, res.clone());
      if (max) trim(cache, max);
    }
    return res;
  } catch {
    return new Response("", { status: 504 });
  }
}

let trimming = false;
async function trim(cache, max) {
  if (trimming) return;
  trimming = true;
  try {
    const keys = await cache.keys();
    for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]); // najstarije prve
  } finally { trimming = false; }
}
