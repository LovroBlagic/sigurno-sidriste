"""Pregled videa po kadrovima: video/kadrovi.html + video/kadrovi/*.jpg
    python3 video/predaja/storyboard.py <build_dir>
Čita <build_dir>/scenes.json (početak i trajanje scena, piše ga render.mjs) i video/eSidro-predaja.mp4."""
import json, subprocess, sys, html
from pathlib import Path

DIR = Path(__file__).resolve().parent
VIDEO_DIR = DIR.parent
VIDEO = VIDEO_DIR / "eSidro-predaja.mp4"
OUT = VIDEO_DIR / "kadrovi"
B = Path(sys.argv[1])
scenes = json.load(open(B / "scenes.json"))["scenes"]
total = json.load(open(B / "scenes.json"))["total"]
OUT.mkdir(exist_ok=True)
for f in OUT.glob("*.jpg"): f.unlink()

# što piše na ekranu u svakoj sceni (iz composition.html)
INFO = {
    "problem": ("Problem", "Satelitski snimci Paklenih otoka; naslovi: Tisuće sidara · Posidonia oceanica 1 cm godišnje · 1 sidro = desetljeća rasta · Loše sidrište = opasnost za ljude i brodove"),
    "users": ("Za koga je eSidro?", "Kartice: Nautičari · Čarter gosti · Čarter tvrtke · Javne ustanove parkova · AI asistenti"),
    "data": ("Sedam slojeva, jedan odgovor", "3D ploče slojeva karte; data.gov.hr (3 skupa): zaštićena područja i Natura 2000 (Bioportal), oznake opasnosti (Plovput); EMODnet dno i staništa; uživo: dubina, Open-Meteo, OpenStreetMap"),
    "search": ("Pretraga u jednom koraku", "upiši mjesto, a aplikacija u krugu od 4 km mjeri dubinu, čita dno i traži zaklon"),
    "detail": ("Zašto baš ovo mjesto", "vrsta dna, raspon dubine, zaklon od vjetrova i duljina lanca, sve s objašnjenjem · satelitska podloga"),
    "posidonia": ("Livada posidonije", "dodir na kartiranu livadu: ne sidri ovdje · satelitska podloga"),
    "boat": ("Moj brod", "gaz, lanac i duljina: odbacuje preplitka i preduboka mjesta, provjerava krug okretanja"),
    "storm": ("Loše vrijeme", "jak vjetar u idućih 24 h: udari po satima i samo mjesta u zaklonu od njega · simulacija bure"),
    "protected": ("Parkovi i opasnosti", "Park prirode Telašćica (Bioportal · data.gov.hr) · pličina na 230 m (Plovput · data.gov.hr) · satelitska podloga"),
    "sdb": ("Dubina sa satelita 0–15 m", "Copernicus Sentinel-2 kalibriran na NASA ICESat-2 · eksperimentalno, pogreška ~1,2 m · Pašmanski kanal"),
    "sos": ("SOS na moru", "MAYDAY na VHF 16, brojevi 195 i 112 te položaj u stupnjevima i minutama · DEMO slanje"),
    "mobile": ("Napravljeno za palubu", "Panel na dnu s tri visine · Karta i sidrišta uvijek vidljivi iznad panela · Dodaj na početni zaslon"),
    "offline": ("Radi i kad nema signala", "Aplikacija se otvara bez mreže · Zadnja pretraga spremljena s prognozom za 24 h · Dno i posidonija iz spremljenih slojeva"),
    "mcp": ("AI asistent preko MCP-a", "Pitanje „Gdje mogu sidriti večeras kod Paklenih otoka?“, poziv alata pronadi_sidriste i stvarni odgovor"),
    "tech": ("Tehnički pristup", "Dijagram: web i AI asistent → javni API i MCP → jezgra core.js → pripremljeni slojevi i podaci uživo; OpenAPI 3.1 · INSPIRE WFS · GeoJSON · MCP · PWA · MIT"),
    "benefit": ("Dvostruka korist", "Manje uništene posidonije · Sigurnija noć na sidru · Parkovi: edukacija · Dalje: zone sidrenja, batimetrija HHI, prijave, upozorenja DHMZ-a"),
    "outro": ("eSidro", "Čuvaj more. Spavaj mirno. · poveznice · tim · Datathon 2026, izazov B"),
}
CHAPTER_COLORS = ["#2fd08a", "#3fa7e0", "#f2c14e", "#b9a4ff", "#ff8a5c", "#7ee08a", "#e07bb5", "#93a9bd", "#cfd8e3"]

