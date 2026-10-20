"""Registers each Mapillary SfM reconstruction of a focus area to the building footprints.

Phone GPS places reconstructions metres off. Points on facades (3-20 m above street level, not
foliage) are matched to the nearest footprint wall and a 2D rigid transform (shift + small
rotation) is solved by robust point-to-line ICP. The transform is applied later to the photo
poses and points, so projected textures land on the right walls.

Writes data/derived/focus/<name>/registration.json:
  {cluster id: {"dx", "dy", "theta" (rad), "cx", "cy" (rotation centre), "before", "after", "n"}}
Usage: .venv/bin/python -I scripts/focus/register.py example-area
"""
import json
import math
import os
import sys

import numpy as np
from scipy.spatial import cKDTree

sys.path.insert(0, os.path.dirname(__file__))
from sfm import Scene, area_center, load_sfm  # noqa: E402

name = sys.argv[1]
area = json.load(open(f"areas/{name}.json"))
out = f"data/derived/focus/{name}"
os.makedirs(out, exist_ok=True)
cx, cy = area_center(area)
scene = Scene()
city = scene.city
P, C, K, shots, meta = load_sfm(name)
R = area["photoRadius"] + 20

# Footprint walls, sampled every 0.25 m, with their normals.
wp, wn = [], []
for b in city["buildings"]:
    ring = [(b["o"][i], b["o"][i + 1]) for i in range(0, len(b["o"]), 2)]
    if min(math.hypot(x - cx, y - cy) for x, y in ring) > R + 40:
        continue
    for a, c in zip(ring, ring[1:] + ring[:1]):
        L = math.hypot(c[0] - a[0], c[1] - a[1])
        if L < 1:
            continue
        nx, ny = (c[1] - a[1]) / L, -(c[0] - a[0]) / L
        for t in np.arange(0, L, 0.25):
            wp.append((a[0] + (c[0] - a[0]) * t / L, a[1] + (c[1] - a[1]) * t / L))
            wn.append((nx, ny))
wp, wn = np.array(wp), np.array(wn)
tree = cKDTree(wp)

# Vertical alignment as in build-focus (cameras 1.5 m above ground).
dz = {}
for k in range(len(meta)):
    cams = np.array([c for (kk, c, _) in shots.values() if kk == k])
    if len(cams):
        dz[k] = float(np.median(cams[:, 2] - scene.ground(cams[:, 0], cams[:, 1])) - 1.5)
Z = P[:, 2] - np.array([dz.get(k, 0) for k in K])
above = Z - scene.ground(P[:, 0], P[:, 1])
green = (C[:, 1] > C[:, 0] + 8) & (C[:, 1] > C[:, 2] + 4)
cand = (np.hypot(P[:, 0] - cx, P[:, 1] - cy) < R) & (above > 3) & (above < 20) & ~green


def solve(src, dst, nrm, w):
    """Weighted point-to-line least squares for (theta, tx, ty) about the origin of src."""
    x, y = src[:, 0], src[:, 1]
    # residual r = n . (R p + t - q); linearised R ~ [[1, -th], [th, 1]]
    A = np.c_[nrm[:, 1] * x - nrm[:, 0] * y, nrm[:, 0], nrm[:, 1]]
    b = -(nrm[:, 0] * (x - dst[:, 0]) + nrm[:, 1] * (y - dst[:, 1]))
    # Damped normal equations: point-to-line leaves sliding along a straight wall unconstrained,
    # so small damping keeps the solution from drifting along it.
    AtA = (A * w[:, None]).T @ A + np.diag([50.0, 0.5, 0.5]) * w.sum() / len(w) * 0.05
    Atb = (A * w[:, None]).T @ b
    sol = np.linalg.solve(AtA, Atb)
    sol[0] = np.clip(sol[0], -math.radians(0.5), math.radians(0.5))
    sol[1:] = np.clip(sol[1:], -1.0, 1.0)
    return sol


