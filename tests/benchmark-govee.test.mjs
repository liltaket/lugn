import { describe, expect, it } from 'vitest';
import {
  ownsLease,
  restoreLease,
  runStatic,
} from '../scripts/benchmark-govee.mjs';

const target = 'lighting.fixture';
const runtime = {
  homeAssistant: {
    baseUrl: 'http://ha.test',
    token: 'fixture',
    entities: { [target]: 'light.fixture' },
  },
  http: { port: 8787, bearerToken: 'fixture' },
};
function fixture({ revoked = false, owned = true } = {}) {
  const native = {
    onOff: 0,
    brightness: 50,
    color: { r: 0, g: 0, b: 0 },
    colorTemInKelvin: 2700,
  };
  let lease = owned ? { id: 'owned', canActivate: !revoked } : undefined;
  const calls = [];
  const fetcher = async (url, options = {}) => {
    const path = new URL(url).pathname;
    const input = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ path, input });
    let body;
    if (path === '/state')
      body = {
        lighting: { devices: { [target]: { externalControl: lease } } },
      };
    else if (path.endsWith('beginExternalControl')) {
      lease = { id: 'owned', canActivate: true };
      body = { controlId: 'owned' };
    } else if (path.endsWith('endExternalControl')) {
      lease = undefined;
      native.onOff = 0;
      body = { accepted: true };
    } else if (path === '/api/services/light/turn_on') {
      native.onOff = 1;
      if (input.color_temp_kelvin !== undefined)
        native.colorTemInKelvin = input.color_temp_kelvin;
      if (input.brightness !== undefined)
        native.brightness = Math.floor((input.brightness * 100) / 255);
      else if (input.brightness_pct !== undefined)
        native.brightness = input.brightness_pct;
      body = [];
    } else if (path === '/api/states/light.fixture')
      body = {
        state: native.onOff ? 'on' : 'off',
        attributes: {
          brightness: Math.round((native.brightness * 255) / 100),
          color_temp_kelvin: 2700,
          color_mode: native.onOff ? 'color_temp' : null,
        },
      };
    else throw new Error('Unexpected fixture route');
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { native, fetcher, calls };
}
describe('Govee hardware benchmark boundaries', () => {
  it('does not count a retained but revoked lease as activation permission', async () => {
    const f = fixture({ revoked: true });
    expect(await ownsLease(f.fetcher, runtime, target, 'owned')).toBe(false);
  });
  it('releases a revoked owned generation without a positive restoration write', async () => {
    const f = fixture({ revoked: true });
    const result = await restoreLease(
      f.fetcher,
      runtime,
      target,
      'light.fixture',
      'owned',
      { power: true, brightnessPct: 50, kelvin: 2700 },
    );
    expect(result.positiveRestorationSkipped).toBe('confirmed_exit');
    expect(f.calls.some((c) => c.path === '/api/services/light/turn_on')).toBe(
      false,
    );
    expect(f.calls.some((c) => c.path.endsWith('endExternalControl'))).toBe(
      true,
    );
  });
  it('compares LAN and HA brightness only after the same verified ON precondition', async () => {
    const f = fixture({ owned: false });
    const sends = [];
    const lan = {
      ensureReachable: async () => ({
        ip: '192.0.2.2',
        status: { ...f.native },
      }),
      status: async () => ({ ...f.native }),
      send: async (_ip, command) => {
        sends.push({ wasOn: f.native.onOff, command });
        f.native.brightness = command.msg.data.value;
      },
    };
    const result = await runStatic({
      device: { id: 'fixture', sku: 'H612A', target },
      runtime,
      lan,
      ws: { status: 'disconnected' },
      fetcher: f.fetcher,
      samples: 2,
      baseline: {},
    });
    expect(sends.length).toBe(2);
    expect(sends.every((s) => s.wasOn === 1)).toBe(true);
    expect(
      result.every(
        (s) =>
          s.success &&
          s.feedback.onOff === 1 &&
          s.feedbackKind === 'udp_devStatus_matching_brightness',
      ),
    ).toBe(true);
    expect(
      f.calls.filter((c) => c.path === '/api/services/light/turn_on')[0].input
        .brightness,
    ).toBe(23);
  });
});

it('uses the same independent Kelvin feedback for LAN and HA temperature steps', async () => {
  const f = fixture({ owned: false });
  const lan = {
    ensureReachable: async () => ({ ip: '192.0.2.2', status: { ...f.native } }),
    status: async () => ({ ...f.native }),
    send: async (_ip, command) => {
      f.native.colorTemInKelvin = command.msg.data.colorTemInKelvin;
    },
  };
  const result = await runStatic({
    device: { id: 'fixture', sku: 'H612A', target },
    runtime,
    lan,
    ws: { status: 'disconnected' },
    fetcher: f.fetcher,
    samples: 2,
    baseline: {},
    operation: 'temperature',
  });
  expect(result).toHaveLength(4);
  expect(
    result.every(
      (s) =>
        s.success &&
        s.feedbackKind === 'udp_devStatus_matching_temperature' &&
        s.feedback.colorTemInKelvin === s.requested.kelvin,
    ),
  ).toBe(true);
});
