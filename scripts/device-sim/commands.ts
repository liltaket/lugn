import {
  LIGHT_ALIASES,
  nextStockholmTime,
  type ScenarioDriver,
} from './scenario.js';
import { SIM_MUSIC, type SimRoom } from './sim-room.js';

export const COMMAND_HELP = `Commands (stdin, or POST text to /sim/command on the control port):
  status                         where the scenario is, clock, instanceId, pairing code
  pair                           issue a fresh pairing code
  scene <name>                   cozy|mys, everyday|vardag, focus|fokus, movie|film, off, or a scene id
  presence occupied [count]      the sensor sees people (count defaults to 1)
  presence empty                 the sensor reports empty (45 s exit grace applies)
  presence unknown               the sensor loses track
  count <n>                      person count while occupied
  prelight on|off                approach signal in the doorway
  home home|away|unknown         Home Assistant home presence
  music play|pause               through Lugn, as a Hub tap
  music volume <0-100>           set volume
  music fade <0-100> [seconds]   volume curve (default 20 s)
  music external play|pause      someone uses the speaker directly
  light <name> on|off            through Lugn (bed, ceiling, desk)
  light <name> unavailable|available
  light <name> blip [seconds]    drop off the network and return (default 10 s)
  light <name> external <0-100>  brightness changed outside Lugn (override)
  bedtime [HH:MM]                start Godnatt now (15 min fade), wake time default 07:00
  bedtime clear                  clear the Godnatt plan
  desktop <gaming|video|music|desktop|idle|off>   computer activity (gaming → suggestion)
  phone heartbeat|foreground|background
  phone focus <sleep|dnd|none>   phone charging on|off   phone alarm HH:MM
  phone geofence enter|exit
  air window open|close          air quality drift follows people and the window
  ha connected|disconnected      Home Assistant integration health
  restart [seconds]              restart the listener with a new instanceId (default 2 s down)
  offline <seconds>              listener unreachable, same instanceId
  ack slow <ms> [count]          answer the next commands late (state arrives first)
  ack fail [count]               fail the next commands with 502 command_failed
  ack clear                      drop pending ack faults
  speed <factor>                 virtual time speed (0 < factor <= 1000)
  jump <30s|10m|2h|HH:MM>        jump virtual time forward
  scenario pause|resume|next|list|<act>   control the scripted loop
  help                           this text`;

const SCENES: Record<string, string> = {
  cozy: 'scene.soft_light',
  mys: 'scene.soft_light',
  mysljus: 'scene.soft_light',
  soft: 'scene.soft_light',
  everyday: 'scene.everyday_light',
  vardag: 'scene.everyday_light',
  vardagsljus: 'scene.everyday_light',
  focus: 'scene.focus_light',
  fokus: 'scene.focus_light',
  movie: 'scene.movie_light',
  film: 'scene.movie_light',
  off: 'scene.all_off',
  'all-off': 'scene.all_off',
};

export class CommandError extends Error {}

function percent(value: string | undefined): number {
  const number = Number(value);
  if (
    value === undefined ||
    !Number.isFinite(number) ||
    number < 0 ||
    number > 100
  )
    throw new CommandError('expected a number from 0 to 100');
  return number;
}

function positive(value: string | undefined, label: string): number {
  const number = Number(value);
  if (value === undefined || !Number.isFinite(number) || number <= 0)
    throw new CommandError(`expected a positive ${label}`);
  return number;
}

/** Parses `30s`, `10m`, `2h` or `HH:MM` (next occurrence) into virtual ms. */
export function parseJump(value: string | undefined, now: number): number {
  if (!value) throw new CommandError('expected 30s, 10m, 2h or HH:MM');
  if (/^\d{1,2}:\d{2}$/.test(value)) {
    const [hour, minute] = value.split(':').map(Number) as [number, number];
    if (hour > 23 || minute > 59) throw new CommandError('invalid time');
    return nextStockholmTime(now, value.padStart(5, '0')) - now;
  }
  const match = /^(\d+(?:\.\d+)?)(s|m|h)$/.exec(value);
  if (!match) throw new CommandError('expected 30s, 10m, 2h or HH:MM');
  const unit = { s: 1_000, m: 60_000, h: 3_600_000 }[
    match[2] as 's' | 'm' | 'h'
  ];
  return Math.round(Number(match[1]) * unit);
}

function light(name: string | undefined): string {
  const id = name ? LIGHT_ALIASES[name] : undefined;
  if (!id)
    throw new CommandError(
      `unknown light; use ${Object.keys(LIGHT_ALIASES)
        .filter((key) => !key.includes('.'))
        .join(', ')}`,
    );
  return id;
}

const clockFormat = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

export function formatVirtualTime(at: number): string {
  return clockFormat.format(at);
}

