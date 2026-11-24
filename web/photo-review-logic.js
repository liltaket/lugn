// Foton: the thinking behind "Granska ansikten", kept apart from the page so it
// can be tested with plain objects. Nothing here touches the document or the
// network: which key does what, which face comes next, where a box goes when
// it is dragged, who a typed name matches, and how to undo a decision.

/** A box this small (a fraction of the picture) is no longer a face. */
export const MIN_SIDE = 0.015;

const clamp = (value, low, high) => Math.min(Math.max(value, low), high);

// ── Keys ──

/**
 * What a key press means in the review, or null when it means nothing there
 * (and the browser keeps it). `event` is a KeyboardEvent or anything shaped
 * like one. While the name finder is open the finder's own field takes keys.
 */
export function keyAction(event, { finderOpen = false } = {}) {
  if (finderOpen) return null;
  const key = event.key;
  if (event.ctrlKey || event.metaKey) {
    return key.toLowerCase() === 'z' && !event.altKey ? { type: 'undo' } : null;
  }
  if (event.altKey) return null;
  if (/^[1-9]$/.test(key)) return { type: 'person', index: Number(key) - 1 };
  switch (key.toLowerCase()) {
    case 'n':
      return { type: 'new' };
    case 'x':
    case 'delete':
      return { type: 'ignore' };
    case 'a':
      return { type: 'ignorePhoto' };
    case 's':
    case ' ':
      return { type: 'skip' };
    case 'arrowright':
      return { type: 'next' };
    case 'arrowleft':
      return { type: 'previous' };
    case 'arrowdown':
      return { type: 'nextPhoto' };
    case 'arrowup':
      return { type: 'previousPhoto' };
    case 'z':
    case 'backspace':
      return { type: 'undo' };
    case 'r':
      return { type: 'resetBox' };
    case '/':
    case 'f':
    case 'enter':
      return { type: 'find' };
    case 'escape':
      return { type: 'close' };
    default:
      return null;
  }
}

// ── People ──

