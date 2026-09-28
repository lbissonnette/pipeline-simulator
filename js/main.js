/* UI wiring, stage rendering (worker grid + flow particles), KPIs and charts. */
(function () {
  'use strict';
  const { Simulation, DEFAULTS, makeRng, sampleRate, expectedRate, expectedBundleTicks } = PipelineSim;

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

  const BASE = { waveAmplitude: 0, bundleSize: 10000, bundleMaxWait: 2, workers: 100, dispatcherCapacity: 10, routing: 'idle', heterogeneity: 0 };
  const NORMAL = { type: 'normal', mean: 0.2, sd: 0.05 };
  const PRESETS = {
    healthy:    Object.assign({}, BASE, { arrivalRate: 150000, dist: NORMAL }),
    overloaded: Object.assign({}, BASE, { arrivalRate: 220000, dist: NORMAL }),
    slowtail:   Object.assign({}, BASE, { arrivalRate: 150000, dist: { type: 'bimodal', mean: 0.2, sd: 0.04, slowFraction: 0.2, slowFactor: 0.25 } }),
    hotspots:   Object.assign({}, BASE, { arrivalRate: 140000, routing: 'sticky', heterogeneity: 0.4, dist: NORMAL }),
    bursty:     Object.assign({}, BASE, { arrivalRate: 150000, waveAmplitude: 0.6, dist: NORMAL }),
  };

  // ---------- controls ----------
  function fmtParam(name, v) {
    switch (name) {
      case 'waveAmplitude': case 'heterogeneity':
      case 'dist.mean': case 'dist.sd': case 'dist.slowFraction': case 'dist.slowFactor':
        return Math.round(v * 100) + '%';
      case 'arrivalRate': case 'bundleSize':
        return fmt(v);
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
    $('#arrival-bundles').textContent = (partial.arrivalRate / partial.bundleSize).toFixed(1).replace(/\.0$/, '');
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
    const ticks = expectedBundleTicks(sim.config.dist);
    const cap = (sim.workers.length * sim.config.bundleSize) / ticks;
    $('#bundle-ticks').textContent = ticks.toFixed(1);
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
  let NODE_R = 34;

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
    const gridX = sideW + pad, gridY = narrow ? 80 : pad;
    const gridW = W - sideW * 2 - pad * 2, gridH = H - gridY - pad;
    const gap = n > 200 ? 2 : 3;
    const cell = Math.floor(Math.min((gridW - gap * (cols - 1)) / cols, (gridH - gap * (rows - 1)) / rows));
    const usedW = cols * cell + (cols - 1) * gap, usedH = rows * cell + (rows - 1) * gap;
    const ox = gridX + (gridW - usedW) / 2, oy = gridY + (gridH - usedH) / 2;
    geom = {
      dpr, W, H, cols, rows, cell, gap, ox, oy, narrow, sideW,
      source: narrow ? { x: W * 0.14, y: 38 } : { x: sideW / 2, y: H * 0.15 },
      bundler: narrow ? { x: W * 0.38, y: 38 } : { x: sideW / 2, y: H * 0.5 },
      dispatcher: narrow ? { x: W * 0.62, y: 38 } : { x: sideW / 2, y: H * 0.85 },
      sink: narrow ? { x: W * 0.86, y: 38 } : { x: W - sideW / 2, y: H * 0.5 },
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
    const g = geom, R = NODE_R;
    const edge = (node, dir) => g.narrow
      ? { x: node.x + (dir === 'out' ? R : dir === 'in' ? -R : 0), y: node.y + (dir === 'down' ? R : 0) }
      : { x: node.x + (dir === 'out' ? R : dir === 'in' ? -R : 0), y: node.y + (dir === 'down' ? R : dir === 'up' ? -R : 0) };
    const sample = (list, max) => {
      const keep = Math.min(list.length, max), out = [];
      for (let i = 0; i < keep; i++) out.push(list[Math.floor((i / keep) * list.length)]);
      return out;
    };
    // bundler -> dispatcher
    for (const [i, e] of sample(events.filter(e => e.type === 'bundle'), 12).entries()) {
      const from = g.narrow ? edge(g.bundler, 'out') : edge(g.bundler, 'down');
      const to = g.narrow ? edge(g.dispatcher, 'in') : edge(g.dispatcher, 'up');
      particles.push({ x0: from.x, y0: from.y, x1: to.x, y1: to.y, t0: now + i * 12, dur: dur * 0.6, kind: 'in' });
    }
    // dispatcher -> worker
    for (const [i, e] of sample(events.filter(e => e.type === 'dispatch'), 24).entries()) {
      const to = cellCenter(e.worker);
      const from = g.narrow ? edge(g.dispatcher, 'down') : edge(g.dispatcher, 'out');
      particles.push({ x0: from.x, y0: from.y, x1: to.x, y1: to.y, t0: now + i * 8, dur, kind: 'in' });
    }
    // worker -> done
    for (const [i, e] of sample(events.filter(e => e.type === 'complete'), 24).entries()) {
      const from = cellCenter(e.worker);
      const to = g.narrow ? edge(g.sink, 'down') : edge(g.sink, 'in');
      particles.push({ x0: from.x, y0: from.y, x1: to.x, y1: to.y, t0: now + i * 10, dur, kind: 'out' });
    }
    // source -> bundler (a few dots per tick, scaled by arrivals)
    const arr = Math.min(6, Math.round(snap.arrivals / Math.max(1, sim.config.bundleSize)));
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

  function buildRamp() {
    ramp = cssVar('--ramp').split(',').map(s => s.trim());
  }

  function cellColor(w) {
    if (!w.bundle) return cssVar('--cell-idle');
    const age = sim.tick - w.bundle.dispatchedTick;
    const expected = expectedBundleTicks(sim.config.dist);
    const ratio = Math.min(1, age / (4 * expected)); // darkest at 4x the expected time
    return ramp[Math.round(ratio * (ramp.length - 1))];
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
    NODE_R = g.narrow ? 28 : 34;
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
      drawArrow(ctx, g.bundler.x, g.bundler.y + r, g.dispatcher.x, g.dispatcher.y - r);
      drawArrow(ctx, g.dispatcher.x + r, g.dispatcher.y, gridLeft - 6, gridMidY);
      drawArrow(ctx, gridRight + 6, gridMidY, g.sink.x - r, g.sink.y);
    } else {
      drawArrow(ctx, g.source.x + r, g.source.y, g.bundler.x - r, g.bundler.y);
      drawArrow(ctx, g.bundler.x + r, g.bundler.y, g.dispatcher.x - r, g.dispatcher.y);
      drawArrow(ctx, g.dispatcher.x + r, g.dispatcher.y, g.sink.x - r, g.sink.y);
    }
    const holding = snap.heldItems > 0;
    const full = snap.dispatcherQueued >= snap.dispatcherCapacity;
    drawNode(ctx, g.source.x, g.source.y, r, 'Source',
      holding ? [`holding ${fmt(snap.heldItems)}`, 'delayed'] : [`${fmt(snap.arrivals)} / tick`],
      holding ? cssVar('--surface-2') : surface);
    drawNode(ctx, g.bundler.x, g.bundler.y, r, 'Bundler',
      [`${fmt(snap.intakeItems)} held`, full ? 'blocked' : `${snap.cut} cut`],
      full && snap.intakeItems >= sim.config.bundleSize ? cssVar('--surface-2') : surface);
    drawNode(ctx, g.dispatcher.x, g.dispatcher.y, r, g.narrow ? 'Dispatch' : 'Dispatcher',
      [`${snap.dispatcherQueued} / ${snap.dispatcherCapacity} queued`, `${snap.dispatched} sent`],
      full ? cssVar('--surface-2') : surface);
    if (full) {
      ctx.beginPath(); ctx.arc(g.dispatcher.x, g.dispatcher.y, r + 2, 0, Math.PI * 2);
      ctx.lineWidth = 2; ctx.strokeStyle = cssVar('--critical'); ctx.stroke();
    }
    drawNode(ctx, g.sink.x, g.sink.y, r, 'Done', [`${fmt(sim.totals.processed)} total`, `${fmt(snap.processed)} / tick`], surface);

    // worker grid
    const offlineFill = cssVar('--cell-offline'), offlineInk = cssVar('--cell-offline-ink');
    const cell = g.cell, rad = Math.min(4, cell / 4);
    for (let i = 0; i < sim.workers.length; i++) {
      const w = sim.workers[i];
      const c = i % g.cols, rr = Math.floor(i / g.cols);
      const x = g.ox + c * (cell + g.gap), y = g.oy + rr * (cell + g.gap);
      const offline = w.offlineUntil >= sim.tick;
      ctx.beginPath(); roundRect(ctx, x, y, cell, cell, rad);
      ctx.fillStyle = offline ? offlineFill : cellColor(w);
      ctx.fill();
      if (offline) {
        ctx.save(); ctx.clip();
        ctx.strokeStyle = offlineInk; ctx.lineWidth = 1;
        for (let d = -cell; d < cell * 2; d += 5) {
          ctx.beginPath(); ctx.moveTo(x + d, y + cell); ctx.lineTo(x + d + cell, y); ctx.stroke();
        }
        ctx.restore();
      }
      if (w.bundle && cell >= 10) {
        const b = w.bundle;
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
    const b = w.bundle;
    tooltip.innerHTML = `<div class="tt-title">Worker ${idx + 1}${offline ? ' · offline' : b ? '' : ' · idle'}</div>` +
      (b ? `<div class="tt-row"><span>Current bundle</span><b>${Math.round(100 * (1 - b.remaining / b.size))}% done · ${fmt(b.remaining)} left</b></div>` +
           `<div class="tt-row"><span>Working for</span><b>${sim.tick - b.dispatchedTick}t · conversions aged ${sim.tick - b.createdTick}t</b></div>` : '') +
      `<div class="tt-row"><span>Last tick rate</span><b>${Math.round(w.lastRate * 100)}% of a bundle</b></div>` +
      `<div class="tt-row"><span>Speed factor</span><b>×${w.speed.toFixed(2)}</b></div>` +
      `<div class="tt-row"><span>Completed</span><b>${w.completed} bundles · ${fmt(w.processed)} conv.</b></div>`;
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
    dispatcher: new LineChart($('#chart-dispatcher'), {
      series: [{ key: 'dispatcherQueued', name: 'Bundles waiting', color: '--s1' }], fill: true,
      reference: { key: 'dispatcherCapacity', name: 'Capacity' },
    }),
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
      deltaEl.textContent = `${d > 0 ? '+' : d < 0 ? '−' : '±'}${fmt(Math.abs(d))} in 60 ticks`;
      deltaEl.className = 'delta ' + (d > 50 ? 'up' : d < -50 ? 'down' : '');
    }
    $('#kpi-oldest').textContent = fmt(snap.oldestAge);
    const recent = h.slice(-20);
    const avg = k => recent.length ? recent.reduce((s, r) => s + (r[k] || 0), 0) / recent.length : 0;
    const p95s = recent.map(r => r.latencyP95).filter(v => v !== null), p50s = recent.map(r => r.latencyP50).filter(v => v !== null);
    const mx = a => a.length ? Math.max(...a) : null;
    const med = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    $('#kpi-p95').textContent = p95s.length ? fmt(mx(p95s)) + 't' : '–';
    $('#kpi-p50').textContent = p50s.length ? `p50 ${fmt(med(p50s))}t · 20-tick window` : 'nothing completed yet';
    $('#kpi-in').textContent = fmt(avg('arrivals'));
    $('#kpi-out').textContent = fmt(avg('processed'));
    $('#kpi-busy').textContent = Math.round(snap.utilization * 100) + '%';
    const dq = $('#kpi-dispatcher');
    dq.textContent = `${snap.dispatcherQueued} / ${snap.dispatcherCapacity}`;
    dq.classList.toggle('warn', snap.dispatcherQueued >= snap.dispatcherCapacity);
    $('#kpi-upstream').textContent = snap.heldItems > 0
      ? `${fmt(snap.intakeItems)} at bundler · ${fmt(snap.heldItems)} upstream`
      : `${fmt(snap.intakeItems)} waiting at bundler`;
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
