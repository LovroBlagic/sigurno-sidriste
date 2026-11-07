#!/usr/bin/env python3
"""
Safe Anchor - turns the raw downloads in ./data into small, Croatia-only
layers the web app loads from ./web/data.

Run:  python3 scripts/build_layers.py      (after scripts/download_data.py)
Needs: Python 3.8+, Node (uses `npx mapshaper` to clip and simplify).
"""

import json
import os
import subprocess
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data")
OUT = os.path.join(ROOT, "web", "data")
os.makedirs(OUT, exist_ok=True)
TMP = tempfile.mkdtemp(prefix="safe-anchor-")

# How well an anchor holds in each EMODnet Folk-5 class (0 bad .. 3 best).
HOLDING = {
    "2. Sand":               ("sand",   "Pijesak",                  3, "Odlično drži - sidro se dobro zarije"),
    "1. Mud to muddy Sand":  ("mud",    "Mulj / muljeviti pijesak", 2, "Dobro drži - pusti dosta lanca i polako zategni"),
    "4. Mixed sediment":     ("mixed",  "Miješano dno",             2, "Osrednje do dobro drži - provjeri je li sidro zahvatilo"),
    "3. Coarse substrate":   ("coarse", "Šljunak / krupno",         1, "Osrednje drži - sidro može kliziti; zategni jače unatrag"),
    "5. Rock & Boulders":    ("rock",   "Stijene i kamenje",        0, "Loše drži i sidro može zapeti - koristi orinku ili plutaču"),
}


def load(name):
    with open(os.path.join(RAW, name), encoding="utf-8") as f:
        return json.load(f)


def dump(path, fc):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(fc, f)


def fc(features):
    return {"type": "FeatureCollection", "features": features}


def mapshaper(*args):
    cmd = ["npx", "-y", "mapshaper@0.6.102", *args]
    subprocess.run(cmd, check=True)


def t(name):
    return os.path.join(TMP, name)


def out(name):
    return os.path.join(OUT, name)


# 1) Seabed substrate, Croatia only, tagged with holding quality.
#    1:250k is the main source; 1:1M fills the inner bays and channels it leaves blank.
def tag_substrate(raw_name, scale):
    feats = []
    for f in load(raw_name)["features"]:
        p = f["properties"]
        if p.get("COUNTRY") != "Croatia" or not f.get("geometry"):
            continue
        key, label, score, note = HOLDING.get(p["FOLK_5_SUBSTRATE_CLASS"],
                                              ("unknown", "Nepoznato", None, "Nema podataka"))
        feats.append({"type": "Feature", "geometry": f["geometry"],
                      "properties": {"cls": key, "label": label, "hold": score,
                                     "note": note, "scale": scale}})
    return fc(feats)


dump(t("sub250.json"), tag_substrate("substrate.geojson", "1:250k"))
dump(t("sub1m.json"), tag_substrate("substrate_1m.geojson", "1:1M"))
mapshaper(t("sub250.json"), "-dissolve", "-o", t("mask250.json"))
mapshaper(t("sub1m.json"), "-erase", t("mask250.json"), "-o", t("sub1m_gaps.json"))
mapshaper("-i", t("sub250.json"), t("sub1m_gaps.json"), "combine-files", "-merge-layers", "force",
          "-simplify", "8%", "keep-shapes", "-clean",
          "-o", out("substrate.geojson"), "precision=0.00001")
# Croatian sea mask = everything EMODnet maps as Croatian seabed
mapshaper(out("substrate.geojson"), "-dissolve", "-o", t("mask.json"))

# 2) Seagrass meadows (Posidonia / Cymodocea) clipped to Croatian waters
feats = []
for f in load("seagrass_2025.geojson")["features"]:
    p = f["properties"]
    kind = p.get("hab_origin", "Seagrass").strip() or "Seagrass"
    feats.append({"type": "Feature", "geometry": f["geometry"],
                  "properties": {"kind": kind, "source": (p.get("source") or "").strip()}})
dump(t("seagrass.json"), fc(feats))
mapshaper(t("seagrass.json"), "-clip", t("mask.json"), "-simplify", "20%", "keep-shapes",
          "-o", out("seagrass.geojson"), "precision=0.00001")

# 3) Posidonia Article 17 grid (10 km cells) reported by Croatia
feats = [{"type": "Feature", "geometry": f["geometry"],
          "properties": {"status": f["properties"].get("cs_ms")}}
         for f in load("posidonia_art17.geojson")["features"]
         if f["properties"].get("ms") == "HR"]
dump(t("posidonia.json"), fc(feats))
mapshaper(t("posidonia.json"), "-clip", t("mask.json"),
          "-o", out("posidonia_grid.geojson"), "precision=0.0001")

# 4) Biological zones (infralittoral = lit seabed where seagrass grows)
feats = [{"type": "Feature", "geometry": f["geometry"],
          "properties": {"zone": f["properties"]["biozone"]}}
         for f in load("biological_zones.geojson")["features"]]
dump(t("bio.json"), fc(feats))
mapshaper(t("bio.json"), "-clip", t("mask.json"), "-dissolve", "zone",
          "-simplify", "10%", "keep-shapes", "-o", out("biozones.geojson"), "precision=0.00001")

# 5) Natura 2000 bird areas (SPA / POP) with flat names
feats = []
for f in load("natura2000.geojson")["features"]:
    p = f["properties"]
    name = p["siteName"]["GeographicalName"]["spelling"]["text"]
    code = p["inspireID"]["localId"]
    feats.append({"type": "Feature", "geometry": f["geometry"],
                  "properties": {"code": code, "name": name}})
dump(t("natura.json"), fc(feats))
mapshaper(t("natura.json"), "-simplify", "3%", "keep-shapes",
          "-o", out("natura2000.geojson"), "precision=0.00001")

for n in sorted(os.listdir(OUT)):
    print(f"  {n:24s} {os.path.getsize(out(n)) / 1024:8.0f} KB")