export function statusOf(room: SimRoom, driver: ScenarioDriver) {
  const view = room.view();
  return {
    virtualTime: room.clock.now(),
    virtualTimeLocal: formatVirtualTime(room.clock.now()),
    speed: room.clock.speed,
    instanceId: room.instanceId,
    revision: view.revision,
    deviceApiOnline: room.online,
    pairingCode: room.pairingCode ?? null,
    scenario: {
      mode: driver.mode,
      ...driver.position,
      last: driver.lastLabel ?? null,
    },
    pendingAckFaults: room.ackFaults.size,
    presence: view.presence.state,
    personCount: view.presence.personCount,
    scene: view.lighting.currentSceneId,
    music: view.music.targets[0]?.observed ?? null,
    suggestions: view.suggestions.length,
  };
}

/** Runs one control command and returns a short answer for the operator. */
export async function runCommand(
  line: string,
  room: SimRoom,
  driver: ScenarioDriver,
): Promise<string> {
  const [verb, ...args] = line.trim().split(/\s+/);
  const [a, b, c] = args;
  switch (verb?.toLowerCase()) {
    case undefined:
    case '':
      return '';
    case 'help':
    case '?':
      return COMMAND_HELP;
    case 'status':
      return JSON.stringify(statusOf(room, driver), null, 2);
    case 'pair': {
      const code = room.issuePairingCode();
      return code ? `pairing code ${code.code}` : 'could not issue a code';
    }
    case 'scene': {
      if (!a) throw new CommandError('expected a scene name');
      const sceneId = SCENES[a.toLowerCase()] ?? a;
      if (!room.engine.scenes.has(sceneId))
        throw new CommandError(
          `unknown scene; known: ${[...room.engine.scenes.keys()].join(', ')}`,
        );
      await room.invoke('lighting.activateScene', { sceneId });
      return `scene ${sceneId}`;
    }
    case 'presence':
      switch (a) {
        case 'occupied': {
          const count = b === undefined ? 1 : Math.floor(positive(b, 'count'));
          await room.sensor('occupied', count);
          return `presence occupied (${count})`;
        }
        case 'empty':
        case 'confirmed_empty':
          await room.sensor('confirmed_empty', 0);
          return 'presence empty (exit grace 45 s)';
        case 'unknown':
          await room.sensor('unknown', null);
          return 'presence unknown';
        default:
          throw new CommandError('presence occupied [count] | empty | unknown');
      }
    case 'count': {
      const count = Math.floor(positive(a, 'count'));
      await room.sensor('occupied', count);
      return `person count ${count}`;
    }
    case 'prelight':
      if (a !== 'on' && a !== 'off') throw new CommandError('prelight on|off');
      await room.prelight(a === 'on');
      return `prelight ${a}`;
    case 'home':
      if (a !== 'home' && a !== 'away' && a !== 'unknown')
        throw new CommandError('home home|away|unknown');
      await room.home(a);
      return `home ${a}`;
    case 'music':
      switch (a) {
        case 'play':
        case 'pause':
          await room.invoke(`music.${a}`, { target: SIM_MUSIC });
          return `music ${a}`;
        case 'volume':
          await room.invoke('music.setVolume', {
            target: SIM_MUSIC,
            volume: percent(b) / 100,
          });
          return `volume ${b} %`;
        case 'fade': {
          const seconds = c === undefined ? 20 : positive(c, 'duration');
          // Lugn fades only from a recent volume report.
          room.speaker.report(SIM_MUSIC);
          await room.invoke('music.fadeVolume', {
            target: SIM_MUSIC,
            volume: percent(b) / 100,
            durationMs: Math.min(120_000, Math.max(1_000, seconds * 1_000)),
          });
          return `fading to ${b} % over ${seconds} s`;
        }
        case 'external':
          if (b !== 'play' && b !== 'pause')
            throw new CommandError('music external play|pause');
          room.speaker.external(SIM_MUSIC, {
            playback: b === 'play' ? 'playing' : 'paused',
          });
          return `speaker ${b} (outside Lugn)`;
        default:
          throw new CommandError(
            'music play|pause|volume <n>|fade <n> [s]|external play|pause',
          );
      }
    case 'light': {
      const target = light(a);
      switch (b) {
        case 'on':
        case 'off':
          await room.invoke('lighting.set', {
            target,
            values: { power: b === 'on' },
          });
          return `${target} ${b}`;
        case 'unavailable':
        case 'available':
          room.lights.setAvailable(target, b === 'available');
          return `${target} ${b}`;
        case 'blip': {
          const seconds = c === undefined ? 10 : positive(c, 'duration');
          room.lights.setAvailable(target, false);
          room.clock.setTimeout(
            () => room.lights.setAvailable(target, true),
            seconds * 1_000,
          );
          return `${target} unavailable for ${seconds} s (virtual)`;
        }
        case 'external':
          room.lights.externalChange(target, { brightness: percent(c) });
          return `${target} brightness ${c} % outside Lugn`;
        default:
          throw new CommandError(
            'light <name> on|off|unavailable|available|blip [s]|external <n>',
          );
      }
    }
    case 'bedtime': {
      if (a === 'clear') {
        const expectedGeneration = room.routinesGeneration();
        await room.experienceRequest('routines/bedtime', {
          action: 'clear',
          expectedGeneration,
          requestId: `device-sim-clear-${room.clock.now()}`,
        });
        return 'Godnatt plan cleared';
      }
      const wakeTime = a ?? '07:00';
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(wakeTime))
        throw new CommandError('bedtime [HH:MM] | bedtime clear');
      await room.experienceRequest('routines/bedtime', {
        action: 'start',
        wakeTime,
        mode: 'auto',
        music: true,
        expectedGeneration: room.routinesGeneration(),
        requestId: `device-sim-bedtime-${room.clock.now()}`,
      });
      return `Godnatt started, wake ${wakeTime}`;
    }
    case 'desktop': {
      const activities = ['gaming', 'video', 'music', 'desktop', 'idle', 'off'];
      if (!a || !activities.includes(a))
        throw new CommandError(`desktop ${activities.join('|')}`);
      room.setDesktop(a as Parameters<SimRoom['setDesktop']>[0]);
      return `desktop ${a}`;
    }
    case 'phone':
      return `phone: ${phoneCommand(room, a, b)}`;
    case 'air':
      if (a === 'window' && (b === 'open' || b === 'close')) {
        room.setWindowOpen(b === 'open');
        return `window ${b}`;
      }
      throw new CommandError('air window open|close');
    case 'ha':
      if (a !== 'connected' && a !== 'disconnected')
        throw new CommandError('ha connected|disconnected');
      room.setHealth('home_assistant', a);
      return `home_assistant ${a}`;
    case 'restart': {
      const seconds = a === undefined ? 2 : positive(a, 'duration');
      void room.restart(seconds * 1_000);
      return `restarting (down ${seconds} s)`;
    }
    case 'offline': {
      const seconds = positive(a, 'duration');
      void room.offline(seconds * 1_000);
      return `offline for ${seconds} s`;
    }
    case 'ack':
      switch (a) {
        case 'slow': {
          const delayMs = positive(b, 'delay in ms');
          const count = c === undefined ? 1 : Math.floor(positive(c, 'count'));
          room.ackFaults.add({ kind: 'slow', delayMs }, count);
          return `next ${count} command(s) answer after ${delayMs} ms`;
        }
        case 'fail': {
          const count = b === undefined ? 1 : Math.floor(positive(b, 'count'));
          room.ackFaults.add({ kind: 'fail' }, count);
          return `next ${count} command(s) fail with 502`;
        }
        case 'clear':
          room.ackFaults.clear();
          return 'ack faults cleared';
        default:
          throw new CommandError(
            'ack slow <ms> [count] | fail [count] | clear',
          );
      }
    case 'speed': {
      const factor = positive(a, 'factor');
      if (factor > 1000) throw new CommandError('speed must be at most 1000');
      room.clock.setSpeed(factor);
      return `speed ×${factor}`;
    }
    case 'jump': {
      const duration = parseJump(a, room.clock.now());
      await room.clock.advanceBy(duration);
      room.updateEnvironment();
      return `virtual time now ${formatVirtualTime(room.clock.now())}`;
    }
    case 'scenario':
      switch (a) {
        case 'pause':
          driver.pause();
          return 'scenario paused';
        case 'resume':
          driver.resume();
          return 'scenario resumed';
        case 'next':
          driver.skip();
          return 'running the next step now';
        case 'list':
          return driver.acts
            .map(
              (act) =>
                `${act.name}: ${act.steps.map((step) => step.label).join(' → ')}`,
            )
            .join('\n');
        default:
          if (a && driver.goTo(a)) return `scenario at act ${a}`;
          throw new CommandError(
            `scenario pause|resume|next|list|${driver.acts.map((act) => act.name).join('|')}`,
          );
      }
    default:
      throw new CommandError(`unknown command "${verb}"; try help`);
  }
}

