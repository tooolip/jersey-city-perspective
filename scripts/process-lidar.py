"""Derives terrain, trees and roof shapes from the LiDAR grids made by fetch-lidar.py.

  data/derived/dtm.f32 + dtm.json   ground elevation (m, NAVD88) on a 1 m grid, gaps under
                                    buildings filled
  data/derived/trees.json           [east, north, ground z, height, crown radius] per tree.
                                    Trees are local canopy-height peaks where the laser passed through
                                    foliage (multiple returns), kept only if the 2023 NAIP photo still
                                    shows vegetation there (NDVI)
  data/derived/roofs.json           per Overture building id: roof levels split into extruded parts
                                    (setbacks, towers on podiums, rooftop bulkheads), heights above ground

Usage: .venv/bin/python -I scripts/process-lidar.py
"""
import json
import math
import os

import numpy as np
from rasterio import features
from rasterio.transform import Affine
from scipy import ndimage
from scipy.spatial import cKDTree
from shapely.geometry import Polygon, shape
from shapely.validation import make_valid

RAW = "data/raw/lidar"
OUT = "data/derived"
ORIGIN = (40.724, -74.042)
M_LAT = 111132.954 - 559.822 * math.cos(2 * ORIGIN[0] * math.pi / 180)
M_LON = 111412.84 * math.cos(ORIGIN[0] * math.pi / 180)

meta = json.load(open(f"{RAW}/meta.json"))
E0, N1 = meta["e0"], meta["n1"]
W1, H1, W5, H5 = meta["w1"], meta["h1"], meta["w5"], meta["h5"]
os.makedirs(OUT, exist_ok=True)

# ------------------------------------------------------------------ terrain
gs, gn = np.load(f"{RAW}/ground_sum.npy"), np.load(f"{RAW}/ground_n.npy")
ground = np.where(gn > 0, gs / np.maximum(gn, 1), np.nan)
holes = np.isnan(ground)
idx = ndimage.distance_transform_edt(holes, return_distances=False, return_indices=True)
dtm = ndimage.gaussian_filter(ground[tuple(idx)], 1.5).astype(np.float32)
dtm.tofile(f"{OUT}/dtm.f32")
json.dump({"e0": E0, "n1": N1, "w": W1, "h": H1, "res": 1.0, "dataset": meta["dataset"],
           "measured": round(float(1 - holes.mean()), 3)}, open(f"{OUT}/dtm.json", "w"))
print(f"terrain {W1}x{H1} @1m, {100 * (1 - holes.mean()):.0f}% measured, z {np.percentile(dtm, 1):.1f}..{np.percentile(dtm, 99):.1f} m")

# ------------------------------------------------------------------ height above ground
dsm = np.load(f"{RAW}/dsm.npy")
dtm05 = np.repeat(np.repeat(dtm, 2, 0), 2, 1)[:H5, :W5]
ndsm = np.where(np.isfinite(dsm), dsm - dtm05, 0).astype(np.float32)
ndsm = np.clip(ndsm, 0, 600)
pad = np.zeros((H1 * 2, W1 * 2), np.float32)
pad[: min(H5, H1 * 2), : min(W5, W1 * 2)] = ndsm[: H1 * 2, : W1 * 2]
ndsm1 = pad.reshape(H1, 2, W1, 2).max(axis=(1, 3))
# Lowest top surface per 1 m cell (absolute z): the deck of structures that the ground filter
# rejects, like the Sixth Street Embankment.
low = np.full((H1 * 2, W1 * 2), np.inf, np.float32)
low[: min(H5, H1 * 2), : min(W5, W1 * 2)] = np.where(np.isfinite(dsm), dsm, np.inf)[: H1 * 2, : W1 * 2]
low = low.reshape(H1, 2, W1, 2).min(axis=(1, 3))
np.where(np.isfinite(low), low, dtm).astype(np.float32).tofile(f"{OUT}/surface_low.f32")

