/**
 * Guru Nanak Dev DSEU Campus — 3D viewer
 * OpenStreetMap footprints/roads + Three.js WebGL.
 * Data © OpenStreetMap contributors, ODbL 1.0.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const BUILD_VERSION = 'v1.0 · 2026-11-25';
const STORE_KEY = 'gndit-campus-buildings-v1';

const KIND_COLOR = {
  academic: 0xc8b9a6, hostel: 0xb9c4cf, workshop: 0xc2c2b4, office: 0xb7bdc9,
  health: 0xd3c2c6, food: 0xcfc0a8, shop: 0xc9c2b0, sports: 0xa8c3b8,
  building: 0xc3c6c2,
};
const AREA_COLOR = {
  park: 0x7ba05b, grass: 0x86a86a, forest: 0x5f7f4a, pitch: 0x7fa05f,
  water: 0x4a7fa5, parking: 0x6a6a72, institution: 0x9a9585,
  industrial: 0x8a8a80, residential: 0xa09a90,
};
const KIND_LABEL = {
  academic: 'Academic', hostel: 'Hostel', workshop: 'Workshop / lab',
  office: 'Office', health: 'Health', food: 'Food', shop: 'Shop',
  sports: 'Sports', building: 'Building',
};

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const state = {
  config: null,
  data: { buildings: [], roads: [], areas: [], pois: [], meta: {} },
  custom: [],
  hour: 15,
  trace: false,
  tracePoints: [],
  selected: null,
  entries: [],
  tween: null,
};

let renderer, scene, camera, controls, raycaster, groundPlane;
let sun, hemi, skyColor = new THREE.Color();
let groundMesh, roadsMesh, areasGroup, buildingsMesh, edgesMesh, labelsGroup,
    lightsGroup, traceGroup, focusRing;
let pickRanges = [];
let buildingMat, edgeMat;
const pointerNdc = new THREE.Vector2();

// ---------------------------------------------------------------- bootstrap
init().catch((err) => {
  console.error(err);
  fail(`Start nahi ho paya: ${err.message}`);
});

async function init() {
  const [config, campus, traced] = await Promise.all([
    loadJson('data/config.json'),
    loadJson('data/campus.json', { optional: true }),
    loadJson('data/campus.buildings.json', { optional: true }),
  ]);
  state.config = config;
  if (campus) {
    state.data = {
      buildings: campus.buildings || [],
      roads: campus.roads || [],
      areas: campus.areas || [],
      pois: campus.pois || [],
      meta: campus.meta || {},
    };
  }
  state.custom = mergeBuildings(traced?.buildings || [], readLocal());

  $('build-stamp').textContent = BUILD_VERSION;
  $('data-note').textContent = state.data.meta.partial
    ? 'Partial OSM snapshot — '
    : 'OSM extract — ';

  setupScene();
  buildWorld();
  buildSearchIndex();
  wireUi();
  setHour(15);
  animate();

  // small debug handle (console se scene inspect kar sakte hain)
  window.__campus = { state, scene, camera, controls, get roads() { return roadsMesh; },
    get buildings() { return buildingsMesh; } };

  $('loader').classList.add('done');
  if (allBuildings().length < 8) {
    $('hint').textContent =
      'OSM par is area ki buildings mapped nahi hain — "Add building" se footprint trace karein.';
  }
}

async function loadJson(path, { optional = false } = {}) {
  try {
    const res = await fetch(path, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (optional) {
      console.warn('optional file missing:', path);
      return null;
    }
    throw err;
  }
}

function fail(message) {
  $('loader-text').textContent = message;
  $('loader').querySelector('.spinner').style.display = 'none';
}

function mergeBuildings(committed, local) {
  const byId = new Map();
  for (const b of committed) byId.set(b.id, b);
  for (const b of local) byId.set(b.id, b);
  return [...byId.values()];
}

function readLocal() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeLocal() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state.custom));
  } catch {
    /* private mode / quota — export still works */
  }
}

