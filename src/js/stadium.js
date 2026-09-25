// ------------------------------------------------------------------ occluders
// Every occluder is a convex planar polygon in world space. rainPass / windPass are the
// fractions of rain or wind that get through (0 = solid, 0.45 = perforated metal mesh).
// They drive the ray-traced fallback when the GPU cannot run the wind tunnel.
class Occluders {
  constructor() { this.list = []; }
  poly(pts, rainPass = 0, windPass = 0) { this.list.push({ pts: pts.map((p) => p.clone()), rainPass, windPass }); }
  box(min, max, matrix, rainPass = 0, windPass = 0) {
    const c = [];
    for (const x of [min.x, max.x]) for (const y of [min.y, max.y]) for (const z of [min.z, max.z]) c.push(new THREE.Vector3(x, y, z).applyMatrix4(matrix));
    const f = [[0, 1, 3, 2], [4, 6, 7, 5], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
    for (const idx of f) this.poly(idx.map((i) => c[i]), rainPass, windPass);
  }
  pack() {
    const S = 19, out = new Float32Array(this.list.length * S);
    const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n = new THREE.Vector3();
    this.list.forEach((o, k) => {
      const b = k * S, p = o.pts;
      e1.subVectors(p[1], p[0]);
      e2.subVectors(p[2], p[0]);
      n.crossVectors(e1, e2).normalize();
      out[b] = n.x; out[b + 1] = n.y; out[b + 2] = n.z; out[b + 3] = n.dot(p[0]); out[b + 4] = p.length;
      for (let j = 0; j < 4; j++) {
        const q = p[Math.min(j, p.length - 1)];
        out[b + 5 + j * 3] = q.x; out[b + 6 + j * 3] = q.y; out[b + 7 + j * 3] = q.z;
      }
      out[b + 17] = o.rainPass; out[b + 18] = o.windPass;
    });
    return out;
  }
}

// ------------------------------------------------------------------ solids
// Convex hexahedra in stadium-local coordinates. The wind tunnel and the rain mask voxelise them
// (today's stadium; the new one comes as a triangle mesh, see VoxelModel).
// `s` is the solid fraction: 1 for concrete, less for perforated metal or open colonnades.
// Vertices 0-3 and 4-7 are opposite faces, with vertex k joined to k + 4.
const HEXA_FACES = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];

function convexPlanes(pts) {
  const c = pts.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length);
  const planes = [];
  for (const f of HEXA_FACES) {
    // Newell's normal copes with the collapsed faces of wedge-shaped stand segments.
    let nx = 0, ny = 0, nz = 0;
    const fc = new THREE.Vector3();
    for (let k = 0; k < f.length; k++) {
      const a = pts[f[k]], b = pts[f[(k + 1) % f.length]];
      nx += (a.y - b.y) * (a.z + b.z); ny += (a.z - b.z) * (a.x + b.x); nz += (a.x - b.x) * (a.y + b.y);
      fc.add(a);
    }
    fc.multiplyScalar(1 / f.length);
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-6) continue;
    const n = new THREE.Vector3(nx / len, ny / len, nz / len);
    if (n.dot(c) - n.dot(fc) > 0) n.negate();
    planes.push(n.x, n.y, n.z, n.dot(fc));
  }
  return Float64Array.from(planes);
}

class SolidSet {
  constructor() { this.list = []; }
  hexa(pts, s = 1) { this.list.push({ pts: pts.map((p) => p.clone()), s }); }
  box(x0, x1, y0, y1, z0, z1, s = 1) {
    const [a, b] = [Math.min(x0, x1), Math.max(x0, x1)], [c, d] = [Math.min(z0, z1), Math.max(z0, z1)];
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    this.hexa([V(a, y0, c), V(b, y0, c), V(b, y1, c), V(a, y1, c), V(a, y0, d), V(b, y0, d), V(b, y1, d), V(a, y1, d)], s);
  }
  resolve() {
    return this.list.map((o) => {
      const pts = o.pts;
      const min = pts.reduce((a, p) => a.min(p), new THREE.Vector3(Infinity, Infinity, Infinity));
      const max = pts.reduce((a, p) => a.max(p), new THREE.Vector3(-Infinity, -Infinity, -Infinity));
      return { planes: convexPlanes(pts), min, max, s: o.s };
    });
  }
}

function insideSolid(planes, x, y, z) {
  for (let k = 0; k < planes.length; k += 4) if (planes[k] * x + planes[k + 1] * y + planes[k + 2] * z - planes[k + 3] > 1e-6) return false;
  return true;
}

// ------------------------------------------------------------------ voxels
// The new stadium comes as a triangle mesh, so the simulation sees it as 1 m voxels in the stadium's
// frame. Every voxel a surface touches takes that surface's solid fraction, and under the rows of seats
// the stands are filled down to the ground, as today's stands are solid wedges. A flood fill from the
// open sides and the sky then marks the air; whatever it cannot reach is solid too. Surfaces on a solid
// block are its faces, the rest are thin: roof plates, facade skins, the corner terraces. A coarse grid
// samples the blocks at its cell centres but thickens thin surfaces to a whole cell, so no drop or gust
// slips through a roof between two cell centres.
class VoxelModel {
  constructor({ x0, x1, z0, z1, top }, h = 1) {
    Object.assign(this, { x0, z0, h, nx: Math.ceil((x1 - x0) / h), ny: Math.ceil(top / h), nz: Math.ceil((z1 - z0) / h) });
    const n = this.nx * this.ny * this.nz;
    this.surf = new Uint8Array(n);
    this.block = new Uint8Array(n);
  }

