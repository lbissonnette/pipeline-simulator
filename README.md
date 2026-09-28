# Pipeline Simulator

An interactive, dependency-free simulation of a streaming conversion pipeline.
Conversions (sign-ups, purchases after an ad) arrive at a configurable rate, are
cut into bundles, queue at a bounded dispatcher, and are handed one at a time to
a pool of 1,000 workers. Each tick (10 seconds) every busy worker completes a
random number of conversions, drawn from a distribution you control; with the
defaults a bundle takes about two hours. Turn the knobs, inject delays, and
watch backlogs form and clear.

Live: <https://lbissonnette.github.io/pipeline-simulator/>

**Run it:** open `index.html` in a browser, or `npm start` to serve it on
<http://localhost:8080>. No build step, no dependencies.

## What you see

- **Flow stage** – a source, a bundler, a dispatcher, a grid of workers (1,000
  by default, up to 2,000) and a "done" sink. Each busy cell's colour is how
  long it has been working on its bundle (light = fresh, dark = twice the
  expected bundle time); the white bar at the bottom is progress on that
  bundle; hatched cells are offline. The dispatcher turns red when its queue is full and the
  bundler shows "blocked". Dots animate bundles moving between stages. Hover a
  cell for its current bundle, last-tick rate and speed factor.
- **KPI row** – backlog (with change over the past hour), age of the oldest
  unprocessed conversion, p50/p95 end-to-end latency over a 30-minute window,
  arrivals and throughput per tick against expected capacity, dispatcher queue
  depth, and worker utilisation.
- **Completeness by arrival minute** – for each simulated minute on the same
  12-hour horizon as the other charts, the share of conversions that arrived in
  that minute which have been processed so far. Older minutes sit at 100%, the newest near 0%, and the
  slope between them is the processing front; incidents leave dents that
  persist until those cohorts catch up. The header shows the most recent
  minute through which everything is at least 99% complete. Hover for the
  minute's arrived and processed counts.
- **Fresh time** – P50, P90 and P99 over time. A 3-minute window slides over
  the arrival minutes; each window's completeness is processed ÷ arrived across
  its three minutes. The P99 fresh time is the age of the oldest window still
  below 99% complete (P90 and P50 likewise), counted from the start of the
  window's oldest minute. Recomputed every simulated minute; 0 means every
  window has passed that threshold. Under the Healthy preset it settles near
  P50 1h, P90 1h48m, P99 2h.
- **Charts** – the last 12 simulated hours of backlog, arrivals vs throughput
  vs capacity, latency percentiles, dispatcher queue depth, and busy share.
  Hover for exact values.

## Knobs

| Group | Control | Effect |
|---|---|---|
| Incoming load | Arrival rate | Mean conversions per tick (Poisson). Default 8,000 = 800/s. |
| | Daily traffic wave | Sinusoidal modulation of the arrival rate over 24 h (± percent). |
| Dispatcher | Queue capacity | Bundles the dispatcher can hold (default 10). When full, the bundler stops cutting bundles. |
| | Routing | Lowest idle index (first fit, default), any idle worker, round robin over idle workers, or sticky partition (a bundle waits for its pre-assigned worker). |
| Processing rate | Distribution | Normal, uniform, log-normal (heavy tail) or bimodal (fast + slow mode). |
| | Mean / std. deviation | Conversions a worker completes per tick (default 10 ± 2.5). Samples are clamped at zero. |
| | Worker heterogeneity | Spread of a permanent per-worker speed multiplier. |
| Incidents | Traffic spike | Multiply arrivals for N minutes. |
| | Degraded workers | Multiply the rate of a percentage of workers, the lowest by index (default) or chosen at random, for N minutes. A multiplier of 0 takes them offline (idle routing skips them); overlapping incidents multiply. |
| | Upstream delay | Hold arrivals for N minutes, then release them all at once. |
| Advanced | Workers | Pool size (default 1,000); can be changed live. |
| | Bundle size | Conversions per bundle (default 7,200, so a bundle takes ~2 h at 10 per tick). |
| | Partial-bundle flush | Minutes a partial bundle waits before being sent anyway. |
| | Random seed | Seed for the run; Reset replays it. |

Presets: **Healthy** (ρ ≈ 0.8), **Overloaded** (ρ ≈ 1.2), **Slow tail**
(bimodal rate), **Hot partitions** (sticky routing + uneven workers) and
**Bursty traffic**. The speed control runs from 1 simulated minute per real
second up to 2 hours per second. Space toggles play/pause, `s` or → steps one
tick.

## The model

One tick is 10 seconds. The model itself is unitless; the UI applies the scale.

1. **Arrivals** per tick ~ Poisson(λ), where λ is the arrival rate times any
   active spike multiplier and the daily wave.
2. **Bundling**: the intake buffer is cut into bundles of the configured size
   whenever enough conversions are present *and the dispatcher has room*; a
   leftover partial bundle is flushed after the max-wait. When the dispatcher is
   full the bundler stops and conversions accumulate in its buffer.
3. **Dispatcher**: a bounded FIFO. Each tick it hands bundles to idle workers.
   *Any idle worker*, *lowest idle index* (first fit) and *round robin* skip
   offline workers; *sticky partition*
   assigns each bundle a worker up front and waits for that worker, even if it
   is busy or offline, like a static partition assignment.
4. **Processing**: each worker holds one bundle. Every tick it draws a rate `r`
   (conversions per tick) from the distribution, multiplies by its speed factor
   and any slowdown, and completes `r` conversions of its bundle. When the
   bundle is done the worker picks up the next bundle on the following tick.
   With 10 per tick and 7,200 per bundle, a bundle takes ~720 ticks = 2 hours.
5. **Capacity** = workers × bundleSize ÷ E[ticks per bundle], where the
   expected ticks per bundle are estimated by simulation. With the defaults
   that is ~10,000 conversions per tick (1,000/s). The load ratio
   ρ = arrivals ÷ capacity is shown live; above 1 the dispatcher pins at its
   capacity and the backlog grows without bound at the bundler.
6. **Latency** of a bundle is measured from the tick its oldest conversion
   arrived to the tick it finished, so it includes time spent filling the
   bundle, waiting at the bundler and in the dispatcher, and being processed.
   Under the Healthy preset the median is a little over two hours.
7. **Arrival cohorts**: every conversion is tagged with the minute it arrived
   in, through the intake buffer (and the upstream-delay hold) into its bundle.
   As a worker makes progress on a bundle, processed conversions are credited
   to the bundle's cohorts oldest-minute first. `Simulation#completeness(n)`
   returns the last `n` minutes as `{ tick, arrived, processed, pct }`, which
   is what the completeness chart plots. `Simulation#freshTimes(levels,
   windowCohorts)` returns the fresh time in ticks per level (default levels
   50, 90 and 99 over 3-minute windows); each tick's snapshot carries the
   latest values as `fresh50`, `fresh90` and `fresh99`.

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
- `test/sim.test.js` – conservation, dispatcher bound, one bundle per worker,
  determinism, stability under/over load, incidents, distribution means,
  per-minute completeness, fresh-time percentiles.

A GitHub Pages workflow (`.github/workflows/pages.yml`) runs the tests and
publishes the site from `main`. It stamps the commit hash onto the script and
stylesheet URLs so browsers pick up new versions immediately; GitHub Pages
itself caches `index.html` for up to 10 minutes after a deploy.

## License

[MIT](LICENSE). Use it for anything; keep the copyright notice.
