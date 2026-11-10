// Närvaro: live radar, status and settings for the STL27L doorway sensor.
// app.js owns the session; this module only borrows its CSRF token through
// window.lugnPanel and talks to Lugn, never to the sensor directly.

const API_ROOT = '/ui/api';
const STREAM_URL = `${API_ROOT}/presence-sensor/stream`;
const RADAR_HALF_RANGE_M = 3.2;
const CONFIRM_TIMEOUT_MS = 6000;

const GROUPS = [
  {
    title: 'Dörr och korridor',
    help: 'Var dörren och korridoren ligger sedd från sensorn. Ändringar här gör att sensorn lär in bakgrunden på nytt.',
    keys: [
      'rotation_deg',
      'threshold_y',
      'threshold_margin',
      'corridor_x_min',
      'corridor_x_max',
      'inside_y_max',
      'outside_y_min',
      'invert_direction',
    ],
  },
  {
    title: 'Kartongfilter',
    help: 'Utesluter ett område där en kartong eller ett föremål annars räknas som person.',
    keys: [
      'box_filter_enabled',
      'box_filter_x_min',
      'box_filter_x_max',
      'box_filter_y_min',
      'box_filter_y_max',
    ],
  },
  {
    title: 'Rörelse',
    help: 'Hur mycket något måste röra sig för att räknas som en person.',
    keys: [
      'min_motion_speed_mps',
      'min_motion_dist_m',
      'static_timeout_seconds',
    ],
  },
  {
    title: 'Räkning och förtändning',
    help: '',
    keys: ['passage_deadtime_ms', 'prelight_mode', 'early_trigger_y'],
  },
];

const LABELS = {
  rotation_deg: 'Sensorns vinkel',
  threshold_y: 'Dörrlinjens läge',
  threshold_margin: 'Dörrzonens bredd (±)',
  corridor_x_min: 'Korridor, vänster kant',
  corridor_x_max: 'Korridor, höger kant',
  inside_y_max: 'Räckvidd inåt rummet',
  outside_y_min: 'Räckvidd utåt (negativt)',
  invert_direction: 'Vänd in och ut',
  box_filter_enabled: 'Använd kartongfilter',
  box_filter_x_min: 'Filter, vänster kant',
  box_filter_x_max: 'Filter, höger kant',
  box_filter_y_min: 'Filter, nedre kant',
  box_filter_y_max: 'Filter, övre kant',
  min_motion_speed_mps: 'Lägsta rörelsehastighet',
  min_motion_dist_m: 'Lägsta förflyttning',
  static_timeout_seconds: 'Tid tills stillastående ignoreras',
  passage_deadtime_ms: 'Minsta tid mellan passager',
  prelight_mode: 'Förtändningsläge',
  early_trigger_y: 'Förtändning utanför dörren',
};
const ENUM_LABELS = {
  prelight_mode: { legacy: 'Enkel', smart: 'Smart (bana)' },
};

const panel = window.lugnPanel;
const el = (id) => document.getElementById(id);
const section = el('presence-section');

let source = null;
let reconnectTimer = null;
let latestFrame = null;
let linkConnected = false;
let fields = [];
let saved = {};
let draft = {};
let configLoaded = false;
let configLoading = false;
let busy = false;
let confirming = null;
let confirmTimer = null;

class PresenceError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

async function capability(name, input = {}) {
  const csrf = panel.csrfToken();
  if (!csrf) throw new PresenceError('session', 401);
  const response = await fetch(`${API_ROOT}/capabilities/${name}`, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json', 'X-Lugn-CSRF': csrf },
    body: JSON.stringify({ input }),
  });
  if (response.status === 401 || response.status === 403) {
    void panel.refresh();
    throw new PresenceError('session', response.status);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new PresenceError(body.error ?? 'failed', response.status);
  }
  return response.json();
}

function failureText(error, fallback) {
  if (error instanceof PresenceError) {
    if (error.code === 'session')
      return 'Sessionen har gått ut. Logga in igen.';
    if (error.code === 'sensor_rejected_change')
      return 'Sensorn avvisade ändringen. Kontrollera värdena.';
    if (error.code === 'target_not_configured')
      return 'Sensorn är inte konfigurerad i Lugn.';
  }
  return fallback;
}

function isActive() {
  return (
    panel.overview()?.presenceSensorEnabled === true &&
    location.hash === '#narvaro' &&
    !section.hidden &&
    document.visibilityState === 'visible'
  );
}

