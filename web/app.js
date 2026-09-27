const API_ROOT = '/ui/api';

const loginView = document.getElementById('login-view');
const dashboardView = document.getElementById('dashboard-view');
const loginForm = document.getElementById('login-form');
const tokenInput = document.getElementById('api-token');
const tokenHelp = document.getElementById('token-help');
const loginError = document.getElementById('login-error');
const loginSubmit = document.getElementById('login-submit');
const logoutButton = document.getElementById('logout-button');
const liveStatus = document.getElementById('live-status');
const liveStatusLabel = document.getElementById('live-status-label');
const updatedAt = document.getElementById('updated-at');
const roomPresence = document.getElementById('room-presence');
const presenceTitle = document.getElementById('presence-title');
const presenceDetail = document.getElementById('presence-detail');
const healthTitle = document.getElementById('health-title');
const healthChip = document.getElementById('health-chip');
const integrationList = document.getElementById('integration-list');
const systemAlert = document.getElementById('system-alert');
const sceneSummary = document.getElementById('scene-summary');
const sceneList = document.getElementById('scene-list');
const reapplyButton = document.getElementById('reapply-button');
const mappingSummary = document.getElementById('mapping-summary');
const lightList = document.getElementById('light-list');
const actionStatus = document.getElementById('action-status');

let csrfToken = null;
let tokenRequired = true;
let overview = null;
let eventSource = null;
let pollTimer = null;
let actionMessage = '';
let actionTone = 'neutral';
const pendingActions = new Set();

class SessionExpiredError extends Error {}

tokenHelp.textContent =
  'Öppna tunneln från din dator med ssh -N -L 8787:127.0.0.1:8787 <user>@<host> och besök http://127.0.0.1:8787/ui/. Hämta token på Lugn-värden enligt docs/OPERATIONS.md, i ett privat terminalfönster, och klistra in den bara här.';

loginForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void createSession();
});

logoutButton.addEventListener('click', () => {
  void endSession();
});

reapplyButton.addEventListener('click', () => {
  void invokeCapability('lighting.reapplyScene', {}, 'scene');
});

void restoreSessionOnStartup();

function node(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

function setLiveStatus(label, tone = 'neutral') {
  liveStatusLabel.textContent = label;
  liveStatus.dataset.tone = tone;
}

function setLoginError(message) {
  loginError.textContent = message;
  loginError.hidden = !message;
}

function setActionMessage(message, tone = 'neutral') {
  actionMessage = message;
  actionTone = tone;
  actionStatus.textContent = message;
  actionStatus.dataset.tone = tone;
}

function showLogin(message = '') {
  stopLiveUpdates();
  csrfToken = null;
  overview = null;
  pendingActions.clear();
  dashboardView.hidden = true;
  loginView.hidden = false;
  logoutButton.hidden = true;
  tokenInput.value = '';
  tokenInput.required = tokenRequired;
  setLoginError(message);
  setLiveStatus('Inte ansluten');
}

function showDashboard() {
  loginView.hidden = true;
  dashboardView.hidden = false;
  logoutButton.hidden = false;
}

async function createSession() {
  const token = tokenInput.value;
  if (tokenRequired && !token) return;

  await startSession(token, false);
}

async function startSession(token, automatic) {
  if (tokenRequired && !token) return;

  loginSubmit.disabled = true;
  loginSubmit.textContent = 'Ansluter…';
  tokenInput.disabled = true;
  setLoginError('');
  setLiveStatus('Skapar session', 'warn');

  try {
    const response = await fetch(`${API_ROOT}/session`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403)
        throw new Error('Kontrollera token och försök igen.');
      throw new Error('Sessionen kunde inte skapas. Försök igen.');
    }

    const result = await response.json();
    if (typeof result?.csrfToken !== 'string' || result.csrfToken.length === 0)
      throw new Error('Servern gav ingen giltig session. Försök igen.');

    csrfToken = result.csrfToken;
    tokenInput.value = '';
    await openDashboard(result.csrfToken);
  } catch (error) {
    csrfToken = null;
    tokenInput.value = '';
    if (error instanceof SessionExpiredError) {
      setLoginError('Sessionen kunde inte verifieras. Logga in igen.');
    } else if (error instanceof Error) {
      setLoginError(error.message);
    } else {
      setLoginError('Sessionen kunde inte skapas. Försök igen.');
    }
    if (automatic && !tokenRequired)
      setLoginError('Den lokala sessionen kunde inte skapas. Försök igen.');
    setLiveStatus('Inte ansluten', 'bad');
  } finally {
    tokenInput.disabled = false;
    loginSubmit.disabled = false;
    loginSubmit.textContent = 'Anslut';
  }
}

