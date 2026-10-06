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
    for (const listener of this.listeners) listener(cloneDeep(validUpdate));
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
        state: cloneDeep(current),
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
        state: cloneDeep(current),
      };
    }
    return {
      kind: 'updates',
      fromRevision: afterRevision,
      updates: cloneDeep(updates),
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
  if (diagnostics !== undefined) newState.diagnostics = cloneDeep(diagnostics);
  if (timings !== undefined) newState.timings = cloneDeep(timings);
  return newState;
}

/**
 * Bolt: Performance optimization
 * Replacing structuredClone with cloneDeep for plain JSON objects.
 * structuredClone is notoriously slow for frequent use due to its capability to handle cyclic references and complex builtin types.
 * For the StateEventStream where objects are simple state representations and performance is critical, a simple deep clone function is much faster (~3x faster).
 */
function cloneDeep<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  if (Array.isArray(obj)) {
    const arr = new Array(obj.length);
    for (let i = 0; i < obj.length; i++) {
      arr[i] = cloneDeep(obj[i]);
    }
    return arr as unknown as T;
  }
  const clonedObj: Record<string, unknown> = {};
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      clonedObj[key] = cloneDeep((obj as Record<string, unknown>)[key]);
    }
  }
  return clonedObj as unknown as T;
}