  // Conservative: every voxel the triangle touches (the triangle-box overlap test of Akenine-Möller).
  surface(pos, index, value) {
    const { x0, z0, h, nx, ny, nz, surf } = this, r = h / 2 + 1e-4;
    const v = new Float64Array(9), e = new Float64Array(9);
    for (let t = 0; t < index.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const p = index[t + k] * 3;
        v[k * 3] = pos[p] - x0; v[k * 3 + 1] = pos[p + 1]; v[k * 3 + 2] = pos[p + 2] - z0;
      }
      for (let k = 0; k < 3; k++) for (let a = 0; a < 3; a++) e[k * 3 + a] = v[((k + 1) % 3) * 3 + a] - v[k * 3 + a];
      const nX = e[1] * e[5] - e[2] * e[4], nY = e[2] * e[3] - e[0] * e[5], nZ = e[0] * e[4] - e[1] * e[3];
      const d = nX * v[0] + nY * v[1] + nZ * v[2], rn = r * (Math.abs(nX) + Math.abs(nY) + Math.abs(nZ));
      const lo = (a) => Math.floor(Math.min(v[a], v[3 + a], v[6 + a]) / h), hi = (a) => Math.floor(Math.max(v[a], v[3 + a], v[6 + a]) / h);
      const i1 = Math.min(nx - 1, hi(0)), k1 = Math.min(ny - 1, hi(1)), j1 = Math.min(nz - 1, hi(2));
      for (let k = Math.max(0, lo(1)); k <= k1; k++) for (let j = Math.max(0, lo(2)); j <= j1; j++) for (let i = Math.max(0, lo(0)); i <= i1; i++) {
        const cx = (i + 0.5) * h, cy = (k + 0.5) * h, cz = (j + 0.5) * h;
        if (Math.abs(nX * cx + nY * cy + nZ * cz - d) > rn || !edgeAxesOverlap(v, e, cx, cy, cz, r)) continue;
        const q = (k * nz + j) * nx + i;
        if (surf[q] < value) surf[q] = value;
      }
    }
  }

  // Solid from the ground up to `y` under a rectangle given in (along, depth) coordinates, where depth
  // runs along the unit vector (fx, fz) and along across it, along (-fz, fx).
  fillBelow(fx, fz, a0, a1, d0, d1, y) {
    const { x0, z0, h, nx, ny, nz, block } = this;
    const xs = [], zs = [];
    for (const a of [a0, a1]) for (const d of [d0, d1]) { xs.push(-fz * a + fx * d); zs.push(fx * a + fz * d); }
    const top = Math.min(ny, Math.round(y / h));
    const i1 = Math.min(nx - 1, Math.floor((Math.max(...xs) - x0) / h)), j1 = Math.min(nz - 1, Math.floor((Math.max(...zs) - z0) / h));
    for (let j = Math.max(0, Math.floor((Math.min(...zs) - z0) / h)); j <= j1; j++) for (let i = Math.max(0, Math.floor((Math.min(...xs) - x0) / h)); i <= i1; i++) {
      const x = x0 + (i + 0.5) * h, z = z0 + (j + 0.5) * h, a = -fz * x + fx * z, d = fx * x + fz * z;
      if (a < a0 || a > a1 || d < d0 || d > d1) continue;
      for (let k = 0; k < top; k++) block[(k * nz + j) * nx + i] = 1;
    }
  }

  close() {
    const { nx, ny, nz, surf, block } = this, n = surf.length, layer = nx * nz;
    const air = new Uint8Array(n), queue = new Int32Array(n);
    let head = 0, tail = 0;
    const visit = (q) => { if (!air[q] && !surf[q] && !block[q]) { air[q] = 1; queue[tail++] = q; } };
    for (let k = 0; k < ny; k++) {
      for (let j = 0; j < nz; j++) { visit((k * nz + j) * nx); visit((k * nz + j) * nx + nx - 1); }
      for (let i = 0; i < nx; i++) { visit(k * layer + i); visit(k * layer + (nz - 1) * nx + i); }
    }
    for (let q = (ny - 1) * layer; q < n; q++) visit(q);
    while (head < tail) {
      const q = queue[head++], i = q % nx, j = Math.floor(q / nx) % nz, k = Math.floor(q / layer);
      if (i > 0) visit(q - 1);
      if (i < nx - 1) visit(q + 1);
      if (j > 0) visit(q - nx);
      if (j < nz - 1) visit(q + nx);
      if (k > 0) visit(q - layer);
      if (k < ny - 1) visit(q + layer);
    }
    const core = new Uint8Array(n);
    for (let q = 0; q < n; q++) if (block[q] || (!air[q] && !surf[q])) core[q] = 1;
    this.thick = new Uint8Array(n);
    this.thin = new Uint8Array(n);
    for (let q = 0; q < n; q++) {
      if (core[q]) { this.thick[q] = 255; continue; }
      if (!surf[q]) continue;
      const i = q % nx, j = Math.floor(q / nx) % nz, k = Math.floor(q / layer);
      const face = (i > 0 && core[q - 1]) || (i < nx - 1 && core[q + 1]) || (j > 0 && core[q - nx]) || (j < nz - 1 && core[q + nx])
        || (k > 0 && core[q - layer]) || (k < ny - 1 && core[q + layer]);
      if (face) this.thick[q] = surf[q]; else this.thin[q] = surf[q];
    }
    this.surf = this.block = null;
    return this;
  }

  // Solid fraction (0-255) of a cube of side `size` centred on a local point.
  cell(x, y, z, size) {
    const { x0, z0, h, nx, ny, nz, thick, thin } = this;
    const fi = (x - x0) / h, fk = y / h, fj = (z - z0) / h, r = size / 2 / h;
    if (fi + r <= 0 || fj + r <= 0 || fk + r <= 0 || fi - r >= nx || fj - r >= nz || fk - r >= ny) return 0;
    const ci = Math.floor(fi), cj = Math.floor(fj), ck = Math.floor(fk);
    let best = ci >= 0 && cj >= 0 && ck >= 0 && ci < nx && cj < nz && ck < ny ? thick[(ck * nz + cj) * nx + ci] : 0;
    const i0 = Math.max(0, Math.floor(fi - r)), i1 = Math.min(nx - 1, Math.ceil(fi + r) - 1);
    const j0 = Math.max(0, Math.floor(fj - r)), j1 = Math.min(nz - 1, Math.ceil(fj + r) - 1);
    const k0 = Math.max(0, Math.floor(fk - r)), k1 = Math.min(ny - 1, Math.ceil(fk + r) - 1);
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) {
      const row = (k * nz + j) * nx;
      for (let i = i0; i <= i1; i++) if (thin[row + i] > best) best = thin[row + i];
    }
    return best;
  }
}

