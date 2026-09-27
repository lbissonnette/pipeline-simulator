/* UI wiring, stage rendering (worker grid + flow particles), KPIs and charts. */
(function () {
  'use strict';
  const { Simulation, DEFAULTS, makeRng, sampleRate, expectedRate, queuedItems } = PipelineSim;

  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const fmt = window.fmtNumber;

  // ---------- state ----------
  const sim = new Simulation({ seed: 42 });
  let playing = false;
  let ticksPerSecond = 12;
  let accumulator = 0;
  let lastFrame = 0;
  let particles = [];
  let ramp = [];
  let hoveredWorker = null;

  const PRESETS = {
    healthy:    { arrivalRate: 400, waveAmplitude: 0, bundleSize: 25, workers: 100, routing: 'leastLoaded', heterogeneity: 0, dist: { type: 'normal', mean: 0.2, sd: 0.05 } },
    overloaded: { arrivalRate: 600, waveAmplitude: 0, bundleSize: 25, workers: 100, routing: 'leastLoaded', heterogeneity: 0, dist: { type: 'normal', mean: 0.2, sd: 0.05 } },
    slowtail:   { arrivalRate: 400, waveAmplitude: 0, bundleSize: 25, workers: 100, routing: 'leastLoaded', heterogeneity: 0, dist: { type: 'bimodal', mean: 0.2, sd: 0.04, slowFraction: 0.2, slowFactor: 0.25 } },
    hotspots:   { arrivalRate: 380, waveAmplitude: 0, bundleSize: 25, workers: 100, routing: 'random', heterogeneity: 0.4, dist: { type: 'normal', mean: 0.2, sd: 0.05 } },
    bursty:     { arrivalRate: 400, waveAmplitude: 0.6, bundleSize: 25, workers: 100, routing: 'leastLoaded', heterogeneity: 0, dist: { type: 'normal', mean: 0.2, sd: 0.05 } },
  };

  // ---------- controls ----------
  function fmtParam(name, v) {
    switch (name) {
      case 'waveAmplitude': case 'heterogeneity':
      case 'dist.mean': case 'dist.sd': case 'dist.slowFraction': case 'dist.slowFactor':
        return Math.round(v * 100) + '%';
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
    $('.bimodal-only').hidden = dist.type !== 'bimodal';
    drawDistribution();
    updateCapacity();
  }

  function applyToControls(cfg) {
    for (const el of $$('[data-param]')) {
      if (cfg[el.dataset.param] !== undefined) el.value = cfg[el.dataset.param];
    }
    if (cfg.dist) {
      for (const el of $$('[data-dist]')) {
        if (cfg.dist[el.dataset.dist] !== undefined) el.value = cfg.dist[el.dataset.dist];
      }
    }
    readControlsIntoSim();
  }

  $$('[data-param], [data-dist]').forEach(el => el.addEventListener('input', () => {
    $$('.chip.active').forEach(c => c.classList.remove('active'));
    readControlsIntoSim();
  }));

  $$('[data-preset]').forEach(btn => btn.addEventListener('click', () => {
    applyToControls(PRESETS[btn.dataset.preset]);
    $$('.chip.active').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
  }));

  $$('[data-incident]').forEach(btn => btn.addEventListener('click', () => {
    const type = btn.dataset.incident;
    const num = id => parseFloat($(id).value);
    if (type === 'spike') sim.addIncident('spike', num('#spike-mag'), num('#spike-dur'));
    else if (type === 'slowdown') sim.addIncident('slowdown', num('#slow-mag'), num('#slow-dur'));
    else if (type === 'outage') sim.addIncident('outage', num('#outage-mag') / 100, num('#outage-dur'));
    else if (type === 'upstreamDelay') sim.addIncident('upstreamDelay', 1, num('#delay-dur'));
    renderIncidents();
    if (!playing) render();
  }));

  const INCIDENT_LABEL = {
    spike: i => `Traffic spike ×${i.magnitude}`,
    slowdown: i => `Slow workers ×${i.magnitude}`,
    outage: i => `Outage: ${i.workers.length} workers offline`,
    upstreamDelay: () => 'Upstream delay (holding arrivals)',
  };

  function renderIncidents() {
    const ul = $('#active-incidents');
    ul.innerHTML = '';
    for (const inc of sim.incidents) {
      const li = document.createElement('li');
      const left = Math.max(0, inc.end - sim.tick);
      const pct = 100 * (1 - left / inc.duration);
      li.innerHTML = `<span>${INCIDENT_LABEL[inc.type](inc)}</span><span class="bar"><i style="width:${pct}%"></i></span><span>${left}t</span><button title="Cancel" aria-label="Cancel incident">×</button>`;
      li.querySelector('button').addEventListener('click', () => { sim.cancelIncident(inc.id); renderIncidents(); if (!playing) render(); });
      ul.appendChild(li);
    }
  }

  // transport
  const playBtn = $('#btn-play');
  function setPlaying(p) {
    playing = p;
    playBtn.textContent = p ? '❚❚ Pause' : '▶ Play';
    playBtn.setAttribute('aria-pressed', String(p));
    if (p) { lastFrame = performance.now(); requestAnimationFrame(frame); }
  }
  playBtn.addEventListener('click', () => setPlaying(!playing));
  $('#btn-step').addEventListener('click', () => { doTick(); render(); });
  $('#btn-reset').addEventListener('click', () => {
    sim.reset(parseInt($('#seed').value, 10) || 0);
    particles = [];
    for (const c of Object.values(charts)) c.hoverIndex = null;
    renderIncidents();
    render();
  });
  $('#speed').addEventListener('input', e => {
    ticksPerSecond = parseInt(e.target.value, 10);
    $('#speed-out').textContent = ticksPerSecond + ' ticks/s';
  });
  document.addEventListener('keydown', e => {
    if (e.target.matches('input, select, textarea')) return;
    if (e.code === 'Space') { e.preventDefault(); setPlaying(!playing); }
    if (e.key === 's' || e.key === 'ArrowRight') { doTick(); render(); }
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
    const bins = 40, counts = new Array(bins).fill(0);
    const rng = makeRng(2024), n = 6000;
    for (let i = 0; i < n; i++) {
      const r = sampleRate(rng, sim.config.dist);
      counts[Math.min(bins - 1, Math.floor(r * bins))]++;
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
    // mean marker
    const m = expectedRate(sim.config.dist);
    ctx.strokeStyle = cssVar('--text-2'); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(Math.round(m * W) + 0.5, 0); ctx.lineTo(Math.round(m * W) + 0.5, H); ctx.stroke();
    ctx.fillStyle = cssVar('--text-2'); ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = m > 0.5 ? 'right' : 'left';
    ctx.fillText(`mean ${Math.round(m * 100)}%`, m * W + (m > 0.5 ? -4 : 4), 10);
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

  function updateCapacity() {
    const cap = sim.workers.length * expectedRate(sim.config.dist) * sim.config.bundleSize;
    $('#capacity').textContent = fmt(cap);
    const rho = sim.config.arrivalRate / Math.max(1e-9, cap);
    const rhoEl = $('#rho');
    rhoEl.textContent = rho.toFixed(2);
    rhoEl.style.color = rho >= 1 ? cssVar('--critical') : '';
    $('#kpi-cap').textContent = `of ${fmt(cap)} capacity`;
  }

  // ---------- simulation loop ----------
  function doTick() {
    const snap = sim.step();
    spawnParticles(sim.events, snap);
    if (sim.tick % 5 === 0 || sim.incidents.length) renderIncidents();
    return snap;
  }

  function frame(now) {
    if (!playing) return;
    const dt = Math.min(0.25, (now - lastFrame) / 1000);
    lastFrame = now;
    accumulator += dt * ticksPerSecond;
    let n = Math.floor(accumulator);
    accumulator -= n;
    if (n > 20) n = 20; // don't stall the frame on a slow machine
    for (let i = 0; i < n; i++) doTick();
    render();
    requestAnimationFrame(frame);
  }

  // ---------- stage ----------
  const stage = $('#stage');
  const sctx = stage.getContext('2d');
  const tooltip = $('#stage-tooltip');
  let geom = null;
  const NODE_R = 34;

  function computeGeometry() {
    const dpr = window.devicePixelRatio || 1;
    const rect = stage.getBoundingClientRect();
    const W = rect.width, H = rect.height;
    if (stage.width !== Math.round(W * dpr) || stage.height !== Math.round(H * dpr)) {
      stage.width = Math.round(W * dpr); stage.height = Math.round(H * dpr);
    }
    const n = sim.workers.length;
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const narrow = W < 640;
    const sideW = narrow ? 0 : 150;
    const pad = 12;
    const gridX = sideW + pad, gridY = narrow ? 84 : pad;
    const gridW = W - sideW * 2 - pad * 2, gridH = H - gridY - pad;
    const gap = n > 200 ? 2 : 3;
    const cell = Math.floor(Math.min((gridW - gap * (cols - 1)) / cols, (gridH - gap * (rows - 1)) / rows));
    const usedW = cols * cell + (cols - 1) * gap, usedH = rows * cell + (rows - 1) * gap;
    const ox = gridX + (gridW - usedW) / 2, oy = gridY + (gridH - usedH) / 2;
    geom = {
      dpr, W, H, cols, rows, cell, gap, ox, oy, narrow, sideW,
      source: narrow ? { x: W * 0.18, y: 40 } : { x: sideW / 2, y: H * 0.22 },
      bundler: narrow ? { x: W * 0.5, y: 40 } : { x: sideW / 2, y: H * 0.62 },
      sink: narrow ? { x: W * 0.82, y: 40 } : { x: W - sideW / 2, y: H * 0.5 },
    };
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
    const dur = Math.max(160, Math.min(600, 900 / Math.max(1, ticksPerSecond / 6)));
    // dispatches: sample so the stage stays legible at high rates
    const dispatches = events.filter(e => e.type === 'dispatch');
    const keep = Math.min(dispatches.length, 24);
    for (let i = 0; i < keep; i++) {
      const e = dispatches[Math.floor((i / keep) * dispatches.length)];
      const to = cellCenter(e.worker);
      const from = geom.narrow ? { x: geom.bundler.x, y: geom.bundler.y + NODE_R } : { x: geom.bundler.x + NODE_R, y: geom.bundler.y };
      particles.push({ x0: from.x, y0: from.y, x1: to.x, y1: to.y, t0: now, dur, kind: 'in' });
    }
    // completions: one particle per completed bundle, from a random busy worker (approximation for the eye)
    const done = Math.min(snap.completedBundles, 16);
    for (let i = 0; i < done; i++) {
      const w = sim.workers[Math.floor(Math.random() * sim.workers.length)];
      const from = cellCenter(w.id);
      const to = geom.narrow ? { x: geom.sink.x, y: geom.sink.y + NODE_R } : { x: geom.sink.x - NODE_R, y: geom.sink.y };
      particles.push({ x0: from.x, y0: from.y, x1: to.x, y1: to.y, t0: now + i * 15, dur, kind: 'out' });
    }
    // arrivals: a few dots from source to bundler
    const arr = Math.min(6, Math.round(snap.arrivals / Math.max(1, sim.config.bundleSize)));
    for (let i = 0; i < arr; i++) {
      const s = geom.source, b = geom.bundler;
      let from, to;
      if (snap.heldItems > 0) {
        from = { x: s.x, y: s.y - NODE_R - 26 }; to = { x: s.x, y: s.y - NODE_R };
      } else if (geom.narrow) {
        from = { x: s.x + NODE_R, y: s.y }; to = { x: b.x - NODE_R, y: b.y };
      } else {
        from = { x: s.x, y: s.y + NODE_R }; to = { x: b.x, y: b.y - NODE_R };
      }
      particles.push({ x0: from.x, y0: from.y, x1: to.x, y1: to.y, t0: now + i * 20, dur: dur * 0.8, kind: 'arr' });
    }
    if (particles.length > 600) particles.splice(0, particles.length - 600);
  }

  function buildRamp() {
    ramp = cssVar('--ramp').split(',').map(s => s.trim());
  }

  function cellColor(items) {
    if (items <= 0) return cssVar('--cell-idle');
    const d = items / sim.config.bundleSize; // depth in bundles
    const idx = Math.min(ramp.length - 1, Math.round((Math.log2(1 + d) / Math.log2(33)) * (ramp.length - 1)));
    return ramp[Math.max(0, idx)];
  }

  function drawNode(ctx, x, y, r, title, lines, fillColor) {
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = fillColor; ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = cssVar('--border'); ctx.stroke();
    ctx.fillStyle = cssVar('--text'); ctx.font = '600 12px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(title, x, y - (lines.length ? 8 : 0));
    ctx.font = '11px system-ui, sans-serif'; ctx.fillStyle = cssVar('--text-2');
    lines.forEach((l, i) => ctx.fillText(l, x, y + 7 + i * 13));
  }

  function drawArrow(ctx, x0, y0, x1, y1) {
    ctx.strokeStyle = cssVar('--axis'); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    const a = Math.atan2(y1 - y0, x1 - x0);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - 7 * Math.cos(a - 0.4), y1 - 7 * Math.sin(a - 0.4));
    ctx.lineTo(x1 - 7 * Math.cos(a + 0.4), y1 - 7 * Math.sin(a + 0.4));
    ctx.closePath(); ctx.fillStyle = cssVar('--axis'); ctx.fill();
  }

  function drawStage() {
    const g = computeGeometry();
    const ctx = sctx;
    ctx.setTransform(g.dpr, 0, 0, g.dpr, 0, 0);
    ctx.clearRect(0, 0, g.W, g.H);
    const snap = sim.last;
    const surface = cssVar('--surface');

    // nodes + connectors
    const gridLeft = g.ox, gridRight = g.ox + g.cols * (g.cell + g.gap) - g.gap;
    const gridMidY = g.oy + (g.rows * (g.cell + g.gap) - g.gap) / 2;
    const r = NODE_R;
    if (!g.narrow) {
      drawArrow(ctx, g.source.x, g.source.y + r, g.bundler.x, g.bundler.y - r);
      drawArrow(ctx, g.bundler.x + r, g.bundler.y, gridLeft - 6, gridMidY);
      drawArrow(ctx, gridRight + 6, gridMidY, g.sink.x - r, g.sink.y);
    } else {
      drawArrow(ctx, g.source.x + r, g.source.y, g.bundler.x - r, g.bundler.y);
      drawArrow(ctx, g.bundler.x + r, g.bundler.y, g.sink.x - r, g.sink.y);
    }
    const holding = snap.heldItems > 0;
    drawNode(ctx, g.source.x, g.source.y, r, 'Source',
      holding ? [`holding ${fmt(snap.heldItems)}`, 'delayed'] : [`${fmt(snap.arrivals)} / tick`],
      holding ? cssVar('--surface-2') : surface);
    drawNode(ctx, g.bundler.x, g.bundler.y, r, 'Bundler', [`${fmt(snap.intakeItems)} buffered`, `${snap.dispatched} sent`], surface);
    drawNode(ctx, g.sink.x, g.sink.y, r, 'Done', [`${fmt(sim.totals.processed)} total`, `${fmt(snap.processed)} / tick`], surface);

    // worker grid
    const offlineFill = cssVar('--cell-offline'), offlineInk = cssVar('--cell-offline-ink');
    const cell = g.cell, rad = Math.min(4, cell / 4);
    for (let i = 0; i < sim.workers.length; i++) {
      const w = sim.workers[i];
      const c = i % g.cols, rr = Math.floor(i / g.cols);
      const x = g.ox + c * (cell + g.gap), y = g.oy + rr * (cell + g.gap);
      const offline = w.offlineUntil >= sim.tick;
      const items = queuedItems(w);
      ctx.beginPath(); roundRect(ctx, x, y, cell, cell, rad);
      ctx.fillStyle = offline ? offlineFill : cellColor(items);
      ctx.fill();
      if (offline) {
        ctx.save(); ctx.clip();
        ctx.strokeStyle = offlineInk; ctx.lineWidth = 1;
        for (let d = -cell; d < cell * 2; d += 5) {
          ctx.beginPath(); ctx.moveTo(x + d, y + cell); ctx.lineTo(x + d + cell, y); ctx.stroke();
        }
        ctx.restore();
      } else if (w.queue.length && cell >= 10) {
        const b = w.queue[0];
        const p = 1 - b.remaining / b.size;
        const bh = Math.max(2, Math.round(cell * 0.14));
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillRect(x + 2, y + cell - bh - 2, Math.round((cell - 4) * p), bh);
      }
      if (hoveredWorker === i) {
        ctx.lineWidth = 2; ctx.strokeStyle = cssVar('--text');
        ctx.beginPath(); roundRect(ctx, x + 1, y + 1, cell - 2, cell - 2, rad); ctx.stroke();
      }
    }

    // particles
    const now = performance.now();
    const alive = [];
    const colIn = cssVar('--s1'), colOut = cssVar('--s2');
    for (const p of particles) {
      const u = (now - p.t0) / p.dur;
      if (u >= 1) continue;
      alive.push(p);
      if (u < 0) continue;
      const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
      const x = p.x0 + (p.x1 - p.x0) * e, y = p.y0 + (p.y1 - p.y0) * e;
      ctx.beginPath(); ctx.arc(x, y, p.kind === 'arr' ? 2.5 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = surface; ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, p.kind === 'arr' ? 1.5 : 2.5, 0, Math.PI * 2);
      ctx.fillStyle = p.kind === 'out' ? colOut : colIn; ctx.fill();
    }
    particles = alive;
  }

  function roundRect(ctx, x, y, w, h, r) {
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
    const items = queuedItems(w);
    const head = w.queue[0];
    tooltip.innerHTML = `<div class="tt-title">Worker ${idx + 1}${offline ? ' · offline' : ''}</div>` +
      `<div class="tt-row"><span>Queued</span><b>${w.queue.length} bundles · ${fmt(items)} conv.</b></div>` +
      (head ? `<div class="tt-row"><span>Current bundle</span><b>${Math.round(100 * (1 - head.remaining / head.size))}% done · age ${sim.tick - head.createdTick}t</b></div>` : '') +
      `<div class="tt-row"><span>Last tick rate</span><b>${Math.round(w.lastRate * 100)}% of a bundle</b></div>` +
      `<div class="tt-row"><span>Speed factor</span><b>×${w.speed.toFixed(2)}</b></div>` +
      `<div class="tt-row"><span>Processed</span><b>${fmt(w.processed)}</b></div>`;
    tooltip.hidden = false;
    const tw = tooltip.offsetWidth;
    tooltip.style.left = (x + 16 + tw > rect.width ? x - tw - 12 : x + 16) + 'px';
    tooltip.style.top = Math.max(0, y - 10) + 'px';
  });
  stage.addEventListener('pointerleave', () => { hoveredWorker = null; tooltip.hidden = true; if (!playing) drawStage(); });

  // ---------- charts ----------
  const charts = {
    backlog: new LineChart($('#chart-backlog'), { series: [{ key: 'backlogItems', name: 'Backlog', color: '--s1' }], fill: true }),
    throughput: new LineChart($('#chart-throughput'), {
      series: [{ key: 'arrivals', name: 'Arrivals', color: '--s1' }, { key: 'processed', name: 'Throughput', color: '--s2' }],
      reference: { key: 'nominalCapacity', name: 'Expected capacity' },
    }),
    latency: new LineChart($('#chart-latency'), { series: [{ key: 'latencyP50', name: 'p50', color: '--s1' }, { key: 'latencyP95', name: 'p95', color: '--s2' }] }),
    util: new LineChart($('#chart-util'), { series: [{ key: 'utilPct', name: 'Busy share', color: '--s1' }], fill: true }),
  };

  // Smooth the noisy per-tick series with a short moving average for display.
  function smoothed(history) {
    const out = new Array(history.length);
    const win = 5;
    let sa = 0, sp = 0, q = [];
    for (let i = 0; i < history.length; i++) {
      const h = history[i];
      q.push(h); sa += h.arrivals; sp += h.processed;
      if (q.length > win) { const d = q.shift(); sa -= d.arrivals; sp -= d.processed; }
      out[i] = Object.assign({}, h, { arrivals: sa / q.length, processed: sp / q.length, utilPct: h.utilization * 100 });
    }
    return out;
  }

  // ---------- KPIs ----------
  function updateKpis() {
    const h = sim.history, snap = sim.last;
    $('#tick').textContent = sim.tick;
    $('#kpi-backlog').textContent = fmt(snap.backlogItems);
    const ago = h.length > 60 ? h[h.length - 61].backlogItems : (h[0] ? h[0].backlogItems : 0);
    const d = snap.backlogItems - ago;
    const deltaEl = $('#kpi-backlog-delta');
    if (h.length < 5) { deltaEl.textContent = 'conversions waiting'; deltaEl.className = 'delta'; }
    else {
      deltaEl.textContent = `${d > 0 ? '+' : d < 0 ? '−' : '±'}${fmt(Math.abs(d))} vs 60 ticks ago`;
      deltaEl.className = 'delta ' + (d > 50 ? 'up' : d < -50 ? 'down' : '');
    }
    $('#kpi-oldest').textContent = fmt(snap.oldestAge);
    const recent = h.slice(-20);
    const avg = k => recent.length ? recent.reduce((s, r) => s + (r[k] || 0), 0) / recent.length : 0;
    const p95s = recent.map(r => r.latencyP95).filter(v => v !== null), p50s = recent.map(r => r.latencyP50).filter(v => v !== null);
    const mx = a => a.length ? Math.max(...a) : null;
    const med = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    $('#kpi-p95').textContent = p95s.length ? fmt(mx(p95s)) + 't' : '–';
    $('#kpi-p50').textContent = p50s.length ? `p50 ${fmt(med(p50s))}t · last 20 ticks` : 'no bundles completed yet';
    $('#kpi-in').textContent = fmt(avg('arrivals'));
    $('#kpi-out').textContent = fmt(avg('processed'));
    $('#kpi-busy').textContent = Math.round(snap.utilization * 100) + '%';
    $('#kpi-workers').textContent = `${snap.idle} idle · ${snap.offline} offline`;
  }

  // ---------- render ----------
  function render() {
    drawStage();
    updateKpis();
    const data = smoothed(sim.history);
    for (const c of Object.values(charts)) { c.setData(data); c.draw(); }
  }

  window.addEventListener('resize', () => { drawDistribution(); render(); });
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { buildRamp(); drawDistribution(); render(); });
  }

  // ---------- boot ----------
  buildRamp();
  readControlsIntoSim();
  $('.chip[data-preset="healthy"]').classList.add('active');
  // warm up so the page opens on a live system rather than an empty grid
  for (let i = 0; i < 40; i++) sim.step();
  render();
  setPlaying(true);
})();
