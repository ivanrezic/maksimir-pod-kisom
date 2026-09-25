// ------------------------------------------------------------------ wind tunnel
/*
 * A 3D Lattice-Boltzmann wind tunnel on the GPU: D3Q19 (or D3Q15 where the GPU can only write four
 * float targets at once) with a Smagorinsky eddy viscosity. The grid is turned to face the wind, so
 * air always enters at x = 0 with a suburban power-law profile, leaves at x = nx, wraps sideways and
 * slips along the lid. Stands, roofs and facades are voxelised into a solid-fraction mask: solid cells
 * bounce the air back, perforated metal lets part of it through. What we keep is the time-averaged
 * velocity field around the stadium, as a fraction of the 10 m wind at the inlet, so one run per wind
 * direction serves every wind speed (at these Reynolds numbers the flow pattern does not change).
 *
 * The distributions live in 2D float textures: each horizontal layer of the grid is one tile.
 */
const LBM = (() => {
  const gl = renderer.getContext();
  const floatTargets = renderer.extensions.has('EXT_color_buffer_float');
  const drawBuffers = gl.getParameter(gl.MAX_DRAW_BUFFERS);
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
  return { ok: floatTargets && drawBuffers >= 4, q: drawBuffers >= 5 ? 19 : 15, software: /SwiftShader|llvmpipe|software/i.test(gpu) };
})();

const TUNNEL = (() => {
  // A software renderer gets a coarser tunnel so the page still answers in reasonable time.
  const dx = LBM.software ? 10 : 5;
  const up = 220, down = 300, width = 560, height = 140;
  const nx = Math.round((up + down) / dx), ny = Math.round(width / dx), nz = Math.round(height / dx);
  const tx = Math.ceil(Math.sqrt(nz));
  const steps = LBM.software ? { warm: 520, avg: 360, every: 3 } : { warm: 1100, avg: 900, every: 3 };
  return { dx, up, nx, ny, nz, tx, W: nx * tx, H: ny * Math.ceil(nz / tx), ...steps };
})();
const U_LATTICE = 0.075;   // lattice speed of the 10 m inlet wind
const windProfile = (y) => Math.pow(Math.max(y, 2) / 10, 0.22);
const SEAT_FACTOR = Math.log(1 / 0.1) / Math.log(7.5 / 0.1);   // head 1 m above the seats vs. the flow ~7.5 m up

function velocitySet(q) {
  const c = q === 19
    ? [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [1, 1, 0], [-1, -1, 0], [1, -1, 0], [-1, 1, 0],
      [1, 0, 1], [-1, 0, -1], [1, 0, -1], [-1, 0, 1], [0, 1, 1], [0, -1, -1], [0, 1, -1], [0, -1, 1]]
    : [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [1, 1, 1], [-1, -1, -1], [1, 1, -1], [-1, -1, 1],
      [1, -1, 1], [-1, 1, -1], [-1, 1, 1], [1, -1, -1]];
  const w = c.map((v) => {
    const n = Math.abs(v[0]) + Math.abs(v[1]) + Math.abs(v[2]);
    return q === 19 ? [1 / 3, 1 / 18, 1 / 36][n] : [2 / 9, 1 / 9, 0, 1 / 72][n];
  });
  const opp = c.map((v) => c.findIndex((u) => u[0] === -v[0] && u[1] === -v[1] && u[2] === -v[2]));
  const mir = c.map((v) => c.findIndex((u) => u[0] === v[0] && u[1] === v[1] && u[2] === -v[2]));
  return { c, w, opp, mir };
}

