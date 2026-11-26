import { describe, expect, it } from 'vitest';

type Face = {
  id: string;
  state: 'open' | 'person' | 'ignored';
  x?: number;
};
type Photo = { id: string; faces: Face[] };
type At = { photoId: string; faceId: string };
type Person = { id: string; name: string | null; faces: number };
type Box = { x: number; y: number; w: number; h: number };
type Key = {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
};
type Logic = {
  keyAction(event: Key, options?: { finderOpen?: boolean }): unknown;
  orderPeople(people: Person[], recent?: string[]): Person[];
  findPeople(
    people: Person[],
    query: string,
  ): { matches: Person[]; create: string | null };
  nextOpen(
    photos: Map<string, Photo>,
    order: string[],
    at: At,
    options?: { wrap?: boolean },
  ): At | null;
  stepFace(
    photos: Map<string, Photo>,
    order: string[],
    at: At,
    direction: 1 | -1,
  ): At | null;
  stepPhoto(
    photos: Map<string, Photo>,
    order: string[],
    at: At,
    direction: 1 | -1,
  ): At | null;
  moveBox(box: Box, dx: number, dy: number): Box;
  resizeBox(box: Box, corner: string, dx: number, dy: number): Box;
  boxBody(box: Box): number[];
  sameBox(a: Box, b: Box): boolean;
  bodyFor(choice: { type: string; person?: string; name?: string }): unknown;
  guess(
    choice: { type: string; person?: string; name?: string },
    people?: Person[],
  ): Record<string, unknown>;
  undoBody(before: {
    state: string;
    person: string | null;
    auto: boolean;
  }): unknown;
  personName(person: { id: string; name: string | null }): string;
  MIN_SIDE: number;
};
const logic = (await import(
  new URL('../web/photo-review-logic.js', import.meta.url).href
)) as Logic;

const key = (k: string, extra: Partial<Key> = {}): Key => ({
  key: k,
  ...extra,
});
const photo = (id: string, ...states: Face['state'][]): Photo => ({
  id,
  faces: states.map((state, i) => ({ id: `${id}.${i}`, state, x: i / 10 })),
});
const world = (...list: Photo[]) => ({
  photos: new Map(list.map((p) => [p.id, p])),
  order: list.map((p) => p.id),
});

describe('the keys of the review', () => {
  it('picks a person with the numbers and decides with letters', () => {
    expect(logic.keyAction(key('1'))).toEqual({ type: 'person', index: 0 });
    expect(logic.keyAction(key('9'))).toEqual({ type: 'person', index: 8 });
    expect(logic.keyAction(key('0'))).toBeNull();
    expect(logic.keyAction(key('n'))).toEqual({ type: 'new' });
    expect(logic.keyAction(key('N', {}))).toEqual({ type: 'new' });
    expect(logic.keyAction(key('x'))).toEqual({ type: 'ignore' });
    expect(logic.keyAction(key('Delete'))).toEqual({ type: 'ignore' });
    expect(logic.keyAction(key('a'))).toEqual({ type: 'ignorePhoto' });
    expect(logic.keyAction(key('r'))).toEqual({ type: 'resetBox' });
  });

  it('moves with space and the arrows, finds with / and takes back with z', () => {
    expect(logic.keyAction(key(' '))).toEqual({ type: 'skip' });
    expect(logic.keyAction(key('s'))).toEqual({ type: 'skip' });
    expect(logic.keyAction(key('ArrowRight'))).toEqual({ type: 'next' });
    expect(logic.keyAction(key('ArrowLeft'))).toEqual({ type: 'previous' });
    expect(logic.keyAction(key('ArrowDown'))).toEqual({ type: 'nextPhoto' });
    expect(logic.keyAction(key('ArrowUp'))).toEqual({ type: 'previousPhoto' });
    expect(logic.keyAction(key('/'))).toEqual({ type: 'find' });
    expect(logic.keyAction(key('Enter'))).toEqual({ type: 'find' });
    expect(logic.keyAction(key('z'))).toEqual({ type: 'undo' });
    expect(logic.keyAction(key('Backspace'))).toEqual({ type: 'undo' });
    expect(logic.keyAction(key('z', { ctrlKey: true }))).toEqual({
      type: 'undo',
    });
    expect(logic.keyAction(key('z', { metaKey: true }))).toEqual({
      type: 'undo',
    });
  });

  it('leaves the browser its own shortcuts and the finder its typing', () => {
    expect(logic.keyAction(key('r', { ctrlKey: true }))).toBeNull();
    expect(logic.keyAction(key('a', { metaKey: true }))).toBeNull();
    expect(logic.keyAction(key('ArrowLeft', { altKey: true }))).toBeNull();
    expect(logic.keyAction(key('q'))).toBeNull();
    expect(logic.keyAction(key('n'), { finderOpen: true })).toBeNull();
    expect(logic.keyAction(key('1'), { finderOpen: true })).toBeNull();
  });
});

