// ------------------------------------------------------------------ rain and wind visuals
const RAIN_BOX = new THREE.Vector3(620, 240, 620);
const rainRT = new Map();
const rainCam = new THREE.OrthographicCamera(-470, 470, 470, -470, 1, 2200);
rainCam.layers.set(LAYER_OCCLUDER);
const rainVP = new THREE.Matrix4();
const depthOnly = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });

function buildRain() {
  const max = 60000;
  const base = new Float32Array(max * 2 * 3), end = new Float32Array(max * 2), pos = new Float32Array(max * 2 * 3);
  for (let i = 0; i < max; i++) {
    const x = rand() * RAIN_BOX.x, y = rand() * RAIN_BOX.y, z = rand() * RAIN_BOX.z;
    for (let k = 0; k < 2; k++) {
      base.set([x, y, z], (i * 2 + k) * 3);
      end[i * 2 + k] = k;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aBase', new THREE.BufferAttribute(base, 3));
  g.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
  g.setDrawRange(0, 0);
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: {
      uTime: timeUniform, uVel: { value: new THREE.Vector3(0, -8, 0) }, uBox: { value: RAIN_BOX.clone() },
      uOrigin: { value: new THREE.Vector3() }, uLen: { value: 4 }, uOpacity: { value: 0.5 },
      uRainVP: { value: rainVP }, uDepth: { value: null },
    },
    vertexShader: `
      uniform float uTime; uniform vec3 uVel; uniform vec3 uBox; uniform vec3 uOrigin; uniform float uLen;
      uniform mat4 uRainVP; uniform sampler2D uDepth;
      attribute vec3 aBase; attribute float aEnd;
      varying float vA;
      void main() {
        vec3 p = mod(aBase + uVel * uTime, uBox) + uOrigin;
        vec4 rc = uRainVP * vec4(p, 1.0);
        vec3 nd = rc.xyz / rc.w;
        vec2 uv = nd.xy * 0.5 + 0.5;
        float dz = nd.z * 0.5 + 0.5;
        float hidden = 0.0;
        if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) hidden = step(texture2D(uDepth, uv).r + 0.0015, dz);
        vec3 w = p - normalize(uVel) * uLen * aEnd;
        vA = (1.0 - hidden) * (1.0 - aEnd * 0.85);
        gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
      }`,
    fragmentShader: `
      uniform float uOpacity; varying float vA;
      void main() { if (vA < 0.01) discard; gl_FragColor = vec4(0.92, 0.95, 0.98, vA * uOpacity); }`,
  });
  const lines = new THREE.LineSegments(g, mat);
  lines.frustumCulled = false;
  lines.renderOrder = 5;
  scene.add(lines);
  return { lines, mat, max };
}

function rainTarget(st) {
  if (!rainRT.has(st)) {
    const rt = new THREE.WebGLRenderTarget(1024, 1024);
    rt.depthTexture = new THREE.DepthTexture(1024, 1024);
    rt.depthTexture.type = THREE.UnsignedIntType;
    rainRT.set(st, rt);
  }
  return rainRT.get(st);
}

function updateRainMaps(p, stadiums) {
  const vt = fallSpeed(p.rain);
  const b = p.from * DEG, u = p.wind * ROOF_WIND;
  const vel = new THREE.Vector3(-Math.sin(b) * u, -vt, Math.cos(b) * u);
  const dir = vel.clone().normalize();
  rainCam.position.copy(MID).addScaledVector(dir, -900);
  rainCam.up.set(0, 0, -1);
  if (Math.abs(dir.y) < 0.98) rainCam.up.set(0, 1, 0);
  rainCam.lookAt(MID);
  rainCam.updateMatrixWorld();
  rainCam.updateProjectionMatrix();
  rainVP.multiplyMatrices(rainCam.projectionMatrix, rainCam.matrixWorldInverse);
  const vis = stadiums.map((s) => s.root.visible);
  renderer.setScissorTest(false);
  scene.overrideMaterial = depthOnly;
  for (const st of stadiums) {
    stadiums.forEach((s) => { s.root.visible = s === st; });
    renderer.setRenderTarget(rainTarget(st));
    renderer.clear();
    renderer.render(scene, rainCam);
  }
  scene.overrideMaterial = null;
  renderer.setRenderTarget(null);
  stadiums.forEach((s, i) => { s.root.visible = vis[i]; });
  return vel;
}

