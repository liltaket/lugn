import { afterEach, expect, it } from 'vitest';
import { StateViewSchema, type StateView } from '../src/core/device-api.js';
import { startSim, type RunningSim } from '../scripts/device-sim/app.js';
import { SIM_PHONE_ID } from '../scripts/device-sim/sim-room.js';

const START = Date.parse('2026-11-16T18:00:00+01:00');
const running: RunningSim[] = [];
afterEach(async () => {
  for (const sim of running.splice(0)) await sim.stop();
});

it('plays the whole day loop through the real engine without failed steps', async () => {
  const log: string[] = [];
  const sim = await startSim({
    host: '127.0.0.1',
    port: 0,
    panelPort: null,
    controlPort: null,
    manualClock: true,
    startAt: START,
    seed: 7,
    scenario: 'calm',
    log: (line) => log.push(line),
  });
  running.push(sim);
  const seen = {
    presence: new Set<string>(),
    counts: new Set<number | null>(),
    exitPending: false,
    converged: new Set<string>(),
    suggestion: undefined as string | undefined,
    quietHours: false,
    deskUnavailable: false,
    overridden: false,
    bedtimeRunning: false,
    home: new Set<string>(),
    co2: [] as number[],
    why: new Set<string>(),
  };
  const sample = (view: StateView) => {
    seen.presence.add(view.presence.state);
    seen.counts.add(view.presence.personCount);
    seen.exitPending ||= view.presence.exitPending !== null;
    if (
      view.lighting.currentSceneId &&
      view.lighting.lights.every((light) => light.matchesIntent === true)
    )
      seen.converged.add(view.lighting.currentSceneId);
    seen.suggestion ??= view.suggestions[0]?.title;
    seen.quietHours ||= view.music.targets[0]?.playback?.quietHours === true;
    seen.deskUnavailable ||= view.lighting.lights.some(
      (light) =>
        light.id === 'lighting.desk' && light.availability === 'unavailable',
    );
    seen.overridden ||= view.lighting.lights.some(
      (light) => light.overridden.length > 0,
    );
    seen.bedtimeRunning ||= (view.routines?.running.length ?? 0) > 0;
    seen.home.add(view.presence.home.state);
    if (view.environment?.co2.value != null)
      seen.co2.push(view.environment.co2.value);
    for (const entry of view.why)
      seen.why.add(`${entry.outcome}:${entry.text}`);
  };
  // Waits are virtual; the jumps inside the acts extend these advances.
  for (let i = 0; i < 4_000 && sim.driver.loops < 1; i++) {
    await sim.clock.advanceBy(2_000);
    sample(sim.room.view());
  }
  expect(sim.driver.loops).toBe(1);
  expect(log.filter((line) => line.includes('step failed'))).toEqual([]);
  expect(StateViewSchema.safeParse(sim.room.view()).success).toBe(true);

  expect([...seen.presence]).toEqual(
    expect.arrayContaining(['occupied', 'confirmed_empty', 'unknown']),
  );
  expect([...seen.counts]).toEqual(expect.arrayContaining([1, 2]));
  expect(seen.exitPending).toBe(true);
  expect([...seen.converged]).toEqual(
    expect.arrayContaining(['scene.everyday_light', 'scene.soft_light']),
  );
  expect(seen.suggestion).toBe('Vill du använda Fokus?');
  expect(seen.overridden).toBe(true);
  expect(seen.bedtimeRunning).toBe(true);
  expect(seen.quietHours).toBe(true);
  expect([...seen.home]).toEqual(expect.arrayContaining(['home', 'away']));
  expect(Math.max(...seen.co2) - Math.min(...seen.co2)).toBeGreaterThan(30);
  // Calm mode leaves outages and server faults out.
  expect(seen.deskUnavailable).toBe(false);
  expect(sim.room.restarts).toBe(0);
  // The why feed carries the engine's own decisions.
  expect([...seen.why]).toEqual(
    expect.arrayContaining([
      'acted:Tände: någon kom in',
      'acted:Släckte: rummet är tomt',
      'acted:Valde Mysljus',
    ]),
  );
  const phone = sim.room.view().phone;
  expect(phone.devices.map((device) => device.deviceId)).toContain(
    SIM_PHONE_ID,
  );
  // One simulated day later, back in the evening.
  expect(sim.clock.now() - START).toBeGreaterThan(23 * 3_600_000);
}, 60_000);

it('runs the fault steps: a light outage and a restart with a new instanceId', async () => {
  const log: string[] = [];
  const sim = await startSim({
    host: '127.0.0.1',
    port: 0,
    panelPort: null,
    controlPort: null,
    manualClock: true,
    startAt: START,
    scenario: 'loop',
    log: (line) => log.push(line),
  });
  running.push(sim);
  const instanceId = sim.room.instanceId;
  let deskUnavailable = false;
  let ackFaults = 0;
  for (let i = 0; i < 400 && sim.room.restarts === 0; i++) {
    await sim.clock.advanceBy(1_000);
    deskUnavailable ||= sim.room
      .view()
      .lighting.lights.some(
        (light) =>
          light.id === 'lighting.desk' && light.availability === 'unavailable',
      );
    ackFaults = Math.max(ackFaults, sim.room.ackFaults.size);
  }
  // Restart holds the listener down for 2 s of wall time.
  await new Promise((resolve) => setTimeout(resolve, 2_300));
  expect(deskUnavailable).toBe(true);
  expect(ackFaults).toBe(2);
  expect(sim.room.restarts).toBe(1);
  expect(sim.room.instanceId).not.toBe(instanceId);
  expect(sim.room.online).toBe(true);
  expect(
    sim.room
      .view()
      .lighting.lights.find((light) => light.id === 'lighting.desk')
      ?.availability,
  ).toBe('available');
  expect(log.filter((line) => line.includes('step failed'))).toEqual([]);
}, 30_000);
