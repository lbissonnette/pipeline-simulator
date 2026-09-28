const test = require('node:test');
const assert = require('node:assert/strict');
const { Simulation, DEFAULTS, makeRng, sampleRate, expectedRate, expectedBundleTicks } = require('../js/sim.js');

// Defaults: 1000 workers x 10 conversions/tick, 7,200-conversion bundles
// (~720 ticks + ~86 ticks of expensive-conversion stalls) -> capacity ~8,900/tick.
// Tests that check exact shapes disable expensive conversions (PURE).
const CAP = 8918;
const PURE = { expensiveFraction: 0 };
function run(sim, ticks) { for (let i = 0; i < ticks; i++) sim.step(); return sim.last; }
function invariants(sim) {
  assert.ok(sim.dispatcher.length <= sim.config.dispatcherCapacity, 'dispatcher over capacity');
  const { arrived, processed } = sim.totals;
  assert.ok(Math.abs(arrived - (processed + sim.last.backlogItems)) < 1e-3, 'items not conserved');
}

test('defaults describe the intended scale', () => {
  const sim = new Simulation();
  assert.equal(sim.workers.length, 1000);
  assert.ok(Math.abs(sim.last.nominalCapacity - CAP) < CAP * 0.02, `capacity ${sim.last.nominalCapacity}`);
  assert.ok(Math.abs(sim.last.load - 0.785) < 0.02, `load ${sim.last.load}`);
});

test('a bundle takes about bundleSize / mean ticks, plus the wasted tail', () => {
  const t = expectedBundleTicks({ type: 'normal', mean: 10, sd: 2.5 }, 7200);
  assert.ok(t > 720 && t < 723, `ticks ${t}`);
});

test('conserves items and never exceeds dispatcher capacity', () => {
  const sim = new Simulation({ arrivalRate: 9000, seed: 7 });
  for (let i = 0; i < 3000; i++) { sim.step(); if (i % 50 === 0) invariants(sim); }
  invariants(sim);
});

test('is deterministic for a given seed', () => {
  const a = new Simulation({ seed: 99 }); run(a, 1500);
  const b = new Simulation({ seed: 99 }); run(b, 1500);
  assert.deepEqual(a.last, b.last);
  assert.deepEqual(a.totals, b.totals);
});

test('under-loaded pipeline settles: bounded backlog, near-empty dispatcher', () => {
  const sim = new Simulation(Object.assign({}, PURE, { arrivalRate: 7000, seed: 1 })); // rho 0.7
  run(sim, 6000);
  const tail = sim.history.slice(-2000);
  const meanBacklog = tail.reduce((s, h) => s + h.backlogItems, 0) / tail.length;
  const meanQueue = tail.reduce((s, h) => s + h.dispatcherQueued, 0) / tail.length;
  const meanBusy = tail.reduce((s, h) => s + h.utilization, 0) / tail.length;
  assert.ok(sim.last.load < 1);
  // in-progress work alone is ~0.7 * 1000 workers * half a bundle
  assert.ok(meanBacklog < 4e6, `mean backlog ${meanBacklog}`);
  assert.ok(meanQueue < 3, `mean dispatcher queue ${meanQueue}`);
  assert.ok(meanBusy > 0.6 && meanBusy < 0.85, `busy ${meanBusy}`);
});

test('over-loaded pipeline fills the dispatcher and backs up at the bundler', () => {
  const sim = new Simulation({ arrivalRate: 14000, seed: 1 }); // rho 1.4
  run(sim, 3000);
  const b1 = sim.last.backlogItems;
  run(sim, 3000);
  const b2 = sim.last.backlogItems;
  assert.ok(sim.last.load > 1);
  assert.equal(sim.last.dispatcherQueued, sim.config.dispatcherCapacity);
  assert.ok(sim.last.intakeItems > sim.config.bundleSize, `intake ${sim.last.intakeItems}`);
  // ~4,000 excess conversions per tick
  assert.ok(b2 - b1 > 9e6, `growth ${b2 - b1}`);
});

test('backlog drains after arrivals stop', () => {
  const sim = new Simulation({ arrivalRate: 12000, seed: 3 });
  run(sim, 2000);
  assert.ok(sim.last.backlogItems > 0);
  sim.update({ arrivalRate: 0 });
  run(sim, 4000);
  assert.equal(sim.last.backlogItems, 0);
  assert.equal(sim.last.dispatcherQueued, 0);
  assert.ok(sim.workers.every(w => w.bundle === null));
});