function lbmSources(set) {
  const T = TUNNEL, Q = set.c.length, NT = Math.ceil(Q / 4), CH = 'xyzw';
  const range = (n) => Array.from({ length: n }, (_, k) => k);
  const common = `precision highp float;
precision highp int;
precision highp sampler2D;
#define Q ${Q}
const int NX = ${T.nx}, NY = ${T.ny}, NZ = ${T.nz}, TX = ${T.tx};
const float DX = ${T.dx.toFixed(2)};
const vec3 C[Q] = vec3[Q](${set.c.map((v) => `vec3(${v.map((x) => x.toFixed(1)).join(', ')})`).join(', ')});
const float WT[Q] = float[Q](${set.w.map((x) => x.toFixed(9)).join(', ')});
const int OPP[Q] = int[Q](${set.opp.join(', ')});
uniform sampler2D uMask;
${range(NT).map((k) => `uniform sampler2D uF${k};`).join('\n')}
uniform float uURef;
ivec3 cellOf(ivec2 t) { int a = t.x / NX, b = t.y / NY; return ivec3(t.x - a * NX, t.y - b * NY, b * TX + a); }
ivec2 texOf(ivec3 c) { return ivec2(c.x + (c.z % TX) * NX, c.y + (c.z / TX) * NY); }
float feq(int i, float rho, vec3 u) { float cu = dot(C[i], u); return WT[i] * rho * (1.0 + 3.0 * cu + 4.5 * cu * cu - 1.5 * dot(u, u)); }
vec3 inflow(int z) { float h = (float(z) + 0.5) * DX; return vec3(uURef * pow(max(h, 2.0) / 10.0, 0.22), 0.0, 0.0); }
`;
  const outs = range(NT).map((k) => `layout(location = ${k}) out vec4 o${k};`).join('\n');
  const write = (a) => range(NT).map((k) => `o${k} = vec4(${range(4).map((j) => (4 * k + j < Q ? `${a}[${4 * k + j}]` : '0.0')).join(', ')});`).join(' ');
  const load = (a) => range(NT).map((k) => `vec4 L${k} = texelFetch(uF${k}, t, 0);`).join(' ') + '\n  ' +
    set.c.map((_, i) => `${a}[${i}] = L${i >> 2}.${CH[i & 3]};`).join(' ');
  // Pull streaming: each direction reads the neighbour it arrives from. The ground is free-slip:
  // a population arriving from below is the mirror image of one that left sideways a step earlier,
  // so the inlet profile reaches the stadium instead of being worn down by a 5 m no-slip floor.
  const pulls = set.c.map((c, i) => {
    if (i === 0) return 'f[0] = me[0];';
    const o = set.opp[i], r = set.mir[i];
    return `s = p - ivec3(${c.join(', ')});
  if (s.z < 0) { q = texOf(ivec3(clamp(s.x, 0, NX - 1), (s.y + NY) % NY, 0)); f[${i}] = texelFetch(uMask, q, 0).r > 0.99 ? me[${o}] : texelFetch(uF${r >> 2}, q, 0).${CH[r & 3]}; }
  else if (s.z >= NZ) f[${i}] = feq(${i}, 1.0, inflow(NZ - 1));
  else if (s.x < 0) f[${i}] = feq(${i}, 1.0, inflow(s.z));
  else if (s.x >= NX) f[${i}] = me[${i}];
  else { s.y = (s.y + NY) % NY; q = texOf(s); f[${i}] = texelFetch(uMask, q, 0).r > 0.99 ? me[${o}] : texelFetch(uF${i >> 2}, q, 0).${CH[i & 3]}; }`;
  }).join('\n  ');

  return {
    vertex: 'in vec3 position;\nvoid main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
    init: `${common}
${outs}
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 p = cellOf(t);
  float o[Q];
  vec3 u = (p.z >= NZ || texelFetch(uMask, t, 0).r > 0.99) ? vec3(0.0) : inflow(p.z);
  for (int i = 0; i < Q; i++) o[i] = feq(i, 1.0, u);
  ${write('o')}
}`,
    step: `${common}
uniform float uTau0;
uniform float uCs2;
${outs}
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 p = cellOf(t);
  float o[Q];
  if (p.z >= NZ) { for (int i = 0; i < Q; i++) o[i] = 0.0; ${write('o')} return; }
  float m = texelFetch(uMask, t, 0).r;
  if (m > 0.99) { for (int i = 0; i < Q; i++) o[i] = WT[i]; ${write('o')} return; }
  float me[Q];
  float f[Q];
  ${load('me')}
  ivec3 s;
  ivec2 q;
  ${pulls}
  float rho = 0.0;
  vec3 mom = vec3(0.0);
  for (int i = 0; i < Q; i++) { rho += f[i]; mom += f[i] * C[i]; }
  vec3 u = mom / max(rho, 1e-3);
  if (!(rho > 0.3 && rho < 3.0) || any(isnan(u))) { rho = 1.0; u = inflow(p.z); for (int i = 0; i < Q; i++) f[i] = feq(i, 1.0, u); }
  float un = length(u);
  if (un > 0.3) u *= 0.3 / un;
  float fe[Q];
  float pxx = 0.0, pyy = 0.0, pzz = 0.0, pxy = 0.0, pxz = 0.0, pyz = 0.0;
  for (int i = 0; i < Q; i++) {
    fe[i] = feq(i, rho, u);
    float n = f[i] - fe[i];
    vec3 c = C[i];
    pxx += c.x * c.x * n; pyy += c.y * c.y * n; pzz += c.z * c.z * n;
    pxy += c.x * c.y * n; pxz += c.x * c.z * n; pyz += c.y * c.z * n;
  }
  // Smagorinsky: relax more where the flow is shearing hard.
  float qn = sqrt(pxx * pxx + pyy * pyy + pzz * pzz + 2.0 * (pxy * pxy + pxz * pxz + pyz * pyz));
  float tau = 0.5 * (uTau0 + sqrt(uTau0 * uTau0 + 25.456 * uCs2 * qn / rho));
  // Porous cells (perforated facade, colonnades) bounce part of the air back.
  float ns = 0.6 * m;
  for (int i = 0; i < Q; i++) o[i] = mix(f[i] - (f[i] - fe[i]) / tau, f[OPP[i]], ns);
  ${write('o')}
}`,
    acc: `${common}
uniform sampler2D uAvg;
layout(location = 0) out vec4 oAvg;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 p = cellOf(t);
  vec4 prev = texelFetch(uAvg, t, 0);
  if (p.z >= NZ || texelFetch(uMask, t, 0).r > 0.99) { oAvg = prev; return; }
  float me[Q];
  ${load('me')}
  float rho = 0.0;
  vec3 mom = vec3(0.0);
  for (int i = 0; i < Q; i++) { rho += me[i]; mom += me[i] * C[i]; }
  vec3 u = mom / max(rho, 1e-3);
  oAvg = prev + vec4(u, length(u));
}`,
  };
}