result = {}
for k, m in enumerate(meta):
    sel = cand & (K == k)
    if sel.sum() < 60:
        continue
    pts = P[sel, :2].copy()
    c0 = pts.mean(axis=0)
    src = pts - c0
    total = np.array([0.0, 0.0, 0.0])  # theta, tx, ty (about c0)
    d0, _ = tree.query(pts)
    before = float(np.median(d0[d0 < 8])) if (d0 < 8).any() else None
    # Coarse search first (ICP alone gets trapped matching to the wrong walls when it starts
    # metres off): shifts within +-6 m, rotations within +-3 deg, truncated distance score.
    rng = np.random.default_rng(k)
    sub = src[rng.choice(len(src), min(400, len(src)), replace=False)]
    best = (np.inf, 0.0, 0.0, 0.0)
    # Wall distance only constrains position across walls; along a street the fit can slide for
    # free, so every metre moved from the GPS position costs a little.
    angles = np.radians(np.arange(-3, 3.01, 1.0)) if before is None or before > 0.6 else [0.0]
    span = np.arange(-6, 6.01, 0.5) if before is None or before > 0.6 else [0.0]
    for th in angles:
        rot = np.array([[math.cos(th), -math.sin(th)], [math.sin(th), math.cos(th)]])
        rs = sub @ rot.T + c0
        for tx in span:
            for ty in span:
                d, _ = tree.query(rs + [tx, ty])
                sc = np.minimum(d, 2.0).mean() + 0.03 * math.hypot(tx, ty)
                if sc < best[0]:
                    best = (sc, th, tx, ty)
    th, tx, ty = best[1:]
    rot = np.array([[math.cos(th), -math.sin(th)], [math.sin(th), math.cos(th)]])
    cur = src @ rot.T + [tx, ty]
    thresh = 3.0
    for it in range(25):
        d, idx = tree.query(cur + c0)
        keep = d < thresh
        if keep.sum() < 30:
            break
        # trimmed: best 70% of the in-threshold matches
        cut = np.percentile(d[keep], 70)
        keep &= d <= cut
        q, nrm = wp[idx[keep]] - c0, wn[idx[keep]]
        w = 1.0 / np.maximum(d[keep], 0.3)
        th, tx, ty = solve(cur[keep], q, nrm, w)
        rot = np.array([[math.cos(th), -math.sin(th)], [math.sin(th), math.cos(th)]])
        cur = cur @ rot.T + [tx, ty]
        total[0] += th
        thresh = max(1.5, thresh * 0.8)
    # total transform: compose by refitting src -> cur exactly (rigid Procrustes)
    H = src.T @ cur
    U, _, Vt = np.linalg.svd(H)
    Rm = (U @ Vt).T
    if np.linalg.det(Rm) < 0:
        Vt[-1] *= -1
        Rm = (U @ Vt).T
    theta = math.atan2(Rm[1, 0], Rm[0, 0])
    shift = (cur - src @ Rm.T).mean(axis=0)
    d1, _ = tree.query(cur + c0)
    after = float(np.median(d1[d1 < 8])) if (d1 < 8).any() else None
    # Conservative: already-good clusters stay put (any move would be along-wall sliding), and a
    # correction must clearly improve the fit.
    ok = (after is not None and before is not None and np.isfinite(shift).all() and before > 0.45
          and after < before * 0.8 and after < 1.5 and abs(theta) < math.radians(4)
          and (math.hypot(*shift) < 7 or (math.hypot(*shift) < 10 and after < before * 0.5)))
    raw = (round(float(shift[0]), 2), round(float(shift[1]), 2), round(math.degrees(theta), 2))
    if not ok:
        shift, theta = np.array([0.0, 0.0]), 0.0
    cid = os.path.basename(m["file"])[:-5]
    result[cid] = {"dx": round(float(shift[0]), 3), "dy": round(float(shift[1]), 3), "theta": round(theta, 5),
                   "cx": round(float(c0[0]), 2), "cy": round(float(c0[1]), 2), "before": before and round(before, 2),
                   "after": after and round(after, 2), "n": int(sel.sum()), "ok": bool(ok)}
    print(f"{cid}: n={sel.sum():5d} wall distance {before if before is not None else float('nan'):.2f} -> "
          f"{after if after is not None else float('nan'):.2f} m, shift ({shift[0]:+.2f}, {shift[1]:+.2f}) m, "
          f"rotation {math.degrees(theta):+.2f} deg {'OK' if ok else 'rejected ' + str(raw)}")
json.dump(result, open(f"{out}/registration.json", "w"), indent=1)
