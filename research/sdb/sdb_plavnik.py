"""Satellite-derived bathymetry (SDB) prototype for Plavnik (Cres-Krk).

Stumpf et al. (2003) log-ratio: ratio = ln(n*B02) / ln(n*B03), depth = m1*ratio + m0,
calibrated (a) on EMODnet cells that come from a real echo-sounder survey and
(b) on ICESat-2 ATL24 laser bathymetry photons, validated by leaving whole ICESat-2 passes out.

Usage (from the repo root):
    python3 -m venv .venv-sdb && .venv-sdb/bin/pip install numpy rasterio matplotlib sliderule
    .venv-sdb/bin/python research/sdb/sdb_plavnik.py [SCENE_ID ...]

Downloads (cached in research/sdb/data/, not committed):
  * Sentinel-2 L2A B02/B03/B08 window from the public Element84 Earth Search STAC
    (AWS sentinel-cogs bucket, no login).
  * EMODnet Bathymetry DTM 2024 depth grid (WCS) and the source of each 0-20 m cell (REST).
  * ICESat-2 ATL24 bathymetry photons via the public SlideRule Earth service (no login).
Writes research/sdb/results.json, research/sdb/sdb_plavnik.png and the experimental web layer
web/data/sdb_plavnik_plicak.{png,json}.
"""
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
os.environ.setdefault("AWS_NO_SIGN_REQUEST", "YES")

import numpy as np
import rasterio
from rasterio.transform import rowcol, xy
from rasterio.warp import transform, transform_bounds
from rasterio.windows import from_bounds

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
BBOX = (14.42, 44.91, 14.62, 45.03)  # lon/lat: Plavnik with the facing Cres and Krk coasts
SCENES = ["S2B_33TVK_20260916_0_L2A", "S2A_33TVK_20250918_1_L2A"]  # lowest NIR glint of the clear scenes screened
STAC = "https://earth-search.aws.element84.com/v1/collections/sentinel-2-l2a/items/"
WCS = ("https://ows.emodnet-bathymetry.eu/wcs?service=WCS&version=2.0.1&request=GetCoverage"
       "&coverageId=emodnet__mean&format=image/tiff"
       f"&subset=Lat({BBOX[1]},{BBOX[3]})&subset=Long({BBOX[0]},{BBOX[2]})")
# Only this source is an echo-sounder survey (Croatian Hydrographic Institute, multibeam +
# singlebeam 1951-2017, 225 m DTM, LAT). 'croatia2003' is EOMAP's own Sentinel-2 SDB, so
# calibrating on it would be circular; GEBCO2024 is a global interpolation.
SURVEYED = {"Pula_Rijeka_Cres_Dubrovnik"}
N = 1000.0          # Stumpf constant (keeps both logs positive for reflectance 0.001-0.1)
NIR_LAND = 0.02     # B08 reflectance above this = land / emergent rock
MIN_WATER_FRAC = 0.9  # an EMODnet cell is used only if >=90 % of its 10 m pixels are water
DEPTH_MAX = 20.0
WEB_SHALLOW_M = 6.0   # web layer marks SDB < 6 m: "shallower than ~5 m" plus about one RMSE of margin
MAP_MAX = 15.0        # the map stops here: only ~7 % of ICESat-2 calibration pixels are deeper than 10 m
IS2_MIN_CONF = 0.9    # ATL24 photon confidence; lower values let many false 'bottom' returns in
IS2_MIN_PHOTONS = 3   # photons needed in a 10 m pixel before its median depth is used
FALSE_BOTTOM_M = 30.0  # HHI survey deeper than this => an ICESat-2 'bottom' photon there is false
N_FOLDS = 5           # cross-validation folds, grouped by ICESat-2 pass (date + beam)


def fetch(url, path):
    if not path.exists():
        DATA.mkdir(exist_ok=True)
        urllib.request.urlretrieve(url, path)
    return path