// The nine edge-cross-axis tests of the triangle-box overlap. v: vertices, e: edges, box at c with half-size r.
function edgeAxesOverlap(v, e, cx, cy, cz, r) {
  const c = [cx, cy, cz];
  for (let k = 0; k < 3; k++) {
    for (let a = 0; a < 3; a++) {
      // axis = edge k x unit axis a
      const b = (a + 1) % 3, d = (a + 2) % 3;
      const eb = e[k * 3 + b], ed = e[k * 3 + d];
      let mn = Infinity, mx = -Infinity;
      for (let m = 0; m < 3; m++) {
        const p = ed * (v[m * 3 + b] - c[b]) - eb * (v[m * 3 + d] - c[d]);
        if (p < mn) mn = p;
        if (p > mx) mx = p;
      }
      const rad = r * (Math.abs(eb) + Math.abs(ed));
      if (mn > rad || mx < -rad) return false;
    }
  }
  return true;
}

// ------------------------------------------------------------------ stadium
const LAYER_OCCLUDER = 2;

class Stadium {
  constructor(key, { center, capacity, name, bowl }) {
    this.key = key;
    this.name = name;
    this.capacity = capacity;
    this.bowl = bowl;   // height of the roof line; below it drops meet the sheltered bowl wind
    this.root = new THREE.Group();
    this.body = new THREE.Group();
    this.body.position.copy(center);
    this.body.rotation.y = STADIUM_YAW;
    this.root.add(this.body);
    scene.add(this.root);
    this.body.updateMatrixWorld(true);
    this.center = center.clone();
    this.seats = [];
    this.occ = new Occluders();
    this.solids = new SolidSet();
    this.voxels = null;       // a VoxelModel stands in for the solids of a stadium built from a mesh
    this.rainBounds = null;   // local box of the 2 m rain mask: [x0, x1, z0, z1, top]
    this.roofMaterials = [];
    this.labels = [];
    this.probes = [];   // points in the corner openings where the tunnel reports the air speed
  }
  get matrix() { return this.body.matrixWorld; }
  local(x, y, z) { return new THREE.Vector3(x, y, z).applyMatrix4(this.matrix); }

  mesh(geo, mat, { cast = true, receive = true, occluder = true } = {}) {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = cast;
    m.receiveShadow = receive;
    if (occluder) m.layers.enable(LAYER_OCCLUDER);
    this.body.add(m);
    return m;
  }

