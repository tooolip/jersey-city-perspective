"""Samples real facade colours from Mapillary street-level photos.

For each street-facing facade, picks the photos that look at it (camera in front, 5-32 m away,
facade in frame), projects points on the facade's upper floors into each photo using the
photo's computed camera pose (OpenSfM rotation + calibration), skips sightlines blocked by other
buildings or LiDAR tree crowns, and takes a robust colour from the pixels that aren't foliage,
sky or window glass. Colours must agree across photos to count as confident.

Reads public/data/city.json (+ terrain.bin), needs MAPILLARY_TOKEN (env or .env.local).
Writes data/derived/facades.json keyed by building id. Photos are cached in data/raw/mly_thumbs/.
Usage: .venv/bin/python -I scripts/fetch-facade-colours.py [--debug N]
"""
import io
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image, ImageDraw

BBOX = (-74.0560, 40.7160, -74.0270, 40.7330)
ORIGIN = (40.724, -74.042)
M_LAT = 111132.954 - 559.822 * math.cos(2 * ORIGIN[0] * math.pi / 180)
M_LON = 111412.84 * math.cos(ORIGIN[0] * math.pi / 180)
CACHE = "data/raw/mly_thumbs"
META = "data/raw/mapillary_images.json"
OUT = "data/derived/facades.json"
CAM_H = 1.6  # camera height above ground (phones / dash mounts)
PER_FACADE = 5
MIN_COS = 0.42  # reject grazing views (more than ~65 degrees off the facade normal)
MAX_DIST = 30
DEBUG = int(sys.argv[sys.argv.index("--debug") + 1]) if "--debug" in sys.argv else 0


def token():
    if os.environ.get("MAPILLARY_TOKEN"):
        return os.environ["MAPILLARY_TOKEN"]
    for line in open(".env.local"):
        if line.startswith("MAPILLARY_TOKEN="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("Set MAPILLARY_TOKEN")


TOKEN = token()
proj = lambda lon, lat: ((lon - ORIGIN[1]) * M_LON, (lat - ORIGIN[0]) * M_LAT)


def get_json(url, tries=5):
    for i in range(tries):
        try:
            return json.load(urllib.request.urlopen(url, timeout=60))
        except Exception as err:  # noqa: BLE001
            last = err
            time.sleep(1.5 * 2 ** i)
    raise RuntimeError(f"{url[:80]}: {last}")


# ------------------------------------------------------------------ scene data
city = json.load(open("public/data/city.json"))
tm = city["terrain"]
terr = np.fromfile("public/data/terrain.bin", np.int16).reshape(tm["h"], tm["w"]) / 100.0


def ground(e, n):
    fx, fy = (e - tm["e0"]) / tm["res"], (tm["n1"] - n) / tm["res"]
    if fx < 0 or fy < 0 or fx > tm["w"] - 1 or fy > tm["h"] - 1:
        return tm["fallback"]
    c, r = min(tm["w"] - 2, int(fx)), min(tm["h"] - 2, int(fy))
    tx, ty = fx - c, fy - r
    a, b, d, f = terr[r, c], terr[r, c + 1], terr[r + 1, c], terr[r + 1, c + 1]
    return (a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + f * tx) * ty


class Grid:
    def __init__(self, cell):
        self.cell, self.m = cell, {}

    def add(self, item, x0, y0, x1, y1):
        c = self.cell
        for gx in range(int(math.floor(x0 / c)), int(math.floor(x1 / c)) + 1):
            for gy in range(int(math.floor(y0 / c)), int(math.floor(y1 / c)) + 1):
                self.m.setdefault((gx, gy), []).append(item)

    def near(self, x, y, r=0):
        c, out, seen = self.cell, [], set()
        for gx in range(int(math.floor((x - r) / c)), int(math.floor((x + r) / c)) + 1):
            for gy in range(int(math.floor((y - r) / c)), int(math.floor((y + r) / c)) + 1):
                for it in self.m.get((gx, gy), ()):
                    if id(it) not in seen:
                        seen.add(id(it))
                        out.append(it)
        return out


def ccw(ring):
    a = sum((ring[i - 1][0] - ring[i][0]) * (ring[i - 1][1] + ring[i][1]) for i in range(len(ring)))
    return ring if a > 0 else ring[::-1]


buildings = []
bgrid = Grid(40)
for b in city["buildings"]:
    ring = ccw([(b["o"][i], b["o"][i + 1]) for i in range(0, len(b["o"]), 2)])
    xs, ys = [p[0] for p in ring], [p[1] for p in ring]
    rec = {"id": b["id"], "ring": ring, "h": b["h"], "base": min(ground(*p) for p in ring), "bb": (min(xs), min(ys), max(xs), max(ys))}
    buildings.append(rec)
    bgrid.add(rec, *rec["bb"])

rgrid = Grid(30)
CAR = {"primary", "secondary", "tertiary", "residential", "unclassified", "trunk", "living_street", "pedestrian", "service"}
for r in city["roads"]:
    if r["k"] not in CAR or r.get("e"):
        continue
    pts = [(r["p"][i], r["p"][i + 1]) for i in range(0, len(r["p"]), 2)]
    for a, b in zip(pts, pts[1:]):
        rgrid.add((a, b, r["w"] / 2), min(a[0], b[0]) - 20, min(a[1], b[1]) - 20, max(a[0], b[0]) + 20, max(a[1], b[1]) + 20)

tgrid = Grid(20)
lt = city.get("lidarTrees", [])
for i in range(0, len(lt), 5):
    e, n, z, h, r = lt[i:i + 5]
    tgrid.add((e, n, z, h, r), e - r, n - r, e + r, n + r)


def seg_dist(p, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    l2 = dx * dx + dy * dy or 1
    t = max(0, min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2))
    return math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)


