const test = require('node:test');
const assert = require('node:assert/strict');
const { Simulation, makeRng, sampleRate, expectedRate, expectedBundleTicks } = require('../js/sim.js');

function run(sim, ticks) { for (let i = 0; i < ticks; i++) sim.step(); return sim.last; }
function invariants(sim) {
  assert.ok(sim.dispatcher.length <= sim.config.dispatcherCapacity, 'dispatcher over capacity');
  for (const w of sim.workers) assert.ok(w.bundle === null || typeof w.bundle === 'object');
  const { arrived, processed } = sim.totals;
  assert.ok(Math.abs(arrived - (processed + sim.last.backlogItems)) < 1e-3, 'items not conserved');
}

test('conserves items and never exceeds dispatcher capacity', () => {
  const sim = new Simulation({ arrivalRate: 180000, seed: 7 });
  for (let i = 0; i < 400; i++) { sim.step(); invariants(sim); }
});

test('is deterministic for a given seed', () => {
  const a = new Simulation({ seed: 99 }); run(a, 200);
  const b = new Simulation({ seed: 99 }); run(b, 200);
  assert.deepEqual(a.last, b.last);
  assert.deepEqual(a.totals, b.totals);
});

test('expected bundle time exceeds 1/mean because leftover capacity is wasted', () => {
  const t = expectedBundleTicks({ type: 'normal', mean: 0.2, sd: 0.05 });
  assert.ok(t > 5 && t < 6.5, `ticks ${t}`);
});

test('under-loaded pipeline keeps a bounded backlog and an empty-ish dispatcher', () => {
  // capacity ≈ 100 workers * 10000 / ~5.5 ticks ≈ 180k/tick; 130k -> rho ≈ 0.7
  const sim = new Simulation({ arrivalRate: 130000, seed: 1 });
  run(sim, 600);
  const tail = sim.history.slice(-300);
  const meanBacklog = tail.reduce((s, h) => s + h.backlogItems, 0) / tail.length;
  const meanQueue = tail.reduce((s, h) => s + h.dispatcherQueued, 0) / tail.length;
  assert.ok(sim.last.load < 1, `load ${sim.last.load}`);
  assert.ok(meanBacklog < 1.5e6, `mean backlog ${meanBacklog}`);
  assert.ok(meanQueue < 5, `mean dispatcher queue ${meanQueue}`);
});

test('over-loaded pipeline fills the dispatcher and backs up at the bundler', () => {
  const sim = new Simulation({ arrivalRate: 260000, seed: 1 }); // rho ≈ 1.4
  run(sim, 300);
  const b300 = sim.last.backlogItems;
  run(sim, 300);
  const b600 = sim.last.backlogItems;
  assert.ok(sim.last.load > 1);
  assert.equal(sim.last.dispatcherQueued, sim.config.dispatcherCapacity);
  assert.ok(sim.last.intakeItems > 1e6, `intake ${sim.last.intakeItems}`);
  assert.ok(b600 - b300 > 1.5e7, `growth ${b600 - b300}`);
});

test('backlog drains after arrivals stop', () => {
  const sim = new Simulation({ arrivalRate: 220000, seed: 3 });
  run(sim, 200);
  assert.ok(sim.last.backlogItems > 0);
  sim.update({ arrivalRate: 0 });
  run(sim, 800);
  assert.equal(sim.last.backlogItems, 0);
  assert.equal(sim.last.dispatcherQueued, 0);
  assert.ok(sim.workers.every(w => w.bundle === null));
});

test('workers hold at most one bundle and only take work when idle', () => {
  const sim = new Simulation({ arrivalRate: 250000, seed: 8 });
  for (let i = 0; i < 100; i++) {
    sim.step();
    for (const w of sim.workers) {
      if (w.bundle) assert.ok(w.bundle.dispatchedTick <= sim.tick);
    }
  }
  // dispatched bundles equal bundles that ever sat on a worker
  assert.equal(sim.totals.bundlesDispatched, sim.totals.bundlesCompleted + sim.workers.filter(w => w.bundle).length);
});