  box(x0, x1, y0, y1, z0, z1, mat, { occ = true, rainPass = 0, windPass = 0, cast = true, solid = occ ? 1 : 0 } = {}) {
    const g = new THREE.BoxGeometry(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0));
    g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    this.mesh(g, mat, { cast, occluder: occ });
    if (occ) this.occ.box(new THREE.Vector3(Math.min(x0, x1), y0, Math.min(z0, z1)), new THREE.Vector3(Math.max(x0, x1), y1, Math.max(z0, z1)), this.matrix, rainPass, windPass);
    if (solid > 0) this.solids.box(x0, x1, y0, y1, z0, z1, solid);
  }

  extrude(poly, h, mat, { occ = true } = {}) {
    const shape = new THREE.Shape(poly.map(([x, z]) => new THREE.Vector2(x, -z)));
    const g = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
    g.rotateX(-Math.PI / 2);
    this.mesh(g, mat);
    if (occ) {
      const b = bounds(poly);
      this.occ.box(new THREE.Vector3(b.x0, 0, b.z0), new THREE.Vector3(b.x1, h, b.z1), this.matrix);
      this.solids.box(b.x0, b.x1, 0, h, b.z0, b.z1, 1);
    }
  }

  /*
   * A stand is lofted between an inner (pitch-side) and an outer polyline, both in local
   * coordinates with the same number of points. Each tier fills the depth fraction f0..f1
   * with `rows` stepped rows rising from y0 to y1.
   */
  stand(spec) {
    let inner = spec.inner.map((p) => p.slice()), outer = spec.outer.map((p) => p.slice());
    if (spec.resample) { inner = resample(inner, spec.resample); outer = resample(outer, spec.resample); }
    const mid = Math.floor(inner.length / 2);
    const o = [outer[mid][0] - inner[mid][0], outer[mid][1] - inner[mid][1]];
    const chord = [inner[inner.length - 1][0] - inner[0][0], inner[inner.length - 1][1] - inner[0][1]];
    if (chord[0] * -o[1] + chord[1] * o[0] < 0) { inner.reverse(); outer.reverse(); }
    const N = inner.length;
    const midLine = inner.map((p, i) => [(p[0] + outer[i][0]) / 2, (p[1] + outer[i][1]) / 2]);
    const cum = [0];
    for (let i = 1; i < N; i++) cum.push(cum[i - 1] + Math.hypot(midLine[i][0] - midLine[i - 1][0], midLine[i][1] - midLine[i - 1][1]));
    const total = cum[N - 1];
    const P = (i, f, y) => new THREE.Vector3(lerp(inner[i][0], outer[i][0], f), y, lerp(inner[i][1], outer[i][1], f));
    const W = (v) => v.clone().applyMatrix4(this.matrix);
    const block = spec.block ?? 26;
    const period = block * 0.5 + 1.2;
    const aisles = [];
    for (let s = period - 0.6; s < total - 1; s += period) aisles.push(s);

    for (const tier of spec.tiers) {
      const { f0, f1, rows, y0, y1 } = tier;
      const base0 = tier.base0 ?? 0, base1 = tier.base1 ?? 0;
      const rise = rows > 1 ? (y1 - y0) / (rows - 1) : 0;
      const top = [];
      for (let k = 0; k < rows; k++) {
        const fa = f0 + ((f1 - f0) * k) / rows, fb = f0 + ((f1 - f0) * (k + 1)) / rows, y = y0 + rise * k;
        top.push({ f: fa, y, v: k / rows }, { f: fb, y, v: (k + 1) / rows });
      }
      const loop = [...top, { f: f1, y: base1 }, { f: f0, y: base0 }];
      const depth = Math.hypot(outer[mid][0] - inner[mid][0], outer[mid][1] - inner[mid][1]) * (f1 - f0);

      const tex = seatTexture({
        length: total, rows, rowMetres: Math.hypot(depth / rows, rise),
        aisles: tier.aisles === false ? null : aisles, ...spec.look, ...(tier.look || {}),
      });
      const seatMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.75 });
      const sPos = [], sUv = [], cPos = [];
      const pushQuad = (arr, uvArr, A, B, C, D, uvs) => {
        for (const p of [A, B, C, A, C, D]) arr.push(p.x, p.y, p.z);
        if (uvArr) uvArr.push(uvs[0], uvs[1], uvs[2], uvs[3], uvs[4], uvs[5], uvs[0], uvs[1], uvs[4], uvs[5], uvs[6], uvs[7]);
      };
      for (let i = 0; i < N - 1; i++) {
        const u0 = cum[i] / total, u1 = cum[i + 1] / total;
        for (let j = 0; j < loop.length; j++) {
          const a = loop[j], b = loop[(j + 1) % loop.length];
          if (Math.abs(a.f - b.f) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) continue;
          const A = P(i, a.f, a.y), B = P(i + 1, a.f, a.y), C = P(i + 1, b.f, b.y), D = P(i, b.f, b.y);
          if (j < top.length - 1) pushQuad(sPos, sUv, A, B, C, D, [u0, a.v, u1, a.v, u1, b.v, u0, b.v]);
          else pushQuad(cPos, null, A, B, C, D);
        }
      }
      // End caps, wound so they face away from the stand.
      const prof = loop.map((q) => new THREE.Vector2(q.f, q.y));
      const tris = THREE.ShapeUtils.triangulateShape(prof, []);
      for (const [i, sign] of [[0, -1], [N - 1, 1]]) {
        const j0 = Math.max(0, i - 1), j1 = Math.min(N - 1, i + 1);
        const along = new THREE.Vector3(midLine[j1][0] - midLine[j0][0], 0, midLine[j1][1] - midLine[j0][1]).multiplyScalar(sign);
        for (const t of tris) {
          let [A, B, C] = t.map((k) => P(i, loop[k].f, loop[k].y));
          const n = new THREE.Vector3().subVectors(B, A).cross(new THREE.Vector3().subVectors(C, A));
          if (n.dot(along) < 0) [B, C] = [C, B];
          for (const p of [A, B, C]) cPos.push(p.x, p.y, p.z);
        }
      }
      const sg = new THREE.BufferGeometry();
      sg.setAttribute('position', new THREE.Float32BufferAttribute(sPos, 3));
      sg.setAttribute('uv', new THREE.Float32BufferAttribute(sUv, 2));
      sg.computeVertexNormals();
      this.mesh(sg, seatMat);
      const cg = new THREE.BufferGeometry();
      cg.setAttribute('position', new THREE.Float32BufferAttribute(cPos, 3));
      cg.computeVertexNormals();
      this.mesh(cg, spec.structure || M.concrete);

      // Occluders: rake plane, back wall with parapet, end walls. Solids: one wedge per segment.
      const yl = y0 + rise * (rows - 1);
      for (let i = 0; i < N - 1; i++) {
        this.occ.poly([W(P(i, f0, y0)), W(P(i + 1, f0, y0)), W(P(i + 1, f1, yl)), W(P(i, f1, yl))]);
        this.occ.poly([W(P(i, f1, base1)), W(P(i + 1, f1, base1)), W(P(i + 1, f1, yl + 1.1)), W(P(i, f1, yl + 1.1))]);
        this.solids.hexa([P(i, f0, base0), P(i, f1, base1), P(i, f1, yl + 1.1), P(i, f0, y0),
          P(i + 1, f0, base0), P(i + 1, f1, base1), P(i + 1, f1, yl + 1.1), P(i + 1, f0, y0)], 1);
      }
      for (const i of [0, N - 1]) this.occ.poly([W(P(i, f0, base0)), W(P(i, f1, base1)), W(P(i, f1, yl)), W(P(i, f0, y0))]);

      if (!spec.occupied) continue;
      // Seats: one spectator per 0.5 m, leaving the aisles free.
      for (let k = 0; k < rows; k++) {
        const fa = f0 + ((f1 - f0) * k) / rows, fb = f0 + ((f1 - f0) * (k + 1)) / rows;
        const f = fa + (fb - fa) * 0.55, y = y0 + rise * k;
        for (let i = 0; i < N - 1; i++) {
          const a = P(i, f, y), b = P(i + 1, f, y);
          const segLen = a.distanceTo(b);
          const steps = Math.max(1, Math.floor(segLen / 0.5));
          for (let s = 0; s < steps; s++) {
            const t = (s + 0.5) / steps;
            const u = cum[i] + (cum[i + 1] - cum[i]) * t;
            if (u < 0.8 || u > total - 0.8) continue;
            const phase = (u + 0.6) % period;
            if (tier.aisles !== false && phase < 1.2) continue;
            const x = lerp(a.x, b.x, t), z = lerp(a.z, b.z, t);
            const ix = lerp(inner[i][0], inner[i + 1][0], t) - lerp(outer[i][0], outer[i + 1][0], t);
            const iz = lerp(inner[i][1], inner[i + 1][1], t) - lerp(outer[i][1], outer[i + 1][1], t);
            this.seats.push({ x, y, z, yaw: Math.atan2(ix, iz), stand: spec.name });
          }
        }
      }
    }
    if (spec.label) this.label(spec.label, spec.labelAt, spec.labelKind || 'stand');
  }

  label(text, [x, y, z], kind = 'stand') { this.labels.push({ text, pos: this.local(x, y, z), kind }); }

  finish() {
    const n = this.seats.length;
    // A seated fan: torso, head and lap, sized so a full row hides the seats behind it.
    const body = new THREE.BoxGeometry(0.48, 0.72, 0.4).translate(0, 0.42 + 0.36, -0.02);
    const head = new THREE.BoxGeometry(0.24, 0.26, 0.26).translate(0, 0.42 + 0.72 + 0.14, 0.02);
    const lap = new THREE.BoxGeometry(0.46, 0.2, 0.46).translate(0, 0.42 + 0.1, 0.4);
    const geo = mergeGeometries([body, head, lap]);
    geo.setAttribute('aSway', new THREE.InstancedBufferAttribute(new Float32Array(n), 1));
    const mat = new THREE.MeshLambertMaterial();
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = timeUniform;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aSway;\nuniform float uTime;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          float ph = float(gl_InstanceID) * 2.3999;
          float gust = 0.6 + 0.4 * sin(uTime * 0.9 + ph * 0.11);
          transformed.x += sin(uTime * (3.5 + aSway * 4.0) + ph) * aSway * gust * 0.07 * (position.y + 0.3);`);
    };
    const mesh = new THREE.InstancedMesh(geo, mat, n);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
    this.heads = new Float32Array(n * 3);
    this.headsLocal = new Float32Array(n * 3);
    this.seatY = new Float32Array(n);
    this.tint = new Float32Array(n);
    // Corner sectors: seats diagonally beyond the corner flag, outside both the touchline and the goal line.
    this.corner = new Uint8Array(n);
    const w = new THREE.Vector3();
    this.seats.forEach((st, i) => {
      q.setFromAxisAngle(UP, st.yaw);
      p.set(st.x, st.y, st.z);
      m4.compose(p, q, s);
      mesh.setMatrixAt(i, m4);
      this.headsLocal.set([st.x, st.y + 1.15, st.z], i * 3);
      w.set(st.x, st.y + 1.15, st.z).applyMatrix4(this.matrix);
      this.heads[i * 3] = w.x; this.heads[i * 3 + 1] = w.y; this.heads[i * 3 + 2] = w.z;
      this.seatY[i] = w.y;
      this.tint[i] = 0.9 + rand() * 0.2;
      this.corner[i] = Math.abs(st.x) > 34 && Math.abs(st.z) > 52.5 ? 1 : 0;
    });
    this.colors = new Float32Array(n * 3);
    this.target = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) this.colors[i] = this.target[i] = 0.85;
    mesh.instanceColor = new THREE.InstancedBufferAttribute(this.colors, 3);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    this.body.add(mesh);
    this.crowd = mesh;
    this.sway = geo.getAttribute('aSway');
    this.packed = this.occ.pack();
  }
}

function resample(poly, n) {
  const d = [0];
  for (let i = 1; i < poly.length; i++) d.push(d[i - 1] + Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]));
  const total = d[d.length - 1], out = [];
  for (let k = 0; k < n; k++) {
    const t = (total * k) / (n - 1);
    let i = 1;
    while (i < d.length - 1 && d[i] < t) i++;
    const f = (t - d[i - 1]) / (d[i] - d[i - 1] || 1);
    out.push([lerp(poly[i - 1][0], poly[i][0], f), lerp(poly[i - 1][1], poly[i][1], f)]);
  }
  return out;
}

const timeUniform = { value: 0 };

function latticeTexture() {
  return canvasTex(64, 256, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.strokeStyle = '#b9c3ca';
    g.lineWidth = 5;
    g.strokeRect(0, 0, w, h);
    g.lineWidth = 3;
    for (let y = 0; y < h; y += 32) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y + 32); g.moveTo(w, y); g.lineTo(0, y + 32); g.stroke(); }
  }, { repeat: [1, 6] });
}

function floodlight(st, x, z, h) {
  const tower = new THREE.CylinderGeometry(0.7, 1.9, h, 4, 1, true);
  tower.translate(x, h / 2, z);
  const lattice = new THREE.MeshStandardMaterial({ map: latticeTexture(), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.5, metalness: 0.5, color: '#dfe6ea' });
  st.mesh(tower, lattice, { occluder: false });
  const toward = Math.atan2(-x, -z);
  const head = st.mesh(new THREE.BoxGeometry(10, 6.5, 1.2), M.steel, { occluder: false });
  head.position.set(x, h + 2.5, z);
  head.rotation.set(0.35, toward, 0, 'YXZ');
  const lamps = st.mesh(new THREE.PlaneGeometry(9.2, 5.8), M.lamp, { cast: false, occluder: false });
  lamps.position.set(x, h + 2.5, z);
  lamps.rotation.set(0.35, toward, 0, 'YXZ');
  lamps.translateZ(0.62);
}

function goals(st, halfLength) {
  for (const s of [-1, 1]) {
    const z = s * halfLength;
    for (const x of [-3.66, 3.66]) st.box(x - 0.06, x + 0.06, 0, 2.44, z - 0.06, z + 0.06, M.white, { occ: false, cast: true });
    st.box(-3.72, 3.72, 2.38, 2.5, z - 0.06, z + 0.06, M.white, { occ: false });
    const net = new THREE.BoxGeometry(7.32, 2.44, 2).translate(0, 1.22, z + s * 1);
    st.mesh(net, M.net, { cast: false, occluder: false });
  }
}

function pitch(st, { apron }) {
  const tex = pitchTexture();
  const g = new THREE.PlaneGeometry(111, 74);
  g.rotateX(-Math.PI / 2);
  g.rotateY(Math.PI / 2);
  g.translate(0, 0.45, 0);
  st.mesh(g, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }), { cast: false, occluder: false });
  if (apron) {
    const a = new THREE.Shape(apron.map(([x, z]) => new THREE.Vector2(x, -z)));
    const ag = new THREE.ShapeGeometry(a);
    ag.rotateX(-Math.PI / 2);
    ag.translate(0, 0.38, 0);
    st.mesh(ag, M.tartan, { cast: false, occluder: false });
  }
  goals(st, 52.5);
}

function signBoard(st, text, [x, y, z], w, h, bg, fg) {
  const tex = canvasTex(w * 32, h * 32, (g, cw, ch) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, cw, ch);
    g.fillStyle = fg;
    g.font = `italic 700 ${Math.round(ch * 0.46)}px Georgia, "Times New Roman", serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, cw / 2, ch / 2);
  });
  const board = st.mesh(new THREE.BoxGeometry(w, h, 0.4), [M.steel, M.steel, M.steel, M.steel, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6 }), M.steel], { occluder: false });
  board.position.set(x, y, z);
  board.rotation.y = Math.atan2(-x, -z);
  for (const d of [-w / 3, w / 3]) {
    const post = st.mesh(new THREE.BoxGeometry(0.4, y - h / 2, 0.4), M.steel, { occluder: false });
    post.position.set(x + Math.cos(board.rotation.y) * d, (y - h / 2) / 2, z - Math.sin(board.rotation.y) * d);
  }
}

