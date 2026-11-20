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
  // After a click, Escape or wheel the page may change under a still cursor:
  // hover and the plate are measured again this long after.
  const HOVER_RECHECK_MS = 300;
  // Frames keep running this long after the last move, so frame gaps are
  // measured across a whole gesture rather than per move.
  const MOTION_TAIL_MS = 100;
  // Longest heartbeat after `warm`, in case `enter` never comes.
  const WARM_MAX_MS = 3000;
  const PERF_INTERVAL_MS = 2000;
  const LAG_SAMPLES = 256;
  // The dot: a soft disc centred on the hotspot, drawn inside a slightly
  // larger box so its shadow is not clipped by paint containment.
  const DOT_SIZE = 18;
  const DOT_BOX = 28;
  const PARKED = 'translate3d(-100px, -100px, 0)';
  // The highlight plate that replaces the dot over a control.
  const PLATE_PADDING = 6;
  const PLATE_MIN_RADIUS = 12;
  // Controls bigger than this keep the dot and get no plate.
  const PLATE_MAX_WIDTH = 420;
  const PLATE_MAX_HEIGHT = 260;
  // The plate leans toward the pointer by this share of its offset from the
  // control's centre, at most PLATE_SHIFT_MAX px each way.
  const PLATE_PARALLAX = 0.06;
  const PLATE_SHIFT_MAX = 3;
  // A plate that faded out less than this long ago slides to the next
  // control instead of popping up there.
  const PLATE_MORPH_MS = 180;
  const EASE_MS = 160;
  const EASE = 'cubic-bezier(0.25, 1, 0.5, 1)';
  const LOOK = {
    dot: { transform: 'scale(1)', opacity: '1' },
    dotPressed: { transform: 'scale(0.85)', opacity: '1' },
    dotOnPlate: { transform: 'scale(0.4)', opacity: '0' },
    plateHidden: { transform: 'scale(0.96)', opacity: '0' },
    plate: { transform: 'scale(1)', opacity: '1' },
    platePressed: { transform: 'scale(0.97)', opacity: '0.7' },
  };
  const INTERACTIVE =
    'button, a, [role="button"], input, label, select, textarea, summary, [tabindex]';
  const FOCUSABLE_FIELDS = 'input, select, textarea';

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
  let dotFill;
  let plate;
  let plateFill;
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
  let recheckTimer;
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
  // Plate geometry in viewport px, set when the hovered control changes.
  let plateShown = false;
  let plateHiddenAt = -Infinity;
  let plateRect = null;
  let plateCenterX = 0;
  let plateCenterY = 0;
  let plateDrawnX = NaN;
  let plateDrawnY = NaN;
  let dotLook = null;
  let plateLook = null;

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

  function fixedLayer(role, width, height) {
    const element = document.createElement('div');
    element.setAttribute('data-hub-pointer', role);
    element.setAttribute('aria-hidden', 'true');
    const style = element.style;
    style.position = 'fixed';
    style.left = '0';
    style.top = '0';
    style.width = `${width}px`;
    style.height = `${height}px`;
    style.margin = '0';
    style.padding = '0';
    style.display = 'block';
    style.pointerEvents = 'none';
    style.willChange = 'transform';
    style.transition = 'none';
    style.visibility = 'hidden';
    return element;
  }

  // Inner layers change scale and opacity only when the look changes (hover
  // or press), never per frame, so they alone carry a transition.
  function easedLayer(look) {
    const element = document.createElement('div');
    const style = element.style;
    style.position = 'absolute';
    style.boxSizing = 'border-box';
    style.margin = '0';
    style.padding = '0';
    style.pointerEvents = 'none';
    style.willChange = 'transform, opacity';
    style.transition = `transform ${EASE_MS}ms ${EASE}, opacity ${EASE_MS}ms ${EASE}`;
    style.transform = look.transform;
    style.opacity = look.opacity;
    return element;
  }

  // Built once, before any `enter`, and kept in the DOM for good: showing it
  // is a visibility flip on layers that already exist. No CSS filter or
  // backdrop: the shadow and fill rasterize once and the layers only move.
  function createCursor() {
    plate = fixedLayer('plate', 0, 0);
    plate.style.zIndex = '2147483646';
    plate.style.contain = 'layout size style';
    plate.style.transform = 'translate3d(0px, 0px, 0)';
    plateFill = easedLayer(LOOK.plateHidden);
    plateFill.style.left = '0';
    plateFill.style.top = '0';
    plateFill.style.right = '0';
    plateFill.style.bottom = '0';
    plateFill.style.background = 'rgba(255, 255, 255, 0.14)';
    plateFill.style.boxShadow = 'inset 0 0 0 1px rgba(255, 255, 255, 0.06)';
    plate.appendChild(plateFill);
    plateLook = LOOK.plateHidden;

    const dot = fixedLayer('dot', DOT_BOX, DOT_BOX);
    dot.style.zIndex = '2147483647';
    dot.style.contain = 'strict';
    dot.style.overflow = 'hidden';
    dot.style.transform = PARKED;
    dotFill = easedLayer(LOOK.dot);
    const inset = `${(DOT_BOX - DOT_SIZE) / 2}px`;
    dotFill.style.left = inset;
    dotFill.style.top = inset;
    dotFill.style.width = `${DOT_SIZE}px`;
    dotFill.style.height = `${DOT_SIZE}px`;
    dotFill.style.borderRadius = '50%';
    dotFill.style.background = 'rgba(236, 240, 232, 0.55)';
    dotFill.style.border = '1px solid rgba(12, 18, 16, 0.32)';
    dotFill.style.boxShadow = '0 1px 4px rgba(0, 0, 0, 0.24)';
    dot.appendChild(dotFill);
    dotLook = LOOK.dot;

    document.body.appendChild(plate);
    document.body.appendChild(dot);
    return dot;
  }

  function setLook(element, current, look) {
    if (current === look) return look;
    if (current.transform !== look.transform)
      element.style.transform = look.transform;
    if (current.opacity !== look.opacity) element.style.opacity = look.opacity;
    return look;
  }

  // Dot and plate looks follow hover and press; called off the hot path.
  function updateLook() {
    const pressed = pressTarget !== null;
    dotLook = setLook(
      dotFill,
      dotLook,
      plateShown ? LOOK.dotOnPlate : pressed ? LOOK.dotPressed : LOOK.dot,
    );
    plateLook = setLook(
      plateFill,
      plateLook,
      !plateShown ? LOOK.plateHidden : pressed ? LOOK.platePressed : LOOK.plate,
    );
  }

  function showCursor() {
    if (!visible) {
      visible = true;
      warmUntil = 0;
      cursor.style.visibility = 'visible';
      plate.style.visibility = 'visible';
      startMeasuring();
    }
    noteMotion(clock());
  }

  function hideCursor() {
    if (visible) {
      visible = false;
      cursor.style.visibility = 'hidden';
      cursor.style.transform = PARKED;
      plate.style.visibility = 'hidden';
      drawnX = NaN;
      drawnY = NaN;
    }
    if (hoverTimer !== undefined) clearTimeout(hoverTimer);
    hoverTimer = undefined;
    if (recheckTimer !== undefined) clearTimeout(recheckTimer);
    recheckTimer = undefined;
    lastHoverAt = -Infinity;
    hoverX = NaN;
    hoverY = NaN;
    hitTarget = null;
    setHover(null);
    plateHiddenAt = -Infinity;
  }

  // ── Highlight plate ──

  // #app-root is scaled with CSS zoom; the plate lives outside it in viewport
  // px. Newer engines report zoomed descendants' rects in viewport px, older
  // ones in the root's own px: the root's own width tells which.
  function rectScale(zoom) {
    if (zoom === 1) return 1;
    const width = document
      .getElementById?.('app-root')
      ?.getBoundingClientRect?.().width;
    if (!(width > 0)) return 1;
    const viewport = window.innerWidth;
    if (Math.abs(width - viewport) <= 2) return 1;
    if (Math.abs(width * zoom - viewport) <= 2) return zoom;
    return 1;
  }

  function rootZoom() {
    const zoom = Number.parseFloat(
      document.getElementById?.('app-root')?.style?.zoom,
    );
    return zoom > 0 ? zoom : 1;
  }

  function disabled(control) {
    return (
      control.disabled === true ||
      control.getAttribute?.('aria-disabled') === 'true'
    );
  }

  // Sizes the plate to the newly hovered control. Runs only when hover moves
  // to another control, from the hover timer, after the hit test has already
  // brought layout up to date.
  function placePlate(control, morph = true) {
    if (!control || disabled(control) || !control.getBoundingClientRect) {
      hidePlate();
      return;
    }
    const zoom = rootZoom();
    const scale = rectScale(zoom);
    const box = control.getBoundingClientRect();
    const width = box.width * scale + 2 * PLATE_PADDING;
    const height = box.height * scale + 2 * PLATE_PADDING;
    if (
      !(box.width > 0 && box.height > 0) ||
      width > PLATE_MAX_WIDTH + 2 * PLATE_PADDING ||
      height > PLATE_MAX_HEIGHT + 2 * PLATE_PADDING
    ) {
      hidePlate();
      return;
    }
    const left = box.left * scale - PLATE_PADDING;
    const top = box.top * scale - PLATE_PADDING;
    const corner = String(getComputedStyle(control).borderTopLeftRadius ?? '');
    const pill = Math.min(width, height) / 2;
    const radius = corner.endsWith('%')
      ? pill
      : Math.min(
          pill,
          Math.max(
            PLATE_MIN_RADIUS,
            (Number.parseFloat(corner) || 0) * zoom + PLATE_PADDING,
          ),
        );
    const previous = !morph
      ? null
      : plateShown || clock() - plateHiddenAt < PLATE_MORPH_MS
        ? plateRect
        : null;
    plateRect = { left, top, width, height };
    plateCenterX = left + width / 2;
    plateCenterY = top + height / 2;
    const style = plate.style;
    style.left = `${left}px`;
    style.top = `${top}px`;
    style.width = `${width}px`;
    style.height = `${height}px`;
    plateFill.style.borderRadius = `${radius}px`;
    drawPlate();
    if (previous) morphPlate(previous, plateRect);
    plateShown = true;
    updateLook();
  }

  // Slides the plate from the control it just left, on the compositor.
  function morphPlate(from, to) {
    if (typeof plateFill.animate !== 'function') return;
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    plateFill.animate(
      [
        {
          transform: `translate(${dx}px, ${dy}px) scale(${from.width / to.width}, ${from.height / to.height})`,
        },
        { transform: 'scale(1)' },
      ],
      { duration: EASE_MS, easing: EASE },
    );
  }

  function hidePlate() {
    if (!plateShown) return;
    plateShown = false;
    plateHiddenAt = clock();
    updateLook();
  }

  function plateShift(offset) {
    const shift = offset * PLATE_PARALLAX;
    return Math.max(-PLATE_SHIFT_MAX, Math.min(PLATE_SHIFT_MAX, shift));
  }

  // The plate leans a few px toward the pointer: one transform write.
  function drawPlate() {
    const px = snap(plateShift(x - plateCenterX));
    const py = snap(plateShift(y - plateCenterY));
    if (px === plateDrawnX && py === plateDrawnY) return;
    plateDrawnX = px;
    plateDrawnY = py;
    plate.style.transform = `translate3d(${px}px, ${py}px, 0)`;
  }

  function requestFrame() {
    if (framePending) return;
    framePending = true;
    requestAnimationFrame(onFrame);
  }

  // The hot path: at most one pointermove for a held button (hit test first,
  // while layout is still clean) and a transform write on the dot, plus one
  // on the plate while it is shown. No other reads or writes.
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
        cursor.style.transform = `translate3d(${snap(x - DOT_BOX / 2)}px, ${snap(y - DOT_BOX / 2)}px, 0)`;
        if (plateShown) drawPlate();
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
    // Measure first, while layout is still clean from the hit test.
    placePlate(control);
    hovered?.removeAttribute?.('data-pointer-hover');
    hovered = control;
    hovered?.setAttribute?.('data-pointer-hover', '');
  }

  // `remeasure` sizes the plate again even when the control is unchanged.
  function refreshHover(now, remeasure = false) {
    lastHoverAt = now;
    hoverX = x;
    hoverY = y;
    const control = controlFor(hitAt(false));
    if (control === hovered && remeasure) placePlate(control, false);
    else setHover(control);
  }

  // The page may have moved or replaced what is under the cursor.
  function recheckHover() {
    if (!visible) return;
    if (recheckTimer !== undefined) clearTimeout(recheckTimer);
    recheckTimer = setTimeout(onRecheckTimer, HOVER_RECHECK_MS);
  }

  function recheckTick() {
    recheckTimer = undefined;
    if (!visible) return;
    refreshHover(clock(), true);
  }
  const onRecheckTimer = guard(recheckTick);

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
    updateLook();
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
    recheckHover();
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
    updateLook();
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
          recheckHover();
        }
        return;
      case 'wheel':
        if (setPoint(message) && visible) noteMotion(clock());
        if (Number.isFinite(message.dx) && Number.isFinite(message.dy)) {
          wheel(message.dx, message.dy);
          recheckHover();
        }
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
