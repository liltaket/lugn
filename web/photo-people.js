// Foton: who the photo frame has found in the pictures. The photo brain on
// Kuffe finds the faces and proposes who they are; here the household names
// the people, confirms a group or moves a face that landed in the wrong one.
// app.js owns the session; this module borrows its CSRF token through
// window.lugnPanel and talks only to Lugn.

const API = '/ui/api/photo-people';
const POLL_MS = 4000;
/** A bundle older than this: Kuffe has gone quiet. */
const QUIET_MS = 6 * 60 * 60 * 1000;

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
  const brain = data?.status?.brain;
  const working = Boolean(brain?.intelAt) && brain.analysed < brain.photos;
  pollTimer = window.setTimeout(
    () => void load(),
    working ? POLL_MS : POLL_MS * 6,
  );
}

// ── Reading the state ──

const sinceFormat = new Intl.DateTimeFormat('sv-SE', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

function statusText(status, now = Date.now()) {
  if (!status) return ['Läser …', 'warn'];
  if (!status.available) return ['Bildanalysen är av', 'warn'];
  const brain = status.brain;
  if (!brain?.intelAt) return ['Väntar på Kuffe', 'warn'];
  if (now - brain.intelAt > QUIET_MS)
    return [
      `Kuffe har inte hörts av sedan ${sinceFormat.format(new Date(brain.intelAt))}`,
      'warn',
    ];
  return [
    `Kuffe: ${brain.analysed} av ${brain.photos} ${brain.photos === 1 ? 'bild analyserad' : 'bilder analyserade'}`,
    brain.analysed < brain.photos ? 'warn' : 'ok',
  ];
}

function peopleLabel(person) {
  const faces = `${person.faces} ${person.faces === 1 ? 'ansikte' : 'ansikten'}`;
  const photos = `${person.photos} ${person.photos === 1 ? 'bild' : 'bilder'}`;
  return `${faces} · ${photos}`;
}

// ── Drawing ──

function faceButton(sample) {
  const button = node('button', 'pp-face');
  button.type = 'button';
  button.setAttribute('aria-label', 'Visa ansiktet');
  const image = new Image();
  image.alt = '';
  image.loading = 'lazy';
  image.decoding = 'async';
  image.src = `${API}/faces/${sample.id}.jpg`;
  button.append(image);
  button.addEventListener('click', () => void openPicture(sample));
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
  for (const sample of person.samples) faces.append(faceButton(sample));
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
  faces.replaceChildren(...data.unassigned.samples.map((s) => faceButton(s)));

  const hiddenBox = el('photo-people-hidden');
  hiddenBox.hidden = hidden.length === 0;
  el('photo-people-hidden-count').textContent = String(hidden.length);
  el('photo-people-hidden-list').replaceChildren(...hidden.map(personCard));

  const skipped = data.skippedPhotos ?? [];
  el('photo-people-skipped').hidden = skipped.length === 0;
  el('photo-people-skipped-title').textContent =
    `Bilder där ansiktena inte spelar roll (${skipped.length})`;
  el('photo-people-skipped-list').replaceChildren(
    ...skipped.map((id) => pictureButton(id)),
  );
}

/** A picture whose faces were marked as not mattering; tap to open it. */
function pictureButton(photoId) {
  const button = node('button', 'pp-thumb');
  button.type = 'button';
  button.setAttribute('aria-label', 'Öppna bilden');
  const image = new Image();
  image.alt = '';
  image.loading = 'lazy';
  image.decoding = 'async';
  image.src = `${API}/photos/${photoId}.jpg`;
  button.append(image);
  button.addEventListener('click', () => void openPicture({ photoId }));
  return button;
}

// ── Reviewing faces in their pictures ──

/** The review is loaded the first time it is wanted. */
let reviewLoaded = null;
function reviewer() {
  reviewLoaded ??= import('./photo-review.js')
    .then((module) =>
      module.createReview({
        call,
        // Every answer carries the panel's people, so the page behind stays right.
        onChange(reply) {
          if (reply?.people && reply.unassigned) data = reply;
        },
        onClose() {
          render();
          void load();
        },
      }),
    )
    .catch((error) => {
      // A failed load is tried again next time.
      reviewLoaded = null;
      throw error;
    });
  return reviewLoaded;
}

async function openPicture(sample) {
  try {
    await (await reviewer()).openPhoto(sample.photoId, sample.id);
  } catch {
    say('Bilden gick inte att öppna just nu.', 'warn');
  }
}

async function startReview() {
  try {
    if (!(await (await reviewer()).openQueue()))
      say('Inga ansikten väntar på en person.', 'ok');
  } catch {
    say('Granskningen gick inte att starta just nu.', 'warn');
  }
}

// ── Page life ──

function start() {
  const begin = el('photo-review-start');
  if (begin && !begin.dataset.wired) {
    begin.dataset.wired = '1';
    begin.addEventListener('click', () => void startReview());
  }
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
