#!/usr/bin/env node
import { createRequire } from 'node:module';
import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createSocket } from 'node:dgram';

const LIMITS = { samples: 30, timeoutMs: 5000, bodyBytes: 1_000_000 };
const EFFECT_RESULT_TIMEOUT_MS = 12_000;
const LAN_DEVICES = new Set(['H612A', 'H612F', 'H6022', 'H60A6']);

function parseArgs(argv) {
  const args = {
    samples: 6,
    operation: 'temperature',
    phase: undefined,
    release: undefined,
    config: undefined,
    bridge: undefined,
    out: undefined,
    baseline: undefined,
    envFiles: [],
    execute: false,
    selfCheck: false,
    help: false,
  };
  const valued = new Map([
    ['--phase', 'phase'],
    ['--operation', 'operation'],
    ['--release', 'release'],
    ['--config', 'config'],
    ['--bridge', 'bridge'],
    ['--out', 'out'],
    ['--samples', 'samples'],
    ['--baseline', 'baseline'],
  ]);
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--execute') args.execute = true;
    else if (token === '--self-check') args.selfCheck = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else if (token === '--env-file') {
      const value = argv[++i];
      if (!value) throw new Error('missing_argument');
      args.envFiles.push(resolve(value));
    } else if (valued.has(token)) {
      const value = argv[++i];
      if (!value) throw new Error('missing_argument');
      const key = valued.get(token);
      args[key] = key === 'samples' ? Number(value) : value;
    } else throw new Error('unknown_argument');
  }
  if (args.selfCheck || args.help) return args;
  if (!['temperature', 'brightness'].includes(args.operation))
    throw new Error('invalid_operation');
  if (!['effects', 'static'].includes(args.phase))
    throw new Error('invalid_phase');
  if (
    !Number.isInteger(args.samples) ||
    args.samples < 1 ||
    args.samples > LIMITS.samples
  )
    throw new Error('invalid_samples');
  for (const key of ['release', 'config', 'bridge', 'out'])
    if (typeof args[key] !== 'string' || !args[key])
      throw new Error('missing_argument');
  return args;
}

function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}

export function summarize(samples) {
  const durations = samples
    .filter((sample) => sample.success && Number.isFinite(sample.feedbackMs))
    .map((sample) => sample.feedbackMs);
  return {
    n: samples.length,
    success: samples.filter((sample) => sample.success).length,
    failed: samples.filter((sample) => !sample.success).length,
    ackMs: {
      n: samples.filter((sample) => Number.isFinite(sample.ackMs)).length,
      p50: percentile(
        samples.map((sample) => sample.ackMs),
        0.5,
      ),
      p95: percentile(
        samples.map((sample) => sample.ackMs),
        0.95,
      ),
      max: samples.some((sample) => Number.isFinite(sample.ackMs))
        ? Math.max(
            ...samples.map((sample) => sample.ackMs).filter(Number.isFinite),
          )
        : null,
    },
    feedbackMs: {
      n: durations.length,
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      max: durations.length ? Math.max(...durations) : null,
    },
  };
}

function selfCheck() {
  const parsed = parseArgs([
    '--phase',
    'effects',
    '--release',
    '/r',
    '--config',
    '/c',
    '--bridge',
    '/b',
    '--out',
    '/o',
    '--samples',
    '30',
    '--execute',
  ]);
  if (!parsed.execute || parsed.samples !== 30) throw new Error('args_check');
  for (const invalid of [
    [
      '--phase',
      'effects',
      '--release',
      '/r',
      '--config',
      '/c',
      '--bridge',
      '/b',
      '--out',
      '/o',
      '--samples',
      '31',
    ],
    [
      '--phase',
      'effects',
      '--release',
      '/r',
      '--config',
      '/c',
      '--bridge',
      '/b',
      '--out',
      '/o',
      '--wat',
    ],
  ]) {
    let failed = false;
    try {
      parseArgs(invalid);
    } catch {
      failed = true;
    }
    if (!failed) throw new Error('invalid_args_check');
  }
  const summary = summarize([
    { success: true, ackMs: 5, feedbackMs: 10 },
    { success: true, ackMs: 6, feedbackMs: 20 },
    { success: true, ackMs: 7, feedbackMs: 30 },
    { success: false, errorCode: 'timeout' },
  ]);
  if (
    summary.n !== 4 ||
    summary.success !== 3 ||
    summary.failed !== 1 ||
    summary.feedbackMs.p50 !== 20 ||
    summary.feedbackMs.p95 !== 30 ||
    summary.feedbackMs.max !== 30 ||
    summary.ackMs.p50 !== 6 ||
    summary.ackMs.p95 !== 7
  )
    throw new Error('summary_check');
  console.log('Govee benchmark argument and summary helpers passed.');
}

