import { createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HomeAssistantPrinterAdapter,
  taskTitle,
} from '../src/adapters/home-assistant-printer.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { CapabilityRegistry } from '../src/application/capabilities.js';
import { FakeClock } from '../src/core/clock.js';
import { LugnDisplayServer } from '../src/runtime/display-server.js';
import { PrinterActivityService } from '../src/runtime/printer-activity-service.js';

const prefix = 'a1_0123456789';
const at = Date.parse('2026-11-20T16:20:00Z');
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBZkAAAAASUVORK5CYII=',
  'base64',
);

function state(
  suffix: string,
  value: string,
  attributes: Record<string, unknown> = {},
  changed = '2026-11-20T15:40:00Z',
) {
  const domain = suffix === 'cover_image' ? 'image' : 'sensor';
  return {
    entity_id: `${domain}.${prefix}_${suffix}`,
    state: value,
    attributes,
    last_changed: changed,
    last_updated: '2026-11-20T16:19:30Z',
  };
}

/** The shape ha-bambulab v2.2 reports for an A1 mid-print. */
function printing(adapter: HomeAssistantPrinterAdapter) {
  for (const item of [
    state('print_status', 'running'),
    state('current_stage', 'printing'),
    state('print_progress', '45', { unit_of_measurement: '%' }),
    state('remaining_time', '0.483333333333333', { unit_of_measurement: 'h' }),
    state('current_layer', '22'),
    state('total_layer_count', '144'),
    state('task_name', 'obj_4_Stand.stl + obj_5_Box.stl + obj_6_Lid.stl + '),
    state('printer_name', 'A1'),
    state('nozzle_temperature', '219.6'),
    state('nozzle_target_temperature', '220'),
    state('bed_temperature', '60'),
    state('bed_target_temperature', '60'),
    state('cover_image', '2026-11-20T16:54:53.841064', {
      entity_picture: '/api/image_proxy/image.x?token=secret',
    }),
  ])
    expect(adapter.acceptState(item)).toBe(true);
}

describe('Home Assistant printer adapter', () => {
  it('turns a running Bambu print into one live activity', () => {
    const clock = new FakeClock(at);
    const adapter = new HomeAssistantPrinterAdapter(
      { entityPrefix: prefix, resultVisibleMinutes: 20 },
      clock,
    );
    expect(adapter.activity()).toBeNull();
    printing(adapter);
    expect(adapter.activity()).toEqual({
      name: 'A1',
      status: 'printing',
      stage: 'printing',
      progress: 45,
      remainingMinutes: 29,
      endsAt: Date.parse('2026-11-20T16:19:30Z') + 29 * 60_000,
      layer: 22,
      totalLayers: 144,
      task: 'Stand + Box + Lid + …',
      nozzle: { current: 220, target: 220 },
      bed: { current: 60, target: 60 },
      statusSince: Date.parse('2026-11-20T15:40:00Z'),
      coverRevision: '2026-11-20T16:54:53.841064',
      observedAt: Date.parse('2026-11-20T16:19:30Z'),
    });
  });

  it('ignores other entities and uses the configured name', () => {
    const adapter = new HomeAssistantPrinterAdapter(
      { entityPrefix: prefix, name: 'Skrivaren', resultVisibleMinutes: 20 },
      new FakeClock(at),
    );
    expect(adapter.acceptState(state('print_status', 'running'))).toBe(true);
    expect(
      adapter.acceptState({
        entity_id: 'sensor.other_print_status',
        state: 'running',
      }),
    ).toBe(false);
    expect(adapter.activity()?.name).toBe('Skrivaren');
  });

  it('shows a finished print for the result window, then hides it', () => {
    const clock = new FakeClock(at);
    const adapter = new HomeAssistantPrinterAdapter(
      { entityPrefix: prefix, resultVisibleMinutes: 20 },
      clock,
    );
    printing(adapter);
    adapter.acceptStateChangedEvent({
      type: 'event',
      event: {
        event_type: 'state_changed',
        data: {
          entity_id: `sensor.${prefix}_print_status`,
          new_state: state(
            'print_status',
            'finish',
            {},
            '2026-11-20T16:20:00Z',
          ),
        },
      },
    });
    expect(adapter.activity()).toMatchObject({
      status: 'finished',
      progress: 100,
      remainingMinutes: 0,
      endsAt: null,
    });
    clock.advanceBy(19 * 60_000);
    expect(adapter.activity()?.status).toBe('finished');
    clock.advanceBy(2 * 60_000);
    expect(adapter.activity()).toBeNull();
  });

  it('hides an idle, offline or unavailable printer', () => {
    const adapter = new HomeAssistantPrinterAdapter(
      { entityPrefix: prefix, resultVisibleMinutes: 20 },
      new FakeClock(at),
    );
    for (const value of ['idle', 'offline', 'unavailable', 'unknown']) {
      adapter.acceptState(state('print_status', value));
      expect(adapter.activity()).toBeNull();
    }
    adapter.acceptStateChangedEvent({
      entity_id: `sensor.${prefix}_print_status`,
      new_state: null,
    });
    expect(adapter.snapshot().status).toBe('offline');
  });

  it('reads older minute-based remaining time', () => {
    const adapter = new HomeAssistantPrinterAdapter(
      { entityPrefix: prefix, resultVisibleMinutes: 20 },
      new FakeClock(at),
    );
    adapter.acceptState(state('print_status', 'pause'));
    adapter.acceptState(
      state('remaining_time', '95', { unit_of_measurement: 'min' }),
    );
    expect(adapter.activity()).toMatchObject({
      status: 'paused',
      remainingMinutes: 95,
    });
  });

  it('words slicer task names for people', () => {
    expect(
      taskTitle('obj_1_Ball Joint Stand.stl + obj_2_Cable_Mount.3mf'),
    ).toBe('Ball Joint Stand + Cable Mount');
    expect(taskTitle('Plate_1')).toBe('Plate 1');
    expect(taskTitle('  ')).toBeNull();
  });
});

