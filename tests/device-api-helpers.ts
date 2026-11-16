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
