import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { StoredFace } from './analysis-store.js';
import { dot, normalize } from './faces.js';

/**
 * Who is who. Faces from the analysis are grouped by similarity into people,
 * and what the household says always wins: a name, a confirmed group, a face
 * moved to someone else, "not a face". Those decisions are saved and never
 * overridden by the automatic grouping, which only fills in what nobody has
 * decided and keeps its own earlier choices stable.
 */
export type FaceRef = {
  /** `<photo id>.<index>`; stable because a picture's analysis never changes. */
  id: string;
  photoId: string;
  face: StoredFace;
};

export type PersonRecord = {
  id: string;
  name: string | null;
  /** Somebody looked at this group and said it is one person. */
  confirmed: boolean;
  /** Not shown or used (a stranger in the background, say). */
  hidden: boolean;
};
type FaceDecision = {
  /** The person a human chose; `null` means "not a person worth tracking". */
  person?: string | null;
  /** The automatic grouping's own choice, remembered so ids stay stable. */
  auto?: string;
  /** People this face was moved away from; the automatic grouping skips them. */
  not?: string[];
};
type PeopleFile = {
  version: 1;
  next: number;
  people: Record<string, PersonRecord>;
  faces: Record<string, FaceDecision>;
};

/** Cosine similarity needed to join an existing person, and to keep a place. */
export const ASSIGN_THRESHOLD = 0.4;
export const KEEP_THRESHOLD = 0.3;
/** Average cosine similarity for faces to form a new person together. */
export const LINK_THRESHOLD = 0.38;
/** Faces below these only join people who are already there. */
const SEED_MIN_SCORE = 0.75;
const SEED_MIN_FRONT = 0.3;
const PERSON_ID = /^p\d{1,6}$/;
const FACE_ID = /^[A-Za-z0-9_-]{24}\.\d{1,2}$/;
const MAX_NAME = 40;

