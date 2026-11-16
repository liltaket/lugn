import { z } from 'zod';
import * as Api from '../core/device-api.js';
import { CapabilitySchemas } from '../application/capabilities.js';
import { BedtimeRequestSchema } from '../application/bedtime.js';
import { RoutineActionSchema } from '../core/routines.js';
import { SuggestionRequestSchema } from './intelligence-api.js';
import * as Phone from '../core/phone.js';

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
  StateView: { schema: Api.StateViewSchema, io: 'output' },
  StatePatch: { schema: Api.StatePatchSchema, io: 'output' },
  HeartbeatEvent: { schema: Api.HeartbeatEventSchema, io: 'output' },
  CommandRequest: { schema: Api.CommandRequestSchema, io: 'input' },
  CommandResponse: { schema: Api.CommandResponseSchema, io: 'output' },
  PhoneObservationBatch: {
    schema: Phone.PhoneObservationBatchSchema,
    io: 'input',
  },
  PhoneObservationResponse: {
    schema: Phone.PhoneObservationResponseSchema,
    io: 'output',
  },
  PhoneConfigResponse: {
    schema: Phone.PhoneConfigResponseSchema,
    io: 'output',
  },
  ...Object.fromEntries(
    Api.DeviceCommandNames.map((name) => [
      `CommandInput.${name}`,
      { schema: commandInputSchema(name), io: 'input' as const },
    ]),
  ),
};

/** The `input` each command accepts, from the same schemas the server parses. */
function commandInputSchema(name: Api.DeviceCommandName): Schema {
  if (name === 'routines.bedtime') return BedtimeRequestSchema;
  if (name === 'routines.action') return RoutineActionSchema;
  if (name === 'suggestions.respond') return SuggestionRequestSchema;
  return CapabilitySchemas[name].input;
}

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
  {
    method: 'get',
    path: '/api/v1/state',
    operationId: 'getState',
    summary: 'Read the compact room state view',
    scope: 'state:read',
    responses: {
      '200': { description: 'Current view.', component: 'StateView' },
      ...commonErrors,
    },
  },
  {
    method: 'post',
    path: '/api/v1/commands',
    operationId: 'postCommand',
    summary: 'Run one typed command through the capability registry',
    description:
      'Idempotent by requestId per device. `input` follows the CommandInput.<command> schema named by `x-lugn-command-inputs`. `accepted` means Lugn took the intent; device feedback arrives in state.',
    scope: 'commands:write',
    request: { component: 'CommandRequest', maxBytes: 16 * 1024 },
    responses: {
      '200': {
        description: 'Accepted or confirmed.',
        component: 'CommandResponse',
      },
      '400': {
        description: 'Invalid request or input.',
        component: 'ApiError',
      },
      '404': { description: 'Unknown target or scene.', component: 'ApiError' },
      '409': {
        description:
          'Request id reused with another body, or the command was refused by policy.',
        component: 'ApiError',
      },
      '502': {
        description: 'The command failed downstream.',
        component: 'ApiError',
      },
      ...commonErrors,
    },
  },
  {
    method: 'get',
    path: '/api/v1/phone/config',
    operationId: 'getPhoneConfig',
    summary: 'Which phone signals Lugn accepts, with age limits',
    scope: 'phone:ingest',
    responses: {
      '200': {
        description: 'Signal settings.',
        component: 'PhoneConfigResponse',
      },
      ...commonErrors,
    },
  },
  {
    method: 'post',
    path: '/api/v1/phone/observations',
    operationId: 'postPhoneObservations',
    summary: 'Submit batched, idempotent phone observations (hints only)',
    description:
      'Each observation has a UUID eventId, a per-session sequence and the device timestamp. Results report applied, duplicate, superseded, rejected or ignored per event. Observations never set room presence.',
    scope: 'phone:ingest',
    request: { component: 'PhoneObservationBatch', maxBytes: 64 * 1024 },
    responses: {
      '200': {
        description: 'Per-event results.',
        component: 'PhoneObservationResponse',
      },
      '400': { description: 'Invalid batch.', component: 'ApiError' },
      ...commonErrors,
    },
  },
  {
    method: 'get',
    path: '/api/v1/events',
    operationId: 'streamEvents',
    summary: 'Server-sent state snapshots and section patches',
    description:
      'Events: `snapshot` (StateView), `patch` (StatePatch, replace listed sections), `heartbeat` (HeartbeatEvent, no id). Event ids are `<instanceId>-<revision>`; reconnect with Last-Event-ID.',
    scope: 'state:read',
    parameters: [
      {
        name: 'Last-Event-ID',
        in: 'header',
        required: false,
        schema: { type: 'string', pattern: '^[A-Za-z0-9]+-[0-9]+$' },
      },
      {
        name: 'lastEventId',
        in: 'query',
        required: false,
        description: 'Fallback for clients that cannot set the header.',
        schema: { type: 'string', pattern: '^[A-Za-z0-9]+-[0-9]+$' },
      },
    ],
    responses: {
      '200': {
        description: 'An event stream.',
        component: 'StreamText',
        contentType: 'text/event-stream',
      },
      '503': { description: 'Too many streams.', component: 'ApiError' },
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
                    schema:
                      response.component === 'StreamText'
                        ? { type: 'string' }
                        : {
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
      ...(operation.operationId === 'postCommand'
        ? {
            'x-lugn-command-inputs': Object.fromEntries(
              Api.DeviceCommandNames.map((name) => [
                name,
                `#/components/schemas/CommandInput.${name}`,
              ]),
            ),
          }
        : {}),
      ...(operation.operationId === 'streamEvents'
        ? {
            'x-lugn-sse-events': {
              snapshot: '#/components/schemas/StateView',
              patch: '#/components/schemas/StatePatch',
              heartbeat: '#/components/schemas/HeartbeatEvent',
            },
          }
        : {}),
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
