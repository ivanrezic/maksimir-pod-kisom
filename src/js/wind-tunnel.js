// ------------------------------------------------------------------ wind tunnel
/*
 * A 3D Lattice-Boltzmann wind tunnel on the GPU: D3Q19 (or D3Q15 where the GPU can only write four
 * float targets at once) with a Smagorinsky eddy viscosity. The grid is turned to face the wind, so
 * air always enters at x = 0 with a suburban power-law profile, wraps around sideways, has the inlet
 * wind above its lid and leaves at x = nx through a sponge. Stands, roofs and facades are voxelised into
 * a solid-fraction mask: solid cells bounce the air back, perforated metal lets part of it through. What
 * we keep is the flow around the stadium, averaged over the last steps, as a fraction of the 10 m wind at
 * the inlet, so one run per wind direction serves every wind speed (the flow pattern around sharp edges
 * hardly changes with the speed).
 *
 * From its start, the inlet wind blowing everywhere, the flow takes a long while to settle: for the roofed
 * bowl some 3000 steps of the 5 m grid. So each run first settles the flow on a grid of twice the cell
 * size, which covers the same time in half the steps at an eighth of the cells, and the fine grid starts
 * from that flow and settles only the details.
 *
 * The distributions live in 2D float textures: each horizontal layer of the grid is one tile.
 */
const LBM = (() => {
  const gl = renderer.getContext();
  const floatTargets = renderer.extensions.has('EXT_color_buffer_float');
  const drawBuffers = gl.getParameter(gl.MAX_DRAW_BUFFERS);
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
  // A GPU may also refuse that many float targets at once: phones before the iPhone 12 hold at most 64 bytes
  // per pixel across them, and D3Q19 writes 80. So draw a pixel into n targets and read the last one back.
  const works = (n) => {
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, count: n, depthBuffer: false });
    const mat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: 'in vec3 position;\nvoid main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `precision highp float;\n${Array.from({ length: n }, (_, k) => `layout(location = ${k}) out vec4 o${k};`).join('\n')}\nvoid main() { ${Array.from({ length: n }, (_, k) => `o${k} = vec4(${k}.5);`).join(' ')} }`,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat), px = new Float32Array(4);
    quad.frustumCulled = false;
    renderer.setRenderTarget(rt);
    renderer.render(quad, new THREE.Camera());
    gl.readBuffer(gl.COLOR_ATTACHMENT0 + n - 1);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, px);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    renderer.setRenderTarget(null);
    rt.dispose(); mat.dispose(); quad.geometry.dispose();
    return px[0] === n - 0.5;
  };
  const q = !floatTargets ? 0 : drawBuffers >= 5 && works(5) ? 19 : drawBuffers >= 4 && works(4) ? 15 : 0;
  return { ok: q > 0, q, software: /SwiftShader|llvmpipe|software/i.test(gpu) };
})();

// A grid over the tunnel's box. Step counts are given for 5 m cells: at a fixed lattice speed of the wind a
// step covers time in proportion to the cell size, so a coarser grid needs fewer.
function tunnelGrid(dx, { warm, avg }) {
  const up = 220, down = 300, width = 560, height = 140, k = 5 / dx;
  const nx = Math.round((up + down) / dx), ny = Math.round(width / dx), nz = Math.round(height / dx);
  const tx = Math.ceil(Math.sqrt(nz));
  return { dx, up, nx, ny, nz, tx, W: nx * tx, H: ny * Math.ceil(nz / tx), warm: Math.round(warm * k), avg: Math.round(avg * k), every: 3 };
}
// A software renderer gets a coarser tunnel so the page still answers in reasonable time.
const TUNNEL = tunnelGrid(LBM.software ? 10 : 5, { warm: 900, avg: 300 });
const SPINUP = tunnelGrid(TUNNEL.dx * 2, { warm: 2400, avg: 600 });
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

