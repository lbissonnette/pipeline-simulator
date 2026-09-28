/* UI wiring, stage rendering (worker grid + flow particles), KPIs and charts. */
(function () {
  'use strict';
  const { Simulation, COHORT_TICKS, makeRng, sampleRate, expectedRate, expectedBundleTicks } = PipelineSim;

  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const fmt = window.fmtNumber;

  // ---------- time ----------
  const TICK_SECONDS = 10;
  const TICKS_PER_MIN = 60 / TICK_SECONDS;
  const TICKS_PER_HOUR = 3600 / TICK_SECONDS;
  const fmtInt = v => Math.round(v).toLocaleString();

  // 720 ticks -> "2h", 735 -> "2h 03m", 42 -> "7m", 3 -> "30s"
  function fmtDur(ticks) {
    if (ticks === null || ticks === undefined || Number.isNaN(ticks)) return '–';
    const s = ticks * TICK_SECONDS;
    if (s < 60) return `${Math.round(s)}s`;
    const m = s / 60;
    if (m < 60) return `${Math.round(m)}m`;
    const h = m / 60;
    if (h < 48) {
      const hh = Math.floor(h), mm = Math.round((h - hh) * 60);
      if (mm === 60) return `${hh + 1}h`;
      return mm ? `${hh}h ${String(mm).padStart(2, '0')}m` : `${hh}h`;
    }
    return `${(h / 24).toFixed(1)}d`;
  }
  const fmtMinutes = ticks => (ticks / TICKS_PER_MIN).toFixed(0) + ' min';
  // axis labels in hours: 0, 0.5, 1, 1.5 ...
  const fmtHours = h => (Math.abs(h - Math.round(h)) < 1e-9 ? String(Math.round(h)) : h.toFixed(h < 1 ? 2 : 1).replace(/0$/, '')) + 'h';
  // Constant-width variant for live readouts: always "Hh MMm" (e.g. 0h 07m, 1h 59m, 2h 00m).
  function fmtDurFixed(ticks) {
    if (ticks === null || ticks === undefined || Number.isNaN(ticks)) return '–';
    const totalMin = Math.round((ticks * TICK_SECONDS) / 60);
    const h = Math.floor(totalMin / 60), m = totalMin % 60;
    return `${h}h ${String(m).padStart(2, '0')}m`;
  }

  // Axis ticks for time-based x axes: pick a "nice" time step in ticks.
  const TIME_STEPS = [6, 30, 60, 180, 360, 720, 1080, 2160, 4320, 8640, 17280];
  function timeTicks(first, last) {
    const range = Math.max(1, last - first);
    let step = TIME_STEPS[TIME_STEPS.length - 1];
    for (const s of TIME_STEPS) { if (range / s <= 7) { step = s; break; } }
    const out = [];
    for (let v = Math.ceil(first / step) * step; v <= last; v += step) out.push({ value: v, label: fmtDur(v) });
    return out;
  }

  // ---------- state ----------
  const sim = new Simulation({ seed: 42 });
  let playing = false;
  const SPEEDS = [6, 12, 30, 60, 120, 180, 360, 720]; // ticks per real second
  let ticksPerSecond = SPEEDS[3];
  let accumulator = 0;
  let lastFrame = 0;
  let particles = [];
  let ramp = [];
  let hoveredWorker = null;

  // ---------- controls ----------
  function fmtParam(name, v) {
    switch (name) {
      case 'waveAmplitude': case 'dist.slowFraction': case 'dist.slowFactor':
        return Math.round(v * 100) + '%';
      case 'expensiveFraction':
        return (v * 100).toFixed(3) + '%';
      case 'expensiveCost': case 'expensiveCostSd':
        return fmtMinutes(v);
      case 'arrivalRate': case 'bundleSize': case 'workers':
        return fmtInt(v);
      case 'dist.mean': case 'dist.sd':
        return Number.isInteger(v) ? String(v) : v.toFixed(v < 5 ? 2 : 1).replace(/\.?0+$/, '');
      case 'bundleMaxWait':
        return fmtMinutes(v);
      default: return String(v);
    }
  }

  function setOutput(name, v) {
    const out = document.querySelector(`[data-out="${name}"]`);
    if (out) out.textContent = fmtParam(name, v);
  }

  function readControlsIntoSim() {
    const partial = {};
    for (const el of $$('[data-param]')) {
      const k = el.dataset.param;
      partial[k] = el.tagName === 'SELECT' ? el.value : parseFloat(el.value);
      setOutput(k, partial[k]);
    }
    const dist = {};
    for (const el of $$('[data-dist]')) {
      const k = el.dataset.dist;
      dist[k] = el.tagName === 'SELECT' ? el.value : parseFloat(el.value);
      setOutput('dist.' + k, dist[k]);
    }
    partial.dist = dist;
    sim.update(partial);
    geom = null;
    updateDegradeWarning();
    $('#arrival-rate-s').textContent = fmtInt(partial.arrivalRate / TICK_SECONDS);
    const perBundle = partial.bundleSize * partial.expensiveFraction;
    $('#expensive-per-bundle').textContent = perBundle.toFixed(2);
    $('#expensive-extra').textContent = fmtDur(perBundle * partial.expensiveCost);
    // compound Poisson: var = lambda * E[cost^2]
    $('#expensive-extra-sd').textContent = fmtDur(Math.sqrt(perBundle * (partial.expensiveCost ** 2 + partial.expensiveCostSd ** 2)));
    $('#rate-per-s').textContent = (dist.mean / TICK_SECONDS).toFixed(2).replace(/0$/, '');
    $('.bimodal-only').hidden = dist.type !== 'bimodal';
    drawDistribution();
    updateCapacity();
  }

  $$('[data-param], [data-dist]').forEach(el => el.addEventListener('input', readControlsIntoSim));

  // Warn when both the dispatcher and the degradation target the lowest indices.
  function updateDegradeWarning() {
    const both = sim.config.routing === 'lowestIdle' && $('#degrade-sel').value === 'lowest';
    $('#degrade-warning').hidden = !both;
  }
  $('#degrade-sel').addEventListener('change', updateDegradeWarning);

  $$('[data-incident]').forEach(btn => btn.addEventListener('click', () => {
    const type = btn.dataset.incident;
    const num = id => parseFloat($(id).value);
    const hours = id => Math.max(1, Math.round(num(id) * TICKS_PER_HOUR));
    if (type === 'spike') sim.addIncident('spike', num('#spike-mag'), hours('#spike-dur'));
    else if (type === 'degrade') sim.addIncident('degrade', { factor: num('#degrade-rate'), fraction: num('#degrade-pct') / 100, selection: $('#degrade-sel').value }, hours('#degrade-dur'));
    else if (type === 'poison') sim.addIncident('poison', { share: num('#poison-share') / 100, cost: Math.round(num('#poison-cost') * TICKS_PER_MIN) }, hours('#poison-dur'));
    else if (type === 'upstreamDelay') sim.addIncident('upstreamDelay', 1, hours('#delay-dur'));
    renderIncidents();
    if (!playing) render(true);
  }));

  const INCIDENT_LABEL = {
    spike: i => `Traffic spike ×${i.magnitude}`,
    degrade: i => (i.factor === 0
      ? `Outage: ${fmtInt(i.workers.length)} workers offline`
      : `Degraded: ${fmtInt(i.workers.length)} workers at ×${i.factor}`) + (i.selection === 'lowest' ? ' (lowest index)' : ''),
    poison: i => `Conversions of death: +${(i.magnitude.share * 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}% at ${fmtDur(i.magnitude.cost)}`,
    upstreamDelay: () => 'Upstream delay (holding arrivals)',
  };

  // The list's DOM is rebuilt only when the set of incidents changes; while
  // they run, only the countdown text and bar width are updated (about once
  // a second from the render loop), so the page is not re-laid-out every tick.
  const incidentRows = new Map(); // id -> { li, bar, time }
  let incidentSignature = '';
  function renderIncidents() {
    const ul = $('#active-incidents');
    const sig = sim.incidents.map(i => i.id).join(',');
    if (sig !== incidentSignature) {
      incidentSignature = sig;
      ul.innerHTML = '';
      incidentRows.clear();
      for (const inc of sim.incidents) {
        const li = document.createElement('li');
        li.innerHTML = `<span>${INCIDENT_LABEL[inc.type](inc)}</span><span class="bar"><i></i></span><span class="num"></span><button title="Cancel" aria-label="Cancel incident">×</button>`;
        li.querySelector('button').addEventListener('click', () => { sim.cancelIncident(inc.id); renderIncidents(); if (!playing) render(true); });
        ul.appendChild(li);
        incidentRows.set(inc.id, { li, bar: li.querySelector('.bar i'), time: li.querySelector('.num') });
      }
    }
    for (const inc of sim.incidents) {
      const row = incidentRows.get(inc.id);
      if (!row) continue;
      const left = Math.max(0, inc.end - sim.tick);
      row.bar.style.width = (100 * (1 - left / inc.duration)).toFixed(1) + '%';
      row.time.textContent = fmtDurFixed(left);
    }
  }

  // transport
  const playBtn = $('#btn-play');
  function setPlaying(p) {
    playing = p;
    playBtn.textContent = p ? '❚❚ Pause' : '▶ Play';
    playBtn.setAttribute('aria-pressed', String(p));
    if (p) { lastFrame = performance.now(); requestAnimationFrame(frame); }
    else render(true);
  }
  playBtn.addEventListener('click', () => setPlaying(!playing));
  $('#btn-step').addEventListener('click', () => { doTick(); render(true); });
  $('#btn-reset').addEventListener('click', () => {
    sim.reset(parseInt($('#seed').value, 10) || 0);
    particles = [];
    for (const c of Object.values(charts)) c.hoverIndex = null;
    resetRows();
    renderIncidents();
    render(true);
  });
  function speedLabel(tps) {
    const minPerSec = tps / TICKS_PER_MIN;
    return minPerSec >= 60 ? `${minPerSec / 60}h / s` : `${minPerSec} min / s`;
  }
  $('#speed').addEventListener('input', e => {
    ticksPerSecond = SPEEDS[parseInt(e.target.value, 10)];
    $('#speed-out').textContent = speedLabel(ticksPerSecond);
  });
  document.addEventListener('keydown', e => {
    if (e.target.matches('input, select, textarea')) return;
    if (e.code === 'Space') { e.preventDefault(); setPlaying(!playing); }
    if (e.key === 's' || e.key === 'ArrowRight') { doTick(); render(true); }
  });

  // ---------- distribution preview ----------
  const distCanvas = $('#dist-canvas');
  function drawDistribution() {
    const ctx = distCanvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = distCanvas.getBoundingClientRect();
    const W = rect.width || 300, H = 80;
    distCanvas.width = W * dpr; distCanvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const d = sim.config.dist;
    const xmax = Math.max(5, Math.ceil(Math.max(d.mean * 2, d.mean + 4 * d.sd) / 5) * 5);
    $('#dist-xmax').textContent = xmax;
    const bins = 40, counts = new Array(bins).fill(0);
    const rng = makeRng(2024), n = 6000;
    for (let i = 0; i < n; i++) {
      const r = sampleRate(rng, d);
      counts[Math.min(bins - 1, Math.floor((r / xmax) * bins))]++;
    }
    const max = Math.max(...counts);
    const bw = W / bins;
    ctx.fillStyle = cssVar('--s1');
    for (let i = 0; i < bins; i++) {
      const h = (counts[i] / max) * (H - 8);
      const x = i * bw + 1, w = Math.max(1, bw - 2), y = H - h;
      if (h <= 0) continue;
      ctx.beginPath();
      roundTop(ctx, x, y, w, h, Math.min(3, w / 2));
      ctx.fill();
    }
    const m = expectedRate(d);
    const mx = Math.round((m / xmax) * W) + 0.5;
    ctx.strokeStyle = cssVar('--text-2'); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(mx, 0); ctx.lineTo(mx, H); ctx.stroke();
    ctx.fillStyle = cssVar('--text-2'); ctx.font = '11px system-ui, sans-serif';
    const right = m / xmax > 0.5;
    ctx.textAlign = right ? 'right' : 'left';
    ctx.fillText(`mean ${fmtParam('dist.mean', m)}`, mx + (right ? -4 : 4), 10);
  }
  function roundTop(ctx, x, y, w, h, r) {
    ctx.moveTo(x, y + h);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h);
    ctx.closePath();
  }

  function bundleTicks() { return sim.expectedBundleTicks(); }

  function updateCapacity() {
    const ticks = bundleTicks();
    const cap = (sim.workers.length * sim.config.bundleSize) / ticks;
    $('#bundle-ticks').textContent = fmtDur(ticks);
    $('#capacity').textContent = fmtInt(cap);
    const rho = sim.config.arrivalRate / Math.max(1e-9, cap);
    const rhoEl = $('#rho');
    rhoEl.textContent = rho.toFixed(2);
    rhoEl.style.color = rho >= 1 ? cssVar('--critical') : '';
    $('#kpi-cap').textContent = `of ${fmtInt(cap)} capacity`;
  }

  // ---------- simulation loop ----------
  function doTick() {
    const snap = sim.step();
    spawnParticles(sim.events, snap);
    return snap;
  }

  function frame(now) {
    if (!playing) return;
    const dt = Math.min(0.25, (now - lastFrame) / 1000);
    lastFrame = now;
    accumulator += dt * ticksPerSecond;
    let n = Math.floor(accumulator);
    accumulator -= n;
    if (n > 400) { n = 400; accumulator = 0; }
    for (let i = 0; i < n; i++) doTick();
    render(false);
    requestAnimationFrame(frame);
  }

  // ---------- stage ----------
  const stage = $('#stage');
  const sctx = stage.getContext('2d');
  const tooltip = $('#stage-tooltip');
  let geom = null;
  let NODE_R = 34;

  function computeGeometry() {
    const n = sim.workers.length;
    const rect0 = stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (geom && geom.n === n && geom.W === rect0.width && geom.H === rect0.height && geom.dpr === dpr) return geom;
    const narrow = rect0.width < 640;
    // taller stage for big pools so cells stay legible
    const wantH = narrow ? (n > 400 ? 520 : 420) : (n > 400 ? 640 : 460);
    if (Math.round(rect0.height) !== wantH) stage.style.height = wantH + 'px';
    const rect = stage.getBoundingClientRect();
    const W = rect.width, H = rect.height;
    if (stage.width !== Math.round(W * dpr) || stage.height !== Math.round(H * dpr)) {
      stage.width = Math.round(W * dpr); stage.height = Math.round(H * dpr);
    }
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const sideW = narrow ? 0 : 150;
    const pad = 12;
    const gridX = sideW + pad, gridY = narrow ? 80 : pad;
    const gridW = W - sideW * 2 - pad * 2, gridH = H - gridY - pad;
    const gap = n > 200 ? 2 : 3;
    const cell = Math.max(2, Math.floor(Math.min((gridW - gap * (cols - 1)) / cols, (gridH - gap * (rows - 1)) / rows)));
    const usedW = cols * cell + (cols - 1) * gap, usedH = rows * cell + (rows - 1) * gap;
    const ox = gridX + (gridW - usedW) / 2, oy = gridY + (gridH - usedH) / 2;
    geom = {
      n, dpr, W, H, cols, rows, cell, gap, ox, oy, narrow, sideW,
      source: narrow ? { x: W * 0.14, y: 38 } : { x: sideW / 2, y: H * 0.15 },
      bundler: narrow ? { x: W * 0.38, y: 38 } : { x: sideW / 2, y: H * 0.5 },
      dispatcher: narrow ? { x: W * 0.62, y: 38 } : { x: sideW / 2, y: H * 0.85 },
      sink: narrow ? { x: W * 0.86, y: 38 } : { x: W - sideW / 2, y: H * 0.5 },
    };
    NODE_R = narrow ? 28 : 34;
    return geom;
  }

  function cellCenter(i) {
    const g = geom;
    const c = i % g.cols, r = Math.floor(i / g.cols);
    return { x: g.ox + c * (g.cell + g.gap) + g.cell / 2, y: g.oy + r * (g.cell + g.gap) + g.cell / 2 };
  }

  function spawnParticles(events, snap) {
    if (!geom) return;
    const now = performance.now();
    // flight time: ~700 ms at 1 min/s, ~450 ms at 10 min/s, 300 ms floor at the fastest speeds
    const dur = Math.max(300, Math.min(700, 1400 / Math.sqrt(Math.max(1, ticksPerSecond / 6))));
    const g = geom, R = NODE_R;
    const edge = (node, dir) => ({
      x: node.x + (dir === 'out' ? R : dir === 'in' ? -R : 0),
      y: node.y + (dir === 'down' ? R : dir === 'up' ? -R : 0),
    });
    const scale = Math.min(1, 60 / Math.max(1, ticksPerSecond)); // 1 at <= 10 min/s, 1/12 at 2 h/s
    const sample = (list, max) => {
      max = Math.max(1, Math.round(max * scale));
      const keep = Math.min(list.length, max), out = [];
      for (let i = 0; i < keep; i++) out.push(list[Math.floor((i / keep) * list.length)]);
      return out;
    };
    for (const [i] of sample(events.filter(e => e.type === 'bundle'), 12).entries()) {
      const from = g.narrow ? edge(g.bundler, 'out') : edge(g.bundler, 'down');
      const to = g.narrow ? edge(g.dispatcher, 'in') : edge(g.dispatcher, 'up');
      particles.push({ x0: from.x, y0: from.y, x1: to.x, y1: to.y, t0: now + i * 12, dur: dur * 0.6, kind: 'in' });
    }
    for (const [i, e] of sample(events.filter(e => e.type === 'dispatch'), 24).entries()) {
      const to = cellCenter(e.worker);
      const from = g.narrow ? edge(g.dispatcher, 'down') : edge(g.dispatcher, 'out');
      particles.push({ x0: from.x, y0: from.y, x1: to.x, y1: to.y, t0: now + i * 8, dur, kind: 'in' });
    }
    for (const [i, e] of sample(events.filter(e => e.type === 'complete'), 24).entries()) {
      const from = cellCenter(e.worker);
      const to = g.narrow ? edge(g.sink, 'down') : edge(g.sink, 'in');
      particles.push({ x0: from.x, y0: from.y, x1: to.x, y1: to.y, t0: now + i * 10, dur, kind: 'out' });
    }
    // arrivals: a steady trickle, doubled during a spike
    const arr = snap.arrivals <= 0 ? 0 : snap.arrivals > 1.5 * sim.config.arrivalRate ? 2 : 1;
    for (let i = 0; i < arr; i++) {
      let from, to;
      if (snap.heldItems > 0) {
        from = { x: g.source.x, y: g.source.y - R - 26 }; to = { x: g.source.x, y: g.source.y - R };
      } else if (g.narrow) {
        from = edge(g.source, 'out'); to = edge(g.bundler, 'in');
      } else {
        from = edge(g.source, 'down'); to = edge(g.bundler, 'up');
      }
      particles.push({ x0: from.x, y0: from.y, x1: to.x, y1: to.y, t0: now + i * 20, dur: dur * 0.8, kind: 'arr' });
    }
    if (particles.length > 600) particles.splice(0, particles.length - 600);
  }

  let theme = null;      // cached colours; rebuilt on theme change

  function buildRamp() {
    ramp = cssVar('--ramp').split(',').map(s => s.trim());
    theme = {
      surface: cssVar('--surface'), surface2: cssVar('--surface-2'), border: cssVar('--border'),
      ink: cssVar('--text'), ink2: cssVar('--text-2'), axis: cssVar('--axis'), critical: cssVar('--critical'),
      idle: cssVar('--cell-idle'), offline: cssVar('--cell-offline'), offlineInk: cssVar('--cell-offline-ink'),
      s1: cssVar('--s1'), s2: cssVar('--s2'),
    };
  }

  function drawNode(ctx, x, y, r, title, lines, fillColor, ink, ink2, border) {
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = fillColor; ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = border; ctx.stroke();
    ctx.fillStyle = ink; ctx.font = `600 ${title.length > 8 ? 11 : 12}px system-ui, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(title, x, y - (lines.length ? 8 : 0));
    ctx.font = '11px system-ui, sans-serif'; ctx.fillStyle = ink2;
    lines.forEach((l, i) => ctx.fillText(l, x, y + 7 + i * 13));
  }

  function drawArrow(ctx, x0, y0, x1, y1, color) {
    ctx.strokeStyle = color; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    const a = Math.atan2(y1 - y0, x1 - x0);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - 7 * Math.cos(a - 0.4), y1 - 7 * Math.sin(a - 0.4));
    ctx.lineTo(x1 - 7 * Math.cos(a + 0.4), y1 - 7 * Math.sin(a + 0.4));
    ctx.closePath(); ctx.fillStyle = color; ctx.fill();
  }

  function drawStage() {
    const g = computeGeometry();
    const ctx = sctx;
    ctx.setTransform(g.dpr, 0, 0, g.dpr, 0, 0);
    ctx.clearRect(0, 0, g.W, g.H);
    const snap = sim.last;
    const C = theme;

    const gridLeft = g.ox, gridRight = g.ox + g.cols * (g.cell + g.gap) - g.gap;
    const gridMidY = g.oy + (g.rows * (g.cell + g.gap) - g.gap) / 2;
    const r = NODE_R;
    if (!g.narrow) {
      drawArrow(ctx, g.source.x, g.source.y + r, g.bundler.x, g.bundler.y - r, C.axis);
      drawArrow(ctx, g.bundler.x, g.bundler.y + r, g.dispatcher.x, g.dispatcher.y - r, C.axis);
      drawArrow(ctx, g.dispatcher.x + r, g.dispatcher.y, gridLeft - 6, gridMidY, C.axis);
      drawArrow(ctx, gridRight + 6, gridMidY, g.sink.x - r, g.sink.y, C.axis);
    } else {
      drawArrow(ctx, g.source.x + r, g.source.y, g.bundler.x - r, g.bundler.y, C.axis);
      drawArrow(ctx, g.bundler.x + r, g.bundler.y, g.dispatcher.x - r, g.dispatcher.y, C.axis);
      drawArrow(ctx, g.dispatcher.x + r, g.dispatcher.y, g.sink.x - r, g.sink.y, C.axis);
    }
    const holding = snap.heldItems > 0;
    const full = snap.dispatcherQueued >= snap.dispatcherCapacity;
    const blocked = full && snap.intakeItems >= sim.config.bundleSize;
    drawNode(ctx, g.source.x, g.source.y, r, 'Source',
      holding ? [`holding ${fmt(snap.heldItems)}`, 'delayed'] : [`${fmt(snap.arrivals)} / tick`],
      holding ? C.surface2 : C.surface, C.ink, C.ink2, C.border);
    drawNode(ctx, g.bundler.x, g.bundler.y, r, 'Bundler',
      [`${fmt(snap.intakeItems)} held`, blocked ? 'blocked' : `${snap.cut} cut`],
      blocked ? C.surface2 : C.surface, C.ink, C.ink2, C.border);
    drawNode(ctx, g.dispatcher.x, g.dispatcher.y, r, 'Dispatcher',
      [`${snap.dispatcherQueued} / ${snap.dispatcherCapacity} queued`, `${snap.dispatched} sent`],
      full ? C.surface2 : C.surface, C.ink, C.ink2, C.border);
    if (full) {
      ctx.beginPath(); ctx.arc(g.dispatcher.x, g.dispatcher.y, r + 2, 0, Math.PI * 2);
      ctx.lineWidth = 2; ctx.strokeStyle = C.critical; ctx.stroke();
    }
    drawNode(ctx, g.sink.x, g.sink.y, r, 'Done', [`${fmt(sim.totals.processed)} total`, `${fmt(snap.processed)} / tick`],
      C.surface, C.ink, C.ink2, C.border);

    // worker grid
    const cell = g.cell, rad = Math.min(4, cell / 4);
    const offlineCells = [], slowedCells = []; // hatched in one batched stroke each, after the loop
    const expected = bundleTicks();
    const ageScale = 2 * expected; // darkest at 2x the expected bundle time
    const showBar = cell >= 9;
    const tick = sim.tick;
    for (let i = 0; i < sim.workers.length; i++) {
      const w = sim.workers[i];
      const c = i % g.cols, rr = Math.floor(i / g.cols);
      const x = g.ox + c * (cell + g.gap), y = g.oy + rr * (cell + g.gap);
      const offline = w.offlineUntil >= tick;
      let fill;
      if (offline) fill = C.offline;
      else if (!w.bundle) fill = C.idle;
      else {
        const ratio = Math.min(1, (tick - w.bundle.dispatchedTick) / ageScale);
        fill = ramp[Math.round(ratio * (ramp.length - 1))];
      }
      ctx.fillStyle = fill;
      if (rad >= 2) { ctx.beginPath(); roundRect(ctx, x, y, cell, cell, rad); ctx.fill(); }
      else ctx.fillRect(x, y, cell, cell);
      if (cell >= 6) {
        if (offline) offlineCells.push(x, y);
        else if (w.degradations.length && sim.degradeFactor(w) < 1) slowedCells.push(x, y);
      }
      if (w.bundle && showBar) {
        const b = w.bundle;
        const p = 1 - b.remaining / b.size;
        const bh = Math.max(2, Math.round(cell * 0.14));
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillRect(x + 1, y + cell - bh - 1, Math.round((cell - 2) * p), bh);
        if (b.stallLeft > 0 && b.stallPoison && !offline) {
          const d = Math.max(3, Math.round(cell * 0.3));
          ctx.fillStyle = C.s2;
          ctx.fillRect(x + cell - d - 1, y + 1, d, d);
        }
      }
      if (hoveredWorker === i) {
        ctx.lineWidth = 2; ctx.strokeStyle = C.ink;
        ctx.strokeRect(x + 1, y + 1, cell - 2, cell - 2);
      }
    }

    // hatching: one stroke for all offline cells, one for all slowed cells
    // (per-cell pattern fills were the main cost during incidents)
    const hatchCells = (cells, color, width) => {
      if (!cells.length) return;
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'butt';
      ctx.beginPath();
      const c = cell, h = c / 2;
      for (let k = 0; k < cells.length; k += 2) {
        const x = cells[k] + 1, y = cells[k + 1] + 1, s = c - 2;
        ctx.moveTo(x, y + s / 2); ctx.lineTo(x + s / 2, y);
        ctx.moveTo(x, y + s); ctx.lineTo(x + s, y);
        ctx.moveTo(x + s / 2, y + s); ctx.lineTo(x + s, y + s / 2);
      }
      ctx.stroke();
    };
    hatchCells(offlineCells, C.offlineInk, 1.2);
    hatchCells(slowedCells, 'rgba(255,255,255,0.75)', 1.5);

    // particles
    const now = performance.now();
    const alive = [];
    for (const p of particles) {
      const u = (now - p.t0) / p.dur;
      if (u >= 1) continue;
      alive.push(p);
      if (u < 0) continue;
      const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
      const x = p.x0 + (p.x1 - p.x0) * e, y = p.y0 + (p.y1 - p.y0) * e;
      ctx.beginPath(); ctx.arc(x, y, p.kind === 'arr' ? 2.5 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = C.surface; ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, p.kind === 'arr' ? 1.5 : 2.5, 0, Math.PI * 2);
      ctx.fillStyle = p.kind === 'out' ? C.s2 : C.s1; ctx.fill();
    }
    particles = alive;
  }

  const nativeRoundRect = typeof CanvasRenderingContext2D !== 'undefined' && 'roundRect' in CanvasRenderingContext2D.prototype;
  function roundRect(ctx, x, y, w, h, r) {
    if (nativeRoundRect) { ctx.roundRect(x, y, w, h, r); return; }
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  stage.addEventListener('pointermove', e => {
    if (!geom) return;
    const rect = stage.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const c = Math.floor((x - geom.ox) / (geom.cell + geom.gap));
    const r = Math.floor((y - geom.oy) / (geom.cell + geom.gap));
    let idx = null;
    if (c >= 0 && c < geom.cols && r >= 0 && r < geom.rows) {
      const i = r * geom.cols + c;
      const inX = x - geom.ox - c * (geom.cell + geom.gap) <= geom.cell;
      const inY = y - geom.oy - r * (geom.cell + geom.gap) <= geom.cell;
      if (i < sim.workers.length && inX && inY) idx = i;
    }
    if (idx !== hoveredWorker) { hoveredWorker = idx; if (!playing) drawStage(); }
    if (idx === null) { tooltip.hidden = true; return; }
    const w = sim.workers[idx];
    const offline = w.offlineUntil >= sim.tick;
    const b = w.bundle;
    const df = offline ? 0 : sim.degradeFactor(w);
    tooltip.innerHTML = `<div class="tt-title">Worker ${idx + 1}${offline ? ' · offline' : df < 1 ? ` · slowed ×${df.toFixed(2)}` : b ? '' : ' · idle'}</div>` +
      (b ? `<div class="tt-row"><span>Current bundle</span><b>${Math.round(100 * (1 - b.remaining / b.size))}% done · ${fmt(b.remaining)} left</b></div>` +
           `<div class="tt-row"><span>Working for</span><b>${fmtDur(sim.tick - b.dispatchedTick)} · data aged ${fmtDur(sim.tick - b.createdTick)}</b></div>` +
           `<div class="tt-row"><span>Expensive conversions</span><b>${b.expensive}${b.poisoned ? ` (${b.poisoned} of death)` : ''}${b.stallLeft > 0 ? ` · stalled, ${fmtDur(b.stallLeft)} left` : b.stalls.length ? ` · ${b.stalls.length} ahead` : ''}</b></div>` : '') +
      `<div class="tt-row"><span>Last tick rate</span><b>${w.lastRate.toFixed(1)} conversions</b></div>` +
      `<div class="tt-row"><span>Completed</span><b>${w.completed} bundles · ${fmt(w.processed)} conv.</b></div>`;
    tooltip.hidden = false;
    const tw = tooltip.offsetWidth;
    tooltip.style.left = (x + 16 + tw > rect.width ? x - tw - 12 : x + 16) + 'px';
    tooltip.style.top = Math.max(0, y - 10) + 'px';
  });
  stage.addEventListener('pointerleave', () => { hoveredWorker = null; tooltip.hidden = true; if (!playing) drawStage(); });

  // ---------- charts ----------
  const timeOpts = { xTicks: timeTicks, titleOf: row => `${fmtDur(row.tick)} (tick ${row.tick})` };
  const charts = {
    backlog: new LineChart($('#chart-backlog'), Object.assign({ series: [{ key: 'backlogItems', name: 'Backlog', color: '--s1' }], fill: true }, timeOpts)),
    throughput: new LineChart($('#chart-throughput'), Object.assign({
      series: [{ key: 'arrivals', name: 'Arrivals / tick', color: '--s1' }, { key: 'processed', name: 'Throughput / tick', color: '--s2' }],
      reference: { key: 'nominalCapacity', name: 'Expected capacity' },
    }, timeOpts)),
    latency: new LineChart($('#chart-latency'), Object.assign({}, timeOpts, {
      series: [{ key: 'latP50Hr', name: 'P50', color: '--s1' }, { key: 'latP90Hr', name: 'P90', color: '--s2' }, { key: 'latP99Hr', name: 'P99', color: '--s3' }],
      yFormat: fmtHours,
      format: v => (v === null || v === undefined) ? '–' : fmtDur(v * TICKS_PER_HOUR),
    })),
    inflight: new LineChart($('#chart-inflight'), Object.assign({}, timeOpts, {
      series: [{ key: 'inflight50Hr', name: 'P50', color: '--s1' }, { key: 'inflight90Hr', name: 'P90', color: '--s2' }, { key: 'inflight99Hr', name: 'P99', color: '--s3' }],
      yFormat: fmtHours,
      format: v => (v === null || v === undefined) ? '–' : fmtDur(v * TICKS_PER_HOUR),
    })),
    dispatcher: new LineChart($('#chart-dispatcher'), Object.assign({
      series: [{ key: 'dispatcherQueued', name: 'Bundles waiting', color: '--s1' }], fill: true,
      reference: { key: 'dispatcherCapacity', name: 'Capacity' },
    }, timeOpts)),
    util: new LineChart($('#chart-util'), Object.assign({ series: [{ key: 'utilPct', name: 'Busy share (%)', color: '--s1' }], fill: true }, timeOpts)),
    completeness: new LineChart($('#chart-completeness'), Object.assign({}, timeOpts, {
      series: [{ key: 'pct', name: 'Complete', color: '--s1' }], fill: true, yMax: 100, xByTick: true,
      format: v => (v === null || v === undefined) ? '–' : v.toFixed(1) + '%',
      titleOf: row => `Arrived ${fmtDur(row.tick - 1)} · ${fmtDur(Math.max(0, sim.tick - row.tick + 1))} ago`,
      extraRows: row => [['Arrived', fmt(row.arrived)], ['Processed', fmt(row.processed)]],
    })),
  };
  charts.fresh = new LineChart($('#chart-fresh'), Object.assign({}, timeOpts, {
    series: [
      { key: 'fresh50Hr', name: 'P50', color: '--s1' },
      { key: 'fresh90Hr', name: 'P90', color: '--s2' },
      { key: 'fresh99Hr', name: 'P99', color: '--s3' },
    ],
    yFormat: fmtHours,
    format: v => (v === null || v === undefined) ? '–' : fmtDur(v * TICKS_PER_HOUR),
  }));

  // ---------- E2E processing-time histogram (6 h vs 7 d) ----------
  const HIST_WINDOWS = [
    { key: '12h', name: 'last 12 h', color: '--s1', ticks: 12 * TICKS_PER_HOUR },
    { key: '7d', name: 'last 7 d', color: '--s2', ticks: 7 * 24 * TICKS_PER_HOUR },
  ];
  const BIN_STEPS_MIN = [1, 2, 5, 10, 15, 30, 60, 120];
  const histChart = new Histogram($('#chart-hist'), {
    xLabel: v => fmtDur(v * TICKS_PER_MIN),
    xTicks: (x0, x1) => timeTicks(x0 * TICKS_PER_MIN, x1 * TICKS_PER_MIN).map(t => ({ value: t.value / TICKS_PER_MIN, label: t.label })),
    countLabel: 'conversions',
  });

  // Each window keeps conversion-weighted counts per minute of latency,
  // updated incrementally: new completions are added as they appear and old
  // ones subtracted as they leave the window, so a refresh costs O(changes).
  const FINE_MINUTES = 48 * 60; // latencies beyond 48 h land in the last slot
  class LatencyWindow {
    constructor(ticks) { this.ticks = ticks; this.reset(); }
    reset() {
      this.fine = new Float64Array(FINE_MINUTES + 1);
      this.total = 0; this.maxMinute = 0;
      this.tail = 0;  // index in sim.completions of the next completion to add
      this.head = 0;  // index of the oldest completion still inside the window
      this.epoch = null;
    }
    slot(c) { return Math.min(FINE_MINUTES, Math.floor(c.latency / TICKS_PER_MIN)); }
    update() {
      const list = sim.completions;
      // the model compacts its array occasionally and reset() empties it: rebuild then
      if (this.epoch !== list || this.tail > list.length || this.head > list.length) { this.reset(); this.epoch = list; }
      for (; this.tail < list.length; this.tail++) {
        const c = list[this.tail], s = this.slot(c);
        this.fine[s] += c.size; this.total += c.size;
        if (s > this.maxMinute) this.maxMinute = s;
      }
      const cutoff = sim.tick - this.ticks;
      for (; this.head < this.tail && list[this.head].tick <= cutoff; this.head++) {
        const c = list[this.head];
        this.fine[this.slot(c)] -= c.size; this.total -= c.size;
      }
      if (this.head >= this.tail) { this.total = 0; this.maxMinute = 0; }
    }
    percentile(p) {
      if (this.total <= 0) return null;
      let acc = 0;
      for (let m = 0; m <= FINE_MINUTES; m++) { acc += this.fine[m]; if (acc >= p * this.total) return (m + 0.5) * TICKS_PER_MIN; }
      return FINE_MINUTES * TICKS_PER_MIN;
    }
    binned(binMin, nBins) {
      const counts = new Array(nBins).fill(0);
      for (let m = 0; m <= FINE_MINUTES; m++) {
        const v = this.fine[m];
        if (v > 0) counts[Math.min(nBins - 1, Math.floor(m / binMin))] += v;
      }
      return counts;
    }
  }
  const histWindows = HIST_WINDOWS.map(w => Object.assign({}, w, { win: new LatencyWindow(w.ticks) }));

  function renderHistogram() {
    // size bins from the 99.5th percentile so a rare very long bundle does not
    // squash the bulk; everything beyond lands in a final overflow bin
    let span = 0;
    for (const w of histWindows) {
      w.win.update();
      if (w.win.total > 0) { const p = w.win.percentile(0.995) / TICKS_PER_MIN; if (p > span) span = p; }
    }
    const maxMin = Math.max(30, span + 1);
    let binMin = BIN_STEPS_MIN[BIN_STEPS_MIN.length - 1];
    for (const bm of BIN_STEPS_MIN) { if (maxMin / bm <= 60) { binMin = bm; break; } }
    const nBins = Math.ceil(maxMin / binMin) + 1;
    const bins = Array.from({ length: nBins }, (_, i) => ({ x0: i * binMin, x1: (i + 1) * binMin, overflow: i === nBins - 1 }));
    const series = histWindows.map(w => {
      const counts = w.win.binned(binMin, nBins), total = w.win.total;
      return { name: w.name, color: w.color, counts, values: counts.map(v => total > 0 ? Math.max(0, (100 * v) / total) : 0) };
    });
    histChart.setData({ bins, series });
    histChart.draw();
  }
  // ---------- in-flight age histogram ----------
  const inflightHist = new Histogram($('#chart-inflight-hist'), {
    xLabel: v => fmtDur(v * TICKS_PER_MIN),
    xTicks: (x0, x1) => timeTicks(x0 * TICKS_PER_MIN, x1 * TICKS_PER_MIN).map(t => ({ value: t.value / TICKS_PER_MIN, label: t.label })),
    countLabel: 'conversions',
  });
  let inflightTotal = 0;
  function renderInflightHistogram() {
    const rows = sim.inflightByAge(); // ascending age, ticks
    const total = rows.reduce((s, r) => s + r.count, 0);
    inflightTotal = total;
    // range from the 99.5th percentile of age, overflow bin beyond
    let span = 0, acc = 0;
    for (const r of rows) { acc += r.count; if (acc >= 0.995 * total) { span = r.age / TICKS_PER_MIN; break; } }
    const maxMin = Math.max(30, span + 1);
    let binMin = BIN_STEPS_MIN[BIN_STEPS_MIN.length - 1];
    for (const bm of BIN_STEPS_MIN) { if (maxMin / bm <= 60) { binMin = bm; break; } }
    const nBins = Math.ceil(maxMin / binMin) + 1;
    const bins = Array.from({ length: nBins }, (_, i) => ({ x0: i * binMin, x1: (i + 1) * binMin, overflow: i === nBins - 1 }));
    const counts = new Array(nBins).fill(0);
    for (const r of rows) counts[Math.min(nBins - 1, Math.floor(r.age / TICKS_PER_MIN / binMin))] += r.count;
    inflightHist.setData({ bins, series: [{ name: 'in flight', color: '--s1', counts, values: counts.map(v => total > 0 ? (100 * v) / total : 0) }] });
    inflightHist.draw();
  }

  function renderHistogramText() {
    for (const w of histWindows) {
      $(`#hist-${w.key}-p50`).textContent = fmtDurFixed(w.win.percentile(0.5));
      $(`#hist-${w.key}-p95`).textContent = fmtDurFixed(w.win.percentile(0.95));
    }
  }

  // Most recent arrival minute at which it and every older minute are >= 99% processed.
  function completeThrough(rows) {
    let through = null;
    for (const r of rows) {
      if (r.pct === null) continue;
      if (r.pct >= 99) through = r;
      else break;
    }
    return through;
  }

  // Chart rows: 5-minute moving averages for the noisy per-tick series and a
  // 30-minute rolling window for latency percentiles (few bundles finish per
  // tick). Built incrementally: only ticks appended since the last call are
  // processed, and rows that fell out of the history window are dropped.
  const AVG_WIN = 5 * TICKS_PER_MIN, LAT_WIN = 60 * TICKS_PER_MIN;
  const rowState = { rows: [], lastTick: 0, q: [], sa: 0, sp: 0, latQ: [], latCount: 0, p50: null, p90: null, p99: null };
  function resetRows() {
    Object.assign(rowState, { rows: [], lastTick: 0, q: [], sa: 0, sp: 0, latQ: [], latCount: 0, p50: null, p90: null, p99: null });
  }
  function chartRows(history) {
    const st = rowState;
    if (!history.length) { resetRows(); return st.rows; }
    if (history[history.length - 1].tick < st.lastTick) resetRows(); // sim was reset
    // drop rows older than the history window
    const firstTick = history[0].tick;
    let drop = 0;
    while (drop < st.rows.length && st.rows[drop].tick < firstTick) drop++;
    if (drop) st.rows.splice(0, drop);
    // append new ticks
    let start = history.length - (history[history.length - 1].tick - st.lastTick);
    if (start < 0) start = 0;
    for (let i = start; i < history.length; i++) {
      const h = history[i];
      if (h.tick <= st.lastTick) continue;
      st.q.push(h); st.sa += h.arrivals; st.sp += h.processed;
      if (st.q.length > AVG_WIN) { const d = st.q.shift(); st.sa -= d.arrivals; st.sp -= d.processed; }
      st.latQ.push(h.latencies); st.latCount += h.latencies.length;
      if (st.latQ.length > LAT_WIN) st.latCount -= st.latQ.shift().length;
      if (st.latCount >= 5 && h.tick % 3 === 0) {
        const all = [];
        for (const arr of st.latQ) for (const v of arr) all.push(v);
        all.sort((a, b) => a - b);
        const at = p => all[Math.min(all.length - 1, Math.floor(all.length * p))] / TICKS_PER_HOUR;
        st.p50 = at(0.5); st.p90 = at(0.9); st.p99 = at(0.99);
      } else if (st.latCount < 5) { st.p50 = null; st.p90 = null; st.p99 = null; }
      st.rows.push({
        tick: h.tick, backlogItems: h.backlogItems, nominalCapacity: h.nominalCapacity,
        dispatcherQueued: h.dispatcherQueued, dispatcherCapacity: h.dispatcherCapacity,
        arrivals: st.sa / st.q.length, processed: st.sp / st.q.length, utilPct: h.utilization * 100,
        latP50Hr: st.p50, latP90Hr: st.p90, latP99Hr: st.p99,
        fresh50Hr: h.fresh50 / TICKS_PER_HOUR, fresh90Hr: h.fresh90 / TICKS_PER_HOUR, fresh99Hr: h.fresh99 / TICKS_PER_HOUR,
        inflight50Hr: h.inflight50 / TICKS_PER_HOUR, inflight90Hr: h.inflight90 / TICKS_PER_HOUR, inflight99Hr: h.inflight99 / TICKS_PER_HOUR,
      });
      st.lastTick = h.tick;
    }
    return st.rows;
  }

  // ---------- KPIs ----------
  function updateKpis(rows) {
    const h = sim.history, snap = sim.last;
    $('#tick').textContent = sim.tick;
    $('#clock').textContent = fmtDurFixed(sim.tick);
    $('#kpi-backlog').textContent = fmt(snap.backlogItems);
    const W = TICKS_PER_HOUR;
    const ago = h.length > W ? h[h.length - 1 - W].backlogItems : (h[0] ? h[0].backlogItems : 0);
    const d = snap.backlogItems - ago;
    const deltaEl = $('#kpi-backlog-delta');
    if (h.length < 30) { deltaEl.textContent = 'conversions in the system'; deltaEl.className = 'delta'; }
    else {
      deltaEl.textContent = `${d > 0 ? '+' : d < 0 ? '−' : '±'}${fmt(Math.abs(d))} past hour`;
      deltaEl.className = 'delta ' + (d > 500 ? 'up' : d < -500 ? 'down' : '');
    }
    $('#kpi-oldest').textContent = fmtDur(snap.oldestAge);
    const last = rows[rows.length - 1];
    if (last && last.latP99Hr !== null) {
      $('#kpi-p99').textContent = fmtDur(last.latP99Hr * TICKS_PER_HOUR);
      $('#kpi-p50').textContent = `p50 ${fmtDur(last.latP50Hr * TICKS_PER_HOUR)} · 1 h window`;
      $('#processed-p50').textContent = fmtDurFixed(last.latP50Hr * TICKS_PER_HOUR);
      $('#processed-p90').textContent = fmtDurFixed(last.latP90Hr * TICKS_PER_HOUR);
      $('#processed-p99').textContent = fmtDurFixed(last.latP99Hr * TICKS_PER_HOUR);
    } else {
      $('#kpi-p99').textContent = '–';
      $('#kpi-p50').textContent = 'no bundles finished yet';
    }
    $('#kpi-in').textContent = last ? fmt(last.arrivals) : '0';
    $('#kpi-out').textContent = last ? fmt(last.processed) : '0';
    $('#kpi-busy').textContent = Math.round(snap.utilization * 100) + '%';
    $('#kpi-workers').textContent = [`${fmtInt(snap.idle)} idle`, snap.stalled ? `${fmtInt(snap.stalled)} stalled` : null, snap.slowed ? `${fmtInt(snap.slowed)} slowed` : null, `${fmtInt(snap.offline)} offline`].filter(Boolean).join(' · ');
    const dq = $('#kpi-dispatcher');
    dq.textContent = `${snap.dispatcherQueued} / ${snap.dispatcherCapacity}`;
    dq.classList.toggle('warn', snap.dispatcherQueued >= snap.dispatcherCapacity);
    $('#kpi-upstream').textContent = snap.heldItems > 0
      ? `${fmt(snap.intakeItems)} at bundler · ${fmt(snap.heldItems)} held`
      : `${fmt(snap.intakeItems)} at bundler`;
  }

  // ---------- render ----------
  // The stage and every chart redraw on each animation frame; the numeric
  // readouts (tiles and header figures) refresh a few times a second so the
  // digits do not flicker, and immediately when paused, stepping or resizing.
  const TEXT_INTERVAL_MS = 250;
  let lastText = 0, lastIncidents = 0;

  // Adaptive chart cadence. The stage draws every frame. The charts are
  // spread round-robin over `chartStride` frames (2 = each chart at 30 Hz on a
  // 60 Hz display). If frames run long the stride widens, up to 6; when there
  // is headroom it narrows again. Series move a fraction of a pixel per frame,
  // so 20-30 Hz chart updates look continuous while the flow stays smooth.
  const STRIDES = [2, 3, 4, 6, 8, 12];
  let strideIdx = 0, chartStride = STRIDES[0];
  let frameNo = 0, frameAvg = 16, lastRenderAt = 0, lastStrideChange = 0;
  function tuneStride(now) {
    if (lastRenderAt) {
      const dt = Math.min(100, now - lastRenderAt);
      frameAvg += (dt - frameAvg) * 0.1;
    }
    lastRenderAt = now;
    if (now - lastStrideChange < 1500) return;
    if (frameAvg > 19 && strideIdx < STRIDES.length - 1) { strideIdx++; lastStrideChange = now; }
    else if (frameAvg < 13.5 && strideIdx > 0) { strideIdx--; lastStrideChange = now; }
    chartStride = STRIDES[strideIdx];
  }

  function render(force) {
    const now = performance.now();
    if (playing && !force) tuneStride(now);
    drawStage();
    const rows = chartRows(sim.history);
    // completeness: same horizon as the other charts
    const firstTick = sim.history.length ? sim.history[0].tick : sim.tick;
    const minutes = Math.floor((sim.tick - 1) / COHORT_TICKS) - Math.floor((firstTick - 1) / COHORT_TICKS) + 1;
    const cohorts = sim.completeness(Math.max(1, minutes));
    frameNo++;
    const drawAll = force || !playing;
    const slot = frameNo % chartStride;
    let i = 0;
    for (const [name, c] of Object.entries(charts)) {
      const mine = drawAll || (i++ % chartStride) === slot;
      if (name === 'completeness') { c.setData(cohorts); c.setDomain(firstTick, sim.tick); if (mine) c.draw(); }
      else { c.setData(rows); if (mine) c.draw(); }
    }
    if (drawAll || (i++ % chartStride) === slot) renderHistogram();
    if (drawAll || (i++ % chartStride) === slot) renderInflightHistogram();
    // incident countdowns: once a second, or at once when the set changes
    if (force || now - lastIncidents >= 1000 || sim.incidents.length !== incidentRows.size) { lastIncidents = now; renderIncidents(); }
    if (!force && playing && now - lastText < TEXT_INTERVAL_MS) return;
    lastText = now;
    updateKpis(rows);
    const through = completeThrough(cohorts);
    $('#complete-through').textContent = through
      ? fmtDurFixed(Math.max(0, sim.tick - through.tick - COHORT_TICKS + 1))
      : '–';
    const f = sim.last;
    $('#fresh-p50').textContent = fmtDurFixed(f.fresh50);
    $('#fresh-p90').textContent = fmtDurFixed(f.fresh90);
    $('#fresh-p99').textContent = fmtDurFixed(f.fresh99);
    $('#inflight-p50').textContent = fmtDurFixed(f.inflight50);
    $('#inflight-p90').textContent = fmtDurFixed(f.inflight90);
    $('#inflight-p99').textContent = fmtDurFixed(f.inflight99);
    $('#inflight-total').textContent = fmt(inflightTotal);
    renderHistogramText();
  }

  window.addEventListener('resize', () => { geom = null; drawDistribution(); render(true); });
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { window.invalidateChartTheme(); buildRamp(); drawDistribution(); render(true); });
  }

  // ---------- boot ----------
  buildRamp();
  readControlsIntoSim();
  $('#speed-out').textContent = speedLabel(ticksPerSecond);
  render(true);
  setPlaying(true);
})();
