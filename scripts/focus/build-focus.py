"""Builds the viewer data for one focus area from its Mapillary 3D download:

  public/data/focus/<name>/focus.json   photo poses in scene coordinates (for photo-match view),
                                        SfM points (truth overlay), alignment offsets
  public/data/focus/<name>/photos/      1600 px copies of the photos (git-ignored)

Each SfM reconstruction gets its own vertical offset: its GPS altitude is shifted so its cameras
sit CAM_H above the LiDAR ground (median), since phone altitude is off by metres.
Usage: .venv/bin/python -I scripts/focus/build-focus.py example-area
"""
import json
import math
import os
import sys
import time

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
from sfm import Scene, area_center, load_sfm, rodrigues, to_local  # noqa: E402

CAM_H = 1.5  # typical phone/dash camera height above the road

name = sys.argv[1]
area = json.load(open(f"areas/{name}.json"))
src = f"data/raw/focus/{name}"
out = f"public/data/focus/{name}"
os.makedirs(f"{out}/photos", exist_ok=True)
cx, cy = area_center(area)
scene = Scene()
P, C, K, shots, meta = load_sfm(name)
images = {im["id"]: im for im in json.load(open(f"{src}/images.json"))}

# ------------------------------------------------------------------ per-cluster vertical alignment
dz = {}
for k in range(len(meta)):
    cams = np.array([c for (kk, c, _) in shots.values() if kk == k])
    if not len(cams):
        continue
    dz[k] = float(np.median(cams[:, 2] - scene.ground(cams[:, 0], cams[:, 1])) - CAM_H)
P = P.copy()
for k, v in dz.items():
    P[K == k, 2] -= v

# ------------------------------------------------------------------ photo poses (three.js frame)
def to_three(v):  # ENU vector -> three.js (x = east, y = up, z = -north)
    return np.array([v[0], v[2], -v[1]])


# Reconstruction shot keys aren't API image ids, so poses come from each photo's computed_*
# fields (from the same reconstruction) and the cluster offset is looked up by cluster id.
cluster_index = {os.path.basename(m["file"])[:-5]: k for k, m in enumerate(meta)}
photos = []
for iid, im in images.items():
    k = cluster_index.get(im.get("sfm_cluster"))
    if k is None or not os.path.exists(f"{src}/photos/{iid}.jpg") or im.get("computed_altitude") is None:
        continue
    lon, lat = im["computed_geometry"]["coordinates"]
    c = np.array([*to_local(lat, lon), im["computed_altitude"] + meta[k]["ref"].get("altitude", 0) - dz.get(k, 0)])
    R = rodrigues(im["computed_rotation"])
    right, down, fwd = R.T @ [1, 0, 0], R.T @ [0, 1, 0], R.T @ [0, 0, 1]
    M = np.c_[to_three(right), to_three(-down), to_three(-fwd)]  # camera basis columns
    # rotation matrix -> quaternion
    t = np.trace(M)
    if t > 0:
        s = math.sqrt(t + 1) * 2
        q = [(M[2, 1] - M[1, 2]) / s, (M[0, 2] - M[2, 0]) / s, (M[1, 0] - M[0, 1]) / s, s / 4]
    else:
        i = int(np.argmax(np.diag(M)))
        j, l = (i + 1) % 3, (i + 2) % 3
        s = math.sqrt(1 + M[i, i] - M[j, j] - M[l, l]) * 2
        q = [0, 0, 0, 0]
        q[i] = s / 4
        q[j] = (M[j, i] + M[i, j]) / s
        q[l] = (M[l, i] + M[i, l]) / s
        q[3] = (M[l, j] - M[j, l]) / s
    w, h = im.get("width") or 4032, im.get("height") or 3024
    f = (im.get("camera_parameters") or [0.8])[0]
    vfov = math.degrees(2 * math.atan((h / max(w, h)) * 0.5 / f))
    photos.append({
        "id": iid, "e": round(c[0], 2), "n": round(c[1], 2), "z": round(c[2], 2), "q": [round(x, 5) for x in q],
        "vfov": round(vfov, 2), "aspect": round(w / h, 4), "yr": time.gmtime(im["captured_at"] / 1000).tm_year,
        "d": round(math.hypot(c[0] - cx, c[1] - cy), 1),
    })
    dst = f"{out}/photos/{iid}.jpg"
    if not os.path.exists(dst):
        img = Image.open(f"{src}/photos/{iid}.jpg")
        img.thumbnail((1600, 1600))
        img.save(dst, quality=82)
photos.sort(key=lambda p: p["d"])

# ------------------------------------------------------------------ SfM points near the area
m = np.hypot(P[:, 0] - cx, P[:, 1] - cy) < area["photoRadius"]
pts = np.round(P[m], 2)
cols = C[m].astype(int)
focus = {
    "name": name, "label": area["label"], "center": [round(cx, 1), round(cy, 1)], "radius": area["radius"],
    "photos": photos,
    "points": {"p": pts.ravel().tolist(), "c": cols.ravel().tolist()},
    "align": {"camH": CAM_H, "clusters": len(dz), "dz": sorted(round(v, 2) for v in dz.values())},
    "source": "Mapillary (CC-BY-SA): photos, camera poses and SfM points",
}
json.dump(focus, open(f"{out}/focus.json", "w"))
index_path = "public/data/focus/index.json"
index = json.load(open(index_path)) if os.path.exists(index_path) else []
if name not in index:
    index.append(name)
json.dump(index, open(index_path, "w"))
print(f"{len(photos)} photos, {len(pts)} SfM points, cluster altitude offsets {min(dz.values()):.1f}..{max(dz.values()):.1f} m")
