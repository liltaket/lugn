import {
  SIM_LIGHTS,
  SIM_MUSIC,
  stockholmHour,
  type SimRoom,
} from './sim-room.js';

export type ScenarioStep = {
  /** Virtual time to wait before this step. */
  after: number;
  label: string;
  /** Fault steps (restart, offline, ack faults, outages) are left out of `calm`. */
  fault?: true;
  run: (room: SimRoom) => Promise<unknown> | unknown;
};

export type ScenarioAct = { name: string; steps: ScenarioStep[] };

const s = (seconds: number) => seconds * 1_000;
const min = (minutes: number) => minutes * 60_000;

/** Next instant (strictly after `from`) whose Stockholm wall clock is hh:mm. */
export function nextStockholmTime(from: number, time: string): number {
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  const target = hour + minute / 60;
  const current = stockholmHour(from);
  let delta = target - current;
  if (delta <= 0) delta += 24;
  // Land on the minute; DST shifts are corrected by re-measuring once.
  let at = Math.floor((from + delta * 3_600_000) / 60_000) * 60_000;
  const drift = target - stockholmHour(at);
  if (Math.abs(drift) > 0.01 && Math.abs(drift) < 2)
    at += Math.round(drift * 60) * 60_000;
  return at <= from ? at + 24 * 3_600_000 : at;
}

function jumpTo(time: string) {
  return async (room: SimRoom) => {
    await room.clock.advanceTo(nextStockholmTime(room.clock.now(), time));
    room.updateEnvironment();
  };
}

function phone(observation: Record<string, unknown> & { type: string }) {
  return (room: SimRoom) => room.phoneObservation(observation);
}

async function startBedtime(room: SimRoom, wakeTime = '07:00'): Promise<void> {
  const expectedGeneration = room.routinesGeneration();
  if (expectedGeneration === null) throw new Error('routines unavailable');
  await room.experienceRequest('routines/bedtime', {
    action: 'start',
    wakeTime,
    mode: 'auto',
    music: true,
    expectedGeneration,
    requestId: `device-sim-bedtime-${room.clock.now()}`,
  });
}

/**
 * One simulated day, looped: an evening with visitors, music, a suggestion
 * and a flaky light; Godnatt with its 15-minute fade across 23:00; a quiet
 * night; and a morning that leaves the room empty before the next evening.
 * Device effects and the why feed come from the real engine reacting.
 */
