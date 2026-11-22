// The quick menu of a page (Foto, Musik): Hem's scenes and a camera button that
// slide up from the bottom edge when the mouse moves over the page or the page
// is tapped, and go away again by themselves. It adds nothing to the page
// until it is shown and changes only the opacity and position of its own
// layer.
//
// A page gives a root element (which gets the class `menu-open` while the menu
// is open, so the page can move or dim its own parts) and a menu element that
// holds a dock (`[data-view='dock']`, drawn by page-views.js) and, optionally,
// a camera button (`[data-qm='camera']`). The Hub's bridged mouse does not send
// pointer events while no button is held, so pointer-bridge.js announces its
// movement as the window event `lugn:pointer-move`.
(() => {
  'use strict';

  const pagesApi = globalThis.lugnPages;
  const HOVER_MS = 4000;
  const TAP_MS = 8000;
  const MOVE_GAP_MS = 150;

  const pager = () => document.getElementById('hub-pager');
  const paging = () => Boolean(pager()?.classList.contains('paging'));
  const hem = () => (typeof refs === 'object' && refs ? refs : null);

  function attach(options) {
    const { id, root, menu } = options;
    if (!root || !menu || !pagesApi) return null;
    const camera = menu.querySelector("[data-qm='camera']");
    const listeners = { open: new Set(), close: new Set() };
    let open = false;
    let timer = 0;
    let dockTimer = 0;
    let lastMove = 0;

    const isActive = () => pagesApi.current() === id;

    function drawDock() {
      globalThis.lugnSceneDock?.draw(id);
      // The camera shortcut exists where Hem has a camera menu.
      const r = hem();
      if (camera) {
        const cameras = Boolean(r?.cameraMenu) && r.cameraMenu.hidden !== true;
        if (camera.hidden === cameras) camera.hidden = !cameras;
      }
    }

    function arm(ms) {
      window.clearTimeout(timer);
      timer = window.setTimeout(close, ms);
    }

    function show(ms) {
      if (!isActive() || paging()) return;
      if (open) {
        arm(ms);
        return;
      }
      open = true;
      drawDock();
      menu.classList.add('open');
      root.classList.add('menu-open');
      window.clearInterval(dockTimer);
      dockTimer = window.setInterval(drawDock, 1000);
      arm(ms);
      for (const fn of listeners.open) fn();
    }

    function close() {
      if (!open) return;
      open = false;
      window.clearTimeout(timer);
      window.clearInterval(dockTimer);
      timer = 0;
      dockTimer = 0;
      menu.classList.remove('open');
      root.classList.remove('menu-open');
      for (const fn of listeners.close) fn();
    }

    // Mouse movement (a real mouse, or the Hub's bridged one) shows the menu
    // and keeps it while the mouse moves; a held button is a swipe, not this.
    function moved(event) {
      if (event && (event.buttons || event.pointerType === 'touch')) return;
      const now = performance.now();
      if (now - lastMove < MOVE_GAP_MS) return;
      lastMove = now;
      show(HOVER_MS);
    }
    root.addEventListener('pointermove', (event) => {
      if (event.pointerType === 'mouse') moved(event);
    });
    window.addEventListener('lugn:pointer-move', () => {
      if (isActive()) moved(null);
    });

    // A tap opens it, or closes it when it lands beside the menu.
    root.addEventListener('click', (event) => {
      if (!isActive() || paging()) return;
      const target = event.target;
      if (camera && camera.contains(target)) {
        close();
        // The cameras live on Hem: go there and open its camera menu.
        const open_ = () => hem()?.cameraMenu?.click?.();
        if (pagesApi.current() === 'home') open_();
        else if (pagesApi.go('home')) {
          const once = () => {
            window.removeEventListener('lugn:pages-settled', once);
            open_();
          };
          window.addEventListener('lugn:pages-settled', once);
        }
        return;
      }
      if (options.handleTap?.(event)) {
        // The page took the tap for one of its own controls.
        if (open) arm(TAP_MS);
        return;
      }
      if (menu.contains(target)) {
        // A scene button (handled by the dock): keep the menu a while longer.
        if (target.closest?.('button')) arm(TAP_MS);
        else close();
        return;
      }
      if (open) close();
      else show(TAP_MS);
    });

    // Leaving the page closes it.
    window.addEventListener('lugn:page', (event) => {
      if (event.detail?.previous === id || event.detail?.page !== id) close();
    });

    return {
      show: (ms = TAP_MS) => show(ms),
      close,
      arm: (ms = TAP_MS) => open && arm(ms),
      isOpen: () => open,
      onOpen: (fn) => listeners.open.add(fn),
      onClose: (fn) => listeners.close.add(fn),
    };
  }

  globalThis.lugnQuickMenu = { attach };

  // Musik has the same menu (without the music controls: the page is those).
  const musicRoot = document.querySelector(
    ".hub-page[data-page='music'] [data-view='root']",
  );
  attach({
    id: 'music',
    root: musicRoot,
    menu: musicRoot?.querySelector("[data-view='menu']"),
  });
})();