function phoneCommand(
  room: SimRoom,
  a: string | undefined,
  b: string | undefined,
): string {
  switch (a) {
    case 'heartbeat':
    case 'foreground':
    case 'background':
      return room.phoneObservation({ type: 'app', state: a });
    case 'focus':
      if (!b || !['sleep', 'dnd', 'other', 'none'].includes(b))
        throw new CommandError('phone focus sleep|dnd|other|none');
      return room.phoneObservation({ type: 'focus', mode: b });
    case 'charging':
      if (b !== 'on' && b !== 'off')
        throw new CommandError('phone charging on|off');
      return room.phoneObservation({
        type: 'power',
        charging: b === 'on',
        batteryLevel: 0.5,
      });
    case 'alarm':
      if (!b || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(b))
        throw new CommandError('phone alarm HH:MM');
      return room.phoneObservation({
        type: 'wake_alarm',
        at: nextStockholmTime(room.clock.now(), b),
        source: 'manual',
      });
    case 'geofence':
      if (b !== 'enter' && b !== 'exit')
        throw new CommandError('phone geofence enter|exit');
      return room.phoneObservation({
        type: 'geofence',
        zoneId: 'home',
        transition: b,
      });
    default:
      throw new CommandError(
        'phone heartbeat|foreground|background|focus <m>|charging on|off|alarm HH:MM|geofence enter|exit',
      );
  }
}