// -------------------------------------------------------------------- scene
function setupScene() {
  const canvas = $('scene');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  scene = new THREE.Scene();
  skyColor.set(0xbcd3e6);
  scene.background = skyColor;
  scene.fog = new THREE.Fog(skyColor.getHex(), 900, 4200);

  camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 1, 7000);
  const view = state.config.defaultView || { yaw: 35, pitch: 42, distance: 620 };
  setCameraOrbit(THREE.MathUtils.degToRad(view.yaw), THREE.MathUtils.degToRad(view.pitch), view.distance);

  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.minDistance = 45;
  controls.maxDistance = 2600;
  controls.target.set(0, 4, 0);

  raycaster = new THREE.Raycaster();
  groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  hemi = new THREE.HemisphereLight(0xdfe9f5, 0x6b6355, 0.6);
  scene.add(hemi);

  sun = new THREE.DirectionalLight(0xfff3e0, 2.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const cam = sun.shadow.camera;
  cam.left = -750; cam.right = 750; cam.top = 750; cam.bottom = -750;
  cam.near = 1; cam.far = 3200;
  sun.shadow.bias = -0.0009;
  sun.shadow.normalBias = 0.6;
  scene.add(sun);
  scene.add(sun.target);

  window.addEventListener('resize', onResize);
}

function setCameraOrbit(yaw, pitch, distance) {
  const target = new THREE.Vector3(0, 4, 0);
  const pos = new THREE.Vector3(
    Math.sin(yaw) * Math.cos(pitch) * distance,
    Math.sin(pitch) * distance,
    Math.cos(yaw) * Math.cos(pitch) * distance,
  ).add(target);
  camera.position.copy(pos);
  if (controls) {
    controls.target.copy(target);
    controls.update();
  } else {
    camera.lookAt(target);
  }
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// -------------------------------------------------------------------- world
function buildWorld() {
  // ground
  const groundGeo = new THREE.PlaneGeometry(7000, 7000);
  groundGeo.rotateX(-Math.PI / 2);
  groundMesh = new THREE.Mesh(
    groundGeo,
    new THREE.MeshStandardMaterial({ color: 0xb4ae9f, roughness: 1, metalness: 0 }),
  );
  groundMesh.receiveShadow = true;
  groundMesh.position.y = -0.05;
  scene.add(groundMesh);

  // flat areas (parks, water, parking…)
  areasGroup = new THREE.Group();
  for (const area of state.data.areas) {
    const color = AREA_COLOR[area.kind] || 0x9a9585;
    const mesh = new THREE.Mesh(
      shapeGeometry(area.poly),
      new THREE.MeshStandardMaterial({
        color, roughness: 0.95, metalness: 0,
        side: THREE.DoubleSide,
        transparent: true, opacity: area.kind === 'water' ? 0.92 : 0.85,
      }),
    );
    mesh.position.y = 0.05;
    mesh.receiveShadow = true;
    areasGroup.add(mesh);
  }
  scene.add(areasGroup);

  // roads
  const roadGeos = [];
  for (const road of state.data.roads) {
    const g = ribbonGeometry(road.line, road.width || 5);
    if (g) roadGeos.push(g);
  }
  if (roadGeos.length) {
    roadsMesh = new THREE.Mesh(
      mergeGeometries(roadGeos, false),
      new THREE.MeshStandardMaterial({
        color: 0x54545e, roughness: 0.92, metalness: 0, side: THREE.DoubleSide,
      }),
    );
    roadsMesh.receiveShadow = true;
    scene.add(roadsMesh);
    roadGeos.forEach((g) => g.dispose());
  }

  // campus focus ring (origin = config.center)
  focusRing = new THREE.Mesh(
    new THREE.RingGeometry(150, 156, 96),
    new THREE.MeshBasicMaterial({ color: 0x7fd1ae, transparent: true, opacity: 0.35, side: THREE.DoubleSide }),
  );
  focusRing.rotation.x = -Math.PI / 2;
  focusRing.position.y = 0.12;
  scene.add(focusRing);

  buildingMat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.84, metalness: 0.04,
    emissive: new THREE.Color(0xffc98a), emissiveIntensity: 0,
  });
  edgeMat = new THREE.LineBasicMaterial({ color: 0x1d2128, transparent: true, opacity: 0.28 });

  labelsGroup = new THREE.Group();
  scene.add(labelsGroup);

  lightsGroup = makeStreetlights();
  scene.add(lightsGroup);

  traceGroup = new THREE.Group();
  scene.add(traceGroup);

  rebuildBuildings();
}

