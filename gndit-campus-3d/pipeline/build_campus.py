#!/usr/bin/env python3
"""
build_campus.py — OpenStreetMap -> data/campus.json

Downloads the raw OSM data for the campus bounding box from the Overpass API,
cleans it with Shapely and writes a compact local-metric scene description that
the Three.js viewer can extrude directly.

    python pipeline/build_campus.py                  # fetch from Overpass + build
    python pipeline/build_campus.py --from-raw raw.json   # build from a saved Overpass response

Coordinate system of the output (metres):
    x = east,  z = south  (north is -z, which is what Three.js expects)
    origin = config.center

Data (c) OpenStreetMap contributors, ODbL 1.0 — https://www.openstreetmap.org/copyright
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

from shapely.geometry import LineString, Polygon
from shapely.geometry.polygon import orient

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CONFIG = DATA / "config.json"

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
UA = "gndit-campus-3d/1.0 (open-source campus map; +https://github.com/)"

# ---------------------------------------------------------------- projection
LAT_M = 110574.0  # metres per degree latitude
LON_M = 111320.0  # metres per degree longitude at the equator


def make_projector(lat0: float, lon0: float):
    k = LON_M * math.cos(math.radians(lat0))

    def project(lon: float, lat: float) -> tuple[float, float]:
        return ((lon - lon0) * k, -(lat - lat0) * LAT_M)

    return project


# ------------------------------------------------------------------ heuristics
ROAD_WIDTH = {
    "motorway": 16.0, "trunk": 14.0, "primary": 11.0, "secondary": 9.0,
    "tertiary": 8.0, "unclassified": 6.0, "residential": 6.0, "service": 4.0,
    "living_street": 5.0, "pedestrian": 4.0, "footway": 2.2, "path": 2.0,
    "steps": 2.0, "cycleway": 2.4, "track": 3.0, "busway": 8.0,
}

BUILDING_HEIGHT = {
    "garage": 3.0, "garages": 3.0, "shed": 3.0, "hut": 2.6, "roof": 3.0,
    "carport": 3.0, "greenhouse": 4.0, "kiosk": 3.0, "toilets": 3.2,
    "house": 7.0, "detached": 8.0, "semidetached_house": 7.5, "bungalow": 7.0,
    "residential": 12.0, "apartments": 15.0, "dormitory": 14.0,
    "school": 11.0, "college": 13.0, "university": 14.0, "kindergarten": 6.0,
    "hospital": 18.0, "commercial": 12.0, "retail": 8.0, "office": 14.0,
    "industrial": 9.0, "warehouse": 8.0, "hotel": 16.0, "yes": 8.0,
}

AREA_STYLE = {
    "park": "park", "garden": "park", "playground": "pitch", "pitch": "pitch",
    "recreation_ground": "park", "grass": "grass", "meadow": "grass",
    "forest": "forest", "scrub": "forest", "water": "water", "basin": "water",
    "reservoir": "water", "parking": "parking", "school": "institution",
    "college": "institution", "university": "institution",
    "institutional": "institution", "industrial": "industrial",
    "residential": "residential", "cemetery": "park", "railway": "industrial",
}

BUILDING_KIND = {
    "school": "academic", "college": "academic", "university": "academic",
    "kindergarten": "academic", "dormitory": "hostel", "hospital": "health",
    "retail": "shop", "commercial": "office", "office": "office",
    "industrial": "workshop", "warehouse": "workshop", "hotel": "hostel",
    "canteen": "food", "cafe": "food", "restaurant": "food",
}


def num(value, default=None):
    """Parse '12', '12.5 m', '3 floors' -> float."""
    if value is None:
        return default
    try:
        return float(str(value).split()[0].replace(",", "."))
    except (ValueError, IndexError):
        return default


def building_height(tags: dict) -> tuple[float, int]:
    levels = num(tags.get("building:levels"))
    height = num(tags.get("height"))
    if height is None and levels:
        height = levels * 3.3
    if height is None:
        height = BUILDING_HEIGHT.get(tags.get("building", "yes"), 8.0)
    height = max(2.5, min(height, 120.0))
    if not levels:
        levels = max(1, round(height / 3.3))
    return round(height, 1), int(levels)


# ------------------------------------------------------------------- overpass
def overpass_query(bbox) -> str:
    s, w, n, e = bbox
    box = f"{s},{w},{n},{e}"
    return f"""
