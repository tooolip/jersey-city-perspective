"""Photo-textures building walls in a focus area from its Mapillary photos.

For each wall (footprint edge) of each building near the area:
  1. candidate photos: camera in front of the wall, 3-45 m away, wall in frame, not grazing;
     photos from reconstructions that failed registration badly are left out;
  2. every 4 cm texel of the wall is projected into each photo with its registered pose
     (scripts/focus/register.py -> build-focus.py); texels hidden behind other buildings, sky
     (connected to the top of the frame) and everything above the roofline are dropped. Where a
     photo shows sky across the top of the wall, its sample is stretched up so its cornice meets
     the model's (LiDAR) top;
  3. per photo, masks of what stands in front of the wall: mapped poles, lamps, signals, signs
     and LiDAR tree trunks (ray tests), crowns, bare branches (black top-hat), sign-coloured
     blobs and glare. A masked sample is only set aside when another photo saw that texel clear;
  4. photos are brought to a common exposure on the texels they share; per texel, with 3+
     photos the sample closest to the others (medoid, near-duplicate views not vouching for each
     other) wins, else the best-weighted; choices are smoothed into coherent patches;
  5. street signs every view sees and large glare patches are cut out; holes are filled from
     their surroundings (push-pull), fading to the wall's median colour far from any data.
Walls whose overlapping photos disagree (content not on the wall plane) are left to the facade
kits. Textures are packed into atlas pages.

Writes public/data/focus/<name>/facades.json + facades-<page>.jpg, and a debug sheet in
data/derived/focus/<name>/facades_debug.jpg. DEBUG_WALL=<building id>:<edge> also dumps that
wall's per-photo samples (sky blue, occluders red, roofline red) and photo choice there.
Usage: .venv/bin/python -I scripts/focus/facades.py example-area
"""
import json
import math
import os
import sys
import warnings

import numpy as np
from PIL import Image
from scipy import ndimage

sys.path.insert(0, os.path.dirname(__file__))
from sfm import Scene, area_center  # noqa: E402

# NaN texels (unseen) trip spurious matmul warnings in numpy on Apple Accelerate
warnings.filterwarnings("ignore", message=".*encountered in matmul")

TEXEL = 0.04  # m
MAX_PHOTOS = 8
PER_SEQUENCE = 2  # viewpoint diversity: parallax moves branches/poles across the wall
TARGET_LUM = 118  # finished walls are lifted to a normal exposure (backlit winter photos)
PAGE = 4096
MIN_COVER = 0.25  # fraction of a wall some photo must see
MIN_AGREE = 0.3  # correlation between overlapping views below which a wall isn't what they show

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

# Photos from reconstructions that failed registration and sit metres off the walls project the
# wrong part of the photo (sky over the roofline, the street over the base): left out.
reg = json.load(open(f"data/derived/focus/{name}/registration.json"))
cluster = {im["id"]: im.get("sfm_cluster") for im in json.load(open(f"data/raw/focus/{name}/images.json"))}
bad = {c for c, r in reg.items() if not r["ok"] and (r["before"] is None or r["before"] > 1.2)}
photos = [p for p in focus["photos"] if os.path.exists(f"public/data/focus/{name}/photos/{p['id']}.jpg") and cluster.get(p["id"]) not in bad]
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


LUMW = np.array([0.299, 0.587, 0.114], np.float32)
_sky = {}


def sky_mask(pid):
    """Sky in a photo: bright grey or blue regions connected to the top of the frame (a white wall
    or a window reflecting the sky isn't). Closing first, so bare branches against the sky count
    as sky too. Quarter resolution."""
    if pid not in _sky:
        img = load(pid)[::4, ::4]
        lum = img @ LUMW
        sat = (img.max(2) - img.min(2)) / (img.max(2) + 1)
        cand = ((lum > 165) & (sat < 0.2)) | ((img[..., 2] > img[..., 0] * 1.08) & (img[..., 2] >= img[..., 1]) & (lum > 130))
        cand = ndimage.binary_closing(np.pad(cand, 3, mode="edge"), iterations=2)[3:-3, 3:-3]
        lab, _ = ndimage.label(cand)
        top = np.unique(lab[0][lab[0] > 0])
        _sky[pid] = np.isin(lab, top)
        if len(_sky) > 60:
            _sky.pop(next(iter(_sky)))
    return _sky[pid]


