// The pages beyond Hem (pages.js runs the pager). Each page does work only
// while it is the active page: `prepare` draws it once as a static neighbour,
// `enter` starts its timers, `leave` stops them.
//
// Dashboard data is read from display.js's own top-level bindings (shared by
// classic scripts), read-only, when a page draws; nothing here changes them.
(() => {
  'use strict';

  const pagesApi = globalThis.lugnPages;
  if (!pagesApi) return;

  const payload = () =>
    typeof latestPayload === 'undefined' ? undefined : latestPayload;
  const view = (page, name) =>
    document.querySelector(
      `.hub-page[data-page='${page}'] [data-view='${name}']`,
    );

  function setText(element, value) {
    if (element && element.textContent !== value) element.textContent = value;
  }

  // The new pages share the dashboard's 600 px canvas and its scale
  // (display.js fitScreen does the same for #app-root).
  function fitCanvases() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    if (!width || !height) return;
    const zoom = Math.min(height / 600, width / 900);
    for (const canvas of document.querySelectorAll('.page-canvas')) {
      canvas.style.zoom = String(zoom);
      canvas.style.setProperty('--W', `${width / zoom}px`);
    }
  }
  fitCanvases();
  window.addEventListener('resize', fitCanvases);

  const timeFormat = new Intl.DateTimeFormat('sv-SE', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Stockholm',
  });
  const dateFormat = new Intl.DateTimeFormat('sv-SE', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'Europe/Stockholm',
  });

  // ── Klocka: big time, indoor air, presence ──

  const AIR = [
    ['temperature', 'Temperatur', 1],
    ['humidity', 'Luftfuktighet', 0],
    ['co2', 'CO₂', 0],
    ['pm25', 'PM2.5', 1],
  ];
  const STALE_MS = 15 * 60 * 1000;
  let clockTimer = 0;
  let airTimer = 0;
  let airKey = '';

  // The Hem clock's own time: the server's, carried forward between payloads.
  const serverNow = () =>
    typeof estimatedServerNow === 'function' && payload()
      ? estimatedServerNow()
      : Date.now();

  function drawClock() {
    const now = new Date(serverNow());
    const date = dateFormat.format(now);
    setText(view('clock', 'time'), timeFormat.format(now));
    setText(
      view('clock', 'date'),
      date.charAt(0).toUpperCase() + date.slice(1),
    );
  }

  function drawAir() {
    const data = payload();
    const environment = data?.environment ?? {};
    const parts = [];
    for (const [name, label, digits] of AIR) {
      const metric = environment[name];
      if (typeof metric?.value !== 'number' || !Number.isFinite(metric.value))
        continue;
      const value = metric.value.toLocaleString('sv-SE', {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
      const unit = typeof metric.unit === 'string' ? ` ${metric.unit}` : '';
      const stale =
        typeof metric.observedAt === 'number' &&
        Date.now() - metric.observedAt > STALE_MS;
      parts.push([label, `${value}${unit}`, stale]);
    }
    const presence = data?.state?.presence;
    const count = presence?.personCount;
    const presenceText =
      presence?.state === 'occupied' && Number.isInteger(count) && count > 0
        ? `${count} ${count === 1 ? 'person' : 'personer'} i rummet`
        : presence?.state === 'confirmed_empty'
          ? 'Rummet är tomt'
          : '';
    const key = JSON.stringify([parts, presenceText]);
    if (key === airKey) return;
    airKey = key;
    const list = view('clock', 'air');
    list?.replaceChildren(
      ...parts.map(([label, value, stale]) => {
        const row = document.createElement('div');
        const dt = document.createElement('dt');
        const dd = document.createElement('dd');
        dt.textContent = label;
        dd.textContent = value;
        if (stale) dd.dataset.stale = 'true';
        row.append(dt, dd);
        return row;
      }),
    );
    setText(view('clock', 'presence'), presenceText);
  }

  function tickClock() {
    drawClock();
    clockTimer = window.setTimeout(
      tickClock,
      60_000 - (serverNow() % 60_000) + 50,
    );
  }

  // The minute ticks while the page is next to the current one too, so a
  // swipe never reveals an old time; the air refreshes only while shown.
  function startClock() {
    window.clearTimeout(clockTimer);
    tickClock();
  }
  pagesApi.define('clock', {
    prepare() {
      startClock();
      drawAir();
    },
    enter() {
      startClock();
      drawAir();
      window.clearInterval(airTimer);
      airTimer = window.setInterval(drawAir, 5000);
    },
    leave() {
      window.clearInterval(airTimer);
      airTimer = 0;
    },
    sleep() {
      window.clearTimeout(clockTimer);
      clockTimer = 0;
    },
  });

  // ── Info: connection, versions, timing ──

  const PROBE_KEY = 'lugn.pages.probe';
  const probeButton = view('info', 'probe');
  let infoTimer = 0;
  let longTasks = [];
  let longTaskObserver = null;

  function readProbeSetting() {
    try {
      return localStorage.getItem(PROBE_KEY) === '1';
    } catch {
      return false;
    }
  }

  function setProbe(on) {
    pagesApi.probe.enabled = on;
    try {
      if (on) localStorage.setItem(PROBE_KEY, '1');
      else localStorage.removeItem(PROBE_KEY);
    } catch {
      // Storage may be unavailable on the receiver; the probe still runs.
    }
    probeButton?.setAttribute('aria-pressed', on ? 'true' : 'false');
    // Long tasks are observed only while measuring.
    if (on && !longTaskObserver && typeof PerformanceObserver === 'function') {
      try {
        longTaskObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries())
            longTasks.push([entry.startTime, entry.duration]);
          if (longTasks.length > 500) longTasks = longTasks.slice(-500);
        });
        longTaskObserver.observe({ entryTypes: ['longtask'] });
      } catch {
        longTaskObserver = null;
      }
    } else if (!on && longTaskObserver) {
      longTaskObserver.disconnect();
      longTaskObserver = null;
      longTasks = [];
    }
    if (pagesApi.current() === 'info') drawInfo();
  }
  probeButton?.addEventListener('click', () =>
    setProbe(!pagesApi.probe.enabled),
  );
  setProbe(readProbeSetting());

  function duration(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h ? `${h} h ${m} min` : m ? `${m} min ${s % 60} s` : `${s} s`;
  }

  function gapSummary(gaps) {
    if (!gaps.length) return 'inga svep mätta än';
    const sorted = [...gaps].sort((a, b) => a - b);
    const at = (f) =>
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * f))];
    const long = gaps.filter((gap) => gap > 25).length;
    return `${gaps.length} bildrutor · median ${at(0.5).toFixed(1)} ms · p95 ${at(0.95).toFixed(1)} ms · max ${sorted[sorted.length - 1].toFixed(0)} ms · ${long} > 25 ms`;
  }

  function facts() {
    const data = payload();
    const out = [];
    const connection = document.getElementById('connection-notice');
    const state = connection?.dataset.state || 'okänd';
    const message =
      document.getElementById('connection-message')?.textContent || '';
    out.push([
      'Anslutning',
      state === 'connected' ? 'Ansluten' : `${state} · ${message}`,
    ]);
    const healthy =
      typeof streamHealthy === 'undefined' ? undefined : streamHealthy;
    out.push([
      'Ström',
      healthy === undefined ? 'okänd' : healthy ? 'SSE live' : 'polling',
    ]);
    const fresh = typeof lastFreshAt === 'undefined' ? 0 : lastFreshAt;
    out.push([
      'Senaste data',
      fresh ? `${duration(Date.now() - fresh)} sedan` : '—',
    ]);
    out.push(['Roll', data?.role ?? '—']);
    out.push([
      'Revision',
      data?.state
        ? `${data.state.revision} · leverans ${data.deliveryRevision ?? '—'}`
        : '—',
    ]);
    out.push([
      'Server-instans',
      data?.instanceId ? String(data.instanceId).slice(0, 8) : '—',
    ]);
    if (typeof data?.generatedAt === 'number')
      out.push([
        'Klockskillnad',
        `${Math.round((Date.now() - data.generatedAt) / 100) / 10} s mot servern`,
      ]);
    out.push(['Sidan uppe', duration(performance.now())]);
    const memory = performance.memory;
    if (memory?.usedJSHeapSize)
      out.push([
        'JS-minne',
        `${(memory.usedJSHeapSize / 1048576).toFixed(1)} av ${(memory.jsHeapSizeLimit / 1048576).toFixed(0)} MB`,
      ]);
    out.push([
      'Skärm',
      `${window.innerWidth}×${window.innerHeight} · dpr ${window.devicePixelRatio || 1}`,
    ]);
    out.push(['Sidor', pagesApi.ids().join(' · ')]);
    if (pagesApi.probe.enabled) {
      out.push(['Svep (rAF)', gapSummary(pagesApi.probe.gaps()), true]);
      const since = performance.now() - 60_000;
      const recent = longTasks.filter(([start]) => start > since);
      const total = recent.reduce((sum, [, d]) => sum + d, 0);
      out.push([
        'Långa tasks',
        `${recent.length} senaste minuten · ${Math.round(total)} ms`,
        true,
      ]);
    } else {
      out.push([
        'Mätning',
        'av (Mät svep slår på rAF-gap under svep och långa tasks)',
        true,
      ]);
    }
    out.push(['Webbläsare', navigator.userAgent, true]);
    return out;
  }

  let infoKey = '';
  function drawInfo() {
    const rows = facts();
    const key = JSON.stringify(rows);
    if (key === infoKey) return;
    infoKey = key;
    view('info', 'facts')?.replaceChildren(
      ...rows.map(([label, value, wide]) => {
        const row = document.createElement('div');
        if (wide) row.dataset.wide = 'true';
        const dt = document.createElement('dt');
        const dd = document.createElement('dd');
        dt.textContent = label;
        dd.textContent = value;
        row.append(dt, dd);
        return row;
      }),
    );
  }

  pagesApi.define('info', {
    prepare: drawInfo,
    enter() {
      window.clearInterval(infoTimer);
      drawInfo();
      infoTimer = window.setInterval(drawInfo, 1000);
    },
    leave() {
      window.clearInterval(infoTimer);
      infoTimer = 0;
    },
  });
})();