// The tunnel frame: x downwind, y across, origin at the inlet's near corner on the ground.
function tunnelFrame(center, from) {
  const b = from * DEG;
  const ex = new THREE.Vector3(-Math.sin(b), 0, Math.cos(b));
  const ey = new THREE.Vector3(-ex.z, 0, ex.x);
  const origin = center.clone().addScaledVector(ex, -TUNNEL.up).addScaledVector(ey, (-TUNNEL.ny * TUNNEL.dx) / 2);
  origin.y = 0;
  return { from, ex, ey, origin };
}

function voxelizeTunnel(st, frame) {
  const { nx, ny, nz, dx, tx, W, H } = TUNNEL;
  const grid = new Uint8Array(nx * ny * nz);
  const inv = st.matrix.clone().invert();
  const R = new THREE.Matrix3().setFromMatrix4(inv);
  const c0 = frame.origin.clone().addScaledVector(frame.ex, 0.5 * dx).addScaledVector(frame.ey, 0.5 * dx).add(new THREE.Vector3(0, 0.5 * dx, 0)).applyMatrix4(inv);
  const di = frame.ex.clone().multiplyScalar(dx).applyMatrix3(R), dj = frame.ey.clone().multiplyScalar(dx).applyMatrix3(R);
  const toGrid = (w) => {
    const rx = w.x - frame.origin.x, rz = w.z - frame.origin.z;
    return [(rx * frame.ex.x + rz * frame.ex.z) / dx - 0.5, (rx * frame.ey.x + rz * frame.ey.z) / dx - 0.5, w.y / dx - 0.5];
  };
  if (st.voxels) {
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const v = st.voxels.cell(c0.x + di.x * i + dj.x * j, c0.y + k * dx, c0.z + di.z * i + dj.z * j, dx);
      if (v) grid[(k * ny + j) * nx + i] = v;
    }
  }
  for (const s of st.solids.resolve()) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const x of [s.min.x, s.max.x]) for (const y of [s.min.y, s.max.y]) for (const z of [s.min.z, s.max.z]) {
      const g = toGrid(new THREE.Vector3(x, y, z).applyMatrix4(st.matrix));
      for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], g[a]); hi[a] = Math.max(hi[a], g[a]); }
    }
    const i0 = Math.max(0, Math.floor(lo[0])), i1 = Math.min(nx - 1, Math.ceil(hi[0]));
    const j0 = Math.max(0, Math.floor(lo[1])), j1 = Math.min(ny - 1, Math.ceil(hi[1]));
    const k0 = Math.max(0, Math.floor(lo[2])), k1 = Math.min(nz - 1, Math.ceil(hi[2]));
    const val = Math.round(s.s * 255);
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = c0.x + di.x * i + dj.x * j, y = c0.y + k * dx, z = c0.z + di.z * i + dj.z * j;
      if (!insideSolid(s.planes, x, y, z)) continue;
      const q = (k * ny + j) * nx + i;
      if (grid[q] < val) grid[q] = val;
    }
  }
  const atlas = new Uint8Array(W * H);
  for (let k = 0; k < nz; k++) {
    const ox = (k % tx) * nx, oy = Math.floor(k / tx) * ny;
    for (let j = 0; j < ny; j++) atlas.set(grid.subarray((k * ny + j) * nx, (k * ny + j + 1) * nx), (oy + j) * W + ox);
  }
  return { grid, atlas };
}

