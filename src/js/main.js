// ------------------------------------------------------------------ views and camera
const master = new THREE.PerspectiveCamera(36, 1, 2, 12000);
const controls = new OrbitControls(master, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 25;
controls.maxDistance = 2200;
controls.maxPolarAngle = 88 * DEG;
controls.target.set(0, 0, 0);
controls.zoomToCursor = false;

// Camera presets are offsets from the stadium centre (plus 8 m) that both views share.
function offsetFromBearing(bearing, elevation, dist) {
  const b = bearing * DEG, e = elevation * DEG;
  return new THREE.Vector3(Math.sin(b) * Math.cos(e) * dist, Math.sin(e) * dist, -Math.cos(b) * Math.cos(e) * dist);
}
const PRESETS = {
  zrak: () => offsetFromBearing(206, 40, window.innerWidth < 880 ? 560 : 720),
  jezero: () => new THREE.Vector3(178, 44, -338).sub(new THREE.Vector3(0, 8, 0)),
  tribina: () => new THREE.Vector3(0, 6, 80).applyAxisAngle(UP, STADIUM_YAW),
  tlocrt: () => new THREE.Vector3(0, 720, 0.5),
};
let tween = null;
function goTo(name, instant = false) {
  const to = PRESETS[name]();
  document.querySelectorAll('[data-cam]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.cam === name)));
  if (instant || REDUCED_MOTION) { master.position.copy(to); controls.update(); return; }
  tween = { from: master.position.clone(), to, t: 0 };
}


// ------------------------------------------------------------------ state + UI
const state = { wind: 8, from: 225, rain: 6, mode: 'rain', xray: false, slice: false, sliceH: 12 };
const PRESET_WEATHER = {
  rominjanje: { wind: 2, from: 45, rain: 1.5 },
  jugozapadnjak: { wind: 8, from: 225, rain: 6 },
  pljusak: { wind: 13, from: 290, rain: 42 },
  sjeveroistocnjak: { wind: 11, from: 40, rain: 3 },
};
const SWEEP_DIRS = [0, 45, 90, 135, 180, 225, 270, 315];

const results = {};
const sweep = { today: {}, future: {} };
const COLORS = {
  dry: new THREE.Color('#efe6d2'), wet: new THREE.Color('#17b4ec'),
  calm: new THREE.Color('#e9ecef'), breeze: new THREE.Color('#f3d27a'), wind: new THREE.Color('#f0a03c'), gale: new THREE.Color('#d0452c'),
};
function windColor(v, out) {
  const stops = [[0, COLORS.calm], [3, COLORS.breeze], [5, COLORS.wind], [8, COLORS.gale]];
  if (v >= 8) return out.copy(COLORS.gale);
  for (let i = 0; i < stops.length - 1; i++) {
    if (v <= stops[i + 1][0]) return out.copy(stops[i][1]).lerp(stops[i + 1][1], (v - stops[i][0]) / (stops[i + 1][0] - stops[i][0]));
  }
  return out.copy(COLORS.gale);
}

// Combine the wind at each seat (fraction of the 10 m wind) with the latest rain result.
function updateResults(st) {
  if (!st.ratio) return;
  const n = st.seats.length, U = state.wind, wet = st.wet;
  const local = new Float32Array(n);
  let wetSum = 0, windSum = 0, windy = 0, covered = 0, coveredCorner = 0, wc = 0, wr = 0, nc = 0;
  for (let i = 0; i < n; i++) {
    local[i] = U * st.ratio[i];
    if (st.corner[i]) nc++;
    if (wet) { if (st.corner[i]) wc += wet[i]; else wr += wet[i]; }
    windSum += local[i];
    if (local[i] > 5) windy++;
    if (wet) wetSum += wet[i];
    if (st.cover && st.cover[i] < 0.5) { covered++; if (st.corner[i]) coveredCorner++; }
    st.sway.array[i] = clamp(local[i] / 9, 0, 1.3);
  }
  st.sway.needsUpdate = true;
  results[st.key] = {
    wet, local, rain: state.rain, wetShare: wet && n ? wetSum / n : null, dry: wet && n ? (1 - wetSum / n) * st.capacity : st.capacity,
    wind: n ? windSum / n : 0, windy: n ? windy / n : 0, cover: st.cover ? covered / n : null,
    coverCorner: st.cover && nc ? coveredCorner / nc : null,
    corner: U * st.stats.corner, rest: U * st.stats.rest, hole: st.stats.hole,
    wetCorner: wet && nc ? wc / nc : null, wetRest: wet && n > nc ? wr / (n - nc) : null,
  };
  paint(st);
  renderStats();
  renderCorners();
}

function paint(st) {
  const r = results[st.key];
  if (!r) return;
  const c = new THREE.Color();
  for (let i = 0; i < st.seats.length; i++) {
    // Rain: the share of the open-sky rain reaching the seat, on a square-root scale so that a spectator catching
    // a fifth of it already shows as getting wet.
    if (state.mode === 'rain') c.copy(COLORS.dry).lerp(COLORS.wet, r.wet && state.rain > 0 ? clamp(Math.sqrt(r.wet[i]) * 1.1, 0, 1) : 0);
    else windColor(r.local[i], c);
    const t = st.tint[i];
    st.target[i * 3] = c.r * t; st.target[i * 3 + 1] = c.g * t; st.target[i * 3 + 2] = c.b * t;
  }
  st.fade = 1;
}

// A share as a percentage, with a decimal below 10 % so that small shares don't round away.
function pct(x) {
  const v = x * 100;
  return `${v < 0.05 ? '0' : fmt(v, v < 9.95 ? 1 : 0)}\u00a0%`;
}
// About how many people: to ten below a thousand, to a hundred above; nobody where the share shows as 0 %.
function people(share, capacity) {
  if (share < 0.0005) return 'gotovo nitko';
  const n = share * capacity, step = n < 1000 ? 10 : 100;
  return `oko ${fmt(Math.round(n / step) * step)} ljudi`;
}

function renderStats() {
  for (const st of STADIUMS) {
    const r = results[st.key], box = $(`.view-stats[data-for="${st.key}"]`);
    const set = (k, html) => { $(`[data-c="${st.key}.${k}"]`).innerHTML = html; };
    if (!r) {
      $('[data-k="wet"]', box).textContent = '…';
      $('[data-k="wind"]', box).textContent = '…';
      $('[data-k="wetAbs"]', box).textContent = 'računam vjetar';
      $('[data-k="windy"]', box).textContent = ' ';
      continue;
    }
    // Numbers still from the last wind direction while the tunnel works on the new one.
    const stale = !!st.field && st.field.from !== state.from;
    box.classList.toggle('stale', stale);
    for (const c of document.querySelectorAll(`[data-c^="${st.key}."]`)) c.classList.toggle('stale', stale);
    const rainOn = state.rain > 0, wetKnown = r.wetShare !== null;
    $('[data-k="wet"]', box).textContent = !rainOn ? 'nema kiše' : wetKnown ? pct(r.wetShare) : '…';
    $('[data-k="wetAbs"]', box).textContent = rainOn && wetKnown ? people(r.wetShare, st.capacity) : ' ';
    $('[data-k="wind"]', box).textContent = `${fmt(r.wind, 1)}\u00a0m/s`;
    $('[data-k="windy"]', box).textContent = `${pct(r.windy)} iznad 5 m/s`;
    set('wet', !rainOn ? '0 %' : wetKnown ? `${pct(r.wetShare)}<span class="bar" style="width:${Math.max(2, r.wetShare * 100)}%"></span>` : '…');
    set('dry', `${fmt(Math.round((rainOn && wetKnown ? r.dry : st.capacity) / 100) * 100)}<small>od ${fmt(st.capacity)}</small>`);
    set('wind', `${fmt(r.wind, 1)}\u00a0m/s`);
    set('windy', `${pct(r.windy)}<span class="bar w" style="width:${Math.max(2, r.windy * 100)}%"></span>`);
    set('cover', r.cover === null ? '…' : pct(r.cover));
  }
}

function renderCorners() {
  const t = results.today, f = results.future;
  for (const [key, r] of [['today', t], ['future', f]]) {
    if (!r) continue;
    $(`[data-c="${key}.corner"]`).textContent = `${fmt(r.corner, 1)}\u00a0m/s`;
    $(`[data-c="${key}.rest"]`).textContent = `${fmt(r.rest, 1)}\u00a0m/s`;
    $(`[data-c="${key}.hole"]`).textContent = r.hole === null ? 'n/a' : `${fmt(r.hole * 100)}\u00a0%`;
    $(`[data-c="${key}.wetCorner"]`).textContent = state.rain <= 0 ? '0 %' : r.wetCorner === null ? '…' : pct(r.wetCorner);
    $(`[data-c="${key}.wetRest"]`).textContent = state.rain <= 0 ? '0 %' : r.wetRest === null ? '…' : pct(r.wetRest);
  }
  const el = $('#corner-answer');
  if (!t || !f) { el.textContent = 'Računam strujanje zraka oko oba stadiona…'; return; }
  const d = dirName(future.field ? future.field.from : state.from);
  if (state.wind < 0.5) { el.textContent = 'Bez vjetra nema ni propuha. Pojačaj vjetar da vidiš razliku između kutova i ostatka stadiona.'; return; }
  const ratio = f.corner / Math.max(f.rest, 0.01);
  const verdict = ratio >= 1.3 ? `Da, za ovaj smjer kroz otvore puše: u kutnim sektorima novog stadiona vjetar je ${fmt(ratio, 1)} puta jači nego na ostalim sjedalima.`
    : ratio >= 1.1 ? 'Pomalo: za ovaj smjer kutni sektori novog stadiona vjetrovitiji su od ostatka tribina.'
    : 'Ne za ovaj smjer: kutni sektori novog stadiona nisu vjetrovitiji od ostatka tribina.';
  const hole = f.hole === null ? '' : `, a kroz otvorene kutove struji ${fmt(f.hole * 100)}\u00a0% slobodnog vjetra na istoj visini`;
  const vsToday = f.corner < t.corner ? `U kutovima je ipak mirnije nego danas, kad ondje puše ${fmt(t.corner, 1)}\u00a0m/s.`
    : `U kutovima puše i više nego danas, kad ondje puše ${fmt(t.corner, 1)}\u00a0m/s.`;
  const exposed = f.coverCorner === null ? null : 1 - f.coverCorner;
  const roofNote = exposed === null ? ''
    : exposed >= 0.005 ? ` Krovovi ne pokrivaju ${pct(exposed)} kutnih sjedala.`
    : ' Krovovi pokrivaju sva kutna sjedala, pa do njih kiša stiže samo ukoso.';
  const rainNote = state.rain > 0 && f.wetCorner !== null
    ? ` Na kiši je ${pct(f.wetCorner)} gledatelja u kutnim sektorima i ${pct(f.wetRest)} na ostalim sjedalima.${roofNote}`
    : '';
  el.textContent = `${verdict} Uz ${fmt(state.wind, 1)}\u00a0m/s ${d.text} kutovi imaju ${fmt(f.corner, 1)}\u00a0m/s, ostala sjedala ${fmt(f.rest, 1)}\u00a0m/s${hole}. ${vsToday}${rainNote}`;
}

// Eight wind directions for the new stadium: corner sectors against the other seats.
function renderSweep() {
  const data = sweep.future, done = SWEEP_DIRS.filter((d) => data[d]);
  $('#sweep-box').hidden = done.length === 0;
  if (!done.length) return;
  const U = state.wind;
  const W = 340, H = 176, L = 30, R = 6, T = 22, B = 24;
  const top = Math.max(1, ...done.map((d) => Math.max(data[d].corner, data[d].rest) * U));
  const step = top > 8 ? 4 : top > 4 ? 2 : top > 2 ? 1 : 0.5;
  const ymax = Math.ceil(top / step) * step;
  const y = (v) => T + (H - T - B) * (1 - v / ymax);
  const band = (W - L - R) / SWEEP_DIRS.length, bw = Math.min(12, band * 0.3);
  const bar = (x, v, cls) => {
    const y0 = y(0), y1 = y(v), r = Math.min(4, (y0 - y1) / 2, bw / 2);
    return `<path class="${cls}" d="M${x},${y0} V${y1 + r} Q${x},${y1} ${x + r},${y1} H${x + bw - r} Q${x + bw},${y1} ${x + bw},${y1 + r} V${y0} Z"/>`;
  };
  let svg = '';
  for (let v = 0; v <= ymax + 1e-6; v += step) {
    svg += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="tick" x="${L - 6}" y="${y(v)}">${fmt(v, step < 1 ? 1 : 0)}</text>`;
  }
  SWEEP_DIRS.forEach((dir, k) => {
    const cx = L + band * (k + 0.5), s = data[dir];
    const cur = Math.round(state.from / 45) % 8 === k;
    svg += `<text class="dir${cur ? ' cur' : ''}" x="${cx}" y="${H - 8}">${DIRS[k][0]}</text>`;
    if (!s) return;
    svg += bar(cx - bw - 1, s.rest * U, 's1') + bar(cx + 1, s.corner * U, 's2');
    svg += `<text class="val" x="${cx + 1 + bw / 2}" y="${y(s.corner * U) - 5}">${fmt(s.corner * U, 1)}</text>`;
    svg += `<rect class="hit" x="${cx - band / 2}" y="${T}" width="${band}" height="${H - T - B}" data-dir="${dir}"/>`;
  });
  $('#sweep-chart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Vjetar u kutnim sektorima i na ostalim sjedalima novog stadiona za osam smjerova, u m/s pri ${fmt(U, 1)}\u00a0m/s">${svg}</svg><div class="tip" hidden></div>`;
  const rows = SWEEP_DIRS.filter((d) => data[d]).map((d) => {
    const s = data[d], o = sweep.today[d];
    return `<tr><th scope="row">${dirName(d).text}</th><td>${fmt(s.corner * U, 1)}</td><td>${fmt(s.rest * U, 1)}</td><td>${fmt(s.hole * 100)}\u00a0%</td><td>${o ? fmt(o.corner * U, 1) : '…'}</td></tr>`;
  }).join('');
  $('#sweep-table').innerHTML = `<thead><tr><th scope="col">Vjetar puše</th><th scope="col">Kutovi</th><th scope="col">Ostalo</th><th scope="col">Kroz otvore</th><th scope="col">Danas, kutovi</th></tr></thead><tbody>${rows}</tbody>`;
  const tip = $('#sweep-chart .tip');
  for (const hit of document.querySelectorAll('#sweep-chart .hit')) {
    const show = () => {
      const d = +hit.dataset.dir, s = data[d];
      tip.innerHTML = `<b>Puše ${dirName(d).text}</b><br>Kutni sektori ${fmt(s.corner * U, 1)}\u00a0m/s<br>Ostala sjedala ${fmt(s.rest * U, 1)}\u00a0m/s<br>Kroz otvore ${fmt(s.hole * 100)}\u00a0% slobodnog vjetra`;
      tip.hidden = false;
      const x = ((+hit.getAttribute('x') + band / 2) / W) * 100;
      tip.style.left = `${clamp(x, 18, 82)}%`;
    };
    hit.addEventListener('pointerenter', show);
    hit.addEventListener('pointerleave', () => { tip.hidden = true; });
  }
}

function renderProgress(job, prog, queue) {
  const el = $('#busy');
  if (!job) {
    el.hidden = true;
    $('#sweep').disabled = false;
    return;
  }
  el.hidden = false;
  const who = job.st.key === 'today' ? 'današnjeg' : 'novog';
  const sweeping = job.kind === 'sweep' || queue.some((j) => j.kind === 'sweep');
  const left = sweeping ? `, još ${queue.filter((j) => j.kind === 'sweep').length + (job.kind === 'sweep' ? 1 : 0)} smjerova` : '';
  el.textContent = `Simuliram strujanje zraka oko ${who} stadiona, vjetar ${dirName(job.from).text}: ${fmt(prog * 100)}\u00a0%${left}.`;
}

function describeWeather() {
  const bf = beaufort(state.wind);
  $('#wind-out').textContent = `${fmt(state.wind, 1)}\u00a0m/s`;
  $('#wind-hint').textContent = state.wind < 0.3 ? 'Tišina, zastave vise.' : `${bf.name[0].toUpperCase() + bf.name.slice(1)}, ${bf.b} bofora na 10 m visine.`;
  const d = dirName(state.from);
  $('#dial-value').textContent = `puše ${d.text}`;
  const dial = $('#dial');
  dial.setAttribute('aria-valuenow', String(Math.round(state.from)));
  dial.setAttribute('aria-valuetext', `puše ${d.text}, ${Math.round(state.from)} stupnjeva`);
  $('.dial-arrow').setAttribute('transform', `rotate(${state.from})`);
  $('#rain-out').textContent = state.rain > 0 ? `${fmt(state.rain, 1)} mm/h` : 'bez kiše';
  if (state.rain <= 0) { $('#rain-hint').textContent = 'Suho. Vjetar na sjedalima vidiš kad pod Prikazom odabereš Vjetar.'; return; }
  // Classes of the rain rate after WMO: light below 2.5 mm/h, moderate to 10, heavy to 50, violent above.
  const kind = state.rain < 2.5 ? 'Slaba kiša' : state.rain < 10 ? 'Umjerena kiša' : state.rain < 50 ? 'Jaka kiša' : 'Vrlo jaka kiša';
  // The smallest and the largest of the five classes of drops.
  const drops = rainDrops(state.rain), a = drops[0], b = drops[drops.length - 1], u = state.wind * ROOF_WIND;
  const ang = (c) => fmt(Math.atan2(u, c.vt) / DEG);
  $('#rain-hint').textContent = `${kind}. Kapi od ${fmt(a.d, 1)} do ${fmt(b.d, 1)}\u00a0mm padaju ${fmt(a.vt, 1)} do ${fmt(b.vt, 1)}\u00a0m/s`
    + (state.wind < 0.3 ? ', okomito.' : `, a iznad krovova ih vjetar nosi pod kutem od ${ang(b)}° do ${ang(a)}° od okomice.`);
}

function syncInputs() {
  $('#wind').value = state.wind;
  $('#rain').value = state.rain;
  for (const b of document.querySelectorAll('[data-preset]')) {
    const w = PRESET_WEATHER[b.dataset.preset];
    b.setAttribute('aria-pressed', String(w.wind === state.wind && w.from === state.from && w.rain === state.rain));
  }
}

let weatherDirty = true;
function weatherChanged() {
  describeWeather();
  syncInputs();
  weatherDirty = true;
}

function buildDial() {
  const g = $('.dial-ticks');
  const ns = 'http://www.w3.org/2000/svg';
  for (let i = 0; i < 16; i++) {
    const a = i * 22.5 * DEG;
    const l = document.createElementNS(ns, 'line');
    const r0 = i % 2 ? 43 : 40;
    l.setAttribute('x1', String(Math.sin(a) * r0)); l.setAttribute('y1', String(-Math.cos(a) * r0));
    l.setAttribute('x2', String(Math.sin(a) * 46)); l.setAttribute('y2', String(-Math.cos(a) * 46));
    g.appendChild(l);
  }
  DIRS.forEach(([s], i) => {
    const a = i * 45 * DEG;
    const t = document.createElementNS(ns, 'text');
    t.setAttribute('x', String(Math.sin(a) * 55)); t.setAttribute('y', String(-Math.cos(a) * 55));
    if (i % 2 === 0) t.setAttribute('class', 'main');
    t.textContent = s;
    g.appendChild(t);
  });
  const dial = $('#dial');
  const setFrom = (e) => {
    const r = dial.getBoundingClientRect();
    const x = e.clientX - (r.left + r.width / 2), y = e.clientY - (r.top + r.height / 2);
    state.from = (Math.round(((Math.atan2(x, -y) / DEG + 360) % 360) / 5) * 5) % 360;
    weatherChanged();
  };
  dial.addEventListener('pointerdown', (e) => { dial.setPointerCapture(e.pointerId); setFrom(e); });
  dial.addEventListener('pointermove', (e) => { if (dial.hasPointerCapture(e.pointerId)) setFrom(e); });
  dial.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 22.5, ArrowUp: 22.5, ArrowLeft: -22.5, ArrowDown: -22.5 }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    state.from = (Math.round((state.from + step) / 22.5) * 22.5 + 360) % 360;
    weatherChanged();
  });
}