def load_s2(scene):
    out = DATA / f"{scene}.tif"
    if not out.exists():
        item = json.load(urllib.request.urlopen(STAC + scene))
        # Earth Search sets earthsearch:boa_offset_applied=True: DN*1e-4 is already reflectance,
        # the -0.1 'offset' in raster:bands must NOT be applied again (it gives negative water).
        assert item["properties"].get("earthsearch:boa_offset_applied") is True
        bands, prof = [], None
        for key in ("blue", "green", "nir"):
            with rasterio.open(item["assets"][key]["href"]) as ds:
                win = from_bounds(*transform_bounds("EPSG:4326", ds.crs, *BBOX), ds.transform).round_offsets().round_lengths()
                bands.append(ds.read(1, window=win))
                if prof is None:
                    prof = dict(driver="GTiff", dtype="uint16", count=3, crs=ds.crs,
                                transform=ds.window_transform(win), height=bands[0].shape[0], width=bands[0].shape[1])
        DATA.mkdir(exist_ok=True)
        with rasterio.open(out, "w", **prof) as dst:
            dst.write(np.stack(bands))
    with rasterio.open(out) as ds:
        b, g, n = (ds.read(i).astype("f4") * 1e-4 for i in (1, 2, 3))
        return b, g, n, ds.transform, ds.crs


def load_icesat2():
    """ATL24 bathymetry photons (class 40) in BBOX: lon, lat, depth below the sea surface [m]."""
    out = DATA / "icesat2_atl24.csv"
    if not out.exists():
        from sliderule import sliderule  # only needed for the first download
        sliderule.init()
        x0, y0, x1, y1 = BBOX
        aoi = [dict(lon=x0, lat=y0), dict(lon=x1, lat=y0), dict(lon=x1, lat=y1), dict(lon=x0, lat=y1), dict(lon=x0, lat=y0)]
        gdf = sliderule.run("atl24x", {}, aoi=aoi)
        gdf = gdf[gdf["class_ph"] == 40]
        df = dict(lon=gdf.geometry.x.values, lat=gdf.geometry.y.values,
                  depth=(gdf["surface_h"] - gdf["ortho_h"]).values,  # ATL24 heights are refraction-corrected
                  confidence=gdf["confidence"].values,
                  track=[f"{t.date()}_gt{gt}" for t, gt in zip(gdf.index, gdf["gt"])])
        DATA.mkdir(exist_ok=True)
        with open(out, "w") as f:
            f.write("lon,lat,depth,confidence,track\n")
            for row in zip(*df.values()):
                f.write("%.7f,%.7f,%.3f,%.4f,%s\n" % row)
    a = np.genfromtxt(out, delimiter=",", names=True, dtype=None, encoding="utf-8")
    return a[np.isfinite(a["depth"])]


def icesat2_photons(ref):
    """Confident ATL24 photons, minus false bottoms: photons in an EMODnet cell that the HHI
    echo-sounder survey puts deeper than FALSE_BOTTOM_M (ATL24 does return isolated 'bottoms'
    at 8-16 m over 40-80 m deep water). Also returns the EMODnet cell of every photon."""
    a = load_icesat2()
    a = a[(a["confidence"] >= IS2_MIN_CONF) & (a["depth"] > 0)]
    r, c = (np.asarray(v) for v in rowcol(ref["transform"], a["lon"], a["lat"]))
    inb = (r >= 0) & (r < ref["shape"][0]) & (c >= 0) & (c < ref["shape"][1])
    a, cell = a[inb], (r * ref["shape"][1] + c)[inb]
    tag_sources(ref, np.unique(cell))
    false = np.isin(ref["src"][cell], list(SURVEYED)) & (ref["depth"][cell] > FALSE_BOTTOM_M)
    return a[~false], cell[~false], int(false.sum()), int(np.unique(cell[false]).size)