# Things standing between the cameras and the walls: (e, n, radius, z bottom, z top) cylinders.
# Mapped positions are only good to about a metre, so radii are generous; a masked sample is only
# set aside when another photo saw that texel clear (see the combine step).
hard_occ, soft_occ = [], []
SIZES = {"pole": (0.4, 0, 10), "lamp": (0.35, 0, 8), "signal": (0.35, 0, 6), "pedsignal": (0.3, 0, 3.5),
         "sign": (0.45, 1.6, 3.6), "cabinet": (0.6, 0, 1.5), "trash": (0.45, 0, 1.2)}
for f in city["furniture"]:
    if f["k"] in SIZES and math.hypot(f["x"] - cx, f["y"] - cy) < area["photoRadius"] + 30:
        r, zl, zh = SIZES[f["k"]]
        hard_occ.append((f["x"], f["y"], r, zl, zh))
for key, kind in (("lamps", "lamp"), ("signals", "signal")):
    arr = city.get(key, [])
    for i in range(0, len(arr), 2):
        if math.hypot(arr[i] - cx, arr[i + 1] - cy) < area["photoRadius"] + 30:
            r, zl, zh = SIZES[kind]
            hard_occ.append((arr[i], arr[i + 1], r, zl, zh))
lt = city.get("lidarTrees", [])
for i in range(0, len(lt), 5):
    e_, n_, gz, h, cr = lt[i:i + 5]
    if math.hypot(e_ - cx, n_ - cy) < area["photoRadius"] + 30:
        hard_occ.append((e_, n_, 0.35, -1, max(2.5, 0.4 * h)))  # trunk (heights relative to ground)
        soft_occ.append((e_, n_, cr, 0.3 * h, h + 0.5))  # crown: leaf-off in the photos, see-through
hard_occ, soft_occ = np.array(hard_occ, float), np.array(soft_occ, float)
for arr in (hard_occ, soft_occ):
    if len(arr):
        g = scene.ground(arr[:, 0], arr[:, 1])
        arr[:, 3] += g
        arr[:, 4] += g


def occluded(cam, X, occ):
    """Rays camera -> X (N,3) passing through any of the cylinders."""
    hit = np.zeros(len(X), bool)
    if not len(occ):
        return hit
    dX = X - cam
    reach = np.hypot(dX[:, 0], dX[:, 1]).max() + 1
    near = occ[np.hypot(occ[:, 0] - cam[0], occ[:, 1] - cam[1]) < reach]
    d2 = (dX[:, :2] ** 2).sum(1)
    for o in near:
        w = o[:2] - cam[:2]
        t = (dX[:, :2] @ w) / np.maximum(d2, 1e-6)
        ok = (t > 0) & (t < 0.97)  # strictly in front of the wall
        px = dX[:, 0] * t - w[0]
        py = dX[:, 1] * t - w[1]
        z = cam[2] + dX[:, 2] * t
        hit |= ok & (px * px + py * py < o[2] ** 2) & (z > o[3]) & (z < o[4])
    return hit