// ---------- Live stream ----------

function openStream() {
  if (source) return;
  setLink('Ansluter …', 'warn');
  source = new EventSource(STREAM_URL, { withCredentials: true });
  source.addEventListener('frame', (event) => {
    try {
      latestFrame = JSON.parse(event.data);
    } catch {
      return;
    }
    linkConnected = true;
    renderFrame(latestFrame);
  });
  source.addEventListener('status', (event) => {
    try {
      linkConnected = JSON.parse(event.data).connected === true;
    } catch {
      return;
    }
    if (!linkConnected) {
      latestFrame = null;
      setLink('Ingen kontakt med sensorn', 'bad');
      renderIdle();
    } else setLink('Live', 'good');
  });
  source.onerror = () => {
    // The browser retries by itself unless the server refused the stream.
    if (source?.readyState === EventSource.CLOSED) {
      closeStream();
      setLink('Strömmen avbröts', 'bad');
      if (isActive()) reconnectTimer = setTimeout(sync, 5000);
    } else setLink('Ansluter …', 'warn');
  };
}

function closeStream() {
  source?.close();
  source = null;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  linkConnected = false;
  latestFrame = null;
}

function setLink(text, tone) {
  el('presence-link').textContent = text;
  el('presence-link').dataset.tone = tone;
}

// ---------- Status ----------

const QUALITY = {
  CERTAIN: ['Säker', 'good'],
  DEGRADED: ['Försämrad', 'warn'],
  UNCERTAIN: ['Osäker', 'bad'],
};
const DIRECTION = { enter: 'In', exit: 'Ut', none: 'Ingen' };

function renderIdle() {
  for (const id of [
    'count',
    'quality',
    'confidence',
    'direction',
    'preview',
    'door',
    'lidar',
  ])
    el(`presence-${id}`).textContent = '–';
  el('presence-quality').removeAttribute('data-tone');
  for (const id of ['minus', 'plus', 'zero', 'recalibrate'])
    el(`presence-${id}`).disabled = true;
  drawRadar(null);
}

function renderFrame(frame) {
  const { state, metrics } = frame;
  el('presence-count').textContent = String(state.count);
  const [quality, tone] = QUALITY[state.quality] ?? [state.quality, 'warn'];
  el('presence-quality').textContent = quality;
  el('presence-quality').dataset.tone = tone;
  el('presence-confidence').textContent =
    `${Math.round(state.confidence * 100)} %`;
  el('presence-direction').textContent =
    DIRECTION[state.last_direction ?? 'none'] ?? 'Ingen';
  const approaching = frame.preview_info?.approaching_tracks?.[0];
  el('presence-preview').textContent = frame.preview_active
    ? approaching?.distance_m !== undefined
      ? `Aktiv · ${approaching.distance_m} m från dörren`
      : 'Aktiv'
    : 'Redo';
  const door = frame.door;
  el('presence-door').textContent = !door?.enabled
    ? 'Ingen dörrsensor'
    : door.blocking
      ? 'Stängd · passager spärrade'
      : door.connected && door.state === 'open'
        ? 'Öppen · räknar'
        : 'Okänd · använder lidar';
  el('presence-lidar').textContent =
    `${metrics.lidar_hz.toFixed(1)} Hz · ${Math.round(metrics.points_per_second)} punkter/s`;
  for (const id of ['minus', 'plus', 'zero', 'recalibrate'])
    el(`presence-${id}`).disabled = busy;
  el('presence-minus').disabled = busy || state.count <= 0;
  el('presence-plus').disabled = busy || state.count >= 10;
  drawRadar(frame);
}

// ---------- Radar ----------

const canvas = el('presence-radar');
const ctx = canvas.getContext('2d');

// The backing store follows the size the canvas is shown at, so text stays
// readable; drawing then happens in CSS pixels.
function fitCanvas() {
  const size = Math.max(240, Math.round(canvas.clientWidth || 640));
  const ratio = window.devicePixelRatio || 1;
  const pixels = Math.round(size * ratio);
  if (canvas.width !== pixels) {
    canvas.width = pixels;
    canvas.height = pixels;
  }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return size;
}