test('outage takes workers offline; idle routing avoids them', () => {
  const sim = new Simulation({ arrivalRate: 160000, seed: 5 });
  run(sim, 50);
  const inc = sim.addIncident('outage', 0.3, 20);
  assert.equal(inc.workers.length, 30);
  sim.step();
  assert.equal(sim.last.offline, 30);
  for (const id of inc.workers) assert.equal(sim.workers[id].lastWorked, 0);
  // no new work is placed on offline workers
  const before = inc.workers.map(id => sim.workers[id].bundle && sim.workers[id].bundle.id);
  run(sim, 10);
  inc.workers.forEach((id, i) => {
    const b = sim.workers[id].bundle;
    assert.equal(b && b.id, before[i]);
  });
  run(sim, 15);
  assert.equal(sim.last.offline, 0);
  assert.equal(sim.incidents.length, 0);
});

test('sticky routing lets bundles wait for a busy or offline worker', () => {
  const sim = new Simulation({ arrivalRate: 160000, seed: 5, routing: 'sticky' });
  run(sim, 50);
  for (const b of sim.dispatcher) assert.ok(Number.isInteger(b.worker));
  sim.addIncident('outage', 0.5, 40);
  run(sim, 40);
  // offline workers accepted bundles that now sit stuck on them
  const stuck = sim.workers.filter(w => w.offlineUntil >= sim.tick && w.bundle);
  assert.ok(stuck.length > 0);
  invariants(sim);
});

test('upstream delay holds arrivals then releases them in a burst', () => {
  const sim = new Simulation({ arrivalRate: 160000, seed: 11 });
  run(sim, 10);
  sim.addIncident('upstreamDelay', 1, 10);
  run(sim, 5);
  assert.ok(sim.last.heldItems > 600000, `held ${sim.last.heldItems}`);
  run(sim, 6);
  assert.equal(sim.last.heldItems, 0);
  assert.ok(sim.last.backlogItems > 1e6, `after release ${sim.last.backlogItems}`);
  assert.ok(sim.last.busy > 50, `busy ${sim.last.busy}`);
});

test('slowdown cuts throughput', () => {
  const sim = new Simulation({ arrivalRate: 170000, seed: 2 });
  run(sim, 100);
  const baseline = sim.history.slice(-30).reduce((s, h) => s + h.processed, 0) / 30;
  sim.addIncident('slowdown', 0.25, 60);
  run(sim, 60);
  const slowed = sim.history.slice(-30).reduce((s, h) => s + h.processed, 0) / 30;
  assert.ok(slowed < baseline * 0.5, `${slowed} vs ${baseline}`);
});

test('latency is reported when bundles complete', () => {
  const sim = new Simulation({ arrivalRate: 160000, seed: 4 });
  run(sim, 50);
  assert.ok(sim.last.latencyP50 >= 1);
  assert.ok(sim.last.latencyP95 >= sim.last.latencyP50);
});

test('distribution samplers have the requested mean', () => {
  const rng = makeRng(123);
  for (const type of ['normal', 'uniform', 'lognormal']) {
    let s = 0; const n = 20000;
    const d = { type, mean: 0.3, sd: 0.05 };
    for (let i = 0; i < n; i++) s += sampleRate(rng, d);
    assert.ok(Math.abs(s / n - 0.3) < 0.01, `${type}: ${s / n}`);
  }
  const bi = expectedRate({ type: 'bimodal', mean: 0.4, sd: 0.02, slowFraction: 0.5, slowFactor: 0.5 });
  assert.ok(Math.abs(bi - 0.3) < 0.02, `bimodal ${bi}`);
});

test('rates are clamped to [0, 1]', () => {
  const rng = makeRng(9);
  for (let i = 0; i < 5000; i++) {
    const r = sampleRate(rng, { type: 'normal', mean: 0.5, sd: 2 });
    assert.ok(r >= 0 && r <= 1);
  }
});

test('worker count can change while running without losing work', () => {
  const sim = new Simulation({ arrivalRate: 160000, seed: 6 });
  run(sim, 30);
  sim.update({ workers: 150 });
  assert.equal(sim.workers.length, 150);
  run(sim, 30);
  sim.update({ workers: 40 });
  assert.equal(sim.workers.length, 40);
  run(sim, 30);
  const { arrived, processed } = sim.totals;
  assert.ok(Math.abs(arrived - (processed + sim.last.backlogItems)) < 1e-3);
});