# ------------------------------------------------------------------ building footprints
proj = lambda lon, lat: ((lon - ORIGIN[1]) * M_LON, (lat - ORIGIN[0]) * M_LAT)
blds = json.load(open("data/raw/overture_buildings_jc.geojson"))["features"]
footprints = []
for f in blds:
    if f["properties"].get("is_underground"):
        continue
    g = f["geometry"]
    polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
    for poly in polys:
        rings = [[proj(*c) for c in ring] for ring in poly]
        if len(rings[0]) < 4:
            continue
        footprints.append((f["properties"]["id"], Polygon(rings[0], rings[1:]), f["properties"].get("height")))

px1 = Affine(1.0, 0, E0, 0, -1.0, N1)  # local meters -> 1 m grid
bmask1 = features.rasterize(((p, 1) for _, p, _ in footprints), out_shape=(H1, W1), transform=px1, dtype=np.uint8).astype(bool)
bmask1 = ndimage.binary_dilation(bmask1, iterations=1)

# ------------------------------------------------------------------ vegetation (NDVI 2023)
nm = json.load(open("data/raw/naip.json"))
rgb = np.fromfile("data/raw/naip.rgb", np.uint8).reshape(nm["height"], nm["width"], 3)
nir = np.fromfile("data/raw/naip.nir", np.uint8).reshape(nm["height"], nm["width"])
red = rgb[:, :, 0].astype(np.float32)
ndvi_img = (nir.astype(np.float32) - red) / (nir.astype(np.float32) + red + 1e-3)
ndvi_img = ndimage.uniform_filter(ndvi_img, 5)  # ~1.5 m smoothing
cols = np.arange(W1) + 0.5
rows = np.arange(H1) + 0.5
lon = ORIGIN[1] + (E0 + cols) / M_LON
lat = ORIGIN[0] + (N1 - rows) / M_LAT
x0, y0, x1, y1 = nm["bbox"]
ix = np.clip(((lon - x0) / (x1 - x0) * nm["width"]).astype(int), 0, nm["width"] - 1)
iy = np.clip(((y1 - lat) / (y1 - y0) * nm["height"]).astype(int), 0, nm["height"] - 1)
ndvi1 = ndvi_img[iy[:, None], ix[None, :]]

# ------------------------------------------------------------------ trees
multi, single = np.load(f"{RAW}/multi.npy").astype(np.float32), np.load(f"{RAW}/single.npy").astype(np.float32)
# Foliage lets the laser through to lower surfaces (multiple returns); roofs and walls don't.
porous = ndimage.uniform_filter((multi + 0.0), 3) / (ndimage.uniform_filter(multi + single, 3) + 1e-3)
canopy = (ndsm1 >= 2.5) & (ndsm1 < 45) & (porous >= 0.25) & ~bmask1
canopy = ndimage.binary_opening(canopy, iterations=1)
chm = ndimage.gaussian_filter(np.where(canopy, ndsm1, 0), 1.0)
peaks = canopy & (chm >= 3) & (
    ((chm == ndimage.maximum_filter(chm, 5)) & (chm < 10)) | ((chm == ndimage.maximum_filter(chm, 7)) & (chm >= 10)))
pr, pc = np.nonzero(peaks)
seeds = np.c_[pr, pc]
cr, cc = np.nonzero(canopy)
counts = np.zeros(len(seeds), int)
if len(seeds):
    d, nearest = cKDTree(seeds).query(np.c_[cr, cc], distance_upper_bound=9)
    ok = np.isfinite(d)
    np.add.at(counts, nearest[ok], 1)
hmax = ndimage.maximum_filter(np.where(canopy, ndsm1, 0), 3)
trees, removed = [], 0
for (r, c), n in zip(seeds, counts):
    if np.median(ndvi1[max(0, r - 1):r + 2, max(0, c - 1):c + 2]) < 0.12:
        removed += 1  # canopy in 2014, no vegetation in the 2023 photo
        continue
    e, nn = E0 + c + 0.5, N1 - r - 0.5
    radius = float(np.clip(math.sqrt(max(n, 1) / math.pi), 1.2, 9.0))
    trees.append([round(e, 1), round(nn, 1), round(float(dtm[r, c]), 2), round(float(hmax[r, c]), 1), round(radius, 1)])