async function restoreSessionOnStartup() {
  loginSubmit.disabled = true;
  tokenInput.disabled = true;
  loginSubmit.textContent = 'Kontrollerar session…';
  setLiveStatus('Kontrollerar session', 'warn');
  try {
    const response = await fetch(`${API_ROOT}/session`, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error('Sessionsstatus kunde inte hämtas.');
    const session = await response.json();
    if (typeof session?.tokenRequired !== 'boolean')
      throw new Error('Sessionsstatus kunde inte tolkas.');

    tokenRequired = session.tokenRequired;
    tokenInput.required = tokenRequired;
    tokenInput.disabled = false;
    loginSubmit.disabled = false;
    loginSubmit.textContent = 'Anslut';

    if (
      session.authenticated === true &&
      typeof session.csrfToken === 'string' &&
      session.csrfToken.length > 0
    ) {
      try {
        await openDashboard(session.csrfToken);
        return;
      } catch {
        showLogin('Sessionen kunde inte återupptas. Logga in igen.');
      }
    }

    if (!tokenRequired) {
      await startSession('', true);
      return;
    }
    setLiveStatus('Inloggning krävs');
  } catch {
    tokenRequired = true;
    tokenInput.required = true;
    tokenInput.disabled = false;
    loginSubmit.disabled = false;
    loginSubmit.textContent = 'Anslut';
    setLoginError(
      'Sessionsstatus kunde inte hämtas. Kontrollera SSH-tunneln och försök ansluta igen.',
    );
    setLiveStatus('Kan inte kontrollera session', 'bad');
  }
}

async function openDashboard(sessionCsrfToken) {
  csrfToken = sessionCsrfToken;
  try {
    overview = await fetchOverview();
  } catch (error) {
    csrfToken = null;
    throw error;
  }
  showDashboard();
  render();
  startLiveUpdates();
  setActionMessage('Ansluten till Lugn.');
}

async function endSession() {
  const headers = {};
  if (csrfToken) headers['X-Lugn-CSRF'] = csrfToken;
  try {
    await fetch(`${API_ROOT}/session`, {
      method: 'DELETE',
      credentials: 'same-origin',
      cache: 'no-store',
      headers,
    });
  } catch {
    // Clear local controls even if the server is unreachable.
  }
  setLoginError('Du har loggat ut.');
  showLogin('Du har loggat ut.');
}

async function fetchOverview() {
  const response = await fetch(`${API_ROOT}/overview`, {
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { accept: 'application/json' },
  });
  if (response.status === 401 || response.status === 403)
    throw new SessionExpiredError('Sessionen har gått ut.');
  if (!response.ok) throw new Error('Rumsstatus kunde inte hämtas.');
  const result = await response.json();
  if (!result?.state?.presence || !result?.state?.lighting?.devices)
    throw new Error('Servern returnerade ett ogiltigt rumsstatus.');
  return result;
}

function startLiveUpdates() {
  stopLiveUpdates();
  setLiveStatus('Ansluter till liveuppdateringar', 'warn');
  eventSource = new EventSource(`${API_ROOT}/events`, {
    withCredentials: true,
  });
  eventSource.onopen = () => setLiveStatus('Liveuppdatering ansluten', 'good');
  eventSource.onmessage = (event) => {
    try {
      const next = JSON.parse(event.data);
      if (!next?.state?.presence || !next?.state?.lighting?.devices) return;
      overview = next;
      render();
    } catch {
      setLiveStatus('Ogiltig liveuppdatering', 'warn');
    }
  };
  eventSource.onerror = () => {
    if (eventSource?.readyState === EventSource.CLOSED) {
      setLiveStatus('Liveuppdatering stängd', 'bad');
    } else {
      setLiveStatus('Liveuppdatering återansluter', 'warn');
    }
  };
  pollTimer = window.setInterval(() => {
    if (!eventSource || eventSource.readyState === EventSource.OPEN) return;
    void refreshOverview();
  }, 15000);
}

function stopLiveUpdates() {
  if (eventSource) eventSource.close();
  eventSource = null;
  if (pollTimer !== null) window.clearInterval(pollTimer);
  pollTimer = null;
}

async function refreshOverview() {
  try {
    overview = await fetchOverview();
    render();
  } catch (error) {
    if (error instanceof SessionExpiredError) {
      showLogin('Sessionen har gått ut. Logga in igen.');
      return;
    }
    setLiveStatus('Kan inte hämta status', 'bad');
  }
}

async function invokeCapability(capability, input, actionKey) {
  if (!csrfToken || pendingActions.has(actionKey)) return;
  pendingActions.add(actionKey);
  setActionMessage('Skickar begäran…');
  render();

  try {
    const response = await fetch(
      `${API_ROOT}/capabilities/${encodeURIComponent(capability)}`,
      {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          'content-type': 'application/json',
          'X-Lugn-CSRF': csrfToken,
        },
        body: JSON.stringify({ input }),
      },
    );
    if (response.status === 401 || response.status === 403)
      throw new SessionExpiredError('Sessionen har gått ut.');
    if (!response.ok) {
      if (response.status === 400 || response.status === 404)
        throw new Error(
          'Begäran kunde inte användas. Kontrollera vald scen eller lampa.',
        );
      throw new Error('Begäran kunde inte skickas. Försök igen.');
    }
    setActionMessage(
      overview?.state?.presence?.state === 'confirmed_empty'
        ? 'Önskat läge sparat. Lamporna hålls släckta tills rummet blir upptaget.'
        : 'Begäran skickad. Lampornas rapporterade läge visar om ändringen har nått fram.',
    );
    await refreshOverview();
  } catch (error) {
    if (error instanceof SessionExpiredError) {
      showLogin('Sessionen har gått ut. Logga in igen.');
      return;
    }
    setActionMessage(
      error instanceof Error
        ? error.message
        : 'Begäran kunde inte skickas. Försök igen.',
      'bad',
    );
  } finally {
    pendingActions.delete(actionKey);
    if (overview) render();
  }
}