def icesat2_pixels(a, ratio, tr, crs):
    """Median ICESat-2 depth per 10 m Sentinel-2 pixel (>= IS2_MIN_PHOTONS photons)."""
    x, y = transform("EPSG:4326", crs, a["lon"], a["lat"])
    r, c = (np.asarray(v) for v in rowcol(tr, x, y))
    ok = (r >= 0) & (r < ratio.shape[0]) & (c >= 0) & (c < ratio.shape[1])
    pix, dep, trk = r[ok] * ratio.shape[1] + c[ok], a["depth"][ok], a["track"][ok]
    u, inv, cnt = np.unique(pix, return_inverse=True, return_counts=True)
    med = np.array([np.median(dep[inv == k]) for k in range(u.size)])
    first = np.array([trk[inv == k][0] for k in range(u.size)])
    keep = (cnt >= IS2_MIN_PHOTONS) & np.isfinite(ratio.ravel()[u])
    return dict(pix=u[keep], depth=med[keep], track=first[keep], ratio=ratio.ravel()[u[keep]],
                n_photons=int(dep.size), n_tracks=int(np.unique(first[keep]).size))


def icesat2_experiment(ref, ratio, tr, crs, r_deep):
    a, _, n_false, n_false_cells = icesat2_photons(ref)
    p = icesat2_pixels(a, ratio, tr, crs)
    tracks = np.unique(p["track"])
    fold_of = dict(zip(np.random.default_rng(0).permutation(tracks), np.arange(tracks.size) % N_FOLDS))
    fold = np.array([fold_of[t] for t in p["track"]])
    oof = np.full(p["depth"].size, np.nan)
    for k in range(N_FOLDS):
        m1, m0 = fit(p["ratio"][fold != k], p["depth"][fold != k])
        oof[fold == k] = m1 * p["ratio"][fold == k] + m0
    m1, m0 = fit(p["ratio"], p["depth"])
    res = dict(false_bottom_photons_removed=n_false, false_bottom_cells=n_false_cells, n_photons_used=p["n_photons"], n_pixels=int(p["depth"].size), n_tracks=p["n_tracks"],
               depth_p10_p50_p90=np.percentile(p["depth"], [10, 50, 90]).round(1).tolist(),
               r_pearson=float(np.corrcoef(p["ratio"], p["depth"])[0, 1]),
               cv_by_track=stats(oof, p["depth"]),
               cv_by_depth={f"{lo}-{hi} m": stats(oof[sel], p["depth"][sel])
                            for lo, hi in ((0, 5), (5, 10), (10, 15), (15, 25))
                            if (sel := (p["depth"] > lo) & (p["depth"] <= hi)).sum() >= 5},
               # the dangerous error for anchoring: SDB says deeper than it is
               n_sdb_deeper_by_2m=int((oof - p["depth"] > 2).sum()),
               n_sdb_deeper_by_5m=int((oof - p["depth"] > 5).sum()),
               model_all=dict(m1=float(m1), m0=float(m0)),
               max_resolvable_depth_m=float(m1 * r_deep + m0))
    return res, (m1, m0), dict(pix=p["pix"], depth=p["depth"], oof=oof)


def icesat2_vs_emodnet(ref):
    """How far each EMODnet source is from ICESat-2 (cell medians, confident photons, 0-20 m)."""
    a, cell, _, _ = icesat2_photons(ref)
    dep = a["depth"]
    out = {}
    cells = np.unique(cell)
    is2 = np.array([np.median(dep[cell == k]) for k in cells])
    # select on the ICESat-2 depth, not on EMODnet's, so cells EMODnet puts too deep are included
    sel = (is2 <= DEPTH_MAX) & (ref["depth"][cells] > 0)
    for s in set(ref["src"][cells[sel]]):
        m = sel & (ref["src"][cells] == s)
        if m.sum() >= 5:
            out[s or "(none)"] = stats(ref["depth"][cells[m]], is2[m])  # error = EMODnet - ICESat-2
    return out


