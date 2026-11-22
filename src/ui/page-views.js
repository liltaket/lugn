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
  // take their state from the same payload Hem's buttons do: selected is
  // the current scene, busy while its command is pending, waiting while the
  // lamps have not reported the current scene revision, and disabled while
  // Lugn is unavailable or the command is pending.

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
    const state = payload()?.state;
    const current = state?.lighting?.currentScene;
    const awaiting = Boolean(
      state?.commands?.some(
        (command) =>
          command.revision === state.lighting?.sceneRevision &&
          command.status === 'pending',
      ),
    );
    for (const button of dock.children) {
      const id = button.dataset.scene;
      const busy = typeof pending === 'object' && pending.has(`scene:${id}`);
      const selected = id === current;
      const look = busy
        ? 'pending'
        : !selected
          ? 'idle'
          : awaiting
            ? 'awaiting'
            : 'selected';
      setAttr(button, 'aria-pressed', String(selected));
      setAttr(button, 'aria-busy', String(busy));
      if (button.dataset.state !== look) button.dataset.state = look;
      if (button.disabled !== (offline || busy))
        button.disabled = offline || busy;
    }
  }

  function setAttr(element, name, value) {
    if (element.getAttribute(name) !== value) element.setAttribute(name, value);
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

  // ── Notices: Hem's toast and connection notice on every page ──
  //
  // Commands sent from any page report through Hem's toast; while another
  // page is shown, the same words show here (a live region), and a lost
  // connection stays shown until Hem's notice goes.

  const notice = document.getElementById('pages-notice');
  const hemToast = document.getElementById('toast');
  const hemConnection = document.getElementById('connection-notice');
  function syncNotice() {
    if (!notice) return;
    let text = '';
    let look = '';
    if (pagesApi.current() !== 'home') {
      if (hemConnection && !hemConnection.hidden) {
        text =
          document.getElementById('connection-message')?.textContent?.trim() ||
          '';
        look = 'error';
      } else if (hemToast && !hemToast.hidden) {
        text = hemToast.textContent.trim();
        look = hemToast.dataset.state || '';
      }
    }
    setText(notice, text);
    if (notice.dataset.state !== look) notice.dataset.state = look;
    if (notice.hidden !== !text) notice.hidden = !text;
  }
  if (notice && typeof MutationObserver === 'function') {
    const observer = new MutationObserver(syncNotice);
    for (const element of [hemToast, hemConnection])
      if (element)
        observer.observe(element, {
          attributes: true,
          attributeFilter: ['hidden', 'data-state'],
          childList: true,
          characterData: true,
          subtree: true,
        });
  }
  pagesApi.onChange(syncNotice);

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
    // As a neighbour Info is drawn once; its facts change every second and
    // are redrawn when it is shown.
    prepare() {
      if (!infoKey) drawInfo();
    },
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
  // The action the play button shows; a press sends exactly this.
  let shownPlayAction = 'playing';

  function clockText(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  const LAST_PLAYED = 'Senast spelat: ';
  function hemTitle(r) {
    const text = r?.musicTitle?.textContent?.trim() || '';
    return text.startsWith(LAST_PLAYED)
      ? { title: text.slice(LAST_PLAYED.length), lastPlayed: true }
      : { title: text, lastPlayed: false };
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
      ready: Boolean(data),
      active,
      title: active ? hemTitle(r).title : 'Ingen musik spelar',
      // Last played: Hem's receiver title says so, or (computer media) its
      // status line.
      lastPlayed:
        active &&
        (hemTitle(r).lastPlayed ||
          r?.musicPlayerStatus?.textContent?.trim() === 'Senast spelat'),
      // When the card has gone (no music, or the pause has run out) nothing of
      // the last track stays: no artist and no cover.
      artist:
        active && r?.musicArtist && !r.musicArtist.hidden
          ? r.musicArtist.textContent.trim()
          : '',
      source: active ? r?.musicSource?.textContent?.trim() || '' : '',
      // While Hem loads a new cover, keep what is shown (null) rather than
      // flashing the empty cover.
      art: !active
        ? ''
        : artReady
          ? r.musicArtworkImage.getAttribute('src') || ''
          : active && r?.musicArtwork?.dataset.state === 'loading'
            ? null
            : '',
      // Hem's own play button label says what a press does there (Pausa
      // only when a press pauses; a manual pause on a player that still
      // reports playing reads Spela).
      playing: r?.musicPlaybackLabel?.textContent?.trim() === 'Pausa',
      canPlay: Boolean(device) && r?.musicPlayback?.disabled === false,
      playBusy: r?.musicPlayback?.getAttribute('aria-busy') === 'true',
      presets: [...(r?.musicPresets?.children ?? [])]
        .filter((button) => button.dataset?.presetId)
        .map((button) => ({
          id: button.dataset.presetId,
          label: button.textContent.trim(),
          disabled: button.disabled,
          busy: button.getAttribute('aria-busy') === 'true',
        })),
      volume:
        typeof volume === 'number' && Number.isFinite(volume)
          ? Math.round(Math.min(1, Math.max(0, volume)) * 100)
          : null,
      // The server says whether this player can skip (Nästa låt).
      nextBusy:
        typeof pending === 'object' && pending.has(`music-track:${target}`),
      canSkip:
        Boolean(device) &&
        data?.musicTrackControl?.[target] === true &&
        r?.musicPlayback?.disabled === false,
      progress:
        typeof musicProgress === 'object' && musicProgress
          ? { ...musicProgress }
          : null,
    };
  }

  function drawMusic() {
    const state = musicState();
    // The cover URL (possibly a long data: URL of Hem's trimmed cover) is
    // compared on its own, not serialised into the key every second.
    drawCover(state.art);
    const key = JSON.stringify({
      ...state,
      art: undefined,
      progress: undefined,
    });
    if (key !== musicKey) {
      musicKey = key;
      const root = view('music', 'root');
      root.dataset.ready = String(state.ready);
      root.dataset.active = String(state.active);
      root.dataset.playing = String(state.playing);
      const titleChanged =
        view('music', 'title').textContent !== state.title ||
        view('music', 'artist').textContent !== state.artist;
      setText(view('music', 'title'), state.title);
      setText(view('music', 'artist'), state.artist);
      // After a while in pause Hem marks the title as last played; here it
      // is said quietly above the title instead.
      setText(
        view('music', 'source'),
        state.lastPlayed
          ? ['Senast spelat', state.source].filter(Boolean).join(' · ')
          : state.source,
      );
      if (titleChanged) reveal(view('music', 'text'), 8);
      drawVolume(state.volume);
      const next = view('music', 'next');
      setAttr(next, 'aria-busy', String(state.nextBusy));
      if (next.disabled !== state.nextBusy) next.disabled = state.nextBusy;
      if (next.hidden !== !(state.active && state.canSkip))
        next.hidden = !(state.active && state.canSkip);
      drawPresets(state);
      const play = view('music', 'play');
      shownPlayAction = state.playing ? 'paused' : 'playing';
      play.disabled = !state.canPlay;
      setAttr(play, 'aria-busy', String(state.playBusy));
      setAttr(play, 'aria-label', state.playing ? 'Pausa' : 'Spela');
      view('music', 'play-icon').setAttribute(
        'd',
        state.playing ? PAUSE_PATH : PLAY_PATH,
      );
    }
    drawProgress(state.progress);
  }

  // Hem's choices in Hem's order, disabled and busy as there.
  function drawPresets(state) {
    const box = view('music', 'presets');
    box.hidden = state.active;
    const key = state.presets.map((preset) => `${preset.id}:${preset.label}`);
    if (box.dataset.key !== key.join('|')) {
      box.dataset.key = key.join('|');
      box.replaceChildren(
        ...state.presets.map((preset) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.dataset.preset = preset.id;
          button.textContent = preset.label;
          return button;
        }),
      );
    }
    for (const button of box.children) {
      const preset = state.presets.find((p) => p.id === button.dataset.preset);
      if (!preset) continue;
      if (button.disabled !== preset.disabled)
        button.disabled = preset.disabled;
      setAttr(button, 'aria-busy', String(preset.busy));
    }
  }

  // The volume as a level, not a number (the number is for screen readers).
  function drawVolume(percent) {
    const box = view('music', 'volume');
    if (box.hidden !== (percent === null)) box.hidden = percent === null;
    if (percent === null) return;
    setAttr(box, 'aria-label', `Volym ${percent} %`);
    const fill = view('music', 'volume-fill');
    const transform = `scaleX(${(percent / 100).toFixed(2)})`;
    if (fill.style.transform !== transform) fill.style.transform = transform;
  }

  // A short rise and fade-in (opacity and transform only), shown only on the
  // page in view and not when the viewer asks for less motion.
  const calm =
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches;
  function reveal(element, rise = 12, delay = 0, duration = 360) {
    if (!musicShown || calm || typeof element?.animate !== 'function') return;
    element.animate(
      [
        { opacity: 0, transform: `translateY(${rise}px)` },
        { opacity: 1, transform: 'none' },
      ],
      {
        duration,
        delay,
        easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
        fill: 'backwards',
      },
    );
  }

  // Musik's own image decides what its cover shows. A new cover is decoded
  // first and then faded in over the old one, so a track change never shows
  // an empty square; a failed one falls back to the note.
  let coverRequest = 0;
  let coverUrl = '';
  function resetAccent() {
    view('music', 'root').style.removeProperty('--music-accent');
  }

  function drawCover(url) {
    if (url === null || url === coverUrl) return;
    coverUrl = url;
    const request = ++coverRequest;
    const cover = view('music', 'cover');
    if (!url) {
      view('music', 'art').hidden = true;
      view('music', 'art-prev').hidden = true;
      view('music', 'backdrop').hidden = true;
      cover.dataset.state = 'missing';
      resetAccent();
      return;
    }
    if (cover.dataset.state !== 'available') cover.dataset.state = 'loading';
    const next = new Image();
    next.decoding = 'async';
    next.src = url;
    const shown = () => {
      if (request !== coverRequest) return;
      const art = view('music', 'art');
      const prev = view('music', 'art-prev');
      // The old cover stays underneath while the new one fades in over it.
      const crossfade =
        musicShown &&
        !calm &&
        !art.hidden &&
        art.getAttribute('src') &&
        typeof art.animate === 'function';
      if (crossfade) {
        prev.setAttribute('src', art.getAttribute('src'));
        prev.hidden = false;
      }
      art.setAttribute('src', url);
      art.hidden = false;
      cover.dataset.state = 'available';
      drawBackdrop(next, crossfade);
      if (musicShown && !calm && typeof art.animate === 'function') {
        const fade = art.animate(
          [
            { opacity: 0, transform: 'scale(1.04)' },
            { opacity: 1, transform: 'none' },
          ],
          { duration: 480, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
        );
        fade.onfinish = () => {
          if (request === coverRequest) prev.hidden = true;
        };
      } else prev.hidden = true;
    };
    const failed = () => {
      if (request !== coverRequest) return;
      view('music', 'art').hidden = true;
      view('music', 'art-prev').hidden = true;
      view('music', 'backdrop').hidden = true;
      cover.dataset.state = 'missing';
      resetAccent();
    };
    (typeof next.decode === 'function'
      ? next.decode()
      : new Promise((resolve, reject) => {
          next.onload = resolve;
          next.onerror = reject;
        })
    ).then(shown, failed);
  }

  // The backdrop: the cover drawn once into a small canvas with a blur, and
  // its average colour as the page's accent (one style write per cover).
  function drawBackdrop(image, fadeIn = false) {
    const canvas = view('music', 'backdrop');
    const context = canvas?.getContext?.('2d', { willReadFrequently: true });
    if (!context || !image.naturalWidth) return;
    try {
      const { width, height } = canvas;
      const scale =
        Math.max(width / image.naturalWidth, height / image.naturalHeight) *
        1.25;
      const w = image.naturalWidth * scale;
      const h = image.naturalHeight * scale;
      context.clearRect(0, 0, width, height);
      context.filter = 'blur(10px) saturate(1.25)';
      context.drawImage(image, (width - w) / 2, (height - h) / 2, w, h);
      context.filter = 'none';
      const data = context.getImageData(0, 0, width, height).data;
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      // Coloured, opaque pixels count most: transparent ones and greys
      // barely move the accent.
      for (let i = 0; i < data.length; i += 16) {
        const alpha = data[i + 3] / 255;
        const chroma =
          (Math.max(data[i], data[i + 1], data[i + 2]) -
            Math.min(data[i], data[i + 1], data[i + 2])) /
          255;
        const weight = alpha * (0.15 + chroma);
        r += data[i] * weight;
        g += data[i + 1] * weight;
        b += data[i + 2] * weight;
        n += weight;
      }
      const root = view('music', 'root');
      if (n > 0) {
        const [ar, ag, ab] = accentFrom(r / n, g / n, b / n);
        root.style.setProperty('--music-accent', `rgb(${ar}, ${ag}, ${ab})`);
      } else resetAccent();
      const wasHidden = canvas.hidden;
      canvas.hidden = false;
      if (
        (wasHidden || fadeIn) &&
        musicShown &&
        !calm &&
        typeof canvas.animate === 'function'
      )
        canvas.animate([{ opacity: wasHidden ? 0 : 0.35 }, { opacity: 0.85 }], {
          duration: 700,
          easing: 'ease-out',
        });
    } catch {
      canvas.hidden = true;
      resetAccent();
    }
  }

  // The average of a cover is often muddy: keep its hue, give it a clear,
  // light tone; a grey cover falls back to the dashboard's warm accent.
  function accentFrom(r, g, b) {
    const max = Math.max(r, g, b) / 255;
    const min = Math.min(r, g, b) / 255;
    const delta = max - min;
    // Grey or nearly black covers have no colour worth taking.
    if (delta < 0.06 || max < 0.14) return [231, 188, 120];
    let hue;
    if (max === r / 255) hue = ((g - b) / 255 / delta) % 6;
    else if (max === g / 255) hue = (b - r) / 255 / delta + 2;
    else hue = (r - g) / 255 / delta + 4;
    hue = (hue * 60 + 360) % 360;
    const sat = Math.min(
      0.62,
      Math.max(0.32, (delta / (1 - Math.abs(max + min - 1))) * 1.2),
    );
    const light = 0.68;
    const c = (1 - Math.abs(2 * light - 1)) * sat;
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
    const m = light - c / 2;
    const [r1, g1, b1] =
      hue < 60
        ? [c, x, 0]
        : hue < 120
          ? [x, c, 0]
          : hue < 180
            ? [0, c, x]
            : hue < 240
              ? [0, x, c]
              : hue < 300
                ? [x, 0, c]
                : [c, 0, x];
    return [r1, g1, b1].map((v) => Math.round((v + m) * 255));
  }

  // The bar runs as one compositor animation from where playback is to the
  // end of the track; it is restarted only when the sample changes.
  function drawProgress(sample) {
    const box = view('music', 'progress');
    const bar = view('music', 'bar');
    if (!sample || !(sample.duration > 0)) {
      if (!box.hidden) box.hidden = true;
      if (barKey) {
        barKey = '';
        barAnimation?.cancel();
        barAnimation = null;
      }
      return;
    }
    if (box.hidden) box.hidden = false;
    const now =
      typeof estimatedServerNow === 'function'
        ? estimatedServerNow()
        : Date.now();
    const position = Math.min(
      sample.duration,
      sample.position +
        (sample.playing ? Math.max(0, (now - sample.at) / 1000) : 0),
    );
    setText(view('music', 'duration'), clockText(sample.duration));
    const key = JSON.stringify([
      sample.position,
      sample.at,
      sample.duration,
      sample.playing,
    ]);
    // The elapsed time ticks only on the shown page; a neighbour kept warm
    // in idle time writes it only when the sample changes (a new track, a
    // seek), so it is never repainted just for the clock.
    if (musicShown || key !== barKey)
      setText(view('music', 'elapsed'), clockText(position));
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

  // A press sends what the button shows (as Hem holds its action through a
  // press), never an action recomputed from a newer state behind the label.
  // The action is taken when the press starts, as Hem holds its own, so a
  // redraw during the press cannot change what the release sends.
  let pressedPlay = null;
  view('music', 'play')?.addEventListener('pointerdown', () => {
    pressedPlay = { action: shownPlayAction, at: performance.now() };
  });
  view('music', 'play')?.addEventListener('click', () => {
    // A press that never clicked (a swipe that started here) is forgotten.
    const action =
      pressedPlay && performance.now() - pressedPlay.at < 2000
        ? pressedPlay.action
        : shownPlayAction;
    pressedPlay = null;
    const data = payload();
    const target = typeof musicTarget === 'string' ? musicTarget : '';
    const device = target ? data?.state?.music?.devices?.[target] : undefined;
    if (
      !device ||
      view('music', 'play').disabled ||
      hem()?.musicPlayback?.disabled !== false ||
      typeof runCommand !== 'function'
    )
      return;
    void runCommand(`music:${target}`, {
      target,
      request: { property: 'playback', value: action },
    });
    window.setTimeout(drawMusic, 0);
  });

  // Nästa låt: a one-off request the player either takes or not; the new
  // title arrives with the next state.
  view('music', 'next')?.addEventListener('click', () => {
    const data = payload();
    const target = typeof musicTarget === 'string' ? musicTarget : '';
    if (
      !target ||
      view('music', 'next').hidden ||
      data?.musicTrackControl?.[target] !== true ||
      hem()?.musicPlayback?.disabled !== false ||
      typeof runCommand !== 'function'
    )
      return;
    // Its own command key: a pending play does not swallow it, nor does it
    // make the play button look busy.
    void runCommand(`music-track:${target}`, {
      target,
      request: { property: 'track', value: 'next' },
    });
    window.setTimeout(drawMusic, 0);
  });

  // A choice is sent only while Hem's own button for it is enabled.
  view('music', 'presets')?.addEventListener('click', (event) => {
    const button = event.target.closest?.('button[data-preset]');
    if (!button || button.disabled || typeof selectMusicPreset !== 'function')
      return;
    const source = [...(hem()?.musicPresets?.children ?? [])].find(
      (candidate) => candidate.dataset?.presetId === button.dataset.preset,
    );
    if (!source || source.disabled) return;
    selectMusicPreset(Number(button.dataset.preset));
    window.setTimeout(drawMusic, 0);
  });

  // Tapping the cover on Hem opens Musik. The visible cover image is the
  // target (in every layout, at its own size), reachable by keyboard; the
  // controls around it keep their own actions.
  const hemCover = document.getElementById('music-artwork-image');
  if (hemCover) {
    hemCover.setAttribute('role', 'button');
    hemCover.setAttribute('tabindex', '0');
    hemCover.setAttribute('aria-label', 'Visa musiken i helskärm');
    const open = () => {
      if (
        !hemCover.hidden &&
        document.getElementById('app-root')?.dataset.musicVisible === 'true'
      )
        pagesApi.go('music');
    };
    hemCover.addEventListener('click', open);
    hemCover.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      open();
    });
  }

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
