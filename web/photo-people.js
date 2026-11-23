// Foton: who the photo frame has found in the pictures. Lugn groups the faces
// it sees; here the household names the people, confirms a group or moves a
// face that landed in the wrong one. app.js owns the session; this module
// borrows its CSRF token through window.lugnPanel and talks only to Lugn.
// Everything about a face stays on the machine that runs Lugn.

const API = '/ui/api/photo-people';
const POLL_MS = 4000;

const el = (id) => document.getElementById(id);
function node(tag, className = '', text = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

let data = null;
let pollTimer = 0;
let busy = false;
let openFace = null;

const section = () => el('photo-people-section');
const visible = () => {
  const target = section();
  return Boolean(
    target && !target.hidden && !target.classList.contains('page-inactive'),
  );
};

async function call(path, body) {
  const csrf = window.lugnPanel?.csrfToken?.();
  const response = await fetch(`${API}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers:
      body === undefined
        ? {}
        : { 'content-type': 'application/json', 'x-lugn-csrf': csrf ?? '' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(String(response.status));
  return response.json();
}

function say(message, tone = '') {
  const note = el('photo-people-note');
  if (!note) return;
  note.textContent = message;
  note.dataset.tone = tone;
  note.hidden = !message;
}

async function load() {
  if (busy) return;
  try {
    data = await call('');
    render();
    say('');
  } catch {
    say('Det gick inte att läsa personerna just nu.', 'warn');
  } finally {
    schedule();
  }
}

async function act(path, body, done) {
  if (busy) return;
  busy = true;
  setBusy(true);
  try {
    data = await call(path, body);
    say(done ?? '', 'ok');
  } catch {
    say('Ändringen gick inte att spara. Försök igen.', 'warn');
  } finally {
    busy = false;
    setBusy(false);
    render();
  }
}

function setBusy(on) {
  section()?.toggleAttribute('data-busy', on);
}

function schedule() {
  window.clearTimeout(pollTimer);
  pollTimer = 0;
  if (!visible() || document.hidden) return;
  const working = data?.status?.analyzer?.pending > 0;
  pollTimer = window.setTimeout(
    () => void load(),
    working ? POLL_MS : POLL_MS * 6,
  );
}

// ── Reading the state ──

function statusText(status) {
  if (!status) return ['Läser …', 'warn'];
  if (!status.available)
    return [
      status.missingModels?.length ? 'Modellerna saknas' : 'Bildanalysen är av',
      'warn',
    ];
  const a = status.analyzer;
  if (a.state === 'backoff') return ['Pausad efter fel', 'warn'];
  if (a.pending > 0)
    return [
      `Analyserar ${a.pending} ${a.pending === 1 ? 'bild' : 'bilder'}`,
      'warn',
    ];
  return [`${status.analysed} av ${status.photos} bilder analyserade`, 'ok'];
}

function peopleLabel(person) {
  const faces = `${person.faces} ${person.faces === 1 ? 'ansikte' : 'ansikten'}`;
  const photos = `${person.photos} ${person.photos === 1 ? 'bild' : 'bilder'}`;
  return `${faces} · ${photos}`;
}

// ── Drawing ──

function faceButton(sample, owner) {
  const button = node('button', 'pp-face');
  button.type = 'button';
  button.setAttribute('aria-label', 'Visa ansiktet');
  const image = new Image();
  image.alt = '';
  image.loading = 'lazy';
  image.decoding = 'async';
  image.src = `${API}/faces/${sample.id}.jpg`;
  button.append(image);
  button.addEventListener('click', () => showFace(sample, owner));
  return button;
}

function personCard(person) {
  const card = node('article', 'pp-person');
  card.dataset.state = person.hidden
    ? 'hidden'
    : person.confirmed
      ? 'confirmed'
      : 'auto';
  const head = node('div', 'pp-head');
  const field = node('input');
  field.type = 'text';
  field.value = person.name ?? '';
  field.placeholder = 'Namnge personen';
  field.maxLength = 40;
  field.autocomplete = 'off';
  field.setAttribute('aria-label', 'Namn');
  const save = () => {
    const name = field.value.trim();
    if ((person.name ?? '') === name) return;
    void act(
      `/people/${person.id}`,
      { name: name === '' ? null : name },
      'Namnet är sparat.',
    );
  };
  field.addEventListener('change', save);
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      field.blur();
    }
  });
  const chip = node(
    'span',
    'state-chip',
    person.hidden ? 'Dold' : person.confirmed ? 'Bekräftad' : 'Föreslagen',
  );
  chip.dataset.tone = person.confirmed && !person.hidden ? 'ok' : 'warn';
  head.append(field, chip);
  const meta = node('p', 'pp-meta', peopleLabel(person));
  const faces = node('div', 'pp-faces');
  for (const sample of person.samples)
    faces.append(faceButton(sample, person.id));
  const actions = node('div', 'button-row pp-actions');
  if (!person.confirmed && !person.hidden && person.faces > 0) {
    const confirm = node(
      'button',
      'button button-small',
      'Det här är en person',
    );
    confirm.type = 'button';
    confirm.addEventListener(
      'click',
      () =>
        void act(
          `/people/${person.id}`,
          { confirm: true },
          'Gruppen är bekräftad.',
        ),
    );
    actions.append(confirm);
  }
  const others = data.people.filter((p) => p.id !== person.id && !p.hidden);
  if (others.length > 0) {
    const merge = node('select', 'pp-select');
    merge.setAttribute('aria-label', 'Slå ihop med');
    merge.append(new Option('Slå ihop med …', ''));
    for (const other of others)
      merge.append(
        new Option(other.name ?? `Okänd person ${other.id.slice(1)}`, other.id),
      );
    merge.addEventListener('change', () => {
      if (merge.value)
        void act(
          '/merge',
          { from: person.id, into: merge.value },
          'Personerna är ihopslagna.',
        );
    });
    actions.append(merge);
  }
  const hide = node(
    'button',
    'button button-small button-quiet',
    person.hidden ? 'Visa igen' : 'Dölj',
  );
  hide.type = 'button';
  hide.title = person.hidden
    ? 'Använd personen i bildurvalet igen'
    : 'Använd inte personen i bildurvalet (en främling i bakgrunden, till exempel)';
  hide.addEventListener(
    'click',
    () => void act(`/people/${person.id}`, { hidden: !person.hidden }),
  );
  actions.append(hide);
  card.append(head, meta, faces, actions);
  return card;
}

function render() {
  const root = el('photo-people-list');
  if (!root || !data) return;
  const [text, tone] = statusText(data.status);
  const chip = el('photo-people-state');
  chip.textContent = text;
  chip.dataset.tone = tone;
  const reason = el('photo-people-reason');
  reason.hidden = !data.status?.reason;
  reason.textContent = data.status?.reason ?? '';

  const shown = data.people.filter((p) => !p.hidden && p.faces > 0);
  const hidden = data.people.filter((p) => p.hidden);
  root.replaceChildren(...shown.map(personCard));
  el('photo-people-empty').hidden =
    shown.length > 0 || data.unassigned.count > 0;

  const unassigned = el('photo-people-unassigned');
  unassigned.hidden = data.unassigned.count === 0;
  el('photo-people-unassigned-count').textContent = String(
    data.unassigned.count,
  );
  const faces = el('photo-people-unassigned-faces');
  faces.replaceChildren(
    ...data.unassigned.samples.map((s) => faceButton(s, null)),
  );

  const hiddenBox = el('photo-people-hidden');
  hiddenBox.hidden = hidden.length === 0;
  el('photo-people-hidden-count').textContent = String(hidden.length);
  el('photo-people-hidden-list').replaceChildren(...hidden.map(personCard));
  if (openFace) refreshFaceDialog();
}

// ── One face: look at it in its picture and put it right ──

function dialog() {
  return el('photo-people-face');
}

function showFace(sample, owner) {
  openFace = { sample, owner };
  const box = dialog();
  if (!box) return;
  const image = el('photo-people-face-photo');
  image.src = `${API}/photos/${sample.photoId}.jpg`;
  const frame = el('photo-people-face-frame');
  frame.style.left = `${sample.x * 100}%`;
  frame.style.top = `${sample.y * 100}%`;
  frame.style.width = `${sample.w * 100}%`;
  frame.style.height = `${sample.h * 100}%`;
  refreshFaceDialog();
  if (!box.open) box.showModal();
}

function refreshFaceDialog() {
  const box = dialog();
  if (!box || !openFace || !data) return;
  const { sample, owner } = openFace;
  const current = data.people.find((p) =>
    p.samples.some((s) => s.id === sample.id),
  );
  const ownerId = current?.id ?? null;
  openFace.owner = ownerId;
  el('photo-people-face-who').textContent = current
    ? (current.name ?? `Okänd person ${current.id.slice(1)}`)
    : 'Ingen person ännu';
  const choose = el('photo-people-face-move');
  choose.replaceChildren(new Option('Flytta till …', ''));
  for (const person of data.people.filter((p) => !p.hidden && p.id !== ownerId))
    choose.append(
      new Option(
        person.name ?? `Okänd person ${person.id.slice(1)}`,
        `p:${person.id}`,
      ),
    );
  choose.append(new Option('En ny person', 'new'));
  choose.append(new Option('Inte en person (visa aldrig)', 'none'));
  void owner;
}

function wireDialog() {
  const box = dialog();
  if (!box || box.dataset.wired) return;
  box.dataset.wired = '1';
  el('photo-people-face-close').addEventListener('click', () => {
    box.close();
  });
  box.addEventListener('close', () => {
    openFace = null;
    el('photo-people-face-photo').removeAttribute('src');
  });
  el('photo-people-face-move').addEventListener('change', (event) => {
    const value = event.target.value;
    if (!value || !openFace) return;
    const body =
      value === 'new'
        ? { new: true }
        : value === 'none'
          ? { none: true }
          : { person: value.slice(2) };
    const id = openFace.sample.id;
    box.close();
    void act(`/faces/${id}`, body, 'Ansiktet är flyttat.');
  });
}

// ── Page life ──

function start() {
  wireDialog();
  void load();
}

function check() {
  if (visible()) {
    if (!data) start();
    else {
      void load();
    }
  } else window.clearTimeout(pollTimer);
}

window.addEventListener('hashchange', () => window.setTimeout(check, 0));
document.addEventListener('visibilitychange', check);
document.addEventListener('lugn:render', () => {
  if (visible() && !data) check();
});
window.setTimeout(check, 0);
