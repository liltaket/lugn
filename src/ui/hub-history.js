// Back and forward on the Hub: the mouse's side buttons (a real mouse, or the
// bridged one, whose buttons pointer-bridge.js sends as the same events).
//
// A place is a page and, on a page that has one, the level opened on it (one
// camera large on Kameror). Back takes one step out:
// 1. close what lies open over Hem (the camera view, a details pane, the
//    morning form);
// 2. leave the level for the page itself (one camera → all cameras);
// 3. return to the place before, and from the first page visited to Hem.
// Forward takes the last of those steps again (an overlay stays closed).
//
// Places are noted however they were reached (swipes, the navbar, taps), and a
// move to the place just before counts as going back, so Back never returns to
// where the user has already stepped out of by hand.
(() => {
  'use strict';

  const pagesApi = globalThis.lugnPages;
  if (!pagesApi) return;

  const LIMIT = 20;
  const BACK_BUTTON = 3;
  const FORWARD_BUTTON = 4;

  const levels = new Map();
  const behind = [];
  const ahead = [];
  // True while Back or Forward moves: those moves are already accounted for.
  let travelling = false;

  const levelOf = (page) => levels.get(page)?.get() || '';
  function now() {
    const page = pagesApi.current();
    return { page, level: levelOf(page) };
  }
  const same = (a, b) =>
    Boolean(a && b) && a.page === b.page && a.level === b.level;

  function keep(list, place) {
    list.push(place);
    if (list.length > LIMIT) list.shift();
  }

  let here = now();

  function note() {
    if (travelling) return;
    const next = now();
    if (same(next, here)) return;
    const leftLevel =
      next.page === here.page && here.level !== '' && next.level === '';
    if (same(next, behind.at(-1))) {
      behind.pop();
      keep(ahead, here);
    } else if (leftLevel) keep(ahead, here);
    else {
      keep(behind, here);
      ahead.length = 0;
    }
    here = next;
  }

  // The place changed by itself (a camera went away): not a step of its own.
  function replace() {
    if (!travelling) here = now();
  }

  function travel(place) {
    const from = here;
    travelling = true;
    try {
      here = place;
      levels.get(place.page)?.set(place.level);
      if (pagesApi.current() !== place.page && !pagesApi.go(place.page)) {
        // The pages are held (a finger is dragging them): stay.
        here = from;
        return false;
      }
      return true;
    } finally {
      travelling = false;
    }
  }

  function back() {
    note();
    if (
      here.page === 'home' &&
      typeof closeHubOverlay === 'function' &&
      closeHubOverlay()
    )
      return true;
    if (here.level) {
      levels.get(here.page).set('');
      note();
      return true;
    }
    const target = behind.at(-1) ?? { page: 'home', level: '' };
    const from = here;
    if (same(target, from) || !travel(target)) return false;
    behind.pop();
    keep(ahead, from);
    return true;
  }

  function forward() {
    note();
    const target = ahead.at(-1);
    const from = here;
    if (!target || !travel(target)) return false;
    ahead.pop();
    keep(behind, from);
    return true;
  }

  // The browser's own back and forward happen on release, so they are stopped
  // there, and only when the dashboard had a step to take.
  window.addEventListener('mouseup', (event) => {
    if (event.button !== BACK_BUTTON && event.button !== FORWARD_BUTTON) return;
    const moved = event.button === BACK_BUTTON ? back() : forward();
    if (moved) event.preventDefault();
  });

  window.addEventListener('lugn:page', note);

  globalThis.lugnHistory = {
    back,
    forward,
    note,
    replace,
    // A page with a level of its own: `get()` is the open one ('' for none),
    // `set(level)` opens it ('' closes it), also before the page is shown.
    level(page, hooks) {
      levels.set(page, hooks);
      if (here.page === page) replace();
    },
  };
})();
