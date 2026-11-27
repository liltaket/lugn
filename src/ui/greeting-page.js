// Hälsning (halsning): one page for Godmorgon, Godnatt, Välkommen hem and the
// dimmed night, with a change of words and light on special days.
// It shows a greeting, one fact, up to three actions and the weather. Only real
// data is read from latestPayload; what is missing is left out.
(() => {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const KINDS = new Set(['godmorgon', 'godnatt', 'hem', 'natt']);
  const SKINS = new Set([
    'jul',
    'nyar',
    'midsommar',
    'fodelsedag',
    'pask',
    'lucia',
    'allahelgon',
    'egen',
  ]);
  const NB_RGB = {
    jul: '212, 98, 90',
    nyar: '230, 203, 138',
    midsommar: '150, 200, 130',
    fodelsedag: '240, 150, 120',
    pask: '236, 208, 111',
    lucia: '240, 196, 108',
    allahelgon: '217, 155, 94',
    day: '231, 188, 120',
    night: '184, 149, 94',
  };

  const timeFmt = new Intl.DateTimeFormat('sv-SE', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'Europe/Stockholm',
  });
  const dateFmt = new Intl.DateTimeFormat('sv-SE', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'Europe/Stockholm',
  });
  const partsFmt = new Intl.DateTimeFormat('en-GB', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    hourCycle: 'h23',
    timeZone: 'Europe/Stockholm',
  });

  const CONDITIONS = {
    'clear-night': 'Klart',
    cloudy: 'Mulet',
    exceptional: 'Ovanligt väder',
    fog: 'Dimma',
    hail: 'Hagel',
    lightning: 'Åska',
    'lightning-rainy': 'Åska och regn',
    partlycloudy: 'Halvklart',
    pouring: 'Ösregn',
    rainy: 'Regn',
    snowy: 'Snö',
    'snowy-rainy': 'Snöblandat regn',
    sunny: 'Soligt',
    windy: 'Blåsigt',
    'windy-variant': 'Blåsigt',
  };

  const CLOUD =
    'M7 18.5h10a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7 9.7a4.4 4.4 0 0 0 0 8.8Z';
  const ICONS = {
    sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-5.500v2.500m0 14v2.500M2.500 12H5m14 0h2.500M5.300 5.300l1.800 1.800m9.800 9.800 1.800 1.800m0-13.400-1.800 1.800m-9.800 9.800-1.800 1.800',
    moon: 'M20.200 15.600A8.600 8.600 0 0 1 8.400 3.800 8.600 8.600 0 1 0 20.200 15.600Z',
    cloud: CLOUD,
    rain: 'M7 15h10a4 4 0 0 0 .6-7.950A5.500 5.500 0 0 0 7 6.200 4.400 4.400 0 0 0 7 15ZM8.500 18l-1 2.500m5.500-2.500-1 2.500m5.500-2.500-1 2.500',
    snow: 'M7 15h10a4 4 0 0 0 .6-7.950A5.500 5.500 0 0 0 7 6.200 4.400 4.400 0 0 0 7 15ZM8 19h.010M12 21h.010M16 19h.010',
    fog: 'M4 8h16M3 12h18M5 16h14',
    power: 'M12 3v9M6.300 5.700a8 8 0 1 0 11.400 0',
    focus:
      'M7 21h11M12.500 21v-4L7 11l4-5m0 0 4-3 6 6-3 4-7-7Z M7 9.500a1.500 1.500 0 1 0 0 3 1.500 1.500 0 0 0 0-3Z',
    play: 'M8 5.500v13l10.500-6.500Z',
    pause: 'M9 5.500v13M15 5.500v13',
  };

  function conditionIcon(condition) {
    if (condition === 'sunny') return 'sun';
    if (condition === 'clear-night') return 'moon';
    if (
      ['rainy', 'pouring', 'lightning', 'lightning-rainy'].includes(condition)
    )
      return 'rain';
    if (['snowy', 'snowy-rainy', 'hail'].includes(condition)) return 'snow';
    if (condition === 'fog') return 'fog';
    return 'cloud';
  }

  const root = document.querySelector(
    ".hub-page[data-page='halsning'] .greeting-page",
  );

  const payload = () =>
    typeof latestPayload === 'undefined' ? undefined : latestPayload;
  const serverNow = () =>
    typeof estimatedServerNow === 'function' && payload()
      ? estimatedServerNow()
      : Date.now();

  let current = null; // null or { kind, skin }
  let dom = null;
  let timer = 0;
  let quickMenuAttached = false;
  let tilesKey = '';

  // ── Helpers ──

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function icon(name, className) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    for (const [key, value] of Object.entries({
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '1.6',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
    }))
      svg.setAttribute(key, value);
    if (className) svg.setAttribute('class', className);
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', ICONS[name]);
    svg.append(path);
    return svg;
  }
  function setText(node, value) {
    if (node.textContent !== value) node.textContent = value;
  }
  function setData(node, name, value) {
    if (value === null || value === undefined) delete node.dataset[name];
    else if (node.dataset[name] !== value) node.dataset[name] = value;
  }
  const isNum = (value) => typeof value === 'number' && Number.isFinite(value);
  const degrees = (value) =>
    `${(Math.round(value) || 0).toLocaleString('sv-SE')}°`;
  const decimal = (value) =>
    value.toLocaleString('sv-SE', { maximumFractionDigits: 1 });

  function stockholm(ms) {
    const parts = {};
    for (const part of partsFmt.formatToParts(ms))
      parts[part.type] = part.value;
    return {
      key: `${parts.year}-${parts.month}-${parts.day}`,
      year: Number(parts.year),
      month: Number(parts.month),
      hour: Number(parts.hour),
      weekend: parts.weekday === 'Sat' || parts.weekday === 'Sun',
    };
  }

  /** The same choice all day, another one the next. */
  function ofTheDay(list, seed) {
    let hash = 0;
    for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return list[hash % list.length];
  }

  function awayText(ms) {
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 60)
      return `${minutes} ${minutes === 1 ? 'minut' : 'minuter'}`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours} ${hours === 1 ? 'timme' : 'timmar'}`;
    return `${Math.floor(hours / 24)} dagar`;
  }

  // ── What is true right now ──

  function readLights(state) {
    const devices = Object.values(state?.lighting?.devices ?? {});
    const on = devices.filter((device) =>
      typeof device?.observed?.power === 'boolean'
        ? device.observed.power
        : device?.effectiveDesired?.power === true,
    ).length;
    return { total: devices.length, on };
  }

  function lightsSentence(lights) {
    if (!lights.total) return '';
    if (!lights.on) return 'Alla lampor är släckta.';
    return lights.on === 1
      ? 'En lampa är tänd.'
      : `${lights.on} lampor är tända.`;
  }

  /** One thing worth knowing before going out, or nothing. */
  function weatherSentence(weather) {
    const today = weather?.forecast?.today;
    const condition = weather?.condition;
    if (
      ['rainy', 'pouring', 'lightning-rainy'].includes(condition) ||
      today?.precipitationProbability >= 50
    )
      return 'Ta med paraply idag.';
    if (['snowy', 'snowy-rainy'].includes(condition))
      return 'Det snöar ute, räkna med halka.';
    if (isNum(weather?.temperature) && weather.temperature <= 0)
      return 'Det är minusgrader ute.';
    if (isNum(weather?.windSpeed) && weather.windSpeed >= 10)
      return 'Det blåser rejält ute.';
    return '';
  }

  function readMusic(data) {
    const devices = data?.state?.music?.devices ?? {};
    const target =
      typeof musicTarget === 'string' && musicTarget
        ? musicTarget
        : Object.keys(devices)[0] || '';
    const device = devices[target];
    if (!device) return null;
    const page = typeof refs === 'object' && refs ? refs : null;
    const route = data.state.music.computerPlayback?.[target];
    const playback = route?.active ? route.playback : device.observed?.playback;
    // As on Hem: a held Pause says what the receiver should do, not whether
    // the computer behind its input plays.
    const playing =
      playback === 'playing' &&
      (route?.active || !data.musicPlaybackPolicies?.[target]?.manualPause);
    const preset = [...(page?.musicPresets?.children ?? [])].find(
      (button) => button.dataset?.presetId && !button.disabled,
    );
    return {
      target,
      playing,
      available: page?.musicPlayback
        ? page.musicPlayback.disabled === false
        : device.availability === 'available',
      busy:
        typeof pending === 'object' &&
        (pending.has(`music:${target}`) ||
          pending.has(`music-preset:${target}`)),
      preset: preset
        ? {
            id: Number(preset.dataset.presetId),
            label: preset.textContent.trim(),
          }
        : null,
    };
  }

  // ── Words ──

  /** The Hub rules' `vadra` tag, which hub-policy.js puts on <html>. */
  const needsAir = () =>
    Boolean(
      document.documentElement?.dataset?.hubTags?.split(' ').includes('vadra'),
    );

  function words({ kind, skin, time, data }) {
    const seed = `${time.key}:${kind}`;
    const lights = lightsSentence(readLights(data?.state));
    if (skin) {
      const age = skin.age ? `Du fyller ${skin.age} idag.` : 'Ha en fin dag.';
      const newYear = time.month === 12 ? time.year + 1 : time.year;
      const special = {
        jul: ['God jul', 'En stilla jul hemma.'],
        nyar: ['Gott nytt år', `Välkommen ${newYear}.`],
        midsommar: ['Glad midsommar', 'Årets ljusaste dagar.'],
        fodelsedag: [skin.name ? `Grattis, ${skin.name}` : 'Grattis', age],
        pask: ['Glad påsk', 'Vårljus och lugna dagar.'],
        lucia: ['God lucia', 'Varmt ljus i decembermörkret.'],
        allahelgon: ['Alla helgons dag', 'En stilla stund.'],
        egen: [skin.title || 'En fin dag', lights],
      }[skin.id];
      return { title: special[0], sub: special[1] };
    }
    if (kind === 'godnatt')
      return {
        title: ofTheDay(['Godnatt', 'Sov gott'], seed),
        sub: needsAir() ? 'Vädra gärna innan du somnar.' : lights,
      };
    if (kind === 'hem') {
      const home = data?.state?.presence?.home;
      const away = isNum(home?.awayDurationMs) ? home.awayDurationMs : 0;
      return {
        title: 'Välkommen hem',
        sub: away >= 60_000 ? `Du var borta i ${awayText(away)}.` : lights,
      };
    }
    let title = 'Godmorgon';
    if (time.hour >= 22 || time.hour < 5) title = 'Sen kväll';
    else if (time.hour >= 17) title = 'God kväll';
    else if (time.hour >= 11) title = 'God dag';
    else if (time.weekend)
      title = ofTheDay(['Godmorgon', 'Lugn morgon', 'Skön helg'], seed);
    const indoor = data?.environment?.temperature?.value;
    if (needsAir()) return { title, sub: 'Dags att vädra.' };
    return {
      title,
      sub:
        weatherSentence(data?.weather) ||
        (isNum(indoor) ? `${decimal(indoor)}° inne just nu.` : lights),
    };
  }

  // ── Actions: the same commands as Hem's ──

  function command(key, body) {
    if (typeof runCommand !== 'function') return;
    void runCommand(key, body);
    window.setTimeout(draw, 0);
  }

  function actions(kind, data) {
    const offline = typeof isUnavailable === 'function' && isUnavailable();
    const known = new Set(
      (typeof getSceneList === 'function'
        ? getSceneList(data)
        : (data?.scenes ?? [])
      ).map((scene) => scene.id),
    );
    const selected = data?.state?.lighting?.currentScene ?? null;
    const light = (id, label, symbol, main = false) => {
      if (!known.has(id)) return null;
      const busy = typeof pending === 'object' && pending.has(`scene:${id}`);
      return {
        key: id,
        scene: id,
        label,
        symbol,
        main,
        pressed: !main && selected === id,
        disabled: offline || busy,
        run: () => command(`scene:${id}`, { sceneId: id }),
      };
    };
    const music = readMusic(data);
    const player = () => {
      if (!music) return null;
      const disabled = offline || music.busy || !music.available;
      if (music.playing)
        return {
          key: 'pause',
          label: 'Pausa musik',
          symbol: 'pause',
          disabled,
          run: () =>
            command(`music:${music.target}`, {
              target: music.target,
              request: { property: 'playback', value: 'paused' },
            }),
        };
      if (kind === 'godnatt' || !music.preset) return null;
      return {
        key: `preset:${music.preset.id}`,
        label: music.preset.label,
        symbol: 'play',
        disabled: offline || music.busy,
        run: () => {
          if (typeof selectMusicPreset === 'function')
            selectMusicPreset(music.preset.id);
          window.setTimeout(draw, 0);
        },
      };
    };
    const everyday = () => light('scene.everyday_light', 'Vardagsljus', 'sun');
    const soft = () => light('scene.soft_light', 'Mysljus', 'moon');
    const list =
      kind === 'godnatt'
        ? [
            light('scene.all_off', 'Släck allt', 'power', true),
            soft(),
            player(),
          ]
        : kind === 'hem'
          ? [everyday(), soft(), player()]
          : [
              everyday(),
              light('scene.focus_light', 'Fokus', 'focus'),
              player(),
            ];
    return list.filter(Boolean);
  }

  function drawTiles(list) {
    const key = list.map((item) => `${item.key}:${item.label}`).join('|');
    if (key !== tilesKey) {
      tilesKey = key;
      dom.buttons = list.map((item) => {
        const button = el('button', 'gp-tile');
        button.type = 'button';
        if (item.scene) button.dataset.scene = item.scene;
        if (item.main) button.dataset.main = 'true';
        const mark = el('span', 'gp-tile-mark');
        const symbol = icon(item.symbol);
        symbol.dataset.symbol = item.symbol;
        mark.append(symbol);
        button.append(mark, el('span', 'gp-tile-name', item.label));
        button.addEventListener('click', () => button.action?.());
        return button;
      });
      dom.tiles.replaceChildren(...dom.buttons);
    }
    list.forEach((item, index) => {
      const button = dom.buttons[index];
      button.action = item.run;
      if (button.disabled !== item.disabled) button.disabled = item.disabled;
      if (item.scene && !item.main)
        button.setAttribute('aria-pressed', String(item.pressed));
    });
  }

  // ── Weather panel ──

  function drawWeather(kind, weather, time) {
    const tomorrowView = kind === 'godnatt';
    // After midnight the coming day is already "today" in the forecast.
    const afterMidnight = tomorrowView && time.hour < 12;
    const day = tomorrowView
      ? weather?.forecast?.[afterMidnight ? 'today' : 'tomorrow']
      : weather?.forecast?.today;
    const condition = tomorrowView ? day?.condition : weather?.condition;
    const temperature = tomorrowView ? day?.high : weather?.temperature;
    const shown = isNum(temperature);
    dom.weather.hidden = !shown;
    root.dataset.weather = String(shown);
    if (!shown) return;

    setText(
      dom.when,
      tomorrowView ? (afterMidnight ? 'Senare idag' : 'Imorgon') : 'Ute nu',
    );
    const symbol = conditionIcon(condition);
    if (dom.symbol.dataset.symbol !== symbol) {
      const next = icon(symbol, 'gp-weather-icon');
      next.dataset.symbol = symbol;
      dom.symbol.replaceWith(next);
      dom.symbol = next;
    }
    setText(dom.temp, degrees(temperature));
    setText(dom.condition, CONDITIONS[condition] ?? '');

    const facts = [];
    if (tomorrowView) {
      if (isNum(day?.low)) facts.push(['Lägst', degrees(day.low)]);
    } else if (isNum(day?.high) && isNum(day?.low)) {
      facts.push(['Idag', `${degrees(day.low)} till ${degrees(day.high)}`]);
    }
    if (isNum(day?.precipitationProbability))
      facts.push([
        'Risk för nederbörd',
        `${Math.round(day.precipitationProbability)} %`,
      ]);
    // At night the coming sunrise; otherwise whichever of the two comes first.
    const { nextRising, nextSetting } = weather?.sun ?? {};
    const sunKind =
      !tomorrowView && isNum(nextSetting) && !(nextRising < nextSetting)
        ? 'nextSetting'
        : 'nextRising';
    const sunAt = weather?.sun?.[sunKind];
    if (isNum(sunAt))
      facts.push([
        sunKind === 'nextRising' ? 'Solen går upp' : 'Solen går ner',
        timeFmt.format(sunAt),
      ]);
    const key = JSON.stringify(facts);
    if (dom.facts.dataset.key !== key) {
      dom.facts.dataset.key = key;
      dom.facts.replaceChildren(
        ...facts.map(([label, value]) => {
          const row = el('div');
          row.append(el('dt', '', label), el('dd', '', value));
          return row;
        }),
      );
    }
  }

  // ── Page ──

  function ensureDom() {
    if (dom) return;
    const date = el('p', 'gp-date');
    const clock = el('time', 'gp-clock');
    const title = el('h1', 'gp-title');
    const sub = el('p', 'gp-sub');
    const tiles = el('div', 'gp-tiles');

    const weather = el('aside', 'gp-weather');
    const when = el('span', 'gp-weather-when');
    const symbol = icon('cloud', 'gp-weather-icon');
    symbol.dataset.symbol = 'cloud';
    const temp = el('strong', 'gp-weather-temp');
    const condition = el('span', 'gp-weather-condition');
    const facts = el('dl', 'gp-weather-facts');
    weather.append(when, symbol, temp, condition, facts);

    const night = el('div', 'gp-night');
    const nightClock = el('time');
    const nightDate = el('span');
    night.append(nightClock, nightDate);

    root.replaceChildren(date, clock, title, sub, tiles, weather, night);
    dom = {
      date,
      clock,
      title,
      sub,
      tiles,
      buttons: [],
      weather,
      when,
      symbol,
      temp,
      condition,
      facts,
      nightClock,
      nightDate,
    };
  }

  function ensureQuickMenu() {
    if (quickMenuAttached || !globalThis.lugnQuickMenu?.attach) return;
    quickMenuAttached = true;
    globalThis.lugnQuickMenu.attach({
      id: 'halsning',
      root,
      handleTap: (event) => Boolean(event.target?.closest?.('button')),
    });
  }

  function draw() {
    if (!root) return;
    ensureDom();
    ensureQuickMenu();

    const kind = current?.kind || 'godmorgon';
    const skin = kind === 'natt' ? null : current?.skin || null;
    const data = payload();
    const nowMs = serverNow();
    const time = stockholm(nowMs);
    const night = kind === 'godnatt' || time.hour >= 22 || time.hour < 5;

    setData(root, 'scene', kind);
    setData(root, 'skin', skin?.id ?? null);
    setData(root, 'tone', night ? 'night' : 'day');
    const rgb = NB_RGB[skin?.id] ?? NB_RGB[night ? 'night' : 'day'];
    if (root.style.getPropertyValue('--nb-rgb') !== rgb)
      root.style.setProperty('--nb-rgb', rgb);

    const clockText = timeFmt.format(nowMs);
    const dateText = dateFmt.format(nowMs);
    if (kind === 'natt') {
      setText(dom.nightClock, clockText);
      setText(dom.nightDate, dateText);
      return;
    }
    setText(dom.date, dateText);
    setText(dom.clock, clockText);
    const copy = words({ kind, skin, time, data });
    setText(dom.title, copy.title);
    setData(dom.title, 'long', String(copy.title.length > 20));
    setText(dom.sub, copy.sub);
    drawTiles(actions(kind, data));
    drawWeather(kind, data?.weather, time);
  }

  // ── Public API (hub-policy.js) ──

  function normalize(input) {
    if (!input || typeof input !== 'object') return null;
    const kind = KINDS.has(input.kind) ? input.kind : 'godmorgon';
    let skin = null;
    if (SKINS.has(input.skin?.id)) {
      const { id, name, title } = input.skin;
      const age = Number(input.skin.age);
      skin = { id };
      if (typeof name === 'string' && name.trim()) skin.name = name.trim();
      if (typeof title === 'string' && title.trim()) skin.title = title.trim();
      if (Number.isFinite(age) && age > 0) skin.age = Math.floor(age);
    }
    return { kind, skin };
  }

  globalThis.lugnGreeting = {
    setScene(scene) {
      const next = normalize(scene);
      if (JSON.stringify(next) === JSON.stringify(current)) return;
      current = next;
      draw();
    },
    scene() {
      return current
        ? { kind: current.kind, skin: current.skin && { ...current.skin } }
        : null;
    },
  };

  function stop() {
    window.clearInterval(timer);
    timer = 0;
  }

  if (globalThis.lugnPages?.define) {
    globalThis.lugnPages.define('halsning', {
      prepare: draw,
      enter() {
        stop();
        draw();
        timer = window.setInterval(draw, 1000);
      },
      leave: stop,
      sleep: stop,
    });
  } else {
    draw();
  }
})();
