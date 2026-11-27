// Hub pages: a horizontal pager over whole-screen pages (Hem first).
//
// The Hub's main thread is slow, so the pager is built around three rules:
// - Only one element ever moves: the track, by `transform` alone. While a
//   finger or the mouse drags, one transform is written per animation frame.
//   On release the settle is one Web Animation of that transform (sampled from
//   a spring, linear between samples), so it runs on the compositor and a busy
//   main thread cannot make it stutter.
// - Pages not on screen do no work: the current page is `active`, its
//   neighbours are `near` (laid out and painted, but static, so a swipe can
//   reveal them at once) and every other page is `off` (content-visibility
//   hidden). Page timers run only while the page is active.
// - No inherited property changes per frame and nothing outside the track is
//   touched during a gesture; the dots change once, when the target is known.
//
// Input: real touch (pointer events, touch-action pan-y), the desk Hub's
// pointer bridge (synthetic pointer/mouse events dispatched to the hit
// element and bubbling to the document; no pointer capture), a horizontal
// wheel or trackpad, a vertical wheel notch outside scrollable areas, and the
// arrow keys. A click that ends a swipe is swallowed.
(() => {
  'use strict';

  const pager = document.getElementById('hub-pager');
  const track = document.getElementById('hub-track');
  if (!pager || !track) return;

  // ── Tuning ──
  const TOUCH_SLOP = 10; // px before a touch is a swipe
  const TAP_SLOP = 10; // px a press may wander and still click
  const MOUSE_SLOP = TAP_SLOP; // so a wobble that still clicks never drags
  const LOCK_RATIO = 1.2; // |dx| must beat |dy| by this much
  const VELOCITY_WINDOW_MS = 90;
  const STILL_MS = 60; // pointer held still this long before release: no fling
  const FLING_VELOCITY = 0.3; // px/ms: a flick past this turns the page
  const PROJECTION_MS = 160; // how far a release velocity carries
  const MIN_VELOCITY_DT_MS = 1000 / 60;
  const MAX_VELOCITY = 4; // px/ms
  const RUBBER = 0.55; // edge resistance (iOS-like)
  const SPRING_RESPONSE = 0.36; // s, period of the undamped spring
  const SPRING_DAMPING = 0.9; // < 1 gives a little overshoot on a fast flick
  const SAMPLE_MS = 1000 / 60;
  const WHEEL_IDLE_MS = 140;
  const WHEEL_STEP = 40; // vertical wheel px for one page
  const WHEEL_COOLDOWN_MS = 450;
  const NEAR_DELAY_MS = 80; // after a settle, before neighbours are prepared
  const WARM_FIRST_MS = 1500; // after load, the neighbours are drawn once
  const WARM_EVERY_MS = 2000; // and kept current this often, when idle
  const LOWER_DELAY_MS = 400; // then the track is marked at rest

  const clock = () => performance.now();
  const pageEls = Array.from(track.querySelectorAll(':scope > .hub-page'));
  const dots = document.getElementById('hub-dots');
  const pages = pageEls.map((el, index) => ({
    id: el.dataset.page || String(index),
    el,
    index,
    state: '',
    hooks: {},
  }));
  pageEls.forEach((el, index) => {
    el.style.left = `${index * 100}%`;
  });
  // Every page there is, in pager order. `pages` is the part of it the pager
  // contains now (see setAvailable).
  const allPages = pages.slice();
  // Pages marked `data-conditional` are in the pager only when Hub rules let
  // them in (hub-policy.js): a greeting belongs to a moment, the computer page
  // to someone at the computer.
  const usualPages = allPages.filter(
    (page) => page.el.dataset.conditional === undefined,
  );

  let width = window.innerWidth || 1024;
  let index = 0;
  let offset = 0; // px the track is shown at (negative moves left)
  let drawn = NaN;
  let frame = 0;
  let animation = null;
  let animFrom = 0;
  let animSamples = null;
  let animStart = 0;
  let gesture = null;
  let swallowClick = false;
  let swallowTimer = 0;
  let nearTimer = 0;
  let wheel = null;
  let wheelStepUntil = 0;
  let wheelStepAccum = 0;
  const listeners = new Set();
  const probe = { enabled: false, gaps: [], last: 0, frame: 0 };

  const base = (i) => -i * width;
  const maxIndex = () => pages.length - 1;

  // ── Drawing ──

  function write(x) {
    if (x === drawn) return;
    drawn = x;
    const px = Math.round(x * 100) / 100;
    track.style.transform = lifted
      ? `translate3d(${px}px, 0, 0)`
      : `translate(${px}px, 0)`;
  }

  // The track is always its own compositor layer (pages.css). While it moves
  // its transform is a translate3d and the pager is marked `moving`; at rest
  // (a little after) the mark goes and a plain translate is written, which
  // changes nothing on screen.
  let lifted = false;
  let paging = false;
  let lowerTimer = 0;
  // Hover (the bridge's plate) is hidden from the first move to the end of
  // the motion; the layer lives a little longer.
  function setPaging(on) {
    if (paging === on) return;
    paging = on;
    pager.classList.toggle('paging', on);
  }
  function lift() {
    window.clearTimeout(lowerTimer);
    setPaging(true);
    if (lifted) return;
    lifted = true;
    pager.classList.add('moving');
    const x = drawn;
    drawn = NaN;
    write(x);
  }
  function lower() {
    if (!lifted || animation || gesture || wheel) return;
    lifted = false;
    pager.classList.remove('moving');
    const x = drawn;
    drawn = NaN;
    write(x);
  }

  function requestDraw() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      write(offset);
    });
  }

  // Past the first or last page the track follows with resistance.
  function rubber(x) {
    const min = base(maxIndex());
    if (x > 0) return band(x);
    if (x < min) return min - band(min - x);
    return x;
  }
  function band(over) {
    return (1 - 1 / ((over * RUBBER) / width + 1)) * width;
  }
  function unrubber(x) {
    const min = base(maxIndex());
    if (x > 0) return unband(x);
    if (x < min) return min - unband(min - x);
    return x;
  }
  function unband(shown) {
    const f = Math.min(shown / width, 0.999);
    return (width / RUBBER) * (1 / (1 - f) - 1);
  }

  // ── Settle: a spring sampled into keyframes, run by the compositor ──

  function springSamples(from, to, velocity) {
    const omega = (2 * Math.PI) / SPRING_RESPONSE / 1000; // rad/ms
    const k = omega * omega;
    const c = 2 * SPRING_DAMPING * omega;
    let x = from - to;
    let v = velocity;
    const out = [from];
    const step = SAMPLE_MS / 4;
    for (let t = 0; t < 1400; t += SAMPLE_MS) {
      for (let s = 0; s < 4; s += 1) {
        const a = -k * x - c * v;
        v += a * step;
        x += v * step;
      }
      out.push(to + x);
      if (Math.abs(x) < 0.25 && Math.abs(v) < 0.02) break;
    }
    out[out.length - 1] = to;
    return out;
  }

  function settle(target, velocity = 0) {
    stopAnimation(false);
    const to = base(target);
    const from = offset;
    setIndex(target);
    if (Math.abs(from - to) < 0.5) {
      offset = to;
      write(to);
      // The snap is complete before anyone hears of the change (changes are
      // queued in order), so a listener that goes on starts a fresh motion.
      motionEnded();
      announce();
      return;
    }
    const samples = springSamples(from, to, velocity);
    const duration = (samples.length - 1) * SAMPLE_MS;
    offset = to;
    if (typeof track.animate !== 'function') {
      write(to);
      // The snap is complete before anyone hears of the change (changes are
      // queued in order), so a listener that goes on starts a fresh motion.
      motionEnded();
      announce();
      return;
    }
    lift();
    animFrom = from;
    animSamples = samples;
    animStart = clock();
    write(to); // the end state lies under the animation
    animation = track.animate(
      samples.map((x) => ({
        transform: `translate3d(${Math.round(x * 100) / 100}px, 0, 0)`,
      })),
      { duration, easing: 'linear' },
    );
    const own = animation;
    own.onfinish = () => {
      if (animation !== own) return;
      animation = null;
      animSamples = null;
      motionEnded();
    };
    if (probe.enabled) probeStart();
    announce();
  }

  // Where the running settle shows the track now, from the samples.
  function animatedOffset() {
    if (!animSamples) return offset;
    const elapsed =
      typeof animation?.currentTime === 'number'
        ? animation.currentTime
        : clock() - animStart;
    const at = elapsed / SAMPLE_MS;
    const i = Math.floor(at);
    if (i >= animSamples.length - 1) return animSamples[animSamples.length - 1];
    if (i < 0) return animFrom;
    const f = at - i;
    return animSamples[i] * (1 - f) + animSamples[i + 1] * f;
  }

  function stopAnimation(keepPosition = true) {
    if (!animation) return;
    const shown = animatedOffset();
    const own = animation;
    animation = null;
    animSamples = null;
    if (keepPosition) {
      offset = shown;
      write(shown);
    }
    own.cancel();
  }

  // ── Page states ──

  // Queues the change at once, so changes are told in the order they
  // happened; `announce` tells the others once the transition is in place,
  // so a listener may call `go` again safely.
  function setIndex(target) {
    if (target === index) return null;
    const previous = pages[index];
    index = target;
    announcements.push({ page: pages[index].id, previous: previous.id });
    syncDots();
    setState(pages[index], 'active');
    return previous;
  }

  // The pages' own enter and leave run once the motion has ended, so a page
  // starting its timers and drawing its live state never lands in the
  // frames of the motion. A run of swipes leaves only the first page and
  // enters only the last.
  let entered = null;
  function enterCurrent() {
    const page = pages[index];
    // Focus left on a control of a page now out of view (neighbours are not
    // inert) is let go, so a key or a bridged Escape cannot act on it.
    const focused = document.activeElement;
    if (
      focused &&
      focused !== document.body &&
      pager.contains(focused) &&
      !page.el.contains(focused)
    )
      focused.blur?.();
    if (entered === page) return;
    if (entered) callHook(entered, 'leave');
    entered = page;
    callHook(page, 'enter');
  }

  // Each change reaches every listener before the next one does, in order,
  // even when a listener goes on to another page.
  const announcements = [];
  let announcing = false;
  function announce() {
    if (announcing || !announcements.length) return;
    announcing = true;
    try {
      while (announcements.length) {
        const change = announcements.shift();
        if (typeof CustomEvent === 'function')
          window.dispatchEvent(
            new CustomEvent('lugn:page', { detail: change }),
          );
        for (const fn of [...listeners]) {
          try {
            fn(change.page, change.previous);
          } catch (error) {
            console.warn('[pages] listener failed', error);
          }
        }
      }
    } finally {
      announcing = false;
    }
  }

  // After a settle the other pages are made near or off, a little later, so
  // the end of the motion is not where their paint lands.
  // The pages have stopped where they are going: the bridge (and anything
  // else) may measure the page again now.
  function motionEnded() {
    setPaging(false);
    enterCurrent();
    window.dispatchEvent?.(new Event('lugn:pages-settled'));
    settled();
  }

  function settled() {
    window.clearTimeout(nearTimer);
    // The new neighbours are prepared when the main thread is idle, not
    // where the end of the motion lands.
    // A motion that starts before the idle time comes keeps the states as
    // they are; its own settle schedules them again.
    nearTimer = window.setTimeout(
      () =>
        whenIdle(() => {
          if (!moving()) syncStates();
        }),
      NEAR_DELAY_MS,
    );
    if (probe.enabled) probeStop();
  }

  const moving = () => Boolean(gesture || wheel || animation || paging);

  function whenIdle(fn) {
    if (typeof requestIdleCallback === 'function')
      requestIdleCallback(() => fn(), { timeout: 500 });
    else fn();
  }

  // Neighbours are drawn from the latest state while nothing moves: once
  // soon after load (when the first state has arrived) and then every few
  // seconds, in idle time. A swipe then reveals a page that is already laid
  // out, painted and decoded, and its first frame does no page work.
  let warmTimer = 0;
  function warmNeighbours() {
    warmTimer = window.setTimeout(warmNeighbours, WARM_EVERY_MS);
    if (moving() || document.visibilityState === 'hidden') return;
    whenIdle(() => {
      if (moving()) return;
      for (const i of [index - 1, index + 1]) {
        const page = pages[i];
        if (page?.state === 'near') callHook(page, 'prepare');
      }
    });
  }

  function syncStates() {
    nearTimer = 0;
    window.clearTimeout(lowerTimer);
    lowerTimer = window.setTimeout(lower, LOWER_DELAY_MS);
    for (const page of pages) {
      const distance = Math.abs(page.index - index);
      setState(
        page,
        distance === 0 ? 'active' : distance === 1 ? 'near' : 'off',
      );
    }
  }

  // Before a gesture can show a neighbour, it must not be `off`. Neighbours
  // already near were drawn in idle time (warmNeighbours), so the press
  // that starts a swipe does no page work.
  function prepareNeighbours() {
    for (const i of [index - 1, index + 1]) {
      const page = pages[i];
      if (page?.state === 'off') setState(page, 'near');
    }
  }

  function setState(page, state) {
    if (page.state === state) return;
    const was = page.state;
    page.state = state;
    page.el.dataset.state = state;
    page.el.setAttribute('aria-hidden', state === 'active' ? 'false' : 'true');
    // Only pages out of reach are inert. Toggling inert restyles a page's
    // whole subtree, and a page turns active in the middle of its motion:
    // measured on a Hub, that cost about 100 ms of style and layout in the
    // swipe's frames. Neighbours stay out of view (and aria-hidden) instead.
    const inert = state === 'off';
    if ('inert' in page.el && page.el.inert !== inert) page.el.inert = inert;
    if (state === 'near' && was !== 'active') callHook(page, 'prepare');
    if (state === 'off') callHook(page, 'sleep');
  }

  function callHook(page, name) {
    const fn = page?.hooks?.[name];
    if (typeof fn !== 'function') return;
    try {
      fn(page.el);
    } catch (error) {
      console.warn(`[pages] ${page.id}.${name} failed`, error);
    }
  }

  function syncDots() {
    if (!dots) return;
    const children = dots.children;
    for (let i = 0; i < children.length; i += 1) {
      // One dot per page the pager contains.
      const shown = i < pages.length;
      if (children[i].style) children[i].style.display = shown ? '' : 'none';
      children[i].classList.toggle('current', i === index);
    }
  }

  // ── Gestures ──

  // While a modal dialog is open on a page, the pages stay where they are.
  function modalOpen() {
    return Boolean(pager.querySelector('.bedtime-overlay:not([hidden])'));
  }

  function ignoredTarget(target) {
    for (let node = target; node && node !== pager; node = node.parentElement) {
      if (node.dataset?.pager === 'ignore') return true;
      if (node.tagName === 'INPUT' && node.type === 'range') return true;
    }
    return false;
  }

  function onPointerDown(event) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    // A new press ends any click swallowing left from the last swipe (a touch
    // swipe, or a bridge swipe released over another control, has no click).
    swallowClick = false;
    if (gesture || !pager.contains(event.target)) return;
    if (ignoredTarget(event.target) || modalOpen()) return;
    const catching = Boolean(animation || wheel);
    if (catching) stopAnimation(true);
    if (wheel) {
      // The press takes over from a horizontal wheel that has not settled.
      window.clearTimeout(wheel.timer);
      wheel = null;
    }
    window.clearTimeout(nearTimer);
    prepareNeighbours();
    gesture = {
      id: event.pointerId,
      type: event.pointerType || 'mouse',
      x0: event.clientX,
      y0: event.clientY,
      downX: event.clientX,
      downY: event.clientY,
      moved: false,
      startOffset: unrubber(offset),
      dragging: catching,
      press: [event.timeStamp || clock(), offset],
      samples: [],
    };
    if (catching) beginDrag(event);
  }

  function beginDrag(event) {
    lift();
    gesture.dragging = true;
    gesture.x0 = event.clientX;
    gesture.startOffset = unrubber(offset);
    try {
      event.target.setPointerCapture?.(event.pointerId);
    } catch {
      // Synthetic pointers (the bridge) cannot be captured; they bubble.
    }
    if (probe.enabled) probeStart();
  }

  function onPointerMove(event) {
    if (!gesture || event.pointerId !== gesture.id) return;
    if (follow(event) && event.cancelable) event.preventDefault();
  }

  // Moves the pages with a pointer position; false while it is not (or no
  // longer) a horizontal swipe. Also run with the release's own position:
  // the bridge sends held moves once per frame but a release at once, so a
  // fast swipe may reach the release with few or no moves.
  function follow(event) {
    // A press that went further than a tap's wobble, in any direction, is
    // not a tap: its click is swallowed whatever the pages did (the bridge
    // would otherwise click a control a diagonal drag ended on).
    if (
      Math.abs(event.clientX - gesture.downX) > TAP_SLOP ||
      Math.abs(event.clientY - gesture.downY) > TAP_SLOP
    )
      gesture.moved = true;
    // A vertical move belongs to the page, and after a resize a held pointer
    // no longer moves the pages; both are tracked to the release.
    if (gesture.vertical || gesture.cancelled) return false;
    const dx = event.clientX - gesture.x0;
    if (!gesture.dragging) {
      const dy = event.clientY - gesture.y0;
      const slop = gesture.type === 'touch' ? TOUCH_SLOP : MOUSE_SLOP;
      if (Math.abs(dy) > slop && Math.abs(dy) >= Math.abs(dx)) {
        gesture.vertical = true;
        return false;
      }
      if (Math.abs(dx) <= slop || Math.abs(dx) < Math.abs(dy) * LOCK_RATIO)
        return false;
      beginDrag(event);
      // Start from the lock point less the slop, so the page neither jumps
      // by the slop nor loses a long first move.
      gesture.x0 = event.clientX - Math.sign(dx) * (Math.abs(dx) - slop);
    }
    offset = rubber(gesture.startOffset + (event.clientX - gesture.x0));
    const samples = gesture.samples;
    // Only a change of position counts as motion: a release (or move) where
    // the pointer already was must not look like a fresh, fast sample.
    if ((samples[samples.length - 1] ?? gesture.press)[1] !== offset) {
      samples.push([event.timeStamp || clock(), offset]);
      if (samples.length > 8) samples.shift();
    }
    // Real pointermoves come once per frame, just before animation frames,
    // and the bridge sends its one move from inside a frame: writing here
    // shows the move in this frame rather than the next.
    write(offset);
    return true;
  }

  // The speed over the last ~90 ms of the drag. `samples` are the moves that
  // changed the position; `press` (optional) is where the drag began. A slow
  // main thread spaces moves out and delays the release, so "held still"
  // means a pause clearly longer than the spacing between actual moves (the
  // wait from the press to the first move does not count).
  function stillAfter(samples) {
    const n = samples.length;
    if (n < 2) return STILL_MS;
    const intervals = Math.min(3, n - 1);
    const spacing =
      (samples[n - 1][0] - samples[n - 1 - intervals][0]) / intervals;
    return Math.max(STILL_MS, spacing * 2.5);
  }

  function releaseVelocity(samples, now, press) {
    const n = samples.length;
    const last = samples[n - 1];
    if (!last) return 0;
    if (now - last[0] > stillAfter(samples)) return 0;
    // The press counts towards the speed while it is within the window.
    const points = press ? [press, ...samples] : samples;
    let first = points[points.length - 2];
    if (!first) return 0;
    for (let i = points.length - 3; i >= 0; i -= 1) {
      if (last[0] - points[i][0] > VELOCITY_WINDOW_MS) break;
      first = points[i];
    }
    // A move and a release in the same instant (the bridge, a stalled
    // thread) count as one frame; and no release throws the pages wildly.
    const dt = Math.max(last[0] - first[0], MIN_VELOCITY_DT_MS);
    const velocity = (last[1] - first[1]) / dt;
    return Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, velocity));
  }

  function onPointerUp(event) {
    if (!gesture || event.pointerId !== gesture.id) return;
    const g = gesture;
    const now = event.timeStamp || clock();
    // Held still before the release: judged before the release's own
    // position is added, so a last pixel cannot revive an earlier flick.
    const before = g.samples[g.samples.length - 1] ?? g.press;
    const held = now - before[0] > stillAfter(g.samples);
    if (
      event.type === 'pointerup' &&
      Number.isFinite(event.clientX) &&
      Number.isFinite(event.clientY)
    )
      follow(event);
    gesture = null;
    if (!g.dragging || g.cancelled || g.vertical) {
      // Not a swipe of the pages (or a resize already put them at rest).
      if (g.dragging || g.moved) swallowSwipeClick();
      settled();
      return;
    }
    swallowSwipeClick();
    let velocity = 0;
    if (event.type !== 'pointercancel') {
      if (!held) velocity = releaseVelocity(g.samples, now, g.press);
      else if (Math.abs(offset - before[1]) > TAP_SLOP)
        // After a pause, a real move that arrives only with the release (the
        // bridge sends it at once) is a new flick of its own; a last pixel
        // or two is not.
        velocity = releaseVelocity([before, [now, offset]], now);
    }
    finish(velocity);
  }

  // Picks the page a release lands on: the nearest page to where the motion
  // would carry, at most one page away, and a flick always turns the page.
  function finish(velocity, turnAt = 0.5) {
    const from = index;
    // A dialog opened during the gesture keeps its page on screen.
    if (modalOpen()) {
      settle(from, 0);
      return;
    }
    const moved = offset - base(from); // < 0: towards the next page
    let target = from;
    const projected = moved + velocity * PROJECTION_MS;
    if (projected < -width * turnAt) target = from + 1;
    else if (projected > width * turnAt) target = from - 1;
    else if (velocity < -FLING_VELOCITY && moved < 0) target = from + 1;
    else if (velocity > FLING_VELOCITY && moved > 0) target = from - 1;
    target = Math.max(0, Math.min(maxIndex(), target));
    // Past an edge the rubber band brings it back without extra speed.
    const atEdge = offset > 0 || offset < base(maxIndex());
    settle(target, atEdge ? velocity * 0.3 : velocity);
  }

  // A swipe's release may be followed by a click on the control it ended
  // over: the browser's for a mouse, the bridge's own after its mouseup. Both
  // come in the same task as the release, so only a click before the next
  // task is swallowed; a touch swipe has no click, and nothing later is
  // touched.
  function swallowSwipeClick() {
    swallowClick = true;
    window.clearTimeout(swallowTimer);
    swallowTimer = window.setTimeout(() => {
      swallowClick = false;
    }, 0);
  }

  function onClick(event) {
    if (!swallowClick || !pager.contains(event.target)) return;
    swallowClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  // ── Wheel ──

  function scrollsVertically(target) {
    for (let node = target; node && node !== pager; node = node.parentElement) {
      if (node.scrollHeight > node.clientHeight + 1) {
        const overflow = getComputedStyle(node).overflowY;
        if (overflow === 'auto' || overflow === 'scroll') return true;
      }
    }
    return false;
  }

  function onWheel(event) {
    if (!pager.contains(event.target) || ignoredTarget(event.target)) return;
    if (modalOpen()) return;
    const scale =
      event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? width : 1;
    const dx = event.deltaX * scale;
    const dy = event.deltaY * scale;
    if (Math.abs(dx) > Math.abs(dy)) {
      event.preventDefault();
      wheelDrag(event, dx);
      return;
    }
    if (!dy || gesture || wheel || scrollsVertically(event.target)) return;
    event.preventDefault();
    const now = clock();
    if (now < wheelStepUntil) {
      wheelStepUntil = now + WHEEL_COOLDOWN_MS / 2; // swallow the momentum tail
      return;
    }
    wheelStepAccum += dy;
    if (Math.abs(wheelStepAccum) < WHEEL_STEP) return;
    const step = wheelStepAccum > 0 ? 1 : -1;
    wheelStepAccum = 0;
    wheelStepUntil = now + WHEEL_COOLDOWN_MS;
    go(index + step);
  }

  function wheelDrag(event, dx) {
    // A held press that is not moving the pages (vertical, or held through a
    // resize) leaves paging to the wheel; it still swallows its own click.
    if (gesture && !gesture.vertical && !gesture.cancelled) return;
    const now = event.timeStamp || clock();
    if (!wheel) {
      stopAnimation(true);
      window.clearTimeout(nearTimer);
      prepareNeighbours();
      lift();
      wheel = { raw: unrubber(offset), samples: [], timer: 0 };
      if (probe.enabled) probeStart();
    }
    wheel.raw -= dx;
    offset = rubber(wheel.raw);
    wheel.samples.push([now, offset]);
    if (wheel.samples.length > 8) wheel.samples.shift();
    requestDraw();
    window.clearTimeout(wheel.timer);
    wheel.timer = window.setTimeout(() => {
      const w = wheel;
      wheel = null;
      // A trackpad's own momentum has mostly ended by now, so a fifth of a
      // page is enough to turn it, and only the tail's speed carries on.
      const last = w.samples[w.samples.length - 1];
      const velocity = last ? releaseVelocity(w.samples, last[0]) * 0.5 : 0;
      finish(Number.isFinite(velocity) ? velocity : 0, 0.2);
    }, WHEEL_IDLE_MS);
  }

  function onKey(event) {
    if (event.defaultPrevented || event.altKey || event.ctrlKey) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (modalOpen()) return;
    if (event.key === 'ArrowRight') go(index + 1);
    else if (event.key === 'ArrowLeft') go(index - 1);
    else return;
    event.preventDefault();
  }

  function go(target) {
    const i =
      typeof target === 'string'
        ? pages.findIndex((page) => page.id === target)
        : target;
    if (!Number.isInteger(i) || i < 0 || i > maxIndex()) return false;
    if (gesture || wheel || modalOpen()) return false;
    stopAnimation(true);
    window.clearTimeout(nearTimer);
    // A jump of more than one page shows only the target's neighbour on the way.
    if (Math.abs(i - index) > 1) {
      offset = base(i + (i > index ? -1 : 1));
      write(offset);
    }
    setState(pages[i], pages[i].state === 'off' ? 'near' : pages[i].state);
    settle(i, 0);
    return true;
  }

  // Which pages the pager contains (hub-policy.js). A page that is left out is
  // taken out of the track, not just hidden, so a swipe goes straight to the
  // next page that is in; the pages that remain close up. `null` (or an empty
  // list) brings back the usual pages, that is every page but the conditional
  // ones. Returns false while a finger or the wheel
  // is moving the pages: the caller asks again.
  function setAvailable(ids) {
    const wanted = Array.isArray(ids)
      ? allPages.filter((page) => ids.includes(page.id))
      : usualPages.slice();
    if (!wanted.length) return setAvailable(null);
    if (
      wanted.length === pages.length &&
      wanted.every((page, i) => page === pages[i])
    )
      return true;
    if (gesture || wheel) return false;
    stopAnimation(false);
    window.clearTimeout(nearTimer);
    const shown = pages[index];
    pages.splice(0, pages.length, ...wanted);
    for (const page of allPages) {
      const out = !wanted.includes(page);
      page.el.style.display = out ? 'none' : '';
      if (out) setState(page, 'off');
    }
    wanted.forEach((page, i) => {
      page.index = i;
      page.el.style.left = `${i * 100}%`;
    });
    const kept = wanted.indexOf(shown);
    index = kept >= 0 ? kept : 0;
    offset = base(index);
    drawn = NaN;
    write(offset);
    syncDots();
    if (kept < 0) {
      // The page on screen is gone: the first page that is left takes over.
      announcements.push({ page: pages[0].id, previous: shown.id });
      setState(pages[0], 'active');
      enterCurrent();
    }
    syncStates();
    announce();
    return true;
  }

  function onResize() {
    const next = window.innerWidth || width;
    if (next === width) return;
    // Whatever moved stops on the current page at the new width.
    stopAnimation(false);
    if (wheel) window.clearTimeout(wheel.timer);
    wheel = null;
    // A held pointer stays tracked until its release, so a swipe's click is
    // still swallowed, but it no longer moves the pages.
    if (gesture) gesture.cancelled = true;
    width = next;
    offset = base(index);
    write(offset);
    window.clearTimeout(nearTimer);
    motionEnded();
  }

  // ── Optional frame probe (Info page): rAF gaps during gestures only ──

  function probeStart() {
    probe.last = 0;
    if (!probe.frame) probe.frame = requestAnimationFrame(probeLoop);
  }
  function probeLoop(now) {
    probe.frame = 0;
    probeTick(now);
    if (animation || gesture?.dragging || wheel)
      probe.frame = requestAnimationFrame(probeLoop);
    else probe.last = 0;
  }
  function probeTick(now = clock()) {
    if (!probe.enabled) return;
    if (probe.last) {
      probe.gaps.push(now - probe.last);
      if (probe.gaps.length > 600)
        probe.gaps.splice(0, probe.gaps.length - 600);
    }
    probe.last = now;
  }
  function probeStop() {
    probe.last = 0;
  }

  // ── Wiring ──

  pager.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointermove', onPointerMove, {
    capture: true,
    passive: false,
  });
  document.addEventListener('pointerup', onPointerUp, true);
  document.addEventListener('pointercancel', onPointerUp, true);
  window.addEventListener('click', onClick, true);
  pager.addEventListener('wheel', onWheel, { capture: true, passive: false });
  window.addEventListener('keydown', onKey);
  // Neighbours are not inert, so focus could land on one out of view; it is
  // sent back, and the pager never scrolls to show it.
  pager.addEventListener('focusin', (event) => {
    const page = event.target.closest?.('.hub-page');
    if (!page || page === pages[index].el) return;
    event.target.blur?.();
    if (pager.scrollLeft) pager.scrollLeft = 0;
  });
  window.addEventListener('resize', onResize);

  setAvailable(null);
  write(0);
  pages.forEach((page, i) => setState(page, i === 0 ? 'active' : 'off'));
  syncStates();
  syncDots();
  warmTimer = window.setTimeout(warmNeighbours, WARM_FIRST_MS);
  window.addEventListener('pagehide', () => window.clearTimeout(warmTimer));

  // The page modules register their hooks here; later, context switching
  // (music starts, a camera event, idle → photos) calls `go`.
  globalThis.lugnPages = {
    go,
    current: () => pages[index].id,
    ids: () => pages.map((page) => page.id),
    // Every page there is, including those Hub rules have taken out.
    all: () => allPages.map((page) => page.id),
    setAvailable,
    define(id, hooks) {
      const page = allPages.find((p) => p.id === id);
      if (!page) return;
      page.hooks = hooks || {};
      if (page.state === 'near') callHook(page, 'prepare');
      if (page.state === 'active') {
        entered = page;
        callHook(page, 'enter');
      }
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    probe: {
      set enabled(on) {
        probe.enabled = Boolean(on);
        if (!on) probe.gaps.length = 0;
      },
      get enabled() {
        return probe.enabled;
      },
      gaps: () => probe.gaps.slice(),
      clear: () => {
        probe.gaps.length = 0;
      },
    },
  };
})();