class WindTunnel {
  constructor() {
    const T = TUNNEL;
    this.set = velocitySet(LBM.q);
    this.nTex = Math.ceil(this.set.c.length / 4);
    const opts = { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, generateMipmaps: false };
    this.f = [0, 1].map(() => new THREE.WebGLRenderTarget(T.W, T.H, { ...opts, count: this.nTex }));
    this.avg = [0, 1].map(() => new THREE.WebGLRenderTarget(T.W, T.H, opts));
    this.maskTex = new THREE.DataTexture(new Uint8Array(T.W * T.H), T.W, T.H, THREE.RedFormat, THREE.UnsignedByteType);
    this.maskTex.unpackAlignment = 1;
    this.maskTex.minFilter = this.maskTex.magFilter = THREE.NearestFilter;
    this.maskTex.generateMipmaps = false;
    const src = lbmSources(this.set);
    // tau0 sets a small molecular viscosity; the Smagorinsky constant is 0.17.
    this.uniforms = { uMask: { value: this.maskTex }, uURef: { value: U_LATTICE }, uTau0: { value: 0.506 }, uCs2: { value: 0.0289 }, uAvg: { value: null } };
    for (let k = 0; k < this.nTex; k++) this.uniforms['uF' + k] = { value: null };
    const mat = (fs) => new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: src.vertex, fragmentShader: fs, uniforms: this.uniforms, depthTest: false, depthWrite: false });
    this.mInit = mat(src.init);
    this.mStep = mat(src.step);
    this.mAcc = mat(src.acc);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.quad = new THREE.Mesh(g, this.mInit);
    this.quad.frustumCulled = false;
    this.qScene = new THREE.Scene();
    this.qScene.add(this.quad);
    this.qCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.job = null;
  }
  get total() { return TUNNEL.warm + TUNNEL.avg; }
  pass(mat, target) { this.quad.material = mat; renderer.setRenderTarget(target); renderer.render(this.qScene, this.qCam); }
  bind(rt) { for (let k = 0; k < this.nTex; k++) this.uniforms['uF' + k].value = rt.textures[k]; }
  begin(st, from) {
    const frame = tunnelFrame(st.center, from);
    const { grid, atlas } = voxelizeTunnel(st, frame);
    this.maskTex.image.data.set(atlas);
    this.maskTex.needsUpdate = true;
    this.job = { st, from, frame, grid, step: 0, cur: 0, acur: 0, samples: 0 };
    this.pass(this.mInit, this.f[0]);
    const cc = renderer.getClearColor(new THREE.Color()), ca = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    for (const rt of this.avg) { renderer.setRenderTarget(rt); renderer.clear(true, false, false); }
    renderer.setClearColor(cc, ca);
    renderer.setRenderTarget(null);
  }
  advance(n) {
    const j = this.job;
    for (let s = 0; s < n && j.step < this.total; s++) {
      this.bind(this.f[j.cur]);
      this.pass(this.mStep, this.f[1 - j.cur]);
      j.cur = 1 - j.cur;
      j.step++;
      if (j.step > TUNNEL.warm && j.step % TUNNEL.every === 0) {
        this.bind(this.f[j.cur]);
        this.uniforms.uAvg.value = this.avg[j.acur].texture;
        this.pass(this.mAcc, this.avg[1 - j.acur]);
        j.acur = 1 - j.acur;
        j.samples++;
      }
    }
    renderer.setRenderTarget(null);
    return j.step / this.total;
  }
  collect() {
    const j = this.job, T = TUNNEL;
    const buf = new Float32Array(T.W * T.H * 4);
    renderer.readRenderTargetPixels(this.avg[j.acur], 0, 0, T.W, T.H, buf);
    this.job = null;
    return new WindField(j.from, j.frame, buf, j.grid, j.samples);
  }
}

