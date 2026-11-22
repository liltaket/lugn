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
  const GRID_INTERVAL_MS = 1500; // per camera, grid
  const FOCUS_INTERVAL_MS = 800; // per camera, one large
  const GRID_WORKERS = 3; // pictures in flight at once
  const FETCH_TIMEOUT_MS = 8000;
  const STALE_MS = 8000; // no new picture for this long: shown as stale
  const LEASE_RENEW_MS = 20_000; // the server's lease lasts 45 s
  const FOCUS_REQUEST_MS = 4000; // a tap on Hem's view stays valid this long
  const RATIO = 16 / 9;
  const GAP = 12;

  // ── Layout (pure) ──

  /**
   * Places `count` equal 16:9 tiles in a `width` × `height` area: the number
   * of columns that gives the biggest tiles, rows centred, a short last row
   * centred. Returns [{x, y, w, h}] in reading order.
   */
  function layout(count, width, height, gap = GAP, ratio = RATIO) {
    if (!(count > 0) || !(width > 0) || !(height > 0)) return [];
    let best = null;
    for (let cols = 1; cols <= Math.min(count, 4); cols += 1) {
      const rows = Math.ceil(count / cols);
      const w = Math.min(
        (width - (cols - 1) * gap) / cols,
        ((height - (rows - 1) * gap) / rows) * ratio,
      );
      if (!best || w > best.w + 0.5) best = { cols, rows, w };
    }
    const w = Math.floor(best.w);
    const h = Math.floor(w / ratio);
    const top = (height - (best.rows * h + (best.rows - 1) * gap)) / 2;
    const rects = [];
    for (let row = 0; row < best.rows; row += 1) {
      const inRow =
        row === best.rows - 1 ? count - best.cols * (best.rows - 1) : best.cols;
      const left = (width - (inRow * w + (inRow - 1) * gap)) / 2;
      for (let col = 0; col < inRow; col += 1)
        rects.push({
          x: Math.round(left + col * (w + gap)),
          y: Math.round(top + row * (h + gap)),
          w,
          h,
        });
    }
    return rects;
  }

  /** One tile as large as the area allows, centred. */
  function single(width, height, ratio = RATIO) {
    const w = Math.floor(Math.min(width, height * ratio));
    const h = Math.floor(w / ratio);
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
  const sub = root.querySelector("[data-view='sub']");
  const back = root.querySelector("[data-view='back']");
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

  function setSub() {
    if (!sub) return;
    const text =
      mode === 'focus'
        ? cams.find((c) => c.id === focusId)?.name || ''
        : cams.length
          ? `${cams.length} ${cams.length === 1 ? 'kamera' : 'kameror'} · tryck för att förstora`
          : '';
    if (sub.textContent !== text) sub.textContent = text;
    if (back) back.hidden = mode !== 'focus';
  }

  // ── Server lease ──

  let leasing = null;
  function openLease() {
    // One request at a time: a camera whose picture says "gone" must not
    // start one each.
    leasing ??= requestLease().finally(() => {
      leasing = null;
    });
    return leasing;
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
      setNotice(
        error?.status === 409
          ? 'Kameravisning är avstängd. Slå på den under Intelligence i kontrollpanelen.'
          : 'Kamerorna går inte att nå just nu.',
      );
      return false;
    }
  }

  function closeLease() {
    // Best effort: the lease also lapses by itself.
    void postJson(`${base()}display-api/camera`, {
      action: 'grid-close',
    }).catch(() => {});
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
    if (mode === 'focus' && !cams.some((c) => c.id === focusId)) mode = 'grid';
    setNotice(
      cams.length === 0
        ? 'Inga kameror är påslagna. Slå på dem under Intelligence i kontrollpanelen.'
        : '',
    );
    applyLayout();
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
    const name = document.createElement('span');
    name.className = 'cams-name';
    name.textContent = item.name;
    const state = document.createElement('span');
    state.className = 'cams-state';
    tile.append(img, name, state);
    return {
      id: item.id,
      name: item.name,
      imageUrl: item.imageUrl,
      tile,
      img,
      state,
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
  function stageSize() {
    const wide = Number.parseFloat(root.style.getPropertyValue('--W')) || 1024;
    return { width: Math.max(300, wide - 72), height: 600 - 76 - 40 };
  }

  function applyLayout() {
    const { width, height } = stageSize();
    const shown =
      mode === 'focus' ? cams.filter((c) => c.id === focusId) : cams;
    const key = `${mode}:${focusId}:${cams.length}:${width}`;
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
        if (rect) {
          const s = cam.tile.style;
          s.left = `${rect.x}px`;
          s.top = `${rect.y}px`;
          s.width = `${rect.w}px`;
          s.height = `${rect.h}px`;
        }
      }
    }
    root.dataset.mode = mode;
    setSub();
  }

  function setMode(next, id = '') {
    if (next === 'focus' && !cams.some((c) => c.id === id)) next = 'grid';
    if (mode === next && focusId === (next === 'focus' ? id : '')) return;
    mode = next;
    focusId = next === 'focus' ? id : '';
    applyLayout();
    // The camera now alone is asked for at once, and faster.
    if (active) schedule(0);
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
    const request =
      focusRequest && Date.now() - focusRequest.at < FOCUS_REQUEST_MS
        ? focusRequest.id
        : '';
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
    if (request && !cams.some((c) => c.id === request)) setMode('grid');
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
    if (active) closeLease();
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

  // Pictures held back while the pages moved appear when they stop.
  window.addEventListener('lugn:pages-settled', () => {
    if (active) {
      flushHeld();
      schedule(0);
    }
  });

  // A tap on a camera shows it large; a tap on it again, or on the title
  // button, returns to the grid.
  stage.addEventListener('click', (event) => {
    const tile = event.target.closest?.('.cams-tile');
    if (!tile || !active) return;
    if (mode === 'focus') setMode('grid');
    else setMode('focus', tile.dataset.camera || '');
  });
  back?.addEventListener('click', () => setMode('grid'));

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
      pagesApi.go('kameror');
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
      for (const cam of cams) release(cam);
    },
  });
})();