test('workers hold at most one bundle', () => {
  const sim = new Simulation({ arrivalRate: 12000, seed: 8 });
  run(sim, 1500);
  assert.equal(sim.totals.bundlesDispatched, sim.totals.bundlesCompleted + sim.workers.filter(w => w.bundle).length);
});

test('outage takes workers offline; idle routing avoids them', () => {
  const sim = new Simulation({ arrivalRate: 8000, seed: 5 });
  run(sim, 1000);
  const inc = sim.addIncident('outage', 0.3, 200);
  assert.equal(inc.workers.length, 300);
  sim.step();
  assert.equal(sim.last.offline, 300);
  for (const id of inc.workers) assert.equal(sim.workers[id].lastWorked, 0);
  const before = inc.workers.map(id => sim.workers[id].bundle && sim.workers[id].bundle.id);
  run(sim, 100);
  inc.workers.forEach((id, i) => {
    const b = sim.workers[id].bundle;
    assert.equal(b && b.id, before[i]);
  });
  run(sim, 150);
  assert.equal(sim.last.offline, 0);
  assert.equal(sim.incidents.length, 0);
});

test('sticky routing lets bundles wait for a busy or offline worker', () => {
  const sim = new Simulation({ arrivalRate: 8000, seed: 5, routing: 'sticky' });
  run(sim, 1000);
  for (const b of sim.dispatcher) assert.ok(Number.isInteger(b.worker));
  sim.addIncident('outage', 0.5, 400);
  run(sim, 300);
  const stuck = sim.workers.filter(w => w.offlineUntil >= sim.tick && w.bundle);
  assert.ok(stuck.length > 0);
  invariants(sim);
});

test('upstream delay holds arrivals then releases them in a burst', () => {
  const sim = new Simulation({ arrivalRate: 8000, seed: 11 });
  run(sim, 100);
  sim.addIncident('upstreamDelay', 1, 60);
  run(sim, 30);
  assert.ok(sim.last.heldItems > 200000, `held ${sim.last.heldItems}`);
  const cutBefore = sim.totals.bundlesCut;
  run(sim, 31);
  assert.equal(sim.last.heldItems, 0);
  assert.ok(sim.totals.bundlesCut - cutBefore >= 10, 'release should cut a burst of bundles');
  invariants(sim);
});

test('slowdown cuts throughput', () => {
  const sim = new Simulation({ arrivalRate: 8500, seed: 2 });
  run(sim, 2000);
  const baseline = sim.history.slice(-200).reduce((s, h) => s + h.processed, 0) / 200;
  sim.addIncident('slowdown', 0.25, 600);
  run(sim, 400);
  const slowed = sim.history.slice(-200).reduce((s, h) => s + h.processed, 0) / 200;
  assert.ok(slowed < baseline * 0.5, `${slowed} vs ${baseline}`);
});

test('end-to-end latency is a little over one bundle time under healthy load', () => {
  const sim = new Simulation(Object.assign({}, PURE, { arrivalRate: 8000, seed: 4 }));
  run(sim, 3000);
  const lat = [];
  for (const h of sim.history.slice(-1000)) lat.push(...h.latencies);
  lat.sort((a, b) => a - b);
  const p50 = lat[Math.floor(lat.length / 2)];
  assert.ok(lat.length > 500, `completed ${lat.length}`);
  assert.ok(p50 > 720 && p50 < 760, `p50 ${p50} ticks`);
});

test('distribution samplers have the requested mean', () => {
  const rng = makeRng(123);
  for (const type of ['normal', 'uniform', 'lognormal']) {
    let s = 0; const n = 20000;
    const d = { type, mean: 10, sd: 2 };
    for (let i = 0; i < n; i++) s += sampleRate(rng, d);
    assert.ok(Math.abs(s / n - 10) < 0.1, `${type}: ${s / n}`);
  }
  const bi = expectedRate({ type: 'bimodal', mean: 10, sd: 1, slowFraction: 0.5, slowFactor: 0.5 });
  assert.ok(Math.abs(bi - 7.5) < 0.15, `bimodal ${bi}`);
});

