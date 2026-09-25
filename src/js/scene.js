import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const ENV = JSON.parse(document.getElementById('env-data').textContent);
const DEG = Math.PI / 180;
const $ = (s, root = document) => root.querySelector(s);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const fmt = (n, d = 0) => n.toLocaleString('hr-HR', { minimumFractionDigits: d, maximumFractionDigits: d });
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ------------------------------------------------------------------ frames
// World: x = east, z = south, y = up, metres. Origin = centre of today's pitch (OSM way 29574648).
// Stadium-local: X across the pitch toward the east stand, Z along it toward the south stand.
const PITCH_BEARING = 342.3;                        // bearing of the pitch axis toward the north stand
const STADIUM_YAW = (360 - PITCH_BEARING) * DEG;
const UP = new THREE.Vector3(0, 1, 0);
// Centre spot of the new pitch (45.8187826 N, 16.0177421 E), from the winning scheme's 1:1000 site plans:
// ~15 m nearer Maksimirska cesta and ~14 m further west (across the pitch) than today's.
const FUTURE_CENTER = new THREE.Vector3(-18.39, 0, -10.14);
const MID = new THREE.Vector3(0, 0, -12);

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20260925);

function pointInPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], zi = poly[i][1], xj = poly[j][0], zj = poly[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function bounds(poly) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of poly) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  return { x0, x1, z0, z1 };
}

