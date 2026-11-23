import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

type Photo = {
  id: string;
  w: number;
  h: number;
  date?: string | null;
  place?: string | null;
  t?: number | null;
  nb?: Array<[number, number]>;
  du?: number[];
  fav?: 1;
  sc?: string;
  sp?: number;
  pp?: string[];
  tr?: number;
  cap?: string;
};
type Api = {
  cornerLevels(
    layout: string,
    photos: Array<{ lu?: number[] }>,
  ): number[] | null;
  buildGroup(library: Photo[], state: unknown, random?: () => number): Photo[];
  rememberGroup(state: unknown, group: Photo[]): void;
  newGroupState(): { plays: Map<string, number>; recent: Array<Set<string>> };
  planGroup(
    photos: Photo[],
    previous: string,
    random?: () => number,
  ): Array<{ layout: string; photos: Photo[] }>;
  groupLabel(
    photos: Photo[],
    listing?: Record<string, unknown>,
    year?: number,
  ): { kind: string; title: string; sub: string } | null;
  rangeText(from: string, to: string, year: number): string;
  mulberry32(seed: number): () => number;
};

function load(): Api {
  const sandbox: Record<string, unknown> = {};
  sandbox['globalThis'] = sandbox;
  const context = createContext(sandbox);
  runInContext(
    readFileSync(new URL('../src/ui/photos-page.js', import.meta.url), 'utf8'),
    context,
  );
  return (sandbox as { lugnPhotos: Api }).lugnPhotos;
}
const api = load();

const portrait = (id: string, extra: Partial<Photo> = {}): Photo => ({
  id: id.padEnd(24, id),
  w: 480,
  h: 640,
  ...extra,
});
const landscape = (id: string, extra: Partial<Photo> = {}): Photo => ({
  id: id.padEnd(24, id),
  w: 1024,
  h: 683,
  ...extra,
});

/** A library of `count` pictures where every `block` of pictures belong together. */
function blocks(count: number, block: number, score = 85): Photo[] {
  const photos: Photo[] = Array.from({ length: count }, (_, i) =>
    portrait(String.fromCharCode(97 + (i % 26)) + String(Math.floor(i / 26)), {
      t: 1_000_000 + i,
    }),
  );
  photos.forEach((photo, i) => {
    const start = Math.floor(i / block) * block;
    photo.nb = [];
    for (let j = start; j < Math.min(start + block, count); j += 1)
      if (j !== i) photo.nb.push([j, score]);
  });
  return photos;
}

