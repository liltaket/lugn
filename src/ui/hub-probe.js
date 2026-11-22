// On-device profile for the Nest Hub. A Hub has no devtools, so this page
// measures itself and posts what it saw to /display-api/probe, where the
// server writes it to the journal. It runs only when the Hub is opened with
// the URL fragment #probe (display.js loads this file then) and never changes
// anything the dashboard does: it adds and removes a small test element and
// some temporary style rules, and presses nothing.
//
// Phases (each posted as soon as it is done):
//   info      browser, screen, memory, which timing APIs exist
//   cpu       fixed JavaScript and DOM work, to compare with a desktop
//   idle      the dashboard alone: frame gaps, long tasks, long frames
//   bare      the dashboard hidden, one moving square: the device's own
//             frame rate when the page is trivial
//   dot       the dashboard with a dot moved by rAF like the pointer bridge
//   dot-*     the same with filters, shadows, animations or layers removed
//   press     the visual press of a scene tile (nothing is sent to Lugn)
(() => {
  'use strict';
  if (window.HubProbe) return;

  const PROBE_URL = `${location.pathname.replace(/\/?$/, '/')}display-api/probe`;
  const run = Math.random().toString(36).slice(2, 8);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const round = (value, digits = 1) => {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  };

  let label;
  function say(text) {
    if (!label) {
      label = document.createElement('div');
      label.style.cssText =
        'position:fixed;left:8px;top:8px;z-index:2147483647;padding:4px 8px;' +
        'border-radius:6px;background:rgba(0,0,0,.72);color:#fff;' +
        'font:12px/1.3 system-ui,sans-serif;pointer-events:none';
      document.body.append(label);
    }
    label.textContent = text;
  }

  let undelivered = 0;
  // Captured before any phase replaces fetch: reports always go out for real.
  const realFetch = window.fetch.bind(window);

  async function post(phase, data) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 5000);
    try {
      const response = await realFetch(PROBE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ run, phase, data }),
        signal: abort.signal,
      });
      if (!response.ok) undelivered += 1;
    } catch {
      undelivered += 1;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Observers ──

  const support = {
    longtask: false,
    loaf: false,
    animations: typeof Element.prototype.animate === 'function',
  };
  const longTasks = [];
  const loafs = [];
  const observers = [];
  function observe(type, sink, flag) {
    try {
      if (!PerformanceObserver.supportedEntryTypes?.includes(type)) return;
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) sink.push(entry);
      });
      observer.observe({ type, buffered: false });
      observers.push({ observer, sink });
      support[flag] = true;
    } catch {
      // Not supported by this Chromium.
    }
  }
  observe('longtask', longTasks, 'longtask');
  observe('long-animation-frame', loafs, 'loaf');
  // Entries are delivered a little late; a phase asks for the rest first.
  function drain() {
    for (const { observer, sink } of observers)
      for (const entry of observer.takeRecords()) sink.push(entry);
  }

  let aborted = false;
  const abortRun = () => {
    aborted = true;
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') abortRun();
  });
  window.addEventListener('pagehide', abortRun);

  function percentile(sorted, fraction) {
    if (!sorted.length) return 0;
    return sorted[
      Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)
    ];
  }

  // Frames seen by rAF for `ms` while `drive` (optional) runs every frame.
  function sampleFrames(ms, drive) {
    return new Promise((resolve, reject) => {
      const gaps = [];
      const startedAt = performance.now();
      let last = startedAt;
      const frame = (time) => {
        try {
          if (aborted) {
            resolve({ gaps, startedAt, endedAt: time, aborted: true });
            return;
          }
          gaps.push(time - last);
          last = time;
          if (drive) drive(time - startedAt);
          if (time - startedAt < ms) requestAnimationFrame(frame);
          else resolve({ gaps, startedAt, endedAt: time, aborted: false });
        } catch (error) {
          reject(error);
        }
      };
      requestAnimationFrame(frame);
    });
  }

  async function summarise({ gaps, startedAt, endedAt, aborted: stopped }) {
    // The frame that ends the window finishes, then late entries arrive.
    await sleep(250);
    drain();
    const inWindow = (entry) =>
      entry.startTime >= startedAt && entry.startTime <= endedAt;
    const sorted = gaps.slice(1).sort((a, b) => a - b);
    const covered = gaps.slice(1).reduce((sum, gap) => sum + gap, 0);
    const mine = longTasks.filter(inWindow);
    const frames = loafs.filter(inWindow);
    const result = {
      frames: sorted.length,
      fps: covered ? round((sorted.length * 1000) / covered) : 0,
      gapP50: round(percentile(sorted, 0.5)),
      gapP95: round(percentile(sorted, 0.95)),
      gapMax: round(sorted[sorted.length - 1] ?? 0),
      over20: sorted.filter((gap) => gap > 20).length,
      over33: sorted.filter((gap) => gap > 33.5).length,
      over50: sorted.filter((gap) => gap > 50).length,
      longTasks: mine.length,
      longTaskMs: round(mine.reduce((sum, entry) => sum + entry.duration, 0)),
      longTaskMax: round(Math.max(0, ...mine.map((entry) => entry.duration))),
    };
    if (stopped) result.aborted = true;
    if (support.loaf) {
      result.loaf = frames.length;
      result.loafMs = round(
        frames.reduce((sum, entry) => sum + entry.duration, 0),
      );
      result.loafMax = round(
        Math.max(0, ...frames.map((entry) => entry.duration)),
      );
      // Where the long frames spent their time: script, then render work.
      let script = 0;
      let renderMs = 0;
      let styleLayout = 0;
      const offenders = new Map();
      for (const frame of frames) {
        if (frame.renderStart)
          renderMs += frame.startTime + frame.duration - frame.renderStart;
        if (frame.styleAndLayoutStart && frame.renderStart)
          styleLayout +=
            frame.startTime + frame.duration - frame.styleAndLayoutStart;
        for (const entry of frame.scripts ?? []) {
          script += entry.duration;
          const name = `${entry.invoker || entry.sourceFunctionName || 'script'}@${String(
            entry.sourceURL || '',
          )
            .split('/')
            .pop()}:${entry.sourceCharPosition ?? ''}`;
          offenders.set(name, (offenders.get(name) ?? 0) + entry.duration);
        }
      }
      result.loafScriptMs = round(script);
      result.loafRenderMs = round(renderMs);
      result.loafStyleLayoutMs = round(styleLayout);
      result.loafTop = [...offenders.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([name, ms]) => [name.slice(0, 80), round(ms)]);
    }
    return result;
  }

  // ── Test pieces ──

  const style = (css) => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    return () => {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
        (item) => item !== sheet,
      );
    };
  };

  function makeDot() {
    const dot = document.createElement('div');
    dot.style.cssText =
      'position:fixed;left:0;top:0;width:20px;height:20px;border-radius:50%;' +
      'background:#fff;z-index:2147483646;pointer-events:none;will-change:transform';
    document.body.append(dot);
    return dot;
  }

  // One lap of a wide ellipse every two seconds, like a moving cursor.
  const moveDot = (dot) => (elapsed) => {
    const t = (elapsed / 2000) * 2 * Math.PI;
    const x = 512 + 440 * Math.cos(t);
    const y = 300 + 240 * Math.sin(t * 1.3);
    dot.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
  };

  async function measureDot(css, ms = 3500) {
    const undo = css ? style(css) : () => {};
    const dot = makeDot();
    try {
      await sleep(600);
      return await summarise(await sampleFrames(ms, moveDot(dot)));
    } finally {
      dot.remove();
      undo();
    }
  }

  // ── Phases ──

  function info() {
    const memory = performance.memory;
    return {
      ua: navigator.userAgent,
      dpr: window.devicePixelRatio,
      inner: [window.innerWidth, window.innerHeight],
      screen: [screen.width, screen.height],
      cores: navigator.hardwareConcurrency ?? null,
      deviceMemory: navigator.deviceMemory ?? null,
      heapMB: memory ? round(memory.usedJSHeapSize / 1048576) : null,
      heapLimitMB: memory ? round(memory.jsHeapSizeLimit / 1048576) : null,
      support,
      layers: document.querySelectorAll('*').length,
      visibility: document.visibilityState,
    };
  }

  function cpu() {
    const time = (work) => {
      const startedAt = performance.now();
      work();
      return round(performance.now() - startedAt);
    };
    let sink = 0;
    const arithmetic = time(() => {
      let x = 1;
      for (let i = 1; i < 3_000_000; i += 1) x = x * 1.0000001 + Math.sqrt(i);
      sink += x;
    });
    const sample = {
      list: Array.from({ length: 400 }, (_, i) => ({
        id: `item-${i}`,
        values: [i, i * 2, i * 3],
        status: i % 3 ? 'confirmed' : 'pending',
        at: 1795364415000 + i,
      })),
    };
    const json = time(() => {
      for (let i = 0; i < 20; i += 1)
        sink += JSON.parse(JSON.stringify(sample)).list.length;
    });
    const dom = time(() => {
      for (let round = 0; round < 5; round += 1) {
        const box = document.createElement('div');
        box.style.cssText = 'position:absolute;left:-9999px;top:0';
        for (let i = 0; i < 600; i += 1) {
          const item = document.createElement('div');
          item.textContent = `row ${i}`;
          box.append(item);
        }
        document.body.append(box);
        sink += box.offsetHeight;
        box.remove();
      }
    });
    // The dashboard's own work on this Hub: a full draw of the last state (what
    // every changed stream message costs) and parsing a payload of that size.
    let renderMs = null;
    let payloadKB = null;
    let payloadParseMs = null;
    try {
      if (
        typeof render === 'function' &&
        typeof latestPayload === 'object' &&
        latestPayload
      ) {
        const text = JSON.stringify(latestPayload);
        payloadKB = round(text.length / 1024);
        payloadParseMs = time(() => {
          for (let i = 0; i < 20; i += 1) sink += JSON.parse(text).role ? 1 : 0;
        });
        payloadParseMs = round(payloadParseMs / 20, 2);
        renderMs = round(
          time(() => {
            for (let i = 0; i < 5; i += 1) render(latestPayload);
          }) / 5,
          2,
        );
      }
    } catch {
      // The numbers above are still sent.
    }
    return {
      renderMs,
      payloadKB,
      payloadParseMs,
      arithmeticMs: arithmetic,
      jsonMs: json,
      domMs: dom,
      sink: sink > 0,
    };
  }

  // The pager lifts its track to a layer (class `moving`, will-change) only
  // while a drag is on. What does that cost on this Hub? (a) frames right
  // after adding the class from rest, then a simulated sideways swipe with
  // (b) the layer lifted at its start, (c) the layer already there, (d) no
  // layer class at all.
  async function layerTests() {
    const pager = document.getElementById('hub-pager');
    const track = document.getElementById('hub-track');
    if (!pager || !track) return [{ variant: 'layer', skipped: 'no pager' }];
    const out = [];
    const previous = track.style.transform;
    const rest = async (ms = 1300) => {
      pager.classList.remove('moving');
      await sleep(ms);
      drain();
    };
    try {
      const first = [];
      const later = [];
      for (let run = 0; run < 3 && !aborted; run += 1) {
        await rest();
        const gaps = [];
        await new Promise((resolve, reject) => {
          let last;
          let added = false;
          const frame = (time) => {
            try {
              if (!added) {
                last = time;
                added = true;
                pager.classList.add('moving');
              } else {
                gaps.push(time - last);
                last = time;
              }
              if (gaps.length >= 24) resolve();
              else requestAnimationFrame(frame);
            } catch (error) {
              reject(error);
            }
          };
          requestAnimationFrame(frame);
        });
        first.push(round(gaps[0]));
        later.push(round(Math.max(...gaps.slice(1))));
      }
      out.push({
        variant: 'layer-add',
        firstGapMs: first,
        maxLaterGapMs: later,
      });
      const swipe = async (variant, mode) => {
        await rest();
        if (mode === 'perm') {
          pager.classList.add('moving');
          await sleep(1300);
          drain();
        }
        const sample = await sampleFrames(700, (elapsed) => {
          if (mode === 'new' && elapsed < 20) pager.classList.add('moving');
          const x = 300 * Math.sin(Math.PI * Math.min(1, elapsed / 600));
          track.style.transform = `translate3d(${-Math.round(x)}px, 0, 0)`;
        });
        track.style.transform = previous;
        out.push({ variant, ...(await summarise(sample)) });
      };
      for (const [variant, mode] of [
        ['swipe-new', 'new'],
        ['swipe-perm', 'perm'],
        ['swipe-none', 'none'],
      ])
        if (!aborted) await swipe(variant, mode);
    } finally {
      track.style.transform = previous;
      pager.classList.remove('moving');
    }
    return out;
  }

  // A long still window: how often does the Hub stop for 50 ms or more with
  // nothing happening, and where in the window.
  async function soak(ms = 30000) {
    const times = [];
    const startedAt = performance.now();
    const heap = [];
    const sample = await sampleFrames(ms, (elapsed) => {
      if (performance.memory && heap.length < 40 && elapsed > heap.length * 750)
        heap.push(round(performance.memory.usedJSHeapSize / 1048576));
    });
    const sorted = sample.gaps.slice(1);
    sorted.forEach((gap, index) => {
      if (gap > 33.5) times.push([round(gap), index]);
    });
    const result = await summarise(sample);
    result.variant = 'soak';
    result.stalls = times.sort((a, b) => b[0] - a[0]).slice(0, 6);
    result.heapMin = heap.length ? Math.min(...heap) : null;
    result.heapMax = heap.length ? Math.max(...heap) : null;
    result.seconds = round((performance.now() - startedAt) / 1000);
    return result;
  }

  // ── Phases that exercise the dashboard's own paths ──

  // The click path of a scene tile with Lugn's answer faked: the page runs its
  // real handler, pending state, post, state read and redraw, but the POST
  // never leaves the Hub (fetch is replaced for the length of the phase), so
  // no scene is activated.
  async function clickPath(css = '', variant = 'click-real') {
    const tile = visibleSceneTile();
    if (!tile) return { variant, skipped: 'no visible scene tile' };
    let blocked = 0;
    const clicked = new Set();
    const stub = (input, init) => {
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (method === 'POST') {
        blocked += 1;
        return Promise.resolve(
          new Response('{"accepted":true}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return realFetch(input, init);
    };
    window.fetch = stub;
    if (window.fetch !== stub) return { variant, skipped: 'fetch locked' };
    const dot = makeDot();
    const undo = css ? style(css) : () => {};
    try {
      await sleep(css ? 900 : 0);
      const sample = await sampleFrames(6500, (elapsed) => {
        moveDot(dot)(elapsed);
        for (const at of [800, 2600, 4400]) {
          if (elapsed >= at && !clicked.has(at)) {
            clicked.add(at);
            tile.click();
          }
        }
      });
      return {
        variant,
        blockedPosts: blocked,
        ...(await summarise(sample)),
      };
    } finally {
      window.fetch = realFetch;
      undo();
      dot.remove();
    }
  }

  // A change of the artwork theme, as at play/pause or a new track.
  async function themeSwap() {
    if (typeof syncArtTheme !== 'function' || typeof root === 'undefined')
      return [];
    const saved = {
      theme: artTheme,
      color: root.dataset.artColor,
      playing: root.dataset.musicPlaying,
    };
    const palettes = [
      {
        accent: '#7aa6ff',
        deep: '#0b1230',
        panel: '#16204a',
        glow: 'rgba(122,166,255,0.2)',
        glowSoft: 'rgba(122,166,255,0.12)',
        tint: 'rgba(180,200,255,0.08)',
        tint2: 'rgba(180,200,255,0.12)',
      },
      {
        accent: '#ff9a62',
        deep: '#2a1208',
        panel: '#3a1c10',
        glow: 'rgba(255,154,98,0.2)',
        glowSoft: 'rgba(255,154,98,0.12)',
        tint: 'rgba(255,210,180,0.08)',
        tint2: 'rgba(255,210,180,0.12)',
      },
    ];
    const out = [];
    try {
      for (const [index, palette] of palettes.entries()) {
        if (aborted) break;
        await sleep(1700);
        drain();
        artTheme = palette;
        root.dataset.artColor = 'true';
        root.dataset.musicPlaying = 'true';
        const frames = sampleFrames(2000, () => {});
        syncArtTheme();
        out.push({
          variant: `theme-swap-${index + 1}`,
          ...(await summarise(await frames)),
        });
      }
    } finally {
      artTheme = saved.theme;
      if (saved.color === undefined) delete root.dataset.artColor;
      else root.dataset.artColor = saved.color;
      if (saved.playing === undefined) delete root.dataset.musicPlaying;
      else root.dataset.musicPlaying = saved.playing;
      syncArtTheme();
      await sleep(1700);
    }
    return out;
  }

  async function artIn() {
    const art = document.getElementById('music-artwork');
    if (!art || art.offsetParent === null || typeof pulse !== 'function')
      return { variant: 'art-in', skipped: 'no artwork shown' };
    const hadClass = art.classList.contains('art-in');
    const frames = sampleFrames(1600, () => {});
    pulse(art, 'art-in');
    const sample = await frames;
    if (!hadClass) art.classList.remove('art-in');
    return { variant: 'art-in', ...(await summarise(sample)) };
  }

  // The same moving dot with the bridge's hover work every 40 ms, with the
  // dashboard's timers and stream paused, or moved by the compositor alone.
  async function hoverDot(mode) {
    const dot = makeDot();
    const plate = document.createElement('div');
    plate.style.cssText =
      'position:fixed;left:0;top:0;width:10px;height:10px;border-radius:12px;' +
      'background:rgba(255,255,255,.2);pointer-events:none;z-index:2147483645;will-change:opacity';
    document.body.append(plate);
    const controls = [...document.querySelectorAll('button')].filter(
      (button) => button.offsetParent !== null,
    );
    const rects = controls.map((control) => ({
      control,
      box: control.getBoundingClientRect(),
    }));
    let x = 0;
    let y = 0;
    const place = (control, box) => {
      plate.style.left = `${box.left - 6}px`;
      plate.style.top = `${box.top - 6}px`;
      plate.style.width = `${box.width + 12}px`;
      plate.style.height = `${box.height + 12}px`;
      plate.style.borderRadius = control
        ? getComputedStyle(control).borderTopLeftRadius
        : '12px';
    };
    const timer = setInterval(() => {
      if (mode === 'hover-real') {
        const control = document.elementFromPoint(x, y)?.closest('button');
        if (control) place(control, control.getBoundingClientRect());
      } else if (mode === 'hover-cached') {
        const hit = rects.find(
          ({ box }) =>
            x >= box.left && x <= box.right && y >= box.top && y <= box.bottom,
        );
        if (hit) place(null, hit.box);
      }
    }, 40);
    const quiet = mode === 'quiet';
    if (quiet) {
      if (typeof clockTimer !== 'undefined') window.clearInterval(clockTimer);
      if (typeof disconnectStream === 'function') disconnectStream();
    }
    try {
      await sleep(600);
      if (mode === 'compositor') {
        const animation = dot.animate(
          [
            { transform: 'translate3d(100px, 300px, 0)' },
            { transform: 'translate3d(900px, 300px, 0)' },
          ],
          { duration: 1000, iterations: Infinity, direction: 'alternate' },
        );
        const sample = await sampleFrames(3500, () => {});
        animation.cancel();
        return { variant: 'compositor-only', ...(await summarise(sample)) };
      }
      const move = moveDot(dot);
      const sample = await sampleFrames(3500, (elapsed) => {
        move(elapsed);
        const match = /translate3d\((-?\d+)px, (-?\d+)px/.exec(
          dot.style.transform,
        );
        if (match) {
          x = Number(match[1]) + 10;
          y = Number(match[2]) + 10;
        }
      });
      return { variant: mode, ...(await summarise(sample)) };
    } finally {
      clearInterval(timer);
      dot.remove();
      plate.remove();
      if (quiet) {
        if (typeof setClock === 'function' && typeof clockTimer !== 'undefined')
          clockTimer = window.setInterval(setClock, 1000);
        if (typeof connectStream === 'function') connectStream();
      }
    }
  }

  // Which part of a theme change stalls the Hub: the whole palette, only the
  // page background colors, or only the colors the cards and controls use.
  async function themeParts() {
    if (typeof syncArtTheme !== 'function' || typeof root === 'undefined')
      return [];
    // The cover colors live on the music column now, not on the root.
    const css = getComputedStyle(
      document.querySelector('.music-section') ?? root,
    );
    const current = {
      accent: css.getPropertyValue('--art-accent').trim(),
      deep: css.getPropertyValue('--art-deep').trim(),
      panel: css.getPropertyValue('--art-panel').trim(),
      glow: css.getPropertyValue('--art-glow').trim(),
      glowSoft: css.getPropertyValue('--art-glow-soft').trim(),
      tint: css.getPropertyValue('--art-tint').trim(),
      tint2: css.getPropertyValue('--art-tint-2').trim(),
    };
    const other = {
      accent: '#7aa6ff',
      deep: '#0b1230',
      panel: '#16204a',
      glow: 'rgba(122,166,255,0.2)',
      glowSoft: 'rgba(122,166,255,0.12)',
      tint: 'rgba(180,200,255,0.08)',
      tint2: 'rgba(180,200,255,0.12)',
    };
    const variants = [
      ['theme-all', other],
      [
        'theme-bg-only',
        {
          ...current,
          deep: other.deep,
          glow: other.glow,
          glowSoft: other.glowSoft,
        },
      ],
      [
        'theme-colors-only',
        {
          ...current,
          accent: other.accent,
          panel: other.panel,
          tint: other.tint,
          tint2: other.tint2,
        },
      ],
    ];
    const saved = {
      theme: artTheme,
      color: root.dataset.artColor,
      playing: root.dataset.musicPlaying,
    };
    const out = [];
    try {
      for (const [variant, palette, css] of variants) {
        if (aborted) break;
        // Back to where it was and let the fade finish.
        artTheme = saved.theme;
        if (saved.color === undefined) delete root.dataset.artColor;
        else root.dataset.artColor = saved.color;
        if (saved.playing === undefined) delete root.dataset.musicPlaying;
        else root.dataset.musicPlaying = saved.playing;
        syncArtTheme();
        await sleep(2000);
        drain();
        artTheme = palette;
        root.dataset.artColor = 'true';
        root.dataset.musicPlaying = 'true';
        const undo = css ? style(css) : () => {};
        try {
          const frames = sampleFrames(1800, () => {});
          syncArtTheme();
          out.push({ variant, ...(await summarise(await frames)) });
        } finally {
          undo();
        }
      }
    } finally {
      artTheme = saved.theme;
      if (saved.color === undefined) delete root.dataset.artColor;
      else root.dataset.artColor = saved.color;
      if (saved.playing === undefined) delete root.dataset.musicPlaying;
      else root.dataset.musicPlaying = saved.playing;
      syncArtTheme();
      await sleep(2000);
    }
    return out;
  }

  // The worst frame after flipping each attribute on the dashboard root to
  // a value no rule matches and back: what a page-wide restyle costs here.
  async function rootAttrs() {
    if (typeof root === 'undefined') return [];
    const names = Object.keys(root.dataset).filter((name) => name !== 'fade');
    const results = [];
    for (const name of names) {
      if (aborted) break;
      const previous = root.dataset[name];
      await sleep(500);
      drain();
      const gaps = [];
      await new Promise((resolve, reject) => {
        let last;
        let step = 0;
        const frame = (time) => {
          try {
            if (step === 0) {
              last = time;
              root.dataset[name] = '__probe';
            } else {
              gaps.push(time - last);
              last = time;
            }
            step += 1;
            if (step === 5) root.dataset[name] = previous;
            if (step > 12) resolve();
            else requestAnimationFrame(frame);
          } catch (error) {
            reject(error);
          }
        };
        requestAnimationFrame(frame);
      });
      root.dataset[name] = previous;
      results.push([name.slice(0, 24), round(Math.max(...gaps))]);
    }
    const reports = [];
    for (let at = 0; at < results.length; at += 10)
      reports.push({
        variant: 'root-attrs',
        part: at / 10,
        worstGapMs: Object.fromEntries(results.slice(at, at + 10)),
      });
    return reports;
  }

  // Real swipes through the pager's own code (synthetic touch pointer events,
  // like a finger), with Lugn's answers faked so nothing a swipe might touch
  // leaves the Hub. `mode` says what is prepared before the swipe: nothing, the
  // track lifted to a layer, the neighbour page lifted to a layer, or both.
  async function swipeRun(mode, label) {
    const api = globalThis.lugnPages;
    const pager = document.getElementById('hub-pager');
    if (!api || !pager || typeof PointerEvent !== 'function')
      return { variant: label, skipped: 'no pager' };
    // A point that is no control, near the middle of the screen.
    let target;
    let from;
    for (const [x, y] of [
      [520, 330],
      [340, 560],
      [200, 40],
      [700, 80],
      [60, 330],
    ]) {
      const element = document.elementFromPoint(x, y);
      if (element && !element.closest('button, a, input, [role=button]')) {
        target = element;
        from = [x, y];
        break;
      }
    }
    if (!target) return { variant: label, skipped: 'no free spot' };
    const stub = (input, init) =>
      String(init?.method ?? 'GET').toUpperCase() === 'POST'
        ? Promise.resolve(
            new Response('{"accepted":true}', {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          )
        : realFetch(input, init);
    window.fetch = stub;
    if (window.fetch !== stub)
      return { variant: label, skipped: 'fetch locked' };
    const send = (type, x, y, buttons) =>
      target.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 77,
          pointerType: 'touch',
          isPrimary: true,
          clientX: x,
          clientY: y,
          buttons,
          bubbles: true,
          cancelable: true,
        }),
      );
    const neighbours = [
      ...document.querySelectorAll('.hub-page[data-state="near"]'),
    ];
    let down = false;
    let up = false;
    let moved = 0;
    try {
      if (mode === 'track' || mode === 'both') pager.classList.add('moving');
      if (mode === 'near' || mode === 'both')
        for (const page of neighbours) page.style.willChange = 'transform';
      if (mode === 'tap') {
        // A press and release without movement, as at idle after a load:
        // the pager prepares its neighbours for a swipe.
        send('pointerdown', from[0], from[1], 1);
        await sleep(80);
        send('pointerup', from[0], from[1], 0);
      }
      if (mode !== 'asis') await sleep(mode === 'tap' ? 1500 : 1300);
      drain();
      const sample = await sampleFrames(1800, (elapsed) => {
        const t = elapsed - 300;
        if (t >= 0 && !down) {
          down = true;
          send('pointerdown', from[0], from[1], 1);
        }
        if (down && !up) {
          const step = Math.min(10, Math.floor((t - 20) / 16));
          if (step > moved) {
            moved = step;
            send('pointermove', from[0] - step * 45, from[1], 1);
          }
          if (step >= 10) {
            up = true;
            send('pointerup', from[0] - 450, from[1], 0);
          }
        }
      });
      return {
        variant: label,
        page: String(api.current?.()),
        ...(await summarise(sample)),
      };
    } finally {
      window.fetch = realFetch;
      pager.classList.remove('moving');
      for (const page of neighbours) page.style.willChange = '';
      await sleep(1200);
      if (api.current?.() !== 'home') api.go?.('home');
      await sleep(1500);
      drain();
    }
  }

  async function bare() {
    const hidden = [
      ...document.querySelectorAll('#hub-pager, #app-root'),
    ].filter(
      (element, index, all) =>
        !all.some((other) => other !== element && other.contains(element)),
    );
    const previous = hidden.map((element) => element.style.visibility);
    try {
      for (const element of hidden) element.style.visibility = 'hidden';
      return await measureDot('', 3500);
    } finally {
      hidden.forEach((element, index) => {
        element.style.visibility = previous[index];
      });
    }
  }

  // A tile the person could press right now: enabled, shown, on the page in
  // view, and not Släck.
  function visibleSceneTile() {
    return [...document.querySelectorAll('button[data-scene]')].find(
      (button) => {
        if (
          button.disabled ||
          button.hidden ||
          button.dataset.scene === 'scene.all_off'
        )
          return false;
        if (button.closest('[inert], [hidden]')) return false;
        const box = button.getBoundingClientRect();
        return (
          box.width > 0 &&
          box.height > 0 &&
          box.right > 0 &&
          box.left < window.innerWidth &&
          box.bottom > 0 &&
          box.top < window.innerHeight
        );
      },
    );
  }

  async function press({ attr = true, lit = true, css = '' } = {}) {
    const tile = visibleSceneTile();
    if (!tile) return { skipped: 'no visible scene tile' };
    const hadLit = tile.classList.contains('lit');
    const hadPressed = tile.hasAttribute('data-pointer-pressed');
    const dot = makeDot();
    const undo = css ? style(css) : () => {};
    let down = false;
    let up = false;
    try {
      const sample = await sampleFrames(2600, (elapsed) => {
        moveDot(dot)(elapsed);
        // Visual press only: the attribute the bridge sets, and the lit pulse.
        if (elapsed > 500 && !down) {
          down = true;
          if (attr) tile.setAttribute('data-pointer-pressed', '');
        }
        if (elapsed > 700 && down && !up) {
          up = true;
          if (attr) tile.removeAttribute('data-pointer-pressed');
          if (lit && typeof pulse === 'function') pulse(tile, 'lit');
        }
      });
      return await summarise(sample);
    } finally {
      dot.remove();
      undo();
      if (!hadPressed) tile.removeAttribute('data-pointer-pressed');
      if (!hadLit) tile.classList.remove('lit');
    }
  }

  async function runAll() {
    const phases = [
      ['processor', 'cpu', async () => cpu()],
      ['stilla sida', 'idle', async () => summarise(await sampleFrames(4000))],
      ['lång stilla mätning', 'idle', () => soak(15000)],
      ['tom sida', 'bare', bare],
      ['sidlager', 'dot', layerTests],
      ['markör', 'dot', () => measureDot('')],
      [
        'utan filter',
        'dot-nofilter',
        () => measureDot('*, *::before, *::after { filter: none !important; }'),
      ],
      [
        'utan skuggor',
        'dot-noshadow',
        () =>
          measureDot(
            '*, *::before, *::after { box-shadow: none !important; text-shadow: none !important; }',
          ),
      ],
      [
        'utan animationer',
        'dot-noanim',
        () =>
          measureDot(
            '*, *::before, *::after { animation: none !important; transition: none !important; }',
          ),
      ],
      [
        'utan lager',
        'dot-nolayers',
        () =>
          measureDot(
            '*, *::before, *::after { will-change: auto !important; }',
          ),
      ],
      ['kompositor-prick', 'dot', () => hoverDot('compositor')],
      ['hover (som bryggan)', 'dot', () => hoverDot('hover-real')],
      ['hover (cachad)', 'dot', () => hoverDot('hover-cached')],
      ['utan timers och ström', 'dot', () => hoverDot('quiet')],
      ['sidsvep-kall-asis', 'dot', () => swipeRun('asis', 'swipe-cold-asis')],
      [
        'sidsvep-kall-track',
        'dot',
        () => swipeRun('track', 'swipe-cold-track'),
      ],
      ['sidsvep-kall-near', 'dot', () => swipeRun('near', 'swipe-cold-near')],
      ['sidsvep-kall-both', 'dot', () => swipeRun('both', 'swipe-cold-both')],
      ['sidsvep-kall-tap', 'dot', () => swipeRun('tap', 'swipe-cold-tap')],
      [
        'sidsvep-varm',
        'dot',
        async () => [
          await swipeRun('asis', 'swipe-warm-asis'),
          await swipeRun('asis', 'swipe-warm-asis-2'),
          await swipeRun('both', 'swipe-warm-both'),
        ],
      ],
      ['temabyte', 'dot', themeSwap],
      ['temats delar', 'dot', themeParts],
      ['rotattribut', 'dot', rootAttrs],
      ['omslag in', 'dot', artIn],
      ['riktigt klick (låtsassvar)', 'press', () => clickPath()],
      [
        'riktigt klick (utan skimmer)',
        'press',
        () =>
          clickPath(
            '#app-root .scene-button[data-state=pending]::after { animation: none !important; display: none !important; }',
            'click-noshimmer',
          ),
      ],
      [
        'riktigt klick (utan filter)',
        'press',
        () =>
          clickPath(
            '*, *::before, *::after { filter: none !important; }',
            'click-nofilter',
          ),
      ],
      [
        'riktigt klick (utan animationer)',
        'press',
        () =>
          clickPath(
            '*, *::before, *::after { animation: none !important; transition: none !important; }',
            'click-noanim',
          ),
      ],
      ['tryck', 'press', async () => ({ variant: 'both', ...(await press()) })],
      [
        'tryck (bara tryckt läge)',
        'press',
        async () => ({ variant: 'attr', ...(await press({ lit: false })) }),
      ],
      [
        'tryck (bara tänd-puls)',
        'press',
        async () => ({ variant: 'lit', ...(await press({ attr: false })) }),
      ],
      [
        'tryck (utan filter)',
        'press',
        async () => ({
          variant: 'nofilter',
          ...(await press({
            css: '*, *::before, *::after { filter: none !important; }',
          })),
        }),
      ],
      [
        'tryck (utan animationer)',
        'press',
        async () => ({
          variant: 'noanim',
          ...(await press({
            css: '*, *::before, *::after { animation: none !important; transition: none !important; }',
          })),
        }),
      ],
      [
        'tryck (utan skuggor)',
        'press',
        async () => ({
          variant: 'noshadow',
          ...(await press({
            css: '*, *::before, *::after { box-shadow: none !important; }',
          })),
        }),
      ],
    ];
    // #probe:text runs only the phases whose label contains the text.
    const only = decodeURIComponent(location.hash.split(':')[1] ?? '');
    const chosen = only
      ? phases.filter(([text]) => text.includes(only))
      : phases;
    try {
      say('Profil: startar …');
      await sleep(3000);
      await post('info', info());
      for (const [text, name, work] of chosen) {
        if (aborted) break;
        say(`Profil: ${text} …`);
        // Late entries of the work before must not land in this phase.
        await sleep(900);
        drain();
        const result = await work();
        for (const report of Array.isArray(result) ? result : [result])
          await post(name, report);
      }
      await post(
        aborted ? 'error' : 'done',
        aborted
          ? { message: 'page hidden during the run' }
          : { run, undelivered },
      );
      say(
        aborted
          ? 'Profil avbruten'
          : undelivered
            ? 'Profil klar (rapport förlorad)'
            : 'Profil klar',
      );
    } catch (error) {
      await post('error', {
        message: String(error?.message ?? error).slice(0, 200),
      });
      say('Profil misslyckades');
    } finally {
      for (const { observer } of observers) observer.disconnect();
      await sleep(2500);
      label?.remove();
    }
  }

  window.HubProbe = { run: runAll };
  runAll().catch((error) =>
    post('error', { message: String(error?.message ?? error) }),
  );
})();