// Wind shown as trails that follow the simulated flow: each particle remembers where it was over the
// last second, so the line bends where air is pushed over a roof or squeezed through a corner.
class WindStreaks {
  constructor(st) {
    this.st = st;
    this.n = 700;
    this.K = 9;
    this.p = new Float32Array(this.n * 3);
    this.hist = new Float32Array(this.n * this.K * 3);
    this.age = new Float32Array(this.n);
    this.life = new Float32Array(this.n);
    this.clock = 0;
    const segs = this.K - 1;
    const pos = new Float32Array(this.n * segs * 6), col = new Float32Array(this.n * segs * 8);
    for (let i = 0; i < this.n; i++) for (let k = 0; k < segs; k++) {
      const a0 = 0.85 * (1 - k / segs), a1 = 0.85 * (1 - (k + 1) / segs);
      col.set([1, 0.83, 0.5, a0, 1, 0.83, 0.5, a1], (i * segs + k) * 8);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 4));
    this.geo = g;
    this.lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 6;
    this.lines.visible = false;
    st.root.add(this.lines);
    this.v = new THREE.Vector3();
    this.q = new THREE.Vector3();
  }
  spawn(i) {
    const f = this.st.field, c = this.st.center;
    const ex = f.frame.ex, ey = f.frame.ey;
    const along = -240 + rand() * 420, across = (rand() - 0.5) * 440;
    const x = c.x + ex.x * along + ey.x * across, z = c.z + ex.z * along + ey.z * across;
    const y = 2 + Math.pow(rand(), 1.7) * 55;
    this.p.set([x, y, z], i * 3);
    for (let k = 0; k < this.K; k++) this.hist.set([x, y, z], (i * this.K + k) * 3);
    this.age[i] = 0;
    this.life[i] = 2.5 + rand() * 4;
  }
  update(dt, params) {
    const f = this.st.field, U = params.wind;
    this.lines.visible = !!f && U > 0.4;
    if (!this.lines.visible) return;
    if (f !== this.field) { this.field = f; for (let i = 0; i < this.n; i++) { this.spawn(i); this.age[i] = rand() * this.life[i]; } }
    this.clock += dt;
    const shift = this.clock > 0.11;
    if (shift) this.clock = 0;
    const c = this.st.center, v = this.v, q = this.q, scale = U * 2.2;
    for (let i = 0; i < this.n; i++) {
      q.set(this.p[i * 3], this.p[i * 3 + 1], this.p[i * 3 + 2]);
      f.vel(q, v);
      q.addScaledVector(v, scale * dt);
      this.age[i] += dt;
      if (this.age[i] > this.life[i] || q.y < 0.5 || Math.hypot(q.x - c.x, q.z - c.z) > 380 || f.solidAt(q)) { this.spawn(i); continue; }
      this.p[i * 3] = q.x; this.p[i * 3 + 1] = q.y; this.p[i * 3 + 2] = q.z;
      const h = i * this.K * 3;
      if (shift) this.hist.copyWithin(h + 3, h, h + (this.K - 1) * 3);
      this.hist[h] = q.x; this.hist[h + 1] = q.y; this.hist[h + 2] = q.z;
    }
    const pos = this.geo.getAttribute('position').array, segs = this.K - 1;
    for (let i = 0; i < this.n; i++) {
      const h = i * this.K * 3;
      for (let k = 0; k < segs; k++) {
        const o = (i * segs + k) * 6;
        for (let a = 0; a < 6; a++) pos[o + a] = this.hist[h + k * 3 + a];
      }
    }
    this.geo.getAttribute('position').needsUpdate = true;
  }
}

// A horizontal cut through the simulated wind: colour shows the speed as a share of the free
// wind at the same height, so gaps that speed the air up show hotter than the open field.
const SLICE_STOPS = [[0, [233, 236, 239]], [0.35, [243, 210, 122]], [0.7, [240, 160, 60]], [1.05, [208, 69, 44]], [1.4, [140, 30, 60]]];
function sliceColor(r, out) {
  let i = 0;
  while (i < SLICE_STOPS.length - 2 && r > SLICE_STOPS[i + 1][0]) i++;
  const [a, ca] = SLICE_STOPS[i], [b, cb] = SLICE_STOPS[i + 1];
  const t = clamp((r - a) / (b - a), 0, 1);
  for (let k = 0; k < 3; k++) out[k] = Math.round(lerp(ca[k], cb[k], t));
}

