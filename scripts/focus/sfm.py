"""Shared helpers for focus-area processing: scene loading, terrain sampling, and Mapillary SfM
reconstructions converted to the scene's local frame ([east, north, up] metres)."""
import glob
import json
import math

import numpy as np

ORIGIN = (40.724, -74.042)  # must match scripts/build-data.mjs
M_LAT = 111132.954 - 559.822 * math.cos(2 * ORIGIN[0] * math.pi / 180)
M_LON = 111412.84 * math.cos(ORIGIN[0] * math.pi / 180)


def to_local(lat, lon):
    return (lon - ORIGIN[1]) * M_LON, (lat - ORIGIN[0]) * M_LAT


def rodrigues(r):
    r = np.asarray(r, float)
    th = np.linalg.norm(r)
    if th < 1e-12:
        return np.eye(3)
    k = r / th
    K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + math.sin(th) * K + (1 - math.cos(th)) * K @ K


class Scene:
    def __init__(self, path="public/data/city.json"):
        self.city = json.load(open(path))
        tm = self.city["terrain"]
        self.tm = tm
        self.terr = np.fromfile("public/data/terrain.bin", np.int16).reshape(tm["h"], tm["w"]) / 100.0

    def ground(self, e, n):
        tm = self.tm
        fx, fy = (e - tm["e0"]) / tm["res"], (tm["n1"] - n) / tm["res"]
        fx = np.clip(fx, 0, tm["w"] - 1.001)
        fy = np.clip(fy, 0, tm["h"] - 1.001)
        c, r = np.floor(fx).astype(int), np.floor(fy).astype(int)
        tx, ty = fx - c, fy - r
        T = self.terr
        return (T[r, c] * (1 - tx) + T[r, c + 1] * tx) * (1 - ty) + (T[r + 1, c] * (1 - tx) + T[r + 1, c + 1] * tx) * ty


def area_center(area):
    return to_local(*area["center"])


def load_sfm(name):
    """All reconstructions of a focus area: points (N,3) local, colours (N,3), cluster index per
    point, and shots {image_id: (cluster, camera centre local (3,), R world->cam)}."""
    pts, cols, cid, shots, meta = [], [], [], {}, []
    for ci, path in enumerate(sorted(glob.glob(f"data/raw/focus/{name}/sfm/*.json"))):
        for rec in json.load(open(path)):
            ref = rec["reference_lla"]
            ox, oy = to_local(ref["latitude"], ref["longitude"])
            # Scale from the reference point's metres to ours (both near-equirectangular here).
            sx = 111412.84 * math.cos(math.radians(ref["latitude"])) / M_LON
            sy = 1.0
            P = np.array([p["coordinates"] for p in rec["points"].values()], float)
            if not len(P):
                continue
            C = np.array([p["color"] for p in rec["points"].values()], float)
            L = np.c_[ox + P[:, 0] * sx, oy + P[:, 1] * sy, ref.get("altitude", 0) + P[:, 2]]
            k = len(meta)
            meta.append({"file": path, "ref": ref, "o": (ox, oy), "s": (sx, sy)})
            pts.append(L)
            cols.append(C)
            cid.append(np.full(len(L), k))
            for sid, sh in rec["shots"].items():
                R = rodrigues(sh["rotation"])
                c = -R.T @ np.array(sh["translation"], float)  # camera centre in reconstruction frame
                shots[sid] = (k, np.array([ox + c[0] * sx, oy + c[1] * sy, ref.get("altitude", 0) + c[2]]), R)
    return np.concatenate(pts), np.concatenate(cols), np.concatenate(cid), shots, meta
