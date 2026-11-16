import { request as httpRequest } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';

export type RawResponse = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json: () => unknown;
};

/** Raw HTTP so tests control Host and Origin, which fetch normalizes. */
export function call(
  port: number,
  options: {
    method?: string;
    path: string;
    host?: string;
    token?: string;
    headers?: Record<string, string>;
    body?: unknown;
    rawBody?: string;
  },
): Promise<RawResponse> {
  const body =
    options.rawBody ??
    (options.body === undefined ? undefined : JSON.stringify(options.body));
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? (body === undefined ? 'GET' : 'POST'),
        path: options.path,
        setHost: false,
        headers: {
          host: options.host ?? `127.0.0.1:${port}`,
          ...(options.token
            ? { authorization: `Bearer ${options.token}` }
            : {}),
          ...(body === undefined
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': String(Buffer.byteLength(body)),
              }),
          ...options.headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            text,
            json: () => JSON.parse(text) as unknown,
          });
        });
      },
    );
    request.on('error', reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

export async function findAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Reads a server-sent event stream until closed by the test. */
export function openStream(
  port: number,
  options: { token: string; host?: string; lastEventId?: string },
) {
  let text = '';
  let ended = false;
  let status = 0;
  const waiters = new Set<() => void>();
  const notify = () => {
    for (const waiter of [...waiters]) waiter();
  };
  const request = httpRequest(
    {
      host: '127.0.0.1',
      port,
      path: '/api/v1/events',
      setHost: false,
      headers: {
        host: options.host ?? `127.0.0.1:${port}`,
        authorization: `Bearer ${options.token}`,
        ...(options.lastEventId
          ? { 'last-event-id': options.lastEventId }
          : {}),
      },
    },
    (response) => {
      status = response.statusCode ?? 0;
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        text += chunk;
        notify();
      });
      response.on('end', () => {
        ended = true;
        notify();
      });
      response.on('close', () => {
        ended = true;
        notify();
      });
    },
  );
  request.on('error', () => {
    ended = true;
    notify();
  });
  request.end();
  const events = () =>
    text
      .split('\n\n')
      .filter((block) => /^data: /m.test(block))
      .map((block) => {
        const field = (name: string) =>
          block
            .split('\n')
            .find((line) => line.startsWith(`${name}: `))
            ?.slice(name.length + 2);
        return {
          event: field('event') ?? 'message',
          id: field('id'),
          data: JSON.parse(field('data')!) as Record<string, unknown>,
        };
      });
  const until = (predicate: () => boolean, label: string) =>
    new Promise<void>((resolve, reject) => {
      if (predicate()) return resolve();
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`Timed out waiting for ${label}: ${text}`));
      }, 3_000);
      const check = () => {
        if (!predicate()) return;
        clearTimeout(timer);
        waiters.delete(check);
        resolve();
      };
      waiters.add(check);
    });
  return {
    status: () => status,
    events,
    ended: () => ended,
    waitForEvents: (count: number) =>
      until(() => events().length >= count, `${count} events`),
    waitForEnd: () => until(() => ended, 'end'),
    close: () => {
      request.destroy();
    },
  };
}
