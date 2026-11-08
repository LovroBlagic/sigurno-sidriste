"""Satellite depth 0-15 m as coloured web tiles (experimental layer "Dubina sa satelita").

Same data and calibration as sdb_hr.py (Stumpf log-ratio from Sentinel-2, one linear model per
15 km block calibrated on ICESat-2 ATL24, blocks that fail the quality gate are left out), but
instead of a yes/no "shallower than 4 m" mask it draws the estimated depth in colour bands.

Shown only where: the block passed the gate, the pixel is optically shallow (ratio < r_deep),
the estimate is 0-15 m and EMODnet does not say deeper than 20 m. When tiles are scaled down
the SHALLOWEST depth wins (safer for a sailor).

Scene per tile: SCENE below overrides sdb_hr's lowest-glint choice where that scene is worse for depth.

Usage (from the repo root, same venv as sdb_hr.py):
    python research/sdb/sdb_depth_tiles.py --plavnik        # only around Plavnik (first check)
    python research/sdb/sdb_depth_tiles.py 33TVK 33TVL ...   # whole Sentinel-2 tiles
Output: web/tiles/sdbd/{z}/{x}/{y}.png + index.json (same index format as web/tiles/depth).
"""
import base64
import json
import math
import sys
import time
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import rowcol
from rasterio.warp import reproject, transform_bounds
from shapely.geometry import box

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sdb_hr as H  # noqa: E402

OUT = H.HERE.parents[1] / "web" / "tiles" / "sdbd"
PLAVNIK = (14.44, 44.92, 14.62, 45.02)  # lon/lat box: Plavnik with the facing Cres and Krk coasts
MAX_DEPTH = 15.0
Z_MAX, Z_MIN = 14, 9
# Depth bands (m) and colours: warm = shallow (watch out), cool = deeper. Index 0 = transparent.
BANDS = [2, 4, 6, 8, 10, 12, 15]
COLORS = [(215, 48, 31), (252, 141, 89), (254, 224, 139), (217, 239, 139), (145, 207, 96), (65, 182, 196), (34, 94, 168)]
ALPHA = 235
FALLBACK = (2, 99)  # larger calibration areas in 15 km cells: 30 km blocks, then the whole Sentinel-2 tile


# Scene per tile when the lowest-glint pick of sdb_hr.py is not the best for depth. On 33TVK the
# 2025-09-18 scene reads most bay interiors (Krušija, Mužan) as optically deep (model 20-35 m where
# EMODnet and the research map say 4-16 m); the 2026-09-16 scene resolves bottom to ~20 m there.
# The other entries were picked by sampling ~15 summer scenes (2022-2026, < 10 % cloud) only at ICESat-2 pixels
# and keeping the one with the most depth area after the full gate (sdb_hr's autumn/winter picks had r 0.0-0.4).
SCENE = {"33TVK": "S2B_33TVK_20260916_0_L2A",
         "33TXH": "S2B_33TXH_20230708_0_L2A",    # Split, Brač, Hvar: r 0.74 (current pick -0.03)
         "33TXJ": "S2B_33TXJ_20230909_0_L2A",    # Šibenik, Trogir: r 0.81 (0.06)
         "33TWJ": "S2B_33TWJ_20230909_0_L2A",    # Zadar: 185 km2 instead of 66
         "33TVL": "S2B_33TVL_20250812_1_L2A"}    # Rab, Senj: r 0.91 (0.41)


