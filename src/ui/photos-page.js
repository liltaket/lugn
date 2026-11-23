// Foto: the Hub as a picture frame (pages.js runs the pager).
//
// The server keeps a small local copy of one shared album and lists it at
// display-api/photos. This page shows the pictures in changing layouts, one to
// three at a time, with a quiet caption (place and date the picture was taken).
//
// Rules from the Hub's responsiveness notes: a slide is built off screen,
// every picture is decoded before it is shown, pictures are fetched one at a
// time, and the only thing that animates is the opacity of a whole slide. No
// root property changes per picture, no blur is computed on the Hub (the
// blurred backdrop is a small picture the server made, scaled up), and nothing
// changes while the pager is moving.
(() => {
  'use strict';

  const pagesApi = globalThis.lugnPages;
  const SHOW_MS = 20_000;
  const FADE_MS = 1400;
  const DECODE_WAIT_MS = 5000;
  const LIST_MS = 10 * 60_000;
  const LANDSCAPE_RATIO = 1.1;
  const PANORAMA_RATIO = 1.9;

  const base = () =>
    typeof BASE_PATH === 'string' ? BASE_PATH : location.pathname;

  // ── Planning (pure) ──

  const isLandscape = (photo) => photo.w / photo.h >= LANDSCAPE_RATIO;
  const isPanorama = (photo) => photo.w / photo.h >= PANORAMA_RATIO;

  // Layouts (what each needs from the queue is decided in plan):
  //   single  one landscape fills the screen (a portrait alone, over its own
  //           backdrop, only when nothing else is left to go with it)
  //   duo     two portraits side by side
  //   pair    a portrait and a landscape side by side
  //   trio    three portraits side by side
  //   mixed   one landscape and two portraits
  //   stack3  three landscapes: two small, one large
  //   wide2   two panoramas stacked

  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffled(items, random) {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  // ── Order of play ──
  //
  // Pictures taken close in time (and place) are played near each other, so a
  // slide often shows moments from the same outing, but the groups are not
  // fixed: the order of the groups is shuffled and some pictures wander.
  const CLUSTER_GAP_MS = 4 * 60 * 60 * 1000;
  const CLUSTER_KM = 30;

  function distanceKm(a, b) {
    if (a.lat == null || b.lat == null) return 0;
    const dy = (a.lat - b.lat) * 111.32;
    const dx = (a.lon - b.lon) * 111.32 * Math.cos((a.lat * Math.PI) / 180);
    return Math.hypot(dx, dy);
  }

  // Clusters by time: a gap of more than a few hours or a move of more than a
  // few tens of kilometres starts a new one. Pictures without a time are alone.
  function clusters(photos) {
    const timed = photos
      .filter((p) => typeof p.t === 'number')
      .sort((a, b) => a.t - b.t);
    const out = [];
    let group = [];
    for (const photo of timed) {
      const last = group[group.length - 1];
      if (
        last &&
        (photo.t - last.t > CLUSTER_GAP_MS ||
          distanceKm(last, photo) > CLUSTER_KM)
      ) {
        out.push(group);
        group = [];
      }
      group.push(photo);
    }
    if (group.length > 0) out.push(group);
    for (const photo of photos)
      if (typeof photo.t !== 'number') out.push([photo]);
    return out;
  }

  function orderQueue(photos, random = Math.random) {
    const order = shuffled(clusters(photos), random).flat();
    // About one in ten pictures moves up to a dozen places, so no group
    // stays together for good.
    for (let i = 0; i < order.length - 1; i += 1) {
      if (random() >= 0.1) continue;
      const j =
        i + 1 + Math.floor(random() * Math.min(12, order.length - i - 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    return order;
  }

  // Takes the first `count` queue entries matching `test`, looking only a few
  // pictures ahead so the order stays close to the shuffle.
  function take(queue, count, test, window = 10) {
    const found = [];
    for (let i = 0; i < queue.length && i < window; i += 1)
      if (test(queue[i])) found.push(i);
    return found.length >= count ? found.slice(0, count) : null;
  }

  /**
   * Chooses the next slide from the front of the queue. Returns
   * { layout, photos, rest } where `rest` is the queue without the used
   * pictures. Never repeats the previous layout when another one fits, and
   * shows a single picture about every other time.
   */
  function plan(queue, previousLayout, random = Math.random, bias = null) {
    if (queue.length === 0) return null;
    const first = queue[0];
    const options = [];
    const add = (layout, indexes, weight) => {
      if (indexes) options.push({ layout, indexes, weight });
    };
    if (isLandscape(first)) {
      add('single', [0], 3);
      const portraits = take(queue.slice(1), 2, (p) => !isLandscape(p));
      if (portraits) add('mixed', [0, ...portraits.map((i) => i + 1)], 2);
      const portrait = take(queue.slice(1), 1, (p) => !isLandscape(p));
      // A portrait beside a landscape: the portrait goes first.
      if (portrait) add('pair', [portrait[0] + 1, 0], 2);
      const landscapes = take(queue.slice(1), 2, isLandscape);
      if (landscapes) add('stack3', [0, ...landscapes.map((i) => i + 1)], 2);
      if (isPanorama(first)) {
        const other = take(queue.slice(1), 1, isPanorama);
        if (other) add('wide2', [0, other[0] + 1], 4);
      }
    } else {
      const more = take(queue.slice(1), 2, (p) => !isLandscape(p));
      if (more) add('trio', [0, ...more.map((i) => i + 1)], 3);
      const one = take(queue.slice(1), 1, (p) => !isLandscape(p));
      if (one) add('duo', [0, one[0] + 1], 3);
      const land = take(queue.slice(1), 1, isLandscape);
      if (land) add('pair', [0, land[0] + 1], 2);
      // A portrait alone, with black around it, only as a last resort.
      if (options.length === 0) add('single', [0], 1);
    }
    // A group asks for its own preferences (no lone portrait, few singles).
    if (bias)
      for (const option of options) option.weight *= bias(option, queue);
    // Options a group has ruled out are only used when nothing else is left,
    // and repeating the last layout is better than using one of those.
    let live = options.filter((option) => option.weight > 0);
    if (live.length === 0) live = options;
    let pool = live.filter((option) => option.layout !== previousLayout);
    if (pool.length === 0) pool = live;
    let total = 0;
    for (const option of pool) total += option.weight;
    let pick = random() * total;
    let chosen = pool[0];
    for (const option of pool) {
      pick -= option.weight;
      if (pick < 0) {
        chosen = option;
        break;
      }
    }
    const used = new Set(chosen.indexes);
    return {
      layout: chosen.layout,
      photos: chosen.indexes.map((i) => queue[i]),
      rest: queue.filter((_, i) => !used.has(i)),
    };
  }

  const MONTHS = [
    'januari',
    'februari',
    'mars',
    'april',
    'maj',
    'juni',
    'juli',
    'augusti',
    'september',
    'oktober',
    'november',
    'december',
  ];

  function parseDate(date) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
    return match
      ? { y: Number(match[1]), m: Number(match[2]) - 1, d: Number(match[3]) }
      : null;
  }

  /**
   * The quiet caption of a slide: the place and the date the pictures were
   * taken, only where they agree. The year is left out for this year.
   */
  function caption(photos, thisYear = new Date().getFullYear()) {
    const places = new Set(photos.map((p) => p.place || ''));
    const place = places.size === 1 ? [...places][0] : '';
    const dates = photos.map((p) => parseDate(p.date));
    let date = '';
    if (dates.every(Boolean)) {
      const [a] = dates;
      const sameDay = dates.every(
        (d) => d.y === a.y && d.m === a.m && d.d === a.d,
      );
      const sameMonth = dates.every((d) => d.y === a.y && d.m === a.m);
      const year = a.y === thisYear ? '' : ` ${a.y}`;
      if (sameDay) date = `${a.d} ${MONTHS[a.m]}${year}`;
      else if (sameMonth) date = `${MONTHS[a.m]}${year || ` ${a.y}`}`;
    }
    return { place, date };
  }

  // ── Groups ──
  //
  // The server lists, for each picture, the pictures that belong with it
  // (`nb`: [index, score 0-100]; time, place, people and what they look like
  // already weighed in) and the near-duplicates (`du`). A group is a seed
  // picture plus four to six of its neighbours, chosen at random with the
  // best-fitting and least-recently-shown most likely, so the same picture is
  // met in new company each time. Nothing here is computed from pixels.
  const GROUP_SIZES = [
    [4, 35],
    [5, 40],
    [6, 25],
  ];
  const LINK_MIN = 0.42; // how well a newcomer must fit the whole group
  const LINK_FALLBACK = 0.2; // when the seed would otherwise stand alone
  const FALLBACK_SIZE = 3; // ...and then only a small group, never a collage
  const RECENT_GROUPS = 8;
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

  function pickWeighted(items, weightOf, random) {
    let total = 0;
    for (const item of items) total += Math.max(0, weightOf(item));
    if (total <= 0) return items[Math.floor(random() * items.length)];
    let pick = random() * total;
    for (const item of items) {
      pick -= Math.max(0, weightOf(item));
      if (pick < 0) return item;
    }
    return items[items.length - 1];
  }

  const pairKey = (a, b) =>
    a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;

  function newGroupState() {
    return { plays: new Map(), recent: [] };
  }

  /**
   * Picks the next group of related pictures from `library` (the listing's
   * photos, in listing order). `state` remembers what was shown: how often
   * each picture and which pairs, so the next group differs.
   */
  function buildGroup(library, state, random = Math.random) {
    if (library.length === 0) return [];
    const plays = state.plays;
    let least = Infinity;
    for (const photo of library)
      least = Math.min(least, plays.get(photo.id) || 0);
    const fresh = (photo, power) =>
      1 / Math.pow(1 + (plays.get(photo.id) || 0) - least, power);
    const at = new Map(library.map((photo, i) => [photo.id, i]));
    const score = (a, b) => {
      const i = at.get(b.id);
      const found = (a.nb || []).find((entry) => entry[0] === i);
      if (found) return found[1] / 100;
      const j = at.get(a.id);
      const back = (b.nb || []).find((entry) => entry[0] === j);
      return back ? back[1] / 100 : 0;
    };
    const duplicate = (a, b) =>
      (a.du || []).includes(at.get(b.id)) ||
      (b.du || []).includes(at.get(a.id));
    const recent = new Set();
    for (const used of state.recent) for (const key of used) recent.add(key);

    // Every round starts from a picture nobody has seen yet this round (a
    // favourite a little more often), so nothing waits long to be shown.
    const unseen = library.filter(
      (photo) => (plays.get(photo.id) || 0) === least,
    );
    const seed = pickWeighted(unseen, (photo) => (photo.fav ? 1.8 : 1), random);
    const size = pickWeighted(GROUP_SIZES, (entry) => entry[1], random)[0];
    const group = [seed];
    const members = new Set([seed.id]);
    for (const threshold of [LINK_MIN, LINK_FALLBACK]) {
      // The relaxed pass exists so a picture without company still gets some;
      // it never grows a full group out of loosely related pictures.
      const limit = threshold === LINK_MIN ? size : FALLBACK_SIZE;
      while (group.length < limit) {
        const candidates = new Map();
        for (const member of group)
          for (const entry of member.nb || []) {
            const other = library[entry[0]];
            if (other && !members.has(other.id))
              candidates.set(other.id, other);
          }
        const pool = [];
        for (const other of candidates.values()) {
          if (group.some((member) => duplicate(member, other))) continue;
          // How well it fits everyone already there; a stranger to some
          // member pulls the average down, and too many strangers rule a
          // picture out however well the rest of the group knows it.
          let fit = 0;
          let strangers = 0;
          for (const member of group) {
            const pair = score(member, other);
            fit += pair;
            if (pair <= 0) strangers += 1;
          }
          fit /= group.length;
          if (fit < threshold) continue;
          if (
            threshold === LINK_MIN &&
            strangers > Math.floor(group.length / 3)
          )
            continue;
          let weight = fit * fit * fresh(other, 1.5);
          for (const member of group)
            if (recent.has(pairKey(member, other))) weight *= 0.4;
          pool.push([other, weight]);
        }
        if (pool.length === 0) break;
        const [chosen] = pickWeighted(pool, (entry) => entry[1], random);
        group.push(chosen);
        members.add(chosen.id);
      }
      // The strict threshold is enough unless the seed would stand alone.
      if (group.length >= 2) break;
    }
    // A picture never stands alone with black around it: a seed without
    // enough company takes the nearest picture in time that has been shown
    // least, related or not.
    if (group.length < 2 && library.length > 1) {
      const DAY = 24 * 60 * 60 * 1000;
      let best = null;
      let bestKey = -Infinity;
      for (const other of library) {
        if (other === seed || duplicate(seed, other)) continue;
        const apart =
          typeof seed.t === 'number' && typeof other.t === 'number'
            ? Math.min(Math.abs(seed.t - other.t) / DAY, 400)
            : 400;
        const key =
          score(seed, other) * 100 - apart / 4 - (plays.get(other.id) || 0) * 5;
        if (key > bestKey) {
          bestKey = key;
          best = other;
        }
      }
      if (best) group.push(best);
    }
    // A story reads in time order when it is all one outing.
    const times = group
      .map((photo) => photo.t)
      .filter((t) => typeof t === 'number');
    if (
      times.length === group.length &&
      Math.max(...times) - Math.min(...times) <= 3 * WEEK_MS
    )
      group.sort((a, b) => a.t - b.t);
    return group;
  }

  function rememberGroup(state, group) {
    for (const photo of group)
      state.plays.set(photo.id, (state.plays.get(photo.id) || 0) + 1);
    const used = new Set();
    for (let i = 0; i < group.length; i += 1)
      for (let j = i + 1; j < group.length; j += 1)
        used.add(pairKey(group[i], group[j]));
    state.recent.push(used);
    if (state.recent.length > RECENT_GROUPS) state.recent.shift();
  }

  /**
   * Splits a group over slides, two or three pictures at a time (five make
   * 2 + 3, six 3 + 3 or 2 + 2 + 2). Never leaves a portrait alone on its own
   * slide when it can be avoided, and only shows a single landscape.
   */
  function planGroup(photos, previousLayout, random = Math.random) {
    const slides = [];
    let rest = photos.slice();
    let layout = previousLayout;
    while (rest.length > 0) {
      const remaining = rest.length;
      const chosen = plan(rest, layout, random, (option, queue) => {
        const count = option.indexes.length;
        let factor = 1;
        // A portrait on a slide of its own is black on one side: only when
        // nothing else can be done (the plan falls back to it if every option
        // has no weight), and a lone landscape fills the screen but is rare.
        if (count === 1)
          factor *= isLandscape(queue[option.indexes[0]])
            ? photos.length < 4
              ? 0.6
              : 0.3
            : 0;
        if (remaining - count === 1) {
          const lone = queue.find((_, i) => !option.indexes.includes(i));
          factor *= lone && !isLandscape(lone) ? 0 : 0.4;
        }
        return factor;
      });
      slides.push({ layout: chosen.layout, photos: chosen.photos });
      rest = chosen.rest;
      layout = chosen.layout;
    }
    return slides;
  }

  // ── Naming a group ──
  //
  // Every group is named the same way, in the same place: a small word for
  // what kind of name it is (RESA, PLATS, TEMA, DAG, MÅNAD, ÅR, MED, MINNE),
  // the name itself, and the time or the company below. The kind follows what
  // the pictures really share, strongest first.
  const PLACE_BOUND_SCENES = new Set([
    'beach',
    'sea',
    'lake',
    'forest',
    'mountain',
    'snow',
    'city',
    'oldtown',
    'sunset',
    'hike',
    'garden',
  ]);
  const SHORT_MONTHS = [
    'jan',
    'feb',
    'mars',
    'apr',
    'maj',
    'juni',
    'juli',
    'aug',
    'sep',
    'okt',
    'nov',
    'dec',
  ];
  const upperFirst = (text) => text.charAt(0).toUpperCase() + text.slice(1);

  function share(photos, valueOf) {
    const counts = new Map();
    for (const photo of photos) {
      const value = valueOf(photo);
      if (value !== null && value !== undefined && value !== '')
        counts.set(value, (counts.get(value) || 0) + 1);
    }
    let best = null;
    for (const entry of counts) if (!best || entry[1] > best[1]) best = entry;
    return best
      ? { value: best[0], count: best[1], share: best[1] / photos.length }
      : null;
  }

  function dayText(date, thisYear) {
    const parts = parseDate(date);
    if (!parts) return '';
    return `${parts.d} ${MONTHS[parts.m]}${parts.y === thisYear ? '' : ` ${parts.y}`}`;
  }

  /** "11–14 september", "29 okt – 3 nov", with the year unless it is this year. */
  function rangeText(from, to, thisYear) {
    const a = parseDate(from);
    const b = parseDate(to);
    if (!a || !b) return '';
    const year = b.y === thisYear && a.y === b.y ? '' : ` ${b.y}`;
    if (a.y === b.y && a.m === b.m && a.d === b.d) return dayText(to, thisYear);
    if (a.y === b.y && a.m === b.m)
      return `${a.d}–${b.d} ${MONTHS[b.m]}${year}`;
    const left = a.y === b.y ? '' : ` ${a.y}`;
    // More than about five weeks: the months say it better than the days.
    const days =
      (Date.UTC(b.y, b.m, b.d) - Date.UTC(a.y, a.m, a.d)) / 86_400_000;
    if (days > 35) return `${MONTHS[a.m]}${left} – ${MONTHS[b.m]}${year}`;
    return `${a.d} ${SHORT_MONTHS[a.m]}${left} – ${b.d} ${SHORT_MONTHS[b.m]}${year}`;
  }

  function peopleText(photos, listing) {
    const names = new Map();
    for (const person of (listing && listing.people) || [])
      if (person.name) names.set(person.id, person.name);
    if (names.size === 0) return '';
    const counts = new Map();
    for (const photo of photos)
      for (const id of photo.pp || [])
        if (names.has(id)) counts.set(id, (counts.get(id) || 0) + 1);
    const present = [...counts]
      .filter((entry) => entry[1] >= Math.max(2, photos.length / 2))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map((entry) => names.get(entry[0]));
    if (present.length === 0) return '';
    return present.length === 1
      ? present[0]
      : `${present.slice(0, -1).join(', ')} och ${present[present.length - 1]}`;
  }

  /**
   * { kind, title, sub } for a group, or null when the pictures share
   * nothing worth saying. `listing` is { trips, scenes, people }.
   */
  function groupLabel(
    photos,
    listing = {},
    thisYear = new Date().getFullYear(),
  ) {
    if (!photos || photos.length === 0) return null;
    const trips = listing.trips || [];
    const scenes = listing.scenes || {};
    const dates = photos.map((p) => parseDate(p.date));
    const known = dates.filter(Boolean);
    const first = known[0];
    const sameDay =
      known.length === photos.length &&
      known.every((d) => d.y === first.y && d.m === first.m && d.d === first.d);
    const sameMonth =
      known.length === photos.length &&
      known.every((d) => d.y === first.y && d.m === first.m);
    const years = new Set(known.map((d) => d.y));
    const dated =
      known.length > 0 ? photos.filter((p) => parseDate(p.date)) : [];
    const sorted = dated.map((p) => p.date).sort();
    const period = sameDay
      ? dayText(sorted[0], thisYear)
      : sameMonth
        ? `${MONTHS[first.m]}${first.y === thisYear ? '' : ` ${first.y}`}`
        : sorted.length > 0
          ? rangeText(sorted[0], sorted[sorted.length - 1], thisYear)
          : '';
    const who = peopleText(photos, listing);
    const withWho = (text) =>
      who ? (text ? `${text} · med ${who}` : `med ${who}`) : text;

    // 1. Somebody wrote it down.
    const caption = share(photos, (p) => p.cap);
    if (caption && caption.share >= 0.5)
      return { kind: 'Minne', title: caption.value, sub: withWho(period) };

    // 2. A trip: the pictures are from one journey.
    const trip = share(photos, (p) => (typeof p.tr === 'number' ? p.tr : null));
    if (trip && trip.share >= 0.8 && trips[trip.value]) {
      const t = trips[trip.value];
      return {
        kind: 'Resa',
        title: t.title,
        sub: withWho(
          sameDay
            ? dayText(sorted[0], thisYear)
            : rangeText(t.from, t.to, thisYear),
        ),
      };
    }

    const place = share(photos, (p) => p.place);
    const samePlace = place && place.share >= 0.6 ? place.value : '';
    const scene = share(photos, (p) =>
      p.sc && scenes[p.sc] && (p.sp || 0) >= 45 ? p.sc : null,
    );
    const strongScene = scene && scene.share >= 0.6 ? scene.value : '';

    // 3. What it is and where.
    if (strongScene && samePlace && PLACE_BOUND_SCENES.has(strongScene))
      return {
        kind: 'Plats',
        title: `${scenes[strongScene]} i ${samePlace}`,
        sub: withWho(period),
      };
    // 4. What it is.
    if (strongScene)
      return {
        kind: 'Tema',
        title: scenes[strongScene],
        sub: withWho([samePlace, period].filter(Boolean).join(' · ')),
      };
    // 5. Where.
    if (samePlace)
      return { kind: 'Plats', title: samePlace, sub: withWho(period) };
    // 6. Who.
    if (who) return { kind: 'Med', title: who, sub: period };
    // 7. When.
    if (sameDay)
      return { kind: 'Dag', title: dayText(sorted[0], thisYear), sub: '' };
    if (sameMonth)
      return {
        kind: 'Månad',
        title: upperFirst(`${MONTHS[first.m]} ${first.y}`),
        sub: '',
      };
    if (years.size === 1 && known.length === photos.length)
      return { kind: 'År', title: String(first.y), sub: '' };
    return null;
  }

  // ── Shade in the corners ──
  //
  // The clock (upper right), the name (lower right) and the music widget
  // (lower left) sit on top of the pictures. The server measured how bright
  // each picture is in those three corners (`lu`: 0-99); a slide gets one
  // level per corner from the picture that really lies in that corner (which
  // cell that is depends on the layout), and the stylesheet shades each corner
  // as much as it needs: 0 dark, 1 mid, 2 bright. Pictures not measured count
  // as mid. Nothing is computed from pixels here.
  const CORNER_CELL = {
    single: [0, 0, 0],
    duo: [1, 1, 0],
    pair: [1, 1, 0],
    trio: [2, 2, 0],
    mixed: [2, 2, 0],
    stack3: [0, 0, 2],
    wide2: [0, 1, 1],
  };
  const LEVEL_MID = 31;
  const LEVEL_BRIGHT = 49;

  /** [upper right, lower right, lower left] levels 0-2 for a slide, or null. */
  function cornerLevels(layout, photos) {
    const cells = CORNER_CELL[layout];
    if (!cells) return null;
    return cells.map((index, corner) => {
      const lu = photos[index] && photos[index].lu;
      const value = Array.isArray(lu) ? lu[corner] : undefined;
      if (typeof value !== 'number') return 1;
      return value < LEVEL_MID ? 0 : value < LEVEL_BRIGHT ? 1 : 2;
    });
  }

  // The menu's veil belongs to the screen's bottom edge: only pictures that
  // reach it get one (not the upper ones of a stack).
  function bottomCell(layout, index) {
    if (layout === 'stack3') return index !== 1; // the upper small one is not
    if (layout === 'wide2') return index === 1;
    return true;
  }

  globalThis.lugnPhotos = {
    bottomCell,
    cornerLevels,
    plan,
    buildGroup,
    rememberGroup,
    newGroupState,
    planGroup,
    groupLabel,
    rangeText,
    caption,
    shuffled,
    mulberry32,
    orderQueue,
    clusters,
  };

  if (!pagesApi) return;
  const root = document.querySelector(
    ".hub-page[data-page='foto'] [data-view='root']",
  );
  if (!root) return;
  const stage = root.querySelector("[data-view='stage']");
  const notice = root.querySelector("[data-view='notice']");
  const pager = document.getElementById('hub-pager');

  // ── State ──

  let revision = '';
  let seen = false;
  let library = [];
  let queue = [];
  // With the server's neighbour lists pictures play in groups; without them
  // (an older server, no analysis) the queue above plays as it always did.
  let smart = false;
  let meta = { trips: [], scenes: {}, people: [] };
  const groupState = newGroupState();
  let pendingSlides = [];
  let random = mulberry32((Date.now() ^ 0x9e3779b9) >>> 0);
  let previousLayout = '';
  let current = null; // { el, layout }
  let building = null; // promise while a slide is being prepared
  let active = false;
  let showTimer = 0;
  let listTimer = 0;
  let listing = null;
  let pendingAdvance = false;
  let generation = 0;

  const paging = () => Boolean(pager && pager.classList.contains('paging'));
  // Runs `fn` now, or once the pager has stopped moving: nothing of this page
  // writes to the DOM or draws while a swipe is under way.
  function whenStill(fn) {
    if (!paging()) {
      fn();
      return;
    }
    const once = () => {
      window.removeEventListener('lugn:pages-settled', once);
      fn();
    };
    window.addEventListener('lugn:pages-settled', once);
  }

  function setNotice(text) {
    if (!notice) return;
    if (text) notice.textContent = text;
    notice.hidden = !text;
  }

  async function loadList() {
    if (listing) return listing;
    listing = (async () => {
      try {
        const response = await fetch(`${base()}display-api/photos`, {
          cache: 'no-store',
        });
        if (response.status === 404) {
          library = [];
          setNotice('Fotoramen är inte inställd');
          return;
        }
        if (!response.ok) return;
        const data = await response.json();
        if (!data || !Array.isArray(data.photos)) return;
        if (data.revision !== revision) {
          revision = data.revision;
          library = data.photos;
          smart = library.some((photo) => Array.isArray(photo.nb));
          meta = {
            trips: Array.isArray(data.trips) ? data.trips : [],
            scenes:
              data.scenes && typeof data.scenes === 'object' ? data.scenes : {},
            people: Array.isArray(data.people) ? data.people : [],
          };
          // Removed pictures leave the queue; new ones play next (the first
          // list ever read is simply put in order).
          const known = new Set(library.map((p) => p.id));
          queue = queue.filter((p) => known.has(p.id));
          const queued = new Set(queue.map((p) => p.id));
          const fresh = library.filter((p) => !queued.has(p.id));
          if (!seen) queue = orderQueue(library, random);
          else if (fresh.length > 0)
            queue = orderQueue(fresh, random).concat(queue);
          seen = true;
        }
        setNotice(library.length === 0 ? 'Inga bilder ännu' : '');
      } catch {
        /* the next round tries again */
      } finally {
        listing = null;
      }
    })();
    return listing;
  }

  function refill() {
    if (queue.length < 4 && library.length > 0) {
      const queued = new Set(queue.map((p) => p.id));
      // Another round: everything not already waiting, in a new order.
      queue = queue.concat(
        orderQueue(
          library.filter((p) => !queued.has(p.id)),
          random,
        ),
      );
    }
  }

  // ── Building a slide ──

  const photoUrl = (photo, variant) =>
    `${base()}display-api/photos/${photo.id}${variant ? `/${variant}` : ''}`;

  function cell(photo, className, withVeil) {
    const wrap = document.createElement('div');
    wrap.className = `ph-cell ${className || ''}`.trim();
    const image = new Image();
    image.alt = '';
    image.decoding = 'async';
    image.draggable = false;
    image.setAttribute('fetchpriority', 'low');
    image.src = photoUrl(photo);
    wrap.appendChild(image);
    // A soft veil along the bottom, drawn from the picture itself once it is
    // decoded and shown while the menu is up: no blur is computed on the Hub.
    let veil = null;
    if (withVeil) {
      veil = document.createElement('canvas');
      veil.className = 'ph-veil';
      wrap.appendChild(veil);
    }
    return { wrap, image, veil };
  }

  // Pictures start loading together (one slide), but are decoded one at a time.
  async function decodeAll(images, token) {
    for (const image of images) {
      if (token !== generation) return false;
      // decode() can wait for a rendering opportunity that a hidden page never
      // gets; a picture that has loaded is shown after a while regardless.
      let timer = 0;
      try {
        await Promise.race([
          image.decode(),
          new Promise((resolve) => {
            timer = window.setTimeout(resolve, DECODE_WAIT_MS);
          }),
        ]);
      } catch {
        return false;
      } finally {
        window.clearTimeout(timer);
      }
      if (!image.complete || image.naturalWidth === 0) return false;
    }
    return token === generation;
  }

  async function build(chosen) {
    const slide = document.createElement('div');
    const landscapeSingle =
      chosen.layout === 'single' && isLandscape(chosen.photos[0]);
    slide.className = `ph-slide ph-${chosen.layout}${
      chosen.layout === 'single'
        ? landscapeSingle
          ? ' ph-landscape'
          : ' ph-portrait'
        : ''
    }`;
    const images = [];
    const veils = [];
    let count = 0;
    const add = (photo, className) => {
      const made = cell(photo, className, bottomCell(chosen.layout, count));
      count += 1;
      slide.appendChild(made.wrap);
      images.push(made.image);
      if (made.veil) veils.push({ canvas: made.veil, image: made.image });
      return made;
    };
    const { photos, layout } = chosen;
    if (layout === 'single') {
      const photo = photos[0];
      if (isLandscape(photo)) {
        add(photo, 'ph-full');
      } else {
        const backdrop = document.createElement('img');
        backdrop.className = 'ph-backdrop';
        backdrop.alt = '';
        backdrop.decoding = 'async';
        backdrop.src = photoUrl(photo, 'backdrop');
        slide.appendChild(backdrop);
        images.push(backdrop);
        add(photo, 'ph-portrait');
      }
    } else if (layout === 'duo') {
      for (const photo of photos) add(photo, 'ph-half');
    } else if (layout === 'pair') {
      add(photos[0], 'ph-pair-p');
      add(photos[1], 'ph-pair-l');
    } else if (layout === 'trio') {
      for (const photo of photos) add(photo, 'ph-col');
    } else if (layout === 'mixed') {
      // The landscape first, then two portraits.
      for (const photo of photos) add(photo, '');
    } else if (layout === 'stack3') {
      photos.forEach((photo, i) => add(photo, i === 0 ? 'ph-big' : ''));
    } else {
      for (const photo of photos) add(photo, '');
    }
    const text = smart
      ? chosen.label || null
      : (() => {
          const quiet = caption(photos);
          return quiet.place || quiet.date
            ? { kind: '', title: quiet.place, sub: quiet.date }
            : null;
        })();
    if (text && (text.title || text.sub)) {
      const element = document.createElement('div');
      element.className = 'ph-cap';
      if (text.kind) {
        const kind = document.createElement('small');
        kind.textContent = text.kind;
        element.appendChild(kind);
      }
      if (text.title) {
        const title = document.createElement('b');
        title.textContent = text.title;
        element.appendChild(title);
      }
      if (text.sub) {
        const sub = document.createElement('span');
        sub.textContent = text.sub;
        element.appendChild(sub);
      }
      // Where in the group this slide is: one dot per slide.
      if (smart && chosen.of > 1) {
        const dots = document.createElement('i');
        dots.className = 'ph-dots';
        for (let i = 0; i < chosen.of; i += 1) {
          const dot = document.createElement('u');
          if (i === chosen.step) dot.className = 'on';
          dots.appendChild(dot);
        }
        element.appendChild(dots);
      }
      slide.appendChild(element);
    }
    // Shade for the clock, the name and the music widget, from the picture in
    // each corner; the blur layers are switched on once the slide has settled.
    const levels = cornerLevels(layout, photos);
    if (levels) {
      slide.dataset.tr = String(levels[0]);
      slide.dataset.br = String(levels[1]);
      slide.dataset.bl = String(levels[2]);
      for (const corner of ['tr', 'br', 'bl']) {
        const shade = document.createElement('div');
        shade.className = `ph-shade ${corner}`;
        slide.appendChild(shade);
      }
      for (const corner of ['tr', 'br', 'bl']) {
        const blur = document.createElement('div');
        blur.className = `ph-blur ${corner}`;
        slide.appendChild(blur);
      }
    }
    return { slide, images, veils };
  }

  // The bottom of the picture, shrunk twice (a blur by averaging), with an alpha
  // ramp from clear at the top to dark at the bottom edge.
  function drawVeil(canvas, image) {
    try {
      const w = 64;
      const h = 24;
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      const step = document.createElement('canvas');
      step.width = 32;
      step.height = 12;
      const stepCtx = step.getContext('2d');
      if (!ctx || !stepCtx) return;
      const sh = image.naturalHeight * 0.45;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(
        image,
        0,
        image.naturalHeight - sh,
        image.naturalWidth,
        sh,
        0,
        0,
        w,
        h,
      );
      stepCtx.imageSmoothingQuality = 'high';
      stepCtx.drawImage(canvas, 0, 0, w, h, 0, 0, 32, 12);
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(step, 0, 0, 32, 12, 0, 0, w, h);
      ctx.globalCompositeOperation = 'destination-in';
      const ramp = ctx.createLinearGradient(0, 0, 0, h);
      ramp.addColorStop(0, 'rgba(0,0,0,0)');
      ramp.addColorStop(0.5, 'rgba(0,0,0,0.55)');
      ramp.addColorStop(1, 'rgba(0,0,0,0.75)');
      ctx.fillStyle = ramp;
      ctx.fillRect(0, 0, w, h);
    } catch {
      /* no veil; the dark gradient remains */
    }
  }

  // The next related group, split over slides; each slide carries the group's
  // name and its place in the group.
  function startGroup() {
    const group = buildGroup(library, groupState, random);
    if (group.length === 0) return;
    rememberGroup(groupState, group);
    const slides = planGroup(group, previousLayout, random);
    const label = groupLabel(group, meta);
    slides.forEach((slide, i) => {
      slide.label = label;
      slide.step = i;
      slide.of = slides.length;
    });
    pendingSlides = slides;
  }

  // Prepares the next slide off screen. Resolves to null when stale or when a
  // picture failed (its photo is dropped from the queue).
  // One consumer gets a built slide: a second caller while one is being built
  // gets `false` (busy, not a failure), so the same slide is never shown twice.
  async function prepareNext() {
    if (building) return false;
    const token = generation;
    const mine = (async () => {
      try {
        if (library.length === 0) await loadList();
        let chosen = null;
        if (smart) {
          if (pendingSlides.length === 0) startGroup();
          chosen = pendingSlides.shift() || null;
        } else {
          refill();
          chosen = plan(queue, previousLayout, random);
          if (chosen) queue = chosen.rest;
        }
        if (!chosen) return null;
        const made = await build(chosen);
        if (!(await decodeAll(made.images, token))) {
          drop(made.slide);
          return null;
        }
        if (paging()) await new Promise((resolve) => whenStill(resolve));
        for (const veil of made.veils) drawVeil(veil.canvas, veil.image);
        return { ...made, layout: chosen.layout };
      } finally {
        if (building === mine) building = null;
      }
    })();
    building = mine;
    return mine;
  }

  // ── Slow drift ──
  //
  // Each picture drifts and swells a little (about ten percent) over the time it is
  // shown: one transform animation per picture, run by the compositor. It is
  // paused while the page is not shown, and off when the Hub says so
  // (localStorage 'lugn.photos.kenburns' = 'off') or asks for less motion.
  const DRIFT_SCALE = 1.11;
  const DRIFT_MAX = 2.4; // percent
  function driftOn() {
    try {
      if (window.localStorage?.getItem('lugn.photos.kenburns') === 'off')
        return false;
    } catch {
      /* storage can be unavailable */
    }
    return !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  }
  function startDrift(slide) {
    if (!slide || slide.dataset.drift === '1' || !driftOn()) return;
    slide.dataset.drift = '1';
    for (const wrap of slide.querySelectorAll('.ph-cell')) {
      const image = wrap.querySelector('img');
      if (typeof image?.animate !== 'function') continue;
      const dx = (random() * 2 - 1) * DRIFT_MAX;
      const dy = (random() * 2 - 1) * DRIFT_MAX;
      image.animate(
        [
          { transform: 'scale(1) translate(0%, 0%)' },
          { transform: `scale(${DRIFT_SCALE}) translate(${dx}%, ${dy}%)` },
        ],
        { duration: SHOW_MS + 2 * FADE_MS, easing: 'linear', fill: 'forwards' },
      );
    }
  }
  function setDriftPlaying(playing) {
    const animations = current?.el.getAnimations?.({ subtree: true }) ?? [];
    for (const animation of animations)
      if (playing) animation.play();
      else animation.pause();
  }

  // ── Showing ──

  function drop(slide) {
    if (!slide) return;
    for (const image of slide.querySelectorAll('img'))
      image.removeAttribute('src');
    slide.remove();
  }

  // The new slide fades in over the old one, which stays opaque until it is
  // covered and is then dropped: one layer animates, and at most two slides
  // are ever in the page. The layer hint is set a moment before the fade
  // starts so the raster of its pictures is not part of the fade's first frame.
  let fading = false;
  const LIFT_MS = 120;
  function show(next) {
    // The same slide is never shown against itself.
    if (current && next.slide === current.el) return;
    const old = current;
    previousLayout = next.layout;
    current = { el: next.slide, layout: next.layout };
    if (!old) {
      // The very first slide appears without a fade, while the page is not
      // being looked at.
      next.slide.classList.add('in');
      stage.appendChild(next.slide);
      if (active) {
        startDrift(next.slide);
        next.slide.classList.add('settled');
      }
      return;
    }
    fading = true;
    next.slide.classList.add('lift');
    stage.appendChild(next.slide);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      window.clearTimeout(fallback);
      next.slide.removeEventListener('transitionend', onEnd);
      next.slide.classList.remove('lift');
      // Fully faded in: now the blur layers may draw.
      if (active) next.slide.classList.add('settled');
      drop(old.el);
      fading = false;
    };
    const onEnd = (event) => {
      if (event.target === next.slide) whenStill(finish);
    };
    const fallback = window.setTimeout(
      () => whenStill(finish),
      LIFT_MS + FADE_MS + 400,
    );
    next.slide.addEventListener('transitionend', onEnd);
    window.setTimeout(() => {
      if (!finished)
        whenStill(() => {
          next.slide.classList.add('in');
          startDrift(next.slide);
        });
    }, LIFT_MS);
  }

  // Failed builds (a missing picture, a server that is down) are tried again
  // with a growing pause.
  let failures = 0;
  const retryDelay = () => Math.min(5000 * 2 ** failures, 5 * 60_000);

  async function advance(manual) {
    // A timer that has fired is gone; a tap leaves a pending one alone until
    // a slide is shown.
    if (!manual) showTimer = 0;
    if (!active) return;
    if (menuOpen && !manual) return; // closing the menu schedules the next
    if (fading || building) {
      if (!manual) scheduleShow(1000);
      return;
    }
    if (paging()) {
      pendingAdvance = true;
      return;
    }
    pendingAdvance = false;
    const token = generation;
    const next = await prepareNext();
    if (token !== generation) {
      if (next) drop(next.slide);
      return;
    }
    if (next === false) {
      if (active && !manual) scheduleShow(1000);
      return;
    }
    if (!next) {
      failures += 1;
      if (active) scheduleShow(retryDelay());
      return;
    }
    failures = 0;
    if (!active || paging()) {
      // Not shown after all: keep what was prepared for the next try.
      drop(next.slide);
      pendingAdvance = active;
      if (active && !menuOpen) scheduleShow(SHOW_MS);
      return;
    }
    show(next);
    scheduleShow(SHOW_MS);
  }

  function scheduleShow(ms) {
    window.clearTimeout(showTimer);
    showTimer = window.setTimeout(advance, ms);
  }

  // The first slide. From prepare (a neighbour, every ~2 s) it is tried at
  // most once a minute, so a missing album, an empty one or a picture that
  // will not decode costs nothing; entering the page always tries.
  const RETRY_MS = 60_000;
  let lastFillAt = 0;
  let held = null; // a first slide that was ready while the pager moved
  async function fillFirst(force) {
    if (current || building || held) return;
    const now = Date.now();
    if (!force && lastFillAt && now - lastFillAt < RETRY_MS) return;
    lastFillAt = now;
    const token = generation;
    await loadList();
    const next = await prepareNext();
    if (next === false) return;
    if (!next) {
      failures += 1;
      return;
    }
    failures = 0;
    if (current || token !== generation) {
      drop(next.slide);
      return;
    }
    if (paging()) {
      held = next;
      return;
    }
    show(next);
  }

  function release() {
    generation += 1;
    window.clearTimeout(showTimer);
    showTimer = 0;
    window.clearInterval(listTimer);
    listTimer = 0;
    if (current) drop(current.el);
    for (const old of stage.querySelectorAll('.ph-slide')) drop(old);
    current = null;
    fading = false;
    if (held) drop(held.slide);
    held = null;
    lastFillAt = 0;
    failures = 0;
    building = null;
    pendingAdvance = false;
    pendingSlides = [];
  }

  window.addEventListener('lugn:pages-settled', () => {
    if (held) {
      const next = held;
      held = null;
      if (current) drop(next.slide);
      else show(next);
    }
    if (pendingAdvance && active) void advance();
  });

  // ── Quick menu and the music widget ──
  //
  // The navbar (quick-menu.js) slides up over the page with Hem's scenes, the
  // Musik and Kameror buttons and a button for the next picture. The picture
  // stays while it is open. The music widget (pause, title, artist) is there
  // whenever something plays and is lifted over the bar while it is open.
  const pauseButton = root.querySelector("[data-view='pause']");
  const nowBox = root.querySelector("[data-view='now']");
  const nowTitle = root.querySelector("[data-view='now-title']");
  const nowArtist = root.querySelector("[data-view='now-artist']");
  const pauseIcon = root.querySelector("[data-view='pause-icon']");
  const PAUSE_PATH = 'M8 5v14M16 5v14';
  const PLAY_PATH = 'M8 5.5v13l11-6.5Z';
  const LAST_PLAYED = 'Senast spelat: ';
  let menuOpen = false;
  let nowTimer = 0;

  // The small blur behind the corners is the one thing here that costs the Hub
  // something while it is shown; the Hub can switch it off for good with
  // localStorage 'lugn.photos.blur' = 'off'.
  try {
    if (window.localStorage?.getItem('lugn.photos.blur') === 'off')
      root.classList.add('no-blur');
  } catch {
    /* storage can be unavailable */
  }

  // The time of day, always there: large enough to read across the room,
  // quiet enough not to take over. It redraws once a minute, on the minute,
  // and never while the pager moves.
  const clockTime = root.querySelector("[data-view='clock-time']");
  const clockDate = root.querySelector("[data-view='clock-date']");
  const CLOCK_ZONE = 'Europe/Stockholm';
  let timeFormat = null;
  let dateFormat = null;
  try {
    timeFormat = new Intl.DateTimeFormat('sv-SE', {
      timeZone: CLOCK_ZONE,
      hour: '2-digit',
      minute: '2-digit',
    });
    dateFormat = new Intl.DateTimeFormat('sv-SE', {
      timeZone: CLOCK_ZONE,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    });
  } catch {
    /* no formatter: the clock stays empty rather than wrong */
  }
  let clockTimer = 0;
  function drawClock() {
    if (!clockTime || !timeFormat || paging()) return;
    const now = new Date();
    setText(clockTime, timeFormat.format(now));
    if (clockDate && dateFormat) setText(clockDate, dateFormat.format(now));
  }
  function runClock() {
    window.clearTimeout(clockTimer);
    clockTimer = window.setTimeout(
      () => {
        drawClock();
        runClock();
      },
      60_000 - (Date.now() % 60_000) + 40,
    );
  }
  function stopClock() {
    window.clearTimeout(clockTimer);
    clockTimer = 0;
  }

  const hem = () => (typeof refs === 'object' && refs ? refs : null);
  const setText = (element, value) => {
    if (element && element.textContent !== value) element.textContent = value;
  };

  // Pause and what is playing come from Hem's own music card, and a press is
  // Hem's own play button pressed, so the same rules (paused by hand, computer
  // media, pending) apply as there. Read once in a while, only while the page
  // is shown.
  function drawNow() {
    const r = hem();
    if (!r || !nowBox || paging()) return;
    const shown =
      document.getElementById('app-root')?.dataset.musicVisible === 'true';
    if (nowBox.hidden === shown) nowBox.hidden = !shown;
    // The shade in the lower left corner is only there while the widget is.
    if (shown) root.classList.add('has-now');
    else root.classList.remove('has-now');
    if (!shown) return;
    const raw = r.musicTitle?.textContent?.trim() || '';
    setText(
      nowTitle,
      raw.startsWith(LAST_PLAYED) ? raw.slice(LAST_PLAYED.length) : raw,
    );
    setText(
      nowArtist,
      r.musicArtist && !r.musicArtist.hidden
        ? r.musicArtist.textContent.trim()
        : '',
    );
    const playing = r.musicPlaybackLabel?.textContent?.trim() === 'Pausa';
    const path = playing ? PAUSE_PATH : PLAY_PATH;
    if (pauseIcon.getAttribute('d') !== path) pauseIcon.setAttribute('d', path);
    const label = playing ? 'Pausa' : 'Spela';
    if (pauseButton.getAttribute('aria-label') !== label)
      pauseButton.setAttribute('aria-label', label);
    const disabled = r.musicPlayback?.disabled !== false;
    if (pauseButton.disabled !== disabled) pauseButton.disabled = disabled;
  }

  const quickMenu = globalThis.lugnQuickMenu?.attach({
    id: 'foto',
    root,
    // The page's own control on the picture: pause (always there while music
    // plays).
    handleTap(event) {
      if (pauseButton?.contains(event.target)) {
        if (!pauseButton.disabled) hem()?.musicPlayback?.click();
        window.setTimeout(drawNow, 0);
        return true;
      }
      return false;
    },
    // The navbar's button for the next picture.
    actions: {
      next: () => void advance(true),
    },
  });
  quickMenu?.onOpen(() => {
    menuOpen = true;
    window.clearTimeout(showTimer);
    showTimer = 0;
  });
  quickMenu?.onClose(() => {
    menuOpen = false;
    if (active && !showTimer) scheduleShow(SHOW_MS);
  });

  pagesApi.define('foto', {
    // Draws the first picture once while the page is a neighbour; later calls
    // change nothing.
    prepare() {
      void fillFirst(false);
    },
    enter() {
      active = true;
      setDriftPlaying(true);
      if (current) {
        startDrift(current.el);
        if (!fading) current.el.classList.add('settled');
      }
      drawNow();
      drawClock();
      runClock();
      if (!nowTimer) nowTimer = window.setInterval(drawNow, 2000);
      void fillFirst(true).then(() => {
        // A first slide that failed to build is tried again soon.
        if (active && !showTimer)
          scheduleShow(current ? SHOW_MS : retryDelay());
      });
      if (!listTimer)
        listTimer = window.setInterval(() => void loadList(), LIST_MS);
    },
    leave() {
      quickMenu?.close();
      active = false;
      setDriftPlaying(false);
      if (current) current.el.classList.remove('settled');
      stopClock();
      window.clearInterval(nowTimer);
      nowTimer = 0;
      window.clearTimeout(showTimer);
      showTimer = 0;
      window.clearInterval(listTimer);
      listTimer = 0;
    },
    sleep() {
      quickMenu?.close();
      active = false;
      stopClock();
      window.clearInterval(nowTimer);
      nowTimer = 0;
      release();
    },
  });
})();