function readEnvText(text, target) {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new Error('invalid_env_file');
    let value = match[2].trim();
    if (
      value.length >= 2 &&
      ((value[0] === '"' && value.at(-1) === '"') ||
        (value[0] === "'" && value.at(-1) === "'"))
    )
      value = value.slice(1, -1);
    if (target[match[1]] === undefined) target[match[1]] = value;
  }
}

async function loadEnvironment(files) {
  const environment = { ...process.env };
  for (const file of [...files].reverse())
    readEnvText(await readFile(file, 'utf8'), environment);
  return environment;
}

async function loadJson(path) {
  const raw = await readFile(path, 'utf8');
  if (Buffer.byteLength(raw) > LIMITS.bodyBytes)
    throw new Error('input_too_large');
  return JSON.parse(raw);
}

function decodeEnv(environment, name) {
  const value = environment[name];
  if (!value) throw new Error('missing_environment');
  if (!name.endsWith('_B64')) return value;
  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  if (Buffer.from(decoded, 'utf8').toString('base64url') !== value)
    throw new Error('invalid_environment');
  return decoded;
}

function deviceList(bridge) {
  const byId = new Map();
  for (const d of bridge.devices ?? []) byId.set(d.id, { ...d, path: 'lan' });
  for (const d of bridge.platform?.devices ?? []) {
    const previous = byId.get(d.id);
    byId.set(d.id, {
      ...previous,
      ...d,
      path: previous ? 'mixed' : 'platform',
    });
  }
  return [...byId.values()];
}

function entitySnapshot(raw) {
  const state = raw?.state;
  const a = raw?.attributes ?? {};
  if (!['on', 'off'].includes(state)) throw new Error('entity_unavailable');
  return {
    power: state === 'on',
    brightnessPct: Number.isFinite(a.brightness)
      ? Math.round((a.brightness / 255) * 100)
      : undefined,
    rgb:
      Array.isArray(a.rgb_color) && a.rgb_color.length === 3
        ? a.rgb_color
        : undefined,
    kelvin: Number.isFinite(a.color_temp_kelvin)
      ? a.color_temp_kelvin
      : undefined,
    colorMode: a.color_mode,
  };
}

function snapshotFromLan(status) {
  status = status?.status ?? status;
  return {
    power: status.onOff === 1,
    brightnessPct: status.brightness,
    ...(status.colorTemInKelvin > 0
      ? { kelvin: status.colorTemInKelvin, colorMode: 'color_temp' }
      : {
          rgb: [status.color.r, status.color.g, status.color.b],
          colorMode: 'rgb',
        }),
  };
}

function canRestoreCeiling(device, entry, snapshot) {
  if (device.sku !== 'H60A6') return true;
  const zones = entry?.zones;
  return Boolean(
    zones &&
    typeof zones.main === 'boolean' &&
    typeof zones.ring === 'boolean' &&
    zones.main === zones.ring &&
    zones.main === snapshot.power,
  );
}

function normalizeResult(phase, transport, device, index, requested) {
  return {
    phase,
    transport,
    device: device.id,
    sku: device.sku,
    sample: index,
    requested,
    success: false,
    ackMs: null,
    feedbackMs: null,
    ackKind: null,
    feedbackKind: null,
    guardMs: null,
    delivery: null,
    errorCode: null,
  };
}

