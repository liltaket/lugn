// Telefoner: pair the Lugn app with a one-time code and revoke paired phones.
// app.js owns the session; this module borrows its CSRF token through
// window.lugnPanel and only talks to Lugn's /ui/api/devices routes.

import { encodeQr } from './qr.js';

const API_ROOT = '/ui/api/devices';
const SERVER_URL_KEY = 'lugn.phones.serverUrl';
const CONFIRM_TIMEOUT_MS = 6000;
const LIST_REFRESH_MS = 15_000;
// While a code is shown the list is read more often, so a new phone appears
// soon after it pairs.
const PAIRING_REFRESH_MS = 3000;
const NBSP = ' ';

const SCOPE_LABELS = {
  'state:read': 'Läsa läget',
  'commands:write': 'Styra rummet',
  'phone:ingest': 'Skicka ledtrådar',
};
const SIGNAL_LABELS = {
  app: 'appen',
  geofence: 'zoner',
  power: 'laddning',
  focus: 'fokus',
  wakeAlarm: 'väckning',
  motion: 'rörelse',
  network: 'nätverk',
};

const panel = window.lugnPanel;
const el = (id) => document.getElementById(id);
const section = el('phones-section');

const clockFormat = new Intl.DateTimeFormat('sv-SE', {
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Europe/Stockholm',
});
const dayFormat = new Intl.DateTimeFormat('sv-SE', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  timeZone: 'Europe/Stockholm',
});
const dateFormat = new Intl.DateTimeFormat('sv-SE', {
  day: 'numeric',
  month: 'short',
  timeZone: 'Europe/Stockholm',
});

// 'loading' | 'ready' | 'disabled' | 'unavailable' | 'error' | 'session'
let listState = 'loading';
let list = null;
let listLoadedAt = 0;
let listLoading = null;
let pairing = null;
let pairingBusy = false;
let revokingId = null;
let confirmingId = null;
let confirmTimer = null;
let tickTimer = null;
let refreshTimer = null;
let renderedSignature = '';

class PhonesError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

async function api(path = '', method = 'GET') {
  const headers = {};
  if (method !== 'GET') {
    const csrf = panel.csrfToken();
    if (!csrf) throw new PhonesError('session', 401);
    headers['content-type'] = 'application/json';
    headers['X-Lugn-CSRF'] = csrf;
  }
  const response = await fetch(`${API_ROOT}${path}`, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers,
    ...(method === 'GET' ? {} : { body: '{}' }),
  });
  if (response.status === 401 || response.status === 403) {
    void panel.refresh();
    throw new PhonesError('session', response.status);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new PhonesError(body.error ?? 'failed', response.status);
  }
  return response.json();
}

function serverNow() {
  return panel.serverNow?.() ?? Date.now();
}

// ---------- Text ----------

function failureText(error, fallback) {
  if (!(error instanceof PhonesError)) return fallback;
  if (error.code === 'session') return 'Sessionen har gått ut. Logga in igen.';
  if (error.code === 'device_limit_reached')
    return 'Det finns redan 32 ihopparade telefoner. Spärra en först.';
  if (error.code === 'too_many_pairing_codes')
    return 'Fyra koder väntar redan. Använd en av dem eller vänta tills de går ut.';
  if (
    error.code === 'device_registry_unavailable' ||
    error.code === 'device_registry_save_failed'
  )
    return 'Lugn kan inte läsa eller spara listan över telefoner. Ingen ändring gjordes.';
  if (error.code === 'device_not_found')
    return 'Telefonen finns inte längre i Lugn.';
  return fallback;
}

/** Short Swedish time for a past moment: nyss, för 5 min sedan, i går 14:02. */
function ago(at, now) {
  const elapsed = Math.max(0, now - at);
  if (elapsed < 45_000) return 'nyss';
  if (elapsed < 3_600_000)
    return `för ${Math.max(1, Math.round(elapsed / 60_000))}${NBSP}min sedan`;
  return when(at, now);
}

function when(at, now) {
  const day = dayFormat.format(at);
  const time = clockFormat.format(at);
  if (day === dayFormat.format(now)) return `i dag ${time}`;
  if (day === dayFormat.format(now - 86_400_000)) return `i går ${time}`;
  return `${dateFormat.format(at)} ${time}`;
}

