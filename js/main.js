/* UI wiring, stage rendering (worker grid + flow particles), KPIs and charts. */
(function () {
  'use strict';
  const { Simulation, DEFAULTS, COHORT_TICKS, makeRng, sampleRate, expectedRate, expectedBundleTicks } = PipelineSim;

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
      case 'arrivalRate': case 'bundleSize': case 'workers': case 'dispatcherCapacity': case 'writerCapacity':
        return fmtInt(v);
      case 'writeRate':
        return fmtInt(v) + ' / tick';
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
    $('#write-rate-s').textContent = fmtInt(partial.writeRate / TICK_SECONDS);
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
        const scen = scenarioIncidents.get(inc.id);
        li.innerHTML = `<span>${scen ? `<b>${scen}</b> · ` : ''}${INCIDENT_LABEL[inc.type](inc)}</span><span class="bar"><i></i></span><span class="num"></span><button title="Cancel" aria-label="Cancel incident">×</button>`;
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

  // ---------- predefined outages ----------
  // Each scenario fires one incident and opens an explanation box above the
  // KPIs: what was injected, what to watch for, why, and live readouts of the
  // metrics the story is about (with their values when it started). Closing
  // the box leaves the incident running; its button ends the incident early.
  const SCENARIOS = {
    stuck: {
      name: 'Stuck workers',
      incident: { type: 'degrade', magnitude: { factor: 0, fraction: 0.003, selection: 'lowest' }, hours: 999 },
      endLabel: 'Unstick the workers',
      setup: c => `<b>${fmtInt(c.affected)}</b> of the ${fmtInt(c.pool)} workers (0.3%, the lowest by index) freeze for <b>999 hours</b>. Each keeps the bundle it was working on, and the dispatcher routes new work around them. <b>Impact is low</b>: only the bundles they were holding are held back, a small amount of data loss until the workers come back.`,
      watch: c => [
        '<b>P99 fresh time climbs by an hour every hour</b>, indefinitely, until the outage clears. P50 and P90 fresh time don’t move.',
        '<b>P99 in-flight age stays under an hour</b>, although the held data is getting older by the hour too.',
        `<b>Backlog, throughput and processed age look normal.</b> The other ${fmtInt(c.pool - c.affected)} workers take the load without noticing.`,
        '<b>Unstick the workers</b> (the button below, or × on the incident). The held bundles are written out hours late, and P99 fresh time falls back at once.',
        '<b>The P99 processed-age graph usually misses even that.</b> A few late bundles are far less than 1% of the bundles written in an hour, so P99 processed age barely moves. Only the tail of the processing-time histogram shows them.',
      ],
      whyTitle: 'Why does P99 fresh time increase while P99 in-flight age doesn’t?',
      why: 'The two P99s are taken over different populations. P99 fresh time judges each 5-minute window of arrivals on its own: a window passes once 99% of the conversions that arrived in it are written out, and the P99 fresh time is the age of the oldest window that hasn’t. The held bundles all come from a few arrival minutes, so when they add up to more than 1% of one window’s arrivals, that window can never pass, and its age grows by an hour every hour. P99 in-flight age pools every conversion not yet written, from every arrival minute, and asks how old the oldest 1% of them are. The held conversions are a few thousand out of hundreds of thousands in flight at any moment, well under 1%, so the 99th percentile still lands on ordinary data that arrived less than an hour ago. The held data sits in the in-flight tail, beyond the 99% mark. Fresh time counts the missing data as a share of its own window, where it is concentrated; in-flight age counts it as a share of everything in flight, where it is diluted.',
      note: 'Your simulation may vary. One stuck bundle is under 1% of a 5-minute window of arrivals, so P99 climbs only when two of them arrived close together, which happens in most runs. If P99 fresh time stays flat, Reset and run it again, or try another seed.',
      live: [
        { label: 'P99 fresh time', row: 'fresh99Hr' },
        { label: 'P99 in-flight age', row: 'inflight99Hr' },
        { label: 'P90 fresh time', row: 'fresh90Hr' },
        { label: 'P99 processed age', row: 'latP99Hr' },
        { label: 'Conversions held', snap: 'degradedStuckItems' },
      ],
    },
    slowTenth: {
      name: 'Slow tenth',
      incident: { type: 'degrade', magnitude: { factor: 0.1, fraction: 0.1, selection: 'random' }, hours: 48 },
      endLabel: 'End the outage now',
      setup: c => `<b>${fmtInt(c.affected)}</b> of the ${fmtInt(c.pool)} workers (10%, chosen at random) drop to <b>10% of their normal speed</b> for <b>48 hours</b>. They keep taking work, so every bundle they pick up takes about ten times as long: roughly four hours instead of 23 minutes.`,
      watch: () => [
        '<b>First two to three hours: P90 fresh time climbs steadily.</b> About a tenth of every 5-minute window of arrivals is sitting on a slow worker, so no window since the outage began can reach 90% complete.',
        '<b>P90 processed age doesn’t move.</b> Well under a tenth of the bundles written each hour come from the slow workers, so the 90th percentile never reaches them.',
        '<b>A few hours in, P90 fresh time drops back to normal</b>, but the outage hasn’t changed at all. The same workers are exactly as slow.',
        '<b>P99 fresh time and P99 processed age</b> still show it. They sit at about the slow bundle time (three to five hours) for the rest of the 48 hours.',
      ],
      why: 'At the start the slow workers still get their usual share of the work, about 10% of every window. Once each of them holds a bundle that will take hours, it takes new work only every few hours, and first-fit routing sends everything else to the fast workers. From then on only about 2% of each window lands on a slow worker. That is too little for P90 to see but well over the 1% that P99 notices. The P90 drop means the slow workers have fallen out of the rotation. It isn’t a recovery.',
      note: 'Your simulation may vary. The timings are for the default settings; other settings change the numbers, and sometimes the story.',
      live: [
        { label: 'P90 fresh time', row: 'fresh90Hr' },
        { label: 'P90 processed age', row: 'latP90Hr' },
        { label: 'P99 fresh time', row: 'fresh99Hr' },
        { label: 'P99 processed age', row: 'latP99Hr' },
      ],
    },
  };
  const scenarioIncidents = new Map(); // incident id -> scenario name, for the incident list
  let activeScenario = null;           // { def, inc, startTick, baseline, peak, scanned }
  let lastRows = [];

  // Settings the scenario texts assume; any change is worth a heads-up.
  const SCENARIO_KEYS = ['workers', 'arrivalRate', 'waveAmplitude', 'bundleSize', 'bundleMaxWait', 'dispatcherCapacity', 'writeRate', 'writerCapacity', 'writerIntake', 'routing', 'dist', 'expensiveFraction', 'expensiveCost', 'expensiveCostSd'];
  function changedSettings() {
    return SCENARIO_KEYS.filter(k => JSON.stringify(sim.config[k]) !== JSON.stringify(DEFAULTS[k]));
  }

  function liveRaw(item) {
    if (item.snap) return sim.last[item.snap] || 0;
    const last = lastRows[lastRows.length - 1];
    const v = last ? last[item.row] : null;
    return v === undefined ? null : v;
  }
  const fmtLive = (item, v) => (v === null ? '–' : item.snap ? fmt(v) : fmtDurFixed(v * TICKS_PER_HOUR));

  function runScenario(key) {
    const def = SCENARIOS[key];
    const { type, magnitude, hours } = def.incident;
    const inc = sim.addIncident(type, magnitude, Math.round(hours * TICKS_PER_HOUR));
    scenarioIncidents.set(inc.id, def.name);
    activeScenario = { def, inc, startTick: sim.tick, baseline: def.live.map(liveRaw), peak: def.live.map(() => null), scanned: sim.tick };
    const ctx = { affected: inc.workers.length, pool: sim.workers.length };
    $('#sc-title').textContent = def.name;
    $('#sc-setup').innerHTML = def.setup(ctx);
    $('#sc-watch').innerHTML = def.watch(ctx).map(t => `<li>${t}</li>`).join('');
    $('#sc-why-title').textContent = def.whyTitle || 'Why';
    $('#sc-why').textContent = def.why;
    const changed = changedSettings();
    $('#sc-note').textContent = def.note + (changed.length
      ? ` Some settings differ from the defaults (${changed.join(', ')}), so expect different numbers.`
      : '');
    $('#sc-live').innerHTML = def.live.map(() => '<div class="sc-stat"><div class="k"></div><div class="v"></div><div class="d"></div></div>').join('');
    $('#sc-end').textContent = def.endLabel;
    const box = $('#scenario-box');
    box.hidden = false;
    renderScenario();
    box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function renderScenario() {
    if (!activeScenario || $('#scenario-box').hidden) return;
    const { def, inc, startTick, baseline, peak } = activeScenario;
    // peaks since the scenario started, from every chart row not yet scanned
    // (row-based values) or the current snapshot (the rest)
    for (const r of lastRows) {
      if (r.tick <= activeScenario.scanned) continue;
      def.live.forEach((item, i) => {
        const v = item.row ? r[item.row] : null;
        if (v !== null && v !== undefined && (peak[i] === null || v > peak[i])) peak[i] = v;
      });
    }
    if (lastRows.length) activeScenario.scanned = lastRows[lastRows.length - 1].tick;
    def.live.forEach((item, i) => {
      if (!item.snap) return;
      const v = liveRaw(item);
      if (peak[i] === null || v > peak[i]) peak[i] = v;
    });
    const running = sim.incidents.some(i => i.id === inc.id);
    const entry = sim.incidentLog.find(e => e.id === inc.id);
    const status = $('#sc-status');
    if (running) {
      status.textContent = `Running · ${fmtDurFixed(sim.tick - startTick)} in · ${fmtDurFixed(Math.max(0, inc.end - sim.tick))} left`;
      status.classList.remove('done');
    } else {
      const lasted = entry && entry.end !== null ? entry.end - startTick : sim.tick - startTick;
      status.textContent = `${entry && entry.cancelled ? 'Ended by hand' : 'Ended'} after ${fmtDurFixed(lasted)}`;
      status.classList.add('done');
    }
    $('#sc-end').hidden = !running;
    const stats = $$('#sc-live .sc-stat');
    def.live.forEach((item, i) => {
      const el = stats[i];
      if (!el) return;
      el.querySelector('.k').textContent = item.label;
      el.querySelector('.v').textContent = fmtLive(item, liveRaw(item));
      el.querySelector('.d').textContent = `at start ${fmtLive(item, baseline[i])} · peak ${fmtLive(item, peak[i])}`;
    });
  }

  function closeScenario() {
    $('#scenario-box').hidden = true;
    activeScenario = null;
  }

  $$('[data-scenario]').forEach(btn => btn.addEventListener('click', () => {
    runScenario(btn.dataset.scenario);
    renderIncidents();
    if (!playing) render(true);
  }));
  $('#sc-close').addEventListener('click', closeScenario);
  $('#sc-end').addEventListener('click', () => {
    if (!activeScenario) return;
    sim.cancelIncident(activeScenario.inc.id);
    renderIncidents();
    render(true);
  });

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
    closeScenario();
    scenarioIncidents.clear();
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
    const workerCap = (sim.workers.length * sim.config.bundleSize) / ticks;
    const cap = Math.min(workerCap, sim.config.writeRate);
    $('#bundle-ticks').textContent = fmtDur(ticks);
    $('#capacity').textContent = fmtInt(cap) + (cap < workerCap ? ' (writer-bound)' : '');
    const rho = sim.config.arrivalRate / Math.max(1e-9, cap);
    const rhoEl = $('#rho');
    rhoEl.textContent = rho.toFixed(2);
    rhoEl.style.color = rho >= 1 ? cssVar('--critical') : '';
    $('#kpi-cap').textContent = `written per tick · of ${fmtInt(cap)} capacity`;
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
  let NODE_R = 42;   // horizontal half-size of a node
  let NODE_RY = 42;  // vertical half-size (narrow screens use wide pills)

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
      source: narrow ? { x: W * 0.1, y: 38 } : { x: sideW / 2, y: H * 0.15 },
      bundler: narrow ? { x: W * 0.3, y: 38 } : { x: sideW / 2, y: H * 0.5 },
      dispatcher: narrow ? { x: W * 0.5, y: 38 } : { x: sideW / 2, y: H * 0.85 },
      writer: narrow ? { x: W * 0.7, y: 38 } : { x: W - sideW / 2, y: H * 0.3 },
      sink: narrow ? { x: W * 0.9, y: 38 } : { x: W - sideW / 2, y: H * 0.7 },
    };
    NODE_R = narrow ? 33 : 42;
    NODE_RY = narrow ? 20 : 42;
    return geom;
  }

  function cellCenter(i) {
    const g = geom;
    const c = i % g.cols, r = Math.floor(i / g.cols);
    return { x: g.ox + c * (g.cell + g.gap) + g.cell / 2, y: g.oy + r * (g.cell + g.gap) + g.cell / 2 };
  }

  // Endpoints of the arrow from the worker pool to Done.
  // pool -> writer arrow (finished bundles), and writer -> Done arrow (written data)
  function poolToWriter(g) {
    const R = NODE_R;
    if (g.narrow) return { from: { x: g.writer.x, y: g.oy - 6 }, to: { x: g.writer.x, y: g.writer.y + NODE_RY } };
    const gridRight = g.ox + g.cols * (g.cell + g.gap) - g.gap;
    const gridMidY = g.oy + (g.rows * (g.cell + g.gap) - g.gap) / 2;
    return { from: { x: gridRight + 6, y: gridMidY }, to: { x: g.writer.x - R, y: g.writer.y } };
  }
  function writerToSink(g) {
    const R = NODE_R;
    if (g.narrow) return { from: { x: g.writer.x + R, y: g.writer.y }, to: { x: g.sink.x - R, y: g.sink.y } };
    return { from: { x: g.writer.x, y: g.writer.y + R }, to: { x: g.sink.x, y: g.sink.y - R } };
  }

  function spawnParticles(events, snap) {
    if (!geom) return;
    const now = performance.now();
    // flight time: ~700 ms at 1 min/s, ~450 ms at 10 min/s, 300 ms floor at the fastest speeds
    const dur = Math.max(300, Math.min(700, 1400 / Math.sqrt(Math.max(1, ticksPerSecond / 6))));
    const g = geom, R = NODE_R;
    const RY = NODE_RY;
    const edge = (node, dir) => ({
      x: node.x + (dir === 'out' ? R : dir === 'in' ? -R : 0),
      y: node.y + (dir === 'down' ? RY : dir === 'up' ? -RY : 0),
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
    // finished bundles travel along the pool -> Writer arrow, written data along Writer -> Done
    const out = poolToWriter(g), fin = writerToSink(g);
    for (const [i] of sample(events.filter(e => e.type === 'complete'), 24).entries()) {
      particles.push({ x0: out.from.x, y0: out.from.y, x1: out.to.x, y1: out.to.y, t0: now + i * 10, dur, kind: 'out' });
    }
    for (const [i] of sample(events.filter(e => e.type === 'written'), 12).entries()) {
      particles.push({ x0: fin.from.x, y0: fin.from.y, x1: fin.to.x, y1: fin.to.y, t0: now + i * 12, dur: dur * 0.6, kind: 'out' });
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
      s1: cssVar('--s1'), s2: cssVar('--s2'), good: cssVar('--good'), s5: cssVar('--s5'),
    };
  }

  // Draw a line of text centred at (x, y) that fits within maxW: shrink the
  // font down to 8px first, then truncate with an ellipsis.
  function fitText(ctx, text, x, y, maxW, size, weight) {
    let px = size;
    const font = n => `${weight ? weight + ' ' : ''}${n}px system-ui, sans-serif`;
    ctx.font = font(px);
    while (ctx.measureText(text).width > maxW && px > 8) { px -= 1; ctx.font = font(px); }
    let t = text;
    while (t.length > 2 && ctx.measureText(t).width > maxW) t = t.slice(0, -2).trimEnd() + '…';
    ctx.fillText(t, x, y);
  }
  function nodePath(ctx, x, y, r, pad) {
    const rx = r + (pad || 0), ry = NODE_RY + (pad || 0);
    ctx.beginPath();
    if (ry >= rx) ctx.arc(x, y, rx, 0, Math.PI * 2);
    else roundRect(ctx, x - rx, y - ry, 2 * rx, 2 * ry, ry); // wide pill
  }
  function drawNode(ctx, x, y, r, title, lines, fillColor, ink, ink2, border) {
    nodePath(ctx, x, y, r);
    ctx.fillStyle = fillColor; ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = border; ctx.stroke();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const maxW = 2 * r - 10;
    const lineH = NODE_RY >= 40 ? 13 : 11;
    const titleY = lines.length ? y - (lines.length * lineH) / 2 : y;
    const small = NODE_RY < 40;
    ctx.fillStyle = ink;
    fitText(ctx, title, x, titleY, maxW, small ? 11 : 12, '600');
    ctx.fillStyle = ink2;
    lines.forEach((l, i) => fitText(ctx, l, x, titleY + (i + 1) * lineH, maxW, small ? 10 : 11));
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

    const gridLeft = g.ox;
    const gridMidY = g.oy + (g.rows * (g.cell + g.gap) - g.gap) / 2;
    const r = NODE_R;
    if (!g.narrow) {
      drawArrow(ctx, g.source.x, g.source.y + r, g.bundler.x, g.bundler.y - r, C.axis);
      drawArrow(ctx, g.bundler.x, g.bundler.y + r, g.dispatcher.x, g.dispatcher.y - r, C.axis);
      drawArrow(ctx, g.dispatcher.x + r, g.dispatcher.y, gridLeft - 6, gridMidY, C.axis);
    } else {
      drawArrow(ctx, g.source.x + r, g.source.y, g.bundler.x - r, g.bundler.y, C.axis);
      drawArrow(ctx, g.bundler.x + r, g.bundler.y, g.dispatcher.x - r, g.dispatcher.y, C.axis);
      drawArrow(ctx, g.dispatcher.x + r, g.dispatcher.y, g.writer.x - r, g.writer.y, C.axis);
    }
    const out = poolToWriter(g), fin = writerToSink(g);
    drawArrow(ctx, out.from.x, out.from.y, out.to.x, out.to.y, C.axis);
    drawArrow(ctx, fin.from.x, fin.from.y, fin.to.x, fin.to.y, C.axis);

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
        if (b.finished) { ctx.fillStyle = C.s5; ctx.fillRect(x + 1, y + 1, cell - 2, bh); } // waiting for the writer
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
      ctx.fillStyle = p.kind === 'out' ? C.good : C.s1; ctx.fill();
    }
    particles = alive;

    // nodes last, so dots arriving at a node disappear under it rather than over its text
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
      [`${fmtInt(snap.dispatcherQueued)} / ${fmtInt(snap.dispatcherCapacity)}`, `${snap.dispatched} sent`],
      full ? C.surface2 : C.surface, C.ink, C.ink2, C.border);
    if (full) {
      nodePath(ctx, g.dispatcher.x, g.dispatcher.y, r, 2);
      ctx.lineWidth = 2; ctx.strokeStyle = C.critical; ctx.stroke();
    }
    const writerFull = snap.writerQueued >= snap.writerCapacity;
    drawNode(ctx, g.writer.x, g.writer.y, r, 'Writer',
      [`${fmtInt(snap.writerQueued)} / ${fmtInt(snap.writerCapacity)}`, snap.blocked ? `${fmt(snap.blocked)} blocked` : `${fmt(snap.written)} / tick`],
      writerFull ? C.surface2 : C.surface, C.ink, C.ink2, C.border);
    if (writerFull) {
      nodePath(ctx, g.writer.x, g.writer.y, r, 2);
      ctx.lineWidth = 2; ctx.strokeStyle = C.critical; ctx.stroke();
    }
    drawNode(ctx, g.sink.x, g.sink.y, r, 'Done', [`${fmt(sim.totals.written)} total`, `${fmt(snap.written)} / tick`],
      C.surface, C.ink, C.ink2, C.border);
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
    tooltip.innerHTML = `<div class="tt-title">Worker ${idx + 1}${offline ? ' · offline' : b && b.finished ? ' · finished, waiting for the writer' : df < 1 ? ` · slowed ×${df.toFixed(2)}` : b ? '' : ' · idle'}</div>` +
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
    where: new LineChart($('#chart-where'), Object.assign({}, timeOpts, {
      stacked: true,
      series: [
        { key: 'stackWorkers', rawKey: 'workerItems', name: 'processing', color: '--s1' },
        { key: 'stackDeath', rawKey: 'deathStuckItems', name: 'stuck on a conversion of death', color: '--s8' },
        { key: 'stackDegraded', rawKey: 'degradedStuckItems', name: 'on degraded / offline workers', color: '--s7' },
        { key: 'stackDispatcher', rawKey: 'dispatcherItems', name: 'dispatcher', color: '--s2' },
        { key: 'stackBundler', rawKey: 'intakeItems', name: 'bundler', color: '--s3' },
        { key: 'stackUpstream', rawKey: 'heldItems', name: 'upstream', color: '--s4' },
        { key: 'stackWriter', rawKey: 'writerStage', name: 'writer', color: '--s5' },
      ],
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

  // Histogram x-ranges ratchet: they grow at once when the data needs it and
  // shrink only when the old maximum falls out of a 12-hour window of
  // simulated time. Without this the range (and with it the bin width) is
  // recomputed from the current data every frame and the chart twitches.
  class RollingMax {
    constructor(windowTicks) { this.window = windowTicks; this.q = []; this.lastTick = -1; }
    push(tick, value) {
      if (tick < this.lastTick) this.q = []; // simulation was reset
      this.lastTick = tick;
      while (this.q.length && this.q[this.q.length - 1].value <= value) this.q.pop();
      this.q.push({ tick, value });
      while (this.q.length && this.q[0].tick < tick - this.window) this.q.shift();
      return this.q[0].value;
    }
  }
  const HIST_RANGE_WINDOW = 12 * TICKS_PER_HOUR;
  const latencyRange = new RollingMax(HIST_RANGE_WINDOW);
  const inflightRange = new RollingMax(HIST_RANGE_WINDOW);

  // Bin width and count for a range in minutes (at most ~60 bins), plus one overflow bin.
  function binPlan(rangeMin) {
    const maxMin = Math.max(30, rangeMin + 1);
    let binMin = BIN_STEPS_MIN[BIN_STEPS_MIN.length - 1];
    for (const bm of BIN_STEPS_MIN) { if (maxMin / bm <= 60) { binMin = bm; break; } }
    const nBins = Math.ceil(maxMin / binMin) + 1;
    const bins = Array.from({ length: nBins }, (_, i) => ({ x0: i * binMin, x1: (i + 1) * binMin, overflow: i === nBins - 1 }));
    return { binMin, nBins, bins };
  }
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

  // Keep the histogram's data current whether or not it is drawn: the rolling
  // windows and the axis ratchet advance every frame, so a hidden chart shows
  // the full picture the moment it is shown again.
  let latencyRangeMin = 30;
  function updateHistogramData() {
    // size bins from the 99.5th percentile so a rare very long bundle does not
    // squash the bulk; everything beyond lands in a final overflow bin
    let span = 0;
    for (const w of histWindows) {
      w.win.update();
      if (w.win.total > 0) { const p = w.win.percentile(0.995) / TICKS_PER_MIN; if (p > span) span = p; }
    }
    latencyRangeMin = latencyRange.push(sim.tick, span);
  }
  function renderHistogram() {
    const { binMin, nBins, bins } = binPlan(latencyRangeMin);
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
  let inflightTotal = 0, inflightRangeMin = 30, inflightRows = [];
  function updateInflightData() {
    inflightRows = sim.inflightByAge(); // ascending age, ticks
    inflightTotal = inflightRows.reduce((s, r) => s + r.count, 0);
    let span = 0, acc = 0;
    for (const r of inflightRows) { acc += r.count; if (acc >= 0.995 * inflightTotal) { span = r.age / TICKS_PER_MIN; break; } }
    inflightRangeMin = inflightRange.push(sim.tick, span);
  }
  function renderInflightHistogram() {
    const rows = inflightRows, total = inflightTotal;
    const { binMin, nBins, bins } = binPlan(inflightRangeMin);
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
      st.q.push(h); st.sa += h.arrivals; st.sp += (h.written || 0);
      if (st.q.length > AVG_WIN) { const d = st.q.shift(); st.sa -= d.arrivals; st.sp -= (d.written || 0); }
      st.latQ.push(h.latencies); st.latCount += h.latencies.length;
      if (st.latQ.length > LAT_WIN) st.latCount -= st.latQ.shift().length;
      if (st.latCount >= 5 && h.tick % 3 === 0) {
        const all = [];
        for (const arr of st.latQ) for (const v of arr) all.push(v);
        all.sort((a, b) => a - b);
        const at = p => all[Math.min(all.length - 1, Math.floor(all.length * p))] / TICKS_PER_HOUR;
        st.p50 = at(0.5); st.p90 = at(0.9); st.p99 = at(0.99);
      } else if (st.latCount < 5) { st.p50 = null; st.p90 = null; st.p99 = null; }
      const wk = h.workerItems || 0, de = h.deathStuckItems || 0, dg = h.degradedStuckItems || 0;
      const dq = h.dispatcherItems || 0, bu = h.intakeItems || 0, up = h.heldItems || 0;
      const wrs = (h.writerItems || 0) + (h.blockedItems || 0); // buffered or finished-but-blocked
      const c1 = wk, c2 = c1 + de, c3 = c2 + dg, c4 = c3 + dq, c5 = c4 + bu, c6 = c5 + up, c7 = c6 + wrs;
      st.rows.push({
        tick: h.tick, backlogItems: h.backlogItems, nominalCapacity: h.nominalCapacity,
        workerItems: wk, deathStuckItems: de, degradedStuckItems: dg, dispatcherItems: dq, intakeItems: bu, heldItems: up, writerStage: wrs,
        stackWorkers: c1, stackDeath: c2, stackDegraded: c3, stackDispatcher: c4, stackBundler: c5, stackUpstream: c6, stackWriter: c7,
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
    $('#kpi-workers').textContent = [`${fmtInt(snap.idle)} idle`, snap.stalled ? `${fmtInt(snap.stalled)} stalled` : null, snap.slowed ? `${fmtInt(snap.slowed)} slowed` : null, snap.blocked ? `${fmtInt(snap.blocked)} blocked` : null, `${fmtInt(snap.offline)} offline`].filter(Boolean).join(' · ');
    const wq = $('#kpi-writer');
    wq.textContent = `${fmtInt(snap.writerQueued)} / ${fmtInt(snap.writerCapacity)}`;
    wq.classList.toggle('warn', snap.writerQueued >= snap.writerCapacity);
    $('#kpi-writer-sub').textContent = snap.blocked ? `${fmtInt(snap.blocked)} blocked workers` : `${fmt(snap.written)} written per tick`;
    const dq = $('#kpi-dispatcher');
    dq.textContent = `${fmtInt(snap.dispatcherQueued)} / ${fmtInt(snap.dispatcherCapacity)}`;
    dq.classList.toggle('warn', snap.dispatcherQueued >= snap.dispatcherCapacity);
    $('#kpi-upstream').textContent = snap.heldItems > 0
      ? `${fmt(snap.intakeItems)} at bundler · ${fmt(snap.heldItems)} held`
      : `${fmt(snap.intakeItems)} at bundler`;
  }

  // Incident markers for the time charts, from the model's incident log.
  const MARKER_COLOR = { spike: '--s2', degrade: '--critical', poison: '--s5', upstreamDelay: '--s4' };
  function markerLabel(e) {
    switch (e.type) {
      case 'spike': return `spike ×${e.magnitude}`;
      case 'degrade': return e.factor === 0 ? `outage ${fmtInt(e.workers)} workers` : `degraded ${fmtInt(e.workers)} ×${e.factor}`;
      case 'poison': return `death +${(e.magnitude.share * 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}%`;
      case 'upstreamDelay': return 'upstream hold';
      default: return e.type;
    }
  }
  function incidentMarkers() {
    return sim.incidentLog.map(e => ({ start: e.start, end: e.end, cancelled: e.cancelled, label: markerLabel(e), color: MARKER_COLOR[e.type] || '--axis' }));
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
    if (!collapsedFor(stage)) drawStage();
    const rows = chartRows(sim.history);
    lastRows = rows;
    // completeness: same horizon as the other charts
    const firstTick = sim.history.length ? sim.history[0].tick : sim.tick;
    const minutes = Math.floor((sim.tick - 1) / COHORT_TICKS) - Math.floor((firstTick - 1) / COHORT_TICKS) + 1;
    const cohorts = sim.completeness(Math.max(1, minutes));
    frameNo++;
    const drawAll = force || !playing;
    const slot = frameNo % chartStride;
    let i = 0;
    const markers = incidentMarkers();
    for (const [name, c] of Object.entries(charts)) {
      c.setMarkers(markers);
      const mine = (drawAll || (i++ % chartStride) === slot) && !collapsedFor(c.canvas);
      if (name === 'completeness') { c.setData(cohorts); c.setDomain(firstTick, sim.tick); if (mine) c.draw(); }
      else { c.setData(rows); if (mine) c.draw(); }
    }
    updateHistogramData();
    updateInflightData();
    if ((drawAll || (i++ % chartStride) === slot) && !collapsedFor(histChart.canvas)) renderHistogram();
    if ((drawAll || (i++ % chartStride) === slot) && !collapsedFor(inflightHist.canvas)) renderInflightHistogram();
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
    renderScenario();
  }

  window.addEventListener('resize', () => { geom = null; drawDistribution(); render(true); });
  // the preview canvas has no width while its panel is collapsed
  distCanvas.closest('details').addEventListener('toggle', e => { if (e.target.open) drawDistribution(); });
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { window.invalidateChartTheme(); buildRamp(); drawDistribution(); render(true); });
  }

  // ---------- card controls: hide/show and drag to reorder ----------
  // Every chart card gets a grip and a Hide button in its header. Collapsed
  // cards keep only their title, and their charts are skipped by the render
  // loop. Order and hidden state persist per browser in localStorage; cards
  // marked data-default-hidden start collapsed until the user shows them.
  // The order key is versioned so a change to the default layout reaches
  // browsers that saved an older arrangement.
  const STORE_ORDER = 'pipeline-sim.card-order.v2', STORE_VIS = 'pipeline-sim.card-visibility';
  const STORE_HIDDEN_V1 = 'pipeline-sim.card-hidden';
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  };
  const chartGrid = $('.charts');
  function cardId(card) {
    const cv = card.querySelector('canvas');
    return card.dataset.card || (cv ? cv.id : null);
  }
  function collapsedFor(canvas) {
    const card = canvas.closest('.card');
    return !!(card && card.classList.contains('collapsed'));
  }
  function setCollapsed(card, on) {
    card.classList.toggle('collapsed', on);
    const btn = card.querySelector('.btn.toggle');
    if (btn) { btn.textContent = on ? 'Show' : 'Hide'; btn.setAttribute('aria-expanded', String(!on)); }
    const vis = store.get(STORE_VIS) || {};
    vis[cardId(card)] = on ? 'hidden' : 'shown';
    store.set(STORE_VIS, vis);
    if (!on) { geom = null; render(true); }
  }
  function saveOrder() {
    store.set(STORE_ORDER, [...chartGrid.querySelectorAll(':scope > .card')].map(cardId));
  }
  function setupCard(card, draggable) {
    const head = card.querySelector('.card-head');
    if (!head) return;
    const actions = document.createElement('span');
    actions.className = 'card-actions';
    if (draggable) {
      const grip = document.createElement('span');
      grip.className = 'grip'; grip.title = 'Drag to reorder'; grip.textContent = '⋮⋮';
      grip.setAttribute('aria-label', 'Drag to reorder');
      grip.addEventListener('pointerdown', e => startDrag(e, card));
      actions.appendChild(grip);
    }
    const btn = document.createElement('button');
    btn.className = 'btn tiny toggle'; btn.type = 'button'; btn.textContent = 'Hide';
    btn.addEventListener('click', () => setCollapsed(card, !card.classList.contains('collapsed')));
    actions.appendChild(btn);
    head.appendChild(actions);
  }
  // Pointer-based reordering (works with mouse and touch): while dragging, the
  // card follows the pointer through the grid by being moved in the DOM.
  function startDrag(e, card) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    const pointerId = e.pointerId;
    card.classList.add('dragging');
    document.body.classList.add('reordering');
    const move = ev => {
      if (ev.pointerId !== pointerId) return;
      // find the sibling card under the pointer by geometry, then place the
      // dragged card before or after it depending on which half was crossed
      for (const over of chartGrid.querySelectorAll(':scope > .card')) {
        if (over === card) continue;
        const r = over.getBoundingClientRect();
        if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) continue;
        const before = ev.clientY < r.top + r.height / 2;
        if (before) chartGrid.insertBefore(card, over); else chartGrid.insertBefore(card, over.nextSibling);
        break;
      }
    };
    const end = ev => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      card.classList.remove('dragging');
      document.body.classList.remove('reordering');
      saveOrder();
      render(true);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }
  function initCards() {
    // restore order; a card missing from the saved order (added since it was
    // saved) keeps its default place after the card it follows in the markup
    const order = store.get(STORE_ORDER);
    if (Array.isArray(order)) {
      const cards = [...chartGrid.querySelectorAll(':scope > .card')];
      const byId = new Map(cards.map(c => [cardId(c), c]));
      const placed = order.filter(id => byId.has(id));
      cards.forEach((c, i) => {
        if (placed.includes(cardId(c))) return;
        const prev = i > 0 ? placed.indexOf(cardId(cards[i - 1])) : -1;
        placed.splice(prev + 1, 0, cardId(c));
      });
      for (const id of placed) chartGrid.appendChild(byId.get(id));
    }
    for (const card of chartGrid.querySelectorAll(':scope > .card')) setupCard(card, true);
    const stageCard = $('.stage-card');
    stageCard.dataset.card = 'stage';
    setupCard(stageCard, false);
    let vis = store.get(STORE_VIS);
    if (!vis) {
      // carry over cards hidden under the old list-of-hidden-ids format
      vis = {};
      for (const id of store.get(STORE_HIDDEN_V1) || []) vis[id] = 'hidden';
      store.set(STORE_VIS, vis);
    }
    for (const card of document.querySelectorAll('.card')) {
      const state = vis[cardId(card)] || ('defaultHidden' in card.dataset ? 'hidden' : 'shown');
      if (state === 'hidden') {
        card.classList.add('collapsed');
        const btn = card.querySelector('.btn.toggle');
        if (btn) { btn.textContent = 'Show'; btn.setAttribute('aria-expanded', 'false'); }
      }
    }
  }

  // PDF / CDF toggles on the distribution charts (remembered per chart)
  const STORE_DIST = 'pipeline-sim.dist-mode';
  const distCharts = { 'chart-hist': histChart, 'chart-inflight-hist': inflightHist };
  function setDistMode(id, mode, persist) {
    const chart = distCharts[id];
    if (!chart) return;
    chart.mode = mode;
    for (const btn of document.querySelectorAll(`[data-dist-toggle="${id}"] button`)) btn.classList.toggle('on', btn.dataset.mode === mode);
    if (persist) { const m = store.get(STORE_DIST) || {}; m[id] = mode; store.set(STORE_DIST, m); render(true); }
  }
  for (const seg of document.querySelectorAll('[data-dist-toggle]')) {
    seg.addEventListener('click', e => {
      const btn = e.target.closest('button[data-mode]');
      if (btn) setDistMode(seg.dataset.distToggle, btn.dataset.mode, true);
    });
  }
  const savedModes = store.get(STORE_DIST) || {};
  for (const id of Object.keys(distCharts)) if (savedModes[id] === 'cdf') setDistMode(id, 'cdf', false);

  // ---------- boot ----------
  initCards();
  buildRamp();
  readControlsIntoSim();
  $('#speed-out').textContent = speedLabel(ticksPerSecond);
  render(true);
  setPlaying(true);
})();
