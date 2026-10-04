const BASE_PATH = location.pathname.replace(/\/?$/, '/');
const STATE_URL = `${BASE_PATH}display-api/state`;
const EVENTS_URL = `${BASE_PATH}display-api/events`;
const SCENE_URL = `${BASE_PATH}display-api/scene`;
const MUSIC_URL = `${BASE_PATH}display-api/music`;
const MUSIC_PRESET_URL = `${BASE_PATH}display-api/music-preset`;
const POLL_MS = 2000;
const STREAM_CHECK_MS = 15000;
const SENSOR_STALE_AFTER_MS = 15 * 60 * 1000;

const root = document.querySelector('#app-root');
const refs = {
  clockTime: document.querySelector('#clock-time'),
  clockDate: document.querySelector('#clock-date'),
  roomPresence: document.querySelector('#room-presence'),
  connection: document.querySelector('#connection-notice'),
  connectionMessage: document.querySelector('#connection-message'),
  retry: document.querySelector('#retry-button'),
  sceneGrid: document.querySelector('#scene-grid'),
  musicPlayerStatus: document.querySelector('#music-player-status'),
  musicTitle: document.querySelector('#music-title'),
  musicSource: document.querySelector('#music-source'),
  musicPresetDj: document.querySelector('#music-preset-dj'),
  musicPresetOptical: document.querySelector('#music-preset-optical'),
  musicPlayback: document.querySelector('#music-playback'),
  musicPlaybackIcon: document.querySelector('#music-playback-icon'),
  musicPlaybackLabel: document.querySelector('#music-playback-label'),
  musicVolumeDown: document.querySelector('#music-volume-down'),
  musicVolumeUp: document.querySelector('#music-volume-up'),
  musicVolumeValue: document.querySelector('#music-volume-value'),
  musicVolumeObservedLabel: document.querySelector(
    '#music-volume-observed-label',
  ),
  musicVolumePolicy: document.querySelector('#music-volume-policy'),
  musicVolumeController: document.querySelector('#music-volume-controller'),
  musicVolumeBaselineLabel: document.querySelector(
    '#music-volume-baseline-label',
  ),
  musicVolumeBaseline: document.querySelector('#music-volume-baseline'),
  musicVolumeTarget: document.querySelector('#music-volume-target'),
  musicVolumeTargetLabel: document.querySelector('#music-volume-target-label'),
  musicVolumeTargetState: document.querySelector('#music-volume-target-state'),
  musicVolumeAdjustments: document.querySelector('#music-volume-adjustments'),
  toast: document.querySelector('#toast'),
  feedback: document.querySelector('#feedback-slot'),
};

const sceneButtons = new Map();
const pending = new Set();
const metricRefs = new Map(
  ['temperature', 'co2', 'pm25', 'humidity'].map((name) => [
    name,
    {
      value: document.querySelector(`#metric-${name}`),
      state: document.querySelector(`#metric-${name}-state`),
      row: document.querySelector(`[data-metric="${name}"]`),
    },
  ]),
);

let latestPayload;
let lastFreshAt = 0;
let sceneOrderKey = null;
let musicTarget = '';
let polling = null;
let timer;
let clockTimer;
let toastTimer;
let stopped = false;
let eventSource;
let streamHealthy = false;
let reconnectTimer;
let reconnectDelay = 1000;
let streamWatchdog;
let latestDeliveryRevision = -1;
let currentInstanceId;
let instanceGeneration = 0;
const retiredInstances = new Set();