test('rates are never negative', () => {
  const rng = makeRng(9);
  for (let i = 0; i < 5000; i++) assert.ok(sampleRate(rng, { type: 'normal', mean: 2, sd: 5 }) >= 0);
});

test('worker count can change while running without losing work', () => {
  const sim = new Simulation({ arrivalRate: 8000, seed: 6 });
  run(sim, 500);
  sim.update({ workers: 1500 });
  assert.equal(sim.workers.length, 1500);
  run(sim, 500);
  sim.update({ workers: 400 });
  assert.equal(sim.workers.length, 400);
  run(sim, 500);
  invariants(sim);
});

test('per-minute completeness: cohorts conserve counts and age toward 100%', () => {
  const sim = new Simulation(Object.assign({}, PURE, { arrivalRate: 8000, seed: 21 }));
  run(sim, 5 * 360); // 5 hours
  const rows = sim.completeness(5 * 60);
  const arrived = rows.reduce((s, r) => s + r.arrived, 0);
  const processed = rows.reduce((s, r) => s + r.processed, 0);
  assert.ok(Math.abs(arrived - sim.totals.arrived) < 1e-3, `arrived ${arrived} vs ${sim.totals.arrived}`);
  assert.ok(Math.abs(processed - sim.totals.processed) < 1e-3, `processed ${processed} vs ${sim.totals.processed}`);
  // the newest minute is barely processed, minutes older than ~2.5 h are done
  assert.ok(rows[rows.length - 1].pct < 5, `newest ${rows[rows.length - 1].pct}`);
  for (const r of rows.slice(0, 60)) assert.ok(r.pct > 99.9, `old cohort ${r.cohort} at ${r.pct}%`);
  // completeness never exceeds 100 and is (weakly) higher for older cohorts in steady state
  for (const r of rows) assert.ok(r.pct <= 100 + 1e-9);
  const mid = rows.slice(60, 120).map(r => r.pct);
  assert.ok(mid[0] >= mid[mid.length - 1] - 5, 'older cohorts should be at least as complete');
});

test('upstream delay keeps held conversions in their original arrival minute', () => {
  const sim = new Simulation(Object.assign({}, PURE, { arrivalRate: 8000, seed: 22 }));
  run(sim, 600);
  sim.addIncident('upstreamDelay', 1, 60);
  run(sim, 30);
  const heldRows = sim.completeness(5).slice(0, 4); // minutes fully inside the hold
  for (const r of heldRows) { assert.ok(r.arrived > 40000); assert.equal(r.processed, 0); }
  run(sim, 40 + 720 + 120); // release, process for well over a bundle time
  for (const r of sim.completeness(200).filter(r => heldRows.some(h => h.cohort === r.cohort))) {
    assert.ok(r.pct > 99.9, `held cohort ${r.cohort} at ${r.pct}`);
  }
});

test('fresh time percentiles: ordered, and near the 2 h ramp under healthy load', () => {
  const sim = new Simulation(Object.assign({}, PURE, { arrivalRate: 8000, seed: 31 }));
  run(sim, 5 * 360);
  const f = sim.freshTimes();
  const min = t => t / 6;
  assert.ok(f[99] >= f[90] && f[90] >= f[50], `order ${JSON.stringify(f)}`);
  // completeness of data aged a is ~ a / 2h, so P50 ~ 60 min, P90 ~ 108, P99 ~ 119
  assert.ok(Math.abs(min(f[50]) - 60) < 8, `p50 ${min(f[50])} min`);
  assert.ok(Math.abs(min(f[90]) - 108) < 8, `p90 ${min(f[90])} min`);
  assert.ok(Math.abs(min(f[99]) - 119) < 8, `p99 ${min(f[99])} min`);
  // snapshot carries the same numbers
  assert.equal(sim.last.fresh99, f[99]);
});

test('fresh time grows during an outage and recovers afterwards', () => {
  const sim = new Simulation(Object.assign({}, PURE, { arrivalRate: 8000, seed: 32 }));
  run(sim, 4 * 360);
  const before = sim.freshTimes()[99];
  sim.addIncident('outage', 0.5, 360); // half the pool offline for an hour
  run(sim, 360 + 360);
  const during = sim.freshTimes()[99];
  assert.ok(during > before + 60, `p99 ${during} vs ${before}`);
  run(sim, 8 * 360);
  const after = sim.freshTimes()[99];
  assert.ok(Math.abs(after - before) < 60, `recovered p99 ${after} vs ${before}`);
});