function render() {
  if (!overview) return;
  const focusedKey = document.activeElement?.dataset?.focusKey;
  const focusedValue =
    document.activeElement instanceof HTMLInputElement &&
    document.activeElement.type === 'range'
      ? document.activeElement.value
      : null;
  showDashboard();
  renderRoomStatus(overview);
  renderScenes(overview);
  const devices = overview.state?.lighting?.devices ?? {};
  const presenceState = overview.state?.presence?.state ?? 'unknown';
  renderLights(devices, presenceState);
  renderMappingSummary(devices, presenceState);
  renderUpdatedAt(overview.state?.updatedAt);
  actionStatus.textContent = actionMessage;
  actionStatus.dataset.tone = actionTone;
  restoreFocus(focusedKey, focusedValue);
}

function restoreFocus(focusedKey, focusedValue) {
  if (!focusedKey) return;
  const element = [...document.querySelectorAll('[data-focus-key]')].find(
    (candidate) => candidate.dataset.focusKey === focusedKey,
  );
  if (!element) return;
  element.focus({ preventScroll: true });
  if (
    focusedValue !== null &&
    element instanceof HTMLInputElement &&
    element.type === 'range' &&
    !element.disabled
  ) {
    element.value = focusedValue;
    const output = element
      .closest('.brightness-control')
      ?.querySelector('.brightness-value');
    if (output) output.textContent = `Nytt önskemål ${focusedValue}%`;
  }
}

