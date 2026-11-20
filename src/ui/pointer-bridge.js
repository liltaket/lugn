// Hub pointer bridge: a desktop agent drives a virtual cursor on this page.
// Wire protocol: agents/linux/hub-pointer/PROTOCOL.md. Lugn hands this page
// the agent URL and token only when the bridge is configured for this Hub;
// otherwise the script does nothing at all.
//
// The Hub's main thread is slow and the dashboard is heavy, so the cursor is
// built once when the bridge is configured and only ever has its transform
// and visibility changed. Each animation frame writes one transform; hover
// hit testing runs from a timer, never inside the frame.
(() => {
  'use strict';

  const CONFIG_URL = `${location.pathname.replace(/\/?$/, '/')}display-api/pointer-bridge`;
  const PROTOCOL_VERSION = 2;
  const POINTER_ID = 4242;
  const RECONNECT_MIN_MS = 500;
  const RECONNECT_MAX_MS = 5000;
  const CONFIG_RETRY_MIN_MS = 5000;
  const CONFIG_RETRY_MAX_MS = 60000;
  // Hover hit tests: at most this often while moving...
  const HOVER_INTERVAL_MS = 60;
  // ...and once this long after the last move.
  const HOVER_SETTLE_MS = 50;
  // Frames keep running this long after the last move, so frame gaps are
  // measured across a whole gesture rather than per move.
  const MOTION_TAIL_MS = 100;
  // Longest heartbeat after `warm`, in case `enter` never comes.
  const WARM_MAX_MS = 3000;
  const PERF_INTERVAL_MS = 2000;
  const LAG_SAMPLES = 256;
  // Pixel offset of the arrow tip inside the cursor graphic.
  const HOTSPOT = 2;
  const CURSOR_WIDTH = 24;
  const CURSOR_HEIGHT = 28;
  const PARKED = 'translate3d(-100px, -100px, 0)';
  const ARROW =
    'M0 0 L0 19.5 L4.7 15.1 L7.9 22.4 L11.3 20.9 L8.2 13.8 L14.6 13.8 Z';
  const INTERACTIVE =
    'button, a, [role="button"], input, label, select, textarea, summary, [tabindex]';
  const FOCUSABLE_FIELDS = 'input, select, textarea';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const clock =
    typeof performance === 'object' &&
    performance &&
    typeof performance.now === 'function'
      ? () => performance.now()
      : () => Date.now();

  let bridge;
  let socket;
  let reconnectDelay = RECONNECT_MIN_MS;
  let reconnectTimer;
  let cursor;
  let visible = false;
  let pixelRatio = 1;
  // Latest point from the agent.
  let x = 0;
  let y = 0;
  // Point the cursor transform was last written for.
  let drawnX = NaN;
  let drawnY = NaN;
  let framePending = false;
  let lastFrameAt = 0;
  let motionUntil = 0;
  let warmUntil = 0;
  let lastMotionAt = -Infinity;
  let hoverTimer;
  let lastHoverAt = -Infinity;
  let hoverX = NaN;
  let hoverY = NaN;
  let hovered = null;
  let hitX = NaN;
  let hitY = NaN;
  let hitTarget = null;
  let pressTarget = null;
  let pressControl = null;
  let pressMoveX = NaN;
  let pressMoveY = NaN;

  // Telemetry for the window since the cursor was shown or the last `perf`.
  const lags = new Float64Array(LAG_SAMPLES);
  const sortedLags = new Float64Array(LAG_SAMPLES);
  let lagCount = 0;
  let lagNext = 0;
  let lagMax = 0;
  let gapMax = 0;
  let frames = 0;
  let moves = 0;
  let longTasks = 0;
  let longTaskMs = 0;
  let spanStart = 0;
  let measuring = false;
  let perfTimer;
  let moveStamp = 0;

  function debug(...args) {
    try {
      console.debug('[pointer-bridge]', ...args);
    } catch {
      // Logging must never affect the page.
    }
  }

  function guard(fn) {
    return (...args) => {
      try {
        return fn(...args);
      } catch (error) {
        debug('ignored error', error);
        return undefined;
      }
    };
  }

  // ── Cursor ──

  function arrowPath(attributes) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', ARROW);
    path.setAttribute('stroke-linejoin', 'round');
    for (const [name, value] of Object.entries(attributes))
      path.setAttribute(name, value);
    return path;
  }

  // Built once, before any `enter`, and kept in the DOM for good: showing it
  // is a visibility flip on a layer that already exists. A second, offset
  // path is the shadow; a CSS filter on a moving layer can make weak GPUs
  // re-rasterize it every frame.
  function createCursor() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', String(CURSOR_WIDTH));
    svg.setAttribute('height', String(CURSOR_HEIGHT));
    svg.setAttribute(
      'viewBox',
      `${-HOTSPOT} ${-HOTSPOT} ${CURSOR_WIDTH} ${CURSOR_HEIGHT}`,
    );
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.appendChild(
      arrowPath({
        transform: 'translate(0.6 1.1)',
        fill: '#000000',
        stroke: '#000000',
        'stroke-width': '2',
        opacity: '0.3',
      }),
    );
    svg.appendChild(
      arrowPath({
        fill: '#ffffff',
        stroke: '#161c1b',
        'stroke-width': '1.4',
      }),
    );
    const style = svg.style;
    style.position = 'fixed';
    style.left = '0';
    style.top = '0';
    style.width = `${CURSOR_WIDTH}px`;
    style.height = `${CURSOR_HEIGHT}px`;
    style.margin = '0';
    style.padding = '0';
    style.display = 'block';
    style.overflow = 'hidden';
    style.pointerEvents = 'none';
    style.zIndex = '2147483647';
    style.contain = 'strict';
    style.willChange = 'transform';
    style.transition = 'none';
    style.transform = PARKED;
    style.visibility = 'hidden';
    document.body.appendChild(svg);
    return svg;
  }

  function showCursor() {
    if (!visible) {
      visible = true;
      warmUntil = 0;
      cursor.style.visibility = 'visible';
      startMeasuring();
    }
    noteMotion(clock());
  }

  function hideCursor() {
    if (visible) {
      visible = false;
      cursor.style.visibility = 'hidden';
      cursor.style.transform = PARKED;
      drawnX = NaN;
      drawnY = NaN;
    }
    if (hoverTimer !== undefined) clearTimeout(hoverTimer);
    hoverTimer = undefined;
    lastHoverAt = -Infinity;
    hoverX = NaN;
    hoverY = NaN;
    hitTarget = null;
    setHover(null);
  }

  function requestFrame() {
    if (framePending) return;
    framePending = true;
    requestAnimationFrame(onFrame);
  }

  // The hot path: at most one pointermove for a held button (hit test first,
  // while layout is still clean) and one transform write. No other reads.
  function frame() {
    framePending = false;
    const now = clock();
    if (visible) {
      if (lastFrameAt) {
        const gap = now - lastFrameAt;
        if (gap > gapMax) gapMax = gap;
      }
      if (pressTarget && (x !== pressMoveX || y !== pressMoveY)) {
        pressMoveX = x;
        pressMoveY = y;
        const target = hitAt(true);
        if (target)
          dispatchPointer('pointermove', target, { button: -1, buttons: 1 });
      }
      if (x !== drawnX || y !== drawnY) {
        drawnX = x;
        drawnY = y;
        cursor.style.transform = `translate3d(${snap(x - HOTSPOT)}px, ${snap(y - HOTSPOT)}px, 0)`;
        frames += 1;
        if (moveStamp) {
          recordLag(now - moveStamp);
          moveStamp = 0;
        }
      }
    }
    if (now < motionUntil || now < warmUntil) {
      lastFrameAt = now;
      requestFrame();
    } else {
      lastFrameAt = 0;
    }
  }
  const onFrame = guard(frame);

  function snap(value) {
    return Math.round(value * pixelRatio) / pixelRatio;
  }

  // ── Hit testing ──

  // Element under the cursor. `cached` reuses the last result for the same
  // point while that element is still in the document.
  function hitAt(cached) {
    if (cached && x === hitX && y === hitY && connected(hitTarget))
      return hitTarget;
    const element = document.elementFromPoint(x, y);
    hitX = x;
    hitY = y;
    hitTarget = !element || element.closest?.('[inert]') ? null : element;
    return hitTarget;
  }

  function controlFor(element) {
    return element?.closest?.(INTERACTIVE) ?? null;
  }

  function setHover(control) {
    if (control === hovered) return;
    hovered?.removeAttribute?.('data-pointer-hover');
    hovered = control;
    hovered?.setAttribute?.('data-pointer-hover', '');
  }

  function refreshHover(now) {
    lastHoverAt = now;
    hoverX = x;
    hoverY = y;
    setHover(controlFor(hitAt(false)));
  }

  // Hover follows the cursor from a timer: at most every HOVER_INTERVAL_MS
  // while moving, and once more after the motion settles.
  function noteMotion(now) {
    lastMotionAt = now;
    if (now + MOTION_TAIL_MS > motionUntil) motionUntil = now + MOTION_TAIL_MS;
    requestFrame();
    if (hoverTimer === undefined)
      armHover(
        Math.max(lastHoverAt + HOVER_INTERVAL_MS - now, HOVER_SETTLE_MS),
      );
  }

  function armHover(delay) {
    hoverTimer = setTimeout(onHoverTimer, delay);
  }

  function hoverTick() {
    hoverTimer = undefined;
    if (!visible) return;
    const now = clock();
    if (x !== hoverX || y !== hoverY) refreshHover(now);
    const sinceMotion = now - lastMotionAt;
    if (sinceMotion < HOVER_SETTLE_MS)
      armHover(
        Math.max(
          lastHoverAt + HOVER_INTERVAL_MS - now,
          HOVER_SETTLE_MS - sinceMotion,
        ),
      );
  }
  const onHoverTimer = guard(hoverTick);

  function connected(element) {
    if (!element) return false;
    if (typeof element.isConnected === 'boolean') return element.isConnected;
    return document.documentElement?.contains?.(element) ?? false;
  }

  // ── Synthetic input ──

  function mouseInit(button, buttons) {
    return {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      button,
      buttons,
    };
  }

  function dispatchPointer(type, target, { button, buttons }) {
    const init = {
      ...mouseInit(button, buttons),
      pointerId: POINTER_ID,
      pointerType: 'mouse',
      isPrimary: true,
      width: 1,
      height: 1,
      pressure: buttons ? 0.5 : 0,
    };
    let event;
    if (typeof PointerEvent === 'function') {
      event = new PointerEvent(type, init);
    } else {
      // Older engines: a MouseEvent carrying pointerId keeps down/up paired.
      event = new MouseEvent(type, init);
      try {
        Object.defineProperty(event, 'pointerId', { value: POINTER_ID });
      } catch {
        // pointerId stays undefined on both down and up, still paired.
      }
    }
    return target.dispatchEvent(event);
  }

  function dispatchMouse(type, target, button, buttons) {
    return target.dispatchEvent(
      new MouseEvent(type, mouseInit(button, buttons)),
    );
  }

  function press() {
    if (pressTarget) return;
    // Always a fresh hit test, and hover catches up before the press shows.
    refreshHover(clock());
    const target = hitTarget;
    if (!target) return;
    const control = controlFor(target);
    pressTarget = target;
    pressControl = control;
    pressMoveX = x;
    pressMoveY = y;
    if (control && !control.disabled)
      control.setAttribute?.('data-pointer-pressed', '');
    dispatchPointer('pointerdown', target, { button: 0, buttons: 1 });
    dispatchMouse('mousedown', target, 0, 1);
    // Focus only text-like fields: programmatic focus on buttons would show
    // the keyboard focus ring and change how the dashboard looks.
    const field = target.closest?.(FOCUSABLE_FIELDS);
    if (field && !field.disabled) field.focus?.({ preventScroll: true });
  }

  function release() {
    if (!pressTarget) return;
    const control = pressControl;
    clearPress();
    const target = hitAt(false) ?? document.body;
    dispatchPointer('pointerup', target, { button: 0, buttons: 0 });
    dispatchMouse('mouseup', target, 0, 0);
    if (controlFor(target) === control && !control?.disabled)
      dispatchMouse('click', target, 0, 0);
  }

  // Ends a press without a click, so display.js never keeps a pointer held.
  function cancelPress() {
    if (!pressTarget) return;
    const target = connected(pressTarget) ? pressTarget : document.body;
    clearPress();
    try {
      dispatchPointer('pointercancel', target, { button: 0, buttons: 0 });
    } catch (error) {
      debug('pointercancel failed', error);
    }
  }

  function clearPress() {
    pressControl?.removeAttribute?.('data-pointer-pressed');
    pressTarget = null;
    pressControl = null;
  }

  function escape() {
    const target = document.activeElement || document.body;
    target.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        bubbles: true,
        cancelable: true,
        composed: true,
      }),
    );
  }

  function scrollableAncestor(element, axis) {
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      const overflow = axis === 'y' ? style.overflowY : style.overflowX;
      const scrollable =
        axis === 'y'
          ? node.scrollHeight > node.clientHeight
          : node.scrollWidth > node.clientWidth;
      if ((overflow === 'auto' || overflow === 'scroll') && scrollable)
        return node;
    }
    return null;
  }

  function wheel(dx, dy) {
    const target = hitAt(true);
    if (!target) return;
    let proceed = true;
    if (typeof WheelEvent === 'function')
      proceed = target.dispatchEvent(
        new WheelEvent('wheel', {
          ...mouseInit(0, pressTarget ? 1 : 0),
          deltaX: dx,
          deltaY: dy,
          deltaMode: 0,
        }),
      );
    if (!proceed) return;
    if (dy) {
      const node = scrollableAncestor(target, 'y');
      if (node) node.scrollTop += dy;
    }
    if (dx) {
      const node = scrollableAncestor(target, 'x');
      if (node) node.scrollLeft += dx;
    }
  }

  // ── Warm-up ──

  // The desktop pointer is close: wake the frame loop (no DOM writes) and
  // run one hit test without touching hover, so the first real frames and
  // hit tests after `enter` are not the first ones in a while.
  function warm(on) {
    if (!on) {
      warmUntil = 0;
      return;
    }
    if (visible) return;
    warmUntil = clock() + WARM_MAX_MS;
    requestFrame();
    hitAt(false);
    hitTarget = null;
  }

  // ── Telemetry ──

  function startMeasuring() {
    if (!measuring) resetStats();
    measuring = true;
    if (perfTimer === undefined) armPerf();
  }

  function armPerf() {
    perfTimer = setTimeout(onPerfTimer, PERF_INTERVAL_MS);
  }

  function perfTick() {
    perfTimer = undefined;
    if (!visible) return;
    sendPerf();
    armPerf();
  }
  const onPerfTimer = guard(perfTick);

  function stopMeasuring() {
    if (perfTimer !== undefined) clearTimeout(perfTimer);
    perfTimer = undefined;
    if (measuring) sendPerf();
    measuring = false;
  }

  function resetStats() {
    lagCount = 0;
    lagNext = 0;
    lagMax = 0;
    gapMax = 0;
    frames = 0;
    moves = 0;
    longTasks = 0;
    longTaskMs = 0;
    spanStart = clock();
  }

  function recordLag(lag) {
    const value = lag > 0 ? lag : 0;
    lags[lagNext] = value;
    lagNext = (lagNext + 1) % LAG_SAMPLES;
    if (lagCount < LAG_SAMPLES) lagCount += 1;
    if (value > lagMax) lagMax = value;
  }

  function percentile(sorted, count, fraction) {
    if (!count) return 0;
    return sorted[Math.min(count - 1, Math.ceil(fraction * count) - 1)];
  }

  function ms(value) {
    return Math.round(value * 10) / 10;
  }

  function sendPerf() {
    const sorted = sortedLags.subarray(0, lagCount);
    sorted.set(lags.subarray(0, lagCount));
    sorted.sort();
    send({
      t: 'perf',
      frames,
      moves,
      lagP50: ms(percentile(sorted, lagCount, 0.5)),
      lagP95: ms(percentile(sorted, lagCount, 0.95)),
      lagMax: ms(lagMax),
      gapMax: ms(gapMax),
      longTasks,
      longTaskMs: Math.round(longTaskMs),
      span: Math.round(clock() - spanStart),
    });
    resetStats();
  }

  function observeLongTasks() {
    try {
      if (typeof PerformanceObserver !== 'function') return;
      new PerformanceObserver(
        guard((list) => {
          if (!measuring) return;
          for (const entry of list.getEntries()) {
            if (entry.startTime + entry.duration < spanStart) continue;
            longTasks += 1;
            longTaskMs += entry.duration;
          }
        }),
      ).observe({ entryTypes: ['longtask'] });
    } catch (error) {
      debug('no long task timing', error);
    }
  }

  // ── Protocol ──

  function setPoint(message) {
    if (Number.isFinite(message.x) && Number.isFinite(message.y)) {
      x = message.x;
      y = message.y;
      return true;
    }
    return false;
  }

  function send(message) {
    if (socket && socket.readyState === 1) socket.send(JSON.stringify(message));
  }

  function hello() {
    pixelRatio = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    send({
      t: 'hello',
      v: PROTOCOL_VERSION,
      w: window.innerWidth,
      h: window.innerHeight,
    });
  }

  function handleMessage(data) {
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;
    switch (message.t) {
      case 'ping':
        send({ t: 'pong', id: message.id });
        return;
      case 'move':
        if (!setPoint(message)) return;
        moveStamp = clock();
        if (!visible) showCursor();
        else noteMotion(moveStamp);
        moves += 1;
        return;
      case 'enter':
        setPoint(message);
        showCursor();
        return;
      case 'button':
        if (setPoint(message)) {
          if (!visible) showCursor();
          else noteMotion(clock());
        }
        if (message.button === 'left') {
          if (message.down) press();
          else release();
        } else if (message.button === 'right' && message.down) {
          escape();
        }
        return;
      case 'wheel':
        if (setPoint(message) && visible) noteMotion(clock());
        if (Number.isFinite(message.dx) && Number.isFinite(message.dy))
          wheel(message.dx, message.dy);
        return;
      case 'leave':
        endCapture();
        return;
      case 'warm':
        warm(message.on === true);
        return;
      default:
    }
  }

  function endCapture() {
    cancelPress();
    hideCursor();
    warmUntil = 0;
    moveStamp = 0;
    stopMeasuring();
  }

  function connect() {
    reconnectTimer = undefined;
    let ws;
    try {
      ws = new WebSocket(
        `${bridge.url}?token=${encodeURIComponent(bridge.token)}`,
      );
    } catch (error) {
      debug('connect failed', error);
      scheduleReconnect();
      return;
    }
    socket = ws;
    ws.onopen = guard(() => {
      if (socket !== ws) return;
      reconnectDelay = RECONNECT_MIN_MS;
      hello();
    });
    ws.onmessage = guard((event) => {
      if (socket === ws) handleMessage(event.data);
    });
    ws.onerror = () => {
      debug('socket error');
    };
    ws.onclose = guard(() => {
      if (socket !== ws) return;
      socket = undefined;
      endCapture();
      scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    if (reconnectTimer !== undefined) return;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    reconnectTimer = setTimeout(guard(connect), delay);
  }

  async function loadConfig(retryDelay) {
    let response;
    try {
      response = await fetch(CONFIG_URL, {
        cache: 'no-store',
        credentials: 'same-origin',
      });
    } catch (error) {
      debug('config unavailable', error);
      retryConfig(retryDelay);
      return;
    }
    if (response.status >= 500) {
      retryConfig(retryDelay);
      return;
    }
    // 404: no bridge for this Hub. Nothing else runs, ever.
    if (!response.ok) return;
    const body = await response.json();
    if (
      !body ||
      typeof body.url !== 'string' ||
      typeof body.token !== 'string' ||
      !/^wss?:\/\//.test(body.url)
    )
      return;
    bridge = { url: body.url, token: body.token };
    cursor = createCursor();
    observeLongTasks();
    window.addEventListener('resize', guard(hello));
    connect();
  }

  function retryConfig(delay) {
    setTimeout(() => {
      loadConfig(Math.min(delay * 2, CONFIG_RETRY_MAX_MS)).catch(debug);
    }, delay);
  }

  loadConfig(CONFIG_RETRY_MIN_MS).catch((error) => debug('disabled', error));
})();