// ------------------------------------------------------------------ renderer
const canvas = $('#gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.02;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const MAX_ANISO = renderer.capabilities.getMaxAnisotropy();

const scene = new THREE.Scene();
const SKY = {
  dryTop: new THREE.Color('#9fb6c8'), dryHorizon: new THREE.Color('#dde5e8'),
  wetTop: new THREE.Color('#6d7b86'), wetHorizon: new THREE.Color('#a9b3b8'),
};
scene.fog = new THREE.Fog(SKY.dryHorizon.clone(), 900, 3600);
scene.background = SKY.dryHorizon.clone();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.55;

const hemi = new THREE.HemisphereLight('#eef3f6', '#5f6452', 1.15);
const sun = new THREE.DirectionalLight('#fff4e2', 2.1);
sun.position.set(-240, 420, 260).add(MID);
sun.target.position.copy(MID);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -250, right: 250, top: 250, bottom: -250, near: 100, far: 1200 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.45;
scene.add(hemi, sun, sun.target);

const skyUniforms = { uTop: { value: SKY.dryTop.clone() }, uHorizon: { value: SKY.dryHorizon.clone() } };
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(7000, 32, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false, uniforms: skyUniforms,
    vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform vec3 uTop; uniform vec3 uHorizon; varying vec3 vP;
      void main() {
        float h = clamp(vP.y * 2.2, 0.0, 1.0);
        gl_FragColor = vec4(mix(uHorizon, uTop, pow(h, 0.7)), 1.0);
        #include <colorspace_fragment>
      }`,
  })
);
sky.renderOrder = -1;
scene.add(sky);

// ------------------------------------------------------------------ texture helpers
function canvasTex(w, h, draw, opts = {}) {
  const c = document.createElement('canvas');
  c.width = Math.max(2, Math.round(w));
  c.height = Math.max(2, Math.round(h));
  const g = c.getContext('2d');
  draw(g, c.width, c.height);
  const t = new THREE.CanvasTexture(c);
  if (opts.color !== false) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = MAX_ANISO;
  if (opts.repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(opts.repeat[0], opts.repeat[1]); }
  return t;
}

function pitchTexture() {
  const L = 105, W = 68, m = 3, s = 10;
  return canvasTex((L + 2 * m) * s, (W + 2 * m) * s, (g, w, h) => {
    const n = 16;
    for (let i = 0; i < n; i++) {
      g.fillStyle = i % 2 ? '#4f9444' : '#5ba24f';
      g.fillRect((i * w) / n, 0, w / n + 1, h);
    }
    const X = (x) => (m + x) * s, Y = (y) => (m + y) * s;
    g.strokeStyle = 'rgba(255,255,255,0.95)';
    g.lineWidth = 0.14 * s;
    g.strokeRect(X(0), Y(0), L * s, W * s);
    g.beginPath(); g.moveTo(X(L / 2), Y(0)); g.lineTo(X(L / 2), Y(W)); g.stroke();
    g.beginPath(); g.arc(X(L / 2), Y(W / 2), 9.15 * s, 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#fff';
    for (const side of [0, 1]) {
      const x0 = side ? L : 0, d = side ? -1 : 1;
      const box = (depth, width) => {
        g.beginPath();
        g.moveTo(X(x0), Y(W / 2 - width / 2)); g.lineTo(X(x0 + d * depth), Y(W / 2 - width / 2));
        g.lineTo(X(x0 + d * depth), Y(W / 2 + width / 2)); g.lineTo(X(x0), Y(W / 2 + width / 2));
        g.stroke();
      };
      box(16.5, 40.32); box(5.5, 18.32);
      const spot = x0 + d * 11;
      g.beginPath(); g.arc(X(spot), Y(W / 2), 0.25 * s, 0, Math.PI * 2); g.fill();
      const a = Math.acos(5.5 / 9.15);
      g.beginPath();
      if (side) g.arc(X(spot), Y(W / 2), 9.15 * s, Math.PI - a, Math.PI + a);
      else g.arc(X(spot), Y(W / 2), 9.15 * s, -a, a);
      g.stroke();
    }
    for (const [cx, cy, a0] of [[0, 0, 0], [L, 0, 0.5], [L, W, 1], [0, W, 1.5]]) {
      g.beginPath(); g.arc(X(cx), Y(cy), 1 * s, a0 * Math.PI, (a0 + 0.5) * Math.PI); g.stroke();
    }
    g.beginPath(); g.arc(X(L / 2), Y(W / 2), 0.25 * s, 0, Math.PI * 2); g.fill();
  });
}

// Seat texture: u runs along the stand (metres along its centre line), v across its rows.
function seatTexture(o) {
  const pxU = Math.min(4096, Math.ceil(o.length * 6));
  const rowPx = 8;
  const H = o.rows * rowPx;
  return canvasTex(pxU, H, (g, w, h) => {
    const mU = w / o.length;
    g.fillStyle = o.seat;
    g.fillRect(0, 0, w, h);
    for (let r = 0; r < o.rows; r++) {
      const y = h - (r + 1) * rowPx;
      g.fillStyle = o.back;
      g.fillRect(0, y, w, 2);
      if (o.shade) { g.fillStyle = o.shade; g.fillRect(0, y + 2, w, 1); }
    }
    if (o.aisles) {
      g.fillStyle = o.aisle;
      for (const a of o.aisles) g.fillRect((a - 0.6) * mU, 0, 1.2 * mU, h);
    }
    if (o.text) {
      const rowsTall = o.text.rows;
      const px = rowsTall * rowPx;
      g.save();
      const metresPerRowU = 1 / mU, metresPerPxV = o.rowMetres / rowPx;
      g.translate(o.text.at * mU, h - (o.text.row + rowsTall / 2) * rowPx);
      g.scale(metresPerPxV / metresPerRowU, 1);
      g.font = `700 ${Math.round(px * 0.95)}px "Arial Rounded MT Bold", "Helvetica Rounded", Arial, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = o.text.color;
      g.fillText(o.text.value, 0, 0);
      g.restore();
    }
  });
}

