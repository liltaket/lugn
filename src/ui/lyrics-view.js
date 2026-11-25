// Musik's lyrics, in two layouts: beside a rail with the cover and the
// controls, or over the whole screen, where the rail comes in with the navbar.
// The navbar's buttons switch between them and set the timing; a Hub remembers
// both.
//
// Timing: while the lines are on screen the page asks Lugn where playback is
// about once a second, and counts on from there on its own clock. Each line
// change is handed to the compositor before it is due, so it happens on time
// even while the page is busy drawing.
(() => {
  'use strict';

  const pagesApi = globalThis.lugnPages;
  const find = (name) =>
    document.querySelector(
      `.hub-page[data-page='music'] [data-view='${name}']`,
    );
  const root = find('root');
  const pane = find('lyrics');
  const track = find('lyrics-track');
  if (!pagesApi || !root || !pane || !track) return;

  const VIEW_KEY = 'lugn.musicLyrics';
  const DELAY_KEY = 'lugn.lyricsDelay';
  // Where the current line's middle sits, and the band whole lines show in.
  // With the navbar open everything stays above its buttons.
  const CLOSED = { middle: 300, top: 14, bottom: 586 };
  const OPEN = { middle: 222, top: 10, bottom: 430 };
  // The padding above and below a line's text (lyrics-view.css).
  const LINE_PAD = 13;
  // How bright a line is by its distance from the current one.
  const OPACITY = new Map([
    [-2, 0.16],
    [-1, 0.32],
    [0, 1],
    [1, 0.5],
    [2, 0.32],
    [3, 0.2],
  ]);
  const SCROLL_MS = 220;
  const LIGHT_MS = 100;
  const EASING = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
  // A line starts to light this long before it is sung.
  const LEAD_SECONDS = 0.15;
  const DELAY_STEP_TENTHS = 1;
  const DELAY_LIMIT_TENTHS = 50;
  const POLL_MS = 1_000;
  // Answers slower than this say too little about when they were measured.
  const SLOW_MS = 700;
  const PLAYHEAD_TIMEOUT_MS = 4_000;
  const LYRICS_TIMEOUT_MS = 25_000;
  // A change larger than this is a seek, not noise.
  const JUMP_SECONDS = 0.35;
  const SAMPLES = 5;
  // After a seek here, answers that have not caught up are not believed.
  const SEEK_HOLD_MS = 2_500;
  // A planned change moves only if its time shifts more than this.
  const REPLAN_MS = 50;
  const REPORT_MS = 60_000;
  const RETRY_MS = 30_000;
  const STALE_MS = 1_500;
  const CACHED_TRACKS = 20;
  const GAP = '♪';

  const NOTES = {
    idle: ['Ingen musik spelar', ''],
    none: [
      'Ingen synkad text',
      'Det finns ingen text att följa till den här låten.',
    ],
    instrumental: ['Instrumental', 'Den här låten har ingen sångtext.'],
    unavailable: [
      'Låttexten kunde inte hämtas',
      'Lugn försöker igen om en stund.',
    ],
    unsynced: [
      'Texten kan inte följas',
      'Spelaren visar ingen position i låten.',
    ],
  };

  const tracks = new Map();
  const listeners = new Set();
  let view = stored(VIEW_KEY, '0');
  view = view === '1' ? 'rail' : view === 'full' ? 'full' : 'off';
  const clampDelay = (tenths) =>
    Math.max(-DELAY_LIMIT_TENTHS, Math.min(DELAY_LIMIT_TENTHS, tenths));
  let delayTenths = clampDelay(Math.round(Number(stored(DELAY_KEY, '0'))) || 0);
  let info = null;
  let entry = null;

  // Where playback is: `start` is the moment (page clock, s) position 0 would
  // have been, from the last few answers; paused, `still` is the position.
  const sync = {
    target: '',
    track: null,
    playing: false,
    start: null,
    still: null,
    duration: null,
    samples: [],
    holdUntil: 0,
    holdStart: null,
    // Set by the first answer, or the first failure to get one.
    answered: false,
  };
  let pollTimer = 0;
  let polling = false;
  let pollAgain = false;
  let shownPlaying = null;
  let shownTitle = null;

  // The lines on screen.
  let drawnLines = null;
  let elements = [];
  let metrics = null;
  let current = null;
  let drawn = { transform: '', opacity: [] };
  let planned = null;
  let animations = [];

  const stats = { rtt: [], jumps: 0, late: [], source: '', since: 0 };

  function stored(name, fallback) {
    try {
      return window.localStorage?.getItem(name) ?? fallback;
    } catch {
      return fallback;
    }
  }

  function keep(name, value) {
    try {
      window.localStorage?.setItem(name, value);
    } catch {
      // The choice then lasts until the page reloads.
    }
  }

  const seconds = () => performance.now() / 1000;
  const base = () =>
    typeof BASE_PATH === 'string' ? BASE_PATH : location.pathname;
  const isOpen = () => Boolean(root.classList?.contains('menu-open'));
  const visible = () => view !== 'off' && Boolean(info?.shown);

  // A question that hangs is given up, so the next one can be asked.
  async function ask(path, timeout) {
    const controller =
      typeof AbortController === 'function' ? new AbortController() : null;
    const giveUp = window.setTimeout(() => controller?.abort(), timeout);
    try {
      const response = await fetch(`${base()}display-api/${path}`, {
        cache: 'no-store',
        ...(controller ? { signal: controller.signal } : {}),
      });
      return response.ok ? await response.json() : null;
    } finally {
      window.clearTimeout(giveUp);
    }
  }

  // ── Where playback is ──

  function resetSync(target) {
    Object.assign(sync, {
      target,
      track: null,
      playing: false,
      start: null,
      still: null,
      duration: null,
      samples: [],
      holdUntil: 0,
      holdStart: null,
      answered: false,
    });
  }

  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[sorted.length >> 1];
  };

  // One answer: `at` is the page's clock halfway through the request, which
  // is when the position was true, give or take the network's asymmetry.
  function take(answer, at) {
    stats.source = answer.source;
    if (answer.source === 'none' || typeof answer.position !== 'number') {
      sync.start = null;
      sync.still = null;
      sync.samples = [];
      // A paused computer names nothing: keep the name while the page does.
      if (sync.track && !sameTrack(sync.track, info)) sync.track = null;
      return;
    }
    const name = answer.track?.title ? answer.track : null;
    if (name && sync.track && name.title !== sync.track.title) {
      sync.samples = [];
      sync.holdUntil = 0;
    }
    sync.track = name;
    sync.duration = answer.duration ?? null;
    sync.playing = answer.playing === true;
    if (!sync.playing) {
      sync.still = answer.position;
      sync.start = null;
      sync.samples = [];
      return;
    }
    sync.still = null;
    const start = at - answer.position;
    if (
      performance.now() < sync.holdUntil &&
      Math.abs(start - sync.holdStart) > 1.5
    )
      return;
    if (
      sync.samples.length &&
      Math.abs(start - median(sync.samples)) > JUMP_SECONDS
    ) {
      sync.samples = [];
      stats.jumps += 1;
    }
    sync.samples.push(start);
    if (sync.samples.length > SAMPLES) sync.samples.shift();
    sync.start = median(sync.samples);
  }

  function position() {
    if (sync.start !== null) return seconds() - sync.start;
    if (sync.still !== null) return sync.still;
    // Without an answer of its own, the page's progress.
    const sample = info?.progress;
    if (sample) {
      const elapsed = sample.playing
        ? Math.max(0, (info.serverNow() - sample.at) / 1000)
        : 0;
      sync.fallback = sample.position + elapsed;
      return sync.fallback;
    }
    // A paused computer reports no position: the lines stay where they were.
    return entry?.position ?? null;
  }

  const playing = () =>
    sync.start !== null
      ? true
      : sync.still !== null
        ? false
        : Boolean(info?.progress?.playing);

  function stopPolling() {
    window.clearTimeout(pollTimer);
    pollTimer = 0;
  }

  async function poll() {
    stopPolling();
    if (!visible() || !info.active || !info.target) return;
    if (polling) {
      pollAgain = true;
      return;
    }
    polling = true;
    const target = info.target;
    const sent = performance.now();
    try {
      const answer = await ask(
        `playhead/${encodeURIComponent(target)}`,
        PLAYHEAD_TIMEOUT_MS,
      );
      const received = performance.now();
      const rtt = received - sent;
      stats.rtt.push(rtt);
      if (answer && target === sync.target) {
        // The position is as of the answer leaving Lugn: the time held there
        // is no part of the way here, which is taken as half the rest.
        const held = Math.min(rtt, Math.max(0, Number(answer.held) || 0));
        if (rtt - held <= SLOW_MS || sync.start === null)
          take(answer, (received - (rtt - held) / 2) / 1000);
      }
    } catch {
      // The next one follows shortly.
    }
    polling = false;
    if (target === sync.target) sync.answered = true;
    report();
    render();
    if (!visible()) return;
    if (pollAgain) {
      pollAgain = false;
      void poll();
    } else if (!pollTimer) pollTimer = window.setTimeout(poll, POLL_MS);
  }

  // Once a minute the Hub says how well it keeps time (Lugn's journal).
  function report() {
    const now = performance.now();
    if (!stats.since) stats.since = now;
    if (now - stats.since < REPORT_MS) return;
    const sorted = (values) => [...values].sort((a, b) => a - b);
    const at = (values, share) =>
      values.length
        ? Math.round(sorted(values)[Math.floor((values.length - 1) * share)])
        : null;
    const data = {
      source: stats.source,
      view,
      requests: stats.rtt.length,
      rttP50: at(stats.rtt, 0.5),
      rttP95: at(stats.rtt, 0.95),
      jumps: stats.jumps,
      changes: stats.late.length,
      lateP50: at(stats.late, 0.5),
      lateP95: at(stats.late, 0.95),
      delayMs: delayTenths * 100,
    };
    Object.assign(stats, { rtt: [], jumps: 0, late: [], since: now });
    void fetch(`${base()}display-api/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ run: 'lyrics', phase: 'lyrics', data }),
    }).catch(() => undefined);
  }

  // ── The lines ──

  // The page shortens long titles, so the answer's name has to begin with it.
  const plain = (value) =>
    String(value ?? '')
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/…$/, '')
      .trimEnd();
  const sameTrack = (answer, asked) =>
    !answer ||
    (plain(answer.title).startsWith(plain(asked.title)) &&
      plain(answer.artist).startsWith(plain(asked.artist)));

  async function request(wanted, asked) {
    wanted.pending = true;
    wanted.duration = asked.duration;
    let answer;
    try {
      answer = await ask(
        `lyrics/${encodeURIComponent(asked.target)}`,
        LYRICS_TIMEOUT_MS,
      );
    } catch {
      answer = null;
    }
    wanted.pending = false;
    if (answer && !sameTrack(answer.track, asked)) {
      // The server is already on another track: ask again shortly.
      wanted.retryAt = performance.now() + STALE_MS;
    } else {
      const lines = Array.isArray(answer?.lines) ? answer.lines : [];
      wanted.status =
        answer?.status === 'synced' && lines.length
          ? 'synced'
          : ['instrumental', 'none'].includes(answer?.status)
            ? answer.status
            : 'unavailable';
      // A long wait before the first line is shown as a pause.
      wanted.lines =
        wanted.status === 'synced'
          ? lines[0].at > 4
            ? [{ at: 0, text: '' }, ...lines]
            : lines
          : null;
      wanted.retryAt =
        wanted.status === 'unavailable' ? performance.now() + RETRY_MS : 0;
    }
    render();
  }

  // The player's own track is known before the page's, when it differs.
  const shownTrack = () =>
    sync.track?.title && sync.track.artist
      ? sync.track
      : { title: info.title, artist: info.artist };

  // The entry for the track, asking for it when it is on screen and not yet
  // known, or known for a different length of recording.
  function lookUp(name) {
    const length = sync.duration ?? info.progress?.duration;
    const duration = length ? Math.round(length) : null;
    const key = JSON.stringify([info.target, name.title, name.artist]);
    let wanted = tracks.get(key);
    if (!wanted) {
      wanted = { status: 'loading', lines: null, duration: null, retryAt: 0 };
      tracks.set(key, wanted);
      while (tracks.size > CACHED_TRACKS)
        tracks.delete(tracks.keys().next().value);
    }
    // The first answer about the position comes with the recording's length.
    if (!info.shown || wanted.pending || !sync.answered) return wanted;
    const otherLength =
      duration !== null &&
      wanted.status !== 'loading' &&
      (wanted.status === 'synced'
        ? wanted.duration !== null && Math.abs(wanted.duration - duration) > 3
        : wanted.duration !== duration);
    const due = wanted.retryAt
      ? performance.now() >= wanted.retryAt
      : wanted.status === 'loading';
    if (due || otherLength)
      void request(wanted, {
        target: info.target,
        title: name.title,
        artist: name.artist,
        duration,
      });
    return wanted;
  }

  // The rail gives the screen away only while there are lines to take it.
  function layout(status) {
    const full =
      view === 'full' && (status === 'synced' || status === 'loading');
    const value = String(full);
    if (root.dataset.lyricsFull !== value) {
      root.dataset.lyricsFull = value;
      cancelPlan();
      metrics = null;
      current = null;
    }
  }

  function cancelPlan() {
    window.clearTimeout(planned?.timer);
    planned = null;
    for (const animation of animations) animation.cancel();
    animations = [];
  }

  function clearLines() {
    cancelPlan();
    drawnLines = null;
    elements = [];
    metrics = null;
    current = null;
  }

  function showNote(status) {
    pane.dataset.status = status;
    layout(status);
    const [heading, detail] = NOTES[status] ?? ['Hämtar låttext …', ''];
    const set = (element, text) => {
      if (element && element.textContent !== text) element.textContent = text;
    };
    set(find('lyrics-heading'), heading);
    set(find('lyrics-detail'), detail);
    if (drawnLines) {
      clearLines();
      track.replaceChildren();
    }
  }

  function build(lines) {
    clearLines();
    drawnLines = lines;
    elements = lines.map((line) => {
      const element = document.createElement('p');
      element.className = 'ly-line';
      element.textContent = line.text || GAP;
      return element;
    });
    drawn = { transform: '', opacity: elements.map(() => 0) };
    track.replaceChildren(...elements);
  }

  // Every line is measured at once, and only again when the layout changes.
  function measure() {
    if (metrics) return true;
    const next = elements.map((line) => [line.offsetTop, line.offsetHeight]);
    if (!next.length || !next.some(([, height]) => height > 0)) return false;
    metrics = next;
    return true;
  }

  function frame(index) {
    const band = isOpen() ? OPEN : CLOSED;
    // Before the first line, the first line waits in the middle, unlit.
    const [top, height] = metrics[Math.max(0, index)];
    const offset = Math.round(band.middle - top - height / 2);
    const opacity = metrics.map(([lineTop, lineHeight], at) => {
      const value = OPACITY.get(at - index);
      if (value === undefined) return 0;
      const first = lineTop + offset + LINE_PAD;
      const last = lineTop + offset + lineHeight - LINE_PAD;
      return at === index || (first >= band.top && last <= band.bottom)
        ? value
        : 0;
    });
    return { transform: `translateY(${offset}px)`, opacity };
  }

  function apply(next) {
    if (track.style.transform !== next.transform)
      track.style.transform = next.transform;
    next.opacity.forEach((value, at) => {
      const text = String(value);
      if (elements[at].style.opacity !== text)
        elements[at].style.opacity = text;
    });
    drawn = next;
  }

  // One compositor animation per thing that changes between two frames.
  function animate(from, to, delay, fill) {
    const run = (element, keyframes, duration) => {
      if (typeof element.animate !== 'function') return;
      animations.push(
        element.animate(keyframes, {
          duration,
          delay,
          easing: EASING,
          fill,
        }),
      );
    };
    if (from.transform !== to.transform)
      run(
        track,
        [{ transform: from.transform }, { transform: to.transform }],
        SCROLL_MS,
      );
    to.opacity.forEach((value, at) => {
      if (value !== from.opacity[at])
        run(
          elements[at],
          [{ opacity: from.opacity[at] }, { opacity: value }],
          LIGHT_MS,
        );
    });
  }

  // Shows a line now, moving there from what is on screen.
  function show(index, move) {
    cancelPlan();
    const from = drawn;
    current = index;
    const next = frame(index);
    apply(next);
    // The line is in place already: the movement only shows how it got there.
    if (move && from.transform) animate(from, next, 0, 'none');
  }

  // Hands the next line change to the compositor ahead of its time.
  function plan(at) {
    const index = current + 1;
    const wait = Math.max(0, (at - position()) * 1000);
    const due = performance.now() + wait;
    if (planned?.index === index && Math.abs(planned.due - due) < REPLAN_MS)
      return;
    cancelPlan();
    const next = frame(index);
    // Held at both ends until the timer has made it the page's own state.
    animate(drawn, next, wait, 'both');
    planned = {
      index,
      due,
      timer: window.setTimeout(() => {
        stats.late.push(Math.max(0, performance.now() - due - SCROLL_MS));
        planned = null;
        current = index;
        apply(next);
        for (const animation of animations) animation.cancel();
        animations = [];
        render();
      }, wait + SCROLL_MS),
    };
  }

  const indexAt = (lines, time) => {
    let low = 0;
    let high = lines.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (lines[middle].at <= time) low = middle + 1;
      else high = middle;
    }
    return low - 1;
  };

  function follow() {
    const now = position();
    if (now === null) {
      showNote('unsynced');
      return;
    }
    entry.position = now;
    pane.dataset.status = 'synced';
    layout('synced');
    if (drawnLines !== entry.lines) build(entry.lines);
    if (!measure()) return;
    const lead = LEAD_SECONDS - delayTenths / 10;
    const index = indexAt(entry.lines, now + lead);
    // A planned change that has started on screen is left to finish.
    const underway =
      planned && planned.index === index && performance.now() >= planned.due;
    if (underway) return;
    if (index !== current) show(index, current !== null);
    const next = entry.lines[current + 1];
    if (info.shown && playing() && next) plan(next.at - lead);
    else cancelPlan();
  }

  function render() {
    if (view === 'off' || !info) return;
    if (!info.ready) {
      showNote('loading');
      return;
    }
    if (!info.active || !info.target) {
      showNote('idle');
      return;
    }
    const name = shownTrack();
    if (!name.title || !name.artist) {
      showNote('none');
      return;
    }
    entry = lookUp(name);
    if (entry.status === 'synced') follow();
    else showNote(entry.status);
  }

  // The layout changed (navbar, view): measure again and move there.
  function relayout() {
    cancelPlan();
    metrics = null;
    const index = current;
    current = null;
    render();
    if (
      index !== null &&
      elements.length &&
      typeof track.animate === 'function'
    )
      track.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: 180 });
  }

  function applyView() {
    root.dataset.lyrics = String(view !== 'off');
    if (view === 'off') root.dataset.lyricsFull = 'false';
    pane.hidden = view === 'off';
  }

  function choose(next) {
    view = next;
    keep(VIEW_KEY, view === 'off' ? '0' : view === 'full' ? 'full' : '1');
    applyView();
    cancelPlan();
    metrics = null;
    current = null;
    if (view === 'off') stopPolling();
    for (const listener of listeners) listener();
    render();
    void poll();
  }

  if (typeof MutationObserver === 'function') {
    let wasOpen = false;
    new MutationObserver(() => {
      const open = isOpen();
      if (open === wasOpen) return;
      wasOpen = open;
      if (view !== 'off') relayout();
    }).observe(root, { attributes: true, attributeFilter: ['class'] });
  }

  applyView();

  globalThis.lugnLyrics = {
    shown: () => view !== 'off',
    full: () => view === 'full',
    toggle: () => choose(view === 'off' ? 'rail' : 'off'),
    toggleFull: () => choose(view === 'full' ? 'rail' : 'full'),
    delayText: () =>
      `${delayTenths > 0 ? '+' : delayTenths < 0 ? '−' : ''}${(
        Math.abs(delayTenths) / 10
      )
        .toFixed(1)
        .replace('.', ',')} s`,
    // +1 shows the lines a tenth of a second later, −1 earlier.
    nudge(direction) {
      delayTenths = clampDelay(delayTenths + direction * DELAY_STEP_TENTHS);
      keep(DELAY_KEY, String(delayTenths));
      cancelPlan();
      render();
    },
    // A seek made here is shown at once, before the player says so.
    seek(to) {
      const start = seconds() - to;
      sync.holdStart = start;
      sync.holdUntil = performance.now() + SEEK_HOLD_MS;
      if (sync.start !== null) {
        sync.samples = [start];
        sync.start = start;
      } else if (sync.still !== null) sync.still = to;
      render();
    },
    onToggle: (listener) => listeners.add(listener),
    draw(next) {
      const wasVisible = visible();
      const changed =
        next.playing !== shownPlaying || next.title !== shownTitle;
      shownPlaying = next.playing;
      shownTitle = next.title;
      info = next;
      if (next.target !== sync.target) resetSync(next.target);
      render();
      // Ask at once when the page appears, and after a pause or a new title.
      if (!visible()) stopPolling();
      else if (!wasVisible || changed) void poll();
      else if (!pollTimer && !polling) void poll();
    },
    sleep() {
      if (info) info = { ...info, shown: false };
      stopPolling();
      cancelPlan();
    },
  };
})();
