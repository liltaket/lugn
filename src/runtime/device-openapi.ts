import { z } from 'zod';
import * as Api from '../core/device-api.js';

type Schema = z.ZodType;
type Operation = {
  method: 'get' | 'post';
  path: string;
  operationId: string;
  summary: string;
  description?: string;
  /** Undefined only for the pairing exchange. */
  scope: Api.DeviceScope | 'any' | undefined;
  request?: { component: string; maxBytes: number };
  responses: Record<
    string,
    { description: string; component?: string; contentType?: string }
  >;
  parameters?: unknown[];
};

/** Component name -> schema and whether it describes a request body. */
const components: Readonly<
  Record<string, { schema: Schema; io: 'input' | 'output' }>
> = {
  ApiError: { schema: Api.ApiErrorSchema, io: 'output' },
  PairRequest: { schema: Api.PairRequestSchema, io: 'input' },
  PairResponse: { schema: Api.PairResponseSchema, io: 'output' },
  MeResponse: { schema: Api.MeResponseSchema, io: 'output' },
};

const commonErrors = {
  '401': {
    description: 'Missing, unknown or revoked token.',
    component: 'ApiError',
  },
  '403': {
    description:
      'Token lacks the scope, or the request carried a browser Origin header.',
    component: 'ApiError',
  },
  '421': { description: 'Host header is not allowed.', component: 'ApiError' },
  '429': {
    description: 'Rate limited; honour Retry-After.',
    component: 'ApiError',
  },
} as const;

const operations: readonly Operation[] = [
  {
    method: 'post',
    path: '/api/v1/pair',
    operationId: 'pair',
    summary: 'Exchange a one-time pairing code for a device token',
    description:
      'The operator creates the code in the Lugn control panel. The returned token is shown once; Lugn stores only its digest.',
    scope: undefined,
    request: { component: 'PairRequest', maxBytes: 2048 },
    responses: {
      '201': { description: 'Paired.', component: 'PairResponse' },
      '400': { description: 'Invalid body.', component: 'ApiError' },
      '401': {
        description: 'Unknown, used or expired pairing code.',
        component: 'ApiError',
      },
      '409': { description: 'Device limit reached.', component: 'ApiError' },
      '429': commonErrors['429'],
    },
  },
  {
    method: 'get',
    path: '/api/v1/me',
    operationId: 'getMe',
    summary: 'Describe the authenticated device and the server clock',
    scope: 'any',
    responses: {
      '200': { description: 'This device.', component: 'MeResponse' },
      ...commonErrors,
    },
  },
];

export function buildOpenApiDocument(): Record<string, unknown> {
  const schemas: Record<string, unknown> = {};
  for (const [name, { schema, io }] of Object.entries(components).sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    const json = z.toJSONSchema(schema, {
      target: 'draft-2020-12',
      io,
      unrepresentable: 'any',
    }) as Record<string, unknown>;
    delete json['$schema'];
    schemas[name] = json;
  }
  const paths: Record<string, Record<string, unknown>> = {};
  for (const operation of [...operations].sort(
    (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
  )) {
    const responses = Object.fromEntries(
      Object.entries(operation.responses).map(([status, response]) => [
        status,
        {
          description: response.description,
          ...(response.component
            ? {
                content: {
                  [response.contentType ?? 'application/json']: {
                    schema: {
                      $ref: `#/components/schemas/${response.component}`,
                    },
                  },
                },
              }
            : {}),
        },
      ]),
    );
    (paths[operation.path] ??= {})[operation.method] = {
      operationId: operation.operationId,
      summary: operation.summary,
      ...(operation.description ? { description: operation.description } : {}),
      ...(operation.scope === undefined
        ? { security: [] }
        : {
            security: [{ deviceToken: [] }],
            'x-lugn-scope': operation.scope,
          }),
      ...(operation.parameters ? { parameters: operation.parameters } : {}),
      ...(operation.request
        ? {
            requestBody: {
              required: true,
              'x-lugn-max-bytes': operation.request.maxBytes,
              content: {
                'application/json': {
                  schema: {
                    $ref: `#/components/schemas/${operation.request.component}`,
                  },
                },
              },
            },
          }
        : {}),
      responses,
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Lugn paired-device API',
      version: `${Api.DEVICE_API_VERSION}.0.0`,
      description:
        'Generated from src/core/device-api.ts by `npm run api:generate`. Do not edit by hand. See docs/IOS-API.md for behaviour.',
    },
    jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    servers: [
      {
        url: 'http://{host}:{port}',
        description: 'The Lugn host over Tailscale or the LAN; never the WAN.',
        variables: {
          host: { default: 'lugn.local' },
          port: { default: '8789' },
        },
      },
    ],
    security: [{ deviceToken: [] }],
    paths,
    components: {
      securitySchemes: {
        deviceToken: {
          type: 'http',
          scheme: 'bearer',
          description: 'Per-device token from POST /api/v1/pair.',
        },
      },
      schemas,
    },
  };
}

/** Deterministic YAML 1.2 block output for a JSON value. */
export function toYaml(value: unknown): string {
  return `${emit(value, 0)}\n`;
}

function emit(value: unknown, indent: number): string {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return value
      .map((item) => {
        if (isContainer(item))
          return `${pad}-${Array.isArray(item) ? `\n${emit(item, indent + 2)}` : ` ${emit(item, indent + 2).trimStart()}`}`;
        return `${pad}- ${scalar(item)}`;
      })
      .join('\n');
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return '{}';
    return entries
      .map(([key, item]) =>
        isContainer(item)
          ? `${pad}${yamlKey(key)}:\n${emit(item, indent + 2)}`
          : `${pad}${yamlKey(key)}: ${scalar(item)}`,
      )
      .join('\n');
  }
  return `${pad}${scalar(value)}`;
}

function isContainer(value: unknown): boolean {
  return Array.isArray(value)
    ? value.length > 0
    : value !== null &&
        typeof value === 'object' &&
        Object.keys(value).length > 0;
}

function scalar(value: unknown): string {
  if (Array.isArray(value)) return '[]';
  if (value !== null && typeof value === 'object') return '{}';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  return 'null';
}

const RESERVED_KEYS = /^(?:y|n|yes|no|on|off|true|false|null|~)$/i;
function yamlKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(key) && !RESERVED_KEYS.test(key)
    ? key
    : JSON.stringify(key);
}
