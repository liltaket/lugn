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

  // ── Scene dock: Hem's scenes on the other pages ──
  //
  // The buttons send exactly what Hem's scene buttons send (runCommand) and
  // show the state Hem's own buttons show, so the two never disagree.

  const hem = () => (typeof refs === 'object' ? refs : null);

  function dockScenes() {
    if (typeof getSceneList !== 'function') return [];
    const scenes = getSceneList(payload()).filter(
      (scene) => !scene.id.startsWith('scene.custom_'),
    );
    // Släck last, as the way out, and at most six in a row.
    const off = scenes.filter((scene) => scene.id === 'scene.all_off');
    const rest = scenes.filter((scene) => scene.id !== 'scene.all_off');
    return [...rest.slice(0, 6 - off.length), ...off];
  }

  function dockButton(scene) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.scene = scene.id;
    const icon =
      typeof sceneIconFor === 'function' ? sceneIconFor(scene.id) : null;
    if (icon) {
      // The same fixed pictograms as Hem; scene names stay text.
      button.insertAdjacentHTML(
        'beforeend',
        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${icon.paths}</svg>`,
      );
    }
    const name = document.createElement('span');
    name.textContent = scene.id === 'scene.all_off' ? 'Släck' : scene.name;
    button.append(name);
    button.title = scene.name;
    return button;
  }

  const dockKeys = new Map();
  function drawDock(page) {
    const dock = view(page, 'dock');
    if (!dock) return;
    const scenes = dockScenes();
    const listKey = scenes
      .map((scene) => `${scene.id}\u0000${scene.name}`)
      .join('\u0001');
    if (dockKeys.get(page) !== listKey) {
      dockKeys.set(page, listKey);
      dock.replaceChildren(...scenes.map(dockButton));
    }
    const offline = typeof isUnavailable === 'function' && isUnavailable();
    for (const button of dock.children) {
      const id = button.dataset.scene;
      const source =
        typeof sceneButtons === 'object' ? sceneButtons.get(id) : null;
      const pressed = source?.getAttribute('aria-pressed') === 'true';
      const state =
        typeof pending === 'object' && pending.has(`scene:${id}`)
          ? 'pending'
          : (source?.dataset.state ?? 'idle');
      if (button.getAttribute('aria-pressed') !== String(pressed))
        button.setAttribute('aria-pressed', String(pressed));
      if (button.dataset.state !== state) button.dataset.state = state;
      if (button.disabled !== offline) button.disabled = offline;
    }
  }

  function onDockClick(event) {
    const button = event.target.closest?.('button[data-scene]');
    if (!button || button.disabled || typeof runCommand !== 'function') return;
    const sceneId = button.dataset.scene;
    if (!dockScenes().some((scene) => scene.id === sceneId)) return;
    void runCommand(`scene:${sceneId}`, { sceneId });
    const page = button.closest('.hub-page')?.dataset.page;
    // Pending shows at once; the confirmation follows the next state.
    window.setTimeout(() => drawDock(page), 0);
  }
  for (const page of ['clock', 'music'])
    view(page, 'dock')?.addEventListener('click', onDockClick);

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
    drawDock('clock');
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
      airTimer = window.setInterval(drawAir, 2000);
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
    // Skipped heartbeats move display.js's delivery counter, not the payload.
    const delivery =
      typeof latestDeliveryRevision === 'number'
        ? latestDeliveryRevision
        : (data?.deliveryRevision ?? -1);
    out.push([
      'Revision',
      data?.state
        ? `${data.state.revision} · leverans ${delivery >= 0 ? delivery : '—'}`
        : '—',
    ]);
    out.push([
      'Server-instans',
      data?.instanceId ? String(data.instanceId).slice(0, 8) : '—',
    ]);
    // The server's time as the dashboard carries it forward, against ours.
    if (typeof data?.generatedAt === 'number')
      out.push([
        'Klockskillnad',
        `${Math.round((Date.now() - serverNow()) / 100) / 10} s mot servern`,
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

  // ── Musik: Hem's music, full screen ──
  //
  // Title, artist, source and cover are read from Hem's music card, so the
  // same rules (pause grace, computer media, retained artwork) apply here.

  const PLAY_PATH = 'M8 5.5v13l11-6.5Z';
  const PAUSE_PATH = 'M7 5h4v14H7zM13 5h4v14h-4z';
  let musicTimer = 0;
  let musicKey = '';
  let barKey = '';
  let barAnimation = null;
  let musicShown = false;

  function clockText(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function musicState() {
    const r = hem();
    const data = payload();
    const target = typeof musicTarget === 'string' ? musicTarget : '';
    const device = target ? data?.state?.music?.devices?.[target] : undefined;
    const active =
      document.getElementById('app-root')?.dataset.musicVisible === 'true';
    const artReady =
      r?.musicArtwork?.dataset.state === 'available' &&
      r?.musicArtworkImage &&
      !r.musicArtworkImage.hidden;
    const volume = device?.observed?.volume;
    return {
      active,
      title: r?.musicTitle?.textContent?.trim() || 'Ingen musik spelar',
      artist:
        r?.musicArtist && !r.musicArtist.hidden
          ? r.musicArtist.textContent.trim()
          : '',
      source: active ? r?.musicSource?.textContent?.trim() || '' : '',
      art: artReady ? r.musicArtworkImage.getAttribute('src') || '' : '',
      playing:
        Boolean(target) &&
        typeof musicPlaybackAction === 'function' &&
        musicPlaybackAction(data, target) === 'paused',
      canPlay: Boolean(device) && !r?.musicPlayback?.disabled,
      volume:
        typeof volume === 'number' && Number.isFinite(volume)
          ? `Volym ${Math.round(volume * 100)} %`
          : '',
      progress:
        typeof musicProgress === 'object' && musicProgress
          ? { ...musicProgress }
          : null,
    };
  }

  function drawMusic() {
    const state = musicState();
    const key = JSON.stringify({ ...state, progress: undefined });
    if (key !== musicKey) {
      musicKey = key;
      const root = view('music', 'root');
      root.dataset.active = String(state.active);
      root.dataset.playing = String(state.playing);
      setText(view('music', 'title'), state.title);
      setText(view('music', 'artist'), state.artist);
      setText(view('music', 'source'), state.source);
      setText(view('music', 'volume'), state.volume);
      view('music', 'presets').hidden = state.active;
      const play = view('music', 'play');
      play.disabled = !state.canPlay;
      play.setAttribute('aria-label', state.playing ? 'Pausa' : 'Spela');
      view('music', 'play-icon').setAttribute(
        'd',
        state.playing ? PAUSE_PATH : PLAY_PATH,
      );
      const art = view('music', 'art');
      if ((art.getAttribute('src') || '') !== state.art) {
        view('music', 'backdrop').hidden = true;
        if (state.art) art.setAttribute('src', state.art);
        else art.removeAttribute('src');
      }
      art.hidden = !state.art;
      view('music', 'cover').dataset.state = state.art
        ? 'available'
        : 'missing';
    }
    drawProgress(state.progress);
  }

  // The bar runs as one compositor animation from where playback is to the
  // end of the track; it is restarted only when the sample changes.
  function drawProgress(sample) {
    const box = view('music', 'progress');
    const bar = view('music', 'bar');
    if (!sample || !(sample.duration > 0)) {
      box.hidden = true;
      barKey = '';
      barAnimation?.cancel();
      barAnimation = null;
      return;
    }
    box.hidden = false;
    const now =
      typeof estimatedServerNow === 'function'
        ? estimatedServerNow()
        : Date.now();
    const position = Math.min(
      sample.duration,
      sample.position +
        (sample.playing ? Math.max(0, (now - sample.at) / 1000) : 0),
    );
    setText(view('music', 'elapsed'), clockText(position));
    setText(view('music', 'duration'), clockText(sample.duration));
    const key = JSON.stringify([
      sample.position,
      sample.at,
      sample.duration,
      sample.playing,
    ]);
    if (key === barKey) return;
    barKey = key;
    barAnimation?.cancel();
    barAnimation = null;
    const from = position / sample.duration;
    bar.style.transform = `scaleX(${from.toFixed(4)})`;
    const remaining = (sample.duration - position) * 1000;
    // Only the shown page animates; a neighbour shows where playback is.
    if (
      musicShown &&
      sample.playing &&
      remaining > 0 &&
      typeof bar.animate === 'function'
    ) {
      barAnimation = bar.animate(
        [
          { transform: `scaleX(${from.toFixed(4)})` },
          { transform: 'scaleX(1)' },
        ],
        { duration: remaining, easing: 'linear', fill: 'forwards' },
      );
    }
  }

  // The backdrop is the loaded cover drawn small, once (same-origin art).
  view('music', 'art')?.addEventListener('load', () => {
    const art = view('music', 'art');
    const canvas = view('music', 'backdrop');
    const context = canvas?.getContext?.('2d');
    if (!context || !art.naturalWidth) return;
    try {
      const { width, height } = canvas;
      const scale = Math.max(
        width / art.naturalWidth,
        height / art.naturalHeight,
      );
      const w = art.naturalWidth * scale;
      const h = art.naturalHeight * scale;
      context.clearRect(0, 0, width, height);
      context.drawImage(art, (width - w) / 2, (height - h) / 2, w, h);
      canvas.hidden = false;
    } catch {
      canvas.hidden = true;
    }
  });

  view('music', 'play')?.addEventListener('click', () => {
    const data = payload();
    const target = typeof musicTarget === 'string' ? musicTarget : '';
    const device = target ? data?.state?.music?.devices?.[target] : undefined;
    if (
      !device ||
      hem()?.musicPlayback?.disabled ||
      typeof runCommand !== 'function' ||
      typeof musicPlaybackAction !== 'function'
    )
      return;
    void runCommand(`music:${target}`, {
      target,
      request: {
        property: 'playback',
        value: musicPlaybackAction(data, target),
      },
    });
  });

  view('music', 'presets')?.addEventListener('click', (event) => {
    const button = event.target.closest?.('button[data-preset]');
    if (!button || typeof selectMusicPreset !== 'function') return;
    selectMusicPreset(Number(button.dataset.preset));
  });

  // Tapping the cover on Hem opens Musik; the buttons on and around it keep
  // their own actions. The cover itself takes no pointer events (it is drawn
  // under the card), so a click that reached no control is placed against
  // the cover's box, above the title.
  const hemRoot = document.getElementById('app-root');
  const hemCover = document.getElementById('music-artwork');
  const HEM_CONTROLS =
    'button, a, input, select, textarea, label, [role="button"]';
  hemRoot?.addEventListener('click', (event) => {
    if (!hemCover || hemRoot.dataset.musicVisible !== 'true') return;
    if (event.defaultPrevented || event.target.closest?.(HEM_CONTROLS)) return;
    const cover = hemCover.getBoundingClientRect();
    const title = document
      .getElementById('music-now-playing')
      ?.getBoundingClientRect();
    const bottom = title && title.top > cover.top ? title.top : cover.bottom;
    if (
      event.clientX >= cover.left &&
      event.clientX <= cover.right &&
      event.clientY >= cover.top &&
      event.clientY <= bottom
    )
      pagesApi.go('music');
  });

  function musicTick() {
    drawMusic();
    drawDock('music');
  }

  pagesApi.define('music', {
    prepare: musicTick,
    enter() {
      window.clearInterval(musicTimer);
      musicShown = true;
      barKey = '';
      musicTick();
      musicTimer = window.setInterval(musicTick, 1000);
    },
    leave() {
      window.clearInterval(musicTimer);
      musicTimer = 0;
      musicShown = false;
      barAnimation?.cancel();
      barAnimation = null;
      barKey = '';
      drawProgress(musicState().progress);
    },
    sleep() {
      // Nothing runs while away: the bar stops with the page.
      barAnimation?.cancel();
      barAnimation = null;
      barKey = '';
    },
  });
})();
