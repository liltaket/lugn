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
    window: { setTimeout, clearTimeout },
    AbortController,
    Date,
  });
  runInContext(
    `let overviewStale = false; let lastOverviewAt = 0; let overviewUpdateGeneration = 0;
    let overview = null; let eventSource = null;
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
  it('does not let an older polling response overwrite a newer live update', async () => {
    const ui = webPanel();
    let release!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const older = {
      state: { revision: 10, presence: {}, lighting: { devices: {} } },
    };
    const newer = {
      state: { revision: 11, presence: {}, lighting: { devices: {} } },
    };
    Object.assign(ui.context, { fetch: () => pending, newer });
    const poll = runInContext('fetchOverview()', ui.context);
    runInContext('overview = newer; overviewUpdateGeneration += 1', ui.context);
    release({ ok: true, json: async () => older });
    await expect(poll).resolves.toMatchObject({ state: { revision: 11 } });
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