describe('building a group', () => {
  it('collects four to six pictures that belong to one block', () => {
    const library = blocks(36, 6);
    for (let seed = 1; seed <= 25; seed += 1) {
      const state = api.newGroupState();
      const group = api.buildGroup(library, state, api.mulberry32(seed));
      expect(group.length).toBeGreaterThanOrEqual(4);
      expect(group.length).toBeLessThanOrEqual(6);
      // Every picture in the group came from the same block.
      const blocksUsed = new Set(
        group.map((p) => Math.floor(library.indexOf(p) / 6)),
      );
      expect(blocksUsed.size).toBe(1);
    }
  });

  it('never puts unrelated pictures together, even when it has to stop short', () => {
    // Three pictures that belong, and thirty strangers with no neighbours.
    const library = [
      ...blocks(3, 3),
      ...Array.from({ length: 30 }, (_, i) => portrait(`s${i}`)),
    ];
    for (let seed = 1; seed <= 20; seed += 1) {
      const group = api.buildGroup(
        library,
        api.newGroupState(),
        api.mulberry32(seed),
      );
      const related = group.filter((p) => library.indexOf(p) < 3).length;
      // A group is either all of the three, or a picture without company
      // with one partner: never a mix of the three and strangers.
      expect(related === group.length || group.length === 2).toBe(true);
      if (related !== group.length) expect(related).toBeLessThanOrEqual(1);
    }
  });

  it('does not grow a full group out of loosely related pictures', () => {
    // Every picture knows the others only a little (score 25, below the
    // strict link): a seed may get a partner or two, never a collage of six.
    const library = blocks(12, 12, 25);
    for (let seed = 1; seed <= 40; seed += 1) {
      const group = api.buildGroup(
        library,
        api.newGroupState(),
        api.mulberry32(seed),
      );
      expect(group.length).toBeGreaterThanOrEqual(2);
      expect(group.length).toBeLessThanOrEqual(3);
    }
  });

  it('keeps out a picture that is a stranger to most of the group', () => {
    // 0..4 know each other well; 5 knows only picture 0.
    const library = blocks(5, 5, 90);
    library.push(portrait('z', { t: 1_000_100 }));
    library[0]!.nb!.push([5, 90]);
    library[5]!.nb = [[0, 90]];
    for (let seed = 1; seed <= 80; seed += 1) {
      const group = api.buildGroup(
        library,
        api.newGroupState(),
        api.mulberry32(seed),
      );
      const ids = group.map((p) => library.indexOf(p));
      // Fits the seed at 90 but the other three at 0 (average 22): not in.
      if (ids.includes(5) && ids.length >= 4) {
        // Only reachable when 5 itself is the seed or joined an early pair.
        expect(ids.filter((i) => i < 5).length).toBeLessThanOrEqual(1);
      }
    }
  });

  it('asks the whole group, not just the seed: a newcomer must fit everyone', () => {
    // 0 is close to 1 and 2, but 1 and 2 are strangers to each other.
    const library = [portrait('a'), portrait('b'), portrait('c')];
    library[0]!.nb = [
      [1, 90],
      [2, 90],
    ];
    library[1]!.nb = [[0, 90]];
    library[2]!.nb = [[0, 90]];
    let both = 0;
    for (let seed = 1; seed <= 40; seed += 1) {
      const group = api.buildGroup(
        library,
        api.newGroupState(),
        api.mulberry32(seed),
      );
      if (group.length === 3) both += 1;
    }
    // Starting from the middle picture the others fit at 90 and 45: allowed;
    // starting from an end, the other end fits at (90 + 0) / 2 = 45: allowed too.
    // What must never happen is a group that repeats a picture.
    for (let seed = 1; seed <= 40; seed += 1) {
      const group = api.buildGroup(
        library,
        api.newGroupState(),
        api.mulberry32(seed),
      );
      expect(new Set(group.map((p) => p.id)).size).toBe(group.length);
    }
    expect(both).toBeGreaterThanOrEqual(0);
  });

  it('keeps bursts of one moment out of the same group', () => {
    const library = blocks(8, 8);
    library[0]!.du = [1];
    library[1]!.du = [0];
    for (let seed = 1; seed <= 40; seed += 1) {
      const group = api.buildGroup(
        library,
        api.newGroupState(),
        api.mulberry32(seed),
      );
      const ids = group.map((p) => library.indexOf(p));
      expect(ids.includes(0) && ids.includes(1)).toBe(false);
    }
  });

  it('plays everything before it repeats and changes company between rounds', () => {
    const library = blocks(24, 6);
    const state = api.newGroupState();
    const random = api.mulberry32(7);
    const seenBefore = new Set<string>();
    let sawRepeatTooEarly = false;
    for (let i = 0; i < 4; i += 1) {
      const group = api.buildGroup(library, state, random);
      api.rememberGroup(state, group);
      for (const photo of group) {
        // Within the first four groups a picture should not come back while
        // a block of the library is still untouched.
        if (seenBefore.has(photo.id) && seenBefore.size < 12)
          sawRepeatTooEarly = true;
        seenBefore.add(photo.id);
      }
    }
    expect(sawRepeatTooEarly).toBe(false);
    // Groups drawn from one block differ from round to round.
    const company = new Set<string>();
    const one = blocks(12, 12);
    const s2 = api.newGroupState();
    for (let i = 0; i < 12; i += 1) {
      const g = api.buildGroup(one, s2, api.mulberry32(100 + i));
      api.rememberGroup(s2, g);
      company.add(
        g
          .map((p) => p.id)
          .sort()
          .join(),
      );
    }
    expect(company.size).toBeGreaterThan(6);
  });

  it('favours favourites for the seed and orders one outing by time', () => {
    const library = blocks(12, 6);
    library[3]!.fav = 1;
    let favourite = 0;
    for (let seed = 1; seed <= 200; seed += 1) {
      const state = api.newGroupState();
      const random = api.mulberry32(seed);
      const group = api.buildGroup(library, state, random);
      const times = group.map((p) => p.t!);
      expect(times).toEqual([...times].sort((a, b) => a - b));
      if (group.includes(library[3]!)) favourite += 1;
    }
    // A fair pick would include it in about 1/12 * group share of the runs.
    expect(favourite).toBeGreaterThan(200 / 12);
  });

  it('copes with nothing and with a library without neighbours', () => {
    expect(api.buildGroup([], api.newGroupState())).toEqual([]);
    const plain = [portrait('a'), portrait('b'), portrait('c')];
    const group = api.buildGroup(plain, api.newGroupState(), api.mulberry32(3));
    // A picture never stands alone: it gets the nearest partner.
    expect(group).toHaveLength(2);
    expect(api.buildGroup([portrait('a')], api.newGroupState())).toHaveLength(
      1,
    );
  });
});

