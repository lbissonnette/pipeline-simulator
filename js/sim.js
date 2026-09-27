/*
 * Pipeline simulator — pure model, no DOM.
 *
 * Conversions arrive each tick, are bundled, and dispatched to a pool of
 * workers. Every tick each worker draws a processing rate from a configurable
 * distribution and completes that fraction of a bundle's worth of items from
 * the front of its queue (spilling into the next bundle if it finishes one).
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
        // normal approximation for large means
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
  // Every distribution is parameterised by a mean and sd (fraction of a bundle
  // per tick) so the same two sliders drive all of them.
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

  function sampleRate(rng, dist) {
    const impl = DISTRIBUTIONS[dist.type] || DISTRIBUTIONS.normal;
    const r = impl.sample(rng, dist);
    // A worker cannot do negative work, nor more than one full bundle per tick.
    return r < 0 ? 0 : r > 1 ? 1 : r;
  }

  // Expected rate after clamping, estimated by sampling (cheap and exact enough).
  function expectedRate(dist, seed) {
    const rng = makeRng(seed || 12345);
    const n = 4000;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += sampleRate(rng, dist);
    return sum / n;
  }

  // ---------- defaults ----------
  const DEFAULTS = {
    workers: 100,
    arrivalRate: 400,          // mean conversions per tick (Poisson)
    waveAmplitude: 0,          // 0..1 diurnal-style modulation of arrivals
    wavePeriod: 300,           // ticks per wave
    bundleSize: 25,            // conversions per bundle
    bundleMaxWait: 2,          // flush a partial bundle after this many ticks
    routing: 'leastLoaded',    // leastLoaded | roundRobin | random
    dist: { type: 'normal', mean: 0.2, sd: 0.05, slowFraction: 0.2, slowFactor: 0.25 },
    heterogeneity: 0,          // sd of per-worker permanent speed multiplier
    historyLength: 900,
    seed: 42,
  };

  const ROUTING = {
    leastLoaded: 'Least loaded (health-aware)',
    roundRobin: 'Round robin',
    random: 'Random (hash partition)',
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

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
      this.intake = { items: 0, oldestTick: null };
      this.held = { items: 0, oldestTick: null };   // upstream-delay holding area
      this.incidents = [];
      this.nextIncidentId = 1;
      this.totals = { arrived: 0, processed: 0, bundlesDispatched: 0, bundlesCompleted: 0 };
      this.history = [];
      this.events = [];   // per-tick dispatch events for the renderer
      this.workers = [];
      this.applyWorkerCount(this.config.workers, true);
      this.last = this.snapshot(0, 0, 0, 0, []);
    }

    applyWorkerCount(n, fresh) {
      const ws = this.workers;
      while (ws.length > n) ws.pop();
      while (ws.length < n) {
        ws.push({
          id: ws.length, queue: [], speed: 1, offlineUntil: -1,
          lastRate: 0, lastWorked: 0, processed: 0,
        });
      }
      if (fresh) this.regenerateSpeeds();
      this.config.workers = n;
    }

    regenerateSpeeds() {
      const h = this.config.heterogeneity;
      const srng = makeRng(this.config.seed ^ 0x9e3779b9);
      for (const w of this.workers) {
        const s = 1 + h * srng.gaussian();
        w.speed = Math.min(3, Math.max(0.1, s));
      }
    }

    // Live config changes. Structural ones (worker count, heterogeneity) are
    // handled specially so the running simulation keeps its state.
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
    }

    // ---------- incidents ----------
    // type: 'spike' (arrival multiplier), 'slowdown' (rate multiplier),
    //       'outage' (fraction of workers offline), 'upstreamDelay' (arrivals held)
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
        for (const wid of inc.workers) this.workers[wid].offlineUntil = -1;
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
        this.addToIntake(this.held.items, this.held.oldestTick);
        this.held = { items: 0, oldestTick: null };
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
    addToIntake(n, tickOfOldest) {
      if (n <= 0) return;
      if (this.intake.items === 0 || this.intake.oldestTick === null) {
        this.intake.oldestTick = tickOfOldest;
      } else {
        this.intake.oldestTick = Math.min(this.intake.oldestTick, tickOfOldest);
      }
      this.intake.items += n;
    }

    cutBundle(size) {
      const b = {
        id: this.nextBundleId++, size, remaining: size,
        createdTick: this.intake.oldestTick, dispatchedTick: this.tick,
      };
      this.intake.items -= size;
      if (this.intake.items <= 0) { this.intake.items = 0; this.intake.oldestTick = null; }
      else this.intake.oldestTick = this.tick; // approximation: leftovers are "fresh"
      return b;
    }

    pickWorker() {
      const ws = this.workers;
      const routing = this.config.routing;
      if (routing === 'random') return ws[this.rng.int(ws.length)];
      if (routing === 'roundRobin') {
        const w = ws[this.rrCursor % ws.length];
        this.rrCursor = (this.rrCursor + 1) % ws.length;
        return w;
      }
      // leastLoaded: fewest queued items among online workers; random tie-break
      let best = null, bestLoad = Infinity, ties = 0;
      for (const w of ws) {
        if (w.offlineUntil >= this.tick) continue;
        const load = queuedItems(w);
        if (load < bestLoad) { best = w; bestLoad = load; ties = 1; }
        else if (load === bestLoad) { ties++; if (this.rng.uniform() < 1 / ties) best = w; }
      }
      return best || ws[this.rng.int(ws.length)];
    }

    dispatch(bundle) {
      const w = this.pickWorker();
      w.queue.push(bundle);
      this.totals.bundlesDispatched++;
      this.events.push({ type: 'dispatch', worker: w.id, size: bundle.size });
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
      if (mods.holdArrivals) {
        if (this.held.items === 0) this.held.oldestTick = t;
        this.held.items += arrivals;
      } else {
        this.addToIntake(arrivals, t);
      }

      // 2. Bundling + dispatch
      let dispatched = 0;
      while (this.intake.items >= cfg.bundleSize) {
        this.dispatch(this.cutBundle(cfg.bundleSize));
        dispatched++;
      }
      if (this.intake.items > 0 && t - this.intake.oldestTick >= cfg.bundleMaxWait) {
        this.dispatch(this.cutBundle(this.intake.items));
        dispatched++;
      }

      // 3. Processing
      let processed = 0, busy = 0, offline = 0, capacityAvailable = 0;
      const latencies = [];
      for (const w of this.workers) {
        if (w.offlineUntil >= t) {
          offline++; w.lastRate = 0; w.lastWorked = 0;
          continue;
        }
        if (w.queue.length) busy++;
        let rate = sampleRate(this.rng, cfg.dist) * w.speed * mods.rateMult;
        if (rate > 1) rate = 1;
        w.lastRate = rate;
        let capacity = rate * cfg.bundleSize;
        capacityAvailable += capacity;
        let worked = 0;
        while (capacity > 1e-9 && w.queue.length) {
          const b = w.queue[0];
          const take = Math.min(capacity, b.remaining);
          b.remaining -= take; capacity -= take; worked += take;
          if (b.remaining <= 1e-9) {
            w.queue.shift();
            latencies.push(t - b.createdTick);
            this.totals.bundlesCompleted++;
          }
        }
        w.lastWorked = worked;
        w.processed += worked;
        processed += worked;
      }
      this.totals.processed += processed;

      const snap = this.snapshot(arrivals, dispatched, processed, busy, latencies, offline, capacityAvailable);
      this.history.push(snap);
      if (this.history.length > cfg.historyLength) this.history.shift();
      this.last = snap;
      return snap;
    }

    snapshot(arrivals, dispatched, processed, busy, latencies, offline, capacityAvailable) {
      const t = this.tick;
      let queuedItems_ = 0, queuedBundles = 0, oldest = null, maxQueue = 0;
      for (const w of this.workers) {
        let q = 0;
        for (const b of w.queue) {
          q += b.remaining;
          if (oldest === null || b.createdTick < oldest) oldest = b.createdTick;
        }
        queuedItems_ += q;
        queuedBundles += w.queue.length;
        if (q > maxQueue) maxQueue = q;
      }
      if (this.intake.items > 0 && (oldest === null || this.intake.oldestTick < oldest)) oldest = this.intake.oldestTick;
      if (this.held.items > 0 && (oldest === null || this.held.oldestTick < oldest)) oldest = this.held.oldestTick;
      latencies.sort((a, b) => a - b);
      const pct = p => latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))] : null;
      const n = this.workers.length;
      const expected = expectedRateCached(this.config.dist);
      return {
        tick: t,
        arrivals, dispatched, processed,
        backlogItems: queuedItems_ + this.intake.items + this.held.items,
        queuedItems: queuedItems_, queuedBundles,
        intakeItems: this.intake.items, heldItems: this.held.items,
        maxQueue,
        oldestAge: oldest === null ? 0 : t - oldest,
        latencyP50: pct(0.5), latencyP95: pct(0.95), latencyMax: latencies.length ? latencies[latencies.length - 1] : null,
        completedBundles: latencies.length,
        busy, offline: offline || 0, idle: n - busy - (offline || 0),
        utilization: n - (offline || 0) > 0 ? busy / (n - (offline || 0)) : 0,
        capacityAvailable: capacityAvailable || 0,
        // Long-run expected capacity in items/tick with all workers online.
        nominalCapacity: n * expected * this.config.bundleSize,
        load: this.config.arrivalRate / Math.max(1e-9, n * expected * this.config.bundleSize),
      };
    }
  }

  function queuedItems(w) {
    let q = 0;
    for (const b of w.queue) q += b.remaining;
    return q;
  }

  // Memoise expected clamped rate per distribution parameter set.
  let _erKey = null, _erVal = 0;
  function expectedRateCached(dist) {
    const key = JSON.stringify(dist);
    if (key !== _erKey) { _erKey = key; _erVal = expectedRate(dist); }
    return _erVal;
  }

  return { Simulation, DEFAULTS, DISTRIBUTIONS, ROUTING, makeRng, sampleRate, expectedRate, queuedItems };
});