export function defaultScenario(): ScenarioAct[] {
  return [
    {
      name: 'kväll',
      steps: [
        {
          after: 0,
          label: 'någon kommer in (1 person)',
          run: (room) => room.sensor('occupied', 1),
        },
        {
          after: s(4),
          label: 'datorn: spel i helskärm (förslag om Fokus efter ~5 s)',
          run: (room) => room.setDesktop('gaming'),
        },
        {
          after: s(20),
          label: 'Hub: Vardagsljus (förslaget försvinner)',
          run: (room) =>
            room.invoke('lighting.activateScene', {
              sceneId: 'scene.everyday_light',
            }),
        },
        {
          after: s(10),
          label: 'Spotify startas från mobilen',
          run: (room) =>
            room.speaker.external(SIM_MUSIC, {
              playback: 'playing',
              source: 'Spotify',
              volume: 0.22,
            }),
        },
        {
          after: s(6),
          label: 'telefonen: app i förgrunden, hemma-wifi, laddar inte',
          run: (room) => {
            room.phoneObservation({ type: 'app', state: 'foreground' });
            room.phoneObservation({
              type: 'network',
              kind: 'wifi',
              homeNetwork: true,
            });
            room.phoneObservation({
              type: 'power',
              charging: false,
              batteryLevel: 0.64,
            });
          },
        },
        {
          after: s(8),
          label: 'en vän kommer in (2 personer)',
          run: (room) => room.sensor('occupied', 2),
        },
        {
          after: s(8),
          label: 'Hub: volymkurva 22 % → 38 % över 20 s',
          run: (room) => {
            // A fade needs a fresh speaker report, as from Home Assistant.
            room.speaker.report(SIM_MUSIC);
            return room.invoke('music.fadeVolume', {
              target: SIM_MUSIC,
              volume: 0.38,
              durationMs: 20_000,
            });
          },
        },
        {
          after: s(25),
          label: 'Hub: Mysljus',
          run: (room) =>
            room.invoke('lighting.activateScene', {
              sceneId: 'scene.soft_light',
            }),
        },
        {
          after: s(25),
          label: 'skrivbordslampan tappar nätet i 12 s',
          fault: true,
          run: (room) => {
            room.lights.setAvailable('lighting.desk', false);
            room.clock.setTimeout(
              () => room.lights.setAvailable('lighting.desk', true),
              12_000,
            );
          },
        },
        {
          after: s(18),
          label: 'någon vrider ner skrivbordslampan i appen (35 %)',
          run: (room) =>
            room.lights.externalChange('lighting.desk', { brightness: 35 }),
        },
        {
          after: s(12),
          label: 'datorn stängs av; vännen går (1 person)',
          run: async (room) => {
            room.setDesktop('off');
            await room.sensor('occupied', 1);
          },
        },
        {
          after: s(8),
          label: 'nästa två telefonkommandon får sena svar (3 s)',
          fault: true,
          run: (room) =>
            room.ackFaults.add({ kind: 'slow', delayMs: 3_000 }, 2),
        },
        {
          after: s(20),
          label: 'rummet blir tomt (utgångsfördröjning 45 s)',
          run: (room) => room.sensor('confirmed_empty', 0),
        },
        {
          after: s(75),
          label: 'tillbaka inom minnestiden',
          run: (room) => room.sensor('occupied', 1),
        },
        {
          after: s(12),
          label: 'servern startar om (nytt instanceId)',
          fault: true,
          run: (room) => room.restart(2_000),
        },
        {
          after: s(15),
          label: 'telefonen: hjärtslag',
          run: phone({ type: 'app', state: 'heartbeat' }),
        },
        {
          after: s(15),
          label: 'nästa telefonkommando misslyckas (502)',
          fault: true,
          run: (room) => room.ackFaults.add({ kind: 'fail' }),
        },
        {
          after: s(20),
          label: 'Lugn är onåbar i 8 s (samma instanceId)',
          fault: true,
          run: (room) => room.offline(8_000),
        },
        {
          after: s(20),
          label: 'fönstret öppnas en stund',
          run: (room) => room.setWindowOpen(true),
        },
        {
          after: s(40),
          label: 'fönstret stängs',
          run: (room) => room.setWindowOpen(false),
        },
      ],
    },
    {
      name: 'läggdags',
      steps: [
        {
          after: s(10),
          label: 'hoppar fram till 22:44',
          run: jumpTo('22:44'),
        },
        {
          after: 0,
          label: 'telefonen: Sov-fokus, laddar, väckning 07:00',
          run: (room) => {
            room.phoneObservation({ type: 'focus', mode: 'sleep' });
            room.phoneObservation({
              type: 'power',
              charging: true,
              batteryLevel: 0.41,
            });
            room.phoneObservation({
              type: 'wake_alarm',
              at: nextStockholmTime(room.clock.now(), '07:00'),
              source: 'sleep_schedule',
            });
          },
        },
        {
          after: s(5),
          label: 'Godnatt startar (15 min nedtoning, väckning 07:00)',
          run: (room) => startBedtime(room),
        },
        {
          after: min(16) + s(30),
          label: 'efter 23:00: en sväng ut ur rummet',
          run: (room) => room.sensor('confirmed_empty', 0),
        },
        {
          after: s(70),
          label: 'tillbaka under tysta timmar (musik startar inte)',
          run: (room) => room.sensor('occupied', 1),
        },
        {
          after: s(30),
          label: 'sensorn tappar spåret en stund',
          run: (room) => room.sensor('unknown', null),
        },
        {
          after: s(20),
          label: 'sensorn ser personen igen',
          run: (room) => room.sensor('occupied', 1),
        },
      ],
    },
    {
      name: 'morgon',
      steps: [
        {
          after: s(30),
          label: 'hoppar fram till 06:50',
          run: jumpTo('06:50'),
        },
        {
          after: 0,
          label: 'telefonen: fokus av',
          run: phone({ type: 'focus', mode: 'none' }),
        },
        {
          after: min(12),
          label: 'telefonen: laddare ur, i rörelse',
          run: (room) => {
            room.phoneObservation({
              type: 'power',
              charging: false,
              batteryLevel: 0.97,
            });
            room.phoneObservation({
              type: 'motion',
              activity: 'walking',
              confidence: 'high',
            });
          },
        },
        {
          after: s(20),
          label: 'Hub: Vardagsljus',
          run: (room) =>
            room.invoke('lighting.activateScene', {
              sceneId: 'scene.everyday_light',
            }),
        },
        {
          after: s(40),
          label: 'går hemifrån: rummet tomt',
          run: (room) => room.sensor('confirmed_empty', 0),
        },
        {
          after: s(90),
          label: 'Home Assistant: borta; telefonen lämnar hemzonen',
          run: async (room) => {
            room.phoneObservation({
              type: 'geofence',
              zoneId: 'home',
              transition: 'exit',
            });
            await room.home('away');
          },
        },
      ],
    },
    {
      name: 'hemkomst',
      steps: [
        {
          after: s(30),
          label: 'hoppar fram till 17:40',
          run: jumpTo('17:40'),
        },
        {
          after: 0,
          label: 'telefonen går in i hemzonen; Home Assistant: hemma',
          run: async (room) => {
            room.phoneObservation({
              type: 'geofence',
              zoneId: 'home',
              transition: 'enter',
            });
            await room.home('home');
          },
        },
        {
          after: s(20),
          label: 'sensorn ser någon i dörren (förtänd)',
          run: (room) => room.prelight(true),
        },
        {
          after: s(4),
          label: 'förtändning slut',
          run: (room) => room.prelight(false),
        },
      ],
    },
  ];
}

