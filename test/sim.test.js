const test = require('node:test');
const assert = require('node:assert/strict');
const { Simulation, DEFAULTS, makeRng, sampleRate, expectedRate, expectedBundleTicks } = require('../js/sim.js');

// Defaults: 1024 workers x 10 conversions/tick, 1,200-conversion bundles
// (~120 ticks of work + ~22 ticks of expensive-conversion stalls) -> capacity
// ~8,640/tick, end-to-end median ~23 min.
// Tests that check exact shapes use a reference model: 7,200-conversion
// bundles (~2 h) with no expensive conversions (PURE), or with a fixed small
// share (REF) where the stalls themselves are under test.
const CAP = 8644;
const N = 1024;
const PURE = { expensiveFraction: 0, bundleSize: 7200 };
const REF = { bundleSize: 7200, expensiveFraction: 0.0001, expensiveCost: 120, expensiveCostSd: 60 };
function run(sim, ticks) { for (let i = 0; i < ticks; i++) sim.step(); return sim.last; }
function invariants(sim) {
  assert.ok(sim.dispatcher.length <= sim.config.dispatcherCapacity, 'dispatcher over capacity');
  assert.ok(sim.writer.queue.length <= sim.config.writerCapacity, 'writer over capacity');
  const { arrived, processed, written } = sim.totals;
  // backlog = unprocessed work + processed-but-unwritten work (writer buffer, blocked workers)
  const unprocessed = sim.last.backlogItems - sim.last.writerItems - sim.last.blockedItems;
  assert.ok(Math.abs(arrived - (processed + unprocessed)) < 1e-3, 'items not conserved');
  assert.ok(written <= processed + 1e-6, 'written more than processed');
}

test('defaults describe the intended scale', () => {
  const sim = new Simulation();
  assert.equal(sim.workers.length, N);
  assert.ok(Math.abs(sim.last.nominalCapacity - CAP) < CAP * 0.02, `capacity ${sim.last.nominalCapacity}`);
  assert.ok(Math.abs(sim.last.load - 0.6) < 0.02, `load ${sim.last.load}`);
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
  assert.equal(sim.totals.bundlesDispatched, sim.totals.bundlesCompleted + sim.workers.filter(w => w.bundle).length + sim.writer.queue.length);
});