function renderRoomStatus(data) {
  const presence = data.state.presence ?? {};
  const tone = presenceTone(presence.state);
  roomPresence.dataset.tone = tone;
  const presenceLabels = {
    occupied: 'Någon i rummet',
    confirmed_empty: 'Rummet är tomt',
    unknown: 'Närvaro okänd',
  };
  presenceTitle.textContent = presenceLabels[presence.state] ?? 'Närvaro okänd';
  if (presence.state === 'occupied' && Number.isInteger(presence.personCount)) {
    const count = presence.personCount;
    presenceDetail.textContent = `${count} ${count === 1 ? 'person' : 'personer'} registrerade`;
  } else if (presence.state === 'confirmed_empty') {
    presenceDetail.textContent =
      'Rummet är tomt. Lamporna hålls släckta; vald scen återupptas vid nästa besök.';
  } else {
    presenceDetail.textContent = 'Lugn inväntar en säker närvarosignal';
  }

  const health = data.health ?? {};
  const healthLabels = {
    ok: ['Systemet igång', 'good'],
    degraded: ['Begränsad drift', 'warn'],
  };
  const [label, healthTone] = healthLabels[health.status] ?? [
    'Okänd status',
    'neutral',
  ];
  healthTitle.textContent = label;
  healthChip.textContent =
    health.status === 'ok'
      ? 'Normal'
      : health.status === 'degraded'
        ? 'Degraderad'
        : 'Okänd';
  healthChip.dataset.tone = healthTone;
  integrationList.replaceChildren();
  const integrations = Object.entries(health.integrations ?? {}).sort(
    ([a], [b]) => a.localeCompare(b),
  );
  if (integrations.length === 0) {
    const item = node('li', 'integration-item');
    item.append(node('span', 'integration-name', 'Integrationer'));
    item.append(node('span', 'integration-value', 'Ingen status'));
    integrationList.append(item);
  }
  for (const [name, status] of integrations) {
    const [statusLabel, statusTone] = integrationStatus(status);
    const item = node('li', 'integration-item');
    item.append(node('span', 'integration-name', integrationLabel(name)));
    const value = node('span', 'integration-value', statusLabel);
    value.dataset.tone = statusTone;
    item.append(value);
    integrationList.append(item);
  }

  systemAlert.hidden = health.status === 'ok';
  systemAlert.textContent =
    health.status === 'degraded'
      ? 'En eller flera anslutningar är begränsade. Se status per integration innan du felsöker en lampa.'
      : health.status === 'ok'
        ? ''
        : 'Systemstatus är okänd. Lampornas rapporterade värden kan vara inaktuella.';
}

function renderScenes(data) {
  const scenes = Array.isArray(data.scenes) ? data.scenes : [];
  const currentScene = data.state.lighting.currentScene;
  const currentSceneInfo = scenes.find((scene) => scene.id === currentScene);
  sceneSummary.textContent = currentSceneInfo
    ? `Vald scen: ${currentSceneInfo.name}`
    : currentScene
      ? 'En scen är vald men finns inte i den aktuella scenlistan.'
      : 'Ingen aktiv scen';
  reapplyButton.hidden = !currentScene;
  reapplyButton.disabled = pendingActions.has('scene');
  reapplyButton.dataset.focusKey = 'reapply-scene';

  sceneList.replaceChildren();
  if (scenes.length === 0) {
    sceneList.append(
      node('p', 'empty-note', 'Inga ljusscener är konfigurerade.'),
    );
    return;
  }
  for (const scene of scenes) {
    const selected = scene.id === currentScene;
    const button = node('button', 'scene-button');
    button.type = 'button';
    button.disabled = pendingActions.has('scene');
    button.setAttribute('aria-pressed', String(selected));
    button.dataset.focusKey = `scene:${scene.id}`;
    const name = node('span', 'scene-name', scene.name);
    button.append(name);
    if (selected) button.append(node('span', 'scene-selected', 'Vald'));
    button.addEventListener('click', () => {
      void invokeCapability(
        'lighting.activateScene',
        { sceneId: scene.id },
        'scene',
      );
    });
    sceneList.append(button);
  }
}

function renderLights(devices, presenceState) {
  lightList.replaceChildren();
  const entries = Object.entries(devices).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  if (entries.length === 0) {
    lightList.append(
      node('p', 'empty-note', 'Inga lampor är mappade till Lugn ännu.'),
    );
    return;
  }
  for (const [target, device] of entries) {
    lightList.append(renderLight(target, device, presenceState));
  }
}