function acceptPayload(payload) {
  if (
    !payload ||
    typeof payload !== 'object' ||
    !payload.state ||
    !Number.isInteger(payload.state.revision) ||
    payload.state.revision < 0
  )
    throw new Error('invalid_state');
  if (
    typeof payload.instanceId === 'string' &&
    payload.instanceId !== currentInstanceId
  ) {
    if (retiredInstances.has(payload.instanceId)) return false;
    if (currentInstanceId) retiredInstances.add(currentInstanceId);
    if (retiredInstances.size > 16)
      retiredInstances.delete(retiredInstances.values().next().value);
    currentInstanceId = payload.instanceId;
    instanceGeneration += 1;
    latestPayload = undefined;
    latestDeliveryRevision = -1;
  }
  const currentRevision = latestPayload?.state?.revision ?? -1;
  if (payload.state.revision < currentRevision) return false;
  if (
    payload.state.revision === currentRevision &&
    Number.isInteger(payload.deliveryRevision) &&
    payload.deliveryRevision < latestDeliveryRevision
  )
    return false;
  latestDeliveryRevision = Number.isInteger(payload.deliveryRevision)
    ? payload.deliveryRevision
    : latestDeliveryRevision;
  setConnection('connected', 'Lugn ansluten');
  render(payload);
  lastFreshAt = Date.now();
  return true;
}

function disconnectStream() {
  streamHealthy = false;
  eventSource?.close();
  eventSource = undefined;
  window.clearTimeout(streamWatchdog);
}

function retryStream() {
  disconnectStream();
  if (stopped || document.visibilityState === 'hidden') return;
  window.clearTimeout(reconnectTimer);
  reconnectTimer = window.setTimeout(connectStream, reconnectDelay);
  reconnectDelay = Math.min(30000, reconnectDelay * 2);
  void refresh();
}

function connectStream() {
  if (
    stopped ||
    eventSource ||
    document.visibilityState === 'hidden' ||
    typeof window.EventSource !== 'function'
  )
    return;
  let source;
  try {
    source = new window.EventSource(EVENTS_URL);
  } catch {
    retryStream();
    return;
  }
  eventSource = source;
  // Also bound a socket that opens but never supplies usable state.
  streamWatchdog = window.setTimeout(retryStream, STREAM_CHECK_MS);
  source.onmessage = (event) => {
    if (source !== eventSource || stopped) return;
    try {
      if (!acceptPayload(JSON.parse(event.data))) return;
      streamHealthy = true;
      reconnectDelay = 1000;
      window.clearTimeout(streamWatchdog);
      streamWatchdog = window.setTimeout(retryStream, STREAM_CHECK_MS);
      window.clearTimeout(timer);
      timer = window.setTimeout(refresh, STREAM_CHECK_MS);
    } catch {
      retryStream();
    }
  };
  source.onerror = () => {
    if (source === eventSource) retryStream();
  };
}

function setText(element, value) {
  if (!element) return;
  const text = String(value);
  if (element.textContent !== text) element.textContent = text;
}

function roleName(role) {
  return role === 'bed' ? 'bed' : role === 'desk' ? 'desk' : 'unknown';
}

function setRole(role) {
  root.dataset.role = roleName(role);
}

function setConnection(state, message, retry = false) {
  if (
    refs.connection.dataset.state === state &&
    refs.connectionMessage.textContent === message &&
    refs.retry.hidden === !retry
  ) {
    return;
  }
  refs.connection.dataset.state = state;
  setText(refs.connectionMessage, message);
  refs.retry.hidden = !retry;
  refs.connection.hidden = state === 'connected' || state === 'loading';
  if (!refs.connection.hidden) {
    window.clearTimeout(toastTimer);
    refs.toast.hidden = true;
  }
  syncFeedback();
  renderScenes(latestPayload);
  renderMusic(latestPayload);
}

function setClock() {
  const now = new Date();
  const time = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    hour: '2-digit',
    minute: '2-digit',
  }).format(now);
  const date = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(now);
  setText(refs.clockTime, time);
  setText(refs.clockDate, date);
  const dateParts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const dateValue = Object.fromEntries(
    dateParts
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  refs.clockDate.dateTime = `${dateValue.year}-${dateValue.month}-${dateValue.day}`;
}