[out:json][timeout:180];
(
  way["building"]({box});
  way["building:part"]({box});
  way["highway"]({box});
  way["area:highway"]({box});
  way["leisure"]({box});
  way["landuse"]({box});
  way["natural"]({box});
  way["amenity"~"^(hospital|clinic|school|college|university|library|canteen|cafe|restaurant|parking|bank|atm|fuel|police|fire_station|place_of_worship|community_centre|auditorium|sports_centre|bus_station)$"]({box});
  way["sport"]({box});
  way["barrier"~"^(wall|fence|hedge)$"]({box});
  node["amenity"]({box});
  node["shop"]({box});
  node["highway"~"^(bus_stop|traffic_signals|crossing)$"]({box});
  node["entrance"]({box});
  node["tourism"]({box});
  node["leisure"]({box});
);
out body;
>;
out skel qt;
"""


def fetch_overpass(bbox) -> dict:
    query = overpass_query(bbox)
    body = urllib.parse.urlencode({"data": query}).encode()
    last = None
    for url in OVERPASS_ENDPOINTS:
        for attempt in range(2):
            try:
                print(f"  GET {url} (try {attempt + 1})", flush=True)
                req = urllib.request.Request(
                    url, data=body,
                    headers={"User-Agent": UA, "Accept": "application/json"},
                )
                with urllib.request.urlopen(req, timeout=200) as resp:
                    raw = json.loads(resp.read().decode())
                print(f"  ok: {len(raw.get('elements', []))} elements")
                return raw
            except Exception as exc:  # noqa: BLE001 - report and try next mirror
                last = exc
                print(f"  failed: {exc}", flush=True)
                time.sleep(3)
    raise SystemExit(
        "Overpass API se data nahi aaya. Last error: %s\n"
        "Internet/Overpass down ho sakta hai — thodi der baad retry karein, "
        "ya --from-raw ke saath saved response dein." % last
    )


# ---------------------------------------------------------------------- build
def build(raw: dict, cfg: dict) -> dict:
    lon0, lat0 = cfg["center"]
    project = make_projector(lat0, lon0)

    nodes: dict[int, tuple[float, float]] = {}
    ways: list[dict] = []
    for el in raw.get("elements", []):
        if el.get("type") == "node":
            nodes[el["id"]] = (el["lon"], el["lat"])
        elif el.get("type") == "way" and el.get("nodes"):
            ways.append(el)

    def coords(way) -> list[tuple[float, float]]:
        return [project(*nodes[n]) for n in way["nodes"] if n in nodes]

    buildings, roads, areas, pois = [], [], [], []

    for way in ways:
        tags = way.get("tags") or {}
        pts = coords(way)
        if len(pts) < 2:
            continue

        is_building = "building" in tags or "building:part" in tags
        if is_building and len(pts) >= 4 and pts[0] != pts[-1]:
            pts.append(pts[0])
        if is_building and len(pts) >= 4:
            try:
                poly = orient(Polygon(pts), 1.0)
                if not poly.is_valid:
                    poly = poly.buffer(0)
                if poly.is_empty or poly.area < 6:
                    continue
                poly = poly.simplify(0.25, preserve_topology=True)
                if poly.is_empty or poly.geom_type != "Polygon":
                    continue
            except Exception:  # noqa: BLE001 - skip broken geometry
                continue
            height, levels = building_height(tags)
            kind = BUILDING_KIND.get(tags.get("building"), "building")
            if "amenity" in tags and tags["amenity"] in BUILDING_KIND:
                kind = BUILDING_KIND[tags["amenity"]]
            c = poly.centroid
            buildings.append({
                "id": way["id"],
                "name": tags.get("name") or tags.get("name:en") or "",
                "kind": kind,
                "type": tags.get("building", "yes"),
                "levels": levels,
                "height": height,
                "area": round(poly.area, 1),
                "cx": round(c.x, 2),
                "cz": round(c.y, 2),
                "poly": [[round(x, 2), round(z, 2)] for x, z in list(poly.exterior.coords)[:-1]],
            })
            continue

        if "highway" in tags:
            kind = tags["highway"]
            roads.append({
                "id": way["id"],
                "name": tags.get("name", ""),
                "kind": kind,
                "width": ROAD_WIDTH.get(kind, 5.0),
                "bridge": tags.get("bridge") == "yes",
                "line": [[round(x, 1), round(z, 1)] for x, z in pts],
            })
            continue

        # flat areas: parks, water, parking, landuse
        style = None
        for key in ("leisure", "landuse", "natural", "amenity", "sport"):
            if key in tags:
                style = AREA_STYLE.get(tags[key])
                if style:
                    break
        if style and len(pts) >= 4:
            if pts[0] != pts[-1]:
                pts.append(pts[0])
            try:
                poly = Polygon(pts)
                if not poly.is_valid:
                    poly = poly.buffer(0)
                if poly.is_empty or poly.area < 30 or poly.geom_type != "Polygon":
                    continue
                poly = poly.simplify(0.4, preserve_topology=True)
            except Exception:  # noqa: BLE001
                continue
            areas.append({
                "id": way["id"],
                "name": tags.get("name", ""),
                "kind": style,
                "poly": [[round(x, 1), round(z, 1)] for x, z in list(poly.exterior.coords)[:-1]],
            })

    for el in raw.get("elements", []):
        if el.get("type") != "node":
            continue
        tags = el.get("tags") or {}
        name = tags.get("name") or tags.get("name:en")
        if not name:
            continue
        kind = (tags.get("amenity") or tags.get("shop") or tags.get("tourism")
                or tags.get("leisure") or tags.get("highway") or "place")
        x, z = project(el["lon"], el["lat"])
        pois.append({"id": el["id"], "name": name, "kind": kind,
                     "x": round(x, 1), "z": round(z, 1)})

    buildings.sort(key=lambda b: -b["area"])
    out = {
        "meta": {
            "name": cfg["name"],
            "center": {"lon": lon0, "lat": lat0},
            "bbox": cfg["bbox"],
            "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "source": "OpenStreetMap contributors, ODbL 1.0",
            "generator": "pipeline/build_campus.py",
            "counts": {"buildings": len(buildings), "roads": len(roads),
                       "areas": len(areas), "pois": len(pois)},
        },
        "buildings": buildings,
        "roads": roads,
        "areas": areas,
        "pois": pois,
    }
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--from-raw", help="saved Overpass JSON response")
    ap.add_argument("--out", default=str(DATA / "campus.json"))
    args = ap.parse_args()

    cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    print(f"Campus: {cfg['name']}  bbox={cfg['bbox']}")

    if args.from_raw:
        raw = json.loads(Path(args.from_raw).read_text(encoding="utf-8"))
        print(f"  using saved response {args.from_raw}")
    else:
        raw = fetch_overpass(cfg["bbox"])

    data = build(raw, cfg)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")

    c = data["meta"]["counts"]
    size_kb = out.stat().st_size / 1024
    print(f"Wrote {out} ({size_kb:.0f} KB)")
    print(f"  buildings={c['buildings']} roads={c['roads']} "
          f"areas={c['areas']} pois={c['pois']}")
    if c["buildings"] == 0:
        print("  NOTE: is bbox me OSM par koi building mapped nahi hai. "
              "Viewer chalega, par buildings khali rahengi — "
              "'Add building' tool se footprints trace karein.")


if __name__ == "__main__":
    sys.exit(main())
