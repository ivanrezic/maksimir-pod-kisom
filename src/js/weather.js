// ------------------------------------------------------------------ weather physics
// Median drop diameter from rain rate (Marshall-Palmer) and terminal fall speed (Atlas et al.).
function fallSpeed(rate) {
  const d0 = 0.89 * Math.pow(Math.max(rate, 0.1), 0.21);
  return 9.65 - 10.3 * Math.exp(-0.6 * d0);
}
const ROOF_WIND = Math.pow(25 / 10, 0.22);          // wind at roof height relative to the 10 m reading
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

// Gusts and veering: five drop paths per spectator, each with its own wind at roof height.
function rainRays(p) {
  if (p.rain <= 0) return [];
  const vt = fallSpeed(p.rain);
  const jitter = [[1, 0, 0.3], [0.7, -9, 0.175], [1.3, 9, 0.175], [0.85, 14, 0.175], [1.15, -14, 0.175]];
  return jitter.map(([g, d, w]) => ({ sx: Math.sin((p.from + d) * DEG), sz: -Math.cos((p.from + d) * DEG), u: p.wind * ROOF_WIND * g, vt, w }));
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
  let occ, heads, nOcc, bowl, cover = null, encl = null;
  const windCache = new Map();
  // Transmission along one ray. mode 0: rain, each surface lets rainPass through.
  // mode 1: wind shelter, each hit weighted by how tall the surface is where the ray meets it.
  // mode 2: enclosure, any wind-blocking surface counts at full strength.
  function cast(ox, oy, oz, rx, ry, rz, mode, maxT) {
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
          t *= cast(qx, qy, qz, (r.sx * r.u) / L, r.vt / L, (r.sz * r.u) / L, 0, 500);
        }
        acc += r.w * t;
      }
      out[i] = acc;
    }
    return out;
  }
  self.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'init') { occ = m.occ; heads = m.heads; bowl = m.bowl; nOcc = occ.length / 19; return; }
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
    this.worker.postMessage({ type: 'init', occ: st.packed, heads: st.heads, bowl: st.bowl });
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
    this.worker.postMessage({ type: 'run', id: ++this.seq, windKey: Math.round(p.from), windRays: windRays(p), rainRays: rainRays(p) });
  }
}
