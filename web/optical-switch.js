// Datorljud till WiiM: status and settings for switching the WiiM to its
// optical input as soon as the computer plays sound. The computer's agent does
// the switching; this panel only edits what Lugn tells it. app.js owns the
// session; this module borrows its CSRF token and the overview through
// window.lugnPanel and talks only to Lugn.

const API_ROOT = '/ui/api';

const PHASES = {
  disabled: ['Av', 'warn'],
  searching: ['Letar efter WiiM', 'warn'],
  idle: ['Redo', 'ok'],
  sound: ['Datorn spelar ljud', 'ok'],
};
const HOST_SOURCES = {
  config: 'från agentens egen konfiguration',
  lugn: 'inställd här',
  discovered: 'hittades automatiskt',
};

const el = (id) => document.getElementById(id);
const clone = (value) => JSON.parse(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function node(tag, className = '', text = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

let draft = null;
let original = null;
let generation = null;
let deviceId = null;
let pending = false;

function panel() {
  return window.lugnPanel;
}

function clock(ms) {
  return new Date(ms).toLocaleTimeString('sv-SE', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function available() {
  const data = panel()?.overview()?.opticalSwitch;
  return data?.version === 1 &&
    typeof data.generation === 'string' &&
    data.computers &&
    Object.keys(data.computers).length > 0
    ? data
    : null;
}

function chip(label, tone) {
  const element = node('span', 'state-chip', label);
  element.dataset.tone = tone;
  return element;
}

function reading(list, label, value) {
  const wrapper = node('div', 'reading');
  wrapper.append(node('dt', '', label), node('dd', '', value));
  list.append(wrapper);
}

function wiimText(wiim) {
  if (!wiim) return null;
  if (!wiim.reachable) return 'Svarar inte';
  if (wiim.optical) return 'Står på optisk ingång';
  return wiim.playing ? 'Spelar egen musik' : 'Står på annan ingång, pausad';
}

function statusRows(data) {
  const rows = [];
  for (const [id, entry] of Object.entries(data.computers)) {
    const agent = data.agents?.[id];
    const state = agent?.state ?? null;
    const row = node('article', 'computer-row');
    row.dataset.deviceId = id;
    const heading = node('header', 'computer-device-heading');
    heading.append(node('h3', '', id));
    const chips = node('div', 'computer-status-chips');
    if (!entry.settings.enabled)
      chips.append(chip('Av i inställningarna', 'warn'));
    else if (!agent || agent.contact !== 'live')
      chips.append(chip('Ingen kontakt med datorns agent', 'warn'));
    else {
      const phase = PHASES[state.phase] ?? ['Okänt', 'warn'];
      chips.append(chip(phase[0], phase[1]));
      if (state.capture === 'unavailable')
        chips.append(chip('Kan inte lyssna på ljudutgången', 'warn'));
    }
    heading.append(chips);
    row.append(heading);
    const lines = node('dl', 'computer-readings');
    if (agent?.contact === 'live' && state && entry.settings.enabled) {
      if (state.host)
        reading(
          lines,
          'WiiM',
          `${state.host} (${HOST_SOURCES[state.hostSource] ?? 'okänt'})`,
        );
      else if (state.phase === 'searching')
        reading(
          lines,
          'WiiM',
          state.discovered.length > 1
            ? `Hittade flera: ${state.discovered.join(', ')}. Ange vilken som ska användas.`
            : 'Ingen hittad än. Ange adressen om det inte går av sig självt.',
        );
      const wiim = wiimText(state.wiim);
      if (wiim) reading(lines, 'WiiM just nu', wiim);
      if (state.lastSwitch)
        reading(
          lines,
          'Senaste byte',
          state.lastSwitch.outcome === 'switched'
            ? `Lyckades kl ${clock(state.lastSwitch.at)} (${state.lastSwitch.latencyMs} ms efter att ljudet började)`
            : `Misslyckades kl ${clock(state.lastSwitch.at)}`,
        );
      if (state.settingsSource !== 'lugn')
        reading(
          lines,
          'Inställningar',
          'Agenten använder sina egna. Kontrollera att den har MQTT-inloggning och rätt behörighet.',
        );
      else if (state.settingsGeneration !== data.generation)
        reading(lines, 'Inställningar', 'Väntar på att agenten tar emot dem');
    }
    if (lines.children.length) row.append(lines);
    rows.push(row);
  }
  return rows;
}

function dirty() {
  return draft !== null && !same(draft, original);
}

function fill(entry) {
  const settings = entry.settings;
  draft = clone(settings);
  original = clone(settings);
  el('optical-enabled').checked = settings.enabled;
  el('optical-host').value = settings.wiimHost ?? '';
  el('optical-sink').value = settings.audioSink ?? '';
  el('optical-min').value = String(settings.minAudibleMs);
  el('optical-release').value = String(settings.releaseMs);
  el('optical-level').value = String(settings.levelDb);
}

const PRIVATE = [
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
];

/** The settings the form describes, or an error message in Swedish. */
function readForm() {
  const number = (id) => Number(el(id).value);
  const min = number('optical-min');
  const release = number('optical-release');
  const level = number('optical-level');
  const host = el('optical-host').value.trim();
  const sink = el('optical-sink').value.trim();
  if (!(Number.isInteger(min) && min >= 200 && min <= 5000))
    return { error: 'Ljudets längd måste vara 200–5000 millisekunder.' };
  if (!(Number.isInteger(release) && release >= 500 && release <= 10000))
    return {
      error:
        'Tystnaden som avslutar ett ljud måste vara 500–10000 millisekunder.',
    };
  if (!(Number.isInteger(level) && level >= -80 && level <= -20))
    return {
      error: 'Känsligheten måste vara ett heltal mellan -80 och -20 dB.',
    };
  if (host) {
    const name = host.split(':')[0];
    const port = host.includes(':') ? Number(host.split(':')[1]) : 443;
    const okName =
      PRIVATE.some((pattern) => pattern.test(name)) ||
      (name.endsWith('.local') && name.length > 6);
    if (
      !/^[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?$/.test(host) ||
      !okName ||
      !(port >= 1 && port <= 65535)
    )
      return {
        error:
          'WiiM-adressen måste vara en IP-adress på det lokala nätverket (till exempel 192.168.1.50) eller ett namn som slutar på .local.',
      };
  }
  if (sink && !/^[A-Za-z0-9._:-]{1,128}$/.test(sink))
    return {
      error:
        'Ljudutgångens namn får bara innehålla bokstäver, siffror och . _ : -',
    };
  return {
    settings: {
      enabled: el('optical-enabled').checked,
      wiimHost: host || null,
      audioSink: sink || null,
      minAudibleMs: min,
      releaseMs: release,
      levelDb: level,
    },
  };
}

function message(text, tone = '') {
  el('optical-message').textContent = text;
  el('optical-message').dataset.tone = tone;
}

function updateControls(data) {
  const stale = !panel()?.overview();
  const current = data?.computers?.[deviceId];
  el('optical-fields').disabled = pending;
  el('optical-save').disabled = pending || stale || !dirty();
  el('optical-discard').disabled = pending || !dirty();
  el('optical-reset').disabled = pending || stale || !current?.customized;
  if (pending) el('optical-save').setAttribute('aria-busy', 'true');
  else el('optical-save').removeAttribute('aria-busy');
}

function render() {
  const data = available();
  el('optical-section').hidden = !data;
  if (!data) return;
  el('optical-status').replaceChildren(...statusRows(data));
  const ids = Object.keys(data.computers).sort();
  if (!deviceId || !ids.includes(deviceId)) {
    deviceId = ids[0];
    draft = null;
  }
  const select = el('optical-device');
  if (
    !same(
      [...select.options].map((o) => o.value),
      ids,
    )
  ) {
    select.replaceChildren(
      ...ids.map((id) => {
        const option = node('option', '', id);
        option.value = id;
        return option;
      }),
    );
  }
  select.value = deviceId;
  el('optical-device-field').hidden = ids.length < 2;
  if (!draft || (!dirty() && generation !== data.generation && !pending)) {
    generation = data.generation;
    fill(data.computers[deviceId]);
  }
  updateControls(data);
}

async function post(body) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${API_ROOT}/optical/settings`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'X-Lugn-CSRF': panel().csrfToken(),
      },
      body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (response.ok) return result;
    if (response.status === 409)
      throw new Error(
        'Ändrat på annat håll. Ditt utkast finns kvar. Ångra ändringarna för att hämta de sparade och försök igen.',
      );
    if (response.status === 401 || response.status === 403)
      throw new Error(
        'Sessionen har gått ut. Logga in igen. Ditt utkast finns kvar.',
      );
    if (response.status === 503)
      throw new Error('Inställningarna kan inte sparas på servern just nu.');
    throw new Error(
      'Servern kunde inte spara inställningarna. Ditt utkast finns kvar.',
    );
  } catch (error) {
    if (error?.name === 'AbortError')
      throw new Error('Servern svarade inte. Ditt utkast finns kvar.');
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function save(settings, doneText) {
  if (pending) return;
  const data = available();
  if (!data) return;
  pending = true;
  updateControls(data);
  message('Väntar på serverns svar…');
  try {
    const result = await post({
      deviceId,
      settings,
      // The generation the draft was made from, so a change made elsewhere
      // meanwhile is reported as a conflict instead of being overwritten.
      expectedGeneration: generation,
    });
    generation = result.generation;
    draft = null;
    await panel().refresh?.();
    message(doneText, 'ok');
  } catch (error) {
    message(error.message, 'bad');
  } finally {
    pending = false;
    render();
  }
}

function init() {
  if (!el('optical-form')) return;
  const edited = () => {
    if (el('optical-message').dataset.tone === 'bad') message('');
    const parsed = readForm();
    if (parsed.settings) draft = parsed.settings;
    updateControls(available());
  };
  el('optical-form').addEventListener('input', edited);
  el('optical-form').addEventListener('change', edited);
  el('optical-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const parsed = readForm();
    if (parsed.error) return message(parsed.error, 'bad');
    void save(parsed.settings, 'Sparat. Gäller direkt.');
  });
  el('optical-device').addEventListener('change', () => {
    if (
      dirty() &&
      !window.confirm('Kasta osparade ändringar för den här datorn?')
    ) {
      el('optical-device').value = deviceId;
      return;
    }
    deviceId = el('optical-device').value;
    draft = null;
    render();
  });
  el('optical-discard').addEventListener('click', () => {
    const data = available();
    if (!data) return;
    fill(data.computers[deviceId]);
    updateControls(data);
    message('Ändringarna är borttagna.');
  });
  el('optical-reset').addEventListener('click', () => {
    if (
      !window.confirm(
        'Återställa till grundinställningen från konfigurationen?',
      )
    )
      return;
    void save(null, 'Grundinställningen gäller igen.');
  });
  document.addEventListener('lugn:render', render);
  window.addEventListener('beforeunload', (event) => {
    if (dirty() || pending) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
  render();
}

init();
