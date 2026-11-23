import { fork, type ChildProcess } from 'node:child_process';
import { setPriority } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { AnalysisStore } from './analysis-store.js';
import type { ModelPaths } from './models.js';
import type { WorkerReply, WorkerRequest } from './worker.js';

/** What the analyzer needs of a worker process; faked in tests. */
export type WorkerHandle = {
  send(message: WorkerRequest): void;
  onReply(handler: (reply: WorkerReply) => void): void;
  onExit(handler: (reason: string) => void): void;
  kill(): void;
};
export type SpawnWorker = (paths: ModelPaths) => WorkerHandle;

export type AnalyzerState =
  'off' | 'unavailable' | 'idle' | 'working' | 'backoff';
export type AnalyzerStatus = {
  state: AnalyzerState;
  reason: string | null;
  pending: number;
  done: number;
  failed: number;
  lastMs: number | null;
};

export type AnalyzerOptions = {
  store: AnalysisStore;
  /** Where each cached picture lives; null when it is gone. */
  pathOf: (id: string) => string | null;
  models: () => Promise<{ paths: ModelPaths | null; reason: string | null }>;
  spawn?: SpawnWorker;
  /** Rest between two pictures, so a long import stays gentle. */
  pauseMs?: number;
  /** A worker with nothing to do for this long exits and gives its memory back. */
  idleMs?: number;
  /** Longest a single picture may take before the worker is replaced. */
  timeoutMs?: number;
  /** Failures in a row before the analyzer waits out `backoffMs`. */
  maxConsecutiveFailures?: number;
  backoffMs?: number;
  /** Called after results were stored (the listing is rebuilt from them). */
  onChange: () => void;
  log?: (message: string) => void;
  warn?: (message: string) => void;
};

const MAX_ATTEMPTS_PER_PICTURE = 2;

/** The production worker: a forked, niced child with a small heap. */
export const forkWorker: SpawnWorker = (paths) => {
  const child: ChildProcess = fork(
    fileURLToPath(new URL('./worker.js', import.meta.url)),
    [],
    {
      env: {
        ...process.env,
        LUGN_PHOTO_MODEL_PATHS: JSON.stringify(paths),
        // One malloc arena that gives memory back: measured 250 MB resident
        // instead of 330 MB over forty pictures.
        MALLOC_ARENA_MAX: '1',
        MALLOC_TRIM_THRESHOLD_: '65536',
      },
      execArgv: ['--max-old-space-size=128'],
      serialization: 'advanced',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    },
  );
  try {
    // Lowest priority: the sensor and the lights come first.
    if (child.pid !== undefined) setPriority(child.pid, 19);
  } catch {
    /* a platform without priorities runs it at normal priority */
  }
  return {
    send: (message) => child.send(message),
    onReply: (handler) => child.on('message', handler as (m: unknown) => void),
    onExit: (handler) => {
      child.once('exit', (code, signal) =>
        handler(`exit ${code ?? signal ?? 'unknown'}`),
      );
      child.once('error', (error) => handler(error.message));
    },
    kill: () => {
      child.kill('SIGKILL');
    },
  };
};

/**
 * Runs the models over pictures that have no record yet, one at a time in a
 * child process. Never runs while there is nothing new, never on a Hub and
 * never while a picture is being shown.
 */
export class PhotoAnalyzer {
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private worker: WorkerHandle | null = null;
  private ready = false;
  private current: string | null = null;
  private timeout: NodeJS.Timeout | undefined;
  private idle: NodeJS.Timeout | undefined;
  private resume: NodeJS.Timeout | undefined;
  private consecutiveFailures = 0;
  private state: AnalyzerState = 'idle';
  private reason: string | null = null;
  private done = 0;
  private failed = 0;
  private lastMs: number | null = null;
  private disposed = false;
  private starting = false;

  constructor(private readonly options: AnalyzerOptions) {}

  status(): AnalyzerStatus {
    return {
      state: this.state,
      reason: this.reason,
      pending: this.queue.length + (this.current ? 1 : 0),
      done: this.done,
      failed: this.failed,
      lastMs: this.lastMs,
    };
  }

  /** Queues every picture that has neither a record nor a final failure. */
  enqueue(ids: Iterable<string>): void {
    if (this.disposed) return;
    for (const id of ids) {
      if (
        this.options.store.has(id) ||
        this.queued.has(id) ||
        id === this.current ||
        this.options.store.failureCount(id) >= MAX_ATTEMPTS_PER_PICTURE
      )
        continue;
      this.queue.push(id);
      this.queued.add(id);
    }
    // The next picture first only if it is new: the newest are listed last.
    if (this.queue.length > 0) void this.pump();
  }

