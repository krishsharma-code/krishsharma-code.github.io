#!/usr/bin/env python3
"""
snapshot_nominatim.py — fallback data generator (no Overpass needed)

Overpass API block ho ya available na ho, tab bhi viewer ko real OSM geometry
dene ke liye ye script Nominatim ke reverse + lookup endpoints se data uthata
hai: ek grid par reverse-geocode karke har point ke feature ke OSM id nikalta
hai, phir un ids ki poori geometry `lookup` se leta hai.

Nomitin ke usage policy ka khayal rakha gaya hai (<= 1 request/second).

    python pipeline/snapshot_nominatim.py --half 350 --step 70

Output schema bilkul wahi hai jo build_campus.py deta hai, isliye viewer ko
farq nahi padta. Note: ye ek *partial* snapshot hai — Overpass build complete
hota hai. meta.partial = true se viewer ko pata chalta hai.
"""

from __future__ import annotations

import argparse
import json
import math
import time
import urllib.parse
import urllib.request
from pathlib import Path

from shapely.geometry import LineString, Polygon
from shapely.geometry.polygon import orient

from build_campus import (AREA_STYLE, BUILDING_KIND, BUILDING_HEIGHT, DATA,
                          ROAD_WIDTH, building_height, make_projector)

NOMINATIM = "https://nominatim.openstreetmap.org"
UA = "gndit-campus-3d/1.0 (open-source campus map; student project)"
STEP_SECONDS = 1.1


def get(path: str, params: dict):
    url = f"{NOMINATIM}/{path}?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": UA,
                                              "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--half", type=float, default=350, help="half box size, metres")
    ap.add_argument("--step", type=float, default=70, help="grid spacing, metres")
    ap.add_argument("--out", default=str(DATA / "campus.json"))
    args = ap.parse_args()

    cfg = json.loads((DATA / "config.json").read_text(encoding="utf-8"))
    lon0, lat0 = cfg["center"]
    project = make_projector(lat0, lon0)

    dlat = args.half / 110574.0
    dlon = args.half / (111320.0 * math.cos(math.radians(lat0)))
    n = int(args.half * 2 / args.step) + 1

    ids: set[tuple[str, int]] = set()
    print(f"Reverse-sampling {n}x{n} grid (~{args.half * 2:.0f} m box)…")
    for i in range(n):
        for j in range(n):
            lat = lat0 - dlat + (2 * dlat) * i / max(1, n - 1)
            lon = lon0 - dlon + (2 * dlon) * j / max(1, n - 1)
            try:
                r = get("reverse", {"lat": lat, "lon": lon,
                                    "format": "jsonv2", "zoom": 18})
                if r.get("osm_type") in ("way", "relation"):
                    ids.add((r["osm_type"], r["osm_id"]))
            except Exception as exc:  # noqa: BLE001
                print("  reverse failed:", exc)
            time.sleep(STEP_SECONDS)

    print(f"{len(ids)} unique features; fetching geometry…")
    results = []
    batch = sorted(ids)
    for k in range(0, len(batch), 40):
        chunk = batch[k:k + 40]
        osm_ids = ",".join(f"{'W' if t == 'way' else 'R'}{i}" for t, i in chunk)
        try:
            results += get("lookup", {"osm_ids": osm_ids, "format": "jsonv2",
                                      "polygon_geojson": 1, "extratags": 1})
        except Exception as exc:  # noqa: BLE001
            print("  lookup failed:", exc)
        time.sleep(STEP_SECONDS)

    buildings, roads, areas = [], [], []
    for r in results:
        tags = r.get("extratags") or {}
        cat, typ = r.get("category"), r.get("type")
        gj = r.get("geojson") or {}
        gtype = gj.get("type")
        name = r.get("name") or tags.get("name:en") or ""

        if gtype == "Polygon":
            ring = gj["coordinates"][0]
            pts = [project(lon, lat) for lon, lat in ring]
        elif gtype == "LineString":
            pts = [project(lon, lat) for lon, lat in gj["coordinates"]]
        else:
            continue
        if len(pts) < 2:
            continue

        if gtype == "Polygon" and (cat == "building" or "building" in tags):
            try:
                poly = orient(Polygon(pts), 1.0)
                if not poly.is_valid:
                    poly = poly.buffer(0)
                if poly.is_empty or poly.geom_type != "Polygon" or poly.area < 6:
                    continue
                poly = poly.simplify(0.25, preserve_topology=True)
            except Exception:  # noqa: BLE001
                continue
            btags = {"building": tags.get("building", typ or "yes"),
                     "height": tags.get("height"),
                     "building:levels": tags.get("building:levels")}
            height, levels = building_height(btags)
            c = poly.centroid
            buildings.append({
                "id": r["osm_id"], "name": name,
                "kind": BUILDING_KIND.get(btags["building"], "building"),
                "type": btags["building"], "levels": levels, "height": height,
                "area": round(poly.area, 1), "cx": round(c.x, 2),
                "cz": round(c.y, 2),
                "poly": [[round(x, 2), round(z, 2)]
                         for x, z in list(poly.exterior.coords)[:-1]],
            })
            continue

        if cat == "highway" and gtype == "LineString":
            roads.append({"id": r["osm_id"], "name": name, "kind": typ,
                          "width": ROAD_WIDTH.get(typ, 5.0), "bridge": False,
                          "line": [[round(x, 1), round(z, 1)] for x, z in pts]})
            continue

        style = AREA_STYLE.get(typ) if cat in ("leisure", "landuse", "natural",
                                               "amenity", "sport") else None
        if style and gtype == "Polygon":
            try:
                poly = Polygon(pts)
                if not poly.is_valid:
                    poly = poly.buffer(0)
                if poly.is_empty or poly.geom_type != "Polygon" or poly.area < 30:
                    continue
                poly = poly.simplify(0.4, preserve_topology=True)
            except Exception:  # noqa: BLE001
                continue
            areas.append({"id": r["osm_id"], "name": name, "kind": style,
                          "poly": [[round(x, 1), round(z, 1)]
                                   for x, z in list(poly.exterior.coords)[:-1]]})

    # merge duplicate road segments of the same street for a continuous ribbon
    out = {
        "meta": {
            "name": cfg["name"],
            "center": {"lon": lon0, "lat": lat0},
            "bbox": cfg["bbox"],
            "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "source": "OpenStreetMap contributors, ODbL 1.0",
            "generator": "pipeline/snapshot_nominatim.py",
            "partial": True,
            "partialNote": ("Nominatim se banaya gaya partial snapshot — sirf "
                            "sampled features. Poora data ke liye Overpass "
                            "build (GitHub Actions) chalayein."),
            "counts": {"buildings": len(buildings), "roads": len(roads),
                       "areas": len(areas), "pois": 0},
        },
        "buildings": sorted(buildings, key=lambda b: -b["area"]),
        "roads": roads,
        "areas": areas,
        "pois": [],
    }
    p = Path(args.out)
    p.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {p} ({p.stat().st_size / 1024:.0f} KB) "
          f"buildings={len(buildings)} roads={len(roads)} areas={len(areas)}")


if __name__ == "__main__":
    main()
