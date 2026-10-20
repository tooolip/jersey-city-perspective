"""Measures real curb lines for the streets in a focus area from LiDAR: cross-street ground
profiles (1 m LiDAR ground, 2014) are aligned on the OSM centreline and averaged along each
street, which brings out the 10-20 cm curb step on each side. The curb is the first rise of
>= STEP beyond the gutter's low point (stopping before any wall); mapped OSM sidewalk lines are
the fallback.

Writes data/derived/focus/<name>/streets.json:
  {street name: {"dir": [dx, dy], "left": m, "right": m, "n": profiles, "src": [..]}}
where left/right are curb offsets relative to the reference direction `dir` (ways running the
other way swap them). Also writes a check image over the aerial photo: curbs.jpg.
Usage: .venv/bin/python -I scripts/focus/streets.py example-area
"""
import json
import math
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(__file__))
from sfm import M_LAT, M_LON, ORIGIN, area_center  # noqa: E402

STEP = 0.06  # m of rise that counts as the curb
name = sys.argv[1]
area = json.load(open(f"areas/{name}.json"))
out = f"data/derived/focus/{name}"
os.makedirs(out, exist_ok=True)
city = json.load(open("public/data/city.json"))
cx, cy = area_center(area)
RAD = area["radius"] + 20
CAR = {"primary", "secondary", "tertiary", "residential", "unclassified", "trunk", "living_street"}

lm = json.load(open("data/raw/lidar/meta.json"))
gs, gn = np.load("data/raw/lidar/ground_sum.npy"), np.load("data/raw/lidar/ground_n.npy")
G = np.where(gn > 0, gs / np.maximum(gn, 1), np.nan)
gz = lambda e, n: G[int(lm["n1"] - n), int(e - lm["e0"])]
OFFS = np.arange(-14, 14.01, 0.5)

use = {}
for r in city["roads"]:
    if r["k"] not in CAR or r.get("e"):
        continue
    for k in {(r["p"][i], r["p"][i + 1]) for i in range(0, len(r["p"]), 2)}:
        use[k] = use.get(k, 0) + 1
junctions = [k for k, v in use.items() if v > 1]

sidewalks = []
for p in city["paths"]:
    if p.get("f") == "sidewalk":
        pts = [(p["p"][i], p["p"][i + 1]) for i in range(0, len(p["p"]), 2)]
        sidewalks += list(zip(pts, pts[1:]))


def ray_hit(p, d, segs, max_d=16):
    best = None
    for a, b in segs:
        ex, ey = b[0] - a[0], b[1] - a[1]
        den = d[0] * ey - d[1] * ex
        if abs(den) < 1e-9:
            continue
        s_ = ((a[0] - p[0]) * ey - (a[1] - p[1]) * ex) / den
        u = ((a[0] - p[0]) * d[1] - (a[1] - p[1]) * d[0]) / den
        if 1.5 < s_ < max_d and 0 <= u <= 1 and (best is None or s_ < best):
            best = s_
    return best


streets = {}
for r in city["roads"]:
    if r["k"] not in CAR or r.get("e") or r.get("cut") or not r.get("n"):
        continue
    pts = [(r["p"][i], r["p"][i + 1]) for i in range(0, len(r["p"]), 2)]
    for a, b in zip(pts, pts[1:]):
        L = math.hypot(b[0] - a[0], b[1] - a[1])
        if L < 4:
            continue
        dx, dy = (b[0] - a[0]) / L, (b[1] - a[1]) / L
        st = streets.setdefault(r["n"], {"dir": (dx, dy), "prof": [], "sw": {"L": [], "R": []}})
        if dx * st["dir"][0] + dy * st["dir"][1] < 0:  # align with the street's reference direction
            a, b, dx, dy = b, a, -dx, -dy
        nx, ny = -dy, dx
        for t in np.arange(1.0, L - 1.0, 1.0):
            p = (a[0] + dx * t, a[1] + dy * t)
            if math.hypot(p[0] - cx, p[1] - cy) > RAD or any(math.hypot(p[0] - j[0], p[1] - j[1]) < 10 for j in junctions):
                continue
            prof = np.array([gz(p[0] + nx * o, p[1] + ny * o) for o in OFFS])
            centre = prof[np.abs(OFFS) <= 2]
            if np.isnan(centre).all():
                continue
            st["prof"].append(prof - np.nanmedian(centre))
            for side, sg in (("L", 1), ("R", -1)):
                hit = ray_hit(p, (nx * sg, ny * sg), sidewalks)
                if hit:
                    st["sw"][side].append(hit)