// The averaged flow around one stadium for one wind direction, as fractions of the 10 m inlet wind.
class WindField {
  constructor(from, frame, buf, grid, samples) {
    const { nx, ny, nz, tx, W, dx } = TUNNEL;
    Object.assign(this, { from, frame, mask: grid, nx, ny, nz, dx });
    const data = new Float32Array(nx * ny * nz * 4);
    const k = 1 / Math.max(samples, 1);
    for (let z = 0; z < nz; z++) {
      const ox = (z % tx) * nx, oy = Math.floor(z / tx) * ny;
      for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
        const s = ((oy + y) * W + ox + x) * 4, d = ((z * ny + y) * nx + x) * 4;
        data[d] = buf[s] * k; data[d + 1] = buf[s + 1] * k; data[d + 2] = buf[s + 2] * k; data[d + 3] = buf[s + 3] * k;
      }
    }
    // Normalise by the along-wind speed measured at 10 m just inside the inlet.
    const zr = 10 / dx - 0.5, z0 = Math.floor(zr), t = zr - z0;
    let sum = 0, cnt = 0;
    for (let x = 2; x < 5; x++) for (let y = 0; y < ny; y++) {
      const a = data[((z0 * ny + y) * nx + x) * 4], b = data[((Math.min(nz - 1, z0 + 1) * ny + y) * nx + x) * 4];
      sum += lerp(a, b, t); cnt++;
    }
    this.uref = sum / cnt || U_LATTICE;
    for (let i = 0; i < data.length; i++) data[i] /= this.uref;
    this.data = data;
    this.tmp = new Float32Array(4);
  }
  // Trilinear average over the fluid neighbours. Returns false outside the tunnel.
  sample(p, out) {
    const f = this.frame, dx = this.dx;
    const rx = p.x - f.origin.x, rz = p.z - f.origin.z;
    const gx = (rx * f.ex.x + rz * f.ex.z) / dx - 0.5, gy = (rx * f.ey.x + rz * f.ey.z) / dx - 0.5;
    const gz = clamp(p.y / dx - 0.5, 0, this.nz - 1.001);
    if (gx < 0 || gy < 0 || gx > this.nx - 1.001 || gy > this.ny - 1.001) return false;
    const i0 = Math.floor(gx), j0 = Math.floor(gy), k0 = Math.floor(gz);
    const tx = gx - i0, ty = gy - j0, tz = gz - k0;
    out[0] = out[1] = out[2] = out[3] = 0;
    let ws = 0;
    for (let c = 0; c < 8; c++) {
      const i = i0 + (c & 1), j = j0 + ((c >> 1) & 1), k = Math.min(this.nz - 1, k0 + (c >> 2));
      const q = (k * this.ny + j) * this.nx + i;
      if (this.mask[q] >= 250) continue;
      const w = (c & 1 ? tx : 1 - tx) * ((c >> 1) & 1 ? ty : 1 - ty) * (c >> 2 ? tz : 1 - tz);
      out[0] += w * this.data[q * 4]; out[1] += w * this.data[q * 4 + 1]; out[2] += w * this.data[q * 4 + 2]; out[3] += w * this.data[q * 4 + 3];
      ws += w;
    }
    if (ws > 1e-4) for (let a = 0; a < 4; a++) out[a] /= ws;
    return true;
  }
  solidAt(p) {
    const f = this.frame, dx = this.dx;
    const rx = p.x - f.origin.x, rz = p.z - f.origin.z;
    const i = Math.floor((rx * f.ex.x + rz * f.ex.z) / dx), j = Math.floor((rx * f.ey.x + rz * f.ey.z) / dx), k = Math.floor(p.y / dx);
    if (i < 0 || j < 0 || k < 0 || i >= this.nx || j >= this.ny || k >= this.nz) return false;
    return this.mask[(k * this.ny + j) * this.nx + i] >= 250;
  }
  // Wind felt by a seated spectator. The open cell touching the stand is held back by the no-slip wall
  // across its whole 5 m, so we read the flow over the stand one cell higher (about 7 m above the rake,
  // unless a roof is in the way) and bring it down to head height, 1 m above the seats, with a log
  // profile over a rough surface (z0 = 0.1 m).
  seatSpeed(p) {
    const f = this.frame, dx = this.dx;
    const rx = p.x - f.origin.x, rz = p.z - f.origin.z;
    const i = Math.round((rx * f.ex.x + rz * f.ex.z) / dx - 0.5), j = Math.round((rx * f.ey.x + rz * f.ey.z) / dx - 0.5);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return windProfile(p.y) * SEAT_FACTOR;
    const col = (k) => (k * this.ny + j) * this.nx + i;
    for (let k = Math.max(0, Math.floor(p.y / dx - 0.5)); k < this.nz - 1; k++) {
      if (this.mask[col(k)] >= 250) continue;
      const q = this.mask[col(k + 1)] < 250 ? col(k + 1) : col(k);
      return this.data[q * 4 + 3] * SEAT_FACTOR;
    }
    return 0;
  }
  // Mean speed felt at a point (fluctuations included), as a fraction of the 10 m wind.
  speed(p) { return this.sample(p, this.tmp) ? this.tmp[3] : windProfile(p.y); }
  // Mean velocity in world axes.
  vel(p, out) {
    const f = this.frame;
    if (!this.sample(p, this.tmp)) return out.copy(f.ex).multiplyScalar(windProfile(p.y));
    const t = this.tmp;
    return out.set(f.ex.x * t[0] + f.ey.x * t[1], t[2], f.ex.z * t[0] + f.ey.z * t[1]);
  }
}

