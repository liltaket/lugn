// Hub pointer bridge: a desktop agent drives a virtual cursor on this page.
// Wire protocol: agents/linux/hub-pointer/PROTOCOL.md. Lugn hands this page
// the agent URL and token only when the bridge is configured for this Hub;
// otherwise the script does nothing at all.
(() => {
  'use strict';

  const CONFIG_URL = `${location.pathname.replace(/\/?$/, '/')}display-api/pointer-bridge`;
  const POINTER_ID = 4242;
  const RECONNECT_MIN_MS = 500;
  const RECONNECT_MAX_MS = 5000;
  const CONFIG_RETRY_MIN_MS = 5000;
  const CONFIG_RETRY_MAX_MS = 60000;
  // Pixel offset of the arrow tip inside the cursor graphic.
  const HOTSPOT = 2;
  const INTERACTIVE =
    'button, a, [role="button"], input, label, select, textarea, summary, [tabindex]';
  const FOCUSABLE_FIELDS = 'input, select, textarea';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  let bridge;
  let socket;
  let reconnectDelay = RECONNECT_MIN_MS;
  let reconnectTimer;
  let cursor;
  let visible = false;
  let x = 0;
  let y = 0;
  let framePending = false;
  let hovered = null;
  let pressTarget = null;
  let pressControl = null;

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

  function createCursor() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', '24');
    svg.setAttribute('height', '28');
    svg.setAttribute('viewBox', `${-HOTSPOT} ${-HOTSPOT} 24 28`);
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute(
      'd',
      'M0 0 L0 19.5 L4.7 15.1 L7.9 22.4 L11.3 20.9 L8.2 13.8 L14.6 13.8 Z',
    );
    path.setAttribute('fill', '#ffffff');
    path.setAttribute('stroke', '#161c1b');
    path.setAttribute('stroke-width', '1.4');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    const style = svg.style;
    style.position = 'fixed';
    style.left = '0';
    style.top = '0';
    style.margin = '0';
    style.pointerEvents = 'none';
    style.zIndex = '2147483647';
    style.willChange = 'transform';
    style.overflow = 'visible';
    style.filter = 'drop-shadow(0 1px 2px rgba(0, 0, 0, 0.45))';
    style.display = 'none';
    document.body.appendChild(svg);
    return svg;
  }

  function showCursor() {
    cursor ??= createCursor();
    if (!visible) {
      visible = true;
      cursor.style.display = 'block';
    }
    scheduleFrame();
  }

  function hideCursor() {
    visible = false;
    if (cursor) cursor.style.display = 'none';
    setHover(null);
  }

  function scheduleFrame() {
    if (framePending) return;
    framePending = true;
    requestAnimationFrame(guard(frame));
  }

  // One cursor write and at most one hit test per frame, at the latest point.
  function frame() {
    framePending = false;
    if (!visible || !cursor) return;
    cursor.style.transform = `translate3d(${x - HOTSPOT}px, ${y - HOTSPOT}px, 0)`;
    const target = hitTest();
    setHover(controlFor(target));
    if (pressTarget && target)
      dispatchPointer('pointermove', target, { button: -1, buttons: 1 });
  }

  // ── Hit testing ──

  function hitTest() {
    const element = document.elementFromPoint(x, y);
    if (!element || element.closest?.('[inert]')) return null;
    return element;
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
    const target = hitTest();
    if (!target) return;
    const control = controlFor(target);
    pressTarget = target;
    pressControl = control;
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
    const target = hitTest() ?? document.body;
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
    const target = hitTest();
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
    send({ t: 'hello', v: 1, w: window.innerWidth, h: window.innerHeight });
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
      case 'enter':
        setPoint(message);
        showCursor();
        return;
      case 'move':
        if (setPoint(message)) {
          if (!visible) showCursor();
          else scheduleFrame();
        }
        return;
      case 'button':
        if (setPoint(message) && !visible) showCursor();
        if (message.button === 'left') {
          if (message.down) press();
          else release();
        } else if (message.button === 'right' && message.down) {
          escape();
        }
        if (visible) scheduleFrame();
        return;
      case 'wheel':
        setPoint(message);
        if (Number.isFinite(message.dx) && Number.isFinite(message.dy))
          wheel(message.dx, message.dy);
        return;
      case 'leave':
        endCapture();
        return;
      default:
    }
  }

  function endCapture() {
    cancelPress();
    hideCursor();
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