def mmss(t):
    return f"{int(t // 60)}:{t % 60:04.1f}".replace(".", ",")

chapters = []
for s in scenes:
    if s["chapter"] not in chapters: chapters.append(s["chapter"])

cards, bar = [], []
for s in scenes:
    a, d = s["start"], s["dur"]
    times = [a + 0.6, a + d * 0.3, a + d * 0.55, a + d * 0.8, a + d - 0.6]
    thumbs = []
    for k, t in enumerate(times):
        f = OUT / f"{s['id']}_{k}.jpg"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{t:.2f}", "-i", str(VIDEO), "-frames:v", "1", "-vf", "scale=640:-1", "-q:v", "3", str(f)], check=True)
        thumbs.append(f'<button class="th" data-t="{t:.2f}"><img src="kadrovi/{f.name}" alt="" loading="lazy"><span>{mmss(t)}</span></button>')
    title, text = INFO.get(s["id"], (s["id"], ""))
    color = CHAPTER_COLORS[chapters.index(s["chapter"]) % len(CHAPTER_COLORS)]
    chap = s["chapter"] or "Kraj"
    cards.append(f'''
    <section class="scene" id="s-{s['id']}" data-a="{a:.2f}" data-b="{a + d:.2f}" style="--c:{color}">
      <header><span class="chap">{html.escape(chap)}</span><h2>{html.escape(title)}</h2>
        <button class="time" data-t="{a:.2f}">{mmss(a)} – {mmss(a + d)} · {d:g} s</button></header>
      <p>{html.escape(text)}</p>
      <div class="row">{''.join(thumbs)}</div>
    </section>''')
    bar.append(f'<button class="seg" data-t="{a:.2f}" data-id="s-{s["id"]}" style="flex:{d};--c:{color}" title="{html.escape(title)} · {mmss(a)}"></button>')