// ------------------------------------------------------------------ materials
const M = {
  ground: new THREE.MeshLambertMaterial({ color: '#d6d4cb' }),
  park: new THREE.MeshLambertMaterial({ color: '#c3d3aa' }),
  grass: new THREE.MeshLambertMaterial({ color: '#b8cea0' }),
  forestFloor: new THREE.MeshLambertMaterial({ color: '#6f8c5b' }),
  water: new THREE.MeshStandardMaterial({ color: '#6f94a6', roughness: 0.12, metalness: 0.1 }),
  asphalt: new THREE.MeshLambertMaterial({ color: '#8d9193' }),
  paving: new THREE.MeshLambertMaterial({ color: '#cbc6ba' }),
  gravel: new THREE.MeshLambertMaterial({ color: '#ddd2b6' }),
  tram: new THREE.MeshLambertMaterial({ color: '#5a5f63' }),
  sidePitch: new THREE.MeshLambertMaterial({ color: '#7fae62' }),
  buildings: new THREE.MeshLambertMaterial({ vertexColors: true }),
  tree: new THREE.MeshLambertMaterial({ flatShading: true }),
  concrete: new THREE.MeshStandardMaterial({ color: '#d7d3ca', roughness: 0.92 }),
  concreteDark: new THREE.MeshStandardMaterial({ color: '#a9a69f', roughness: 0.9 }),
  glass: new THREE.MeshStandardMaterial({ color: '#2f4e70', roughness: 0.15, metalness: 0.4 }),
  glassWarm: new THREE.MeshStandardMaterial({ color: '#3a3a36', roughness: 0.2, metalness: 0.3, emissive: '#f3d9a4', emissiveIntensity: 0.35 }),
  ochre: new THREE.MeshStandardMaterial({ color: '#c98a4b', roughness: 0.85 }),
  magenta: new THREE.MeshStandardMaterial({ color: '#d0177d', roughness: 0.6 }),
  tartan: new THREE.MeshLambertMaterial({ color: '#566f9f' }),
  white: new THREE.MeshStandardMaterial({ color: '#f4f4f1', roughness: 0.6 }),
  steel: new THREE.MeshStandardMaterial({ color: '#9aa4ab', roughness: 0.5, metalness: 0.6 }),
  lamp: new THREE.MeshBasicMaterial({ color: '#fffbe8' }),
  net: new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }),
};

// ------------------------------------------------------------------ flat ground layers
function flatGeometry(polys, y) {
  const geos = [];
  for (const p of polys) {
    if (!p || p.length < 3) continue;
    const shape = new THREE.Shape(p.map(([x, z]) => new THREE.Vector2(x, -z)));
    const g = new THREE.ShapeGeometry(shape);
    g.rotateX(-Math.PI / 2);
    g.translate(0, y, 0);
    geos.push(g);
  }
  return geos.length ? mergeGeometries(geos) : null;
}

