import type {
  MusicAdapter,
  MusicCommand,
  MusicObservation,
} from './simulated-music.js';

export type MusicAdapterRoute = {
  targets: readonly string[];
  adapter: MusicAdapter;
};

/** Routes music commands, reads and subscriptions across multiple adapters by target. */
export class CompositeMusicAdapter implements MusicAdapter {
  private readonly byTarget = new Map<string, MusicAdapter>();
  private readonly adapters: MusicAdapter[];

  constructor(routes: readonly MusicAdapterRoute[]) {
    this.adapters = [];
    for (const route of routes) {
      if (!this.adapters.includes(route.adapter))
        this.adapters.push(route.adapter);
      for (const target of route.targets) {
        if (this.byTarget.has(target))
          throw new Error(`Duplicate music target route for ${target}`);
        this.byTarget.set(target, route.adapter);
      }
    }
  }

  async dispatch(command: MusicCommand, signal?: AbortSignal): Promise<void> {
    const adapter = this.byTarget.get(command.target);
    if (!adapter)
      throw new Error(`No music adapter is configured for ${command.target}`);
    await adapter.dispatch(command, signal);
  }

  async readStatus(
    target: string,
    signal?: AbortSignal,
  ): Promise<MusicObservation> {
    const adapter = this.byTarget.get(target);
    if (!adapter?.readStatus)
      throw new Error(`Music verification read is unavailable for ${target}`);
    return adapter.readStatus(target, signal);
  }

  subscribe(listener: (observation: MusicObservation) => void): () => void {
    const unsubscribes = this.adapters.map((adapter) =>
      adapter.subscribe(listener),
    );
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }
}
