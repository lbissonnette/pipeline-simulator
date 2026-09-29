/* First-visit tour: a spotlight plus a short card for each step, walking
 * through how to read the flow, the KPIs and the charts, and how to make the
 * pipeline misbehave. Shown once per browser (remembered in localStorage);
 * the Tour button in the top bar replays it. The page stays live and
 * clickable underneath, so the simulation keeps running during the tour. */
(function () {
  'use strict';

  const $ = sel => document.querySelector(sel);
  const STORE_SEEN = 'pipeline-sim.tour-seen';
  const seen = {
    get() { try { return localStorage.getItem(STORE_SEEN) === '1'; } catch (e) { return false; } },
    set() { try { localStorage.setItem(STORE_SEEN, '1'); } catch (e) { /* storage unavailable */ } },
  };
  const cardOf = sel => { const el = $(sel); return el ? el.closest('.card') : null; };

  // target: element to spotlight (null = centred card). open: a collapsed
  // <details> panel to open for the step and restore afterwards.
  // action: an optional button that does something on the page.
  const STEPS = [
    {
      title: 'Welcome to the pipeline simulator',
      body: 'Conversions stream in, get cut into bundles, queue at a dispatcher and are processed by a pool of workers, then written out. The simulation is already running. This short tour shows how to read it and how to make a backlog form and clear.',
    },
    {
      target: () => $('.transport'),
      title: 'Control time',
      body: 'Play and pause (<kbd>Space</kbd>), step one 10-second tick (<kbd>→</kbd>), or reset to replay the same seed. Speed runs from 1 simulated minute to 2 hours per real second: turn it up to watch a whole day unfold.',
    },
    {
      target: () => $('.stage-card'),
      title: 'Follow the flow',
      body: 'Left to right: Source → Bundler → Dispatcher → the worker grid → Writer → Done. Each worker holds one bundle; its cell darkens the longer it has been working on it, and the white bar shows progress. A red ring means a queue is full. Hover a cell for details.',
    },
    {
      target: () => $('.kpis'),
      title: 'Read the vital signs',
      body: '<b>Backlog</b> is everything not yet written out and <b>Oldest conversion</b> is how stale the worst of it is. Compare <b>Arrivals</b> with <b>Throughput</b>: while arrivals exceed what the pool can finish, the backlog can only grow.',
    },
    {
      target: () => $('.capacity-line'),
      open: () => $('.capacity-line').closest('details'),
      title: 'Watch the load ratio ρ',
      body: 'ρ = arrivals ÷ capacity. Well below 1, queues stay short. Close to 1, small bursts cause long waits and slow recoveries. Above 1, the backlog grows without bound. Every knob in the parameter panels moves capacity or load; this line tells you by how much.',
    },
    {
      target: () => $('.controls .panel'),
      title: 'Break something',
      body: 'Incidents start on the next tick and expire on their own; stack as many as you like. A traffic spike is the simplest: it multiplies arrivals for a while and pushes ρ above 1.',
      action: {
        label: 'Fire a 3× spike',
        done: 'Spike fired ✓',
        run: () => { const btn = $('[data-incident="spike"]'); if (btn) btn.click(); },
      },
    },
    {
      target: () => cardOf('#chart-backlog'),
      title: 'See the backlog form and drain',
      body: 'During a spike the backlog climbs; afterwards it drains at capacity minus arrivals, so the closer ρ is to 1 the longer recovery takes. Every time chart shades the period an incident was active.',
    },
    {
      target: () => cardOf('#chart-fresh'),
      title: 'Measure how far behind the data is',
      body: '<b>Completeness by arrival minute</b> and <b>Fresh time</b> answer what downstream consumers care about: how recent is the data I can trust? P99 fresh time is the age of the oldest 5-minute window that is still under 99% complete.',
    },
    {
      target: () => $('.notes'),
      title: 'Make it yours',
      body: 'Hide or drag any chart card to rearrange the page; the layout is remembered. <b>How the model works</b> explains every mechanism. Replay this tour any time from the <b>Tour</b> button at the top.',
    },
  ];

  let idx = -1, spot = null, pop = null, openedPanel = null, raf = 0, lastFocus = null;

  function build() {
    spot = document.createElement('div');
    spot.className = 'tour-spot';
    spot.setAttribute('aria-hidden', 'true');
    pop = document.createElement('div');
    pop.className = 'tour-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-labelledby', 'tour-title');
    pop.setAttribute('aria-describedby', 'tour-body');
    pop.innerHTML =
      '<div class="tour-step"></div>' +
      '<h3 id="tour-title"></h3>' +
      '<p id="tour-body"></p>' +
      '<button type="button" class="btn small tour-action" hidden></button>' +
      '<div class="tour-foot">' +
        '<button type="button" class="tour-skip">Skip tour</button>' +
        '<span class="tour-nav">' +
          '<button type="button" class="btn small tour-back">Back</button>' +
          '<button type="button" class="btn small primary tour-next">Next</button>' +
        '</span>' +
      '</div>';
    pop.querySelector('.tour-skip').addEventListener('click', end);
    pop.querySelector('.tour-back').addEventListener('click', () => show(idx - 1));
    pop.querySelector('.tour-next').addEventListener('click', () => (idx === STEPS.length - 1 ? end() : show(idx + 1)));
    document.body.append(spot, pop);
  }

  function restorePanel() {
    if (openedPanel) { openedPanel.open = false; openedPanel = null; }
  }

  function show(i) {
    restorePanel();
    idx = Math.max(0, Math.min(STEPS.length - 1, i));
    const step = STEPS[idx];
    const panel = step.open ? step.open() : null;
    if (panel && !panel.open) { panel.open = true; openedPanel = panel; }
    const target = currentTarget();
    if (target) scrollToTarget(target);
    else window.scrollTo(0, 0);

    pop.querySelector('.tour-step').textContent = `${idx + 1} of ${STEPS.length}`;
    pop.querySelector('#tour-title').textContent = step.title;
    pop.querySelector('#tour-body').innerHTML = step.body;
    const act = pop.querySelector('.tour-action');
    act.hidden = !step.action;
    if (step.action) {
      act.textContent = step.action.label;
      act.disabled = false;
      act.onclick = () => { step.action.run(); act.textContent = step.action.done; act.disabled = true; };
    }
    pop.querySelector('.tour-back').hidden = idx === 0;
    pop.querySelector('.tour-skip').hidden = idx === STEPS.length - 1;
    const next = pop.querySelector('.tour-next');
    next.textContent = idx === 0 ? 'Start' : idx === STEPS.length - 1 ? 'Done' : 'Next';
    place();
    next.focus({ preventScroll: true });
  }

  // Centre the target in the space below the sticky top bar, or line its top
  // up just under the bar when it is too tall to fit.
  function scrollToTarget(el) {
    const bar = $('.topbar');
    const barH = bar && el.closest('.topbar') !== bar ? bar.getBoundingClientRect().height : 0;
    const r = el.getBoundingClientRect(), room = window.innerHeight - barH;
    const offset = r.height + 24 > room ? r.top - barH - 12 : r.top - barH - (room - r.height) / 2;
    window.scrollBy(0, offset);
  }

  // A target that is missing or not rendered falls back to a centred card.
  function currentTarget() {
    const step = STEPS[idx];
    const el = step && step.target ? step.target() : null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width || r.height ? el : null;
  }

  function place() {
    if (!pop) return;
    const vw = document.documentElement.clientWidth, vh = window.innerHeight;
    const gutter = 16, gap = 12, pad = 6;
    const target = currentTarget();
    pop.style.width = Math.min(360, vw - 2 * gutter) + 'px';
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    if (!target) {
      spot.classList.add('center');
      spot.style.cssText = '';
      pop.style.left = Math.round((vw - pw) / 2) + 'px';
      pop.style.top = Math.round(Math.max(gutter, (vh - ph) / 2)) + 'px';
      return;
    }
    spot.classList.remove('center');
    const r = target.getBoundingClientRect();
    spot.style.left = (r.left - pad) + 'px';
    spot.style.top = (r.top - pad) + 'px';
    spot.style.width = (r.width + 2 * pad) + 'px';
    spot.style.height = (r.height + 2 * pad) + 'px';
    // below the target if it fits, else above, else beside it, else pinned
    // to the bottom edge
    let top, left = Math.min(Math.max(gutter, r.left), vw - pw - gutter);
    const besideTop = Math.min(Math.max(gutter, r.top), vh - ph - gutter);
    if (r.bottom + pad + gap + ph <= vh - gutter) top = r.bottom + pad + gap;
    else if (r.top - pad - gap - ph >= gutter) top = r.top - pad - gap - ph;
    else if (r.right + pad + gap + pw <= vw - gutter) { top = besideTop; left = r.right + pad + gap; }
    else if (r.left - pad - gap - pw >= gutter) { top = besideTop; left = r.left - pad - gap - pw; }
    else top = vh - ph - gutter;
    pop.style.left = Math.round(left) + 'px';
    pop.style.top = Math.round(Math.max(gutter, top)) + 'px';
  }
  function schedulePlace() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; place(); });
  }

  // Tour keys win over the page's shortcuts while the card is up.
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end(); }
    else if (e.key === 'ArrowRight' && !e.target.matches('input, select, textarea')) {
      e.preventDefault(); e.stopPropagation(); idx === STEPS.length - 1 ? end() : show(idx + 1);
    } else if (e.key === 'ArrowLeft' && !e.target.matches('input, select, textarea')) {
      e.preventDefault(); e.stopPropagation(); show(idx - 1);
    } else if ((e.code === 'Space' || e.key === 'Enter') && pop.contains(e.target)) {
      e.stopPropagation(); // let the focused tour button activate instead of toggling play
    }
  }

  function start() {
    if (pop) return;
    seen.set();
    lastFocus = document.activeElement;
    build();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', schedulePlace);
    window.addEventListener('scroll', schedulePlace, true);
    show(0);
  }

  function end() {
    if (!pop) return;
    restorePanel();
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', schedulePlace);
    window.removeEventListener('scroll', schedulePlace, true);
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    spot.remove(); pop.remove();
    spot = pop = null; idx = -1;
    window.scrollTo(0, 0);
    if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
  }

  $('#btn-tour').addEventListener('click', start);
  if (!seen.get()) start();
})();
