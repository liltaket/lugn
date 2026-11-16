import { request } from 'node:http';
import { z } from 'zod';
import {
  GoveeCapabilitiesSchema,
  GoveeStaticColorSchema,
  type GoveeCapabilities,
  type GoveeStaticColor,
} from '../core/schemas.js';
import type {
  LightingAdapter,
  LightingCommand,
  LightingObservation,
} from './simulated-lighting.js';

export interface GoveeControlClient {
  capabilities(): Promise<GoveeCapabilities>;
  apply(body: {
    requestId: string;
    target: string;
    controlId: string;
    effect?: string | undefined;
    staticColor?: GoveeStaticColor | undefined;
    modeOnly?: true | undefined;
    zones?: { main: boolean; ring: boolean } | undefined;
    zoneOrder?: 'disable-first' | 'disable-only' | 'enable-only' | undefined;
  }): Promise<void>;
  cancel(target: string, controlId?: string): Promise<void>;
}

/** Local IPC only. Responses contain delivery outcomes, never physical effect confirmation. */
export class GoveeSocketClient implements GoveeControlClient {
  constructor(private readonly socketPath: string) {}
  async capabilities(): Promise<GoveeCapabilities> {
    return z
      .object({ targets: GoveeCapabilitiesSchema })
      .parse(await this.call('GET', '/capabilities')).targets;
  }
  async apply(body: Parameters<GoveeControlClient['apply']>[0]): Promise<void> {
    const result = z
      .object({
        requestId: z.literal(body.requestId),
        target: z.literal(body.target),
        controlId: z.literal(body.controlId),
        status: z.literal('sent'),
      })
      .safeParse(await this.call('POST', '/apply', body));
    if (!result.success) throw new Error('Invalid Govee delivery response');
  }
  async cancel(target: string, controlId?: string): Promise<void> {
    z.object({ status: z.literal('drained') }).parse(
      await this.call('POST', '/cancel', {
        target,
        ...(controlId ? { controlId } : {}),
      }),
    );
  }
  private call(method: string, path: string, body?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const bytes = body === undefined ? undefined : JSON.stringify(body);
      const req = request(
        {
          socketPath: this.socketPath,
          signal: AbortSignal.timeout(method === 'GET' ? 2_000 : 60_000),
          method,
          path,
          headers:
            bytes === undefined
              ? {}
              : {
                  'content-type': 'application/json',
                  'content-length': Buffer.byteLength(bytes),
                },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let length = 0;
          response.on('data', (chunk: Buffer) => {
            length += chunk.length;
            if (length > 1024 * 1024)
              req.destroy(new Error('Govee response too large'));
            else chunks.push(chunk);
          });
          response.on('end', () => {
            if (response.statusCode !== 200) {
              reject(
                new Error(
                  `Govee control request failed (${response.statusCode ?? 503})`,
                ),
              );
              return;
            }
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch {
              reject(new Error('Invalid Govee control response'));
            }
          });
          response.on('error', () =>
            reject(new Error('Govee control response interrupted')),
          );
        },
      );
      req.setTimeout(method === 'GET' ? 2_000 : 60_000, () =>
        req.destroy(new Error('Govee control request timed out')),
      );
      req.on('error', () => reject(new Error('Govee companion unavailable')));
      req.end(bytes);
    });
  }
}

