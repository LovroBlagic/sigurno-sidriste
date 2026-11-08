#!/usr/bin/env node
/* Unaprijed izračunate pločice karte dubine (web/tiles/depth/{z}/{x}/{y}.png) za Jadran, zum 7-12.
 * Izvor: EMODnet Bathymetry (WMS, bicubic). Svaka zona dobije boju pojasa dubine i tanku izobatu na prijelazu,
 * kopno ostaje prozirno. Pločice samo s kopnom se ne spremaju; popis postojećih je u index.json.
 * Bez npm paketa: PNG se čita i piše ručno (zlib).
 *
 *   node scripts/build_depth_tiles.mjs        (~10 min, ~50 upita prema EMODnetu)
 */
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const OUT = path.join(ROOT, "web", "tiles", "depth");
export const BOUNDS = { s: 41.5, w: 12.0, n: 46.5, e: 20.0 }; // isto kao TILE_BOUNDS u web/app.js
const ZOOMS = (process.env.ZOOMS || "7,8,9,10,11,12").split(",").map(Number); // ZOOMS=7,10 za brzu probu
const CHUNK = 16; // 16x16 pločica = 4096 px po upitu
const MAX_M = 60; // dubina kodirana u sivu: crno = 60 m ili dublje, bijelo = 0 m

// Pojasevi kao na Garmin karti: plitko tamnije plavo, dublje od 20 m bijelo
const BANDS = [2, 5, 10, 20, 50, Infinity];
const PALETTE = [
  [0, 0, 0, 0],            // 0 kopno (prozirno)
  [74, 159, 224, 255],     // 1: 0-2 m
  [116, 183, 232, 255],    // 2: 2-5 m
  [159, 207, 240, 255],    // 3: 5-10 m
  [198, 227, 247, 255],    // 4: 10-20 m
  [255, 255, 255, 255],    // 5: 20-50 m
  [255, 255, 255, 255],    // 6: > 50 m
  [70, 105, 140, 255],     // 7: izobata / obala
];
// Izobate samo na 10-11: pločice zuma 12 preglednik povećava za bliže zumove, pa bi linija postala debela mrlja
const CONTOUR = 7, CONTOUR_ZOOMS = [10, 11];

const SLD = `<StyledLayerDescriptor version="1.0.0" xmlns="http://www.opengis.net/sld"><NamedLayer><Name>emodnet:mean</Name><UserStyle><FeatureTypeStyle><Rule><RasterSymbolizer><ColorMap type="ramp">`
  + `<ColorMapEntry color="#000000" quantity="-${MAX_M}"/><ColorMapEntry color="#ffffff" quantity="0"/>`
  + `<ColorMapEntry color="#ffffff" opacity="0" quantity="0.01"/><ColorMapEntry color="#ffffff" opacity="0" quantity="10000"/>`
  + `</ColorMap></RasterSymbolizer></Rule></FeatureTypeStyle></UserStyle></NamedLayer></StyledLayerDescriptor>`;

/* --- Web Mercator --- */
const R = 6378137, HALF = Math.PI * R;
const tileX = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const tileY = (lat, z) => { const r = (lat * Math.PI) / 180; return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z); };
const tileMerc = (x, y, z) => { const s = (2 * HALF) / 2 ** z; return { minx: -HALF + x * s, maxx: -HALF + (x + 1) * s, maxy: HALF - y * s, miny: HALF - (y + 1) * s }; };

/* --- PNG čitanje (8-bit, paleta / siva / RGB(A), bez isprepletanja) --- */
function readPng(buf) {
  let p = 8, w, h, type, plte, trns; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), t = buf.toString("ascii", p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len);
    if (t === "IHDR") { w = d.readUInt32BE(0); h = d.readUInt32BE(4); type = d[9]; if (d[8] !== 8 || d[12]) throw new Error("PNG format nije podržan"); }
    else if (t === "PLTE") plte = d; else if (t === "tRNS") trns = d; else if (t === "IDAT") idat.push(d);
    p += 12 + len;
  }
  const bpp = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type], stride = w * bpp, raw = zlib.inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), row = px.subarray(y * stride, (y + 1) * stride), up = y ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0, b = up ? up[i] : 0, c = up && i >= bpp ? up[i - bpp] : 0;
      let v = src[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      row[i] = v;
    }
  }
  // vrati sivu (0-255) i prozirnost (true = kopno) po pikselu
  const gray = new Uint8Array(w * h), land = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (type === 3) { const k = px[i]; gray[i] = plte[k * 3]; land[i] = trns && k < trns.length && trns[k] < 128 ? 1 : 0; }
    else if (type === 6) { gray[i] = px[i * 4]; land[i] = px[i * 4 + 3] < 128 ? 1 : 0; }
    else if (type === 4) { gray[i] = px[i * 2]; land[i] = px[i * 2 + 1] < 128 ? 1 : 0; }
    else gray[i] = px[i * bpp];
  }
  return { w, h, gray, land };
}

