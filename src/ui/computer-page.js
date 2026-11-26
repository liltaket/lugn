// Dator (dator): what the computer is doing right now: processor, graphics,
// memory, swap, the busiest programs, the network and the disk. Only fresh
// figures from latestPayload.computerStats are shown; nothing is made up.
(() => {
  'use strict';

  const PROGRAMS = 5;

  const timeFmt = new Intl.DateTimeFormat('sv-SE', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'Europe/Stockholm',
  });

  const root = document.querySelector(
    ".hub-page[data-page='dator'] .computer-page",
  );

  const payload = () =>
    typeof latestPayload === 'undefined' ? undefined : latestPayload;
  const serverNow = () =>
    typeof estimatedServerNow === 'function' && payload()
      ? estimatedServerNow()
      : Date.now();

  let dom = null;
  let timer = 0;
  let quickMenuAttached = false;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function setText(node, value) {
    if (node.textContent !== value) node.textContent = value;
  }
  const isNum = (value) => typeof value === 'number' && Number.isFinite(value);
  const number = (value, digits = 0) =>
    value.toLocaleString('sv-SE', { maximumFractionDigits: digits });
  const percentOf = (used, total) =>
    isNum(used) && total > 0 ? (used / total) * 100 : null;
  const gigabytes = (used, total) =>
    isNum(used) && total > 0
      ? `${number(used / 1024, 1)} av ${number(total / 1024)} GB`
      : '';
  const memory = (mb) =>
    mb >= 1024 ? `${number(mb / 1024, 1)} GB` : `${number(mb)} MB`;

  /** The computer being used, else one that is online, else the one that sends. */
  function choose(data) {
    const devices = Object.entries(data?.state?.computer?.devices ?? {});
    const online = devices.filter(([, d]) => d?.availability === 'online');
    const [id, device] = online.find(
      ([, d]) => d.freshness === 'fresh' && d.observed?.idle !== true,
    ) ??
      online[0] ??
      devices[0] ?? [Object.keys(data?.computerStats ?? {})[0], null];
    return id ? { id, device } : null;
  }

  function statusText(device) {
    if (!device) return '';
    if (device.availability === 'offline') return 'Frånkopplad';
    if (device.observed?.locked) return 'Låst';
    if (device.observed?.idle) return 'Vilar';
    const app = device.observed?.activeApplication;
    const raw = app?.resourceClass || app?.id || '';
    const name = String(raw).split('.').pop().replace(/[-_]+/g, ' ');
    return name
      ? `${name.charAt(0).toUpperCase()}${name.slice(1)} i fokus`
      : '';
  }

  function reading(label) {
    const card = el('article', 'cp-card cp-reading');
    const value = el('strong', 'cp-value');
    const figure = document.createTextNode('');
    value.append(figure, el('small', '', '%'));
    const bar = el('div', 'cp-bar');
    const fill = el('i');
    bar.append(fill);
    const detail = el('span', 'cp-detail');
    card.append(el('span', 'cp-label', label), value, bar, detail);
    return {
      card,
      set(percent, text) {
        card.hidden = !isNum(percent);
        if (card.hidden) return;
        const clamped = Math.max(0, Math.min(100, percent));
        setText(figure, String(Math.round(clamped)));
        const transform = `scaleX(${(clamped / 100).toFixed(3)})`;
        if (fill.style.transform !== transform)
          fill.style.transform = transform;
        card.dataset.high = String(clamped >= 90);
        setText(detail, text);
      },
    };
  }

  function rate(label) {
    const row = el('div', 'cp-rate');
    const value = el('strong');
    const figure = document.createTextNode('');
    value.append(figure, el('small', '', 'Mbit/s'));
    row.append(el('span', '', label), value);
    return {
      row,
      set(mbit) {
        row.hidden = !isNum(mbit);
        if (!row.hidden) setText(figure, number(mbit, mbit < 100 ? 1 : 0));
      },
    };
  }

  function ensureDom() {
    if (dom) return;
    const head = el('header', 'cp-head');
    const name = el('h1', 'cp-name');
    const status = el('span', 'cp-status');
    const clock = el('time', 'cp-clock');
    head.append(name, status, clock);

    const readings = el('section', 'cp-readings');
    const cpu = reading('Processor');
    const gpu = reading('Grafik');
    const ram = reading('Minne');
    const swap = reading('Swap');
    readings.append(cpu.card, gpu.card, ram.card, swap.card);

    const lower = el('section', 'cp-lower');
    const programs = el('article', 'cp-card cp-programs');
    const table = el('table');
    const headRow = el('tr');
    for (const label of ['Öppna program', 'Processor', 'Minne'])
      headRow.append(el('th', '', label));
    const thead = el('thead');
    thead.append(headRow);
    const rows = el('tbody');
    table.append(thead, rows);
    programs.append(table);

    const network = el('article', 'cp-card cp-network');
    const down = rate('Ned');
    const up = rate('Upp');
    const offline = el('span', 'cp-detail', 'Ingen uppgift om nätet.');
    const disk = el('div', 'cp-disk');
    const diskValue = el('span');
    disk.append(el('span', '', 'Disk'), diskValue);
    network.append(
      el('span', 'cp-label', 'Internet'),
      down.row,
      up.row,
      offline,
      disk,
    );
    lower.append(programs, network);

    const empty = el(
      'p',
      'cp-empty',
      'Datorn skickar ingen statistik just nu.',
    );
    root.replaceChildren(head, readings, lower, empty);
    dom = {
      name,
      status,
      clock,
      readings,
      lower,
      empty,
      cpu,
      gpu,
      ram,
      swap,
      programs,
      rows,
      down,
      up,
      offline,
      disk,
      diskValue,
    };
  }

  function ensureQuickMenu() {
    if (quickMenuAttached || !globalThis.lugnQuickMenu?.attach) return;
    quickMenuAttached = true;
    globalThis.lugnQuickMenu.attach({ id: 'dator', root });
  }

  function draw() {
    if (!root) return;
    ensureDom();
    ensureQuickMenu();
    root.style.setProperty('--nb-rgb', '231, 188, 120');

    const data = payload();
    const chosen = choose(data);
    const stats = chosen ? data?.computerStats?.[chosen.id] : null;
    const id = chosen?.id ?? '';
    setText(
      dom.name,
      data?.computerNames?.[id] ||
        (id ? `${id.charAt(0).toUpperCase()}${id.slice(1)}` : 'Dator'),
    );
    setText(dom.status, statusText(chosen?.device));
    setText(dom.clock, timeFmt.format(serverNow()));

    dom.empty.hidden = Boolean(stats);
    dom.readings.hidden = !stats;
    dom.lower.hidden = !stats;
    if (!stats) return;

    const { cpu, gpu, memory: mem, network, disk } = stats;
    const temperature = (value) =>
      isNum(value) ? `${Math.round(value)} °C` : '';
    dom.cpu.set(cpu?.percent, temperature(cpu?.tempC));
    dom.gpu.set(
      gpu?.percent,
      [temperature(gpu?.tempC), gigabytes(gpu?.vramUsedMb, gpu?.vramTotalMb)]
        .filter(Boolean)
        .join(', '),
    );
    dom.ram.set(
      percentOf(mem?.ramUsedMb, mem?.ramTotalMb),
      gigabytes(mem?.ramUsedMb, mem?.ramTotalMb),
    );
    dom.swap.set(
      percentOf(mem?.swapUsedMb, mem?.swapTotalMb),
      gigabytes(mem?.swapUsedMb, mem?.swapTotalMb),
    );

    const list = (stats.processes ?? []).slice(0, PROGRAMS);
    dom.programs.hidden = !list.length;
    const key = JSON.stringify(list);
    if (dom.rows.dataset.key !== key) {
      dom.rows.dataset.key = key;
      dom.rows.replaceChildren(
        ...list.map((program) => {
          const row = el('tr');
          row.append(
            el('td', '', program.name),
            el('td', '', `${number(program.cpuPercent)} %`),
            el('td', '', memory(program.ramMb)),
          );
          return row;
        }),
      );
    }

    // Without a network interface the zeros would mean nothing.
    const online = Boolean(network?.iface);
    dom.down.set(online ? network.downMbit : null);
    dom.up.set(online ? network.upMbit : null);
    dom.offline.hidden = online;
    dom.disk.hidden = !(disk?.totalGb > 0);
    if (!dom.disk.hidden)
      setText(
        dom.diskValue,
        `${number(disk.usedGb)} av ${number(disk.totalGb)} GB`,
      );
  }

  function stop() {
    window.clearInterval(timer);
    timer = 0;
  }

  if (globalThis.lugnPages?.define) {
    globalThis.lugnPages.define('dator', {
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
