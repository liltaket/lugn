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
  const BAND = { middle: 300, top: 14, bottom: 586 };
  // How bright a line is by its distance from the current one.
  const OPACITY = new Map([
    [-2, 0.16],
    [-1, 0.32],
    [0, 1],
    [1, 0.5],
    [2, 0.32],
    [3, 0.2],
  ]);
  const RAIL_OPACITY = new Map([
    [-1, 0.24],
    [0, 1],
    [1, 0.38],
  ]);
  const SCROLL_MS = 220;
  const LIGHT_MS = 100;
  const EASING = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
  // A line starts to light this long before it is sung.
  const LEAD_SECONDS = 0.15;
  const DELAY_STEP_TENTHS = 1;
  const DELAY_LIMIT_TENTHS = 50;
  const POLL_MS = 1_000;
  // Around a track change the player is asked more often.
  const HURRY_MS = 250;
  const HURRY_FOR_MS = 3_000;
  // The player's own track counts for this long after it was last heard.
  const FRESH_MS = 4_000;
  // Lines of a new track not here by now are said to be on their way.
  const PATIENCE_MS = 600;
  // A change of layout: what leaves fades first, then what arrives, while the
  // cover travels between its places.
  const MODE_MS = 400;
  const LEAVE_MS = 150;
  const ENTER_AFTER_MS = 130;
  // The lines' column per layout (lyrics-view.css): its left edge, the text
  // size and the padding above and below a line's text.
  const RAIL_COLUMN = { left: 408, size: 34, pad: 16 };
  const FULL_COLUMN = { left: 72, size: 52, pad: 13 };
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
    art: null,
    // When the player itself was last heard, and its position then.
    heard: 0,
    sample: null,
  };
  // Whether the lyrics layout is on screen: chosen, and with lines to show.
  let showing = false;
  // The track on screen has nothing to follow.
  let missing = false;
  let gone = null;
  let drawnOpen = false;
  let hurryUntil = 0;
  let leaving = null;
  let drawnGeometry = null;
  let pollTimer = 0;
  let polling = false;
  let pollAgain = false;
  let shownPlaying = null;
  let shownTitle = null;
  let shownAnnounced = '';

  // The lines on screen.
  let drawnLines = null;
  let elements = [];
  let metrics = null;
  let current = null;
  let drawn = { transform: '', opacity: [] };
  let planned = null;
  let animations = [];

  const stats = {
    rtt: [],
    jumps: 0,
    late: [],
    cover: [],
    source: '',
    since: 0,
  };

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
      art: null,
      heard: 0,
      sample: null,
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
    // The player's own word, or the computer's behind its input.
    const direct = ['player', 'computer'].includes(answer.source);
    sync.heard = direct ? performance.now() : 0;
    if (direct) sync.art = answer.art ?? null;
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
      sync.sample = null;
      sync.still = answer.position;
      sync.start = null;
      sync.samples = [];
      hurryUntil = 0;
      return;
    }
    sync.still = null;
    const start = at - answer.position;
    if (info?.serverNow)
      sync.sample = {
        position: answer.position,
        duration: sync.duration,
        at: info.serverNow() - Math.max(0, (seconds() - at) * 1000),
        playing: true,
      };
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

  // The player's track, for the page to show ahead of the dashboard's.
  function player(target) {
    if (
      target !== sync.target ||
      !sync.track?.title ||
      !sync.heard ||
      performance.now() - sync.heard > FRESH_MS
    )
      return null;
    return {
      title: sync.track.title,
      artist: sync.track.artist,
      art: sync.art,
      progress: sync.sample,
    };
  }

  const identity = () => JSON.stringify([sync.track?.title, sync.art]);

  // Soon after a step, at a track's end, and while a new cover is on its way.
  function nextPoll() {
    if (performance.now() < hurryUntil) return HURRY_MS;
    if (sync.playing && sync.start !== null && sync.duration) {
      const left = (sync.duration - (seconds() - sync.start)) * 1000;
      if (left < POLL_MS && left > -HURRY_FOR_MS)
        return Math.max(HURRY_MS, left + 150);
    }
    return POLL_MS;
  }

  const wanted = () => Boolean(info?.shown && info.active && info.target);
  // Keep polling once a second only while playback is running (or briefly
  // after a seek/track step, or until the first answer arrives). When paused,
  // SSE notifies draw() as soon as playback resumes or the track changes.
  const shouldKeepPolling = () =>
    wanted() &&
    (!sync.answered ||
      playing() ||
      Boolean(info?.playing) ||
      performance.now() < hurryUntil);

  async function poll() {
    stopPolling();
    if (!wanted()) return;
    if (polling) {
      pollAgain = true;
      return;
    }
    polling = true;
    const target = info.target;
    const sent = performance.now();
    const before = identity();
    try {
      const answer = await ask(
        `playhead/${encodeURIComponent(target)}${
          view === 'off' ? '' : '/lyrics'
        }`,
        PLAYHEAD_TIMEOUT_MS,
      );
      const received = performance.now();
      const rtt = received - sent;
      if (view !== 'off') stats.rtt.push(rtt);
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
    if (view !== 'off') report();
    if (identity() !== before) {
      // A new track without its cover yet: it follows shortly while playing.
      if (sync.heard && sync.playing && !sync.art)
        hurryUntil = performance.now() + HURRY_FOR_MS;
      else if (sync.art || !sync.playing) hurryUntil = 0;
      for (const listener of listeners) listener();
    }
    render();
    if (!wanted()) return;
    if (pollAgain) {
      pollAgain = false;
      void poll();
    } else if (!pollTimer && shouldKeepPolling())
      pollTimer = window.setTimeout(poll, nextPoll());
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
      // From a new cover's address to its picture being decoded.
      covers: stats.cover.length,
      coverP50: at(stats.cover, 0.5),
      coverMax: at(stats.cover, 1),
    };
    Object.assign(stats, {
      rtt: [],
      jumps: 0,
      late: [],
      cover: [],
      since: now,
    });
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

  const reduced = () =>
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches;
  const canMove = (element) =>
    Boolean(info?.shown) &&
    !reduced() &&
    typeof element?.animate === 'function';

  // Where the current line sits in the layout on screen.
  function geometry() {
    const full = root.dataset.lyricsFull === 'true';
    return {
      ...(full ? FULL_COLUMN : RAIL_COLUMN),
      middle: BAND.middle,
    };
  }

  // The current line travels from where it was to where it is now: the new
  // layout is in place at once, and this only moves the eye there.
  function glide(from, to) {
    if (!from || !canMove(pane)) return;
    const scale = from.size / to.size;
    const x = from.left - to.left;
    const y = from.middle - to.middle;
    if (!x && !y && scale === 1) return;
    // The origin is set on the element, not in the keyframes: a
    // transform-origin there would keep the animation off the compositor.
    pane.style.transformOrigin = `0 ${to.middle}px`;
    pane.animate(
      [
        {
          transform: `translate(${x}px, ${y}px) scale(${scale})`,
          // The lines break differently at another size.
          opacity: scale === 1 ? 1 : 0.1,
        },
        { transform: 'none', opacity: 1 },
      ],
      { duration: MODE_MS, easing: EASING },
    );
  }

  // New lines rise into place.
  function arrive(delay = 0) {
    if (!canMove(pane)) return;
    pane.animate(
      [
        { opacity: 0, transform: 'translateY(28px)' },
        { opacity: 1, transform: 'none' },
      ],
      { duration: MODE_MS, delay, easing: EASING, fill: 'backwards' },
    );
  }

  // The last track's lines fade while the next one's are fetched.
  function leave() {
    if (leaving) return;
    cancelPlan();
    const fade = canMove(track)
      ? track.animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: 160,
          easing: 'ease-out',
          fill: 'forwards',
        })
      : null;
    leaving = {
      fade,
      since: performance.now(),
      timer: window.setTimeout(render, PATIENCE_MS),
    };
  }

  function stay() {
    window.clearTimeout(leaving?.timer);
    leaving?.fade?.cancel();
    leaving = null;
  }

  // The full layout, where it is chosen and the lyrics are on screen.
  function layout() {
    const value = String(showing && view === 'full');
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

  // New lines are on their way: bars where they will be.
  function showLoading() {
    stay();
    pane.dataset.status = 'loading';
    if (drawnLines) {
      clearLines();
      track.replaceChildren();
    }
  }

  function build(lines) {
    stay();
    clearLines();
    arrive();
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
    // Before the first line, the first line waits in the middle, unlit.
    const [top, height] = metrics[Math.max(0, index)];
    // Beside the rail fewer lines show, which leaves the page air.
    const { size, pad } = geometry();
    const full = size === FULL_COLUMN.size;
    const offset = Math.round(BAND.middle - top - height / 2);
    const opacity = metrics.map(([lineTop, lineHeight], at) => {
      const value = (full ? OPACITY : RAIL_OPACITY).get(at - index);
      if (value === undefined) return 0;
      const first = lineTop + offset + pad;
      const last = lineTop + offset + lineHeight - pad;
      return at === index || (first >= BAND.top && last <= BAND.bottom)
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
    drawnGeometry = geometry();
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

  // No lines to follow for what plays: the cover view.
  function nothing() {
    missing = true;
    present(false);
  }

  function follow() {
    const now = position();
    if (now === null) {
      nothing();
      return;
    }
    missing = false;
    // The navbar's own view: the cover and the controls.
    if (isOpen()) {
      entry.position = now;
      present(false);
      return;
    }
    present(true);
    entry.position = now;
    pane.dataset.status = 'synced';
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

  // A track without lines to follow takes the cover view, until one has.
  function render() {
    if (view === 'off' || !info) return;
    if (!info.ready) {
      showLoading();
      return;
    }
    const name = info.active && info.target ? shownTrack() : null;
    if (!name?.title || !name.artist) {
      nothing();
      return;
    }
    entry = lookUp(name);
    if (entry.status === 'synced') follow();
    else if (entry.status !== 'loading') nothing();
    // Still being fetched: the layout stays as it is meanwhile, apart from
    // making way for the navbar and coming back after it.
    else if (isOpen()) present(false);
    else if (!showing && !missing) present(true);
    else if (!showing) return;
    else if (
      drawnLines &&
      // Still the last track's: kept, fading, for a short while.
      (!leaving || performance.now() - leaving.since < PATIENCE_MS)
    )
      leave();
    else showLoading();
  }

  function applyLayout() {
    root.dataset.lyrics = String(showing);
    layout();
    pane.hidden = !showing;
  }

  const boxOf = (element) => element?.getBoundingClientRect?.();

  // The cover is the same picture in every layout: it travels between its
  // places, by the `translate` and `scale` properties so that the layout's own
  // transform is left alone.
  function moveCover(cover, before) {
    const after = boxOf(cover);
    if (!before?.width || !after?.width || !canMove(cover)) return;
    const page = boxOf(root);
    const zoom = page.width / root.offsetWidth || 1;
    const scale = before.width / after.width;
    const [originX, originY] = window
      .getComputedStyle(cover)
      .transformOrigin.split(' ')
      .map(parseFloat);
    const shift = (from, to, edge, offset, origin) => {
      const was = (from - edge) / zoom - offset;
      const is = (to - edge) / zoom - offset;
      return was - origin - scale * (is - origin);
    };
    const x = shift(
      before.left,
      after.left,
      page.left,
      cover.offsetLeft,
      originX,
    );
    const y = shift(before.top, after.top, page.top, cover.offsetTop, originY);
    cover.animate(
      [
        { translate: `${x}px ${y}px`, scale: String(scale) },
        { translate: '0px 0px', scale: '1' },
      ],
      { duration: MODE_MS + 60, easing: EASING },
    );
  }

  // What is leaving the page: a copy of it as it looked, fading out over the
  // new layout. The cover is not in it when the same cover travels on.
  function leaveBehind(withCover) {
    gone?.();
    if (!canMove(root) || typeof root.cloneNode !== 'function') return;
    const copy = root.cloneNode(true);
    copy.classList.toggle('menu-open', drawnOpen);
    // Nothing that finds the page's parts may find the copy's.
    for (const element of [
      copy,
      ...copy.querySelectorAll('[data-view], [id]'),
    ]) {
      element.removeAttribute('data-view');
      element.removeAttribute('id');
    }
    copy.setAttribute('aria-hidden', 'true');
    Object.assign(copy.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      pointerEvents: 'none',
    });
    const hide = (selector) => {
      const element = copy.querySelector(selector);
      if (element) element.style.visibility = 'hidden';
    };
    hide('.music-page-backdrop');
    if (!withCover) hide('.music-page-cover');
    root.parentNode.appendChild(copy);
    copy.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: LEAVE_MS,
      easing: 'ease-out',
      fill: 'forwards',
    });
    // By the clock, so a copy never stays over the controls.
    const timer = window.setTimeout(() => gone?.(), LEAVE_MS);
    gone = () => {
      window.clearTimeout(timer);
      copy.remove();
      gone = null;
    };
  }

  // Moves the page to a layout: the cover travels, the rest crosses over.
  function change(shows, mutate) {
    const cover = find('cover');
    const before = boxOf(cover);
    const hidden =
      canMove(cover) &&
      window.getComputedStyle?.(cover).visibility === 'hidden';
    const from = drawnGeometry;
    const showed = showing;
    mutate?.();
    const covered = shows && view === 'full';
    if (showed !== shows) leaveBehind(covered);
    // The new layout takes its place at once, to be measured and then moved.
    root.dataset.switching = 'true';
    showing = shows;
    applyLayout();
    drawnOpen = isOpen();
    cancelPlan();
    stay();
    metrics = null;
    current = null;
    // The page redraws what depends on the layout, once this change is done.
    window.setTimeout(() => {
      for (const listener of listeners) listener();
    }, 0);
    if (showed !== showing) {
      if (hidden) appear(cover, ENTER_AFTER_MS);
      else if (!covered) moveCover(cover, before);
      appear(find('text')?.parentElement, ENTER_AFTER_MS);
      if (showing) arrive(ENTER_AFTER_MS);
    }
    window.setTimeout(() => {
      root.dataset.switching = 'false';
    }, 40);
    return from;
  }

  function appear(element, delay) {
    if (!canMove(element)) return;
    element.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: MODE_MS - delay,
      delay,
      easing: 'ease-out',
      fill: 'backwards',
    });
  }

  function present(shows) {
    if (shows === showing) {
      layout();
      return;
    }
    // Lines on their way out stay drawn while the pane fades.
    change(shows);
  }

  function choose(next) {
    // Turned on, the lyrics layout shows while the track is looked up, unless
    // it is already known to have nothing to follow.
    const known = entry && !['synced', 'loading'].includes(entry.status);
    missing = Boolean(known);
    const hidden = known || (isOpen() && next !== 'off');
    const from = change(next !== 'off' && !hidden, () => {
      view = next;
      keep(VIEW_KEY, view === 'off' ? '0' : view === 'full' ? 'full' : '1');
    });
    render();
    if (showing && elements.length) glide(from, geometry());
    void poll();
  }

  if (typeof MutationObserver === 'function') {
    let wasOpen = false;
    new MutationObserver(() => {
      const open = isOpen();
      if (open === wasOpen) return;
      wasOpen = open;
      if (view !== 'off') render();
    }).observe(root, { attributes: true, attributeFilter: ['class'] });
  }

  showing = view !== 'off';
  applyLayout();

  globalThis.lugnLyrics = {
    shown: () => view !== 'off',
    // Chosen and on screen: not while a track has nothing to follow.
    showing: () => showing,
    // Chosen, but this track has nothing to follow.
    missing: () => view !== 'off' && missing,
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
    player,
    coverTook: (ms) => stats.cover.push(ms),
    // A step was asked for: the player is asked often until it shows.
    hurry() {
      hurryUntil = performance.now() + HURRY_FOR_MS;
      void poll();
    },
    draw(next) {
      const wasWanted = wanted();
      const announced = JSON.stringify(next.announced ?? null);
      const changed =
        next.playing !== shownPlaying ||
        next.title !== shownTitle ||
        announced !== shownAnnounced;
      shownPlaying = next.playing;
      shownTitle = next.title;
      shownAnnounced = announced;
      info = next;
      if (next.target !== sync.target) resetSync(next.target);
      render();
      // Ask at once when the page appears, and after a pause or a new title.
      if (!wanted()) stopPolling();
      else if (!wasWanted || changed) void poll();
      else if (!pollTimer && !polling && shouldKeepPolling()) void poll();
    },
    sleep() {
      if (info) info = { ...info, shown: false };
      stopPolling();
      cancelPlan();
      stay();
    },
  };
})();
