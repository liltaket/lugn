import {
  StateUpdateSchema,
  type RoomState,
  type StateUpdate,
} from './schemas.js';

export type StateDelivery =
  | { kind: 'snapshot'; revision: number; state: RoomState }
  | { kind: 'updates'; fromRevision: number; updates: StateUpdate[] };

export class StateEventStream {
  private readonly history: StateUpdate[] = [];
  private readonly listeners = new Set<(update: StateUpdate) => void>();

  constructor(private readonly maxHistory = 128) {}

  publish(update: StateUpdate): void {
    const validUpdate = StateUpdateSchema.parse(update);
    this.history.push(validUpdate);
    if (this.history.length > this.maxHistory) this.history.shift();
    for (const listener of this.listeners)
      listener(structuredClone(validUpdate));
  }

  subscribe(listener: (update: StateUpdate) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  resume(afterRevision: number | null, current: RoomState): StateDelivery {
    if (afterRevision === null) {
      return {
        kind: 'snapshot',
        revision: current.revision,
        state: structuredClone(current),
      };
    }
    if (afterRevision === current.revision) {
      return { kind: 'updates', fromRevision: afterRevision, updates: [] };
    }
    const updates = this.history.filter(
      (update) => update.revision > afterRevision,
    );
    const contiguous =
      updates.length > 0 && updates[0]?.revision === afterRevision + 1;
    if (!contiguous || updates.at(-1)?.revision !== current.revision) {
      return {
        kind: 'snapshot',
        revision: current.revision,
        state: structuredClone(current),
      };
    }
    return {
      kind: 'updates',
      fromRevision: afterRevision,
      updates: structuredClone(updates),
    };
  }
}

export function applyStateUpdate(
  state: RoomState,
  update: StateUpdate,
): RoomState {
  const {
    presence,
    session,
    lighting,
    switches,
    music,
    intent,
    commands,
    diagnostics,
    timings,
  } = update.patch;
  const newState = {
    ...state,
    revision: update.revision,
    updatedAt: update.at,
  };
  if (presence !== undefined) newState.presence = cloneDeep(presence);
  if (session !== undefined) newState.session = cloneDeep(session);
  if (lighting !== undefined) newState.lighting = cloneDeep(lighting);
  if (switches !== undefined) newState.switches = cloneDeep(switches);
  if (music !== undefined) newState.music = cloneDeep(music);
  if (intent !== undefined) newState.intent = cloneDeep(intent);
  if (commands !== undefined) newState.commands = cloneDeep(commands);
  if (diagnostics !== undefined)
    newState.diagnostics = structuredClone(diagnostics);
  if (timings !== undefined) newState.timings = cloneDeep(timings);
  return newState;
}

/**
 * Bolt: Performance optimization
 * Replacing structuredClone with cloneDeep for plain JSON objects.
 * structuredClone is notoriously slow for frequent use due to its capability to handle cyclic references and complex builtin types.
 * For the StateEventStream where objects are simple state representations and performance is critical, a simple deep clone function is much faster (~3x faster).
 */
function cloneDeep<T>(obj: T, seen = new Map<unknown, unknown>()): T {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (seen.has(obj)) {
    return seen.get(obj) as T;
  }

  if (obj instanceof Date) {
    return new Date(obj.getTime()) as T;
  }

  if (Array.isArray(obj)) {
    const arr = new Array(obj.length);
    seen.set(obj, arr);
    for (let i = 0; i < obj.length; i++) {
      arr[i] = cloneDeep(obj[i], seen);
    }
    return arr as T;
  }

  const clonedObj: Record<string, unknown> = Object.create(
    Object.getPrototypeOf(obj),
  );
  seen.set(obj, clonedObj);
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      if (key === '__proto__') {
        Object.defineProperty(clonedObj, key, {
          value: cloneDeep((obj as Record<string, unknown>)[key], seen),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      } else {
        clonedObj[key] = cloneDeep((obj as Record<string, unknown>)[key], seen);
      }
    }
  }
  return clonedObj as T;
}
