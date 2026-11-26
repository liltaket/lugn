import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Who is who. The photo brain on Kuffe groups the faces and proposes who each
 * one is; what the household says always wins: a name, a confirmed group, a
 * face moved to someone else, "not a person". Those decisions are saved and
 * never overridden. Kuffe's new groups get stable person ids here, so a
 * person keeps their id (and name) from one bundle to the next.
 */

/** One face as the photo brain sent it: a box and its proposal, no embedding. */
export type Face = {
  /** Box as fractions of the picture. */
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
  /** 0 (profile) to 1 (straight on). */
  front: number;
  /** 0–100: how useful for recognition. */
  quality: number;
  /** `p3`: an existing person; `n7`: a new group; absent: too unclear. */
  p?: string | undefined;
};
export type FaceRef = {
  /** `<photo id>.<index>`: the face's place in that picture's list in the bundle. */
  id: string;
  photoId: string;
  face: Face;
};

export type PersonRecord = {
  id: string;
  name: string | null;
  /** Somebody looked at this group and said it is one person. */
  confirmed: boolean;
  /** Not shown or used (a stranger in the background, say). */
  hidden: boolean;
};
type Box = [x: number, y: number, w: number, h: number];
type FaceDecision = {
  /** The person a human chose; `null` means "not a person worth tracking". */
  person?: string | null;
  /** The automatic grouping's own choice, remembered so ids stay stable. */
  auto?: string;
  /** People this face was moved away from; never given to them automatically. */
  not?: string[];
  /**
   * Where the face was when somebody decided. A decision follows its face
   * when the faces of a picture are numbered differently (another detector).
   */
  box?: Box;
  /**
   * Where the household says the face really is, when the detector's box sat
   * on an arm or a shoulder. The detector's own box stays in `box`: that is
   * what a decision follows.
   */
  moved?: Box;
};
type PeopleFile = {
  version: 1;
  next: number;
  people: Record<string, PersonRecord>;
  faces: Record<string, FaceDecision>;
  /** Pictures whose faces nobody cares about (a crowd, a street). */
  skipped?: string[];
};

/** The household's decisions, for the photo brain to anchor on. */
export type PeopleLabels = {
  schema: 1;
  people: PersonRecord[];
  decided: Record<string, string | null>;
  previous: Record<string, string>;
  not: Record<string, string[]>;
};

const PERSON_ID = /^p\d{1,6}$/;
const NEW_GROUP = /^n\d{1,6}$/;
const FACE_ID = /^[A-Za-z0-9_-]{24}\.\d{1,2}$/;
const PHOTO_ID = /^[A-Za-z0-9_-]{24}$/;
/** The smallest box a household may draw, as a fraction of the picture. */
const MIN_BOX = 0.01;
const MAX_NAME = 40;
/** How much a decided face's box must overlap a face to be that face. */
const SAME_FACE_IOU = 0.5;

/** One face as the panel shows it: where it is, and in which picture. */
export type FaceSample = {
  id: string;
  photoId: string;
  x: number;
  y: number;
  w: number;
  h: number;
};
const sampleOf = (face: FaceRef, moved?: Box): FaceSample => ({
  id: face.id,
  photoId: face.photoId,
  x: moved ? moved[0] : face.face.x,
  y: moved ? moved[1] : face.face.y,
  w: moved ? moved[2] : face.face.w,
  h: moved ? moved[3] : face.face.h,
});

export type PeopleView = {
  people: Array<
    PersonRecord & {
      faces: number;
      photos: number;
      samples: FaceSample[];
    }
  >;
  unassigned: {
    count: number;
    samples: FaceSample[];
  };
  ignored: number;
  /** Pictures marked "none of these faces matter", most recent decisions last. */
  skippedPhotos: string[];
};