function drawRadar(frame) {
  const w = fitCanvas();
  const h = w;
  const cx = w / 2;
  const cy = h / 2;
  const scale = w / (2 * RADAR_HALF_RANGE_M);
  ctx.fillStyle = '#070b10';
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = '#1b222d';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#5b6672';
  ctx.font = '11px sans-serif';
  for (const r of [1, 2, 3]) {
    ctx.beginPath();
    ctx.arc(cx, cy, r * scale, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillText(`${r} m`, cx + r * scale - 28, cy - 5);
  }
  ctx.beginPath();
  ctx.moveTo(cx, 0);
  ctx.lineTo(cx, h);
  ctx.moveTo(0, cy);
  ctx.lineTo(w, cy);
  ctx.stroke();

  if (!frame) {
    ctx.fillStyle = '#8b949e';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(
      linkConnected ? 'Väntar på första bilden …' : 'Ingen kontakt med sensorn',
      cx,
      cy - 24,
    );
    ctx.textAlign = 'start';
    drawSensor(cx, cy, 0);
    return;
  }

  const cfg = frame.config ?? {};
  const xMin = cfg.corridor_x_min ?? -0.8;
  const xMax = cfg.corridor_x_max ?? 0.8;
  const threshold = cfg.threshold_y ?? 0;
  const margin = cfg.threshold_margin ?? 0.15;
  const inverted = cfg.invert_direction === true;
  const left = cx + xMin * scale;
  const right = cx + xMax * scale;
  const top = cy - (cfg.inside_y_max ?? 1.8) * scale;
  const bottom = cy - (cfg.outside_y_min ?? -1.8) * scale;

  ctx.strokeStyle = '#30363d';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.strokeRect(left, top, right - left, bottom - top);
  ctx.setLineDash([]);

  // Zone the preview trigger watches: the outside of the door.
  const outsideDepth = 2;
  const approachA = inverted
    ? cy - (threshold + margin + outsideDepth) * scale
    : cy - (threshold - margin) * scale;
  const approachB = inverted
    ? cy - (threshold + margin) * scale
    : cy - (threshold - margin - outsideDepth) * scale;
  ctx.fillStyle = frame.preview_active
    ? 'rgba(56, 189, 248, 0.18)'
    : 'rgba(56, 189, 248, 0.05)';
  ctx.fillRect(
    left,
    Math.min(approachA, approachB),
    right - left,
    Math.abs(approachB - approachA),
  );
  ctx.fillStyle = frame.preview_active ? '#38bdf8' : 'rgba(56, 189, 248, 0.75)';
  ctx.font = 'bold 10px sans-serif';
  ctx.fillText(
    frame.preview_active ? 'FÖRTÄNDNING AKTIV' : 'FÖRTÄNDNINGSZON',
    left + 8,
    (approachA + approachB) / 2 + 3,
  );

  ctx.fillStyle = 'rgba(210, 153, 34, 0.14)';
  ctx.fillRect(
    left,
    cy - (threshold + margin) * scale,
    right - left,
    2 * margin * scale,
  );

  if (cfg.box_filter_enabled) {
    const bx = cx + (cfg.box_filter_x_min ?? 0.2) * scale;
    const bw = (cfg.box_filter_x_max ?? 0.7) * scale + cx - bx;
    const by = cy - (cfg.box_filter_y_max ?? 1.15) * scale;
    const bh = cy - (cfg.box_filter_y_min ?? 0.55) * scale - by;
    ctx.fillStyle = 'rgba(240, 136, 62, 0.16)';
    ctx.strokeStyle = 'rgba(240, 136, 62, 0.7)';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([3, 3]);
    ctx.fillRect(bx, by, bw, bh);
    ctx.strokeRect(bx, by, bw, bh);
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(240, 136, 62, 0.95)';
    ctx.font = 'bold 10px sans-serif';
    ctx.fillText('Kartongfilter', bx + 5, by + 13);
  }

  const doorY = cy - threshold * scale;
  ctx.strokeStyle = '#d29922';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(left, doorY);
  ctx.lineTo(right, doorY);
  ctx.stroke();
  ctx.fillStyle = inverted ? '#58a6ff' : '#3fb950';
  ctx.font = 'bold 11px sans-serif';
  ctx.fillText(
    `${inverted ? 'UTOMHUS' : 'RUM'} ↑`,
    cx - 40,
    cy - (threshold + margin) * scale - 10,
  );
  ctx.fillStyle = inverted ? '#3fb950' : '#58a6ff';
  ctx.fillText(
    `${inverted ? 'RUM' : 'UTOMHUS'} ↓`,
    cx - 40,
    cy - (threshold - margin) * scale + 20,
  );

  for (const [x, y, foreground] of frame.points) {
    ctx.fillStyle = foreground ? '#58a6ff' : '#262c36';
    ctx.beginPath();
    ctx.arc(cx + x * scale, cy - y * scale, foreground ? 2.5 : 1.2, 0, 6.2832);
    ctx.fill();
  }

  ctx.strokeStyle = 'rgba(88, 166, 255, 0.5)';
  ctx.lineWidth = 1.5;
  for (const cluster of frame.clusters) {
    ctx.beginPath();
    ctx.arc(
      cx + cluster.x * scale,
      cy - cluster.y * scale,
      Math.max(8, (cluster.diameter / 2) * scale),
      0,
      6.2832,
    );
    ctx.stroke();
  }

  for (const track of frame.tracks) drawTrack(track, cx, cy, scale);
  drawSensor(cx, cy, cfg.rotation_deg ?? 0);
}

function drawTrack(track, cx, cy, scale) {
  const x = cx + track.x * scale;
  const y = cy - track.y * scale;
  if (track.trajectory.length > 1) {
    ctx.strokeStyle = track.is_static
      ? 'rgba(210, 153, 34, 0.3)'
      : 'rgba(63, 185, 80, 0.4)';
    ctx.lineWidth = track.is_static ? 1.5 : 2.5;
    ctx.beginPath();
    track.trajectory.forEach(([tx, ty], index) => {
      if (index === 0) ctx.moveTo(cx + tx * scale, cy - ty * scale);
      else ctx.lineTo(cx + tx * scale, cy - ty * scale);
    });
    ctx.stroke();
  }
  ctx.fillStyle = track.is_static
    ? '#d29922'
    : track.is_moving
      ? '#3fb950'
      : '#8b949e';
  ctx.beginPath();
  ctx.arc(x, y, track.is_static ? 6 : 8, 0, 6.2832);
  ctx.fill();
  const speed = Math.hypot(track.vx, track.vy);
  if (speed > 0.05 && !track.is_static) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + track.vx * 0.35 * scale, y - track.vy * 0.35 * scale);
    ctx.stroke();
  }
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 10px sans-serif';
  const label = track.is_static
    ? 'STILLA'
    : track.is_moving
      ? `${speed.toFixed(2)} m/s`
      : 'VÄNTAR';
  ctx.fillText(`T${track.id} · ${label}`, x + 11, y - 5);
}