function getSceneList(payload) {
  if (!Array.isArray(payload?.scenes)) return [];
  const unique = new Map();
  for (const scene of payload.scenes) {
    if (
      scene &&
      typeof scene.id === 'string' &&
      typeof scene.name === 'string' &&
      !unique.has(scene.id)
    ) {
      unique.set(scene.id, { id: scene.id, name: scene.name });
    }
  }
  const sceneOrder = [
    'scene.all_off',
    'scene.soft_light',
    'scene.everyday_light',
    'scene.movie_light',
    'scene.focus_light',
  ];
  return [...unique.values()].sort((a, b) => {
    const rank = (id) => {
      const index = sceneOrder.indexOf(id);
      return index < 0 ? sceneOrder.length : index;
    };
    const difference = rank(a.id) - rank(b.id);
    return difference || a.name.localeCompare(b.name, 'sv');
  });
}

function sceneButtonFor(scene) {
  let button = sceneButtons.get(scene.id);
  if (button) return button;
  button = document.createElement('button');
  button.type = 'button';
  button.className = 'scene-button';
  button.dataset.scene = scene.id;
  button.setAttribute('aria-pressed', 'false');
  const copy = document.createElement('span');
  copy.className = 'scene-copy';
  const name = document.createElement('span');
  name.className = 'scene-name';
  copy.append(name);
  const status = document.createElement('span');
  status.className = 'scene-status';
  copy.append(status);
  const mark = document.createElement('span');
  mark.className = 'scene-current-mark';
  mark.setAttribute('aria-hidden', 'true');
  button.append(copy, mark);
  sceneButtons.set(scene.id, button);
  return button;
}

function renderScenes(payload) {
  if (!refs.sceneGrid) return;
  const scenes = getSceneList(payload);
  const current = payload?.state?.lighting?.currentScene;
  const ids = new Set(scenes.map((scene) => scene.id));
  for (const [sceneId, button] of sceneButtons) {
    if (!ids.has(sceneId)) {
      button.remove();
      sceneButtons.delete(sceneId);
    }
  }
  if (scenes.length === 0) {
    if (!refs.sceneGrid.querySelector('.section-empty')) {
      const empty = document.createElement('p');
      empty.className = 'section-empty';
      empty.textContent = 'Ljuslägen visas när Lugn är anslutet.';
      refs.sceneGrid.replaceChildren(empty);
    }
    return;
  }
  const ordered = [];
  for (const scene of scenes) {
    const button = sceneButtonFor(scene);
    button.querySelector('.scene-name').textContent = scene.name;
    button.dataset.kind = scene.id === 'scene.all_off' ? 'off' : 'scene';
    const isPending = pending.has(`scene:${scene.id}`);
    button.disabled = isUnavailable() || isPending;
    button.setAttribute('aria-busy', String(isPending));
    const selected = scene.id === current;
    const awaitingDevices =
      selected &&
      payload?.state?.commands?.some(
        (command) =>
          command.revision === payload.state.lighting.sceneRevision &&
          command.status === 'pending',
      );
    const confirmed =
      selected &&
      Object.values(payload?.state?.lighting?.devices ?? {}).every((device) =>
        Object.entries(device.effectiveDesired ?? {}).every(
          ([property, value]) =>
            (device.effectiveDesired.power === false && property !== 'power') ||
            (device.availability === 'available' &&
              device.observed?.[property] === value),
        ),
      );
    const status = isPending
      ? 'Skickar …'
      : !selected
        ? ''
        : awaitingDevices
          ? 'Valt · väntar på lampor'
          : confirmed
            ? 'Bekräftat'
            : 'Valt';
    setText(button.querySelector('.scene-status'), status);
    button.querySelector('.scene-status').hidden = !status;
    if (button.getAttribute('aria-pressed') !== String(selected))
      button.setAttribute('aria-pressed', String(selected));
    ordered.push(button);
  }
  const orderKey = scenes.map((scene) => scene.id).join('\u0000');
  if (
    sceneOrderKey !== orderKey ||
    refs.sceneGrid.firstElementChild?.classList.contains('section-empty')
  ) {
    refs.sceneGrid.replaceChildren(...ordered);
    sceneOrderKey = orderKey;
  }
}