def point_in(p, ring):
    x, y, inside = p[0], p[1], False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def segs_cross(p, q, a, b):
    d = lambda u, v, w: (v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0])
    return (d(p, q, a) > 0) != (d(p, q, b) > 0) and (d(a, b, p) > 0) != (d(a, b, q) > 0)


def blocked(cam, pt, z_pt, self_id):
    """Line of sight from camera to a facade point crosses another building or a tree crown."""
    mx, my = (cam[0] + pt[0]) / 2, (cam[1] + pt[1]) / 2
    rad = math.hypot(pt[0] - cam[0], pt[1] - cam[1]) / 2 + 2
    for b in bgrid.near(mx, my, rad):
        if b["id"] == self_id:
            continue
        ring = b["ring"]
        for i in range(len(ring)):
            if segs_cross(cam, pt, ring[i - 1], ring[i]):
                # Only if the obstacle is tall enough at that point to hide the sample.
                if b["base"] + b["h"] > z_pt - 1:
                    return True
                break
    for (e, n, z, h, r) in tgrid.near(mx, my, rad):
        # Leaf-off winter photos: bare branches reach past the LiDAR crown, so be generous.
        if seg_dist((e, n), cam, pt) < r * 1.2 + 0.5 and z + 2 < z_pt < z + h + 1.5:
            return True
    return False


def facades_of(b):
    ring, out = b["ring"], []
    for i in range(len(ring)):
        a, c = ring[i], ring[(i + 1) % len(ring)]
        L = math.hypot(c[0] - a[0], c[1] - a[1])
        if L < 3:
            continue
        nx, ny = (c[1] - a[1]) / L, -(c[0] - a[0]) / L
        mid = ((a[0] + c[0]) / 2, (a[1] + c[1]) / 2)
        probe = (mid[0] + nx * 5, mid[1] + ny * 5)
        if any(point_in(probe, o["ring"]) for o in bgrid.near(*probe) if o["id"] != b["id"]):
            continue
        if not any(seg_dist(probe, s[0], s[1]) - s[2] < 9 for s in rgrid.near(*probe)):
            continue
        out.append({"a": a, "c": c, "L": L, "n": (nx, ny), "mid": mid})
    return sorted(out, key=lambda f: -f["L"])[:2]


# ------------------------------------------------------------------ photo metadata
FIELDS = "id,captured_at,computed_geometry,computed_compass_angle,computed_rotation,camera_type,camera_parameters,width,height,sequence"
if os.path.exists(META):
    images = json.load(open(META))
