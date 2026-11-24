import jpeg from 'jpeg-js';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../src/core/clock.js';
import { SteamCoverPaletteService } from '../src/runtime/steam-cover-palette-service.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const flush = async () => {
  for (let i = 0; i < 60; i++) await Promise.resolve();
};

function orangeJpeg(): Uint8Array {
  const width = 32;
  const height = 48;
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([230, 110, 20, 255], i);
  return jpeg.encode({ data, width, height }, 92).data;
}

type Reply = { status?: number; type?: string; body?: Uint8Array };
function fixture(replies: Record<string, Reply>) {
  const clock = new FakeClock(0);
  const urls: string[] = [];
  const transport = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const reply = replies[url.slice(url.lastIndexOf('/') + 1)] ?? {
      status: 404,
    };
    return new Response(reply.body ? Buffer.from(reply.body) : null, {
      status: reply.status ?? 200,
      headers: { 'content-type': reply.type ?? 'image/jpeg' },
    });
  }) as typeof fetch;
  const service = new SteamCoverPaletteService({ transport, clock });
  cleanups.push(() => service.dispose());
  let notified = 0;
  service.subscribe(() => notified++);
  return { service, clock, urls, notified: () => notified };
}

describe('steam cover palette', () => {
  it('returns nothing at once, then the cover colours, fetched once', async () => {
    const f = fixture({ 'library_600x900.jpg': { body: orangeJpeg() } });
    expect(f.service.current('730')).toEqual([]);
    await flush();
    const palette = f.service.current('730');
    expect(palette).toHaveLength(1);
    expect(palette[0]![0]).toBeGreaterThan(200);
    expect(f.notified()).toBe(1);
    f.service.current('730');
    await flush();
    expect(f.urls).toEqual([
      'https://cdn.cloudflare.steamstatic.com/steam/apps/730/library_600x900.jpg',
    ]);
  });

  it('falls back to the wide header when the portrait cover is missing', async () => {
    const f = fixture({ 'header.jpg': { body: orangeJpeg() } });
    f.service.current('620');
    await flush();
    expect(f.urls.map((url) => url.split('/').pop())).toEqual([
      'library_600x900.jpg',
      'header.jpg',
    ]);
    expect(f.service.current('620')).toHaveLength(1);
  });

  it('retries a failed lookup only after the pause', async () => {
    const f = fixture({});
    f.service.current('440');
    await flush();
    expect(f.urls).toHaveLength(2);
    f.service.current('440');
    await flush();
    expect(f.urls).toHaveLength(2);
    f.clock.advanceBy(121_000);
    f.service.current('440');
    await flush();
    expect(f.urls).toHaveLength(4);
    expect(f.notified()).toBe(0);
  });

  it('refuses anything that is not a real JPEG, and ids that are not plain numbers', async () => {
    const f = fixture({
      'library_600x900.jpg': {
        body: Buffer.from('<html>'),
        type: 'image/jpeg',
      },
      'header.jpg': { body: orangeJpeg(), type: 'text/html' },
    });
    f.service.current('10');
    await flush();
    expect(f.service.current('10')).toEqual([]);
    for (const bad of ['../etc', '0', '12a', '', '12345678901']) {
      expect(f.service.current(bad)).toEqual([]);
    }
    await flush();
    expect(f.urls.every((url) => url.includes('/apps/10/'))).toBe(true);
  });

  it('remembers a cover without colour instead of asking again', async () => {
    const grey = Buffer.alloc(32 * 32 * 4, 128);
    const f = fixture({
      'library_600x900.jpg': {
        body: jpeg.encode({ data: grey, width: 32, height: 32 }, 90).data,
      },
    });
    f.service.current('5');
    await flush();
    expect(f.service.current('5')).toEqual([]);
    const asked = f.urls.length;
    f.service.current('5');
    await flush();
    expect(f.urls).toHaveLength(asked);
  });

  it('uses the colourful header when the portrait cover has no colour', async () => {
    const grey = Buffer.alloc(32 * 32 * 4, 128);
    const f = fixture({
      'library_600x900.jpg': {
        body: jpeg.encode({ data: grey, width: 32, height: 32 }, 90).data,
      },
      'header.jpg': { body: orangeJpeg() },
    });
    f.service.current('7');
    await flush();
    expect(f.service.current('7')).toHaveLength(1);
  });
});