const plain = (text) =>
  String(text ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('sv')
    .replace(/\s+/g, ' ')
    .trim();

export const personName = (person) =>
  person.name ?? `Okänd person ${String(person.id).slice(1)}`;

/**
 * The people in the order the number keys pick them: whoever was chosen last
 * comes first, then the named, then those with the most faces.
 */
export function orderPeople(people, recent = []) {
  const rank = new Map(recent.map((id, index) => [id, index]));
  return [...people].sort((a, b) => {
    const ra = rank.has(a.id) ? rank.get(a.id) : Infinity;
    const rb = rank.has(b.id) ? rank.get(b.id) : Infinity;
    if (ra !== rb) return ra < rb ? -1 : 1;
    return (
      Number(b.name !== null) - Number(a.name !== null) ||
      b.faces - a.faces ||
      Number(String(a.id).slice(1)) - Number(String(b.id).slice(1))
    );
  });
}

/**
 * Who a typed text means. `matches` are the people whose name starts with it
 * first, then those that contain it; `create` is the name to make a new
 * person with when nobody is called exactly that.
 */
export function findPeople(people, query) {
  const wanted = plain(query);
  if (wanted === '') return { matches: [...people], create: null };
  const starts = [];
  const inside = [];
  let exact = false;
  for (const person of people) {
    const name = plain(personName(person));
    if (name === wanted) exact = true;
    if (name.startsWith(wanted)) starts.push(person);
    else if (name.includes(wanted)) inside.push(person);
  }
  const typed = String(query).replace(/\s+/g, ' ').trim();
  return { matches: [...starts, ...inside], create: exact ? null : typed };
}

// ── Where to go ──

const facesOf = (photos, photoId) => photos.get(photoId)?.faces ?? [];

/** The next face nobody has placed, from just after `at`; null when none is left. */
export function nextOpen(photos, order, at, { wrap = false } = {}) {
  const start = Math.max(0, order.indexOf(at.photoId));
  const here = facesOf(photos, at.photoId);
  const index = here.findIndex((f) => f.id === at.faceId);
  for (let i = index + 1; i < here.length; i += 1)
    if (here[i].state === 'open')
      return { photoId: at.photoId, faceId: here[i].id };
  for (let p = start + 1; p < order.length; p += 1) {
    const open = facesOf(photos, order[p]).find((f) => f.state === 'open');
    if (open) return { photoId: order[p], faceId: open.id };
  }
  if (!wrap) return null;
  for (let p = 0; p <= start; p += 1) {
    const open = facesOf(photos, order[p]).find(
      (f) =>
        f.state === 'open' && !(order[p] === at.photoId && f.id === at.faceId),
    );
    if (open) return { photoId: order[p], faceId: open.id };
  }
  return null;
}

/** One face to the left or right, crossing into the next picture at the end. */
export function stepFace(photos, order, at, direction) {
  const here = facesOf(photos, at.photoId);
  const index = here.findIndex((f) => f.id === at.faceId) + direction;
  if (index >= 0 && index < here.length)
    return { photoId: at.photoId, faceId: here[index].id };
  const photo = order.indexOf(at.photoId) + direction;
  if (photo < 0 || photo >= order.length) return null;
  const faces = facesOf(photos, order[photo]);
  if (faces.length === 0) return null;
  const face = direction > 0 ? faces[0] : faces[faces.length - 1];
  return { photoId: order[photo], faceId: face.id };
}

/** The next or previous picture, on the first face nobody has placed. */
export function stepPhoto(photos, order, at, direction) {
  const photo = order.indexOf(at.photoId) + direction;
  if (photo < 0 || photo >= order.length) return null;
  const faces = facesOf(photos, order[photo]);
  const face = faces.find((f) => f.state === 'open') ?? faces[0];
  return face ? { photoId: order[photo], faceId: face.id } : null;
}

// ── Boxes ──

/** A box (fractions of the picture) moved by a fraction, kept inside it. */
export function moveBox(box, dx, dy) {
  return {
    x: clamp(box.x + dx, 0, 1 - box.w),
    y: clamp(box.y + dy, 0, 1 - box.h),
    w: box.w,
    h: box.h,
  };
}

/** A box with one corner (`nw`, `ne`, `sw`, `se`) dragged by a fraction. */
export function resizeBox(box, corner, dx, dy) {
  let left = box.x;
  let top = box.y;
  let right = box.x + box.w;
  let bottom = box.y + box.h;
  if (corner.includes('w')) left = clamp(left + dx, 0, right - MIN_SIDE);
  else right = clamp(right + dx, left + MIN_SIDE, 1);
  if (corner.includes('n')) top = clamp(top + dy, 0, bottom - MIN_SIDE);
  else bottom = clamp(bottom + dy, top + MIN_SIDE, 1);
  return { x: left, y: top, w: right - left, h: bottom - top };
}

const round4 = (value) => Math.round(value * 10000) / 10000;
export const boxBody = (box) => [box.x, box.y, box.w, box.h].map(round4);
export const sameBox = (a, b) =>
  Math.abs(a.x - b.x) < 0.0005 &&
  Math.abs(a.y - b.y) < 0.0005 &&
  Math.abs(a.w - b.w) < 0.0005 &&
  Math.abs(a.h - b.h) < 0.0005;

// ── Deciding, and taking it back ──

/** What the server is asked to do for a choice. */
export function bodyFor(choice) {
  switch (choice.type) {
    case 'person':
      return { person: choice.person };
    case 'named':
      return { named: choice.name };
    case 'new':
      return { new: true };
    case 'ignore':
      return { none: true };
    default:
      return { open: true };
  }
}

/** What a face looks like at once, before the server has answered. */
export function guess(choice, people = []) {
  switch (choice.type) {
    case 'person':
      return { state: 'person', person: choice.person, auto: false };
    case 'named': {
      const found = findPeople(people, choice.name);
      const same = found.create === null ? found.matches[0] : null;
      return {
        state: 'person',
        person: same?.id ?? null,
        auto: false,
        label: same ? null : choice.name,
      };
    }
    case 'new':
      return { state: 'person', person: null, auto: false, label: 'Ny person' };
    case 'ignore':
      return { state: 'ignored', person: null, auto: false };
    default:
      return { state: 'open', person: null, auto: false, label: null };
  }
}

/**
 * The request that puts a face back as it was. A person the photo brain only
 * proposed is not a decision, so it goes back to nobody having looked.
 */
export function undoBody(before) {
  if (before.state === 'ignored' && !before.viaPhoto) return { none: true };
  // A person who is not known yet (a guess before the answer) has no id to go back to.
  if (before.state === 'person' && !before.auto && before.person)
    return { person: before.person };
  return { open: true };
}