function drawSensor(cx, cy, rotation) {
  ctx.fillStyle = '#f85149';
  ctx.beginPath();
  ctx.arc(cx, cy, 6, 0, 6.2832);
  ctx.fill();
  ctx.strokeStyle = '#f85149';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx, cy - 14);
  ctx.stroke();
  ctx.fillStyle = '#8b949e';
  ctx.font = '10px sans-serif';
  ctx.fillText(`LiDAR · ${Math.round(rotation)}°`, cx - 34, cy + 18);
}

// ---------- Actions ----------

function actionStatus(text, tone = 'neutral') {
  el('presence-action-status').textContent = text;
  el('presence-action-status').dataset.tone = tone;
}

async function runAction(name, input, doneText) {
  if (busy) return;
  busy = true;
  for (const id of ['minus', 'plus', 'zero', 'recalibrate'])
    el(`presence-${id}`).disabled = true;
  actionStatus('Skickar till sensorn …');
  try {
    await capability(name, input);
    actionStatus(doneText, 'good');
  } catch (error) {
    actionStatus(
      failureText(error, 'Sensorn svarade inte. Försök igen.'),
      'bad',
    );
  } finally {
    busy = false;
    if (latestFrame) renderFrame(latestFrame);
  }
}

function setCount(count) {
  void runAction(
    'presence.setCount',
    { count },
    `Sensorns räknare är satt till ${count}. Rummets status följer sensorns nästa rapport.`,
  );
}

function askToConfirm(key, button, label, confirmLabel, run) {
  if (confirming === key) {
    clearTimeout(confirmTimer);
    confirming = null;
    button.textContent = label;
    run();
    return;
  }
  clearTimeout(confirmTimer);
  confirming = key;
  button.textContent = confirmLabel;
  confirmTimer = setTimeout(() => {
    confirming = null;
    button.textContent = label;
  }, CONFIRM_TIMEOUT_MS);
}