function ribbonGeometry(lines, widthOf, y) {
  const pos = [];
  const tri = (a, b, c) => {
    const cy = (b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1]);
    if (cy < 0) [b, c] = [c, b];
    pos.push(a[0], y, a[1], b[0], y, b[1], c[0], y, c[1]);
  };
  for (const L of lines) {
    const w = widthOf(L) / 2;
    const p = L.p || L;
    for (let i = 0; i < p.length - 1; i++) {
      const [x1, z1] = p[i], [x2, z2] = p[i + 1];
      const dx = x2 - x1, dz = z2 - z1, len = Math.hypot(dx, dz) || 1;
      const nx = (-dz / len) * w, nz = (dx / len) * w, ex = (dx / len) * w * 0.6, ez = (dz / len) * w * 0.6;
      const a = [x1 - ex + nx, z1 - ez + nz], b = [x2 + ex + nx, z2 + ez + nz];
      const c = [x2 + ex - nx, z2 + ez - nz], d = [x1 - ex - nx, z1 - ez - nz];
      tri(a, b, c); tri(a, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const nrm = new Float32Array(pos.length);
  for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  return g;
}

function addMesh(geo, mat, { shadow = 'receive', parent = scene, order } = {}) {
  if (!geo) return null;
  const m = new THREE.Mesh(geo, mat);
  m.receiveShadow = shadow === 'receive' || shadow === 'both';
  m.castShadow = shadow === 'cast' || shadow === 'both';
  if (order !== undefined) m.renderOrder = order;
  parent.add(m);
  return m;
}

// ------------------------------------------------------------------ environment
const roadWidth = [16, 9, 6, 4.5, 2.2];
function buildEnvironment() {
  addMesh(new THREE.CircleGeometry(6500, 72).rotateX(-Math.PI / 2), M.ground);
  addMesh(flatGeometry([ENV.park], 0.04), M.park);
  addMesh(flatGeometry(ENV.grass, 0.08), M.grass);
  addMesh(flatGeometry(ENV.forest, 0.12), M.forestFloor);
  addMesh(flatGeometry(ENV.water, 0.3), M.water);
  addMesh(flatGeometry(ENV.pitches.filter((p) => p.s === 'soccer').map((p) => p.p), 0.2), M.sidePitch);

  const roads = ENV.roads;
  addMesh(ribbonGeometry(roads.filter((r) => r.c <= 2), (r) => roadWidth[r.c], 0.22), M.asphalt);
  addMesh(ribbonGeometry(roads.filter((r) => r.c === 3), (r) => roadWidth[r.c], 0.2), M.paving);
  addMesh(ribbonGeometry(roads.filter((r) => r.c === 4), (r) => roadWidth[r.c], 0.18), M.gravel);
  addMesh(ribbonGeometry(ENV.tram.map((p) => ({ p })), () => 1.6, 0.26), M.tram);

  // Buildings standing inside today's stadium footprint belong to the stadium models.
  const onSite = (b) => {
    const cx = b.p.reduce((a, p) => a + p[0], 0) / b.p.length, cz = b.p.reduce((a, p) => a + p[1], 0) / b.p.length;
    const c = Math.cos(-STADIUM_YAW), s = Math.sin(-STADIUM_YAW);
    const lx = cx * c + cz * s, lz = -cx * s + cz * c;
    return lx > -114 && lx < 114 && lz > -128 && lz < 128;
  };
  addMesh(buildingsGeometry(ENV.buildings.filter((b) => !onSite(b))), M.buildings, { shadow: 'both' });
  buildTrees();
}

function buildingsGeometry(list) {
  const pos = [], col = [], nrm = [];
  const c = new THREE.Color();
  const push = (p, n, color) => { pos.push(p[0], p[1], p[2]); nrm.push(n[0], n[1], n[2]); col.push(color.r, color.g, color.b); };
  for (const b of list) {
    let pts = b.p;
    if (pts.length < 3) continue;
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x1, z1] = pts[i], [x2, z2] = pts[(i + 1) % pts.length];
      area += x1 * z2 - x2 * z1;
    }
    if (area < 0) pts = pts.slice().reverse();
    const h = b.h;
    const small = h <= 11 && Math.abs(area) / 2 < 450;
    const wall = c.clone().setHSL(0.1, 0.12, 0.84 + rand() * 0.06);
    const roof = small ? c.clone().setHSL(0.035 + rand() * 0.02, 0.42, 0.44 + rand() * 0.08) : c.clone().setHSL(0.1, 0.05, 0.74 + rand() * 0.06);
    for (let i = 0; i < pts.length; i++) {
      const [x1, z1] = pts[i], [x2, z2] = pts[(i + 1) % pts.length];
      const dx = x2 - x1, dz = z2 - z1, len = Math.hypot(dx, dz) || 1;
      const n = [dz / len, 0, -dx / len];
      const b1 = [x1, 0, z1], b2 = [x2, 0, z2], t1 = [x1, h, z1], t2 = [x2, h, z2];
      for (const p of [b1, t2, b2, b1, t1, t2]) push(p, n, wall);
    }
    const tris = THREE.ShapeUtils.triangulateShape(pts.map(([x, z]) => new THREE.Vector2(x, z)), []);
    for (const t of tris) {
      let [a, bb, cc] = t.map((i) => pts[i]);
      const cy = (bb[1] - a[1]) * (cc[0] - a[0]) - (bb[0] - a[0]) * (cc[1] - a[1]);
      if (cy < 0) [bb, cc] = [cc, bb];
      for (const p of [a, bb, cc]) push([p[0], h, p[1]], [0, 1, 0], roof);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

// Rotated rectangle around both stadium sites; no park trees are planted inside it.
function inStadiumSite(x, z) {
  const c = Math.cos(-STADIUM_YAW), s = Math.sin(-STADIUM_YAW);
  const lx = x * c + z * s, lz = -x * s + z * c;
  return lx > -125 && lx < 120 && lz > -150 && lz < 138;
}

function buildTrees() {
  // Spatial hash of the bigger roads so trees stay off the carriageway.
  const cell = 60, hash = new Map();
  const segs = [];
  for (const r of ENV.roads) {
    if (r.c > 2) continue;
    for (let i = 0; i < r.p.length - 1; i++) {
      const s = { a: r.p[i], b: r.p[i + 1], w: roadWidth[r.c] / 2 + 3 };
      segs.push(s);
      const x0 = Math.floor(Math.min(s.a[0], s.b[0]) / cell), x1 = Math.floor(Math.max(s.a[0], s.b[0]) / cell);
      const z0 = Math.floor(Math.min(s.a[1], s.b[1]) / cell), z1 = Math.floor(Math.max(s.a[1], s.b[1]) / cell);
      for (let gx = x0; gx <= x1; gx++) for (let gz = z0; gz <= z1; gz++) {
        const k = gx + ',' + gz;
        if (!hash.has(k)) hash.set(k, []);
        hash.get(k).push(s);
      }
    }
  }
  const nearRoad = (x, z) => {
    const list = hash.get(Math.floor(x / cell) + ',' + Math.floor(z / cell));
    if (!list) return false;
    for (const s of list) {
      const dx = s.b[0] - s.a[0], dz = s.b[1] - s.a[1];
      const t = clamp(((x - s.a[0]) * dx + (z - s.a[1]) * dz) / (dx * dx + dz * dz || 1), 0, 1);
      if (Math.hypot(x - s.a[0] - dx * t, z - s.a[1] - dz * t) < s.w) return true;
    }
    return false;
  };
  const waterBoxes = ENV.water.map((w) => ({ w, b: bounds(w) }));
  const inWater = (x, z) => waterBoxes.some(({ w, b }) => x > b.x0 - 4 && x < b.x1 + 4 && z > b.z0 - 4 && z < b.z1 + 4 && pointInPoly(x, z, w));
  const forestBoxes = ENV.forest.map((f) => ({ f, b: bounds(f) }));
  const inForest = (x, z) => forestBoxes.some(({ f, b }) => x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1 && pointInPoly(x, z, f));

  const trees = [];
  const ok = (x, z) => Math.hypot(x, z) < 1700 && !inStadiumSite(x, z) && !inWater(x, z) && !nearRoad(x, z);
  for (const { f, b } of forestBoxes) {
    const step = 10.5;
    for (let x = b.x0; x < b.x1; x += step) for (let z = b.z0; z < b.z1; z += step) {
      const px = x + (rand() - 0.5) * step * 0.9, pz = z + (rand() - 0.5) * step * 0.9;
      if (pointInPoly(px, pz, f) && ok(px, pz)) trees.push([px, pz, 1]);
    }
  }
  const pb = bounds(ENV.park);
  for (let x = pb.x0; x < pb.x1; x += 24) for (let z = pb.z0; z < pb.z1; z += 24) {
    if (rand() > 0.4) continue;
    const px = x + (rand() - 0.5) * 20, pz = z + (rand() - 0.5) * 20;
    if (pointInPoly(px, pz, ENV.park) && !inForest(px, pz) && ok(px, pz)) trees.push([px, pz, 0.85]);
  }
  // Alleys along Maksimirska cesta, as in the competition renders.
  for (const r of ENV.roads) {
    if (r.c !== 0 || !/Maksimirska/.test(r.n)) continue;
    for (let i = 0; i < r.p.length - 1; i++) {
      const [x1, z1] = r.p[i], [x2, z2] = r.p[i + 1];
      const dx = x2 - x1, dz = z2 - z1, len = Math.hypot(dx, dz);
      if (len < 1) continue;
      for (let s = 0; s < len; s += 13) {
        for (const side of [-1, 1]) {
          const px = x1 + (dx * s) / len + (-dz / len) * side * 14, pz = z1 + (dz * s) / len + (dx / len) * side * 14;
          if (px > -950 && px < 1300 && !inStadiumSite(px, pz) && !inWater(px, pz) && !nearRoad(px, pz)) trees.push([px, pz, 0.7]);
        }
      }
    }
  }

  const near = trees.filter(([x, z]) => Math.hypot(x - MID.x, z - MID.z) < 430);
  const far = trees.filter(([x, z]) => Math.hypot(x - MID.x, z - MID.z) >= 430);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3(), col = new THREE.Color();
  for (const [list, cast] of [[near, true], [far, false]]) {
    const mesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, cast ? 1 : 0), M.tree, list.length);
    list.forEach(([x, z, k], i) => {
      const r = (4.6 + rand() * 3.2) * (0.75 + 0.25 * k);
      const h = r * (1.15 + rand() * 0.45);
      sc.set(r, h, r * (0.9 + rand() * 0.2));
      q.setFromAxisAngle(UP, rand() * Math.PI);
      p.set(x, h * 0.92 + 2.5 + rand() * 2, z);
      m4.compose(p, q, sc);
      mesh.setMatrixAt(i, m4);
      col.setHSL(0.22 + rand() * 0.08, 0.3 + rand() * 0.18, 0.24 + rand() * 0.12);
      mesh.setColorAt(i, col);
    });
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }
}