// ------------------------------------------------------------------ today
// Stadion Maksimir in its full 35,123-seat layout: four open stands, none of them roofed.
const DINAMO_BLUE = '#2349b3';
const LOOK_TODAY = { seat: DINAMO_BLUE, back: '#1a3782', shade: '#2d55c4', aisle: '#f2c230' };
const LETTERS = (at, row, rows) => ({ text: { value: 'gnk dinamo', at, row, rows, color: '#f4f4ee' } });

function buildToday() {
  const st = new Stadium('today', { center: new THREE.Vector3(0, 0, 0), capacity: 35123, name: 'Danas', bowl: 26 });

  // Bowl floor: blue tartan of the former running track, then the pitch.
  const floor = [[-50.5, -83], [59, -83], [62, -64], [62, 64], [51.6, 75.6], [39.1, 88.7], [21.6, 97.3], [0.5, 100.8],
    [-19.4, 97.3], [-38.4, 87.1], [-50.3, 74.8], [-50.5, 56]];
  pitch(st, { apron: floor });
  const site = new THREE.Shape([[-112, -128], [108, -128], [108, 128], [-112, 128]].map(([x, z]) => new THREE.Vector2(x, -z)));
  const sg = new THREE.ShapeGeometry(site); sg.rotateX(-Math.PI / 2); sg.translate(0, 0.27, 0);
  st.mesh(sg, M.paving, { cast: false, occluder: false });

  // Zapad (west): lower ring, VIP glass band with the pink sponsor fascia, then the upper tier
  // carried on rows of massive pillars with the concourse underneath.
  st.stand({ name: 'zapad', inner: [[-50.5, 56], [-50.5, -64]], outer: [[-63, 56], [-63, -64]], occupied: true,
    tiers: [{ f0: 0, f1: 1, rows: 15, y0: 0.9, y1: 6.9 }], look: LOOK_TODAY });
  st.box(-67, -63, 6.9, 10.2, -64, 64, M.glassWarm);
  st.box(-67.5, -67, 9.4, 11.0, -60, 60, M.magenta, { occ: false });
  st.stand({ name: 'zapad', inner: [[-67, 64], [-67, -64]], outer: [[-93, 64], [-93, -64]], occupied: true,
    tiers: [{ f0: 0, f1: 1, rows: 30, y0: 11.0, y1: 27.2, base0: 10.2, base1: 10.2 }],
    look: { ...LOOK_TODAY, ...LETTERS(64, 7, 16) }, label: 'Zapad', labelAt: [-84, 36, 0] });
  st.box(-78, -67, 0, 6.9, -64, 64, M.glass);
  for (let z = -60; z <= 60; z += 12) {
    st.box(-86.4, -84.6, 0, 10.2, z - 0.9, z + 0.9, M.concrete, { solid: 0 });
    st.box(-94.6, -92.4, 0, 28.3, z - 1.1, z + 1.1, M.concrete, { solid: 0 });
  }
  st.solids.box(-93, -78, 0, 10.2, -64, 64, 0.3);

  // Sjever (north): two tiers in front of the glass office block, home of the Bad Blue Boys.
  st.stand({ name: 'sjever', inner: [[-55, -83], [59, -83]], outer: [[-55, -96], [59, -96]], occupied: true,
    tiers: [{ f0: 0, f1: 1, rows: 16, y0: 0.9, y1: 7.4 }], look: LOOK_TODAY });
  st.box(-55, 59, 7.4, 10.5, -99, -96, M.glassWarm);
  st.stand({ name: 'sjever', inner: [[-55, -99], [59, -99]], outer: [[-55, -118], [59, -118]], occupied: true,
    tiers: [{ f0: 0, f1: 1, rows: 24, y0: 10.5, y1: 23.4 }],
    look: { ...LOOK_TODAY, ...LETTERS(57, 5, 14) }, label: 'Sjever', labelAt: [2, 32, -108] });
  st.box(-55, 59, 0, 25.2, -122, -118, M.glass);

  // Istok (east): the 1961 stand, one long rake whose back is lifted on raking struts.
  st.stand({ name: 'istok', inner: [[62, 64], [62, -64]], outer: [[100, 64], [100, -64]], occupied: true,
    tiers: [{ f0: 0, f1: 1, rows: 44, y0: 1.2, y1: 19.3, base0: 0, base1: 6.5 }],
    look: { ...LOOK_TODAY, ...LETTERS(64, 12, 22) }, label: 'Istok', labelAt: [82, 28, 0] });
  const struts = [];
  for (let z = -60; z <= 60; z += 10) {
    const s = new THREE.CylinderGeometry(0.35, 0.35, 9.2, 6);
    s.rotateZ(0.72);
    s.translate(102.6, 3.3, z);
    struts.push(s);
  }
  st.mesh(mergeGeometries(struts), M.white, { occluder: false });
  st.solids.box(88, 106, 0, 6.5, -64, 64, 0.2);

  // Jug (south): the curved 1960s stand, lofted along its OSM outline, with its colonnade.
  const innerArc = [[51.6, 75.6], [48.4, 79.6], [46.5, 82.1], [39.1, 88.7], [31.0, 93.5], [21.6, 97.3], [15.9, 98.9], [9.6, 100.2],
    [5.0, 100.7], [0.5, 100.8], [-5.4, 100.3], [-8.2, 100.1], [-13.4, 99.2], [-19.4, 97.3], [-23.2, 95.9], [-27.7, 93.8],
    [-33.3, 90.7], [-38.4, 87.1], [-44.5, 81.8], [-46.7, 79.7], [-49.3, 76.5], [-50.3, 74.8]];
  const outerArc = [[59.6, 100.4], [50.0, 108.5], [40.8, 113.5], [25.5, 120.7], [20.2, 121.5], [11.5, 122.9], [0.7, 123.8],
    [-11.2, 122.7], [-20.8, 121.3], [-30.4, 118.0], [-40.2, 113.8], [-48.4, 107.7], [-58.8, 100.1]];
  st.stand({ name: 'jug', inner: innerArc, outer: outerArc, resample: 25, occupied: true, block: 22,
    tiers: [{ f0: 0, f1: 1, rows: 30, y0: 0.9, y1: 14.2 }], look: LOOK_TODAY,
    label: 'Jug', labelAt: [0, 24, 112] });
  const colonnade = resample(outerArc, 27);
  const cg = [];
  colonnade.forEach(([x, z], i) => {
    const r = Math.hypot(x, z - 60), ox = (x / r) * 1.6, oz = ((z - 60) / r) * 1.6;
    cg.push(new THREE.CylinderGeometry(0.45, 0.45, 15.2, 8).translate(x + ox, 7.6, z + oz));
    if (i < colonnade.length - 1) {
      const [x2, z2] = colonnade[i + 1];
      const len = Math.hypot(x2 - x, z2 - z);
      const beam = new THREE.BoxGeometry(len + 0.8, 1.1, 0.7);
      beam.rotateY(-Math.atan2(z2 - z, x2 - x));
      beam.translate((x + x2) / 2 + ox, 15.4, (z + z2) / 2 + oz);
      cg.push(beam);
    }
  });
  st.mesh(mergeGeometries(cg.map((g) => g.index ? g.toNonIndexed() : g)), M.white);
  const board = new THREE.BoxGeometry(15, 5.5, 0.8).translate(0, 19.5, 121.5);
  st.mesh(board, new THREE.MeshStandardMaterial({ color: '#1b1f24', roughness: 0.4, emissive: '#ffcf6b', emissiveIntensity: 0.08 }), { occluder: false });
  for (const x of [-5, 5]) st.box(x - 0.3, x + 0.3, 14, 17, 121.2, 121.8, M.steel, { occ: false });
  signBoard(st, 'Večernji list', [-46, 18.5, 108], 13, 4.2, '#d7263d', '#ffffff');

  // Corner blocks from OSM: ochre offices in the north-west, glass cylinder in the north-east.
  st.extrude([[-55.8, -121.9], [-96.1, -121.7], [-95.6, -65.8], [-62.5, -66.0], [-62.5, -60.4], [-55.2, -60.5], [-55.3, -64.1], [-55.4, -83.0]], 21, M.ochre);
  st.extrude([[83.0, -88.3], [82.9, -64.2], [101.1, -64.4], [109.7, -64.6], [110.0, -84.5], [95.7, -84.5], [95.7, -88.8]], 12, M.concrete);
  st.extrude([[60.2, -120.8], [67.4, -120.8], [67.2, -117.7], [70.9, -119.4], [73.2, -119.9], [75.5, -119.8], [78.7, -118.6],
    [81.0, -117.2], [83.1, -114.3], [84.1, -111.6], [84.4, -108.1], [83.5, -105.3], [82.2, -103.0], [79.7, -100.4], [75.6, -98.8],
    [73.1, -98.7], [70.4, -99.1], [68.8, -99.9], [67.3, -101.0], [68.8, -92.8], [68.8, -89.5], [60.0, -89.4]], 24, M.glass);

  for (const [x, z] of [[-60, -80], [61, -80], [-58, 70], [60, 70]]) floodlight(st, x, z, 50);
  // The open corners today: south-west and south-east, where the curved stand stops short of the long ones.
  st.probes = [[-58, 70], [60, 70]];
  st.rainBounds = [-120, 120, -135, 135, 44];
  st.finish();
  return st;
}