// T is the grid; S, if given, the coarser grid whose averaged flow a run may start from.
function lbmSources(set, T, S = null) {
  const Q = set.c.length, NT = Math.ceil(Q / 4), CH = 'xyzw';
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
${S ? `uniform bool uSeeded;
uniform sampler2D uSeed;
uniform sampler2D uSeedMask;
uniform float uSeedScale;
const int SNX = ${S.nx}, SNY = ${S.ny}, SNZ = ${S.nz}, STX = ${S.tx};
// The coarse run's mean velocity at a cell of this grid, interpolated from its open cells around it.
vec3 coarse(ivec3 p) {
  vec3 g = clamp((vec3(p) + 0.5) * ${(T.dx / S.dx).toFixed(6)} - 0.5, vec3(0.0), vec3(float(SNX), float(SNY), float(SNZ)) - 1.001);
  ivec3 b = ivec3(g);
  vec3 f = g - vec3(b), u = vec3(0.0);
  float ws = 0.0;
  for (int n = 0; n < 8; n++) {
    ivec3 o = ivec3(n & 1, (n >> 1) & 1, n >> 2), c = b + o;
    ivec2 q = ivec2(c.x + (c.z % STX) * SNX, c.y + (c.z / STX) * SNY);
    if (texelFetch(uSeedMask, q, 0).r > 0.99) continue;
    vec3 w3 = mix(1.0 - f, f, vec3(o));
    float w = w3.x * w3.y * w3.z;
    u += w * texelFetch(uSeed, q, 0).xyz;
    ws += w;
  }
  return ws > 1e-3 ? u * uSeedScale / ws : vec3(0.0);
}` : ''}
`;
  const outs = range(NT).map((k) => `layout(location = ${k}) out vec4 o${k};`).join('\n');
  // The textures hold each population's offset from its rest weight, for precision.
  const write = (a) => range(NT).map((k) => `o${k} = vec4(${range(4).map((j) => (4 * k + j < Q ? `${a}[${4 * k + j}] - WT[${4 * k + j}]` : '0.0')).join(', ')});`).join(' ');
  const load = (a) => range(NT).map((k) => `vec4 L${k} = texelFetch(uF${k}, t, 0);`).join(' ') + '\n  ' +
    set.c.map((_, i) => `${a}[${i}] = L${i >> 2}.${CH[i & 3]} + WT[${i}];`).join(' ');
  // Pull streaming: each direction reads the neighbour it arrives from. The ground is free-slip:
  // a population arriving from below is the mirror image of one that left sideways a step earlier,
  // so the inlet profile reaches the stadium instead of being worn down by a 5 m no-slip floor.
  const pulls = set.c.map((c, i) => {
    if (i === 0) return 'f[0] = me[0];';
    const o = set.opp[i], r = set.mir[i];
    return `s = p - ivec3(${c.join(', ')});
  if (s.z < 0) { q = texOf(ivec3(clamp(s.x, 0, NX - 1), (s.y + NY) % NY, 0)); f[${i}] = (links & ${1 << i}) != 0 ? me[${o}] : texelFetch(uF${r >> 2}, q, 0).${CH[r & 3]} + WT[${r}]; }
  else if (s.z >= NZ) f[${i}] = feq(${i}, 1.0, inflow(NZ - 1));
  else if (s.x < 0) f[${i}] = feq(${i}, 1.0, inflow(s.z));
  else if (s.x >= NX) f[${i}] = feq(${i}, 1.0, uo);
  else { s.y = (s.y + NY) % NY; q = texOf(s); f[${i}] = (links & ${1 << i}) != 0 ? me[${o}] : texelFetch(uF${i >> 2}, q, 0).${CH[i & 3]} + WT[${i}]; }`;
  }).join('\n  ');
  // Which directions stream in from a solid cell and so bounce back: worked out once per run, one bit each.
  const linkBits = set.c.map((c, i) => i === 0 ? '' : `s = p - ivec3(${c.join(', ')});
  if (s.z < 0) { if (texelFetch(uMask, texOf(ivec3(clamp(s.x, 0, NX - 1), (s.y + NY) % NY, 0)), 0).r > 0.99) bits |= ${1 << i}; }
  else if (s.z < NZ && s.x >= 0 && s.x < NX) { s.y = (s.y + NY) % NY; if (texelFetch(uMask, texOf(s), 0).r > 0.99) bits |= ${1 << i}; }`).join('\n  ');

  return {
    vertex: 'in vec3 position;\nvoid main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
    init: `${common}
${outs}
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 p = cellOf(t);
  float o[Q];
  vec3 u = (p.z >= NZ || texelFetch(uMask, t, 0).r > 0.99) ? vec3(0.0) : ${S ? 'uSeeded ? coarse(p) : ' : ''}inflow(p.z);
  for (int i = 0; i < Q; i++) o[i] = feq(i, 1.0, u);
  ${write('o')}
}`,
    // The cell's solid fraction and, in the other channels, the bits of the directions that bounce back.
    links: `${common}
