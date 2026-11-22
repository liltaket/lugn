import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CompositeMusicAdapter } from '../src/adapters/composite-music.js';
import {
  SimulatedMusicAdapter,
  type MusicObservation,
} from '../src/adapters/simulated-music.js';
import {
  WiimMusicAdapter,
  decodeWiimHex,
  parseWiimEqBand,
  parseWiimPlayerStatus,
  parseWiimPresetInfo,
  parseWiimStatusEx,
  parseWiimUpnpLastChange,
  sourceNameToWiimSwitchMode,
  type WiimTransport,
  type WiimUpnpEvent,
} from '../src/adapters/wiim-music.js';
import { FakeClock } from '../src/core/clock.js';
import { validateRuntimeFileConfig } from '../src/runtime/config.js';
import { startRuntime } from '../src/runtime/main.js';
import type { HomeAssistantSocket } from '../src/adapters/home-assistant-websocket.js';

function toHex(text: string): string {
  return Buffer.from(text, 'utf8').toString('hex').toUpperCase();
}

function makePlayerStatus(overrides: Record<string, string> = {}): string {
  return JSON.stringify({
    type: '0',
    ch: '0',
    mode: '43',
    loop: '4',
    eq: '0',
    vendor: '',
    status: 'play',
    curpos: '12000',
    offset_pts: '0',
    totlen: '180000',
    Title: toHex('Unknown'),
    Artist: toHex('Unknown'),
    Album: toHex('Unknown'),
    alarmflag: '0',
    plicount: '0',
    plicurr: '0',
    vol: '53',
    mute: '0',
    ...overrides,
  });
}

class FakeWiimTransport implements WiimTransport {
  readonly commands: Array<{ host: string; command: string }> = [];
  statusBody = makePlayerStatus();
  statusExBody = JSON.stringify({
    DeviceName: 'Brunos rum',
    firmware: 'Linkplay.5.2.833833',
    project: 'WiiM_Amp_Ultra',
    RSSI: '-28',
    max_volume: '80',
    BleRemoteBatterylevel: '65',
  });
  presetInfoBody = JSON.stringify({
    preset_num: 2,
    preset_list: [
      { number: 1, name: 'DJ', source: 'SPOTIFY', picurl: '' },
      { number: 2, name: 'Chill', source: 'SPOTIFY', picurl: '' },
    ],
  });
  eqBandBody = JSON.stringify({
    status: 'OK',
    EQStat: 'On',
    Name: 'Bass Booster',
  });
  commandReply = 'OK';
  failStatus = false;
  failCommand = false;
  disposed = false;

  async sendCommand(host: string, command: string): Promise<string> {
    this.commands.push({ host, command });
    if (command === 'getPlayerStatus') {
      if (this.failStatus) throw new Error('unreachable');
      return this.statusBody;
    }
    if (command === 'getStatusEx') return this.statusExBody;
    if (command === 'getPresetInfo') return this.presetInfoBody;
    if (command === 'EQGetBand') return this.eqBandBody;
    if (this.failCommand) throw new Error('transport error');
    return this.commandReply;
  }

  dispose(): void {
    this.disposed = true;
  }
}

class InertSocket implements HomeAssistantSocket {
  addEventListener(): void {}
  send(): void {}
  close(): void {}
}

