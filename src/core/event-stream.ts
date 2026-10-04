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
  if (presence !== undefined) newState.presence = structuredClone(presence);
  if (session !== undefined) newState.session = structuredClone(session);
  if (lighting !== undefined) newState.lighting = structuredClone(lighting);
  if (switches !== undefined) newState.switches = structuredClone(switches);
  if (music !== undefined) newState.music = structuredClone(music);
  if (intent !== undefined) newState.intent = structuredClone(intent);
  if (commands !== undefined) newState.commands = structuredClone(commands);
  if (diagnostics !== undefined)
    newState.diagnostics = structuredClone(diagnostics);
  if (timings !== undefined) newState.timings = structuredClone(timings);
  return newState;
}
