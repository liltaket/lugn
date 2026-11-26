// Foton: "Granska ansikten". A picture at a time, every face in it: say who it
// is from the keyboard, say that it does not matter (or that none of the
// picture's faces do), and drag a box with the mouse when the detector put it
// on an arm instead of a face. The thinking is in photo-review-logic.js; this
// file is the page: it draws, listens and talks to Lugn through `call`.

import {
  bodyFor,
  boxBody,
  findPeople,
  guess,
  keyAction,
  moveBox,
  nextOpen,
  orderPeople,
  personName,
  resizeBox,
  sameBox,
  stepFace,
  stepPhoto,
  undoBody,
} from './photo-review-logic.js';

const API = '/ui/api/photo-people';
/** How many people the number keys reach. */
const NUMBERED = 9;
/** A finger or a hand moves a little when it clicks. */
const DRAG_PX = 4;

const el = (id) => document.getElementById(id);
function node(tag, className = '', text = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}
const percent = (value) => `${(value * 100).toFixed(3)}%`;
const cropUrl = (face) =>
  `${API}/faces/${face.id}.jpg?b=${[face.x, face.y, face.w, face.h]
    .map((n) => Math.round(n * 1000))
    .join('-')}`;

function keycap(text) {
  const key = node('kbd', 'pr-key', text);
  key.setAttribute('aria-hidden', 'true');
  return key;
}

/**
 * `call(path, body?)` asks Lugn (GET without a body) and returns the JSON;
 * `onChange(reply)` hears every answer that carries the panel's people;
 * `onClose()` runs when the review is put away.
 */
