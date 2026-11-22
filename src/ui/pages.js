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
  const MOUSE_SLOP = 6;
  const LOCK_RATIO = 1.2; // |dx| must beat |dy| by this much
  const VELOCITY_WINDOW_MS = 90;
  const STILL_MS = 60; // pointer held still this long before release: no fling
  const FLING_VELOCITY = 0.3; // px/ms: a flick past this turns the page
  const PROJECTION_MS = 160; // how far a release velocity carries
  const RUBBER = 0.55; // edge resistance (iOS-like)
  const SPRING_RESPONSE = 0.36; // s, period of the undamped spring
  const SPRING_DAMPING = 0.9; // < 1 gives a little overshoot on a fast flick
  const SAMPLE_MS = 1000 / 60;
  const WHEEL_IDLE_MS = 140;
  const WHEEL_STEP = 40; // vertical wheel px for one page
  const WHEEL_COOLDOWN_MS = 450;
  const CLICK_SWALLOW_MS = 500;
  const NEAR_DELAY_MS = 80; // after a settle, before neighbours are prepared
  const LOWER_DELAY_MS = 400; // then the track stops being its own layer

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
  let swallowClickUntil = 0;
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

  // The track is its own compositor layer only while it moves (and briefly
  // after). At rest it is painted with the page, exactly as without pages;
  // as a layer it would draw text with different anti-aliasing.
  let lifted = false;
  let lowerTimer = 0;
  function lift() {
    window.clearTimeout(lowerTimer);
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
    // The bridge (and anything else) may measure the page again now.
    window.dispatchEvent?.(new Event('lugn:pages-settled'));
  }

  function requestDraw() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      write(offset);
      probeTick();
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
      settled();
      return;
    }
    const samples = springSamples(from, to, velocity);
    const duration = (samples.length - 1) * SAMPLE_MS;
    offset = to;
    if (typeof track.animate !== 'function') {
      write(to);
      settled();
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
      settled();
    };
    if (probe.enabled) probeStart();
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

  function setIndex(target) {
    if (target === index) return;
    const previous = pages[index];
    index = target;
    syncDots();
    callHook(previous, 'leave');
    setState(pages[index], 'active');
    callHook(pages[index], 'enter');
    for (const fn of listeners) {
      try {
        fn(pages[index].id, previous.id);
      } catch (error) {
        console.warn('[pages] listener failed', error);
      }
    }
  }

  // After a settle the other pages are made near or off, a little later, so
  // the end of the motion is not where their paint lands.
  function settled() {
    window.clearTimeout(nearTimer);
    nearTimer = window.setTimeout(syncStates, NEAR_DELAY_MS);
    if (probe.enabled) probeStop();
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

  // Before a gesture can show a neighbour, it must not be `off`.
  function prepareNeighbours() {
    for (const i of [index - 1, index + 1]) {
      const page = pages[i];
      if (page && page.state === 'off') setState(page, 'near');
    }
  }

  function setState(page, state) {
    if (page.state === state) return;
    const was = page.state;
    page.state = state;
    page.el.dataset.state = state;
    page.el.setAttribute('aria-hidden', state === 'active' ? 'false' : 'true');
    if ('inert' in page.el) page.el.inert = state !== 'active';
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
    for (let i = 0; i < children.length; i += 1)
      children[i].classList.toggle('current', i === index);
  }

  // ── Gestures ──

  function ignoredTarget(target) {
    for (let node = target; node && node !== pager; node = node.parentElement) {
      if (node.dataset?.pager === 'ignore') return true;
      if (node.tagName === 'INPUT' && node.type === 'range') return true;
    }
    return false;
  }

  function onPointerDown(event) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (gesture || !pager.contains(event.target)) return;
    if (ignoredTarget(event.target)) return;
    const catching = Boolean(animation);
    if (catching) stopAnimation(true);
    window.clearTimeout(nearTimer);
    prepareNeighbours();
    gesture = {
      id: event.pointerId,
      type: event.pointerType || 'mouse',
      x0: event.clientX,
      y0: event.clientY,
      startOffset: unrubber(offset),
      dragging: catching,
      samples: [[event.timeStamp || clock(), offset]],
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
    const dx = event.clientX - gesture.x0;
    if (!gesture.dragging) {
      const dy = event.clientY - gesture.y0;
      const slop = gesture.type === 'touch' ? TOUCH_SLOP : MOUSE_SLOP;
      if (Math.abs(dy) > slop && Math.abs(dy) >= Math.abs(dx)) {
        gesture = null; // a vertical move belongs to the page
        settled();
        return;
      }
      if (Math.abs(dx) <= slop || Math.abs(dx) < Math.abs(dy) * LOCK_RATIO)
        return;
      beginDrag(event);
      // Start from the lock point, so the page does not jump by the slop.
      gesture.x0 = event.clientX;
    }
    if (event.cancelable) event.preventDefault();
    offset = rubber(gesture.startOffset + (event.clientX - gesture.x0));
    const samples = gesture.samples;
    samples.push([event.timeStamp || clock(), offset]);
    if (samples.length > 8) samples.shift();
    // Real pointermoves come once per frame, just before animation frames,
    // and the bridge sends its one move from inside a frame: writing here
    // shows the move in this frame rather than the next.
    write(offset);
    probeTick();
  }

  // The speed over the last ~90 ms of the drag (at least two moves). A slow
  // main thread spaces moves out and delays the release, so "held still"
  // means a pause clearly longer than the moves' own spacing.
  function releaseVelocity(samples, now) {
    const n = samples.length;
    const last = samples[n - 1];
    if (!last || n < 2) return 0;
    let first = samples[n - 2];
    for (let i = n - 3; i >= 0; i -= 1) {
      if (last[0] - samples[i][0] > VELOCITY_WINDOW_MS) break;
      first = samples[i];
    }
    const spacing =
      (last[0] - samples[Math.max(0, n - 4)][0]) / Math.min(3, n - 1);
    if (now - last[0] > Math.max(STILL_MS, spacing * 2.5)) return 0;
    const dt = last[0] - first[0];
    return dt > 0 ? (last[1] - first[1]) / dt : 0;
  }

  function onPointerUp(event) {
    if (!gesture || event.pointerId !== gesture.id) return;
    const g = gesture;
    gesture = null;
    if (!g.dragging) {
      settled();
      return;
    }
    swallowClickUntil = clock() + CLICK_SWALLOW_MS;
    const velocity =
      event.type === 'pointercancel'
        ? 0
        : releaseVelocity(g.samples, event.timeStamp || clock());
    finish(velocity);
  }

  // Picks the page a release lands on: the nearest page to where the motion
  // would carry, at most one page away, and a flick always turns the page.
  function finish(velocity, turnAt = 0.5) {
    const from = index;
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

  function onClick(event) {
    if (!swallowClickUntil || clock() > swallowClickUntil) return;
    swallowClickUntil = 0;
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
    if (gesture) return;
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
    if (gesture || wheel) return false;
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

  function onResize() {
    const next = window.innerWidth || width;
    if (next === width) return;
    stopAnimation(false);
    width = next;
    offset = base(index);
    write(offset);
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
  window.addEventListener('resize', onResize);

  write(0);
  pages.forEach((page, i) => setState(page, i === 0 ? 'active' : 'off'));
  syncStates();
  syncDots();

  // The page modules register their hooks here; later, context switching
  // (music starts, a camera event, idle → photos) calls `go`.
  globalThis.lugnPages = {
    go,
    current: () => pages[index].id,
    ids: () => pages.map((page) => page.id),
    define(id, hooks) {
      const page = pages.find((p) => p.id === id);
      if (!page) return;
      page.hooks = hooks || {};
      if (page.state === 'near') callHook(page, 'prepare');
      if (page.state === 'active') callHook(page, 'enter');
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
