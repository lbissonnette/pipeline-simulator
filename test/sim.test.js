const test = require('node:test');
const assert = require('node:assert/strict');
const { Simulation, DEFAULTS, makeRng, sampleRate, expectedRate, expectedBundleTicks } = require('../js/sim.js');

// Defaults: 1000 workers x 10 conversions/tick, 7,200-conversion bundles
// (~720 ticks each) -> capacity ~10,000 conversions/tick.
const CAP = 10000;
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
  assert.ok(Math.abs(sim.last.load - 0.8) < 0.02, `load ${sim.last.load}`);
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
  const sim = new Simulation({ arrivalRate: 7000, seed: 1 }); // rho 0.7
  run(sim, 6000);
  const tail = sim.history.slice(-2000);
  const meanBacklog = tail.reduce((s, h) => s + h.backlogItems, 0) / tail.length;
  const meanQueue = tail.reduce((s, h) => s + h.dispatcherQueued, 0) / tail.length;
  const meanBusy = tail.reduce((s, h) => s + h.utilization, 0) / tail.length;
  assert.ok(sim.last.load < 1);
  // in-progress work alone is ~0.7 * 1000 workers * half a bundle
  assert.ok(meanBacklog < 4e6, `mean backlog ${meanBacklog}`);
  assert.ok(meanQueue < 3, `mean dispatcher queue ${meanQueue}`);
  assert.ok(meanBusy > 0.6 && meanBusy < 0.8, `busy ${meanBusy}`);
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
  const sim = new Simulation({ arrivalRate: 8000, seed: 4 });
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
  const sim = new Simulation({ arrivalRate: 8000, seed: 21 });
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
  const sim = new Simulation({ arrivalRate: 8000, seed: 22 });
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
  const sim = new Simulation({ arrivalRate: 8000, seed: 31 });
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
  const sim = new Simulation({ arrivalRate: 8000, seed: 32 });
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
