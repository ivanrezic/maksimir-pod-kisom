// ------------------------------------------------------------------ weather physics
// Terminal fall speed of a raindrop of diameter d mm (Atlas et al. 1973).
const dropSpeed = (d) => Math.max(0.1, 9.65 - 10.3 * Math.exp(-0.6 * d));

// Drop sizes after Best (1950): drops smaller than d mm hold 1 - exp(-(d/a)^2.25) of the water in the air,
// a = 1.3 R^0.232. Weighted by their fall speed, that becomes the share of the rain they bring down. The
// rain is split into five classes that bring down a fifth each; each class falls at its middle drop's speed.
const DROP_CLASSES = 5;
function rainDrops(rate) {
  const a = 1.3 * Math.pow(Math.max(rate, 0.1), 0.232), dd = 0.01, cdf = [];
  let acc = 0;
  for (let d = dd / 2; d < 10; d += dd) {
    acc += 2.25 / a * Math.pow(d / a, 1.25) * Math.exp(-Math.pow(d / a, 2.25)) * dropSpeed(d) * dd;
    cdf.push([d, acc]);
  }
  const out = [];
  for (let k = 0, i = 0; k < DROP_CLASSES; k++) {
    while (cdf[i][1] < ((k + 0.5) / DROP_CLASSES) * acc) i++;
    out.push({ d: cdf[i][0], vt: dropSpeed(cdf[i][0]) });
  }
  return out;
}
// The middle class: half the rain falls in larger drops, half in smaller ones.
const fallSpeed = (rate) => rainDrops(rate)[DROP_CLASSES >> 1].vt;
const ROOF_WIND = Math.pow(40 / 10, 0.22);          // wind at the new roofs, 40 m up, relative to the 10 m reading
const heightFactor = (y) => Math.pow(Math.max(y, 3) / 10, 0.22);

function beaufort(v) {
  const limits = [0.3, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7];
  const names = ['tišina', 'lahor', 'povjetarac', 'slab vjetar', 'umjeren vjetar', 'umjereno jak vjetar', 'jak vjetar',
    'žestok vjetar', 'olujni vjetar', 'jak olujni vjetar', 'žestok olujni vjetar', 'orkanski vjetar', 'orkan'];
  let b = 0;
  while (b < limits.length && v >= limits[b]) b++;
  return { b, name: names[b] };
}

const DIRS = [
  ['S', 'sjevera'], ['SI', 'sjeveroistoka'], ['I', 'istoka'], ['JI', 'jugoistoka'],
  ['J', 'juga'], ['JZ', 'jugozapada'], ['Z', 'zapada'], ['SZ', 'sjeverozapada'],
];
function dirName(deg) {
  const i = Math.round(deg / 45) % 8;
  const from = DIRS[i][1];
  const prep = /^(s|z|š|ž)/.test(from) ? 'sa' : 's';
  return { short: DIRS[i][0], text: `${prep} ${from}` };
}

// Gusts and veering: five drop paths per spectator, each with its own wind above the bowl (at height `top`)
// and its own class of drop, paired so that the mean drift over the five is that of every gust with every size.
function rainRays(p, top) {
  if (p.rain <= 0) return [];
  const drops = rainDrops(p.rain), u = p.wind * heightFactor(top);
  const jitter = [[1, 0, 2], [0.7, -9, 1], [1.3, 9, 3], [0.85, 14, 4], [1.15, -14, 0]];
  return jitter.map(([g, d, c]) => ({ sx: Math.sin((p.from + d) * DEG), sz: -Math.cos((p.from + d) * DEG), u: u * g, vt: drops[c].vt, w: 1 / jitter.length }));
}

// Local wind relative to the 10 m reading: shelter toward the wind and enclosure all around.
const localFactor = (shelter, encl) => (1 - 0.75 * shelter) * (1 - 0.45 * encl);