function renderEnvironment(environment) {
  const metrics =
    environment && typeof environment === 'object' ? environment : {};
  for (const [name, elements] of metricRefs) {
    const metric = metrics[name];
    const value = metric?.value;
    const observedAt = metric?.observedAt;
    const unit = typeof metric?.unit === 'string' ? metric.unit : '';
    const valid = typeof value === 'number' && Number.isFinite(value);
    elements.row.dataset.state = valid ? 'available' : 'missing';
    if (!valid) {
      setText(elements.value, '—');
      delete elements.value.dataset.value;
      setText(elements.state, 'Ingen sensordata');
      continue;
    }
    const formatted = new Intl.NumberFormat('sv-SE', {
      minimumFractionDigits: 0,
      maximumFractionDigits: name === 'temperature' || name === 'pm25' ? 1 : 0,
    }).format(value);
    const displayKey = `${formatted} ${unit}`;
    if (elements.value.dataset.value !== displayKey) {
      const unitLabel = document.createElement('span');
      unitLabel.className = 'metric-unit';
      unitLabel.textContent = unit ? ` ${unit}` : '';
      elements.value.replaceChildren(
        document.createTextNode(formatted),
        unitLabel,
      );
      elements.value.dataset.value = displayKey;
    }
    const freshTime =
      typeof observedAt === 'number' && Number.isFinite(observedAt)
        ? observedAt
        : 0;
    const stale =
      freshTime > 0 && Date.now() - freshTime > SENSOR_STALE_AFTER_MS;
    elements.row.dataset.state = stale ? 'stale' : 'available';
    setText(
      elements.state,
      stale ? 'Gammalt värde' : freshTime > 0 ? '' : 'Mättid saknas',
    );
    if (freshTime === 0) elements.row.dataset.state = 'unknown';
  }
}

function renderRoomPresence(state) {
  const presence = state?.presence;
  if (presence?.state === 'confirmed_empty') {
    setText(refs.roomPresence, 'Rummet är tomt');
    return;
  }
  if (presence?.state !== 'occupied') {
    setText(refs.roomPresence, 'Närvaro okänd');
    return;
  }
  const count = presence.personCount;
  if (!Number.isInteger(count) || count < 1) {
    setText(refs.roomPresence, 'I rummet · antal okänt');
    return;
  }
  setText(
    refs.roomPresence,
    `I rummet · ${count} ${count === 1 ? 'person' : 'personer'}`,
  );
}

function musicDevices(payload) {
  const devices = payload?.state?.music?.devices;
  if (!devices || typeof devices !== 'object') return [];
  return Object.entries(devices).filter(
    ([target, device]) =>
      target.startsWith('music.') && device && typeof device === 'object',
  );
}

function volumeFraction(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : null;
}

