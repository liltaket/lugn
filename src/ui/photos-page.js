// Foto: the Hub as a picture frame (pages.js runs the pager).
//
// The server keeps a small local copy of one shared album and lists it at
// display-api/photos. This page shows the pictures in changing layouts, one to
// three at a time, with a quiet caption (place and date the picture was taken).
//
// Rules from the Hub's responsiveness notes: a slide is built off screen,
// every picture is decoded before it is shown, pictures are fetched one at a
// time, and the only thing that animates is the opacity of a whole slide. No
// root property changes per picture, no blur is computed on the Hub (the
// blurred backdrop is a small picture the server made, scaled up), and nothing
// changes while the pager is moving.
(() => {
  'use strict';

  const pagesApi = globalThis.lugnPages;
  const SHOW_MS = 20_000;
  const FADE_MS = 1400;
  const DECODE_WAIT_MS = 5000;
  const LIST_MS = 10 * 60_000;
  const LANDSCAPE_RATIO = 1.1;
  const PANORAMA_RATIO = 1.9;

  const base = () =>
    typeof BASE_PATH === 'string' ? BASE_PATH : location.pathname;

  // ── Planning (pure) ──

  const isLandscape = (photo) => photo.w / photo.h >= LANDSCAPE_RATIO;
  const isPanorama = (photo) => photo.w / photo.h >= PANORAMA_RATIO;

  // Layouts (what each needs from the queue is decided in plan):
  //   single  one landscape fills the screen (a portrait alone, over its own
  //           backdrop, only when nothing else is left to go with it)
  //   duo     two portraits side by side
  //   pair    a portrait and a landscape side by side
  //   trio    three portraits side by side
  //   mixed   one landscape and two portraits
  //   stack3  three landscapes: two small, one large
  //   wide2   two panoramas stacked

  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffled(items, random) {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  // ── Order of play ──
  //
  // Pictures taken close in time (and place) are played near each other, so a
  // slide often shows moments from the same outing, but the groups are not
  // fixed: the order of the groups is shuffled and some pictures wander.
  const CLUSTER_GAP_MS = 4 * 60 * 60 * 1000;
  const CLUSTER_KM = 30;

  function distanceKm(a, b) {
    if (a.lat == null || b.lat == null) return 0;
    const dy = (a.lat - b.lat) * 111.32;
    const dx = (a.lon - b.lon) * 111.32 * Math.cos((a.lat * Math.PI) / 180);
    return Math.hypot(dx, dy);
  }

  // Clusters by time: a gap of more than a few hours or a move of more than a
  // few tens of kilometres starts a new one. Pictures without a time are alone.
  function clusters(photos) {
    const timed = photos
      .filter((p) => typeof p.t === 'number')
      .sort((a, b) => a.t - b.t);
    const out = [];
    let group = [];
    for (const photo of timed) {
      const last = group[group.length - 1];
      if (
        last &&
        (photo.t - last.t > CLUSTER_GAP_MS ||
          distanceKm(last, photo) > CLUSTER_KM)
      ) {
        out.push(group);
        group = [];
      }
      group.push(photo);
    }
    if (group.length > 0) out.push(group);
    for (const photo of photos)
      if (typeof photo.t !== 'number') out.push([photo]);
    return out;
  }

  function orderQueue(photos, random = Math.random) {
    const order = shuffled(clusters(photos), random).flat();
    // About one in ten pictures moves up to a dozen places, so no group
    // stays together for good.
    for (let i = 0; i < order.length - 1; i += 1) {
      if (random() >= 0.1) continue;
      const j =
        i + 1 + Math.floor(random() * Math.min(12, order.length - i - 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    return order;
  }

  // Takes the first `count` queue entries matching `test`, looking only a few
  // pictures ahead so the order stays close to the shuffle.
  function take(queue, count, test, window = 10) {
    const found = [];
    for (let i = 0; i < queue.length && i < window; i += 1)
      if (test(queue[i])) found.push(i);
    return found.length >= count ? found.slice(0, count) : null;
  }

  /**
   * Chooses the next slide from the front of the queue. Returns
   * { layout, photos, rest } where `rest` is the queue without the used
   * pictures. Never repeats the previous layout when another one fits, and
   * shows a single picture about every other time.
   */
  function plan(queue, previousLayout, random = Math.random) {
    if (queue.length === 0) return null;
    const first = queue[0];
    const options = [];
    const add = (layout, indexes, weight) => {
      if (indexes) options.push({ layout, indexes, weight });
    };
    if (isLandscape(first)) {
      add('single', [0], 3);
      const portraits = take(queue.slice(1), 2, (p) => !isLandscape(p));
      if (portraits) add('mixed', [0, ...portraits.map((i) => i + 1)], 2);
      const portrait = take(queue.slice(1), 1, (p) => !isLandscape(p));
      // A portrait beside a landscape: the portrait goes first.
      if (portrait) add('pair', [portrait[0] + 1, 0], 2);
      const landscapes = take(queue.slice(1), 2, isLandscape);
      if (landscapes) add('stack3', [0, ...landscapes.map((i) => i + 1)], 2);
      if (isPanorama(first)) {
        const other = take(queue.slice(1), 1, isPanorama);
        if (other) add('wide2', [0, other[0] + 1], 4);
      }
    } else {
      const more = take(queue.slice(1), 2, (p) => !isLandscape(p));
      if (more) add('trio', [0, ...more.map((i) => i + 1)], 3);
      const one = take(queue.slice(1), 1, (p) => !isLandscape(p));
      if (one) add('duo', [0, one[0] + 1], 3);
      const land = take(queue.slice(1), 1, isLandscape);
      if (land) add('pair', [0, land[0] + 1], 2);
      // A portrait alone, with black around it, only as a last resort.
      if (options.length === 0) add('single', [0], 1);
    }
    let pool = options.filter((option) => option.layout !== previousLayout);
    if (pool.length === 0) pool = options;
    let total = 0;
    for (const option of pool) total += option.weight;
    let pick = random() * total;
    let chosen = pool[0];
    for (const option of pool) {
      pick -= option.weight;
      if (pick < 0) {
        chosen = option;
        break;
      }
    }
    const used = new Set(chosen.indexes);
    return {
      layout: chosen.layout,
      photos: chosen.indexes.map((i) => queue[i]),
      rest: queue.filter((_, i) => !used.has(i)),
    };
  }

  const MONTHS = [
    'januari',
    'februari',
    'mars',
    'april',
    'maj',
    'juni',
    'juli',
    'augusti',
    'september',
    'oktober',
    'november',
    'december',
  ];

  function parseDate(date) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
    return match
      ? { y: Number(match[1]), m: Number(match[2]) - 1, d: Number(match[3]) }
      : null;
  }

  /**
   * The quiet caption of a slide: the place and the date the pictures were
   * taken, only where they agree. The year is left out for this year.
   */
  function caption(photos, thisYear = new Date().getFullYear()) {
    const places = new Set(photos.map((p) => p.place || ''));
    const place = places.size === 1 ? [...places][0] : '';
    const dates = photos.map((p) => parseDate(p.date));
    let date = '';
    if (dates.every(Boolean)) {
      const [a] = dates;
      const sameDay = dates.every(
        (d) => d.y === a.y && d.m === a.m && d.d === a.d,
      );
      const sameMonth = dates.every((d) => d.y === a.y && d.m === a.m);
      const year = a.y === thisYear ? '' : ` ${a.y}`;
      if (sameDay) date = `${a.d} ${MONTHS[a.m]}${year}`;
      else if (sameMonth) date = `${MONTHS[a.m]}${year || ` ${a.y}`}`;
    }
    return { place, date };
  }

  globalThis.lugnPhotos = {
    plan,
    caption,
    shuffled,
    mulberry32,
    orderQueue,
    clusters,
  };

  if (!pagesApi) return;
  const root = document.querySelector(
    ".hub-page[data-page='foto'] [data-view='root']",
  );
  if (!root) return;
  const stage = root.querySelector("[data-view='stage']");
  const notice = root.querySelector("[data-view='notice']");
  const pager = document.getElementById('hub-pager');

  // ── State ──

  let revision = '';
  let seen = false;
  let library = [];
  let queue = [];
  let random = mulberry32((Date.now() ^ 0x9e3779b9) >>> 0);
  let previousLayout = '';
  let current = null; // { el, layout }
  let building = null; // promise while a slide is being prepared
  let active = false;
  let showTimer = 0;
  let listTimer = 0;
  let listing = null;
  let pendingAdvance = false;
  let generation = 0;

  const paging = () => Boolean(pager && pager.classList.contains('paging'));
  // Runs `fn` now, or once the pager has stopped moving: nothing of this page
  // writes to the DOM or draws while a swipe is under way.
  function whenStill(fn) {
    if (!paging()) {
      fn();
      return;
    }
    const once = () => {
      window.removeEventListener('lugn:pages-settled', once);
      fn();
    };
    window.addEventListener('lugn:pages-settled', once);
  }

  function setNotice(text) {
    if (!notice) return;
    if (text) notice.textContent = text;
    notice.hidden = !text;
  }

  async function loadList() {
    if (listing) return listing;
    listing = (async () => {
      try {
        const response = await fetch(`${base()}display-api/photos`, {
          cache: 'no-store',
        });
        if (response.status === 404) {
          library = [];
          setNotice('Fotoramen är inte inställd');
          return;
        }
        if (!response.ok) return;
        const data = await response.json();
        if (!data || !Array.isArray(data.photos)) return;
        if (data.revision !== revision) {
          revision = data.revision;
          library = data.photos;
          // Removed pictures leave the queue; new ones play next (the first
          // list ever read is simply put in order).
          const known = new Set(library.map((p) => p.id));
          queue = queue.filter((p) => known.has(p.id));
          const queued = new Set(queue.map((p) => p.id));
          const fresh = library.filter((p) => !queued.has(p.id));
          if (!seen) queue = orderQueue(library, random);
          else if (fresh.length > 0)
            queue = orderQueue(fresh, random).concat(queue);
          seen = true;
        }
        setNotice(library.length === 0 ? 'Inga bilder ännu' : '');
      } catch {
        /* the next round tries again */
      } finally {
        listing = null;
      }
    })();
    return listing;
  }

  function refill() {
    if (queue.length < 4 && library.length > 0) {
      const queued = new Set(queue.map((p) => p.id));
      // Another round: everything not already waiting, in a new order.
      queue = queue.concat(
        orderQueue(
          library.filter((p) => !queued.has(p.id)),
          random,
        ),
      );
    }
  }

  // ── Building a slide ──

  const photoUrl = (photo, variant) =>
    `${base()}display-api/photos/${photo.id}${variant ? `/${variant}` : ''}`;

  function cell(photo, className) {
    const wrap = document.createElement('div');
    wrap.className = `ph-cell ${className || ''}`.trim();
    const image = new Image();
    image.alt = '';
    image.decoding = 'async';
    image.draggable = false;
    image.setAttribute('fetchpriority', 'low');
    image.src = photoUrl(photo);
    wrap.appendChild(image);
    // A soft veil along the bottom, drawn from the picture itself once it is
    // decoded and shown while the menu is up: no blur is computed on the Hub.
    const veil = document.createElement('canvas');
    veil.className = 'ph-veil';
    wrap.appendChild(veil);
    return { wrap, image, veil };
  }

  // Pictures start loading together (one slide), but are decoded one at a time.
  async function decodeAll(images, token) {
    for (const image of images) {
      if (token !== generation) return false;
      // decode() can wait for a rendering opportunity that a hidden page never
      // gets; a picture that has loaded is shown after a while regardless.
      let timer = 0;
      try {
        await Promise.race([
          image.decode(),
          new Promise((resolve) => {
            timer = window.setTimeout(resolve, DECODE_WAIT_MS);
          }),
        ]);
      } catch {
        return false;
      } finally {
        window.clearTimeout(timer);
      }
      if (!image.complete || image.naturalWidth === 0) return false;
    }
    return token === generation;
  }

  async function build(chosen) {
    const slide = document.createElement('div');
    const landscapeSingle =
      chosen.layout === 'single' && isLandscape(chosen.photos[0]);
    slide.className = `ph-slide ph-${chosen.layout}${
      chosen.layout === 'single'
        ? landscapeSingle
          ? ' ph-landscape'
          : ' ph-portrait'
        : ''
    }`;
    const images = [];
    const veils = [];
    const add = (photo, className) => {
      const made = cell(photo, className);
      slide.appendChild(made.wrap);
      images.push(made.image);
      veils.push({ canvas: made.veil, image: made.image });
      return made;
    };
    const { photos, layout } = chosen;
    if (layout === 'single') {
      const photo = photos[0];
      if (isLandscape(photo)) {
        add(photo, 'ph-full');
      } else {
        const backdrop = document.createElement('img');
        backdrop.className = 'ph-backdrop';
        backdrop.alt = '';
        backdrop.decoding = 'async';
        backdrop.src = photoUrl(photo, 'backdrop');
        slide.appendChild(backdrop);
        images.push(backdrop);
        add(photo, 'ph-portrait');
      }
    } else if (layout === 'duo') {
      for (const photo of photos) add(photo, 'ph-half');
    } else if (layout === 'pair') {
      add(photos[0], 'ph-pair-p');
      add(photos[1], 'ph-pair-l');
    } else if (layout === 'trio') {
      for (const photo of photos) add(photo, 'ph-col');
    } else if (layout === 'mixed') {
      // The landscape first, then two portraits.
      for (const photo of photos) add(photo, '');
    } else if (layout === 'stack3') {
      photos.forEach((photo, i) => add(photo, i === 0 ? 'ph-big' : ''));
    } else {
      for (const photo of photos) add(photo, '');
    }
    const text = caption(photos);
    if (text.place || text.date) {
      const element = document.createElement('div');
      element.className = 'ph-cap';
      if (text.place) {
        const place = document.createElement('b');
        place.textContent = text.place;
        element.appendChild(place);
      }
      if (text.date) {
        const date = document.createElement('span');
        date.textContent = text.date;
        element.appendChild(date);
      }
      slide.appendChild(element);
    }
    return { slide, images, veils };
  }

  // The bottom of the picture, shrunk twice (a blur by averaging), with an alpha
  // ramp from clear at the top to dark at the bottom edge.
  function drawVeil(canvas, image) {
    try {
      const w = 64;
      const h = 24;
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      const step = document.createElement('canvas');
      step.width = 16;
      step.height = 6;
      const stepCtx = step.getContext('2d');
      if (!ctx || !stepCtx) return;
      const sh = image.naturalHeight * 0.45;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(
        image,
        0,
        image.naturalHeight - sh,
        image.naturalWidth,
        sh,
        0,
        0,
        w,
        h,
      );
      stepCtx.imageSmoothingQuality = 'high';
      stepCtx.drawImage(canvas, 0, 0, w, h, 0, 0, 16, 6);
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(step, 0, 0, 16, 6, 0, 0, w, h);
      ctx.globalCompositeOperation = 'destination-in';
      const ramp = ctx.createLinearGradient(0, 0, 0, h);
      ramp.addColorStop(0, 'rgba(0,0,0,0)');
      ramp.addColorStop(0.55, 'rgba(0,0,0,0.8)');
      ramp.addColorStop(1, 'rgba(0,0,0,0.95)');
      ctx.fillStyle = ramp;
      ctx.fillRect(0, 0, w, h);
    } catch {
      /* no veil; the dark gradient remains */
    }
  }

  // Prepares the next slide off screen. Resolves to null when stale or when a
  // picture failed (its photo is dropped from the queue).
  // One consumer gets a built slide: a second caller while one is being built
  // gets `false` (busy, not a failure), so the same slide is never shown twice.
  async function prepareNext() {
    if (building) return false;
    const token = generation;
    const mine = (async () => {
      try {
        if (library.length === 0) await loadList();
        refill();
        const chosen = plan(queue, previousLayout, random);
        if (!chosen) return null;
        queue = chosen.rest;
        const made = await build(chosen);
        if (!(await decodeAll(made.images, token))) {
          drop(made.slide);
          return null;
        }
        if (paging()) await new Promise((resolve) => whenStill(resolve));
        for (const veil of made.veils) drawVeil(veil.canvas, veil.image);
        return { ...made, layout: chosen.layout };
      } finally {
        if (building === mine) building = null;
      }
    })();
    building = mine;
    return mine;
  }

  // ── Showing ──

  function drop(slide) {
    if (!slide) return;
    for (const image of slide.querySelectorAll('img'))
      image.removeAttribute('src');
    slide.remove();
  }

  // The new slide fades in over the old one, which stays opaque until it is
  // covered and is then dropped: one layer animates, and at most two slides
  // are ever in the page. The layer hint is set a moment before the fade
  // starts so the raster of its pictures is not part of the fade's first frame.
  let fading = false;
  const LIFT_MS = 120;
  function show(next) {
    // The same slide is never shown against itself.
    if (current && next.slide === current.el) return;
    const old = current;
    previousLayout = next.layout;
    current = { el: next.slide, layout: next.layout };
    if (!old) {
      // The very first slide appears without a fade, while the page is not
      // being looked at.
      next.slide.classList.add('in');
      stage.appendChild(next.slide);
      return;
    }
    fading = true;
    next.slide.classList.add('lift');
    stage.appendChild(next.slide);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      window.clearTimeout(fallback);
      next.slide.removeEventListener('transitionend', onEnd);
      next.slide.classList.remove('lift');
      drop(old.el);
      fading = false;
    };
    const onEnd = (event) => {
      if (event.target === next.slide) whenStill(finish);
    };
    const fallback = window.setTimeout(
      () => whenStill(finish),
      LIFT_MS + FADE_MS + 400,
    );
    next.slide.addEventListener('transitionend', onEnd);
    window.setTimeout(() => {
      if (!finished) whenStill(() => next.slide.classList.add('in'));
    }, LIFT_MS);
  }

  // Failed builds (a missing picture, a server that is down) are tried again
  // with a growing pause.
  let failures = 0;
  const retryDelay = () => Math.min(5000 * 2 ** failures, 5 * 60_000);

  async function advance(manual) {
    // A timer that has fired is gone; a tap leaves a pending one alone until
    // a slide is shown.
    if (!manual) showTimer = 0;
    if (!active) return;
    if (menuOpen && !manual) return; // closing the menu schedules the next
    if (fading || building) {
      if (!manual) scheduleShow(1000);
      return;
    }
    if (paging()) {
      pendingAdvance = true;
      return;
    }
    pendingAdvance = false;
    const token = generation;
    const next = await prepareNext();
    if (token !== generation) {
      if (next) drop(next.slide);
      return;
    }
    if (next === false) {
      if (active && !manual) scheduleShow(1000);
      return;
    }
    if (!next) {
      failures += 1;
      if (active) scheduleShow(retryDelay());
      return;
    }
    failures = 0;
    if (!active || paging()) {
      // Not shown after all: keep what was prepared for the next try.
      drop(next.slide);
      pendingAdvance = active;
      if (active && !menuOpen) scheduleShow(SHOW_MS);
      return;
    }
    show(next);
    scheduleShow(SHOW_MS);
  }

  function scheduleShow(ms) {
    window.clearTimeout(showTimer);
    showTimer = window.setTimeout(advance, ms);
  }

  // The first slide. From prepare (a neighbour, every ~2 s) it is tried at
  // most once a minute, so a missing album, an empty one or a picture that
  // will not decode costs nothing; entering the page always tries.
  const RETRY_MS = 60_000;
  let lastFillAt = 0;
  let held = null; // a first slide that was ready while the pager moved
  async function fillFirst(force) {
    if (current || building || held) return;
    const now = Date.now();
    if (!force && lastFillAt && now - lastFillAt < RETRY_MS) return;
    lastFillAt = now;
    const token = generation;
    await loadList();
    const next = await prepareNext();
    if (next === false) return;
    if (!next) {
      failures += 1;
      return;
    }
    failures = 0;
    if (current || token !== generation) {
      drop(next.slide);
      return;
    }
    if (paging()) {
      held = next;
      return;
    }
    show(next);
  }

  function release() {
    generation += 1;
    window.clearTimeout(showTimer);
    showTimer = 0;
    window.clearInterval(listTimer);
    listTimer = 0;
    if (current) drop(current.el);
    for (const old of stage.querySelectorAll('.ph-slide')) drop(old);
    current = null;
    fading = false;
    if (held) drop(held.slide);
    held = null;
    lastFillAt = 0;
    failures = 0;
    building = null;
    pendingAdvance = false;
  }

  window.addEventListener('lugn:pages-settled', () => {
    if (held) {
      const next = held;
      held = null;
      if (current) drop(next.slide);
      else show(next);
    }
    if (pendingAdvance && active) void advance();
  });

  // ── Quick menu and the music widget ──
  //
  // The quick menu (quick-menu.js) slides up with Hem's scenes, a camera button
  // and a button for the next picture. The picture stays while it is open. The
  // music widget (pause, title, artist) is there whenever something plays and
  // is lifted over the menu while it is open.
  const menuElement = root.querySelector("[data-view='menu']");
  const nextButton = root.querySelector("[data-view='next']");
  const pauseButton = root.querySelector("[data-view='pause']");
  const nowBox = root.querySelector("[data-view='now']");
  const nowTitle = root.querySelector("[data-view='now-title']");
  const nowArtist = root.querySelector("[data-view='now-artist']");
  const pauseIcon = root.querySelector("[data-view='pause-icon']");
  const PAUSE_PATH = 'M8 5v14M16 5v14';
  const PLAY_PATH = 'M8 5.5v13l11-6.5Z';
  const LAST_PLAYED = 'Senast spelat: ';
  let menuOpen = false;
  let nowTimer = 0;

  const hem = () => (typeof refs === 'object' && refs ? refs : null);
  const setText = (element, value) => {
    if (element && element.textContent !== value) element.textContent = value;
  };

  // Pause and what is playing come from Hem's own music card, and a press is
  // Hem's own play button pressed, so the same rules (paused by hand, computer
  // media, pending) apply as there. Read once in a while, only while the page
  // is shown.
  function drawNow() {
    const r = hem();
    if (!r || !nowBox || paging()) return;
    const shown =
      document.getElementById('app-root')?.dataset.musicVisible === 'true';
    if (nowBox.hidden === shown) nowBox.hidden = !shown;
    if (!shown) return;
    const raw = r.musicTitle?.textContent?.trim() || '';
    setText(
      nowTitle,
      raw.startsWith(LAST_PLAYED) ? raw.slice(LAST_PLAYED.length) : raw,
    );
    setText(
      nowArtist,
      r.musicArtist && !r.musicArtist.hidden
        ? r.musicArtist.textContent.trim()
        : '',
    );
    const playing = r.musicPlaybackLabel?.textContent?.trim() === 'Pausa';
    const path = playing ? PAUSE_PATH : PLAY_PATH;
    if (pauseIcon.getAttribute('d') !== path) pauseIcon.setAttribute('d', path);
    const label = playing ? 'Pausa' : 'Spela';
    if (pauseButton.getAttribute('aria-label') !== label)
      pauseButton.setAttribute('aria-label', label);
    const disabled = r.musicPlayback?.disabled !== false;
    if (pauseButton.disabled !== disabled) pauseButton.disabled = disabled;
  }

  const quickMenu = globalThis.lugnQuickMenu?.attach({
    id: 'foto',
    root,
    menu: menuElement,
    // The page's own controls: pause (always there while music plays) and the
    // next picture.
    handleTap(event) {
      if (pauseButton?.contains(event.target)) {
        if (!pauseButton.disabled) hem()?.musicPlayback?.click();
        window.setTimeout(drawNow, 0);
        return true;
      }
      if (nextButton?.contains(event.target)) {
        void advance(true);
        return true;
      }
      return false;
    },
  });
  quickMenu?.onOpen(() => {
    menuOpen = true;
    window.clearTimeout(showTimer);
    showTimer = 0;
  });
  quickMenu?.onClose(() => {
    menuOpen = false;
    if (active && !showTimer) scheduleShow(SHOW_MS);
  });

  pagesApi.define('foto', {
    // Draws the first picture once while the page is a neighbour; later calls
    // change nothing.
    prepare() {
      void fillFirst(false);
    },
    enter() {
      active = true;
      drawNow();
      if (!nowTimer) nowTimer = window.setInterval(drawNow, 2000);
      void fillFirst(true).then(() => {
        // A first slide that failed to build is tried again soon.
        if (active && !showTimer)
          scheduleShow(current ? SHOW_MS : retryDelay());
      });
      if (!listTimer)
        listTimer = window.setInterval(() => void loadList(), LIST_MS);
    },
    leave() {
      quickMenu?.close();
      active = false;
      window.clearInterval(nowTimer);
      nowTimer = 0;
      window.clearTimeout(showTimer);
      showTimer = 0;
      window.clearInterval(listTimer);
      listTimer = 0;
    },
    sleep() {
      quickMenu?.close();
      active = false;
      window.clearInterval(nowTimer);
      nowTimer = 0;
      release();
    },
  });
})();