function windRays(p) {
  const out = [];
  for (const [e, we] of [[3, 0.5], [12, 0.32], [24, 0.18]]) for (const d of [-20, 0, 20]) {
    const b = (p.from + d) * DEG, ce = Math.cos(e * DEG);
    out.push({ d: [Math.sin(b) * ce, Math.sin(e * DEG), -Math.cos(b) * ce], w: we / 3 });
  }
  return out;
}

// Runs off the main thread: one worker per stadium, tracing rays from every spectator.
function workerMain() {
  let occ, heads, nOcc, bowl, grid = null, cover = null, encl = null;
  const windCache = new Map();
  // Transmission along one ray. mode 0: rain, each surface lets rainPass through.
  // mode 1: wind shelter, each hit weighted by how tall the surface is where the ray meets it.
  // mode 2: enclosure, any wind-blocking surface counts at full strength.
  function cast(ox, oy, oz, rx, ry, rz, mode, maxT, t0 = 2.4) {
    if (grid) return castGrid(ox, oy, oz, rx, ry, rz, mode, maxT, t0);
    let trans = 1;
    for (let k = 0; k < nOcc; k++) {
      const b = k * 19;
      const nx = occ[b], ny = occ[b + 1], nz = occ[b + 2];
      const den = nx * rx + ny * ry + nz * rz;
      if (den > -1e-6 && den < 1e-6) continue;
      const t = (occ[b + 3] - (nx * ox + ny * oy + nz * oz)) / den;
      if (t < 0.25 || t > maxT) continue;
      const hx = ox + rx * t, hy = oy + ry * t, hz = oz + rz * t;
      const nv = occ[b + 4];
      let inside = true;
      for (let j = 0; j < nv; j++) {
        const a = b + 5 + 3 * j, c = b + 5 + 3 * ((j + 1) % nv);
        const ex = occ[c] - occ[a], ey = occ[c + 1] - occ[a + 1], ez = occ[c + 2] - occ[a + 2];
        const px = hx - occ[a], py = hy - occ[a + 1], pz = hz - occ[a + 2];
        const cx = ey * pz - ez * py, cy = ez * px - ex * pz, cz = ex * py - ey * px;
        if (cx * nx + cy * ny + cz * nz < -1e-3) { inside = false; break; }
      }
      if (!inside) continue;
      if (mode === 0) { trans *= occ[b + 17]; if (trans < 0.02) return 0; }
      else if (mode === 2) trans *= occ[b + 18];
      else trans *= 1 - (1 - occ[b + 18]) * Math.exp(-t / (8 * Math.max(hy, 4)));
    }
    return trans;
  }
  // A stadium built from voxels is marched through its 2 m grid in its own frame (every ray here climbs).
  // Each run of solid cells counts as one surface, closed or perforated metal, like one polygon above;
  // perforated metal lets its open share of the rain through. A ray from a head skips its first 2.4 m
  // (t0): the cell around a head often holds the rows behind it.
  function castGrid(ox, oy, oz, rx, ry, rz, mode, maxT, t0) {
    const { mask, g, cos, sin } = grid;
    const lx = rx * cos - rz * sin, lz = rx * sin + rz * cos;
    let trans = 1, inside = false;
    for (let t = t0; t < maxT; t += g.dx / 2) {
      const x = ox + lx * t, y = oy + ry * t, z = oz + lz * t;
      if (y >= g.top) break;
      const i = Math.floor((x - g.x0) / g.dx), j = Math.floor((z - g.z0) / g.dx), k = Math.floor(y / g.dx);
      if (i < 0 || j < 0 || i >= g.nx || j >= g.nz) break;
      const m = k < 0 ? 255 : mask[(k * g.nz + j) * g.nx + i];
      if (!m) { inside = false; continue; }
      if (inside) continue;
      inside = true;
      const pass = m >= 250 ? 0 : mode === 0 ? 1 - m / 255 : 0.45;
      if (mode === 0) { trans *= pass; if (trans < 0.02) return 0; }
      else if (mode === 2) trans *= pass;
      else trans *= 1 - (1 - pass) * Math.exp(-t / (8 * Math.max(y, 4)));
    }
    return trans;
  }
  function trace(rays, mode, maxT) {
    const n = heads.length / 3, out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const ox = heads[3 * i], oy = heads[3 * i + 1], oz = heads[3 * i + 2];
      let acc = 0;
      for (const r of rays) {
        const t = cast(ox, oy, oz, r.d[0], r.d[1], r.d[2], mode, maxT);
        acc += r.w * (mode === 0 ? t : 1 - t);
      }
      out[i] = acc;
    }
    return out;
  }
  // A drop falls through the free wind above the bowl, then through the weaker wind inside it.
  function traceRain(rays, shelter) {
    const n = heads.length / 3, out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const ox = heads[3 * i], oy = heads[3 * i + 1], oz = heads[3 * i + 2];
      const k = (1 - 0.75 * shelter[i]) * (1 - 0.45 * encl[i]);
      let acc = 0;
      for (const r of rays) {
        const ui = r.u * k;
        let L = Math.hypot(ui, r.vt);
        const ax = (r.sx * ui) / L, ay = r.vt / L, az = (r.sz * ui) / L;
        const tA = oy < bowl ? (bowl - oy) / ay : 0;
        let t = tA > 0 ? cast(ox, oy, oz, ax, ay, az, 0, tA) : 1;
        if (t > 0.02) {
          const qx = ox + ax * tA, qy = oy + ay * tA, qz = oz + az * tA;
          L = Math.hypot(r.u, r.vt);
          t *= cast(qx, qy, qz, (r.sx * r.u) / L, r.vt / L, (r.sz * r.u) / L, 0, 500, 0);
        }
        acc += r.w * t;
      }
      out[i] = acc;
    }
    return out;
  }
  self.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'init') { occ = m.occ; heads = m.heads; bowl = m.bowl; grid = m.grid; nOcc = occ.length / 19; return; }
    if (!cover) {
      cover = trace([{ d: [0, 1, 0], w: 1 }], 0, 500);
      const ring = [];
      for (let a = 0; a < 16; a++) ring.push({ d: [Math.sin(a * 0.3927) * 0.996, 0.0872, -Math.cos(a * 0.3927) * 0.996], w: 1 / 16 });
      encl = trace(ring, 2, 250);
    }
    let shelter = windCache.get(m.windKey);
    if (!shelter) { shelter = trace(m.windRays, 1, 260); windCache.set(m.windKey, shelter); }
    const wet = m.rainRays.length ? traceRain(m.rainRays, shelter) : new Float32Array(heads.length / 3);
    self.postMessage({ id: m.id, wet, shelter: shelter.slice(), cover: cover.slice(), encl: encl.slice() }, [wet.buffer]);
  };
}
const workerURL = URL.createObjectURL(new Blob([`(${workerMain.toString()})()`], { type: 'text/javascript' }));

class Sim {
  constructor(st, onResult) {
    this.st = st;
    this.worker = new Worker(workerURL);
    // A stadium built from voxels is traced through its rain mask, from the heads in its own frame.
    const grid = st.voxels ? { ...rainMask(st, st.rainBounds), cos: Math.cos(STADIUM_YAW), sin: Math.sin(STADIUM_YAW) } : null;
    this.worker.postMessage({ type: 'init', occ: st.packed, heads: grid ? st.headsLocal : st.heads, bowl: st.bowl, grid });
    this.busy = false;
    this.pending = null;
    this.seq = 0;
    this.worker.onmessage = (e) => {
      this.busy = false;
      onResult(st, e.data, this.params);
      if (this.pending) { const p = this.pending; this.pending = null; this.run(p); }
    };
  }
  run(p) {
    if (this.busy) { this.pending = p; return; }
    this.busy = true;
    this.params = { ...p };
    this.worker.postMessage({ type: 'run', id: ++this.seq, windKey: Math.round(p.from), windRays: windRays(p), rainRays: rainRays(p, this.st.bowl) });
  }
}
