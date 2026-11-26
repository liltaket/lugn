import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { HubSettingsService } from '../src/application/hub-settings.js';
import type { HubSettings } from '../src/core/hub-settings.js';
import { defaultPresenceFeedbackSettings } from '../src/core/presence-feedback.js';
import { CapabilityRegistry } from '../src/application/capabilities.js';
import { FakeClock } from '../src/core/clock.js';
import { HubRulesSchema, type HubRule } from '../src/core/hub-rules.js';
import { LugnDisplayServer } from '../src/runtime/display-server.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const bedToken = 'b'.repeat(32);
const deskToken = 'd'.repeat(32);

async function freePort(): Promise<number> {
  const finder = createServer();
  await new Promise<void>((resolve) => finder.listen(0, '127.0.0.1', resolve));
  const address = finder.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  await new Promise<void>((resolve) => finder.close(() => resolve()));
  return address.port;
}

async function setup(
  rules: HubRule[] | undefined,
  hubSettings?: HubSettingsService,
) {
  const clock = new FakeClock(Date.parse('2026-11-24T12:00:00+01:00'));
  const engine = new LugnEngine(clock);
  cleanups.push(async () => engine.dispose());
  const port = await freePort();
  const server = new LugnDisplayServer({
    host: '127.0.0.1',
    port,
    hubs: [
      { id: 'bed', role: 'bed', token: bedToken, castHost: '127.0.0.1' },
      { id: 'desk', role: 'desk', token: deskToken, castHost: '127.0.0.1' },
    ],
    capabilities: new CapabilityRegistry(engine),
    scenes: [...engine.scenes.values()],
    stateProvider: () => engine.state,
    ...(rules ? { hubRules: rules } : {}),
    ...(hubSettings ? { hubSettings } : {}),
  });
  await server.start();
  cleanups.push(() => server.stop());
  const origin = `http://127.0.0.1:${port}`;
  const read = async (token: string) =>
    (await (await fetch(`${origin}/k/${token}/display-api/state`)).json()) as {
      hubPolicy?: Record<string, unknown>;
    };
  return {
    engine,
    clock,
    origin,
    bed: () => read(bedToken),
    desk: () => read(deskToken),
  };
}