// ------------------------------------------------------------------ rain through the simulated wind
// A 2 m voxel mask of each stadium in its own coordinates, for the drop paths.
const RAIN_GRID = 2;
function rainMask(st, [x0, x1, z0, z1, top]) {
  const dx = RAIN_GRID, nx = Math.ceil((x1 - x0) / dx), nz = Math.ceil((z1 - z0) / dx), ny = Math.ceil(top / dx);
  const mask = new Uint8Array(nx * ny * nz);
  if (st.voxels) {
    for (let k = 0; k < ny; k++) for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      mask[(k * nz + j) * nx + i] = st.voxels.cell(x0 + (i + 0.5) * dx, (k + 0.5) * dx, z0 + (j + 0.5) * dx, dx);
    }
  }
  for (const s of st.solids.resolve()) {
    const i0 = Math.max(0, Math.floor((s.min.x - x0) / dx)), i1 = Math.min(nx - 1, Math.floor((s.max.x - x0) / dx));
    const j0 = Math.max(0, Math.floor((s.min.z - z0) / dx)), j1 = Math.min(nz - 1, Math.floor((s.max.z - z0) / dx));
    const k0 = Math.max(0, Math.floor(s.min.y / dx)), k1 = Math.min(ny - 1, Math.floor(s.max.y / dx));
    const val = Math.round(s.s * 255);
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      if (!insideSolid(s.planes, x0 + (i + 0.5) * dx, (k + 0.5) * dx, z0 + (j + 0.5) * dx)) continue;
      const q = (k * nz + j) * nx + i;
      if (mask[q] < val) mask[q] = val;
    }
  }
  return { mask, g: { x0, z0, dx, nx, ny, nz, top } };
}

