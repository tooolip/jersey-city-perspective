"""Focus-area terrain: separates street level from raised plateaus and opens tunnels through them.

  * Street level ("low") is interpolated from LiDAR ground along road centrelines (not on
    bridges or in tunnels) plus the 2019 photo camera tracks (camera height - CAM_H).
  * Plateaus are measured ground more than RAISE metres above street level (old rail embankments,
    raised lots behind retaining walls). They become solid blocks with vertical walls; their top
    keeps the measured LiDAR surface ("top").
  * OSM "tunnels" through a plateau are cut out of it at street level. Photos show these are
    open cuts between retaining walls (the only roof is a bridge, already an elevated OSM way),
    so no roof is added.

Writes data/derived/focus/<name>/terrain.json with a 1 m patch (low/top grids + plateau mask),
plateau polygons and the cut (tunnel-tagged) ways to draw at street level. Check image: terrain.png.
Usage: .venv/bin/python -I scripts/focus/terrain.py example-area
"""
import json
import math
import os
import sys

import numpy as np
from PIL import Image
from rasterio import features
from rasterio.transform import Affine
from scipy import ndimage
from scipy.interpolate import griddata
from shapely.geometry import LineString, Polygon, mapping, shape
from shapely.ops import unary_union

sys.path.insert(0, os.path.dirname(__file__))
from sfm import M_LAT, M_LON, ORIGIN, area_center, to_local  # noqa: E402

RAISE = 2.0  # metres above street level to count as a plateau
MIN_AREA = 400  # m2
MIN_MEAN_RAISE = 3.0  # m: smaller bumps are yards, stoops, LiDAR noise
MARGIN = 60  # patch extends this far beyond the focus radius

name = sys.argv[1]
area = json.load(open(f"areas/{name}.json"))
out = f"data/derived/focus/{name}"
os.makedirs(out, exist_ok=True)
cx, cy = area_center(area)
R = area["radius"] + MARGIN

# ------------------------------------------------------------------ LiDAR window (1 m)
meta = json.load(open("data/raw/lidar/meta.json"))
gs, gn = np.load("data/raw/lidar/ground_sum.npy"), np.load("data/raw/lidar/ground_n.npy")
dm = json.load(open("data/derived/dtm.json"))
dtm = np.fromfile("data/derived/dtm.f32", np.float32).reshape(dm["h"], dm["w"])
c0, r0 = int(cx - R - meta["e0"]), int(meta["n1"] - (cy + R))
W = H = int(2 * R)
e0, n1 = meta["e0"] + c0, meta["n1"] - r0  # patch origin (cell corner)
meas = np.where(gn[r0:r0 + H, c0:c0 + W] > 0, gs[r0:r0 + H, c0:c0 + W] / np.maximum(gn[r0:r0 + H, c0:c0 + W], 1), np.nan)
filled = dtm[r0:r0 + H, c0:c0 + W].astype(float)
T = Affine(1.0, 0, e0, 0, -1.0, n1)
cell = lambda e, n: (int(n1 - n), int(e - e0))

# ------------------------------------------------------------------ street-level anchors
osm = json.load(open("data/raw/osm_features.json"))["elements"]
CAR = {"primary", "secondary", "tertiary", "residential", "unclassified", "trunk", "living_street", "service"}
anchors, tunnels = [], []
for el in osm:
    t = el.get("tags", {})
    if el["type"] != "way" or t.get("highway") not in CAR or "geometry" not in el:
        continue
    pts = [to_local(g["lat"], g["lon"]) for g in el["geometry"]]
    if not any(math.hypot(p[0] - cx, p[1] - cy) < R for p in pts):
        continue
    if t.get("tunnel") not in (None, "no"):
        tunnels.append({"pts": pts, "tags": t})
        continue
    if t.get("bridge") not in (None, "no") or t.get("layer", "0") not in ("0", "-0") or t.get("highway") == "service":
        continue
    line = LineString(pts)
    for d in np.arange(0, line.length, 2.0):
        p = line.interpolate(d)
        r, c = cell(p.x, p.y)
        if 0 <= r < H and 0 <= c < W and not np.isnan(meas[r, c]):
            anchors.append((p.x, p.y, meas[r, c]))
focus = json.load(open(f"public/data/focus/{name}/focus.json"))
for ph in focus["photos"]:
    if math.hypot(ph["e"] - cx, ph["n"] - cy) < R:
        anchors.append((ph["e"], ph["n"], ph["z"] - focus["align"]["camH"]))