function lastSeenText(device, phone, since, now) {
  const seen = Math.max(device.lastSeenAt ?? 0, phone?.lastSeenAt ?? 0);
  if (seen > 0) return `Sedd ${ago(seen, now)}`;
  // Last-seen times live in memory, so a restart forgets them.
  return device.createdAt >= since ? 'Aldrig sedd' : 'Inte sedd sedan omstart';
}

function signalSummary(device, phone) {
  if (!device.scopes.includes('phone:ingest'))
    return { text: 'Skickar inga ledtrådar', tone: 'neutral' };
  if (!phone) return { text: 'Inga ledtrådar än', tone: 'neutral' };
  const fresh = [];
  const older = [];
  for (const [name, label] of Object.entries(SIGNAL_LABELS)) {
    const signal = phone.signals?.[name];
    if (!signal) continue;
    const values = name === 'geofence' ? Object.values(signal) : [signal];
    if (values.length === 0) continue;
    (values.some((value) => value.fresh) ? fresh : older).push(label);
  }
  if (!fresh.length && !older.length)
    return { text: 'Inga ledtrådar än', tone: 'neutral' };
  const parts = [];
  if (fresh.length) parts.push(`Färska: ${fresh.join(', ')}`);
  if (older.length) parts.push(`Äldre: ${older.join(', ')}`);
  return { text: parts.join(' · '), tone: fresh.length ? 'good' : 'warn' };
}

// ---------- Server URL ----------

/** The app needs an origin such as https://lugn.example.ts.net:8789. */
function normalizeServerUrl(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== '/') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function storedServerUrl() {
  try {
    return normalizeServerUrl(localStorage.getItem(SERVER_URL_KEY));
  } catch {
    return null;
  }
}

function storeServerUrl(value) {
  try {
    if (value) localStorage.setItem(SERVER_URL_KEY, value);
    else localStorage.removeItem(SERVER_URL_KEY);
  } catch {
    // Private windows may refuse storage; the field still works this visit.
  }
}

let typedServerUrl = null;

function serverUrl() {
  return list?.publicUrl ?? typedServerUrl ?? storedServerUrl();
}

function renderServerField() {
  const configured = list?.publicUrl ?? null;
  el('phones-server-field').hidden = configured !== null;
  el('phones-server-configured').hidden = configured === null;
  if (configured !== null) {
    el('phones-server-configured-url').textContent = configured;
    return;
  }
  const input = el('phones-server-url');
  if (document.activeElement !== input && !input.value)
    input.value = serverUrl() ?? '';
}

function onServerInput() {
  const input = el('phones-server-url');
  const help = el('phones-server-help');
  const value = normalizeServerUrl(input.value);
  if (!input.value.trim()) {
    typedServerUrl = null;
    storeServerUrl(null);
    help.dataset.tone = 'neutral';
    help.textContent = serverHelp();
  } else if (value) {
    typedServerUrl = value;
    storeServerUrl(value);
    help.dataset.tone = 'neutral';
    help.textContent = serverHelp();
  } else {
    typedServerUrl = null;
    help.dataset.tone = 'bad';
    help.textContent =
      'Skriv bara adressen, med https:// och port, utan sökväg.';
  }
  renderPairing();
}

function serverHelp() {
  return 'Adressen telefonen når Lugn på. Sparas bara i den här webbläsaren. Sätt device.publicUrl i config.json så behöver ingen fylla i den.';
}

// ---------- Pairing ----------

async function createCode() {
  if (pairingBusy) return;
  pairingBusy = true;
  setPairStatus('Skapar kod');
  renderPairing();
  try {
    const created = await api('/pairing', 'POST');
    pairing = {
      code: created.code,
      expiresAt: created.expiresAt,
      createdAt: serverNow(),
      knownIds: new Set((list?.devices ?? []).map((device) => device.id)),
    };
    setPairStatus('');
  } catch (error) {
    setPairStatus(failureText(error, 'Kunde inte skapa en kod.'), 'bad');
  } finally {
    pairingBusy = false;
    renderPairing();
    sync();
  }
}

function hideCode() {
  if (!pairing) return;
  const left = pairing.expiresAt - serverNow();
  pairing = null;
  setPairStatus(left > 0 ? 'Koden är dold men gäller tills den går ut.' : '');
  renderPairing();
  sync();
}