page = f'''<!doctype html>
<html lang="hr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>eSidro video po kadrovima</title>
<style>
  :root {{ --bg:#0b1118; --panel:#111b26; --line:#223244; --ink:#e8eef4; --soft:#93a9bd; }}
  * {{ box-sizing:border-box; margin:0; }}
  body {{ background:var(--bg); color:var(--ink); font:15px/1.45 -apple-system, "IBM Plex Sans", system-ui, sans-serif; }}
  .wrap {{ display:grid; grid-template-columns:minmax(0, 36%) minmax(0, 1fr); gap:28px; padding:24px; max-width:2200px; margin:0 auto; }}
  .player {{ position:sticky; top:24px; align-self:start; }}
  video {{ width:100%; border-radius:12px; background:#000; display:block; }}
  h1 {{ font-size:22px; margin-bottom:4px; }}
  .meta {{ color:var(--soft); margin-bottom:14px; }}
  .bar {{ display:flex; gap:2px; margin:14px 0 6px; height:16px; }}
  .seg {{ border:0; border-radius:3px; background:var(--c); opacity:.45; cursor:pointer; padding:0; }}
  .seg.on {{ opacity:1; outline:2px solid #fff; outline-offset:1px; }}
  .now {{ color:var(--soft); font-size:14px; min-height:22px; }}
  .legend {{ display:flex; flex-wrap:wrap; gap:8px 16px; margin-top:12px; color:var(--soft); font-size:13px; }}
  .legend i {{ display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:6px; vertical-align:middle; }}
  .scenes {{ display:grid; gap:18px; }}
  .scene {{ background:var(--panel); border:1px solid var(--line); border-left:4px solid var(--c); border-radius:12px; padding:16px; }}
  .scene.on {{ border-color:var(--c); box-shadow:0 0 0 1px var(--c); }}
  .scene header {{ display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; }}
  .chap {{ color:var(--c); font-size:12px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; }}
  h2 {{ font-size:18px; flex:1; min-width:180px; }}
  .time {{ background:none; border:1px solid var(--line); color:var(--ink); border-radius:8px; padding:4px 10px; cursor:pointer; font:inherit; font-size:13px; }}
  .scene p {{ color:var(--soft); margin:8px 0 12px; }}
  .row {{ display:grid; grid-template-columns:repeat(auto-fill, minmax(240px, 1fr)); gap:8px; }}
  .th {{ position:relative; border:0; padding:0; background:none; cursor:pointer; border-radius:6px; overflow:hidden; }}
  .th img {{ width:100%; display:block; aspect-ratio:16/9; object-fit:cover; }}
  .th span {{ position:absolute; left:4px; bottom:4px; background:rgba(0,0,0,.7); color:#fff; font-size:11px; padding:1px 5px; border-radius:4px; }}
  .th:hover img, .th:focus-visible img {{ outline:2px solid var(--c); outline-offset:-2px; }}
  @media (max-width: 900px) {{
    .wrap {{ grid-template-columns:1fr; padding:16px; }}
    .player {{ position:sticky; top:0; z-index:2; background:var(--bg); padding-bottom:8px; }}
    .row {{ grid-template-columns:repeat(3, minmax(0, 1fr)); }}
    .row .th:nth-child(n+4) {{ display:none; }}
  }}
</style>
</head>
<body>
<div class="wrap">
  <div class="player">
    <h1>eSidro: video za predaju po kadrovima</h1>
    <div class="meta">{len(scenes)} scena · {mmss(total)} · klikni sličicu, vrijeme ili traku za skok u videu</div>
    <video id="v" src="eSidro-predaja.mp4" controls preload="metadata"></video>
    <div class="bar">{''.join(bar)}</div>
    <div class="now" id="now"></div>
    <div class="legend">{''.join(f'<span><i style="background:{CHAPTER_COLORS[i % len(CHAPTER_COLORS)]}"></i>{html.escape(c or "Kraj")}</span>' for i, c in enumerate(chapters))}</div>
  </div>
  <div class="scenes">{''.join(cards)}</div>
</div>
<script>
  const v = document.getElementById("v");
  const scenes = [...document.querySelectorAll(".scene")];
  const segs = [...document.querySelectorAll(".seg")];
  document.addEventListener("click", (e) => {{
    const b = e.target.closest("[data-t]");
    if (!b) return;
    v.currentTime = +b.dataset.t;
    v.play().catch(() => {{}});
  }});
  let last = null;
  v.addEventListener("timeupdate", () => {{
    const t = v.currentTime;
    const s = scenes.find((x) => t >= +x.dataset.a && t < +x.dataset.b) || null;
    if (s === last) return;
    last = s;
    scenes.forEach((x) => x.classList.toggle("on", x === s));
    segs.forEach((x) => x.classList.toggle("on", s && x.dataset.id === s.id));
    document.getElementById("now").textContent = s ? `Sada: ${{s.querySelector(".chap").textContent}} · ${{s.querySelector("h2").textContent}}` : "";
    if (s && !v.paused) s.scrollIntoView({{ block: "nearest", behavior: "smooth" }});
  }});
</script>
</body>
</html>
'''
(VIDEO_DIR / "kadrovi.html").write_text(page, encoding="utf-8")
print("video/kadrovi.html,", len(scenes), "scena,", len(list(OUT.glob('*.jpg'))), "sličica")