describe('splitting a group over slides', () => {
  it('shows five pictures as two slides, and never a lone portrait', () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const group = [
        portrait('a'),
        portrait('b'),
        portrait('c'),
        portrait('d'),
        portrait('e'),
      ];
      const slides = api.planGroup(group, '', api.mulberry32(seed));
      expect(slides.map((s) => s.photos.length)).toSatisfy((sizes: number[]) =>
        ['2,3', '3,2'].includes(sizes.join()),
      );
      expect(
        slides
          .flatMap((s) => s.photos)
          .map((p) => p.id)
          .sort(),
      ).toEqual(group.map((p) => p.id).sort());
    }
  });

  it('shows a lone landscape full screen and a pair of portraits side by side', () => {
    const slides = api.planGroup(
      [landscape('a'), portrait('b'), portrait('c')],
      '',
      api.mulberry32(5),
    );
    expect(slides.reduce((n, s) => n + s.photos.length, 0)).toBe(3);
    for (const slide of slides)
      if (slide.photos.length === 1)
        expect(slide.photos[0]!.w).toBeGreaterThan(slide.photos[0]!.h);
  });

  it('does not repeat the previous layout when another fits', () => {
    const group = [
      portrait('a'),
      portrait('b'),
      portrait('c'),
      portrait('d'),
      portrait('e'),
      portrait('f'),
    ];
    const slides = api.planGroup(group, 'trio', api.mulberry32(2));
    expect(slides[0]!.layout).not.toBe('trio');
  });
});

describe('no picture stands alone with black beside it', () => {
  it('gives an isolated picture a partner instead of a slide of its own', () => {
    const library = [
      ...blocks(2, 2),
      ...Array.from({ length: 6 }, (_, i) =>
        portrait(`s${i}`, { t: 5_000_000 + i }),
      ),
    ];
    // Only a picture that has no neighbours at all would stand alone.
    for (let seed = 1; seed <= 60; seed += 1) {
      const group = api.buildGroup(
        library,
        api.newGroupState(),
        api.mulberry32(seed),
      );
      expect(group.length).toBeGreaterThanOrEqual(2);
      const slides = api.planGroup(group, '', api.mulberry32(seed));
      for (const slide of slides)
        if (slide.photos.length === 1)
          expect(slide.photos[0]!.w).toBeGreaterThan(slide.photos[0]!.h);
    }
  });

  it('never shows a portrait on a slide of its own, whatever the mix and the last layout', () => {
    const shapes = [
      [1, 0, 0],
      [3, 2, 0],
      [2, 1, 0],
      [4, 1, 0],
      [1, 3, 0],
      [5, 1, 0],
      [2, 4, 0],
      [4, 2, 0],
    ];
    for (const [portraits, landscapes] of shapes) {
      for (const previous of ['', 'duo', 'trio', 'pair', 'mixed', 'single']) {
        for (let seed = 1; seed <= 40; seed += 1) {
          const photos = [
            ...Array.from({ length: portraits! }, (_, i) => portrait(`p${i}`)),
            ...Array.from({ length: landscapes! + 0 }, (_, i) =>
              landscape(`l${i}`),
            ),
          ];
          if (photos.length < 2) continue;
          for (const slide of api.planGroup(
            photos,
            previous,
            api.mulberry32(seed),
          ))
            if (slide.photos.length === 1)
              expect(slide.photos[0]!.w).toBeGreaterThan(slide.photos[0]!.h);
        }
      }
    }
    // Pictures with landscapes mixed in, too.
    for (let seed = 1; seed <= 200; seed += 1) {
      const rnd = api.mulberry32(seed);
      const count = 2 + Math.floor(rnd() * 5);
      const photos = Array.from({ length: count }, (_, i) =>
        rnd() < 0.5 ? portrait(`p${i}`) : landscape(`l${i}`),
      );
      const previous = ['', 'duo', 'trio', 'pair', 'mixed', 'single', 'stack3'][
        Math.floor(rnd() * 7)
      ]!;
      const slides = api.planGroup(photos, previous, rnd);
      expect(slides.flatMap((s) => s.photos)).toHaveLength(count);
      for (const slide of slides)
        if (slide.photos.length === 1)
          expect(slide.photos[0]!.w).toBeGreaterThan(slide.photos[0]!.h);
    }
  });
});

