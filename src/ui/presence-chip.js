// The presence chip: a small capsule in the top left corner of every page but
// Hem (which has its own, in the clock), Info and Inställningar. The quiet count is drawn only
// while the navbar is open, so a photo or the clock is never marked by it. The
// amber looks come up by themselves, navbar or not: they are not the normal
// case, and if the sensor sees nobody and nobody corrects it, nobody is there.
//
// It has three looks:
//   steady   the sensor's count, as a quiet reading that also corrects. Only
//            with the navbar open.
//            A tap sets the count to 1, as Hem's does, when it is not 1 already.
//   empty    the sensor sees nobody: an amber "Jag är här". One tap.
//   leaving  the sensor sees nobody and Lugn is about to switch off: an amber
//            "Jag är kvar" with the seconds left. One tap stops it.
//
// The words are all there is: no picture, no sentence. The correction is the
// same call as Hem's capsule (`presence:one`, see display.js), so it is
// attributed, acknowledged and reported (the toast reaches every page) the
// same way, and it only exists where a presence sensor is configured.
(() => {
  'use strict';

  const chip = document.getElementById('presence-chip');
  const pagesApi = globalThis.lugnPages;
  if (!chip) return;
  const button = chip.querySelector('.pc-button');
  const countEl = chip.querySelector('.pc-count');
  const labelEl = chip.querySelector('.pc-label');
  const timeEl = chip.querySelector('.pc-time');
  const barEl = chip.querySelector('.pc-bar');

  // Pages where the chip is not drawn: Hem has its own, Info is for diagnosis.
  const QUIET = new Set(['home', 'info', 'installningar']);

  let latest = null;
  let timer = 0;
  let drawn = '';

  const serverNow = () =>
    typeof estimatedServerNow === 'function'
      ? estimatedServerNow()
      : Date.now();
  const isBusy = () =>
    (typeof pending !== 'undefined' && pending.has('presence:one')) ||
    (typeof presenceAcknowledgedKey !== 'undefined' &&
      presenceAcknowledgedKey !== null);

  function set(el, name, value) {
    if (el.dataset[name] !== value) el.dataset[name] = value;
  }
  function text(el, value) {
    if (el.textContent !== value) el.textContent = value;
  }

  function clock(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  // What the chip should show for a payload, or null when it should not be on
  // the page at all (no sensor to correct, or a page that does without it).
  function model(payload) {
    const presence = payload?.state?.presence;
    if (!presence || payload?.presenceCountCorrectionAvailable !== true)
      return null;
    const page = pagesApi?.current?.();
    if (!page || QUIET.has(page)) return null;
    const count = presence.personCount;
    const exit = presence.exitPending;
    if (exit && typeof exit.until === 'number')
      return {
        mode: 'leaving',
        until: exit.until,
        total: Math.max(1, exit.until - (exit.startedAt ?? exit.until)),
      };
    if (presence.state === 'confirmed_empty') return { mode: 'empty' };
    const known = presence.state === 'occupied' && Number.isInteger(count);
    return {
      mode: 'steady',
      count: known && count > 0 ? String(count) : '?',
      // A count of one needs no correction.
      tap: !(known && count === 1),
    };
  }

  function stopTimer() {
    window.clearInterval(timer);
    timer = 0;
  }

  function draw() {
    const m = model(latest);
    if (!m) {
      stopTimer();
      if (!chip.hidden) chip.hidden = true;
      drawn = '';
      return;
    }
    if (chip.hidden) chip.hidden = false;
    const busy = isBusy();
    set(chip, 'mode', m.mode);
    const tappable = m.mode !== 'steady' || m.tap;
    set(chip, 'tap', String(tappable));
    button.disabled = busy || !tappable;
    button.setAttribute('aria-busy', String(busy));

    if (m.mode === 'steady') {
      text(countEl, m.count);
      text(labelEl, '');
      text(timeEl, '');
      button.setAttribute(
        'aria-label',
        m.count === '?'
          ? 'Närvaro okänd. Tryck för att sätta till 1 person'
          : `${m.count} ${m.count === '1' ? 'person' : 'personer'}${tappable ? '. Tryck för att sätta till 1 person' : ''}`,
      );
      stopTimer();
      barEl.style.transform = '';
    } else if (m.mode === 'empty') {
      text(labelEl, 'Jag är här');
      text(timeEl, '');
      button.setAttribute(
        'aria-label',
        'Rummet verkar tomt. Jag är här: sätt till 1 person',
      );
      stopTimer();
      barEl.style.transform = '';
    } else {
      text(labelEl, 'Jag är kvar');
      const left = m.until - serverNow();
      text(timeEl, clock(left));
      barEl.style.transform = `scaleX(${Math.max(0, Math.min(1, left / m.total))})`;
      button.setAttribute(
        'aria-label',
        `Släcker om ${clock(left)}. Jag är kvar: sätt till 1 person`,
      );
      // Once a second while it counts down, and not otherwise.
      if (!timer) timer = window.setInterval(draw, 1000);
    }
    drawn = m.mode;
  }

  // The chip lies outside the pager and the pages, so a press on it is neither
  // a swipe nor a tap on the bare page that opens the navbar.
  button.addEventListener('click', () => {
    if (button.disabled) return;
    if (typeof runCommand === 'function') void runCommand('presence:one', {});
  });

  window.addEventListener('lugn:page', draw);

  globalThis.lugnPresenceChip = {
    render(payload) {
      latest = payload;
      draw();
    },
    mode: () => drawn,
  };
})();
