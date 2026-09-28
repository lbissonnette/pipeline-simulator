# Pipeline Simulator

An interactive, dependency-free simulation of a streaming conversion pipeline.
Conversions (sign-ups, purchases after an ad) arrive at a configurable rate, are
cut into bundles, queue at a bounded dispatcher, and are handed one at a time to
a pool of 1,024 identical workers. Each tick (10 seconds) every busy worker
completes a random number of conversions, drawn from a distribution you
control, and a small share of expensive conversions add stalls; with the
defaults a bundle takes a median of about 23 minutes end to end. Turn the knobs, inject delays, and
watch backlogs form and clear.

Live: <https://lbissonnette.github.io/pipeline-simulator/>

**Run it:** open `index.html` in a browser, or `npm start` to serve it on
<http://localhost:8080>. No build step, no dependencies.

## What you see

- **Flow stage** – a source, a bundler, a dispatcher, a grid of workers (1,024
  by default, up to 2,048) and a "done" sink. Each busy cell's colour is how
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
  header shows the most recent minute through which everything is at least
  99% complete. Hover for the
  minute's arrived and processed counts.
- **Fresh time** – P50, P90 and P99 over time. A 5-minute window slides over
  the arrival minutes; each window's completeness is processed ÷ arrived across
  its five minutes. The P99 fresh time is the age of the oldest window still
  below 99% complete (P90 and P50 likewise), counted from the start of the
  window's oldest minute. Recomputed every simulated minute; 0 means every
  window has passed that threshold.
- **End-to-end processing time distribution** – a histogram of bundle
  end-to-end time for the last 12 hours and the last 7 days on the same axes.
  Each window is weighted by conversions and normalised to its own total, so
  the shapes are comparable although the 7-day set is far larger. Bin width
  adapts to the widest latency seen; the header shows each window's p50 and
  p95.
- **Charts** – the last 12 simulated hours of backlog, arrivals vs throughput
  vs capacity, latency percentiles, dispatcher queue depth, and busy share.
  Hover for exact values.

## Knobs

| Group | Control | Effect |
|---|---|---|
| Incoming load | Arrival rate | Mean conversions per tick (Poisson). Default 5,200 = 520/s, which keeps about 60% of the pool busy. |
| | Daily traffic wave | Sinusoidal modulation of the arrival rate over 24 h (± percent). |
| Dispatcher | Queue capacity | Bundles the dispatcher can hold (default 10). When full, the bundler stops cutting bundles. |
| | Routing | Lowest idle index (first fit, default), any idle worker, round robin over idle workers, or sticky partition (a bundle waits for its pre-assigned worker). |
| Processing rate | Distribution | Normal, uniform, log-normal (heavy tail) or bimodal (fast + slow mode). |
| | Mean / std. deviation | Conversions a worker completes per tick (default 10 ± 2.5). Samples are clamped at zero. Per-tick noise averages out over a bundle, so this barely affects end-to-end spread. |
| | Expensive conversions | Share of conversions that are expensive (default 0.15%, about 1.8 per bundle), and the mean and spread of each one's extra cost (default 2 ± 3 min, log-normal, each stall capped at 4 h). A bundle with k of them stalls for the sum of their costs. This is what spreads end-to-end times; workers are identical. |
| Incidents | Traffic spike | Multiply arrivals for N minutes. |
| | Degraded workers | Multiply the rate of a percentage of workers, chosen at random (default) or the lowest by index, for N minutes. A warning appears when both this and the dispatcher target the lowest indices. A multiplier of 0 takes them offline (idle routing skips them); overlapping incidents multiply. |
| | Conversion of Death | For N minutes, an extra share of conversions are expensive at a fixed cost you choose, on top of the configured ones. |
| | Upstream delay | Hold arrivals for N minutes, then release them all at once. |
| Advanced | Workers | Pool size (default 1,024, a 32 × 32 grid); can be changed live. |
| | Bundle size | Conversions per bundle (default 1,200, so the work itself takes ~20 min at 10 per tick). |
| | Partial-bundle flush | Minutes a partial bundle waits before being sent anyway. |
| | Random seed | Seed for the run; Reset replays it. |

The speed control runs from 1 simulated minute per real
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
   (conversions per tick) from the distribution, multiplies by any degradation,
   and completes `r` conversions of its bundle. Workers are identical. When the
   bundle is done the worker picks up the next bundle on the following tick.
   With 10 per tick and 1,200 per bundle, the rate-driven part of a bundle
   takes ~120 ticks = 20 minutes. Per-tick noise averages out over a bundle,
   so it does not spread end-to-end times.
5. **Expensive conversions**: each conversion is independently expensive with
   probability `share`, so a bundle holds Poisson(B × share) of them at random
   positions. Each draws its own cost from a log-normal with the configured
   mean and spread; reaching one stalls the worker for that long. Extra time
   per bundle is a compound Poisson sum with mean B × share × cost and
   sd √(B × share × (cost² + spread²)); no single stall exceeds 4 h. The
   defaults (0.15%, 2 ± 3 min, about 1.8 per bundle) add 3.6 ± 4.8 min on top
   of the 20-minute base, giving an end-to-end median of ~23 min, p90 ~30 min,
   p99 ~45 min.
6. **Capacity** = workers × bundleSize ÷ E[ticks per bundle], where the
   expected ticks are the rate-driven part (estimated by simulation) plus the
   mean stall time. With the defaults that is ~8,600 conversions per tick. The load ratio
   ρ = arrivals ÷ capacity is shown live; above 1 the dispatcher pins at its
   capacity and the backlog grows without bound at the bundler.
7. **Latency** of a bundle is measured from the tick its oldest conversion
   arrived to the tick it finished, so it includes time spent filling the
   bundle, waiting at the bundler and in the dispatcher, and being processed.
8. **Arrival cohorts**: every conversion is tagged with the minute it arrived
   in, through the intake buffer (and the upstream-delay hold) into its bundle.
   A bundle is written out atomically, so its cohorts are credited only when
   the whole bundle completes. `Simulation#completeness(n)`
   returns the last `n` minutes as `{ tick, arrived, processed, pct }`, which
   is what the completeness chart plots. `Simulation#freshTimes(levels,
   windowCohorts)` returns the fresh time in ticks per level (default levels
   50, 90 and 99 over 5-minute windows); each tick's snapshot carries the
   latest values as `fresh50`, `fresh90` and `fresh99`. Every bundle
   completion is kept for 7 days as `{ tick, latency, size }`;
   `Simulation#latencySamples(windowTicks)` returns the ones within a window.

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
  per-minute completeness, fresh-time percentiles, completion retention.

A GitHub Pages workflow (`.github/workflows/pages.yml`) runs the tests and
publishes the site from `main`. It stamps the commit hash onto the script and
stylesheet URLs so browsers pick up new versions immediately; GitHub Pages
itself caches `index.html` for up to 10 minutes after a deploy.

## License

[MIT](LICENSE). Use it for anything; keep the copyright notice.