A = np.array(anchors)
# Robust: drop anchors far above their neighbours (road over a plateau edge, bad cameras).
keep = np.ones(len(A), bool)
for i, (x, y, z) in enumerate(A):
    nb = A[np.hypot(A[:, 0] - x, A[:, 1] - y) < 25, 2]
    keep[i] = z < np.median(nb) + 1.0
A = A[keep]
E, N = np.meshgrid(e0 + np.arange(W) + 0.5, n1 - np.arange(H) - 0.5)
low = griddata(A[:, :2], A[:, 2], (E, N), method="linear")
low_nn = griddata(A[:, :2], A[:, 2], (E, N), method="nearest")
low = np.where(np.isnan(low), low_nn, low)
low = ndimage.gaussian_filter(low, 3)

# ------------------------------------------------------------------ plateaus
raised = np.nan_to_num(meas - low, nan=-9) > RAISE
raised = ndimage.binary_closing(raised, iterations=2)  # bridge LiDAR gaps on top
raised = ndimage.binary_fill_holes(raised)
raised = ndimage.binary_opening(raised, iterations=1)
# Buildings standing on a plateau hide its ground from the LiDAR (no returns under roofs):
# count a footprint as plateau when much of the measured ground around it is plateau-level.
city = json.load(open("public/data/city.json"))
diff = np.nan_to_num(meas - low, nan=np.nan)
for bd in city["buildings"]:
    ring = [(bd["o"][i], bd["o"][i + 1]) for i in range(0, len(bd["o"]), 2)]
    if not any(math.hypot(x - cx, y - cy) < R for x, y in ring):
        continue
    poly = Polygon(ring).buffer(0)
    if poly.area < 30:
        continue
    fp = features.rasterize([(poly, 1)], out_shape=(H, W), transform=T).astype(bool)
    halo = features.rasterize([(poly.buffer(6).difference(poly.buffer(1)), 1)], out_shape=(H, W), transform=T).astype(bool)
    vals = diff[halo & ~np.isnan(diff)]
    if len(vals) >= 20 and (vals > RAISE).mean() >= 0.35:
        raised |= fp
lab, n = ndimage.label(raised)
sizes = ndimage.sum(raised, lab, range(1, n + 1))
lift = ndimage.mean(np.where(np.isnan(meas), 0, meas - low), lab, range(1, n + 1)) / np.maximum(ndimage.mean(~np.isnan(meas), lab, range(1, n + 1)), 1e-3)
raised = np.isin(lab, [i + 1 for i in range(n) if sizes[i] >= MIN_AREA and lift[i] >= MIN_MEAN_RAISE])

# Raster outlines step in 1 m stairs; real retaining walls run straight along the streets.
polys = [shape(g).simplify(1.5) for g, v in features.shapes(raised.astype(np.uint8), mask=raised, transform=T) if v == 1]
plateau = unary_union([p.buffer(0) for p in polys if p.area >= MIN_AREA])

# Cuts: measure where the walls stand on each side of the street (first raised cell out from
# the centreline) and cut a straight corridor at those offsets.
WIDTH = {"residential": 8, "tertiary": 10, "secondary": 12, "primary": 13, "trunk": 11, "service": 5, "unclassified": 7}


def wall_offset(line, side):
    offs = []
    for d in np.arange(2, line.length - 2, 2.0):
        p, q = line.interpolate(d), line.interpolate(min(line.length, d + 0.5))
        dx, dy = q.x - p.x, q.y - p.y
        L = math.hypot(dx, dy) or 1
        nx, ny = -dy / L * side, dx / L * side
        for o in np.arange(2.0, 16.0, 0.5):
            r, c = cell(p.x + nx * o, p.y + ny * o)
            if 0 <= r < H and 0 <= c < W and raised[r, c]:
                offs.append(o)
                break
    return float(np.median(offs)) if len(offs) >= 3 else None


corr = []
for tn in tunnels:
    line = LineString(tn["pts"])
    w = float(tn["tags"].get("width") or WIDTH.get(tn["tags"].get("highway"), 8))
    left, right = wall_offset(line, 1), wall_offset(line, -1)
    tn["walls"] = [left, right]
    left = left if left is not None else w / 2 + 0.75
    right = right if right is not None else w / 2 + 0.75
    corr.append(unary_union([line.buffer(left, cap_style=2, single_sided=True), line.buffer(-right, cap_style=2, single_sided=True)]).buffer(0.05))
corridor = unary_union(corr) if corr else Polygon()
# Close notches up to ~6 m so the plateau meets the cut's straight corridor edge (and runs
# straight along streets), then cut the corridor and drop slivers.
closed = plateau.buffer(3, join_style=2).buffer(-3, join_style=2) if not plateau.is_empty else Polygon()
blocks = closed.difference(corridor) if not closed.is_empty else Polygon()
blocks = blocks.buffer(-0.8, join_style=2).buffer(0.8, join_style=2).simplify(0.4)

