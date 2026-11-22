// Hub pointer bridge: a desktop agent drives a virtual cursor on this page.
// Wire protocol: agents/linux/hub-pointer/PROTOCOL.md. Lugn hands this page
// the agent URL and token only when the bridge is configured for this Hub;
// otherwise the script does nothing at all.
//
// The Hub's main thread is slow and the dashboard is heavy, so the cursor is
// built once when the bridge is configured and only ever has its transform
// and visibility changed. Each animation frame writes one transform; hover
// hit testing, and the highlight around the hovered control, run from a
// timer, never inside the frame.
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
  const HOVER_INTERVAL_MS = 40;
  // ...and once this long after the last move.
  const HOVER_SETTLE_MS = 30;
  // After a click, Escape or wheel the page may change under a still cursor:
  // hover and the plate are measured again this long after.
  const HOVER_RECHECK_MS = 300;
  // Frames keep running this long after the last move, so frame gaps are
  // measured across a whole gesture rather than per move.
  const MOTION_TAIL_MS = 100;
  // The agent sends moves at most about 50 times a second and Wi-Fi delivers
  // them in bursts, so the page often has a new position only every second or
  // third frame. The dot follows the position exponentially instead of
  // jumping to it, so it moves on every frame. This is its time constant; 0
  // switches smoothing off. A gap longer than SMOOTH_IDLE_MS, or a jump of
  // more than SMOOTH_JUMP_PX, puts the dot straight on the position.
  const SMOOTH_MS = 28;
  const SMOOTH_IDLE_MS = 100;
  const SMOOTH_JUMP_PX = 400;
  // Longest heartbeat after `warm`, in case `enter` never comes.
  const WARM_MAX_MS = 3000;
  const PERF_INTERVAL_MS = 2000;
  const LAG_SAMPLES = 256;
  // The dot: a soft disc centred on the hotspot, drawn inside a slightly
  // larger box so its shadow is not clipped by paint containment. It always
  // shows and only ever moves.
  const DOT_SIZE = 20;
  const DOT_BOX = 30;
  const PARKED = 'translate3d(-100px, -100px, 0)';
  // The highlight plate: static around the hovered control, under the dot.
  const PLATE_PADDING = 6;
  const PLATE_MIN_RADIUS = 12;
  // A plate covering at least this many px draws an outline instead: a large
  // area washed in white reads as selected rather than hovered.
  const RING_MIN_AREA = 64000;
  const FADE_MS = 110;
  // The dark hairline outside keeps the plate visible over light controls
  // and artwork.
  const PLATE_LOOKS = {
    fill: {
      background: 'rgba(255, 255, 255, 0.14)',
      pressed: 'rgba(255, 255, 255, 0.24)',
      boxShadow:
        'inset 0 0 0 1px rgba(255, 255, 255, 0.12), 0 0 0 1px rgba(0, 0, 0, 0.16)',
    },
    ring: {
      background: 'rgba(255, 255, 255, 0.04)',
      pressed: 'rgba(255, 255, 255, 0.1)',
      boxShadow:
        'inset 0 0 0 2px rgba(255, 255, 255, 0.42), 0 0 0 1px rgba(0, 0, 0, 0.22)',
    },
  };
  // Everything on the Hub that acts on a click: display.js binds its
  // handlers to buttons (the scene grid delegates to its buttons) and the
  // bedtime form's labels carry their radios, checkbox and time field.
  // Generic focus targets ([tabindex] panels and scroll areas) do nothing on
  // a click and are left out.
  const CONTROLS =
    'button, a[href], input, select, textarea, summary, label, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [role="option"]';
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
  // Two plates, so one can fade out around the control just left while the
  // other fades in around the next one.
  let plates = [];
  let visible = false;
  let pixelRatio = 1;
  // Latest point from the agent.
  let x = 0;
  let y = 0;
  // Point the cursor transform was last written for.
  let drawnX = NaN;
  let drawnY = NaN;
  // Where the dot is shown while it follows (x, y).
  let shownX = NaN;
  let shownY = NaN;
  let drawnTransform = '';
  let framePending = false;
  let lastFrameAt = 0;
  let motionUntil = 0;
  let warmUntil = 0;
  let lastMotionAt = -Infinity;
  let lastMoveEvent = 0;
  let lastEventX = -Infinity;
  let lastEventY = -Infinity;
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
  // The plate shown around the hovered control, if any.
  let activePlate = null;

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

  // A plate never moves: its box is set once per hovered control and only
  // its opacity eases.
  function createPlate() {
    const element = fixedLayer('plate', 0, 0);
    const style = element.style;
    style.zIndex = '2147483646';
    style.boxSizing = 'border-box';
    style.contain = 'layout size style';
    style.willChange = 'opacity';
    style.transition = `opacity ${FADE_MS}ms ease-out`;
    style.opacity = '0';
    document.body.appendChild(element);
    return { element, control: null, look: null, background: '', shown: false };
  }

  // Built once, before any `enter`, and kept in the DOM for good: showing it
  // is a visibility flip on layers that already exist. No CSS filter or
  // backdrop: the shadow and fill rasterize once and the layers only move or
  // fade.
  function createCursor() {
    plates = [createPlate(), createPlate()];
    const dot = fixedLayer('dot', DOT_BOX, DOT_BOX);
    dot.style.zIndex = '2147483647';
    dot.style.contain = 'strict';
    dot.style.overflow = 'hidden';
    dot.style.transform = PARKED;
    const fill = document.createElement('div');
    const style = fill.style;
    const inset = `${(DOT_BOX - DOT_SIZE) / 2}px`;
    style.position = 'absolute';
    style.boxSizing = 'border-box';
    style.left = inset;
    style.top = inset;
    style.width = `${DOT_SIZE}px`;
    style.height = `${DOT_SIZE}px`;
    style.margin = '0';
    style.padding = '0';
    style.pointerEvents = 'none';
    style.borderRadius = '50%';
    style.background = 'rgba(236, 240, 232, 0.55)';
    style.border = '1px solid rgba(12, 18, 16, 0.32)';
    style.boxShadow = '0 1px 4px rgba(0, 0, 0, 0.24)';
    dot.appendChild(fill);
    document.body.appendChild(dot);
    return dot;
  }

  function showCursor() {
    if (!visible) {
      visible = true;
      warmUntil = 0;
      cursor.style.visibility = 'visible';
      for (const plate of plates) plate.element.style.visibility = 'visible';
      startMeasuring();
    }
    noteMotion(clock());
  }

  function hideCursor() {
    if (visible) {
      visible = false;
      cursor.style.visibility = 'hidden';
      cursor.style.transform = PARKED;
      for (const plate of plates) plate.element.style.visibility = 'hidden';
      drawnX = NaN;
      drawnY = NaN;
      drawnTransform = '';
      shownX = NaN;
      shownY = NaN;
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
    if (
      control.disabled === true ||
      control.getAttribute?.('aria-disabled') === 'true' ||
      control.control?.disabled === true
    )
      return true;
    try {
      return control.matches?.(':disabled') === true;
    } catch {
      return false;
    }
  }

  function setOpacity(plate, shown) {
    if (plate.shown === shown) return;
    plate.shown = shown;
    plate.element.style.opacity = shown ? '1' : '0';
  }

  // Fill colour follows the press; written only when it changes.
  function updateLook() {
    const plate = activePlate;
    if (!plate) return;
    const background =
      pressTarget !== null ? plate.look.pressed : plate.look.background;
    if (plate.background === background) return;
    plate.background = background;
    plate.element.style.background = background;
  }

  // Puts a plate around the hovered control. Runs only from the hover timer
  // (or a recheck), after the hit test has brought layout up to date.
  // `remeasure` resizes the shown plate in place for the same control;
  // otherwise the old plate fades out where it is and the other one fades in
  // around the new control. Nothing slides.
  function placePlate(control, remeasure = false) {
    if (!control || disabled(control) || !control.getBoundingClientRect) {
      hidePlate();
      return;
    }
    const zoom = rootZoom();
    const scale = rectScale(zoom);
    const box = control.getBoundingClientRect();
    if (!(box.width > 0 && box.height > 0)) {
      hidePlate();
      return;
    }
    const width = box.width * scale + 2 * PLATE_PADDING;
    const height = box.height * scale + 2 * PLATE_PADDING;
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
    const look =
      width * height >= RING_MIN_AREA ? PLATE_LOOKS.ring : PLATE_LOOKS.fill;
    let plate = activePlate;
    if (!(remeasure && plate && plate.control === control)) {
      // Back to a control whose plate is still fading out: that plate fades
      // back in; otherwise the idle plate takes the new control.
      plate =
        plates.find(
          (entry) => entry !== activePlate && entry.control === control,
        ) ?? plates.find((entry) => entry !== activePlate);
      if (activePlate && activePlate !== plate) setOpacity(activePlate, false);
    }
    const style = plate.element.style;
    style.left = `${left}px`;
    style.top = `${top}px`;
    style.width = `${width}px`;
    style.height = `${height}px`;
    style.borderRadius = `${radius}px`;
    if (plate.look !== look) {
      plate.look = look;
      plate.background = '';
      style.boxShadow = look.boxShadow;
    }
    plate.control = control;
    activePlate = plate;
    updateLook();
    setOpacity(plate, true);
  }

  function hidePlate() {
    if (!activePlate) return;
    setOpacity(activePlate, false);
    activePlate = null;
  }

  function requestFrame() {
    if (framePending) return;
    framePending = true;
    requestAnimationFrame(onFrame);
  }

  // The hot path: at most one pointermove for a held button (hit test first,
  // while layout is still clean) and a transform write on the dot. No other
  // reads or writes; the plate does not move.
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
      follow(now);
      if (shownX !== drawnX || shownY !== drawnY) {
        drawnX = shownX;
        drawnY = shownY;
        // A frame counts, and the lag is taken, when the dot visibly moves:
        // a change below a device pixel writes nothing.
        const transform = `translate3d(${snap(shownX - DOT_BOX / 2)}px, ${snap(shownY - DOT_BOX / 2)}px, 0)`;
        if (transform !== drawnTransform) {
          drawnTransform = transform;
          cursor.style.transform = transform;
          frames += 1;
          // Pages that show something on mouse movement (the quick menu) are
          // told, when the dot has moved at least 2 px and at most every
          // 150 ms; the bridged mouse sends no pointermove while no button is
          // held.
          if (
            now - lastMoveEvent > 150 &&
            Math.abs(shownX - lastEventX) + Math.abs(shownY - lastEventY) >=
              2 &&
            typeof Event === 'function'
          ) {
            lastMoveEvent = now;
            lastEventX = shownX;
            lastEventY = shownY;
            window.dispatchEvent?.(new Event('lugn:pointer-move'));
          }
          if (moveStamp) {
            recordLag(now - moveStamp);
            moveStamp = 0;
          }
        }
      }
    }
    if (now < motionUntil || now < warmUntil || (visible && following())) {
      lastFrameAt = now;
      requestFrame();
    } else {
      lastFrameAt = 0;
    }
  }
  const onFrame = guard(frame);

  function following() {
    return shownX !== x || shownY !== y;
  }

  // Moves the shown position toward (x, y) by the time since the last frame.
  function follow(now) {
    const gap = lastFrameAt ? now - lastFrameAt : 0;
    if (
      !SMOOTH_MS ||
      !Number.isFinite(shownX) ||
      !(gap > 0 && gap < SMOOTH_IDLE_MS) ||
      Math.hypot(x - shownX, y - shownY) > SMOOTH_JUMP_PX
    ) {
      shownX = x;
      shownY = y;
      return;
    }
    const share = 1 - Math.exp(-gap / SMOOTH_MS);
    shownX += (x - shownX) * share;
    shownY += (y - shownY) * share;
    // The last fraction of a pixel is the position itself.
    if (Math.abs(x - shownX) < 0.25) shownX = x;
    if (Math.abs(y - shownY) < 0.25) shownY = y;
  }

  function snap(value) {
    return Math.round(value * pixelRatio) / pixelRatio;
  }

  // ── Hit testing ──

  // Element under the cursor. `cached` reuses the last result for the same
  // point while that element is still in the document.
  function hitAt(cached) {
    // A page change can make the cached element inert without removing it.
    if (
      cached &&
      x === hitX &&
      y === hitY &&
      connected(hitTarget) &&
      !hitTarget.closest?.('[inert]')
    )
      return hitTarget;
    const element = document.elementFromPoint(x, y);
    hitX = x;
    hitY = y;
    hitTarget = !element || element.closest?.('[inert]') ? null : element;
    return hitTarget;
  }

  // The element a click at this point acts on: a button rather than the
  // span inside it, and a label rather than the radio, checkbox or field it
  // wraps. Nothing inside an aria-hidden subtree counts.
  function controlFor(element) {
    let control = element?.closest?.(CONTROLS) ?? null;
    if (!control) return null;
    if (/^input$/i.test(control.tagName ?? ''))
      control = control.parentElement?.closest?.('label') ?? control;
    if (control.closest?.('[aria-hidden="true"]')) return null;
    return control;
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
    if (control === hovered && remeasure) placePlate(control, true);
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
    // The page pager hides the plate while it moves; once it lies still the
    // control under the cursor is measured again at once.
    window.addEventListener(
      'lugn:pages-settled',
      guard(() => {
        if (!visible) return;
        hitX = NaN;
        if (recheckTimer !== undefined) clearTimeout(recheckTimer);
        recheckTimer = setTimeout(onRecheckTimer, 0);
      }),
    );
    // A page change (at release, before the track settles) drops what the
    // cursor was last known to be over.
    window.addEventListener(
      'lugn:page',
      guard(() => {
        hitX = NaN;
      }),
    );
    connect();
  }

  function retryConfig(delay) {
    setTimeout(() => {
      loadConfig(Math.min(delay * 2, CONFIG_RETRY_MAX_MS)).catch(debug);
    }, delay);
  }

  loadConfig(CONFIG_RETRY_MIN_MS).catch((error) => debug('disabled', error));
})();