// ------------------------------------------------------------------ the winning scheme (VG13 Architects)
// The new stadium is a mesh of the winning entry drawn from its competition boards, kept in
// src/future-stadium.bin, which the build inlines as base64: indexed triangles per material in the stadium
// frame, quantised to 5 mm, and one line per block of seats. Here the parts become meshes, the seat lines
// spectators, and the solid parts a voxel model for the wind tunnel, the rain paths and the ray-traced fallback.

// Solid fraction of each part in the simulation. The perforated facade metal holds back a bit over half
// of the air; roof fins, trusses, light gantries and everything at pitch or plaza level stay out.
const SIM_PARTS = {
  roof: 1, roof_light: 1, roof_soffit: 1, seat: 1, concrete: 1, concrete_edge: 1, concrete_dark: 1,
  glass: 1, glass_dark: 1, mullion: 1, shadow: 1, facade: 0.55, facade_rib: 0.55,
};
const ROOF_PARTS = ['roof', 'roof_light', 'roof_soffit', 'roof_edge', 'truss', 'steel', 'lamp'];
const GROUND_PARTS = ['plaza', 'plaza_b', 'hardstand', 'turf_dark', 'turf_light', 'turf_edge', 'field_line', 'board', 'net'];
const TREAD = 0.44;   // the model's seat pans stand 0.44 m above the tread