# ------------------------------------------------------------------ grids
top = np.where(raised, meas, np.nan)
if raised.any():
    idx = ndimage.distance_transform_edt(np.isnan(top), return_distances=False, return_indices=True)
    top = ndimage.gaussian_filter(top[tuple(idx)], 1.0)
else:
    top = low.copy()
# Ground model outside plateaus: measured where present, else street level, blended near anchors.
block_mask = features.rasterize([(blocks, 1)], out_shape=(H, W), transform=T).astype(bool) if not blocks.is_empty else np.zeros((H, W), bool)
ground = np.where(np.isnan(meas), filled, meas)
# Around plateaus (wall tops, slivers outside the final outline) and wherever ground stands more
# than a metre above street level, the ground model is street level: walls are drawn separately.
near = features.rasterize([(blocks.buffer(2.0), 1)], out_shape=(H, W), transform=T).astype(bool) if not blocks.is_empty else np.zeros((H, W), bool)
ground = np.where(near | raised | (ground - low > 1.0), low, ground)
ground = ndimage.gaussian_filter(ground, 0.8)


def ring_list(geom):
    out = []
    for g in getattr(geom, "geoms", [geom]):
        if g.is_empty or g.geom_type != "Polygon" or g.area < 20:
            continue
        o = [round(v, 2) for xy in list(g.exterior.coords)[:-1] for v in xy]
        holes = [[round(v, 2) for xy in list(h.coords)[:-1] for v in xy] for h in g.interiors]
        out.append({"o": o, "holes": holes} if holes else {"o": o})
    return out


SIDEWALK = 2.0  # m along each wall of a cut (photos: narrow sidewalks against the walls)


def cut_road(tn):
    """The roadway in a cut, recentred between the measured walls (OSM centrelines can be metres
    off; here the walls agree with the aerial photo and the camera tracks)."""
    w = float(tn["tags"].get("width") or WIDTH.get(tn["tags"].get("highway"), 8))
    left, right = tn.get("walls") or [None, None]
    line = LineString(tn["pts"])
    if left is not None and right is not None and left + right - 2 * SIDEWALK > 4:
        shift = (left - right) / 2
        line = line.parallel_offset(abs(shift), "left" if shift > 0 else "right") if abs(shift) > 0.2 else line
        if shift < -0.2:
            line = LineString(list(line.coords)[::-1])  # right offsets come back reversed
        w = left + right - 2 * SIDEWALK
    return {"name": tn["tags"].get("name"), "k": tn["tags"].get("highway"), "walls": tn.get("walls"),
            "p": [round(v, 1) for xy in line.coords for v in xy], "w": round(w, 1)}


cm = lambda a: np.clip(np.round(a * 100), -32000, 32000).astype(int).ravel().tolist()
result = {
    "patch": {"e0": e0, "n1": n1, "res": 1.0, "w": W, "h": H, "low": cm(ground), "top": cm(top),
              "mask": np.packbits(block_mask.ravel()).tolist()},
    "plateaus": ring_list(blocks),
    "tunnels": [cut_road(tn) for tn in tunnels],
    "anchors": int(len(A)),
}
json.dump(result, open(f"{out}/terrain.json", "w"))
print(f"anchors {len(A)}, plateaus {len(result['plateaus'])} ({blocks.area:.0f} m2), cuts {len(tunnels)}")
print(f"street level {np.nanpercentile(low, 5):.2f}..{np.nanpercentile(low, 95):.2f} m, plateau top {np.nanpercentile(top[raised], 5) if raised.any() else 0:.2f}..{np.nanpercentile(top[raised], 95) if raised.any() else 0:.2f} m")

# ------------------------------------------------------------------ check image
vis = np.where(block_mask, top, ground)
v = np.clip((vis - 1) / 8, 0, 1)
img = np.stack([v * 255, (1 - abs(v - 0.5) * 2) * 200, (1 - v) * 255], -1).astype(np.uint8)
edge = block_mask ^ ndimage.binary_erosion(block_mask)
img[edge] = (255, 255, 255)
cor = features.rasterize([(corridor, 1)], out_shape=(H, W), transform=T).astype(bool) if corr else np.zeros((H, W), bool)
img[cor & ~block_mask] = (img[cor & ~block_mask] * 0.5 + np.array([255, 255, 0]) * 0.5).astype(np.uint8)
Image.fromarray(img).resize((W * 3, H * 3), Image.NEAREST).save(f"{out}/terrain.png")
