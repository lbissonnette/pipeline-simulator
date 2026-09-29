# Pipeline Simulator

An interactive, dependency-free simulation of a streaming conversion pipeline.
Conversions (sign-ups, purchases after an ad) arrive at a configurable rate, are
cut into bundles, queue at a bounded dispatcher, and are handed one at a time to
a pool of 1,024 identical workers and then a buffered writer. Each tick (10 seconds) every busy worker
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
  bundle; a red corner mark means the worker is stalled on a conversion of
  death; hatched cells are offline. The dispatcher turns red when its queue is full and the
  bundler shows "blocked". Dots animate bundles moving between stages; green dots on the arrow into
  "done" are completed bundles. Hover a
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
- **Age of in-flight data** – a histogram of how old the conversions still in
  the system are (held upstream, at the bundler, in the dispatcher, or inside a
  bundle being processed), plus P50/P90/P99 of that age over time.
- **End-to-end processing time distribution** – a histogram of bundle
  end-to-end time for the last 12 hours and the last 7 days on the same axes.
  Each window is weighted by conversions and normalised to its own total, so
  the shapes are comparable although the 7-day set is far larger. Bin width
  adapts to the widest latency seen; the header shows each window's p50 and
  p95.
- **Age percentiles of processed data** – P50/P90/P99 of the end-to-end age
  of bundles at write-out, over a rolling one-hour window of completions.
- **Where in-flight data is** – a stacked area of conversions not yet written
  out, by stage: being processed, stuck behind a conversion-of-death stall, on
  degraded or offline workers, queued at the dispatcher, buffered at the
  bundler, held upstream, at the writer. Hover for each layer's share.
- **Charts** – the last 12 simulated hours of backlog, arrivals vs throughput
  vs capacity, dispatcher queue depth, and busy share. Hover for exact values.
- **PDF / CDF** – both distribution charts toggle between the share per bin
  (PDF) and the cumulative share at or below each value (CDF); remembered per
  chart.
- **Predefined outages** – two ready-made incidents, each of which opens a box
  above the KPIs explaining what was injected, what to watch for and why,
  with live readouts (now, at start, peak) of the metrics the story is about.
  *Stuck workers* takes 0.3% of the pool, the lowest by index, offline for
  999 hours: P99 fresh time climbs indefinitely while everything else looks
  normal. *Slow tenth* runs a random 10% of workers at 10% speed for 48 hours:
  P90 fresh time climbs, then drops a few hours in although nothing has
  changed, and P90 end-to-end never moves. Closing the box leaves the outage
  running; its button ends it early.
- **Incident markers** – time charts shade each incident's active period with
  start and end lines; an × marks one that was switched off by hand.
- **Tour** – a short guided tour opens on the first visit: time controls, the
  flow, the KPIs, the load ratio ρ, firing an incident, and reading the
  backlog and freshness charts. It is shown once per browser (remembered in
  localStorage); the **Tour** button in the top bar replays it.
- **Layout** – each chart card has a Hide button (collapses to its title) and a
  grip to drag it up or down; the arrangement is remembered per browser. The
  two in-flight age charts start hidden. The parameter panels collapse too;
  only *Inject a delay* (at the top) starts open.

## Knobs