// The file is gzipped: "MKS1", a u32 header length, a JSON header padded to 4 bytes, then the blocks the header
// points to. Per part: uint16 xyz positions in steps of `step` metres from `origin`, and uint16 triangle
// indices. Per block of seats: int16 [x0, z0, x1, z1, y, fx, fz, n], the ends of the line through the seat
// pans and its height in cm, the facing in 1/10000 and the number of seats.
async function loadFutureModel() {
  const b64 = document.getElementById('future-model').textContent.trim();
  const zipped = await fetch(`data:application/octet-stream;base64,${b64}`);
  const buf = await new Response(zipped.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  const size = new DataView(buf).getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, size)));
  const base = 8 + size, [ox, oy, oz] = header.origin, step = header.step;
  const parts = {};
  for (const p of header.parts) {
    const q = new Uint16Array(buf, base + p.positions, p.vertices * 3), pos = new Float32Array(q.length);
    for (let i = 0; i < q.length; i += 3) {
      pos[i] = ox + q[i] * step; pos[i + 1] = oy + q[i + 1] * step; pos[i + 2] = oz + q[i + 2] * step;
    }
    parts[p.name] = { pos, index: new Uint16Array(buf, base + p.indices, p.triangles * 3), material: p.material };
  }
  return { parts, rows: new Int16Array(buf, base + header.seatRows.offset, header.seatRows.count * 8) };
}

