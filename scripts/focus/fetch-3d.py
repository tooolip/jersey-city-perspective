"""Downloads Mapillary 3D data for one focus area (areas/<name>.json): every photo within
`photoRadius` metres with its computed pose, its SfM reconstruction (coloured 3D points and
camera poses, OpenSfM format) and a 2048 px copy of the photo.

Output: data/raw/focus/<name>/{images.json, sfm/<cluster>.json, photos/<id>.jpg}
Usage: .venv/bin/python -I scripts/focus/fetch-3d.py example-area
"""
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request
import zlib
from concurrent.futures import ThreadPoolExecutor

AREA = json.load(open(f"areas/{sys.argv[1]}.json"))
OUT = f"data/raw/focus/{AREA['name']}"
FIELDS = ("id,captured_at,camera_type,camera_parameters,width,height,computed_geometry,computed_rotation,"
          "computed_compass_angle,computed_altitude,sequence,sfm_cluster,thumb_2048_url")


def token():
    if os.environ.get("MAPILLARY_TOKEN"):
        return os.environ["MAPILLARY_TOKEN"]
    for line in open(".env.local"):
        if line.startswith("MAPILLARY_TOKEN="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("Set MAPILLARY_TOKEN")


def get(url, tries=5, raw=False):
    for i in range(tries):
        try:
            data = urllib.request.urlopen(url, timeout=90).read()
            return data if raw else json.loads(data)
        except Exception as err:  # noqa: BLE001
            last = err
            time.sleep(1.5 * 2 ** i)
    raise RuntimeError(f"{url[:80]}: {last}")


TOKEN = token()
lat0, lon0 = AREA["center"]
r = AREA["photoRadius"]
dlat = r / 111132.0
dlon = r / (111412.84 * math.cos(math.radians(lat0)))
bbox = (lon0 - dlon, lat0 - dlat, lon0 + dlon, lat0 + dlat)

os.makedirs(f"{OUT}/sfm", exist_ok=True)
os.makedirs(f"{OUT}/photos", exist_ok=True)
q = urllib.parse.urlencode({"access_token": TOKEN, "fields": FIELDS, "bbox": ",".join(f"{v:.6f}" for v in bbox), "limit": 2000})
images = get(f"https://graph.mapillary.com/images?{q}").get("data", [])


def dist(im):
    lon, lat = im["computed_geometry"]["coordinates"]
    return math.hypot((lon - lon0) * 111412.84 * math.cos(math.radians(lat0)), (lat - lat0) * 111132.0)


images = [im for im in images if im.get("computed_geometry") and im.get("computed_rotation") and im.get("camera_type") == "perspective" and dist(im) <= r]
print(f"{len(images)} photos within {r} m")

clusters = {}
for im in images:
    sc = im.get("sfm_cluster")
    if sc and (sc.get("url") or sc["id"] not in clusters):
        clusters[sc["id"]] = sc.get("url") or im["id"]
for cid, url in clusters.items():
    path = f"{OUT}/sfm/{cid}.json"
    if not os.path.exists(path):
        if not url.startswith("http"):  # list results sometimes omit the URL: ask the photo itself
            q = urllib.parse.urlencode({"access_token": TOKEN, "fields": "sfm_cluster"})
            url = get(f"https://graph.mapillary.com/{url}?{q}").get("sfm_cluster", {}).get("url")
        if not url:
            continue  # some reconstructions aren't published
        recs = json.loads(zlib.decompress(get(url, raw=True)))
        json.dump(recs, open(path, "w"))
print(f"{len(os.listdir(f'{OUT}/sfm'))} of {len(clusters)} SfM clusters available")


def photo(im):
    path = f"{OUT}/photos/{im['id']}.jpg"
    if os.path.exists(path) or not im.get("thumb_2048_url"):
        return
    open(path, "wb").write(get(im["thumb_2048_url"], raw=True))


with ThreadPoolExecutor(8) as pool:
    list(pool.map(photo, images))
for im in images:
    im.pop("thumb_2048_url", None)  # signed URLs expire; don't keep them
    if im.get("sfm_cluster"):
        im["sfm_cluster"] = im["sfm_cluster"]["id"]
json.dump(images, open(f"{OUT}/images.json", "w"))
print(f"saved {OUT} ({len(os.listdir(f'{OUT}/photos'))} photos)")