function safeErrorCode(error) {
  const known =
    error?.code ??
    (/^[A-Z0-9_]{1,64}$/i.test(error?.message ?? '')
      ? error.message
      : undefined);
  return typeof known === 'string' && /^[A-Z0-9_]{1,40}$/i.test(known)
    ? known.toLowerCase()
    : 'transport_error';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, { deadlineMs, intervalMs = 100, validate } = {}) {
  const until = performance.now() + deadlineMs;
  let latest;
  while (performance.now() < until) {
    latest = await check();
    if (validate(latest)) return latest;
    await sleep(intervalMs);
  }
  throw Object.assign(new Error(), { code: 'feedback_timeout', latest });
}

function mqttMessageConnect(client) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Object.assign(new Error(), { code: 'mqtt_timeout' })),
      LIMITS.timeoutMs,
    );
    client.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    client.once('error', () => {
      clearTimeout(timer);
      reject(Object.assign(new Error(), { code: 'mqtt_error' }));
    });
  });
}

function mqttPublish(client, topic, payload) {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    client.publish(topic, payload, { qos: 0, retain: false }, (error) => {
      if (error)
        reject(Object.assign(new Error(), { code: 'mqtt_publish_failed' }));
      else resolve({ started, ackMs: performance.now() - started });
    });
  });
}

function waitEffectMessage(client, topic, effect, notBefore) {
  let rejectPending;
  const promise = new Promise((resolve, reject) => {
    rejectPending = reject;
    const timer = setTimeout(() => {
      client.off('message', handler);
      reject(Object.assign(new Error(), { code: 'companion_result_timeout' }));
    }, EFFECT_RESULT_TIMEOUT_MS);
    const handler = (messageTopic, bytes, packet) => {
      if (messageTopic !== topic || packet.retain) return;
      let value;
      try {
        value = JSON.parse(bytes.toString());
      } catch {
        return;
      }
      const resultEffect = value.requested_effect ?? value.requested?.effect;
      const status = value.status ?? value.last_result;
      const stamp = Date.parse(value.at ?? '');
      const matchingEffect =
        resultEffect === effect ||
        (!resultEffect && ['cloud_accepted', 'error'].includes(status));
      if (
        !matchingEffect ||
        !Number.isFinite(stamp) ||
        stamp < notBefore ||
        !['udp_sent', 'cloud_accepted', 'error'].includes(status)
      )
        return;
      clearTimeout(timer);
      client.off('message', handler);
      resolve(value);
    };
    client.on('message', handler);
  });
  return {
    promise,
    cancel() {
      rejectPending?.(
        Object.assign(new Error(), { code: 'benchmark_cancelled' }),
      );
      rejectPending = undefined;
    },
  };
}