describe('who a number or a name means', () => {
  const people: Person[] = [
    { id: 'p3', name: null, faces: 40 },
    { id: 'p2', name: 'Erik', faces: 5 },
    { id: 'p1', name: 'Åsa', faces: 9 },
    { id: 'p4', name: 'Anna', faces: 9 },
  ];

  it('puts the named first, then those with most faces, then the recent', () => {
    expect(logic.orderPeople(people).map((p) => p.id)).toEqual([
      'p1',
      'p4',
      'p2',
      'p3',
    ]);
    expect(logic.orderPeople(people, ['p3', 'p2']).map((p) => p.id)).toEqual([
      'p3',
      'p2',
      'p1',
      'p4',
    ]);
  });

  it('finds a name from its beginning, then from inside it, ignoring case and accents', () => {
    expect(logic.findPeople(people, 'ann').matches.map((p) => p.id)).toEqual([
      'p4',
    ]);
    expect(logic.findPeople(people, 'asa').matches.map((p) => p.id)).toEqual([
      'p1',
    ]);
    expect(logic.findPeople(people, 'ri').matches.map((p) => p.id)).toEqual([
      'p2',
    ]);
    expect(logic.findPeople(people, 'ERIK').create).toBeNull();
    expect(logic.findPeople(people, '  Ida  ')).toEqual({
      matches: [],
      create: 'Ida',
    });
    // An unnamed person is found by the name they are shown under.
    expect(
      logic.findPeople(people, 'okänd person 3').matches.map((p) => p.id),
    ).toEqual(['p3']);
    // Nothing typed lists everybody and offers nothing new.
    expect(logic.findPeople(people, '   ')).toEqual({
      matches: people,
      create: null,
    });
    expect(logic.personName({ id: 'p7', name: null })).toBe('Okänd person 7');
  });
});

describe('where the review goes next', () => {
  const { photos, order } = world(
    photo('a', 'person', 'open', 'open'),
    photo('b', 'person', 'ignored'),
    photo('c', 'open', 'person'),
  );

  it('goes to the next face nobody has placed, across pictures', () => {
    expect(
      logic.nextOpen(photos, order, { photoId: 'a', faceId: 'a.1' }),
    ).toEqual({ photoId: 'a', faceId: 'a.2' });
    expect(
      logic.nextOpen(photos, order, { photoId: 'a', faceId: 'a.2' }),
    ).toEqual({ photoId: 'c', faceId: 'c.0' });
    expect(
      logic.nextOpen(photos, order, { photoId: 'c', faceId: 'c.0' }),
    ).toBeNull();
  });

  it('can come back round to what was skipped, but never to the face it stands on', () => {
    expect(
      logic.nextOpen(
        photos,
        order,
        { photoId: 'c', faceId: 'c.0' },
        { wrap: true },
      ),
    ).toEqual({ photoId: 'a', faceId: 'a.1' });
    const alone = world(photo('a', 'open'));
    expect(
      logic.nextOpen(
        alone.photos,
        alone.order,
        { photoId: 'a', faceId: 'a.0' },
        { wrap: true },
      ),
    ).toBeNull();
  });

  it('steps a face at a time and crosses into the next picture at the edge', () => {
    expect(
      logic.stepFace(photos, order, { photoId: 'a', faceId: 'a.0' }, 1),
    ).toEqual({ photoId: 'a', faceId: 'a.1' });
    expect(
      logic.stepFace(photos, order, { photoId: 'a', faceId: 'a.2' }, 1),
    ).toEqual({ photoId: 'b', faceId: 'b.0' });
    expect(
      logic.stepFace(photos, order, { photoId: 'b', faceId: 'b.0' }, -1),
    ).toEqual({ photoId: 'a', faceId: 'a.2' });
    expect(
      logic.stepFace(photos, order, { photoId: 'a', faceId: 'a.0' }, -1),
    ).toBeNull();
    expect(
      logic.stepFace(photos, order, { photoId: 'c', faceId: 'c.1' }, 1),
    ).toBeNull();
  });

  it('steps a picture at a time, onto the first face nobody has placed', () => {
    expect(
      logic.stepPhoto(photos, order, { photoId: 'a', faceId: 'a.2' }, 1),
    ).toEqual({ photoId: 'b', faceId: 'b.0' });
    expect(
      logic.stepPhoto(photos, order, { photoId: 'b', faceId: 'b.0' }, 1),
    ).toEqual({ photoId: 'c', faceId: 'c.0' });
    expect(
      logic.stepPhoto(photos, order, { photoId: 'c', faceId: 'c.0' }, -1),
    ).toEqual({ photoId: 'b', faceId: 'b.0' });
    expect(
      logic.stepPhoto(photos, order, { photoId: 'c', faceId: 'c.0' }, 1),
    ).toBeNull();
  });
});

