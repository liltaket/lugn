const BASE_PATH = location.pathname.replace(/\/?$/, '/');
const STATE_URL = `${BASE_PATH}display-api/state`;
const EVENTS_URL = `${BASE_PATH}display-api/events`;
const SCENE_URL = `${BASE_PATH}display-api/scene`;
const MUSIC_URL = `${BASE_PATH}display-api/music`;
const VOLUME_AUTHORITY_URL = `${BASE_PATH}display-api/volume-authority`;
const MUSIC_PRESET_URL = `${BASE_PATH}display-api/music-preset`;
const PRESENCE_COUNT_URL = `${BASE_PATH}display-api/presence-count-one`;
const ROUTINE_URL = `${BASE_PATH}display-api/routine`;
const BEDTIME_URL = `${BASE_PATH}display-api/bedtime`;
const SUGGESTION_URL = `${BASE_PATH}display-api/suggestion`;
const POLL_MS = 2000;
const STREAM_CHECK_MS = 15000;
const SENSOR_STALE_AFTER_MS = 15 * 60 * 1000;
const COMPUTER_MEDIA_PAUSE_GRACE_MS = 8_000;

// Bolt optimization: Cache Intl instantiations to prevent O(N) object allocations during high-frequency render loops.
const timeFormat = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  hour: '2-digit',
  minute: '2-digit',
});

const dateFormat = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

const datePartsFormat = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const environmentNumberFormat = new Intl.NumberFormat('sv-SE', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const environmentNumberFormatWithFractions = new Intl.NumberFormat('sv-SE', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
});

const root = document.querySelector('#app-root');
const refs = {
  cameraMenu: document.querySelector('#camera-menu'),
  cameraChoices: document.querySelector('#camera-choices'),
  cameraPanel: document.querySelector('#camera-panel'),
  cameraName: document.querySelector('#camera-name'),
  cameraReason: document.querySelector('#camera-reason'),
  cameraClose: document.querySelector('#camera-close'),
  cameraCountdown: document.querySelector('#camera-countdown'),
  cameraImage: document.querySelector('#camera-image'),
  cameraPlaceholder: document.querySelector('#camera-placeholder'),
  cameraStatus: document.querySelector('#camera-status'),
  musicSection: document.querySelector('.music-section'),
  musicHeading: document.querySelector('#music-heading'),
  contextStrip: document.querySelector('#context-strip'),
  contextTitle: document.querySelector('#context-title'),
  contextDescription: document.querySelector('#context-description'),
  contextActions: document.querySelector('#context-actions'),
  contextDetailsButton: document.querySelector('#context-details-button'),
  contextPanel: document.querySelector('#context-panel'),
  contextList: document.querySelector('#context-list'),
  sceneOff: document.querySelector('#scene-off'),
  bedtimeDock: document.querySelector('#bedtime-dock'),
  bedtimeNight: document.querySelector('#bedtime-night'),
  bedtimeMorning: document.querySelector('#bedtime-morning'),
  bedtimePlan: document.querySelector('#bedtime-plan'),
  bedtimeEdit: document.querySelector('#bedtime-edit'),
  bedtimeClear: document.querySelector('#bedtime-clear'),
  bedtimeStatus: document.querySelector('#bedtime-status'),
  bedtimeDialog: document.querySelector('#bedtime-dialog'),
  bedtimeForm: document.querySelector('#bedtime-form'),
  bedtimeHeading: document.querySelector('#bedtime-heading'),
  bedtimeTime: document.querySelector('#bedtime-time'),
  bedtimeAuto: document.querySelector('#bedtime-mode-auto'),
  bedtimeButton: document.querySelector('#bedtime-mode-button'),
  bedtimeNone: document.querySelector('#bedtime-mode-none'),
  bedtimeMusic: document.querySelector('#bedtime-music'),
  bedtimeSummary: document.querySelector('#bedtime-summary'),
  bedtimeError: document.querySelector('#bedtime-error'),
  bedtimeConfirm: document.querySelector('#bedtime-confirm'),
  bedtimeCancel: document.querySelector('#bedtime-cancel'),
  bedtimeClose: document.querySelector('#bedtime-close'),
  scenePagination: document.querySelector('#scene-pagination'),
  scenePrevious: document.querySelector('#scene-previous'),
  sceneNext: document.querySelector('#scene-next'),
  scenePageLabel: document.querySelector('#scene-page-label'),
  musicArtwork: document.querySelector('#music-artwork'),
  musicArtworkImage: document.querySelector('#music-artwork-image'),
  musicArtist: document.querySelector('#music-artist'),
  clockTime: document.querySelector('#clock-time'),
  clockDate: document.querySelector('#clock-date'),
  roomPresence: document.querySelector('#room-presence'),
  presenceCountOne: document.querySelector('#presence-count-one'),
  presenceCountLabel: document.querySelector('#presence-count-label'),
  clockTop: document.querySelector('.clock-top'),
  connection: document.querySelector('#connection-notice'),
  connectionMessage: document.querySelector('#connection-message'),
  retry: document.querySelector('#retry-button'),
  sceneGrid: document.querySelector('#scene-grid'),
  sceneSection: document.querySelector('#scene-section'),
  musicDetails: document.querySelector('#music-details'),
  musicDetailsButton: document.querySelector('#music-details-button'),
  musicVolumeAuto: document.querySelector('#music-volume-auto'),
  musicVolumeManual: document.querySelector('#music-volume-manual'),
  musicAuthorityState: document.querySelector('#music-authority-state'),
  musicVolumeRequested: document.querySelector('#music-volume-requested'),
  musicVolumeAutomaticTarget: document.querySelector(
    '#music-volume-automatic-target',
  ),
  musicVolumeLastChange: document.querySelector('#music-volume-last-change'),
  musicVolumePolicyEnabled: document.querySelector(
    '#music-volume-policy-enabled',
  ),
  musicVolumePolicyActivity: document.querySelector(
    '#music-volume-policy-activity',
  ),
  musicPlaybackPolicy: document.querySelector('#music-playback-policy'),
  musicPlaybackEligibility: document.querySelector(
    '#music-playback-eligibility',
  ),
  musicPlaybackQuiet: document.querySelector('#music-playback-quiet'),
  musicPlaybackHold: document.querySelector('#music-playback-hold'),
  musicResumeWindow: document.querySelector('#music-resume-window'),
  musicCommandState: document.querySelector('#music-command-state'),
  musicAuthorityDetail: document.querySelector('#music-authority-detail'),
  musicCommandDetail: document.querySelector('#music-command-detail'),
  musicDecisionHistory: document.querySelector('#music-decision-history'),
  musicPlayerStatus: document.querySelector('#music-player-status'),
  musicTitle: document.querySelector('#music-title'),
  musicSource: document.querySelector('#music-source'),
  musicPresetDj: document.querySelector('#music-preset-dj'),
  musicPresets: document.querySelector('#music-presets'),
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

let cameraActive = null;
const cameraDismissedIds = new Set();
let cameraCloseHoldUntil = 0;
let cameraPendingShow = null;
let cameraChoicesOpen = false;
let cameraChoicesKey;
let cameraActionPending = false;
let cameraActionRequests = 0;
let cameraActionEpoch = 0;
let cameraMediaEpoch = 0;
let cameraMediaKey = null;
let cameraImageController;
let cameraImageTimer;
let cameraMediaTimeout;
let cameraObjectUrl;
let contextDetailsOpen = false;
let contextRenderKey;
let contextListKey;
let bedtimeDraft = null;
let bedtimeReturnFocus;
let artworkKey;
let latestPayload;
let payloadReceivedAt = 0;
let musicDetailsOpen = false;
let historyRenderKey;
let lastFreshAt = 0;
let sceneOrderKey = null;
let scenePage = 0;
let presetRoleKey = null;
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
let computerMediaDisplay = null;
let computerMediaPauseTimer;
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
  lastFreshAt = Date.now();
  setConnection('connected', 'Lugn ansluten');
  render(payload);
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
      const wasHealthy = streamHealthy;
      streamHealthy = true;
      reconnectDelay = 1000;
      window.clearTimeout(streamWatchdog);
      streamWatchdog = window.setTimeout(retryStream, STREAM_CHECK_MS);
      if (!wasHealthy) {
        window.clearTimeout(timer);
        timer = window.setTimeout(refresh, STREAM_CHECK_MS);
      }
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
  const resolved = roleName(role);
  root.dataset.role = resolved;
  if (refs.musicPresets && presetRoleKey !== resolved) {
    const presets =
      resolved === 'desk'
        ? [refs.musicPresetOptical, refs.musicPresetDj]
        : [refs.musicPresetDj, refs.musicPresetOptical];
    refs.musicPresets.replaceChildren(...presets, refs.musicDetailsButton);
    presetRoleKey = resolved;
  }
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
  renderContext(latestPayload);
  renderScenes(latestPayload);
  renderPresenceCorrection(latestPayload);
  renderRoomPresence(latestPayload?.state);
  renderMusic(latestPayload);
  renderCamera(latestPayload);
}