async function fetchJson(fetcher, url, options = {}) {
  const response = await fetcher(url, {
    ...options,
    signal: AbortSignal.timeout(LIMITS.timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw Object.assign(new Error(), { code: `http_${response.status}` });
  }
  const body = await response.text();
  if (Buffer.byteLength(body) > LIMITS.bodyBytes)
    throw Object.assign(new Error(), { code: 'response_too_large' });
  return body ? JSON.parse(body) : undefined;
}

async function stateGet(fetcher, runtime, entityId) {
  return fetchJson(
    fetcher,
    `${runtime.homeAssistant.baseUrl}/api/states/${encodeURIComponent(entityId)}`,
    {
      headers: { Authorization: `Bearer ${runtime.homeAssistant.token}` },
    },
  );
}

async function haService(fetcher, runtime, entityId, service, data = {}) {
  return fetchJson(
    fetcher,
    `${runtime.homeAssistant.baseUrl}/api/services/light/${service}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${runtime.homeAssistant.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ entity_id: entityId, ...data }),
    },
  );
}

async function lugnCall(fetcher, runtime, path, input) {
  const headers = { 'Content-Type': 'application/json' };
  if (runtime.http.bearerToken)
    headers.Authorization = `Bearer ${runtime.http.bearerToken}`;
  return fetchJson(fetcher, `http://127.0.0.1:${runtime.http.port}${path}`, {
    method: input === undefined ? 'GET' : 'POST',
    headers,
    ...(input === undefined
      ? {}
      : {
          body: JSON.stringify({
            input,
            reason: 'Bounded Govee transport benchmark',
          }),
        }),
  });
}

async function readDeviceState(fetcher, runtime, target) {
  const state = await lugnCall(fetcher, runtime, '/state');
  const device = state?.lighting?.devices?.[target];
  if (!device) throw new Error('target_not_in_lugn_state');
  return { state, device };
}

async function acquireLease(fetcher, runtime, target) {
  const { device } = await readDeviceState(fetcher, runtime, target);
  if (device.externalControl)
    throw Object.assign(new Error(), { code: 'target_already_external' });
  const result = await lugnCall(
    fetcher,
    runtime,
    '/capabilities/lighting.beginExternalControl',
    { target, activate: false },
  );
  if (typeof result?.controlId !== 'string')
    throw Object.assign(new Error(), { code: 'lease_not_confirmed' });
  return result.controlId;
}

export async function ownsLease(fetcher, runtime, target, controlId) {
  const { device } = await readDeviceState(fetcher, runtime, target);
  return (
    device.externalControl?.id === controlId &&
    device.externalControl.canActivate !== false
  );
}

export async function restoreLease(
  fetcher,
  runtime,
  target,
  entityId,
  controlId,
  snapshot,
) {
  const { device } = await readDeviceState(fetcher, runtime, target);
  if (device.externalControl?.id !== controlId)
    return { restored: false, reason: 'ownership_changed' };
  if (device.externalControl.canActivate === false) {
    await lugnCall(
      fetcher,
      runtime,
      '/capabilities/lighting.endExternalControl',
      { target, expectedControlId: controlId },
    );
    return { restored: true, positiveRestorationSkipped: 'confirmed_exit' };
  }
  const values = {};
  if (snapshot.brightnessPct !== undefined)
    values.brightness = Math.ceil((snapshot.brightnessPct * 255) / 100);
  if (snapshot.colorMode === 'color_temp' && snapshot.kelvin !== undefined)
    values.color_temp_kelvin = snapshot.kelvin;
  else if (snapshot.rgb) values.rgb_color = snapshot.rgb;
  else if (snapshot.kelvin !== undefined)
    values.color_temp_kelvin = snapshot.kelvin;
  await haService(fetcher, runtime, entityId, 'turn_on', values);
  if (
    (await readDeviceState(fetcher, runtime, target)).device.externalControl
      ?.id === controlId
  ) {
    await lugnCall(
      fetcher,
      runtime,
      '/capabilities/lighting.endExternalControl',
      { target, expectedControlId: controlId },
    );
    return { restored: true };
  }
  return { restored: true, releasedByExternalOff: true };
}

async function runEffectTarget({
  device,
  runtime,
  mqtt,
  fetcher,
  samples,
  baseline,
}) {
  const entityId = runtime.homeAssistant.entities[device.target];
  const selectId = `select.lugn_govee_${device.id}_effect`;
  const resultTopic =
    device.path === 'platform'
      ? `lugn/govee/platform/${device.id}/result`
      : `lugn/govee/${device.id}/result`;
  const commandTopic =
    device.path === 'platform'
      ? `lugn/govee/platform/${device.id}/set`
      : `lugn/govee/${device.id}/set`;
  if (!entityId) throw new Error('target_not_mapped');
  const state = await stateGet(fetcher, runtime, entityId);
  const snapshot = baseline[device.id]
    ? {
        ...snapshotFromLan(baseline[device.id]),
        colorMode: entitySnapshot(state).colorMode,
      }
    : entitySnapshot(state);
  if (!canRestoreCeiling(device, baseline[device.id], snapshot))
    throw Object.assign(new Error(), {
      code: 'ceiling_zone_baseline_required',
    });
  const selector = await stateGet(fetcher, runtime, selectId);
  const options = selector?.attributes?.options;
  if (!Array.isArray(options)) throw new Error('selector_unavailable');
  const appEffects = options.filter(
    (option) =>
      typeof option === 'string' &&
      option !== 'Lugn' &&
      !option.startsWith('Extern'),
  );
  const forest =
    appEffects.find((option) => option === 'Forest') ??
    appEffects.find((option) => option.startsWith('Forest')) ??
    appEffects[0];
  const aurora =
    appEffects.find((option) => option === 'Aurora') ??
    appEffects.find((option) => option.startsWith('Aurora')) ??
    appEffects.find((option) => option !== forest);
  const targetEffects = [forest, aurora];
  if (targetEffects.some((effect) => typeof effect !== 'string'))
    throw new Error('effects_not_available');
  await mqtt.subscribeAsync(resultTopic, { qos: 0 });
  let leaseId = await acquireLease(fetcher, runtime, device.target);
  const output = [];
  try {
    await haService(fetcher, runtime, entityId, 'turn_on', {
      brightness: Math.ceil((10 * 255) / 100),
    });
    for (let i = 0; i < samples; i++) {
      const effect = targetEffects[i % targetEffects.length];
      const sample = normalizeResult(
        'effects',
        device.path,
        device,
        i + 1,
        effect,
      );
      try {
        if (!(await ownsLease(fetcher, runtime, device.target, leaseId)))
          throw Object.assign(new Error(), { code: 'ownership_changed' });
        const notBefore = Date.now();
        const resultWait = waitEffectMessage(
          mqtt,
          resultTopic,
          effect,
          notBefore,
        );
        // Attach immediately: if MQTT publish itself fails, cancelling the
        // outstanding result waiter must not become an unhandled rejection.
        void resultWait.promise.catch(() => undefined);
        try {
          const published = await mqttPublish(mqtt, commandTopic, effect);
          sample.ackMs = published.ackMs;
          sample.ackKind = 'mqtt_qos0_publish';
          const delivery = await resultWait.promise;
          sample.feedbackMs = performance.now() - published.started;
          sample.feedbackKind = 'companion_delivery_diagnostic';
          sample.delivery = delivery.status ?? delivery.last_result;
          if (sample.delivery === 'error')
            throw Object.assign(new Error(), {
              code: 'companion_delivery_error',
            });
          const latest = await readDeviceState(fetcher, runtime, device.target);
          const currentId = latest.device.externalControl?.id;
          if (!currentId || currentId === leaseId)
            throw Object.assign(new Error(), { code: 'ownership_changed' });
          // Each legacy selector command starts a new engine generation. Adopt
          // only the live ID after the matching fresh companion result.
          leaseId = currentId;
          if (!['udp_sent', 'cloud_accepted'].includes(sample.delivery))
            throw Object.assign(new Error(), { code: 'delivery_failed' });
          sample.success = true;
          sample.sceneConfirmed = false;
        } finally {
          resultWait.cancel();
        }
      } catch (error) {
        sample.success = false;
        sample.errorCode = safeErrorCode(error);
      }
      output.push(sample);
    }
  } finally {
    const restoration = await restoreLease(
      fetcher,
      runtime,
      device.target,
      entityId,
      leaseId,
      snapshot,
    ).catch((error) => ({ restored: false, reason: safeErrorCode(error) }));
    for (const sample of output) sample.restoration = restoration;
  }
  return output;
}

async function bindLanExclusive(interfaceAddress) {
  const socket = createSocket({ type: 'udp4', reuseAddr: false });
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      socket.off('listening', onListen);
      reject(error);
    };
    const onListen = () => {
      socket.off('error', onError);
      resolve();
    };
    socket.once('error', onError);
    socket.once('listening', onListen);
    try {
      socket.bind({ port: 4002, address: interfaceAddress, exclusive: true });
    } catch (error) {
      socket.off('error', onError);
      reject(error);
    }
  });
  return socket;
}