function shapeGeometry(poly) {
  const shape = new THREE.Shape(poly.map(([x, z]) => new THREE.Vector2(x, -z)));
  const geo = new THREE.ShapeGeometry(shape);
  geo.rotateX(-Math.PI / 2);
  return geo;
}

function ribbonGeometry(line, width) {
  const pts = line.map(([x, z]) => new THREE.Vector2(x, z));
  if (pts.length < 2) return null;
  const hw = Math.max(1.2, width / 2);
  const pos = [];
  const idx = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[i - 1] || pts[i];
    const next = pts[i + 1] || pts[i];
    let dx = next.x - prev.x;
    let dz = next.y - prev.y;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    const nx = -dz, nz = dx;
    pos.push(pts[i].x + nx * hw, 0, pts[i].y + nz * hw);
    pos.push(pts[i].x - nx * hw, 0, pts[i].y - nz * hw);
    if (i < pts.length - 1) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

function allBuildings() {
  return [...state.data.buildings, ...state.custom];
}

function rebuildBuildings() {
  if (buildingsMesh) {
    scene.remove(buildingsMesh);
    buildingsMesh.geometry.dispose();
    buildingsMesh = null;
  }
  if (edgesMesh) {
    scene.remove(edgesMesh);
    edgesMesh.geometry.dispose();
    edgesMesh = null;
  }
  labelsGroup.clear();

  const list = allBuildings();
  const geos = [];
  const edgeGeos = [];
  pickRanges = [];
  let triangles = 0;

  for (const b of list) {
    if (!b.poly || b.poly.length < 3) continue;
    const height = clamp(Number(b.height) || 8, 2.5, 120);
    const shape = new THREE.Shape(b.poly.map(([x, z]) => new THREE.Vector2(x, -z)));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, curveSegments: 1 });
    geo.rotateX(-Math.PI / 2);
    geo.deleteAttribute('uv');
    geo.computeVertexNormals();

    const base = new THREE.Color(KIND_COLOR[b.kind] || KIND_COLOR.building);
    const jitter = 0.94 + ((hashString(String(b.id)) % 12) / 100);
    base.multiplyScalar(jitter);
    const count = geo.attributes.position.count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      colors[i * 3] = base.r;
      colors[i * 3 + 1] = base.g;
      colors[i * 3 + 2] = base.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const tri = geo.attributes.position.count / 3;
    pickRanges.push({ start: triangles, end: triangles + tri, building: b });
    triangles += tri;
    geos.push(geo);

    const edges = new THREE.EdgesGeometry(geo, 25);
    edgeGeos.push(edges);

    if (b.name && height > 3) labelsGroup.add(makeLabel(b.name, b, height));
  }

  if (geos.length) {
    buildingsMesh = new THREE.Mesh(mergeGeometries(geos, false), buildingMat);
    buildingsMesh.castShadow = true;
    buildingsMesh.receiveShadow = true;
    scene.add(buildingsMesh);
    geos.forEach((g) => g.dispose());

    edgesMesh = new THREE.LineSegments(mergeGeometries(edgeGeos, false), edgeMat);
    scene.add(edgesMesh);
    edgeGeos.forEach((g) => g.dispose());
  }
  applyTimeToMaterials();
}