describe('Hub rules in the display payload', () => {
  it('adds nothing to a Hub payload when no rules are configured', async () => {
    const t = await setup(undefined);
    expect('hubPolicy' in (await t.bed())).toBe(false);
    const none = await setup([]);
    expect('hubPolicy' in (await none.bed())).toBe(false);
  });

  it('gives each Hub the policy that is true for it', async () => {
    const rules = HubRulesSchema.parse([
      {
        id: 'away-calm',
        when: { home: 'away' },
        then: { only: ['clock'], dim: 0.5 },
      },
      {
        id: 'bed-night-tag',
        hubs: { role: 'bed' },
        when: { home: 'home' },
        then: { tags: ['bed-home'] },
      },
    ]);
    const t = await setup(rules);
    await t.engine.handleHomePresence('home', t.clock.now());
    const home = await t.bed();
    expect(home.hubPolicy).toMatchObject({
      pages: null,
      dim: 1,
      tags: ['bed-home'],
      rules: ['bed-night-tag'],
    });
    expect((await t.desk()).hubPolicy).toMatchObject({ tags: [], rules: [] });

    await t.engine.handleHomePresence('away', t.clock.now());
    const away = await t.desk();
    expect(away.hubPolicy).toMatchObject({
      pages: ['clock'],
      dim: 0.5,
      rules: ['away-calm'],
    });
  });

  it('serves the new scripts and styles to an authenticated Hub only', async () => {
    const t = await setup(undefined);
    for (const [file, type] of [
      ['hub-policy.js', 'text/javascript; charset=utf-8'],
      ['presence-chip.js', 'text/javascript; charset=utf-8'],
      ['presence-chip.css', 'text/css; charset=utf-8'],
      ['greeting-page.js', 'text/javascript; charset=utf-8'],
      ['greeting-page.css', 'text/css; charset=utf-8'],
      ['computer-page.js', 'text/javascript; charset=utf-8'],
      ['computer-page.css', 'text/css; charset=utf-8'],
      ['settings-page.js', 'text/javascript; charset=utf-8'],
      ['settings-page.css', 'text/css; charset=utf-8'],
    ] as const) {
      const response = await fetch(`${t.origin}/k/${bedToken}/${file}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(type);
      expect(await response.text()).toBe(
        readFileSync(new URL(`../src/ui/${file}`, import.meta.url), 'utf8'),
      );
      expect(
        (await fetch(`${t.origin}/k/${'x'.repeat(32)}/${file}`)).status,
      ).toBe(404);
    }
  });
});

describe('Settings from a Hub', () => {
  function settings() {
    let presence = structuredClone(defaultPresenceFeedbackSettings);
    const saved: HubSettings[] = [];
    const service = new HubSettingsService({
      rules: HubRulesSchema.parse([
        { id: 'vadra', when: { air: 'stuffy' }, then: { tags: ['vadra'] } },
        {
          id: 'film',
          switch: 'film',
          when: { watching: true },
          then: { dim: 0.5 },
        },
      ]),
      save: async (value) => {
        saved.push(value);
        return value;
      },
      presence: {
        getSettings: () => structuredClone(presence),
        updateSettings: async (value) => (presence = value),
      },
    });
    return { service, saved, grace: () => presence.exitGraceSeconds };
  }

  it('lists only what there is something to change', async () => {
    const t = await setup(undefined, settings().service);
    const body = (await t.bed()) as { settings?: Array<{ id: string }> };
    expect(body.settings?.map((item) => item.id)).toEqual([
      'exitGrace',
      'airPpm',
      'chime',
      'film',
    ]);
  });

  it('saves an offered value and refuses any other, or another origin', async () => {
    const s = settings();
    const t = await setup(undefined, s.service);
    const post = (body: unknown, origin = t.origin) =>
      fetch(`${t.origin}/k/${bedToken}/display-api/setting`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify(body),
      });
    expect((await post({ id: 'exitGrace', value: 120 })).status).toBe(200);
    expect(s.grace()).toBe(120);
    expect((await post({ id: 'exitGrace', value: 7 })).status).toBe(400);
    expect((await post({ id: 'cameraAuto', value: true })).status).toBe(400);
    expect((await post({ id: 'film', value: 1 })).status).toBe(400);
    expect(
      (await post({ id: 'exitGrace', value: 300 }, 'http://evil.example'))
        .status,
    ).toBe(403);
    expect(s.grace()).toBe(120);
    expect((await post({ id: 'film', value: false })).status).toBe(200);
    expect(s.saved.at(-1)).toMatchObject({ film: false, airPpm: 1000 });
    expect(s.service.own().film).toBe(false);
  });
});

describe('Home status facts in the engine', () => {
  it('records when the status changed and when the resident came home', async () => {
    const clock = new FakeClock(1_000_000);
    const engine = new LugnEngine(clock);
    cleanups.push(async () => engine.dispose());
    const home = () => engine.state.presence.home;

    // The first answer after a restart is not an arrival.
    await engine.handleHomePresence('home', 1_000_000);
    expect(home()).toMatchObject({
      state: 'home',
      since: 1_000_000,
      arrivedAt: null,
    });

    // A repeated observation keeps the time the status began.
    await engine.handleHomePresence('home', 1_500_000);
    expect(home()).toMatchObject({
      state: 'home',
      observedAt: 1_500_000,
      since: 1_000_000,
    });

    await engine.handleHomePresence('away', 2_000_000);
    expect(home()).toMatchObject({
      state: 'away',
      since: 2_000_000,
      arrivedAt: null,
    });

    await engine.handleHomePresence('home', 3_000_000);
    expect(home()).toMatchObject({
      state: 'home',
      since: 3_000_000,
      arrivedAt: 3_000_000,
    });

    // Unknown is not an arrival and has no start.
    await engine.handleHomePresence('unknown', 3_100_000);
    expect(home()).toMatchObject({ state: 'unknown', since: null });
    await engine.handleHomePresence('home', 3_200_000);
    expect(home()).toMatchObject({
      state: 'home',
      since: 3_200_000,
      arrivedAt: 3_000_000,
    });

    // Leaving clears it.
    await engine.handleHomePresence('away', 4_000_000);
    expect(home().arrivedAt).toBeNull();
  });
});

describe('Hub rules configuration', () => {
  it('lists the new files with the pager assets', () => {
    const html = readFileSync(
      new URL('../src/ui/display.html', import.meta.url),
      'utf8',
    );
    for (const asset of ['hub-policy.js', 'presence-chip.js'])
      expect(html).toContain(`<script src="./${asset}" defer></script>`);
    expect(html).toContain(
      '<link rel="stylesheet" href="./presence-chip.css" />',
    );
    // Rules are applied after the pager exists.
    expect(html.indexOf('./hub-policy.js')).toBeGreaterThan(
      html.indexOf('./pages.js'),
    );
  });
});
