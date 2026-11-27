import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';
import { MusicRequestSchema } from '../src/core/schemas.js';

// The greeting page's music tile: what it shows as playing and what it sends.

const script = readFileSync(
  new URL('../src/ui/greeting-page.js', import.meta.url),
  'utf8',
);

class Node {
  className = '';
  textContent = '';
  disabled = false;
  hidden = false;
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  children: Node[] = [];
  style = { getPropertyValue: () => '', setProperty: () => undefined };
  action?: () => void;
  private clicks: Array<() => void> = [];
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  append(...children: Node[]): void {
    this.children.push(...children);
  }
  replaceChildren(...children: Node[]): void {
    this.children = children;
  }
  replaceWith(): void {}
  addEventListener(type: string, listener: () => void): void {
    if (type === 'click') this.clicks.push(listener);
  }
  click(): void {
    for (const listener of this.clicks) listener();
  }
  find(match: (node: Node) => boolean): Node | undefined {
    if (match(this)) return this;
    for (const child of this.children) {
      const found = child.find(match);
      if (found) return found;
    }
    return undefined;
  }
}

function tile({
  receiver = 'playing',
  computer,
  held = false,
}: {
  receiver?: string;
  computer?: { active: boolean; playback: string };
  held?: boolean;
}) {
  vi.useFakeTimers();
  const root = new Node();
  const sent: Array<[string, { request: unknown }]> = [];
  const context = createContext({
    document: {
      querySelector: () => root,
      createElement: () => new Node(),
      createElementNS: () => new Node(),
    },
    window: globalThis,
    Date,
    Intl,
    musicTarget: 'music.room',
    latestPayload: {
      state: {
        music: {
          devices: {
            'music.room': {
              availability: 'available',
              observed: { playback: receiver },
            },
          },
          ...(computer ? { computerPlayback: { 'music.room': computer } } : {}),
        },
      },
      musicPlaybackPolicies: {
        'music.room': { manualPause: held ? { createdAt: 1 } : null },
      },
    },
    runCommand: (key: string, body: { request: unknown }) => {
      sent.push([key, body]);
    },
  });
  runInContext(script, context);
  const named = (label: string) =>
    root.find(
      (node) =>
        node.className === 'gp-tile' &&
        node.children.some((child) => child.textContent === label),
    );
  return { named, sent };
}

afterEach(() => vi.useRealTimers());

it('sends a Pause the server accepts', () => {
  const page = tile({});
  page.named('Pausa musik')!.click();
  expect(page.sent).toHaveLength(1);
  expect(MusicRequestSchema.parse(page.sent[0]![1].request)).toEqual({
    property: 'playback',
    value: 'paused',
  });
});

it('shows playing computer media although the receiver Pause is still held', () => {
  const page = tile({
    computer: { active: true, playback: 'playing' },
    held: true,
  });
  expect(page.named('Pausa musik')).toBeDefined();
});

it('offers no Pause while the computer media is paused', () => {
  const page = tile({ computer: { active: true, playback: 'paused' } });
  expect(page.named('Pausa musik')).toBeUndefined();
});

it('keeps the held Pause of the receiver itself', () => {
  const page = tile({
    computer: { active: false, playback: 'unknown' },
    held: true,
  });
  expect(page.named('Pausa musik')).toBeUndefined();
});
