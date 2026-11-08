#!/usr/bin/env python3
"""
Safe Anchor - downloads the open seabed datasets for the Croatian Adriatic.

Run:  python3 scripts/download_data.py
Needs: Python 3.8+, internet. No extra packages.
Output: ./data/*.geojson

Sources (credit these in your app):
  - EMODnet Geology  - Seabed substrate 1:250k + 1:1M (Folk classes)
  - EMODnet Seabed Habitats - Posidonia beds (Art.17, habitat 1120)
  - EMODnet Seabed Habitats - Seagrass cover polygons (2025)
  - EMODnet Seabed Habitats - EUSeaMap 2025 biological zones
  - Bioportal (HR, INSPIRE WFS) - Natura 2000 bird areas (ps2:ProtectedSite)
"""

import json
import os
import ssl
import sys
import urllib.parse
import urllib.request

# Croatian Adriatic bounding box (lon/lat, WGS84)
MIN_LON, MIN_LAT, MAX_LON, MAX_LAT = 13.0, 42.3, 19.5, 45.6

OUT = "data"
os.makedirs(OUT, exist_ok=True)
UA = {"User-Agent": "safe-anchor-hackathon/1.0"}


def _ssl_context():
    # macOS python.org builds ship without CA certs; fall back to certifi or the system bundle
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        pass
    for cafile in ("/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt"):
        if os.path.exists(cafile):
            return ssl.create_default_context(cafile=cafile)
    return ssl.create_default_context()


SSL_CTX = _ssl_context()


def get_json(url, params):
    full = url + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(full, headers=UA)
    with urllib.request.urlopen(req, timeout=180, context=SSL_CTX) as r:
        return json.loads(r.read().decode("utf-8"))


def save(name, fc):
    path = os.path.join(OUT, name)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(fc, f)
    print(f"  saved {path}  ({len(fc.get('features', []))} features)")


# 1) Seabed substrate - EMODnet Geology (ArcGIS REST, paged, 1000 per page)
# layer 2 = 1:250k (detailed, offshore), layer 3 = 1:1M (coarser, also covers inner bays)
def substrate(layer=2, filename="substrate.geojson", label="1:250k"):
    print(f"Seabed substrate {label} (EMODnet Geology)...")
    url = ("https://gtkdata.gtk.fi/arcgis/rest/services/EMODnet/"
           f"EMODnet_Geology/MapServer/{layer}/query")
    feats, offset = [], 0
    while True:
        data = get_json(url, {
            "where": "1=1",
            "geometry": f"{MIN_LON},{MIN_LAT},{MAX_LON},{MAX_LAT}",
            "geometryType": "esriGeometryEnvelope",
            "inSR": 4326, "outSR": 4326,
            "spatialRel": "esriSpatialRelIntersects",
            "outFields": "FOLK_5_SUBSTRATE_CLASS,FOLK_16_SUBSTRATE_CLASS,COUNTRY",
            "f": "geojson",
            "resultOffset": offset,
            "resultRecordCount": 1000,
        })
        batch = data.get("features", [])
        feats += batch
        print(f"  page at offset {offset}: {len(batch)}")
        if len(batch) < 1000 and not data.get("exceededTransferLimit"):
            break
        offset += len(batch)
        if not batch:
            break
    save(filename, {"type": "FeatureCollection", "features": feats})


# 2-4) EMODnet Seabed Habitats (GeoServer WFS)
def wfs(layer, filename, label):
    print(f"{label}...")
    url = "https://ows.emodnet-seabedhabitats.eu/geoserver/emodnet_view/wfs"
    data = get_json(url, {
        "service": "WFS", "version": "1.0.0", "request": "GetFeature",
        "typeName": layer,
        "srsName": "EPSG:4326",
        "bbox": f"{MIN_LON},{MIN_LAT},{MAX_LON},{MAX_LAT},EPSG:4326",  # CRS suffix: else read in layer-native CRS
        "outputFormat": "application/json",
    })
    save(filename, data)


# 5) Natura 2000 bird areas - Croatian Bioportal INSPIRE WFS (whole country, ~15 MB)
def natura():
    print("Natura 2000 (Bioportal)...")
    data = get_json("https://services.bioportal.hr/inspire/geos2/ps/wfs", {
        "service": "WFS", "version": "2.0.0", "request": "GetFeature",
        "typeNames": "ps2:ProtectedSite",
        "outputFormat": "application/json", "srsName": "EPSG:4326",
    })
    save("natura2000.geojson", data)


JOBS = [
    ("substrate", substrate),
    ("substrate_1m", lambda: substrate(3, "substrate_1m.geojson", "1:1M")),
    ("posidonia", lambda: wfs("emodnet_view:art17_hab_1120",
                              "posidonia_art17.geojson",
                              "Posidonia beds (Art.17 habitat 1120)")),
    ("seagrass", lambda: wfs("emodnet_view:seagrass_eov_poly_2025",
                             "seagrass_2025.geojson",
                             "Seagrass cover polygons 2025")),
    ("biozones", lambda: wfs("emodnet_view:eusm2025_bio_200",
                             "biological_zones.geojson",
                             "EUSeaMap 2025 biological zones (200m simplified)")),
    ("natura", natura),
]

if __name__ == "__main__":
    failed = []
    for name, fn in JOBS:
        try:
            fn()
        except Exception as e:  # keep going if one source is down
            print(f"  FAILED {name}: {e}")
            failed.append(name)
    print("\nDone." if not failed else f"\nDone, but these failed: {failed}")
    print("Next: python3 scripts/build_layers.py  (depth and wind are queried live in the app)")
    sys.exit(1 if failed else 0)
