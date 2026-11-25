// Musik's lyrics: the cover and the controls move into a rail on the left and
// the song's lines follow playback on the right. The navbar's button turns it
// on and off, and a Hub remembers the choice.
//
// page-views.js hands in what the page shows (the same title and position as
// the controls); lines are fetched only while they are on screen.
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

  const STORAGE_KEY = 'lugn.musicLyrics';
  // The current line's top, and the band whole lines are shown in. With the
  // navbar open everything lifts, and the lines stay above its buttons.
  const CLOSED = { anchor: 152, top: 36, bottom: 552 };
  const OPEN = { anchor: 130, top: 10, bottom: 428 };
  // The padding above and below a line's text (lyrics-view.css).
  const LINE_PAD = 13;
  // A line lights up slightly before it is sung, which reads as on time.
  const LEAD_SECONDS = 0.25;
  const NEIGHBOURS = 3;
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
  let on = readChoice();
  let info = null;
  let key = '';
  let drawnLines = null;
  let elements = [];
  let current = -1;
  let timer = 0;

  function readChoice() {
    try {
      return window.localStorage?.getItem(STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  }

  function keepChoice() {
    try {
      window.localStorage?.setItem(STORAGE_KEY, on ? '1' : '0');
    } catch {
      // The choice then lasts until the page reloads.
    }
  }

  function applyMode() {
    root.dataset.lyrics = String(on);
    pane.hidden = !on;
  }

  function stopTimer() {
    window.clearTimeout(timer);
    timer = 0;
  }

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

  async function request(entry, asked) {
    entry.pending = true;
    entry.duration = asked.duration;
    let answer;
    try {
      const base =
        typeof BASE_PATH === 'string' ? BASE_PATH : location.pathname;
      const response = await fetch(
        `${base}display-api/lyrics/${encodeURIComponent(asked.target)}`,
        { cache: 'no-store' },
      );
      answer = response.ok ? await response.json() : null;
    } catch {
      answer = null;
    }
    entry.pending = false;
    if (answer && !sameTrack(answer.track, asked)) {
      // The server is already on another track: ask again shortly.
      entry.retryAt = performance.now() + STALE_MS;
    } else {
      const lines = Array.isArray(answer?.lines) ? answer.lines : [];
      entry.status =
        answer?.status === 'synced' && lines.length
          ? 'synced'
          : ['instrumental', 'none'].includes(answer?.status)
            ? answer.status
            : 'unavailable';
      // A long wait before the first line is shown as a pause.
      entry.lines =
        entry.status === 'synced'
          ? lines[0].at > 4
            ? [{ at: 0, text: '' }, ...lines]
            : lines
          : null;
      entry.retryAt =
        entry.status === 'unavailable' ? performance.now() + RETRY_MS : 0;
    }
    render();
  }

  // The entry for what the page shows, asking for it when it is on screen and
  // not yet known, or known for a different length of recording.
  function lookUp() {
    const duration = info.progress?.duration
      ? Math.round(info.progress.duration)
      : null;
    let entry = tracks.get(key);
    if (!entry) {
      entry = { status: 'loading', lines: null, duration: null, retryAt: 0 };
      tracks.set(key, entry);
      while (tracks.size > CACHED_TRACKS)
        tracks.delete(tracks.keys().next().value);
    }
    if (!info.shown || entry.pending) return entry;
    const otherLength =
      duration !== null &&
      entry.status !== 'loading' &&
      (entry.status === 'synced'
        ? entry.duration !== null && Math.abs(entry.duration - duration) > 3
        : entry.duration !== duration);
    const due = entry.retryAt
      ? performance.now() >= entry.retryAt
      : entry.status === 'loading';
    if (due || otherLength)
      void request(entry, {
        target: info.target,
        title: info.title,
        artist: info.artist,
        duration,
      });
    return entry;
  }

  function showNote(status) {
    pane.dataset.status = status;
    const [heading, detail] = NOTES[status] ?? ['Hämtar låttext …', ''];
    const set = (element, text) => {
      if (element && element.textContent !== text) element.textContent = text;
    };
    set(find('lyrics-heading'), heading);
    set(find('lyrics-detail'), detail);
    if (drawnLines) {
      drawnLines = null;
      elements = [];
      current = -1;
      track.replaceChildren();
    }
  }

  function build(lines) {
    drawnLines = lines;
    current = -1;
    elements = lines.map((line) => {
      const element = document.createElement('p');
      element.className = 'ly-line';
      element.textContent = line.text || GAP;
      return element;
    });
    // A new song starts in place rather than scrolling there.
    track.dataset.settled = 'false';
    track.replaceChildren(...elements);
  }

  const indexAt = (lines, seconds) => {
    let low = 0;
    let high = lines.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (lines[middle].at <= seconds) low = middle + 1;
      else high = middle;
    }
    return low - 1;
  };

  // Moves the track so the current line sits at the anchor, and shows only
  // whole lines inside the band.
  function place(index) {
    const open = Boolean(root.classList?.contains('menu-open'));
    const band = open ? OPEN : CLOSED;
    // Before the first line, the first line waits at the anchor, unlit.
    const at = Math.max(0, index);
    const element = elements[at];
    if (!element) return;
    const offset = Math.round(band.anchor - LINE_PAD - element.offsetTop);
    const transform = `translateY(${offset}px)`;
    if (track.style.transform !== transform) track.style.transform = transform;
    // Every line is measured before any is changed, so a Hub lays out once.
    const values = elements.map((line, position) => {
      const distance = position - index;
      if (distance < -1 || distance > NEIGHBOURS) return '';
      const top = line.offsetTop + offset + LINE_PAD;
      const bottom = line.offsetTop + offset + line.offsetHeight - LINE_PAD;
      return distance === 0 || (top >= band.top && bottom <= band.bottom)
        ? String(distance)
        : '';
    });
    elements.forEach((line, position) => {
      const value = values[position];
      if ((line.dataset.at ?? '') !== value) line.dataset.at = value;
    });
  }

  const positionNow = (sample) =>
    sample.position +
    (sample.playing ? Math.max(0, (info.serverNow() - sample.at) / 1000) : 0);

  function follow(entry) {
    // A paused computer reports no position: the lines stay where they were.
    const sample = info.progress;
    if (sample) entry.position = positionNow(sample);
    if (entry.position === undefined) {
      showNote('unsynced');
      return;
    }
    pane.dataset.status = 'synced';
    if (drawnLines !== entry.lines) build(entry.lines);
    const seconds = entry.position + LEAD_SECONDS;
    current = indexAt(entry.lines, seconds);
    place(current);
    if (track.dataset.settled !== 'true')
      window.setTimeout(() => {
        track.dataset.settled = 'true';
      }, 60);
    const next = entry.lines[current + 1];
    if (info.shown && sample?.playing && next)
      timer = window.setTimeout(
        render,
        Math.max(60, (next.at - seconds) * 1000),
      );
  }

  function render() {
    stopTimer();
    if (!on || !info) return;
    if (!info.ready) {
      showNote('loading');
      return;
    }
    if (!info.active || !info.target) {
      showNote('idle');
      return;
    }
    if (!info.title || !info.artist) {
      showNote('none');
      return;
    }
    key = JSON.stringify([info.target, info.title, info.artist]);
    const entry = lookUp();
    if (entry.status === 'synced') follow(entry);
    else showNote(entry.status);
  }

  // The navbar opening or closing moves the lines with the rail.
  if (typeof MutationObserver === 'function') {
    let wasOpen = false;
    new MutationObserver(() => {
      const open = root.classList.contains('menu-open');
      if (open === wasOpen) return;
      wasOpen = open;
      render();
    }).observe(root, { attributes: true, attributeFilter: ['class'] });
  }

  applyMode();

  globalThis.lugnLyrics = {
    shown: () => on,
    toggle() {
      on = !on;
      keepChoice();
      applyMode();
      stopTimer();
      for (const listener of listeners) listener();
    },
    onToggle: (listener) => listeners.add(listener),
    draw(next) {
      info = next;
      render();
    },
    sleep: stopTimer,
  };
})();
