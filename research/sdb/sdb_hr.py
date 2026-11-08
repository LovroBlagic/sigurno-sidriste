"""Satellite "shallower than 4 m" layer for the whole Croatian coast.

Same method as sdb_plavnik.py (Stumpf log-ratio from Sentinel-2, calibrated on ICESat-2 ATL24),
run per Sentinel-2 tile with its own scene, calibration and quality gate. Tiles that fail the
gate are left out of the map. Output: XYZ tiles in web/tiles/sdb/ (+ index.json in the same
format as web/tiles/depth) and research/sdb/results_hr.json.

Usage (from the repo root, same venv as sdb_plavnik.py plus scipy and shapely):
    .venv-sdb/bin/pip install numpy rasterio matplotlib sliderule scipy shapely
    .venv-sdb/bin/python research/sdb/sdb_hr.py            # all tiles (~1 h first time)
    .venv-sdb/bin/python research/sdb/sdb_hr.py 33TVK      # one tile (cached data is reused)
"""
import base64
import json
import math
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
os.environ.setdefault("AWS_NO_SIGN_REQUEST", "YES")
os.environ.setdefault("GDAL_HTTP_MULTIRANGE", "YES")
os.environ.setdefault("GDAL_HTTP_MERGE_CONSECUTIVE_RANGES", "YES")

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.features import rasterize
from rasterio.transform import rowcol
from rasterio.warp import reproject, transform, transform_bounds, transform_geom
from scipy import ndimage
from shapely import contains_xy
from shapely.geometry import box, mapping, shape

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sdb_plavnik as P  # noqa: E402  (shared constants and helpers)

HERE = P.HERE
DATA = P.DATA / "hr"
WEB_TILES = HERE.parents[1] / "web" / "tiles" / "sdb"
STAC_SEARCH = "https://earth-search.aws.element84.com/v1/search"
EEZ_URL = ("https://geo.vliz.be/geoserver/MarineRegions/wfs?service=WFS&version=1.0.0&request=GetFeature"
           "&typeName=MarineRegions:eez&outputFormat=application/json&propertyName=mrgid,geoname,the_geom"
           "&cql_filter=mrgid=5673")  # Croatian EEZ (Marine Regions, CC BY 4.0)
# Sentinel-2 tiles that overlap the Croatian EEZ (tiles without Croatian coast are skipped automatically)
TILES = ["33TUL", "33TUK", "33TUJ", "33TVL", "33TVK", "33TVJ", "33TVH", "33TWK", "33TWJ", "33TWH",
         "33TWG", "33TXJ", "33TXH", "33TXG", "33TYH", "33TYG", "34TBM"]
DATES = "2025-05-01T00:00:00Z/2026-11-08T00:00:00Z"
COAST_KM = 3.0          # look for shallows within this distance of land ...
COAST_EMOD_M = 40.0     # ... or where EMODnet says shallower than this (offshore shoals)
FALSE_BOTTOM_M = 40.0   # ICESat-2 'bottom' where EMODnet is deeper than this = false bottom
SHALLOW_M = 4.0         # the map answers "shallower than 4 m?"
TARGET_CATCH = 0.95     # pick the smallest SDB threshold (4.0-6.0 m) that marks >= 95 % of real < 4 m pixels
# One linear model per 15 km block: a single model per 110 km tile mixes bottom types and water
# clarity (tile 33TVK: r 0.39 for the whole tile, ~0.9 in most blocks). Each block has its own
# calibration and gate; blocks that fail are left off the map. 15 km was picked on tile 33TVK
# (20 km: 12/28 blocks pass, 24.7 km2; 15 km: 17/50, 32.1 km2; 10 km: 21/88, 31.5 km2; same RMSE).
BLOCK_PX = 1500
GATE = dict(min_pixels=80, min_tracks=8, min_r=0.7, max_rmse=2.0, min_shallow=20, max_emod_deep_share=0.1)
EMOD_DEEP_M = 20.0      # never mark where EMODnet is deeper than this; a block marking > 10 % there fails
Z_MAX, Z_MIN = 13, 8    # web tiles: native zoom 13 (~14 m pixels at 44 N), browser upscales beyond
ORANGE = (230, 81, 0, 200)
PREFETCH = False


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, file=sys.stderr, flush=True)