/** One queue per physical target spans baseline, effects, masks and subsequent static/OFF. */
export class GoveePresetLightingAdapter implements LightingAdapter {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly powerWaiters = new Set<{
    target: string;
    resolve: () => void;
  }>();
  async refreshCapabilities(): Promise<void> {
    const next = await this.client.capabilities();
    // Keep known capabilities through an outage so static/OFF still uses its barrier.
    Object.assign(this.goveeCapabilities, next);
  }
  constructor(
    private readonly ordinary: LightingAdapter,
    private readonly client: GoveeControlClient,
    readonly goveeCapabilities: GoveeCapabilities,
    private readonly stagedPowerTimeoutMs = 4_000,
    private readonly stagedSettleMs = 1_500,
  ) {
    this.ordinary.subscribe((observation) => {
      if (observation.values.power !== true) return;
      for (const waiter of this.powerWaiters)
        if (waiter.target === observation.target) waiter.resolve();
    });
  }
  subscribe(listener: (observation: LightingObservation) => void): () => void {
    return this.ordinary.subscribe(listener);
  }
  dispatch(command: LightingCommand): Promise<void> {
    if (!this.goveeCapabilities[command.target]) {
      if (command.govee || command.goveeStatic)
        return Promise.reject(new Error('Govee capabilities unavailable'));
      return this.ordinary.dispatch(command);
    }
    const previous = this.tails.get(command.target) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.execute(command));
    this.tails.set(command.target, next);
    void next
      .finally(() => {
        if (this.tails.get(command.target) === next)
          this.tails.delete(command.target);
      })
      .catch(() => undefined);
    return next;
  }
  private async execute(command: LightingCommand): Promise<void> {
    const current = () => command.isCurrent?.() !== false;
    if (!current()) return;
    const capability = this.goveeCapabilities[command.target]!;
    const intent = command.govee;
    const staticReset = command.goveeStatic;
    if (
      staticReset &&
      (intent ||
        !capability.staticColor ||
        (staticReset.zones && !capability.zones) ||
        !command.isCurrent ||
        !GoveeStaticColorSchema.safeParse(staticReset.color).success ||
        command.values.power === false)
    )
      throw new Error('Invalid Govee static reset');
    if (
      intent?.staticColor &&
      (!capability.staticColor ||
        !command.isCurrent ||
        !intent.zones ||
        intent.effect !== undefined ||
        command.goveeOnly ||
        !GoveeStaticColorSchema.safeParse(intent.staticColor).success ||
        command.values.power === false)
    )
      throw new Error('Invalid Govee static reset');
    if (intent?.knownZones && !intent.zones)
      throw new Error('Invalid Govee zone staging');
    if (
      intent?.stageZones &&
      (!intent.zones ||
        (intent.zones.main && intent.zones.ring) ||
        !command.isCurrent ||
        command.goveeOnly ||
        command.values.power !== true)
    )
      throw new Error('Invalid Govee zone staging');
    if (
      command.goveeOnly &&
      (!intent?.effect ||
        !command.isCurrent ||
        Object.keys(command.values).length !== 0)
    )
      throw new Error('Invalid Govee rotation step');
    if (
      intent &&
      (intent.rotation !== undefined ||
        (intent.effect && !capability.effects.includes(intent.effect)) ||
        (intent.zones && !capability.zones))
    )
      throw new Error('Unsupported Govee preset');
    // Every new physical request drains legacy selector writes too. Lease acquisition
    // is outside the companion's device-write lock, avoiding a circular main API wait.
    try {
      await this.client.cancel(command.target);
    } catch (error) {
      // Local OFF remains available during a companion outage. No positive write is safe.
      if (command.values.power === false && current())
        await this.ordinary.dispatch(command);
      throw error;
    }
    if (!current()) return;
    const values = { ...command.values };
    const range = capability.colorTemperature;
    const kelvin = (value: number) =>
      range ? Math.max(range.min, Math.min(range.max, value)) : value;
    if (values.colorTemperature !== undefined)
      values.colorTemperature = kelvin(values.colorTemperature);
    // The vendor API rejects out-of-range Kelvin; a rejection must not become OFF.
    const staticColor = (color: GoveeStaticColor): GoveeStaticColor =>
      color.colorTemperature === undefined
        ? color
        : { colorTemperature: kelvin(color.colorTemperature) };
    // The H60A6 ignores zone toggles while dark. A cloud toggle ON powers it
    // with its stored mask, which persists through whole OFF, but a local Matter
    // ON lights the whole fixture. A stored mask that already matches is
    // therefore powered by the wanted zone's cloud ON. An unknown or different
    // one is lit through HA at 1 %, so the unwanted zone is barely visible.
    // Either way the unwanted zone's OFF follows its own ON report, because
    // otherwise the next Matter write relights it. Cloud acceptance precedes
    // delivery, so the OFF gets time to arrive before the scene brightness. A
    // zone ON while lit relights an OFF zone, so no toggle follows the OFF.
    const known = intent?.knownZones;
    const covers = (
      mask: { main: boolean; ring: boolean },
      lit?: { main: boolean; ring: boolean },
    ) => Boolean(lit && (!mask.main || lit.main) && (!mask.ring || lit.ring));
    let stagedLit = false;
    if (intent?.stageZones && intent.zones) {
      const stored = Boolean(
        known &&
        known.main === intent.zones.main &&
        known.ring === intent.zones.ring,
      );
      const powered = this.waitForPower(command.target, current);
      try {
        if (stored)
          await this.applyGuarded(
            command,
            intent.controlId,
            { zones: intent.zones, zoneOrder: 'enable-only' },
            current,
          );
        else
          await this.ordinary.dispatch({
            id: command.id,
            target: command.target,
            values: {
              power: true,
              brightness: 1,
              ...(values.rgb
                ? { rgb: values.rgb }
                : values.colorTemperature !== undefined
                  ? { colorTemperature: values.colorTemperature }
                  : {}),
            },
          });
        if ((await powered.wait) && current()) {
          await this.applyGuarded(
            command,
            intent.controlId,
            covers(intent.zones, known)
              ? { zones: intent.zones, zoneOrder: 'disable-only' }
              : { zones: intent.zones },
            current,
          );
          stagedLit = true;
          await this.settle(this.stagedSettleMs, current);
        }
      } catch {
        // Best effort only: baseline and the authoritative final mask still run.
      } finally {
        powered.stop();
      }
      if (!current()) return;
    }
    // Restoring both zones does not depend on the baseline: on a lit fixture
    // the main ON lights at once, so it is sent alongside the local write.
    const restore =
      staticReset?.zones && !command.goveeOnly
        ? this.applyGuarded(
            command,
            staticReset.controlId,
            { zones: staticReset.zones },
            current,
          )
        : undefined;
    restore?.catch(() => undefined);
    if (!command.goveeOnly) {
      try {
        await this.ordinary.dispatch({
          id: command.id,
          target: command.target,
          values,
        });
      } catch (error) {
        await restore?.catch(() => undefined);
        throw error;
      }
    }
    try {
      await restore;
    } catch (error) {
      if (!current()) return;
      // Both zones were wanted; a failed restore leaves no unwanted zone lit.
      throw error;
    }
    if (!current() || (!intent && !staticReset) || values.power === false)
      return;
    const controlId = (intent ?? staticReset)!.controlId;
    const color = intent?.staticColor ?? staticReset?.color;
    const zones = restore ? undefined : (intent?.zones ?? staticReset?.zones);
    // Wanted zones already lit get no ON toggle: on the H60A6 it would relight
    // an OFF zone. Unknown or dark zones still use the enable-first mask.
    const zoneBody =
      !zones || stagedLit
        ? {}
        : covers(zones, known)
          ? zones.main && zones.ring
            ? {}
            : { zones, zoneOrder: 'disable-only' as const }
          : { zones };
    const body = {
      ...(command.goveeOnly ? { modeOnly: true as const } : {}),
      ...(intent?.effect !== undefined ? { effect: intent.effect } : {}),
      ...zoneBody,
      ...(color ? { staticColor: staticColor(color) } : {}),
    };
    if (
      body.effect === undefined &&
      body.zones === undefined &&
      body.staticColor === undefined
    )
      return;
    try {
      await this.applyGuarded(command, controlId, body, current);
    } catch (error) {
      if (!current()) return;
      // A partial mask failure must not leave an accidentally illuminated second zone.
      await this.ordinary.dispatch({
        id: `${command.id}-govee-failed-off`,
        target: command.target,
        values: { power: false },
      });
      throw error;
    }
  }

  /** Resolves on a fresh native ON report, a timeout or a lost generation. */
  private waitForPower(
    target: string,
    current: () => boolean,
  ): { wait: Promise<boolean>; stop: () => void } {
    let finish!: (powered: boolean) => void;
    const wait = new Promise<boolean>((resolve) => {
      const waiter = { target, resolve: () => finish(true) };
      const timer = setTimeout(() => finish(false), this.stagedPowerTimeoutMs);
      const poll = setInterval(() => {
        if (!current()) finish(false);
      }, 20);
      finish = (powered) => {
        clearTimeout(timer);
        clearInterval(poll);
        this.powerWaiters.delete(waiter);
        resolve(powered);
      };
      this.powerWaiters.add(waiter);
    });
    return { wait, stop: () => finish(false) };
  }

  /** Waits for delivery after API acceptance; a lost generation ends it early. */
  private settle(ms: number, current: () => boolean): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      const poll = setInterval(() => {
        if (!current()) done();
      }, 20);
      function done() {
        clearTimeout(timer);
        clearInterval(poll);
        resolve();
      }
    });
  }

  /** Rejects after a requested drain; cancellation never leaves later stale sends. */
  private async applyGuarded(
    command: LightingCommand,
    controlId: string,
    body: Omit<
      Parameters<GoveeControlClient['apply']>[0],
      'requestId' | 'target' | 'controlId'
    >,
    current: () => boolean,
  ): Promise<void> {
    // A disconnected/aborted HTTP request cannot retract a cloud write. On guard
    // invalidation explicitly cancel and wait for the server's drain acknowledgement.
    let cancel: Promise<void> | undefined;
    let drained!: () => void;
    let drainFailed!: (error: unknown) => void;
    const cancellation = new Promise<void>((resolve, reject) => {
      drained = resolve;
      drainFailed = reject;
    });
    const requestCancel = () => {
      if (!cancel) {
        cancel = this.client.cancel(command.target, controlId);
        void cancel.then(drained, drainFailed);
      }
      return cancel;
    };
    const timer = setInterval(() => {
      if (!current()) requestCancel();
    }, 20);
    try {
      // A drained cancellation releases the target even if the obsolete apply
      // response is lost. Promise.race consumes any late apply rejection.
      await Promise.race([
        this.client.apply({
          requestId: command.id,
          target: command.target,
          controlId,
          ...body,
        }),
        cancellation,
      ]);
    } catch (error) {
      await requestCancel();
      throw error;
    } finally {
      clearInterval(timer);
      if (!current()) requestCancel();
      if (cancel) await cancel;
    }
  }
}