async function buildFuture() {
  const { parts, rows } = await loadFutureModel();
  const st = new Stadium('future', { center: FUTURE_CENTER, capacity: 35000, name: 'Novi', bowl: 38 });

  for (const [name, { pos, index, material: m }] of Object.entries(parts)) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(new THREE.BufferAttribute(index, 1));
    const mat = new THREE.MeshStandardMaterial({
      color: m.color, metalness: m.metalness, roughness: m.roughness, flatShading: true,
      side: m.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
      transparent: m.blend, opacity: m.blend ? m.opacity : 1, depthWrite: !m.blend,
    });
    const ground = GROUND_PARTS.includes(name);
    st.mesh(g, mat, { cast: !ground && !m.blend, occluder: !ground });
    if (ROOF_PARTS.includes(name)) st.roofMaterials.push(mat);
  }

  // A spectator on every seat of each block, and the blocks of one row, across aisles and vomitories,
  // joined into a line of stand that is solid below its tread.
  const lines = new Map();
  for (let r = 0; r < rows.length; r += 8) {
    const x0 = rows[r] / 100, z0 = rows[r + 1] / 100, x1 = rows[r + 2] / 100, z1 = rows[r + 3] / 100, y = rows[r + 4] / 100;
    const fx = rows[r + 5] / 1e4, fz = rows[r + 6] / 1e4, n = rows[r + 7];
    const yaw = Math.atan2(fx, fz), stand = fx > 0.5 ? 'zapad' : fx < -0.5 ? 'istok' : fz > 0.5 ? 'sjever' : 'jug';
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      st.seats.push({ x: lerp(x0, x1, t), y: y - TREAD, z: lerp(z0, z1, t), yaw, stand });
    }
    const d = ((x0 + x1) / 2) * fx + ((z0 + z1) / 2) * fz, a0 = -fz * x0 + fx * z0, a1 = -fz * x1 + fx * z1;
    const key = `${stand} ${Math.round(d * 10)} ${rows[r + 4]}`;
    const line = lines.get(key) || { fx, fz, d, y, a0: Infinity, a1: -Infinity };
    line.a0 = Math.min(line.a0, a0, a1);
    line.a1 = Math.max(line.a1, a0, a1);
    lines.set(key, line);
  }

  const vox = new VoxelModel({ x0: -98, x1: 98, z0: -102, z1: 106, top: 44 });
  for (const [name, s] of Object.entries(SIM_PARTS)) vox.surface(parts[name].pos, parts[name].index, Math.round(s * 255));
  // The tread runs from just in front of the seat pan back to the next row.
  for (const l of lines.values()) vox.fillBelow(l.fx, l.fz, l.a0, l.a1, l.d - 0.5, l.d + 0.35, l.y - TREAD);
  st.voxels = vox.close();
  st.rainBounds = [-98, 98, -102, 106, 46];

  st.label('Zapad', [-80, 46, 0]);
  st.label('Istok', [80, 46, 0]);
  st.label('Sjever', [0, 40, -86]);
  st.label('Jug', [0, 40, 88]);
  // The corners, open to the sky where the long roofs (±67 m) and the end roofs (±55 m) stop short of
  // each other, and open at the ground past the ends of the stands and the facades. The probes stand
  // where the opening is clear of every part at all four probe heights.
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) st.label('otvor', [80 * sx, 30, 90 * sz], 'hole');
  st.probes = [[-80, -90], [80, -90], [-80, 90], [80, 90]];
  st.finish();
  return st;
}
