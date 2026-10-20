"""Photo-textures building walls in a focus area from its Mapillary photos.

For each wall (footprint edge) of each building near the area:
  1. candidate photos: camera in front of the wall, 3-45 m away, wall in frame, not grazing;
  2. every 8 cm texel of the wall is projected into each photo with its registered pose
     (scripts/focus/register.py -> build-focus.py); texels hidden behind other buildings are
     skipped;
  3. photos are brought to a common exposure on the texels they share;
  4. per texel, with 3+ photos the sample closest to the others (medoid) wins, which drops cars,
     people and other things seen in only one photo; with fewer, the best-weighted photo wins.
Textures are packed into atlas pages; texels no photo saw get the wall's median colour.

Writes public/data/focus/<name>/facades.json + facades-<page>.jpg, and a debug sheet in
data/derived/focus/<name>/facades_debug.jpg.
Usage: .venv/bin/python -I scripts/focus/facades.py example-area
"""
import json
import math
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

sys.path.insert(0, os.path.dirname(__file__))
from sfm import Scene, area_center  # noqa: E402

TEXEL = 0.04  # m
MAX_PHOTOS = 6
PER_SEQUENCE = 2  # viewpoint diversity: parallax moves branches/poles across the wall
TARGET_LUM = 118  # finished walls are lifted to a normal exposure (backlit winter photos)
PAGE = 4096
MIN_COVER = 0.25  # fraction of a wall some photo must see

name = sys.argv[1]
area = json.load(open(f"areas/{name}.json"))
cx, cy = area_center(area)
scene = Scene()
city = scene.city
focus = json.load(open(f"public/data/focus/{name}/focus.json"))
tp = json.load(open(f"data/derived/focus/{name}/terrain.json"))["patch"]
mask = np.unpackbits(np.array(tp["mask"], np.uint8))[: tp["w"] * tp["h"]].reshape(tp["h"], tp["w"]).astype(bool)
top_grid = np.array(tp["top"], float).reshape(tp["h"], tp["w"]) / 100
low_grid = np.array(tp["low"], float).reshape(tp["h"], tp["w"]) / 100


def patch_cell(e, n):
    c, r = int(e - tp["e0"]), int(tp["n1"] - n)
    return (r, c) if 0 <= r < tp["h"] and 0 <= c < tp["w"] else None


def seat(ring):
    """Same rule as the viewer: mostly-on-plateau buildings stand on the plateau top."""
    cells = [patch_cell(x, y) for x, y in ring]
    on = [rc for rc in cells if rc and mask[rc]]
    if len(on) * 2 >= len(ring):
        return min(top_grid[rc] for rc in on)
    vals = []
    for (x, y), rc in zip(ring, cells):
        vals.append(low_grid[rc] if rc else float(scene.ground(np.array([x]), np.array([y]))[0]))
    return min(vals)


# ------------------------------------------------------------------ buildings and walls
blds = []
for b in city["buildings"]:
    ring = [(b["o"][i], b["o"][i + 1]) for i in range(0, len(b["o"]), 2)]
    if min(math.hypot(x - cx, y - cy) for x, y in ring) > area["radius"] + 30:
        continue
    base = seat(ring)
    ref = b["zb"] if b.get("zb") is not None and not b.get("est") and abs(b["zb"] - base) < 8 else base
    top = ref + b["h"]
    if top - base < 2.5:
        continue
    # outward normals need CCW order; keep data edge indices
    area2 = sum((ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]) for i, j in zip(range(len(ring)), [len(ring) - 1] + list(range(len(ring) - 1))))
    ccw = area2 > 0
    blds.append({"b": b, "ring": ring, "base": base, "top": top, "ccw": ccw})

occluders = []  # (ring, z_top) of every nearby building, for line-of-sight tests
for b in city["buildings"]:
    ring = [(b["o"][i], b["o"][i + 1]) for i in range(0, len(b["o"]), 2)]
    if min(math.hypot(x - cx, y - cy) for x, y in ring) < area["photoRadius"] + 30:
        occluders.append((np.array(ring), (b.get("zb") or 3) + b["h"], b.get("id")))

