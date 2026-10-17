import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

class Element {
  textContent = '';
  className = '';
  tagName: string;
  dataset: Record<string, string> = {};
  children: Element[] = [];
  hidden = false;
  open = false;

  constructor(tagName = 'div') {
    this.tagName = tagName;
  }

  append(...children: Element[]) {
    this.children.push(...children);
  }

  replaceChildren(...children: Element[]) {
    this.children = children;
  }

  setAttribute() {}
}

function computerPanel() {
  const source = readFileSync(
    new URL('../web/app.js', import.meta.url),
    'utf8',
  );
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
    document: { createElement: (tag: string) => new Element(tag) },
    computerSection: get('computer-section'),
    computerList: get('computer-list'),
  });
  runInContext(
    `function node(tag, className, text) {
       const result = document.createElement(tag);
       if (className) result.className = className;
       if (text !== undefined) result.textContent = text;
       return result;
     }
     ${functions}`,
    context,
  );
  return {
    context,
    section: get('computer-section'),
    list: get('computer-list'),
  };
}

function descendants(element: Element): Element[] {
  return [element, ...element.children.flatMap(descendants)];
}

function texts(element: Element): string[] {
  return descendants(element)
    .map((child) => child.textContent)
    .filter(Boolean);
}

function observation(overrides: Record<string, unknown> = {}) {
  return {
    deviceId: 'desktop-main',
    availability: 'online',
    freshness: 'fresh',
    reason: 'live',
    observedAt: 1_800_000_000_000,
    receivedAt: 1_800_000_000_000,
    sessionId: 'session-1',
    sequence: 2,
    observed: {
      networkOnline: true,
      locked: false,
      idle: false,
      activeApplication: {
        id: 'org.mozilla.firefox',
        resourceClass: 'browser',
      },
      fullscreen: false,
      audio: { playing: false, applications: [], roles: [] },
      media: [
        {
          player: 'mpv',
          identity: null,
          desktopEntry: 'mpv.desktop',
          playback: 'paused',
          title: 'Film',
          artists: ['Artist'],
          album: 'Soundtrack',
          contentType: 'video',
        },
      ],
    },
    activity: {
      classification: 'video',
      source: 'desktop-agent',
      basis: 'media playback',
    },
    lastEvent: null,
    ...overrides,
  };
}