function renderLight(target, device, presenceState) {
  const article = node('article', 'light-row');
  const identity = node('div', 'light-identity');
  identity.append(node('h3', '', displayTarget(target)));
  identity.append(node('code', '', target));
  const badges = node('div', 'light-badges');
  const availability = availabilityStatus(device.availability);
  badges.append(stateChip(availability.label, availability.tone));
  const convergence = convergenceStatus(device, presenceState);
  badges.append(stateChip(convergence.label, convergence.tone));
  identity.append(badges);
  article.append(identity);

  const readings = node('dl', 'light-readings');
  appendReading(
    readings,
    'Önskad ström',
    formatPower(device.effectiveDesired?.power),
    device.effectiveDesired?.power === undefined ? 'warn' : '',
  );
  appendReading(
    readings,
    'Rapporterad ström',
    formatPower(device.observed?.power),
    device.observed?.power === undefined ? 'warn' : '',
  );
  if (hasBrightness(device)) {
    appendReading(
      readings,
      'Önskad ljusstyrka',
      formatPercent(device.effectiveDesired?.brightness),
      device.effectiveDesired?.brightness === undefined ? 'warn' : '',
    );
    appendReading(
      readings,
      'Rapporterad ljusstyrka',
      formatPercent(device.observed?.brightness),
      device.observed?.brightness === undefined ? 'warn' : '',
    );
  }
  if (hasColorTemperature(device)) {
    appendReading(
      readings,
      'Önskad färgtemperatur',
      formatTemperature(device.effectiveDesired?.colorTemperature),
      device.effectiveDesired?.colorTemperature === undefined ? 'warn' : '',
    );
    appendReading(
      readings,
      'Rapporterad färgtemperatur',
      formatTemperature(device.observed?.colorTemperature),
      device.observed?.colorTemperature === undefined ? 'warn' : '',
    );
  }
  article.append(readings);

  const controls = node('div', 'light-controls');
  const isPending = pendingActions.has(`light:${target}`);
  const unavailable = device.availability === 'unavailable';
  const knownPower = device.effectiveDesired?.power ?? device.observed?.power;
  const powerControl = node('div', 'power-control');
  powerControl.append(node('span', 'power-label', 'Ström'));
  const powerLabel = node('label', 'power-toggle');
  const powerInput = document.createElement('input');
  powerInput.type = 'checkbox';
  powerInput.className = 'switch-input';
  powerInput.checked = knownPower === true;
  powerInput.indeterminate = knownPower === undefined;
  powerInput.disabled = unavailable || isPending;
  powerInput.setAttribute(
    'aria-label',
    `Önskat strömläge för ${displayTarget(target)}`,
  );
  powerInput.dataset.focusKey = `power:${target}`;
  const switchTrack = node('span', 'switch-track');
  switchTrack.setAttribute('aria-hidden', 'true');
  powerLabel.append(powerInput, switchTrack);
  powerControl.append(powerLabel);
  powerInput.addEventListener('change', () => {
    void invokeCapability(
      'lighting.set',
      { target, values: { power: powerInput.checked } },
      `light:${target}`,
    );
  });
  controls.append(powerControl);

  if (hasBrightness(device)) {
    controls.append(
      renderBrightnessControl(target, device, unavailable || isPending),
    );
  }
  controls.append(
    node('p', 'ownership-note', ownershipLabel(device.ownership)),
  );
  article.append(controls);
  return article;
}