else:
    images, tiles = {}, []
    step = 0.002
    x = BBOX[0]
    while x < BBOX[2]:
        y = BBOX[1]
        while y < BBOX[3]:
            tiles.append((x, y, min(x + step, BBOX[2]), min(y + step, BBOX[3])))
            y += step
        x += step

    def fetch_tile(t, depth=0):
        q = urllib.parse.urlencode({"access_token": TOKEN, "fields": FIELDS, "bbox": ",".join(f"{v:.6f}" for v in t), "limit": 2000})
        data = get_json(f"https://graph.mapillary.com/images?{q}").get("data", [])
        if len(data) >= 2000 and depth < 3:
            mx, my = (t[0] + t[2]) / 2, (t[1] + t[3]) / 2
            return sum((fetch_tile(s, depth + 1) for s in [(t[0], t[1], mx, my), (mx, t[1], t[2], my), (t[0], my, mx, t[3]), (mx, my, t[2], t[3])]), [])
        return data

    with ThreadPoolExecutor(6) as pool:
        for i, data in enumerate(pool.map(fetch_tile, tiles)):
            for im in data:
                if im.get("computed_rotation") and im.get("computed_geometry"):
                    images[im["id"]] = im
            if i % 20 == 0:
                print(f"  metadata tiles {i + 1}/{len(tiles)}, photos {len(images)}")
    json.dump(images, open(META, "w"))
print(f"photos with computed poses: {len(images)}")


def rodrigues(r):
    r = np.asarray(r, float)
    th = np.linalg.norm(r)
    if th < 1e-12:
        return np.eye(3)
    k = r / th
    K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + math.sin(th) * K + (1 - math.cos(th)) * K @ K


cams = []
igrid = Grid(30)
for im in images.values():
    # Street-level perspective photos only: panoramas here are often taken from rooftops, where
    # the assumed camera height is wrong.
    if im.get("camera_type") != "perspective":
        continue
    e, n = proj(*im["computed_geometry"]["coordinates"])
    # A camera standing inside a footprint was on a roof or balcony, not the street.
    if any(point_in((e, n), o["ring"]) for o in bgrid.near(e, n)):
        continue
    cp = im.get("camera_parameters") or [0.8, 0, 0]
    cam = {
        "id": im["id"], "e": e, "n": n, "z": ground(e, n) + CAM_H, "R": rodrigues(im["computed_rotation"]),
        "type": im["camera_type"], "f": cp[0], "k1": cp[1] if len(cp) > 1 else 0, "k2": cp[2] if len(cp) > 2 else 0,
        "w": im.get("width") or 4, "h": im.get("height") or 3, "seq": im.get("sequence"),
        "year": time.gmtime((im.get("captured_at") or 0) / 1000).tm_year,
    }
    cams.append(cam)
    igrid.add(cam, e, n, e, n)


def project(cam, e, n, z, tw, th):
    """World point -> thumbnail pixel (or None if behind / outside)."""
    Xc = cam["R"] @ np.array([e - cam["e"], n - cam["n"], z - cam["z"]])
    if cam["type"] == "perspective":
        if Xc[2] <= 0.5:
            return None
        xn, yn = Xc[0] / Xc[2], Xc[1] / Xc[2]
        r2 = xn * xn + yn * yn
        d = 1 + cam["k1"] * r2 + cam["k2"] * r2 * r2
        s = max(tw, th)
        px, py = tw / 2 + cam["f"] * d * xn * s, th / 2 + cam["f"] * d * yn * s
    else:
        lon = math.atan2(Xc[0], Xc[2])
        lat = -math.atan2(Xc[1], math.hypot(Xc[0], Xc[2]))
        px, py = (lon / (2 * math.pi) + 0.5) * tw, (0.5 - lat / math.pi) * th
    if not (2 <= px < tw - 2 and 2 <= py < th - 2):
        return None
    return px, py


def sample_points(b, fc):
    """Points on the lower upper floors: above parked cars and shopfronts, below cornices, roof
    edges and steeples (a building's recorded height is often its tallest point)."""
    lo = min(3.5, b["h"] * 0.4)
    hi = max(lo + 1, min(b["h"] * 0.6, 12))
    pts = []
    for t in (0.2, 0.35, 0.5, 0.65, 0.8):
        x = fc["a"][0] + (fc["c"][0] - fc["a"][0]) * t + fc["n"][0] * 0.15
        y = fc["a"][1] + (fc["c"][1] - fc["a"][1]) * t + fc["n"][1] * 0.15
        for u in (0.15, 0.45, 0.75):
            pts.append((x, y, b["base"] + lo + (hi - lo) * u))
    return pts


