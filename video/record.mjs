#!/usr/bin/env node
/* Snima 60 s promotivni video "Sigurno sidrište".
 *   1. npm start            (server mora raditi na :5173)
 *   2. node video/record.mjs
 * Izlaz: video/sigurno-sidriste.mp4
 * Svaka scena traje koliko i njezina naracija (macOS glas "Lana") + mala pauza.
 */
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OVERLAY_INIT, cardProblem, cardIdea, chatScene, cardOutro } from "./scenes.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(DIR, "build");
const APP = process.env.APP_URL || "http://localhost:5173";
const W = 1280, H = 720;
const POSIDONIA = [43.1740, 16.3249]; // kartirana livada posidonije kod Paklenih otoka
mkdirSync(BUILD, { recursive: true });

/* ---------- naracija ---------- */
const NARR = JSON.parse(readFileSync(path.join(DIR, "narration.json"), "utf8"));
const probe = (f) => +execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString();
const scenes = {};
for (const n of NARR) {
  const audio = path.join(BUILD, `${n.id}.aiff`);
  if (!existsSync(audio)) execFileSync("say", ["-v", "Lana", "-r", "178", "-o", audio, n.text]);
  const len = probe(audio);
  scenes[n.id] = { ...n, audio, dur: +(len + (n.id === "s7" ? 0.8 : 0.25) + 0.15).toFixed(2) };
}
console.log("trajanje:", Object.values(scenes).reduce((a, s) => a + s.dur, 0).toFixed(1), "s");

/* ---------- zagrijavanje predmemorije (da pretraga u snimci stigne odmah) ---------- */
{
  const g = await (await fetch(`${APP}/api/geocode?q=${encodeURIComponent("Pakleni otoci")}`)).json();
  const t = Date.now();
  await (await fetch(`${APP}/api/find?lat=${g.lat}&lon=${g.lon}&r=4`)).json();
  console.log(`zagrijano: pretraga ${((Date.now() - t) / 1000).toFixed(1)} s`);
}

/* ---------- snimanje ---------- */
const browser = await chromium.launch();
const takes = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function take(name, fn) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, locale: "hr-HR",
    recordVideo: { dir: BUILD, size: { width: W, height: H } } });
  const page = await ctx.newPage();
  const t0 = Date.now();
  const marks = [];
  const mark = (id) => { marks.push({ id, at: (Date.now() - t0) / 1000 }); return Date.now(); };
  await fn(page, mark);
  const wall = (Date.now() - t0) / 1000;
  await ctx.close();
  const file = await page.video().path();
  // Video počinje malo nakon t0: pomakni oznake za tu razliku
  const lag = Math.max(0, wall - probe(file));
  marks.forEach((m) => { m.at = Math.max(0, m.at - lag); });
  takes.push({ name, file, marks });
  console.log(`snimljeno: ${name} (kašnjenje ${lag.toFixed(2)} s)`, marks.map((m) => `${m.id}@${m.at.toFixed(2)}`).join(" "));
}

// pričekaj do t sekundi nakon početka scene
const until = async (start, t) => { const left = start + t * 1000 - Date.now(); if (left > 0) await sleep(left); };

async function glide(page, from, to, ms = 700) {
  const steps = Math.max(8, Math.round(ms / 16));
  for (let i = 1; i <= steps; i++) {
    const k = i / steps, e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    await page.mouse.move(from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e);
    await sleep(ms / steps);
  }
  return to;
}
const center = async (loc) => { const b = await loc.boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };

async function card(page, mark, id, html) {
  await page.setContent(html, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await sleep(200);
  const start = mark(id);
  await page.evaluate(() => { document.body.style.display = ""; window.start?.(); });
  await until(start, scenes[id].dur);
}

// --- 1, 2: problem i ideja
await take("uvod", async (page, mark) => {
  await card(page, mark, "s1", cardProblem(scenes.s1.text));
  await card(page, mark, "s2", cardIdea(scenes.s2.text));
});

// --- 3, 4, 5: aplikacija uživo
await take("aplikacija", async (page, mark) => {
  await page.addInitScript(OVERLAY_INIT);
  await page.goto(APP, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelectorAll(".leaflet-overlay-pane path").length > 100);
  await page.evaluate(() => document.fonts.ready);
  await sleep(1500);
  let cur = [900, 520];
  await page.mouse.move(...cur);

  // s3: upiši mjesto, pritisni gumb, popis sidrišta
  let start = mark("s3");
  await page.evaluate((t) => window.__caption(t), scenes.s3.text);
  const input = page.locator("#q");
  cur = await glide(page, cur, await center(input), 900);
  await until(start, 1.3);
  await page.mouse.click(...cur);
  await page.keyboard.type("Pakleni otoci", { delay: 85 });
  await until(start, 3.6);
  cur = await glide(page, cur, await center(page.locator("#search button")), 600);
  await until(start, 4.6);
  await page.mouse.click(...cur);
  await page.waitForSelector(".spots button");
  await until(start, 7.6);
  const items = page.locator(".spots button");
  cur = await glide(page, cur, await center(items.nth(0)), 900);
  await until(start, 9.6);
  cur = await glide(page, cur, await center(items.nth(1)), 600);
  await until(start, 11.0);
  cur = await glide(page, cur, await center(items.nth(0)), 600);
  await until(start, scenes.s3.dur);

  // s4: detalji prvog mjesta
  start = mark("s4");
  await page.evaluate((t) => window.__caption(t), scenes.s4.text);
  await page.mouse.click(...cur);
  await page.waitForSelector(".verdict");
  await until(start, 2.8);
  cur = await glide(page, cur, [200, 470], 500);
  for (let i = 0; i < 14; i++) { await page.mouse.wheel(0, 24); await sleep(190); }
  await until(start, scenes.s4.dur);

  // s5: dodir na livadu posidonije
  start = mark("s5");
  await page.evaluate((t) => window.__caption(t), scenes.s5.text);
  await page.evaluate(([la, lo]) => new Promise((ok) => {
    const m = window.__sidriste.map; m.once("moveend", ok); m.flyTo([la, lo], 15, { duration: 1.1 });
  }), POSIDONIA);
  const target = await page.evaluate(([la, lo]) => {
    const m = window.__sidriste.map; const p = m.latLngToContainerPoint([la, lo]).round();
    const ll = m.containerPointToLatLng(p); return { x: p.x, y: p.y, lat: ll.lat, lng: ll.lng };
  }, POSIDONIA);
  // zagrij predmemoriju servera za točno tu točku, da rezultat stigne odmah nakon klika
  const warm = page.evaluate(({ lat, lng }) => fetch(`api/check?lat=${lat}&lon=${lng}`).then((r) => r.json()), target);
  cur = await glide(page, cur, [target.x, target.y], 900);
  await warm;
  await until(start, 2.1);
  await page.mouse.click(target.x, target.y);
  await page.waitForSelector(".verdict");
  await until(start, scenes.s5.dur);
});

// --- 6: MCP u AI asistentu (stvarni rezultat alata)
const found = await (await fetch(`${APP}/api/find?q=${encodeURIComponent("Pakleni otoci")}`)).json();
const top = found.spots.slice(0, 3);
const w = found.weather;
const answer = `Noćas ${w ? `udari do <b>${Math.round(Math.max(w.gust, w.gustMax12 ?? 0))} čv</b>, najjače puše <b>${found.wind}</b>` : ""} - evo mjesta u zaklonu:
  <ol>${top.map((s) => `<li><b>${s.depth} m, ${s.seabed.toLowerCase()}</b> · ocjena ${s.score}/100<br>
    <span class="m">zaklon od: ${s.shelter.from.join(", ")} · pusti ${s.chain} m lanca · ${s.distanceKm} km</span></li>`).join("")}</ol>
  <div class="warn">Spusti sidro na svijetli pijesak - nikad na posidoniju.</div>`;
await take("mcp", async (page, mark) => {
  await card(page, mark, "s6", chatScene(scenes.s6.text, "Gdje mogu sidriti večeras kod Paklenih otoka?", answer));
});

// --- 7: kraj
await take("kraj", async (page, mark) => { await card(page, mark, "s7", cardOutro(scenes.s7.text)); });
await browser.close();

/* ---------- montaža ---------- */
const parts = [];
for (const t of takes) {
  t.marks.forEach((m, i) => {
    const s = scenes[m.id];
    const first = i === 0, last = i === t.marks.length - 1;
    const fades = [first ? "fade=t=in:st=0:d=0.3" : null, last ? `fade=t=out:st=${(s.dur - 0.3).toFixed(2)}:d=0.3` : null].filter(Boolean);
    const out = path.join(BUILD, `${m.id}.mp4`);
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", m.at.toFixed(3), "-i", t.file, "-i", s.audio,
      "-filter_complex", [`[0:v]fps=30,scale=${W}:${H},format=yuv420p${fades.length ? "," + fades.join(",") : ""}[v]`,
        `[1:a]aresample=48000,adelay=150|150,apad,atrim=0:${s.dur}[a]`].join(";"),
      "-map", "[v]", "-map", "[a]", "-t", String(s.dur), "-c:v", "libx264", "-preset", "medium", "-crf", "18",
      "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2", out]);
    parts.push(out);
  });
}
const list = path.join(BUILD, "list.txt");
writeFileSync(list, NARR.map((n) => `file '${path.join(BUILD, `${n.id}.mp4`)}'`).join("\n"));
const final = path.join(DIR, "sigurno-sidriste.mp4");
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", final]);
console.log("gotovo:", final, probe(final).toFixed(1), "s");
