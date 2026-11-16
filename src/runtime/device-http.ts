import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ZodError } from 'zod';
import { DEVICE_API_VERSION } from '../core/device-api.js';

export class DeviceRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export function isJsonRequest(request: IncomingMessage): boolean {
  const contentType = request.headers['content-type'];
  return (
    typeof contentType === 'string' &&
    contentType.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
  );
}

export async function readJsonBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<unknown> {
  if (!isJsonRequest(request))
    throw new DeviceRequestError(415, 'content_type_must_be_application_json');
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new DeviceRequestError(413, 'request_too_large');
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > maxBytes)
      throw new DeviceRequestError(413, 'request_too_large');
    chunks.push(buffer);
  }
  if (byteLength === 0) throw new DeviceRequestError(400, 'empty_request_body');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new DeviceRequestError(400, 'invalid_json');
  }
}

export function safeIssues(
  error: ZodError,
): Array<{ path: string; message: string }> {
  return error.issues.slice(0, 32).map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

export const deviceResponseHeaders = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-lugn-api-version': String(DEVICE_API_VERSION),
} as const;

export function sendJson(
  response: ServerResponse,
  statusCode: number,
  value: unknown,
): void {
  if (response.destroyed || response.headersSent) return;
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    ...deviceResponseHeaders,
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(body);
}