function setPairStatus(text, tone = 'neutral') {
  el('phones-pair-status').textContent = text;
  el('phones-pair-status').dataset.tone = tone;
}

function pairingPayload(code, url) {
  return `lugn://pair?server=${encodeURIComponent(url)}&code=${encodeURIComponent(code)}`;
}

function renderQr(text) {
  const figure = el('phones-qr');
  if (!text) {
    figure.hidden = true;
    figure.replaceChildren();
    figure.dataset.payload = '';
    return;
  }
  figure.hidden = false;
  if (figure.dataset.payload === text) return;
  const qr = encodeQr(text);
  const quiet = 4;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const span = qr.size + quiet * 2;
  svg.setAttribute('viewBox', `0 0 ${span} ${span}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute(
    'aria-label',
    'QR-kod med serveradressen och koden. Skanna den med telefonens kamera.',
  );
  svg.setAttribute('shape-rendering', 'crispEdges');
  const path = document.createElementNS(ns, 'path');
  let d = '';
  for (let y = 0; y < qr.size; y++) {
    let x = 0;
    while (x < qr.size) {
      if (!qr.modules[y][x]) {
        x++;
        continue;
      }
      let run = 1;
      while (x + run < qr.size && qr.modules[y][x + run]) run++;
      d += `M${x + quiet} ${y + quiet}h${run}v1h-${run}z`;
      x += run;
    }
  }
  path.setAttribute('d', d);
  svg.append(path);
  figure.replaceChildren(svg);
  figure.dataset.payload = text;
}

function renderPairing() {
  const ready = listState === 'ready';
  el('phones-pair-button').disabled = pairingBusy || !ready;
  el('phones-pair-button').textContent = pairing ? 'Ny kod' : 'Skapa kod';
  const card = el('phones-code-card');
  if (!pairing) {
    card.hidden = true;
    renderQr(null);
    return;
  }
  card.hidden = false;
  const left = pairing.expiresAt - serverNow();
  const expired = left <= 0;
  card.dataset.state = expired ? 'expired' : 'active';
  el('phones-code').textContent = pairing.code;
  if (expired) {
    el('phones-countdown').textContent = 'Koden har gått ut. Skapa en ny.';
    el('phones-countdown').dataset.tone = 'warn';
  } else {
    const seconds = Math.ceil(left / 1000);
    const minutes = Math.floor(seconds / 60);
    const rest = String(seconds % 60).padStart(2, '0');
    el('phones-countdown').textContent =
      `Gäller i ${minutes}:${rest}, till ${clockFormat.format(pairing.expiresAt)}`;
    el('phones-countdown').dataset.tone = seconds <= 30 ? 'warn' : 'neutral';
  }
  const url = serverUrl();
  el('phones-code-server').textContent = url ?? 'Inte ifylld';
  el('phones-code-server').dataset.tone = url ? 'neutral' : 'warn';
  el('phones-qr-missing').hidden = expired || url !== null;
  renderQr(expired || !url ? null : pairingPayload(pairing.code, url));
}

// A phone that appears after the code was made has just used it.
function notePairedDevice() {
  if (!pairing || !list) return;
  const paired = list.devices.find(
    (device) => !pairing.knownIds.has(device.id) && device.revokedAt === null,
  );
  if (!paired) return;
  pairing = null;
  setPairStatus(`${paired.name} är ihopparad.`, 'good');
}

// ---------- List ----------

async function loadList() {
  if (listLoading) return listLoading;
  listLoading = (async () => {
    let kept = false;
    try {
      list = await api();
      listState = 'ready';
    } catch (error) {
      if (
        error instanceof PhonesError &&
        error.code === 'device_api_disabled'
      ) {
        listState = 'disabled';
        list = null;
      } else if (error instanceof PhonesError && error.code === 'session')
        listState = 'session';
      else if (list) kept = true;
      else listState = 'error';
    } finally {
      listLoadedAt = Date.now();
      listLoading = null;
    }
    if (kept)
      setListStatus(
        'Kunde inte uppdatera listan. Visar det Lugn senast svarade.',
        'warn',
      );
    else if (el('phones-list-status').dataset.tone === 'warn')
      setListStatus('');
    notePairedDevice();
    render();
  })();
  return listLoading;
}

function setListStatus(text, tone = 'neutral') {
  el('phones-list-status').textContent = text;
  el('phones-list-status').dataset.tone = tone;
}

function askToRevoke(device) {
  if (revokingId) return;
  if (confirmingId === device.id) {
    clearTimeout(confirmTimer);
    confirmingId = null;
    void revoke(device);
    return;
  }
  clearTimeout(confirmTimer);
  confirmingId = device.id;
  confirmTimer = setTimeout(() => {
    confirmingId = null;
    renderList();
  }, CONFIRM_TIMEOUT_MS);
  renderList();
}

async function revoke(device) {
  revokingId = device.id;
  setListStatus(`Spärrar ${device.name}`);
  renderList();
  try {
    await api(`/${device.id}/revoke`, 'POST');
    setListStatus(
      `Spärrade ${device.name}. Telefonen kommer inte in längre.`,
      'good',
    );
  } catch (error) {
    setListStatus(
      failureText(error, `Kunde inte spärra ${device.name}.`),
      'bad',
    );
  } finally {
    revokingId = null;
  }
  await loadList();
}

function node(tag, className = '', text = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function reading(label, value, tone) {
  const wrapper = node('div', 'reading');
  const dd = node('dd', '', value);
  if (tone && tone !== 'neutral') dd.dataset.tone = tone;
  wrapper.append(node('dt', '', label), dd);
  return wrapper;
}

function rowModel(device, now) {
  const phone = panel.overview()?.state?.phone?.devices?.[device.id];
  const signals = signalSummary(device, phone);
  return {
    id: device.id,
    name: device.name,
    seen: lastSeenText(device, phone, list.lastSeenSince, now),
    signals,
    scopes:
      device.scopes.map((scope) => SCOPE_LABELS[scope] ?? scope).join(', ') ||
      'Inga',
    paired: when(device.createdAt, now),
    app: device.appVersion ? `iOS · ${device.appVersion}` : 'iOS',
    revokedAt: device.revokedAt,
  };
}

function renderRow(model, device) {
  const article = node('article', 'phone-row');
  article.dataset.deviceId = model.id;
  const heading = node('header', 'phone-row-heading');
  heading.append(node('h3', '', model.name));
  const button = node(
    'button',
    'button button-danger button-small',
    revokingId === model.id
      ? 'Spärrar'
      : confirmingId === model.id
        ? 'Bekräfta spärr'
        : 'Spärra',
  );
  button.type = 'button';
  button.disabled = revokingId !== null;
  button.setAttribute('aria-label', `Spärra ${model.name}`);
  button.addEventListener('click', () => askToRevoke(device));
  heading.append(button);
  article.append(heading);
  const readings = node('dl', 'phone-readings');
  readings.append(
    reading('Senast', model.seen),
    reading('Ledtrådar', model.signals.text, model.signals.tone),
    reading('Får', model.scopes),
    reading('Ihopparad', `${model.paired} · ${model.app}`),
  );
  article.append(readings);
  if (confirmingId === model.id)
    article.append(
      node(
        'p',
        'field-help',
        'Telefonen loggas ut direkt och kommer inte in igen förrän du parar ihop den på nytt.',
      ),
    );
  return article;
}

function renderList() {
  if (!list) return;
  const now = Date.now();
  const active = list.devices.filter((device) => device.revokedAt === null);
  const revoked = list.devices.filter((device) => device.revokedAt !== null);
  const models = active.map((device) => rowModel(device, now));
  const revokedModels = revoked.map((device) => ({
    id: device.id,
    name: device.name,
    text: `Spärrad ${when(device.revokedAt, now)}`,
  }));
  // Live overview updates arrive often; rebuild only when something shown
  // changed, so focus and the confirm step survive.
  const signature = JSON.stringify([
    models,
    revokedModels,
    confirmingId,
    revokingId,
  ]);
  if (signature === renderedSignature) return;
  renderedSignature = signature;
  const devices = new Map(list.devices.map((device) => [device.id, device]));
  el('phones-list').replaceChildren(
    ...models.map((model) => renderRow(model, devices.get(model.id))),
  );
  el('phones-empty').hidden = active.length > 0;
  el('phones-revoked').hidden = revoked.length === 0;
  el('phones-revoked-summary').textContent =
    `Spärrade telefoner (${revoked.length})`;
  el('phones-revoked-list').replaceChildren(
    ...revokedModels.map((model) => {
      const row = node('p', 'phone-revoked-row');
      row.append(
        node('span', '', model.name),
        node('span', 'phone-revoked-time', model.text),
      );
      return row;
    }),
  );
}

function renderIndexValue() {
  const value = el('settings-value-telefoner');
  if (!value) return;
  if (listState === 'disabled') value.textContent = 'Av';
  else if (list)
    value.textContent = String(
      list.devices.filter((device) => device.revokedAt === null).length,
    );
  else value.textContent = '';
}

function render() {
  renderIndexValue();
  const unavailable = el('phones-unavailable');
  const content = el('phones-content');
  const chip = el('phones-status');
  const states = {
    loading: ['Hämtar', 'neutral'],
    ready: ['', 'good'],
    disabled: ['Av', 'neutral'],
    session: ['Utloggad', 'warn'],
    error: ['Svarar inte', 'bad'],
  };
  const [label, tone] = states[listState] ?? states.error;
  chip.hidden = label === '';
  chip.textContent = label;
  chip.dataset.tone = tone;
  content.hidden = listState !== 'ready';
  unavailable.hidden = listState === 'ready' || listState === 'loading';
  if (listState === 'disabled') {
    unavailable.replaceChildren(
      node('strong', '', 'Enhets-API:t är avstängt.'),
      document.createTextNode(
        ' Sätt device.enabled till true i config.json och starta om Lugn. Se avsnittet om ihopparade enheter i OPERATIONS.md.',
      ),
    );
  } else if (listState === 'session') {
    unavailable.textContent = 'Sessionen har gått ut. Logga in igen.';
  } else if (listState === 'error') {
    unavailable.replaceChildren(
      document.createTextNode(
        'Kunde inte hämta telefonerna. Försöker igen om en stund. ',
      ),
    );
    const retry = node(
      'button',
      'button button-quiet button-small',
      'Försök igen',
    );
    retry.type = 'button';
    retry.addEventListener('click', () => void loadList());
    unavailable.append(retry);
  }
  if (listState !== 'ready') return;
  renderServerField();
  renderPairing();
  renderList();
}

// ---------- Lifecycle ----------

function isVisible() {
  return (
    location.hash === '#telefoner' &&
    document.visibilityState !== 'hidden' &&
    panel.overview() !== null &&
    panel.overview() !== undefined
  );
}

function tick() {
  if (pairing) renderPairing();
}

function sync() {
  if (!panel || !section) return;
  const signedIn = panel.overview() !== null && panel.overview() !== undefined;
  // The settings list shows a count even before the page is opened.
  if (signedIn && listLoadedAt === 0 && !listLoading) void loadList();
  if (!isVisible()) {
    clearInterval(tickTimer);
    clearInterval(refreshTimer?.id);
    tickTimer = null;
    refreshTimer = null;
    return;
  }
  const waiting = pairing !== null && pairing.expiresAt > serverNow();
  const interval = waiting ? PAIRING_REFRESH_MS : LIST_REFRESH_MS;
  // A failed or signed-out read is retried soon after the next live update.
  const maxAge = listState === 'ready' ? interval : PAIRING_REFRESH_MS;
  if (Date.now() - listLoadedAt >= maxAge && !listLoading) void loadList();
  tickTimer ??= setInterval(tick, 1000);
  if (refreshTimer?.interval !== interval) {
    clearInterval(refreshTimer?.id);
    refreshTimer = {
      interval,
      id: setInterval(() => {
        if (isVisible()) void loadList();
      }, interval),
    };
  }
}

if (panel && section) {
  el('phones-pair-button').addEventListener('click', () => void createCode());
  el('phones-code-hide').addEventListener('click', hideCode);
  el('phones-server-url').addEventListener('input', onServerInput);
  el('phones-server-help').textContent = serverHelp();
  window.addEventListener('hashchange', sync);
  document.addEventListener('visibilitychange', sync);
  document.addEventListener('lugn:render', () => {
    sync();
    if (listState === 'ready') renderList();
  });
  render();
  sync();
}