def stumpf_ratio(b, g, nir):
    water = (nir < NIR_LAND) & (b > 0) & (g > 0)
    # drop the first water pixel next to land (mixed pixels, adjacency effect)
    land = ~water
    near = land.copy()
    near[1:] |= land[:-1]; near[:-1] |= land[1:]; near[:, 1:] |= land[:, :-1]; near[:, :-1] |= land[:, 1:]
    water &= ~near
    with np.errstate(invalid="ignore", divide="ignore"):
        r = np.log(N * b) / np.log(N * g)
    r[~water] = np.nan
    # 5x5 (50 m) median against sensor noise, striping and small waves; land stays NaN.
    win = np.lib.stride_tricks.sliding_window_view(np.pad(r, 2, constant_values=np.nan), (5, 5))
    with np.errstate(all="ignore"):
        import warnings
        warnings.simplefilter("ignore", RuntimeWarning)
        r = np.where(water, np.nanmedian(win.reshape(*r.shape, 25), axis=-1), np.nan)
    return r, water


def rest_source(lon, lat):
    """Source identifier of one EMODnet DTM cell, via the REST API (sequential, polite, retried)."""
    url = f"https://rest.emodnet-bathymetry.eu/depth_sample?geom=POINT({lon:.6f}%20{lat:.6f})"
    for attempt in range(6):
        try:
            r = json.load(urllib.request.urlopen(url, timeout=30))
            return (r.get("reference") or {}).get("identifier") or ""
        except Exception:
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(url)


def emodnet_reference():
    """EMODnet DTM 2024 depth grid (WCS) plus the source of every 0-20 m cell (REST, cached).

    The WFS source_references polygons overlap and disagreed with the REST answer in a
    60-cell spot check, so the per-cell REST 'reference.identifier' is used instead.
    """
    tif = fetch(WCS, DATA / "emodnet_mean.tif")
    with rasterio.open(tif) as ds:
        elev, tr = ds.read(1), ds.transform
    rows, cols = np.indices(elev.shape)
    lon, lat = (np.asarray(v) for v in xy(tr, rows.ravel(), cols.ravel()))
    depth = -elev.ravel()
    ref = dict(lon=lon, lat=lat, depth=depth, src=np.full(depth.size, "", dtype=object), transform=tr, shape=elev.shape)
    tag_sources(ref, np.flatnonzero((depth > 0) & (depth <= DEPTH_MAX)))
    return ref


def tag_sources(ref, cells):
    """Fill ref['src'] for the given cell indices from the REST API, cached on disk."""
    cache_path = DATA / "emodnet_sources_rest.json"
    cache = json.loads(cache_path.read_text()) if cache_path.exists() else {}
    for k, i in enumerate(cells):
        key = f"{ref['lon'][i]:.6f},{ref['lat'][i]:.6f}"
        if key not in cache:
            cache[key] = rest_source(ref["lon"][i], ref["lat"][i])
            time.sleep(0.15)
            if k % 200 == 0:
                cache_path.write_text(json.dumps(cache))
                print(f"EMODnet REST {k}/{len(cells)}", file=sys.stderr, flush=True)
        ref["src"][i] = cache[key]
    cache_path.write_text(json.dumps(cache))


