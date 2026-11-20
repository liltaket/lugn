import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createWiimUpnpSubscriber,
  type WiimUpnpEvent,
} from '../src/adapters/wiim-music.js';

const volumeXml =
  '&lt;Event&gt;&lt;InstanceID val="0"&gt;&lt;Volume channel="Master" val="42"/&gt;&lt;/InstanceID&gt;&lt;/Event&gt;';

function notify(
  callback: string,
  headers: Record<string, string>,
): Promise<number> {
  const url = new URL(callback);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'NOTIFY',
        headers,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end(
      `<e:propertyset><LastChange>${volumeXml}</LastChange></e:propertyset>`,
    );
  });
}

describe('WiiM UPnP GENA subscriber', () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanup.splice(0)) fn();
  });

  it('accepts notifications that carry the subscription id and ignores others', async () => {
    const callbacks = new Map<string, string>();
    const device: Server = createServer((req, res) => {
      const match = /^<(.+)>$/.exec(String(req.headers['callback'] ?? ''));
      if (req.method === 'SUBSCRIBE' && match?.[1]) {
        callbacks.set(String(req.url), match[1]);
        res.writeHead(200, { SID: `uuid:sid-for-${req.url}` });
      } else {
        res.writeHead(200);
      }
      res.end();
    });
    await new Promise<void>((resolve) =>
      device.listen(0, '127.0.0.1', () => resolve()),
    );
    cleanup.push(() => device.close());
    const events: WiimUpnpEvent[] = [];
    const stop = createWiimUpnpSubscriber()(
      '127.0.0.1',
      (device.address() as AddressInfo).port,
      (event) => events.push(event),
    );
    cleanup.push(stop);
    await waitFor(() => callbacks.size === 2);
    const callback = callbacks.get('/upnp/event/rendercontrol1')!;

    await notify(callback, { SID: 'uuid:someone-else' });
    await notify(callback, {});
    await notify(callback, {
      SID: 'uuid:sid-for-/upnp/event/rendertransport1',
    });
    expect(events).toEqual([]);

    await notify(callback, { SID: 'uuid:sid-for-/upnp/event/rendercontrol1' });
    expect(events).toEqual([{ service: 'rendering_control', volume: 0.42 }]);
  });
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition not met');
}