function bindUI() {
  $('#wind').addEventListener('input', (e) => { state.wind = +e.target.value; weatherChanged(); renderSweep(); });
  $('#rain').addEventListener('input', (e) => { state.rain = +e.target.value; weatherChanged(); });
  for (const b of document.querySelectorAll('[data-preset]')) b.addEventListener('click', () => {
    Object.assign(state, PRESET_WEATHER[b.dataset.preset]);
    weatherChanged();
    renderSweep();
  });
  for (const b of document.querySelectorAll('[data-mode]')) b.addEventListener('click', () => {
    state.mode = b.dataset.mode;
    document.querySelectorAll('[data-mode]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    $('#legend-rain').hidden = state.mode !== 'rain';
    $('#legend-wind').hidden = state.mode !== 'wind';
    STADIUMS.forEach(paint);
  });
  for (const b of document.querySelectorAll('[data-cam]')) b.addEventListener('click', () => goTo(b.dataset.cam));
  $('#xray').addEventListener('change', (e) => {
    state.xray = e.target.checked;
    for (const st of STADIUMS) for (const m of new Set(st.roofMaterials)) {
      m.transparent = state.xray;
      m.opacity = state.xray ? 0.16 : 1;
      m.depthWrite = !state.xray;
      m.needsUpdate = true;
    }
  });
  $('#slice').addEventListener('change', (e) => { state.slice = e.target.checked; });
  $('#slice-h').addEventListener('input', (e) => { state.sliceH = +e.target.value; $('#slice-out').textContent = `${state.sliceH} m`; });
  $('#sweep').addEventListener('click', () => {
    if (!aero) return;
    $('#sweep').disabled = true;
    const jobs = [];
    for (const st of [future, today]) for (const from of SWEEP_DIRS) if (!sweep[st.key][from]) jobs.push({ st, from });
    aero.sweep(jobs);
    if (!jobs.length) { $('#sweep').disabled = false; renderSweep(); }
  });
  $('#cell-size').textContent = String(TUNNEL.dx);
  $('#spin-size').textContent = String(SPINUP.dx);
  if (!LBM.ok) {
    $('#sweep').hidden = true;
    $('#slice-field').hidden = true;
    $('#fallback-note').hidden = false;
  }
  buildDial();
}

// ------------------------------------------------------------------ boot
buildEnvironment();
const today = buildToday();
const future = await buildFuture();
const STADIUMS = [today, future];
const rain = buildRain();
const streaks = STADIUMS.map((st) => new WindStreaks(st));
const slices = STADIUMS.map((st) => new SliceView(st));

// The wind tunnel where the GPU supports it; otherwise the ray-traced estimate.
let aero = null, rainSims = null, sims = null;
function onField(st, field, kind) {
  const stats = fieldStats(st, field);
  if (kind === 'sweep' || field.from !== state.from) {
    sweep[st.key][field.from] = { corner: stats.corner, rest: stats.rest, hole: stats.hole };
    renderSweep();
  }
  if (field.from !== state.from) return;
  sweep[st.key][field.from] = { corner: stats.corner, rest: stats.rest, hole: stats.hole };
  st.field = field;
  st.ratio = stats.ratio;
  st.stats = stats;
  const rs = rainSims.get(st);
  rs.setField(field);
  rs.run(state);
  updateResults(st);
  renderSweep();
}
function onRain(st, data) {
  st.wet = data.wet;
  st.cover = data.cover;
  updateResults(st);
}
function onHeuristic(st, r, p) {
  const n = st.seats.length;
  st.ratio = new Float32Array(n);
  let cs = 0, cn = 0, rs = 0, rn = 0;
  for (let i = 0; i < n; i++) {
    st.ratio[i] = heightFactor(st.seatY[i]) * localFactor(r.shelter[i], r.encl[i]);
    if (st.corner[i]) { cs += st.ratio[i]; cn++; } else { rs += st.ratio[i]; rn++; }
  }
  st.stats = { corner: cn ? cs / cn : 0, rest: rn ? rs / rn : 0, hole: null };
  st.wet = r.wet;
  st.cover = r.cover;
  updateResults(st);
}
if (LBM.ok) {
  aero = new Aero(onField, renderProgress);
  rainSims = new Map(STADIUMS.map((st) => [st, new RainSim(st, st.rainBounds, onRain)]));
} else {
  sims = STADIUMS.map((st) => new Sim(st, onHeuristic));
}

const views = [
  { el: $('#view-a'), st: today, cam: new THREE.PerspectiveCamera(36, 1, 2, 12000) },
  { el: $('#view-b'), st: future, cam: new THREE.PerspectiveCamera(36, 1, 2, 12000) },
];
const baseLabels = envLabels();
for (const v of views) {
  v.target = v.st.center.clone().add(new THREE.Vector3(0, 8, 0));
  v.labels = new LabelLayer($('.labels', v.el));
  for (const l of baseLabels) v.labels.add(l.text, l.pos, l.kind);
  for (const l of v.st.labels) v.labels.add(l.text, l.pos, l.kind);
}

bindUI();
weatherChanged();
renderStats();
renderCorners();
goTo('zrak', true);

function resize() {
  const r = canvas.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
}
new ResizeObserver(resize).observe(canvas);
resize();

let rainVel = new THREE.Vector3(0, -6, 0);
let dirTimer = 0, requestedFrom = null;
function applyWeather() {
  weatherDirty = false;
  if (aero) {
    // A new direction needs a new tunnel run; wait until the dial stops moving.
    if (state.from !== requestedFrom) {
      clearTimeout(dirTimer);
      const from = state.from;
      dirTimer = setTimeout(() => { requestedFrom = from; for (const st of STADIUMS) aero.request(st, from); }, requestedFrom === null ? 0 : 350);
    }
    for (const st of STADIUMS) {
      if (st.field) rainSims.get(st).run(state);
      updateResults(st);
    }
  } else {
    for (const s of sims) s.run({ wind: state.wind, from: state.from, rain: state.rain });
  }
  rainVel = updateRainMaps(state, STADIUMS);
  const k = clamp(state.rain / 25, 0, 1);
  const top = SKY.dryTop.clone().lerp(SKY.wetTop, k), hor = SKY.dryHorizon.clone().lerp(SKY.wetHorizon, k);
  skyUniforms.uTop.value.copy(top);
  skyUniforms.uHorizon.value.copy(hor);
  scene.fog.color.copy(hor);
  scene.fog.near = lerp(900, 320, k);
  scene.fog.far = lerp(3600, 1900, k);
  sun.intensity = lerp(2.1, 0.55, Math.sqrt(k));
  hemi.intensity = lerp(1.15, 1.55, k);
  renderer.toneMappingExposure = lerp(1.02, 1.12, k);
  const count = state.rain > 0 ? Math.round(Math.min(rain.max, 9000 + state.rain * 1400)) : 0;
  rain.lines.geometry.setDrawRange(0, count * 2);
  rain.lines.visible = count > 0;
  rain.mat.uniforms.uVel.value.copy(rainVel).multiplyScalar(2.6);
  rain.mat.uniforms.uLen.value = 3 + Math.min(4, rainVel.length() * 0.35);
  rain.mat.uniforms.uOpacity.value = 0.28 + k * 0.32;
}

const clock = new THREE.Clock();
const northEl = $('#north svg');
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  timeUniform.value += REDUCED_MOTION ? 0 : dt;
  if (weatherDirty) applyWeather();
  if (aero) aero.tick();

  if (tween) {
    tween.t = Math.min(1, tween.t + dt / 1.3);
    const e = tween.t < 0.5 ? 4 * tween.t ** 3 : 1 - (-2 * tween.t + 2) ** 3 / 2;
    master.position.copy(tween.from).lerp(tween.to, e);
    if (tween.t >= 1) tween = null;
  }
  controls.update();

  for (const st of STADIUMS) {
    if (!st.fade) continue;
    const k = 1 - Math.exp(-dt * 7);
    let moving = 0;
    for (let i = 0; i < st.colors.length; i++) {
      const d = st.target[i] - st.colors[i];
      st.colors[i] += d * k;
      if (Math.abs(d) > 0.004) moving++;
    }
    st.crowd.instanceColor.needsUpdate = true;
    if (!moving) st.fade = 0;
  }
  if (!REDUCED_MOTION) for (const s of streaks) s.update(dt, state);
  for (const s of slices) s.update(state.sliceH, state.slice);

  const cr = canvas.getBoundingClientRect();
  renderer.setScissorTest(true);
  for (const v of views) {
    const r = v.el.getBoundingClientRect();
    const x = r.left - cr.left, y = cr.bottom - r.bottom, w = r.width, h = r.height;
    if (w < 2 || h < 2) continue;
    v.cam.position.copy(v.target).add(master.position);
    v.cam.quaternion.copy(master.quaternion);
    v.cam.aspect = w / h;
    v.cam.updateProjectionMatrix();
    v.cam.updateMatrixWorld();
    for (const st of STADIUMS) st.root.visible = st === v.st;
    const o = v.target;
    rain.mat.uniforms.uOrigin.value.set(o.x - RAIN_BOX.x / 2, 0, o.z - RAIN_BOX.z / 2);
    rain.mat.uniforms.uDepth.value = rainTarget(v.st).depthTexture;
    sky.position.copy(v.cam.position);
    renderer.setViewport(x, y, w, h);
    renderer.setScissor(x, y, w, h);
    renderer.render(scene, v.cam);
    v.labels.update(v.cam, w, h);
  }
  const fwd = new THREE.Vector3();
  master.getWorldDirection(fwd);
  const heading = Math.atan2(fwd.x, -fwd.z) / DEG;
  northEl.style.transform = `rotate(${-heading}deg)`;
  requestAnimationFrame(frame);
}
$('#loading').remove();
requestAnimationFrame(frame);