// ---------- Settings form ----------

function fieldLabel(field) {
  return LABELS[field.key] ?? field.key;
}

function buildForm() {
  const groups = el('presence-groups');
  groups.replaceChildren();
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const listed = new Set(GROUPS.flatMap((group) => group.keys));
  const extra = fields.filter((field) => !listed.has(field.key));
  const plan = GROUPS.map((group) => ({
    ...group,
    fields: group.keys.map((key) => byKey.get(key)).filter(Boolean),
  }));
  if (extra.length)
    plan.push({ title: 'Övrigt', help: '', fields: extra, keys: [] });
  for (const group of plan) {
    if (!group.fields.length) continue;
    const wrapper = document.createElement('div');
    wrapper.className = 'presence-group';
    const heading = document.createElement('h3');
    heading.textContent = group.title;
    wrapper.append(heading);
    if (group.help) {
      const help = document.createElement('p');
      help.className = 'field-help';
      help.textContent = group.help;
      wrapper.append(help);
    }
    const grid = document.createElement('div');
    grid.className = 'presence-grid';
    for (const field of group.fields) grid.append(fieldControl(field));
    wrapper.append(grid);
    groups.append(wrapper);
  }
}

function fieldControl(field) {
  const label = document.createElement('label');
  label.className =
    field.type === 'boolean' ? 'settings-toggle' : 'presence-field';
  const text = document.createElement('span');
  text.textContent = field.unit
    ? `${fieldLabel(field)} (${field.unit === 'deg' ? '°' : field.unit})`
    : fieldLabel(field);
  const input =
    field.type === 'enum'
      ? document.createElement('select')
      : document.createElement('input');
  input.dataset.presenceKey = field.key;
  if (field.type === 'enum') {
    for (const option of field.options ?? []) {
      const item = document.createElement('option');
      item.value = option;
      item.textContent = ENUM_LABELS[field.key]?.[option] ?? option;
      input.append(item);
    }
  } else if (field.type === 'boolean') {
    input.type = 'checkbox';
  } else {
    input.type = 'number';
    input.inputMode = 'decimal';
    // Range checks are done in readDraft; the step is only a hint for the
    // spinner, so an older value between steps is never flagged as invalid.
    input.step = 'any';
    if (field.min !== undefined) input.min = String(field.min);
    if (field.max !== undefined) input.max = String(field.max);
  }
  input.addEventListener('input', () => onFieldInput(field, input));
  input.addEventListener('change', () => onFieldInput(field, input));
  if (field.type === 'boolean') label.append(input, text);
  else label.append(text, input);
  return label;
}

function writeInput(field, value) {
  const input = document.querySelector(
    `[data-presence-key="${CSS.escape(field.key)}"]`,
  );
  if (!input) return;
  if (field.type === 'boolean') input.checked = value === true;
  else input.value = String(value);
}

function readInput(field, input) {
  if (field.type === 'boolean') return input.checked;
  if (field.type === 'enum') return input.value;
  if (input.value.trim() === '') return null;
  return Number(input.value);
}

function fieldError(field, value) {
  if (field.type === 'boolean' || field.type === 'enum') return null;
  if (typeof value !== 'number' || !Number.isFinite(value))
    return `${fieldLabel(field)} måste vara ett tal.`;
  if (field.min !== undefined && value < field.min)
    return `${fieldLabel(field)} måste vara minst ${field.min}.`;
  if (field.max !== undefined && value > field.max)
    return `${fieldLabel(field)} får vara högst ${field.max}.`;
  if (field.type === 'integer' && !Number.isInteger(value))
    return `${fieldLabel(field)} måste vara ett heltal.`;
  return null;
}

function onFieldInput(field, input) {
  draft[field.key] = readInput(field, input);
  resetConfirmation();
  updateFormControls();
}

function changedKeys() {
  return fields
    .map((field) => field.key)
    .filter((key) => draft[key] !== saved[key]);
}

function resetConfirmation() {
  if (confirming !== 'save') return;
  clearTimeout(confirmTimer);
  confirming = null;
  el('presence-save').textContent = 'Spara';
}