export type ScenarioMode = 'loop' | 'calm' | 'off';

type DriverOptions = {
  acts?: ScenarioAct[];
  mode?: ScenarioMode;
  log?: (line: string) => void;
};

/**
 * Plays the acts in order, forever. Waits are virtual time, so `speed`
 * compresses everything, including Lugn's own fades and grace periods.
 */
export class ScenarioDriver {
  readonly acts: ScenarioAct[];
  mode: ScenarioMode;
  private readonly log: (line: string) => void;
  private actIndex = 0;
  private stepIndex = 0;
  private paused = false;
  private running: Promise<void> | undefined;
  private wake: (() => void) | undefined;
  private generation = 0;
  private stopped = false;
  completedSteps = 0;
  loops = 0;
  lastLabel: string | undefined;

  constructor(
    private readonly room: SimRoom,
    options: DriverOptions = {},
  ) {
    this.acts = options.acts ?? defaultScenario();
    this.mode = options.mode ?? 'loop';
    this.log = options.log ?? (() => undefined);
  }

  get position(): { act: string; step: number; paused: boolean } {
    return {
      act: this.acts[this.actIndex]?.name ?? '',
      step: this.stepIndex,
      paused: this.paused || this.mode === 'off',
    };
  }

  start(): void {
    if (this.mode === 'off' || this.running) return;
    this.running = this.loop().finally(() => {
      this.running = undefined;
    });
  }

  pause(): void {
    this.paused = true;
    this.interrupt();
  }

  resume(): void {
    this.paused = false;
    if (this.mode === 'off') this.mode = 'loop';
    this.interrupt();
    this.start();
  }

  /** Runs the next step now instead of waiting. */
  skip(): void {
    this.skipWait = true;
    this.interrupt();
  }

  /** Jumps to the start of an act by name. */
  goTo(name: string): boolean {
    const index = this.acts.findIndex((act) => act.name === name);
    if (index < 0) return false;
    this.actIndex = index;
    this.stepIndex = 0;
    this.interrupt();
    return true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.interrupt();
    await this.running;
  }

  private skipWait = false;

  private interrupt(): void {
    this.generation += 1;
    this.wake?.();
  }

  /**
   * Resolves true when the wait completed (or was skipped) and the step should
   * run, false when an interrupt asks the loop to re-evaluate its position.
   */
  private wait(virtualMs: number): Promise<boolean> {
    const generation = this.generation;
    if (this.skipWait) {
      this.skipWait = false;
      return Promise.resolve(true);
    }
    const clock = this.room.clock;
    return new Promise((resolve) => {
      let timer: ReturnType<typeof clock.setTimeout> | undefined;
      const finish = (proceed: boolean) => {
        if (timer !== undefined) clock.clearTimeout(timer);
        this.wake = undefined;
        resolve(proceed);
      };
      this.wake = () => {
        const skip = this.skipWait;
        this.skipWait = false;
        finish(skip);
      };
      if (!Number.isFinite(virtualMs)) return;
      if (virtualMs > 0)
        timer = clock.setTimeout(
          () => finish(this.generation === generation),
          virtualMs,
        );
      else setImmediate(() => finish(this.generation === generation));
    });
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      if (this.paused) {
        await this.wait(Number.POSITIVE_INFINITY);
        continue;
      }
      const act = this.acts[this.actIndex];
      if (!act) {
        this.actIndex = 0;
        this.stepIndex = 0;
        this.loops += 1;
        continue;
      }
      const step = act.steps[this.stepIndex];
      if (!step) {
        this.actIndex += 1;
        this.stepIndex = 0;
        continue;
      }
      if (step.fault && this.mode === 'calm') {
        this.stepIndex += 1;
        continue;
      }
      const position = `${this.actIndex}:${this.stepIndex}`;
      if (!(await this.wait(step.after))) continue;
      if (this.stopped) break;
      // An interrupt (goTo) may have moved the cursor while waiting.
      if (`${this.actIndex}:${this.stepIndex}` !== position) continue;
      this.stepIndex += 1;
      this.lastLabel = `${act.name} · ${step.label}`;
      this.log(this.lastLabel);
      try {
        await step.run(this.room);
      } catch (error) {
        this.log(
          `step failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      this.completedSteps += 1;
    }
  }
}

export const LIGHT_ALIASES: Record<string, string> = Object.fromEntries(
  SIM_LIGHTS.flatMap((id) => [
    [id, id],
    [id.replace('lighting.', ''), id],
  ]),
);
