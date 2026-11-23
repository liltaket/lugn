// The navbar of the pages after Hem (Musik, Foto, Kameror, Klocka, Info): one
// bar (#hub-nav) that lies over the pager, so it stays where it is while the
// pages move under it. It slides up from the bottom edge when the mouse moves
// over a page or the page is tapped, and goes away again by itself. It adds
// nothing to a page until it is shown and changes only the opacity and
// position of its own layer.
//
// The bar draws what the page it is over needs (its context):
// - Hem's scenes (the dock, drawn by page-views.js) on every page;
// - a Musik button everywhere but on Musik, a Kameror button everywhere but
//   on Kameror (and where Hem has no cameras);
// - a back button where the page has a level to go back from (Kameror, when
//   one camera is large), and a button for the next picture on Foto.
//
// A page registers itself with `attach({ id, root, handleTap, actions })`:
// `root` gets the class `menu-open` while the bar is open over it (so the page
// can move or dim its own parts), `handleTap(event)` returns true for a press
// the page takes itself (everything else on the bare page opens or closes the
// bar), `actions.next` is the Foto button's press. The returned object has
// `setBack(fn | null)` for the back button.
//
// How it opens decides how it closes: opened by the mouse (a real mouse, or
// the Hub's bridged one, which pointer-bridge.js announces as the window event
// `lugn:pointer-move`; it sends no pointermove while no button is held) it
// goes when the mouse leaves the screen (`lugn:pointer-leave`) or has been
// still for four seconds; opened by a tap it goes after eight seconds. A tap
// that closes it, like leaving, ends a hover for good: the mouse moving a
// little afterwards does not bring it back until the mouse has left or been
// still a while.
(() => {
  'use strict';

  const pagesApi = globalThis.lugnPages;
  const nav = document.getElementById('hub-nav');
  if (!pagesApi || !nav) return;

  const HOVER_MS = 4000;
  const TAP_MS = 8000;
  const LEAVE_MS = 300;
  const SUPPRESS_IDLE_MS = 5000;
  const MOVE_GAP_MS = 150;

  const pager = () => document.getElementById('hub-pager');
  const paging = () => Boolean(pager()?.classList.contains('paging'));
  const hem = () => (typeof refs === 'object' && refs ? refs : null);
  const button = (name) => nav.querySelector(`[data-nb='${name}']`);
  const buttons = {
    back: button('back'),
    next: button('next'),
    music: button('music'),
    cameras: button('cameras'),
  };
  const dock = nav.querySelector("[data-view='dock']");

  const controllers = new Map();
  let open = false;
  let how = ''; // 'hover' or 'tap'
  let shown = null; // the page controller the bar is over
  let timer = 0;
  let dockTimer = 0;
  let lastMove = 0;
  let suppressed = false;
  let suppressTimer = 0;
  let drawnRgb = null;

  const current = () => controllers.get(pagesApi.current()) || null;
  const keepMs = () => (how === 'tap' ? TAP_MS : HOVER_MS);

  function notify(controller, kind) {
    if (!controller) return;
    for (const fn of controller.listeners[kind]) fn();
  }

  function hide(element, hidden) {
    if (element && element.hidden !== hidden) element.hidden = hidden;
  }

  // What the bar has to offer on the page it is over.
  function drawContext() {
    const controller = shown || current();
    if (!controller) return;
    if (nav.dataset.page !== controller.id) nav.dataset.page = controller.id;
    const r = hem();
    const cameras = Boolean(r?.cameraMenu) && r.cameraMenu.hidden !== true;
    hide(buttons.back, !controller.back);
    hide(buttons.next, !controller.actions?.next);
    hide(buttons.music, controller.id === 'music');
    hide(buttons.cameras, controller.id === 'kameror' || !cameras);
    // A page may tint the selected scene with its own colour (Musik: the
    // cover's), as the three numbers of an rgb() colour.
    const rgb = controller.root?.style?.getPropertyValue?.('--nb-rgb') || '';
    if (rgb !== drawnRgb) {
      drawnRgb = rgb;
      if (rgb) nav.style.setProperty('--nb-rgb', rgb);
      else nav.style.removeProperty('--nb-rgb');
    }
  }

  function drawDock() {
    globalThis.lugnSceneDock?.draw(dock);
    drawContext();
  }

  function arm(ms) {
    window.clearTimeout(timer);
    timer = window.setTimeout(close, ms);
  }

  function show(kind, ms) {
    const controller = current();
    if (!controller || paging()) return;
    clearSuppress();
    if (open) {
      arm(ms);
      return;
    }
    open = true;
    how = kind;
    shown = controller;
    drawDock();
    nav.classList.add('open');
    controller.root.classList.add('menu-open');
    window.clearInterval(dockTimer);
    dockTimer = window.setInterval(() => {
      if (!paging()) drawDock();
    }, 1000);
    arm(ms);
    notify(controller, 'open');
  }

  function close() {
    if (!open) return;
    open = false;
    how = '';
    window.clearTimeout(timer);
    window.clearInterval(dockTimer);
    timer = 0;
    dockTimer = 0;
    nav.classList.remove('open');
    const was = shown;
    shown = null;
    was?.root.classList.remove('menu-open');
    notify(was, 'close');
  }

  // The page changed under an open bar: the bar stays, with the new page's
  // context (and what the old page moved for it moves back).
  function followPage() {
    if (!open) return;
    const next = current();
    if (!next) {
      close();
      return;
    }
    if (next === shown) return;
    const was = shown;
    shown = next;
    was?.root.classList.remove('menu-open');
    next.root.classList.add('menu-open');
    notify(was, 'close');
    notify(next, 'open');
    drawDock();
    arm(keepMs());
  }
  window.addEventListener('lugn:page', followPage);

  // After a tap closed it, the hovering mouse is not asked again: it must
  // leave, or rest for a while, before moving shows the bar again.
  function suppress() {
    suppressed = true;
    window.clearTimeout(suppressTimer);
    suppressTimer = window.setTimeout(clearSuppress, SUPPRESS_IDLE_MS);
  }
  function clearSuppress() {
    suppressed = false;
    window.clearTimeout(suppressTimer);
    suppressTimer = 0;
  }

  // Mouse movement (a real mouse, or the Hub's bridged one) shows the bar and
  // keeps it while the mouse moves; a held button is a swipe, not this.
  function moved(event) {
    if (event && (event.buttons || event.pointerType === 'touch')) return;
    const now = performance.now();
    if (now - lastMove < MOVE_GAP_MS) return;
    lastMove = now;
    if (!current() || paging()) return;
    if (suppressed) {
      suppress();
      return;
    }
    if (open) arm(keepMs());
    else show('hover', HOVER_MS);
  }

  // The mouse left the screen: a bar it opened goes with it.
  function pointerLeft() {
    clearSuppress();
    if (open && how === 'hover') arm(LEAVE_MS);
  }
  window.addEventListener('lugn:pointer-leave', pointerLeft);
  document.documentElement?.addEventListener?.('mouseleave', pointerLeft);
  // Told from the bridge's dot frame: the work is done a moment later, not
  // inside it.
  window.addEventListener('lugn:pointer-move', () => {
    window.setTimeout(() => moved(null), 0);
  });
  nav.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'mouse') moved(event);
  });

  // The bar's own buttons.
  function openCameras() {
    // The cameras have their own page; where there is none, Hem's camera menu.
    if (pagesApi.ids().includes('kameror')) {
      pagesApi.go('kameror');
      return;
    }
    const press = () => hem()?.cameraMenu?.click?.();
    if (pagesApi.current() === 'home') press();
    else if (pagesApi.go('home')) {
      const once = () => {
        window.removeEventListener('lugn:pages-settled', once);
        press();
      };
      window.addEventListener('lugn:pages-settled', once);
    }
  }

  nav.addEventListener('click', (event) => {
    if (!open || paging()) return;
    const control = event.target?.closest?.('button');
    if (!control || control.disabled) return;
    const name = control.getAttribute?.('data-nb');
    const controller = shown;
    if (name === 'back') controller?.back?.();
    else if (name === 'next') controller?.actions?.next?.();
    else if (name === 'music') pagesApi.go('music');
    else if (name === 'cameras') openCameras();
    // A press keeps the bar a while longer (a scene button is the dock's own).
    if (open) arm(keepMs());
  });

  function attach(options) {
    const { id, root } = options;
    if (!root) return null;
    const controller = {
      id,
      root,
      handleTap: options.handleTap || null,
      actions: options.actions || null,
      back: null,
      listeners: { open: new Set(), close: new Set() },
    };
    controllers.set(id, controller);
    const isCurrent = () => current() === controller;

    root.addEventListener('pointermove', (event) => {
      if (event.pointerType === 'mouse' && isCurrent()) moved(event);
    });

    // A tap on the bare page opens the bar, or closes it again.
    root.addEventListener('click', (event) => {
      if (!isCurrent() || paging()) return;
      if (controller.handleTap?.(event)) {
        // The page took the tap for one of its own controls.
        if (open) arm(keepMs());
        return;
      }
      if (open) {
        close();
        suppress();
      } else show('tap', TAP_MS);
    });

    return {
      show: (ms = TAP_MS) => {
        if (isCurrent()) show('tap', ms);
      },
      close: () => {
        if (shown === controller) close();
      },
      arm: (ms = TAP_MS) => open && shown === controller && arm(ms),
      isOpen: () => open && shown === controller,
      onOpen: (fn) => controller.listeners.open.add(fn),
      onClose: (fn) => controller.listeners.close.add(fn),
      // The back button: shown while the page gives a way back.
      setBack(fn) {
        controller.back = typeof fn === 'function' ? fn : null;
        if (open && shown === controller) drawContext();
      },
    };
  }

  globalThis.lugnQuickMenu = { attach };

  // Klocka and Info have it too (the pages are only to look at, so any tap on
  // them is a tap on the bare page; Info's own button is its own).
  const clockRoot = document.querySelector(
    ".hub-page[data-page='clock'] .clock-page",
  );
  if (clockRoot) attach({ id: 'clock', root: clockRoot });
  const infoRoot = document.querySelector(
    ".hub-page[data-page='info'] .info-page",
  );
  if (infoRoot)
    attach({
      id: 'info',
      root: infoRoot,
      handleTap: (event) => Boolean(event.target.closest?.('button')),
    });

  // Musik has the bar too (without the music button: the page is that).
  const musicRoot = document.querySelector(
    ".hub-page[data-page='music'] [data-view='root']",
  );
  if (musicRoot)
    attach({
      id: 'music',
      root: musicRoot,
      // A press on a control (play, next, presets, volume, the cover) is that
      // control's own; only the bare page opens or closes the bar.
      handleTap: (event) =>
        Boolean(
          event.target.closest?.(
            "button, a, input, [data-view='presets'], [data-view='volume'], [data-view='cover']",
          ),
        ),
    });
})();