describe('dragging a box', () => {
  const box = { x: 0.4, y: 0.3, w: 0.2, h: 0.25 };

  it('moves it and keeps it inside the picture', () => {
    const moved = logic.moveBox(box, 0.1, -0.1);
    expect(moved.x).toBeCloseTo(0.5);
    expect(moved.y).toBeCloseTo(0.2);
    expect([moved.w, moved.h]).toEqual([0.2, 0.25]);
    const far = logic.moveBox(box, 5, 5);
    expect(far.x + far.w).toBeCloseTo(1);
    expect(far.y + far.h).toBeCloseTo(1);
    const back = logic.moveBox(box, -5, -5);
    expect([back.x, back.y]).toEqual([0, 0]);
  });

  it('pulls a corner and leaves the opposite one where it is', () => {
    const se = logic.resizeBox(box, 'se', 0.1, 0.05);
    expect(se.x).toBeCloseTo(0.4);
    expect(se.y).toBeCloseTo(0.3);
    expect(se.w).toBeCloseTo(0.3);
    expect(se.h).toBeCloseTo(0.3);
    const nw = logic.resizeBox(box, 'nw', -0.1, -0.1);
    expect(nw.x).toBeCloseTo(0.3);
    expect(nw.y).toBeCloseTo(0.2);
    expect(nw.x + nw.w).toBeCloseTo(0.6);
    expect(nw.y + nw.h).toBeCloseTo(0.55);
    const ne = logic.resizeBox(box, 'ne', 0.1, -0.1);
    expect(ne.x).toBeCloseTo(0.4);
    expect(ne.x + ne.w).toBeCloseTo(0.7);
    expect(ne.y).toBeCloseTo(0.2);
    const sw = logic.resizeBox(box, 'sw', -0.1, 0.1);
    expect(sw.x).toBeCloseTo(0.3);
    expect(sw.y + sw.h).toBeCloseTo(0.65);
  });

  it('never makes a box smaller than a face, nor lets it leave the picture', () => {
    const squashed = logic.resizeBox(box, 'se', -1, -1);
    expect(squashed.w).toBeCloseTo(logic.MIN_SIDE);
    expect(squashed.h).toBeCloseTo(logic.MIN_SIDE);
    expect(squashed.x).toBeCloseTo(0.4);
    const flipped = logic.resizeBox(box, 'nw', 1, 1);
    expect(flipped.x).toBeCloseTo(0.6 - logic.MIN_SIDE);
    expect(flipped.w).toBeCloseTo(logic.MIN_SIDE);
    const huge = logic.resizeBox(box, 'se', 5, 5);
    expect(huge.x + huge.w).toBeCloseTo(1);
    expect(huge.y + huge.h).toBeCloseTo(1);
    const left = logic.resizeBox(box, 'nw', -5, -5);
    expect([left.x, left.y]).toEqual([0, 0]);
  });

  it('sends four rounded numbers and knows a box that did not move', () => {
    expect(logic.boxBody({ x: 1 / 3, y: 0.1, w: 0.2, h: 0.123456 })).toEqual([
      0.3333, 0.1, 0.2, 0.1235,
    ]);
    expect(logic.sameBox(box, { ...box, x: 0.4003 })).toBe(true);
    expect(logic.sameBox(box, { ...box, x: 0.41 })).toBe(false);
  });
});

describe('deciding and taking it back', () => {
  it('asks the server for what was chosen', () => {
    expect(logic.bodyFor({ type: 'person', person: 'p2' })).toEqual({
      person: 'p2',
    });
    expect(logic.bodyFor({ type: 'named', name: 'Anna' })).toEqual({
      named: 'Anna',
    });
    expect(logic.bodyFor({ type: 'new' })).toEqual({ new: true });
    expect(logic.bodyFor({ type: 'ignore' })).toEqual({ none: true });
  });

  it('shows the choice at once, before the answer', () => {
    expect(logic.guess({ type: 'person', person: 'p2' })).toMatchObject({
      state: 'person',
      person: 'p2',
      auto: false,
    });
    expect(logic.guess({ type: 'ignore' })).toMatchObject({
      state: 'ignored',
      person: null,
    });
    const people = [{ id: 'p1', name: 'Anna', faces: 3 }];
    expect(logic.guess({ type: 'named', name: 'anna' }, people)).toMatchObject({
      state: 'person',
      person: 'p1',
    });
    expect(logic.guess({ type: 'named', name: 'Erik' }, people)).toMatchObject({
      state: 'person',
      person: null,
      label: 'Erik',
    });
    expect(logic.guess({ type: 'new' })).toMatchObject({ label: 'Ny person' });
  });

  it('puts a face back as it was; a mere proposal goes back to nobody having looked', () => {
    expect(
      logic.undoBody({ state: 'ignored', person: null, auto: false }),
    ).toEqual({ none: true });
    expect(
      logic.undoBody({ state: 'person', person: 'p2', auto: false }),
    ).toEqual({ person: 'p2' });
    expect(
      logic.undoBody({ state: 'person', person: 'p2', auto: true }),
    ).toEqual({ open: true });
    expect(
      logic.undoBody({ state: 'open', person: null, auto: false }),
    ).toEqual({ open: true });
    // Ignored because the whole picture is: back to what the picture says.
    expect(
      logic.undoBody({
        state: 'ignored',
        person: null,
        auto: false,
        viaPhoto: true,
      } as never),
    ).toEqual({ open: true });
    // A guess before the answer has no person to go back to.
    expect(
      logic.undoBody({ state: 'person', person: null, auto: false }),
    ).toEqual({ open: true });
  });
});
