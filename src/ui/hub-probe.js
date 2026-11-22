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
  async function post(phase, data) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 5000);
    try {
      const response = await fetch(PROBE_URL, {
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
    return {
      arithmeticMs: arithmetic,
      jsonMs: json,
      domMs: dom,
      sink: sink > 0,
    };
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

  async function press() {
    const tile = visibleSceneTile();
    if (!tile) return { skipped: 'no visible scene tile' };
    const hadLit = tile.classList.contains('lit');
    const hadPressed = tile.hasAttribute('data-pointer-pressed');
    const dot = makeDot();
    let down = false;
    let up = false;
    try {
      const sample = await sampleFrames(2600, (elapsed) => {
        moveDot(dot)(elapsed);
        // Visual press only: the attribute the bridge sets, and the lit pulse.
        if (elapsed > 500 && !down) {
          down = true;
          tile.setAttribute('data-pointer-pressed', '');
        }
        if (elapsed > 700 && down && !up) {
          up = true;
          tile.removeAttribute('data-pointer-pressed');
          if (typeof pulse === 'function') pulse(tile, 'lit');
        }
      });
      return await summarise(sample);
    } finally {
      dot.remove();
      if (!hadPressed) tile.removeAttribute('data-pointer-pressed');
      if (!hadLit) tile.classList.remove('lit');
    }
  }

  async function runAll() {
    const phases = [
      ['processor', 'cpu', async () => cpu()],
      ['stilla sida', 'idle', async () => summarise(await sampleFrames(4000))],
      ['tom sida', 'bare', bare],
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
      ['tryck', 'press', press],
    ];
    try {
      say('Profil: startar …');
      await sleep(3000);
      await post('info', info());
      for (const [text, name, work] of phases) {
        if (aborted) break;
        say(`Profil: ${text} …`);
        // Late entries of the work before must not land in this phase.
        await sleep(900);
        drain();
        await post(name, await work());
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
