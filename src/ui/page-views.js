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
    for (const canvas of document.querySelectorAll('.page-canvas, .hub-nav')) {
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

  // The navbar is a quick menu, so it holds few and large choices: not the
  // soft, music and party scenes (Hem has them), but Filmkväll and Dynamisk,
  // which follows the music and the situation by itself.
  const DOCK_HIDDEN = new Set([
    'scene.soft_light',
    'scene.music',
    'scene.party',
  ]);
  const DOCK_MAX = 5;

  function dockScenes() {
    if (typeof getSceneList !== 'function') return [];
    const scenes = getSceneList(payload()).filter(
      (scene) =>
        !scene.id.startsWith('scene.custom_') && !DOCK_HIDDEN.has(scene.id),
    );
    // Släck last, as the way out.
    const off = scenes.filter((scene) => scene.id === 'scene.all_off');
    const rest = scenes.filter((scene) => scene.id !== 'scene.all_off');
    return [...rest.slice(0, DOCK_MAX - off.length), ...off];
  }

  function dockButton(scene) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.scene = scene.id;
    const icon =
      typeof sceneIconFor === 'function' ? sceneIconFor(scene.id) : null;
    const name = scene.id === 'scene.all_off' ? 'Släck' : scene.name;
    if (icon) {
      // The same fixed pictograms as Hem; the bar shows only the picture (the
      // name is the button's label and tooltip).
      button.insertAdjacentHTML(
        'beforeend',
        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${icon.paths}</svg>`,
      );
    } else {
      // A scene without a picture keeps its name, so it is never an empty button.
      const label = document.createElement('span');
      label.textContent = name;
      button.append(label);
    }
    button.setAttribute('aria-label', name);
    button.title = scene.name;
    return button;
  }

  // The one dock lives in the navbar (quick-menu.js), which draws it while it
  // is open.
  const navDock = document.querySelector('#hub-nav [data-view="dock"]');
  let dockKey = '';
  function drawDock(dock = navDock) {
    if (!dock) return;
    const scenes = dockScenes();
    const listKey = scenes
      .map((scene) => `${scene.id}\u0000${scene.name}`)
      .join('\u0001');
    if (dockKey !== listKey) {
      dockKey = listKey;
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
    // Pending shows at once; the confirmation follows the next state.
    window.setTimeout(() => drawDock(), 0);
  }
  navDock?.addEventListener('click', onDockClick);
  globalThis.lugnSceneDock = { draw: drawDock };

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
    // Behind a computer input the steps and the position are the computer's
    // media; otherwise the player's own.
    const desktop = data?.state?.music?.computerPlayback?.[target];
    const onComputer = desktop?.active === true;
    const connected =
      typeof isUnavailable === 'function' ? !isUnavailable() : true;
    const ownControl =
      Boolean(device) &&
      data?.musicTrackControl?.[target] === true &&
      r?.musicPlayback?.disabled === false;
    const computerControl = (flag) =>
      onComputer && connected && !desktop.pending && desktop[flag] === true;
    // The player says what it plays well before Hem hears of it (and where
    // it can be asked): its track and cover then lead.
    const player = active ? globalThis.lugnLyrics?.player(target) : null;
    const hemName = hemTitle(r).title.replace(/…$/, '').trimEnd();
    const ahead = Boolean(player) && !player.title.startsWith(hemName);
    const progress =
      ahead && player.progress
        ? player.progress
        : typeof musicProgress === 'object' && musicProgress
          ? { ...musicProgress }
          : null;
    const hemArt = artReady
      ? r.musicArtworkImage.getAttribute('src') || ''
      : r?.musicArtwork?.dataset.state === 'loading'
        ? null
        : '';
    return {
      ready: Boolean(data),
      active,
      title: !active
        ? 'Ingen musik spelar'
        : player
          ? player.title
          : hemTitle(r).title,
      // Last played: Hem's receiver title says so, or (computer media) its
      // status line.
      lastPlayed:
        active &&
        !ahead &&
        (hemTitle(r).lastPlayed ||
          r?.musicPlayerStatus?.textContent?.trim() === 'Senast spelat'),
      // When the card has gone (no music, or the pause has run out) nothing of
      // the last track stays: no artist and no cover.
      artist: player
        ? player.artist
        : active && r?.musicArtist && !r.musicArtist.hidden
          ? r.musicArtist.textContent.trim()
          : '',
      source: active ? r?.musicSource?.textContent?.trim() || '' : '',
      // While Hem loads a new cover, keep what is shown (null) rather than
      // flashing the empty cover.
      // With the player ahead, Hem's cover is the last track's.
      art: !active
        ? ''
        : player
          ? (player.art ?? (ahead ? null : hemArt))
          : hemArt,
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
      volume: shownVolume(target, device),
      // Adjustable exactly when Hem's own volume buttons are.
      canVolume:
        r?.musicVolumeDown?.disabled === false ||
        r?.musicVolumeUp?.disabled === false,
      // The server says whether this player, or the computer's playing media,
      // can step and seek. A computer's buttons stay (disabled) while it
      // cannot, so they do not come and go with its playback.
      stepBusy:
        typeof pending === 'object' && pending.has(`music-track:${target}`),
      showSteps: ownControl || (Boolean(device) && onComputer),
      canNext: onComputer ? computerControl('canNext') : ownControl,
      canPrevious: onComputer ? computerControl('canPrevious') : ownControl,
      canSeek:
        Boolean(progress) &&
        (onComputer ? computerControl('canSeek') : ownControl),
      progress: progress && shownProgress(target, progress),
    };
  }

  function drawMusic() {
    const state = musicState();
    // The cover URL (possibly a long data: URL of Hem's trimmed cover) is
    // compared on its own, not serialised into the key every second.
    drawCover(state.art, state.active, state.title);
    const key = JSON.stringify({
      ...state,
      art: undefined,
      progress: undefined,
      volume: undefined,
      canSeek: undefined,
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
      for (const [name, can] of [
        ['previous', state.canPrevious],
        ['next', state.canNext],
      ]) {
        const button = view('music', name);
        setAttr(button, 'aria-busy', String(state.stepBusy));
        const disabled = state.stepBusy || !can;
        if (button.disabled !== disabled) button.disabled = disabled;
        const hidden = !(state.active && state.showSteps);
        if (button.hidden !== hidden) button.hidden = hidden;
      }
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
    drawVolume(state.volume, state.canVolume);
    drawProgress(state.progress);
    drawSeek(state.progress, state.canSeek && state.active, state.title);
    drawLyrics(state);
  }

  // The lyrics (lyrics-view.js) follow the same track and position as the
  // controls beside them.
  function drawLyrics(state) {
    globalThis.lugnLyrics?.draw({
      target: currentTarget(),
      shown: musicShown,
      ready: state.ready,
      active: state.active,
      title: state.title,
      artist: state.artist,
      progress: state.progress,
      playing: state.playing,
      // The server's own word on the track: a change is asked about at once.
      announced: payload()?.nowPlaying?.[currentTarget()],
      serverNow,
    });
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
  function drawVolume(percent, adjustable) {
    const box = view('music', 'volume');
    if (box.hidden !== (percent === null)) box.hidden = percent === null;
    if (percent === null) {
      volumeSlider?.enable(false);
      return;
    }
    volumeSlider?.enable(adjustable, {
      label: 'Volym',
      max: 100,
      now: percent,
      text: `${percent} %`,
    });
    // While it is held, the finger says where the level is.
    if (!volumeSlider?.held()) drawLevel(percent / 100);
  }

  function drawLevel(fraction) {
    const fill = view('music', 'volume-fill');
    const transform = `scaleX(${fraction.toFixed(2)})`;
    if (fill.style.transform !== transform) fill.style.transform = transform;
    volumeSlider?.at(fraction);
  }

  // ── Adjusting: drag, tap, wheel or arrow keys on the two bars ──

  const WHEEL_NOTCH_PX = 40;
  const WHEEL_SEND_MS = 250;
  const VOLUME_SEND_MS = 300;
  const VOLUME_STEP = 0.02;
  const SEEK_STEP_SECONDS = 5;
  // How long a sent level or position is shown while no report confirms it.
  const VOLUME_HOLD_MS = 4000;
  const SEEK_HOLD_MS = 5000;

  const clamp = (value) => Math.min(1, Math.max(0, value));

  // Where along an element a pointer is. Older engines give a zoomed canvas's
  // rects in its own px, the pointer in the screen's.
  function fractionAt(element, clientX) {
    const rect = element.getBoundingClientRect();
    const zoom =
      Number(element.closest?.('.page-canvas')?.style.zoom || 1) || 1;
    const scale =
      zoom !== 1 && Math.abs(rect.width - element.offsetWidth) < 1 ? zoom : 1;
    return rect.width > 0
      ? clamp((clientX - rect.left * scale) / (rect.width * scale))
      : 0;
  }

  // A horizontal bar taken by touch, the mouse (also the bridged one, whose
  // held moves reach the document), the wheel or the arrow keys. `value` is
  // where it stands, `show` draws a position while it is adjusted, `move`
  // hears the drag and `commit` the position chosen. A bar that cannot be
  // adjusted is left alone: a swipe over it turns the page as before.
  function adjustable(element, { value, step, show, move, commit, restore }) {
    if (!element) return null;
    let enabled = false;
    let drag = null;
    let wheeled = null;
    let wheelTimer = 0;
    let wheelSum = 0;

    const held = () => Boolean(drag || wheeled !== null);
    function preview(fraction) {
      show(fraction);
      element.style.setProperty('--at', fraction.toFixed(4));
    }
    function end() {
      drag = null;
      wheeled = null;
      window.clearTimeout(wheelTimer);
      wheelSum = 0;
      element.removeAttribute('data-dragging');
    }
    function cancel() {
      if (!held()) return;
      end();
      restore();
    }
    function choose(fraction) {
      end();
      commit(fraction);
    }

    element.addEventListener('pointerdown', (event) => {
      if (!enabled || event.button !== 0 || drag) return;
      event.preventDefault();
      end();
      drag = { id: event.pointerId, at: fractionAt(element, event.clientX) };
      element.setAttribute('data-dragging', 'true');
      try {
        element.setPointerCapture?.(event.pointerId);
      } catch {
        // The bridge's synthetic pointer cannot be captured; it bubbles.
      }
      preview(drag.at);
    });
    const mine = (event) => drag && event.pointerId === drag.id;
    document.addEventListener('pointermove', (event) => {
      if (!mine(event)) return;
      drag.at = fractionAt(element, event.clientX);
      preview(drag.at);
      move?.(drag.at);
    });
    document.addEventListener('pointerup', (event) => {
      if (mine(event)) choose(fractionAt(element, event.clientX));
    });
    document.addEventListener('pointercancel', (event) => {
      if (mine(event)) cancel();
    });

    // Up or right is more. A wheel notch is one step; a trackpad's small
    // deltas add up to one. The choice is sent once the wheel rests.
    element.addEventListener(
      'wheel',
      (event) => {
        if (!enabled) return;
        event.preventDefault();
        if (drag) return;
        const delta =
          Math.abs(event.deltaX) > Math.abs(event.deltaY)
            ? event.deltaX
            : -event.deltaY;
        wheelSum += delta * (event.deltaMode === 1 ? WHEEL_NOTCH_PX : 1);
        if (Math.abs(wheelSum) < WHEEL_NOTCH_PX) return;
        const direction = Math.sign(wheelSum);
        wheelSum = 0;
        wheeled = clamp((wheeled ?? value()) + direction * step());
        element.setAttribute('data-dragging', 'true');
        preview(wheeled);
        window.clearTimeout(wheelTimer);
        wheelTimer = window.setTimeout(() => choose(wheeled), WHEEL_SEND_MS);
      },
      { passive: false },
    );

    element.addEventListener('keydown', (event) => {
      const direction = {
        ArrowRight: 1,
        ArrowUp: 1,
        ArrowLeft: -1,
        ArrowDown: -1,
      }[event.key];
      if (!enabled || !direction) return;
      // The pager's own arrow keys stay out of it.
      event.preventDefault();
      const next = clamp(value() + direction * step());
      preview(next);
      choose(next);
    });

    return {
      held,
      cancel,
      at(fraction) {
        if (!held()) element.style.setProperty('--at', fraction.toFixed(4));
      },
      enable(on, aria) {
        if (on !== enabled) {
          enabled = on;
          if (on) {
            element.setAttribute('role', 'slider');
            element.setAttribute('tabindex', '0');
            element.setAttribute('data-pager', 'ignore');
          } else {
            cancel();
            for (const name of [
              'role',
              'tabindex',
              'data-pager',
              'aria-label',
              'aria-valuemin',
              'aria-valuemax',
              'aria-valuenow',
              'aria-valuetext',
            ])
              element.removeAttribute(name);
          }
        }
        if (!on || !aria) return;
        setAttr(element, 'aria-label', aria.label);
        setAttr(element, 'aria-valuemin', '0');
        setAttr(element, 'aria-valuemax', String(aria.max));
        setAttr(element, 'aria-valuenow', String(aria.now));
        setAttr(element, 'aria-valuetext', aria.text);
      },
    };
  }

  const currentTarget = () =>
    typeof musicTarget === 'string' ? musicTarget : '';

  // Volume: sent while dragging (not too often) and on release, one request at
  // a time with only the newest level waiting. Shown as chosen until the
  // player reports it.
  let chosenVolume = null;
  let queuedVolume = null;
  let sendingVolume = false;
  let volumeSentAt = -Infinity;
  const playerVolume = () => {
    const device = payload()?.state?.music?.devices?.[currentTarget()];
    return device ? shownVolume(currentTarget(), device) : null;
  };

  function shownVolume(target, device) {
    const observed = device?.observed?.volume;
    const percent =
      typeof observed === 'number' && Number.isFinite(observed)
        ? Math.round(clamp(observed) * 100)
        : null;
    if (chosenVolume?.target !== target) return percent;
    if (
      percent === null ||
      percent === chosenVolume.percent ||
      performance.now() >= chosenVolume.until
    ) {
      chosenVolume = null;
      return percent;
    }
    return chosenVolume.percent;
  }

  async function sendVolume(fraction) {
    const target = currentTarget();
    if (!target || typeof runCommand !== 'function') return;
    const percent = Math.round(clamp(fraction) * 100);
    // The level already on its way (or standing) is not asked for twice.
    if (percent === (chosenVolume?.percent ?? playerVolume())) return;
    chosenVolume = {
      target,
      percent,
      until: performance.now() + VOLUME_HOLD_MS,
    };
    volumeSentAt = performance.now();
    queuedVolume = { target, value: percent / 100 };
    if (sendingVolume) return;
    sendingVolume = true;
    try {
      while (queuedVolume) {
        const next = queuedVolume;
        queuedVolume = null;
        // Its own command key: a drag neither waits for Play nor marks it.
        await runCommand(`music-volume:${next.target}`, {
          target: next.target,
          request: { property: 'volume', value: next.value },
        });
      }
    } finally {
      sendingVolume = false;
    }
  }

  const volumeSlider = adjustable(view('music', 'volume-slider'), {
    value: () => (playerVolume() ?? 0) / 100,
    step: () => VOLUME_STEP,
    show: (fraction) => drawLevel(fraction),
    move: (fraction) => {
      if (performance.now() - volumeSentAt >= VOLUME_SEND_MS)
        void sendVolume(fraction);
    },
    commit: (fraction) => {
      void sendVolume(fraction);
      drawMusic();
    },
    restore: () => drawMusic(),
  });

  // Time: one seek when the finger lets go. Shown there until the player
  // reports a position taken after it.
  let chosenPosition = null;
  let seekSample = null;
  let seekTrack = '';
  function shownProgress(target, sample) {
    if (chosenPosition?.target !== target) return sample;
    if (
      sample.at > chosenPosition.at ||
      sample.duration !== chosenPosition.duration ||
      performance.now() >= chosenPosition.until
    ) {
      chosenPosition = null;
      return sample;
    }
    return {
      ...sample,
      position: chosenPosition.position,
      at: chosenPosition.at,
    };
  }

  const positionNow = (sample) =>
    Math.min(
      sample.duration,
      sample.position +
        (sample.playing ? Math.max(0, (serverNow() - sample.at) / 1000) : 0),
    );

  function drawSeek(sample, seekable, title) {
    // A position chosen on one track is never sent to the next.
    if (
      seekSlider?.held() &&
      (title !== seekTrack || sample?.duration !== seekSample?.duration)
    )
      seekSlider.cancel();
    if (!seekSlider?.held()) {
      seekSample = sample;
      seekTrack = title;
    }
    if (!sample || !(sample.duration > 0)) {
      seekSlider?.enable(false);
      return;
    }
    const position = positionNow(sample);
    seekSlider?.enable(seekable, {
      label: 'Position i låten',
      max: Math.floor(sample.duration),
      now: Math.floor(position),
      text: `${clockText(position)} av ${clockText(sample.duration)}`,
    });
    seekSlider?.at(position / sample.duration);
  }

  const seekSlider = adjustable(view('music', 'seek'), {
    value: () =>
      seekSample ? positionNow(seekSample) / seekSample.duration : 0,
    step: () => (seekSample ? SEEK_STEP_SECONDS / seekSample.duration : 0),
    show: (fraction) => {
      barAnimation?.cancel();
      barAnimation = null;
      barKey = '';
      view('music', 'bar').style.transform = `scaleX(${fraction.toFixed(4)})`;
      if (seekSample)
        setText(
          view('music', 'elapsed'),
          clockText(fraction * seekSample.duration),
        );
    },
    commit: (fraction) => {
      const target = currentTarget();
      if (!target || !seekSample || typeof runCommand !== 'function') return;
      const position = Math.floor(fraction * seekSample.duration);
      chosenPosition = {
        target,
        position,
        duration: seekSample.duration,
        at: serverNow(),
        until: performance.now() + SEEK_HOLD_MS,
      };
      void runCommand(`music-seek:${target}`, {
        target,
        request: { property: 'seek', value: position },
      });
      globalThis.lugnLyrics?.seek(position);
      drawMusic();
    },
    restore: () => {
      barKey = '';
      drawMusic();
    },
  });

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

  // Musik's own images decide what its cover shows. A new cover is loaded
  // and decoded in the hidden one of two images, then faded in over the shown
  // one, so a track change never shows an empty square.
  const COVER_MS = 240;
  // The backdrop is drawn once the new cover has started to show.
  const BACKDROP_AFTER_MS = 40;
  // A track without a cover keeps the last one this long before it goes.
  const NO_COVER_MS = 5_000;
  let coverRequest = 0;
  let coverUrl = '';
  let coverFront = null;
  let noCoverTimer = 0;
  function resetAccent() {
    const root = view('music', 'root');
    root.style.removeProperty('--music-accent');
    root.style.removeProperty('--nb-rgb');
  }

  function emptyCover() {
    coverFront = null;
    view('music', 'art').hidden = true;
    view('music', 'art-prev').hidden = true;
    for (const name of ['backdrop', 'backdrop-next']) {
      const canvas = view('music', name);
      if (canvas) canvas.hidden = true;
    }
    view('music', 'cover').dataset.state = 'missing';
    resetAccent();
  }

  // `keep` while music still plays: the next cover is usually moments away.
  // `track` names whose cover it is: the same track's picture from another
  // place fades in without the small zoom a new track's has.
  let coverTrack = '';
  function drawCover(url, keep = false, track = '') {
    if (url === null) return;
    if (!url) {
      if (keep && coverFront) {
        if (!noCoverTimer)
          noCoverTimer = window.setTimeout(() => {
            noCoverTimer = 0;
            coverUrl = '';
            coverRequest += 1;
            emptyCover();
          }, NO_COVER_MS);
        return;
      }
      window.clearTimeout(noCoverTimer);
      noCoverTimer = 0;
      if (coverUrl === '' && !coverFront) return;
      coverUrl = '';
      coverRequest += 1;
      emptyCover();
      return;
    }
    window.clearTimeout(noCoverTimer);
    noCoverTimer = 0;
    if (url === coverUrl) return;
    coverUrl = url;
    const asked = performance.now();
    const request = ++coverRequest;
    const cover = view('music', 'cover');
    if (cover.dataset.state !== 'available') cover.dataset.state = 'loading';
    const images = [view('music', 'art'), view('music', 'art-prev')];
    const next = images.find((image) => image !== coverFront);
    next.hidden = true;
    next.setAttribute('src', url);
    const shown = () => {
      if (request !== coverRequest) return;
      const last = coverFront;
      coverFront = next;
      next.style.zIndex = '2';
      if (last) last.style.zIndex = '1';
      next.hidden = false;
      cover.dataset.state = 'available';
      const moving = musicShown && !calm && typeof next.animate === 'function';
      const arriving = track !== coverTrack;
      coverTrack = track;
      if (musicShown)
        globalThis.lugnLyrics?.coverTook?.(performance.now() - asked);
      if (!moving) {
        drawBackdrop(next, false);
        if (last) last.hidden = true;
        return;
      }
      window.setTimeout(() => {
        if (request === coverRequest) drawBackdrop(next, true);
      }, BACKDROP_AFTER_MS);
      const fade = next.animate(
        [
          { opacity: 0, transform: arriving ? 'scale(1.05)' : 'none' },
          { opacity: 1, transform: 'none' },
        ],
        { duration: COVER_MS, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
      );
      fade.onfinish = () => {
        if (last && request === coverRequest) last.hidden = true;
      };
    };
    const failed = () => {
      if (request !== coverRequest) return;
      emptyCover();
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
  let backdropFront = null;
  function drawBackdrop(image, fadeIn = false) {
    // Drawn on the canvas out of sight, which then fades in over the other.
    const layers = [view('music', 'backdrop'), view('music', 'backdrop-next')];
    const last = backdropFront?.hidden === false ? backdropFront : null;
    const canvas = layers.find((layer) => layer && layer !== last) ?? layers[0];
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
        // The navbar tints its lit scene with the same colour.
        root.style.setProperty('--nb-rgb', `${ar}, ${ag}, ${ab}`);
      } else resetAccent();
      canvas.hidden = false;
      canvas.style.zIndex = '1';
      backdropFront = canvas;
      if (last) last.style.zIndex = '0';
      const done = () => {
        if (last && backdropFront === canvas) last.hidden = true;
      };
      if (fadeIn && typeof canvas.animate === 'function')
        canvas.animate([{ opacity: 0 }, { opacity: 0.85 }], {
          duration: last ? 480 : 600,
          easing: 'ease-out',
        }).onfinish = done;
      else done();
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
    // While it is held, the finger says where playback is.
    if (seekSlider?.held()) {
      setText(view('music', 'duration'), clockText(sample.duration));
      return;
    }
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

  // Föregående and Nästa låt: one-off requests the player either takes or
  // not; the new title arrives with the next state.
  for (const step of ['previous', 'next']) {
    view('music', step)?.addEventListener('click', () => {
      const target = currentTarget();
      const state = musicState();
      if (
        !target ||
        view('music', step).hidden ||
        !(step === 'next' ? state.canNext : state.canPrevious) ||
        typeof runCommand !== 'function'
      )
        return;
      // Their own command key: a pending play does not swallow them, nor do
      // they make the play button look busy.
      void runCommand(`music-track:${target}`, {
        target,
        request: { property: 'track', value: step },
      });
      globalThis.lugnLyrics?.hurry();
      window.setTimeout(drawMusic, 0);
    });
  }

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
      seekSlider?.cancel();
      volumeSlider?.cancel();
      barAnimation?.cancel();
      barAnimation = null;
      barKey = '';
      drawProgress(musicState().progress);
      drawLyrics(musicState());
    },
    sleep() {
      // Nothing runs while away: the bar stops with the page.
      barAnimation?.cancel();
      barAnimation = null;
      barKey = '';
      globalThis.lugnLyrics?.sleep();
    },
  });
  globalThis.lugnLyrics?.onToggle(drawMusic);
  window.addEventListener('lugn:payload', () => {
    if (musicShown) drawMusic();
  });
})();