test('fresh time is zero when everything is complete', () => {
  const sim = new Simulation({ arrivalRate: 8000, seed: 33 });
  run(sim, 600);
  sim.update({ arrivalRate: 0 });
  run(sim, 2000);
  const f = sim.freshTimes();
  assert.deepEqual(f, { 50: 0, 90: 0, 99: 0 });
});

test('degrade incident: a share of workers run slower, and factor 0 means offline', () => {
  const sim = new Simulation({ arrivalRate: 8000, seed: 41 });
  run(sim, 1500);
  const inc = sim.addIncident('degrade', { factor: 0.25, fraction: 0.3, selection: 'random' }, 120);
  assert.equal(inc.workers.length, 300);
  sim.step();
  assert.equal(sim.last.slowed, 300);
  assert.equal(sim.last.offline, 0);
  // slowed workers still get work and still process, just less of it
  const affected = new Set(inc.workers);
  let slowSum = 0, slowN = 0, fastSum = 0, fastN = 0;
  for (let i = 0; i < 60; i++) {
    sim.step();
    for (const w of sim.workers) {
      if (!w.bundle) continue;
      if (affected.has(w.id)) { slowSum += w.lastRate; slowN++; } else { fastSum += w.lastRate; fastN++; }
    }
  }
  assert.ok(slowN > 0 && fastN > 0);
  const ratio = (slowSum / slowN) / (fastSum / fastN);
  assert.ok(Math.abs(ratio - 0.25) < 0.05, `ratio ${ratio}`);
  run(sim, 120);
  assert.equal(sim.last.slowed, 0);
  // full outage through the same incident type
  const out = sim.addIncident('degrade', { factor: 0, fraction: 0.1 }, 50);
  sim.step();
  assert.equal(sim.last.offline, out.workers.length);
  sim.cancelIncident(out.id);
  sim.step();
  assert.equal(sim.last.offline, 0);
  invariants(sim);
});

test('lowest-idle routing concentrates work on low-index workers', () => {
  const sim = new Simulation({ arrivalRate: 7000, seed: 51, routing: 'lowestIdle' });
  run(sim, 3000);
  const busy = sim.workers.filter(w => w.bundle).map(w => w.id);
  const idle = sim.workers.filter(w => !w.bundle).map(w => w.id);
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  assert.ok(busy.length > 700 && idle.length > 100);
  assert.ok(mean(busy) < mean(idle) - 300, `busy ${mean(busy)} idle ${mean(idle)}`);
  assert.ok(sim.workers[0].completed > sim.workers[999].completed);
  invariants(sim);
});

test('degrade can target the lowest x% of workers by index', () => {
  const sim = new Simulation({ arrivalRate: 8000, seed: 52 });
  run(sim, 100);
  const inc = sim.addIncident('degrade', { factor: 0, fraction: 0.2, selection: 'lowest' }, 60);
  assert.deepEqual(inc.workers, Array.from({ length: 200 }, (_, i) => i));
  sim.step();
  for (let i = 0; i < 200; i++) assert.ok(sim.workers[i].offlineUntil >= sim.tick);
  assert.ok(sim.workers[200].offlineUntil < sim.tick);
  const rnd = sim.addIncident('degrade', { factor: 0.5, fraction: 0.2, selection: 'random' }, 60);
  assert.notDeepEqual(rnd.workers.slice().sort((a, b) => a - b), inc.workers);
});

test('completions are retained for the window and can be sliced by recency', () => {
  const sim = new Simulation({ arrivalRate: 8000, seed: 61, completionRetention: 3000, expensiveFraction: 0 });
  run(sim, 5000);
  const all = sim.latencySamples(1e9);
  assert.ok(all.length > 0);
  assert.ok(all.every(c => c.tick > sim.tick - 3000), 'old completions should be pruned');
  const recent = sim.latencySamples(600);
  assert.ok(recent.length > 0 && recent.length < all.length);
  assert.ok(recent.every(c => c.tick > sim.tick - 600));
  // per-bundle latency near 2 h under healthy load, weighted by size
  const w = recent.reduce((s, c) => s + c.size, 0);
  const mean = recent.reduce((s, c) => s + c.latency * c.size, 0) / w;
  assert.ok(mean > 720 && mean < 780, `mean latency ${mean}`);
});