describe('computer dashboard observations', () => {
  it('hides and clears the panel when no computers are configured', () => {
    const ui = computerPanel();
    ui.context['renderComputers']({ 'desktop-main': observation() });
    expect(ui.section.hidden).toBe(false);
    expect(ui.list.children).toHaveLength(1);

    ui.context['renderComputers']({});
    expect(ui.section.hidden).toBe(true);
    expect(ui.list.children).toHaveLength(0);
  });

  it('shows physical readings separately from assessed activity and detail', () => {
    const ui = computerPanel();
    ui.context['renderComputers']({ 'desktop-main': observation() });

    const content = texts(ui.list.children[0]!);
    expect(content).toContain('Online');
    expect(content).toContain('Aktuell');
    expect(content).toContain('Olåst');
    expect(content).toContain('Aktiv');
    expect(content).toContain('Ljud spelas inte');
    expect(content).toContain('Bedömd aktivitet');
    expect(content).toContain('Video');
    expect(content).toContain('org.mozilla.firefox');
    expect(content).toContain('Film');
    expect(content).toContain('Artist');
    expect(content).toContain('Pausad');
  });

  it('keeps unknown readings distinct from false readings', () => {
    const ui = computerPanel();
    ui.context['renderComputers']({
      'desktop-main': observation({
        availability: 'unknown',
        freshness: 'unknown',
        observed: {
          networkOnline: null,
          locked: null,
          idle: null,
          activeApplication: null,
          fullscreen: null,
          audio: null,
          media: null,
        },
        activity: {
          classification: 'unknown',
          source: 'desktop-agent',
          basis: null,
        },
      }),
    });

    const content = texts(ui.list.children[0]!);
    expect(content).toContain('Anslutning okänd');
    expect(content).toContain('Aktualitet okänd');
    const primaryReadings = descendants(ui.list.children[0]!).find(
      (element) => element.className === 'computer-readings',
    )!;
    expect(
      primaryReadings.children.map((reading) => [
        reading.children[0]?.textContent,
        reading.children[1]?.textContent,
      ]),
    ).toEqual([
      ['Låsning', 'Okänt'],
      ['Datoraktivitet', 'Okänt'],
      ['Helskärm', 'Okänt'],
      ['Ljud', 'Okänt'],
    ]);
    expect(content).toContain('Okänd');
    expect(content).not.toContain('Olåst');
    expect(content).not.toContain('Aktiv');
    expect(content).not.toContain('Nej');
    expect(content).not.toContain('Ljud spelas inte');
  });

  it('shows Swedish stale and disconnect reasons with unavailable fields cleared', () => {
    const ui = computerPanel();
    ui.context['renderComputers']({
      'desktop-main': observation({
        availability: 'offline',
        freshness: 'stale',
        reason: 'offline',
        observed: {
          networkOnline: null,
          locked: null,
          idle: null,
          activeApplication: null,
          fullscreen: null,
          audio: null,
          media: null,
        },
      }),
    });

    const content = texts(ui.list.children[0]!);
    expect(content).toContain('Offline');
    expect(content).toContain('Föråldrad');
    expect(content).toContain('Datoragenten är offline.');
    expect(content).not.toContain('Olåst');
    expect(content).not.toContain('Film');
    expect(content).not.toContain('org.mozilla.firefox');
  });

  it('keeps expanded details open when a new overview rerenders the row', () => {
    const ui = computerPanel();
    ui.context['renderComputers']({ 'desktop-main': observation() });
    const details = descendants(ui.list.children[0]!).find(
      (element) => element.className === 'computer-details',
    )!;
    details.open = true;

    ui.context['renderComputers']({
      'desktop-main': observation({ sequence: 3 }),
    });
    const rerendered = descendants(ui.list.children[0]!);
    const nextDetails = rerendered.find(
      (element) => element.className === 'computer-details',
    )!;
    const summary = rerendered.find(
      (element) => element.tagName === 'summary',
    )!;
    expect(nextDetails.open).toBe(true);
    expect(summary.dataset['focusKey']).toBe('computer:desktop-main:details');
  });

  it('marks computer readings unknown while the dashboard has no live contact', () => {
    const ui = computerPanel();
    ui.context['renderComputers']({ 'desktop-main': observation() }, true);

    const content = texts(ui.list.children[0]!);
    expect(content).toContain('Anslutning okänd');
    expect(content).toContain('Aktualitet okänd');
    expect(content).toContain('Ingen livekontakt med Lugn.');
    expect(content).toContain('Okänd');
    expect(content).not.toContain('Online');
    expect(content).not.toContain('Aktuell');
    expect(content).not.toContain('Olåst');
    expect(content).not.toContain('Aktiv');
    expect(content).not.toContain('Video');
  });

  it('renders untrusted application and media strings as text', () => {
    const ui = computerPanel();
    const attack = '<img src=x onerror=alert(1)>';
    const data = observation();
    data.observed.activeApplication.id = attack;
    data.observed.media[0]!.title = attack;
    ui.context['renderComputers']({ 'desktop-main': data });

    const row = ui.list.children[0]!;
    expect(texts(row)).toContain(attack);
    expect(descendants(row).some((element) => element.tagName === 'img')).toBe(
      false,
    );
  });

  it.each([
    ['awaiting_state', 'Väntar på datorns första statusrapport.'],
    ['retained', 'Sparad rapport mottagen; väntar på en aktuell rapport.'],
    ['stale', 'Ingen ny rapport har kommit in i tid.'],
    ['offline', 'Datoragenten är offline.'],
    ['malformed', 'Datorns senaste rapport kunde inte läsas.'],
    ['stopped', 'Mottagningen av datorstatus har stoppats.'],
  ])('translates the %s status reason', (reason, label) => {
    const ui = computerPanel();
    ui.context['renderComputers']({
      'desktop-main': observation({ reason }),
    });
    expect(texts(ui.list.children[0]!)).toContain(label);
  });
});