# ------------------------------------------------------------------ choose photos per facade
jobs = []  # (building, facade, cam)
for b in buildings:
    if b["h"] < 3:
        continue
    for fc in facades_of(b):
        cand = []
        for cam in igrid.near(*fc["mid"], 32):
            vx, vy = cam["e"] - fc["mid"][0], cam["n"] - fc["mid"][1]
            dist = math.hypot(vx, vy)
            if not 5 <= dist <= 32 or vx * fc["n"][0] + vy * fc["n"][1] < 3:
                continue
            zc = b["base"] + min(4.5, b["h"] * 0.6)
            if project(cam, fc["mid"][0], fc["mid"][1], zc, 1024, 768 if cam["type"] == "perspective" else 512) is None:
                continue
            headon = (vx * fc["n"][0] + vy * fc["n"][1]) / dist
            score = abs(dist - 13) / 13 + (1 - headon) + (2026 - cam["year"]) / 25
            cand.append((score, cam))
        cand.sort(key=lambda s: s[0])
        seqs = set()
        for _, cam in cand:
            if cam["seq"] in seqs:
                continue
            seqs.add(cam["seq"])
            jobs.append((b, fc, cam))
            if len(seqs) >= PER_FACADE:
                break
need = sorted({cam["id"] for _, _, cam in jobs})
print(f"facades with photos: {len({(id(b), id(fc)) for b, fc, _ in jobs})}, photo jobs {len(jobs)}, unique photos {len(need)}")