function renderBrightnessControl(target, device, disabled) {
  const wrap = node('div', 'brightness-control');
  const current =
    device.effectiveDesired?.brightness ?? device.observed?.brightness;
  const minus = node('button', 'adjust-button', '−10');
  minus.type = 'button';
  minus.disabled = disabled || !Number.isInteger(current) || current <= 0;
  minus.setAttribute(
    'aria-label',
    `Sänk ljusstyrkan för ${displayTarget(target)} med 10 procentenheter`,
  );
  minus.dataset.focusKey = `adjust-down:${target}`;
  minus.addEventListener('click', () => {
    void invokeCapability(
      'lighting.adjust',
      { target, brightnessDelta: -10 },
      `light:${target}`,
    );
  });

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '100';
  slider.step = '1';
  slider.value = String(Number.isInteger(current) ? current : 0);
  slider.disabled = disabled;
  slider.setAttribute(
    'aria-label',
    `Önskad ljusstyrka för ${displayTarget(target)}`,
  );
  slider.dataset.focusKey = `brightness:${target}`;
  const value = node(
    'span',
    'brightness-value',
    Number.isInteger(current) ? `${current}%` : 'Okänd',
  );
  slider.addEventListener('input', () => {
    value.textContent = `Nytt önskemål ${slider.value}%`;
  });
  slider.addEventListener('change', () => {
    void invokeCapability(
      'lighting.set',
      { target, values: { brightness: Number(slider.value) } },
      `light:${target}`,
    );
  });

  const plus = node('button', 'adjust-button', '+10');
  plus.type = 'button';
  plus.disabled = disabled || !Number.isInteger(current) || current >= 100;
  plus.setAttribute(
    'aria-label',
    `Höj ljusstyrkan för ${displayTarget(target)} med 10 procentenheter`,
  );
  plus.dataset.focusKey = `adjust-up:${target}`;
  plus.addEventListener('click', () => {
    void invokeCapability(
      'lighting.adjust',
      { target, brightnessDelta: 10 },
      `light:${target}`,
    );
  });

  wrap.append(minus, slider, value, plus);
  return wrap;
}

function appendReading(list, label, value, tone = '') {
  const item = node('div', 'reading');
  item.append(node('dt', '', label));
  const result = node('dd', '', value);
  if (tone) result.dataset.tone = tone;
  item.append(result);
  list.append(item);
}

function stateChip(label, tone) {
  const chip = node('span', 'state-chip', label);
  chip.dataset.tone = tone;
  return chip;
}

function renderMappingSummary(devices, presenceState) {
  if (presenceState === 'confirmed_empty') {
    const values = Object.values(devices);
    const unavailable = values.filter(
      (device) => device.availability === 'unavailable',
    ).length;
    const degraded = values.filter(
      (device) => device.availability === 'degraded',
    ).length;
    const parts = ['Lamporna hålls släckta medan rummet är tomt'];
    if (unavailable) parts.push(`${unavailable} otillgängliga`);
    if (degraded) parts.push(`${degraded} med degraderad status`);
    mappingSummary.textContent = parts.join(' · ');
    return;
  }
  const counts = {
    aligned: 0,
    waiting: 0,
    diverged: 0,
    unavailable: 0,
    empty: 0,
    degraded: 0,
  };
  for (const device of Object.values(devices)) {
    if (device.availability === 'unavailable') {
      counts.unavailable += 1;
      continue;
    }
    if (device.availability === 'degraded') {
      counts.degraded += 1;
      continue;
    }
    const desired = device.effectiveDesired ?? {};
    const properties = Object.keys(desired);
    if (properties.length === 0) {
      counts.empty += 1;
      continue;
    }
    if (
      properties.some((property) => device.observed?.[property] === undefined)
    ) {
      counts.waiting += 1;
      continue;
    }
    if (
      properties.every(
        (property) => device.observed[property] === desired[property],
      )
    ) {
      counts.aligned += 1;
    } else {
      counts.diverged += 1;
    }
  }
  const parts = [];
  if (counts.aligned)
    parts.push(`${counts.aligned} rapporterade värden stämmer`);
  if (counts.waiting) parts.push(`${counts.waiting} inväntar återrapportering`);
  if (counts.diverged)
    parts.push(`${counts.diverged} avviker från önskat läge`);
  if (counts.unavailable) parts.push(`${counts.unavailable} otillgängliga`);
  if (counts.degraded) parts.push(`${counts.degraded} med degraderad status`);
  if (counts.empty) parts.push(`${counts.empty} utan önskade värden`);
  mappingSummary.textContent = parts.length
    ? parts.join(' · ')
    : 'Inga lampor att visa';
}

function renderUpdatedAt(value) {
  if (!Number.isFinite(value) || value < 0) {
    updatedAt.textContent = 'Uppdateringstid saknas';
    return;
  }
  const date = new Date(value);
  updatedAt.textContent = Number.isNaN(date.getTime())
    ? 'Uppdateringstid saknas'
    : `Tillstånd ändrat ${new Intl.DateTimeFormat('sv-SE', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }).format(date)}`;
}