def curb_from(profile, sign):
    """Offset of the curb on one side of a median profile (sign +1 = left, -1 = right)."""
    idx = [i for i in range(len(OFFS)) if OFFS[i] * sign >= 1.5]
    idx.sort(key=lambda i: abs(OFFS[i]))
    vals = [(abs(OFFS[i]), profile[i]) for i in idx if not np.isnan(profile[i])]
    if len(vals) < 6:
        return None
    lo = min(v for o, v in vals if o <= 7)
    lo_at = next(o for o, v in vals if v == lo)
    for (o, v), (o2, v2) in zip(vals, vals[1:]):
        if o <= lo_at:
            continue
        if v2 - lo > 1.0:  # a wall: the curb wasn't found before it
            return None
        if v2 - lo >= STEP and v2 - v >= STEP * 0.5:
            return (o + o2) / 2
    return None


result = {}
for nm_, st in streets.items():
    if len(st["prof"]) < 8:
        continue
    med = np.nanmedian(np.array(st["prof"]), axis=0)
    rec = {"dir": [round(v, 4) for v in st["dir"]], "n": len(st["prof"]), "src": []}
    for side, label, sg in (("L", "left", 1), ("R", "right", -1)):
        val, src = curb_from(med, sg), "lidar"
        if val is None and len(st["sw"][side]) >= 4:
            val, src = float(np.median(st["sw"][side])) - 0.8, "sidewalk-line"
        if val is not None and 2.5 <= val <= 11:
            rec[label] = round(float(val), 2)
            rec["src"].append(src)
        else:
            rec["src"].append(None)
    if "left" in rec or "right" in rec:
        result[nm_] = rec
json.dump(result, open(f"{out}/streets.json", "w"), indent=1)
for k, v in result.items():
    print(f"{k:22s} left {v.get('left', '-'):>5} right {v.get('right', '-'):>5}  ({v['n']} profiles, {v['src']})")

nm = json.load(open("data/raw/naip.json"))
rgb = np.fromfile("data/raw/naip.rgb", np.uint8).reshape(nm["height"], nm["width"], 3)
x0, y0, x1, y1 = nm["bbox"]


def pix(e, n):
    lon = ORIGIN[1] + e / M_LON
    lat = ORIGIN[0] + n / M_LAT
    return (lon - x0) / (x1 - x0) * nm["width"], (y1 - lat) / (y1 - y0) * nm["height"]


# ------------------------------------------------------------------ check image
R, SC = 70, 8
a, b = pix(cx - R, cy + R), pix(cx + R, cy - R)
crop = Image.fromarray(rgb[int(a[1]):int(b[1]), int(a[0]):int(b[0])]).resize((2 * R * SC, 2 * R * SC))
dr = ImageDraw.Draw(crop)
P = lambda e, n: ((e - cx + R) * SC, (cy + R - n) * SC)
for r in city["roads"]:
    v = result.get(r.get("n"))
    if not v or r["k"] not in CAR:
        continue
    pts = [(r["p"][i], r["p"][i + 1]) for i in range(0, len(r["p"]), 2)]
    for a_, b_ in zip(pts, pts[1:]):
        L = math.hypot(b_[0] - a_[0], b_[1] - a_[1]) or 1
        dx, dy = (b_[0] - a_[0]) / L, (b_[1] - a_[1]) / L
        flip = dx * v["dir"][0] + dy * v["dir"][1] < 0
        for side, sg in (("left", 1), ("right", -1)):
            key = side if not flip else ("right" if side == "left" else "left")
            o = v.get(key, r["w"] / 2)
            nx, ny = -dy * sg * o, dx * sg * o
            dr.line([P(a_[0] + nx, a_[1] + ny), P(b_[0] + nx, b_[1] + ny)], fill=(255, 60, 60), width=3)
crop.save(f"{out}/curbs.jpg", quality=85)
