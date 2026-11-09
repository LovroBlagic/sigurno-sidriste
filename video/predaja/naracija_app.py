"""Aplikacija za snimanje naracije vlastitim glasom: video/naracija.html
    python3 video/predaja/naracija_app.py <build_dir>
Vremena scena iz <build_dir>/scenes.json (piše ga render.mjs), tekst iz script.json (polje "naracija").
Pokretanje (mikrofon radi samo na localhostu ili https):
    cd video && python3 -m http.server 8765    ->  http://localhost:8765/naracija.html"""
import json, sys
from pathlib import Path

DIR = Path(__file__).resolve().parent
B = Path(sys.argv[1])
meta = json.load(open(B / "scenes.json"))
script = {s["id"]: s for s in json.load(open(DIR / "script.json"))}
TITLES = {"hook": "Uvod: sidro", "meadow": "Posidonija", "dilemma": "Dilema nautičara", "night": "Noćna bura", "reveal": "Rješenje", "problem": "Problem", "users": "Korisnici", "data": "Otvoreni podaci", "search": "Pretraga", "detail": "Detalji mjesta",
          "posidonia": "Livada posidonije", "boat": "Moj brod", "storm": "Loše vrijeme", "protected": "Parkovi i opasnosti",
          "sdb": "Dubina sa satelita", "sos": "SOS na moru", "mobile": "Na mobitelu", "offline": "Bez interneta",
          "mcp": "AI asistent (MCP)", "tech": "Tehnički pristup", "benefit": "Korist", "outro": "Kraj"}
data = {"total": meta["total"], "scenes": [
    {"id": s["id"], "title": TITLES.get(s["id"], s["id"]), "chapter": s["chapter"], "start": round(s["start"], 3), "dur": s["dur"],
     "text": script[s["id"]].get("naracija", "")} for s in meta["scenes"]]}
tpl = (DIR / "naracija_template.html").read_text(encoding="utf-8")
(DIR.parent / "naracija.html").write_text(tpl.replace("__DATA__", json.dumps(data, ensure_ascii=False)), encoding="utf-8")
print("video/naracija.html:", len(data["scenes"]), "scena")
