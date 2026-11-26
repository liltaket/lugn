import { z } from 'zod';
import { systemClock, type Clock } from '../core/clock.js';
import { ComputerDeviceIdSchema } from '../core/computer.js';
import type { PresenceMqttSubscriber } from '../runtime/mqttjs-subscriber.js';

const MAX_PAYLOAD_BYTES = 16_384;
const MAX_FUTURE_SKEW_MS = 5_000;
/** A sample older than this is not shown: a stopped publisher leaves no numbers. */
export const COMPUTER_STATS_MAX_AGE_MS = 15_000;
const HISTORY = 40;

const Percent = z.number().min(0).max(100);
const Amount = z.number().min(0).max(1e9);
const Text = z.string().max(64);

/** What a desktop's stats publisher sends on `<prefix>/<deviceId>/stats`. */
export const ComputerStatsMessageSchema = z
  .object({
    schema_version: z.literal(1),
    device_id: ComputerDeviceIdSchema,
    timestamp_ms: z.number().int().nonnegative(),
    model: Text.nullable().optional(),
    uptime_sec: Amount.nullable().optional(),
    cpu: z.object({
      percent: Percent,
      temp_c: z.number().min(-50).max(200).nullable().optional(),
      ghz: z.number().min(0).max(20).nullable().optional(),
      cores: z.array(Percent).max(256),
    }),
    gpu: z
      .object({
        percent: Percent.nullable().optional(),
        vram_used_mb: Amount.nullable().optional(),
        vram_total_mb: Amount.nullable().optional(),
        temp_c: z.number().min(-50).max(200).nullable().optional(),
        power_w: Amount.nullable().optional(),
        fan_percent: Percent.nullable().optional(),
      })
      .nullable()
      .optional(),
    memory: z.object({
      ram_used_mb: Amount,
      ram_total_mb: Amount,
      swap_used_mb: Amount,
      swap_total_mb: Amount,
    }),
    network: z.object({
      iface: Text.nullable().optional(),
      down_mbit: Amount,
      up_mbit: Amount,
    }),
    disk: z
      .object({
        label: Text.nullable().optional(),
        used_gb: Amount,
        total_gb: Amount,
        read_mbs: Amount,
        write_mbs: Amount,
      })
      .nullable()
      .optional(),
    processes: z
      .array(
        z.object({
          name: Text,
          cpu_percent: Amount,
          ram_mb: Amount,
        }),
      )
      .max(16),
  })
  .strict();

/** What the Hubs get: display-ready, with a short history for the sparklines. */
export type ComputerStats = {
  model: string | null;
  uptimeSec: number | null;
  observedAt: number;
  cpu: {
    percent: number;
    tempC: number | null;
    ghz: number | null;
    cores: number[];
    history: number[];
  };
  gpu: {
    percent: number | null;
    vramUsedMb: number | null;
    vramTotalMb: number | null;
    tempC: number | null;
    powerW: number | null;
    fanPercent: number | null;
    history: number[];
  } | null;
  memory: {
    ramUsedMb: number;
    ramTotalMb: number;
    swapUsedMb: number;
    swapTotalMb: number;
  };
  network: {
    iface: string | null;
    downMbit: number;
    upMbit: number;
    downHistory: number[];
    upHistory: number[];
  };
  disk: {
    label: string | null;
    usedGb: number;
    totalGb: number;
    readMBs: number;
    writeMBs: number;
  } | null;
  processes: Array<{ name: string; cpuPercent: number; ramMb: number }>;
};

