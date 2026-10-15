import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

class Element {
  textContent = '';
  className = '';
  dataset: Record<string, string> = {};
  children: Element[] = [];
  disabled = false;
  append(...children: Element[]) {
    this.children.push(...children);
  }
  replaceChildren(...children: Element[]) {
    this.children = children;
  }
  setAttribute() {}
  addEventListener() {}
}

function webPanel() {
  const source = readFileSync(
    new URL('../web/app.js', import.meta.url),
    'utf8',
  );
  // Run production functions with a small DOM, without login/network startup.
  const functions = [
    ...source.matchAll(/^(?:async )?function \w+\([\s\S]*?^\}/gm),
  ]
    .map(([fn]) => fn)
    .join('\n');
  const elements = new Map<string, Element>();
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  const context = createContext({
    document: { createElement: () => new Element() },
    ...Object.fromEntries(
      [
        'roomPresence',
        'presenceTitle',
        'presenceDetail',
        'healthTitle',
        'healthChip',
        'integrationList',
        'liveStatus',
        'liveStatusLabel',
        'systemAlert',
      ].map((id) => [id, get(id)]),
    ),
    window: {
      setTimeout,
      clearTimeout,
      setInterval: () => 0,
      clearInterval() {},
    },
    AbortController,
    Date,
  });
  runInContext(
    `let overviewStale = false; let lastOverviewAt = 0; let overviewInstanceGeneration = 0;
    let overviewInstanceId; let overviewDeliveryRevision = -1;
    const retiredOverviewInstances = new Set();
    let overview = null; let eventSource = null; let pollTimer = null;
    let authProvider = 'token'; let clerkClient = null;
    const API_ROOT = '/ui/api'; const pendingActions = new Set();
    class SessionExpiredError extends Error {}
    ${functions}`,
    context,
  );
  return { context, get };
}

function texts(element: Element): string[] {
  return [element.textContent, ...element.children.flatMap(texts)].filter(
    Boolean,
  );
}

const device = {
  availability: 'available',
  observed: { playback: 'playing', title: 'Track', volume: 0.3 },
  requested: {},
  allowedSources: [],
};

function overviewPayload(
  revision: number,
  deliveryRevision: number,
  playback = 'playing',
  instanceId = 'runtime-a',
) {
  return {
    instanceId,
    deliveryRevision,
    state: {
      revision,
      presence: {},
      lighting: { devices: {} },
      music: {
        devices: {
          'music.room': {
            ...device,
            observed: { ...device.observed, playback },
          },
        },
      },
    },
  };
}

function liveWebPanel() {
  const ui = webPanel();
  const streams: Array<{ onmessage?: (event: { data: string }) => void }> = [];
  class EventSource {
    onmessage?: (event: { data: string }) => void;
    constructor() {
      streams.push(this);
    }
    close() {}
  }
  Object.assign(ui.context, { EventSource });
  runInContext('render = () => {}; startLiveUpdates()', ui.context);
  return {
    ...ui,
    emit: (payload: unknown) =>
      streams[0]!.onmessage?.({ data: JSON.stringify(payload) }),
    respond: (payload: unknown) => {
      ui.context['fetch'] = async () => ({
        ok: true,
        json: async () => payload,
      });
    },
  };
}

