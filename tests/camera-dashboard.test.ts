import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CameraDashboardService } from '../src/application/camera-dashboard.js';
import {
  CameraDashboardConfigSchema,
  createCameraSettings,
  type CameraDashboardConfig,
} from '../src/core/cameras.js';
import { FakeClock, type TimerHandle } from '../src/core/clock.js';
import { CameraSettingsStore } from '../src/runtime/camera-settings-store.js';
const config: CameraDashboardConfig = {
  cameras: [
    { id: 'entry', name: 'Entré', entityId: 'camera.entry' },
    { id: 'front', name: 'Framsida', entityId: 'camera.front' },
  ],
  triggers: [
    {
      id: 'motion',
      name: 'Rörelse vid entrén',
      cameraId: 'entry',
      kind: 'state',
      entityId: 'binary_sensor.motion',
      from: 'off',
      to: 'on',
    },
    {
      id: 'gate',
      name: 'Grind',
      cameraId: 'front',
      kind: 'automation',
      entityId: 'automation.gate_sound',
    },
    {
      id: 'cue',
      name: 'Grindljud',
      cameraId: 'entry',
      kind: 'service',
      domain: 'media_player',
      service: 'play_media',
      entityId: 'media_player.hall',
      mediaContentId: '/private/gate-sound.mp3',
    },
  ],
};
const directories: string[] = [];
const services: CameraDashboardService[] = [];
afterEach(async () => {
  services.splice(0).forEach((service) => service.dispose());
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function setup(
  enabled = true,
  definitions: CameraDashboardConfig = config,
  clock = new FakeClock(Date.parse('2026-10-21T12:00:00Z')),
) {
  const directory = await mkdtemp(join(tmpdir(), 'camera-dashboard-'));
  directories.push(directory);
  const store = new CameraSettingsStore(
    join(directory, 'cameras.json'),
    createCameraSettings(definitions),
  );
  await store.load();
  const service = new CameraDashboardService(definitions, store, clock);
  services.push(service);
  if (enabled)
    await service.updateSettings(
      {
        ...store.snapshot().settings,
        enabled: true,
        automaticEnabled: true,
        triggers: Object.fromEntries(
          definitions.triggers.map((trigger) => [trigger.id, true]),
        ),
      },
      store.snapshot().generation,
    );
  service.setConnected(true);
  service.seedStates([
    { entity_id: 'camera.entry', state: 'idle' },
    { entity_id: 'camera.front', state: 'streaming' },
    ...definitions.triggers
      .filter((trigger) => trigger.kind === 'state')
      .map((trigger) => ({ entity_id: trigger.entityId, state: 'off' })),
  ]);
  const event = (event_type: string, data: unknown, time = clock.now()) => ({
    event_type,
    data,
    time_fired: new Date(time).toISOString(),
    context: { id: 'context' },
  });
  const motion = (from = 'off', to = 'on', time = clock.now()) =>
    service.acceptEvent(
      event(
        'state_changed',
        {
          entity_id: 'binary_sensor.motion',
          old_state: { state: from },
          new_state: { state: to },
        },
        time,
      ),
    );
  const gate = () =>
    service.acceptEvent(
      event('automation_triggered', { entity_id: 'automation.gate_sound' }),
    );
  return { service, store, clock, event, motion, gate };
}
it('defaults to disabled, with camera selection available but all triggers opted out', async () => {
  const { service, motion } = await setup(false);
  motion();
  expect(service.snapshot('bed')).toMatchObject({
    settings: { enabled: false, automaticEnabled: false, durationSeconds: 30 },
    active: null,
  });
  expect(() => service.show('desk', 'entry')).toThrow(
    'camera_unavailable_or_disabled',
  );
});
it('shows a fresh edge for 30 seconds without extending for another event or stealing the current view', async () => {
  const { service, motion, gate, clock } = await setup();
  motion();
  motion('on', 'off');
  const active = service.snapshot('desk').active;
  expect(active).toMatchObject({
    cameraId: 'entry',
    manual: false,
    expiresAt: clock.now() + 30_000,
  });
  clock.advanceBy(20_000);
  gate();
  expect(service.snapshot('desk').active).toEqual(active);
  clock.advanceBy(10_000);
  expect(service.snapshot('desk').active).toBeNull();
  expect(clock.pendingTimers()).toBe(0);
});
it('manual selection takes priority and a dismissal suppresses automatic reopen for 60 seconds', async () => {
  const { service, motion, gate, clock } = await setup();
  service.show('bed', 'front');
  motion();
  expect(service.snapshot('bed').active).toMatchObject({
    cameraId: 'front',
    manual: true,
  });
  service.dismiss('bed');
  gate();
  expect(service.snapshot('bed').active).toBeNull();
  clock.advanceBy(60_000);
  gate();
  expect(service.snapshot('bed').active?.cameraId).toBe('front');
});
it('still permits manual opening during event cooldown and allows dismissing an empty view', async () => {
  const { service, motion } = await setup();
  service.dismiss('desk');
  motion();
  expect(service.snapshot('desk').active).toBeNull();
  expect(service.show('desk', 'front').active?.manual).toBe(true);
  expect(service.dismiss('desk').active).toBeNull();
});
it.each([-10_001, 5_001])(
  'rejects stale or future events at delta %s',
  async (delta) => {
    const { service, motion, clock } = await setup();
    motion('off', 'on', clock.now() + delta);
    expect(service.snapshot('web').active).toBeNull();
  },
);
it('never treats unknown transitions, initial observations or reconnect seeding as edges', async () => {
  const { service, motion, clock } = await setup();
  motion('unknown', 'on');
  expect(service.snapshot('web').active).toBeNull();
  service.setConnected(false);
  motion();
  service.setConnected(true);
  motion();
  expect(service.snapshot('web').active).toBeNull();
  service.seedStates([
    { entity_id: 'camera.entry', state: 'idle' },
    { entity_id: 'binary_sensor.motion', state: 'on' },
  ]);
  expect(service.snapshot('web').active).toBeNull();
  clock.advanceBy(1);
  motion('on', 'off');
  motion();
  expect(service.snapshot('web').active?.cameraId).toBe('entry');
});
it('clears on disconnection or camera unavailability, and rejects out of order edges', async () => {
  const { service, motion, clock, event } = await setup();
  clock.advanceBy(2_000);
  motion('off', 'off');
  motion('off', 'on', clock.now() - 1000);
  expect(service.snapshot('desk').active).toBeNull();
  motion();
  expect(service.snapshot('desk').active).not.toBeNull();
  service.acceptEvent(
    event('state_changed', {
      entity_id: 'camera.entry',
      old_state: { state: 'idle' },
      new_state: { state: 'unavailable' },
    }),
  );
  expect(service.snapshot('desk').active).toBeNull();
  expect(() => service.show('bed', 'entry')).toThrow();
  service.show('bed', 'front');
  service.setConnected(false);
  expect(service.snapshot('bed').active).toBeNull();
});
it('observes an exact gate sound call passively without triggering on other sounds or speakers', async () => {
  const { service, event } = await setup();
  const data = {
    domain: 'media_player',
    service: 'play_media',
    service_data: {
      entity_id: 'media_player.hall',
      media_content_id: 'other.mp3',
    },
  };
  service.acceptEvent(event('call_service', data));
  expect(service.snapshot('desk').active).toBeNull();
  data.service_data.media_content_id = '/private/gate-sound.mp3';
  data.service_data.entity_id = 'media_player.other';
  service.acceptEvent(event('call_service', data));
  expect(service.snapshot('desk').active).toBeNull();
  data.service_data.entity_id = 'media_player.hall';
  service.acceptEvent(event('call_service', data));
  expect(service.snapshot('desk').active?.reason).toBe('Grindljud');
  expect(JSON.stringify(service.snapshot('desk'))).not.toMatch(
    /private|entity_id|media_player|automation\./,
  );
});
it('persisted opt-out clears existing views and new service instances never replay active views', async () => {
  const { service, store, motion, clock } = await setup();
  motion();
  expect(clock.pendingTimers()).toBe(3);
  await service.updateSettings(
    { ...store.snapshot().settings, enabled: false },
    store.snapshot().generation,
  );
  expect(service.snapshot('bed').active).toBeNull();
  expect(clock.pendingTimers()).toBe(0);
  const restarted = new CameraDashboardService(config, store, clock);
  services.push(restarted);
  expect(restarted.snapshot('bed').active).toBeNull();
  expect(restarted.snapshot('bed').settings.enabled).toBe(false);
});
it('respects selected viewers, cameras and triggers, and rejects unknown config ids', async () => {
  const { service, store, motion, gate } = await setup();
  await service.updateSettings(
    {
      ...store.snapshot().settings,
      viewers: ['desk'],
      cameras: { entry: true, front: false },
      triggers: { motion: true, gate: false, cue: false },
    },
    store.snapshot().generation,
  );
  gate();
  expect(service.snapshot('desk').active).toBeNull();
  motion();
  expect(service.snapshot('desk').active?.cameraId).toBe('entry');
  expect(service.snapshot('bed').active).toBeNull();
  expect(() => service.show('desk', 'front')).toThrow();
  await expect(
    service.updateSettings(
      { ...store.snapshot().settings, cameras: { missing: true } },
      store.snapshot().generation,
    ),
  ).rejects.toMatchObject({ status: 400 });
});
it('configuration bounds IDs, definitions and references', () => {
  expect(CameraDashboardConfigSchema.safeParse(config).success).toBe(true);
  expect(
    CameraDashboardConfigSchema.safeParse({
      ...config,
      cameras: [config.cameras[0], config.cameras[0]],
    }).success,
  ).toBe(false);
  expect(
    CameraDashboardConfigSchema.safeParse({ ...config, cameras: [] }).success,
  ).toBe(false);
  expect(
    CameraDashboardConfigSchema.safeParse({
      ...config,
      cameras: [{ id: 'url', name: 'URL', entityId: 'https://private/' }],
    }).success,
  ).toBe(false);
});
it('subscriber failures cannot interrupt dismissal or future observations', async () => {
  const { service, motion } = await setup();
  service.subscribe(() => {
    throw new Error('broken listener');
  });
  motion();
  expect(service.dismiss('desk').active).toBeNull();
});

const classifiedConfig: CameraDashboardConfig = {
  cameras: config.cameras,
  triggers: ['person', 'animal', 'vehicle'].map((kind) => ({
    id: kind,
    name: `Detected ${kind}`,
    cameraId: 'entry',
    kind: 'state' as const,
    entityId: `binary_sensor.entry_${kind}`,
    from: 'off' as const,
    to: 'on' as const,
  })),
};
it.each(['person', 'animal', 'vehicle'])(
  'uses the configured native %s detector and ignores generic motion on either camera',
  async (kind) => {
    const { service, event, clock } = await setup(true, classifiedConfig);
    const edge = (entity: string, from = 'off', to = 'on') =>
      service.acceptEvent(
        event('state_changed', {
          entity_id: entity,
          old_state: { state: from },
          new_state: { state: to },
        }),
      );
    for (let n = 0; n < 20; n++) {
      for (const entity of [
        'binary_sensor.entry_motion',
        'binary_sensor.front_motion',
      ]) {
        edge(entity);
        edge(entity, 'on', 'off');
      }
      clock.advanceBy(100);
    }
    expect(service.snapshot('bed').active).toBeNull();
    edge(`binary_sensor.entry_${kind}`);
    expect(service.snapshot('bed').active).toMatchObject({
      cameraId: 'entry',
      reason: `Detected ${kind}`,
      manual: false,
      expiresAt: clock.now() + 60_000,
    });
    edge(`binary_sensor.entry_${kind}`, 'on', 'off');
    clock.advanceBy(30_000);
    expect(service.snapshot('bed').active).toBeNull();
    edge('binary_sensor.front_motion');
    expect(service.snapshot('bed').active).toBeNull();
    expect(service.show('bed', 'front').active).toMatchObject({
      cameraId: 'front',
      manual: true,
    });
  },
);
it('never falls back to raw motion when an object detector is unavailable', async () => {
  const { service, event } = await setup(true, classifiedConfig);
  const edge = (entity: string, from: string, to: string) =>
    service.acceptEvent(
      event('state_changed', {
        entity_id: entity,
        old_state: { state: from },
        new_state: { state: to },
      }),
    );
  edge('binary_sensor.entry_person', 'off', 'unavailable');
  edge('binary_sensor.entry_motion', 'off', 'on');
  edge('binary_sensor.entry_person', 'unavailable', 'on');
  expect(service.snapshot('desk').active).toBeNull();
});

function classifiedEdge(
  s: Awaited<ReturnType<typeof setup>>,
  kind: string,
  from = 'off',
  to = 'on',
  time = s.clock.now(),
) {
  s.service.acceptEvent(
    s.event(
      'state_changed',
      {
        entity_id: `binary_sensor.entry_${kind}`,
        old_state: { state: from },
        new_state: { state: to },
      },
      time,
    ),
  );
}
it('advertises sustained activity extension before the minimum and locks only one fixed extension at 30 seconds', async () => {
  const s = await setup(true, classifiedConfig);
  classifiedEdge(s, 'person');
  const initial = s.service.snapshot('bed').active!;
  expect(initial.expiresAt).toBe(s.clock.now() + 60_000);
  s.clock.advanceBy(30_000);
  expect(s.service.snapshot('bed').active).toEqual(initial);
  s.clock.advanceBy(5_000);
  classifiedEdge(s, 'person', 'on', 'off');
  expect(s.service.snapshot('bed').active).toEqual(initial);
  s.clock.advanceBy(24_999);
  expect(s.service.snapshot('bed').active).not.toBeNull();
  s.clock.advanceBy(1);
  expect(s.service.snapshot('bed').active).toBeNull();
  expect(s.clock.pendingTimers()).toBe(0);
});
it('returns to the original minimum when activity ends before 30 seconds', async () => {
  const s = await setup(true, classifiedConfig);
  classifiedEdge(s, 'person');
  const id = s.service.snapshot('bed').active!.id;
  s.clock.advanceBy(10_000);
  classifiedEdge(s, 'person', 'on', 'off');
  expect(s.service.snapshot('bed').active).toMatchObject({
    id,
    expiresAt: s.clock.now() + 20_000,
  });
  s.clock.advanceBy(20_000);
  expect(s.service.snapshot('bed').active).toBeNull();
});
it('counts only enabled categories for the same camera and permits a different category to sustain the view', async () => {
  const s = await setup(true, classifiedConfig);
  await s.service.updateSettings(
    {
      ...s.store.snapshot().settings,
      triggers: { person: true, animal: true, vehicle: false },
    },
    s.store.snapshot().generation,
  );
  const start = s.clock.now();
  s.service.show('bed', 'entry');
  classifiedEdge(s, 'vehicle');
  expect(s.service.snapshot('bed').active!.expiresAt).toBe(start + 30_000);
  classifiedEdge(s, 'person');
  classifiedEdge(s, 'animal');
  s.clock.advanceBy(10_000);
  classifiedEdge(s, 'person', 'on', 'off');
  expect(s.service.snapshot('bed').active!.expiresAt).toBe(start + 60_000);
  classifiedEdge(s, 'animal', 'on', 'off');
  expect(s.service.snapshot('bed').active!.expiresAt).toBe(start + 30_000);
  s.service.show('desk', 'front');
  classifiedEdge(s, 'person');
  expect(s.service.snapshot('desk').active!.expiresAt).toBe(
    s.clock.now() + 30_000,
  );
});
it('uses trusted seeded activity for a manually opened view without replaying an automatic event', async () => {
  const s = await setup(true, classifiedConfig);
  s.service.seedStates([
    { entity_id: 'camera.entry', state: 'idle' },
    { entity_id: 'binary_sensor.entry_person', state: 'on' },
  ]);
  expect(s.service.snapshot('bed').active).toBeNull();
  const view = s.service.show('bed', 'entry').active!;
  expect(view).toMatchObject({
    manual: true,
    expiresAt: s.clock.now() + 60_000,
  });
  s.clock.advanceBy(60_000);
  expect(s.service.snapshot('bed').active).toBeNull();
});
it('never extends from stale reports, unavailable detectors, or unrelated raw motion', async () => {
  const s = await setup(true, classifiedConfig);
  s.service.show('bed', 'entry');
  classifiedEdge(s, 'person', 'off', 'on', s.clock.now() - 10_001);
  s.service.acceptEvent(
    s.event('state_changed', {
      entity_id: 'binary_sensor.entry_motion',
      old_state: { state: 'off' },
      new_state: { state: 'on' },
    }),
  );
  expect(s.service.snapshot('bed').active!.expiresAt).toBe(
    s.clock.now() + 30_000,
  );
  classifiedEdge(s, 'animal');
  expect(s.service.snapshot('bed').active!.expiresAt).toBe(
    s.clock.now() + 60_000,
  );
  classifiedEdge(s, 'animal', 'on', 'unavailable');
  expect(s.service.snapshot('bed').active!.expiresAt).toBe(
    s.clock.now() + 30_000,
  );
  s.clock.advanceBy(30_000);
  expect(s.service.snapshot('bed').active).toBeNull();
});
it('duplicates and repeated activity cannot slide the hard deadline or reopen an explicitly dismissed view', async () => {
  const s = await setup(true, classifiedConfig);
  classifiedEdge(s, 'person');
  const initial = s.service.snapshot('bed').active!;
  for (let i = 0; i < 11; i++) {
    s.clock.advanceBy(5_000);
    classifiedEdge(s, 'person', 'on', 'on');
    expect(s.service.snapshot('bed').active).toEqual(initial);
  }
  s.service.dismiss('bed');
  classifiedEdge(s, 'animal');
  expect(s.service.snapshot('bed').active).toBeNull();
  s.clock.advanceBy(5_000);
  expect(s.service.snapshot('desk').active).toBeNull();
  expect(s.service.snapshot('bed').active).toBeNull();
});
it('disconnection, unavailable cameras and settings opt-out immediately cancel extended views', async () => {
  const s = await setup(true, classifiedConfig);
  classifiedEdge(s, 'person');
  s.clock.advanceBy(30_000);
  s.service.setConnected(false);
  expect(s.service.snapshot('bed').active).toBeNull();
  expect(s.clock.pendingTimers()).toBe(0);
  s.service.setConnected(true);
  s.service.seedStates([
    { entity_id: 'camera.entry', state: 'idle' },
    { entity_id: 'binary_sensor.entry_person', state: 'on' },
  ]);
  expect(s.service.snapshot('bed').active).toBeNull();
  s.service.show('bed', 'entry');
  s.service.acceptEvent(
    s.event('state_changed', {
      entity_id: 'camera.entry',
      old_state: { state: 'idle' },
      new_state: { state: 'unavailable' },
    }),
  );
  expect(s.service.snapshot('bed').active).toBeNull();
});
it('scales both anchored bounds with the configured minimum and never persists the extension', async () => {
  const s = await setup(true, classifiedConfig);
  await s.service.updateSettings(
    { ...s.store.snapshot().settings, durationSeconds: 5 },
    s.store.snapshot().generation,
  );
  classifiedEdge(s, 'person');
  expect(s.service.snapshot('bed').active!.expiresAt).toBe(
    s.clock.now() + 10_000,
  );
  s.clock.advanceBy(5_000);
  classifiedEdge(s, 'person', 'on', 'off');
  expect(s.service.snapshot('bed').active).not.toBeNull();
  const restarted = new CameraDashboardService(
    classifiedConfig,
    s.store,
    s.clock,
  );
  services.push(restarted);
  expect(restarted.snapshot('bed').active).toBeNull();
  expect(s.store.snapshot()).not.toHaveProperty('active');
  s.clock.advanceBy(5_000);
  expect(s.service.snapshot('bed').active).toBeNull();
});

it('extends at the minimum with an admitted future HA timestamp because activity age uses monotonic receipt time', async () => {
  const s = await setup(true, classifiedConfig);
  const startedAt = s.clock.now();
  s.service.show('bed', 'entry');
  s.clock.advanceBy(29_000);
  classifiedEdge(s, 'person', 'off', 'on', s.clock.now() + 2_000);
  expect(s.service.snapshot('bed').active!.expiresAt).toBe(startedAt + 60_000);
  s.clock.advanceBy(1_000);
  expect(s.service.snapshot('bed').active!.expiresAt).toBe(startedAt + 60_000);
  s.clock.advanceBy(30_000);
  expect(s.service.snapshot('bed').active).toBeNull();
});

it('locks earned activity extension before applying an OFF received after a delayed minimum timer', async () => {
  class DeferredClock extends FakeClock {
    private id = 0;
    private readonly deferred = new Map<
      TimerHandle,
      { at: number; callback: () => void }
    >();
    override setTimeout(callback: () => void, delayMs: number): TimerHandle {
      const id = ++this.id as unknown as TimerHandle;
      this.deferred.set(id, { at: this.monotonicNow() + delayMs, callback });
      return id;
    }
    override clearTimeout(id: TimerHandle): void {
      this.deferred.delete(id);
    }
    override pendingTimers(): number {
      return this.deferred.size;
    }
    flush(): void {
      for (const [id, timer] of [...this.deferred]) {
        if (timer.at <= this.monotonicNow()) {
          this.deferred.delete(id);
          timer.callback();
        }
      }
    }
  }
  const clock = new DeferredClock(Date.parse('2026-10-21T12:00:00Z'));
  const s = await setup(true, classifiedConfig, clock);
  classifiedEdge(s, 'person');
  const initial = s.service.snapshot('bed').active!;
  clock.advanceBy(35_000); // Host event loop has not delivered the 30s callback.
  classifiedEdge(s, 'person', 'on', 'off');
  expect(s.service.snapshot('bed').active).toEqual(initial);
  clock.advanceBy(24_999);
  clock.flush();
  expect(s.service.snapshot('bed').active).toEqual(initial);
  clock.advanceBy(1);
  clock.flush();
  expect(s.service.snapshot('bed').active).toBeNull();
  expect(clock.pendingTimers()).toBe(0);
});