photos = [p for p in focus["photos"] if os.path.exists(f"public/data/focus/{name}/photos/{p['id']}.jpg")]
for p in photos:
    p["Rm"] = np.array(p["R"]).reshape(3, 3)
    p["C"] = np.array(p["c"])


def project(p, X, W, H):
    Xc = (X - p["C"]) @ p["Rm"].T
    z = Xc[:, 2]
    ok = z > 0.5
    xn, yn = Xc[:, 0] / np.where(ok, z, 1), Xc[:, 1] / np.where(ok, z, 1)
    r2 = xn * xn + yn * yn
    d = 1 + p["k1"] * r2 + p["k2"] * r2 * r2
    s = max(W, H)
    u = W / 2 + p["f"] * d * xn * s
    v = H / 2 + p["f"] * d * yn * s
    ok &= (u >= 1) & (u < W - 2) & (v >= 1) & (v < H - 2) & (r2 < 1.2)
    return u, v, ok


def blocked(cam, pts, self_id):
    """2D line of sight from camera to wall points, against other buildings' walls."""
    hit = np.zeros(len(pts), bool)
    P0 = cam[None, :2]
    for ring, ztop, oid in occluders:
        if oid == self_id:
            continue
        A, B = ring, np.roll(ring, -1, axis=0)
        # segment-segment intersection, all walls x all points
        d1 = pts[:, None, :] - P0[:, None, :]
        e = B - A
        den = d1[..., 0] * e[None, :, 1] - d1[..., 1] * e[None, :, 0]
        w = A[None, :, :] - P0[:, None, :]
        with np.errstate(divide="ignore", invalid="ignore"):
            t = (w[..., 0] * e[None, :, 1] - w[..., 1] * e[None, :, 0]) / den
            s = (w[..., 0] * d1[..., 1] - w[..., 1] * d1[..., 0]) / den
        cross = (t > 0.02) & (t < 0.98) & (s >= 0) & (s <= 1)
        hit |= cross.any(axis=1)
    return hit


_img = {}


def load(pid):
    if pid not in _img:
        _img[pid] = np.asarray(Image.open(f"public/data/focus/{name}/photos/{pid}.jpg").convert("RGB"), np.float32)
        if len(_img) > 60:
            _img.pop(next(iter(_img)))
    return _img[pid]


def bilinear(img, u, v):
    out = np.empty((len(u), 3), np.float32)
    for ch in range(3):
        out[:, ch] = ndimage.map_coordinates(img[..., ch], [v, u], order=1, mode="nearest")
    return out


