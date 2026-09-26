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
  const { presence, lighting, commands, diagnostics, timings } = update.patch;
  return {
    ...structuredClone(state),
    ...(presence === undefined ? {} : { presence: structuredClone(presence) }),
    ...(lighting === undefined ? {} : { lighting: structuredClone(lighting) }),
    ...(commands === undefined ? {} : { commands: structuredClone(commands) }),
    ...(diagnostics === undefined
      ? {}
      : { diagnostics: structuredClone(diagnostics) }),
    ...(timings === undefined ? {} : { timings: structuredClone(timings) }),
    revision: update.revision,
    updatedAt: update.at,
  };
}
