"""Streams USGS 3DEP LiDAR (Entwine Point Tiles on AWS) for the project area and rasterizes it
on the fly into grids in local meters ([east, north] from the scene origin):

  ground_sum / ground_n  (1 m)    ground-classified points -> terrain
  dsm                    (0.5 m)  highest non-noise return -> roofs, canopy
  multi / single         (1 m)    non-ground returns with / without later returns: laser that
                                  passes through foliage gives multiple returns, roofs give one

Output: data/raw/lidar/*.npy plus meta.json. Points themselves are not stored.
Usage: .venv/bin/python scripts/fetch-lidar.py [dataset]
"""
import io
import json
import math
import os
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import laspy
import numpy as np

DATASET = sys.argv[1] if len(sys.argv) > 1 else "USGS_Lidar_Point_Cloud_NJ_SdL5_2014_LAS_2015"
BASE = f"https://s3-us-west-2.amazonaws.com/usgs-lidar-public/{DATASET}"
BBOX = (-74.0565, 40.7155, -74.0265, 40.7335)  # lon/lat: project area + context ring
OUT = "data/raw/lidar"

# Must match scripts/build-data.mjs
ORIGIN = (40.724, -74.042)
M_LAT = 111132.954 - 559.822 * math.cos(2 * ORIGIN[0] * math.pi / 180)
M_LON = 111412.84 * math.cos(ORIGIN[0] * math.pi / 180)
R = 6378137.0


def merc(lon, lat):
    return lon * math.pi / 180 * R, math.log(math.tan((90 + lat) * math.pi / 360)) * R


def merc_to_local(x, y):
    lon = x / R * 180 / math.pi
    lat = (2 * np.arctan(np.exp(y / R)) - math.pi / 2) * 180 / math.pi
    return (lon - ORIGIN[1]) * M_LON, (lat - ORIGIN[0]) * M_LAT


E0 = (BBOX[0] - ORIGIN[1]) * M_LON
E1 = (BBOX[2] - ORIGIN[1]) * M_LON
N0 = (BBOX[1] - ORIGIN[0]) * M_LAT
N1 = (BBOX[3] - ORIGIN[0]) * M_LAT


def grid(res):
    return int(math.ceil((E1 - E0) / res)), int(math.ceil((N1 - N0) / res))


W1, H1 = grid(1.0)
W5, H5 = grid(0.5)
ground_sum = np.zeros((H1, W1), np.float64)
ground_n = np.zeros((H1, W1), np.uint16)
multi = np.zeros((H1, W1), np.uint16)
single = np.zeros((H1, W1), np.uint16)
dsm = np.full((H5, W5), -np.inf, np.float32)

get = lambda u: json.load(urllib.request.urlopen(u, timeout=60))
ept = get(BASE + "/ept.json")
B = ept["bounds"]
mx0, my0 = merc(BBOX[0], BBOX[1])
mx1, my1 = merc(BBOX[2], BBOX[3])


def node_bounds(d, x, y):
    s = (B[3] - B[0]) / 2 ** d
    return B[0] + x * s, B[1] + y * s, B[0] + (x + 1) * s, B[1] + (y + 1) * s


nodes = []


def walk(h, key):
    cnt = h.get(key)
    if cnt is None:
        return
    d, x, y, z = map(int, key.split("-"))
    a, b, c, e = node_bounds(d, x, y)
    if c < mx0 or a > mx1 or e < my0 or b > my1:
        return
    if cnt == -1:
        h.update(get(f"{BASE}/ept-hierarchy/{key}.json"))
        cnt = h[key]
    if cnt > 0:
        nodes.append(key)
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                walk(h, f"{d + 1}-{2 * x + dx}-{2 * y + dy}-{2 * z + dz}")


walk(get(BASE + "/ept-hierarchy/0-0-0-0.json"), "0-0-0-0")
print(f"{DATASET}: {len(nodes)} nodes intersect the area")


def fetch(key):
    for attempt in range(4):
        try:
            return key, urllib.request.urlopen(f"{BASE}/ept-data/{key}.laz", timeout=120).read()
        except Exception as err:  # noqa: BLE001
            last = err
    raise RuntimeError(f"{key}: {last}")


def accumulate(data):
    las = laspy.read(io.BytesIO(data))
    e, n = merc_to_local(np.asarray(las.x), np.asarray(las.y))
    z = np.asarray(las.z, np.float32)
    cls = np.asarray(las.classification)
    nret = np.asarray(las.number_of_returns)
    rnum = np.asarray(las.return_number)
    keep = (e >= E0) & (e < E1) & (n >= N0) & (n < N1) & ~np.isin(cls, (7, 18))  # drop noise
    e, n, z, cls, nret, rnum = e[keep], n[keep], z[keep], cls[keep], nret[keep], rnum[keep]
    # rows count north -> south so arrays read like a map
    c1 = ((e - E0) / 1.0).astype(np.int32)
    r1 = ((N1 - n) / 1.0).astype(np.int32)
    c5 = ((e - E0) / 0.5).astype(np.int32)
    r5 = ((N1 - n) / 0.5).astype(np.int32)
    g = cls == 2
    np.add.at(ground_sum, (r1[g], c1[g]), z[g])
    np.add.at(ground_n, (r1[g], c1[g]), 1)
    ng = (cls == 1) & (rnum == 1)
    np.add.at(multi, (r1[ng & (nret > 1)], c1[ng & (nret > 1)]), 1)
    np.add.at(single, (r1[ng & (nret == 1)], c1[ng & (nret == 1)]), 1)
    surf = cls != 9  # water returns don't count as surfaces
    np.maximum.at(dsm, (r5[surf], c5[surf]), z[surf])
    return int(keep.sum())


total = 0
with ThreadPoolExecutor(8) as pool:
    for i, (key, data) in enumerate(pool.map(fetch, nodes)):
        total += accumulate(data)
        if i % 100 == 0 or i == len(nodes) - 1:
            print(f"  {i + 1}/{len(nodes)} nodes, {total / 1e6:.1f}M points")

os.makedirs(OUT, exist_ok=True)
for name, arr in [("ground_sum", ground_sum), ("ground_n", ground_n), ("multi", multi), ("single", single), ("dsm", dsm)]:
    np.save(f"{OUT}/{name}.npy", arr)
with open(f"{OUT}/meta.json", "w") as f:
    json.dump({"dataset": DATASET, "e0": E0, "n1": N1, "w1": W1, "h1": H1, "w5": W5, "h5": H5, "points": total}, f)
print(f"Saved {OUT}/ ({total / 1e6:.1f}M points, grids {W1}x{H1} @1m, {W5}x{H5} @0.5m)")
