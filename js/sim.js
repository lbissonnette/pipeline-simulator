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
  // Log-normal draw with the given mean and sd (sd 0 returns the mean).
  function sampleLognormal(rng, mean, sd) {
    if (mean <= 0) return 0;
    if (sd <= 0) return mean;
    const sigma2 = Math.log(1 + (sd / mean) ** 2);
    return Math.exp(Math.log(mean) - sigma2 / 2 + Math.sqrt(sigma2) * rng.gaussian());
  }

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
  // tick (1/s), so a bundle of 1,200 takes ~120 ticks (20 min) of work plus
  // expensive-conversion stalls (1.8 per bundle on average, 2 ± 3 min each,
  // capped at 4 h), for an end-to-end median of ~23 min (p99 ~45 min).
  // 1,024 identical workers (a 32 x 32 grid) give ~8,600 conversions per tick.
  const DEFAULTS = {
    workers: 1024,
    arrivalRate: 6900,         // mean conversions per tick (Poisson), rho ~0.8
    waveAmplitude: 0,          // 0..1 modulation of arrivals
    wavePeriod: 8640,          // ticks per wave (24 h at 10 s per tick)
    bundleSize: 1200,          // conversions per bundle (20 min at 10/tick)
    bundleMaxWait: 30,         // flush a partial bundle after this many ticks (5 min)
    dispatcherCapacity: 10,    // bundles the dispatcher can hold
    routing: 'lowestIdle',     // lowestIdle | idle | roundRobin | sticky
    dist: { type: 'normal', mean: 10, sd: 2.5, slowFraction: 0.2, slowFactor: 0.25 }, // conversions / tick / worker
    // Expensive conversions: a small share of conversions each cost a fixed
    // extra processing time. A bundle holding k of them stalls k x cost ticks.
    expensiveFraction: 0.0015, // share of conversions that are expensive (0.15%, ~1.8 per bundle)
    expensiveCost: 12,         // mean extra ticks per expensive conversion (2 min)
    expensiveCostSd: 18,       // sd of that cost (log-normal), 3 min
    expensiveCostCap: 1440,    // no single stall longer than this (4 h), like a timeout
    historyLength: 4320,       // 12 h
    completionRetention: 7 * 24 * 360, // keep bundle completions for 7 days
    seed: 42,
  };

  const ROUTING = {
    idle: 'Any idle worker',
    lowestIdle: 'Lowest idle index (first fit)',
    roundRobin: 'Round robin over idle workers',
    sticky: 'Sticky partition (bundle waits for its worker)',
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  const COHORT_TICKS = 6;          // ticks per arrival cohort (1 minute at 10 s/tick)
  const COHORT_HISTORY = 24 * 60;  // cohorts kept for the completeness view (24 h)
  const FRESH_LEVELS = [50, 90, 99];
  const FRESH_WINDOW = 3;          // cohorts per fresh-time window (3 minutes)
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
      this.completions = [];      // { tick, latency, size } per finished bundle, oldest first
      this.completionsHead = 0;   // index of the oldest retained completion
      this.fresh = null;          // cached freshTimes(), refreshed every cohort
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
        if (!w.bundle) continue;
        // hand its work back: to the dispatcher if there is room, else to the
        // front of the intake buffer (keeping the conversions' arrival minutes)
        if (this.dispatcher.length < this.config.dispatcherCapacity) this.dispatcher.unshift(w.bundle);
        else this.returnToIntake(w.bundle);
      }
      while (ws.length < n) {
        ws.push({
          id: ws.length, bundle: null, offlineUntil: -1,
          degradations: [],   // { id, factor, until } from active incidents
          lastRate: 0, lastWorked: 0, processed: 0, completed: 0,
        });
      }
      this.config.workers = n;
      if (this.config.routing === 'sticky') {
        for (const b of this.dispatcher) if (b.worker >= n) b.worker = this.rng.int(n);
      }
    }

    update(partial) {
      const prev = this.config;
      const next = Object.assign({}, prev, partial);
      if (partial.dist) next.dist = Object.assign({}, prev.dist, partial.dist);
      this.config = next;
      if (partial.workers !== undefined && partial.workers !== this.workers.length) {
        this.applyWorkerCount(partial.workers, false);
      }
      if (partial.routing === 'sticky' && prev.routing !== 'sticky') {
        for (const b of this.dispatcher) if (b.worker === null) b.worker = this.rng.int(this.workers.length);
      }
    }

    // ---------- incidents ----------
    // type: 'spike'         magnitude = arrival multiplier
    //       'degrade'       magnitude = { factor, fraction, selection }: a
    //                       `fraction` of workers run at `factor` x their rate;
    //                       factor 0 is a full outage (offline, skipped by idle
    //                       routing). selection 'lowest' (default) takes the
    //                       lowest indices, 'random' picks them at random.
    //       'upstreamDelay' arrivals are held until the incident ends
    //       'outage' / 'slowdown' are kept as shorthands for 'degrade'
    addIncident(type, magnitude, duration) {
      if (type === 'outage') { type = 'degrade'; magnitude = { factor: 0, fraction: magnitude }; }
      else if (type === 'slowdown') { type = 'degrade'; magnitude = { factor: magnitude, fraction: 1 }; }
      const inc = {
        id: this.nextIncidentId++, type, magnitude, duration,
        start: this.tick + 1, end: this.tick + duration, workers: [],
      };
      if (type === 'degrade') {
        const factor = Math.max(0, magnitude.factor);
        const count = Math.round(this.workers.length * Math.min(1, Math.max(0, magnitude.fraction)));
        const ids = this.workers.map(w => w.id);
        inc.selection = magnitude.selection === 'random' ? 'random' : 'lowest';
        if (inc.selection === 'random') {
          for (let i = ids.length - 1; i > 0; i--) {
            const j = this.rng.int(i + 1);
            [ids[i], ids[j]] = [ids[j], ids[i]];
          }
        }
        inc.workers = ids.slice(0, count);
        inc.factor = factor;
        for (const id of inc.workers) {
          const w = this.workers[id];
          w.degradations.push({ id: inc.id, factor, until: inc.end });
          if (factor === 0) w.offlineUntil = Math.max(w.offlineUntil, inc.end);
        }
      }
      this.incidents.push(inc);
      return inc;
    }

    cancelIncident(id) {
      const inc = this.incidents.find(i => i.id === id);
      if (!inc) return;
      if (inc.type === 'degrade') {
        for (const wid of inc.workers) {
          const w = this.workers[wid];
          if (!w) continue;
          w.degradations = w.degradations.filter(d => d.id !== id);
          // offline only while some remaining zero-factor degradation covers this worker
          w.offlineUntil = w.degradations.reduce((m, d) => d.factor === 0 ? Math.max(m, d.until) : m, -1);
        }
      }
      if (inc.type === 'upstreamDelay') this.releaseHeld();
      this.incidents = this.incidents.filter(i => i.id !== id);
    }

    activeModifiers() {
      let arrivalMult = 1, holdArrivals = false;
      for (const inc of this.incidents) {
        if (inc.type === 'spike') arrivalMult *= inc.magnitude;
        else if (inc.type === 'upstreamDelay') holdArrivals = true;
      }
      return { arrivalMult, holdArrivals };
    }

    // Product of the factors of the degradations still covering the worker.
    degradeFactor(w) {
      if (!w.degradations.length) return 1;
      let f = 1, live = false;
      for (const d of w.degradations) {
        if (d.until >= this.tick) { f *= d.factor; live = true; }
      }
      if (!live) w.degradations = [];
      return f;
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
        // count: conversions of this cohort not yet worked through; total: in the bundle
        cohorts.push({ cohort: head.cohort, count: take, total: take, firstTick: head.firstTick });
        head.count -= take; need -= take;
        if (head.count <= 1e-9) q.shift();
      }
      // expensive conversions: how many, and where in the bundle they sit
      const cfg = this.config;
      const k = cfg.expensiveFraction > 0 ? Math.min(Math.round(size), this.rng.poisson(size * cfg.expensiveFraction)) : 0;
      const stalls = [];
      for (let i = 0; i < k; i++) {
        stalls.push({ at: this.rng.uniform() * size, cost: Math.min(cfg.expensiveCostCap, sampleLognormal(this.rng, cfg.expensiveCost, cfg.expensiveCostSd)) });
      }
      stalls.sort((x, y) => x.at - y.at);
      const b = {
        id: this.nextBundleId++, size, remaining: size,
        cohorts, cursor: 0,                       // cursor: index of the cohort being processed
        createdTick: cohorts.length ? cohorts[0].firstTick : this.tick,
        cutTick: this.tick, dispatchedTick: null,
        worker: cfg.routing === 'sticky' ? this.rng.int(this.workers.length) : null,
        expensive: k, stalls, stallLeft: 0,       // stall points { at, cost } and ticks left in the current stall
        extraTicks: stalls.reduce((s, x) => s + x.cost, 0),
      };
      this.intake.items -= size;
      if (this.intake.items <= 1e-9 || !q.length) { this.intake.items = 0; this.intake.oldestTick = null; this.intake.cohorts = []; }
      else this.intake.oldestTick = q[0].firstTick;
      this.totals.bundlesCut++;
      this.events.push({ type: 'bundle', size });
      return b;
    }

    // Put a bundle's unprocessed conversions back at the front of the intake buffer.
    // The part already worked through counts as processed for its cohorts.
    returnToIntake(b) {
      const back = [];
      for (const c of b.cohorts) {
        const done = c.total - c.count;
        if (done > 1e-9) { const stat = this.cohorts.get(c.cohort); if (stat) stat.processed += done; }
        if (c.count > 1e-9) back.push({ cohort: c.cohort, count: c.count, firstTick: c.firstTick });
      }
      if (!back.length) return;
      this.intake.cohorts = back.concat(this.intake.cohorts);
      this.intake.items += b.remaining;
      this.intake.oldestTick = this.intake.cohorts[0].firstTick;
    }

    // Track how far the worker has got through the bundle's cohorts (oldest
    // first). This does NOT count as processed for completeness: a bundle is
    // written out atomically, so its cohorts are credited only when it completes.
    creditProcessed(b, amount) {
      let left = amount;
      while (left > 1e-9 && b.cursor < b.cohorts.length) {
        const c = b.cohorts[b.cursor];
        const take = Math.min(left, c.count);
        c.count -= take; left -= take;
        if (c.count <= 1e-9) b.cursor++;
      }
    }

    // Bundle written out: every conversion in it is now complete for its cohort.
    creditCompleted(b) {
      for (const c of b.cohorts) {
        const stat = this.cohorts.get(c.cohort);
        if (stat) stat.processed += c.total;
      }
    }

    // Drop completions older than the retention window. A moving head index
    // avoids shifting a large array every tick.
    pruneCompletions() {
      const cutoff = this.tick - this.config.completionRetention;
      const c = this.completions;
      while (this.completionsHead < c.length && c[this.completionsHead].tick <= cutoff) this.completionsHead++;
      if (this.completionsHead > 20000) {
        this.completions = c.slice(this.completionsHead);
        this.completionsHead = 0;
      }
    }

    // Bundle completions within the last `windowTicks`, oldest first.
    latencySamples(windowTicks) {
      const cutoff = this.tick - windowTicks;
      const c = this.completions;
      let i = this.completionsHead;
      while (i < c.length && c[i].tick <= cutoff) i++;
      return c.slice(i);
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

    // "Fresh time" at percentile levels. Slide a window of `windowCohorts`
    // arrival minutes from oldest to newest; a window's completeness is
    // processed / arrived over those minutes. The P<L> fresh time is the age
    // (ticks since the window's oldest minute began) of the oldest window that
    // is less than L% complete. 0 means every window is at least L% complete.
    freshTimes(levels, windowCohorts) {
      levels = levels || FRESH_LEVELS;
      windowCohorts = windowCohorts || FRESH_WINDOW;
      const now = cohortOf(Math.max(1, this.tick));
      const oldest = Math.max(0, now - COHORT_HISTORY + 1);
      const result = {};
      const pending = new Set(levels);
      let sa = 0, sp = 0;
      const q = [];
      for (let c = oldest; c <= now && pending.size; c++) {
        const s = this.cohorts.get(c);
        const a = s ? s.arrived : 0, p = s ? Math.min(s.processed, a) : 0;
        q.push([a, p]); sa += a; sp += p;
        if (q.length > windowCohorts) { const [da, dp] = q.shift(); sa -= da; sp -= dp; }
        if (q.length < windowCohorts || sa <= 0) continue;
        const pct = (100 * sp) / sa;
        const age = this.tick - (c - windowCohorts + 1) * COHORT_TICKS;
        for (const L of Array.from(pending)) {
          if (pct < L) { result[L] = age; pending.delete(L); }
        }
      }
      for (const L of pending) result[L] = 0;
      return result;
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
      if (this.config.routing === 'lowestIdle') {
        for (let i = 0; i < ws.length && q.length; i++) {
          if (this.isIdle(ws[i])) { this.assign(ws[i], q.shift()); n++; }
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
      let processed = 0, busy = 0, offline = 0, slowed = 0, stalled = 0;
      const latencies = [];
      for (const w of this.workers) {
        if (w.offlineUntil >= t) {
          offline++; w.lastRate = 0; w.lastWorked = 0;
          continue;
        }
        const factor = this.degradeFactor(w);
        if (factor < 1) slowed++;
        const rate = sampleRate(this.rng, cfg.dist) * factor;
        w.lastRate = rate;
        w.lastWorked = 0;
        const b = w.bundle;
        if (!b) continue;
        busy++;
        // stalled on an expensive conversion: the stall burns wall-clock ticks
        // (a degraded worker burns them proportionally slower)
        if (b.stallLeft > 0) {
          b.stallLeft -= factor;
          w.lastRate = 0;
          stalled++;
          continue;
        }
        let take = Math.min(rate, b.remaining);
        const done = b.size - b.remaining;
        if (b.stalls.length && done + take >= b.stalls[0].at) {
          // reach the expensive conversion, then stall for its cost
          take = Math.max(0, Math.min(take, b.stalls[0].at - done));
          b.stallLeft = b.stalls.shift().cost;
        }
        b.remaining -= take;
        this.creditProcessed(b, take);
        w.lastWorked = take;
        w.processed += take;
        processed += take;
        if (b.remaining <= 1e-9) {
          w.bundle = null;
          w.completed++;
          this.creditCompleted(b);
          latencies.push(t - b.createdTick);
          this.completions.push({ tick: t, latency: t - b.createdTick, size: b.size, expensive: b.expensive, extraTicks: b.extraTicks });
          this.totals.bundlesCompleted++;
          this.events.push({ type: 'complete', worker: w.id });
        }
      }
      this.totals.processed += processed;

      if (!this.fresh || t % COHORT_TICKS === 0) this.fresh = this.freshTimes();
      this.pruneCompletions();

      const snap = this.snapshot(arrivals, dispatched, processed, busy, latencies, offline, cut, slowed, stalled);
      this.history.push(snap);
      if (this.history.length > cfg.historyLength) this.history.shift();
      this.last = snap;
      return snap;
    }

    // Expected ticks per bundle: the rate-driven part (by simulation) plus the
    // mean stall time from expensive conversions.
    expectedBundleTicks() {
      const cfg = this.config;
      // the cap trims a little off the mean cost; ignored here (well under 1% for the defaults)
      return expectedBundleTicksCached(cfg.dist, cfg.bundleSize) + cfg.bundleSize * cfg.expensiveFraction * cfg.expensiveCost;
    }

    snapshot(arrivals, dispatched, processed, busy, latencies, offline, cut, slowed, stalled) {
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
      const bundleTicks = this.expectedBundleTicks();
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
        fresh50: this.fresh ? this.fresh[50] : 0,
        fresh90: this.fresh ? this.fresh[90] : 0,
        fresh99: this.fresh ? this.fresh[99] : 0,
        completedBundles: latencies.length,
        busy, offline, slowed: slowed || 0, stalled: stalled || 0, idle: n - busy - offline,
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
    Simulation, DEFAULTS, DISTRIBUTIONS, ROUTING, COHORT_TICKS, FRESH_LEVELS, FRESH_WINDOW, makeRng, sampleRate, sampleLognormal,
    expectedRate, expectedBundleTicks: expectedBundleTicksCached,
  };
});