/** One face as the panel shows it: where it is, and in which picture. */
export type FaceSample = {
  id: string;
  photoId: string;
  x: number;
  y: number;
  w: number;
  h: number;
};
const sampleOf = (face: FaceRef): FaceSample => ({
  id: face.id,
  photoId: face.photoId,
  x: face.face.x,
  y: face.face.y,
  w: face.face.w,
  h: face.face.h,
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
};

export type MoveTarget = { person: string } | 'new' | 'none';

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

export class PeopleStore {
  private people = new Map<string, PersonRecord>();
  private decisions = new Map<string, FaceDecision>();
  private next = 1;
  private dirty = false;
  /** The latest grouping: face id → person id. */
  private assignment = new Map<string, string>();
  private faces: FaceRef[] = [];

  constructor(
    private readonly path: string,
    private readonly warn: (message: string) => void = () => undefined,
  ) {}

  async load(): Promise<void> {
    this.people.clear();
    this.decisions.clear();
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
          kept.not = decision.not.filter((id) => PERSON_ID.test(id));
        this.decisions.set(face, kept);
      }
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
            d.person !== undefined || d.auto !== undefined || d.not?.length,
        ),
      ),
    };
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = join(dirname(this.path), `.people.${process.pid}.tmp`);
    await writeFile(temporary, JSON.stringify(file), { mode: 0o600 });
    await rename(temporary, this.path);
    this.dirty = false;
  }

  // ── Grouping ──

  /** Re-groups `faces`; decisions made by people are left exactly as they are. */
  regroup(faces: FaceRef[]): void {
    this.faces = faces;
    const byId = new Map(faces.map((f) => [f.id, f]));
    // Faces whose picture left the library lose their automatic memory only.
    for (const [id, decision] of [...this.decisions])
      if (
        !byId.has(id) &&
        decision.person === undefined &&
        !decision.not?.length
      ) {
        this.decisions.delete(id);
        this.dirty = true;
      }

    const assignment = new Map<string, string>();
    const sums = new Map<string, Float32Array>();
    const counts = new Map<string, number>();
    const add = (person: string, face: FaceRef, weight: number): void => {
      const sum =
        sums.get(person) ?? new Float32Array(face.face.embedding.length);
      for (let i = 0; i < sum.length; i += 1)
        sum[i] = sum[i]! + face.face.embedding[i]! * weight;
      sums.set(person, sum);
      counts.set(person, (counts.get(person) ?? 0) + 1);
    };
    const weightOf = (face: FaceRef): number =>
      0.4 + 0.6 * Math.min(1, face.face.score) * (0.5 + 0.5 * face.face.front);

    // 1. What people decided.
    const open: FaceRef[] = [];
    for (const face of faces) {
      const decision = this.decisions.get(face.id);
      if (decision?.person === null) continue;
      if (
        typeof decision?.person === 'string' &&
        this.people.has(decision.person)
      ) {
        assignment.set(face.id, decision.person);
        add(decision.person, face, 1);
      } else open.push(face);
    }
    // Centroids from decided faces; people with none yet start from their
    // earlier automatic members.
    const decided = new Set(sums.keys());
    for (const face of open) {
      const earlier = this.decisions.get(face.id)?.auto;
      if (earlier && this.people.has(earlier) && !decided.has(earlier))
        add(earlier, face, weightOf(face));
    }
    const centroids = (): Map<string, Float32Array> => {
      const out = new Map<string, Float32Array>();
      for (const [person, sum] of sums) out.set(person, normalize(sum));
      return out;
    };

    // 2. Open faces: keep an earlier place, else join the best person.
    const centres = centroids();
    const pool: FaceRef[] = [];
    const ordered = [...open].sort((a, b) => weightOf(b) - weightOf(a));
    for (const face of ordered) {
      const decision = this.decisions.get(face.id);
      const blocked = new Set(decision?.not ?? []);
      const earlier = decision?.auto;
      let chosen: string | null = null;
      if (earlier && this.people.has(earlier) && !blocked.has(earlier)) {
        const centre = centres.get(earlier);
        if (centre && dot(face.face.embedding, centre) >= KEEP_THRESHOLD)
          chosen = earlier;
      }
      if (!chosen) {
        let best = ASSIGN_THRESHOLD;
        for (const [person, centre] of centres) {
          if (blocked.has(person)) continue;
          const similarity = dot(face.face.embedding, centre);
          if (similarity >= best) {
            best = similarity;
            chosen = person;
          }
        }
      }
      if (chosen) {
        assignment.set(face.id, chosen);
        if (!(this.decisions.get(face.id)?.auto === chosen))
          this.setAuto(face.id, chosen);
      } else pool.push(face);
    }

    // 3. Who is left and clear enough starts new people, two or more at a time.
    const seeds = pool.filter(
      (f) => f.face.score >= SEED_MIN_SCORE && f.face.front >= SEED_MIN_FRONT,
    );
    for (const group of linkFaces(seeds, LINK_THRESHOLD)) {
      if (group.length < 2) continue;
      // A group that mostly agreed on an older person that has gone keeps no
      // memory of it; it gets a fresh id.
      const person = this.createPerson();
      for (const face of group) {
        assignment.set(face.id, person.id);
        this.setAuto(face.id, person.id);
      }
    }
    for (const face of pool)
      if (!assignment.has(face.id) && this.decisions.get(face.id)?.auto) {
        this.setAuto(face.id, null);
      }

    // 4. People nobody named, confirmed or decided on, and who have no faces, go.
    const used = new Set(assignment.values());
    for (const person of [...this.people.values()]) {
      if (used.has(person.id) || person.name || person.confirmed) continue;
      this.people.delete(person.id);
      this.dirty = true;
    }
    this.assignment = assignment;
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
      if (this.decisions.get(face.id)?.person === null) {
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
    const best = (a: FaceRef, b: FaceRef): number =>
      b.face.score * (0.5 + 0.5 * b.face.front) * b.face.w -
      a.face.score * (0.5 + 0.5 * a.face.front) * a.face.w;
    const people = [...this.people.values()]
      .map((person) => {
        const list = members.get(person.id) ?? [];
        return {
          ...person,
          faces: list.length,
          photos: new Set(list.map((f) => f.photoId)).size,
          samples: [...list].sort(best).slice(0, 24).map(sampleOf),
        };
      })
      .sort(
        (a, b) =>
          Number(a.hidden) - Number(b.hidden) ||
          b.faces - a.faces ||
          a.id.localeCompare(b.id, 'en', { numeric: true }),
      );
    return {
      people,
      unassigned: {
        count: unassigned.length,
        samples: [...unassigned].sort(best).slice(0, 60).map(sampleOf),
      },
      ignored,
    };
  }

  faceRef(faceId: string): FaceRef | undefined {
    return this.faces.find((f) => f.id === faceId);
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
    if (!FACE_ID.test(faceId) || !this.faces.some((f) => f.id === faceId))
      throw new PeopleError('not_found', 'No such face.');
    const before = this.assignment.get(faceId);
    let person: string | null;
    if (target === 'none') person = null;
    else if (target === 'new') {
      person = this.createPerson().id;
    } else {
      this.require(target.person);
      person = target.person;
    }
    const decision = this.decisions.get(faceId) ?? {};
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
    const decision = this.decisions.get(faceId) ?? {};
    decision.person = personId;
    this.decisions.set(faceId, decision);
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

/**
 * Average-linkage agglomerative grouping: merges the two groups whose faces
 * agree most, while that average stays at or above `threshold`. Pair sums are
 * kept and updated on every merge, so the work is O(n²) per merge.
 */
export function linkFaces(faces: FaceRef[], threshold: number): FaceRef[][] {
  const n = faces.length;
  const sums = new Float64Array(n * n);
  for (let i = 0; i < n; i += 1)
    for (let j = i + 1; j < n; j += 1) {
      const value = dot(faces[i]!.face.embedding, faces[j]!.face.embedding);
      sums[i * n + j] = value;
      sums[j * n + i] = value;
    }
  const members: FaceRef[][] = faces.map((face) => [face]);
  const alive = new Array<boolean>(n).fill(true);
  for (;;) {
    let best = threshold;
    let a = -1;
    let b = -1;
    for (let i = 0; i < n; i += 1) {
      if (!alive[i]) continue;
      for (let j = i + 1; j < n; j += 1) {
        if (!alive[j]) continue;
        const value =
          sums[i * n + j]! / (members[i]!.length * members[j]!.length);
        if (value >= best) {
          best = value;
          a = i;
          b = j;
        }
      }
    }
    if (a < 0) break;
    for (let k = 0; k < n; k += 1) {
      if (!alive[k] || k === a || k === b) continue;
      const merged = sums[a * n + k]! + sums[b * n + k]!;
      sums[a * n + k] = merged;
      sums[k * n + a] = merged;
    }
    members[a] = members[a]!.concat(members[b]!);
    alive[b] = false;
  }
  return members.filter((_, i) => alive[i]);
}