def cell_ratios(ref, ratio, water, s2_tr, s2_crs):
    """Median Stumpf ratio of the S2 pixels inside every EMODnet cell (cells are ~115 x 80 m)."""
    rows, cols = np.indices(ratio.shape)
    x, y = xy(s2_tr, rows.ravel(), cols.ravel())
    lon, lat = transform(s2_crs, "EPSG:4326", x, y)
    r, c = rowcol(ref["transform"], lon, lat)
    cell = np.asarray(r) * ref["shape"][1] + np.asarray(c)
    ok = (np.asarray(r) >= 0) & (np.asarray(r) < ref["shape"][0]) & (np.asarray(c) >= 0) & (np.asarray(c) < ref["shape"][1])
    cell, wat, rat = cell[ok], water.ravel()[ok], ratio.ravel()[ok]
    n_all = np.bincount(cell, minlength=ref["depth"].size)
    n_wat = np.bincount(cell, weights=wat, minlength=ref["depth"].size)
    med = np.full(ref["depth"].size, np.nan)
    order = np.argsort(cell[wat]); cw, rw = cell[wat][order], rat[wat][order]
    starts = np.r_[0, np.flatnonzero(np.diff(cw)) + 1]
    for s, e in zip(starts, np.r_[starts[1:], len(cw)]):
        med[cw[s]] = np.median(rw[s:e])
    frac = np.divide(n_wat, n_all, out=np.zeros_like(n_wat), where=n_all > 0)
    return med, frac


def fit(r, d):
    m1, m0 = np.polyfit(r, d, 1)
    return m1, m0


def stats(pred, obs):
    e = pred - obs
    return dict(n=int(e.size), rmse=float(np.sqrt(np.mean(e ** 2))), bias=float(np.mean(e)),
                mae=float(np.mean(np.abs(e))), p95_abs=float(np.percentile(np.abs(e), 95)), r2=float(1 - np.sum(e ** 2) / np.sum((obs - obs.mean()) ** 2)))