def depth_map(tile):
    """Calibrated SDB depth (m, NaN = not shown) on the tile's 10 m grid, using sdb_hr's cached data."""
    # The Marine Regions EEZ coastline is generalised: bay interiors (Krušija, Mužan on Plavnik) fall
    # outside it and were cut from the map. Buffer it ~2 km inland; land itself is masked by NIR.
    sea = H.eez().buffer(0.02)
    sc = {"id": SCENE[tile]} if tile in SCENE else H.choose_scene(tile, H.eez())
    ratio, tr, crs = H.tile_ratio(tile, sc["id"], sea, suffix="_bays")
    bounds_ll = transform_bounds(crs, "EPSG:4326", *rasterio.transform.array_bounds(*ratio.shape, tr))
    a = H.icesat2(tile, bounds_ll, sea.intersection(box(*bounds_ll)))
    res, _ = H.calibrate(tile, sc["id"], ratio, tr, crs, a)
    emod = np.load(H.DATA / f"{sc['id']}_emod.npy")
    B = H.BLOCK_PX
    models = {(b["row"], b["col"]): b for b in res.get("blocks", []) if "fail" not in b}
    n_own = len(models)
    # 15 km cells with too little ICESat-2 for their own model: borrow one fitted on a larger area
    # (FALLBACK), with the same gate and EMODnet check. Cells whose own data gave a bad model keep none.
    if "r_deep" in res:
        starved = {(b["row"], b["col"]) for b in res["blocks"] if b.get("fail", "").startswith("too little ICESat-2")}
        u, dep, trk, _ = H.is2_pixels(sc["id"], ratio, tr, crs, a)
        rr, cc = np.divmod(u, ratio.shape[1])
        rat = ratio.ravel()[u]
        for k in FALLBACK:
            K = k * B
            for by in range(0, ratio.shape[0], K):
                for bx in range(0, ratio.shape[1], K):
                    todo = [c for c in starved - models.keys() if by <= c[0] * B < by + K and bx <= c[1] * B < bx + K]
                    if not todo:
                        continue
                    sel = (rr >= by) & (rr < by + K) & (cc >= bx) & (cc < bx + K)
                    b = H.calibrate_block(rat[sel], dep[sel], trk[sel])
                    if "fail" in b:
                        continue
                    win = ratio[by:by + K, bx:bx + K]
                    m = np.isfinite(win) & (win < res["r_deep"]) & (b["m1"] * win + b["m0"] < b["threshold_m"])
                    if (m & (emod_on(emod, by, bx, win.shape) < -H.EMOD_DEEP_M)).sum() > H.GATE["max_emod_deep_share"] * max(m.sum(), 1):
                        continue
                    b["scale_km"] = round(min(K, max(ratio.shape)) / 100)
                    H.log(tile, f"{len(todo)} cells from a {b['scale_km']} km model: r {b['r_pearson']:.2f}, "
                                f"RMSE {b['cv']['rmse']:.1f} m, {b['n_pixels']} pixels / {b['n_tracks']} passes")
                    for c in todo:
                        models[c] = b
    depth = np.full(ratio.shape, np.nan, "f4")
    for (row, col), b in models.items():
        by, bx = row * B, col * B
        win = ratio[by:by + B, bx:bx + B]
        d = b["m1"] * win + b["m0"]
        e = emod_on(emod, by, bx, win.shape)
        ok = np.isfinite(win) & (win < res["r_deep"]) & (d <= MAX_DEPTH) & (e >= -H.EMOD_DEEP_M)
        depth[by:by + B, bx:bx + B] = np.where(ok, np.clip(d, 0.1, MAX_DEPTH), np.nan)
    ok_blocks = list({id(b): b for b in models.values()}.values())
    H.log(tile, f"{n_own} blocks pass, {len(models) - n_own} cells from larger areas, "
                f"{np.isfinite(depth).sum() * 1e-4:.1f} km2 with depth 0-{MAX_DEPTH:.0f} m")
    return depth, tr, crs, ok_blocks


