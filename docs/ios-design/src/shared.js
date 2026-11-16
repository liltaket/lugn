/* Lugn iOS prototypes: shared behaviour. Plain JS, no dependencies. */
window.Lugn = (() => {
  const root = document.documentElement;
  const q = new URLSearchParams(location.search);
  if (q.get('theme')) root.dataset.theme = q.get('theme');
  if (q.has('safe')) root.dataset.safe = '';
  if (q.has('solid')) root.dataset.solid = '';
  if (q.has('shot')) root.dataset.shot = '';
  else
    requestAnimationFrame(() =>
      requestAnimationFrame(() => (root.dataset.ready = '')),
    );
  const light = () => root.dataset.theme === 'light';

  /* Scene pictograms: 24 grid, 1.6 stroke, round caps. Same family as the Hub. */
  const PIC = {
    off: '<path d="M12 3.8v7.6"/><path d="M7 6.9a7.4 7.4 0 1 0 10 0"/>',
    mys: '<path d="M19.4 14.6A8 8 0 0 1 9.4 4.6a8 8 0 1 0 10 10z"/>',
    vardag:
      '<circle cx="12" cy="12" r="3.7"/><path d="M12 3.2v2.2M12 18.6v2.2M3.2 12h2.2M18.6 12h2.2M5.8 5.8l1.5 1.5M16.7 16.7l1.5 1.5M5.8 18.2l1.5-1.5M16.7 7.3l1.5-1.5"/>',
    film: '<rect x="3.4" y="4.8" width="17.2" height="11.6" rx="2.4"/><path d="M10.5 8.4v4.4l3.8-2.2z"/><path d="M8.4 19.6h7.2"/>',
    fokus:
      '<path d="M5.5 20.2h8"/><path d="M9.5 20.2v-6.4l4-5"/><path d="M11.6 6.2l6.2 4.9-.9 1.2a4 4 0 0 1-6.2-4.9z"/><path d="M17.6 15.2l.9 1.2M14.6 16.4v1.5M20 12.8l1.4.5"/>',
    party:
      '<path d="M12 2.8v3.4"/><circle cx="12" cy="13.6" r="7.2"/><path d="M4.8 13.6h14.4M6.3 9.6h11.4M6.3 17.6h11.4"/><path d="M12 6.4c-2.6 2-2.6 12.4 0 14.4M12 6.4c2.6 2 2.6 12.4 0 14.4"/>',
    tick: '<path d="M5 12.6l4.4 4.4L19 7.4"/>',
    chev: '<path d="M9 5.5l6.5 6.5L9 18.5"/>',
    back: '<path d="M14.5 5.5L8 12l6.5 6.5"/>',
    moon: '<path d="M19.4 14.6A8 8 0 0 1 9.4 4.6a8 8 0 1 0 10 10z"/><path d="M17.2 3.6v3.2M15.6 5.2h3.2"/>',
    warn: '<path d="M12 4.2l8.4 14.6H3.6z"/><path d="M12 10v4.2M12 16.6v.2"/>',
    wifiOff:
      '<path d="M4 4l16 16"/><path d="M8.6 15.4a5 5 0 0 1 6.2-.5M5.4 12a9.4 9.4 0 0 1 3.4-2.2M12.4 8.6a9.6 9.6 0 0 1 6.4 3.2M2.6 8.6a14 14 0 0 1 3-2M10.6 5a14 14 0 0 1 10.8 3.6"/><circle cx="12" cy="18.6" r=".7"/>',
    person:
      '<circle cx="12" cy="8" r="3.4"/><path d="M5.2 20c.6-4 3.4-6 6.8-6s6.2 2 6.8 6"/>',
    play: '<path d="M8 5.2v13.6L19 12z" fill="currentColor"/>',
    pause: '<path d="M8.5 5.5v13M15.5 5.5v13" stroke-width="2.6"/>',
    next: '<path d="M6 6v12l9-6z" fill="currentColor"/><path d="M18 6v12" stroke-width="2.2"/>',
    prev: '<path d="M18 6v12l-9-6z" fill="currentColor"/><path d="M6 6v12" stroke-width="2.2"/>',
    bulb: '<path d="M9 17.4h6M10 20.4h4"/><path d="M8.4 14.6a6 6 0 1 1 7.2 0c-.6.5-.9 1-.9 1.6H9.3c0-.6-.3-1.1-.9-1.6z"/>',
    plus: '<path d="M12 5.5v13M5.5 12h13"/>',
    minus: '<path d="M5.5 12h13"/>',
    more: '<circle cx="6" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="18" cy="12" r="1.2" fill="currentColor"/>',
    x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  };
  const svg = (name, extra = '') =>
    `<svg viewBox="0 0 24 24" aria-hidden="true" ${extra}>${PIC[name]}</svg>`;

  /* Room light per scene: three pools (bed lamp, desk lamp, wash) and intensity k (0..1). */
  const SCENES = {
    off: {
      name: 'Helt släckt',
      hint: 'Allt av',
      p: ['#16263a', '#0e1a2a', '#0a121c'],
      k: 0.55,
      pl: ['#c9d6de', '#d6dfe4', '#dfe6e8'],
      kl: 0.5,
    },
    mys: {
      name: 'Mysljus',
      hint: '35 %, glöd',
      p: ['#ff9a45', '#ffb066', '#c85f2a'],
      k: 0.9,
      pl: ['#ffc48a', '#ffd3a6', '#ffe1c2'],
      kl: 0.95,
    },
    vardag: {
      name: 'Vardagsljus',
      hint: '60 %, varmt',
      p: ['#ffc07c', '#ffd29c', '#f0a45c'],
      k: 0.8,
      pl: ['#ffd9ae', '#ffe6c8', '#fff0dc'],
      kl: 0.9,
    },
    film: {
      name: 'Filmkväll',
      hint: '15 %, skärmljus',
      p: ['#c9542a', '#3f5bf0', '#7a2f22'],
      k: 0.8,
      pl: ['#f2b89c', '#b9c6ff', '#f3d6c8'],
      kl: 0.8,
    },
    fokus: {
      name: 'Fokus',
      hint: '100 %, 4000 K',
      p: ['#f6ecdc', '#dfe9f4', '#fff3df'],
      k: 0.76,
      pl: ['#ffffff', '#d6e4f5', '#fff1d6'],
      kl: 1,
    },
    party: {
      name: 'Party',
      hint: 'Färg, rörelse',
      p: ['#ff3f9a', '#3cc4ff', '#7a4cff'],
      k: 0.95,
      pl: ['#ffb3d8', '#b3e6ff', '#d2c2ff'],
      kl: 0.9,
    },
  };
  const ORDER = ['off', 'mys', 'vardag', 'film', 'fokus', 'party'];

  function setField(scene, level = 1) {
    const s = SCENES[scene];
    if (!s) return;
    const p = light() ? s.pl : s.p;
    root.style.setProperty('--p1', p[0]);
    root.style.setProperty('--p2', p[1]);
    root.style.setProperty('--p3', p[2]);
    root.style.setProperty('--k', String((light() ? s.kl : s.k) * level));
  }

  /* Haptics: logged for designers, vibrates on devices that can. */
  const HAPTIC_MS = {
    selection: 4,
    soft: 8,
    light: 10,
    medium: 16,
    rigid: 12,
    heavy: 24,
    success: [10, 60, 14],
    warning: [14, 80, 14],
    error: [18, 50, 18, 50, 18],
  };
  function haptic(type, where = '') {
    const log = document.querySelector('.haptic-log');
    if (log) {
      const d = document.createElement('div');
      d.textContent = `${type}${where ? '  · ' + where : ''}`;
      log.querySelector('b').after(d);
      while (log.children.length > 7) log.lastChild.remove();
    }
    if (navigator.vibrate)
      try {
        navigator.vibrate(HAPTIC_MS[type] || 8);
      } catch {
        /* vibration is optional */
      }
  }

  /* Fader: follows the finger 1:1, snaps to named detents inside a magnet zone,
     ticks softly every `tick` units. el must contain nothing that captures pointers. */
  function fader(
    el,
    {
      axis = 'y',
      value = 50,
      min = 0,
      max = 100,
      detents = [],
      magnet = 3,
      tick = 10,
      name = 'reglage',
      onChange,
    } = {},
  ) {
    let v = value,
      lastTick = Math.round(value / tick),
      lastDetent = null,
      t0 = 0,
      v0 = value;
    const set = (nv, fromUser) => {
      v = Math.min(max, Math.max(min, nv));
      el.style.setProperty('--v', String((v - min) / (max - min)));
      el.setAttribute('aria-valuenow', String(Math.round(v)));
      onChange?.(v, fromUser);
    };
    const read = (e) => {
      const r = el.getBoundingClientRect();
      const f =
        axis === 'y'
          ? 1 - (e.clientY - r.top) / r.height
          : (e.clientX - r.left) / r.width;
      return min + Math.min(1, Math.max(0, f)) * (max - min);
    };
    const move = (e) => {
      let nv = read(e);
      const now = performance.now();
      const speed = (Math.abs(nv - v0) / Math.max(1, now - t0)) * 1000; // units per second
      t0 = now;
      v0 = nv;
      const d = detents.find((x) => Math.abs(x - nv) <= magnet);
      if (d !== undefined && speed < 220) nv = d;
      if (d !== undefined && d !== lastDetent)
        haptic(
          d === min || d === max ? 'rigid' : 'selection',
          `${name}: hack ${d}`,
        );
      lastDetent = d === undefined ? null : d;
      const tk = Math.round(nv / tick);
      if (tk !== lastTick && d === undefined && speed < 160)
        haptic('soft', `${name}: steg`);
      lastTick = tk;
      set(nv, true);
    };
    el.setAttribute('role', 'slider');
    el.setAttribute('aria-valuemin', min);
    el.setAttribute('aria-valuemax', max);
    el.tabIndex = 0;
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      el.dataset.drag = '';
      t0 = performance.now();
      v0 = v;
      move(e);
    });
    el.addEventListener('pointermove', (e) => {
      if ('drag' in el.dataset) move(e);
    });
    const end = () => {
      delete el.dataset.drag;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('keydown', (e) => {
      const step = (max - min) / 20;
      if (['ArrowUp', 'ArrowRight'].includes(e.key)) {
        set(v + step, true);
        haptic('selection', name);
      }
      if (['ArrowDown', 'ArrowLeft'].includes(e.key)) {
        set(v - step, true);
        haptic('selection', name);
      }
    });
    set(value, false);
    return { set: (nv) => set(nv, false), get: () => v };
  }

  function tileHTML(scene, state = 'idle', st) {
    const s = SCENES[scene];
    const label =
      st || (state === 'on' ? (scene === 'off' ? 'Släckt' : 'Aktiv') : s.hint);
    return `<button class="tile" data-scene="${scene}" data-state="${state}" aria-pressed="${state === 'on'}" aria-label="${s.name}">
      <span class="fill"></span><span class="pic">${svg(scene)}</span>
      <span><span class="nm">${s.name}</span><span class="st">${svg('tick')}<span class="stt">${label}</span></span></span>
      <span class="wait"></span></button>`;
  }

  /* Scene tile: touch fills from the finger at once, device confirmation follows.
     opts.onHold(tile) opens the hold sheet; opts.outcome(scene) returns 'ok' | 'slow' | 'fail' | 'offline'. */
  function wireTiles(container, opts = {}) {
    const timers = new WeakMap();
    const setSt = (t, state, text) => {
      t.dataset.state = state;
      t.querySelector('.stt').textContent = text;
      t.setAttribute('aria-pressed', state === 'on');
    };
    container.addEventListener('pointerdown', (e) => {
      const t = e.target.closest('.tile');
      if (!t) return;
      const r = t.getBoundingClientRect();
      t.style.setProperty('--x', ((e.clientX - r.left) / r.width) * 100 + '%');
      t.style.setProperty('--y', ((e.clientY - r.top) / r.height) * 100 + '%');
      t.classList.add('pressed');
      haptic('soft', 'tryck ned');
      t._held = false;
      t._hold = setTimeout(() => {
        if (!opts.onHold) return;
        t._held = true;
        t.classList.remove('pressed');
        haptic('medium', 'håll: öppnar blad');
        opts.onHold(t);
      }, 380);
    });
    const cancel = (e) => {
      const t = e.target.closest?.('.tile');
      if (t) {
        clearTimeout(t._hold);
        t.classList.remove('pressed');
      }
    };
    container.addEventListener('pointerleave', cancel, true);
    container.addEventListener('pointercancel', cancel, true);
    container.addEventListener('pointerup', (e) => {
      const t = e.target.closest('.tile');
      if (!t) return;
      clearTimeout(t._hold);
      t.classList.remove('pressed');
      if (t._held) return;
      const scene = t.dataset.scene;
      const outcome = opts.outcome ? opts.outcome(scene) : 'ok';
      if (outcome === 'offline') {
        haptic('warning', 'offline: skickar inte');
        opts.onOffline?.(t);
        return;
      }
      container.querySelectorAll('.tile').forEach((o) => {
        if (o !== t && o.dataset.state !== 'idle') {
          (timers.get(o) || []).forEach(clearTimeout);
          setSt(o, 'idle', SCENES[o.dataset.scene].hint);
        }
      });
      (timers.get(t) || []).forEach(clearTimeout);
      setSt(t, 'sending', 'Skickar');
      setField(scene);
      opts.onSelect?.(scene, 'sending');
      const ts = [];
      ts.push(setTimeout(() => setSt(t, 'waiting', 'Väntar på lamporna'), 260));
      if (outcome === 'ok')
        ts.push(
          setTimeout(() => {
            setSt(t, 'on', scene === 'off' ? 'Släckt' : 'Aktiv');
            haptic('soft', 'bekräftat av lamporna');
            opts.onSelect?.(scene, 'on');
          }, 1150),
        );
      if (outcome === 'slow') {
        ts.push(setTimeout(() => setSt(t, 'slow', 'Svarar långsamt'), 2500));
        ts.push(
          setTimeout(() => {
            setSt(t, 'on', 'Aktiv');
            haptic('soft', 'bekräftat (sent)');
            opts.onSelect?.(scene, 'on');
          }, 5200),
        );
      }
      if (outcome === 'fail')
        ts.push(
          setTimeout(() => {
            setSt(t, 'failed', 'Gick inte. Tryck igen.');
            haptic('error', 'kommandot misslyckades');
            opts.onFail?.(scene);
          }, 2200),
        );
      timers.set(t, ts);
    });
    container.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /* Chrome shared by every screen. */
  const TABS = [
    [
      'hem',
      'Hem',
      'hem.html',
      '<path d="M4.5 11.2L12 4.6l7.5 6.6"/><path d="M6.4 9.8v9.4h11.2V9.8"/>',
    ],
    ['belysning', 'Belysning', 'belysning.html', PIC.bulb],
    [
      'musik',
      'Musik',
      'musik.html',
      '<path d="M9.2 17.6V6.2l9.6-1.8v11.2"/><circle cx="6.9" cy="17.6" r="2.3"/><circle cx="16.5" cy="15.6" r="2.3"/>',
    ],
    [
      'rutiner',
      'Rutiner',
      'godnatt.html',
      '<circle cx="12" cy="12" r="8"/><path d="M12 7.4V12l3 2"/>',
    ],
    [
      'installningar',
      'Inställningar',
      'telefon.html',
      '<path d="M4 7.5h9M17 7.5h3M4 16.5h3M11 16.5h9"/><circle cx="15" cy="7.5" r="2"/><circle cx="9" cy="16.5" r="2"/>',
    ],
  ];
  function chrome({
    time = '21:47',
    tab = null,
    why = null,
    statusInk = null,
  } = {}) {
    const dev = document.querySelector('.device');
    const sb = document.createElement('div');
    sb.className = 'statusbar';
    if (statusInk) sb.style.color = statusInk;
    sb.innerHTML = `<div class="clock">${time}</div><div class="island"></div><div class="sys">
      <svg width="18" height="12" viewBox="0 0 18 12"><rect x="0" y="8" width="3" height="4" rx=".8"/><rect x="5" y="5.5" width="3" height="6.5" rx=".8"/><rect x="10" y="3" width="3" height="9" rx=".8"/><rect x="15" y="0" width="3" height="12" rx=".8"/></svg>
      <svg width="17" height="12" viewBox="0 0 17 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" style="fill:none"><path d="M1.4 4.3a10.2 10.2 0 0 1 14.2 0"/><path d="M4 7a6.5 6.5 0 0 1 9 0"/><path d="M6.7 9.6a2.7 2.7 0 0 1 3.6 0"/></svg>
      <svg width="27" height="13" viewBox="0 0 27 13"><rect x=".5" y=".5" width="23" height="12" rx="3.6" fill="none" stroke="currentColor" opacity=".4"/><rect x="2" y="2" width="16.5" height="9" rx="2.2"/><path d="M25 4.5v4c.8-.3 1.5-1 1.5-2s-.7-1.7-1.5-2z" opacity=".45"/></svg></div>`;
    dev.append(sb);
    if (why) {
      const a = document.createElement('a');
      a.className = 'accessory glass';
      a.href = 'varfor.html';
      a.setAttribute('aria-label', `Varför? ${why.text}, ${why.t}`);
      a.innerHTML = `<span class="dot ${why.kind || ''}"></span><span class="a">${why.text}</span><time>${why.t}</time>`;
      dev.append(a);
    }
    if (tab) {
      const nav = document.createElement('nav');
      nav.className = 'tabbar glass';
      nav.setAttribute('aria-label', 'Flikar');
      nav.innerHTML = TABS.map(
        ([id, name, href, d]) =>
          `<a class="tab" href="${href}" ${id === tab ? 'aria-current="page"' : ''}><svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>${name}</a>`,
      ).join('');
      dev.append(nav);
    }
    const hb = document.createElement('div');
    hb.className = 'homebar';
    dev.append(hb);
    const safe = document.createElement('div');
    safe.className = 'safe';
    safe.innerHTML =
      '<i class="t"><span>säker yta topp 62</span></i><i class="reach"><span>tumzon: allt du styr ligger här</span></i><i class="b"><span>säker yta botten 34</span></i>';
    dev.append(safe);
    document.addEventListener('keydown', (e) => {
      if (e.key === 's') root.toggleAttribute('data-safe');
      if (e.key === 't') root.dataset.theme = light() ? 'dark' : 'light';
      if (e.key === 'g') root.toggleAttribute('data-solid');
    });
  }

  return {
    q,
    PIC,
    svg,
    SCENES,
    ORDER,
    setField,
    haptic,
    fader,
    tileHTML,
    wireTiles,
    chrome,
    light,
  };
})();