function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function makeLabel(text, building, height) {
  const pad = 16;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const font = '600 34px "Inter", system-ui, sans-serif';
  ctx.font = font;
  const w = Math.min(720, ctx.measureText(text).width + pad * 2);
  canvas.width = Math.ceil(w);
  canvas.height = 64;
  const c = canvas.getContext('2d');
  c.font = font;
  c.fillStyle = 'rgba(12,16,22,0.72)';
  roundRect(c, 0, 8, canvas.width, 48, 14);
  c.fill();
  c.fillStyle = '#f4f2ec';
  c.textBaseline = 'middle';
  c.fillText(text, pad, 33);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture, transparent: true, depthTest: false, depthWrite: false,
  }));
  const scale = 0.42;
  sprite.scale.set(canvas.width * scale, canvas.height * scale, 1);
  sprite.position.set(building.cx ?? 0, height + 12, building.cz ?? 0);
  sprite.renderOrder = 5;
  return sprite;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function makeStreetlights() {
  const positions = [];
  for (const road of state.data.roads) {
    if (!['primary', 'secondary', 'tertiary', 'residential'].includes(road.kind)) continue;
    const line = road.line;
    let acc = 0;
    for (let i = 1; i < line.length; i++) {
      const [x0, z0] = line[i - 1];
      const [x1, z1] = line[i];
      const seg = Math.hypot(x1 - x0, z1 - z0);
      acc += seg;
      if (acc > 55) {
        acc = 0;
        positions.push(x1, 5.5, z1);
      }
      if (positions.length > 2400) break;
    }
    if (positions.length > 2400) break;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const tex = glowTexture();
  const mat = new THREE.PointsMaterial({
    size: 26, map: tex, transparent: true, opacity: 0, depthWrite: false,
    blending: THREE.AdditiveBlending, color: 0xffd9a0, sizeAttenuation: true,
  });
  const points = new THREE.Points(geo, mat);
  points.userData.material = mat;
  return points;
}

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,232,190,1)');
  g.addColorStop(0.35, 'rgba(255,205,140,0.55)');
  g.addColorStop(1, 'rgba(255,190,120,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// -------------------------------------------------------------- day / night
function setHour(hour) {
  state.hour = hour;
  const ang = ((hour - 6) / 12) * Math.PI;
  const alt = Math.sin(ang);
  const daylight = clamp(alt, 0, 1);
  const night = 1 - clamp(alt * 3, 0, 1);

  const dir = new THREE.Vector3(Math.cos(ang), Math.max(alt, -0.2), 0.55).normalize();
  sun.position.copy(dir.multiplyScalar(1500));
  sun.target.position.set(0, 0, 0);

  sun.intensity = 0.06 + 2.3 * Math.pow(daylight, 0.7);
  sun.color.setHSL(0.09, 0.55 - 0.4 * daylight, 0.62 + 0.2 * daylight);

  hemi.intensity = 0.3 + 0.5 * daylight;

  const night0 = new THREE.Color(0x0a0f1a);
  const dusk = new THREE.Color(0x4a3a44);
  const day = new THREE.Color(0xbcd3e6);
  if (daylight < 0.28) skyColor.copy(night0).lerp(dusk, daylight / 0.28);
  else skyColor.copy(dusk).lerp(day, (daylight - 0.28) / 0.72);

  scene.background = skyColor;
  scene.fog.color.copy(skyColor);
  scene.fog.near = 700 + 400 * daylight;
  scene.fog.far = 2600 + 2000 * daylight;
  renderer.toneMappingExposure = 0.85 + 0.25 * daylight;

  if (groundMesh) {
    groundMesh.material.color.setHex(0xb4ae9f).multiplyScalar(0.55 + 0.45 * daylight);
  }
  if (lightsGroup) {
    const mat = lightsGroup.userData.material;
    mat.opacity = night * 0.9;
    lightsGroup.visible = night > 0.05;
  }
  if (focusRing) focusRing.material.opacity = 0.18 + 0.2 * daylight;
  applyTimeToMaterials(night);
  updateClockLabel();
}

function applyTimeToMaterials(night = 1 - clamp(Math.sin(((state.hour - 6) / 12) * Math.PI) * 3, 0, 1)) {
  if (buildingMat) buildingMat.emissiveIntensity = night * 0.6;
  if (edgeMat) edgeMat.opacity = 0.12 + 0.18 * (1 - night);
}

function updateClockLabel() {
  const h = Math.floor(state.hour);
  const m = Math.round((state.hour - h) * 60);
  $('hour-out').textContent = `${String(h % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  $('hour').value = String(state.hour);
  const isNight = state.hour < 6.4 || state.hour > 18.6;
  $('btn-daynight').textContent = isNight ? 'Day' : 'Night';
  $('btn-daynight').setAttribute('aria-pressed', String(isNight));
}

// ------------------------------------------------------------------- search
function buildSearchIndex() {
  const entries = [];
  const seenRoads = new Set();
  for (const b of allBuildings()) {
    if (!b.name) continue;
    entries.push({ label: b.name, sub: KIND_LABEL[b.kind] || 'Building', x: b.cx, z: b.cz, distance: 200 });
  }
  for (const r of state.data.roads) {
    if (!r.name || seenRoads.has(r.name)) continue;
    seenRoads.add(r.name);
    const mid = r.line[Math.floor(r.line.length / 2)] || [0, 0];
    entries.push({ label: r.name, sub: 'Road', x: mid[0], z: mid[1], distance: 460 });
  }
  for (const p of state.data.pois) {
    entries.push({ label: p.name, sub: p.kind, x: p.x, z: p.z, distance: 260 });
  }
  state.entries = entries;
}

function searchEntries(q) {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  return state.entries
    .map((e) => {
      const label = e.label.toLowerCase();
      let score = -1;
      if (label.startsWith(needle)) score = 0;
      else if (label.includes(needle)) score = 1;
      return { e, score };
    })
    .filter((r) => r.score >= 0)
    .sort((a, b) => a.score - b.score || a.e.label.length - b.e.label.length)
    .slice(0, 7)
    .map((r) => r.e);
}

// ------------------------------------------------------------------ fly-to
function flyTo(x, z, distance = 220) {
  const target = new THREE.Vector3(x, 6, z);
  const dir = camera.position.clone().sub(controls.target).normalize();
  if (dir.y < 0.25) dir.y = 0.25;
  dir.normalize();
  const desired = target.clone().add(dir.multiplyScalar(distance));
  state.tween = {
    t: 0, dur: 1250,
    fromPos: camera.position.clone(), toPos: desired,
    fromTarget: controls.target.clone(), toTarget: target,
  };
}

function stepTween(dt) {
  const tw = state.tween;
  if (!tw) return;
  tw.t += dt;
  const p = clamp(tw.t / tw.dur, 0, 1);
  const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
  camera.position.lerpVectors(tw.fromPos, tw.toPos, e);
  controls.target.lerpVectors(tw.fromTarget, tw.toTarget, e);
  if (p >= 1) state.tween = null;
}

// ------------------------------------------------------------------ picking
function pick(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointerNdc, camera);
  if (!buildingsMesh) return null;
  const hits = raycaster.intersectObject(buildingsMesh, false);
  if (!hits.length) return null;
  const tri = hits[0].faceIndex;
  const range = pickRanges.find((r) => tri >= r.start && tri < r.end);
  return range ? range.building : null;
}

function groundPoint(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointerNdc, camera);
  const out = new THREE.Vector3();
  return raycaster.ray.intersectPlane(groundPlane, out) ? out : null;
}

function showPanel(building) {
  state.selected = building;
  $('panel-title').textContent = building.name || 'Unnamed building';
  $('panel-sub').textContent = KIND_LABEL[building.kind] || 'Building';
  const facts = [
    ['Floors', building.levels ?? '—'],
    ['Height', `${Math.round(building.height || 0)} m`],
    ['Footprint', `${Math.round(building.area || 0)} m²`],
    ['Source', String(building.id).startsWith('custom-') ? 'Traced here' : `OSM ${building.id}`],
  ];
  $('panel-facts').innerHTML = facts
    .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
    .join('');
  $('panel').hidden = false;
  document.body.classList.add('panel-open');
  $('panel-focus').onclick = () => flyTo(building.cx ?? 0, building.cz ?? 0, 170);
}

// ------------------------------------------------------------------- tracing
function toggleTrace(on) {
  state.trace = on;
  $('btn-trace').setAttribute('aria-pressed', String(on));
  $('trace-card').hidden = !on;
  if (on) {
    $('panel').hidden = true;
    $('trace-form').hidden = true;
    state.tracePoints = [];
    drawTrace();
  } else {
    clearTrace();
  }
  updateTraceCount();
}

function addTracePoint(event) {
  const p = groundPoint(event);
  if (!p) return;
  state.tracePoints.push([p.x, p.z]);
  drawTrace();
  updateTraceCount();
}

function drawTrace() {
  clearTrace();
  const pts = state.tracePoints;
  if (!pts.length) return;
  const pos = [];
  for (const [x, z] of pts) pos.push(x, 1, z);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x7fd1ae }));
  traceGroup.add(line);

  const dots = new THREE.Points(geo.clone(), new THREE.PointsMaterial({ color: 0x7fd1ae, size: 9, sizeAttenuation: true }));
  traceGroup.add(dots);

  if (pts.length >= 2) {
    const ring = [...pts, pts[0]];
    const rpos = [];
    for (const [x, z] of ring) rpos.push(x, 1, z);
    const rgeo = new THREE.BufferGeometry();
    rgeo.setAttribute('position', new THREE.Float32BufferAttribute(rpos, 3));
    const dashed = new THREE.Line(rgeo, new THREE.LineDashedMaterial({
      color: 0x7fd1ae, dashSize: 6, gapSize: 4, transparent: true, opacity: 0.7,
    }));
    dashed.computeLineDistances();
    traceGroup.add(dashed);
  }
}

function clearTrace() {
  while (traceGroup.children.length) {
    const child = traceGroup.children.pop();
    child.geometry?.dispose();
    child.material?.dispose();
  }
}

function updateTraceCount() {
  $('trace-count').textContent = String(state.tracePoints.length);
}

function finishTrace() {
  if (state.tracePoints.length < 3) {
    $('hint').textContent = 'Kam se kam 3 points chahiye.';
    return;
  }
  $('trace-form').hidden = false;
  $('trace-name').focus();
}

function saveTracedBuilding(name, kind, levels) {
  const pts = state.tracePoints.map(([x, z]) => [round2(x), round2(z)]);
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cz = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const building = {
    id: `custom-${Date.now()}`,
    name: name || 'New building',
    kind,
    levels,
    height: Math.round(levels * 3.3 * 10) / 10,
    area: Math.round(polygonArea(pts)),
    cx: round2(cx),
    cz: round2(cz),
    poly: pts,
  };
  state.custom.push(building);
  writeLocal();
  rebuildBuildings();
  buildSearchIndex();
  toggleTrace(false);
  showPanel(building);
  $('btn-export').hidden = false;
  $('hint').textContent = 'Saved locally. "Export" se JSON download karein aur data/ folder me commit karein.';
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

function polygonArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  }
  return Math.abs(a / 2);
}

function exportBuildings() {
  const payload = { buildings: state.custom };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'campus.buildings.json';
  a.click();
  URL.revokeObjectURL(url);
}

// ------------------------------------------------------------------------ ui
function wireUi() {
  const searchInput = $('search');
  const suggest = $('suggest');
  let active = -1;
  let current = [];

  const renderSuggest = (items) => {
    current = items;
    active = -1;
    if (!items.length) {
      suggest.innerHTML = '<li class="empty">Kuch nahi mila</li>';
      suggest.hidden = false;
      return;
    }
    suggest.innerHTML = items
      .map((e, i) => `<li role="option" data-i="${i}" aria-selected="false">${escapeHtml(e.label)}<span>${escapeHtml(e.sub || '')}</span></li>`)
      .join('');
    suggest.hidden = false;
  };

  const choose = (i) => {
    const e = current[i];
    if (!e) return;
    suggest.hidden = true;
    searchInput.value = e.label;
    flyTo(e.x, e.z, e.distance || 240);
  };

  searchInput.addEventListener('input', () => {
    const q = searchInput.value;
    if (!q.trim()) { suggest.hidden = true; return; }
    renderSuggest(searchEntries(q));
  });
  searchInput.addEventListener('keydown', (ev) => {
    if (suggest.hidden) return;
    if (ev.key === 'ArrowDown') { active = Math.min(active + 1, current.length - 1); ev.preventDefault(); }
    else if (ev.key === 'ArrowUp') { active = Math.max(active - 1, 0); ev.preventDefault(); }
    else if (ev.key === 'Enter') { choose(active >= 0 ? active : 0); return; }
    else if (ev.key === 'Escape') { suggest.hidden = true; return; }
    [...suggest.children].forEach((li, i) => li.setAttribute('aria-selected', String(i === active)));
    if (active >= 0) suggest.children[active]?.scrollIntoView({ block: 'nearest' });
  });
  suggest.addEventListener('click', (ev) => {
    const li = ev.target.closest('li[data-i]');
    if (li) choose(Number(li.dataset.i));
  });
  document.addEventListener('click', (ev) => {
    if (!ev.target.closest('.search')) suggest.hidden = true;
  });

  $('hour').addEventListener('input', (ev) => setHour(Number(ev.target.value)));
  $('btn-daynight').addEventListener('click', () => {
    const night = state.hour >= 6.4 && state.hour <= 18.6;
    setHour(night ? 21.5 : 12.5);
  });
  $('btn-reset').addEventListener('click', () => {
    const view = state.config.defaultView || { yaw: 35, pitch: 42, distance: 620 };
    const target = new THREE.Vector3(0, 4, 0);
    const pos = new THREE.Vector3(
      Math.sin(THREE.MathUtils.degToRad(view.yaw)) * Math.cos(THREE.MathUtils.degToRad(view.pitch)) * view.distance,
      Math.sin(THREE.MathUtils.degToRad(view.pitch)) * view.distance,
      Math.cos(THREE.MathUtils.degToRad(view.yaw)) * Math.cos(THREE.MathUtils.degToRad(view.pitch)) * view.distance,
    ).add(target);
    state.tween = {
      t: 0, dur: 900, fromPos: camera.position.clone(), toPos: pos,
      fromTarget: controls.target.clone(), toTarget: target,
    };
  });

  $('btn-trace').addEventListener('click', () => toggleTrace(!state.trace));
  $('trace-cancel').addEventListener('click', () => toggleTrace(false));
  $('trace-undo').addEventListener('click', () => {
    state.tracePoints.pop();
    drawTrace();
    updateTraceCount();
  });
  $('trace-finish').addEventListener('click', finishTrace);
  $('trace-discard').addEventListener('click', () => toggleTrace(false));
  $('trace-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    saveTracedBuilding(
      $('trace-name').value.trim(),
      $('trace-kind').value,
      clamp(Number($('trace-levels').value) || 1, 1, 30),
    );
  });
  $('btn-export').addEventListener('click', exportBuildings);
  $('panel-close').addEventListener('click', () => {
    $('panel').hidden = true;
    document.body.classList.remove('panel-open');
  });

  document.addEventListener('keydown', (ev) => {
    const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);
    if (ev.key === 'Enter' && state.trace && !typing && $('trace-form').hidden) {
      if (state.tracePoints.length >= 3) finishTrace();
    }
    if (ev.key === 'Escape') {
      if (state.trace) toggleTrace(false);
      $('panel').hidden = true;
    }
  });

  const canvas = renderer.domElement;
  let down = null;
  canvas.addEventListener('pointerdown', (ev) => { down = { x: ev.clientX, y: ev.clientY }; });
  canvas.addEventListener('pointerup', (ev) => {
    if (!down) return;
    const moved = Math.hypot(ev.clientX - down.x, ev.clientY - down.y);
    down = null;
    if (moved > 6) return;
    if (state.trace) { addTracePoint(ev); return; }
    const hit = pick(ev);
    if (hit) showPanel(hit);
    else { $('panel').hidden = true; document.body.classList.remove('panel-open'); }
  });

  $('btn-export').hidden = state.custom.length === 0;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ---------------------------------------------------------------------- loop
let last = performance.now();
function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  const dt = now - last;
  last = now;
  stepTween(dt);
  controls.update();
  renderer.render(scene, camera);
}