layout(location = 0) out vec4 oLinks;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 p = cellOf(t);
  int bits = 0;
  ivec3 s;
  if (p.z < NZ) {
  ${linkBits}
  }
  oLinks = vec4(texelFetch(uMask, t, 0).r, float(bits & 255) / 255.0, float((bits >> 8) & 255) / 255.0, float(bits >> 16) / 255.0);
}`,
    step: `${common}
uniform sampler2D uLinks;
uniform float uTau0;
uniform float uCs2;
${outs}
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 p = cellOf(t);
  float o[Q];
  if (p.z >= NZ) { for (int i = 0; i < Q; i++) o[i] = WT[i]; ${write('o')} return; }
  vec4 lk = texelFetch(uLinks, t, 0);
  float m = lk.r;
  if (m > 0.99) { for (int i = 0; i < Q; i++) o[i] = WT[i]; ${write('o')} return; }
  int links = int(lk.g * 255.0 + 0.5) | (int(lk.b * 255.0 + 0.5) << 8) | (int(lk.a * 255.0 + 0.5) << 16);
  float me[Q];
  float f[Q];
  ${load('me')}
  // The outlet lets in the equilibrium at rest density with the last cell's own velocity. Copying the cell's
  // populations instead fed a wake that reached the end back into itself, until the flow ran away.
  vec3 uo = vec3(0.0);
  if (p.x == NX - 1) { float r = 0.0; for (int i = 0; i < Q; i++) { r += me[i]; uo += me[i] * C[i]; } uo /= r; }
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
  // Smagorinsky: relax more where the flow is shearing hard. Over the last 80 m a sponge thickens the air
  // so the wake leaves the tunnel quietly.
  float qn = sqrt(pxx * pxx + pyy * pyy + pzz * pzz + 2.0 * (pxy * pxy + pxz * pxz + pyz * pyz));
  float sp = max(0.0, float(p.x - NX + ${Math.round(80 / T.dx) + 1}) / ${Math.round(80 / T.dx)}.0), t0 = uTau0 + 0.3 * sp * sp;
  float tau = 0.5 * (t0 + sqrt(t0 * t0 + 25.456 * uCs2 * qn / rho));
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
  // A porous cell's stored populations keep 1 - 1.2 m of the momentum it streams with (see the step).
  vec3 u = mom / max(rho, 1e-3) / max(1.0 - 1.2 * texelFetch(uMask, t, 0).r, 0.1);
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

