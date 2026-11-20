// Skärmstyrning: status and settings for putting a computer's display to sleep
// and waking it. app.js owns the session; this module borrows its CSRF token
// and the overview through window.lugnPanel and talks only to Lugn.

const API_ROOT = '/ui/api';
const MINUTE = 60_000;

const HELD_BY = {
  video: 'Film spelas',
  game: 'Spel pågår',
  fullscreen_playback: 'Helskärm med uppspelning',
  other_blocker: 'Något håller datorn vaken',
  unexplained_inhibitor: 'Något spärrar vila utan förklaring',
  computer_unknown: 'Datorns status är okänd',
  blockers_unknown: 'Kan inte läsa vad som håller datorn vaken',
  no_feedback: 'Datorn rapporterar inte skärmläget',
  keeps_waking: 'Skärmen tänds om hela tiden',
  off_failed: 'Släckningen lyckades inte',
};
const INHIBITED = {
  recent_input: 'Du använder datorn',
  recent_activity: 'Datorn är aktiv',
  video_or_game: 'Film eller spel pågår',
};
const PROBLEMS = {
  off_failed: 'Släckningen lyckades inte',
  keeps_waking: 'Skärmen tänds om hela tiden',
  wake_failed: 'Tändningen lyckades inte',
  wake_unavailable: 'Ingen skärm ansluten',
};
const POWER = {
  on: ['Skärmen är på', 'ok'],
  off: ['Skärmen är släckt', 'ok'],
  partial: ['Skärmarna är delvis på', 'warn'],
  none: ['Ingen skärm ansluten', 'warn'],
  unknown: ['Skärmläget är okänt', 'warn'],
};
const OUTCOMES = {
  applied: 'lyckades',
  rejected: 'avvisades',
  uncertain: 'gav ingen märkbar effekt',
  failed: 'fick inget svar',
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

function minutes(ms) {
  return Math.round((ms / MINUTE) * 100) / 100;
}

function clock(ms) {
  return new Date(ms).toLocaleTimeString('sv-SE', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function available() {
  const data = panel()?.overview()?.displayPower;
  return data?.version === 1 &&
    typeof data.generation === 'string' &&
    data.computers &&
    Object.keys(data.computers).length > 0
    ? data
    : null;
}

function statusRows(data, displays, now) {
  const rows = [];
  for (const [id, entry] of Object.entries(data.computers)) {
    const display = displays?.[id];
    const row = node('article', 'computer-row');
    row.dataset.deviceId = id;
    const heading = node('header', 'computer-device-heading');
    heading.append(node('h3', '', id));
    const chips = node('div', 'computer-status-chips');
    if (!entry.settings.enabled)
      chips.append(chip('Av i inställningarna', 'warn'));
    else if (!display || display.control !== 'available')
      chips.append(chip('Ingen kontakt med datorns agent', 'warn'));
    else {
      const power =
        POWER[display.observed?.power ?? 'unknown'] ?? POWER.unknown;
      chips.append(chip(power[0], power[1]));
    }
    heading.append(chips);
    row.append(heading);
    const lines = node('dl', 'computer-readings');
    if (display && entry.settings.enabled) {
      if (display.inhibited)
        reading(
          lines,
          'Väntar',
          INHIBITED[display.inhibited] ?? display.inhibited,
        );
      if (display.problem)
        reading(lines, 'Problem', PROBLEMS[display.problem] ?? display.problem);
      const idle = display.idleSleep;
      if (idle) {
        if (idle.heldBy)
          reading(
            lines,
            'Släcks inte på inaktivitet',
            HELD_BY[idle.heldBy] ?? idle.heldBy,
          );
        else if (idle.dueAt)
          reading(
            lines,
            'Släcks vid inaktivitet',
            idle.dueAt <= now
              ? 'nu'
              : `om ${Math.max(1, Math.round((idle.dueAt - now) / MINUTE))} min (${clock(idle.dueAt)})`,
          );
      }
      if (
        display.nextAttemptAt &&
        display.desired === 'off' &&
        !display.inhibited
      )
        reading(
          lines,
          'Släcks',
          display.nextAttemptAt <= now
            ? 'nu'
            : `kl ${clock(display.nextAttemptAt)}`,
        );
      if (display.lastRequest)
        reading(
          lines,
          'Senaste kommando',
          `${display.lastRequest.action === 'off' ? 'Släck' : 'Tänd'} ${OUTCOMES[display.lastRequest.outcome] ?? ''} kl ${clock(display.lastRequest.at)}`,
        );
    }
    if (lines.children.length) row.append(lines);
    rows.push(row);
  }
  return rows;
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

function dirty() {
  return draft !== null && !same(draft, original);
}

function fill(entry) {
  const settings = entry.settings;
  draft = clone(settings);
  original = clone(settings);
  el('display-enabled').checked = settings.enabled;
  el('display-away').checked = settings.ensureOffWhenAway;
  el('display-off-after').value = String(minutes(settings.offAfterEmptyMs));
  el('display-idle-enabled').checked = settings.idleSleepAfterMs !== null;
  el('display-idle-minutes').value = String(
    minutes(settings.idleSleepAfterMs ?? 30 * MINUTE),
  );
  el('display-inhibit').checked = settings.inhibitOnActivity;
  el('display-inhibit-max').value = String(
    minutes(settings.activeInhibitMaxMs),
  );
  el('display-ignore').value = settings.ignoreIdleBlockers.join(', ');
  el('display-wake').checked = settings.wakeOnEntry;
  el('display-wake-quiet').checked = settings.wakeInQuietHours;
}

/** The settings the form describes, or an error message in Swedish. */
function readForm() {
  const number = (id) => Number(el(id).value);
  const offAfter = number('display-off-after');
  const idle = number('display-idle-minutes');
  const inhibitMax = number('display-inhibit-max');
  if (!(offAfter >= 1 && offAfter <= 1440))
    return { error: 'Tomt rum måste vara 1–1440 minuter.' };
  if (el('display-idle-enabled').checked && !(idle >= 5 && idle <= 1440))
    return { error: 'Inaktivitet måste vara 5–1440 minuter.' };
  if (!(inhibitMax >= 0 && inhibitMax <= 1440))
    return { error: 'Väntetiden för film och spel måste vara 0–1440 minuter.' };
  const ignore = [
    ...new Set(
      el('display-ignore')
        .value.split(',')
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ];
  if (ignore.length > 16 || ignore.some((name) => name.length > 64))
    return { error: 'Högst 16 appnamn, vardera högst 64 tecken.' };
  return {
    settings: {
      enabled: el('display-enabled').checked,
      offAfterEmptyMs: Math.round(offAfter * MINUTE),
      ensureOffWhenAway: el('display-away').checked,
      wakeOnEntry: el('display-wake').checked,
      wakeInQuietHours: el('display-wake-quiet').checked,
      inhibitOnActivity: el('display-inhibit').checked,
      activeInhibitMaxMs: Math.round(inhibitMax * MINUTE),
      idleSleepAfterMs: el('display-idle-enabled').checked
        ? Math.round(idle * MINUTE)
        : null,
      ignoreIdleBlockers: ignore,
    },
  };
}

function message(text, tone = '') {
  el('display-power-message').textContent = text;
  el('display-power-message').dataset.tone = tone;
}

function updateControls(data) {
  const stale = !panel()?.overview();
  const current = data?.computers?.[deviceId];
  el('display-power-fields').disabled = pending;
  el('display-save').disabled = pending || stale || !dirty();
  el('display-discard').disabled = pending || !dirty();
  el('display-reset').disabled = pending || stale || !current?.customized;
  el('display-idle-minutes').disabled = !el('display-idle-enabled').checked;
  if (pending) el('display-save').setAttribute('aria-busy', 'true');
  else el('display-save').removeAttribute('aria-busy');
}

function render() {
  const data = available();
  el('display-power-section').hidden = !data;
  if (!data) return;
  const overview = panel().overview();
  el('display-power-status').replaceChildren(
    ...statusRows(data, overview.state?.computer?.displays, Date.now()),
  );
  const ids = Object.keys(data.computers).sort();
  if (!deviceId || !ids.includes(deviceId)) {
    deviceId = ids[0];
    draft = null;
  }
  const select = el('display-device');
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
  el('display-device-field').hidden = ids.length < 2;
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
    const response = await fetch(`${API_ROOT}/display/settings`, {
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
  if (!el('display-power-form')) return;
  const edited = () => {
    if (el('display-power-message').dataset.tone === 'bad') message('');
    const parsed = readForm();
    if (parsed.settings) draft = parsed.settings;
    updateControls(available());
  };
  el('display-power-form').addEventListener('input', edited);
  el('display-power-form').addEventListener('change', edited);
  el('display-power-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const parsed = readForm();
    if (parsed.error) return message(parsed.error, 'bad');
    void save(parsed.settings, 'Sparat. Gäller direkt.');
  });
  el('display-device').addEventListener('change', () => {
    if (
      dirty() &&
      !window.confirm('Kasta osparade ändringar för den här datorn?')
    ) {
      el('display-device').value = deviceId;
      return;
    }
    deviceId = el('display-device').value;
    draft = null;
    render();
  });
  el('display-discard').addEventListener('click', () => {
    const data = available();
    if (!data) return;
    fill(data.computers[deviceId]);
    updateControls(data);
    message('Ändringarna är borttagna.');
  });
  el('display-reset').addEventListener('click', () => {
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
