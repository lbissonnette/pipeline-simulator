/*
 * Pipeline simulator — pure model, no DOM.
 *
 * Conversions arrive each tick and are cut into bundles by the bundler. The
 * bundler hands bundles to a dispatcher with a bounded queue; when the queue
 * is full the bundler stops cutting (back-pressure) and conversions pile up
 * in its intake buffer. The dispatcher hands each bundle to an idle worker.
 * Workers hold exactly one bundle at a time; every tick a worker draws a
 * processing rate (conversions per tick) from a configurable distribution and
 * completes that many conversions of its bundle. When it finishes, it becomes
 * idle and can take the next bundle on the following tick.
 *
 * The model is unitless in time: a tick is whatever the UI says it is, except
 * that arrival cohorts are grouped per COHORT_TICKS ticks (one minute at 10 s
 * per tick) so completeness can be reported per arrival minute.
 *
 * Loaded as a plain <script> in the browser (global `PipelineSim`) and via
 * require() in Node for tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PipelineSim = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- randomness ----------
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeRng(seed) {
    const uniform = mulberry32(seed);
    let spare = null;
    function gaussian() {
      if (spare !== null) { const s = spare; spare = null; return s; }
      let u, v, s;
      do {
        u = uniform() * 2 - 1;
        v = uniform() * 2 - 1;
        s = u * u + v * v;
      } while (s >= 1 || s === 0);
      const m = Math.sqrt(-2 * Math.log(s) / s);
      spare = v * m;
      return u * m;
    }
    function poisson(lambda) {
      if (lambda <= 0) return 0;
      if (lambda > 60) {
        return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * gaussian()));
      }
      const L = Math.exp(-lambda);
      let k = 0, p = 1;
      do { k++; p *= uniform(); } while (p > L);
      return k - 1;
    }
    function int(n) { return Math.floor(uniform() * n); }
    return { uniform, gaussian, poisson, int };
  }

  // ---------- processing-rate distributions ----------
  const DISTRIBUTIONS = {
    normal: {
      label: 'Normal',
      sample(rng, d) { return d.mean + d.sd * rng.gaussian(); },
    },
    uniform: {
      label: 'Uniform',
      sample(rng, d) {
        const half = d.sd * Math.sqrt(3);
        return d.mean - half + rng.uniform() * 2 * half;
      },
    },
    lognormal: {
      label: 'Log-normal (heavy tail)',
      sample(rng, d) {
        if (d.mean <= 0) return 0;
        const cv2 = (d.sd / d.mean) ** 2;
        const sigma2 = Math.log(1 + cv2);
        const mu = Math.log(d.mean) - sigma2 / 2;
        return Math.exp(mu + Math.sqrt(sigma2) * rng.gaussian());
      },
    },
    bimodal: {
      label: 'Bimodal (fast + slow mode)',
      sample(rng, d) {
        const slow = rng.uniform() < d.slowFraction;
        const mean = slow ? d.mean * d.slowFactor : d.mean;
        return mean + d.sd * rng.gaussian();
      },
    },
  };

  // Conversions a worker completes this tick. Never negative.
  function sampleRate(rng, dist) {
    const impl = DISTRIBUTIONS[dist.type] || DISTRIBUTIONS.normal;
    const r = impl.sample(rng, dist);
    return r < 0 ? 0 : r;
  }

  // Mean clamped rate, by sampling.
  function expectedRate(dist, seed) {
    const rng = makeRng(seed || 12345);
    const n = 4000;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += sampleRate(rng, dist);
    return sum / n;
  }

  // Expected ticks a worker needs to finish one bundle. Because a worker
  // finishes a bundle mid-tick and idles for the rest of it, this is a little
  // more than bundleSize / mean rate; Monte Carlo gets it right for any
  // distribution, including the clamp at zero.
  function expectedBundleTicks(dist, bundleSize, seed) {
    const rng = makeRng(seed || 777);
    const bundles = 200;
    let ticks = 0;
    for (let i = 0; i < bundles; i++) {
      let done = 0, t = 0;
      while (done < bundleSize && t < 1e6) { done += sampleRate(rng, dist); t++; }
      ticks += t;
    }
    return ticks / bundles;
  }

  // ---------- defaults ----------
  // Defaults assume a tick of 10 seconds: a worker does 10 conversions per
  // tick (1/s), a bundle of 7,200 takes ~720 ticks (2 hours), and 1,000
  // workers give ~10,000 conversions per tick of capacity.
  const DEFAULTS = {
    workers: 1000,
    arrivalRate: 8000,         // mean conversions per tick (Poisson)
    waveAmplitude: 0,          // 0..1 modulation of arrivals
    wavePeriod: 8640,          // ticks per wave (24 h at 10 s per tick)
    bundleSize: 7200,          // conversions per bundle
    bundleMaxWait: 30,         // flush a partial bundle after this many ticks (5 min)
    dispatcherCapacity: 10,    // bundles the dispatcher can hold
    routing: 'idle',           // idle | roundRobin | sticky
    dist: { type: 'normal', mean: 10, sd: 2.5, slowFraction: 0.2, slowFactor: 0.25 }, // conversions / tick / worker
    heterogeneity: 0,          // sd of per-worker permanent speed multiplier
    historyLength: 4320,       // 12 h
    seed: 42,
  };

  const ROUTING = {
    idle: 'Any idle worker',
    roundRobin: 'Round robin over idle workers',
    sticky: 'Sticky partition (bundle waits for its worker)',
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  const COHORT_TICKS = 6;          // ticks per arrival cohort (1 minute at 10 s/tick)
  const COHORT_HISTORY = 24 * 60;  // cohorts kept for the completeness view (24 h)
  const cohortOf = tick => Math.floor((tick - 1) / COHORT_TICKS);

  // ---------- simulation ----------
  class Simulation {
    constructor(config) {
      this.config = Object.assign(clone(DEFAULTS), config || {});
      this.config.dist = Object.assign(clone(DEFAULTS.dist), (config && config.dist) || {});
      this.reset();
    }

    reset(seed) {
      if (seed !== undefined) this.config.seed = seed;
      this.rng = makeRng(this.config.seed);
      this.tick = 0;
      this.nextBundleId = 1;
      this.rrCursor = 0;
      // Buffers are FIFO lists of cohorts: { cohort, count, firstTick }.
      this.intake = { items: 0, oldestTick: null, cohorts: [] };
      this.held = { items: 0, oldestTick: null, cohorts: [] };   // upstream-delay holding area
      this.cohorts = new Map();   // cohort -> { arrived, processed }
      this.dispatcher = [];                          // queued bundles, FIFO
      this.incidents = [];
      this.nextIncidentId = 1;
      this.totals = { arrived: 0, processed: 0, bundlesCut: 0, bundlesDispatched: 0, bundlesCompleted: 0 };
      this.history = [];
      this.events = [];
      this.workers = [];
      this.applyWorkerCount(this.config.workers, true);
      this.last = this.snapshot(0, 0, 0, 0, []);
    }

    applyWorkerCount(n, fresh) {
      const ws = this.workers;
      while (ws.length > n) {
        const w = ws.pop();
        if (w.bundle) this.dispatcher.unshift(w.bundle); // hand its work back
      }
      while (ws.length < n) {
        ws.push({
          id: ws.length, bundle: null, speed: 1, offlineUntil: -1,
          lastRate: 0, lastWorked: 0, processed: 0, completed: 0,
        });
      }
      if (fresh) this.regenerateSpeeds();
      this.config.workers = n;
      if (this.config.routing === 'sticky') {
        for (const b of this.dispatcher) if (b.worker >= n) b.worker = this.rng.int(n);
      }
    }

    regenerateSpeeds() {
      const h = this.config.heterogeneity;
      const srng = makeRng(this.config.seed ^ 0x9e3779b9);
      for (const w of this.workers) {
        const s = 1 + h * srng.gaussian();
        w.speed = Math.min(3, Math.max(0.1, s));
      }
    }

    update(partial) {
      const prev = this.config;
      const next = Object.assign({}, prev, partial);
      if (partial.dist) next.dist = Object.assign({}, prev.dist, partial.dist);
      this.config = next;
      if (partial.workers !== undefined && partial.workers !== this.workers.length) {
        this.applyWorkerCount(partial.workers, false);
        this.regenerateSpeeds();
      }
      if (partial.heterogeneity !== undefined && partial.heterogeneity !== prev.heterogeneity) {
        this.regenerateSpeeds();
      }
      if (partial.routing === 'sticky' && prev.routing !== 'sticky') {
        for (const b of this.dispatcher) if (b.worker === null) b.worker = this.rng.int(this.workers.length);
      }
    }

    // ---------- incidents ----------
    addIncident(type, magnitude, duration) {
      const inc = {
        id: this.nextIncidentId++, type, magnitude, duration,
        start: this.tick + 1, end: this.tick + duration, workers: [],
      };
      if (type === 'outage') {
        const count = Math.round(this.workers.length * magnitude);
        const ids = this.workers.map(w => w.id);
        for (let i = ids.length - 1; i > 0; i--) {
          const j = this.rng.int(i + 1);
          [ids[i], ids[j]] = [ids[j], ids[i]];
        }
        inc.workers = ids.slice(0, count);
        for (const id of inc.workers) {
          this.workers[id].offlineUntil = Math.max(this.workers[id].offlineUntil, inc.end);
        }
      }
      this.incidents.push(inc);
      return inc;
    }

    cancelIncident(id) {
      const inc = this.incidents.find(i => i.id === id);
      if (!inc) return;
      if (inc.type === 'outage') {
        for (const wid of inc.workers) if (this.workers[wid]) this.workers[wid].offlineUntil = -1;
      }
      if (inc.type === 'upstreamDelay') this.releaseHeld();
      this.incidents = this.incidents.filter(i => i.id !== id);
    }

    activeModifiers() {
      let arrivalMult = 1, rateMult = 1, holdArrivals = false;
      for (const inc of this.incidents) {
        if (inc.type === 'spike') arrivalMult *= inc.magnitude;
        else if (inc.type === 'slowdown') rateMult *= inc.magnitude;
        else if (inc.type === 'upstreamDelay') holdArrivals = true;
      }
      return { arrivalMult, rateMult, holdArrivals };
    }

    releaseHeld() {
      if (this.held.items > 0) {
        // held conversions are older than anything in the intake buffer
        this.intake.cohorts = this.held.cohorts.concat(this.intake.cohorts);
        this.intake.items += this.held.items;
        this.intake.oldestTick = this.intake.oldestTick === null ? this.held.oldestTick : Math.min(this.intake.oldestTick, this.held.oldestTick);
        this.held = { items: 0, oldestTick: null, cohorts: [] };
      }
    }

    expireIncidents() {
      const remaining = [];
      for (const inc of this.incidents) {
        if (this.tick > inc.end) {
          if (inc.type === 'upstreamDelay') this.releaseHeld();
        } else remaining.push(inc);
      }
      this.incidents = remaining;
    }

    // ---------- intake / bundling ----------
    // Record n conversions arriving this tick into a buffer (intake or held).
    addArrivals(buffer, n) {
      if (n <= 0) return;
      const t = this.tick, c = cohortOf(t);
      const last = buffer.cohorts[buffer.cohorts.length - 1];
      if (last && last.cohort === c) last.count += n;
      else buffer.cohorts.push({ cohort: c, count: n, firstTick: t });
      if (buffer.items === 0) buffer.oldestTick = t;
      buffer.items += n;
      let stat = this.cohorts.get(c);
      if (!stat) { stat = { arrived: 0, processed: 0 }; this.cohorts.set(c, stat); this.pruneCohorts(c); }
      stat.arrived += n;
    }

    pruneCohorts(newest) {
      if (this.cohorts.size <= COHORT_HISTORY + 60) return;
      for (const k of this.cohorts.keys()) { if (k < newest - COHORT_HISTORY) this.cohorts.delete(k); }
    }

    // Take `size` conversions from the front of the intake buffer as a bundle.
    cutBundle(size) {
      const cohorts = [];
      let need = size;
      const q = this.intake.cohorts;
      while (need > 1e-9 && q.length) {
        const head = q[0];
        const take = Math.min(need, head.count);
        cohorts.push({ cohort: head.cohort, count: take, firstTick: head.firstTick });
        head.count -= take; need -= take;
        if (head.count <= 1e-9) q.shift();
      }
      const b = {
        id: this.nextBundleId++, size, remaining: size,
        cohorts, cursor: 0,                       // cursor: index of the cohort being processed
        createdTick: cohorts.length ? cohorts[0].firstTick : this.tick,
        cutTick: this.tick, dispatchedTick: null,
        worker: this.config.routing === 'sticky' ? this.rng.int(this.workers.length) : null,
      };
      this.intake.items -= size;
      if (this.intake.items <= 1e-9 || !q.length) { this.intake.items = 0; this.intake.oldestTick = null; this.intake.cohorts = []; }
      else this.intake.oldestTick = q[0].firstTick;
      this.totals.bundlesCut++;
      this.events.push({ type: 'bundle', size });
      return b;
    }

    // Attribute `amount` processed conversions to the bundle's cohorts, oldest first.
    creditProcessed(b, amount) {
      let left = amount;
      while (left > 1e-9 && b.cursor < b.cohorts.length) {
        const c = b.cohorts[b.cursor];
        const take = Math.min(left, c.count);
        c.count -= take; left -= take;
        const stat = this.cohorts.get(c.cohort);
        if (stat) stat.processed += take;
        if (c.count <= 1e-9) b.cursor++;
      }
    }

    // Completeness per arrival cohort for the last `count` cohorts:
    // [{ cohort, tick, arrived, processed, pct }], oldest first.
    completeness(count) {
      const now = cohortOf(Math.max(1, this.tick));
      const out = [];
      for (let c = now - count + 1; c <= now; c++) {
        if (c < 0) continue;
        const s = this.cohorts.get(c);
        const arrived = s ? s.arrived : 0, processed = s ? Math.min(s.processed, arrived) : 0;
        out.push({ cohort: c, tick: c * COHORT_TICKS + 1, arrived, processed, pct: arrived > 0 ? (100 * processed) / arrived : null });
      }
      return out;
    }

    // ---------- dispatcher ----------
    isIdle(w) { return w.bundle === null && w.offlineUntil < this.tick; }

    assign(w, bundle) {
      w.bundle = bundle;
      bundle.dispatchedTick = this.tick;
      this.totals.bundlesDispatched++;
      this.events.push({ type: 'dispatch', worker: w.id, size: bundle.size });
    }

    // Hand as many queued bundles as possible to workers. Returns count.
    dispatchQueued() {
      const ws = this.workers, q = this.dispatcher;
      if (!q.length) return 0;
      let n = 0;
      if (this.config.routing === 'sticky') {
        // A bundle waits for its own worker, which may be busy or even offline.
        for (let i = 0; i < q.length;) {
          const b = q[i], w = ws[b.worker];
          if (w && w.bundle === null) { this.assign(w, b); q.splice(i, 1); n++; }
          else i++;
        }
        return n;
      }
      if (this.config.routing === 'roundRobin') {
        const N = ws.length;
        let scanned = 0;
        while (q.length && scanned < N) {
          const w = ws[this.rrCursor % N];
          this.rrCursor = (this.rrCursor + 1) % N;
          scanned++;
          if (this.isIdle(w)) { this.assign(w, q.shift()); n++; scanned = 0; }
        }
        return n;
      }
      // idle: random idle online worker
      const idle = [];
      for (const w of ws) if (this.isIdle(w)) idle.push(w);
      while (q.length && idle.length) {
        const k = this.rng.int(idle.length);
        const w = idle[k];
        idle[k] = idle[idle.length - 1]; idle.pop();
        this.assign(w, q.shift()); n++;
      }
      return n;
    }

    // ---------- the tick ----------
    step() {
      const cfg = this.config;
      this.tick++;
      this.events = [];
      const t = this.tick;

      this.expireIncidents();
      const mods = this.activeModifiers();

      // 1. Arrivals
      let lambda = cfg.arrivalRate * mods.arrivalMult;
      if (cfg.waveAmplitude > 0) {
        lambda *= 1 + cfg.waveAmplitude * Math.sin((2 * Math.PI * t) / cfg.wavePeriod);
      }
      const arrivals = this.rng.poisson(lambda);
      this.totals.arrived += arrivals;
      this.addArrivals(mods.holdArrivals ? this.held : this.intake, arrivals);

      // 2. Dispatch what was already queued, then bundle while the dispatcher
      //    has room, handing bundles straight through to idle workers.
      let dispatched = this.dispatchQueued();
      let cut = 0;
      const room = () => this.dispatcher.length < cfg.dispatcherCapacity;
      while (this.intake.items >= cfg.bundleSize && room()) {
        this.dispatcher.push(this.cutBundle(cfg.bundleSize));
        cut++;
        dispatched += this.dispatchQueued();
      }
      if (this.intake.items > 0 && room() && t - this.intake.oldestTick >= cfg.bundleMaxWait) {
        this.dispatcher.push(this.cutBundle(this.intake.items));
        cut++;
        dispatched += this.dispatchQueued();
      }

      // 3. Processing: one bundle per worker
      let processed = 0, busy = 0, offline = 0;
      const latencies = [];
      for (const w of this.workers) {
        if (w.offlineUntil >= t) {
          offline++; w.lastRate = 0; w.lastWorked = 0;
          continue;
        }
        const rate = sampleRate(this.rng, cfg.dist) * w.speed * mods.rateMult;
        w.lastRate = rate;
        w.lastWorked = 0;
        const b = w.bundle;
        if (!b) continue;
        busy++;
        const take = Math.min(rate, b.remaining);
        b.remaining -= take;
        this.creditProcessed(b, take);
        w.lastWorked = take;
        w.processed += take;
        processed += take;
        if (b.remaining <= 1e-9) {
          w.bundle = null;
          w.completed++;
          latencies.push(t - b.createdTick);
          this.totals.bundlesCompleted++;
          this.events.push({ type: 'complete', worker: w.id });
        }
      }
      this.totals.processed += processed;

      const snap = this.snapshot(arrivals, dispatched, processed, busy, latencies, offline, cut);
      this.history.push(snap);
      if (this.history.length > cfg.historyLength) this.history.shift();
      this.last = snap;
      return snap;
    }

    snapshot(arrivals, dispatched, processed, busy, latencies, offline, cut) {
      const t = this.tick;
      let inProgress = 0, oldest = null, maxAge = 0;
      for (const w of this.workers) {
        if (!w.bundle) continue;
        inProgress += w.bundle.remaining;
        if (oldest === null || w.bundle.createdTick < oldest) oldest = w.bundle.createdTick;
        const age = t - w.bundle.dispatchedTick;
        if (age > maxAge) maxAge = age;
      }
      let queuedItems_ = 0;
      for (const b of this.dispatcher) {
        queuedItems_ += b.remaining;
        if (oldest === null || b.createdTick < oldest) oldest = b.createdTick;
      }
      if (this.intake.items > 0 && (oldest === null || this.intake.oldestTick < oldest)) oldest = this.intake.oldestTick;
      if (this.held.items > 0 && (oldest === null || this.held.oldestTick < oldest)) oldest = this.held.oldestTick;
      latencies.sort((a, b) => a - b);
      const pct = p => latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))] : null;
      const n = this.workers.length;
      const bundleTicks = expectedBundleTicksCached(this.config.dist, this.config.bundleSize);
      const capacity = (n * this.config.bundleSize) / bundleTicks;
      offline = offline || 0;
      return {
        tick: t,
        arrivals, dispatched, processed, cut: cut || 0,
        backlogItems: inProgress + queuedItems_ + this.intake.items + this.held.items,
        inProgressItems: inProgress,
        dispatcherItems: queuedItems_,
        dispatcherQueued: this.dispatcher.length,
        dispatcherCapacity: this.config.dispatcherCapacity,
        intakeItems: this.intake.items, heldItems: this.held.items,
        oldestAge: oldest === null ? 0 : t - oldest,
        maxBundleAge: maxAge,
        latencyP50: pct(0.5), latencyP95: pct(0.95), latencyMax: latencies.length ? latencies[latencies.length - 1] : null,
        latencies,
        completedBundles: latencies.length,
        busy, offline, idle: n - busy - offline,
        utilization: n - offline > 0 ? busy / (n - offline) : 0,
        expectedBundleTicks: bundleTicks,
        nominalCapacity: capacity,
        load: this.config.arrivalRate / Math.max(1e-9, capacity),
      };
    }
  }

  let _btKey = null, _btVal = 0;
  function expectedBundleTicksCached(dist, bundleSize) {
    const key = JSON.stringify(dist) + '|' + bundleSize;
    if (key !== _btKey) { _btKey = key; _btVal = expectedBundleTicks(dist, bundleSize); }
    return _btVal;
  }

  return {
    Simulation, DEFAULTS, DISTRIBUTIONS, ROUTING, COHORT_TICKS, makeRng, sampleRate,
    expectedRate, expectedBundleTicks: expectedBundleTicksCached,
  };
});
