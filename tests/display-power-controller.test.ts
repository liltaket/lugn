import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ComputerDisplayAck,
  ComputerDisplayTransport,
} from '../src/adapters/computer-display-mqtt.js';
import {
  DisplayPowerController,
  defaultDisplayPowerPolicy,
  type DisplayPowerPolicy,
} from '../src/application/display-power-controller.js';
import { FakeClock } from '../src/core/clock.js';
import type {
  DisplayPowerEvidence,
  DisplayPowerSnapshot,
} from '../src/core/display-power.js';
import type { RoomState } from '../src/core/schemas.js';

const SESSION = '11111111-1111-4111-8111-111111111111';
const MINUTE = 60_000;
const flush = () => new Promise((resolve) => setImmediate(resolve));

type Presence = 'occupied' | 'confirmed_empty' | 'unknown';
type Scene = {
  presence: Presence;
  home: 'home' | 'away' | 'unknown';
  idle: boolean | null;
  activity: 'desktop' | 'gaming' | 'video' | 'idle' | 'unknown';
  online: boolean;
  session: string;
};

function harness(
  policy: Partial<DisplayPowerPolicy> = {},
  options: { evidenceSettleMs?: number } = {},
) {
  const clock = new FakeClock(1_000_000);
  const scene: Scene = {
    presence: 'occupied',
    home: 'home',
    idle: true,
    activity: 'desktop',
    online: true,
    session: SESSION,
  };
  const transport = {
    fresh: true,
    backend: 'kscreen' as 'kscreen' | null,
    outcome: 'applied' as ComputerDisplayAck['outcome'],
    reject: false,
    hold: undefined as Promise<void> | undefined,
    sent: [] as Array<'on' | 'off'>,
    getSnapshot() {
      return {
        fresh: transport.fresh,
        receivedAtMs: 0,
        state: { session_id: SESSION, backend: transport.backend },
      };
    },
    sendCommand: vi.fn(async (action: 'on' | 'off') => {
      transport.sent.push(action);
      if (transport.hold) await transport.hold;
      if (transport.reject) throw new Error('no ack');
      return { outcome: transport.outcome } as ComputerDisplayAck;
    }),
  };
  let evidence: DisplayPowerEvidence | undefined;
  let quiet = false;
  const published: DisplayPowerSnapshot[] = [];
  const state = (): RoomState =>
    ({
      presence: {
        state: scene.presence,
        personCount: null,
        continuityExpiresAt: null,
        home: { state: scene.home, observedAt: null },
      },
      computer: {
        devices: {
          kuffe: {
            deviceId: 'kuffe',
            availability: scene.online ? 'online' : 'offline',
            freshness: scene.online ? 'fresh' : 'unknown',
            sessionId: scene.session,
            observed: { idle: scene.idle },
            activity: { classification: scene.activity },
          },
        },
      },
    }) as unknown as RoomState;
  const controller = new DisplayPowerController({
    deviceId: 'kuffe',
    clock,
    policy: { ...defaultDisplayPowerPolicy, ...policy },
    getState: state,
    transport: transport as unknown as ComputerDisplayTransport,
    evidence: () =>
      evidence ?? {
        source: 'power-sensor',
        state: 'unknown',
        watts: null,
        observedAt: null,
      },
    isQuietHours: () => quiet,
    ...options,
    publish: (snapshot) => published.push(snapshot),
  });
  const advance = async (ms: number) => {
    clock.advanceBy(ms);
    await flush();
  };
  const set = async (patch: Partial<Scene>) => {
    Object.assign(scene, patch);
    controller.observe();
    await flush();
  };
  return {
    clock,
    transport,
    controller,
    published,
    advance,
    set,
    setEvidence: (
      next: DisplayPowerEvidence['state'],
      watts: number | null,
    ) => {
      evidence = {
        source: 'power-sensor',
        state: next,
        watts,
        observedAt: clock.now(),
      };
      controller.observe();
    },
    setQuiet: (value: boolean) => (quiet = value),
  };
}

