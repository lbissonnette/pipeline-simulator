/*
 * Minimal canvas line chart with crosshair + tooltip. No dependencies.
 * series: [{ key, name, color }] — values read from history[i][key].
 */
(function (root) {
  'use strict';

  // Theme colours are read through getComputedStyle, which is slow enough to
  // matter at 60 fps across many charts; cache them briefly.
  const cssCache = new Map();
  let cssCacheAt = 0;
  function cssVar(name) {
    const now = performance.now();
    if (now - cssCacheAt > 1000) { cssCache.clear(); cssCacheAt = now; }
    let v = cssCache.get(name);
    if (v === undefined) { v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); cssCache.set(name, v); }
    return v;
  }
  function invalidateCssCache() { cssCache.clear(); cssCacheAt = 0; }

  function niceStep(range, maxTicks) {
    const rough = range / Math.max(1, maxTicks);
    const mag = Math.pow(10, Math.floor(Math.log10(rough || 1)));
    for (const m of [1, 2, 2.5, 5, 10]) {
      if (m * mag >= rough) return m * mag;
    }
    return 10 * mag;
  }

  function fmt(v) {
    if (v === null || v === undefined || Number.isNaN(v)) return '–';
    const a = Math.abs(v);
    if (a >= 1e6) return (v / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
    if (a >= 1e4) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    if (a >= 100) return Math.round(v).toLocaleString();
    if (Number.isInteger(v)) return String(v);
    return v.toFixed(a >= 10 ? 1 : 2);
  }

  class LineChart {
    constructor(canvas, opts) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.series = opts.series;
      this.title = opts.title || '';
      this.unit = opts.unit || '';
      this.fill = !!opts.fill;
      this.reference = opts.reference || null; // { key, name } drawn as gray line
      this.xTicks = opts.xTicks || null;       // (firstTick, lastTick) => [{ value, label }]
      this.titleOf = opts.titleOf || (row => `Tick ${row.tick}`);
      this.format = opts.format || fmt;        // value formatter for tooltip
      this.yMax = opts.yMax || null;           // fixed y axis top (else auto)
      this.yFormat = opts.yFormat || fmt;      // axis label formatter
      // xByTick: place rows by their `tick` value within an explicit domain
      // (set via setDomain) instead of evenly by index. Lets sparse rows (one
      // per minute) scroll as smoothly as per-tick rows.
      this.xByTick = !!opts.xByTick;
      this.domain = null;
      // stacked: series[i].key holds the cumulative value (series 0..i summed) and
      // series[i].rawKey the layer's own value; bands are filled between layers
      this.stacked = !!opts.stacked;
      this.extraRows = opts.extraRows || null; // row => [[label, value], ...] appended to the tooltip
      this.hoverIndex = null;
      this.history = [];
      this.tooltip = document.createElement('div');
      this.tooltip.className = 'chart-tooltip';
      this.tooltip.hidden = true;
      canvas.parentElement.appendChild(this.tooltip);
      canvas.addEventListener('pointermove', e => this.onMove(e));
      canvas.addEventListener('pointerleave', () => { this.hoverIndex = null; this.tooltip.hidden = true; this.draw(); });
      this.padding = { l: 48, r: 14, t: 10, b: 22 };
    }

    resize() {
      const dpr = window.devicePixelRatio || 1;
      const rect = this.canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const w = Math.round(rect.width * dpr), h = Math.round(rect.height * dpr);
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w; this.canvas.height = h;
      }
      this.dpr = dpr; this.w = rect.width; this.h = rect.height;
    }

    setData(history) { this.history = history; }
    setDomain(x0, x1) { this.domain = [x0, x1]; }
    xRange() {
      const h = this.history;
      if (this.xByTick && this.domain) return this.domain;
      return h.length ? [h[0].tick, h[h.length - 1].tick] : [0, 1];
    }

    onMove(e) {
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const n = this.history.length;
      if (!n) return;
      const { l, r } = this.padding;
      const pw = this.w - l - r;
      let idx;
      if (this.xByTick) {
        const [x0, x1] = this.xRange();
        const tickAt = x0 + ((x - l) / pw) * (x1 - x0);
        idx = 0;
        let best = Infinity;
        for (let i = 0; i < n; i++) { const d = Math.abs(this.history[i].tick - tickAt); if (d < best) { best = d; idx = i; } }
      } else {
        idx = Math.round(((x - l) / pw) * (n - 1));
      }
      this.hoverIndex = Math.max(0, Math.min(n - 1, idx));
      this.draw();
      const row = this.history[this.hoverIndex];
      let html = `<div class="tt-title">${this.titleOf(row)}</div>`;
      const ttSeries = this.stacked ? this.series.slice().reverse() : this.series; // top layer first
      for (const s of ttSeries) {
        html += `<div class="tt-row"><span class="tt-swatch" style="background:${this.color(s)}"></span><span>${s.name}</span><b>${this.format(row[s.rawKey || s.key])}</b></div>`;
      }
      if (this.stacked) {
        const top = this.series[this.series.length - 1];
        html += `<div class="tt-row"><span class="tt-swatch" style="visibility:hidden"></span><span>total</span><b>${this.format(row[top.key])}</b></div>`;
      }
      if (this.reference) {
        html += `<div class="tt-row"><span class="tt-swatch tt-ref"></span><span>${this.reference.name}</span><b>${this.format(row[this.reference.key])}</b></div>`;
      }
      if (this.extraRows) {
        for (const [label, value] of this.extraRows(row)) {
          html += `<div class="tt-row"><span class="tt-swatch" style="visibility:hidden"></span><span>${label}</span><b>${value}</b></div>`;
        }
      }
      this.tooltip.innerHTML = html;
      this.tooltip.hidden = false;
      const tw = this.tooltip.offsetWidth;
      let tx = x + 14;
      if (tx + tw > this.w - 4) tx = x - tw - 14;
      this.tooltip.style.left = tx + 'px';
      this.tooltip.style.top = Math.max(4, e.clientY - rect.top - 10) + 'px';
    }

    color(s) { return s.color.startsWith('--') ? cssVar(s.color) : s.color; }

    draw() {
      this.resize();
      const ctx = this.ctx, dpr = this.dpr || 1;
      if (!this.w) return;
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, this.w, this.h);
      const { l, r, t, b } = this.padding;
      const pw = this.w - l - r, ph = this.h - t - b;
      const hist = this.history, n = hist.length;
      const grid = cssVar('--grid'), axis = cssVar('--axis'), muted = cssVar('--text-muted');
      const font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';

      // y range
      let maxY = 0;
      const keys = this.series.map(s => s.key).concat(this.reference ? [this.reference.key] : []);
      for (const row of hist) for (const k of keys) { const v = row[k]; if (v !== null && v !== undefined && v > maxY) maxY = v; }
      if (this.yMax) maxY = this.yMax;
      if (maxY <= 0) maxY = 1;
      const step = niceStep(maxY, 4);
      const yMax = this.yMax ? this.yMax : Math.ceil(maxY / step) * step;
      const yOf = v => t + ph - (v / yMax) * ph;
      const [dx0, dx1] = this.xRange();
      const xOf = this.xByTick
        ? i => l + ((hist[i].tick - dx0) / Math.max(1, dx1 - dx0)) * pw
        : i => l + (n <= 1 ? 0 : (i / (n - 1)) * pw);

      // grid + y labels
      ctx.font = font; ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
      ctx.lineWidth = 1;
      for (let v = 0; v <= yMax + 1e-9; v += step) {
        const y = Math.round(yOf(v)) + 0.5;
        ctx.strokeStyle = v === 0 ? axis : grid;
        ctx.beginPath(); ctx.moveTo(l, y); ctx.lineTo(l + pw, y); ctx.stroke();
        ctx.fillStyle = muted; ctx.fillText(this.yFormat(v), l - 6, y);
      }
      // x labels
      if (n > 1) {
        ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = muted;
        const first = dx0, last = dx1;
        let labels;
        if (this.xTicks) labels = this.xTicks(first, last);
        else {
          labels = [];
          const xs = niceStep(last - first, 6);
          for (let tv = Math.ceil(first / xs) * xs; tv <= last; tv += xs) labels.push({ value: tv, label: String(tv) });
        }
        // rows may be spaced more than one tick apart, so place labels by tick value
        const xOfTick = v => l + ((v - first) / Math.max(1, last - first)) * pw;
        for (const { value, label } of labels) {
          if (value < first || value > last) continue;
          ctx.fillText(label, xOfTick(value), t + ph + 6);
        }
      }

      if (n < 2) { ctx.restore(); return; }
      // keep series inside the plot (a tick-placed row can start just left of the domain)
      ctx.save(); ctx.beginPath(); ctx.rect(l - 1, t - 3, pw + 2, ph + 4); ctx.clip();

      // When there are many more points than pixels, draw each pixel column's
      // min and max instead of every point: same shape, far fewer segments.
      const bucket = Math.max(1, Math.floor(n / Math.max(1, pw)));
      const tracePath = (key, closeForFill) => {
        let started = false, lastX = 0;
        if (closeForFill) { ctx.moveTo(xOf(0), yOf(0)); started = true; }
        for (let i = 0; i < n; i += bucket) {
          const end = Math.min(n, i + bucket);
          let lo = Infinity, hi = -Infinity, loI = -1, hiI = -1;
          for (let j = i; j < end; j++) {
            const v = hist[j][key];
            if (v === null || v === undefined) continue;
            if (v < lo) { lo = v; loI = j; }
            if (v > hi) { hi = v; hiI = j; }
          }
          if (loI < 0) { if (!closeForFill) started = false; continue; }
          const x = xOf(i);
          // visit the extremes in index order so the run reads left to right
          const first = loI <= hiI ? lo : hi, second = loI <= hiI ? hi : lo;
          if (!started) { ctx.moveTo(x, yOf(first)); started = true; } else ctx.lineTo(x, yOf(first));
          if (bucket > 1 && first !== second) ctx.lineTo(x, yOf(second));
          lastX = x;
        }
        if (closeForFill) { ctx.lineTo(lastX, yOf(0)); ctx.closePath(); }
      };

      // reference line
      if (this.reference) {
        ctx.strokeStyle = axis; ctx.lineWidth = 1.5;
        ctx.beginPath(); tracePath(this.reference.key, false); ctx.stroke();
      }

      // series
      if (this.stacked) {
        // a band per layer: forward along this layer's cumulative top, back along the previous one
        const traceBack = key => {
          for (let i = n - 1; i >= 0; i -= bucket) {
            const start = Math.max(0, i - bucket + 1);
            let lo = Infinity, hi = -Infinity;
            for (let j = start; j <= i; j++) { const v = key ? hist[j][key] : 0; if (v === null || v === undefined) continue; if (v < lo) lo = v; if (v > hi) hi = v; }
            if (lo === Infinity) continue;
            const x = xOf(start);
            ctx.lineTo(x, yOf(hi)); if (bucket > 1 && hi !== lo) ctx.lineTo(x, yOf(lo));
          }
        };
        this.series.forEach((s, si) => {
          const col = this.color(s);
          ctx.beginPath(); tracePath(s.key, false); traceBack(si > 0 ? this.series[si - 1].key : null); ctx.closePath();
          ctx.globalAlpha = 0.55; ctx.fillStyle = col; ctx.fill(); ctx.globalAlpha = 1;
          ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.lineJoin = 'round';
          ctx.beginPath(); tracePath(s.key, false); ctx.stroke();
        });
      } else {
        for (const s of this.series) {
          const col = this.color(s);
          if (this.fill) {
            ctx.beginPath(); tracePath(s.key, true);
            ctx.globalAlpha = 0.12; ctx.fillStyle = col; ctx.fill(); ctx.globalAlpha = 1;
          }
          ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
          ctx.beginPath(); tracePath(s.key, false); ctx.stroke();
        }
      }
      ctx.restore();

      // crosshair + markers
      if (this.hoverIndex !== null && this.hoverIndex < n) {
        const i = this.hoverIndex, x = Math.round(xOf(i)) + 0.5;
        ctx.strokeStyle = axis; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, t); ctx.lineTo(x, t + ph); ctx.stroke();
        const surface = cssVar('--surface');
        for (const s of this.series) {
          const v = hist[i][s.key];
          if (v === null || v === undefined) continue;
          ctx.beginPath(); ctx.arc(xOf(i), yOf(v), 5, 0, Math.PI * 2);
          ctx.fillStyle = surface; ctx.fill();
          ctx.beginPath(); ctx.arc(xOf(i), yOf(v), 3.5, 0, Math.PI * 2);
          ctx.fillStyle = this.color(s); ctx.fill();
        }
      }
      ctx.restore();
    }
  }

  /*
   * Overlaid histogram: several series share the same bins; each series is a
   * share (percent) so differently sized populations are comparable.
   * setData({ bins: [{ x0, x1 }], series: [{ name, color, values, counts }] })
   */
  class Histogram {
    constructor(canvas, opts) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.xLabel = opts.xLabel || (v => String(v));
      this.xTicks = opts.xTicks || null; // (x0, x1) => [{ value, label }]
      this.countLabel = opts.countLabel || 'count';
      this.mode = opts.mode || 'pdf';   // 'pdf': share per bin as bars; 'cdf': cumulative share as step curves
      this.data = { bins: [], series: [] };
      this.hoverIndex = null;
      this.tooltip = document.createElement('div');
      this.tooltip.className = 'chart-tooltip';
      this.tooltip.hidden = true;
      canvas.parentElement.appendChild(this.tooltip);
      canvas.addEventListener('pointermove', e => this.onMove(e));
      canvas.addEventListener('pointerleave', () => { this.hoverIndex = null; this.tooltip.hidden = true; this.draw(); });
      this.padding = { l: 48, r: 14, t: 10, b: 22 };
    }

    resize() { LineChart.prototype.resize.call(this); }
    setData(d) { this.data = d; }
    color(s) { return s.color.startsWith('--') ? cssVar(s.color) : s.color; }

    onMove(e) {
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const { bins, series } = this.data;
      if (!bins.length) return;
      const { l, r } = this.padding;
      const pw = this.w - l - r;
      const idx = Math.floor(((x - l) / pw) * bins.length);
      if (idx < 0 || idx >= bins.length) { this.hoverIndex = null; this.tooltip.hidden = true; this.draw(); return; }
      this.hoverIndex = idx;
      this.draw();
      const b = bins[idx];
      const cdf = this.mode === 'cdf';
      let html = cdf
        ? `<div class="tt-title">${b.overflow ? 'all' : 'up to ' + this.xLabel(b.x1)}</div>`
        : `<div class="tt-title">${b.overflow ? this.xLabel(b.x0) + ' and above' : this.xLabel(b.x0) + ' – ' + this.xLabel(b.x1)}</div>`;
      for (const s of series) {
        let v = s.values[idx], c = s.counts ? s.counts[idx] : null;
        if (cdf) { v = 0; c = s.counts ? 0 : null; for (let k = 0; k <= idx; k++) { v += s.values[k]; if (c !== null) c += s.counts[k]; } v = Math.min(100, v); }
        html += `<div class="tt-row"><span class="tt-swatch" style="background:${this.color(s)}"></span><span>${s.name}</span><b>${v.toFixed(1)}%${c !== null ? ` · ${fmt(c)} ${this.countLabel}` : ''}</b></div>`;
      }
      this.tooltip.innerHTML = html;
      this.tooltip.hidden = false;
      const tw = this.tooltip.offsetWidth;
      let tx = x + 14;
      if (tx + tw > this.w - 4) tx = x - tw - 14;
      this.tooltip.style.left = tx + 'px';
      this.tooltip.style.top = Math.max(4, e.clientY - rect.top - 10) + 'px';
    }

    draw() {
      this.resize();
      const ctx = this.ctx, dpr = this.dpr || 1;
      if (!this.w) return;
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, this.w, this.h);
      const { l, r, t, b } = this.padding;
      const pw = this.w - l - r, ph = this.h - t - b;
      const { bins, series } = this.data;
      const grid = cssVar('--grid'), axis = cssVar('--axis'), muted = cssVar('--text-muted'), surface = cssVar('--surface');
      ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';

      const cdf = this.mode === 'cdf';
      // in CDF mode plot cumulative shares (0..100); in PDF mode the per-bin shares
      const plotted = cdf
        ? series.map(s => { let acc = 0; return Object.assign({}, s, { values: s.values.map(v => (acc = Math.min(100, acc + v))) }); })
        : series;
      let maxY = 0;
      if (cdf) maxY = 100;
      else for (const s of plotted) for (const v of s.values) if (v > maxY) maxY = v;
      if (maxY <= 0) maxY = 1;
      const step = cdf ? 25 : niceStep(maxY, 4);
      const yMax = cdf ? 100 : Math.ceil(maxY / step) * step;
      const yOf = v => t + ph - (v / yMax) * ph;

      ctx.textBaseline = 'middle'; ctx.textAlign = 'right'; ctx.lineWidth = 1;
      for (let v = 0; v <= yMax + 1e-9; v += step) {
        const y = Math.round(yOf(v)) + 0.5;
        ctx.strokeStyle = v === 0 ? axis : grid;
        ctx.beginPath(); ctx.moveTo(l, y); ctx.lineTo(l + pw, y); ctx.stroke();
        ctx.fillStyle = muted; ctx.fillText(fmt(v) + '%', l - 6, y);
      }
      if (!bins.length) { ctx.restore(); return; }
      const x0 = bins[0].x0, x1 = bins[bins.length - 1].x1;
      const xOf = v => l + ((v - x0) / (x1 - x0)) * pw;
      ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = muted;
      const labels = this.xTicks ? this.xTicks(x0, x1) : bins.filter((_, i) => i % 8 === 0).map(bn => ({ value: bn.x0, label: this.xLabel(bn.x0) }));
      for (const { value, label } of labels) {
        if (value < x0 || value > x1) continue;
        ctx.fillText(label, xOf(value), t + ph + 6);
      }

      // bars per series: the first is a translucent fill, later ones are drawn
      // as outlined step shapes so both stay readable where they overlap.
      // In CDF mode every series is a step curve.
      const gap = 1;
      plotted.forEach((s, si) => {
        const col = this.color(s);
        if (si === 0 && !cdf) {
          ctx.fillStyle = col; ctx.globalAlpha = 0.35;
          bins.forEach((bn, i) => {
            const v = s.values[i]; if (v <= 0) return;
            const bx = xOf(bn.x0) + gap, bw = Math.max(1, xOf(bn.x1) - xOf(bn.x0) - 2 * gap);
            ctx.fillRect(bx, yOf(v), bw, t + ph - yOf(v));
          });
          ctx.globalAlpha = 1;
        } else {
          ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.lineJoin = 'round';
          // a light fill under the first series only, so overlapping curves stay readable
          if (si === 0) {
            ctx.fillStyle = col; ctx.globalAlpha = 0.15;
            ctx.beginPath();
            ctx.moveTo(xOf(bins[0].x0), yOf(0));
            bins.forEach((bn, i) => { const y = yOf(s.values[i]); ctx.lineTo(xOf(bn.x0), y); ctx.lineTo(xOf(bn.x1), y); });
            ctx.lineTo(xOf(x1), yOf(0));
            ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1;
          }
          ctx.beginPath();
          bins.forEach((bn, i) => { const y = yOf(s.values[i]); if (i === 0) ctx.moveTo(xOf(bn.x0), y); else ctx.lineTo(xOf(bn.x0), y); ctx.lineTo(xOf(bn.x1), y); });
          ctx.stroke();
        }
      });

      if (this.hoverIndex !== null && this.hoverIndex < bins.length) {
        const bn = bins[this.hoverIndex];
        ctx.fillStyle = cssVar('--text'); ctx.globalAlpha = 0.08;
        ctx.fillRect(xOf(bn.x0), t, xOf(bn.x1) - xOf(bn.x0), ph);
        ctx.globalAlpha = 1;
        for (const s of plotted) {
          const v = s.values[this.hoverIndex];
          const cx = (xOf(bn.x0) + xOf(bn.x1)) / 2, cy = yOf(v);
          ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2); ctx.fillStyle = surface; ctx.fill();
          ctx.beginPath(); ctx.arc(cx, cy, 3.5, 0, Math.PI * 2); ctx.fillStyle = this.color(s); ctx.fill();
        }
      }
      ctx.restore();
    }
  }

  root.LineChart = LineChart;
  root.Histogram = Histogram;
  root.fmtNumber = fmt;
  root.invalidateChartTheme = invalidateCssCache;
})(window);
