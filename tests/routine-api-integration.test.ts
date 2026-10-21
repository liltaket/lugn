import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SimulatedLightingAdapter } from '../src/adapters/simulated-lighting.js';
import { CapabilityRegistry } from '../src/application/capabilities.js';
import { ExperienceRequestError } from '../src/application/experience-api.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { RoutineService } from '../src/application/routines.js';
import { FakeClock } from '../src/core/clock.js';
import {
  createRoutineTemplates,
  type RoutineDefinition,
} from '../src/core/routines.js';
import { RoutineApi } from '../src/runtime/routine-api.js';
import { RoutineStore } from '../src/runtime/routine-store.js';

const human = {
  actor: { type: 'user' as const, id: 'test-ui' },
  source: 'isolated-test',
};
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('routine API integration with existing capability ownership', () => {
  let directory: string;
  let service: RoutineService | undefined;
  let engine: LugnEngine | undefined;
  afterEach(async () => {
    service?.dispose();
    engine?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function fixture() {
    directory = await mkdtemp(join(tmpdir(), 'lugn-routine-api-'));
    const clock = new FakeClock(Date.parse('2026-10-20T18:00:00Z'));
    const adapter = new SimulatedLightingAdapter(clock);
    engine = new LugnEngine(clock, {
      deviceIds: ['lighting.bed'],
      scenes: [],
      adapter,
    });
    const capabilities = new CapabilityRegistry(engine);
    const store = new RoutineStore(
      join(directory, 'routines.json'),
      createRoutineTemplates({ lightTargets: ['lighting.bed'] }),
    );
    await store.load();
    service = new RoutineService(clock, { engine, capabilities, store });
    const api = new RoutineApi(service, store);
    return { clock, adapter, engine, capabilities, store, api, service };
  }

  it('ships disabled templates and persists edits without executing previews or saves', async () => {
    const f = await fixture();
    const initial = f.service.snapshot();
    expect(initial.definitions.every((d) => !d.enabled)).toBe(true);
    expect(initial.next).toEqual([]);
    await expect(
      f.api.request(
        'routines/action',
        { id: 'good-night', action: 'start' },
        human,
      ),
    ).rejects.toMatchObject({ status: 409, code: 'routine_disabled' });
    const definition: RoutineDefinition = {
      ...initial.definitions[0]!,
      enabled: true,
      steps: [
        { type: 'delay', durationMs: 5000 },
        {
          type: 'light',
          targets: ['lighting.bed'],
          brightness: 0,
          durationMs: 0,
        },
      ],
    };
    const preview = await f.api.request(
      'routines/preview',
      { definition },
      human,
    );
    expect(preview).toMatchObject({ durationMs: 5000 });
    await f.api.request(
      'routines/save',
      { definition, expectedGeneration: initial.generation },
      human,
    );
    expect(f.adapter.dispatched).toHaveLength(0);
    const restored = new RoutineStore(join(directory, 'routines.json'));
    expect(
      (await restored.load()).definitions.find((d) => d.id === definition.id),
    ).toEqual(definition);
    await expect(
      f.api.request(
        'routines/delete',
        { id: definition.id, expectedGeneration: initial.generation },
        human,
      ),
    ).rejects.toBeInstanceOf(ExperienceRequestError);
    expect(f.service.snapshot().definitions).toContainEqual(definition);
  });

  it('routes explicit manual intervention through the engine and cancels future routine steps', async () => {
    const f = await fixture();
    const definition: RoutineDefinition = {
      id: 'delayed-off',
      name: 'Släck senare',
      kind: 'custom',
      enabled: true,
      schedule: null,
      steps: [
        { type: 'delay', durationMs: 5000 },
        {
          type: 'light',
          targets: ['lighting.bed'],
          brightness: 0,
          durationMs: 0,
        },
      ],
    };
    await f.api.request(
      'routines/save',
      { definition, expectedGeneration: f.store.snapshot().generation },
      human,
    );
    await f.api.request(
      'routines/action',
      { id: definition.id, action: 'start', requestId: 'night-once' },
      human,
    );
    await flush();
    await f.capabilities.invoke(
      'lighting.set',
      { target: 'lighting.bed', values: { power: true, brightness: 60 } },
      human,
    );
    const afterHuman = f.adapter.dispatched.length;
    f.clock.advanceBy(10_000);
    await flush();
    expect(f.adapter.dispatched).toHaveLength(afterHuman);
    expect(f.service.snapshot().runs).toContainEqual(
      expect.objectContaining({
        routineId: definition.id,
        status: 'cancelled',
      }),
    );
    expect(
      f.engine.state.lighting.devices['lighting.bed']!.effectiveDesired,
    ).toMatchObject({ power: true, brightness: 60 });
  });

  it('drops running work on disposal and never replays it after reloading persisted definitions', async () => {
    const f = await fixture();
    const definition: RoutineDefinition = {
      id: 'after-restart',
      name: 'Vänta',
      kind: 'custom',
      enabled: true,
      schedule: null,
      steps: [
        { type: 'delay', durationMs: 5000 },
        {
          type: 'light',
          targets: ['lighting.bed'],
          brightness: 0,
          durationMs: 0,
        },
      ],
    };
    await f.api.request(
      'routines/save',
      { definition, expectedGeneration: f.store.snapshot().generation },
      human,
    );
    await f.api.request(
      'routines/action',
      { id: definition.id, action: 'start' },
      human,
    );
    await flush();
    f.service.dispose();
    const restored = new RoutineStore(join(directory, 'routines.json'));
    await restored.load();
    service = new RoutineService(f.clock, {
      engine: f.engine,
      capabilities: f.capabilities,
      store: restored,
    });
    f.clock.advanceBy(60_000);
    await flush();
    expect(service.snapshot().runs).toEqual([]);
    expect(f.adapter.dispatched).toHaveLength(0);
  });
});
