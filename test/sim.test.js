const test = require('node:test');
const assert = require('node:assert/strict');
const { Simulation, makeRng, sampleRate, expectedRate } = require('../js/sim.js');

function run(sim, ticks) { for (let i = 0; i < ticks; i++) sim.step(); return sim.last; }

test('conserves items: arrived == processed + backlog', () => {
  const sim = new Simulation({ arrivalRate: 450, seed: 7 });
  run(sim, 400);
  const { arrived, processed } = sim.totals;
  assert.ok(Math.abs(arrived - (processed + sim.last.backlogItems)) < 1e-6);
});

test('is deterministic for a given seed', () => {
  const a = new Simulation({ seed: 99 }); run(a, 200);
  const b = new Simulation({ seed: 99 }); run(b, 200);
  assert.deepEqual(a.last, b.last);
  assert.deepEqual(a.totals, b.totals);
});

test('under-loaded pipeline keeps a bounded backlog', () => {
  // capacity = 100 workers * 0.2 * 25 = 500 items/tick; arrivals 350 -> rho 0.7
  const sim = new Simulation({ arrivalRate: 350, seed: 1 });
  run(sim, 600);
  const tail = sim.history.slice(-300);
  const mean = tail.reduce((s, h) => s + h.backlogItems, 0) / tail.length;
  assert.ok(mean < 4000, `mean backlog ${mean}`);
  assert.ok(sim.last.load < 1);
});

test('over-loaded pipeline grows its backlog roughly linearly', () => {
  const sim = new Simulation({ arrivalRate: 700, seed: 1 }); // rho 1.4
  run(sim, 300);
  const b300 = sim.last.backlogItems;
  run(sim, 300);
  const b600 = sim.last.backlogItems;
  assert.ok(sim.last.load > 1);
  // ~200 items/tick of excess over 300 ticks ≈ 60k
  assert.ok(b600 - b300 > 40000, `growth ${b600 - b300}`);
});

test('backlog drains after arrivals stop', () => {
  const sim = new Simulation({ arrivalRate: 600, seed: 3 });
  run(sim, 200);
  assert.ok(sim.last.backlogItems > 0);
  sim.update({ arrivalRate: 0 });
  run(sim, 300);
  assert.equal(sim.last.backlogItems, 0);
  assert.equal(sim.last.queuedBundles, 0);
});

test('outage takes workers offline and they do no work', () => {
  const sim = new Simulation({ arrivalRate: 400, seed: 5, routing: 'random' });
  run(sim, 50);
  const inc = sim.addIncident('outage', 0.3, 20);
  assert.equal(inc.workers.length, 30);
  sim.step();
  assert.equal(sim.last.offline, 30);
  for (const id of inc.workers) assert.equal(sim.workers[id].lastWorked, 0);
  run(sim, 25);
  assert.equal(sim.last.offline, 0);
  assert.equal(sim.incidents.length, 0);
});

test('least-loaded routing avoids offline workers', () => {
  const sim = new Simulation({ arrivalRate: 400, seed: 5, routing: 'leastLoaded' });
  run(sim, 20);
  const inc = sim.addIncident('outage', 0.5, 30);
  const before = inc.workers.map(id => sim.workers[id].queue.length);
  run(sim, 10);
  const after = inc.workers.map(id => sim.workers[id].queue.length);
  for (let i = 0; i < before.length; i++) assert.ok(after[i] <= before[i]);
});

test('upstream delay holds arrivals then releases them in a burst', () => {
  const sim = new Simulation({ arrivalRate: 400, seed: 11 });
  run(sim, 10);
  sim.addIncident('upstreamDelay', 1, 10);
  run(sim, 5);
  assert.ok(sim.last.heldItems > 1500, `held ${sim.last.heldItems}`);
  assert.equal(sim.last.dispatched === 0 || sim.last.intakeItems === 0, true);
  run(sim, 6); // past the end of the incident
  assert.equal(sim.last.heldItems, 0);
  assert.ok(sim.last.queuedItems > 3000, `queued ${sim.last.queuedItems}`);
});

test('slowdown cuts throughput', () => {
  const sim = new Simulation({ arrivalRate: 450, seed: 2 });
  run(sim, 100);
  const baseline = sim.history.slice(-30).reduce((s, h) => s + h.processed, 0) / 30;
  sim.addIncident('slowdown', 0.25, 60);
  run(sim, 60);
  const slowed = sim.history.slice(-30).reduce((s, h) => s + h.processed, 0) / 30;
  assert.ok(slowed < baseline * 0.5, `${slowed} vs ${baseline}`);
});

test('latency is reported when bundles complete', () => {
  const sim = new Simulation({ arrivalRate: 400, seed: 4 });
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

test('worker count can change while running', () => {
  const sim = new Simulation({ arrivalRate: 400, seed: 6 });
  run(sim, 30);
  sim.update({ workers: 150 });
  assert.equal(sim.workers.length, 150);
  run(sim, 30);
  sim.update({ workers: 40 });
  assert.equal(sim.workers.length, 40);
  run(sim, 30);
  const { arrived, processed } = sim.totals;
  // items on removed workers are dropped from the pool, so conservation only holds as an upper bound
  assert.ok(processed + sim.last.backlogItems <= arrived + 1e-6);
});