def push_pull(img, w):
    """Fills unweighted texels smoothly from their surroundings (multi-scale averaging)."""
    if min(img.shape[:2]) <= 2 or w.all():
        return np.where(w[..., None] > 0, img, (img * w[..., None]).sum((0, 1)) / max(w.sum(), 1e-6))
    h, wd = img.shape[:2]
    H2, W2 = (h + 1) // 2 * 2, (wd + 1) // 2 * 2
    ip = np.zeros((H2, W2, 3), np.float32)
    wp_ = np.zeros((H2, W2), np.float32)
    ip[:h, :wd] = img * w[..., None]
    wp_[:h, :wd] = w
    sw = wp_.reshape(H2 // 2, 2, W2 // 2, 2).sum((1, 3))
    si = ip.reshape(H2 // 2, 2, W2 // 2, 2, 3).sum((1, 3))
    lo = push_pull(si / np.maximum(sw, 1e-6)[..., None], np.minimum(sw, 1))
    up = ndimage.zoom(lo, (2, 2, 1), order=1)[:h, :wd]
    up = np.pad(up, ((0, h - up.shape[0]), (0, wd - up.shape[1]), (0, 0)), mode="edge")
    return img * w[..., None] + up * (1 - w[..., None])


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
        # coarse copy of the texel grid for the (slower) occluder ray tests
        CS = 4
        Xg = X.reshape(nv, nu, 3)
        Xc_ = Xg[CS // 2::CS, CS // 2::CS].reshape(-1, 3)
        cshape = Xg[CS // 2::CS, CS // 2::CS].shape[:2]

        def upsample(m):
            m = np.repeat(np.repeat(m.reshape(cshape), CS, 0), CS, 1)[:nv, :nu]
            return np.pad(m, ((0, nv - m.shape[0]), (0, nu - m.shape[1])), mode="edge").ravel()

        samples, weights, hards, softs, used = [], [], [], [], []
        stretched = []
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
            # Sky (where our wall runs higher than the building in the photo) isn't wall, and nor is
            # anything above it in that column: wires, branches and the roofline's soft edge.
            sm = sky_mask(p["id"])
            sky = np.zeros(len(X), bool)
            sky[ok] = sm[np.clip((vv[ok] / 4).astype(int), 0, sm.shape[0] - 1), np.clip((u[ok] / 4).astype(int), 0, sm.shape[1] - 1)]
            px = col[ok]
            lum_ = px @ LUMW
            sat_ = (px.max(1) - px.min(1)) / (px.max(1) + 1)
            loose = np.zeros(len(X), bool)  # isolated bright grey / blue texels (the old test)
            loose[ok] = ((lum_ > 175) & (sat_ < 0.18)) | ((px[:, 2] > px[:, 0] * 1.1) & (px[:, 2] >= px[:, 1]) & (lum_ > 140))
            sg = sky.reshape(nv, nu)
            # Roofline per column: the first run of 32 cm of in-frame, non-sky texels from the top,
            # in columns with sky above it (sky lower down, in windows, is only masked).
            solid = (~sg & ok.reshape(nv, nu)).astype(np.float32)
            solid = ndimage.uniform_filter1d(solid, 8, axis=0, origin=-3, mode="constant") > 0.99
            first = np.where(solid.any(0), np.argmax(solid, 0), -1)
            lowest = np.array([first[c_] if first[c_] > 0 and sg[: first[c_], c_].any() else -1 for c_ in range(nu)])
            lowest[lowest > 0.6 * nv] = -1
            above = np.arange(nv)[:, None] < (lowest[None, :] + 2)
            if os.environ.get("DEBUG_WALL") == f"{b['id']}:{k}":
                dbg = np.nan_to_num(col.reshape(nv, nu, 3)).astype(np.uint8).copy()
                dbg[sg] = (dbg[sg] * 0.5 + np.array([0, 0, 255]) * 0.5).astype(np.uint8)
                for c_ in range(nu):
                    if lowest[c_] >= 0:
                        dbg[lowest[c_], c_] = (255, 0, 0)
                hm = upsample(occluded(p["C"], Xc_, hard_occ)).reshape(nv, nu)
                dbg[hm] = (dbg[hm] * 0.5 + np.array([255, 0, 0]) * 0.5).astype(np.uint8)
                Image.fromarray(dbg).save(f"data/derived/focus/{name}/dbg_{p['id']}.png")
                print(p["id"], "lowest med", np.median(lowest[lowest >= 0]) / nv if (lowest >= 0).any() else None, (lowest >= 0).sum(), nu)
            col[(above | sg).ravel() | loose] = np.nan
            hard = occluded(p["C"], Xc_, hard_occ)
            soft = occluded(p["C"], Xc_, soft_occ)
            hard, soft = upsample(hard), upsample(soft)
            # Roofline: the model's heights match the LiDAR, so when this photo shows sky across the
            # top of the wall its pose is off. Typically the reconstruction's scale or the camera's
            # distance from the wall is: that scales heights about the camera, roughly about the
            # wall's base. Fit the sky edge as a line across the wall (a slight yaw or roll tilts
            # it) and stretch this photo's sample up from the base so its cornice meets the top.
            seen_cols = ~np.isnan(col.reshape(nv, nu, 3)[..., 0]).all(0) | (lowest >= 0)
            sc_ = np.flatnonzero(lowest >= 0)
            if len(sc_) >= max(8, 0.3 * seen_cols.sum()):
                fit = np.polyfit(sc_, lowest[sc_], 1)
                for _ in range(2):  # drop columns where the edge is a tree or a taller building behind
                    res_ = np.abs(np.polyval(fit, sc_) - lowest[sc_])
                    keep_ = res_ <= max(4, np.percentile(res_, 70))
                    fit = np.polyfit(sc_[keep_], lowest[sc_][keep_], 1)
                rc = np.clip(np.polyval(fit, np.arange(nu)) + 2, 0, 0.45 * nv)
                # only a clean, straight edge: glare and haze give ragged false ones
                clean_edge = np.median(np.abs(np.polyval(fit, sc_) - lowest[sc_])) <= max(3, 0.03 * nv)
                if clean_edge and np.median(rc) > 0.02 * nv:
                    j = np.arange(nv)[:, None]
                    src = rc[None, :] + j * (nv - 1 - rc[None, :]) / (nv - 1)
                    cc = np.broadcast_to(np.arange(nu)[None, :], (nv, nu))
                    g3 = col.reshape(nv, nu, 3)
                    col = np.stack([ndimage.map_coordinates(g3[..., ch], [src, cc], order=1, cval=np.nan) for ch in range(3)], -1).reshape(-1, 3)
                    hard = ndimage.map_coordinates(hard.reshape(nv, nu).astype(np.float32), [src, cc], order=0) > 0.5
                    soft = ndimage.map_coordinates(soft.reshape(nv, nu).astype(np.float32), [src, cc], order=0) > 0.5
                    hard, soft = hard.ravel(), soft.ravel()
                    stretched.append(float(np.median(rc)) / nv)
            # Prefer well-exposed views (backlit shots leave the wall in deep shadow).
            wall_lum = np.nanmedian(col @ LUMW) if (~np.isnan(col[:, 0])).any() else 0
            samples.append(col)
            used.append(p)
            weights.append(w * float(np.clip(wall_lum / 90, 0.3, 1.5)))
            hards.append(hard)
            softs.append(soft)
        if not samples:
            continue
        S = np.stack(samples)  # (P, N, 3)
        valid = ~np.isnan(S[..., 0])
        cover = valid.any(axis=0).mean()
        if cover < MIN_COVER:
            continue
        # exposure: scale each photo to the median luminance on texels shared with the others
        lum = S @ LUMW
        ref = np.nanmedian(np.where(valid, lum, np.nan), axis=0)
        for i in range(len(S)):
            m = valid[i] & ~np.isnan(ref)
            if m.sum() > 100:
                g = np.clip(np.nanmedian(ref[m]) / max(np.nanmedian(lum[i][m]), 1), 0.6, 1.7)
                S[i] *= g
        lum = S @ LUMW
        # Image cues per photo, on the rectified wall: bare branches are thin dark lines (black
        # top-hat, ~36 cm element) and glare blows texels out; street signs are small saturated
        # blobs at sign height.
        branch, signb = np.zeros_like(valid), np.zeros_like(valid)
        rows_z = np.repeat(zs, nu) - z0
        for i in range(len(S)):
            Lg = np.where(valid[i], lum[i], np.nan).reshape(nv, nu)
            Lf = np.where(np.isnan(Lg), np.nanmedian(Lg) if valid[i].any() else 0, Lg)
            cl = ndimage.grey_closing(Lf, size=(9, 9))
            th = (cl - Lf > 22) & (cl - Lf > 0.2 * cl)
            branch[i] = ndimage.binary_dilation(th, iterations=1).ravel()
            px = np.nan_to_num(S[i])
            sat = (px.max(1) - px.min(1)) / (px.max(1) + 1)
            blown = valid[i] & (lum[i] > 215) & (sat < 0.1)  # sun glare, haze
            if blown.sum() > 0.1 * max(valid[i].sum(), 1):  # a glary view: its white isn't wall
                valid[i] &= ~blown
                S[i][blown] = np.nan
            branch[i] |= blown
            blob = ((sat > 0.5) & (px.max(1) > 70) & (rows_z > 1.3) & (rows_z < 4)).reshape(nv, nu)
            lab, nl = ndimage.label(ndimage.binary_closing(blob, iterations=2))
            if nl:
                sizes = ndimage.sum(np.ones_like(lab), lab, index=np.arange(1, nl + 1)) * TEXEL * TEXEL
                keep = np.flatnonzero((sizes > 0.04) & (sizes < 1.5)) + 1
                signb[i] = ndimage.binary_dilation(np.isin(lab, keep), iterations=3).ravel()
        hard, soft = np.stack(hards), np.stack(softs)
        # Use the cleanest samples each texel has: a mask only rules a sample out when some other
        # photo saw the texel without it. Wall details flagged in every view (railings, a painted
        # sign) so fall back to all views, while branches, poles and signs, which parallax moves
        # across the wall from view to view, get replaced.
        V = valid.copy()
        for tier in (valid & ~hard, valid & ~hard & ~branch, valid & ~hard & ~branch & ~signb,
                     valid & ~hard & ~branch & ~signb & ~soft):
            has = tier.any(axis=0)
            V = np.where(has[None], tier, V)
        # combine: medoid of 3+ samples, else best-weighted available
        Wt = np.array(weights)[:, None] * V
        best = np.argmax(Wt, axis=0)
        # Photos taken within a few metres of each other see foreground things (signs, poles) at
        # the same spot on the wall, so they don't get to vouch for each other.
        cams = np.array([p["C"] for p in used])
        near_cam = np.hypot(*(cams[:, None, :2] - cams[None, :, :2]).transpose(2, 0, 1)) < 3.0
        multi = V.sum(axis=0) >= 3
        if multi.any():
            Sm = S[:, multi]
            Vm = V[:, multi]
            D = np.zeros((len(S), multi.sum()), np.float32)
            for i in range(len(S)):
                diff = np.minimum(np.abs(Sm - Sm[i][None]).sum(axis=2), 200)
                others = Vm & ~near_cam[i][:, None]
                D[i] = np.where(others, diff, 0).sum(axis=0) / np.maximum(others.sum(0), 1) + np.where(Vm[i] & others.any(0), 0, 1e9)
            pick = np.argmin(D, axis=0)
            ok_ = D[pick, np.arange(multi.sum())] < 1e9  # else every view is a near-duplicate: best-weighted
            best[np.flatnonzero(multi)[ok_]] = pick[ok_]
        # Coherent patches instead of per-texel speckle: each texel takes the photo most chosen
        # around it (28 cm window) among the ones it may use.
        seen = V.any(axis=0)
        votes = np.stack([ndimage.uniform_filter((best == i).reshape(nv, nu).astype(np.float32), 7).ravel()
                          for i in range(len(S))])
        votes[~V] = -1
        best = np.argmax(votes, axis=0)
        out = S[best, np.arange(S.shape[1])]
        out[~seen] = np.nan
        if os.environ.get("DEBUG_WALL") == f"{b['id']}:{k}":
            pal = np.array([[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [255, 0, 255], [0, 255, 255], [255, 255, 255], [128, 128, 128]], np.uint8)
            lbl = pal[best % 8].reshape(nv, nu, 3).copy()
            lbl[~seen.reshape(nv, nu)] = 0
            Image.fromarray(lbl).save(f"data/derived/focus/{name}/dbg_label.png")
        # Street signs every view sees (close to the wall, little parallax): compact blobs of traffic
        # yellow or red at sign height, clearly more so than the wall around them. Hue ratios, not
        # brightness, since backlit signs are dark. Lintels and sills share the colour but are thin
        # bars, so a blob must be sign-shaped. Cut out and filled from the wall around them.
        og = np.nan_to_num(out).reshape(nv, nu, 3)
        r_, g_, b_ = og[..., 0] + 1, og[..., 1] + 1, og[..., 2] + 1
        yel = ((r_ + g_) / 2 - b_) / ((r_ + g_) / 2)
        yel_bg = ndimage.median_filter(yel[::3, ::3], size=(21, 21)).repeat(3, 0).repeat(3, 1)[:nv, :nu]  # ~2.5 m around
        traffic = ((g_ > 0.7 * r_) & (g_ < 1.15 * r_) & (yel > 0.05) & (yel > yel_bg + 0.25) & (r_ + g_ > 40)) \
            | ((g_ < 0.35 * r_) & (b_ < 0.4 * r_) & (r_ > 40))
        traffic &= seen.reshape(nv, nu) & ((rows_z > 1.0) & (rows_z < 4.5)).reshape(nv, nu)
        blobs = ndimage.binary_fill_holes(ndimage.binary_closing(np.pad(traffic, 5), iterations=5))[5:-5, 5:-5]
        lab, nl = ndimage.label(blobs)
        cut = np.zeros((nv, nu), bool)
        for li, sl in enumerate(ndimage.find_objects(lab), 1):
            if sl is None:
                continue
            hh, ww = (sl[0].stop - sl[0].start) * TEXEL, (sl[1].stop - sl[1].start) * TEXEL
            area_ = (lab[sl] == li).sum() * TEXEL * TEXEL
            if 0.35 <= hh <= 2.0 and 0.35 <= ww <= 3.0 and area_ >= 0.35 * hh * ww:  # a sign or two on a post
                cut[sl] |= lab[sl] == li
        # Haze and glare from views shot into the sun: large smooth patches far brighter than the
        # wall and colourless (windows reflecting the sky are smaller and framed).
        lum_o = og @ LUMW
        med_o = np.median(lum_o[seen.reshape(nv, nu)]) if seen.any() else 0
        sat_o = (og.max(2) - og.min(2)) / (og.max(2) + 1)
        sd = np.sqrt(np.maximum(ndimage.uniform_filter(lum_o ** 2, 7) - ndimage.uniform_filter(lum_o, 7) ** 2, 0))
        haze = seen.reshape(nv, nu) & (lum_o > 1.8 * med_o + 10) & (sat_o < 0.15) & (sd < 0.12 * lum_o + 2)
        lab, nl = ndimage.label(ndimage.binary_closing(haze, iterations=2))
        if nl:
            sizes = ndimage.sum(np.ones_like(lab), lab, index=np.arange(1, nl + 1)) * TEXEL * TEXEL
            cut |= np.isin(lab, np.flatnonzero(sizes > 2.0) + 1)
        cut = ndimage.binary_dilation(cut, iterations=3).ravel()
        out[cut] = np.nan
        seen = seen & ~cut
        if nl:
            sizes = ndimage.sum(np.ones_like(lab), lab, index=np.arange(1, nl + 1)) * TEXEL * TEXEL
            cut = ndimage.binary_dilation(np.isin(lab, np.flatnonzero((sizes > 0.03) & (sizes < 1.5)) + 1), iterations=3).ravel()
            out[cut] = np.nan
            seen = seen & ~cut
        # Does the texture show this wall? Content on the wall plane lines up between photos (any
        # pair of views); things at another depth (an unmapped building or tree in front, a pose
        # that's off) shift by parallax and don't.
        agree = []
        for i in range(len(S)):
            for k2 in range(i + 1, len(S)):
                m = V[i] & V[k2]
                if m.sum() > 0.1 * len(m) and m.sum() > 400:
                    li = ndimage.gaussian_filter(np.where(m, lum[i], 0).reshape(nv, nu), 1.5).ravel()[m]
                    lk = ndimage.gaussian_filter(np.where(m, lum[k2], 0).reshape(nv, nu), 1.5).ravel()[m]
                    agree.append((float(np.corrcoef(li, lk)[0, 1]), int(m.sum())))
        ncc = float(np.average([a for a, _ in agree], weights=[c for _, c in agree])) if agree else None
        if ncc is not None and ncc < MIN_AGREE:
            print(f"  {b['id']}:{k} left to the facade kit: photos disagree (agreement {ncc:.2f})")
            continue
        fill = np.nanmedian(out[seen], axis=0)
        # Holes: smooth fill from the surroundings, fading to the wall's median colour far away.
        grid = push_pull(np.nan_to_num(out).reshape(nv, nu, 3), seen.reshape(nv, nu).astype(np.float32))
        dist = ndimage.distance_transform_edt(~seen.reshape(nv, nu)) * TEXEL
        fade = np.clip((dist - 0.5) / 1.5, 0, 1)[..., None]
        grid = grid * (1 - fade) + fill * fade
        # Lift to a normal exposure (scene lighting is applied on top), gently in the shadows.
        lum_all = grid @ LUMW
        gain = float(np.clip(TARGET_LUM / max(np.median(lum_all), 1), 0.8, 2.4))
        grid = 255 * np.power(np.clip(grid * gain / 255, 0, 1), 0.92)
        tex = np.clip(grid, 0, 255).astype(np.uint8)
        textures.append({"id": b["id"], "edge": k, "z0": round(z0, 2), "z1": round(z1, 2), "L": round(L, 2),
                         "img": tex, "cover": round(float(cover), 2), "photos": len(samples), "ids": [p["id"] for _, p in cands],
                         "multi": round(float(multi.mean()), 2), "roof": round(max(stretched, default=0), 2), "ncc": ncc and round(ncc, 2), "color": [int(v) for v in fill]})
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
                "cover": t["cover"], "photos": t["photos"], "multi": t["multi"], "roof": t["roof"], "ncc": t["ncc"], "ids": t["ids"]})
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