function decode(payload: unknown): unknown {
  try {
    const text =
      typeof payload === 'string'
        ? payload
        : payload instanceof Uint8Array
          ? Buffer.from(payload).toString('utf8')
          : '';
    if (text.length === 0 || text.length > MAX_PAYLOAD_BYTES) return undefined;
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function push(history: number[], value: number | null | undefined): number[] {
  if (value === null || value === undefined) return history;
  history.push(Math.round(value * 10) / 10);
  if (history.length > HISTORY) history.splice(0, history.length - HISTORY);
  return history;
}

export type ComputerStatsMqttOptions = {
  deviceId: string;
  /** Prefix preceding /{deviceId}/stats (the same as the computer's state). */
  baseTopic?: string;
  clock?: Clock;
};

/**
 * Read-only MQTT intake of one desktop's resource statistics (CPU, GPU, memory,
 * network, disk, programs). Nothing is kept across a stop or a broker drop, and
 * a sample that is not fresh is not reported.
 */
export class ComputerStatsMqttAdapter {
  private readonly deviceId: string;
  private readonly topic: string;
  private readonly clock: Clock;
  private unsubscribe: (() => void) | undefined;
  private connected = false;
  private sample: { stats: ComputerStats; receivedAt: number } | undefined;
  private readonly cpuHistory: number[] = [];
  private readonly gpuHistory: number[] = [];
  private readonly downHistory: number[] = [];
  private readonly upHistory: number[] = [];

  constructor(
    private readonly subscriber: PresenceMqttSubscriber,
    options: ComputerStatsMqttOptions,
  ) {
    this.deviceId = ComputerDeviceIdSchema.parse(options.deviceId);
    const prefix = (options.baseTopic ?? 'lugn/computers').replace(/\/+$/, '');
    if (!prefix || /[+#\0]/.test(prefix))
      throw new Error('Computer MQTT prefix must be a concrete topic');
    this.topic = `${prefix}/${this.deviceId}/stats`;
    this.clock = options.clock ?? systemClock;
  }

  get id(): string {
    return this.deviceId;
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.subscriber.subscribe(
      this.topic,
      { qos: 0 },
      (topic, payload, metadata) => {
        // A retained sample is a past one.
        if (!this.connected || topic !== this.topic || metadata.retain) return;
        this.receive(payload);
      },
    );
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.connected = false;
    this.reset();
  }

  setBrokerConnected(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    if (!connected) this.reset();
  }

  /** The latest sample, or null when there is none or it is not fresh. */
  snapshot(): ComputerStats | null {
    if (!this.sample) return null;
    if (this.clock.now() - this.sample.receivedAt > COMPUTER_STATS_MAX_AGE_MS)
      return null;
    return this.sample.stats;
  }

  private reset(): void {
    this.sample = undefined;
    for (const history of [
      this.cpuHistory,
      this.gpuHistory,
      this.downHistory,
      this.upHistory,
    ])
      history.length = 0;
  }

  private receive(payload: unknown): void {
    const parsed = ComputerStatsMessageSchema.safeParse(decode(payload));
    if (!parsed.success || parsed.data.device_id !== this.deviceId) return;
    const message = parsed.data;
    const now = this.clock.now();
    if (message.timestamp_ms > now + MAX_FUTURE_SKEW_MS) return;
    if (now - message.timestamp_ms > COMPUTER_STATS_MAX_AGE_MS) return;
    const gpu = message.gpu ?? null;
    const stats: ComputerStats = {
      model: message.model ?? null,
      uptimeSec: message.uptime_sec ?? null,
      observedAt: message.timestamp_ms,
      cpu: {
        percent: message.cpu.percent,
        tempC: message.cpu.temp_c ?? null,
        ghz: message.cpu.ghz ?? null,
        cores: message.cpu.cores,
        history: push(this.cpuHistory, message.cpu.percent).slice(),
      },
      gpu: gpu
        ? {
            percent: gpu.percent ?? null,
            vramUsedMb: gpu.vram_used_mb ?? null,
            vramTotalMb: gpu.vram_total_mb ?? null,
            tempC: gpu.temp_c ?? null,
            powerW: gpu.power_w ?? null,
            fanPercent: gpu.fan_percent ?? null,
            history: push(this.gpuHistory, gpu.percent).slice(),
          }
        : null,
      memory: {
        ramUsedMb: message.memory.ram_used_mb,
        ramTotalMb: message.memory.ram_total_mb,
        swapUsedMb: message.memory.swap_used_mb,
        swapTotalMb: message.memory.swap_total_mb,
      },
      network: {
        iface: message.network.iface ?? null,
        downMbit: message.network.down_mbit,
        upMbit: message.network.up_mbit,
        downHistory: push(this.downHistory, message.network.down_mbit).slice(),
        upHistory: push(this.upHistory, message.network.up_mbit).slice(),
      },
      disk: message.disk
        ? {
            label: message.disk.label ?? null,
            usedGb: message.disk.used_gb,
            totalGb: message.disk.total_gb,
            readMBs: message.disk.read_mbs,
            writeMBs: message.disk.write_mbs,
          }
        : null,
      processes: message.processes.map((process) => ({
        name: process.name,
        cpuPercent: process.cpu_percent,
        ramMb: process.ram_mb,
      })),
    };
    this.sample = { stats, receivedAt: now };
  }
}