# ------------------------------------------------------------------ texture each wall
textures = []
for bd in blds:
    b, ring = bd["b"], bd["ring"]
    for k in range(len(ring)):
        a, c = np.array(ring[k]), np.array(ring[(k + 1) % len(ring)])
        L = float(np.hypot(*(c - a)))
        if L < 2.0:
            continue
        d = (c - a) / L
        n = np.array([d[1], -d[0]]) if bd["ccw"] else np.array([-d[1], d[0]])
        z0, z1 = bd["base"], min(bd["top"], bd["base"] + 40)
        mid = (a + c) / 2
        # candidates
        cands = []
        for p in photos:
            v = p["C"][:2] - mid
            dist = float(np.hypot(*v))
            if dist < 3 or dist > 45 or v @ n < 1.0:
                continue
            cosang = (v @ n) / dist
            if cosang < 0.25:
                continue
            # A long or tall wall seen up close rarely has its centre in frame: probe a 5 x 3 grid.
            probe = np.array([[*(a + d * L * fu + n * 0.05), z0 + (z1 - z0) * fz] for fu in (0.1, 0.3, 0.5, 0.7, 0.9) for fz in (0.2, 0.5, 0.8)])
            u, vv, ok = project(p, probe, 1600, 1200)
            if ok.sum() < 2:
                continue
            w = cosang / max(dist, 6) * (1.3 if p.get("reg") else 1.0)
            cands.append((w, p))
        if not cands:
            continue
        cands.sort(key=lambda x: -x[0])
        picked, per_seq = [], {}
        for w, p in cands:
            sq = p.get("seq")
            if per_seq.get(sq, 0) >= PER_SEQUENCE:
                continue
            per_seq[sq] = per_seq.get(sq, 0) + 1
            picked.append((w, p))
            if len(picked) >= MAX_PHOTOS:
                break
        cands = picked
        nu, nv = max(2, int(L / TEXEL)), max(2, int((z1 - z0) / TEXEL))
        us = (np.arange(nu) + 0.5) / nu * L
        zs = z1 - (np.arange(nv) + 0.5) / nv * (z1 - z0)  # row 0 = top
        UU, ZZ = np.meshgrid(us, zs)
        X = np.c_[(a[0] + d[0] * UU + n[0] * 0.05).ravel(), (a[1] + d[1] * UU + n[1] * 0.05).ravel(), ZZ.ravel()]
        samples, weights = [], []
        for w, p in cands:
            img = load(p["id"])
            H, W = img.shape[:2]
            u, vv, ok = project(p, X, W, H)
            if ok.sum() < 50:
                continue
            # line of sight on a coarse set of columns, spread to all rows
            cols = np.linspace(0, nu - 1, max(2, int(L / 0.5))).astype(int)
            pts2 = np.c_[a[0] + d[0] * us[cols] + n[0] * 0.1, a[1] + d[1] * us[cols] + n[1] * 0.1]
            vis_cols = ~blocked(p["C"], pts2, b.get("id"))
            vis = np.interp(np.arange(nu), cols, vis_cols.astype(float)) > 0.5
            ok &= np.tile(vis, nv)
            col = np.full((len(X), 3), np.nan, np.float32)
            col[ok] = bilinear(img, u[ok], vv[ok])
            # Sky (where our wall runs higher than the building in the photo) isn't wall.
            px = col[ok]
            lum_ = px @ np.array([0.299, 0.587, 0.114], np.float32)
            sat_ = (px.max(1) - px.min(1)) / (px.max(1) + 1)
            sky = ((lum_ > 175) & (sat_ < 0.18)) | ((px[:, 2] > px[:, 0] * 1.1) & (px[:, 2] >= px[:, 1]) & (lum_ > 140))
            idx_ok = np.flatnonzero(ok)
            col[idx_ok[sky]] = np.nan
            # Prefer well-exposed views (backlit shots leave the wall in deep shadow).
            wall_lum = np.nanmedian(col @ np.array([0.299, 0.587, 0.114], np.float32)) if (~np.isnan(col[:, 0])).any() else 0
            samples.append(col)
            weights.append(w * float(np.clip(wall_lum / 90, 0.3, 1.5)))
        if not samples:
            continue
        S = np.stack(samples)  # (P, N, 3)
        valid = ~np.isnan(S[..., 0])
        cover = valid.any(axis=0).mean()
        if cover < MIN_COVER:
            continue
        # exposure: scale each photo to the median luminance on texels shared with the others
        lum = S @ np.array([0.299, 0.587, 0.114], np.float32)
        ref = np.nanmedian(np.where(valid, lum, np.nan), axis=0)
        for i in range(len(S)):
            m = valid[i] & ~np.isnan(ref)
            if m.sum() > 100:
                g = np.clip(np.nanmedian(ref[m]) / max(np.nanmedian(lum[i][m]), 1), 0.6, 1.7)
                S[i] *= g
        # combine: medoid of 3+ samples, else best-weighted available
        Wt = np.array(weights)[:, None] * valid
        out = np.full((S.shape[1], 3), np.nan, np.float32)
        best = np.argmax(Wt, axis=0)
        out[:] = S[best, np.arange(S.shape[1])]
        multi = valid.sum(axis=0) >= 3
        if multi.any():
            Sm = S[:, multi]
            Vm = valid[:, multi]
            D = np.zeros((len(S), multi.sum()), np.float32)
            for i in range(len(S)):
                diff = np.abs(Sm - Sm[i][None]).sum(axis=2)
                D[i] = np.where(Vm, diff, 0).sum(axis=0) + np.where(Vm[i], 0, 1e9)
            pick = np.argmin(D, axis=0)
            out[multi] = Sm[pick, np.arange(multi.sum())]
        seen = ~np.isnan(out[:, 0])
        fill = np.nanmedian(out[seen], axis=0)
        grid = out.reshape(nv, nu, 3)
        hole = ~seen.reshape(nv, nu)
        # Small gaps take the nearest seen texel; larger unseen areas the wall's median colour.
        dist, (ri, ci) = ndimage.distance_transform_edt(hole, return_indices=True)
        grid = grid[ri, ci]
        grid[dist * TEXEL > 1.0] = fill
        # Lift to a normal exposure (scene lighting is applied on top), gently in the shadows.
        lum_all = grid @ np.array([0.299, 0.587, 0.114], np.float32)
        gain = float(np.clip(TARGET_LUM / max(np.median(lum_all), 1), 0.8, 2.4))
        grid = 255 * np.power(np.clip(grid * gain / 255, 0, 1), 0.92)
        tex = np.clip(grid, 0, 255).astype(np.uint8)
        textures.append({"id": b["id"], "edge": k, "z0": round(z0, 2), "z1": round(z1, 2), "L": round(L, 2),
                         "img": tex, "cover": round(float(cover), 2), "photos": len(samples),
                         "multi": round(float(multi.mean()), 2), "color": [int(v) for v in fill]})