// Worker: follows each drop backwards from a spectator's head, through the simulated wind and
// the falling speed of the drop, until it is above every roof (wet) or hits something (dry).
function rainWorkerMain() {
  let heads, mask, g, field = null, cover = null, cell = -1;
  const STEP = 1.2;
  const v = new Float32Array(3);
  function solid(x, y, z) {
    const i = Math.floor((x - g.x0) / g.dx), j = Math.floor((z - g.z0) / g.dx), k = Math.floor(y / g.dx);
    if (i < 0 || j < 0 || i >= g.nx || j >= g.nz || k >= g.ny) return -1;
    if (k < 0) return 255;
    cell = (k * g.nz + j) * g.nx + i;
    return mask[cell];
  }
  function air(x, y, z) {
    const f = field, A = f.A;
    const i = Math.round(A[0] * x + A[1] * y + A[2] * z + A[3]);
    const j = Math.round(A[4] * x + A[5] * y + A[6] * z + A[7]);
    const k = Math.max(0, Math.round(A[8] * x + A[9] * y + A[10] * z + A[11]));
    if (i >= 0 && j >= 0 && i < f.nx && j < f.ny && k < f.nz) {
      const q = (k * f.ny + j) * f.nx + i;
      if (f.mask[q] >= 250) { v[0] = v[1] = v[2] = 0; return; }
      const a = f.data[q * 3], b = f.data[q * 3 + 1], c = f.data[q * 3 + 2], V = f.V;
      v[0] = V[0] * a + V[1] * b + V[2] * c; v[1] = V[3] * a + V[4] * b + V[5] * c; v[2] = V[6] * a + V[7] * b + V[8] * c;
      return;
    }
    const pr = Math.pow(Math.max(y, 2) / 10, 0.22);
    v[0] = f.dir[0] * pr; v[1] = 0; v[2] = f.dir[2] * pr;
  }
  function trace(U, vt, gusts) {
    const n = heads.length / 3, out = new Float32Array(n);
    for (let s = 0; s < n; s++) {
      let acc = 0;
      for (const [gust, w] of gusts) {
        let x = heads[3 * s], y = heads[3 * s + 1], z = heads[3 * s + 2], trans = 1, run = 0, last = -1;
        for (let it = 0; it < 400; it++) {
          let ax = 0, ay = 0, az = 0;
          if (U > 0 && field) { air(x, y, z); ax = v[0] * U * gust; ay = v[1] * U * gust; az = v[2] * U * gust; }
          const dy = ay - vt;
          const dt = STEP / Math.hypot(ax, dy, az);
          x -= ax * dt; y -= dy * dt; z -= az * dt;
          run += STEP;
          if (y > g.top) break;
          if (run < 2.4) continue;
          const m = solid(x, y, z);
          if (m < 0) break;
          if (m >= 250) { trans = 0; break; }
          if (m > 0 && cell !== last) { trans *= 1 - (0.75 * m) / 255; last = cell; }
        }
        acc += w * trans;
      }
      out[s] = acc;
    }
    return out;
  }
  self.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'init') { heads = m.heads; mask = m.mask; g = m.g; return; }
    if (m.type === 'field') { field = m.field; return; }
    if (!cover) cover = trace(0, 6, [[1, 1]]);
    const wet = m.rain > 0 ? trace(m.U, m.vt, [[0.65, 0.25], [1, 0.5], [1.35, 0.25]]) : new Float32Array(heads.length / 3);
    self.postMessage({ id: m.id, wet, cover: cover.slice() }, [wet.buffer]);
  };
}
const rainWorkerURL = URL.createObjectURL(new Blob([`(${rainWorkerMain.toString()})()`], { type: 'text/javascript' }));

class RainSim {
  constructor(st, bounds, onResult) {
    this.st = st;
    this.worker = new Worker(rainWorkerURL);
    const { mask, g } = rainMask(st, bounds);
    this.worker.postMessage({ type: 'init', heads: st.headsLocal, mask, g });
    this.busy = false;
    this.pending = null;
    this.seq = 0;
    this.worker.onmessage = (e) => {
      this.busy = false;
      onResult(this.st, e.data);
      if (this.pending) { const p = this.pending; this.pending = null; this.run(p); }
    };
  }
  setField(field) {
    const st = this.st, f = field.frame, dx = field.dx;
    const inv = st.matrix.clone().invert(), R = new THREE.Matrix3().setFromMatrix4(inv);
    const t = new THREE.Vector3().setFromMatrixPosition(st.matrix);
    const Rex = f.ex.clone().applyMatrix3(R), Rey = f.ey.clone().applyMatrix3(R), Rup = UP.clone().applyMatrix3(R);
    // local -> tunnel cell (affine), and tunnel velocity -> local velocity.
    const A = [
      Rex.x / dx, Rex.y / dx, Rex.z / dx, ((t.x - f.origin.x) * f.ex.x + (t.z - f.origin.z) * f.ex.z) / dx - 0.5,
      Rey.x / dx, Rey.y / dx, Rey.z / dx, ((t.x - f.origin.x) * f.ey.x + (t.z - f.origin.z) * f.ey.z) / dx - 0.5,
      0, 1 / dx, 0, t.y / dx - 0.5,
    ];
    const V = [Rex.x, Rey.x, Rup.x, Rex.y, Rey.y, Rup.y, Rex.z, Rey.z, Rup.z];
    const n = field.nx * field.ny * field.nz, data = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { data[i * 3] = field.data[i * 4]; data[i * 3 + 1] = field.data[i * 4 + 1]; data[i * 3 + 2] = field.data[i * 4 + 2]; }
    this.worker.postMessage({ type: 'field', field: { nx: field.nx, ny: field.ny, nz: field.nz, data, mask: field.mask, A, V, dir: [Rex.x, Rex.y, Rex.z] } }, [data.buffer]);
  }
  run(p) {
    if (this.busy) { this.pending = p; return; }
    this.busy = true;
    this.worker.postMessage({ type: 'run', id: ++this.seq, U: p.wind, vt: fallSpeed(p.rain), rain: p.rain });
  }
}