class SliceView {
  constructor(st) {
    this.st = st;
    const T = TUNNEL;
    this.data = new Uint8Array(T.nx * T.ny * 4);
    this.tex = new THREE.DataTexture(this.data, T.nx, T.ny, THREE.RGBAFormat);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.magFilter = this.tex.minFilter = THREE.LinearFilter;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(T.nx * T.dx, T.ny * T.dx),
      new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false }));
    this.mesh.renderOrder = 4;
    this.mesh.visible = false;
    st.root.add(this.mesh);
  }
  update(h, show) {
    const f = this.st.field;
    this.mesh.visible = show && !!f;
    if (!this.mesh.visible || (this.f === f && this.h === h)) return;
    this.f = f;
    this.h = h;
    const T = TUNNEL, fr = f.frame;
    const kz = clamp(h / T.dx - 0.5, 0, T.nz - 1.001), k0 = Math.floor(kz), t = kz - k0, free = windProfile(h);
    const rgb = [0, 0, 0], c = this.st.center;
    for (let j = 0; j < T.ny; j++) for (let i = 0; i < T.nx; i++) {
      const q0 = (k0 * T.ny + j) * T.nx + i, q1 = q0 + T.nx * T.ny, o = (j * T.nx + i) * 4;
      const wx = fr.origin.x + fr.ex.x * (i + 0.5) * T.dx + fr.ey.x * (j + 0.5) * T.dx;
      const wz = fr.origin.z + fr.ex.z * (i + 0.5) * T.dx + fr.ey.z * (j + 0.5) * T.dx;
      const fade = clamp((330 - Math.hypot(wx - c.x, wz - c.z)) / 110, 0, 1);
      if (f.mask[q0] >= 250 || f.mask[q1] >= 250 || fade <= 0) { this.data[o + 3] = 0; continue; }
      sliceColor(lerp(f.data[q0 * 4 + 3], f.data[q1 * 4 + 3], t) / free, rgb);
      this.data[o] = rgb[0]; this.data[o + 1] = rgb[1]; this.data[o + 2] = rgb[2]; this.data[o + 3] = Math.round(205 * fade);
    }
    this.tex.needsUpdate = true;
    const n = new THREE.Vector3().crossVectors(fr.ex, fr.ey);
    this.mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(fr.ex, fr.ey, n));
    this.mesh.position.copy(fr.origin).addScaledVector(fr.ex, (T.nx * T.dx) / 2).addScaledVector(fr.ey, (T.ny * T.dx) / 2);
    this.mesh.position.y = h;
  }
}

// ------------------------------------------------------------------ labels
class LabelLayer {
  constructor(el) { this.el = el; this.items = []; }
  add(text, pos, kind) {
    const e = document.createElement('span');
    e.className = 'lbl ' + kind.split(' ').map((k) => (k.startsWith('lbl-') ? k : 'lbl-' + k)).join(' ');
    e.textContent = text;
    this.el.appendChild(e);
    this.items.push({ e, pos, shown: true });
  }
  update(cam, w, h) {
    const v = new THREE.Vector3();
    for (const it of this.items) {
      v.copy(it.pos).project(cam);
      const d = cam.position.distanceTo(it.pos);
      const show = v.z < 1 && v.x > -1.05 && v.x < 1.05 && v.y > -1.05 && v.y < 1.1 && d < 2600;
      if (show !== it.shown) { it.e.style.display = show ? '' : 'none'; it.shown = show; }
      if (!show) continue;
      const x = (v.x * 0.5 + 0.5) * w, y = (-v.y * 0.5 + 0.5) * h;
      it.e.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
      it.e.style.opacity = d > 1500 ? String(clamp(1 - (d - 1500) / 1100, 0, 1)) : '1';
    }
  }
}

function envLabels() {
  const out = [{ text: 'Park Maksimir', pos: new THREE.Vector3(360, 40, -640), kind: 'park' }];
  for (const l of ENV.labels) out.push({ text: l.t, pos: new THREE.Vector3(l.x, l.k === 'water' ? 4 : 14, l.z), kind: l.k === 'water' ? 'water' : 'poi' });
  // Put the road name on the Maksimirska cesta vertex closest to a spot west of the stadium.
  let best = null, bd = Infinity;
  for (const r of ENV.roads) if (/Maksimirska/.test(r.n)) for (const [x, z] of r.p) {
    const d = Math.hypot(x + 330, z + 20);
    if (d < bd) { bd = d; best = [x, z]; }
  }
  if (best) out.push({ text: 'Maksimirska cesta', pos: new THREE.Vector3(best[0], 3, best[1]), kind: 'road' });
  return out;
}