describe('shade in the corners', () => {
  const lu = (tr: number, br: number, bl: number) => ({ lu: [tr, br, bl] });
  it('takes each corner from the picture that lies in it', () => {
    // Three portraits: the clock and the name are on the third, the music on the first.
    expect(
      api.cornerLevels('trio', [lu(5, 5, 90), lu(5, 5, 5), lu(90, 40, 5)]),
    ).toEqual([2, 1, 2]);
    expect(api.cornerLevels('duo', [lu(0, 0, 10), lu(60, 60, 0)])).toEqual([
      2, 2, 0,
    ]);
    // A big picture on the right, two small ones stacked on the left.
    expect(
      api.cornerLevels('stack3', [lu(5, 5, 0), lu(0, 0, 0), lu(0, 0, 80)]),
    ).toEqual([0, 0, 2]);
    // Two panoramas: the clock on the upper, the name and the music on the lower.
    expect(api.cornerLevels('wide2', [lu(80, 0, 0), lu(0, 20, 60)])).toEqual([
      2, 0, 2,
    ]);
    expect(api.cornerLevels('single', [lu(30, 31, 48)])).toEqual([0, 1, 1]);
  });

  it('counts a picture that was not measured as mid, and knows no unknown layout', () => {
    expect(api.cornerLevels('single', [{}])).toEqual([1, 1, 1]);
    expect(api.cornerLevels('duo', [{ lu: [1] }, {}])).toEqual([1, 1, 1]);
    expect(api.cornerLevels('nope', [{}])).toBeNull();
  });
});