test('expensive conversions: each one adds exactly its cost to the bundle', () => {
  const sim = new Simulation({ arrivalRate: 7000, seed: 71, expensiveFraction: 0.0001, expensiveCost: 120, expensiveCostSd: 0 });
  run(sim, 4000);
  const byK = new Map();
  for (const c of sim.latencySamples(2000)) {
    if (!byK.has(c.expensive)) byK.set(c.expensive, []);
    byK.get(c.expensive).push(c.latency);
  }
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  assert.ok(byK.get(0).length > 200 && byK.get(1).length > 100 && byK.get(2).length > 20);
  const m0 = mean(byK.get(0));
  assert.ok(m0 > 715 && m0 < 735, `k=0 mean ${m0}`);
  assert.ok(Math.abs(mean(byK.get(1)) - m0 - 120) < 5, `k=1 delta ${mean(byK.get(1)) - m0}`);
  assert.ok(Math.abs(mean(byK.get(2)) - m0 - 240) < 8, `k=2 delta ${mean(byK.get(2)) - m0}`);
  // Poisson(0.72) share of k=0 is ~49%
  const total = [...byK.values()].reduce((s, a) => s + a.length, 0);
  assert.ok(Math.abs(byK.get(0).length / total - Math.exp(-0.72)) < 0.05);
  assert.ok(sim.last.stalled > 0);
  invariants(sim);
});

test('expensive-tail preset: end-to-end mean ~4 h, sd ~1.2 h', () => {
  const sim = new Simulation({ arrivalRate: 4000, seed: 72, expensiveFraction: 0.000525, expensiveCost: 192, expensiveCostSd: 114 });
  run(sim, 12000);
  const c = sim.latencySamples(6000);
  let w = 0, m = 0;
  for (const x of c) { w += x.size; m += x.latency * x.size; }
  m /= w;
  let v = 0;
  for (const x of c) v += x.size * (x.latency - m) ** 2;
  const sd = Math.sqrt(v / w);
  assert.ok(Math.abs(m / 360 - 4) < 0.15, `mean ${m / 360} h`);
  assert.ok(Math.abs(sd / 360 - 1.2) < 0.15, `sd ${sd / 360} h`);
  assert.ok(sim.last.load > 0.75 && sim.last.load < 0.85, `load ${sim.last.load}`);
});

test('workers are homogeneous: no per-worker speed state', () => {
  const sim = new Simulation();
  assert.ok(sim.workers.every(w => w.speed === undefined));
  assert.equal(sim.config.heterogeneity, undefined);
});


test('expensive cost spread: per-conversion costs vary log-normally around the mean', () => {
  const { sampleLognormal } = require('../js/sim.js');
  const rng = makeRng(5);
  let n = 20000, sum = 0, sq = 0;
  for (let i = 0; i < n; i++) { const v = sampleLognormal(rng, 120, 60); sum += v; sq += v * v; }
  const mean = sum / n, sd = Math.sqrt(sq / n - mean * mean);
  assert.ok(Math.abs(mean - 120) < 2, `mean ${mean}`);
  assert.ok(Math.abs(sd - 60) < 3, `sd ${sd}`);
  assert.equal(sampleLognormal(rng, 120, 0), 120);
  // in the simulation, the recorded extra time equals the sum of the drawn costs
  const sim = new Simulation({ arrivalRate: 7000, seed: 73 });
  run(sim, 3000);
  const c = sim.latencySamples(1000).filter(x => x.expensive === 1);
  assert.ok(c.length > 100);
  const extras = c.map(x => x.extraTicks);
  const m = extras.reduce((a, b) => a + b, 0) / extras.length;
  const s2 = extras.reduce((a, b) => a + (b - m) ** 2, 0) / extras.length;
  assert.ok(Math.abs(m - 120) < 10, `k=1 mean extra ${m}`);
  assert.ok(Math.abs(Math.sqrt(s2) - 60) < 12, `k=1 sd extra ${Math.sqrt(s2)}`);
  // and the bundle's latency tracks it: latency ≈ base + extra
  const resid = c.map(x => x.latency - x.extraTicks);
  const rm = resid.reduce((a, b) => a + b, 0) / resid.length;
  assert.ok(rm > 715 && rm < 740, `base ${rm}`);
});