test('outage takes workers offline; idle routing avoids them', () => {
  const sim = new Simulation({ arrivalRate: 8000, seed: 5 });
  run(sim, 1000);
  const inc = sim.addIncident('outage', 0.3, 200);
  assert.equal(inc.workers.length, Math.round(0.3 * N));
  sim.step();
  assert.equal(sim.last.offline, Math.round(0.3 * N));
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
  // bundles are written atomically: cohorts are credited only when the writer
  // has written the whole bundle, so cohort-processed = total written
  assert.ok(Math.abs(processed - sim.totals.written) < 1e-3, `processed ${processed} vs written ${sim.totals.written}`);
  // recent minutes are 0% until their bundle completes (~2 h), older ones are done
  for (const r of rows.slice(-100)) assert.equal(r.pct, 0, `young cohort ${r.cohort} at ${r.pct}%`);
  for (const r of rows.slice(0, 60)) assert.ok(r.pct > 99.9, `old cohort ${r.cohort} at ${r.pct}%`);
  for (const r of rows) assert.ok(r.pct <= 100 + 1e-9);
  // the step from 0 to 100 happens within a few minutes of the 2 h bundle time
  const firstIncomplete = rows.findIndex(r => r.pct < 99);
  const ageMin = rows.length - firstIncomplete;
  assert.ok(ageMin > 118 && ageMin < 128, `step at ${ageMin} min`);
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

test('fresh time percentiles: ordered, and near the 2 h bundle time under healthy load', () => {
  const sim = new Simulation(Object.assign({}, PURE, { arrivalRate: 8000, seed: 31 }));
  run(sim, 5 * 360);
  const f = sim.freshTimes();
  const min = t => t / 6;
  assert.ok(f[99] >= f[90] && f[90] >= f[50], `order ${JSON.stringify(f)}`);
  // bundles are written atomically, so a minute goes from 0% to 100% when its
  // bundle completes ~2 h later: all three percentiles sit near 2 h
  for (const L of [50, 90, 99]) assert.ok(Math.abs(min(f[L]) - 121) < 6, `p${L} ${min(f[L])} min`);
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
  assert.equal(inc.workers.length, Math.round(0.3 * N));
  sim.step();
  assert.equal(sim.last.slowed, Math.round(0.3 * N));
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
  const sim = new Simulation({ arrivalRate: 6900, seed: 51, routing: 'lowestIdle' });
  run(sim, 3000);
  const busy = sim.workers.filter(w => w.bundle).map(w => w.id);
  const idle = sim.workers.filter(w => !w.bundle).map(w => w.id);
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  assert.ok(busy.length > 700 && idle.length > 100);
  assert.ok(mean(busy) < mean(idle) - 300, `busy ${mean(busy)} idle ${mean(idle)}`);
  assert.ok(sim.workers[0].completed > sim.workers[N - 1].completed);
  invariants(sim);
});

test('degrade can target the lowest x% of workers by index', () => {
  const sim = new Simulation({ arrivalRate: 8000, seed: 52 });
  run(sim, 100);
  const k = Math.round(0.2 * N);
  const inc = sim.addIncident('degrade', { factor: 0, fraction: 0.2, selection: 'lowest' }, 60);
  assert.deepEqual(inc.workers, Array.from({ length: k }, (_, i) => i));
  sim.step();
  for (let i = 0; i < k; i++) assert.ok(sim.workers[i].offlineUntil >= sim.tick);
  assert.ok(sim.workers[k].offlineUntil < sim.tick);
  const rnd = sim.addIncident('degrade', { factor: 0.5, fraction: 0.2, selection: 'random' }, 60);
  assert.notDeepEqual(rnd.workers.slice().sort((a, b) => a - b), inc.workers);
});

test('completions are retained for the window and can be sliced by recency', () => {
  const sim = new Simulation(Object.assign({}, PURE, { arrivalRate: 8000, seed: 61, completionRetention: 3000 }));
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
  const sim = new Simulation(Object.assign({}, REF, { arrivalRate: 7000, seed: 71, expensiveCostSd: 0 }));
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

test('default distribution: end-to-end median ~23 min, p99 under an hour', () => {
  const sim = new Simulation({ seed: 72 });
  run(sim, 6000);
  const c = sim.latencySamples(3000).slice().sort((a, b) => a.latency - b.latency);
  const total = c.reduce((s, x) => s + x.size, 0);
  const q = p => { let acc = 0; for (const x of c) { acc += x.size; if (acc >= p * total) return x.latency / 6; } return null; };
  assert.ok(c.length > 5000, `completions ${c.length}`);
  assert.ok(Math.abs(q(0.5) - 23) < 2, `median ${q(0.5)} min`);
  assert.ok(q(0.9) > 26 && q(0.9) < 35, `p90 ${q(0.9)} min`);
  assert.ok(q(0.99) > 35 && q(0.99) < 60, `p99 ${q(0.99)} min`);
  assert.ok(sim.last.load > 0.55 && sim.last.load < 0.65, `load ${sim.last.load}`);
});

test('conversion-of-death incident adds fixed-cost stalls while active', () => {
  const sim = new Simulation({ seed: 81, expensiveFraction: 0 });
  run(sim, 1500);
  const before = sim.latencySamples(600);
  // 0.05% at 10 min (about 0.6 per bundle), for 50 min
  const inc = sim.addIncident('poison', { share: 0.0005, cost: 60 }, 300);
  run(sim, 300 + 600); // let the poisoned bundles finish
  const after = sim.latencySamples(900);
  const poisoned = after.filter(c => c.expensive > 0);
  assert.ok(before.every(c => c.expensive === 0));
  assert.ok(poisoned.length > 300, `poisoned ${poisoned.length}`);
  // each conversion of death adds exactly its cost (no spread)
  const byK = new Map();
  for (const c of poisoned) { if (!byK.has(c.expensive)) byK.set(c.expensive, []); byK.get(c.expensive).push(c.latency); }
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  const base = mean(before.map(c => c.latency));
  for (const [k, lats] of byK) if (lats.length >= 10) assert.ok(Math.abs(mean(lats) - base - k * 60) < 8, `k=${k}: ${mean(lats) - base}`);
  // bundles cut after the incident ended are clean again
  assert.equal(sim.incidents.length, 0);
  run(sim, 300);
  assert.ok(sim.latencySamples(60).every(c => c.expensive === 0));
});

test('conversions of death follow arrival time through an upstream hold', () => {
  const sim = new Simulation({ seed: 82, expensiveFraction: 0 });
  run(sim, 600);
  // hold arrivals for 300 ticks; poison only the first 120 ticks of the hold
  sim.addIncident('upstreamDelay', 1, 300);
  const poisonStart = sim.tick + 1;
  sim.addIncident('poison', { share: 0.002, cost: 60 }, 120);
  const poisonEnd = sim.tick + 120;
  run(sim, 301); // the hold releases on the tick after it expires
  assert.equal(sim.last.heldItems, 0);
  run(sim, 900); // let the released bundles finish
  const c = sim.latencySamples(900);
  const inWindow = c.filter(x => x.createdTick >= poisonStart && x.createdTick <= poisonEnd);
  const afterWindow = c.filter(x => x.createdTick > poisonEnd);
  assert.ok(inWindow.length > 100 && afterWindow.length > 100, `${inWindow.length} / ${afterWindow.length}`);
  // ~2.4 per bundle expected in the window: nearly all poisoned; none afterwards
  assert.ok(inWindow.filter(x => x.poisoned > 0).length / inWindow.length > 0.85);
  assert.ok(afterWindow.every(x => x.poisoned === 0));
  invariants(sim);
});

test('in-flight age: counts match the backlog and percentiles are ordered', () => {
  const sim = new Simulation({ seed: 91 });
  run(sim, 2000);
  const rows = sim.inflightByAge();
  const total = rows.reduce((s, r) => s + r.count, 0);
  // in flight = arrived but not yet written out
  assert.ok(Math.abs(total - (sim.totals.arrived - sim.totals.written)) < 1e-3, `${total} vs ${sim.totals.arrived - sim.totals.written}`);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i].age >= rows[i - 1].age);
  const p = sim.inflightPercentiles();
  assert.ok(p[50] <= p[90] && p[90] <= p[99], JSON.stringify(p));
  // ages of data still in flight under healthy load: mostly under one bundle time
  assert.ok(p[50] > 3 * 6 && p[50] < 20 * 6, `p50 ${p[50] / 6} min`);
  assert.ok(p[99] < 90 * 6, `p99 ${p[99] / 6} min`);
  // the snapshot value is refreshed once per arrival minute
  assert.ok(Math.abs(sim.last.inflight99 - p[99]) <= 6, `${sim.last.inflight99} vs ${p[99]}`);
});

test('stalls record whether they are on a conversion of death', () => {
  const sim = new Simulation({ seed: 82 });
  const seen = { plain: 0, poison: 0 };
  const tally = () => {
    for (const w of sim.workers) {
      const b = w.bundle;
      if (b && b.stallLeft > 0) seen[b.stallPoison ? 'poison' : 'plain']++;
    }
  };
  for (let i = 0; i < 1500; i++) { sim.step(); tally(); }
  // only the configured expensive conversions so far: none flagged
  assert.ok(seen.plain > 0, `plain ${seen.plain}`);
  assert.equal(seen.poison, 0);
  sim.update({ expensiveFraction: 0 });
  sim.addIncident('poison', { share: 0.0005, cost: 60 }, 300);
  seen.plain = 0;
  for (let i = 0; i < 900; i++) { sim.step(); tally(); }
  assert.ok(seen.poison > 0, `poison ${seen.poison}`);
});

test('writer: default rate keeps up, buffer bounded, nothing blocked', () => {
  const sim = new Simulation({ seed: 101 });
  let maxQ = 0, blockedTicks = 0;
  for (let i = 0; i < 3000; i++) { sim.step(); maxQ = Math.max(maxQ, sim.last.writerQueued); if (sim.last.blocked) blockedTicks++; }
  assert.ok(maxQ <= sim.config.writerCapacity);
  assert.equal(blockedTicks, 0);
  assert.ok(sim.totals.written > 0.9 * sim.totals.processed, 'writer should be keeping up');
  invariants(sim);
});

test('writer: a slow writer caps throughput and blocks workers', () => {
  const sim = new Simulation({ seed: 102, writeRate: 3000, writerCapacity: 8 });
  run(sim, 3000);
  const tail = sim.history.slice(-600);
  const writtenPerTick = tail.reduce((s, h) => s + h.written, 0) / tail.length;
  assert.ok(Math.abs(writtenPerTick - 3000) < 60, `written/tick ${writtenPerTick}`);
  assert.ok(sim.last.blocked > 100, `blocked ${sim.last.blocked}`);
  assert.equal(sim.last.busy + sim.last.blocked + sim.last.idle + sim.last.offline, N);
  assert.equal(sim.last.nominalCapacity, 3000);
  // end-to-end latency now includes the wait for the writer
  const lat = sim.latencySamples(300).map(c => c.latency);
  const med = lat.sort((a, b) => a - b)[Math.floor(lat.length / 2)];
  assert.ok(med > 200 * 6, `median ${med / 6} min`);
  invariants(sim);
});

test('writer intake policies choose the expected blocked worker', () => {
  for (const policy of ['fifo', 'lowestIndex', 'random']) {
    // one bundle written per tick, a one-slot buffer: exactly one admission per tick once saturated
    const sim = new Simulation({ seed: 103, writeRate: 1200, writerCapacity: 1, writerIntake: policy, expensiveFraction: 0 });
    run(sim, 600);
    assert.ok(sim.last.blocked > 50, `${policy}: blocked ${sim.last.blocked}`);
    for (let i = 0; i < 20; i++) {
      const blockedBefore = sim.workers.filter(w => w.bundle && w.bundle.finished).map(w => ({ id: w.id, t: w.bundle.finishedTick }));
      sim.step();
      const admitted = sim.events.filter(e => e.type === 'complete').map(e => e.worker);
      if (!admitted.length || !blockedBefore.length) continue;
      const first = admitted[0];
      if (policy === 'lowestIndex') assert.equal(first, Math.min(...blockedBefore.map(b => b.id)));
      if (policy === 'fifo') {
        const minT = Math.min(...blockedBefore.map(b => b.t));
        const chosen = blockedBefore.find(b => b.id === first);
        assert.ok(chosen && chosen.t === minT, `fifo admitted ${first} finished at ${chosen && chosen.t}, earliest ${minT}`);
      }
    }
    invariants(sim);
  }
});

test('incident log records start, end, and manual switch-off', () => {
  const sim = new Simulation({ seed: 111 });
  run(sim, 100);
  const a = sim.addIncident('spike', 2, 50);
  const b = sim.addIncident('upstreamDelay', 1, 500);
  run(sim, 60);
  const la = sim.incidentLog.find(e => e.id === a.id), lb = sim.incidentLog.find(e => e.id === b.id);
  assert.equal(la.start, 101); assert.equal(la.end, 150); assert.equal(la.cancelled, false);
  assert.equal(lb.end, null);
  sim.cancelIncident(b.id);
  assert.equal(lb.end, sim.tick); assert.equal(lb.cancelled, true);
  assert.equal(sim.incidents.length, 0);
});

test('in-flight breakdown: stuck-on-death and degraded layers sum with the rest', () => {
  const sim = new Simulation({ seed: 121 });
  run(sim, 1500);
  sim.addIncident('degrade', { factor: 0, fraction: 0.2, selection: 'random' }, 300);
  sim.addIncident('poison', { share: 0.002, cost: 300 }, 300);
  run(sim, 200); // sample while both incidents are active
  const s = sim.last;
  assert.ok(s.degradedStuckItems > 0 && s.deathStuckItems > 0, JSON.stringify({ d: s.degradedStuckItems, p: s.deathStuckItems }));
  // the worker layers partition the in-progress bundles
  const onWorkers = sim.workers.reduce((a, w) => a + (w.bundle && !w.bundle.finished ? w.bundle.size : 0), 0);
  assert.ok(Math.abs(s.workerItems + s.deathStuckItems + s.degradedStuckItems - onWorkers) < 1e-6);
  invariants(sim);
});

test('stalls are not capped: a conversion of death keeps its full cost', () => {
  const sim = new Simulation({ seed: 74, expensiveFraction: 0 });
  run(sim, 100);
  // 20 h each, well past the old 4 h cap
  sim.addIncident('poison', { share: 0.001, cost: 7200 }, 60);
  run(sim, 400);
  const stalls = sim.workers.filter(w => w.bundle).flatMap(w => w.bundle.stalls.filter(st => st.poison));
  const stalled = sim.workers.filter(w => w.bundle && w.bundle.stallPoison);
  assert.ok(stalls.length > 0 && stalls.every(st => st.cost === 7200));
  assert.ok(stalled.length > 0 && stalled.some(w => w.bundle.stallLeft > 1440), 'no stall past 4 h');
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
  const sim = new Simulation(Object.assign({}, REF, { arrivalRate: 7000, seed: 73 }));
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

test('stuck workers: unwritten minutes outlive the 24 h horizon, so P99 fresh time keeps climbing', () => {
  // Predefined outage "Stuck workers": 0.3% of the pool, lowest by index, offline for 999 h.
  const H = 360;
  const sim = new Simulation({ seed: 42 });
  run(sim, 2 * H);
  const inc = sim.addIncident('degrade', { factor: 0, fraction: 0.003, selection: 'lowest' }, 999 * H);
  assert.equal(inc.workers.length, 3);
  assert.deepEqual(inc.workers, [0, 1, 2]);
  run(sim, 30 * H);
  // the three held bundles are still in flight, far past the 24 h cohort horizon
  assert.equal(sim.last.degradedStuckItems, 3 * sim.config.bundleSize);
  assert.ok(sim.last.fresh99 > 29 * H, `P99 fresh ${sim.last.fresh99 / H} h`);
  assert.ok(sim.last.fresh90 < H, `P90 fresh ${sim.last.fresh90 / H} h`);
  assert.ok(sim.inflightByAge().some(r => r.age > 29 * H), 'stuck data missing from in-flight ages');
  // ... yet it is well under 1% of everything in flight, so P99 in-flight age stays low
  assert.ok(sim.last.inflight99 < H, `P99 in-flight ${sim.last.inflight99 / H} h`);
  // only the unwritten minutes and their neighbours are kept past the horizon
  assert.ok(sim.cohorts.size < 24 * 60 + 60 + 40, `cohorts kept ${sim.cohorts.size}`);
  invariants(sim);
  // unstick: the held bundles are written, P99 fresh time falls back, old minutes are pruned
  sim.cancelIncident(inc.id);
  run(sim, 2 * H);
  assert.equal(sim.last.degradedStuckItems, 0);
  assert.ok(sim.last.fresh99 < 2 * H, `P99 fresh after ${sim.last.fresh99 / H} h`);
  assert.ok(sim.cohorts.size <= 24 * 60 + 61, `cohorts kept ${sim.cohorts.size}`);
  invariants(sim);
});

test('slow tenth: P90 fresh time climbs, then drops while the outage continues', () => {
  // Predefined outage "Slow tenth": 10% of workers, chosen at random, at 10% speed for 48 h.
  const H = 360;
  const sim = new Simulation({ seed: 42 });
  run(sim, 2 * H);
  sim.addIncident('degrade', { factor: 0.1, fraction: 0.1, selection: 'random' }, 48 * H);
  let peak90 = 0;
  const lat = [];
  for (let i = 0; i < 8 * H; i++) {
    sim.step();
    peak90 = Math.max(peak90, sim.last.fresh90);
    lat.push(...sim.last.latencies);
  }
  assert.ok(peak90 > 1.5 * H, `P90 fresh peak ${peak90 / H} h`);
  // hours later, same outage: P90 is back near normal, P99 still shows it
  assert.ok(sim.last.fresh90 < H, `P90 fresh now ${sim.last.fresh90 / H} h`);
  assert.ok(sim.last.fresh99 > 2 * H, `P99 fresh now ${sim.last.fresh99 / H} h`);
  // end-to-end P90 of what was written never reached the slow bundles
  lat.sort((a, b) => a - b);
  assert.ok(lat[Math.floor(lat.length * 0.9)] < H, `P90 e2e ${lat[Math.floor(lat.length * 0.9)] / H} h`);
  invariants(sim);
});