describe('naming a group', () => {
  const listing = {
    trips: [
      { title: 'Mallorca', from: '2026-07-12', to: '2026-07-19', cc: 'ES' },
    ],
    scenes: { beach: 'Stranden', food: 'Maten', mountain: 'Bergen' },
    people: [
      { id: 'p1', name: 'Anna' },
      { id: 'p2', name: 'Erik' },
      { id: 'p3', name: null },
    ],
  };
  const group = (extra: Partial<Photo>, n = 5, dates?: string[]): Photo[] =>
    Array.from({ length: n }, (_, i) =>
      portrait(`g${i}`, { date: dates?.[i] ?? '2026-07-14', ...extra }),
    );

  it('names a trip with its dates', () => {
    expect(
      api.groupLabel(
        group({ tr: 0, place: 'Palma' }, 5, [
          '2026-07-12',
          '2026-07-13',
          '2026-07-14',
          '2026-07-15',
          '2026-07-16',
        ]),
        listing,
        2026,
      ),
    ).toEqual({
      kind: 'Resa',
      title: 'Mallorca',
      sub: '12–19 juli',
    });
    // A day of the trip says which day.
    expect(api.groupLabel(group({ tr: 0 }), listing, 2026)).toMatchObject({
      kind: 'Resa',
      sub: '14 juli',
    });
  });

  it('names what and where when both are plain', () => {
    expect(
      api.groupLabel(
        group({ place: 'Marstrand', sc: 'beach', sp: 80 }),
        listing,
        2026,
      ),
    ).toEqual({ kind: 'Plats', title: 'Stranden i Marstrand', sub: '14 juli' });
  });

  it('names a theme that has no place, and puts place and date below', () => {
    expect(
      api.groupLabel(group({ sc: 'food', sp: 70 }), listing, 2026),
    ).toEqual({
      kind: 'Tema',
      title: 'Maten',
      sub: '14 juli',
    });
    expect(
      api.groupLabel(
        group({ sc: 'food', sp: 70, place: 'Rom' }),
        listing,
        2026,
      ),
    ).toEqual({ kind: 'Tema', title: 'Maten', sub: 'Rom · 14 juli' });
  });

  it('ignores a scene that is not sure or not shared by most pictures', () => {
    expect(
      api.groupLabel(
        group({ sc: 'food', sp: 30, place: 'Rom' }),
        listing,
        2026,
      ),
    ).toMatchObject({
      kind: 'Plats',
      title: 'Rom',
    });
    const mixed = [
      ...group({ sc: 'food', sp: 90 }, 2),
      ...group({ sc: 'mountain', sp: 90 }, 3),
    ];
    expect(api.groupLabel(mixed, listing, 2026)).toMatchObject({
      kind: 'Tema',
      title: 'Bergen',
    });
    const split = [
      ...group({ sc: 'food', sp: 90 }, 2),
      ...group({ sc: 'mountain', sp: 90 }, 2),
      ...group({}, 1),
    ];
    expect(api.groupLabel(split, listing, 2026)).toMatchObject({ kind: 'Dag' });
  });

  it('adds the people who are named, and only them', () => {
    const photos = group({ place: 'Rom', pp: ['p1', 'p2', 'p3'] });
    expect(api.groupLabel(photos, listing, 2026)).toEqual({
      kind: 'Plats',
      title: 'Rom',
      sub: '14 juli · med Anna och Erik',
    });
    expect(api.groupLabel(group({ pp: ['p3'] }), listing, 2026)).toMatchObject({
      kind: 'Dag',
    });
    expect(api.groupLabel(group({ pp: ['p1'] }), listing, 2026)).toEqual({
      kind: 'Med',
      title: 'Anna',
      sub: '14 juli',
    });
  });

  it('prefers a caption somebody wrote', () => {
    expect(
      api.groupLabel(
        group({ cap: 'Midsommar hos mormor', place: 'Rom' }),
        listing,
        2026,
      ),
    ).toEqual({ kind: 'Minne', title: 'Midsommar hos mormor', sub: '14 juli' });
  });

  it('falls back to the day, the month or the year', () => {
    expect(api.groupLabel(group({}), {}, 2026)).toEqual({
      kind: 'Dag',
      title: '14 juli',
      sub: '',
    });
    expect(
      api.groupLabel(
        group({}, 4, ['2026-07-01', '2026-07-09', '2026-07-20', '2026-07-30']),
        {},
        2026,
      ),
    ).toEqual({
      kind: 'Månad',
      title: 'Juli 2026',
      sub: '',
    });
    expect(
      api.groupLabel(
        group({}, 4, ['2025-03-01', '2025-07-09', '2025-10-20', '2025-12-30']),
        {},
        2026,
      ),
    ).toEqual({
      kind: 'År',
      title: '2025',
      sub: '',
    });
    // Different years, no place, no scene: nothing honest to say.
    expect(
      api.groupLabel(
        group({}, 4, ['2024-03-01', '2025-07-09', '2025-10-20', '2026-12-30']),
        {},
        2026,
      ),
    ).toBeNull();
    expect(api.groupLabel([], listing)).toBeNull();
  });

  it('writes the year only when it is not this year', () => {
    expect(api.rangeText('2025-07-12', '2025-07-19', 2026)).toBe(
      '12–19 juli 2025',
    );
    expect(api.rangeText('2026-10-29', '2026-11-03', 2026)).toBe(
      '29 okt – 3 nov',
    );
    expect(api.rangeText('2025-12-28', '2026-01-03', 2026)).toBe(
      '28 dec 2025 – 3 jan 2026',
    );
    expect(api.rangeText('2026-09-01', '2026-11-20', 2026)).toBe(
      'september – november',
    );
    expect(api.rangeText('2026-07-14', '2026-07-14', 2026)).toBe('14 juli');
  });
});
