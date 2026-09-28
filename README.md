# Pipeline Simulator

An interactive, dependency-free simulation of a streaming conversion pipeline.
Conversions (sign-ups, purchases after an ad) arrive at a configurable rate, are
bundled, and fan out to a pool of workers. Each tick every worker completes a
random fraction of a bundle, drawn from a distribution you control. Turn the
knobs, inject delays, and watch backlogs form and clear.

**Run it:** open `index.html` in a browser, or `npm start` to serve it on
<http://localhost:8080>. No build step, no dependencies.

## What you see

- **Flow stage** – a source, a bundler, a grid of workers (100 by default, up to
  400) and a "done" sink. Each cell's colour is its queue depth on a single-hue
  ramp; the white bar at the bottom is progress on the bundle it is working on;
  hatched cells are offline. Dots animate bundles being dispatched and completed.
  Hover a cell for its queue, current bundle, last-tick rate and speed factor.
- **KPI row** – backlog (with change over the last 60 ticks), age of the oldest
  unprocessed conversion, p50/p95 latency of recently completed bundles,
  arrivals and throughput per tick against expected capacity, and worker
  utilisation.
- **Charts** – backlog over time, arrivals vs throughput vs capacity, latency
  percentiles, and busy share. Hover for exact values per tick.

## Knobs

| Group | Control | Effect |
|---|---|---|
| Incoming load | Arrival rate | Mean conversions per tick (Poisson). |
| | Traffic wave | Sinusoidal modulation of the arrival rate (± percent). |
| | Bundle size | Conversions per bundle. |
| | Partial-bundle flush | Ticks a partial bundle waits before being sent anyway. |
| Worker pool | Workers | Pool size; can be changed live. |
| | Routing | Least loaded (health-aware), round robin, or random (hash-partition-like). |
| | Worker heterogeneity | Spread of a permanent per-worker speed multiplier. |
| Processing rate | Distribution | Normal, uniform, log-normal (heavy tail) or bimodal (fast + slow mode). |
| | Mean / std. deviation | Fraction of a bundle completed per tick; samples are clamped to 0–100%. |
| Incidents | Traffic spike | Multiply arrivals for N ticks. |
| | Slow workers | Multiply every worker's rate for N ticks. |
| | Worker outage | Take a percentage of workers offline for N ticks. |
| | Upstream delay | Hold arrivals for N ticks, then release them all at once. |

Presets: **Healthy** (ρ ≈ 0.8), **Overloaded** (ρ ≈ 1.2), **Slow tail**
(bimodal rate), **Hot partitions** (random routing + uneven workers) and
**Bursty traffic**. Space toggles play/pause, `s` or → steps one tick.

## The model

1. **Arrivals** per tick ~ Poisson(λ), where λ is the arrival rate times any
   active spike multiplier and the traffic wave.
2. **Bundling**: the intake buffer is cut into bundles of the configured size as
   soon as enough conversions are present; a leftover partial bundle is flushed
   after the max-wait.
3. **Routing** places each bundle on one worker's queue. Least-loaded picks the
   online worker with the fewest queued conversions; round robin and random keep
   assigning to offline workers, as a static partition assignment would.
4. **Processing**: each tick every online worker draws a rate `r` from the
   distribution, multiplies by its speed factor and any slowdown, clamps to
   [0, 1], and completes `r × bundleSize` conversions from the front of its
   queue, spilling into the next bundle when one finishes.
5. **Capacity** = workers × E[r] × bundleSize. The load ratio ρ = arrivals ÷
   capacity is shown live; above 1 the backlog grows without bound, and as ρ
   approaches 1 from below latency climbs steeply even though the system is
   "keeping up" on average.
6. **Latency** of a bundle is measured from the tick its oldest conversion
   arrived to the tick it finished.

Everything is driven by a seeded PRNG, so a given seed plus the same sequence of
clicks reproduces the same run.

## Development

```
npm test        # model tests (node --test)
npm start       # serve locally
```

- `js/sim.js` – the model. Pure JavaScript, no DOM; loads as a browser global
  and as a CommonJS module for the tests.
- `js/charts.js` – small canvas line chart with crosshair tooltip.
- `js/main.js` – controls, stage rendering, KPIs.
- `test/sim.test.js` – conservation, determinism, stability under/over load,
  incidents, distribution means.

A GitHub Pages workflow (`.github/workflows/pages.yml`) publishes the site from
the default branch once Pages is enabled for the repository with "GitHub
Actions" as the source.

## License

[MIT](LICENSE). Use it for anything; keep the copyright notice.
