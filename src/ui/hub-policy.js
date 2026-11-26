// Hub rules, on the Hub: applies the policy the server worked out for this Hub
// (src/core/hub-rules.ts, docs/HUB-RULES.md). The server decides; this file
// only carries it out, so the rules, the clock and the arrival time live in one
// place and a Hub never disagrees with another about what a rule means.
//
// A policy (`payload.hubPolicy`; absent means no rules, and nothing here runs):
//   pages  which pages the pager contains (null: the usual ones, that is all but
//          the conditional greeting and computer pages). The others are taken
//          out of the track, so swiping skips them. Where the page on screen
//          goes away, the first page that is left takes over.
//   focus  a page to bring up, with a token naming this one activation of the
//          rule. The Hub goes there once per token: a person who swipes away is
//          left alone until the rule starts again. It is also dropped, and not
//          retried, when the Hub is on a page the rule does not take over from
//          (`fromPages`) or has been touched within `idleSeconds`. `returnTo` is
//          where it goes when the rule ends, if the Hub is still on the page it
//          was taken to and nobody has touched it since.
//   scene  the greeting page's scene ({ kind, skin }), handed to
//          `lugnGreeting.setScene`.
//   dim    1 leaves the screen as it is. Smaller is darker. The Hub cannot dim
//          its own panel, so this lays a black sheet over the page. A touch
//          lifts it for half a minute; on a nearly black screen that first tap
//          only wakes it.
//   tags   free labels, on <html> as `data-hub-tags`; anything may style or
//          read them (`[data-hub-tags~='night'] .thing { ... }`).
//
// To look at a scene without waiting for its rule, tap its button on the Info
// page, or open the Hub page with `#scene=godnatt` (also godmorgon, hem, natt),
// optionally `&skin=jul`, `&name=Alva&age=32`, or `#show=dator`. The server's
// policy is then ignored, until "Av" or a reload.
(() => {
  'use strict';

  const pagesApi = globalThis.lugnPages;
  if (!pagesApi) return;

  const root = document.documentElement;
  const sheet = document.getElementById('hub-dim');
  const RETRY_MS = 500;
  const RETRIES = 12;
  // A Hub that was only just opened, or touched, is not moved by itself.
  const clockMs = () => window.performance?.now?.() ?? Date.now();

  let drawnKey = '';
  let wanted = null; // the page list last asked for
  let actedOn = null; // the focus token this Hub has gone to
  let focus = null; // { page, returnTo } while a focus is in force
  let autoPage = null; // the page the Hub was taken to, until someone moves on
  let retryTimer = 0;
  let lastTouch = clockMs();
  // A dimmed Hub lights up while someone uses it. A nearly black one takes the
  // first tap on its sheet, so nothing unseen is pressed.
  const WAKE_MS = 30_000;
  const DEEP_DIM = 0.2;
  let level = 1; // the dim the rules ask for
  let woken = false;
  let wakeTimer = 0;

  function touch() {
    lastTouch = clockMs();
    if (level < 1 && level > DEEP_DIM) wake();
  }
  const touchEvents = ['pointerdown', 'touchstart', 'keydown', 'wheel'];
  for (const type of touchEvents)
    document.addEventListener?.(type, touch, { capture: true, passive: true });
  // Someone moved to another page: the page we took them to is theirs now.
  window.addEventListener?.('lugn:page', () => {
    if (autoPage !== null && pagesApi.current() !== autoPage) autoPage = null;
  });
  const idleFor = (seconds) => clockMs() - lastTouch >= seconds * 1000;

  function setTags(tags) {
    const value = Array.isArray(tags) ? tags.join(' ') : '';
    if (value) root.dataset.hubTags = value;
    else delete root.dataset.hubTags;
  }

  function drawDim() {
    if (!sheet) return;
    const shown = woken ? 1 : level;
    sheet.style.pointerEvents = shown <= DEEP_DIM ? 'auto' : 'none';
    if (shown >= 1) {
      sheet.style.opacity = '0';
      // The sheet is taken out of the page once it has faded.
      window.setTimeout(() => {
        if (sheet.style.opacity === '0') sheet.hidden = true;
      }, 1400);
      return;
    }
    sheet.hidden = false;
    // A frame later, so the fade starts from clear.
    window.requestAnimationFrame(() => {
      sheet.style.opacity = String(Math.round((1 - shown) * 100) / 100);
    });
  }

  function wake() {
    woken = true;
    window.clearTimeout(wakeTimer);
    const sleep = () => {
      if (!idleFor(WAKE_MS / 1000)) {
        wakeTimer = window.setTimeout(sleep, WAKE_MS);
        return;
      }
      woken = false;
      drawDim();
    };
    wakeTimer = window.setTimeout(sleep, WAKE_MS);
    drawDim();
  }
  // A moment later, so the tap that woke the screen ends on the sheet.
  sheet?.addEventListener?.('pointerup', () => window.setTimeout(wake, 50));

  function setDim(dim) {
    const next = typeof dim === 'number' && dim > 0 && dim < 1 ? dim : 1;
    if (next === level) return;
    level = next;
    // A new request is obeyed at once, whoever touched the screen before it.
    woken = false;
    window.clearTimeout(wakeTimer);
    drawDim();
  }

  // The pager does not rearrange pages under a finger; it says so and this
  // asks again.
  function applyPages(list, tries = 0) {
    window.clearTimeout(retryTimer);
    if (pagesApi.setAvailable(list)) return;
    if (tries >= RETRIES) return;
    retryTimer = window.setTimeout(
      () => applyPages(wanted, tries + 1),
      RETRY_MS,
    );
  }

  function goTo(page, token, tries = 0) {
    // Only for the activation still in force.
    if (token !== null && actedOn !== token) return;
    if (pagesApi.current() === page) return;
    if (pagesApi.go(page)) {
      autoPage = page;
      return;
    }
    if (tries >= RETRIES) return;
    window.setTimeout(() => goTo(page, token, tries + 1), RETRY_MS);
  }

  // Whether this Hub may be moved now. A chance that is missed is not kept for
  // later: the person was in the middle of something.
  function mayTake(offer) {
    if (
      Array.isArray(offer.fromPages) &&
      !offer.fromPages.includes(pagesApi.current())
    )
      return false;
    if (typeof offer.idleSeconds === 'number' && !idleFor(offer.idleSeconds))
      return false;
    return true;
  }

  const RETURN_IDLE_SECONDS = 30;

  function applyScene(scene) {
    globalThis.lugnGreeting?.setScene?.(scene ?? null);
  }

  // What to look at, from the Info page's buttons or `#scene=…` / `#show=…`
  // in the address: a policy of its own that replaces the server's.
  let override = null;
  let previews = 0;
  let latest;

  function fromAddress() {
    // The server turns away a query string, so the address carries it after #.
    const query = new URLSearchParams(
      (globalThis.location?.hash ?? '').replace(/^#/, ''),
    );
    const kind = query.get('scene');
    if (query.get('show') === 'dator') return { show: 'dator' };
    if (!kind) return null;
    const age = Number(query.get('age'));
    const skinId = query.get('skin');
    return {
      scene: kind,
      skin: skinId
        ? {
            id: skinId,
            ...(query.get('name') ? { name: query.get('name') } : {}),
            ...(Number.isInteger(age) && age > 0 ? { age } : {}),
            ...(query.get('title') ? { title: query.get('title') } : {}),
          }
        : null,
    };
  }
  let addressSpec = fromAddress();
  if (addressSpec) previews = 1;

  function previewPolicy() {
    const spec = override ?? addressSpec;
    if (!spec) return null;
    const token = `preview-${previews}`;
    if (spec.show === 'dator')
      return {
        pages: pagesApi.all().filter((page) => page !== 'halsning'),
        focus: { page: 'dator', returnTo: 'home', token },
        scene: null,
        dim: 1,
        tags: [],
      };
    return {
      // Not locked, even for the night sheet: the way back is on the Info page.
      pages: pagesApi.all(),
      focus: { page: 'halsning', returnTo: 'home', token },
      scene: { kind: spec.scene, skin: spec.skin ?? null, rule: 'preview' },
      dim: 1,
      tags: [],
    };
  }

  function apply(policy) {
    latest = policy;
    const preview = previewPolicy();
    const next =
      preview ?? (policy && typeof policy === 'object' ? policy : {});
    const pages = Array.isArray(next.pages) ? next.pages : null;
    const scene =
      next.scene && typeof next.scene === 'object' ? next.scene : null;
    const key = JSON.stringify([pages, next.dim ?? 1, next.tags ?? [], scene]);
    if (key !== drawnKey) {
      drawnKey = key;
      wanted = pages;
      setTags(next.tags);
      setDim(next.dim);
      applyPages(pages);
    }

    // Every time, not only on a change: the greeting page may load after the
    // first payload, and it ignores a scene it already has.
    applyScene(scene);

    const now =
      next.focus && typeof next.focus === 'object' ? next.focus : null;
    if (now && now.token !== actedOn) {
      actedOn = now.token;
      focus = { page: now.page, returnTo: now.returnTo || null };
      if (mayTake(now)) goTo(now.page, now.token);
    } else if (!now && focus) {
      const ended = focus;
      focus = null;
      actedOn = null;
      if (
        ended.returnTo &&
        pagesApi.current() === ended.page &&
        autoPage === ended.page &&
        idleFor(RETURN_IDLE_SECONDS)
      )
        goTo(ended.returnTo, null);
      autoPage = null;
    }
  }

  // Look at a scene (`{ scene, skin }` or `{ show: 'dator' }`) or, with null,
  // go back to what the rules say.
  function preview(spec) {
    override = spec;
    if (!spec) addressSpec = null;
    previews += 1;
    apply(latest);
  }

  globalThis.lugnHubPolicy = { apply, touch, preview };

  // The Info page's buttons.
  const SCENE_BUTTONS = [
    ['Godmorgon', { scene: 'godmorgon' }],
    ['Godnatt', { scene: 'godnatt' }],
    ['Välkommen hem', { scene: 'hem' }],
    ['Natt', { scene: 'natt' }],
    ['God jul', { scene: 'godmorgon', skin: { id: 'jul' } }],
    [
      'Födelsedag',
      {
        scene: 'godmorgon',
        skin: { id: 'fodelsedag' },
      },
    ],
    ['Dator', { show: 'dator' }],
    ['Av', null],
  ];
  const holder = document.querySelector?.("[data-view='scenes']");
  if (holder && document.createElement) {
    for (const [label, spec] of SCENE_BUTTONS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', () => {
        preview(spec);
        for (const other of holder.children)
          other.setAttribute(
            'aria-pressed',
            String(other === button && !!spec),
          );
      });
      holder.append(button);
    }
  }
})();
