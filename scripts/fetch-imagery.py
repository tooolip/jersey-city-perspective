"""Downloads the latest USDA NAIP aerial photo (30 cm, public domain) for the project area
from Microsoft Planetary Computer, reprojected to WGS84 lon/lat so the data build can sample
it with a simple linear mapping.

Usage: .venv/bin/python scripts/fetch-imagery.py
"""
import json
import os
import urllib.request

import numpy as np
import rasterio
from rasterio.warp import Resampling, reproject, transform_bounds
from rasterio.windows import from_bounds
from rasterio.transform import from_bounds as transform_from_bounds

BBOX = (-74.0600, 40.7130, -74.0240, 40.7350)  # lon/lat
OUT = "data/raw/naip.tif"
STAC = "https://planetarycomputer.microsoft.com/api/stac/v1/search"
TOKEN = "https://planetarycomputer.microsoft.com/api/sas/v1/token/naip"
RES_M = 0.3


def post_json(url, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        return json.load(r)


def main():
    found = post_json(STAC, {
        "collections": ["naip"], "bbox": list(BBOX), "limit": 20,
        "sortby": [{"field": "datetime", "direction": "desc"}],
    })["features"]
    # Newest New Jersey capture that fully contains the area.
    item = next(f for f in found if f["id"].startswith("nj_") and
                f["bbox"][0] <= BBOX[0] and f["bbox"][1] <= BBOX[1] and f["bbox"][2] >= BBOX[2] and f["bbox"][3] >= BBOX[3])
    with urllib.request.urlopen(TOKEN) as r:
        token = json.load(r)["token"]
    href = item["assets"]["image"]["href"] + "?" + token
    print(f"Using {item['id']} ({item['properties']['datetime'][:10]}, {item['properties']['gsd']} m)")

    with rasterio.open(href) as src:
        native = transform_bounds("EPSG:4326", src.crs, *BBOX, densify_pts=21)
        win = from_bounds(*native, transform=src.transform).round_offsets().round_lengths()
        data = src.read([1, 2, 3, 4], window=win)  # R, G, B, near-infrared
        win_transform = src.window_transform(win)
        print(f"Read {data.shape[2]}x{data.shape[1]} px from source")

        lat0 = (BBOX[1] + BBOX[3]) / 2
        width = int((BBOX[2] - BBOX[0]) * 111412.84 * np.cos(np.radians(lat0)) / RES_M)
        height = int((BBOX[3] - BBOX[1]) * 111132.95 / RES_M)
        dst_transform = transform_from_bounds(*BBOX, width, height)
        out = np.zeros((4, height, width), dtype=np.uint8)
        reproject(data, out, src_transform=win_transform, src_crs=src.crs,
                  dst_transform=dst_transform, dst_crs="EPSG:4326", resampling=Resampling.bilinear)

    os.makedirs("data/raw", exist_ok=True)
    profile = dict(driver="GTiff", width=width, height=height, count=4, dtype="uint8", crs="EPSG:4326",
                   transform=dst_transform, compress="deflate", tiled=True, blockxsize=512, blockysize=512)
    with rasterio.open(OUT, "w", **profile) as dst:
        dst.write(out)
        dst.update_tags(source=item["id"], datetime=item["properties"]["datetime"])
    # Plain raw dump for the Node data build (no GeoTIFF reader needed there).
    meta = {"bbox": BBOX, "width": width, "height": height, "source": item["id"], "date": item["properties"]["datetime"][:10]}
    out[:3].transpose(1, 2, 0).tofile("data/raw/naip.rgb")
    out[3].tofile("data/raw/naip.nir")  # for NDVI (vegetation) checks
    with open("data/raw/naip.json", "w") as f:
        json.dump(meta, f)
    print(f"Saved {OUT}, data/raw/naip.rgb and naip.nir ({width}x{height})")


if __name__ == "__main__":
    main()
