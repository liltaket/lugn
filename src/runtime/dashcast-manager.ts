import { DashCastAdapter } from '../adapters/dashcast.js';

const DEFAULT_CHECK_INTERVAL_MS = 10_000;
const DEFAULT_EXTERNAL_CAST_GRACE_MS = 90_000;
// A successful Cast send only confirms delivery to DashCast, not that the Hub
// rendered the page. Retry at a slower cadence until its display API heartbeat
// confirms the dashboard is actually loaded.
const DASHBOARD_HEARTBEAT_RETRY_INTERVAL_MS = 25_000;

export type ManagedDashCastHub = {
  id: string;
  castHost: string;
};

export type ManagedDashCastState =
  'starting' | 'managed' | 'yielding' | 'offline' | 'error' | 'unknown';

export type ManagedDashCastStatus = {
  state: ManagedDashCastState;
  message: string;
};

export type DashCastManagerOptions = {
  publicUrl: string;
  hubs: readonly ManagedDashCastHub[];
  dashboardPath(hubId: string): string;
  dashboardActive?(hubId: string): boolean;
  checkIntervalMs?: number;
  externalCastGraceMs?: number;
  now?: () => number;
  createAdapter?: () => DashCastAdapter;
};

type HubRuntime = {
  readonly hub: ManagedDashCastHub;
  readonly adapter: DashCastAdapter;
  inFlight: boolean;
  lastDashboardAttemptAt?: number;
  externalCastAt?: number;
  status: ManagedDashCastStatus;
};

/**
 * Periodically observes each configured Cast receiver. Lugn sends DashCast
 * only when no unrelated app is active; a new external session takes priority
 * and Lugn waits for a stable idle interval before restoring its own page.
 */
export class DashCastManager {
  private readonly hubs: HubRuntime[];
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly graceMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private started = false;
  private stopped = false;

  constructor(private readonly options: DashCastManagerOptions) {
    this.now = options.now ?? Date.now;
    this.intervalMs = options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.graceMs =
      options.externalCastGraceMs ?? DEFAULT_EXTERNAL_CAST_GRACE_MS;
    if (!Number.isFinite(this.intervalMs) || this.intervalMs < 1_000)
      throw new Error('DashCast check interval must be at least one second');
    if (!Number.isFinite(this.graceMs) || this.graceMs < 0)
      throw new Error('DashCast external cast grace period cannot be negative');
    if (options.hubs.length === 0)
      throw new Error('DashCast manager requires at least one Hub');

    const createAdapter =
      options.createAdapter ?? (() => new DashCastAdapter());
    this.hubs = options.hubs.map((hub) => ({
      hub,
      adapter: createAdapter(),
      inFlight: false,
      status: {
        state: 'starting',
        message: 'Väntar på första Cast-kontrollen.',
      },
    }));
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    for (const runtime of this.hubs) void this.checkHub(runtime);
    this.timer = setInterval(() => {
      for (const runtime of this.hubs) void this.checkHub(runtime);
    }, this.intervalMs);
    this.timer.unref?.();
  }

  statusForHub(hubId: string): ManagedDashCastStatus {
    return (
      this.hubs.find(({ hub }) => hub.id === hubId)?.status ?? {
        state: 'unknown',
        message: 'Den här Hubben bevakas inte av Lugn.',
      }
    );
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const runtime of this.hubs) runtime.adapter.close();
  }

  private async checkHub(runtime: HubRuntime): Promise<void> {
    if (this.stopped || runtime.inFlight) return;
    runtime.inFlight = true;
    try {
      const receiver = await runtime.adapter.getReceiverStatus(
        runtime.hub.castHost,
      );
      if (this.stopped) return;

      if (receiver.state === 'other_app_active') {
        runtime.externalCastAt = this.now();
        runtime.status = {
          state: 'yielding',
          message: 'Lugn låter det som castas nu vara kvar.',
        };
        return;
      }

      if (runtime.externalCastAt !== undefined) {
        if (receiver.state === 'dashcast_active') {
          runtime.externalCastAt = this.now();
          runtime.status = {
            state: 'yielding',
            message: 'DashCast körs utanför Lugn; väntar innan återställning.',
          };
          return;
        }
        if (this.now() - runtime.externalCastAt < this.graceMs) {
          runtime.status = {
            state: 'yielding',
            message:
              'Hubben är ledig; Lugn väntar innan kontrollpanelen återställs.',
          };
          return;
        }
        delete runtime.externalCastAt;
      }

      if (this.options.dashboardActive?.(runtime.hub.id) === true) {
        runtime.status = {
          state: 'managed',
          message: 'Hubben hämtar kontrollpanelens status från Lugn.',
        };
        return;
      }

      if (
        runtime.lastDashboardAttemptAt !== undefined &&
        this.now() - runtime.lastDashboardAttemptAt <
          DASHBOARD_HEARTBEAT_RETRY_INTERVAL_MS
      ) {
        runtime.status = {
          state: 'starting',
          message:
            'DashCast tog emot panelens adress; väntar på status från Hubben.',
        };
        return;
      }

      runtime.status = {
        state: 'starting',
        message: 'Lugn startar sin kontrollpanel via DashCast.',
      };
      runtime.lastDashboardAttemptAt = this.now();
      try {
        await runtime.adapter.sendDashboard(
          runtime.hub.castHost,
          `${this.options.publicUrl}${this.options.dashboardPath(runtime.hub.id)}`,
          { restartActiveSession: true },
        );
        if (this.stopped) return;
        runtime.lastDashboardAttemptAt = this.now();
        runtime.status = {
          state: 'starting',
          message:
            'Lugn skickade panelens adress; väntar på att Hubben hämtar status.',
        };
      } catch (error) {
        if (this.stopped) return;
        runtime.lastDashboardAttemptAt = this.now();
        const failure = getFailureCode(error);
        if (failure === 'active_app_conflict') {
          runtime.externalCastAt ??= this.now();
          runtime.status = {
            state: 'yielding',
            message:
              'Annan casting har företräde; Lugn inväntar att Hubben blir ledig.',
          };
        } else {
          runtime.status = {
            state:
              failure === 'socket_error' || failure === 'timeout'
                ? 'offline'
                : 'error',
            message:
              failure === 'socket_error' || failure === 'timeout'
                ? 'Cast-mottagaren svarar inte; Lugn försöker igen.'
                : 'DashCast-styrningen misslyckades; Lugn försöker igen.',
          };
        }
      }
    } catch (error) {
      if (!this.stopped) {
        const failure = getFailureCode(error);
        runtime.status = {
          state:
            failure === 'socket_error' || failure === 'timeout'
              ? 'offline'
              : 'error',
          message:
            failure === 'socket_error' || failure === 'timeout'
              ? 'Cast-mottagaren svarar inte; Lugn försöker igen.'
              : 'Cast-status kunde inte läsas; Lugn försöker igen.',
        };
      }
    } finally {
      runtime.inFlight = false;
    }
  }
}

function getFailureCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error
    ? String((error as Error & { code?: unknown }).code)
    : undefined;
}