def jget(url, body=None):
    req = urllib.request.Request(url, json.dumps(body).encode() if body else None, {"Content-Type": "application/json"})
    for attempt in range(5):
        try:
            return json.load(urllib.request.urlopen(req, timeout=120))
        except Exception:
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(url)


def eez():
    path = P.fetch(EEZ_URL, P.DATA / "hr_eez.geojson")
    return shape(json.load(open(path))["features"][0]["geometry"])


# ---------------------------------------------------------------- scene choice
def choose_scene(tile, sea):
    """Clearest, lowest-glint scene: few clouds, little nodata, lowest NIR over open water (overview)."""
    cache = DATA / f"{tile}_scene.json"
    if cache.exists():
        return json.loads(cache.read_text())
    feats = []
    for nodata in (5, 40):
        body = {"collections": ["sentinel-2-l2a"], "datetime": DATES, "limit": 200,
                "query": {"grid:code": {"eq": f"MGRS-{tile}"}, "eo:cloud_cover": {"lt": 5},
                          "s2:nodata_pixel_percentage": {"lt": nodata}}}
        feats = jget(STAC_SEARCH, body)["features"]
        if feats:
            break
    feats.sort(key=lambda f: f["properties"]["eo:cloud_cover"])
    best = None
    for f in feats[:12]:
        with rasterio.open(f["assets"]["nir"]["href"]) as ds:
            ov = 16
            nir = ds.read(1, out_shape=(ds.height // ov, ds.width // ov)).astype("f4") * 1e-4
            tr = ds.transform * ds.transform.scale(ds.width / nir.shape[1], ds.height / nir.shape[0])
            inside = rasterize([transform_geom("EPSG:4326", ds.crs, mapping(sea))], out_shape=nir.shape, transform=tr) > 0
        water = inside & (nir > 0) & (nir < P.NIR_LAND)
        if water.sum() < 100:
            continue
        glint = float(np.median(nir[water]))
        score = glint + 0.0005 * f["properties"]["eo:cloud_cover"]
        if best is None or score < best["score"]:
            best = dict(id=f["id"], score=score, glint_nir=glint, cloud=f["properties"]["eo:cloud_cover"],
                        nodata=f["properties"]["s2:nodata_pixel_percentage"])
    DATA.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(best))
    return best


# ---------------------------------------------------------------- per-tile ratio
def emod_grid(tile_bounds_ll):
    w, s, e, n = tile_bounds_ll
    url = (P.WCS.split("&subset=")[0] + f"&subset=Lat({s:.4f},{n:.4f})&subset=Long({w:.4f},{e:.4f})")
    path = DATA / f"emod_{w:.3f}_{s:.3f}.tif"
    return P.fetch(url, path)


def tile_ratio(tile, scene, sea):
    """Stumpf ratio (5x5 NaN-median) for coastal Croatian water of one tile; cached as uint16 GeoTIFF."""
    out = DATA / f"{scene}_ratio.tif"
    if out.exists():
        with rasterio.open(out) as ds:
            r = ds.read(1)
            return np.where(r > 0, r.astype("f4") / 10000, np.nan), ds.transform, ds.crs
    item = jget(P.STAC + scene)
    assert item["properties"].get("earthsearch:boa_offset_applied") is True

    def read(key):
        with rasterio.open(item["assets"][key]["href"]) as ds:
            if key == "scl":
                return ds.read(1, out_shape=(ds.height * 2, ds.width * 2), resampling=Resampling.nearest)
            return ds.read(1)
    with ThreadPoolExecutor(4) as ex:
        b, g, nir, scl = ex.map(read, ["blue", "green", "nir", "scl"])
    with rasterio.open(item["assets"]["blue"]["href"]) as ds:
        tr, crs, shp = ds.transform, ds.crs, (ds.height, ds.width)
    log(tile, "read bands")
    b = b.astype("f4") * 1e-4; g = g.astype("f4") * 1e-4; nir = nir.astype("f4") * 1e-4
    cloud = np.isin(scl, [0, 1, 3, 8, 9, 10])  # nodata, saturated, cloud shadow, cloud, cirrus
    land = nir >= P.NIR_LAND
    water = ~land & ~cloud & (b > 0) & (g > 0)
    water &= ~ndimage.binary_dilation(land, iterations=1)  # first pixel next to land is mixed
    inside = rasterize([transform_geom("EPSG:4326", crs, mapping(sea))], out_shape=shp, transform=tr) > 0
    # coastal zone: within COAST_KM of land, or EMODnet shallower than COAST_EMOD_M
    small = land[::8, ::8]
    near = ndimage.distance_transform_edt(~small) * 80 <= COAST_KM * 1000
    near = np.repeat(np.repeat(near, 8, 0), 8, 1)[: shp[0], : shp[1]]
    emod = np.zeros(shp, "f4")
    with rasterio.open(emod_grid(transform_bounds(crs, "EPSG:4326", *rasterio.transform.array_bounds(*shp, tr)))) as ds:
        reproject(ds.read(1), emod, src_transform=ds.transform, src_crs=ds.crs, dst_transform=tr, dst_crs=crs,
                  resampling=Resampling.bilinear)
    cand = water & inside & (near | ((emod < 0) & (-emod < COAST_EMOD_M)))
    del scl, cloud, small, near
    with np.errstate(invalid="ignore", divide="ignore"):
        raw = np.log(P.N * b) / np.log(P.N * g)
    raw[~water] = np.nan
    del b, g
    # 5x5 NaN-median only where needed (candidate pixels), in chunks
    ratio = np.full(shp, np.nan, "f4")
    pad = np.pad(raw, 2, constant_values=np.nan)
    rr, cc = np.nonzero(cand)
    offs = [(dy, dx) for dy in range(5) for dx in range(5)]
    for s in range(0, rr.size, 2_000_000):
        r_, c_ = rr[s:s + 2_000_000], cc[s:s + 2_000_000]
        win = np.stack([pad[r_ + dy, c_ + dx] for dy, dx in offs], axis=1)
        with np.errstate(all="ignore"):
            import warnings
            warnings.simplefilter("ignore", RuntimeWarning)
            ratio[r_, c_] = np.nanmedian(win, axis=1)
    log(tile, "ratio for", rr.size, "coastal water pixels")
    enc = np.where(np.isfinite(ratio), np.clip(ratio * 10000, 1, 65535), 0).astype("uint16")
    with rasterio.open(out, "w", driver="GTiff", dtype="uint16", count=1, crs=crs, transform=tr, width=shp[1], height=shp[0],
                       compress="deflate", predictor=2, tiled=True, nodata=0) as dst:
        dst.write(enc, 1)
    # keep EMODnet on the tile grid for the deep-water reference and the false-bottom filter
    np.save(DATA / f"{scene}_emod.npy", emod[::8, ::8])
    return ratio, tr, crs


# ---------------------------------------------------------------- ICESat-2
def icesat2(tile, bounds_ll, sea):
    path = DATA / f"{tile}_atl24.csv"
    if not path.exists():
        from sliderule import sliderule
        sliderule.init()
        w, s, e, n = bounds_ll
        rows = []
        # SlideRule caps one request at 300 granules: ask in 3x3 parts
        for i in range(3):
            for j in range(3):
                x0, x1 = w + (e - w) * i / 3, w + (e - w) * (i + 1) / 3
                y0, y1 = s + (n - s) * j / 3, s + (n - s) * (j + 1) / 3
                part = box(x0, y0, x1, y1)
                if not part.intersects(sea):
                    continue
                aoi = [dict(lon=x0, lat=y0), dict(lon=x1, lat=y0), dict(lon=x1, lat=y1), dict(lon=x0, lat=y1), dict(lon=x0, lat=y0)]
                gdf = sliderule.run("atl24x", {}, aoi=aoi)
                if gdf is None or len(gdf) == 0:
                    continue
                gdf = gdf[gdf["class_ph"] == 40]
                rows += [("%.7f,%.7f,%.3f,%.4f,%s_gt%s\n" % (x, y, d, c, t.date(), gt))
                         for x, y, d, c, t, gt in zip(gdf.geometry.x, gdf.geometry.y, gdf["surface_h"] - gdf["ortho_h"],
                                                      gdf["confidence"], gdf.index, gdf["gt"])]
        with open(path, "w") as f:
            f.write("lon,lat,depth,confidence,track\n")
            f.writelines(rows)
    a = np.genfromtxt(path, delimiter=",", names=True, dtype=None, encoding="utf-8")
    if a.size == 0:
        return a
    a = np.atleast_1d(a)
    a = a[np.isfinite(a["depth"]) & (a["depth"] > 0) & (a["confidence"] >= P.IS2_MIN_CONF)]
    return a[contains_xy(sea, a["lon"], a["lat"])]


def is2_pixels(scene, ratio, tr, crs, a):
    """Median ICESat-2 depth per 10 m pixel (>= IS2_MIN_PHOTONS photons), false bottoms removed."""
    emod = np.load(DATA / f"{scene}_emod.npy")
    x, y = transform("EPSG:4326", crs, a["lon"], a["lat"])
    r, c = (np.asarray(v) for v in rowcol(tr, x, y))
    ok = (r >= 0) & (r < ratio.shape[0]) & (c >= 0) & (c < ratio.shape[1])
    a, r, c = a[ok], r[ok], c[ok]
    false = emod[np.clip(r // 8, 0, emod.shape[0] - 1), np.clip(c // 8, 0, emod.shape[1] - 1)] < -FALSE_BOTTOM_M
    a, r, c = a[~false], r[~false], c[~false]
    u, inv, cnt = np.unique(r * ratio.shape[1] + c, return_inverse=True, return_counts=True)
    order = np.argsort(inv, kind="stable")
    starts = np.cumsum(cnt) - cnt  # empty when no photon is left (e.g. all were false bottoms)
    dep = np.array([np.median(a["depth"][order[s:s + n]]) for s, n in zip(starts, cnt)])
    trk = np.array([a["track"][order[s]] for s in starts])
    keep = (cnt >= P.IS2_MIN_PHOTONS) & np.isfinite(ratio.ravel()[u])
    return u[keep], dep[keep], trk[keep], int(false.sum())


def calibrate_block(rat, dep, trk):
    """Linear Stumpf fit with CV by ICESat-2 pass; returns stats, model and threshold, or a reason."""
    tracks = np.unique(trk)
    res = dict(n_pixels=int(dep.size), n_tracks=int(tracks.size))
    if dep.size < GATE["min_pixels"] or tracks.size < GATE["min_tracks"]:
        res["fail"] = f"too little ICESat-2 ({dep.size} pixels, {tracks.size} passes)"
        return res
    fold_of = dict(zip(np.random.default_rng(0).permutation(tracks), np.arange(tracks.size) % P.N_FOLDS))
    fold = np.array([fold_of[t] for t in trk])
    oof = np.full(dep.size, np.nan)
    for k in range(P.N_FOLDS):
        m1, m0 = P.fit(rat[fold != k], dep[fold != k])
        oof[fold == k] = m1 * rat[fold == k] + m0
    m1, m0 = P.fit(rat, dep)
    truly = dep < SHALLOW_M
    res.update(r_pearson=float(np.corrcoef(rat, dep)[0, 1]), cv=P.stats(oof, dep), m1=float(m1), m0=float(m0),
               n_shallow=int(truly.sum()))
    thr = next((t for t in np.arange(SHALLOW_M, 6.01, 0.5) if truly.sum() and np.mean(oof[truly] < t) >= TARGET_CATCH), None)
    if thr is not None:
        res.update(threshold_m=float(thr), catch=float(np.mean(oof[truly] < thr)),
                   marked_truly_shallow=float(np.mean(truly[oof < thr])))
    why = [w for w, bad in [
        (f"r {res['r_pearson']:.2f} < {GATE['min_r']}", res["r_pearson"] < GATE["min_r"]),
        (f"RMSE {res['cv']['rmse']:.1f} m > {GATE['max_rmse']}", res["cv"]["rmse"] > GATE["max_rmse"]),
        (f"only {truly.sum()} pixels < {SHALLOW_M:.0f} m", truly.sum() < GATE["min_shallow"]),
        (f"no threshold <= 6 m catches {TARGET_CATCH:.0%}", thr is None)] if bad]
    if why:
        res["fail"] = "; ".join(why)
    return res


def calibrate(tile, scene, ratio, tr, crs, a):
    res = dict(tile=tile, scene=scene)
    emod = np.load(DATA / f"{scene}_emod.npy")
    deep = np.isfinite(ratio[::8, ::8]) & (emod < -50)
    if deep.sum() < 50:  # northern Adriatic (west Istria) is shallower than 50 m; on 33TVK 30 m gives ~ the same r_deep
        deep = np.isfinite(ratio[::8, ::8]) & (emod < -30)
    if deep.sum() < 50 or a.size == 0:
        res["fail"] = "no deep water or no ICESat-2 data"
        return res, None
    r_deep = float(np.nanpercentile(ratio[::8, ::8][deep], 10))
    u, dep, trk, n_false = is2_pixels(scene, ratio, tr, crs, a)
    rr, cc = np.divmod(u, ratio.shape[1])
    rat = ratio.ravel()[u]
    res.update(r_deep=r_deep, false_bottom_photons_removed=n_false, n_pixels=int(u.size), blocks=[])
    shallow = np.zeros(ratio.shape, bool)
    for by in range(0, ratio.shape[0], BLOCK_PX):
        for bx in range(0, ratio.shape[1], BLOCK_PX):
            sel = (rr >= by) & (rr < by + BLOCK_PX) & (cc >= bx) & (cc < bx + BLOCK_PX)
            win = ratio[by:by + BLOCK_PX, bx:bx + BLOCK_PX]
            if not np.isfinite(win).any():
                continue
            b = calibrate_block(rat[sel], dep[sel], trk[sel])
            b.update(row=by // BLOCK_PX, col=bx // BLOCK_PX)
            res["blocks"].append(b)
            if "fail" not in b:
                m = np.isfinite(win) & (win < r_deep) & (b["m1"] * win + b["m0"] < b["threshold_m"])
                # Sanity check against EMODnet: a good model marks (almost) nothing where the chart says > 20 m.
                # ICESat-2 CV cannot see this: its photons lie near shore (tile 33TVL passed CV but marked
                # 28 km2 of 30-60 m deep water west of Krk).
                e = emod[np.minimum(np.arange(by, by + win.shape[0]) // 8, emod.shape[0] - 1)[:, None],
                         np.minimum(np.arange(bx, bx + win.shape[1]) // 8, emod.shape[1] - 1)]
                deep_m = e < -EMOD_DEEP_M
                b["marked_where_emod_deep"] = float((m & deep_m).sum() / max(m.sum(), 1))
                if b["marked_where_emod_deep"] > GATE["max_emod_deep_share"]:
                    b["fail"] = f"{b['marked_where_emod_deep']:.0%} of marked area where EMODnet > {EMOD_DEEP_M:.0f} m"
                else:
                    shallow[by:by + BLOCK_PX, bx:bx + BLOCK_PX] = m & ~deep_m
    ok = [b for b in res["blocks"] if "fail" not in b]
    res.update(blocks_ok=len(ok), blocks_total=len(res["blocks"]), shallow_km2=float(shallow.sum() * 1e-4))
    if not ok:
        res["fail"] = "no block passed the quality gate"
        return res, None
    return res, shallow


# ---------------------------------------------------------------- web tiles
R = 6378137.0
def merc_tile_bounds(z, x, y):
    n = 2 ** z; size = 2 * math.pi * R / n
    x0 = -math.pi * R + x * size; y1 = math.pi * R - y * size
    return x0, y1 - size, x0 + size, y1


def add_to_tiles(store, shallow, tr, crs):
    """OR the shallow mask into z=Z_MAX 256x256 web-mercator tiles (max resampling = conservative)."""
    w, s, e, n = transform_bounds(crs, "EPSG:4326", *rasterio.transform.array_bounds(*shallow.shape, tr))
    def tx(lon): return int((lon + 180) / 360 * 2 ** Z_MAX)
    def ty(lat): return int((1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * 2 ** Z_MAX)
    src = shallow.astype("uint8")
    # skip web tiles with nothing under them: check a coarse occupancy grid first
    for x in range(tx(w), tx(e) + 1):
        for y in range(ty(n), ty(s) + 1):
            b = merc_tile_bounds(Z_MAX, x, y)
            bl = transform_bounds("EPSG:3857", crs, *b)
            r0, c0 = rowcol(tr, bl[0], bl[3]); r1, c1 = rowcol(tr, bl[2], bl[1])
            r0, c0 = max(r0, 0), max(c0, 0); r1, c1 = min(r1 + 1, src.shape[0]), min(c1 + 1, src.shape[1])
            if r0 >= r1 or c0 >= c1 or not src[r0:r1, c0:c1].any():
                continue
            dst = np.zeros((256, 256), "uint8")
            reproject(src, dst, src_transform=tr, src_crs=crs,
                      dst_transform=rasterio.transform.from_bounds(*b, 256, 256), dst_crs="EPSG:3857",
                      resampling=Resampling.max)
            if dst.any():
                store[(x, y)] = store.get((x, y), np.zeros((256, 256), bool)) | (dst > 0)


def write_tiles(store, meta):
    from PIL import Image
    import shutil
    if WEB_TILES.exists():
        shutil.rmtree(WEB_TILES)
    index, level = {}, store
    for z in range(Z_MAX, Z_MIN - 1, -1):
        for (x, y), m in level.items():
            d = WEB_TILES / str(z) / str(x); d.mkdir(parents=True, exist_ok=True)
            im = Image.fromarray(m.astype("uint8"), "P")
            im.putpalette([0, 0, 0, *ORANGE[:3]]); im.info["transparency"] = bytes([0, ORANGE[3]])
            im.save(d / f"{y}.png", optimize=True, transparency=bytes([0, ORANGE[3]]))
        xs = [k[0] for k in level]; ys = [k[1] for k in level]
        x0, y0, w, h = min(xs), min(ys), max(xs) - min(xs) + 1, max(ys) - min(ys) + 1
        bits = bytearray((w * h + 7) // 8)
        for x, y in level:
            k = (y - y0) * w + (x - x0); bits[k >> 3] |= 1 << (k & 7)
        index[z] = dict(x0=x0, y0=y0, w=w, h=h, bits=base64.b64encode(bytes(bits)).decode())
        parent = {}
        for (x, y), m in level.items():  # 2x2 max-pool to the next zoom out
            p = parent.setdefault((x // 2, y // 2), np.zeros((256, 256), bool))
            sub = m.reshape(128, 2, 128, 2).any(axis=(1, 3))
            p[(y % 2) * 128:(y % 2) * 128 + 128, (x % 2) * 128:(x % 2) * 128 + 128] |= sub
        level = parent
    (WEB_TILES / "index.json").write_text(json.dumps(dict(v=str(int(time.time())), zooms=index, meta=meta)))


def main(tiles):
    sea = eez()
    results, store = [], {}
    prev = HERE / "results_hr.json"
    old = {r["tile"]: r for r in json.loads(prev.read_text())["tiles"]} if prev.exists() else {}
    for tile in TILES:
        if tile not in tiles:
            if tile in old:
                results.append(old[tile])
            continue
        sc = choose_scene(tile, sea)
        if PREFETCH and sc:  # only download and cache (lets several tiles download in parallel)
            ratio, tr, crs = tile_ratio(tile, sc["id"], sea)
            if np.isfinite(ratio).any():
                bounds_ll = transform_bounds(crs, "EPSG:4326", *rasterio.transform.array_bounds(*ratio.shape, tr))
                icesat2(tile, bounds_ll, sea.intersection(box(*bounds_ll)))
            log(tile, "prefetched"); continue
        if not sc:
            results.append(dict(tile=tile, fail="no clear scene / no water in Croatian EEZ")); continue
        log(tile, "scene", sc["id"], "glint", round(sc["glint_nir"], 4))
        ratio, tr, crs = tile_ratio(tile, sc["id"], sea)
        if not np.isfinite(ratio).any():
            results.append(dict(tile=tile, scene=sc["id"], fail="no Croatian coastal water")); continue
        bounds_ll = transform_bounds(crs, "EPSG:4326", *rasterio.transform.array_bounds(*ratio.shape, tr))
        a = icesat2(tile, bounds_ll, sea.intersection(box(*bounds_ll)))
        res, shallow = calibrate(tile, sc["id"], ratio, tr, crs, a)
        res["scene_glint_nir"], res["scene_cloud"] = sc["glint_nir"], sc["cloud"]
        log(tile, json.dumps({k: v for k, v in res.items() if k != "blocks"}))
        if shallow is not None:
            np.save(DATA / f"{tile}_shallow.npy", np.packbits(shallow))
        results.append(res)
        del ratio
    if PREFETCH:
        return
    # web tiles from every tile that passed (also those processed in earlier runs)
    for res in results:
        f = DATA / f"{res['tile']}_shallow.npy"
        if "fail" in res or not f.exists():
            continue
        with rasterio.open(DATA / f"{res['scene']}_ratio.tif") as ds:
            tr, crs, shp = ds.transform, ds.crs, ds.shape
        shallow = np.unpackbits(np.load(f))[: shp[0] * shp[1]].reshape(shp).astype(bool)
        add_to_tiles(store, shallow, tr, crs)
        log(res["tile"], "web tiles so far", len(store))
    blocks = [b for r in results for b in r.get("blocks", []) if "fail" not in b]
    meta = dict(shallow_below_m=SHALLOW_M, tiles_with_layer=sum("fail" not in r for r in results), tiles_total=len(results),
                blocks_ok=len(blocks), blocks_total=sum(len(r.get("blocks", [])) for r in results),
                catch_min=round(min(b["catch"] for b in blocks), 2) if blocks else None,
                rmse_median=round(float(np.median([b["cv"]["rmse"] for b in blocks])), 1) if blocks else None)
    write_tiles(store, meta)
    prev.write_text(json.dumps(dict(meta=meta, gate=GATE, tiles=results), indent=1) + "\n")
    log("done", json.dumps(meta))


if __name__ == "__main__":
    PREFETCH = "--prefetch" in sys.argv
    main([a for a in sys.argv[1:] if a != "--prefetch"] or TILES)
