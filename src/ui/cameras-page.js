// Kameror: every allowed camera at once, in a grid (pages.js runs the pager).
//
// The page opens a lease on the server (display-api/camera {action:'grid'})
// while it is shown, renews it, and asks for one picture per camera, round
// and round, a few at a time. A tap on a camera shows it large and refreshed
// faster (the others rest); a tap again returns to the grid. Tapping the
// small camera view on Hem opens this page on that camera.
//
// Rules from the Hub's responsiveness notes: nothing runs while the page is
// not the shown one (no lease, no fetches, no timers), at most a few pictures
// are in flight, a picture is decoded off screen before it replaces the last
// one, nothing is swapped while the pager moves, and the only thing that
// animates is a picture's opacity when it first appears.
(() => {
  'use strict';

  const pagesApi = globalThis.lugnPages;

  // Pace. A picture is ~25 KB and takes the server about half a second; the
  // Hub decodes and paints each one, so the grid is kept to a calm rate.
  const GRID_INTERVAL_MS = 1000; // per camera, grid (about 1 Hz)
  // One camera large: back to back, as fast as the camera answers (about a
  // third of a second per picture, so 2–3 Hz). The server shares one fetch
  // per camera, so a second request for it would only get the same picture.
  const FOCUS_INTERVAL_MS = 150;
  const GRID_WORKERS = 3; // pictures in flight at once
  const FETCH_TIMEOUT_MS = 8000;
  const STALE_MS = 8000; // no new picture for this long: shown as stale
  const LEASE_RENEW_MS = 20_000; // the server's lease lasts 45 s
  const FOCUS_REQUEST_MS = 4000; // a tap on Hem's view stays valid this long
  const RATIO = 16 / 9;
  const GAP = 8;

  // ── Layout (pure) ──

  // A tile may be a little taller than 16:9: its picture then fills it and is
  // cropped at the sides (object-fit: cover), by at most 1 - 1 / STRETCH
  // (15 %). That is what lets a grid use the whole screen.
  const STRETCH = 1.18;

  /** Row sizes for `count` tiles in `rows` rows, nearly equal. With tiles all
   * alike the short row comes last (as in any grid); when rows share the
   * width, the row with the fewest (and so the biggest) tiles comes first, so
   * the first cameras (the ones that matter most) get the biggest tiles. */
  function rowCounts(count, rows, alike) {
    const base = Math.floor(count / rows);
    const extra = count % rows;
    return Array.from({ length: rows }, (_, i) =>
      (alike ? i < extra : i >= rows - extra) ? base + 1 : base,
    );
  }

  /**
   * Places `count` 16:9-ish tiles in a `width` × `height` area, using as much
   * of it as it can. Candidates: every number of rows (up to four), tiles all
   * alike or rows sharing the width evenly (rows with fewer tiles get bigger
   * ones). Each is scaled to fit the height, stretched up to STRETCH to fill
   * it; the candidate whose smallest tile is biggest wins (ties: the one
   * covering more). Rows and the whole grid are centred.
   */
  function layout(count, width, height, gap = GAP, ratio = RATIO) {
    if (!(count > 0) || !(width > 0) || !(height > 0)) return [];
    let best = null;
    for (let rows = 1; rows <= Math.min(count, 4); rows += 1) {
      const avail = height - (rows - 1) * gap;
      for (const alike of [true, false]) {
        const counts = rowCounts(count, rows, alike);
        const cols = Math.max(...counts);
        const colWidth = (width - (cols - 1) * gap) / cols;
        // Tile widths per row: all alike, or each row filling the width.
        const widths = counts.map((k) =>
          alike ? colWidth : (width - (k - 1) * gap) / k,
        );
        const ideal = widths.map((w) => w / ratio);
        const sum = ideal.reduce((a, b) => a + b, 0);
        const fit = avail / sum;
        // Too tall: every tile shrinks (staying 16:9). Room to spare: taller
        // tiles, up to STRETCH.
        const scale = Math.min(fit, STRETCH);
        const tiles = counts.map((k, i) => {
          const w = fit < 1 ? widths[i] * fit : widths[i];
          const h = fit < 1 ? ideal[i] * fit : ideal[i] * scale;
          return { k, w: Math.floor(w), h: Math.floor(h) };
        });
        const smallest = Math.min(...tiles.map((t) => t.w * t.h));
        const covered = tiles.reduce((a, t) => a + t.k * t.w * t.h, 0);
        const better =
          !best ||
          smallest > best.smallest * 1.03 ||
          (smallest > best.smallest * 0.97 && covered > best.covered);
        if (better) best = { tiles, smallest, covered };
      }
    }
    const used = best.tiles.reduce((a, t) => a + t.h, 0);
    const top = (height - (used + (best.tiles.length - 1) * gap)) / 2;
    const rects = [];
    let y = top;
    for (const row of best.tiles) {
      const left = (width - (row.k * row.w + (row.k - 1) * gap)) / 2;
      for (let col = 0; col < row.k; col += 1)
        rects.push({
          x: Math.round(left + col * (row.w + gap)),
          y: Math.round(y),
          w: row.w,
          h: row.h,
        });
      y += row.h + gap;
    }
    return rects;
  }

  /** One tile as large as the area allows (stretched like the others), centred. */
  function single(width, height, ratio = RATIO) {
    const h = Math.floor(Math.min(height, (width / ratio) * STRETCH));
    const w = Math.floor(Math.min(width, h * ratio * STRETCH));
    return {
      x: Math.round((width - w) / 2),
      y: Math.round((height - h) / 2),
      w,
      h,
    };
  }

  globalThis.lugnCameras = { layout, single };

  if (!pagesApi) return;
  const root = document.querySelector(
    ".hub-page[data-page='kameror'] [data-view='root']",
  );
  if (!root) return;
  const stage = root.querySelector("[data-view='stage']");
  const notice = root.querySelector("[data-view='notice']");
  const pager = document.getElementById('hub-pager');
  const calm =
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches;

  const base = () =>
    typeof BASE_PATH === 'string' ? BASE_PATH : location.pathname;
  const paging = () => Boolean(pager && pager.classList.contains('paging'));
  const payload = () =>
    typeof latestPayload === 'undefined' ? undefined : latestPayload;

  // ── State ──

  let cams = []; // [{ id, name, imageUrl, tile, img, ... }]
  let mode = 'grid';
  let focusId = '';
  let active = false;
  let leaseTimer = 0;
  let wakeTimer = 0;
  let generation = 0; // bumped when the page stops, so old fetches are dropped
  let layoutKey = '';
  const held = []; // decoded pictures waiting for the pager to stop
  let focusRequest = null; // { id, at } from a tap on Hem's small view

  // ── Notices ──

  function setNotice(text) {
    if (!notice) return;
    if (notice.hidden !== !text) notice.hidden = !text;
    if (text && notice.textContent !== text) notice.textContent = text;
  }

  // The way from one large camera back to all of them is the navbar's back
  // button (quick-menu.js), given only while one camera is large.
  let navbar = null;
  function setBack() {
    navbar?.setBack(mode === 'focus' ? () => setMode('grid') : null);
  }

  // ── Server lease ──

  let leasing = null; // { token, promise }
  function openLease() {
    // One request at a time per visit: a camera whose picture says "gone"
    // must not start one each. A request from an earlier visit is not shared
    // (it answers for a page that has stopped).
    if (leasing?.token !== generation) {
      const entry = { token: generation, promise: null };
      entry.promise = requestLease().finally(() => {
        if (leasing === entry) leasing = null;
      });
      leasing = entry;
    }
    return leasing.promise;
  }

  async function requestLease() {
    const token = generation;
    try {
      const result = await postJson(`${base()}display-api/camera`, {
        action: 'grid',
      });
      if (token !== generation) return false;
      const list = Array.isArray(result?.cameraGrid?.cameras)
        ? result.cameraGrid.cameras
        : [];
      adopt(list);
      return true;
    } catch (error) {
      if (token !== generation) return false;
      if (error?.status === 409) {
        // Previews are off or this screen is not allowed: no picture stays on
        // screen (Hem hides its view at once too).
        adopt([]);
        setNotice(
          'Kameravisning är avstängd. Slå på den under Intelligence i kontrollpanelen.',
        );
      } else setNotice('Kamerorna går inte att nå just nu.');
      return false;
    }
  }

  // Ends the server's lease once an earlier request for it has been answered
  // (so a late "open" cannot land after the "close"), unless the page has been
  // entered again meanwhile: that visit's lease replaces it.
  function closeLease(pending) {
    void Promise.resolve(pending)
      .catch(() => {})
      .then(() => {
        if (active) return;
        return postJson(`${base()}display-api/camera`, {
          action: 'grid-close',
        });
      })
      .catch(() => {});
  }

  // The cameras the server offers; existing tiles are kept (and their last
  // pictures with them) when the same camera is still on the list.
  function adopt(list) {
    const ids = list.map((c) => `${c.id}:${c.name}`).join('|');
    const same = ids === cams.map((c) => `${c.id}:${c.name}`).join('|');
    if (!same) {
      const old = new Map(cams.map((c) => [c.id, c]));
      const next = list.map((item) => {
        const kept = old.get(item.id);
        if (kept) {
          kept.imageUrl = item.imageUrl;
          kept.name = item.name;
          old.delete(item.id);
          return kept;
        }
        return makeCam(item);
      });
      for (const gone of old.values()) dropCam(gone);
      cams = next;
      stage.replaceChildren(...cams.map((c) => c.tile));
      layoutKey = '';
    } else {
      for (let i = 0; i < cams.length; i += 1)
        cams[i].imageUrl = list[i].imageUrl;
    }
    const lost = mode === 'focus' && !cams.some((c) => c.id === focusId);
    if (lost) mode = 'grid';
    setNotice(
      cams.length === 0
        ? 'Inga kameror är påslagna. Slå på dem under Intelligence i kontrollpanelen.'
        : '',
    );
    applyLayout();
    if (lost) globalThis.lugnHistory?.replace();
  }

  // ── Tiles ──

  function makeCam(item) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'cams-tile';
    tile.dataset.camera = item.id;
    tile.dataset.state = 'waiting';
    tile.setAttribute('aria-label', `${item.name}, visa stor`);
    const img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    img.draggable = false;
    img.hidden = true;
    // The name as a small pill with a dot for the picture's state (as Hem's
    // camera view has).
    const name = document.createElement('span');
    name.className = 'cams-name';
    const dot = document.createElement('i');
    dot.className = 'cams-dot';
    const label = document.createElement('span');
    label.textContent = item.name;
    name.append(dot, label);
    tile.append(img, name);
    return {
      id: item.id,
      name: item.name,
      imageUrl: item.imageUrl,
      tile,
      img,
      objectUrl: '',
      lastStart: 0,
      lastOk: 0,
      fails: 0,
      busy: false,
      controller: null,
    };
  }

  function dropCam(cam) {
    cam.controller?.abort();
    release(cam);
    cam.tile.remove();
  }

  function release(cam) {
    if (cam.objectUrl) URL.revokeObjectURL(cam.objectUrl);
    cam.objectUrl = '';
    cam.img.removeAttribute('src');
    cam.img.hidden = true;
  }

  function setTileState(cam, state) {
    if (cam.tile.dataset.state !== state) cam.tile.dataset.state = state;
  }

  // Tiles keep their size; only the grid they stand in changes (rarely).
  // The room the stylesheet gives the grid, with the navbar open and closed.
  const STAGE = { closed: 600 - 12 - 28, open: 600 - 84 - 106 };
  const STAGE_TOP = { closed: 12, open: 84 };
  const MOVE_MS = 360;
  const MOVE_STEPS = 12;
  const navOpen = () => Boolean(root.classList?.contains('menu-open'));
  let drawnOpen = false;
  function stageSize() {
    const wide = Number.parseFloat(root.style.getPropertyValue('--W')) || 1024;
    return {
      width: Math.max(300, wide - 24),
      height: navOpen() ? STAGE.open : STAGE.closed,
    };
  }

  // Each tile moves from where it stood to its new place by transforms alone:
  // the layout is already the new one, and the tile is scaled back to the old.
  // Its picture and name are scaled the other way, so neither is squeezed.
  function glide(tile, from, to) {
    if (!from || !to.w || !to.h || typeof tile.animate !== 'function') return;
    const img = tile.querySelector?.('img');
    const name = tile.querySelector?.('.cams-name');
    const frames = { tile: [], img: [], name: [] };
    for (let step = 0; step <= MOVE_STEPS; step += 1) {
      const t = step / MOVE_STEPS;
      // Ease out, as the navbar's own movement.
      const e = 1 - (1 - t) ** 3;
      const mix = (a, b) => a + (b - a) * e;
      const sx = mix(from.w / to.w, 1);
      const sy = mix(from.h / to.h, 1);
      const cover = Math.max(sx, sy);
      frames.tile.push({
        transform: `translate(${mix(from.x - to.x, 0)}px, ${mix(from.y - to.y, 0)}px) scale(${sx}, ${sy})`,
      });
      frames.img.push({ transform: `scale(${cover / sx}, ${cover / sy})` });
      // The name scales about its own corner (transform-origin in the
      // stylesheet): a transform-origin in the keyframes would keep the whole
      // animation off the compositor.
      frames.name.push({ transform: `scale(${1 / sx}, ${1 / sy})` });
    }
    const timing = { duration: MOVE_MS, easing: 'linear' };
    tile.animate(frames.tile, timing);
    img?.animate?.(frames.img, timing);
    name?.animate?.(frames.name, timing);
  }

  function applyLayout() {
    const { width, height } = stageSize();
    const shown =
      mode === 'focus' ? cams.filter((c) => c.id === focusId) : cams;
    const open = navOpen();
    const key = `${mode}:${focusId}:${cams.length}:${width}:${open}`;
    // Only the navbar opening or closing moves tiles; a new grid is just there.
    const moving = active && open !== drawnOpen && layoutKey !== '';
    const before = STAGE_TOP[drawnOpen ? 'open' : 'closed'];
    const after = STAGE_TOP[open ? 'open' : 'closed'];
    drawnOpen = open;
    if (key !== layoutKey) {
      layoutKey = key;
      const rects =
        mode === 'focus'
          ? [single(width, height)]
          : layout(cams.length, width, height);
      let index = 0;
      for (const cam of cams) {
        const rect = shown.includes(cam) ? rects[index] : null;
        if (rect) index += 1;
        cam.tile.hidden = !rect;
        // What a tap does follows the mode.
        const label =
          mode === 'focus'
            ? `${cam.name}, tillbaka till alla kameror`
            : `${cam.name}, visa stor`;
        if (cam.tile.getAttribute('aria-label') !== label)
          cam.tile.setAttribute('aria-label', label);
        if (rect) {
          const s = cam.tile.style;
          const was = cam.rect;
          cam.rect = rect;
          if (moving && was)
            glide(cam.tile, { ...was, y: was.y + before - after }, rect);
          s.left = `${rect.x}px`;
          s.top = `${rect.y}px`;
          s.width = `${rect.w}px`;
          s.height = `${rect.h}px`;
        }
      }
    }
    root.dataset.mode = mode;
    setBack();
  }

  function setMode(next, id = '') {
    if (next === 'focus' && !cams.some((c) => c.id === id)) next = 'grid';
    if (mode === next && focusId === (next === 'focus' ? id : '')) return;
    mode = next;
    focusId = next === 'focus' ? id : '';
    applyLayout();
    // The camera now alone is asked for at once, and faster.
    if (active) schedule(0);
    globalThis.lugnHistory?.note();
  }

  // The large camera as a level of this page, for Back and Forward
  // (hub-history.js). Before the page is shown it is the camera asked for.
  const freshRequest = () =>
    focusRequest && Date.now() - focusRequest.at < FOCUS_REQUEST_MS
      ? focusRequest.id
      : '';
  const openLevel = () => {
    if (!active) return freshRequest();
    return mode === 'focus' ? focusId : '';
  };
  function setLevel(id) {
    if (active) setMode(id ? 'focus' : 'grid', id);
    else focusRequest = id ? { id, at: Date.now() } : null;
  }

  // ── Pictures ──

  function show(cam, url, at) {
    const first = cam.img.hidden;
    const old = cam.objectUrl;
    cam.objectUrl = url;
    cam.img.src = url;
    cam.img.hidden = false;
    if (old) URL.revokeObjectURL(old);
    cam.lastOk = at;
    cam.fails = 0;
    setTileState(cam, 'live');
    if (first && !calm && typeof cam.img.animate === 'function')
      cam.img.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: 400,
        easing: 'ease-out',
      });
  }

  async function fetchFrame(cam) {
    const token = generation;
    cam.busy = true;
    cam.lastStart = Date.now();
    const controller = new AbortController();
    cam.controller = controller;
    const timeout = window.setTimeout(
      () => controller.abort(),
      FETCH_TIMEOUT_MS,
    );
    let url = '';
    try {
      const response = await fetch(cam.imageUrl, {
        cache: 'no-store',
        credentials: 'same-origin',
        signal: controller.signal,
      });
      if (response.status === 404) {
        // The lease lapsed or the camera was switched off: ask again.
        if (token === generation) void openLease();
        throw new Error('gone');
      }
      if (!response.ok) throw new Error(`image_${response.status}`);
      const blob = await response.blob();
      if (token !== generation) return;
      url = URL.createObjectURL(blob);
      const probe = new Image();
      probe.src = url;
      // Decoded off screen first, so the visible picture is never replaced by
      // one that is not ready.
      if (typeof probe.decode === 'function') await probe.decode();
      // Emptied, not removed: Chrome never frees a detached picture whose `src`
      // attribute was taken away, and a new one is made for every frame.
      probe.src = '';
      if (token !== generation) {
        URL.revokeObjectURL(url);
        return;
      }
      if (paging()) {
        // Not while the pages move: kept until they stop.
        held.push({ cam, url, at: Date.now() });
        url = '';
      } else {
        show(cam, url, Date.now());
        url = '';
      }
    } catch {
      if (url) URL.revokeObjectURL(url);
      if (token === generation) {
        cam.fails += 1;
        if (cam.fails >= 3) setTileState(cam, 'offline');
      }
    } finally {
      window.clearTimeout(timeout);
      // A fetch from before the page stopped touches nothing now.
      if (token === generation) {
        cam.busy = false;
        cam.controller = null;
        if (active) schedule();
      }
    }
  }

  function flushHeld() {
    for (const item of held.splice(0)) {
      if (!cams.includes(item.cam)) {
        URL.revokeObjectURL(item.url);
        continue;
      }
      show(item.cam, item.url, item.at);
    }
  }

  // The camera most overdue goes first; a failing camera waits longer.
  function interval(cam) {
    const base = mode === 'focus' ? FOCUS_INTERVAL_MS : GRID_INTERVAL_MS;
    return Math.min(10_000, base * 2 ** Math.min(cam.fails, 3));
  }

  function tick() {
    wakeTimer = 0;
    if (!active) return;
    const now = Date.now();
    const limit = mode === 'focus' ? 1 : GRID_WORKERS;
    let running = cams.filter((c) => c.busy).length;
    // A camera without an address (listed from Hem's data before the server
    // has answered) is not asked for yet.
    const wanted = (
      mode === 'focus' ? cams.filter((c) => c.id === focusId) : cams
    )
      .filter((c) => c.imageUrl && !c.busy && now - c.lastStart >= interval(c))
      .sort((a, b) => a.lastStart - b.lastStart);
    // Nothing new is asked for while the pages move (the picture would only
    // be held back); the next round comes when they stop.
    if (!paging())
      for (const cam of wanted) {
        if (running >= limit) break;
        running += 1;
        void fetchFrame(cam);
      }
    // Pictures that have gone stale say so.
    for (const cam of cams)
      if (cam.lastOk && now - cam.lastOk > STALE_MS && cam.fails < 3)
        setTileState(cam, 'stale');
    schedule(paging() ? 250 : undefined);
  }

  function schedule(delay) {
    if (!active) return;
    window.clearTimeout(wakeTimer);
    const now = Date.now();
    let next = Infinity;
    for (const cam of mode === 'focus'
      ? cams.filter((c) => c.id === focusId)
      : cams)
      if (cam.imageUrl && !cam.busy)
        next = Math.min(next, cam.lastStart + interval(cam) - now);
    const wait = delay ?? Math.max(60, Number.isFinite(next) ? next : 500);
    wakeTimer = window.setTimeout(tick, wait);
  }

  // ── Page lifecycle ──

  async function start() {
    active = true;
    generation += 1;
    const request = freshRequest();
    focusRequest = null;
    // The cameras are known from Hem's payload before the lease answers.
    if (cams.length === 0) seedFromPayload();
    if (request) {
      mode = 'focus';
      focusId = request;
    } else {
      mode = 'grid';
      focusId = '';
    }
    layoutKey = '';
    applyLayout();
    // The lease is renewed for as long as the page is shown, and asked for
    // again if it failed (Lugn or Home Assistant coming back).
    window.clearInterval(leaseTimer);
    leaseTimer = window.setInterval(
      () =>
        void openLease().then((ok) => {
          if (ok && active && !wakeTimer) schedule(0);
        }),
      LEASE_RENEW_MS,
    );
    if (!(await openLease())) return;
    if (!active) return;
    if (request && !cams.some((c) => c.id === request)) {
      setMode('grid');
      globalThis.lugnHistory?.replace();
    }
    schedule(0);
  }

  // Tiles from the dashboard's own camera list while the server answers, so
  // they stand in their places at once.
  function seedFromPayload() {
    const defs = payload()?.cameraDashboard?.definitions;
    if (!Array.isArray(defs)) return;
    const list = defs
      .filter((d) => d.enabled && d.available)
      .map((d) => ({ id: d.id, name: d.name, imageUrl: '' }));
    if (list.length) adopt(list);
  }

  function stop() {
    if (active) closeLease(leasing?.promise);
    active = false;
    generation += 1;
    window.clearTimeout(wakeTimer);
    wakeTimer = 0;
    window.clearInterval(leaseTimer);
    leaseTimer = 0;
    for (const cam of cams) cam.controller?.abort();
    for (const item of held.splice(0)) URL.revokeObjectURL(item.url);
    for (const cam of cams) cam.busy = false;
  }

  // A resized screen (the pages' canvas follows it) is laid out again.
  window.addEventListener('resize', () => {
    if (!active) return;
    layoutKey = '';
    applyLayout();
  });

  // Pictures held back while the pages moved appear when they stop.
  window.addEventListener('lugn:pages-settled', () => {
    if (active) {
      flushHeld();
      schedule(0);
    }
  });

  // Taps (the navbar, below, gives them to this function first): in the grid a
  // tap on a camera shows it large, and the navbar comes up with its back
  // button so the way out is in sight. In the large view a tap goes to the
  // navbar (it opens or closes). Returns true when the page has taken the tap.
  function handleTap(event) {
    if (!active) return false;
    const tile = event.target.closest?.('.cams-tile');
    if (tile && mode === 'grid') {
      setMode('focus', tile.dataset.camera || '');
      navbar?.show();
      return true;
    }
    return false;
  }

  // The same navbar as Foto and Musik: the scenes, and the way back from one
  // camera, slide up from the bottom edge on mouse movement or a tap beside
  // the cameras. It is attached once every script has run (quick-menu.js comes
  // after this one).
  function attachMenu() {
    globalThis.lugnHistory?.level('kameror', {
      get: openLevel,
      set: setLevel,
    });
    navbar =
      globalThis.lugnQuickMenu?.attach({
        id: 'kameror',
        root,
        handleTap,
      }) ?? null;
    navbar?.onOpen?.(applyLayout);
    navbar?.onClose?.(applyLayout);
    setBack();
  }
  // Deferred scripts run while the document is still `interactive`, before
  // DOMContentLoaded, so only a finished document attaches at once.
  if (document.readyState === 'complete') attachMenu();
  else document.addEventListener('DOMContentLoaded', attachMenu);

  // Tapping Hem's small camera view opens this page on that camera. The
  // whole view takes the tap (its name chip lies over the picture), but its
  // buttons (close, the print chip) keep their own actions. The picture's
  // frame is the keyboard stop.
  const panel = document.getElementById('camera-panel');
  const frame = document.getElementById('camera-image')?.parentElement;
  if (panel && frame) {
    frame.setAttribute('role', 'button');
    frame.setAttribute('tabindex', '0');
    frame.setAttribute('aria-label', 'Visa kameran stor bland alla kameror');
    const open = () => {
      const id = payload()?.cameraDashboard?.active?.cameraId;
      if (!id) return;
      focusRequest = { id, at: Date.now() };
      if (!pagesApi.go('kameror')) focusRequest = null;
    };
    panel.addEventListener('click', (event) => {
      if (event.target.closest?.('button, a, input')) return;
      open();
    });
    frame.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      open();
    });
  }

  pagesApi.define('kameror', {
    // As a neighbour the page is only laid out from what Hem already knows:
    // no lease, no pictures, nothing that changes unless the cameras do.
    prepare() {
      if (!active && cams.length === 0) seedFromPayload();
    },
    enter() {
      void start();
    },
    leave() {
      stop();
    },
    sleep() {
      stop();
      for (const cam of cams) {
        release(cam);
        setTileState(cam, 'waiting');
        cam.lastOk = 0;
        cam.lastStart = 0;
        cam.fails = 0;
      }
    },
  });
})();