describe('DisplayPowerController', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it('does nothing while the room is occupied', async () => {
    h.controller.observe();
    await h.advance(60 * MINUTE);
    expect(h.transport.sent).toEqual([]);
    expect(h.published.at(-1)).toMatchObject({
      desired: 'on',
      control: 'available',
    });
  });

  it('sleeps the display after the room has stayed confirmed empty, then repeats at a low rate', async () => {
    await h.set({ presence: 'confirmed_empty' });
    expect(h.published.at(-1)).toMatchObject({ desired: 'off' });
    await h.advance(2 * MINUTE - 1);
    expect(h.transport.sent).toEqual([]);
    await h.advance(1);
    expect(h.transport.sent).toEqual(['off']);
    await h.advance(14 * MINUTE);
    expect(h.transport.sent).toEqual(['off']);
    await h.advance(1 * MINUTE);
    expect(h.transport.sent).toEqual(['off', 'off']);
    expect(h.published.at(-1)?.lastRequest).toMatchObject({
      action: 'off',
      outcome: 'applied',
    });
  });

  it('treats the house being away like an empty room', async () => {
    await h.set({ home: 'away' });
    await h.advance(2 * MINUTE);
    expect(h.transport.sent).toEqual(['off']);
  });

  it('does not act on tracking loss and keeps counting an empty period through it', async () => {
    await h.set({ presence: 'confirmed_empty' });
    await h.advance(1 * MINUTE);
    await h.set({ presence: 'unknown' });
    await h.advance(10 * MINUTE);
    expect(h.transport.sent).toEqual([]);
    expect(h.published.at(-1)).toMatchObject({ desired: null });
    await h.set({ presence: 'confirmed_empty' });
    expect(h.transport.sent).toEqual(['off']);
  });

  it('wakes exactly once when someone is confirmed back after Lugn put it to sleep', async () => {
    await h.set({ presence: 'confirmed_empty' });
    await h.advance(2 * MINUTE);
    await h.set({ presence: 'occupied' });
    expect(h.transport.sent).toEqual(['off', 'on']);
    await h.advance(60 * MINUTE);
    expect(h.transport.sent).toEqual(['off', 'on']);
  });

  it('never wakes a display it did not put to sleep', async () => {
    await h.set({ presence: 'confirmed_empty' });
    await h.advance(1 * MINUTE);
    await h.set({ presence: 'occupied' });
    await h.advance(30 * MINUTE);
    expect(h.transport.sent).toEqual([]);
  });

  it('respects wakeOnEntry=false and quiet hours', async () => {
    h = harness({ wakeOnEntry: false });
    await h.set({ presence: 'confirmed_empty' });
    await h.advance(2 * MINUTE);
    await h.set({ presence: 'occupied' });
    expect(h.transport.sent).toEqual(['off']);

    h = harness();
    await h.set({ presence: 'confirmed_empty' });
    await h.advance(2 * MINUTE);
    h.setQuiet(true);
    await h.set({ presence: 'occupied' });
    expect(h.transport.sent).toEqual(['off']);

    h = harness({ wakeInQuietHours: true });
    await h.set({ presence: 'confirmed_empty' });
    await h.advance(2 * MINUTE);
    h.setQuiet(true);
    await h.set({ presence: 'occupied' });
    expect(h.transport.sent).toEqual(['off', 'on']);
  });

  it('holds sleep while the computer is in use, but only for the configured window', async () => {
    h = harness({ activeInhibitMaxMs: 30 * MINUTE });
    await h.set({ presence: 'confirmed_empty', idle: false });
    await h.advance(10 * MINUTE);
    expect(h.transport.sent).toEqual([]);
    expect(h.published.at(-1)).toMatchObject({
      inhibited: 'recent_activity',
      nextAttemptAt: null,
    });
    await h.set({ idle: true });
    expect(h.transport.sent).toEqual(['off']);

    h = harness({ activeInhibitMaxMs: 30 * MINUTE });
    await h.set({ presence: 'confirmed_empty', idle: false });
    await h.advance(29 * MINUTE);
    expect(h.transport.sent).toEqual([]);
    await h.advance(1 * MINUTE);
    expect(h.transport.sent).toEqual(['off']);
  });

  it('holds sleep for a game or video when idle is not reported', async () => {
    await h.set({ presence: 'confirmed_empty', idle: null, activity: 'video' });
    await h.advance(5 * MINUTE);
    expect(h.transport.sent).toEqual([]);
    expect(h.published.at(-1)?.inhibited).toBe('video_or_game');
  });

  it('can ignore activity entirely', async () => {
    h = harness({ inhibitOnActivity: false });
    await h.set({ presence: 'confirmed_empty', idle: false });
    await h.advance(2 * MINUTE);
    expect(h.transport.sent).toEqual(['off']);
  });

  it('waits for a live transport instead of spinning, then sends once ready', async () => {
    h.transport.fresh = false;
    await h.set({ presence: 'confirmed_empty' });
    await h.advance(5 * MINUTE);
    expect(h.transport.sent).toEqual([]);
    expect(h.published.at(-1)).toMatchObject({ control: 'unavailable' });
    h.transport.fresh = true;
    h.controller.observe();
    await flush();
    expect(h.transport.sent).toEqual(['off']);
  });

  it('requires the computer observation and display state to share a session', async () => {
    await h.set({ presence: 'confirmed_empty', session: 'other-session' });
    await h.advance(5 * MINUTE);
    expect(h.transport.sent).toEqual([]);
    h.transport.backend = null;
    await h.set({ session: SESSION });
    expect(h.transport.sent).toEqual([]);
  });

  it('backs off after failures and keeps retrying the idempotent request', async () => {
    h.transport.outcome = 'rejected';
    await h.set({ presence: 'confirmed_empty' });
    await h.advance(2 * MINUTE);
    expect(h.transport.sent).toEqual(['off']);
    await h.advance(29_999);
    expect(h.transport.sent).toEqual(['off']);
    await h.advance(1);
    expect(h.transport.sent).toEqual(['off', 'off']);
    await h.advance(59_999);
    expect(h.transport.sent).toHaveLength(2);
    await h.advance(1);
    expect(h.transport.sent).toHaveLength(3);
    h.transport.outcome = 'applied';
    await h.advance(2 * MINUTE);
    expect(h.published.at(-1)?.lastRequest).toMatchObject({
      outcome: 'applied',
    });
  });

  it('treats a missing acknowledgement as a failure and still wakes after an uncertain sleep', async () => {
    h.transport.reject = true;
    await h.set({ presence: 'confirmed_empty' });
    await h.advance(2 * MINUTE);
    expect(h.published.at(-1)?.lastRequest).toMatchObject({
      outcome: 'failed',
    });
    h.transport.reject = false;
    h.transport.outcome = 'uncertain';
    await h.advance(30_000);
    expect(h.published.at(-1)?.lastRequest).toMatchObject({
      outcome: 'uncertain',
    });
    h.transport.outcome = 'applied';
    await h.set({ presence: 'occupied' });
    expect(h.transport.sent.at(-1)).toBe('on');
  });

  it('wakes after a return that happens while the sleep request is in flight', async () => {
    let release!: () => void;
    h.transport.hold = new Promise((resolve) => (release = resolve));
    await h.set({ presence: 'confirmed_empty' });
    await h.advance(2 * MINUTE);
    expect(h.transport.sent).toEqual(['off']);
    await h.set({ presence: 'occupied' });
    expect(h.transport.sent).toEqual(['off']);
    h.transport.hold = undefined;
    release();
    await flush();
    expect(h.transport.sent).toEqual(['off', 'on']);
  });

  describe('with power evidence', () => {
    it('repeats sooner when the plug still shows draw after a sleep request', async () => {
      await h.set({ presence: 'confirmed_empty' });
      await h.advance(2 * MINUTE);
      expect(h.transport.sent).toEqual(['off']);
      h.setEvidence('on', 32);
      await h.advance(2 * MINUTE - 1);
      expect(h.transport.sent).toEqual(['off']);
      await h.advance(1);
      expect(h.transport.sent).toEqual(['off', 'off']);
      // Never a tight loop.
      await h.advance(MINUTE);
      expect(h.transport.sent).toHaveLength(2);
    });

    it('stops repeating when the plug shows standby', async () => {
      await h.set({ presence: 'confirmed_empty' });
      await h.advance(2 * MINUTE);
      h.setEvidence('standby', 1);
      await h.advance(5 * 60 * MINUTE);
      expect(h.transport.sent).toEqual(['off']);
      await h.advance(60 * MINUTE + 1);
      expect(h.transport.sent).toEqual(['off', 'off']);
    });

    it('does not send an initial sleep request to a display that is already dark', async () => {
      h.setEvidence('standby', 1);
      await h.set({ presence: 'confirmed_empty' });
      await h.advance(10 * MINUTE);
      expect(h.transport.sent).toEqual([]);
      // Someone wakes it while the room is empty: now sleep is requested.
      h.setEvidence('on', 30);
      expect(h.transport.sent).toEqual(['off']);
    });

    it('skips a wake when the display is already drawing power', async () => {
      await h.set({ presence: 'confirmed_empty' });
      await h.advance(2 * MINUTE);
      h.setEvidence('on', 30);
      await h.set({ presence: 'occupied' });
      expect(h.transport.sent).toEqual(['off']);
    });

    it('retries a wake that the plug says did not take, at most three times', async () => {
      await h.set({ presence: 'confirmed_empty' });
      await h.advance(2 * MINUTE);
      h.setEvidence('standby', 1);
      await h.set({ presence: 'occupied' });
      expect(h.transport.sent).toEqual(['off', 'on']);
      await h.advance(20_000);
      expect(h.transport.sent).toEqual(['off', 'on', 'on']);
      await h.advance(20_000);
      expect(h.transport.sent).toEqual(['off', 'on', 'on', 'on']);
      await h.advance(5 * MINUTE);
      expect(h.transport.sent).toHaveLength(4);
    });

    it('waits for the sensor to settle before judging whether a wake took', async () => {
      h = harness({}, { evidenceSettleMs: 20_000 });
      await h.set({ presence: 'confirmed_empty' });
      await h.advance(2 * MINUTE);
      h.setEvidence('standby', 1);
      await h.set({ presence: 'occupied' });
      expect(h.transport.sent).toEqual(['off', 'on']);
      // 20 s would have been enough without a settling sensor.
      await h.advance(34_999);
      expect(h.transport.sent).toEqual(['off', 'on']);
      await h.advance(1);
      expect(h.transport.sent).toEqual(['off', 'on', 'on']);
    });

    it('does not start a wake from evidence alone', async () => {
      h.setEvidence('standby', 1);
      await h.set({ presence: 'occupied' });
      await h.advance(60 * MINUTE);
      expect(h.transport.sent).toEqual([]);
    });
  });

  it('publishes status only when it changes', async () => {
    h.controller.observe();
    h.controller.observe();
    await flush();
    expect(h.published).toHaveLength(1);
  });

  it('stops all timers when disposed', async () => {
    await h.set({ presence: 'confirmed_empty' });
    h.controller.dispose();
    await h.advance(60 * MINUTE);
    expect(h.transport.sent).toEqual([]);
  });
});