print(f"{len(textures)} walls textured from {len(photos)} photos")

# ------------------------------------------------------------------ pack into atlas pages
textures.sort(key=lambda t: -t["img"].shape[0])
pages, x, y, row_h = [np.zeros((PAGE, PAGE, 3), np.uint8)], 0, 0, 0
out = []
for t in textures:
    h, w = t["img"].shape[:2]
    if w > PAGE:  # very long walls: downscale to fit a page
        t["img"] = np.asarray(Image.fromarray(t["img"]).resize((PAGE, max(2, int(h * PAGE / w)))))
        h, w = t["img"].shape[:2]
    if x + w > PAGE:
        x, y, row_h = 0, y + row_h + 2, 0
    if y + h > PAGE:
        pages.append(np.zeros((PAGE, PAGE, 3), np.uint8))
        x, y, row_h = 0, 0, 0
    pages[-1][y:y + h, x:x + w] = t["img"]
    out.append({"id": t["id"], "edge": t["edge"], "z0": t["z0"], "z1": t["z1"], "page": len(pages) - 1,
                "uv": [x / PAGE, 1 - (y + h) / PAGE, (x + w) / PAGE, 1 - y / PAGE],
                "cover": t["cover"], "photos": t["photos"], "multi": t["multi"]})
    x += w + 2
    row_h = max(row_h, h)
dst = f"public/data/focus/{name}"
for i, pg in enumerate(pages):
    used = pg[: max(1, (y + row_h + 2) if i == len(pages) - 1 else PAGE)]
    Image.fromarray(pg).save(f"{dst}/facades-{i}.jpg", quality=86)
json.dump({"texel": TEXEL, "pages": len(pages), "walls": out}, open(f"{dst}/facades.json", "w"))
print(f"{len(pages)} atlas page(s); mean cover {np.mean([t['cover'] for t in out]):.2f}, "
      f"walls with 3+ photos on half their area: {sum(1 for t in out if t['multi'] > 0.5)}")

# debug: the 8 largest textures side by side
big = sorted(textures, key=lambda t: -t["img"].size)[:8]
sheet = Image.new("RGB", (1600, 1600), (30, 30, 30))
yy = 0
for t in big:
    im = Image.fromarray(t["img"])
    im.thumbnail((1600, 200))
    sheet.paste(im, (0, yy))
    yy += im.size[1] + 4
os.makedirs(f"data/derived/focus/{name}", exist_ok=True)
sheet.save(f"data/derived/focus/{name}/facades_debug.jpg", quality=85)