function integrationLabel(name) {
  const labels = {
    home_assistant: 'Home Assistant',
    mqtt: 'MQTT',
  };
  return (
    labels[name] ??
    name.replace(/[._-]+/g, ' ').replace(/^./, (letter) => letter.toUpperCase())
  );
}

function integrationStatus(status) {
  const statuses = {
    connected: ['Ansluten', 'good'],
    not_configured: ['Inte konfigurerad', 'neutral'],
    connecting: ['Ansluter', 'warn'],
    authenticating: ['Verifierar', 'warn'],
    subscribing: ['Startar', 'warn'],
    reconnecting: ['Återansluter', 'warn'],
    disconnected: ['Frånkopplad', 'bad'],
    stopped: ['Stoppad', 'bad'],
    failed: ['Fel', 'bad'],
  };
  return statuses[status] ?? ['Okänd status', 'neutral'];
}

function presenceTone(state) {
  if (state === 'occupied') return 'good';
  if (state === 'confirmed_empty') return 'neutral';
  return 'warn';
}

function availabilityStatus(availability) {
  const statuses = {
    available: { label: 'Tillgänglig', tone: 'good' },
    degraded: { label: 'Degraderad', tone: 'warn' },
    unavailable: { label: 'Otillgänglig', tone: 'bad' },
  };
  return statuses[availability] ?? { label: 'Status okänd', tone: 'neutral' };
}

function convergenceStatus(device, presenceState) {
  if (device.availability === 'unavailable')
    return { label: 'Ingen aktuell återrapportering', tone: 'bad' };
  if (device.availability === 'degraded')
    return { label: 'Återrapportering begränsad', tone: 'warn' };
  if (presenceState === 'confirmed_empty') {
    if (device.observed?.power === false)
      return { label: 'Av enligt tomt-rum-läge', tone: 'neutral' };
    if (device.observed?.power === true)
      return { label: 'Väntar på avstängning', tone: 'warn' };
    return { label: 'Inväntar avstängningsrapport', tone: 'warn' };
  }
  const desired = device.effectiveDesired ?? {};
  const properties = Object.keys(desired);
  if (properties.length === 0)
    return { label: 'Inget önskat läge', tone: 'neutral' };
  if (properties.some((property) => device.observed?.[property] === undefined))
    return { label: 'Inväntar återrapportering', tone: 'warn' };
  if (
    properties.every(
      (property) => device.observed[property] === desired[property],
    )
  )
    return { label: 'Rapporterat läge stämmer', tone: 'good' };
  return { label: 'Avviker från önskat läge', tone: 'warn' };
}

function ownershipLabel(ownership = {}) {
  const values = Object.values(ownership);
  const names = new Set();
  for (const item of values) {
    if (item.kind === 'scene') {
      names.add('Scenstyrd');
    } else if (item.kind === 'override') {
      names.add(
        item.actor?.type === 'home_assistant'
          ? 'Överstyrd via Home Assistant'
          : 'Manuell justering',
      );
    }
  }
  return names.size
    ? [...names].join(' · ')
    : 'Ingen aktiv scen- eller manuell ägare';
}

function displayTarget(target) {
  const label = target
    .replace(/^lighting\./, '')
    .replace(/[._-]+/g, ' ')
    .trim();
  return label
    ? label.replace(/^./, (letter) => letter.toLocaleUpperCase('sv-SE'))
    : target;
}

function formatPower(value) {
  if (value === true) return 'På';
  if (value === false) return 'Av';
  return 'Okänt';
}

function formatPercent(value) {
  return Number.isInteger(value) ? `${value}%` : 'Okänd';
}

function formatTemperature(value) {
  return Number.isInteger(value) ? `${value} K` : 'Okänd';
}

function hasBrightness(device) {
  return (
    Number.isInteger(device.effectiveDesired?.brightness) ||
    Number.isInteger(device.observed?.brightness)
  );
}

function hasColorTemperature(device) {
  return (
    Number.isInteger(device.effectiveDesired?.colorTemperature) ||
    Number.isInteger(device.observed?.colorTemperature)
  );
}