function voxelizeTunnel(st, frame, T) {
  const { nx, ny, nz, dx, tx, W, H } = T;
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
  // A tunnel on grid T; given the coarser grid S, it can start from the flow of a tunnel on S.
  constructor(T, S = null) {
    this.T = T;
    this.set = velocitySet(LBM.q);
    this.nTex = Math.ceil(this.set.c.length / 4);
    const opts = { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, generateMipmaps: false };
    this.f = [0, 1].map(() => new THREE.WebGLRenderTarget(T.W, T.H, { ...opts, count: this.nTex }));
    this.avg = [0, 1].map(() => new THREE.WebGLRenderTarget(T.W, T.H, opts));
    this.links = new THREE.WebGLRenderTarget(T.W, T.H, { ...opts, type: THREE.UnsignedByteType });
    const tex = (data, format, type) => {
      const t = new THREE.DataTexture(data, T.W, T.H, format, type);
      t.unpackAlignment = 1;
      t.minFilter = t.magFilter = THREE.NearestFilter;
      t.generateMipmaps = false;
      return t;
    };
    this.maskTex = tex(new Uint8Array(T.W * T.H), THREE.RedFormat, THREE.UnsignedByteType);
    const src = lbmSources(this.set, T, S);
    // tau0 sets a small molecular viscosity; the Smagorinsky constant is 0.17.
    this.uniforms = { uMask: { value: this.maskTex }, uLinks: { value: this.links.texture }, uURef: { value: U_LATTICE }, uTau0: { value: 0.506 }, uCs2: { value: 0.0289 }, uAvg: { value: null } };
    if (S) Object.assign(this.uniforms, { uSeeded: { value: false }, uSeed: { value: null }, uSeedMask: { value: null }, uSeedScale: { value: 1 } });
    for (let k = 0; k < this.nTex; k++) this.uniforms['uF' + k] = { value: null };
    const mat = (fs) => new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: src.vertex, fragmentShader: fs, uniforms: this.uniforms, depthTest: false, depthWrite: false });
    this.mInit = mat(src.init);
    this.mLinks = mat(src.links);
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
  get total() { return this.T.warm + this.T.avg; }
  pass(mat, target) { this.quad.material = mat; renderer.setRenderTarget(target); renderer.render(this.qScene, this.qCam); }
  bind(rt) { for (let k = 0; k < this.nTex; k++) this.uniforms['uF' + k].value = rt.textures[k]; }
  // Start from the inlet wind everywhere, or from the averaged flow of a coarser tunnel's current run.
  begin(st, from, seed = null) {
    const frame = tunnelFrame(st.center, from);
    const { grid, atlas } = voxelizeTunnel(st, frame, this.T);
    this.maskTex.image.data.set(atlas);
    this.maskTex.needsUpdate = true;
    if (this.uniforms.uSeeded) {
      this.uniforms.uSeeded.value = !!seed;
      if (seed) {
        this.uniforms.uSeed.value = seed.avg[seed.job.acur].texture;
        this.uniforms.uSeedMask.value = seed.maskTex;
        this.uniforms.uSeedScale.value = 1 / Math.max(1, seed.job.samples);
      }
    }
    this.job = { st, from, frame, grid, step: 0, cur: 0, acur: 0, samples: 0 };
    this.pass(this.mLinks, this.links);
    this.pass(this.mInit, this.f[0]);
    const cc = renderer.getClearColor(new THREE.Color()), ca = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    for (const rt of this.avg) { renderer.setRenderTarget(rt); renderer.clear(true, false, false); }
    renderer.setClearColor(cc, ca);
    renderer.setRenderTarget(null);
  }
  advance(n) {
    const j = this.job, T = this.T;
    for (let s = 0; s < n && j.step < this.total; s++) {
      this.bind(this.f[j.cur]);
      this.pass(this.mStep, this.f[1 - j.cur]);
      j.cur = 1 - j.cur;
      j.step++;
      if (j.step > T.warm && j.step % T.every === 0) {
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
  // The averaged flow, read back without stalling the page; the tunnel is free for the next run at once.
  async collect() {
    const j = this.job, T = this.T, buf = new Float32Array(T.W * T.H * 4);
    this.job = null;
    await renderer.readRenderTargetPixelsAsync(this.avg[j.acur], 0, 0, T.W, T.H, buf);
    return new WindField(j.from, j.frame, buf, j.grid, j.samples, T);
  }
}

// The averaged flow around one stadium for one wind direction, as fractions of the 10 m inlet wind.
class WindField {
  constructor(from, frame, buf, grid, samples, T) {
    const { nx, ny, nz, tx, W, dx } = T;
    Object.assign(this, { from, frame, mask: grid, nx, ny, nz, dx });
    // As a fraction of the 10 m wind let in at the inlet. (Measured just inside the inlet, the wind already feels
    // the stadium 200 m downstream holding it back a few per cent.)
    const data = new Float32Array(nx * ny * nz * 4);
    const k = 1 / Math.max(samples, 1) / U_LATTICE;
    for (let z = 0; z < nz; z++) {
      const ox = (z % tx) * nx, oy = Math.floor(z / tx) * ny;
      for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
        const s = ((oy + y) * W + ox + x) * 4, d = ((z * ny + y) * nx + x) * 4;
        data[d] = buf[s] * k; data[d + 1] = buf[s + 1] * k; data[d + 2] = buf[s + 2] * k; data[d + 3] = buf[s + 3] * k;
      }
    }
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
  // profile over a rough surface (z0 = 0.1 m). Under a roof the 5 m cells can stay solid right up to it:
  // no open cell within two means the seat sits in still air, not in the wind above the roof.
  seatSpeed(p) {
    const f = this.frame, dx = this.dx;
    const rx = p.x - f.origin.x, rz = p.z - f.origin.z;
    const i = Math.round((rx * f.ex.x + rz * f.ex.z) / dx - 0.5), j = Math.round((rx * f.ey.x + rz * f.ey.z) / dx - 0.5);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return windProfile(p.y) * SEAT_FACTOR;
    const col = (k) => (k * this.ny + j) * this.nx + i, k0 = Math.max(0, Math.floor(p.y / dx - 0.5));
    for (let k = k0; k <= Math.min(k0 + 2, this.nz - 2); k++) {
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
  // Above the highest solid cell nothing stops a drop any more.
  let high = ny;
  while (high > 0 && !mask.subarray((high - 1) * nx * nz, high * nx * nz).some((m) => m > 0)) high--;
  return { mask, g: { x0, z0, dx, nx, ny, nz, top: Math.min(top, (high + 1) * dx) } };
}

// Worker: follows each drop backwards from a spectator's head, through the simulated wind and the falling
// speed of the drop, until it is above every roof (wet) or hits something (dry).
// - Drops of the five sizes of the rain (see rainDrops).
// - Gusts: the tunnel's inlet is steady and its 5 m cells resolve little of the turbulence inside the bowl,
//   so the gusts are added along the free wind, with a spread of GUST times the 10 m wind (turbulence of the
//   free wind is about 0.25 of it, measured inside street canyons and bowls nearer 0.15), at six strengths.
//   A gust is one eddy, about EDDY metres across like those in the shear layer over the roofs: it carries a
//   drop in full only while the drop falls through it, and the eddies above push it one way or the other, so
//   together they move it as far as a random walk would, with the square root of its fall, not in step with it.
// - A drop lags behind the wind: it takes about vt/g to pick up a change, so it still moves with the air it
//   met that long before, further up its path, unless a roof or stand lies in between.
const GUST = 0.2, EDDY = 10;
function rainWorkerMain() {
  let heads, mask, g, near, field = null, wind = null, cover = null;
  const STEP = 1.2, G = 9.81;
  // Six equally likely strengths of a normal spread: the mean of each sixth, scaled so the six keep its spread.
  const GUSTS = [-1.563, -0.712, -0.221, 0.221, 0.712, 1.563].map((xi) => [xi, 1 / 6]);
  const v = new Float32Array(3);
  // The mean air velocity at a point of the stadium frame, as a fraction of the 10 m wind, interpolated
  // from the open cells around it. Where the tunnel's 5 m cells are all solid (next to a stand, which the
  // 2 m mask of the drops leaves open), the air is that of an open cell up to two above; if none, under a
  // roof, it is still.
  function air(x, y, z) {
    const f = field, A = f.A, { nx, ny, nz, data, mask: fm } = f;
    const gi = A[0] * x + A[1] * y + A[2] * z + A[3], gj = A[4] * x + A[5] * y + A[6] * z + A[7], gk = Math.max(0, A[9] * y + A[11]);
    if (gi < 0 || gj < 0 || gi > nx - 1 || gj > ny - 1 || gk > nz - 1) { free(y); return; }
    const i0 = Math.min(nx - 2, Math.floor(gi)), j0 = Math.min(ny - 2, Math.floor(gj)), k0 = Math.min(nz - 2, Math.floor(gk));
    const tx = gi - i0, ty = gj - j0, tz = gk - k0;
    let a = 0, b = 0, c = 0, ws = 0;
    for (let n = 0; n < 8; n++) {
      const q = ((k0 + (n >> 2)) * ny + j0 + ((n >> 1) & 1)) * nx + i0 + (n & 1);
      if (fm[q] >= 250) continue;
      const w = (n & 1 ? tx : 1 - tx) * ((n >> 1) & 1 ? ty : 1 - ty) * (n >> 2 ? tz : 1 - tz);
      a += w * data[q * 3]; b += w * data[q * 3 + 1]; c += w * data[q * 3 + 2]; ws += w;
    }
    if (ws > 1e-3) { a /= ws; b /= ws; c /= ws; }
    else {
      const col = Math.round(gj) * nx + Math.round(gi), k0 = Math.round(gk);
      for (let k = k0; k < Math.min(nz, k0 + 3); k++) {
        const q = k * nx * ny + col;
        if (fm[q] < 250) { a = data[q * 3]; b = data[q * 3 + 1]; c = data[q * 3 + 2]; break; }
      }
    }
    const V = f.V;
    v[0] = V[0] * a + V[1] * b + V[2] * c; v[1] = V[3] * a + V[4] * b + V[5] * c; v[2] = V[6] * a + V[7] * b + V[8] * c;
  }
  // The undisturbed wind, outside the tunnel and the mask.
  function free(y) {
    const pr = Math.pow(Math.max(y, 2) / 10, 0.22), d = field.dir;
    v[0] = d[0] * pr; v[1] = 0; v[2] = d[2] * pr;
  }
  // The air at the centre of every cell of the mask, once per field, so a drop's step only looks it up.
  function sampleWind() {
    wind = new Float32Array(g.nx * g.ny * g.nz * 3);
    for (let k = 0; k < g.ny; k++) for (let j = 0; j < g.nz; j++) for (let i = 0; i < g.nx; i++) {
      air(g.x0 + (i + 0.5) * g.dx, (k + 0.5) * g.dx, g.z0 + (j + 0.5) * g.dx);
      wind.set(v, ((k * g.nz + j) * g.nx + i) * 3);
    }
  }
  // The mask cell around a point, or -1 outside the mask.
  function cellOf(x, y, z) {
    const i = Math.floor((x - g.x0) / g.dx), j = Math.floor((z - g.z0) / g.dx), k = Math.floor(y / g.dx);
    return i < 0 || j < 0 || k < 0 || i >= g.nx || j >= g.nz || k >= g.ny ? -1 : (k * g.nz + j) * g.nx + i;
  }
  function windOf(q, y) {
    if (q < 0) { free(y); return; }
    v[0] = wind[q * 3]; v[1] = wind[q * 3 + 1]; v[2] = wind[q * 3 + 2];
  }
  // How many cells each cell is from the nearest solid or perforated one (counting diagonal steps, up to 15):
  // where nothing is within reach, a drop's lag needs no checking and the drop can take a longer step.
  function nearness() {
    const { nx, ny, nz } = g, n = nx * ny * nz, d = new Uint8Array(n).fill(15), queue = new Int32Array(n);
    let head = 0, tail = 0;
    for (let q = 0; q < n; q++) if (mask[q] > 0) { d[q] = 0; queue[tail++] = q; }
    while (head < tail) {
      const q = queue[head++], dq = d[q] + 1;
      if (dq >= 15) continue;
      const i = q % nx, j = Math.floor(q / nx) % nz, k = Math.floor(q / (nx * nz));
      for (let c = Math.max(0, k - 1); c <= Math.min(ny - 1, k + 1); c++) for (let b = Math.max(0, j - 1); b <= Math.min(nz - 1, j + 1); b++) {
        for (let a = Math.max(0, i - 1); a <= Math.min(nx - 1, i + 1); a++) {
          const r = (c * nz + b) * nx + a;
          if (d[r] > dq) { d[r] = dq; queue[tail++] = r; }
        }
      }
    }
    return d;
  }
  // The cell a drop was in `lag` seconds before, going back along (bx, by, bz) from (x, y, z): the last open one
  // before a solid cell (past the head's own 2.4 m), -1 above or beside the mask. Sets ly to its height.
  let ly = 0;
  function laggedCell(x, y, z, bx, by, bz, lag, run, q) {
    const len = Math.sqrt(bx * bx + by * by + bz * bz) * lag, n = Math.ceil(len / g.dx);
    ly = y;
    if (q >= 0 && near[q] > n) {
      const py = y + by * lag, c = cellOf(x + bx * lag, py, z + bz * lag);
      if (c >= 0) { ly = py; return c; }
      if (py > 0) { ly = py; return -1; }
      return q;
    }
    for (let k = 1; k <= n; k++) {
      const t = (lag * k) / n, py = y + by * t, c = cellOf(x + bx * t, py, z + bz * t);
      if (c < 0) { if (py > 0) { ly = py; return -1; } return q; }
      if (mask[c] >= 250 && run + (len * k) / n > 2.4) return q;
      q = c; ly = py;
    }
    return q;
  }
  // The heads s0 to s1 into out.
  function trace(U, drops, gusts, s0, s1, out) {
    const share = 1 / drops.length;
    const dx = field ? field.dir[0] : 0, dz = field ? field.dir[2] : 0;
    for (let s = s0; s < s1; s++) {
      let acc = 0;
      for (const vt of drops) {
        const lag = vt / G;
        for (const [xi, w] of gusts) {
          const gx = dx * xi * GUST * U, gz = dz * xi * GUST * U;
          let x = heads[3 * s], y = heads[3 * s + 1], z = heads[3 * s + 2], q = cellOf(x, y, z), trans = 1, run = 0, last = -1;
          for (let it = 0; it < 400; it++) {
            // The eddy at the head pushes in full; past it, just enough for the drift to grow as sqrt(EDDY * run).
            const fe = run < EDDY ? 1 : 0.5 * Math.sqrt(EDDY / run);
            let ax = 0, ay = 0, az = 0;
            if (U > 0 && wind) {
              windOf(q, y);
              ax = v[0] * U + gx * fe; ay = v[1] * U; az = v[2] * U + gz * fe;
              const qa = laggedCell(x, y, z, -ax, vt - ay, -az, lag, run, q);
              if (qa !== q) { windOf(qa, ly); ax = v[0] * U + gx * fe; ay = v[1] * U; az = v[2] * U + gz * fe; }
            }
            // In open air, with nothing within reach, the step can be as long as the clearance.
            const step = run >= 2.4 && q >= 0 && near[q] > 3 ? Math.min(8, (near[q] - 2) * g.dx) : STEP;
            const dy = ay - vt, dt = step / Math.sqrt(ax * ax + dy * dy + az * az);
            x -= ax * dt; y -= dy * dt; z -= az * dt;
            run += step;
            if (y > g.top) break;
            q = cellOf(x, y, z);
            if (run < 2.4) continue;
            // Below the ground a drop never arrives; beside the mask it falls in the open.
            if (q < 0) { if (y < 0) trans = 0; break; }
            // A run of perforated cells is one screen, which lets through its open share.
            const m = mask[q];
            if (m >= 250) { trans = 0; break; }
            if (m > 0) { if (last < 0) trans *= 1 - m / 255; last = q; } else last = -1;
          }
          acc += share * w * trans;
        }
      }
      out[s] = acc;
    }
    return out;
  }
  // A run traces the heads a batch at a time and gives up as soon as a newer run arrives, so a slider being
  // dragged only ever waits for the latest weather.
  let latest = 0;
  async function run(m, id) {
    const n = heads.length / 3, wet = new Float32Array(n);
    if (!cover) cover = trace(0, [6], [[0, 1]], 0, n, new Float32Array(n));
    if (m.rain > 0) for (let s = 0; s < n; s += 2000) {
      trace(m.U, m.drops, m.U > 0 ? GUSTS : [[0, 1]], s, Math.min(n, s + 2000), wet);   // no wind, no gusts
      await new Promise((r) => setTimeout(r));
      if (id !== latest) return;
    }
    self.postMessage({ id: m.id, wet, cover: cover.slice() }, [wet.buffer]);
  }
  self.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'init') { heads = m.heads; mask = m.mask; g = m.g; near = nearness(); return; }
    if (m.type === 'field') { field = m.field; sampleWind(); return; }
    run(m, ++latest);
  };
}
const rainWorkerURL = URL.createObjectURL(new Blob([`const GUST = ${GUST}, EDDY = ${EDDY};\n(${rainWorkerMain.toString()})()`], { type: 'text/javascript' }));

class RainSim {
  constructor(st, bounds, onResult) {
    this.st = st;
    this.worker = new Worker(rainWorkerURL);
    const { mask, g } = rainMask(st, bounds);
    this.worker.postMessage({ type: 'init', heads: st.headsLocal, mask, g });
    this.seq = 0;
    this.busy = false;
    this.from = null;      // wind direction of the field the worker holds
    this.runFrom = null;   // and of the one the latest run traces through
    // Only the latest run answers; one overtaken on its way back is dropped.
    this.worker.onmessage = (e) => { if (e.data.id === this.seq) { this.busy = false; onResult(this.st, e.data, this.runFrom); } };
  }
  setField(field) {
    this.from = field.from;
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
    this.busy = true;
    this.runFrom = this.from;
    this.worker.postMessage({ type: 'run', id: ++this.seq, U: p.wind, drops: rainDrops(p.rain).map((c) => c.vt), rain: p.rain });
  }
}

// ------------------------------------------------------------------ job queue
// One tunnel, many requests: the views' current wind direction first, then any sweep of directions.
// Each job spins the flow up on the coarse grid and finishes on the fine one.
const SPIN_SHARE = 0.2;   // roughly the coarse grid's part of the work, for the progress bar
class Aero {
  constructor(onField, onProgress) {
    this.tunnel = new WindTunnel(TUNNEL, SPINUP);
    this.spin = new WindTunnel(SPINUP);
    this.queue = [];
    this.cache = new Map();
    this.reading = new Set();   // runs whose flow is on its way back from the GPU
    this.current = null;
    this.steps = { spin: LBM.software ? 8 : 64, fine: LBM.software ? 4 : 16 };
    this.last = 0;
    this.onField = onField;
    this.onProgress = onProgress;
  }
  key(st, from) { return `${st.key}:${from}`; }
  cancel() { this.tunnel.job = this.spin.job = null; this.current = null; }
  request(st, from) {
    const key = this.key(st, from), hit = this.cache.get(key);
    this.queue = this.queue.filter((j) => !(j.kind === 'view' && j.st === st));
    if (this.current && this.current.kind === 'view' && this.current.st === st && this.current.from !== from) this.cancel();
    if (hit) { this.onField(st, hit, 'view'); return; }
    if (this.current && this.current.st === st && this.current.from === from) { this.current.kind = 'view'; return; }
    if (this.reading.has(key)) return;
    this.queue.unshift({ st, from, kind: 'view' });
  }
  sweep(jobs) { for (const j of jobs) this.queue.push({ ...j, kind: 'sweep' }); }
  get busy() { return !!this.current || this.queue.length > 0; }
  tick() {
    // Steps per frame for some 22 frames a second while the tunnel runs, each grid with its own count, timed on
    // the clock: a frame held up by other work (building a mask, compiling a shader) doesn't count.
    const now = performance.now(), dt = (now - this.last) / 1000;
    this.last = now;
    if (!this.current) {
      const next = this.queue.shift();
      if (!next) return;
      const key = this.key(next.st, next.from), hit = this.cache.get(key);
      if (hit) { this.onField(next.st, hit, next.kind); this.idle(); return; }
      if (this.reading.has(key)) return;   // already run, its flow on the way back
      this.current = next;
      this.spin.begin(next.st, next.from);
    }
    const phase = this.spin.job ? 'spin' : 'fine', most = LBM.software ? 8 : phase === 'spin' ? 320 : 64;
    if (dt < 1 / 26) this.steps[phase] = Math.min(most, Math.ceil(this.steps[phase] * 1.1));
    else if (dt > 1 / 18 && dt < 0.25) this.steps[phase] = Math.max(2, Math.floor(this.steps[phase] * 0.9));
    const job = this.current;
    let prog;
    if (this.spin.job) {
      prog = SPIN_SHARE * this.spin.advance(this.steps.spin);
      if (prog >= SPIN_SHARE) { this.tunnel.begin(job.st, job.from, this.spin); this.spin.job = null; }
    } else prog = SPIN_SHARE + (1 - SPIN_SHARE) * this.tunnel.advance(this.steps.fine);
    this.onProgress(job, prog, this.queue);
    if (prog < 1) return;
    const key = this.key(job.st, job.from);
    this.current = null;
    this.reading.add(key);
    this.tunnel.collect().then((field) => {
      this.reading.delete(key);
      this.cache.set(key, field);
      while (this.cache.size > 12) this.cache.delete(this.cache.keys().next().value);
      this.onField(job.st, field, job.kind);
      this.idle();
    }, () => { this.reading.delete(key); this.idle(); });
  }
  idle() { if (!this.busy && !this.reading.size) this.onProgress(null, 1, []); }
}

// Wind at every seat, in the corner sectors, and through the corner openings, from one field. What a spectator
// feels is the mean flow and the gusts, which the tunnel doesn't resolve (see GUST), brought down to head height
// like the mean: under a roof, where the mean flow of the tunnel is all but still, the gusts are what is left.
function fieldStats(st, field) {
  const n = st.seats.length, ratio = new Float32Array(n), p = new THREE.Vector3(), gust = GUST * SEAT_FACTOR;
  let cs = 0, cn = 0, rs = 0, rn = 0;
  for (let i = 0; i < n; i++) {
    p.set(st.heads[i * 3], st.heads[i * 3 + 1], st.heads[i * 3 + 2]);
    ratio[i] = Math.hypot(field.seatSpeed(p), gust);
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