| Group | Control | Effect |
|---|---|---|
| Incoming load | Arrival rate | Mean conversions per tick (Poisson). Default 5,200 = 520/s, which keeps about 60% of the pool busy. |
| | Daily traffic wave | Sinusoidal modulation of the arrival rate over 24 h (± percent). |
| Dispatcher | Queue capacity | Bundles the dispatcher can hold (default 1,024). When full, the bundler stops cutting bundles. |
| | Routing | Lowest idle index (first fit, default), any idle worker, round robin over idle workers, or sticky partition (a bundle waits for its pre-assigned worker). |
| Writer | Write rate | Conversions the writer can write per tick (default 9,000, about 900 per second). |
| | Buffer capacity | Finished bundles the writer can hold (default 256). When full, workers that finish a bundle are blocked until a slot frees. |
| | Intake | Which blocked worker is admitted when a slot frees: FIFO (finished earliest), lowest worker index, or random. |
| Processing rate | Distribution | Normal, uniform, log-normal (heavy tail) or bimodal (fast + slow mode). |
| | Mean / std. deviation | Conversions a worker completes per tick (default 10 ± 2.5). Samples are clamped at zero. Per-tick noise averages out over a bundle, so this barely affects end-to-end spread. |
| | Expensive conversions | Share of conversions that are expensive (default 0.15%, about 1.8 per bundle), and the mean and spread of each one's extra cost (default 2 ± 3 min, log-normal). A bundle with k of them stalls for the sum of their costs. This is what spreads end-to-end times; workers are identical. |
| Incidents | Traffic spike | Multiply arrivals for N hours. |
| | Predefined outages | *Stuck workers* (0.3%, lowest by index, offline 999 h) and *Slow tenth* (10% at random, rate × 0.1, 48 h), each with an explanation box. |
| | Degraded workers | Multiply the rate of a percentage of workers, chosen at random (default) or the lowest by index, for N hours (default 24). A warning appears when both this and the dispatcher target the lowest indices. A multiplier of 0 takes them offline (idle routing skips them); overlapping incidents multiply. |
| | Conversion of Death | For N hours, an extra share of arriving conversions are expensive at a fixed cost you choose, on top of the configured ones (default 24 h). The tag follows arrival time through the bundler and any upstream hold. |
| | Upstream delay | Hold arrivals for N hours, then release them all at once. |
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
   sd √(B × share × (cost² + spread²)). The
   defaults (0.15%, 2 ± 3 min, about 1.8 per bundle) add 3.6 ± 4.8 min on top
   of the 20-minute base, giving an end-to-end median of ~23 min, p90 ~30 min,
   p99 ~45 min.
6. **Writer**: a finished bundle goes to a buffered writer and is written out
   in order at the configured rate. It counts as complete only once fully
   written, so completeness, fresh time and latency all measure to write-out.
   If the buffer is full, the worker holding the finished bundle is blocked
   until a slot frees; the intake policy picks which blocked worker goes next.
7. **Capacity** = workers × bundleSize ÷ E[ticks per bundle], where the
   expected ticks are the rate-driven part (estimated by simulation) plus the
   mean stall time. With the defaults that is ~8,600 conversions per tick. The load ratio
   ρ = arrivals ÷ capacity is shown live; above 1 the dispatcher pins at its
   capacity and the backlog grows without bound at the bundler.
8. **Latency** of a bundle is measured from the tick its oldest conversion
   arrived to the tick it finished, so it includes time spent filling the
   bundle, waiting at the bundler and in the dispatcher, and being processed.
9. **Arrival cohorts**: every conversion is tagged with the minute it arrived
   in, through the intake buffer (and the upstream-delay hold) into its bundle.
   A bundle is written out atomically, so its cohorts are credited only when
   the whole bundle completes. Minutes are kept for 24 hours; older ones stay
   only while some of their conversions are unwritten (plus their neighbours
   within a fresh-time window), so a bundle stuck for days keeps counting
   against fresh time and in-flight age. `Simulation#completeness(n)`
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
- `js/tour.js` – the first-visit guided tour and its replay button.
- `test/sim.test.js` – conservation, dispatcher bound, one bundle per worker,
  determinism, stability under/over load, incidents, distribution means,
  per-minute completeness, fresh-time percentiles, completion retention, and
  the two predefined outages.

A GitHub Pages workflow (`.github/workflows/pages.yml`) runs the tests and
publishes the site from `main`. It stamps the commit hash onto the script and
stylesheet URLs so browsers pick up new versions immediately; GitHub Pages
itself caches `index.html` for up to 10 minutes after a deploy.

## License

[MIT](LICENSE). Use it for anything; keep the copyright notice.