export async function runStatic({
  device,
  runtime,
  platformDevice,
  platformClient,
  lan,
  ws,
  fetcher,
  samples,
  baseline,
  operation = 'brightness',
}) {
  const temperature = operation === 'temperature';
  const entityId = runtime.homeAssistant.entities[device.target];
  if (!entityId) throw new Error('target_not_mapped');
  const beforeHA = entitySnapshot(await stateGet(fetcher, runtime, entityId));
  let beforeLan;
  if (LAN_DEVICES.has(device.sku)) {
    if (lan.ensureReachable) beforeLan = await lan.ensureReachable(device.id);
    else {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const ip = await lan.address(device.id);
          beforeLan = { ip, status: await lan.status(ip) };
          break;
        } catch (error) {
          if (attempt) throw error;
          await lan.discover();
        }
      }
    }
  }
  const snapshot = baseline[device.id]
    ? snapshotFromLan(baseline[device.id])
    : beforeLan
      ? snapshotFromLan(beforeLan.status)
      : beforeHA;
  if (!canRestoreCeiling(device, baseline[device.id], snapshot))
    throw Object.assign(new Error(), {
      code: 'ceiling_zone_baseline_required',
    });
  const leaseId = await acquireLease(fetcher, runtime, device.target);
  const methods = [
    ...(beforeLan ? ['lan'] : []),
    'ha_rest',
    ...(ws.status === 'connected' ? ['ha_websocket'] : []),
    ...(platformDevice && platformClient ? ['govee_platform'] : []),
  ];
  const observe = () =>
    beforeLan ? lan.status(beforeLan.ip) : stateGet(fetcher, runtime, entityId);
  const scalar = (state) =>
    temperature
      ? beforeLan
        ? state.colorTemInKelvin
        : state.attributes?.color_temp_kelvin
      : beforeLan
        ? state.brightness
        : (state.attributes?.brightness * 100) / 255;
  const powered = (state) =>
    beforeLan ? state.onOff === 1 : state.state === 'on';
  const output = [];
  try {
    if (!(await ownsLease(fetcher, runtime, device.target, leaseId)))
      throw Object.assign(new Error(), { code: 'ownership_changed' });
    await haService(fetcher, runtime, entityId, 'turn_on', {
      brightness: Math.ceil((9 * 255) / 100),
    });
    await waitFor(observe, {
      deadlineMs: 3500,
      intervalMs: 120,
      validate: powered,
    });
    for (const method of methods)
      for (let i = 0; i < samples; i++) {
        const sample = normalizeResult('static', method, device, i + 1, null);
        sample.operation = operation;
        try {
          const pre = await observe();
          const actual = scalar(pre);
          const value = temperature
            ? Math.abs(actual - 3000) < 100
              ? 4000
              : 3000
            : Math.round(actual) === 10
              ? 11
              : 10;
          sample.beforeFeedback = pre;
          sample.requested = temperature
            ? { kelvin: value }
            : { brightnessPct: value };
          const guardStarted = performance.now();
          if (!(await ownsLease(fetcher, runtime, device.target, leaseId)))
            throw Object.assign(new Error(), { code: 'ownership_changed' });
          sample.guardMs = performance.now() - guardStarted;
          const started = performance.now();
          const haValues = temperature
            ? { color_temp_kelvin: value }
            : { brightness: Math.ceil((value * 255) / 100) };
          if (method === 'lan') {
            await lan.send(
              beforeLan.ip,
              {
                msg: temperature
                  ? {
                      cmd: 'colorwc',
                      data: {
                        color: { r: 255, g: 255, b: 255 },
                        colorTemInKelvin: value,
                      },
                    }
                  : { cmd: 'brightness', data: { value } },
              },
              4003,
            );
            sample.ackKind = 'udp_socket_send_callback';
          } else if (method === 'ha_rest') {
            await haService(fetcher, runtime, entityId, 'turn_on', haValues);
            sample.ackKind = 'ha_rest_response';
          } else if (method === 'ha_websocket') {
            const ack = ws.callService(
              {
                domain: 'light',
                service: 'turn_on',
                serviceData: haValues,
                target: { entity_id: entityId },
              },
              LIMITS.timeoutMs,
            );
            if (!ack)
              throw Object.assign(new Error(), {
                code: 'websocket_disconnected',
              });
            await ack;
            sample.ackKind = 'ha_websocket_response';
          } else {
            const capability = platformDevice.capabilities.find(
              (c) =>
                c.type ===
                  (temperature
                    ? 'devices.capabilities.color_setting'
                    : 'devices.capabilities.range') &&
                c.instance ===
                  (temperature ? 'colorTemperatureK' : 'brightness'),
            );
            if (
              !capability ||
              !platformClient.valueAllowed(capability.parameters, value)
            )
              throw Object.assign(new Error(), {
                code: 'capability_unsupported',
              });
            await platformClient.client.control(
              platformDevice,
              { type: capability.type, instance: capability.instance, value },
              () => undefined,
            );
            sample.ackKind = 'govee_api_response';
          }
          sample.ackMs = performance.now() - started;
          sample.feedbackKind = beforeLan
            ? `udp_devStatus_matching_${operation}`
            : `ha_state_${operation}_software`;
          sample.feedback = await waitFor(observe, {
            deadlineMs: 3500,
            intervalMs: 120,
            validate: (feedback) =>
              powered(feedback) &&
              (temperature
                ? Math.abs(scalar(feedback) - value) <= 50
                : beforeLan
                  ? scalar(feedback) === value
                  : Math.round(scalar(feedback)) === value) &&
              scalar(feedback) !== actual,
          });
          sample.feedbackMs = performance.now() - started;
          sample.success = true;
        } catch (error) {
          sample.errorCode = safeErrorCode(error);
        }
        output.push(sample);
      }
  } finally {
    const restoration = await restoreLease(
      fetcher,
      runtime,
      device.target,
      entityId,
      leaseId,
      snapshot,
    ).catch((error) => ({ restored: false, reason: safeErrorCode(error) }));
    for (const sample of output) sample.restoration = restoration;
  }
  return output;
}