function updateFormControls() {
  const dirty = changedKeys().length > 0;
  el('presence-save').disabled = !dirty || busy;
  el('presence-discard').disabled = !dirty || busy;
  const status = el('presence-settings-status');
  if (dirty) setSettingsStatus('Du har osparade ändringar.', 'warn');
  // Only the unsaved-changes notice is cleared here; a result message stays.
  else if (status.dataset.tone === 'warn') setSettingsStatus('');
}

function setSettingsStatus(text, tone = 'neutral') {
  el('presence-settings-status').textContent = text;
  el('presence-settings-status').dataset.tone = tone;
}

function applyDocument(config) {
  fields = config.fields;
  saved = { ...config.values };
  draft = { ...config.values };
  buildForm();
  for (const field of fields) writeInput(field, saved[field.key]);
  updateFormControls();
}

async function loadConfig() {
  if (configLoading || configLoaded) return;
  configLoading = true;
  try {
    applyDocument(await capability('presence.getSensorConfig'));
    configLoaded = true;
    el('presence-form').hidden = false;
    el('presence-settings-unavailable').hidden = true;
  } catch (error) {
    el('presence-form').hidden = true;
    el('presence-settings-unavailable').hidden = false;
    el('presence-settings-unavailable').textContent = failureText(
      error,
      'Sensorns inställningar kunde inte hämtas. Kontrollera att sensorn är igång.',
    );
  } finally {
    configLoading = false;
  }
}

async function saveSettings() {
  const keys = changedKeys();
  if (!keys.length || busy) return;
  const byKey = new Map(fields.map((field) => [field.key, field]));
  for (const key of keys) {
    const message = fieldError(byKey.get(key), draft[key]);
    if (message) {
      setSettingsStatus(message, 'bad');
      return;
    }
  }
  const recalibrates = keys.some((key) => byKey.get(key).recalibrates);
  const send = async () => {
    busy = true;
    updateFormControls();
    setSettingsStatus('Sparar i sensorn …');
    try {
      const changes = Object.fromEntries(keys.map((key) => [key, draft[key]]));
      const result = await capability('presence.updateSensorConfig', {
        changes,
      });
      applyDocument(result);
      setSettingsStatus(
        result.backgroundReset
          ? 'Sparat. Sensorn lär in bakgrunden på nytt, så räkningen kan vara osäker en stund.'
          : 'Sparat.',
        'good',
      );
    } catch (error) {
      setSettingsStatus(
        failureText(
          error,
          'Sensorn svarade inte. Ändringarna är inte sparade.',
        ),
        'bad',
      );
    } finally {
      busy = false;
      updateFormControls();
    }
  };
  if (!recalibrates) {
    await send();
    return;
  }
  askToConfirm(
    'save',
    el('presence-save'),
    'Spara',
    'Bekräfta: bakgrunden lärs in på nytt',
    () => void send(),
  );
}

// ---------- Lifecycle ----------

function sync() {
  if (!panel || !section) return;
  if (isActive()) {
    openStream();
    void loadConfig();
  } else {
    closeStream();
  }
}

if (panel && section) {
  el('presence-minus').addEventListener('click', () => {
    if (latestFrame) setCount(Math.max(0, latestFrame.state.count - 1));
  });
  el('presence-plus').addEventListener('click', () => {
    if (latestFrame) setCount(Math.min(10, latestFrame.state.count + 1));
  });
  el('presence-zero').addEventListener('click', () => setCount(0));
  el('presence-recalibrate').addEventListener('click', () =>
    askToConfirm(
      'recalibrate',
      el('presence-recalibrate'),
      'Kalibrera om bakgrund',
      'Bekräfta omkalibrering',
      () =>
        void runAction(
          'presence.recalibrate',
          {},
          'Sensorn lär in bakgrunden på nytt. Räkningen kan vara osäker en stund.',
        ),
    ),
  );
  el('presence-form').addEventListener('submit', (event) => {
    event.preventDefault();
    void saveSettings();
  });
  el('presence-discard').addEventListener('click', () => {
    resetConfirmation();
    for (const field of fields) {
      draft[field.key] = saved[field.key];
      writeInput(field, saved[field.key]);
    }
    updateFormControls();
    setSettingsStatus('Ändringarna är borttagna.');
  });
  window.addEventListener('resize', () => drawRadar(latestFrame));
  window.addEventListener('hashchange', sync);
  document.addEventListener('visibilitychange', sync);
  document.addEventListener('lugn:render', sync);
  window.addEventListener('pagehide', closeStream);
  renderIdle();
  sync();
}