  /** Drops queued pictures that left the library. */
  forget(live: Set<string>): void {
    for (let i = this.queue.length - 1; i >= 0; i -= 1) {
      const id = this.queue[i]!;
      if (!live.has(id)) {
        this.queue.splice(i, 1);
        this.queued.delete(id);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timeout);
    clearTimeout(this.idle);
    clearTimeout(this.resume);
    this.stopWorker(true);
  }

  private setState(state: AnalyzerState, reason: string | null = null): void {
    this.state = state;
    this.reason = reason;
  }

  private async pump(): Promise<void> {
    if (this.disposed || this.starting || this.current || this.resume) return;
    if (this.queue.length === 0) {
      this.armIdle();
      if (this.state !== 'unavailable' && this.state !== 'off')
        this.setState('idle');
      return;
    }
    clearTimeout(this.idle);
    if (!this.worker) {
      this.starting = true;
      try {
        const { paths, reason } = await this.options.models();
        if (!paths) {
          this.setState('unavailable', reason);
          this.queue.length = 0;
          this.queued.clear();
          return;
        }
        this.worker = (this.options.spawn ?? forkWorker)(paths);
        this.ready = false;
        this.worker.onReply((reply) => this.reply(reply));
        const handle = this.worker;
        this.worker.onExit((why) => this.exited(handle, why));
        this.setState('working');
      } catch (error) {
        this.fail(error instanceof Error ? error.message : String(error));
        return;
      } finally {
        this.starting = false;
      }
    }
    this.next();
  }

  private next(): void {
    if (this.disposed || !this.worker || !this.ready || this.current) return;
    while (this.queue.length > 0) {
      const id = this.queue.shift()!;
      this.queued.delete(id);
      const path = this.options.pathOf(id);
      if (!path || this.options.store.has(id)) continue;
      this.current = id;
      this.setState('working');
      this.worker.send({ type: 'analyse', id, path });
      clearTimeout(this.timeout);
      this.timeout = setTimeout(() => {
        const stuck = this.current;
        this.options.warn?.(`photo analysis timed out on one picture`);
        if (stuck) this.options.store.noteFailure(stuck);
        this.restart('timeout');
      }, this.options.timeoutMs ?? 120_000);
      this.timeout.unref?.();
      return;
    }
    this.armIdle();
    this.setState('idle');
  }

  private reply(reply: WorkerReply): void {
    if (reply.type === 'ready') {
      this.ready = true;
      this.next();
      return;
    }
    clearTimeout(this.timeout);
    if (reply.type === 'error') {
      if (reply.id === null) {
        this.fail(reply.message);
        return;
      }
      this.failed += 1;
      this.options.store.noteFailure(reply.id);
      this.options.warn?.(
        `photo analysis skipped one picture: ${reply.message}`,
      );
      this.current = null;
      this.afterPicture(false);
      return;
    }
    const id = reply.id;
    if (id !== this.current) return;
    this.current = null;
    this.options.store.put(id, {
      embedding: reply.embedding,
      faces: reply.faces,
      at: Date.now(),
    });
    this.done += 1;
    this.lastMs = reply.ms;
    this.consecutiveFailures = 0;
    this.options.log?.(
      `photo analysis: one picture took ${reply.ms} ms, ${reply.faces.length} face(s), ${this.queue.length} waiting`,
    );
    this.afterPicture(true);
  }

  private afterPicture(changed: boolean): void {
    if (changed && (this.queue.length === 0 || this.done % 10 === 0))
      this.options.onChange();
    const pause = this.options.pauseMs ?? 250;
    if (this.queue.length === 0) {
      this.options.onChange();
      this.armIdle();
      this.setState('idle');
      return;
    }
    setTimeout(() => this.next(), pause).unref?.();
  }

  private exited(handle: WorkerHandle, why: string): void {
    if (this.worker !== handle) return;
    this.worker = null;
    this.ready = false;
    clearTimeout(this.timeout);
    if (this.disposed) return;
    const lost = this.current;
    this.current = null;
    if (lost) {
      this.options.store.noteFailure(lost);
      this.fail(`worker ${why} while analysing a picture`);
      return;
    }
    // An idle worker leaving is normal; with work left it is started again.
    if (this.queue.length > 0) void this.pump();
  }

  private restart(why: string): void {
    this.current = null;
    this.stopWorker(true);
    this.fail(`worker restarted: ${why}`);
  }

  private fail(message: string): void {
    this.consecutiveFailures += 1;
    this.options.warn?.(`photo analysis problem: ${message}`);
    const limit = this.options.maxConsecutiveFailures ?? 3;
    if (this.consecutiveFailures >= limit) {
      // Something is wrong with the models or the machine: wait, then retry.
      const wait = this.options.backoffMs ?? 10 * 60_000;
      this.setState('backoff', message);
      this.consecutiveFailures = 0;
      this.stopWorker(true);
      this.resume = setTimeout(() => {
        this.resume = undefined;
        void this.pump();
      }, wait);
      this.resume.unref?.();
      return;
    }
    this.stopWorker(true);
    void this.pump();
  }

  private armIdle(): void {
    clearTimeout(this.idle);
    if (!this.worker) return;
    this.idle = setTimeout(
      () => this.stopWorker(false),
      this.options.idleMs ?? 30_000,
    );
    this.idle.unref?.();
  }

  private stopWorker(force: boolean): void {
    clearTimeout(this.idle);
    const worker = this.worker;
    if (!worker) return;
    this.worker = null;
    this.ready = false;
    try {
      if (force) worker.kill();
      else worker.send({ type: 'stop' });
    } catch {
      /* already gone */
    }
  }
}