/** One face in its picture, as the review shows it. */
export type ReviewFace = FaceSample & {
  /** `open`: nobody and nothing has placed it; `ignored`: it does not matter. */
  state: 'open' | 'person' | 'ignored';
  person: string | null;
  /** The person is only the photo brain's proposal, not a household decision. */
  auto: boolean;
  /** The household moved the box from where the detector put it. */
  moved: boolean;
};
export type ReviewPhoto = {
  id: string;
  /** Marked: none of this picture's faces matter. */
  skipped: boolean;
  /** Left to right. */
  faces: ReviewFace[];
};
export type ReviewPerson = {
  id: string;
  name: string | null;
  faces: number;
  /** A face that shows them, for a thumbnail; null without faces. */
  sample: string | null;
};
export type ReviewView = { people: ReviewPerson[]; photos: ReviewPhoto[] };

/**
 * Where a face goes. `open` takes the household's decision back; `named` is
 * the person with that name (a new one if nobody has it).
 */
export type MoveTarget =
  { person: string } | { named: string } | 'new' | 'none' | 'open';

export class PeopleError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'PeopleError';
  }
}

export const faceKey = (photoId: string, index: number): string =>
  `${photoId}.${index}`;
export const isFaceId = (value: string): boolean => FACE_ID.test(value);

const boxOf = (face: Face): Box => [
  Math.round(face.x * 1000) / 1000,
  Math.round(face.y * 1000) / 1000,
  Math.round(face.w * 1000) / 1000,
  Math.round(face.h * 1000) / 1000,
];
function overlap(a: Box, b: Box): number {
  const w = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / (a[2] * a[3] + b[2] * b[3] - inter);
}
const isHuman = (decision: FaceDecision | undefined): boolean =>
  decision !== undefined &&
  (decision.person !== undefined ||
    Boolean(decision.not?.length) ||
    decision.moved !== undefined);
const numeric = (a: string, b: string): number =>
  a.localeCompare(b, 'en', { numeric: true });

export class PeopleStore {
  private people = new Map<string, PersonRecord>();
  private decisions = new Map<string, FaceDecision>();
  private next = 1;
  private dirty = false;
  /** The latest mapping: face id → person id. */
  private assignment = new Map<string, string>();
  private faces: FaceRef[] = [];
  private byId = new Map<string, FaceRef>();
  /** Human decisions that sit on a face they were not made for (kept, not used). */
  private dormant = new Set<string>();
  /** Pictures whose faces nobody cares about, unless a face was decided. */
  private skipped = new Set<string>();

  constructor(
    private readonly path: string,
    private readonly warn: (message: string) => void = () => undefined,
  ) {}