/* --- PNG pisanje (paleta) --- */
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t, "ascii"), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
const PLTE = Buffer.from(PALETTE.flatMap(([r, g, b]) => [r, g, b])), TRNS = Buffer.from(PALETTE.map((c) => c[3]));
function writePng(idx, w, h) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 3;
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) idx.subarray(y * w, (y + 1) * w).forEach((v, i) => { raw[y * (w + 1) + 1 + i] = v; });
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("PLTE", PLTE), chunk("tRNS", TRNS),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

async function fetchChunk(z, x0, y0, nx, ny) {
  const a = tileMerc(x0, y0, z), b = tileMerc(x0 + nx - 1, y0 + ny - 1, z);
  const q = new URLSearchParams({ service: "WMS", version: "1.1.1", request: "GetMap", layers: "emodnet:mean", styles: "", format: "image/png",
    transparent: "true", srs: "EPSG:3857", bbox: [a.minx, b.miny, b.maxx, a.maxy].join(","), width: nx * 256, height: ny * 256,
    interpolations: "bicubic", sld_body: SLD });
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(`https://ows.emodnet-bathymetry.eu/wms?${q}`, { signal: AbortSignal.timeout(180e3) });
      if (!r.ok || !r.headers.get("content-type")?.startsWith("image/png")) throw new Error(`HTTP ${r.status} ${await r.text().then((t) => t.slice(0, 120))}`);
      return readPng(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      if (attempt >= 4) throw e;
      console.warn(`  z${z} ${x0},${y0}: ${e.message} - ponavljam`);
      await new Promise((s) => setTimeout(s, 5000 * attempt));
    }
  }
}

function classify({ w, h, gray, land }, z) {
  const cls = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (land[i]) continue;
    const depth = ((255 - gray[i]) / 255) * MAX_M;
    cls[i] = 1 + BANDS.findIndex((b) => depth < b);
  }
  if (!CONTOUR_ZOOMS.includes(z)) return cls;
  // tanka linija gdje se pojas mijenja (izobate 2, 5, 10, 20, 50 m) i uz obalu
  const out = cls.slice();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, c = cls[i];
    if (!c) continue;
    const r = x + 1 < w ? cls[i + 1] : c, d = y + 1 < h ? cls[i + w] : c, l = x ? cls[i - 1] : c, u = y ? cls[i - w] : c;
    if ((r && r < c) || (d && d < c) || (l && l < c) || (u && u < c) || !r || !d || !l || !u) out[i] = CONTOUR;
  }
  return out;
}

async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); })); }

await rm(OUT, { recursive: true, force: true });
// index.json: {v, zooms: {z: {x0, y0, w, h, bits}}} - bit po pločici (base64), 1 = postoji. Par KB umjesto popisa.
const index = {};
let bytes = 0, total = 0;
for (const z of ZOOMS) {
  const x0 = tileX(BOUNDS.w, z), x1 = tileX(BOUNDS.e, z), y0 = tileY(BOUNDS.n, z), y1 = tileY(BOUNDS.s, z);
  const W = x1 - x0 + 1, H = y1 - y0 + 1, bits = new Uint8Array(Math.ceil((W * H) / 8));
  const jobs = [];
  for (let cy = y0; cy <= y1; cy += CHUNK) for (let cx = x0; cx <= x1; cx += CHUNK) jobs.push([cx, cy, Math.min(CHUNK, x1 - cx + 1), Math.min(CHUNK, y1 - cy + 1)]);
  console.log(`z${z}: ${(x1 - x0 + 1) * (y1 - y0 + 1)} pločica, ${jobs.length} upita`);
  let saved = 0;
  await pool(jobs, 3, async ([cx, cy, nx, ny]) => {
    const img = await fetchChunk(z, cx, cy, nx, ny);
    const cls = classify(img, z);
    for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) {
      const t = new Uint8Array(256 * 256);
      let sea = false;
      for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
        const v = cls[(ty * 256 + y) * img.w + tx * 256 + x];
        t[y * 256 + x] = v; if (v) sea = true;
      }
      if (!sea) continue; // samo kopno - preglednik ga crta kao kopno
      const dir = path.join(OUT, String(z), String(cx + tx));
      await mkdir(dir, { recursive: true });
      const png = writePng(t, 256, 256);
      await writeFile(path.join(dir, `${cy + ty}.png`), png);
      const k = (cy + ty - y0) * W + (cx + tx - x0);
      bits[k >> 3] |= 1 << (k & 7);
      bytes += png.length; saved++;
    }
  });
  index[z] = { x0, y0, w: W, h: H, bits: Buffer.from(bits).toString("base64") };
  total += saved;
  console.log(`  spremljeno ${saved}`);
}
// v = oznaka izrade; aplikacija je dodaje u URL pločica, pa nova izrada zaobiđe stare pločice u predmemoriji
await writeFile(path.join(OUT, "index.json"), JSON.stringify({ v: Date.now().toString(36), zooms: index }));
console.log(`Gotovo: ${total} pločica, ${(bytes / 1e6).toFixed(1)} MB`);