def run(scene, ref):
    b, g, nir, tr, crs = load_s2(scene)
    ratio, water = stumpf_ratio(b, g, nir)
    med, frac = cell_ratios(ref, ratio, water, tr, crs)
    base = (frac >= MIN_WATER_FRAC) & np.isfinite(med) & (ref["depth"] > 0) & (ref["depth"] <= DEPTH_MAX)
    sel = base & np.isin(ref["src"], list(SURVEYED))
    idx = np.flatnonzero(sel)
    res = dict(scene=scene, n_surveyed_0_20=int(idx.size),
               n_by_source_0_20={s: int((base & (ref["src"] == s)).sum()) for s in set(ref["src"][base])})
    if idx.size < 10:
        res["verdict"] = "too few surveyed points to calibrate"
        return res, ratio, water, tr, crs, None
    d, r = ref["depth"][idx], med[idx]
    # Hold-out 1: random 30 %. Hold-out 2: spatial, west vs east of the median longitude
    # (neighbouring 115 m cells are correlated, so the random split is optimistic).
    rng = np.random.default_rng(0)
    test = np.zeros(idx.size, bool); test[rng.choice(idx.size, max(3, idx.size * 3 // 10), replace=False)] = True
    m1, m0 = fit(r[~test], d[~test])
    res["random_holdout"] = stats(m1 * r[test] + m0, d[test])
    lon = ref["lon"][idx]; east = lon > np.median(lon)
    sp = []
    for tr_mask in (east, ~east):
        a1, a0 = fit(r[~tr_mask], d[~tr_mask])
        sp.append(stats(a1 * r[tr_mask] + a0, d[tr_mask]))
    res["spatial_holdout_west_east"] = sp
    m1, m0 = fit(r, d)
    res["model_all"] = dict(m1=float(m1), m0=float(m0), r_pearson=float(np.corrcoef(r, d)[0, 1]),
                            in_sample=stats(m1 * r + m0, d))
    res["survey_depth_p0_p10_p50_p90_p100"] = np.percentile(d, [0, 10, 50, 90, 100]).round(1).tolist()
    # Experiment B: calibrate on EOMAP's Sentinel-2 SDB ('croatia2003', NOT a survey) and test the
    # result on the independent HHI survey cells. Shows whether the ratio has usable shape at all.
    eo = np.flatnonzero(base & (ref["src"] == "croatia2003"))
    b1, b0 = fit(med[eo], ref["depth"][eo])
    res["eomap_calibrated"] = dict(m1=float(b1), m0=float(b0), n_calib=int(eo.size),
                                   r_pearson_ratio_vs_eomap=float(np.corrcoef(med[eo], ref["depth"][eo])[0, 1]),
                                   vs_hhi_survey=stats(b1 * r + b0, d))
    # Optically deep limit: ratio of cells that are certainly deep (EMODnet > 50 m, any source).
    # Pixels with a ratio at or above the 10th percentile of that are indistinguishable from deep water.
    deep = (frac >= MIN_WATER_FRAC) & np.isfinite(med) & (ref["depth"] > 50)
    r_deep = float(np.percentile(med[deep], 10))
    res["deep_water_ratio_p10_p50"] = [r_deep, float(np.median(med[deep]))]
    res["max_resolvable_depth_m"] = dict(eomap_model=float(b1 * r_deep + b0))
    res["hhi_cells_beyond_optical_limit"] = int((r >= r_deep).sum())
    res["icesat2"], is2_model, is2_pts = icesat2_experiment(ref, ratio, tr, crs, r_deep)
    res["calib_points"] = dict(lon=lon.tolist(), lat=ref["lat"][idx].tolist(), depth=d.tolist(), ratio=r.tolist(),
                               test=test.tolist())
    return res, ratio, water, tr, crs, dict(survey=(m1, m0), eomap=(b1, b0), icesat2=is2_model, is2_pts=is2_pts, r_deep=r_deep)


def plot(res, ratio, water, tr, crs, models, out):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.colors import ListedColormap

    fig, (ax, ax2) = plt.subplots(1, 2, figsize=(14, 6.6), gridspec_kw=dict(width_ratios=[1.6, 1]))
    h, w = ratio.shape
    ext = (tr.c, tr.c + tr.a * w, tr.f + tr.e * h, tr.f)
    ax.set_facecolor("#e8eef2")
    ax.imshow(np.where(water, np.nan, 1.0), extent=ext, cmap=ListedColormap(["#c9c2b0"]), interpolation="nearest")
    # Map: calibrated on ICESat-2 (the only reference with real shallow depths here).
    m1, m0 = models["icesat2"]
    depth = m1 * ratio + m0
    depth[(depth < 0) | (depth > MAP_MAX) | (ratio >= models["r_deep"])] = np.nan
    im = ax.imshow(depth, extent=ext, cmap="viridis_r", vmin=0, vmax=MAP_MAX, interpolation="nearest")
    fig.colorbar(im, ax=ax, shrink=0.8, label=f"SDB depth [m]; blank = deeper than {MAP_MAX:.0f} m or can't tell")
    pts = models["is2_pts"]
    rr, cc = np.divmod(pts["pix"], w)
    ax.scatter(tr.c + (cc + 0.5) * tr.a, tr.f + (rr + 0.5) * tr.e, s=1.5, c="k", lw=0, label="ICESat-2 ATL24 pixels")
    cp = res["calib_points"]
    x, y = transform("EPSG:4326", crs, cp["lon"], cp["lat"])
    ax.scatter(x, y, s=12, facecolors="none", edgecolors="red", lw=0.8, label="HHI survey cells 0-20 m (EMODnet)")
    ax.legend(loc="lower left", fontsize=8, markerscale=3)
    (x0, x1), (y0, y1) = transform("EPSG:4326", crs, [14.465, 14.585], [44.935, 45.0])
    ax.set(xlim=(x0, x1), ylim=(y0, y1), xticks=[], yticks=[])
    ax.set_title(f"Plavnik, Sentinel-2 {res['scene'][10:18]}, Stumpf log-ratio calibrated on ICESat-2\n"
                 "RESEARCH ONLY - NOT FOR NAVIGATION", fontsize=10)

    ax2.scatter(pts["depth"], pts["oof"], s=8, c="tab:blue", alpha=0.5, lw=0, label="ICESat-2 pixels, pass held out")
    d, r = np.array(cp["depth"]), np.array(cp["ratio"])
    s1, s0 = models["survey"]
    t = np.array(cp["test"])
    ax2.scatter(d[t], s1 * r[t] + s0, s=22, marker="x", c="red", label="HHI-calibrated, held out")
    ax2.plot([0, DEPTH_MAX], [0, DEPTH_MAX], "k--", lw=0.8)
    ax2.set(xlim=(0, DEPTH_MAX + 1), ylim=(-2, 25), xlabel="reference depth [m]", ylabel="SDB depth [m]")
    cv = res["icesat2"]["cv_by_track"]
    band = res["icesat2"]["cv_by_depth"]
    lines = ", ".join(f"{k}: {v['rmse']:.1f}" for k, v in band.items())
    ax2.set_title(f"ICESat-2, {N_FOLDS}-fold CV by pass: RMSE {cv['rmse']:.1f} m, bias {cv['bias']:+.1f} m, "
                  f"R2 {cv['r2']:.2f} (n={cv['n']})\nRMSE by depth [m]: {lines}", fontsize=9)
    ax2.legend(fontsize=8, loc="upper left")
    fig.tight_layout()
    fig.savefig(out, dpi=120)


def export_web_layer(res, ratio, tr, crs, models):
    """Transparent PNG in Web Mercator (for Leaflet L.imageOverlay) marking where SDB < WEB_SHALLOW_M,
    plus a JSON with its lat/lon bounds and the accuracy numbers shown in the app."""
    from rasterio.warp import reproject, Resampling, calculate_default_transform
    import matplotlib.pyplot as plt

    m1, m0 = models["icesat2"]
    shallow = (np.isfinite(ratio) & (ratio < models["r_deep"]) & (m1 * ratio + m0 < WEB_SHALLOW_M)).astype("uint8")
    h, w = ratio.shape
    dst_tr, dw, dh = calculate_default_transform(crs, "EPSG:3857", w, h, *rasterio.transform.array_bounds(h, w, tr))
    dst = np.zeros((dh, dw), "uint8")
    reproject(shallow, dst, src_transform=tr, src_crs=crs, dst_transform=dst_tr, dst_crs="EPSG:3857",
              resampling=Resampling.nearest)
    rgba = np.zeros((dh, dw, 4), "uint8")
    rgba[dst == 1] = (230, 81, 0, 200)
    web = HERE.parents[1] / "web" / "data"
    plt.imsave(web / "sdb_plavnik_plicak.png", rgba)
    (x0, x1), (y0, y1) = transform("EPSG:3857", "EPSG:4326",
                                   [dst_tr.c, dst_tr.c + dst_tr.a * dw], [dst_tr.f + dst_tr.e * dh, dst_tr.f])
    cv = res["icesat2"]["cv_by_track"]
    meta = dict(bounds=[[y0, x0], [y1, x1]], scene=res["scene"], shallow_below_m=WEB_SHALLOW_M,
                rmse_m=round(cv["rmse"], 1), source="research/sdb/README.md")
    (web / "sdb_plavnik_plicak.json").write_text(json.dumps(meta, indent=1) + "\n")


def main(scenes):
    ref = emodnet_reference()
    allres = []
    for i, scene in enumerate(scenes):
        res, ratio, water, tr, crs, models = run(scene, ref)
        if i == 0 and models:
            plot(res, ratio, water, tr, crs, models, HERE / "sdb_plavnik.png")
            export_web_layer(res, ratio, tr, crs, models)
        res.pop("calib_points", None)
        allres.append(res)
        print(json.dumps(res, indent=1))
    out = dict(scenes=allres, icesat2_vs_emodnet_error_m=icesat2_vs_emodnet(ref))
    print(json.dumps(out["icesat2_vs_emodnet_error_m"], indent=1))
    (HERE / "results.json").write_text(json.dumps(out, indent=1) + "\n")


if __name__ == "__main__":
    main(sys.argv[1:] or SCENES)