  async load(): Promise<void> {
    this.people.clear();
    this.decisions.clear();
    this.skipped.clear();
    try {
      const parsed = JSON.parse(
        await readFile(this.path, 'utf8'),
      ) as PeopleFile;
      if (parsed.version !== 1) return;
      this.next = Math.max(1, Math.floor(Number(parsed.next) || 1));
      for (const [id, person] of Object.entries(parsed.people ?? {})) {
        if (!PERSON_ID.test(id)) continue;
        this.people.set(id, {
          id,
          name: cleanName(person.name),
          confirmed: Boolean(person.confirmed),
          hidden: Boolean(person.hidden),
        });
      }
      for (const [face, decision] of Object.entries(parsed.faces ?? {})) {
        if (!FACE_ID.test(face)) continue;
        const kept: FaceDecision = {};
        if (decision.person === null) kept.person = null;
        else if (
          typeof decision.person === 'string' &&
          this.people.has(decision.person)
        )
          kept.person = decision.person;
        if (typeof decision.auto === 'string' && this.people.has(decision.auto))
          kept.auto = decision.auto;
        if (Array.isArray(decision.not))
          kept.not = decision.not.filter(
            (id) => typeof id === 'string' && PERSON_ID.test(id),
          );
        const box = cleanBox(decision.box);
        if (box) kept.box = box;
        const moved = cleanBox(decision.moved);
        if (moved) kept.moved = moved;
        this.decisions.set(face, kept);
      }
      for (const photo of parsed.skipped ?? [])
        if (typeof photo === 'string' && PHOTO_ID.test(photo))
          this.skipped.add(photo);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        this.warn(
          `photo people file unreadable, starting again: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    const file: PeopleFile = {
      version: 1,
      next: this.next,
      people: Object.fromEntries(this.people),
      faces: Object.fromEntries(
        [...this.decisions].filter(
          ([, d]) =>
            d.person !== undefined ||
            d.auto !== undefined ||
            d.not?.length ||
            d.moved !== undefined,
        ),
      ),
      ...(this.skipped.size > 0 ? { skipped: [...this.skipped] } : {}),
    };
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = join(dirname(this.path), `.people.${process.pid}.tmp`);
    await writeFile(temporary, JSON.stringify(file), { mode: 0o600 });
    await rename(temporary, this.path);
    this.dirty = false;
  }

  /**
   * Boxes for decisions made before boxes were kept (from the old local
   * analysis), so those decisions can follow their faces.
   */
  adoptBoxes(boxes: ReadonlyMap<string, Box>): void {
    for (const [id, decision] of this.decisions) {
      if (decision.box || !isHuman(decision)) continue;
      const box = cleanBox(boxes.get(id));
      if (!box) continue;
      decision.box = box;
      this.dirty = true;
    }
  }

  /** True when a human decision still lacks the box it was made for. */
  needsBoxes(): boolean {
    for (const decision of this.decisions.values())
      if (isHuman(decision) && !decision.box) return true;
    return false;
  }

  // ── The mapping ──

  /**
   * Who every face is: the household's decision if there is one, else the
   * photo brain's proposal mapped to a stable person id. O(faces).
   */
  regroup(faces: FaceRef[]): void {
    this.faces = faces;
    this.byId = new Map(faces.map((f) => [f.id, f]));
    this.followFaces();
    // Faces whose picture left (or that Kuffe no longer sees) lose their
    // automatic memory only.
    for (const [id, decision] of [...this.decisions])
      if (!this.byId.has(id) && !isHuman(decision)) {
        this.decisions.delete(id);
        this.dirty = true;
      }

    const assignment = new Map<string, string>();
    const blocked = (face: FaceRef, person: string): boolean =>
      !this.dormant.has(face.id) &&
      Boolean(this.decisions.get(face.id)?.not?.includes(person));

    // 1. What people decided.
    const open: FaceRef[] = [];
    for (const face of faces) {
      const decision = this.dormant.has(face.id)
        ? undefined
        : this.decisions.get(face.id);
      if (decision?.person === null) continue;
      if (
        typeof decision?.person === 'string' &&
        this.people.has(decision.person)
      )
        assignment.set(face.id, decision.person);
      else if (this.skipped.has(face.photoId)) continue;
      else open.push(face);
    }

    // 2. Proposals of a person this side knows.
    const groups = new Map<string, FaceRef[]>();
    for (const face of open) {
      const proposal = face.face.p;
      if (!proposal) continue;
      // The proposal is about the box the detector drew; the household moved it.
      if (!this.dormant.has(face.id) && this.decisions.get(face.id)?.moved)
        continue;
      if (PERSON_ID.test(proposal)) {
        if (this.people.has(proposal) && !blocked(face, proposal))
          assignment.set(face.id, proposal);
      } else if (NEW_GROUP.test(proposal)) {
        const list = groups.get(proposal) ?? [];
        list.push(face);
        groups.set(proposal, list);
      }
    }

    // 3. New groups: the person most of its faces were before, if no other
    // group took them; otherwise somebody new (two faces or more).
    const taken = new Set<string>();
    const ordered = [...groups].sort(
      (a, b) => b[1].length - a[1].length || numeric(a[0], b[0]),
    );
    for (const [, members] of ordered) {
      const votes = new Map<string, number>();
      for (const face of members) {
        const earlier = this.dormant.has(face.id)
          ? undefined
          : this.decisions.get(face.id)?.auto;
        if (earlier && this.people.has(earlier) && !taken.has(earlier))
          votes.set(earlier, (votes.get(earlier) ?? 0) + 1);
      }
      let person: string | null = null;
      let best = 0;
      for (const [id, count] of votes)
        if (
          count > best ||
          (count === best && person && numeric(id, person) < 0)
        ) {
          person = id;
          best = count;
        }
      if (!person && members.length >= 2) person = this.createPerson().id;
      if (!person) continue;
      taken.add(person);
      for (const face of members)
        if (!blocked(face, person)) assignment.set(face.id, person);
    }

    // 4. Remember the automatic choices, so ids stay stable.
    for (const face of open) {
      if (this.dormant.has(face.id)) continue;
      const chosen = assignment.get(face.id) ?? null;
      const earlier = this.decisions.get(face.id)?.auto ?? null;
      if (chosen !== earlier) this.setAuto(face.id, chosen);
    }

    // 5. People nobody named, confirmed or decided on, and who have no faces, go.
    const used = new Set(assignment.values());
    for (const person of [...this.people.values()]) {
      if (used.has(person.id) || person.name || person.confirmed) continue;
      this.people.delete(person.id);
      this.dirty = true;
    }
    this.assignment = assignment;
  }

  /**
   * A human decision that knows its face's box and sits on a face elsewhere
   * in the picture moves to the face that matches; one that matches none is
   * kept but not used until its face is seen again.
   */
  private followFaces(): void {
    this.dormant = new Set();
    const byPhoto = new Map<string, FaceRef[]>();
    for (const face of this.faces) {
      const list = byPhoto.get(face.photoId) ?? [];
      list.push(face);
      byPhoto.set(face.photoId, list);
    }
    const claimed = new Set<string>();
    const moves: Array<[from: string, to: string]> = [];
    for (const [id, decision] of this.decisions) {
      if (!decision.box || !isHuman(decision)) continue;
      const photoId = id.slice(0, id.indexOf('.'));
      const candidates = byPhoto.get(photoId);
      if (!candidates) continue; // the picture's faces are not known now
      const here = this.byId.get(id);
      if (here && overlap(boxOf(here.face), decision.box) >= SAME_FACE_IOU) {
        claimed.add(id);
        continue;
      }
      let match: FaceRef | null = null;
      let best = SAME_FACE_IOU;
      for (const face of candidates) {
        if (face.id === id || claimed.has(face.id)) continue;
        if (isHuman(this.decisions.get(face.id))) continue;
        const score = overlap(boxOf(face.face), decision.box);
        if (score >= best) {
          best = score;
          match = face;
        }
      }
      if (match) {
        claimed.add(match.id);
        moves.push([id, match.id]);
      } else if (here) this.dormant.add(id);
    }
    for (const [from, to] of moves) {
      // The human part moves; the automatic memory stays with each face id.
      const { person, not, box, auto, moved } = this.decisions.get(from)!;
      const target = this.decisions.get(to)?.auto;
      this.decisions.set(to, {
        ...(person !== undefined ? { person } : {}),
        ...(not?.length ? { not } : {}),
        ...(box ? { box } : {}),
        ...(moved ? { moved } : {}),
        ...(target ? { auto: target } : {}),
      });
      if (auto) this.decisions.set(from, { auto });
      else this.decisions.delete(from);
      this.dirty = true;
    }
    // A decision moved onto a face's id stops another from being dormant there.
    for (const [, to] of moves) this.dormant.delete(to);
  }

  private setAuto(faceId: string, person: string | null): void {
    const decision = this.decisions.get(faceId) ?? {};
    if (person === null) delete decision.auto;
    else decision.auto = person;
    this.decisions.set(faceId, decision);
    this.dirty = true;
  }

  private createPerson(): PersonRecord {
    const person: PersonRecord = {
      id: `p${this.next}`,
      name: null,
      confirmed: false,
      hidden: false,
    };
    this.next += 1;
    this.people.set(person.id, person);
    this.dirty = true;
    return person;
  }

  // ── Reading ──

  /** The body of `GET /photo-brain/v1/people`. */
  labels(): PeopleLabels {
    const decided: Record<string, string | null> = {};
    const previous: Record<string, string> = {};
    const not: Record<string, string[]> = {};
    for (const [id, decision] of this.decisions) {
      if (this.dormant.has(id)) continue;
      if (decision.person !== undefined) decided[id] = decision.person;
      if (decision.auto) previous[id] = decision.auto;
      if (decision.not?.length) not[id] = [...decision.not];
    }
    // The detector's box on a face the household moved describes the wrong
    // place (an arm, say), so it is no example of anybody; and a picture whose
    // faces do not matter is no example either.
    for (const face of this.faces) {
      if (this.dormant.has(face.id)) continue;
      const decision = this.decisions.get(face.id);
      if (
        decision?.moved ||
        (decision?.person === undefined && this.skipped.has(face.photoId))
      )
        decided[face.id] = null;
    }
    return {
      schema: 1,
      people: [...this.people.values()]
        .map((person) => ({ ...person }))
        .sort((a, b) => numeric(a.id, b.id)),
      decided,
      previous,
      not,
    };
  }

  /** The people each picture shows, by picture id; hidden people left out. */
  peopleByPhoto(): Map<string, string[]> {
    const out = new Map<string, Set<string>>();
    for (const face of this.faces) {
      const person = this.assignment.get(face.id);
      if (!person || this.people.get(person)?.hidden) continue;
      const set = out.get(face.photoId) ?? new Set<string>();
      set.add(person);
      out.set(face.photoId, set);
    }
    return new Map([...out].map(([photo, set]) => [photo, [...set].sort()]));
  }

  /** People with at least one face who are not hidden. */
  activeCount(): number {
    const used = new Set(this.assignment.values());
    let count = 0;
    for (const id of used) if (!this.people.get(id)?.hidden) count += 1;
    return count;
  }

  faceCount(): number {
    return this.faces.length;
  }

  person(id: string): PersonRecord | undefined {
    return this.people.get(id);
  }

  nameOf(id: string): string | null {
    return this.people.get(id)?.name ?? null;
  }

  view(): PeopleView {
    const members = new Map<string, FaceRef[]>();
    const unassigned: FaceRef[] = [];
    let ignored = 0;
    for (const face of this.faces) {
      if (this.isIgnored(face)) {
        ignored += 1;
        continue;
      }
      const person = this.assignment.get(face.id);
      if (person) {
        const list = members.get(person) ?? [];
        list.push(face);
        members.set(person, list);
      } else unassigned.push(face);
    }
    const weight = (f: FaceRef): number =>
      f.face.score * (0.5 + 0.5 * f.face.front) * f.face.w;
    const best = (a: FaceRef, b: FaceRef): number => weight(b) - weight(a);
    const people = [...this.people.values()]
      .map((person) => {
        const list = members.get(person.id) ?? [];
        return {
          ...person,
          faces: list.length,
          photos: new Set(list.map((f) => f.photoId)).size,
          samples: [...list].sort(best).slice(0, 24).map(this.sample),
        };
      })
      .sort(
        (a, b) =>
          Number(a.hidden) - Number(b.hidden) ||
          b.faces - a.faces ||
          numeric(a.id, b.id),
      );
    return {
      people,
      unassigned: {
        count: unassigned.length,
        samples: [...unassigned].sort(best).slice(0, 60).map(this.sample),
      },
      ignored,
      skippedPhotos: this.skippedPhotos(),
    };
  }

  /** A face as the panel shows it: where the household says it is. */
  private readonly sample = (face: FaceRef): FaceSample =>
    sampleOf(face, this.movedBox(face.id));

  private movedBox(faceId: string): Box | undefined {
    return this.dormant.has(faceId)
      ? undefined
      : this.decisions.get(faceId)?.moved;
  }

  /** The face is not wanted: said so, or its picture was marked and it was not decided. */
  private isIgnored(face: FaceRef): boolean {
    const decision = this.dormant.has(face.id)
      ? undefined
      : this.decisions.get(face.id);
    return (
      decision?.person === null ||
      (decision?.person === undefined && this.skipped.has(face.photoId))
    );
  }

  private skippedPhotos(): string[] {
    const here = new Set(this.faces.map((f) => f.photoId));
    return [...this.skipped].filter((id) => here.has(id)).slice(-60);
  }

  faceRef(faceId: string): FaceRef | undefined {
    return this.byId.get(faceId);
  }

  /** Where a face is: the household's box if it moved it, else the detector's. */
  faceBox(
    faceId: string,
  ): { x: number; y: number; w: number; h: number } | undefined {
    const ref = this.byId.get(faceId);
    if (!ref) return undefined;
    const moved = this.movedBox(faceId);
    return moved
      ? { x: moved[0], y: moved[1], w: moved[2], h: moved[3] }
      : { x: ref.face.x, y: ref.face.y, w: ref.face.w, h: ref.face.h };
  }

  // ── Review: every face of a picture, in its picture ──

  /** Pictures with a face nobody has placed, those with the most of them first. */
  review(): ReviewView {
    const byPhoto = new Map<string, FaceRef[]>();
    for (const face of this.faces) {
      const list = byPhoto.get(face.photoId) ?? [];
      list.push(face);
      byPhoto.set(face.photoId, list);
    }
    const photos: Array<{ photo: ReviewPhoto; open: number }> = [];
    for (const [id, list] of byPhoto) {
      const photo = this.reviewPhoto(id, list);
      const open = photo.faces.filter((f) => f.state === 'open').length;
      if (open > 0) photos.push({ photo, open });
    }
    photos.sort(
      (a, b) => b.open - a.open || a.photo.id.localeCompare(b.photo.id),
    );
    return {
      people: this.reviewPeople(),
      photos: photos.map((p) => p.photo),
    };
  }

  /** One picture with all its faces, for a face opened from the panel. */
  photoReview(photoId: string): { people: ReviewPerson[]; photo: ReviewPhoto } {
    const list = this.faces.filter((f) => f.photoId === photoId);
    if (!PHOTO_ID.test(photoId) || list.length === 0)
      throw new PeopleError('not_found', 'No such picture.');
    return {
      people: this.reviewPeople(),
      photo: this.reviewPhoto(photoId, list),
    };
  }

  private reviewPhoto(id: string, list: FaceRef[]): ReviewPhoto {
    const faces = list
      .map((ref): ReviewFace => {
        const ignored = this.isIgnored(ref);
        const person = ignored ? null : (this.assignment.get(ref.id) ?? null);
        const decision = this.dormant.has(ref.id)
          ? undefined
          : this.decisions.get(ref.id);
        return {
          ...this.sample(ref),
          state: ignored ? 'ignored' : person ? 'person' : 'open',
          person,
          auto: person !== null && decision?.person === undefined,
          moved: decision?.moved !== undefined,
        };
      })
      .sort(
        (a, b) => a.x + a.w / 2 - (b.x + b.w / 2) || (a.id < b.id ? -1 : 1),
      );
    return { id, skipped: this.skipped.has(id), faces };
  }

  private reviewPeople(): ReviewPerson[] {
    const counts = new Map<string, number>();
    const best = new Map<string, { id: string; weight: number }>();
    for (const face of this.faces) {
      const person = this.assignment.get(face.id);
      if (!person || this.isIgnored(face)) continue;
      counts.set(person, (counts.get(person) ?? 0) + 1);
      const weight =
        face.face.score * (0.5 + 0.5 * face.face.front) * face.face.w;
      if (weight > (best.get(person)?.weight ?? -1))
        best.set(person, { id: face.id, weight });
    }
    return [...this.people.values()]
      .filter((p) => !p.hidden && (p.name !== null || counts.has(p.id)))
      .map((p) => ({
        id: p.id,
        name: p.name,
        faces: counts.get(p.id) ?? 0,
        sample: best.get(p.id)?.id ?? null,
      }))
      .sort(
        (a, b) =>
          Number(b.name !== null) - Number(a.name !== null) ||
          b.faces - a.faces ||
          numeric(a.id, b.id),
      );
  }

  // ── Corrections (every one is a human decision and is kept) ──

  rename(personId: string, name: string | null): PersonRecord {
    const person = this.require(personId);
    person.name = cleanName(name);
    // Naming someone says the group is right.
    if (person.name) this.confirm(personId);
    this.dirty = true;
    return person;
  }

  /** "This group is one person": every current member is pinned to it. */
  confirm(personId: string): PersonRecord {
    const person = this.require(personId);
    person.confirmed = true;
    for (const [face, person2] of this.assignment)
      if (person2 === personId) this.decide(face, personId);
    this.dirty = true;
    return person;
  }

  setHidden(personId: string, hidden: boolean): PersonRecord {
    const person = this.require(personId);
    person.hidden = hidden;
    this.dirty = true;
    return person;
  }

  moveFace(faceId: string, target: MoveTarget): { person: string | null } {
    if (!FACE_ID.test(faceId) || !this.byId.has(faceId))
      throw new PeopleError('not_found', 'No such face.');
    if (target === 'open') {
      // Takes the household's decision back, and with it the people the face
      // was moved away from: the proposal and the grouping decide again, as
      // if nobody had looked.
      const decision = this.claim(faceId);
      delete decision.person;
      delete decision.not;
      this.decisions.set(faceId, decision);
      this.dirty = true;
      this.regroup(this.faces);
      return { person: this.assignment.get(faceId) ?? null };
    }
    const before = this.assignment.get(faceId);
    let person: string | null;
    if (target === 'none') person = null;
    else if (target === 'new') {
      person = this.createPerson().id;
    } else if ('named' in target) {
      person = this.personNamed(target.named).id;
    } else {
      this.require(target.person);
      person = target.person;
    }
    const decision = this.claim(faceId);
    if (before && before !== person) {
      const not = new Set(decision.not ?? []);
      not.add(before);
      decision.not = [...not].slice(-12);
    }
    decision.person = person;
    this.decisions.set(faceId, decision);
    if (person) this.assignment.set(faceId, person);
    else this.assignment.delete(faceId);
    this.dirty = true;
    return { person };
  }

  /**
   * Somebody who is called this (any case, and not hidden: a hidden person is
   * out of sight, so nothing is filed under them by accident), or a new,
   * confirmed person who is.
   */
  private personNamed(input: string): PersonRecord {
    const name = cleanName(input);
    if (!name) throw new PeopleError('invalid', 'Give the person a name.');
    for (const person of this.people.values())
      if (
        !person.hidden &&
        person.name?.toLocaleLowerCase('sv') === name.toLocaleLowerCase('sv')
      )
        return person;
    const person = this.createPerson();
    person.name = name;
    person.confirmed = true;
    return person;
  }

  /**
   * Moves a face's box to where the face really is (the detector put it on an
   * arm), or gives it back to the detector with `null`. The detector's idea of
   * who it is described the old place, so the face is left for the household
   * to place unless they already had.
   */
  setFaceBox(faceId: string, input: number[] | null): void {
    if (!FACE_ID.test(faceId) || !this.byId.has(faceId))
      throw new PeopleError('not_found', 'No such face.');
    const moved = input === null ? null : clampBox(input);
    if (input !== null && !moved)
      throw new PeopleError('invalid', 'That is not a box.');
    const decision = this.claim(faceId);
    if (moved) decision.moved = moved;
    else delete decision.moved;
    this.decisions.set(faceId, decision);
    this.dirty = true;
    if (moved && decision.person === undefined) this.assignment.delete(faceId);
    else if (!moved) this.regroup(this.faces);
  }

  /** "None of this picture's faces matter" (and the way back). */
  skipPhoto(photoId: string, skip: boolean): void {
    if (
      !PHOTO_ID.test(photoId) ||
      !this.faces.some((f) => f.photoId === photoId)
    )
      throw new PeopleError('not_found', 'No such picture.');
    if (skip === this.skipped.has(photoId)) return;
    if (skip) this.skipped.add(photoId);
    else this.skipped.delete(photoId);
    this.dirty = true;
    this.regroup(this.faces);
  }

  merge(fromId: string, intoId: string): PersonRecord {
    if (fromId === intoId)
      throw new PeopleError('invalid', 'Pick another person.');
    const from = this.require(fromId);
    const into = this.require(intoId);
    for (const [face, person] of [...this.assignment])
      if (person === fromId) {
        this.decide(face, intoId);
        this.assignment.set(face, intoId);
      }
    for (const [face, decision] of this.decisions) {
      if (decision.person === fromId) decision.person = intoId;
      if (decision.auto === fromId) decision.auto = intoId;
      if (decision.not?.includes(fromId))
        decision.not = decision.not.filter((id) => id !== fromId);
      this.decisions.set(face, decision);
    }
    if (!into.name && from.name) into.name = from.name;
    into.confirmed = into.confirmed || from.confirmed;
    this.people.delete(fromId);
    this.dirty = true;
    return into;
  }

  private decide(faceId: string, personId: string): void {
    const decision = this.claim(faceId);
    decision.person = personId;
    this.decisions.set(faceId, decision);
  }

  /**
   * The decision record of a face somebody now decides on: a dormant one
   * (made for another face) is replaced, and the face's box is kept with it.
   */
  private claim(faceId: string): FaceDecision {
    const existing = this.decisions.get(faceId);
    const decision: FaceDecision = this.dormant.has(faceId)
      ? existing?.auto
        ? { auto: existing.auto }
        : {}
      : (existing ?? {});
    this.dormant.delete(faceId);
    const face = this.byId.get(faceId);
    if (face) decision.box = boxOf(face.face);
    return decision;
  }

  private require(id: string): PersonRecord {
    const person = this.people.get(id);
    if (!person) throw new PeopleError('not_found', 'No such person.');
    return person;
  }
}

function cleanName(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const name = input.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  return name === '' ? null : name;
}

/** A box the household drew: kept inside the picture, and big enough to be one. */
function clampBox(input: ArrayLike<number>): Box | undefined {
  if (input.length !== 4) return undefined;
  const [x0, y0, w0, h0] = Array.from(input, Number);
  if (![x0, y0, w0, h0].every((n) => Number.isFinite(n))) return undefined;
  const x = Math.min(Math.max(x0!, 0), 1);
  const y = Math.min(Math.max(y0!, 0), 1);
  const w = Math.min(w0!, 1 - x);
  const h = Math.min(h0!, 1 - y);
  if (w < MIN_BOX || h < MIN_BOX) return undefined;
  const r = (n: number): number => Math.round(n * 10000) / 10000;
  return [r(x), r(y), r(w), r(h)];
}

function cleanBox(input: unknown): Box | undefined {
  if (!Array.isArray(input) || input.length !== 4) return undefined;
  const box = input.map(Number);
  if (box.some((n) => !Number.isFinite(n) || n < 0 || n > 1)) return undefined;
  if (box[2]! <= 0 || box[3]! <= 0) return undefined;
  return box as Box;
}