describe('web music observation labels', () => {
  it.each([
    ['playing', 'Spelar', 'Nu spelas'],
    ['paused', 'Pausad', 'Senaste titel'],
    ['idle', 'Inaktiv', 'Senaste titel'],
    ['off', 'Av', 'Senaste titel'],
    ['unknown', 'Okänt', 'Senaste titel'],
  ])('qualifies titles for %s', (playback, label, titleLabel) => {
    const ui = webPanel();
    const value = { ...device, observed: { ...device.observed, playback } };
    const article = runInContext(
      `renderMusicPlayer('music.room', ${JSON.stringify(value)}, [])`,
      ui.context,
    ) as Element;
    const content = texts(article);
    expect(content).toContain(label);
    expect(content).toContain(titleLabel);
    if (playback !== 'playing') expect(content).not.toContain('Nu spelas');
  });

  it.each(['unavailable', 'offline'])(
    'marks cached values when %s and disables commands',
    (state) => {
      const ui = webPanel();
      const value = {
        ...device,
        availability: state === 'unavailable' ? state : 'available',
      };
      runInContext(`overviewStale = ${state === 'offline'}`, ui.context);
      const article = runInContext(
        `renderMusicPlayer('music.room', ${JSON.stringify(value)}, [])`,
        ui.context,
      ) as Element;
      expect(texts(article)).toContain('Senast rapporterad titel');
      expect(texts(article)).toContain('Senast rapporterad uppspelning');
      const descendants = (item: Element): Element[] => [
        item,
        ...item.children.flatMap(descendants),
      ];
      expect(
        descendants(article).filter(
          (item) => item.textContent === 'Spela / återuppta',
        )[0]?.disabled,
      ).toBe(true);
    },
  );

  it.each(['pending', 'failed', 'unconfirmed'])(
    'keeps %s requests separate from reported playback',
    (status) => {
      const ui = webPanel();
      const value = {
        ...device,
        observed: { ...device.observed, playback: 'paused' },
        requested: { playback: 'playing' },
      };
      const commands = [
        {
          target: 'music.room',
          requested: { property: 'playback', value: 'playing' },
          status,
        },
      ];
      const article = runInContext(
        `renderMusicPlayer('music.room', ${JSON.stringify(value)}, ${JSON.stringify(commands)})`,
        ui.context,
      ) as Element;
      expect(texts(article)).toContain('Pausad');
      expect(texts(article)).not.toContain('Nu spelas');
      expect(
        texts(article).some((text) => text.startsWith('Lugn begär: Spela')),
      ).toBe(true);
    },
  );

  it('qualifies presence after failed polling and restores it after recovery', async () => {
    vi.useFakeTimers();
    try {
      const ui = webPanel();
      const data = {
        state: {
          revision: 1,
          presence: { state: 'occupied', personCount: 2 },
          lighting: { devices: {} },
        },
        health: {},
      };
      const fetch = vi
        .fn()
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => data,
        });
      Object.assign(ui.context, { fetch, data });
      runInContext(
        `overview = data; render = () => renderRoomStatus(overview)`,
        ui.context,
      );
      await runInContext('refreshOverview()', ui.context);
      expect(ui.get('presenceTitle').textContent).toBe(
        'Senast rapporterat: Någon i rummet',
      );
      await runInContext('refreshOverview()', ui.context);
      expect(ui.get('presenceTitle').textContent).toBe('Någon i rummet');
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(['http-first', 'sse-first'])(
    'orders HTTP and SSE snapshots regardless of arrival order: %s',
    async (order) => {
      const ui = liveWebPanel();
      const older = overviewPayload(10, 10, 'playing');
      const newer = overviewPayload(11, 11, 'paused');
      if (order === 'http-first') {
        ui.respond(newer);
        await runInContext('refreshOverview()', ui.context);
        ui.emit(older);
      } else {
        let release!: (value: unknown) => void;
        ui.context['fetch'] = () =>
          new Promise((resolve) => {
            release = resolve;
          });
        const poll = runInContext('refreshOverview()', ui.context);
        ui.emit(newer);
        release({ ok: true, json: async () => older });
        await poll;
      }
      expect(runInContext('overview.state.revision', ui.context)).toBe(11);
      expect(
        runInContext(
          "overview.state.music.devices['music.room'].observed.playback",
          ui.context,
        ),
      ).toBe('paused');
    },
  );

  it.each([false, true])(
    'accepts the newest overlapping poll (reverse completion: %s)',
    async (reverse) => {
      const ui = liveWebPanel();
      const releases: Array<(value: unknown) => void> = [];
      ui.context['fetch'] = () =>
        new Promise((resolve) => releases.push(resolve));
      const first = runInContext('refreshOverview()', ui.context);
      const second = runInContext('refreshOverview()', ui.context);
      const old = () =>
        releases[0]!({ ok: true, json: async () => overviewPayload(12, 12) });
      const fresh = () =>
        releases[1]!({ ok: true, json: async () => overviewPayload(13, 13) });
      if (reverse) {
        fresh();
        await second;
        old();
        await first;
      } else {
        old();
        await first;
        fresh();
        await second;
      }
      expect(runInContext('overview.state.revision', ui.context)).toBe(13);
    },
  );

  it('orders equal-revision health changes, accepts restart and rejects retired or obsolete in-flight instances', async () => {
    const ui = liveWebPanel();
    ui.emit(overviewPayload(100, 100));
    ui.respond({
      ...overviewPayload(100, 102),
      musicObservationTrust: { 'music.room': false },
    });
    await runInContext('refreshOverview()', ui.context);
    ui.emit({
      ...overviewPayload(100, 101),
      musicObservationTrust: { 'music.room': true },
    });
    expect(
      runInContext("overview.musicObservationTrust['music.room']", ui.context),
    ).toBe(false);
    ui.emit({
      ...overviewPayload(100, 103),
      musicObservationTrust: { 'music.room': true },
    });
    expect(
      runInContext("overview.musicObservationTrust['music.room']", ui.context),
    ).toBe(true);
    let release!: (value: unknown) => void;
    ui.context['fetch'] = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const poll = runInContext('refreshOverview()', ui.context);
    ui.emit(overviewPayload(1, 1, 'paused', 'runtime-b'));
    release({
      ok: true,
      json: async () => overviewPayload(200, 200, 'playing', 'runtime-c'),
    });
    await poll;
    ui.emit(overviewPayload(201, 201));
    expect(runInContext('overview.instanceId', ui.context)).toBe('runtime-b');
    expect(runInContext('overview.state.revision', ui.context)).toBe(1);
  });

  it('qualifies HA-disconnected observations while keeping commands available', () => {
    const ui = webPanel();
    runInContext(
      `overview = {health:{integrations:{home_assistant:'disconnected'}}}`,
      ui.context,
    );
    const article = runInContext(
      `renderMusicPlayer('music.room', ${JSON.stringify(device)}, [])`,
      ui.context,
    ) as Element;
    expect(texts(article)).toContain('Senast rapporterad titel');
    expect(texts(article)).not.toContain('Nu spelas');
  });

  it('keeps cached observations qualified while HA is connected but unreconciled', () => {
    const ui = webPanel();
    runInContext(
      `overview = { health: { integrations: { home_assistant: 'connected' } }, musicObservationTrust: { 'music.room': false } }`,
      ui.context,
    );
    const article = runInContext(
      `renderMusicPlayer('music.room', ${JSON.stringify(device)}, [])`,
      ui.context,
    ) as Element;
    expect(texts(article)).toContain('Senast rapporterad uppspelning');
    expect(texts(article)).toContain('Senast rapporterad volym');
    expect(texts(article)).not.toContain('Nu spelas');
  });

  it('qualifies older observations without permanently locking controls after recovery', () => {
    const ui = webPanel();
    const commands = [
      {
        target: 'music.room',
        requested: { property: 'playback', value: 'paused' },
        status: 'unconfirmed',
        recovery: { verifiedAt: 10, reported: { playback: 'paused' } },
      },
    ];
    const article = runInContext(
      `renderMusicPlayer('music.room', ${JSON.stringify(device)}, ${JSON.stringify(commands)})`,
      ui.context,
    ) as Element;
    expect(texts(article)).toContain('Senast rapporterad uppspelning');
    const descendants = (item: Element): Element[] => [
      item,
      ...item.children.flatMap(descendants),
    ];
    expect(
      descendants(article).find(
        (item) => item.textContent === 'Spela / återuppta',
      )?.disabled,
    ).toBe(false);
  });
});