async function atomicJson(path, value) {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
  const temporary = `${absolute}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, absolute);
}

function printHelp() {
  console.log(
    'Usage: benchmark-govee.mjs --phase effects|static --release DIR --config FILE --bridge FILE --out FILE [--samples 1..30] [--operation temperature|brightness] [--baseline FILE] [--env-file FILE ...] [--execute]',
  );
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(
      `Invalid Govee benchmark arguments (${safeErrorCode(error)}). Use --help for usage.`,
    );
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    printHelp();
    return;
  }
  if (args.selfCheck) {
    selfCheck();
    return;
  }
  const environment = await loadEnvironment(args.envFiles);
  const release = resolve(args.release);
  const module = async (relative) =>
    import(pathToFileURL(join(release, 'dist', relative)).href);
  const loadLanTransport = async () => {
    try {
      return await module('runtime/govee-lan-transport.js');
    } catch {
      return module('runtime/govee-effects-bridge.js');
    }
  };
  const [
    { loadRuntimeConfig },
    { GoveeLanTransport },
    { GoveePlatformClient, platformValueAllowed },
    { HomeAssistantWebSocketTransport },
  ] = await Promise.all([
    module('runtime/config.js'),
    loadLanTransport(),
    module('adapters/govee-platform.js'),
    module('adapters/home-assistant-websocket.js'),
  ]);
  const runtime = loadRuntimeConfig(resolve(args.config), environment);
  const bridge = await loadJson(resolve(args.bridge));
  if (!runtime.mqtt) throw new Error('mqtt_unavailable');
  const devices = deviceList(bridge).filter(
    (device) => runtime.homeAssistant.entities[device.target],
  );
  if (!devices.length) throw new Error('no_govee_targets');
  const plan = {
    phase: args.phase,
    operation: args.operation,
    samplesPerMethod: args.samples,
    devices: devices.map(({ id, sku, target, path }) => ({
      id,
      sku,
      target,
      path,
    })),
    mutatesLights: true,
    baseline: args.baseline ?? null,
  };
  if (!args.execute) {
    console.log(JSON.stringify({ dryRun: true, plan }));
    return;
  }

  let baseline = {};
  if (args.baseline) {
    const raw = await loadJson(resolve(args.baseline));
    baseline = Array.isArray(raw)
      ? Object.fromEntries(
          raw.filter((x) => x?.id && x?.status).map((x) => [x.id, x]),
        )
      : raw;
  }
  const output = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    host: process.env.HOSTNAME ?? 'unknown',
    plan,
    samples: [],
    summary: {},
  };
  const fetcher = globalThis.fetch;
  let mqtt;
  let lan;
  let ws;
  let wsStarted = false;
  let socketGuard;
  try {
    const require = createRequire(join(release, 'package.json'));
    const mqttLib = require('mqtt');
    mqtt = mqttLib.connect(runtime.mqtt.url, {
      ...(runtime.mqtt.username === undefined
        ? {}
        : { username: runtime.mqtt.username }),
      ...(runtime.mqtt.password === undefined
        ? {}
        : { password: runtime.mqtt.password }),
      clientId: `lugn-govee-bench-${process.pid}`.slice(0, 64),
      clean: true,
      reconnectPeriod: 0,
      connectTimeout: LIMITS.timeoutMs,
      resubscribe: false,
      queueQoSZero: false,
    });
    await mqttMessageConnect(mqtt);
    ws = new HomeAssistantWebSocketTransport(
      {
        baseUrl: runtime.homeAssistant.baseUrl,
        token: runtime.homeAssistant.token,
      },
      () => undefined,
    );
    ws.start();
    wsStarted = true;
    try {
      await waitFor(async () => ws.status, {
        deadlineMs: LIMITS.timeoutMs,
        intervalMs: 50,
        validate: (status) => status === 'connected',
      });
    } catch {
      /* REST remains a measured control path. */
    }

    if (args.phase === 'static') {
      socketGuard = await bindLanExclusive(bridge.interfaceAddress);
      socketGuard.close();
      socketGuard = undefined;
      lan = new GoveeLanTransport(bridge);
      await lan.start();
    }

    let platformClient;
    const platformDevices = new Map();
    if (bridge.platform) {
      const apiKey = decodeEnv(environment, bridge.platform.apiKeyEnv);
      platformClient = new GoveePlatformClient({ apiKey });
      if (args.phase === 'static') {
        const available = await platformClient.devices();
        for (const d of bridge.platform.devices) {
          const found = available.find(
            (x) => x.sku === d.sku && x.device === d.device,
          );
          if (found) platformDevices.set(d.id, found);
        }
      }
    }

    for (const device of devices) {
      try {
        if (args.phase === 'effects') {
          output.samples.push(
            ...(await runEffectTarget({
              device,
              runtime,
              mqtt,
              fetcher,
              samples: args.samples,
              baseline,
            })),
          );
        } else {
          const platformDevice = platformDevices.get(device.id);
          output.samples.push(
            ...(await runStatic({
              device,
              runtime,
              platformDevice,
              operation: args.operation,
              platformClient: platformClient
                ? { client: platformClient, valueAllowed: platformValueAllowed }
                : undefined,
              lan,
              ws,
              fetcher,
              samples: args.samples,
              baseline,
            })),
          );
        }
      } catch (error) {
        const sample = normalizeResult(
          args.phase,
          device.path,
          device,
          0,
          null,
        );
        sample.errorCode = safeErrorCode(error);
        sample.errorType = ['TypeError', 'ReferenceError', 'Error'].includes(
          error?.name,
        )
          ? error.name
          : 'Error';
        sample.errorSite =
          /benchmark-govee.mjs:(\d+):/.exec(error?.stack ?? '')?.[1] ?? null;
        output.samples.push(sample);
      }
    }
  } finally {
    try {
      lan?.stop();
    } catch {}
    try {
      socketGuard?.close();
    } catch {}
    if (mqtt)
      await new Promise((resolve) => {
        mqtt.end(true, {}, resolve);
      });
    if (wsStarted) ws.stop();
    output.completedAt = new Date().toISOString();
    const groups = new Map();
    for (const sample of output.samples) {
      const key = `${sample.phase}/${sample.transport}/${sample.device}`;
      groups.set(key, [...(groups.get(key) ?? []), sample]);
    }
    for (const [key, samples] of groups)
      output.summary[key] = summarize(samples);
    output.summary.all = summarize(output.samples);
    await atomicJson(args.out, output);
  }
  console.log(
    JSON.stringify({ artifact: resolve(args.out), summary: output.summary }),
  );
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  void main().catch((error) => {
    console.error(`Govee benchmark failed (${safeErrorCode(error)}).`);
    process.exitCode = 1;
  });
}