const tempDirectories: string[] = [];
afterEach(async () => {
  while (tempDirectories.length > 0) {
    const dir = tempDirectories.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

describe('WiiM protocol parsers', () => {
  it('decodes hex UTF-8 metadata and treats LinkPlay unknown sentinels as null', () => {
    expect(decodeWiimHex(toHex('Håkan Hellström'))).toBe('Håkan Hellström');
    expect(decodeWiimHex('556E6B6E6F776E')).toBeNull(); // "Unknown"
    expect(decodeWiimHex('unknow')).toBeNull();
    expect(decodeWiimHex('un_known')).toBeNull();
    expect(decodeWiimHex('')).toBeNull();
    expect(decodeWiimHex(null)).toBeNull();
  });

  it('parses getPlayerStatus including mode labels, volume, playback, metadata and position', () => {
    const spotify = parseWiimPlayerStatus(
      makePlayerStatus({
        mode: '31',
        status: 'play',
        vol: '42',
        Title: toHex('Track One'),
        Artist: toHex('Artist A'),
        Album: toHex('Album B'),
        curpos: '45000',
        totlen: '210000',
      }),
    );
    expect(spotify).toEqual({
      mode: '31',
      playback: 'playing',
      volume: 0.42,
      source: 'Spotify',
      title: 'Track One',
      artist: 'Artist A',
      album: 'Album B',
      positionSeconds: 45,
      durationSeconds: 210,
    });

    const optical = parseWiimPlayerStatus(
      makePlayerStatus({
        mode: '43',
        status: 'stop',
        vol: '53',
        curpos: '148793',
        totlen: '208810',
      }),
      { '43': 'Optical' },
    );
    expect(optical.source).toBe('Optical');
    expect(optical.playback).toBe('idle');
    expect(optical.volume).toBe(0.53);
    // Stale curpos/totlen from a previous stream are suppressed on physical inputs.
    expect(optical.positionSeconds).toBeUndefined();
    expect(optical.durationSeconds).toBeUndefined();
  });

  it('parses read-only diagnostics from getStatusEx, getPresetInfo and EQGetBand', () => {
    expect(
      parseWiimStatusEx(
        JSON.stringify({
          DeviceName: 'Brunos rum',
          firmware: 'Linkplay.5.2.833833',
          project: 'WiiM_Amp_Ultra',
          RSSI: '-28',
          max_volume: '80',
          BleRemoteBatterylevel: '65',
        }),
      ),
    ).toEqual({
      deviceName: 'Brunos rum',
      firmware: 'Linkplay.5.2.833833',
      project: 'WiiM_Amp_Ultra',
      rssi: -28,
      maxVolume: 80,
      remoteBatteryPercent: 65,
    });

    expect(
      parseWiimPresetInfo(
        JSON.stringify({
          preset_num: 2,
          preset_list: [
            { number: 1, name: 'DJ', source: 'SPOTIFY' },
            { number: 99, name: 'Out of range', source: 'SPOTIFY' },
          ],
        }),
      ),
    ).toEqual([{ number: 1, name: 'DJ', source: 'SPOTIFY' }]);

    expect(
      parseWiimEqBand(
        JSON.stringify({ status: 'OK', EQStat: 'On', Name: 'Bass Booster' }),
      ),
    ).toBe('Bass Booster');
    expect(
      parseWiimEqBand(
        JSON.stringify({ status: 'OK', EQStat: 'Off', Name: 'Flat' }),
      ),
    ).toBe('Off');
  });

  it('parses UPnP GENA LastChange XML notifications for AVTransport and RenderingControl', () => {
    const avtXml = `<?xml version='1.0'?>
      <e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0">
        <e:property>
          <LastChange>&lt;Event&gt;&lt;InstanceID val=&quot;0&quot;&gt;&lt;TransportState val=&quot;PLAYING&quot;/&gt;&lt;CurrentTrackURI val=&quot;OPTICAL&quot;/&gt;&lt;/InstanceID&gt;&lt;/Event&gt;</LastChange>
        </e:property>
      </e:propertyset>`;
    expect(parseWiimUpnpLastChange('avtransport', avtXml)).toEqual({
      service: 'avtransport',
      transportState: 'playing',
      trackUri: 'OPTICAL',
    });

    const rcXml = `<LastChange>&lt;Event&gt;&lt;InstanceID val=&quot;0&quot;&gt;&lt;Mute channel=&quot;Master&quot; val=&quot;0&quot;/&gt;&lt;Volume channel=&quot;Master&quot; val=&quot;47&quot;/&gt;&lt;/InstanceID&gt;&lt;/Event&gt;</LastChange>`;
    expect(parseWiimUpnpLastChange('rendering_control', rcXml)).toEqual({
      service: 'rendering_control',
      volume: 0.47,
      mute: false,
    });
  });

  it('maps friendly source labels to LinkPlay switchmode values', () => {
    expect(sourceNameToWiimSwitchMode('Optical In')).toBe('optical');
    expect(sourceNameToWiimSwitchMode('Optical')).toBe('optical');
    expect(sourceNameToWiimSwitchMode('Spotify')).toBe('wifi');
    expect(sourceNameToWiimSwitchMode('Line In')).toBe('line-in');
    expect(sourceNameToWiimSwitchMode('HDMI')).toBe('hdmi');
    expect(sourceNameToWiimSwitchMode('Unknown Source')).toBeNull();
  });
});

describe('WiimMusicAdapter', () => {
  it('enforces LAN-only hosts and distinct targets', () => {
    const clock = new FakeClock(1_000_000);
    const transport = new FakeWiimTransport();
    expect(
      () =>
        new WiimMusicAdapter(
          { targets: { 'music.room': { host: '8.8.8.8' } } },
          transport,
          clock,
        ),
    ).toThrow();
    expect(
      () =>
        new WiimMusicAdapter(
          {
            targets: {
              'music.a': { host: '192.168.10.194' },
              'music.b': { host: '192.168.10.194' },
            },
          },
          transport,
          clock,
        ),
    ).toThrow();
  });

  it('polls, loads diagnostics, handles UPnP push immediately, and preserves playbackChangedAt across metadata updates', async () => {
    const clock = new FakeClock(1_700_000_000_000);
    const transport = new FakeWiimTransport();
    let emitUpnp: ((event: WiimUpnpEvent) => void) | undefined;
    let unsubscribed = false;

    const adapter = new WiimMusicAdapter(
      {
        targets: {
          'music.room': {
            host: '192.168.10.194',
            pollIntervalMs: 5_000,
            upnpPush: true,
          },
        },
      },
      transport,
      clock,
      {
        subscribeUpnp: (_host, _port, onEvent) => {
          emitUpnp = onEvent;
          return () => {
            unsubscribed = true;
          };
        },
      },
    );

    const observations: MusicObservation[] = [];
    adapter.subscribe((obs) => observations.push(obs));
    adapter.start();
    for (let i = 0; i < 6; i++) await Promise.resolve();

    expect(observations).toHaveLength(1);
    expect(observations[0]!.available).toBe(true);
    expect(observations[0]!.values.source).toBe('Optical In');
    expect(observations[0]!.values.volume).toBe(0.53);
    expect(adapter.isTargetTrusted('music.room')).toBe(true);
    expect(adapter.isConnected()).toBe(true);

    const initialPlaybackChangedAt = observations[0]!.playbackChangedAt;
    expect(adapter.getDeviceInfo('music.room')).toEqual({
      deviceName: 'Brunos rum',
      firmware: 'Linkplay.5.2.833833',
      project: 'WiiM_Amp_Ultra',
      rssi: -28,
      maxVolume: 80,
      remoteBatteryPercent: 65,
      eqName: 'Bass Booster',
      presets: [
        { number: 1, name: 'DJ', source: 'SPOTIFY' },
        { number: 2, name: 'Chill', source: 'SPOTIFY' },
      ],
    });

    // Metadata/volume change without playback change keeps playbackChangedAt intact.
    clock.advanceBy(2_000);
    transport.statusBody = makePlayerStatus({
      mode: '31',
      status: 'play',
      vol: '40',
      Title: toHex('New Track'),
    });
    emitUpnp?.({ service: 'rendering_control', volume: 0.4 });
    // Immediate push emission before the async getPlayerStatus refresh finishes.
    expect(observations).toHaveLength(2);
    expect(observations[1]!.values.volume).toBe(0.4);
    expect(observations[1]!.provenance?.source).toBe('wiim.upnp_push');
    expect(observations[1]!.playbackChangedAt).toBe(initialPlaybackChangedAt);

    await Promise.resolve();
    await Promise.resolve();
    expect(observations).toHaveLength(3);
    expect(observations[2]!.values.source).toBe('Spotify');
    expect(observations[2]!.values.title).toBe('New Track');
    expect(observations[2]!.playbackChangedAt).toBe(initialPlaybackChangedAt);

    // Pure readStatus must NOT emit to subscribers.
    const countBeforeRead = observations.length;
    const read = await adapter.readStatus('music.room');
    expect(observations).toHaveLength(countBeforeRead);
    expect(read.values.source).toBe('Spotify');
    expect(read.provenance?.source).toBe('wiim.status_read');

    await adapter.stop();
    expect(unsubscribed).toBe(true);
    expect(transport.disposed).toBe(true);
  });

  it('dispatches playback, volume, allowlisted sources, and presets directly to the WiiM', async () => {
    const clock = new FakeClock(1_700_000_000_000);
    const transport = new FakeWiimTransport();
    const adapter = new WiimMusicAdapter(
      {
        targets: {
          'music.room': {
            host: '192.168.10.194',
            sources: ['Spotify', 'Optical In'],
            presets: { spotify_dj: 1, optical: 4 },
            upnpPush: false,
          },
        },
      },
      transport,
      clock,
    );

    await adapter.dispatch({
      id: 'c1',
      target: 'music.room',
      requested: { property: 'playback', value: 'paused' },
    });
    await adapter.dispatch({
      id: 'c2',
      target: 'music.room',
      requested: { property: 'playback', value: 'playing' },
    });
    await adapter.dispatch({
      id: 'c3',
      target: 'music.room',
      requested: { property: 'volume', value: 0.37 },
    });
    await adapter.dispatch({
      id: 'c4',
      target: 'music.room',
      requested: { property: 'source', value: 'Optical In' },
    });
    await adapter.dispatch({
      id: 'c5',
      target: 'music.room',
      requested: { property: 'preset', value: 'spotify_dj' },
    });
    await adapter.dispatch({
      id: 'c5n',
      target: 'music.room',
      requested: { property: 'track', value: 'next' },
    });
    await adapter.dispatch({
      id: 'c5p',
      target: 'music.room',
      requested: { property: 'track', value: 'previous' },
    });

    const sent = transport.commands
      .map((c) => c.command)
      .filter(
        (cmd) =>
          cmd.startsWith('setPlayerCmd:') ||
          cmd.startsWith('MCUKeyShortClick:'),
      );
    expect(sent).toEqual([
      'setPlayerCmd:pause',
      'setPlayerCmd:play',
      'setPlayerCmd:vol:37',
      'setPlayerCmd:switchmode:optical',
      'MCUKeyShortClick:1',
      'setPlayerCmd:next',
      'setPlayerCmd:prev',
    ]);

    // Source outside allowlist is rejected without hitting the network.
    const countBefore = transport.commands.length;
    await expect(
      adapter.dispatch({
        id: 'c6',
        target: 'music.room',
        requested: { property: 'source', value: 'HDMI' },
      }),
    ).rejects.toThrow(/not allowed/i);
    expect(transport.commands).toHaveLength(countBefore);

    // Explicit device rejection fails the command.
    transport.commandReply = 'unknown command';
    await expect(
      adapter.dispatch({
        id: 'c7',
        target: 'music.room',
        requested: { property: 'playback', value: 'paused' },
      }),
    ).rejects.toThrow(/rejected/i);

    await adapter.stop();
  });

  it('marks target unavailable and untrusted after consecutive poll failures', async () => {
    const clock = new FakeClock(1_700_000_000_000);
    const transport = new FakeWiimTransport();
    const adapter = new WiimMusicAdapter(
      {
        targets: {
          'music.room': {
            host: '192.168.10.194',
            pollIntervalMs: 5_000,
            upnpPush: false,
          },
        },
      },
      transport,
      clock,
    );
    const observations: MusicObservation[] = [];
    adapter.subscribe((obs) => observations.push(obs));

    await adapter.refreshNow('music.room');
    expect(adapter.isTargetTrusted('music.room')).toBe(true);

    transport.failStatus = true;
    await adapter.refreshNow('music.room');
    await adapter.refreshNow('music.room');
    expect(adapter.isTargetTrusted('music.room')).toBe(true); // tolerates 2 transient drops
    await adapter.refreshNow('music.room');
    expect(adapter.isTargetTrusted('music.room')).toBe(false);
    expect(observations.at(-1)?.available).toBe(false);

    await adapter.stop();
  });
});

describe('CompositeMusicAdapter and runtime config integration', () => {
  it('routes commands, readStatus and subscriptions by target', async () => {
    const clock = new FakeClock(1_000);
    const a = new SimulatedMusicAdapter(clock);
    const b = new SimulatedMusicAdapter(clock);
    const composite = new CompositeMusicAdapter([
      { targets: ['music.ha'], adapter: a },
      { targets: ['music.wiim'], adapter: b },
    ]);
    const seen: string[] = [];
    composite.subscribe((obs) => seen.push(obs.target));

    await composite.dispatch({
      id: '1',
      target: 'music.ha',
      requested: { property: 'volume', value: 0.2 },
    });
    await composite.dispatch({
      id: '2',
      target: 'music.wiim',
      requested: { property: 'volume', value: 0.4 },
    });
    expect(a.dispatched).toHaveLength(1);
    expect(b.dispatched).toHaveLength(1);

    a.observe('music.ha', {
      playback: 'playing',
      volume: 0.2,
      source: 'Spotify',
      title: null,
    });
    b.observe('music.wiim', {
      playback: 'idle',
      volume: 0.4,
      source: 'Optical In',
      title: null,
    });
    expect(seen).toEqual(['music.ha', 'music.wiim']);
  });

  it('rejects duplicate targets configured in both homeAssistant.music and wiim.music', () => {
    const base = {
      homeAssistant: {
        baseUrl: 'http://192.168.10.5:8123',
        tokenEnv: 'HA_TOKEN',
        entities: { 'lighting.desk': 'light.desk' },
        music: {
          'music.room': {
            entityId: 'media_player.wiim',
            sources: ['Optical In'],
          },
        },
      },
      wiim: {
        music: {
          'music.room': {
            host: '192.168.10.194',
          },
        },
      },
    };
    expect(() => validateRuntimeFileConfig(base)).toThrow(
      /both homeAssistant\.music and wiim\.music/i,
    );
  });

  it('boots startRuntime with a direct wiim.music target without any HA media_player entity', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lugn-wiim-rt-'));
    tempDirectories.push(dir);
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const assigned = (probe.address() as AddressInfo).port;
        probe.close((err) => (err ? reject(err) : resolve(assigned)));
      });
    });
    const configPath = join(dir, 'config.json');
    process.env['LUGN_TEST_HA_TOKEN'] = 'synthetic-token';
    await writeFile(
      configPath,
      JSON.stringify({
        http: { host: '127.0.0.1', port },
        homeAssistant: {
          baseUrl: 'http://127.0.0.1:8123',
          tokenEnv: 'LUGN_TEST_HA_TOKEN',
          entities: { 'lighting.desk': 'light.desk' },
        },
        scenes: [],
        wiim: {
          music: {
            'music.room': {
              host: '192.168.10.194',
              upnpPush: false,
            },
          },
        },
      }),
    );

    const transport = new FakeWiimTransport();
    const runtime = await startRuntime(configPath, {
      lightingIntentPath: join(dir, 'intent.json'),
      homeAssistantFetch: async () =>
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      createHomeAssistantSocket: () => new InertSocket(),
      wiimTransport: transport,
    });
    try {
      // Allow initial poll microtasks to settle.
      await new Promise((resolve) => setTimeout(resolve, 25));
      const device = runtime.engine.state.music.devices['music.room'];
      expect(device).toBeDefined();
      expect(device?.availability).toBe('available');
      expect(device?.observed.source).toBe('Optical In');
      expect(device?.observed.volume).toBe(0.53);
    } finally {
      await runtime.stop();
      delete process.env['LUGN_TEST_HA_TOKEN'];
    }
  });
});