// ------------------------------------------------------------------ job queue
// One tunnel, many requests: the views' current wind direction first, then any sweep of directions.
class Aero {
  constructor(onField, onProgress) {
    this.tunnel = new WindTunnel();
    this.queue = [];
    this.cache = new Map();
    this.current = null;
    this.steps = LBM.software ? 4 : 12;
    this.onField = onField;
    this.onProgress = onProgress;
  }
  key(st, from) { return `${st.key}:${from}`; }
  request(st, from) {
    const hit = this.cache.get(this.key(st, from));
    this.queue = this.queue.filter((j) => !(j.kind === 'view' && j.st === st));
    if (this.current && this.current.kind === 'view' && this.current.st === st && this.current.from !== from) {
      this.tunnel.job = null;
      this.current = null;
    }
    if (hit) { this.onField(st, hit, 'view'); return; }
    if (this.current && this.current.st === st && this.current.from === from) { this.current.kind = 'view'; return; }
    this.queue.unshift({ st, from, kind: 'view' });
  }
  sweep(jobs) { for (const j of jobs) this.queue.push({ ...j, kind: 'sweep' }); }
  get busy() { return !!this.current || this.queue.length > 0; }
  tick(dt) {
    if (dt < 1 / 40) this.steps = Math.min(LBM.software ? 8 : 48, this.steps + 1);
    else if (dt > 1 / 22) this.steps = Math.max(2, Math.floor(this.steps * 0.8));
    if (!this.current) {
      const next = this.queue.shift();
      if (!next) return;
      const hit = this.cache.get(this.key(next.st, next.from));
      if (hit) { this.onField(next.st, hit, next.kind); return; }
      this.current = next;
      this.tunnel.begin(next.st, next.from);
    }
    const prog = this.tunnel.advance(this.steps);
    this.onProgress(this.current, prog, this.queue);
    if (prog < 1) return;
    const field = this.tunnel.collect();
    const job = this.current;
    this.current = null;
    this.cache.set(this.key(job.st, job.from), field);
    while (this.cache.size > 12) this.cache.delete(this.cache.keys().next().value);
    this.onField(job.st, field, job.kind);
    if (!this.busy) this.onProgress(null, 1, []);
  }
}

// Wind at every seat, in the corner sectors, and through the corner openings, from one field.
function fieldStats(st, field) {
  const n = st.seats.length, ratio = new Float32Array(n), p = new THREE.Vector3();
  let cs = 0, cn = 0, rs = 0, rn = 0;
  for (let i = 0; i < n; i++) {
    p.set(st.heads[i * 3], st.heads[i * 3 + 1], st.heads[i * 3 + 2]);
    ratio[i] = field.seatSpeed(p);
    if (st.corner[i]) { cs += ratio[i]; cn++; } else { rs += ratio[i]; rn++; }
  }
  const heights = [8, 14, 20, 26];
  const free = heights.reduce((a, h) => a + windProfile(h), 0) / heights.length;
  let hole = 0;
  for (const [x, z] of st.probes) {
    let s = 0;
    for (const h of heights) s += field.speed(st.local(x, h, z));
    hole = Math.max(hole, s / heights.length / free);
  }
  return { ratio, corner: cn ? cs / cn : 0, rest: rn ? rs / rn : 0, hole };
}