function formatVolume(value) {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

function formatVolumeOffset(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const percentagePoints = Math.round(Math.abs(value) * 100);
  if (percentagePoints === 0) return '0 pp';
  return `${value < 0 ? '−' : '+'}${percentagePoints} pp`;
}

function renderMusicVolumePolicy(payload, target) {
  const policy = target ? payload?.musicVolumePolicies?.[target] : null;
  const baseline = volumeFraction(policy?.baseline);
  const requested = volumeFraction(
    payload?.state?.music?.devices?.[target]?.requested?.volume,
  );
  const goal = requested ?? volumeFraction(policy?.target);
  const controller =
    policy?.controller === 'lugn' || policy?.controller === 'you'
      ? policy.controller
      : 'unknown';
  refs.musicVolumePolicy.dataset.controller = controller;
  setText(
    refs.musicVolumeController,
    controller === 'lugn' && policy?.automatic === true
      ? 'Lugn justerar volymen'
      : controller === 'you' && policy?.automatic === true
        ? 'Du ändrade volymen'
        : controller === 'you'
          ? 'Du styr volymen'
          : 'Volymstyrning okänd',
  );
  setText(
    refs.musicVolumeTargetLabel,
    requested !== null
      ? 'Begärt mål'
      : policy?.automatic === true
        ? 'Automatiskt mål'
        : 'Mål',
  );
  setText(refs.musicVolumeTarget, formatVolume(goal));
  const explanation =
    requested !== null &&
    Math.abs(
      requested -
        (payload?.state?.music?.devices?.[target]?.observed?.volume ?? -1),
    ) > 0.005
      ? 'Begärt · väntar på spelaren'
      : goal === null
        ? 'Mål saknas'
        : policy?.automatic === true && policy?.baselineSource === 'user'
          ? 'Din bas · Lugn anpassar efter dygn och antal personer'
          : policy?.automatic === true
            ? 'Målet följer dygn och antal personer'
            : controller === 'you'
              ? 'Automatiken är pausad'
              : 'Väntar på volymregel';
  setText(refs.musicVolumeTargetState, explanation);
  refs.musicVolumeTargetState.hidden = !explanation;
  setText(
    refs.musicVolumeBaselineLabel,
    policy?.baselineSource === 'user'
      ? 'Din bas'
      : policy?.baselineSource === 'inferred'
        ? 'Uppskattad bas'
        : 'Basnivå',
  );
  setText(refs.musicVolumeBaseline, formatVolume(baseline));
  const presence = payload?.state?.presence;
  const personCount =
    Number.isInteger(presence?.personCount) && presence.personCount >= 0
      ? presence.personCount
      : null;
  const personCountLabel = personCount === null ? 'okänt' : personCount;
  setText(
    refs.musicVolumeAdjustments,
    `Dygn: ${formatVolumeOffset(policy?.dailyOffset)} · Personer (${personCountLabel}): ${formatVolumeOffset(policy?.personOffset)}`,
  );
}

function renderMusic(payload) {
  const entries = musicDevices(payload);
  if (entries.length === 0) {
    musicTarget = '';
    renderMusicVolumePolicy(payload, null);
    setText(refs.musicPlayerStatus, 'Ingen musikspelare konfigurerad');
    setText(refs.musicTitle, 'Musikspelare saknas');
    setText(refs.musicSource, 'Lägg till en mediaspelare i Lugn');
    refs.musicPlayback.disabled = true;
    refs.musicPresetDj.disabled = true;
    refs.musicPresetOptical.disabled = true;
    refs.musicPresetDj.setAttribute('aria-busy', 'false');
    refs.musicPresetOptical.setAttribute('aria-busy', 'false');
    refs.musicPresetDj.dataset.state = 'unavailable';
    refs.musicPresetOptical.dataset.state = 'unavailable';
    refs.musicVolumeDown.disabled = true;
    refs.musicVolumeUp.disabled = true;
    setText(refs.musicVolumeObservedLabel, 'Nu');
    refs.musicVolumeValue.value = '—';
    refs.musicVolumeValue.setAttribute(
      'aria-label',
      'Spelarens rapporterade volym',
    );
    setText(refs.musicVolumeValue, '—');
    return;
  }
  if (!entries.some(([target]) => target === musicTarget))
    musicTarget = entries[0][0];
  const [, device] =
    entries.find(([target]) => target === musicTarget) ?? entries[0];
  const observed = device.observed ?? {};
  const availability = device.availability ?? 'unavailable';
  const isPlaying = observed.playback === 'playing';
  const isPending =
    pending.has(`music:${musicTarget}`) ||
    pending.has(`music-preset:${musicTarget}`);
  const connected = !isUnavailable();
  const canControl = availability === 'available' && connected && !isPending;
  const volumeAvailable =
    typeof observed.volume === 'number' && Number.isFinite(observed.volume);
  const volume = volumeAvailable
    ? Math.min(1, Math.max(0, observed.volume))
    : null;
  const controlVolume = musicVolumeForControl(device);
  renderMusicVolumePolicy(payload, musicTarget);

  refs.musicPlayback.disabled = !canControl;
  refs.musicPresetDj.disabled = !canControl;
  refs.musicPresetOptical.disabled = !canControl;
  refs.musicPresetDj.setAttribute('aria-busy', String(isPending));
  refs.musicPresetOptical.setAttribute('aria-busy', String(isPending));
  refs.musicPresetDj.dataset.state = isPending
    ? 'pending'
    : availability !== 'available'
      ? 'unavailable'
      : 'ready';
  refs.musicPresetOptical.dataset.state = refs.musicPresetDj.dataset.state;
  refs.musicPlayback.setAttribute(
    'aria-label',
    isPlaying ? 'Pausa musik' : 'Starta musik',
  );
  refs.musicPlayback.setAttribute('aria-pressed', String(isPlaying));
  setText(refs.musicPlaybackIcon, isPlaying ? 'Ⅱ' : '▶');
  setText(refs.musicPlaybackLabel, isPlaying ? 'Pausa' : 'Spela');
  refs.musicVolumeDown.disabled =
    !canControl || controlVolume === null || controlVolume <= 0;
  refs.musicVolumeUp.disabled =
    !canControl || controlVolume === null || controlVolume >= 1;
  setText(
    refs.musicVolumeObservedLabel,
    availability === 'available' ? 'Nu' : 'Senast',
  );
  refs.musicVolumeValue.setAttribute(
    'aria-label',
    availability === 'available'
      ? 'Spelarens rapporterade volym'
      : 'Senast rapporterade spelarvolym',
  );
  const title =
    typeof observed.title === 'string' && observed.title.trim()
      ? observed.title.trim()
      : isPlaying
        ? 'Musik spelas'
        : 'Ingen musik spelar';
  setText(refs.musicTitle, title);
  const source = typeof observed.source === 'string' ? observed.source : '';
  setText(
    refs.musicSource,
    source || (isPlaying ? 'Spelar musik' : 'Välj Spotify DJ eller Optical'),
  );
  setText(
    refs.musicPlayerStatus,
    isPending
      ? 'Skickar kommando …'
      : availability !== 'available'
        ? 'Spelaren är inte tillgänglig'
        : '',
  );
  refs.musicVolumeValue.value = formatVolume(volume);
  setText(refs.musicVolumeValue, refs.musicVolumeValue.value);
}

function render(payload) {
  latestPayload = payload;
  setRole(payload?.role);
  renderScenes(payload);
  renderEnvironment(payload?.environment);
  renderRoomPresence(payload?.state);
  renderMusic(payload);
}

async function getState() {
  const response = await fetch(STATE_URL, {
    method: 'GET',
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    const error = new Error(`state_${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function syncFeedback() {
  const visible = !refs.connection.hidden || !refs.toast.hidden;
  refs.feedback.hidden = !visible;
  root.dataset.feedback = String(visible);
}

function showToast(message, state) {
  if (!refs.connection.hidden) return;
  window.clearTimeout(toastTimer);
  refs.toast.dataset.state = state;
  refs.toast.textContent = message;
  refs.toast.hidden = false;
  syncFeedback();
  toastTimer = window.setTimeout(() => {
    refs.toast.hidden = true;
    syncFeedback();
  }, 8000);
}

async function refresh(afterCommand = false) {
  if (stopped || (!afterCommand && document.visibilityState === 'hidden'))
    return;
  if (polling) {
    if (!afterCommand) return polling;
    await polling;
    // A poll already in flight can contain a snapshot from before acceptance.
    // Start a new read before the command's controls become available again.
    return refresh(true);
  }
  window.clearTimeout(timer);
  polling = readState();
  return polling;
}

async function readState() {
  const readGeneration = instanceGeneration;
  try {
    const payload = await getState();
    if (
      readGeneration !== instanceGeneration &&
      payload?.instanceId !== currentInstanceId
    )
      return;
    acceptPayload(payload);
  } catch (error) {
    if (streamHealthy && error?.status !== 401 && error?.status !== 403) return;
    if (error?.status === 401 || error?.status === 403) {
      disconnectStream();
      setConnection(
        'unauthorized',
        'Kontrollpanelen saknar åtkomst. Öppna den igen från Lugn.',
        true,
      );
    } else {
      setConnection(
        'offline',
        lastFreshAt
          ? 'Kontakten med Lugn bröts. Väntar på återanslutning.'
          : 'Lugn svarar inte ännu. Försöker igen automatiskt.',
        !lastFreshAt,
      );
    }
    renderScenes(latestPayload);
    renderMusic(latestPayload);
  } finally {
    polling = null;
    window.clearTimeout(timer);
    if (!stopped)
      timer = window.setTimeout(
        refresh,
        streamHealthy ? STREAM_CHECK_MS : POLL_MS,
      );
  }
}

function isUnavailable() {
  return (
    refs.connection.dataset.state === 'offline' ||
    refs.connection.dataset.state === 'unauthorized'
  );
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    cache: 'no-store',
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const error = new Error(`command_${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json().catch(() => ({}));
}

async function runCommand(key, body) {
  if (pending.has(key) || isUnavailable()) return;
  window.clearTimeout(toastTimer);
  refs.toast.hidden = true;
  syncFeedback();
  pending.add(key);
  renderScenes(latestPayload);
  renderMusic(latestPayload);
  try {
    const url = key.startsWith('scene:')
      ? SCENE_URL
      : key.startsWith('music-preset:')
        ? MUSIC_PRESET_URL
        : MUSIC_URL;
    await postJson(url, body);
    await refresh(true);
  } catch (error) {
    if (error?.status === 401 || error?.status === 403) {
      setConnection(
        'unauthorized',
        'Åtkomsten har gått ut. Öppna kontrollpanelen igen.',
        true,
      );
    } else if (error?.status === 502 || error?.status === 504) {
      showToast(
        'Kvittens saknas. Kommandot kan ha nått enheten; status uppdateras när den svarar.',
        'pending',
      );
      await refresh(true);
    } else {
      showToast('Kommandot nådde inte Lugn. Försök igen.', 'error');
    }
  } finally {
    pending.delete(key);
    renderScenes(latestPayload);
    renderMusic(latestPayload);
  }
}

refs.sceneGrid.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-scene]');
  if (!button || !refs.sceneGrid.contains(button)) return;
  const sceneId = button.dataset.scene;
  if (!sceneId) return;
  void runCommand(`scene:${sceneId}`, { sceneId });
});

refs.musicPlayback.addEventListener('click', () => {
  const device = latestPayload?.state?.music?.devices?.[musicTarget];
  if (!device) return;
  const value = device.observed?.playback === 'playing' ? 'paused' : 'playing';
  void runCommand(`music:${musicTarget}`, {
    target: musicTarget,
    request: { property: 'playback', value },
  });
});

function selectMusicPreset(presetId) {
  if (!musicTarget) return;
  void runCommand(`music-preset:${musicTarget}`, {
    target: musicTarget,
    presetId,
  });
}

refs.musicPresetDj.addEventListener('click', () => {
  selectMusicPreset(1);
});

refs.musicPresetOptical.addEventListener('click', () => {
  selectMusicPreset(4);
});

function musicVolumeForControl(device) {
  const volume = device?.requested?.volume ?? device?.observed?.volume;
  return typeof volume === 'number' && Number.isFinite(volume)
    ? Math.min(1, Math.max(0, volume))
    : null;
}

function stepMusicVolume(direction) {
  const device = latestPayload?.state?.music?.devices?.[musicTarget];
  const volume = musicVolumeForControl(device);
  if (!musicTarget || volume === null) return;
  const value =
    Math.round(Math.min(1, Math.max(0, volume + direction * 0.05)) * 100) / 100;
  if (value === volume) return;
  void runCommand(`music:${musicTarget}`, {
    target: musicTarget,
    request: { property: 'volume', value },
  });
}

refs.musicVolumeDown.addEventListener('click', () => {
  stepMusicVolume(-1);
});

refs.musicVolumeUp.addEventListener('click', () => {
  stepMusicVolume(1);
});

refs.retry.addEventListener('click', () => {
  window.clearTimeout(timer);
  void refresh();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    window.clearTimeout(timer);
    connectStream();
    void refresh();
  } else {
    disconnectStream();
    window.clearTimeout(reconnectTimer);
  }
});

window.addEventListener('pagehide', () => {
  stopped = true;
  disconnectStream();
  window.clearTimeout(reconnectTimer);
  window.clearTimeout(timer);
  window.clearInterval(clockTimer);
  window.clearTimeout(toastTimer);
});

setClock();
clockTimer = window.setInterval(setClock, 1000);
void refresh();
connectStream();
