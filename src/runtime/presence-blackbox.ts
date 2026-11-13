import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import type { SensorStreamMessage } from '../adapters/stl27l-sensor-stream.js';
import { systemClock, type Clock } from '../core/clock.js';

const WINDOW_MS = 60_000;
const MAX_RECORDS = 400;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const MAX_PENDING = 2;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 500;
const CAPTURE_NAME = /^\d{13}-[\da-f-]{36}\.jsonl\.gz$/;
const TEMPORARY_NAME = /^\d{13}-[\da-f-]{36}\.tmp$/;

type Record = {
  monotonic: number;
  receivedAt: number;
  message: SensorStreamMessage;
};

/** One bounded RAM window; disk I/O and gzip run only after a correction. */
export class PresenceBlackbox {
  private records: Record[] = [];
  private bytes = 0;
  private evictedAt = -Infinity;
  private readonly startedAt: number;
  private pending = 0;
  private writes: Promise<void> = Promise.resolve();

  constructor(
    readonly directory: string,
    private readonly warn: (message: string) => void = console.warn,
    private readonly clock: Clock = systemClock,
  ) {
    this.startedAt = clock.monotonicNow();
  }

  accept(message: SensorStreamMessage): void {
    const monotonic = this.clock.monotonicNow();
    this.prune(monotonic);
    // Count UTF-16 storage conservatively, including small record overhead.
    const bytes = message.data.length * 2 + 256;
    if (bytes > MAX_BUFFER_BYTES) {
      this.evictedAt = monotonic;
      return;
    }
    this.records.push({ monotonic, receivedAt: this.clock.now(), message });
    this.bytes += bytes;
    while (this.records.length > MAX_RECORDS || this.bytes > MAX_BUFFER_BYTES) {
      this.evictedAt = this.records[0]!.monotonic;
      this.removeFirst();
    }
  }

  private removeFirst(): void {
    const record = this.records.shift()!;
    this.bytes -= record.message.data.length * 2 + 256;
  }

  private prune(now: number): void {
    while (this.records[0] && this.records[0].monotonic < now - WINDOW_MS)
      this.removeFirst();
  }

  /** Snapshot synchronously; return an outcome callback that never waits on I/O. */
  beginCapture(): (acknowledged: boolean) => void {
    if (this.pending >= MAX_PENDING) {
      this.warn('[lugn] presence blackbox busy; capture skipped');
      return () => {};
    }
    const now = this.clock.monotonicNow();
    this.prune(now);
    const records = this.records.slice();
    const triggeredAt = this.clock.now();
    const id = `${triggeredAt}-${randomUUID()}`;
    const metadata = {
      type: 'capture',
      schemaVersion: 1,
      id,
      sensor: 'STL27L',
      trigger: 'manual_count_one',
      requestedCount: 1,
      triggeredAt: new Date(triggeredAt).toISOString(),
      windowMs: WINDOW_MS,
      availableHistoryMs: Math.min(WINDOW_MS, now - this.startedAt),
      bufferTruncated: this.evictedAt >= now - WINDOW_MS,
      frameCount: records.filter((r) => r.message.type === 'frame').length,
      // These are requested upstream limits, not a claim about achieved rate.
      stream: { requestedMaxFps: 5, requestedPointStep: 8 },
    };
    this.pending += 1;
    let finished = false;
    return (acknowledged) => {
      if (finished) return;
      finished = true;
      this.writes = this.writes
        .then(() => this.save(id, { ...metadata, acknowledged }, records, now))
        .catch(() => {
          this.warn('[lugn] presence blackbox capture could not be saved');
        })
        .finally(() => {
          this.pending -= 1;
        });
    };
  }

  private async save(
    id: string,
    metadata: object,
    records: Record[],
    triggerMonotonic: number,
  ): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    // Writes are serialized. Leftovers here belong to an interrupted prior
    // write/release, so a crash cannot gradually fill the archive with temps.
    for (const name of await readdir(this.directory)) {
      if (TEMPORARY_NAME.test(name)) await unlink(join(this.directory, name));
    }
    const temporary = join(this.directory, `${id}.tmp`);
    const destination = join(this.directory, `${id}.jsonl.gz`);
    try {
      function* lines() {
        yield `${JSON.stringify(metadata)}\n`;
        for (const record of records) {
          yield `{"type":"${record.message.type}","receivedAt":${record.receivedAt},"offsetMs":${record.monotonic - triggerMonotonic},"data":${record.message.data}}\n`;
        }
      }
      await pipeline(
        Readable.from(lines()),
        createGzip({ level: 1 }),
        createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
      );
      const size = (await stat(temporary)).size;
      await this.makeRoom(size);
      await rename(temporary, destination);
      console.info(
        `[lugn] presence blackbox saved ${id}.jsonl.gz (${size} bytes)`,
      );
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  private async makeRoom(incomingBytes: number): Promise<void> {
    if (incomingBytes > MAX_ARCHIVE_BYTES) throw new Error('Capture too large');
    const files = [];
    for (const name of (await readdir(this.directory))
      .filter((name) => CAPTURE_NAME.test(name))
      .sort()) {
      files.push({ name, size: (await stat(join(this.directory, name))).size });
    }
    let bytes = files.reduce((sum, file) => sum + file.size, 0);
    while (
      files.length >= MAX_ARCHIVE_FILES ||
      bytes + incomingBytes > MAX_ARCHIVE_BYTES
    ) {
      const oldest = files.shift()!;
      await unlink(join(this.directory, oldest.name));
      bytes -= oldest.size;
      this.warn(
        '[lugn] presence blackbox rotated oldest capture; export captures to retain them',
      );
    }
  }

  /** The runtime first drains HTTP requests, so all outcome callbacks have run. */
  async flush(): Promise<void> {
    await this.writes;
  }
}