json.dump({"dataset": meta["dataset"], "ndvi_year": nm["date"][:4], "trees": trees, "removed_since": removed}, open(f"{OUT}/trees.json", "w"))
print(f"trees {len(trees)} (canopy peaks {len(seeds)}, {removed} gone by {nm['date'][:4]})")

# ------------------------------------------------------------------ roof levels -> parts
px5 = Affine(0.5, 0, E0, 0, -0.5, N1)
roofs, absent = {}, 0
for bid, poly, h_ov in footprints:
    minx, miny, maxx, maxy = poly.bounds
    c0, c1 = int((minx - E0) / 0.5) - 1, int((maxx - E0) / 0.5) + 2
    r0, r1 = int((N1 - maxy) / 0.5) - 1, int((N1 - miny) / 0.5) + 2
    if c0 < 0 or r0 < 0 or c1 > W5 or r1 > H5:
        continue
    win = Affine(0.5, 0, E0 + c0 * 0.5, 0, -0.5, N1 - r0 * 0.5)
    mask = features.rasterize([(poly, 1)], out_shape=(r1 - r0, c1 - c0), transform=win, dtype=np.uint8).astype(bool)
    inner = ndimage.binary_erosion(mask)
    if inner.sum() >= 12:
        mask_s = inner
    else:
        mask_s = mask
    vals = ndsm[r0:r1, c0:c1][mask_s]
    if len(vals) < 24:
        continue
    if np.median(vals) < 2.0:
        if h_ov and h_ov > 5:
            absent += 1  # LiDAR (2014) sees no building here: probably built later
            roofs[bid] = {"absent": True}
        continue
    up = vals[vals >= 2.0]
    bins = np.floor(up).astype(int)
    hist = np.bincount(bins)
    occupied = hist >= max(3, 0.015 * len(up))
    levels, start, gap = [], None, 0
    for i, occ in enumerate(np.append(occupied, False)):
        if occ:
            if start is None:
                start = i
            gap, last = 0, i
        elif start is not None:
            gap += 1
            if gap > 1:
                sel = up[(bins >= start) & (bins <= last)]
                levels.append((start, last + 1, sel))
                start, gap = None, 0
    if not levels:
        continue
    base_i = next((i for i, (_, _, s) in enumerate(levels) if len(s) >= 0.15 * len(up)), max(range(len(levels)), key=lambda i: len(levels[i][2])))
    h_base = float(np.percentile(levels[base_i][2], 75))
    parts = []
    prev_h = h_base
    sub = ndsm[r0:r1, c0:c1]
    for lo, hi, sel in levels[base_i + 1:]:
        if lo - prev_h < 1.5:
            continue
        lab, n = ndimage.label(mask & (sub >= lo - 0.25), structure=np.ones((3, 3)))
        for k in range(1, n + 1):
            comp = lab == k
            if comp.sum() < 16:  # < 4 m2
                continue
            ph = float(np.percentile(sub[comp], 75))
            for geom, v in features.shapes(comp.astype(np.uint8), mask=comp, transform=win):
                if v != 1:
                    continue
                pg = make_valid(shape(geom).simplify(0.35)).intersection(poly)
                for g in getattr(pg, "geoms", [pg]):
                    if g.geom_type != "Polygon" or g.area < 4:
                        continue
                    ring = [round(c, 1) for xy in list(g.exterior.coords)[:-1] for c in xy]
                    parts.append({"o": ring, "mh": round(prev_h, 1), "h": round(ph, 1), "a": round(g.area)})
        prev_h = float(np.median(sel))
    parts = sorted(parts, key=lambda p: -p["a"])[:12]
    for p in parts:
        del p["a"]
    roofs[bid] = {"base": round(h_base, 1), "levels": len(levels) - base_i, "parts": parts}
json.dump({"dataset": meta["dataset"], "roofs": roofs}, open(f"{OUT}/roofs.json", "w"))
with_parts = sum(1 for r in roofs.values() if r.get("parts"))
print(f"roofs {len(roofs)} buildings, {with_parts} with raised parts ({sum(len(r.get('parts', [])) for r in roofs.values())} parts), {absent} not in 2014 LiDAR")