export function createReview({ call, onChange, onClose }) {
  let state = null;
  let wired = false;
  let noteTimer = 0;

  const dialog = () => el('photo-review');
  const photoOf = (id) => state.photos.get(id);
  const here = () => photoOf(state.at.photoId);
  const faceIn = (photoId, faceId) =>
    photoOf(photoId)?.faces.find((f) => f.id === faceId);
  const current = () => faceIn(state.at.photoId, state.at.faceId);
  /** The people the number keys pick; the order is fixed for the whole review. */
  const numbered = () =>
    state.slots
      .map((id) => state.people.find((p) => p.id === id))
      .filter(Boolean);
  /** Someone new keeps the numbers of everybody else and takes the next free one. */
  function keepSlots() {
    const known = new Set(state.people.map((p) => p.id));
    state.slots = state.slots.filter((id) => known.has(id));
    for (const person of orderPeople(state.people))
      if (!state.slots.includes(person.id)) state.slots.push(person.id);
  }
  const nameOfFace = (face) => {
    if (face.person) {
      const person = state.people.find((p) => p.id === face.person);
      return person ? personName(person) : (face.label ?? 'Ny person');
    }
    return face.label ?? null;
  };

  // ── Opening and closing ──

  /** Every picture with a face nobody has placed, a crowd first. */
  async function openQueue() {
    const queue = await call('/review');
    if (queue.photos.length === 0) return false;
    start('queue', queue.photos, queue.people, null);
    return true;
  }

  /** One picture, on one face; for a face tapped in the panel. */
  async function openPhoto(photoId, faceId) {
    const { photo, people } = await call(`/photos/${photoId}.json`);
    start('single', [photo], people, faceId ?? null);
  }

  function start(mode, photos, people, faceId) {
    wire();
    const order = photos.map((p) => p.id);
    state = {
      mode,
      order,
      photos: new Map(photos.map((p) => [p.id, p])),
      people,
      slots: [],
      at: null,
      undo: [],
      recent: [],
      finder: false,
      pick: 0,
      choices: [],
      pending: new Map(),
      chain: Promise.resolve(),
      decided: 0,
      done: false,
      drag: null,
      stale: false,
    };
    keepSlots();
    const wanted = faceId
      ? photos.find((p) => p.faces.some((f) => f.id === faceId))
      : null;
    if (wanted) state.at = { photoId: wanted.id, faceId };
    else {
      const open = order
        .map((id) => photoOf(id).faces.find((f) => f.state === 'open'))
        .find(Boolean);
      const photo = open
        ? photos.find((p) => p.faces.includes(open))
        : photos[0];
      state.at = { photoId: photo.id, faceId: (open ?? photo.faces[0]).id };
    }
    el('photo-review-note').textContent = '';
    const box = dialog();
    if (!box.open) box.showModal();
    box.focus();
    render();
  }

  function close() {
    const box = dialog();
    if (box?.open) box.close();
  }

  function closed() {
    state = null;
    window.clearTimeout(noteTimer);
    el('photo-review-photo').removeAttribute('src');
    el('photo-review-boxes').replaceChildren();
    el('photo-review-crop').removeAttribute('src');
    el('photo-review-finder').hidden = true;
    el('photo-review-boxes').style.visibility = '';
    onClose();
  }

  function wire() {
    if (wired) return;
    wired = true;
    const box = dialog();
    box.addEventListener('close', closed);
    box.addEventListener('cancel', (event) => {
      if (!state) return;
      // Escape puts the name finder away first, the review second.
      if (state.finder) {
        event.preventDefault();
        closeFinder();
      }
    });
    el('photo-review-close').addEventListener('click', close);
    el('photo-review-done-close').addEventListener('click', close);
    // On the document, not the dialog: when a button is redrawn under the
    // focus, the keys go to the page, and they must still reach the review.
    document.addEventListener('keydown', onKey);
    const holder = el('photo-review-boxes');
    holder.addEventListener('pointerdown', onPointerDown);
    holder.addEventListener('pointermove', onPointerMove);
    holder.addEventListener('pointerup', onPointerUp);
    holder.addEventListener('pointercancel', onPointerUp);
    el('photo-review-photo').addEventListener('load', () => {
      fit();
      el('photo-review-boxes').style.visibility = '';
    });
    el('photo-review-photo').addEventListener('error', () => {
      if (state) note('Bilden gick inte att läsa.', 'warn');
    });
    if (typeof ResizeObserver === 'function')
      new ResizeObserver(fit).observe(el('photo-review-stage'));
    const form = el('photo-review-finder');
    form.addEventListener('submit', (event) => event.preventDefault());
    const search = el('photo-review-search');
    search.addEventListener('input', () => {
      state.pick = 0;
      renderMatches();
    });
    search.addEventListener('keydown', onFinderKey);
  }

  // ── Keys ──

  function onKey(event) {
    if (!state || event.defaultPrevented || !dialog().open) return;
    // A key held down is not a decision per face.
    if (event.repeat) return;
    if (state.finder) return;
    const target = event.target;
    // A button or a field that has the focus keeps Space and Enter.
    if (
      (event.key === ' ' || event.key === 'Enter') &&
      target?.closest?.('button, a, select, input, textarea, summary')
    )
      return;
    const action = keyAction(event);
    if (!action || action.type === 'close') return;
    event.preventDefault();
    run(action);
  }

  function run(action) {
    if (state.done) {
      if (action.type === 'undo') undo();
      else if (['skip', 'find', 'next'].includes(action.type)) close();
      return;
    }
    switch (action.type) {
      case 'person': {
        const person = numbered()[action.index];
        if (person && action.index < NUMBERED)
          decide({ type: 'person', person: person.id });
        break;
      }
      case 'new':
        decide({ type: 'new' });
        break;
      case 'ignore':
        decide({ type: 'ignore' });
        break;
      case 'ignorePhoto':
        togglePhoto();
        break;
      case 'skip':
        goTo(nextOpen(state.photos, state.order, state.at, { wrap: true }));
        break;
      case 'next':
        goTo(stepFace(state.photos, state.order, state.at, 1));
        break;
      case 'previous':
        goTo(stepFace(state.photos, state.order, state.at, -1));
        break;
      case 'nextPhoto':
        goTo(stepPhoto(state.photos, state.order, state.at, 1));
        break;
      case 'previousPhoto':
        goTo(stepPhoto(state.photos, state.order, state.at, -1));
        break;
      case 'undo':
        undo();
        break;
      case 'resetBox':
        resetBox();
        break;
      case 'find':
        openFinder();
        break;
      default:
    }
  }

  function goTo(target) {
    if (!target) return;
    state.at = target;
    render();
  }

  // ── Deciding ──

  const snapshot = (face) => ({
    state: face.state,
    person: face.person,
    auto: face.auto,
    label: face.label ?? null,
    // Ignored because the whole picture is, not because somebody said so.
    viaPhoto: Boolean(photoOf(state.at.photoId)?.skipped),
  });

  function decide(choice) {
    const face = current();
    if (!face) return;
    state.undo.push({
      kind: 'face',
      photoId: state.at.photoId,
      faceId: face.id,
      before: snapshot(face),
      at: { ...state.at },
    });
    Object.assign(face, guess(choice, state.people));
    if (choice.type === 'person')
      state.recent = [
        choice.person,
        ...state.recent.filter((id) => id !== choice.person),
      ].slice(0, 12);
    state.decided += 1;
    post(`/faces/${face.id}`, bodyFor(choice), state.at.photoId);
    advance();
  }

  /** On to the next face nobody has placed; nowhere left means done. */
  function advance() {
    const target =
      nextOpen(state.photos, state.order, state.at) ??
      nextOpen(state.photos, state.order, state.at, { wrap: true });
    if (target) state.at = target;
    else if (state.mode === 'queue') state.done = true;
    render();
  }

  /** None of this picture's faces matter (or, pressed again, they do). */
  function togglePhoto() {
    const photo = here();
    if (photo.skipped) {
      photo.skipped = false;
      post(`/photos/${photo.id}`, { skip: false }, photo.id);
      note('Bildens ansikten räknas igen.');
      render();
      return;
    }
    state.undo.push({
      kind: 'photo',
      photoId: photo.id,
      snapshot: structuredClone(photo),
      at: { ...state.at },
    });
    photo.skipped = true;
    for (const face of photo.faces)
      if (face.state === 'open' || (face.state === 'person' && face.auto))
        Object.assign(face, { state: 'ignored', person: null, auto: false });
    state.decided += 1;
    post(`/photos/${photo.id}`, { skip: true }, photo.id);
    note('Inga ansikten i bilden spelar roll. Z ångrar.');
    advance();
  }

  function undo() {
    const entry = state.undo.pop();
    if (!entry) {
      note('Det finns inget att ångra.');
      return;
    }
    state.done = false;
    if (entry.kind === 'photo') {
      state.photos.set(entry.photoId, entry.snapshot);
      post(
        `/photos/${entry.photoId}`,
        { skip: entry.snapshot.skipped },
        entry.photoId,
      );
    } else {
      const face = faceIn(entry.photoId, entry.faceId);
      if (face) {
        Object.assign(face, entry.before);
        const body =
          entry.kind === 'box'
            ? { box: entry.before.moved ? boxBody(entry.before) : null }
            : undoBody(entry.before);
        post(`/faces/${entry.faceId}`, body, entry.photoId);
      }
    }
    state.at = entry.at;
    note('Ångrat.');
    render();
  }

  function resetBox() {
    const face = current();
    if (!face?.moved) return;
    state.undo.push({
      kind: 'box',
      photoId: state.at.photoId,
      faceId: face.id,
      before: {
        ...snapshot(face),
        x: face.x,
        y: face.y,
        w: face.w,
        h: face.h,
        moved: true,
      },
      at: { ...state.at },
    });
    post(`/faces/${face.id}`, { box: null }, state.at.photoId);
    note('Rutan sitter där detektorn la den igen.');
  }

  // ── Talking to Lugn ──

  /**
   * One request at a time, in order. A picture takes its answer from the last
   * request made in it: an earlier answer would undo what was chosen since.
   */
  function post(path, body, photoId) {
    const mine = state;
    mine.pending.set(photoId, (mine.pending.get(photoId) ?? 0) + 1);
    const settle = () =>
      mine.pending.set(photoId, (mine.pending.get(photoId) ?? 1) - 1);
    mine.chain = mine.chain.then(async () => {
      let reply = null;
      try {
        reply = await call(path, body);
      } catch {
        settle();
        if (state !== mine) return;
        note('Ändringen gick inte att spara. Bilden läses om.', 'warn');
        try {
          apply(await call(`/photos/${photoId}.json`), true);
        } catch {
          /* the note above says it */
        }
        return;
      }
      settle();
      onChange(reply);
      if (state === mine && reply.review)
        apply(reply.review, mine.pending.get(photoId) === 0);
    });
  }

  /** The picture is only taken over when nothing newer is on its way for it. */
  function apply(review, picture) {
    if (picture) state.photos.set(review.photo.id, review.photo);
    state.people = review.people;
    keepSlots();
    if (state.drag) state.stale = true;
    else render();
  }

  // ── The name finder ──

  function openFinder() {
    state.finder = true;
    state.pick = 0;
    el('photo-review-finder').hidden = false;
    const search = el('photo-review-search');
    search.value = '';
    renderMatches();
    search.focus();
  }

  function closeFinder() {
    if (!state?.finder) return;
    state.finder = false;
    el('photo-review-finder').hidden = true;
    dialog().focus();
  }

  function renderMatches() {
    const found = findPeople(
      orderPeople(state.people, state.recent),
      el('photo-review-search').value,
    );
    const choices = found.matches
      .slice(0, 8)
      .map((person) => ({ type: 'person', person: person.id, shown: person }));
    if (found.create)
      choices.push({ type: 'named', name: found.create, shown: null });
    state.choices = choices;
    state.pick = Math.min(state.pick, Math.max(0, choices.length - 1));
    const list = el('photo-review-matches');
    list.replaceChildren(
      ...choices.map((choice, index) => {
        const item = node('li', 'pr-match');
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', String(index === state.pick));
        if (choice.shown) {
          if (choice.shown.sample) {
            const image = new Image();
            image.alt = '';
            image.src = `${API}/faces/${choice.shown.sample}.jpg`;
            item.append(image);
          }
          item.append(node('span', '', personName(choice.shown)));
        } else item.append(node('span', '', `Ny person: ${choice.name}`));
        item.addEventListener('pointerdown', (event) => {
          event.preventDefault();
          chooseMatch(choice);
        });
        return item;
      }),
    );
    if (choices.length === 0)
      list.replaceChildren(node('li', 'pr-match', 'Skriv ett namn.'));
  }

  function chooseMatch(choice) {
    closeFinder();
    decide(
      choice.type === 'person'
        ? { type: 'person', person: choice.person }
        : choice,
    );
  }

  function onFinderKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeFinder();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const n = state.choices.length;
      if (n > 0)
        state.pick = (state.pick + (event.key === 'ArrowDown' ? 1 : n - 1)) % n;
      renderMatches();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const choice = state.choices[state.pick];
      if (choice) chooseMatch(choice);
    }
    event.stopPropagation();
  }

  // ── Dragging a box ──

  function onPointerDown(event) {
    if (!state || event.button !== 0) return;
    const boxElement = event.target.closest('.pr-box');
    if (!boxElement) return;
    const face = faceIn(state.at.photoId, boxElement.dataset.id);
    if (!face) return;
    event.preventDefault();
    if (state.finder) closeFinder();
    if (state.at.faceId !== face.id) {
      state.at = { photoId: state.at.photoId, faceId: face.id };
      state.done = false;
      markSelected();
      renderSide();
    }
    const origin = { x: face.x, y: face.y, w: face.w, h: face.h };
    state.drag = {
      id: face.id,
      corner: event.target.closest('.pr-handle')?.dataset.corner ?? null,
      x0: event.clientX,
      y0: event.clientY,
      rect: el('photo-review-boxes').getBoundingClientRect(),
      origin,
      box: origin,
      moved: false,
      element: boxElement,
    };
    boxElement.setPointerCapture?.(event.pointerId);
    dialog().focus();
  }

  function onPointerMove(event) {
    const drag = state?.drag;
    if (!drag || drag.rect.width === 0 || drag.rect.height === 0) return;
    const dx = event.clientX - drag.x0;
    const dy = event.clientY - drag.y0;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_PX) return;
    drag.moved = true;
    const fx = dx / drag.rect.width;
    const fy = dy / drag.rect.height;
    drag.box = drag.corner
      ? resizeBox(drag.origin, drag.corner, fx, fy)
      : moveBox(drag.origin, fx, fy);
    place(drag.element, drag.box);
  }

  function onPointerUp() {
    const drag = state?.drag;
    if (!drag) return;
    state.drag = null;
    if (drag.moved && !sameBox(drag.origin, drag.box)) commitBox(drag);
    else if (state.stale) render();
    state.stale = false;
  }

  function commitBox(drag) {
    const face = faceIn(state.at.photoId, drag.id);
    if (!face) return;
    state.undo.push({
      kind: 'box',
      photoId: state.at.photoId,
      faceId: face.id,
      before: { ...snapshot(face), ...drag.origin, moved: face.moved },
      at: { ...state.at },
    });
    Object.assign(face, drag.box, { moved: true });
    // The photo brain's idea of who it is described the old place.
    if (face.state === 'person' && face.auto)
      Object.assign(face, { state: 'open', person: null, auto: false });
    post(`/faces/${face.id}`, { box: boxBody(drag.box) }, state.at.photoId);
    note(
      face.state === 'open'
        ? 'Rutan är flyttad. Välj vem det är.'
        : 'Rutan är flyttad.',
    );
    render();
  }

  // ── Drawing ──

  function note(message, tone = '') {
    const target = el('photo-review-note');
    target.textContent = message;
    target.dataset.tone = tone;
    window.clearTimeout(noteTimer);
    if (message)
      noteTimer = window.setTimeout(() => {
        target.textContent = '';
      }, 4500);
  }

  function render() {
    if (!state) return;
    renderStage();
    renderSide();
    preload();
  }

  function fit() {
    const image = el('photo-review-photo');
    const stage = el('photo-review-stage');
    const holder = el('photo-review-boxes');
    if (!image.naturalWidth || !image.naturalHeight) return;
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    const ratio = image.naturalWidth / image.naturalHeight;
    let width = sw;
    let height = sw / ratio;
    if (height > sh) {
      height = sh;
      width = sh * ratio;
    }
    Object.assign(holder.style, {
      width: `${width}px`,
      height: `${height}px`,
      left: `${(sw - width) / 2}px`,
      top: `${(sh - height) / 2}px`,
    });
  }

  function place(element, box) {
    element.style.left = percent(box.x);
    element.style.top = percent(box.y);
    element.style.width = percent(box.w);
    element.style.height = percent(box.h);
    element.dataset.low = box.y + box.h > 0.86 ? '1' : '';
  }

  function boxNode(face) {
    const box = node('div', 'pr-box');
    box.dataset.id = face.id;
    box.dataset.state = face.state;
    if (face.moved) box.dataset.moved = '1';
    place(box, face);
    const label = nameOfFace(face);
    const tag = node(
      'span',
      'pr-tag',
      face.state === 'ignored'
        ? 'Spelar ingen roll'
        : (label ?? 'Ingen person'),
    );
    box.append(tag);
    return box;
  }

  function markSelected() {
    for (const box of el('photo-review-boxes').children) {
      const selected = box.dataset.id === state.at.faceId;
      box.toggleAttribute('data-selected', selected);
      for (const handle of box.querySelectorAll('.pr-handle')) handle.remove();
      if (selected)
        for (const corner of ['nw', 'ne', 'sw', 'se']) {
          const handle = node('i', 'pr-handle');
          handle.dataset.corner = corner;
          box.append(handle);
        }
    }
  }

  function renderStage() {
    const photo = here();
    const image = el('photo-review-photo');
    const source = `${API}/photos/${photo.id}.jpg`;
    // The boxes wait for their picture, so they never sit on the last one.
    if (image.getAttribute('src') !== source) {
      el('photo-review-boxes').style.visibility = 'hidden';
      image.src = source;
    }
    fit();
    const banner = el('photo-review-banner');
    banner.hidden = !photo.skipped;
    banner.textContent = photo.skipped
      ? 'Ansiktena i den här bilden spelar ingen roll. Tryck A för att ta med dem igen.'
      : '';
    el('photo-review-boxes').replaceChildren(...photo.faces.map(boxNode));
    markSelected();
  }

  function renderSide() {
    const photo = here();
    const face = current();
    const done = state.done;
    el('photo-review-done').hidden = !done;
    for (const id of [
      'photo-review-current',
      'photo-review-people',
      'photo-review-actions',
    ])
      el(id).hidden = done;
    if (done) {
      el('photo-review-progress').textContent = 'Alla bilder är genomgångna';
      el('photo-review-done-text').textContent =
        state.decided === 1
          ? 'Ett val sparades. Z ångrar det senaste.'
          : `${state.decided} val sparades. Z ångrar det senaste.`;
      el('photo-review-done-close').focus();
      return;
    }
    const index = photo.faces.findIndex((f) => f.id === face.id) + 1;
    el('photo-review-progress').textContent =
      state.mode === 'queue'
        ? `Bild ${state.order.indexOf(photo.id) + 1} av ${state.order.length} · ansikte ${index} av ${photo.faces.length}`
        : `Ansikte ${index} av ${photo.faces.length} i bilden`;

    const crop = el('photo-review-crop');
    const source = cropUrl(face);
    if (crop.getAttribute('src') !== source) crop.src = source;
    const who = nameOfFace(face);
    el('photo-review-who').textContent =
      face.state === 'ignored'
        ? 'Spelar ingen roll'
        : (who ?? 'Ingen person ännu');
    el('photo-review-state').textContent =
      face.state === 'ignored'
        ? photo.skipped
          ? 'Hela bilden är markerad som ointressant.'
          : 'Ansiktet används inte.'
        : face.state === 'person'
          ? face.auto
            ? 'Ett förslag. Välj personen för att bekräfta.'
            : 'Vald.'
          : 'Välj vem det är.';

    const people = numbered();
    const list = el('photo-review-people');
    list.replaceChildren(
      ...people.slice(0, NUMBERED).map((person, i) => {
        const button = node('button', 'pr-person');
        button.type = 'button';
        button.setAttribute('aria-pressed', String(face.person === person.id));
        button.append(keycap(String(i + 1)));
        if (person.sample) {
          const image = new Image();
          image.alt = '';
          image.src = `${API}/faces/${person.sample}.jpg`;
          button.append(image);
        }
        button.append(node('span', 'pr-name', personName(person)));
        button.addEventListener('click', () => {
          decide({ type: 'person', person: person.id });
          dialog().focus();
        });
        return button;
      }),
    );
    if (people.length === 0)
      list.replaceChildren(
        node(
          'p',
          'pr-empty',
          'Inga personer än. Tryck N eller skriv ett namn.',
        ),
      );

    const actions = [
      ['Ange eller sök namn', '/', () => openFinder()],
      ['Ny person', 'N', () => decide({ type: 'new' })],
      ['Spelar ingen roll', 'X', () => decide({ type: 'ignore' })],
      [
        photo.skipped
          ? 'Ta med bildens ansikten igen'
          : 'Inga ansikten i bilden spelar roll',
        'A',
        () => togglePhoto(),
      ],
      ['Hoppa över', 'S', () => run({ type: 'skip' })],
      ['‹ Föregående ansikte', '←', () => run({ type: 'previous' })],
      ['Nästa ansikte ›', '→', () => run({ type: 'next' })],
      ['Ångra', 'Z', () => undo(), state.undo.length === 0],
    ];
    if (face.moved) actions.push(['Återställ rutan', 'R', () => resetBox()]);
    el('photo-review-actions').replaceChildren(
      ...actions.map(([label, key, act, disabled]) => {
        const button = node('button', 'pr-action');
        button.type = 'button';
        button.disabled = Boolean(disabled);
        button.setAttribute('aria-keyshortcuts', key);
        button.append(node('span', '', label), keycap(key));
        button.addEventListener('click', () => {
          act();
          if (!state?.finder) dialog().focus();
        });
        return button;
      }),
      node(
        'p',
        'pr-help',
        'Sitter rutan fel? Dra den med musen till ansiktet, och dra i hörnen för att ändra storlek.',
      ),
    );
  }

  /** The next picture is fetched while this one is looked at. */
  function preload() {
    if (state.mode !== 'queue') return;
    const next = state.order[state.order.indexOf(state.at.photoId) + 1];
    if (!next) return;
    const image = new Image();
    image.src = `${API}/photos/${next}.jpg`;
  }

  return { openQueue, openPhoto };
}