describe('printer live activity on the Hub', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function setup() {
    const finder = createServer();
    await new Promise<void>((resolve) =>
      finder.listen(0, '127.0.0.1', resolve),
    );
    const address = finder.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const port = address.port;
    await new Promise<void>((resolve) => finder.close(() => resolve()));
    const clock = new FakeClock(at);
    const adapter = new HomeAssistantPrinterAdapter(
      { entityPrefix: prefix, resultVisibleMinutes: 20 },
      clock,
    );
    // ha-bambulab labels its PNG cover image/jpeg; the bytes decide.
    const upstream = vi.fn<typeof fetch>(
      async () =>
        new Response(png, { headers: { 'content-type': 'image/jpeg' } }),
    );
    const printer = new PrinterActivityService(
      adapter,
      { baseUrl: 'http://ha.test', token: 'private' },
      upstream,
    );
    const engine = new LugnEngine(clock, {});
    const hubToken = 'b'.repeat(32);
    const server = new LugnDisplayServer({
      host: '127.0.0.1',
      port,
      hubs: [
        { id: 'bed', role: 'bed', token: hubToken, castHost: '127.0.0.1' },
      ],
      capabilities: new CapabilityRegistry(engine),
      scenes: [...engine.scenes.values()],
      stateProvider: () => engine.state,
      printer,
    });
    await server.start();
    cleanups.push(async () => {
      await server.stop();
      engine.dispose();
    });
    return {
      adapter,
      upstream,
      origin: `http://127.0.0.1:${port}`,
      base: `http://127.0.0.1:${port}/k/${hubToken}/display-api`,
    };
  }

  it('sends the print and proxies its cover without HA credentials', async () => {
    const f = await setup();
    const idle = (await (await fetch(`${f.base}/state`)).json()) as {
      printer: unknown;
    };
    expect(idle.printer).toBeNull();
    printing(f.adapter);
    const payload = (await (await fetch(`${f.base}/state`)).json()) as {
      printer: { status: string; progress: number; imageUrl: string };
    };
    expect(payload.printer).toMatchObject({ status: 'printing', progress: 45 });
    expect(payload.printer).not.toHaveProperty('coverRevision');
    expect(payload.printer.imageUrl).toMatch(
      /^\/k\/b{32}\/display-api\/printer\/cover\/[A-Za-z0-9_-]{32}$/,
    );
    expect(JSON.stringify(payload)).not.toContain('secret');

    for (let index = 0; index < 2; index++) {
      const image = await fetch(`${f.origin}${payload.printer.imageUrl}`);
      expect(image.status).toBe(200);
      expect(image.headers.get('content-type')).toBe('image/png');
      expect(Buffer.from(await image.arrayBuffer()).equals(png)).toBe(true);
    }
    expect(f.upstream).toHaveBeenCalledTimes(1);
    const [url, init] = f.upstream.mock.calls[0]!;
    expect(url).toBe(
      `http://ha.test/api/image_proxy/image.${prefix}_cover_image`,
    );
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer private',
    );

    const guessed = await fetch(`${f.base}/printer/cover/${'c'.repeat(32)}`);
    expect(guessed.status).toBe(404);

    // A new print publishes a new cover, and the old link stops working.
    f.adapter.acceptState(
      state('cover_image', '2026-11-20T18:00:00.000000', {}),
    );
    expect((await fetch(`${f.origin}${payload.printer.imageUrl}`)).status).toBe(
      404,
    );
  });

  it('refuses a cover that is not an image', async () => {
    const f = await setup();
    printing(f.adapter);
    f.upstream.mockResolvedValueOnce(
      new Response('<html>', { headers: { 'content-type': 'image/jpeg' } }),
    );
    const payload = (await (await fetch(`${f.base}/state`)).json()) as {
      printer: { imageUrl: string };
    };
    expect((await fetch(`${f.origin}${payload.printer.imageUrl}`)).status).toBe(
      404,
    );
  });
});
