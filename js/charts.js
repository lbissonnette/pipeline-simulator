/*
 * Minimal canvas line chart with crosshair + tooltip. No dependencies.
 * series: [{ key, name, color }] — values read from history[i][key].
 */
(function (root) {
  'use strict';

  function cssVar(name, el) {
    return getComputedStyle(el || document.documentElement).getPropertyValue(name).trim();
  }

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

    onMove(e) {
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const n = this.history.length;
      if (!n) return;
      const { l, r } = this.padding;
      const pw = this.w - l - r;
      const idx = Math.round(((x - l) / pw) * (n - 1));
      this.hoverIndex = Math.max(0, Math.min(n - 1, idx));
      this.draw();
      const row = this.history[this.hoverIndex];
      let html = `<div class="tt-title">${this.titleOf(row)}</div>`;
      for (const s of this.series) {
        html += `<div class="tt-row"><span class="tt-swatch" style="background:${this.color(s)}"></span><span>${s.name}</span><b>${this.format(row[s.key])}</b></div>`;
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
      const xOf = i => l + (n <= 1 ? 0 : (i / (n - 1)) * pw);

      // grid + y labels
      ctx.font = font; ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
      ctx.lineWidth = 1;
      for (let v = 0; v <= yMax + 1e-9; v += step) {
        const y = Math.round(yOf(v)) + 0.5;
        ctx.strokeStyle = v === 0 ? axis : grid;
        ctx.beginPath(); ctx.moveTo(l, y); ctx.lineTo(l + pw, y); ctx.stroke();
        ctx.fillStyle = muted; ctx.fillText(fmt(v), l - 6, y);
      }
      // x labels
      if (n > 1) {
        ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = muted;
        const first = hist[0].tick, last = hist[n - 1].tick;
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

      // reference line
      if (this.reference) {
        ctx.strokeStyle = axis; ctx.lineWidth = 1.5;
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < n; i++) {
          const v = hist[i][this.reference.key];
          if (v === null || v === undefined) continue;
          const x = xOf(i), y = yOf(v);
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      // series
      for (const s of this.series) {
        const col = this.color(s);
        if (this.fill) {
          ctx.beginPath();
          ctx.moveTo(xOf(0), yOf(0));
          for (let i = 0; i < n; i++) ctx.lineTo(xOf(i), yOf(hist[i][s.key] || 0));
          ctx.lineTo(xOf(n - 1), yOf(0));
          ctx.closePath();
          ctx.globalAlpha = 0.12; ctx.fillStyle = col; ctx.fill(); ctx.globalAlpha = 1;
        }
        ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < n; i++) {
          const v = hist[i][s.key];
          if (v === null || v === undefined) { started = false; continue; }
          const x = xOf(i), y = yOf(v);
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

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

  root.LineChart = LineChart;
  root.fmtNumber = fmt;
})(window);