function setClock() {
  if (lastFreshAt && Date.now() - lastFreshAt > STREAM_CHECK_MS * 2)
    setConnection('offline', 'Inga färska uppdateringar från Lugn.');
  const now = new Date(latestPayload ? estimatedServerNow() : Date.now());
  const time = timeFormat.format(now);
  const date = dateFormat.format(now);
  setText(refs.clockTime, time);
  setText(refs.clockDate, date);
  const dateParts = datePartsFormat.formatToParts(now);
  const dateValue = Object.fromEntries(
    dateParts
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  refs.clockDate.dateTime = `${dateValue.year}-${dateValue.month}-${dateValue.day}`;
  if (latestPayload) {
    renderContext(latestPayload);
    renderScenes(latestPayload);
    renderMusicVolumePolicy(latestPayload, musicTarget);
    renderMusicExplanations(latestPayload, musicTarget);
    renderCamera(latestPayload);
  }
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
  const neutralOrder = [
    'scene.all_off',
    'scene.soft_light',
    'scene.everyday_light',
    'scene.movie_light',
    'scene.focus_light',
    'scene.party',
  ];
  const role = roleName(payload?.role);
  const sceneOrder =
    role === 'bed'
      ? ['scene.all_off', 'scene.soft_light', 'scene.sleep', ...neutralOrder]
      : role === 'desk'
        ? ['scene.focus_light', 'scene.everyday_light', ...neutralOrder]
        : neutralOrder;
  return [...unique.values()].sort((a, b) => {
    const rank = (id) => {
      const index = sceneOrder.indexOf(id);
      return index < 0 ? sceneOrder.length : index;
    };
    const difference = rank(a.id) - rank(b.id);
    return difference || a.name.localeCompare(b.name, 'sv');
  });
}

// Only these established scene IDs have an unambiguous visual meaning. User
// presets keep their names; user-controlled strings never enter SVG markup.
function sceneIconFor(sceneId) {
  const icons = {
    'scene.all_off': {
      name: 'power',
      paths: '<path d="M12 3v9"/><path d="M6.3 5.7a8 8 0 1 0 11.4 0"/>',
    },
    'scene.soft_light': {
      name: 'moon',
      paths:
        '<path d="M20.2 15.6A8.6 8.6 0 0 1 8.4 3.8 8.6 8.6 0 1 0 20.2 15.6Z"/>',
    },
    'scene.everyday_light': {
      name: 'sun',
      paths:
        '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    },
    'scene.focus_light': {
      name: 'desk-lamp',
      paths:
        '<path d="M7 21h11M12.5 21v-4L7 11l4-5"/><circle cx="7" cy="11" r="1.5"/><path d="m11 6 4-3 6 6-3 4Z"/><path d="m15 10 2 2"/>',
    },
    'scene.party': {
      name: 'disco-ball',
      paths:
        '<path d="M12 1.5V4"/><circle cx="12" cy="11" r="7"/><path d="M5.5 8.5h13m-13 5h13M12 4c-4 4-4 10 0 14m0-14c4 4 4 10 0 14M3 20l1-1m16 0 1 1m-9 0v2"/>',
    },
    'scene.movie_light': {
      name: 'film',
      paths:
        '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/><path d="m10 8 5 2.5-5 2.5Z"/>',
    },
  };
  return Object.prototype.hasOwnProperty.call(icons, sceneId)
    ? icons[sceneId]
    : null;
}

function sceneButtonFor(scene) {
  let button = sceneButtons.get(scene.id);
  if (button) return button;
  button =
    scene.id === 'scene.all_off'
      ? refs.sceneOff
      : document.createElement('button');
  if (scene.id === 'scene.all_off') button.replaceChildren();
  button.type = 'button';
  button.className =
    scene.id === 'scene.all_off' ? 'scene-button light-off' : 'scene-button';
  button.dataset.scene = scene.id;
  button.setAttribute('aria-pressed', 'false');
  const icon = sceneIconFor(scene.id);
  button.dataset.icon = String(!!icon);
  if (icon) {
    const symbol = document.createElement('span');
    symbol.className = 'scene-icon';
    symbol.dataset.symbol = icon.name;
    symbol.setAttribute('aria-hidden', 'true');
    symbol.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" focusable="false">${icon.paths}</svg>`;
    button.append(symbol);
  }
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
  const allScenes = getSceneList(payload);
  const presets = allScenes.filter((scene) => scene.id !== 'scene.all_off');
  const off = allScenes.find((scene) => scene.id === 'scene.all_off');
  refs.sceneOff.hidden = !off;
  refs.sceneOff.disabled =
    !off || isUnavailable() || pending.has('scene:scene.all_off');
  const pageSize = 6;
  const pages = Math.max(1, Math.ceil(presets.length / pageSize));
  scenePage = Math.min(scenePage, pages - 1);
  refs.scenePagination.hidden = pages <= 1 || contextDetailsOpen;
  refs.scenePrevious.disabled = scenePage === 0;
  refs.sceneNext.disabled = scenePage === pages - 1;
  setText(refs.scenePageLabel, `${scenePage + 1} / ${pages}`);
  const scenes = presets.slice(
    scenePage * pageSize,
    (scenePage + 1) * pageSize,
  );
  const current = payload?.state?.lighting?.currentScene;
  const ids = new Set(allScenes.map((scene) => scene.id));
  for (const [sceneId, button] of sceneButtons) {
    if (!ids.has(sceneId) && sceneId !== 'scene.all_off') {
      button.remove();
      sceneButtons.delete(sceneId);
    }
  }
  if (scenes.length === 0 && !off) {
    if (!refs.sceneGrid.querySelector('.section-empty')) {
      const empty = document.createElement('p');
      empty.className = 'section-empty';
      empty.textContent = 'Ljuslägen visas när Lugn är anslutet.';
      refs.sceneGrid.replaceChildren(empty);
    }
    return;
  }
  const ordered = [];
  for (const [index, scene] of [...(off ? [off] : []), ...scenes].entries()) {
    const button = sceneButtonFor(scene);
    button.querySelector('.scene-name').textContent =
      scene.id === 'scene.all_off' ? 'Släck' : scene.name;
    button.dataset.kind = scene.id === 'scene.all_off' ? 'off' : 'scene';
    button.dataset.featured = String(
      scenes.length % 2 === 1 && index === (off ? 1 : 0),
    );
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
      Object.values(payload?.state?.lighting?.devices ?? {}).some(
        (device) => Object.keys(device.effectiveDesired ?? {}).length > 0,
      ) &&
      Object.values(payload?.state?.lighting?.devices ?? {}).every((device) =>
        Object.entries(device.effectiveDesired ?? {}).every(
          ([property, value]) =>
            (device.effectiveDesired.power === false && property !== 'power') ||
            (device.availability === 'available' &&
              lightingFeedbackMatches(
                property,
                value,
                device.observed?.[property],
              )),
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
    const availability = isUnavailable()
      ? selected
        ? 'Frånkopplad. Senast valda ljusläge'
        : 'Frånkopplad'
      : status;
    button.setAttribute(
      'aria-label',
      `${scene.name}${availability ? `. ${availability}` : ''}`,
    );
    button.setAttribute(
      'title',
      `${scene.name}${availability ? ` · ${availability}` : ''}`,
    );
    button.dataset.state = isUnavailable()
      ? 'offline'
      : isPending
        ? 'pending'
        : !selected
          ? 'idle'
          : awaitingDevices
            ? 'awaiting'
            : confirmed
              ? 'confirmed'
              : 'selected';
    setText(button.querySelector('.scene-status'), status);
    button.querySelector('.scene-status').hidden = !status;
    if (button.getAttribute('aria-pressed') !== String(selected))
      button.setAttribute('aria-pressed', String(selected));
    if (scene.id !== 'scene.all_off') ordered.push(button);
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

function requestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  // The Hub can run on HTTP, where randomUUID is not available.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (letter) => {
    const value = Math.floor(Math.random() * 16);
    return (letter === 'x' ? value : (value & 3) | 8).toString(16);
  });
}

function bedtimeData(payload) {
  const value = payload?.routines?.bedtime;
  return roleName(payload?.role) === 'bed' && value && typeof value === 'object'
    ? value
    : null;
}

function bedtimeOwnedPlan(payload) {
  return payload?.routines?.definitions?.find(
    (definition) =>
      definition.id === payload?.routines?.bedtime?.morningRoutineId &&
      definition.bedtime?.owner === 'bedtime',
  )?.bedtime?.plan;
}

function bedtimeActionButton(label, action, available = true) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'context-action';
  button.dataset.bedtimeAction = action;
  button.dataset.available = String(available);
  button.textContent = label;
  button.addEventListener('click', () => {
    if (action === 'morning') void postBedtime('morning');
    else openBedtime(action, button);
  });
  return button;
}

function renderBedtime(payload) {
  const bedtime = bedtimeData(payload);
  const busy = pending.has('bedtime');
  const disabled =
    isUnavailable() ||
    busy ||
    !bedtime ||
    payload?.routines?.generation === undefined;
  const now = estimatedServerNow();
  const hour = Number(timeFormat.format(new Date(now)).split(':')[0]);
  const ownedPlan = bedtimeOwnedPlan(payload);
  const ready = bedtime?.ready;
  const scheduledWindow = Number.isFinite(ready?.until) && now < ready.until;
  const buttonPlan = ownedPlan ?? bedtime?.plan;
  const scheduledToday =
    buttonPlan?.mode === 'button' &&
    datePartsFormat.format(new Date(buttonPlan.at)) ===
      datePartsFormat.format(new Date(now));
  const plan = bedtime?.plan ?? (scheduledWindow ? ownedPlan : null);
  refs.bedtimeDock.hidden = !bedtime || contextDetailsOpen;
  refs.bedtimeNight.hidden = !(hour >= 18 || hour < 4);
  refs.bedtimeMorning.hidden = !(
    scheduledWindow ||
    (!scheduledToday && hour >= 6 && hour < 11)
  );
  refs.bedtimeNight.disabled = disabled || bedtime?.nightAvailable !== true;
  refs.bedtimeMorning.disabled = disabled || bedtime?.morningAvailable !== true;
  refs.bedtimePlan.hidden = !plan;
  setText(
    refs.bedtimeEdit,
    plan
      ? `${plan.time} · ${plan.mode === 'auto' ? 'Ljus' : 'Knapp'}${plan.music ? ' + musik' : ''}`
      : '',
  );
  refs.bedtimeEdit.setAttribute(
    'aria-label',
    `Ändra morgonplan ${plan?.time ?? ''}`,
  );
  refs.bedtimeEdit.disabled = disabled;
  refs.bedtimeClear.disabled = disabled;
  const running = (payload?.routines?.runs ?? []).some(
    (run) => run.status === 'running',
  );
  if (running) {
    refs.bedtimeNight.disabled = true;
    refs.bedtimeMorning.disabled = true;
  }
  const skipped = bedtime?.skippedTargets?.length ?? 0;
  setText(
    refs.bedtimeStatus,
    isUnavailable()
      ? 'Frånkopplad'
      : busy
        ? 'Skickar …'
        : skipped
          ? `${skipped} ${skipped === 1 ? 'lampa saknar' : 'lampor saknar'} status`
          : '',
  );
  refs.bedtimeStatus.hidden = !refs.bedtimeStatus.textContent;
  for (const button of [
    refs.bedtimeNight,
    refs.bedtimeMorning,
    refs.bedtimeClear,
  ])
    button.setAttribute('aria-busy', String(busy));
  syncBedtimeForm();
}

function openBedtime(action = 'start', trigger) {
  const bedtime = bedtimeData(latestPayload);
  if (!bedtime || isUnavailable() || pending.has('bedtime')) return;
  if (action === 'start' && !bedtime.nightAvailable) return;
  const plan =
    bedtime.plan ??
    (bedtime.ready?.until > estimatedServerNow()
      ? bedtimeOwnedPlan(latestPayload)
      : null);
  bedtimeReturnFocus = trigger ?? document.activeElement;
  bedtimeDraft = { action, generation: latestPayload.routines.generation };
  refs.bedtimeTime.value = plan?.time ?? '07:30';
  refs.bedtimeAuto.checked = !plan || plan.mode === 'auto';
  refs.bedtimeButton.checked = plan?.mode === 'button';
  refs.bedtimeNone.checked = false;
  refs.bedtimeMusic.checked = plan?.music === true;
  refs.bedtimeError.hidden = true;
  refs.bedtimeDialog.hidden = false;
  root.inert = true;
  setText(
    refs.bedtimeHeading,
    action === 'start' ? 'När vill du vakna?' : 'Planera nästa morgon',
  );
  syncBedtimeForm();
  refs.bedtimeClose.focus?.();
}

function closeBedtime(confirmed = false) {
  if (pending.has('bedtime') && !confirmed) return;
  refs.bedtimeDialog.hidden = true;
  root.inert = false;
  bedtimeDraft = null;
  bedtimeReturnFocus?.focus?.();
}

function bedtimeFormValue() {
  const mode = refs.bedtimeNone.checked
    ? 'none'
    : refs.bedtimeButton.checked
      ? 'button'
      : 'auto';
  return {
    wakeTime:
      mode === 'none' &&
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(refs.bedtimeTime.value)
        ? '07:30'
        : refs.bedtimeTime.value,
    mode,
    music:
      mode !== 'none' &&
      bedtimeData(latestPayload)?.musicAvailable === true &&
      refs.bedtimeMusic.checked,
  };
}

function syncBedtimeForm() {
  if (!bedtimeDraft) return;
  const bedtime = bedtimeData(latestPayload);
  const { wakeTime, mode, music } = bedtimeFormValue();
  const busy = pending.has('bedtime');
  const none = mode === 'none';
  const valid = none || /^([01]\d|2[0-3]):[0-5]\d$/.test(wakeTime);
  const unavailable = isUnavailable() || !bedtime;
  refs.bedtimeTime.disabled = busy || none;
  refs.bedtimeTime.required = !none;
  refs.bedtimeAuto.disabled = busy || bedtime?.morningAvailable !== true;
  refs.bedtimeButton.disabled = busy || bedtime?.morningAvailable !== true;
  refs.bedtimeNone.disabled = busy;
  const musicUnavailable =
    !none && refs.bedtimeMusic.checked && bedtime?.musicAvailable !== true;
  refs.bedtimeMusic.disabled =
    busy ||
    none ||
    (bedtime?.musicAvailable !== true && !refs.bedtimeMusic.checked);
  refs.bedtimeClose.disabled = busy;
  refs.bedtimeCancel.disabled = busy;
  for (const time of ['0700', '0730', '0800'])
    document.querySelector(`#bedtime-time-${time}`).disabled = busy || none;
  refs.bedtimeConfirm.disabled =
    busy ||
    unavailable ||
    musicUnavailable ||
    !valid ||
    bedtimeDraft.generation === undefined ||
    (!none && bedtime?.morningAvailable !== true) ||
    (bedtimeDraft.action === 'start' && bedtime?.nightAvailable !== true);
  refs.bedtimeConfirm.setAttribute('aria-busy', String(busy));
  setText(
    refs.bedtimeConfirm,
    busy
      ? 'Skickar …'
      : bedtimeDraft.action === 'plan'
        ? 'Spara morgonen'
        : none
          ? 'Godnatt utan väckning'
          : mode === 'auto'
            ? `Godnatt & väck ${wakeTime}`
            : `Godnatt · visa knapp ${wakeTime}`,
  );
  setText(
    refs.bedtimeSummary,
    unavailable
      ? 'Anslut till Lugn för att spara. Dina val finns kvar.'
      : musicUnavailable
        ? 'Musikspelaren saknar kontakt. Avmarkera musik eller vänta på anslutning.'
        : none
          ? bedtimeDraft.action === 'start'
            ? 'Bara kvällsrutinen. Ingen morgon planeras.'
            : 'Morgonplanen tas bort.'
          : !valid
            ? 'Välj en giltig väcktid.'
            : mode === 'auto'
              ? `Nästa morgon kl. ${wakeTime} börjar ljuset öka mjukt i 20 minuter.${music ? ' Musik från vald källa, med oförändrad volym.' : ' Ingen musik.'}`
              : `Nästa morgon kl. ${wakeTime} visas God morgon i en timme. Ljuset väntar på ditt tryck.${music ? ' Musik startas först när du trycker.' : ' Ingen musik.'}`,
  );
}

async function postBedtime(action) {
  const bedtime = bedtimeData(latestPayload);
  if (!bedtime || isUnavailable() || pending.has('bedtime')) return;
  const draft = bedtimeDraft;
  const formAction = action === 'start' || action === 'plan';
  if (formAction && (!draft || refs.bedtimeConfirm.disabled)) return;
  if (action === 'morning' && !bedtime.morningAvailable) return;
  const expectedGeneration = formAction
    ? draft.generation
    : latestPayload.routines.generation;
  if (expectedGeneration === undefined) return;
  const body = {
    action,
    ...(formAction
      ? bedtimeFormValue()
      : action === 'morning'
        ? {
            music:
              bedtime.ready?.until > estimatedServerNow() &&
              bedtime.ready.music === true,
          }
        : {}),
    expectedGeneration,
    requestId: requestId(),
  };
  pending.add('bedtime');
  refs.bedtimeError.hidden = true;
  renderContext(latestPayload);
  try {
    await postJson(BEDTIME_URL, body);
    if (formAction && bedtimeDraft === draft) closeBedtime(true);
    showToast(
      action === 'clear'
        ? 'Morgonplanen är borttagen.'
        : action === 'morning'
          ? 'God morgon är startad.'
          : action === 'start'
            ? 'Godnatt är startad. Morgonvalet är sparat.'
            : 'Morgonvalet är sparat.',
      'success',
    );
    await refresh(true);
  } catch (error) {
    const message =
      error?.status === 409
        ? 'Planen har ändrats. Stäng och öppna igen för att se den aktuella planen.'
        : error?.name === 'AbortError' ||
            error?.status === 502 ||
            error?.status === 504
          ? 'Kvittens saknas. Kontrollera status innan du försöker igen.'
          : error?.status === 400 || error?.status === 422
            ? 'Kontrollera väcktiden och dina val. Försök igen.'
            : 'Kunde inte spara. Dina val finns kvar. Försök igen.';
    if (error?.status === 401 || error?.status === 403)
      setConnection(
        'unauthorized',
        'Åtkomsten har gått ut. Öppna kontrollpanelen igen.',
        true,
      );
    if (formAction && bedtimeDraft === draft) {
      setText(refs.bedtimeError, message);
      refs.bedtimeError.hidden = false;
    } else showToast(message, 'error');
  } finally {
    pending.delete('bedtime');
    renderContext(latestPayload);
  }
}

// Optional Lugn 2 projections are independent of room state. Older servers may
// omit them, and an empty/disabled template never creates a control implicitly.
function contextData(payload) {
  const routines = payload?.routines;
  const definitions = Array.isArray(routines?.definitions)
    ? routines.definitions.filter(
        (item) =>
          item && typeof item.id === 'string' && typeof item.name === 'string',
      )
    : [];
  const runs = Array.isArray(routines?.runs) ? routines.runs : [];
  const now = estimatedServerNow();
  const next = (Array.isArray(routines?.next) ? routines.next : [])
    .filter(
      (item) =>
        Number.isFinite(item?.at) &&
        item.at > now &&
        definitions.some(
          (definition) =>
            definition.id === item.routineId &&
            definition.enabled === true &&
            definition.schedule,
        ),
    )
    .sort((a, b) => a.at - b.at);
  const scenes = getSceneList(payload);
  const suggestions = (
    Array.isArray(payload?.intelligence?.suggestions)
      ? payload.intelligence.suggestions
      : []
  ).filter(
    (item) =>
      item &&
      typeof item.id === 'string' &&
      typeof item.title === 'string' &&
      Number.isFinite(item.expiresAt) &&
      item.expiresAt > now &&
      (item.kind === 'scene'
        ? scenes.some((scene) => scene.id === item.sceneId)
        : item.kind === 'optical' &&
          !!payload?.state?.music?.devices?.[item.target]),
  );
  return { definitions, runs, next, suggestions };
}

function occurrenceLabel(at) {
  return `${dateFormat.format(new Date(at))} kl. ${timeFormat.format(new Date(at))}`;
}

function contextAction(kind, id, action, label, minutes) {
  // A server-observed run can be cancelled even if its Start response was lost.
  const pendingKey = `${kind}:${id}${kind === 'routine' && action === 'cancel' ? ':cancel' : ''}`;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'context-action';
  button.dataset.action = action;
  button.dataset.kind = kind;
  button.dataset.id = id;
  button.dataset.pendingKey = pendingKey;
  button.textContent = label;
  button.disabled = isUnavailable() || pending.has(pendingKey);
  button.setAttribute('aria-busy', String(pending.has(pendingKey)));
  button.addEventListener('click', () => {
    void runCommand(pendingKey, {
      id,
      action,
      ...(kind === 'routine' ? { requestId: requestId() } : {}),
      ...(minutes ? { minutes } : {}),
    });
  });
  return button;
}

function routineActions(definition, run, occurrence) {
  if (run?.status === 'running') {
    const actions = [
      contextAction('routine', definition.id, 'cancel', 'Avbryt'),
    ];
    if (definition.id === bedtimeData(latestPayload)?.morningRoutineId)
      actions.push(
        contextAction(
          'routine',
          definition.id,
          'snooze',
          'Skjut upp 10 min',
          10,
        ),
      );
    return actions;
  }
  const actions = [];
  if (definition.enabled === true)
    actions.push(contextAction('routine', definition.id, 'start', 'Starta'));
  if (occurrence)
    actions.push(
      contextAction('routine', definition.id, 'snooze', 'Skjut upp 10 min', 10),
      contextAction('routine', definition.id, 'skip', 'Hoppa över'),
    );
  return actions;
}

function setContextDetailsOpen(open) {
  contextDetailsOpen = open;
  refs.contextPanel.hidden = !open;
  refs.sceneGrid.hidden = open;
  refs.contextStrip.hidden = open || !refs.contextTitle.textContent;
  renderScenes(latestPayload);
  renderBedtime(latestPayload);
  refs.contextDetailsButton.setAttribute('aria-expanded', String(open));
  setText(refs.contextDetailsButton, open ? 'Tillbaka' : 'Rutiner & förslag');
  if (open) refs.contextPanel.focus?.();
}

function renderContext(payload) {
  const data = contextData(payload);
  const { definitions, runs, next, suggestions } = data;
  const bedtimeProjection = bedtimeData(payload);
  refs.contextDetailsButton.hidden =
    !bedtimeProjection && definitions.length === 0 && suggestions.length === 0;
  if (refs.contextDetailsButton.hidden && contextDetailsOpen)
    setContextDetailsOpen(false);
  const running = runs.find(
    (run) =>
      run?.status === 'running' &&
      (definitions.some((item) => item.id === run.routineId) ||
        [
          bedtimeProjection?.nightRoutineId,
          bedtimeProjection?.morningRoutineId,
        ].includes(run.routineId)),
  );
  const wake = next.find(
    (item) =>
      definitions.find((definition) => definition.id === item.routineId)
        ?.kind === 'good_morning',
  );
  const hour = Number(
    timeFormat.format(new Date(estimatedServerNow())).split(':')[0],
  );
  const bedtime =
    roleName(payload?.role) === 'bed' && (hour >= 18 || hour < 6)
      ? definitions.find(
          (item) => item.kind === 'good_night' && item.enabled === true,
        )
      : null;
  let title = '',
    description = '',
    actions = [];
  if (running) {
    const definition = definitions.find(
      (item) => item.id === running.routineId,
    ) ?? {
      id: running.routineId,
      name:
        running.routineId === bedtimeProjection?.nightRoutineId
          ? 'Godnatt'
          : 'God morgon',
    };
    title = definition.name;
    description = `Pågår · steg ${running.stepIndex + 1} av ${definition.steps?.length ?? '—'}`;
    actions = [['routine', definition.id, 'cancel', 'Avbryt']];
    if (
      bedtimeProjection &&
      running.routineId === bedtimeProjection.morningRoutineId
    )
      actions.push(['routine', definition.id, 'snooze', '10 min senare', 10]);
  } else if (bedtimeProjection) {
    // The compact dock owns evening/morning entry points on current servers.
  } else if (roleName(payload?.role) === 'bed' && bedtime) {
    title = bedtime.name;
    description = wake
      ? `Väckning ${occurrenceLabel(wake.at)}`
      : 'Din valda kvällsrutin';
    actions = [['routine', bedtime.id, 'start', 'Starta']];
  } else if (roleName(payload?.role) === 'bed' && wake) {
    title = definitions.find((item) => item.id === wake.routineId).name;
    description = `Planerad ${occurrenceLabel(wake.at)}`;
    actions = [
      ['routine', wake.routineId, 'snooze', '10 min senare', 10],
      ['routine', wake.routineId, 'skip', 'Hoppa över'],
    ];
  } else if (roleName(payload?.role) === 'desk' && suggestions.length) {
    const suggestion = suggestions[0];
    title = suggestion.title;
    description = suggestion.reason;
    actions = [
      ['suggestion', suggestion.id, 'accept', 'Välj'],
      ['suggestion', suggestion.id, 'dismiss', 'Inte nu'],
    ];
  }
  if (title && isUnavailable())
    description = `Senast rapporterat · ${description}`;
  setText(refs.contextTitle, title);
  setText(refs.contextDescription, description);
  const key = JSON.stringify(actions);
  if (key !== contextRenderKey) {
    refs.contextActions.replaceChildren(
      ...actions.map((args) => contextAction(...args)),
    );
    contextRenderKey = key;
  }
  refs.contextStrip.hidden = contextDetailsOpen || !title;
  syncContextButtons(refs.contextActions);
  renderBedtime(payload);
  const listKey = JSON.stringify([data, bedtimeProjection]);
  if (listKey === contextListKey) {
    syncContextButtons(refs.contextList);
    return;
  }
  contextListKey = listKey;
  const items = [];
  if (bedtimeProjection) {
    items.push(
      contextItem(
        'Kväll och morgon',
        'Starta när du vill eller ändra morgonplanen.',
        [
          bedtimeActionButton(
            'Godnatt',
            'start',
            bedtimeProjection.nightAvailable === true && !running,
          ),
          bedtimeActionButton(
            'God morgon',
            'morning',
            bedtimeProjection.morningAvailable === true && !running,
          ),
          bedtimeActionButton(
            'Planera morgonen',
            'plan',
            bedtimeProjection.morningAvailable === true,
          ),
        ],
      ),
    );
  }
  for (const definition of definitions) {
    const run = runs.find(
      (item) => item?.routineId === definition.id && item.status === 'running',
    );
    const last = runs
      .filter((item) => item?.routineId === definition.id)
      .at(-1);
    const occurrence = next.find((item) => item.routineId === definition.id);
    const status = run
      ? 'Pågår. Avbryt stoppar kommande steg.'
      : definition.enabled !== true
        ? 'Avstängd. Aktivera i webbpanelen.'
        : occurrence
          ? `Nästa: ${occurrenceLabel(occurrence.at)}`
          : 'Ingen kommande tid planerad. Starta när du vill.';
    const result =
      !run && last
        ? ({
            failed: 'Senaste körningen misslyckades.',
            cancelled: 'Senaste körningen avbröts.',
            completed: 'Senaste körningen avslutades.',
          }[last.status] ?? '')
        : '';
    if (
      bedtimeProjection &&
      !run &&
      [
        bedtimeProjection.nightRoutineId,
        bedtimeProjection.morningRoutineId,
      ].includes(definition.id)
    )
      continue;
    items.push(
      contextItem(
        definition.name,
        `${status} ${result} ${last?.reason ?? ''}`.trim(),
        routineActions(definition, run, occurrence),
      ),
    );
  }
  for (const suggestion of suggestions) {
    items.push(
      contextItem(suggestion.title, suggestion.reason, [
        contextAction('suggestion', suggestion.id, 'accept', 'Välj'),
        contextAction('suggestion', suggestion.id, 'reject', 'Avvisa'),
        contextAction('suggestion', suggestion.id, 'dismiss', 'Inte nu'),
      ]),
    );
  }
  if (!items.length)
    items.push(
      contextItem(
        'Inga rutiner eller förslag',
        'Konfigurera rutiner och förslag i webbpanelen.',
        [],
      ),
    );
  refs.contextList.replaceChildren(...items);
  syncContextButtons(refs.contextList);
}

function syncContextButtons(container) {
  for (const child of container.children) {
    if (child.className === 'context-action') {
      if (child.dataset.bedtimeAction) {
        const busy = pending.has('bedtime');
        child.disabled =
          isUnavailable() || busy || child.dataset.available !== 'true';
        child.setAttribute('aria-busy', String(busy));
        continue;
      }
      const busy = pending.has(child.dataset.pendingKey);
      child.disabled = isUnavailable() || busy;
      child.setAttribute('aria-busy', String(busy));
    } else syncContextButtons(child);
  }
}

function contextItem(title, description, actions) {
  const item = document.createElement('article');
  item.className = 'context-item';
  const heading = document.createElement('h3');
  heading.textContent = title;
  const copy = document.createElement('p');
  copy.textContent = description;
  const controls = document.createElement('div');
  controls.className = 'context-actions';
  controls.append(...actions);
  item.append(heading, copy, controls);
  return item;
}

function renderArtwork(payload, target) {
  const art = payload?.artwork?.[target];
  // Keep artwork local. Never load arbitrary external metadata URLs in a Hub.
  const safePath =
    typeof art?.url === 'string' &&
    /^\/(?!\/)/.test(art.url) &&
    !/[\\\x00-\x20]/.test(art.url);
  const url =
    target && art?.status === 'available' && safePath ? art.url : null;
  const key = JSON.stringify([target, url, art?.status]);
  if (key === artworkKey) return;
  artworkKey = key;
  refs.musicArtworkImage.hidden = true;
  refs.musicArtwork.dataset.state = url ? 'loading' : 'missing';
  if (url) refs.musicArtworkImage.setAttribute('src', url);
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
    const formatter =
      name === 'temperature' || name === 'pm25'
        ? environmentNumberFormatWithFractions
        : environmentNumberFormat;
    const formatted = formatter.format(value);
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
  const prefix = isUnavailable() ? 'Senast rapporterat: ' : '';
  if (presence?.state === 'confirmed_empty') {
    setText(refs.roomPresence, `${prefix}Rummet är tomt`);
    return;
  }
  if (presence?.state !== 'occupied') {
    setText(refs.roomPresence, `${prefix}Närvaro okänd`);
    return;
  }
  const count = presence.personCount;
  if (!Number.isInteger(count) || count < 1) {
    setText(refs.roomPresence, `${prefix}I rummet · antal okänt`);
    return;
  }
  setText(
    refs.roomPresence,
    `${prefix}I rummet · ${count} ${count === 1 ? 'person' : 'personer'}`,
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

function renderVolumeAuthority(payload, target) {
  const policy = payload?.musicVolumePolicies?.[target];
  const busy = pending.has(`volume-authority:${target}`);
  const blocked = policy?.authorityControlBlocked;
  const observationsUntrusted = !musicObservationTrusted(payload, target);
  const unavailable = isUnavailable() || observationsUntrusted;
  const disabled =
    unavailable ||
    !policy ||
    blocked !== null ||
    busy ||
    pending.has(`music:${target}`) ||
    pending.has(`music-preset:${target}`);
  for (const [button, selected] of [
    [
      refs.musicVolumeAuto,
      policy?.mode ? policy.mode === 'auto' : policy?.activeOwner === 'lugn',
    ],
    [
      refs.musicVolumeManual,
      policy?.mode
        ? policy.mode === 'manual'
        : policy?.activeOwner === 'manual',
    ],
  ]) {
    button.disabled = disabled;
    button.setAttribute('aria-pressed', String(!unavailable && selected));
    button.setAttribute('aria-busy', String(busy));
  }
  const reason = isUnavailable()
    ? 'Lugn svarar inte · försök när kontakten är tillbaka'
    : observationsUntrusted
      ? 'Spelarstatus saknar kontakt · vänta på tillförlitlig volym'
      : !policy
        ? 'Väntar på volymstatus'
        : busy
          ? 'Byter volymstyrning …'
          : blocked === 'volume_unavailable'
            ? 'Spelaren saknar tillförlitlig volym · vänta på status'
            : blocked === 'volume_pending'
              ? 'Väntar på volymkvittens · försök igen när spelaren svarat'
              : blocked === 'fade_active'
                ? 'Volymen tonas · vänta tills toningen är klar'
                : policy.mode === 'manual' || policy.selectorIntent
                  ? 'Manuellt läge · behålls tills du väljer Auto'
                  : '';
  setText(refs.musicAuthorityState, reason);
  refs.musicAuthorityState.hidden = !reason;
}

function musicObservationTrusted(payload, target) {
  return (
    payload?.musicObservationConnected !== false &&
    payload?.musicObservationTrust?.[target] !== false
  );
}

function clearComputerMediaDisplay() {
  computerMediaDisplay = null;
  window.clearTimeout(computerMediaPauseTimer);
  computerMediaPauseTimer = undefined;
}

function compactMediaText(value, limit) {
  const text =
    typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  const characters = Array.from(text);
  if (characters.length <= limit) return text;
  const prefix = characters.slice(0, limit - 1).join('');
  const space = prefix.lastIndexOf(' ');
  return `${(space >= limit * 0.6 ? prefix.slice(0, space) : prefix).trimEnd()}…`;
}

function renderComputerMediaTitle(media, status) {
  setText(refs.musicTitle, compactMediaText(media.title, 56));
  setText(refs.musicSource, 'Optical');
  setText(refs.musicArtist, compactMediaText(media.artist, 42));
  refs.musicArtist.hidden = !refs.musicArtist.textContent;
  setText(refs.musicPlayerStatus, status);
}

function renderComputerNowPlaying(
  payload,
  target,
  device,
  connected,
  reportedOnly,
  playbackLabel,
) {
  const projections = payload?.computerNowPlaying;
  const projection = projections?.[target];
  if (!projection || typeof projection !== 'object') {
    clearComputerMediaDisplay();
    return;
  }

  // The API only includes this projection when the configured Optical input is
  // actually observed. Keep that source visible even while the HA report is
  // stale, so the receiver's preset number never replaces the computer state.
  const observed = device.observed ?? {};
  const source =
    typeof observed.source === 'string' && observed.source.trim()
      ? observed.source.trim()
      : 'Optical';
  setText(refs.musicSource, 'Optical');
  const status = projection.status;
  const key = JSON.stringify([
    target,
    projection.deviceId,
    source,
    payload?.state?.computer?.devices?.[projection.deviceId]?.sessionId ?? null,
    payload?.instanceId ?? null,
  ]);
  if (computerMediaDisplay?.key !== key) clearComputerMediaDisplay();
  const freshPlaying =
    !reportedOnly &&
    connected &&
    device.availability === 'available' &&
    musicObservationTrusted(payload, target) &&
    observed.playback === 'playing';

  const computer = payload?.state?.computer?.devices?.[projection.deviceId];
  const refreshingMedia =
    status === 'unavailable' &&
    computer?.availability === 'online' &&
    computer?.freshness === 'fresh' &&
    computer?.observed?.media === null;
  const knownPause =
    !reportedOnly &&
    connected &&
    device.availability === 'available' &&
    musicObservationTrusted(payload, target) &&
    ['playing', 'paused', 'idle'].includes(observed.playback) &&
    (refreshingMedia ||
      (observed.playback === 'playing' && status === 'idle') ||
      (['paused', 'idle'].includes(observed.playback) &&
        ['playing', 'idle'].includes(status)));
  if (knownPause && computerMediaDisplay) {
    computerMediaDisplay.pausedAt ??= monotonicNow();
    const remaining =
      COMPUTER_MEDIA_PAUSE_GRACE_MS -
      (monotonicNow() - computerMediaDisplay.pausedAt);
    if (remaining > 0) {
      renderComputerMediaTitle(
        computerMediaDisplay,
        observed.playback === 'paused' ? 'Pausad' : 'Senast spelat',
      );
      // One deadline per pause: polling and heartbeats must not extend it.
      computerMediaPauseTimer ??= window.setTimeout(() => {
        computerMediaPauseTimer = undefined;
        if (!stopped && latestPayload) renderMusic(latestPayload);
      }, remaining);
      return;
    }
  }
  if (!freshPlaying || status !== 'playing') clearComputerMediaDisplay();

  if (!freshPlaying) {
    if (reportedOnly) {
      setText(refs.musicTitle, 'Datorns media är okänt');
      setText(refs.musicPlayerStatus, 'Senast rapporterat');
    } else if (
      device.availability !== 'available' ||
      status === 'unavailable' ||
      observed.playback === 'unknown'
    ) {
      setText(refs.musicTitle, 'Datorns media är okänt');
      setText(refs.musicPlayerStatus, 'Okänt');
    } else if (['paused', 'idle', 'off'].includes(observed.playback)) {
      setText(refs.musicTitle, 'Ingen musik spelar');
      setText(refs.musicPlayerStatus, playbackLabel);
    } else {
      setText(refs.musicTitle, 'Datorns media är okänt');
      setText(refs.musicPlayerStatus, 'Okänt');
    }
    return;
  }

  if (status === 'playing') {
    window.clearTimeout(computerMediaPauseTimer);
    computerMediaPauseTimer = undefined;
    computerMediaDisplay = {
      key,
      title:
        typeof projection.title === 'string' && projection.title.trim()
          ? projection.title.trim()
          : 'Media från datorn',
      artist: projection.artist,
      pausedAt: null,
    };
    renderComputerMediaTitle(computerMediaDisplay, 'Spelar');
  } else if (status === 'idle') {
    setText(refs.musicTitle, 'Inget media spelas på datorn');
    setText(refs.musicPlayerStatus, 'Inget media spelas');
  } else if (status === 'ambiguous') {
    setText(refs.musicTitle, 'Flera medier spelas på datorn');
    setText(refs.musicPlayerStatus, 'Flera medier spelas');
  } else {
    setText(refs.musicTitle, 'Datorns media är okänt');
    setText(refs.musicPlayerStatus, 'Okänt');
  }
}

function renderMusicVolumePolicy(payload, target) {
  renderVolumeAuthority(payload, target);
  const stale =
    isUnavailable() ||
    !musicObservationTrusted(payload, target) ||
    payload?.state?.music?.devices?.[target]?.availability !== 'available';

  const policy = target ? payload?.musicVolumePolicies?.[target] : null;
  const baseline = volumeFraction(
    policy?.configuredBaseline ?? policy?.baseline,
  );
  const requested = volumeFraction(
    payload?.state?.music?.devices?.[target]?.requested?.volume,
  );
  const owner = ['manual', 'lugn', 'none'].includes(policy?.activeOwner)
    ? policy.activeOwner
    : policy?.automatic === true
      ? 'lugn'
      : 'unknown';
  const activityKnown = typeof policy?.policyActive === 'boolean';
  const active = activityKnown
    ? policy.policyActive
    : policy?.automatic === true;
  const goal =
    policy?.activeOwner !== undefined
      ? volumeFraction(policy?.effectiveTarget)
      : (requested ?? volumeFraction(policy?.target));
  refs.musicVolumePolicy.dataset.controller = stale
    ? 'unknown'
    : owner === 'manual'
      ? 'you'
      : owner;
  setText(
    refs.musicVolumeController,
    stale
      ? 'Styrning okänd'
      : owner === 'manual'
        ? 'Manuell volym'
        : owner === 'lugn'
          ? active
            ? 'Lugn styr volymen'
            : 'Lugn tonar volymen'
          : owner === 'none'
            ? 'Ingen aktiv volymstyrning'
            : 'Volymstyrning okänd',
  );
  setText(
    refs.musicVolumeTargetLabel,
    stale
      ? 'Senaste mål'
      : owner === 'manual'
        ? 'Manuellt mål'
        : owner === 'lugn'
          ? active
            ? 'Automål'
            : 'Toningsmål'
          : requested !== null && !policy
            ? 'Begärt mål'
            : 'Aktivt mål',
  );
  setText(refs.musicVolumeTarget, formatVolume(goal));
  const hold = policy?.manualHold;
  const explanation = stale
    ? isUnavailable()
      ? 'Lugn svarar inte · visar senaste värden'
      : !musicObservationTrusted(payload, target)
        ? 'Home Assistant-återkoppling saknas · visar senaste värden'
        : 'Spelaren är frånkopplad · visar senaste värden'
    : policy?.mode === 'manual' && policy?.activityReason === 'manual_hold'
      ? policy.passiveReductionActive
        ? `Manuell referens ${formatVolume(volumeFraction(policy.manualReference))} · personsänkning aktiv`
        : 'Manuellt läge · behålls tills du väljer Auto'
      : hold && typeof hold.expiresAt === 'number'
        ? continuityText(hold.expiresAt, 'Manuellt val')
        : volumeReason(policy?.activityReason);
  setText(refs.musicVolumeTargetState, explanation);
  refs.musicVolumeTargetState.hidden = false;
  setText(refs.musicVolumeRequested, formatVolume(requested));
  setText(
    refs.musicVolumeAutomaticTarget,
    formatVolume(volumeFraction(policy?.target)),
  );
  setText(
    refs.musicVolumePolicyEnabled,
    stale
      ? 'Okänt'
      : typeof policy?.policyEnabled === 'boolean'
        ? policy.policyEnabled
          ? 'På'
          : 'Av'
        : 'Okänt',
  );
  setText(
    refs.musicVolumePolicyActivity,
    stale
      ? 'Okänt'
      : activityKnown
        ? active
          ? 'Aktiv'
          : volumeActivityLabel(policy?.activityReason)
        : 'Okänt',
  );
  const change = payload?.state?.music?.volumeChanges?.[target];
  setText(
    refs.musicVolumeLastChange,
    change
      ? `${volumeChanger(change)} · ${formatVolume(volumeFraction(change.volume))}`
      : 'Okänd',
  );
  setText(
    refs.musicVolumeBaselineLabel,
    policy?.configuredBaseline !== undefined
      ? 'Sparad Auto-bas'
      : policy?.baselineSource === 'user'
        ? 'Manuellt vald bas'
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
    `Auto: dygn ${formatVolumeOffset(policy?.dailyOffset)} · Personer (${personCountLabel}): ${formatVolumeOffset(policy?.personOffset)}${policy?.mode === 'manual' ? ` · Manuell referens ${formatVolume(volumeFraction(policy.manualReference))}` : ''}`,
  );
}

function monotonicNow() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function estimatedServerNow() {
  return typeof latestPayload?.generatedAt === 'number' &&
    Number.isFinite(latestPayload.generatedAt)
    ? latestPayload.generatedAt +
        Math.max(0, monotonicNow() - payloadReceivedAt)
    : Date.now();
}

function continuityText(expiresAt, prefix) {
  const remaining = expiresAt - estimatedServerNow();
  return remaining > 0
    ? `${prefix} · ${Math.ceil(remaining / 60000)} min kvar vid tomt rum`
    : 'Kontinuitetsgräns nådd · inväntar Lugn';
}

function volumeReason(reason) {
  return (
    {
      manual_hold: 'Manuellt val · automatiken väntar',
      automation_disabled: 'Volymautomatiken är av',
      presence_unknown: 'Automatiken väntar · närvaro okänd',
      person_count_unknown:
        'Manuellt läge · personsänkningen väntar på antal personer',
      confirmed_empty: 'Automatiken väntar · rummet tomt',
      home_away: 'Automatiken väntar · borta',
      fade_active: 'Volymtoning pågår · minutregeln väntar',
      volume_unavailable: 'Automatiken väntar · volymrapport saknas',
      active: 'Lugn anpassar efter dygn och antal personer',
    }[reason] ?? 'Orsak saknas'
  );
}

function volumeActivityLabel(reason) {
  return (
    {
      manual_hold: 'Manuell volym',
      automation_disabled: 'Automatik av',
      presence_unknown: 'Väntar på närvaro',
      person_count_unknown: 'Väntar på antal personer',
      confirmed_empty: 'Rummet tomt',
      home_away: 'Borta',
      fade_active: 'Toning pågår',
      volume_unavailable: 'Spelaren saknar volymrapport',
    }[reason] ?? 'Aktivitet okänd'
  );
}

function playbackReason(reason) {
  return (
    {
      manual_pause: 'Manuell paus spärrar autostart',
      home_away: 'Autostart spärrad · borta',
      quiet_hours: 'Ingen autostart 23–06',
      presence_unknown: 'Autostart väntar · närvaro okänd',
      confirmed_empty: 'Autostart väntar · rummet tomt',
      player_unavailable: 'Autostart väntar · spelaren frånkopplad',
      already_playing: 'Spelaren spelar · ingen ny autostart',
      computer_not_resumable: 'Ingen datorpaus att återuppta',
      awaiting_new_entry: 'Autostart först vid en ny entré',
    }[reason] ?? 'Autostartvillkor okända'
  );
}

function volumeChanger(change) {
  const human = ['user', 'physical_remote', 'home_assistant'].includes(
    change.provenance?.actor?.type,
  );
  if (change.attribution === 'matched')
    return human ? 'Matchar manuell begäran' : 'Matchar Lugn';
  if (change.attribution === 'correlated')
    return human ? 'Manuell återkoppling' : 'Lugn-återkoppling';
  return change.provenance?.actor?.type === 'physical_remote'
    ? 'Fysisk kontroll'
    : 'Extern / HA';
}

function renderMusicExplanations(payload, target) {
  const policy = payload?.musicPlaybackPolicies?.[target];
  const stale = isUnavailable();
  setText(
    refs.musicPlaybackPolicy,
    isUnavailable()
      ? 'Autostartvillkor okända · Lugn svarar inte'
      : playbackReason(policy?.activityReason),
  );
  setText(
    refs.musicPlaybackEligibility,
    stale
      ? 'Autostartvillkor okända · Lugn svarar inte.'
      : policy?.entryEligible === true
        ? 'Villkoren tillåter automatisk musik vid nästa bekräftade entré.'
        : playbackReason(policy?.activityReason),
  );
  setText(
    refs.musicPlaybackQuiet,
    !stale && typeof policy?.quietHours === 'boolean'
      ? policy.quietHours
        ? 'Natt: ingen autostart 23–06.'
        : 'Autostartfönster: 06–23, vid ny entré.'
      : 'Nattvillkor okända.',
  );
  setText(
    refs.musicPlaybackHold,
    stale
      ? 'Pausspärr okänd · Lugn svarar inte.'
      : policy?.manualPause
        ? policy.manualPause.resetPolicy === 'room_session_or_explicit_playback'
          ? 'Pausspärren släpps när rumsbesöket avslutas, eller med Spela/preset.'
          : 'Spela eller välj preset för att släppa pausspärren.'
        : policy
          ? 'Ingen manuell pausspärr.'
          : 'Pausspärr okänd.',
  );
  const resume = policy?.resumeExpiresAt;
  setText(
    refs.musicResumeWindow,
    stale
      ? 'Återgångsfönster okänt · Lugn svarar inte.'
      : typeof resume === 'number'
        ? resume > estimatedServerNow()
          ? `Återgångsfönster: ${Math.ceil((resume - estimatedServerNow()) / 60000)} min kvar.`
          : 'Återgångsfönstret har löpt ut.'
        : 'Ingen sparad återgång.',
  );
  const commands = (payload?.state?.music?.commands ?? []).filter(
    (item) => item.target === target,
  );
  const computerRoute = payload?.state?.music?.computerPlayback?.[target];
  const computerCommand =
    computerRoute?.active === true ? computerRoute.lastCommand : null;
  if (computerCommand?.target === target) {
    const existing = commands.findIndex(
      (command) => command.id === computerCommand.id,
    );
    if (existing === -1) commands.push(computerCommand);
    else commands[existing] = computerCommand;
  }
  commands.sort((left, right) => left.issuedAt - right.issuedAt);
  const outstanding = commands.filter((item) => item.status === 'pending');
  const command = outstanding.at(-1) ?? commands.at(-1);
  const pendingLabel =
    outstanding.length > 1
      ? `${outstanding.length} begäranden`
      : command?.requested?.property === 'volume'
        ? 'Volym begärd'
        : 'Musik begärd';
  const latest = commands.at(-1);
  const pendingResult =
    outstanding.length &&
    latest !== command &&
    ['failed', 'unconfirmed'].includes(latest?.status)
      ? `${outstanding.length > 1 ? `${outstanding.length} begäranden` : command.requested?.property === 'volume' ? 'Volym' : 'Musik'} inväntar · ${latest.requested?.property === 'volume' ? 'volym' : 'musik'} ${latest.status === 'failed' ? 'misslyckades' : 'saknar kvittens'}`
      : null;
  const commandText =
    pendingResult ??
    (stale && command?.recovery
      ? 'Återförsökens status okänd · Lugn svarar inte.'
      : musicRecoveryText(command)) ??
    (command
      ? ({
          pending:
            typeof command.acceptedAt === 'number'
              ? `${pendingLabel} · inväntar spelaren`
              : 'Skickar till spelaren …',
          failed: 'Senaste begäran misslyckades · försök igen',
          unconfirmed: 'Kvittens saknas · kontrollera rapporterat läge',
          superseded: 'Äldre begäran ersatt av nyare val',
          confirmed: 'Begäran rapporterad av spelaren',
        }[command.status] ?? 'Begärans status okänd')
      : '');
  setText(refs.musicCommandState, commandText);
  refs.musicCommandState.hidden = !commandText;
  setText(refs.musicAuthorityDetail, refs.musicAuthorityState.textContent);
  refs.musicAuthorityDetail.hidden = !refs.musicAuthorityState.textContent;
  setText(refs.musicCommandDetail, commandText);
  refs.musicCommandDetail.hidden = !commandText;
  const history = payload?.state?.music?.decisions;
  const decisions = Array.isArray(history)
    ? history
        .filter((item) => item.target === target)
        .slice(-8)
        .reverse()
    : [];
  const key = JSON.stringify([target, Array.isArray(history), decisions]);
  if (key === historyRenderKey) return;
  historyRenderKey = key;
  const rows = decisions.map((decision) => {
    const row = document.createElement('li');
    const time = document.createElement('time');
    time.textContent =
      typeof decision.at === 'number' && Number.isFinite(decision.at)
        ? timeFormat.format(new Date(decision.at))
        : '—';
    const copy = document.createElement('span');
    copy.textContent =
      decision.reason?.kind === 'volume'
        ? `Volym: ${volumeReason(decision.reason.value)}`
        : `Musik: ${playbackReason(decision.reason?.value)}`;
    row.append(time, copy);
    return row;
  });
  if (!rows.length) {
    const row = document.createElement('li');
    row.textContent = Array.isArray(history)
      ? 'Inga beslut i denna process ännu.'
      : 'Beslutshistorik saknas.';
    rows.push(row);
  }
  refs.musicDecisionHistory.replaceChildren(...rows);
}

function musicRecoveryText(command) {
  const recovery = command?.recovery;
  if (!recovery || ['confirmed', 'superseded'].includes(command.status))
    return null;
  const attempts = `${recovery.attemptCount}/3`;
  if (recovery.stage === 'verifying')
    return `Kvittens saknas · läser HA-status (försök ${attempts})`;
  if (recovery.stage === 'retrying')
    return `Återförsök ${attempts} · skickar till HA`;
  if (recovery.stage === 'awaiting_feedback')
    return recovery.attemptCount > 1
      ? `Försök ${attempts} · inväntar HA-rapport`
      : null;
  if (recovery.stage === 'waiting_retry') {
    const seconds = Math.max(
      0,
      Math.ceil((recovery.nextAttemptAt - estimatedServerNow()) / 1000),
    );
    return `HA saknar begärt läge · ny kontroll om ${seconds} s`;
  }
  if (recovery.stage === 'matched') {
    const request = command.requested;
    const report = recovery.reported;
    const value =
      request.property === 'volume'
        ? formatVolume(volumeFraction(report?.volume))
        : request.property === 'source'
          ? report?.source
          : { playing: 'spelar', paused: 'pausad' }[report?.playback];
    return `HA-kontroll: ${value ?? 'begärt läge'} · matchar begäran, orsak okänd`;
  }
  if (recovery.stage !== 'stopped') return null;
  return (
    {
      superseded: 'Återförsök stoppat · nyare val',
      policy_changed: 'Återförsök stoppat · ändrade villkor',
      read_unavailable: 'Kvittens saknas · statuskontroll stöds inte',
      read_failed: 'HA-status kunde inte läsas · inget återförsök',
      read_timeout: 'HA-status svarade inte i tid · inget återförsök',
      invalid_readback: 'HA-status är ogiltig eller äldre · inget återförsök',
      reported_unavailable:
        'HA rapporterar spelaren otillgänglig · inget återförsök',
      newer_report: 'Nyare HA-status · Lugn avstår återförsök',
      non_retryable:
        command.requested.property === 'preset'
          ? 'HA rapporterar spelstatus · vald preset kan inte verifieras'
          : 'HA rapporterar annan källa · inget återförsök',
      attempt_limit: 'Kvittens saknas efter 3 försök · kontrollera HA-status',
      dispatch_failed: 'Återförsöket misslyckades · kontrollera HA-status',
      acceptance_pending: 'Anropet kan ännu pågå · inget återförsök',
      deadline: 'Tidsgräns 60 s nådd · inga fler återförsök',
      disposed: 'Återförsöket avslutat',
    }[recovery.stopReason] ?? null
  );
}

function setMusicDetailsOpen(open) {
  musicDetailsOpen = open;
  refs.musicDetails.hidden = !open;
  refs.sceneSection.hidden = open;
  if (open) setContextDetailsOpen(false);
  root.dataset.musicDetails = String(open);
  refs.musicDetailsButton.setAttribute('aria-expanded', String(open));
  setText(refs.musicDetailsButton, open ? 'Tillbaka' : 'Detaljer');
}

function renderMusic(payload) {
  const entries = musicDevices(payload);
  if (entries.length === 0) {
    clearComputerMediaDisplay();
    musicTarget = '';
    renderArtwork(payload, null);
    setText(refs.musicArtist, '');
    refs.musicArtist.hidden = true;
    setMusicDetailsOpen(false);
    refs.musicDetailsButton.disabled = true;
    renderMusicVolumePolicy(payload, null);
    renderMusicExplanations(payload, null);
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
  refs.musicDetailsButton.disabled = false;
  const observed = device.observed ?? {};
  const availability = device.availability ?? 'unavailable';
  const desktop = payload?.state?.music?.computerPlayback?.[musicTarget];
  const desktopControl = desktop?.active === true;
  const isPlaying = desktopControl
    ? desktop.playback === 'playing'
    : observed.playback === 'playing';
  const playbackAction = musicPlaybackAction(payload, musicTarget);
  const isPending =
    pending.has(`music:${musicTarget}`) ||
    pending.has(`music-preset:${musicTarget}`);
  const authorityPending = pending.has(`volume-authority:${musicTarget}`);
  const connected = !isUnavailable();
  const canControl = availability === 'available' && connected && !isPending;
  const volumeAvailable =
    typeof observed.volume === 'number' && Number.isFinite(observed.volume);
  const volume = volumeAvailable
    ? Math.min(1, Math.max(0, observed.volume))
    : null;
  const controlVolume = musicVolumeForControl(device);
  renderMusicVolumePolicy(payload, musicTarget);
  renderMusicExplanations(payload, musicTarget);

  refs.musicPlayback.disabled =
    !canControl ||
    (desktopControl &&
      (desktop.playback === 'unknown' ||
        desktop.pending ||
        !(playbackAction === 'paused' ? desktop.canPause : desktop.canResume)));
  refs.musicPlayback.setAttribute(
    'aria-busy',
    String(desktopControl && desktop.pending),
  );
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
    playbackAction === 'paused'
      ? 'Pausa musik'
      : payload?.musicPlaybackPolicies?.[musicTarget]?.manualPause
        ? 'Spela och släpp manuell paus'
        : 'Starta musik',
  );
  refs.musicPlayback.setAttribute('aria-pressed', String(isPlaying));
  setText(refs.musicPlaybackIcon, playbackAction === 'paused' ? 'Ⅱ' : '▶');
  setText(
    refs.musicPlaybackLabel,
    playbackAction === 'paused' ? 'Pausa' : 'Spela',
  );
  refs.musicVolumeDown.disabled =
    !canControl ||
    authorityPending ||
    controlVolume === null ||
    controlVolume <= 0;
  refs.musicVolumeUp.disabled =
    !canControl ||
    authorityPending ||
    controlVolume === null ||
    controlVolume >= 1;
  const newerVerification = (payload?.state?.music?.commands ?? []).some(
    (command) =>
      command.target === musicTarget &&
      typeof command.recovery?.verifiedAt === 'number' &&
      command.recovery.verifiedAt > (device.observedAt ?? -1) &&
      typeof command.recovery.reported?.volume === 'number' &&
      command.recovery.reported.volume !== volume,
  );
  setText(
    refs.musicVolumeObservedLabel,
    availability === 'available' &&
      connected &&
      musicObservationTrusted(payload, musicTarget) &&
      !newerVerification
      ? 'Nu'
      : 'Senast',
  );
  refs.musicVolumeValue.setAttribute(
    'aria-label',
    availability === 'available' &&
      connected &&
      musicObservationTrusted(payload, musicTarget) &&
      !newerVerification
      ? 'Spelarens rapporterade volym'
      : 'Senast rapporterade spelarvolym',
  );
  const playbackLabels = {
    playing: 'Spelar',
    paused: 'Pausad',
    idle: 'Inaktiv',
    off: 'Av',
    unknown: 'Okänt',
  };
  const playbackLabel = playbackLabels[observed.playback] ?? 'Okänt';
  const newerPlaybackReport = (payload?.state?.music?.commands ?? []).some(
    (command) =>
      command.target === musicTarget &&
      command.recovery?.verifiedAt > (device.observedAt ?? -1) &&
      typeof command.recovery?.reported?.playback === 'string' &&
      command.recovery.reported.playback !== observed.playback,
  );
  const reportedOnly =
    !connected ||
    availability !== 'available' ||
    !musicObservationTrusted(payload, musicTarget) ||
    newerPlaybackReport;
  const title =
    typeof observed.title === 'string' && observed.title.trim()
      ? observed.title.trim()
      : reportedOnly
        ? 'Ingen titel rapporterad'
        : isPlaying
          ? 'Musik spelas'
          : ['paused', 'idle', 'off'].includes(observed.playback)
            ? 'Ingen musik spelar'
            : 'Uppspelning okänd';
  setText(
    refs.musicTitle,
    typeof observed.title === 'string' && observed.title.trim()
      ? reportedOnly
        ? `Senast rapporterat: ${title}`
        : !isPlaying
          ? `Senaste titel: ${title}`
          : title
      : title,
  );
  const source = typeof observed.source === 'string' ? observed.source : '';
  setText(
    refs.musicSource,
    source ||
      (reportedOnly
        ? 'Ingen källa rapporterad'
        : isPlaying
          ? 'Spelar musik'
          : 'Välj Spotify DJ eller Optical'),
  );
  setText(
    refs.musicPlayerStatus,
    reportedOnly ? `Senast rapporterat: ${playbackLabel}` : playbackLabel,
  );
  renderComputerNowPlaying(
    payload,
    musicTarget,
    device,
    connected,
    reportedOnly,
    playbackLabel,
  );
  const computer = payload?.computerNowPlaying?.[musicTarget];
  // Computer media and receiver metadata must never be presented as one album.
  const artist = computer ? computerMediaDisplay?.artist : observed.artist;
  setText(refs.musicArtist, typeof artist === 'string' ? artist.trim() : '');
  refs.musicArtist.hidden = !refs.musicArtist.textContent;
  renderArtwork(payload, musicTarget);
  refs.musicVolumeValue.value = formatVolume(volume);
  setText(refs.musicVolumeValue, refs.musicVolumeValue.value);
}

function render(payload) {
  latestPayload = payload;
  payloadReceivedAt = monotonicNow();
  setRole(payload?.role);
  renderContext(payload);
  renderScenes(payload);
  renderEnvironment(payload?.environment);
  renderRoomPresence(payload?.state);
  renderPresenceCorrection(payload);
  renderMusic(payload);
  renderCamera(payload);
  setClock();
}

function renderPresenceCorrection(payload) {
  const available = payload?.presenceCountCorrectionAvailable === true;
  const busy = pending.has('presence:one');
  refs.presenceCountOne.hidden = !available;
  refs.presenceCountOne.disabled = busy || isUnavailable();
  refs.presenceCountOne.setAttribute('aria-busy', String(busy));
  refs.clockTop.dataset.correction = String(available);
  setText(refs.presenceCountLabel, busy ? '…' : '1');
}

async function getState() {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(STATE_URL, {
      signal: controller.signal,
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
    return await response.json();
  } finally {
    window.clearTimeout(timeout);
  }
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
    renderContext(latestPayload);
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
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = new Error(`command_${response.status}`);
      error.status = response.status;
      if (url === VOLUME_AUTHORITY_URL)
        error.code = (await response.json().catch(() => ({}))).error;
      throw error;
    }
    return await response.json().catch(() => ({}));
  } finally {
    window.clearTimeout(timeout);
  }
}

async function runCommand(key, body) {
  if (pending.has(key) || isUnavailable()) return;
  window.clearTimeout(toastTimer);
  refs.toast.hidden = true;
  syncFeedback();
  pending.add(key);
  renderPresenceCorrection(latestPayload);
  renderContext(latestPayload);
  renderScenes(latestPayload);
  renderMusic(latestPayload);
  try {
    const url = key.startsWith('routine:')
      ? ROUTINE_URL
      : key.startsWith('suggestion:')
        ? SUGGESTION_URL
        : key === 'presence:one'
          ? PRESENCE_COUNT_URL
          : key.startsWith('scene:')
            ? SCENE_URL
            : key.startsWith('music-preset:')
              ? MUSIC_PRESET_URL
              : key.startsWith('volume-authority:')
                ? VOLUME_AUTHORITY_URL
                : MUSIC_URL;
    await postJson(url, body);
    if (key === 'presence:one')
      showToast(
        'Räknaren har bekräftat 1 person. Väntar på sensorstatus.',
        'success',
      );
    await refresh(true);
  } catch (error) {
    if (error?.status === 401 || error?.status === 403) {
      setConnection(
        'unauthorized',
        'Åtkomsten har gått ut. Öppna kontrollpanelen igen.',
        true,
      );
    } else if (
      error?.name === 'AbortError' ||
      error?.status === 502 ||
      error?.status === 504
    ) {
      showToast(
        key === 'presence:one'
          ? 'Räknaren kunde inte bekräfta ändringen. Kontrollera antalet och försök igen.'
          : 'Kvittens saknas. Kommandot kan ha nått enheten; status uppdateras när den svarar.',
        'pending',
      );
      await refresh(true);
    } else if (key.startsWith('volume-authority:')) {
      showToast(
        error.code === 'volume_pending' || error.code === 'fade_active'
          ? 'Volymen ändras redan. Vänta på kvittens och försök igen.'
          : error.code === 'volume_unavailable'
            ? 'Spelaren saknar tillförlitlig volym. Vänta på status och försök igen.'
            : 'Volymstyrningen kunde inte ändras. Kontrollera status och försök igen.',
        'error',
      );
      await refresh(true);
    } else {
      showToast('Kommandot nådde inte Lugn. Försök igen.', 'error');
    }
  } finally {
    pending.delete(key);
    renderPresenceCorrection(latestPayload);
    renderContext(latestPayload);
    renderScenes(latestPayload);
    renderMusic(latestPayload);
  }
}

refs.scenePrevious.addEventListener('click', () => {
  if (scenePage > 0) scenePage -= 1;
  renderScenes(latestPayload);
});
refs.sceneNext.addEventListener('click', () => {
  scenePage += 1;
  renderScenes(latestPayload);
});

// Camera media is scoped to one server-issued view. No HA credentials enter the browser.
function cameraMediaUrl(value) {
  if (typeof value !== 'string' || !/^(\/|\.\/)/.test(value)) return null;
  try {
    const url = new URL(value, location.href);
    return url.origin === location.origin && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function stopCameraMedia() {
  const hadMedia = cameraMediaKey || cameraImageController || cameraObjectUrl;
  cameraMediaEpoch += 1;
  window.clearTimeout(cameraImageTimer);
  window.clearTimeout(cameraMediaTimeout);
  cameraImageController?.abort();
  cameraImageController = null;
  if (!hadMedia) return;
  refs.cameraImage.onload = null;
  refs.cameraImage.onerror = null;
  refs.cameraImage.removeAttribute('src');
  refs.cameraImage.hidden = true;
  if (cameraObjectUrl) URL.revokeObjectURL(cameraObjectUrl);
  cameraObjectUrl = null;
  cameraMediaKey = null;
}

function cameraCanRun(epoch) {
  return (
    epoch === cameraMediaEpoch &&
    !stopped &&
    !isUnavailable() &&
    document.visibilityState !== 'hidden' &&
    !refs.cameraPanel.hidden &&
    cameraActive?.expiresAt > estimatedServerNow()
  );
}

function startCameraImages(active, epoch) {
  window.clearTimeout(cameraMediaTimeout);
  const imageUrl = cameraMediaUrl(active.imageUrl);
  if (!imageUrl) {
    refs.cameraPlaceholder.textContent = 'Kamerabilden är inte tillgänglig.';
    refs.cameraStatus.textContent =
      'Ingen bild kunde hämtas. Rumskontrollerna fungerar som vanligt.';
    return;
  }
  let failures = 0;
  const frame = async () => {
    if (!cameraCanRun(epoch)) return;
    const controller = new AbortController();
    cameraImageController = controller;
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    cameraMediaTimeout = timeout;
    try {
      const response = await fetch(imageUrl, {
        cache: 'no-store',
        credentials: 'same-origin',
        signal: controller.signal,
      });
      if (
        !response.ok ||
        !response.headers.get('content-type')?.startsWith('image/')
      )
        throw new Error('image_unavailable');
      const blob = await response.blob();
      if (!cameraCanRun(epoch)) return;
      if (blob.size > 8 * 1024 * 1024) throw new Error('image_too_large');
      const nextUrl = URL.createObjectURL(blob);
      if (cameraObjectUrl) URL.revokeObjectURL(cameraObjectUrl);
      cameraObjectUrl = nextUrl;
      refs.cameraImage.onload = () => {
        if (!cameraCanRun(epoch)) return;
        failures = 0;
        refs.cameraImage.hidden = false;
        refs.cameraPlaceholder.hidden = true;
        refs.cameraStatus.textContent = `Uppdaterad bild kl. ${new Date().toLocaleTimeString('sv-SE')}`;
        cameraImageTimer = window.setTimeout(frame, 1000);
      };
      refs.cameraImage.onerror = () => {
        if (!cameraCanRun(epoch)) return;
        refs.cameraStatus.textContent = 'Kamerabilden kunde inte visas.';
      };
      refs.cameraImage.src = nextUrl;
    } catch {
      if (!cameraCanRun(epoch)) return;
      failures += 1;
      refs.cameraStatus.textContent =
        failures < 3
          ? 'Ingen ny bild. Försöker igen …'
          : 'Kameran svarar inte. Stäng och öppna vyn för att försöka igen.';
      if (!refs.cameraImage.hidden)
        refs.cameraStatus.textContent += ' Bilden är inaktuell.';
      if (failures < 3) cameraImageTimer = window.setTimeout(frame, 2000);
    } finally {
      window.clearTimeout(timeout);
      if (cameraImageController === controller) cameraImageController = null;
    }
  };
  void frame();
}

function startCameraMedia(active) {
  stopCameraMedia();
  cameraMediaKey = `${active.id}|${active.imageUrl ?? ''}`;
  refs.cameraPlaceholder.hidden = false;
  refs.cameraPlaceholder.textContent = 'Hämtar kamerabild …';
  refs.cameraStatus.textContent = 'Tyst kameravy · uppdateras varje sekund';
  startCameraImages(active, cameraMediaEpoch);
}

function renderCamera(payload) {
  const camera = payload?.cameraDashboard;
  const allowed = camera?.settings?.enabled === true;
  const viewers = camera?.settings?.viewers;
  const viewerAllowed =
    !Array.isArray(viewers) || viewers.includes(roleName(payload?.role));
  const definitions = Array.isArray(camera?.definitions)
    ? camera.definitions.filter((item) => item.enabled && item.available)
    : [];
  refs.cameraMenu.hidden = !allowed || !viewerAllowed || !definitions.length;
  refs.cameraMenu.disabled = isUnavailable() || cameraActionRequests > 0;
  if (cameraChoicesKey !== JSON.stringify(definitions)) {
    cameraChoicesKey = JSON.stringify(definitions);
    refs.cameraChoices.replaceChildren(
      ...definitions.map((item) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = item.name;
        button.dataset.cameraId = item.id;
        button.addEventListener('click', () => {
          void cameraAction('show', item.id);
        });
        return button;
      }),
    );
  }
  for (const button of refs.cameraChoices.children)
    button.disabled =
      cameraActionPending || cameraActionRequests > 0 || isUnavailable();
  if (camera?.active?.id && cameraCloseHoldUntil > estimatedServerNow()) {
    cameraDismissedIds.add(camera.active.id);
    if (cameraDismissedIds.size > 32)
      cameraDismissedIds.delete(cameraDismissedIds.values().next().value);
  }
  const showingPending =
    cameraActionPending &&
    cameraPendingShow &&
    cameraCloseHoldUntil <= estimatedServerNow() &&
    allowed &&
    viewerAllowed;
  const active =
    allowed &&
    viewerAllowed &&
    cameraCloseHoldUntil <= estimatedServerNow() &&
    !cameraDismissedIds.has(camera?.active?.id) &&
    camera?.active?.expiresAt > estimatedServerNow()
      ? camera.active
      : null;
  cameraActive = active;
  refs.cameraPanel.hidden = !active && !showingPending;
  if (!allowed || !viewerAllowed) cameraChoicesOpen = false;
  refs.cameraChoices.hidden = !cameraChoicesOpen;
  refs.cameraMenu.setAttribute('aria-expanded', String(cameraChoicesOpen));
  refs.cameraMenu.textContent =
    cameraActionRequests > 0
      ? cameraCloseHoldUntil > estimatedServerNow()
        ? 'Stänger …'
        : 'Öppnar …'
      : active
        ? 'Byt kamera'
        : 'Kameror';
  refs.musicSection.dataset.camera = String(
    !!active || !!showingPending || cameraChoicesOpen,
  );
  setText(
    refs.musicHeading,
    active || showingPending ? 'Utanför rummet' : 'Musik',
  );
  if (!active || isUnavailable() || document.visibilityState === 'hidden') {
    if (cameraMediaKey) stopCameraMedia();
    if (showingPending && !active) {
      setText(
        refs.cameraName,
        definitions.find((item) => item.id === cameraPendingShow)?.name ||
          'Kamera',
      );
      setText(refs.cameraReason, 'Väntar på servern');
      setText(refs.cameraCountdown, '');
      refs.cameraPlaceholder.hidden = false;
      refs.cameraPlaceholder.textContent = 'Öppnar kameravyn …';
      refs.cameraStatus.textContent = 'Du kan stänga vyn medan den öppnas.';
    }
    if (active && isUnavailable())
      refs.cameraStatus.textContent =
        'Kontakten med Lugn bröts. Kameran har stoppats.';
    return;
  }
  setText(refs.cameraName, active.name);
  setText(refs.cameraReason, active.reason || 'Manuellt öppnad');
  setText(
    refs.cameraCountdown,
    `${Math.max(0, Math.ceil((active.expiresAt - estimatedServerNow()) / 1000))} s`,
  );
  refs.cameraImage.alt = `${active.name}, senast hämtade kamerabild`;
  const key = `${active.id}|${active.imageUrl ?? ''}`;
  if (cameraMediaKey !== key) void startCameraMedia(active);
}

async function cameraAction(action, cameraId) {
  if (
    action === 'show' &&
    (cameraActionPending || cameraActionRequests > 0 || isUnavailable())
  )
    return;
  cameraActionRequests += 1;
  const operation = ++cameraActionEpoch;
  if (action === 'hide') {
    cameraCloseHoldUntil = estimatedServerNow() + 60000;
    if (cameraActive?.id) cameraDismissedIds.add(cameraActive.id);
    cameraPendingShow = null;
    cameraChoicesOpen = false;
    stopCameraMedia();
    refs.cameraPanel.hidden = true;
    refs.musicSection.dataset.camera = 'false';
    refs.cameraMenu.focus?.();
  } else {
    cameraCloseHoldUntil = 0;
    cameraDismissedIds.clear();
    cameraPendingShow = cameraId;
    cameraChoicesOpen = false;
  }
  cameraActionPending = true;
  renderCamera(latestPayload);
  try {
    const result = await postJson(`${BASE_PATH}display-api/camera`, {
      action,
      ...(cameraId ? { cameraId } : {}),
    });
    if (operation !== cameraActionEpoch) {
      if (action === 'show' && cameraCloseHoldUntil > estimatedServerNow()) {
        await postJson(`${BASE_PATH}display-api/camera`, { action: 'hide' });
      }
      return;
    }
    if (result.cameraDashboard && latestPayload) {
      latestPayload.cameraDashboard = result.cameraDashboard;
    }
    renderCamera(latestPayload);
  } catch {
    if (operation === cameraActionEpoch)
      showToast(
        action === 'hide'
          ? 'Vyn är stängd här. Servern kunde inte bekräfta stängningen.'
          : 'Kameran kunde inte öppnas. Kontrollera anslutningen och kamerainställningarna.',
        'error',
      );
  } finally {
    cameraActionRequests -= 1;
    if (operation === cameraActionEpoch) {
      cameraActionPending = false;
      cameraPendingShow = null;
    }
    renderCamera(latestPayload);
  }
}

refs.cameraMenu.addEventListener('click', () => {
  cameraChoicesOpen = !cameraChoicesOpen;
  renderCamera(latestPayload);
});
refs.cameraClose.addEventListener('click', () => {
  void cameraAction('hide');
});

refs.contextDetailsButton.addEventListener('click', () => {
  setContextDetailsOpen(!contextDetailsOpen);
});
refs.sceneOff.addEventListener('click', () => {
  if (!refs.sceneOff.disabled)
    void runCommand('scene:scene.all_off', { sceneId: 'scene.all_off' });
});
refs.bedtimeNight.addEventListener('click', () =>
  openBedtime('start', refs.bedtimeNight),
);
refs.bedtimeMorning.addEventListener('click', () => {
  void postBedtime('morning');
});
refs.bedtimeEdit.addEventListener('click', () =>
  openBedtime('plan', refs.bedtimeEdit),
);
refs.bedtimeClear.addEventListener('click', () => {
  void postBedtime('clear');
});
refs.bedtimeCancel.addEventListener('click', () => closeBedtime());
refs.bedtimeClose.addEventListener('click', () => closeBedtime());
refs.bedtimeForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (bedtimeDraft) void postBedtime(bedtimeDraft.action);
});
refs.bedtimeTime.addEventListener('input', () => {
  syncBedtimeForm();
});
for (const input of [
  refs.bedtimeAuto,
  refs.bedtimeButton,
  refs.bedtimeNone,
  refs.bedtimeMusic,
])
  input.addEventListener('change', () => {
    syncBedtimeForm();
  });
for (const [id, time] of [
  ['0700', '07:00'],
  ['0730', '07:30'],
  ['0800', '08:00'],
])
  document
    .querySelector(`#bedtime-time-${id}`)
    .addEventListener('click', () => {
      refs.bedtimeTime.value = time;
      syncBedtimeForm();
    });
// Use a regular modal overlay for older Nest Hub Chrome versions without dialog.
function bedtimeKeydown(event) {
  if (!bedtimeDraft) return;
  if (event.key === 'Escape') {
    event.preventDefault?.();
    closeBedtime();
  } else if (event.key === 'Tab') {
    const controls = [
      refs.bedtimeClose,
      refs.bedtimeTime,
      ...['0700', '0730', '0800'].map((id) =>
        document.querySelector(`#bedtime-time-${id}`),
      ),
      refs.bedtimeAuto,
      refs.bedtimeButton,
      refs.bedtimeNone,
      refs.bedtimeMusic,
      refs.bedtimeCancel,
      refs.bedtimeConfirm,
    ].filter((control) => !control.disabled);
    const first = controls[0];
    const last = controls.at(-1);
    if (
      !controls.includes(document.activeElement) ||
      (event.shiftKey && document.activeElement === first) ||
      (!event.shiftKey && document.activeElement === last)
    ) {
      event.preventDefault?.();
      (event.shiftKey ? last : first)?.focus?.();
    }
  }
}
refs.musicArtworkImage.addEventListener('error', () => {
  refs.musicArtworkImage.hidden = true;
  refs.musicArtwork.dataset.state = 'unavailable';
});
refs.musicArtworkImage.addEventListener('load', () => {
  if (refs.musicArtwork.dataset.state !== 'loading') return;
  refs.musicArtworkImage.hidden = false;
  refs.musicArtwork.dataset.state = 'available';
});
document.addEventListener('keydown', (event) => {
  if (bedtimeDraft) {
    bedtimeKeydown(event);
    return;
  }
  if (event.key !== 'Escape') return;
  if (cameraActive || cameraChoicesOpen || cameraPendingShow) {
    void cameraAction('hide');
    refs.cameraMenu.focus?.();
  } else if (contextDetailsOpen) {
    setContextDetailsOpen(false);
    refs.contextDetailsButton.focus?.();
  } else if (musicDetailsOpen) {
    setMusicDetailsOpen(false);
    refs.musicDetailsButton.focus?.();
  }
});

refs.presenceCountOne.addEventListener('click', () => {
  void runCommand('presence:one', {});
});

refs.sceneGrid.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-scene]');
  if (!button || !refs.sceneGrid.contains(button)) return;
  const sceneId = button.dataset.scene;
  if (!sceneId) return;
  void runCommand(`scene:${sceneId}`, { sceneId });
});

