# Guru Nanak Dev DSEU Campus — 3D map

Interactive 3D campus map for **Guru Nanak Dev DSEU Campus (formerly GNDIT), Sector 15, Rohini, Delhi 110089**.
OpenStreetMap footprints and roads are extruded into a walkable 3D scene in the browser with Three.js — no build step, no backend, ~120 KB of app code.

**Live:** https://krishsharma-code.github.io/gndit-campus-3d/

---

## Features

| Feature | Where |
|---|---|
| Extruded 3D buildings with real heights/floors from OSM tags | `assets/app.js` → `rebuildBuildings()` |
| Road network as ribbon meshes, parks / water / parking as flat areas | `ribbonGeometry()`, `areasGroup` |
| Search bar with suggestions → smooth camera fly-to | `buildSearchIndex()`, `flyTo()` |
| Day / night cycle with moving sun, real-time shadows, window glow, street lights | `setHour()` |
| Click any building for floors, height, footprint and source OSM id | `showPanel()` |
| **Add building** — trace a missing footprint on the ground, save, export JSON | `toggleTrace()`, `exportBuildings()` |
| Merged geometry (one draw call for all buildings) — smooth on phones | `mergeGeometries()` |

## How the data flows

```
OpenStreetMap (Overpass API)
        │  pipeline/build_campus.py   ← Shapely: clean, project, measure
        ▼
data/campus.json      buildings / roads / areas / pois in local metres
        │
        ▼
assets/app.js         ExtrudeGeometry → WebGL scene
```

Coordinates in `data/campus.json` are metres from `config.center`:
`x` = east, `z` = south (Three.js expects north at `-z`). No GIS library is needed in the browser.

## Run locally

```bash
git clone <this repo> && cd gndit-campus-3d
python3 -m http.server 8080      # ES modules need http://, not file://
# open http://localhost:8080
```

Rebuild the dataset from OSM:

```bash
pip install -r pipeline/requirements.txt
python pipeline/build_campus.py            # Overpass API se fresh data
python pipeline/snapshot_nominatim.py      # fallback: Nominatim-only partial snapshot
```

The campus bounding box lives in `data/config.json` (`bbox = [south, west, north, east]`).
Kisi doosre campus ke liye bas `center` + `bbox` badal dein — baaki pipeline aur viewer wahi rahega.

## Buildings add karna (important)

Delhi ke is ilaake me OpenStreetMap par **roads mapped hain, building footprints nahi**.
Isliye viewer ke andar hi ek tracer hai:

1. **Add building** dabayein.
2. Map par building ke corners par click karein (3 se zyada points).
3. **Finish** → naam, kind aur floors bharein → **Save**.
4. **Export** → `campus.buildings.json` download hoga.
5. Us file ko `data/` folder me replace karke commit kar dein — ab har visitor ko dikhegi.

Footprints OSM me hi daalna behtar hai (dusre logon ko bhi milega): <https://www.openstreetmap.org/edit> par area trace karein — agla monthly build unhe automatically utha lega.

## Deploy

GitHub par push karte hi `.github/workflows/deploy.yml` chalega: Overpass se fresh OSM data laata hai, `data/campus.json` banata hai aur GitHub Pages par publish karta hai (monthly cron bhi set hai).
Pages source ko **GitHub Actions** par set rakhna hai (Settings → Pages → Source: GitHub Actions).

Overpass down ho to workflow commit kiya hua `data/campus.json` hi deploy karta hai — site kabhi khaali nahi hoti.

## Data & licence

* Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), [ODbL 1.0](https://opendatacommons.org/licenses/odbl/). Attribution viewer ke footer me hai — hatayein nahi.
* Code: MIT (`LICENSE`).
* `data/campus.json` jab `"partial": true` ho to wo Nominatim se bana partial snapshot hai, poora extract nahi.

Built with [Three.js](https://threejs.org) r169 (vendored in `assets/vendor/`, no CDN needed), [Shapely](https://shapely.readthedocs.io), and the [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API).