def emod_on(emod, by, bx, shape):
    """EMODnet depth (stored at 1/8 resolution) for a window of the 10 m grid."""
    return emod[np.minimum(np.arange(by, by + shape[0]) // 8, emod.shape[0] - 1)[:, None],
                np.minimum(np.arange(bx, bx + shape[1]) // 8, emod.shape[1] - 1)]


def to_tiles(store, depth, tr, crs, clip_ll=None):
    """Min-resample depth into z=Z_MAX web-mercator tiles (shallowest wins); store[(x, y)] = float32 256x256."""
    w, s, e, n = clip_ll or transform_bounds(crs, "EPSG:4326", *rasterio.transform.array_bounds(*depth.shape, tr))
    def tx(lon): return int((lon + 180) / 360 * 2 ** Z_MAX)
    def ty(lat): return int((1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * 2 ** Z_MAX)
    src = np.where(np.isfinite(depth), depth, 0).astype("f4")  # 0 = nodata
    for x in range(tx(w), tx(e) + 1):
        for y in range(ty(n), ty(s) + 1):
            b = H.merc_tile_bounds(Z_MAX, x, y)
            bl = transform_bounds("EPSG:3857", crs, *b)
            r0, c0 = rowcol(tr, bl[0], bl[3]); r1, c1 = rowcol(tr, bl[2], bl[1])
            r0, c0 = max(r0, 0), max(c0, 0); r1, c1 = min(r1 + 1, src.shape[0]), min(c1 + 1, src.shape[1])
            if r0 >= r1 or c0 >= c1 or not src[r0:r1, c0:c1].any():
                continue
            dst = np.zeros((256, 256), "f4")
            reproject(src, dst, src_transform=tr, src_crs=crs, src_nodata=0,
                      dst_transform=rasterio.transform.from_bounds(*b, 256, 256), dst_crs="EPSG:3857", dst_nodata=0,
                      resampling=Resampling.min)
            if not dst.any():
                continue
            old = store.get((x, y))
            store[(x, y)] = dst if old is None else np.where((old > 0) & ((dst == 0) | (old < dst)), old, dst)


def band_index(d):
    """0 = nothing, 1..len(BANDS) = colour band."""
    idx = np.searchsorted(BANDS, d, side="right") + 1
    return np.where(d > 0, np.minimum(idx, len(BANDS)), 0).astype("uint8")


def write(store, meta):
    from PIL import Image
    import shutil
    if OUT.exists():
        shutil.rmtree(OUT)
    pal = [0, 0, 0] + [c for rgb in COLORS for c in rgb]
    trans = bytes([0] + [ALPHA] * len(COLORS))
    index, level = {}, store
    for z in range(Z_MAX, Z_MIN - 1, -1):
        for (x, y), d in level.items():
            p = OUT / str(z) / str(x); p.mkdir(parents=True, exist_ok=True)
            im = Image.fromarray(band_index(d), "P"); im.putpalette(pal)
            im.save(p / f"{y}.png", optimize=True, transparency=trans)
        xs = [k[0] for k in level]; ys = [k[1] for k in level]
        x0, y0, w, h = min(xs), min(ys), max(xs) - min(xs) + 1, max(ys) - min(ys) + 1
        bits = bytearray((w * h + 7) // 8)
        for x, y in level:
            k = (y - y0) * w + (x - x0); bits[k >> 3] |= 1 << (k & 7)
        index[z] = dict(x0=x0, y0=y0, w=w, h=h, bits=base64.b64encode(bytes(bits)).decode())
        parent = {}
        for (x, y), d in level.items():  # 2x2 to the next zoom out, shallowest non-empty wins
            q = np.where(d > 0, d, np.inf).reshape(128, 2, 128, 2).min(axis=(1, 3))
            q = np.where(np.isfinite(q), q, 0)
            p = parent.setdefault((x // 2, y // 2), np.zeros((256, 256), "f4"))
            sl = np.s_[(y % 2) * 128:(y % 2) * 128 + 128, (x % 2) * 128:(x % 2) * 128 + 128]
            p[sl] = q
        level = parent
    (OUT / "index.json").write_text(json.dumps(dict(v=str(int(time.time())), zooms=index, meta=meta)))


def main(args):
    plavnik = "--plavnik" in args
    tiles = [a for a in args if not a.startswith("--")] or (["33TVK"] if plavnik else H.TILES)
    store, blocks = {}, []
    for tile in tiles:
        depth, tr, crs, ok = depth_map(tile)
        if not ok:
            continue
        blocks += ok
        to_tiles(store, depth, tr, crs, PLAVNIK if plavnik else None)
        H.log(tile, "web tiles so far", len(store))
    if not store:
        sys.exit("no depth to draw")
    meta = dict(area="Plavnik" if plavnik else "dio obale", max_depth_m=MAX_DEPTH, bands_m=BANDS,
                colors=["#%02x%02x%02x" % c for c in COLORS], blocks=len(blocks),
                rmse_median=round(float(np.median([b["cv"]["rmse"] for b in blocks])), 1))
    write(store, meta)
    H.log("done", json.dumps(meta), sum(1 for _ in OUT.rglob("*.png")), "png")


if __name__ == "__main__":
    main(sys.argv[1:])
