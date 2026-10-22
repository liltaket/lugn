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
import { FakeClock } from '../src/core/clock.js';
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
) {
  const directory = await mkdtemp(join(tmpdir(), 'camera-dashboard-'));
  directories.push(directory);
  const clock = new FakeClock(Date.parse('2026-10-21T12:00:00Z'));
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
      expiresAt: clock.now() + 30_000,
    });
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