# ------------------------------------------------------------------ download thumbnails
os.makedirs(CACHE, exist_ok=True)
missing = [i for i in need if not os.path.exists(f"{CACHE}/{i}.jpg")]
for k in range(0, len(missing), 50):
    ids = missing[k:k + 50]
    q = urllib.parse.urlencode({"access_token": TOKEN, "ids": ",".join(ids), "fields": "thumb_256_url"})
    urls = get_json(f"https://graph.mapillary.com/?{q}")

    def dl(i):
        u = urls.get(i, {}).get("thumb_256_url")
        if not u:
            return
        try:
            data = urllib.request.urlopen(u, timeout=60).read()
            open(f"{CACHE}/{i}.jpg", "wb").write(data)
        except Exception:  # noqa: BLE001
            pass

    with ThreadPoolExecutor(12) as pool:
        list(pool.map(dl, ids))
    if (k // 50) % 20 == 0:
        print(f"  thumbnails {min(k + 50, len(missing))}/{len(missing)}")

# ------------------------------------------------------------------ sample colours
_img = {}


def load(i):
    if i not in _img:
        try:
            _img[i] = np.asarray(Image.open(f"{CACHE}/{i}.jpg").convert("RGB"), np.float32)
        except Exception:  # noqa: BLE001
            _img[i] = None
        if len(_img) > 400:
            _img.pop(next(iter(_img)))
    return _img[i]


def dominant(px, bin_size=22, radius=34):
    """Colour of the largest pixel cluster: the wall, rather than a blend of wall, window glass
    and trim."""
    q = (px // bin_size).astype(int)
    keys, counts = np.unique(q[:, 0] * 10000 + q[:, 1] * 100 + q[:, 2], return_counts=True)
    k = keys[np.argmax(counts)]
    centre = (np.array([k // 10000, (k // 100) % 100, k % 100]) + 0.5) * bin_size
    near = px[np.abs(px - centre).sum(axis=1) < radius * 1.5]
    return np.median(near if len(near) >= 8 else px, axis=0)


def usable(px):
    r, g, b = px[:, 0], px[:, 1], px[:, 2]
    luma = 0.299 * r + 0.587 * g + 0.114 * b
    veg = (g > r * 1.06) & (g > b * 1.04)
    sat = (np.max(px, axis=1) - np.min(px, axis=1)) / (np.max(px, axis=1) + 1)
    sky = ((b > r * 1.12) & (b >= g) & (luma > 120)) | ((luma > 205) & (sat < 0.12))
    glass = luma < 38
    blown = luma > 245
    return ~(veg | sky | glass | blown)


per_building = {}
debug_left = DEBUG
for b, fc, cam in jobs:
    img = load(cam["id"])
    if img is None:
        continue
    th, tw = img.shape[:2]
    # Exposure from the road surface in the lower centre of the frame (asphalt ~ sRGB 100).
    road = img[int(th * 0.82):int(th * 0.95), int(tw * 0.35):int(tw * 0.65)].reshape(-1, 3)
    road_l = float(np.median(road @ np.array([0.299, 0.587, 0.114]))) if len(road) else 100.0
    gain = float(np.clip(100.0 / max(road_l, 1), 0.85, 1.6))
    got, pts_px = [], []
    for (x, y, z) in sample_points(b, fc):
        vx, vy = cam["e"] - x, cam["n"] - y
        d = math.hypot(vx, vy)
        if d > MAX_DIST or (vx * fc["n"][0] + vy * fc["n"][1]) / (d or 1) < MIN_COS:
            continue
        if blocked((cam["e"], cam["n"]), (x, y), z, b["id"]):
            continue
        p = project(cam, x, y, z, tw, th)
        if p is None:
            continue
        cx, cy = int(p[0]), int(p[1])
        patch = img[max(0, cy - 2):cy + 3, max(0, cx - 2):cx + 3].reshape(-1, 3)
        # Busy patches (branches, wires, signs against the wall) aren't plain wall.
        if np.std(patch @ np.array([0.299, 0.587, 0.114])) > 26:
            continue
        patch = patch[usable(patch)] * gain
        if len(patch) >= 4:
            got.append(patch)
            pts_px.append(p)
    if len(got) < 6:
        continue
    px = np.concatenate(got)
    rec = per_building.setdefault(b["id"], {"px": [], "imgs": [], "years": []})
    rec["px"].append(px)
    rec["imgs"].append(dominant(px))
    rec["years"].append(cam["year"])
    if debug_left > 0:
        debug_left -= 1
        os.makedirs("data/raw/facade_debug", exist_ok=True)
        im = Image.fromarray(img.astype(np.uint8)).resize((tw * 3, th * 3))
        dr = ImageDraw.Draw(im)
        outline = [project(cam, *pt, tw, th) for pt in [(fc["a"][0], fc["a"][1], b["base"]), (fc["c"][0], fc["c"][1], b["base"]),
                                                       (fc["c"][0], fc["c"][1], b["base"] + b["h"]), (fc["a"][0], fc["a"][1], b["base"] + b["h"])]]
        if all(outline):
            dr.polygon([(u * 3, v * 3) for u, v in outline], outline=(255, 0, 0))
        for u, v in pts_px:
            dr.rectangle([u * 3 - 6, v * 3 - 6, u * 3 + 6, v * 3 + 6], outline=(0, 255, 255), width=2)
        c = tuple(int(v) for v in dominant(px))
        dr.rectangle([4, 4, 60, 40], fill=c, outline=(255, 255, 255))
        im.save(f"data/raw/facade_debug/{b['id']}_{cam['id']}.jpg")

def overcast_correct(rgb):
    """Most photos are grey-day captures (exposure is normalised per photo from the road); add a
    little saturation and lightness back so the colour reads as the wall's, not its overcast look."""
    import colorsys
    h, l, sat = colorsys.rgb_to_hls(*(np.clip(rgb, 0, 255) / 255))
    l = min(0.92, l * 1.05)
    sat = min(1.0, sat * 1.15)
    return np.array(colorsys.hls_to_rgb(h, l, sat)) * 255


hexc = lambda v: "#%02x%02x%02x" % tuple(int(round(min(255, max(0, x)))) for x in v)
out, mixed = {}, 0
for bid, rec in per_building.items():
    per_img = np.array(rec["imgs"])
    # Consensus: the largest group of photos whose colours agree (L1 distance < 45).
    groups = [[j for j in range(len(per_img)) if np.abs(per_img[j] - per_img[i]).sum() < 45] for i in range(len(per_img))]
    best = max(groups, key=len)
    px = np.concatenate([rec["px"][j] for j in best])
    med = np.median(per_img[best], axis=0)
    if len(per_img) == 1:
        conf = "single"
    elif len(best) >= 2 and len(best) >= len(per_img) / 2:
        conf = "agree"
    else:
        conf = "mixed"
    mixed += conf == "mixed"
    out[bid] = {"c": hexc(overcast_correct(med)), "raw": hexc(med), "n": len(best), "of": len(per_img), "px": int(len(px)),
                "yr": int(max(rec["years"][j] for j in best)), "conf": conf}
os.makedirs("data/derived", exist_ok=True)
json.dump(out, open(OUT, "w"))
print(f"facade colours for {len(out)} of {len(buildings)} buildings ({sum(1 for v in out.values() if v['conf'] == 'agree')} agreeing across photos, {mixed} mixed)")