for (const [button, mode] of [
  [refs.musicVolumeAuto, 'auto'],
  [refs.musicVolumeManual, 'manual'],
]) {
  button.addEventListener('click', () => {
    if (!musicTarget) return;
    void runCommand(`volume-authority:${musicTarget}`, {
      target: musicTarget,
      mode,
    });
  });
}

refs.musicPlayback.addEventListener('click', () => {
  const device = latestPayload?.state?.music?.devices?.[musicTarget];
  if (!device) return;
  const value = musicPlaybackAction(latestPayload, musicTarget);
  void runCommand(`music:${musicTarget}`, {
    target: musicTarget,
    request: { property: 'playback', value },
  });
});

function musicPlaybackAction(payload, target) {
  const desktop = payload?.state?.music?.computerPlayback?.[target];
  if (desktop?.active === true)
    return desktop.playback === 'playing' ? 'paused' : 'playing';
  return payload?.musicPlaybackPolicies?.[target]?.manualPause
    ? 'playing'
    : payload?.state?.music?.devices?.[target]?.observed?.playback === 'playing'
      ? 'paused'
      : 'playing';
}

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

refs.musicDetailsButton.addEventListener('click', () => {
  setMusicDetailsOpen(!musicDetailsOpen);
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
    stopCameraMedia();
    disconnectStream();
    window.clearTimeout(reconnectTimer);
  }
});

window.addEventListener('pagehide', () => {
  stopped = true;
  stopCameraMedia();
  clearComputerMediaDisplay();
  disconnectStream();
  window.clearTimeout(reconnectTimer);
  window.clearTimeout(timer);
  window.clearInterval(clockTimer);
  window.clearTimeout(toastTimer);
});

setMusicDetailsOpen(false);
setClock();
clockTimer = window.setInterval(setClock, 1000);
void refresh();
connectStream();
