import { createRequire } from 'node:module';
import { randomInt } from 'node:crypto';
import { z } from 'zod';

export const DASHCAST_APP_ID = '84912283';
export const DASHCAST_NAMESPACE = 'urn:x-cast:com.madmod.dashcast';
export const DASHCAST_PORT = 8009;

const CONNECTION_NAMESPACE = 'urn:x-cast:com.google.cast.tp.connection';
const IDLE_SCREEN_APP_ID = 'E8C28D3C';
const DEFAULT_TIMEOUT_MS = 8_000;
const DASHCAST_READY_STATUS = 'Application ready';
const READINESS_POLL_INTERVAL_MS = 250;
const SESSION_STOP_POLL_INTERVAL_MS = 250;
const NAVIGATION_SETTLE_DELAY_MS = 1_800;

const DashboardUrlSchema = z
  .string()
  .url()
  .superRefine((value, context) => {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      context.addIssue({
        code: 'custom',
        message: 'Dashboard URL must use HTTP or HTTPS',
      });
    }
    if (url.username || url.password) {
      context.addIssue({
        code: 'custom',
        message: 'Dashboard URL cannot contain credentials',
      });
    }
  });

const ReceiverStatusSchema = z.object({
  applications: z
    .array(
      z.object({
        appId: z.string(),
        displayName: z.string().optional(),
        isIdleScreen: z.boolean().optional(),
        sessionId: z.string().optional(),
        statusText: z.string().optional(),
        transportId: z.string().optional(),
      }),
    )
    .optional(),
});

const ApplicationSessionSchema = z.object({
  appId: z.string(),
  displayName: z.string().optional(),
  isIdleScreen: z.boolean().optional(),
  sessionId: z.string().optional(),
  statusText: z.string().optional(),
  transportId: z.string().min(1),
});

export type DashCastPhase =
  | 'idle'
  | 'connecting'
  | 'checking_receiver'
  | 'launching'
  | 'sending'
  | 'sent_unconfirmed'
  | 'failed'
  | 'closed';

export type DashCastReceiverState =
  'no_active_app' | 'dashcast_active' | 'other_app_active';

export type DashCastApplication = {
  appId: string;
  displayName?: string;
  isIdleScreen?: boolean;
  sessionId?: string;
  statusText?: string;
  transportId?: string;
};

export type DashCastReceiverSnapshot = {
  address: string;
  state: DashCastReceiverState;
  applications: DashCastApplication[];
};

export type DashCastFailureCode =
  | 'invalid_address'
  | 'invalid_url'
  | 'timeout'
  | 'socket_error'
  | 'receiver_status_error'
  | 'launch_error'
  | 'launch_missing_session'
  | 'stop_error'
  | 'active_app_conflict'
  | 'channel_error'
  | 'closed';

export type DashCastStatus = {
  phase: DashCastPhase;
  address?: string;
  receiver?: DashCastReceiverSnapshot;
  failure?: DashCastFailureCode;
  updatedAt: number;
};

export type DashCastSendResult = {
  address: string;
  appId: typeof DASHCAST_APP_ID;
  receiver: DashCastReceiverSnapshot;
  /** The Cast socket received the command; the page load remains unconfirmed. */
  delivery: 'sent_unconfirmed';
};

type CastChannel = {
  send(data: unknown): void;
  close(): void;
};

type RawCastClient = {
  createChannel(
    sourceId: string,
    destinationId: string,
    namespace: string,
    encoding: 'JSON',
  ): CastChannel;
};

type ReceiverController = {
  getStatus(callback: (error: Error | null, response: unknown) => void): void;
  launch(
    appId: string,
    callback: (error: Error | null, applications: unknown[]) => void,
  ): void;
  stop?(
    sessionId: string,
    callback: (error: Error | null, applications: unknown[]) => void,
  ): void;
};

/** Small structural surface of castv2-client, kept injectable for host code. */
export type DashCastClient = {
  client: RawCastClient;
  receiver?: ReceiverController | null;
  connect(options: { host: string; port: number }, callback: () => void): void;
  on(event: 'error', listener: (error: Error) => void): unknown;
  removeListener(event: 'error', listener: (error: Error) => void): unknown;
  close(): void;
};

export type DashCastClientFactory = () => DashCastClient;

export type DashCastAdapterOptions = {
  clientFactory?: DashCastClientFactory;
  timeoutMs?: number;
  now?: () => number;
};

export type DashCastSendOptions = {
  /** Stop and relaunch an active DashCast app before sending the URL. */
  restartActiveSession?: boolean;
};

const require = createRequire(import.meta.url);
const CastV2ClientModule = require('castv2-client') as {
  Client: new () => DashCastClient;
};

/**
 * Controls DashCast directly over Cast V2. Its JSON echo confirms that DashCast
 * accepted the command, but does not confirm that the page rendered.
 */
export class DashCastAdapter {
  private readonly clientFactory: DashCastClientFactory;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private listeners = new Set<(status: DashCastStatus) => void>();
  private activeClient: DashCastClient | undefined;
  private cancelActiveOperation: (() => void) | undefined;
  private disposed = false;
  private _status: DashCastStatus = {
    phase: 'idle',
    updatedAt: Date.now(),
  };

  constructor(options: DashCastAdapterOptions = {}) {
    this.clientFactory =
      options.clientFactory ?? (() => new CastV2ClientModule.Client());
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? Date.now;

    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 1) {
      throw new Error('DashCast timeoutMs must be a positive finite number');
    }
    this._status = { phase: 'idle', updatedAt: this.now() };
  }

  get status(): DashCastStatus {
    return this._status;
  }

  subscribe(listener: (status: DashCastStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Reads receiver status without launching or changing its current app. */
  async getReceiverStatus(address: string): Promise<DashCastReceiverSnapshot> {
    const normalizedAddress = parseAddress(address);
    return this.withConnection(
      normalizedAddress,
      'checking_receiver',
      (client) =>
        this.readReceiverStatus(normalizedAddress, requireReceiver(client)),
    );
  }

  /**
   * Launches DashCast only when the receiver is idle or already running
   * DashCast. When requested, an active DashCast session is stopped and
   * relaunched. An unrelated active app is left untouched for user control.
   */
  async sendDashboard(
    address: string,
    dashboardUrl: string,
    options: DashCastSendOptions = {},
  ): Promise<DashCastSendResult> {
    const normalizedAddress = parseAddress(address);
    const parsedUrl = DashboardUrlSchema.safeParse(dashboardUrl);
    if (!parsedUrl.success) {
      this.setStatus({
        phase: 'failed',
        address: normalizedAddress,
        failure: 'invalid_url',
      });
      throw new DashCastOperationError('invalid_url');
    }

    return this.withConnection(
      normalizedAddress,
      'checking_receiver',
      async (client) => {
        const controller = requireReceiver(client);
        const before = await this.readReceiverStatus(
          normalizedAddress,
          controller,
        );
        if (before.state === 'other_app_active') {
          this.setStatus({
            phase: 'failed',
            address: normalizedAddress,
            receiver: before,
            failure: 'active_app_conflict',
          });
          throw new DashCastOperationError('active_app_conflict');
        }

        const existingSession = before.applications.find(
          (application) => application.appId === DASHCAST_APP_ID,
        );
        let session =
          before.state === 'dashcast_active' && existingSession?.transportId
            ? ApplicationSessionSchema.parse(existingSession)
            : undefined;
        if (
          options.restartActiveSession &&
          before.state === 'dashcast_active'
        ) {
          if (!session) {
            throw new DashCastOperationError('launch_missing_session');
          }
          const oldSessionId = session.sessionId;
          if (!oldSessionId) {
            throw new DashCastOperationError('launch_missing_session');
          }
          if (!controller.stop) {
            throw new DashCastOperationError('stop_error');
          }
          this.setStatus({
            phase: 'launching',
            address: normalizedAddress,
            receiver: before,
          });
          const stopSession = controller.stop;
          await withTimeout(
            new Promise<void>((resolve, reject) => {
              stopSession.call(controller, oldSessionId, (error) => {
                if (error) reject(new DashCastOperationError('stop_error'));
                else resolve();
              });
            }),
            this.timeoutMs,
          );
          await this.waitForDashCastStopped(
            normalizedAddress,
            controller,
            oldSessionId,
          );
          session = undefined;
        }
        if (!session) {
          this.setStatus({
            phase: 'launching',
            address: normalizedAddress,
            receiver: before,
          });
          const launchedApplications = await withTimeout(
            new Promise<unknown[]>((resolve, reject) => {
              controller.launch(DASHCAST_APP_ID, (error, applications) => {
                if (error) reject(new DashCastOperationError('launch_error'));
                else resolve(applications);
              });
            }),
            this.timeoutMs,
          );
          const sessions = z
            .array(ApplicationSessionSchema)
            .safeParse(launchedApplications);
          if (!sessions.success) {
            throw new DashCastOperationError('launch_missing_session');
          }
          session = sessions.data.find(
            (application) => application.appId === DASHCAST_APP_ID,
          );
        }
        if (!session?.transportId || !session.sessionId) {
          throw new DashCastOperationError('launch_missing_session');
        }

        // pychromecast's PlatformSender uses this sender ID for app messages.
        const senderId = 'sender-0';
        const requestId = randomInt(2, 1_000_000);
        let connectionChannel: CastChannel | undefined;
        let dashCastChannel: CastChannel | undefined;
        try {
          connectionChannel = client.client.createChannel(
            senderId,
            session.transportId,
            CONNECTION_NAMESPACE,
            'JSON',
          );
          const readyReceiver = await this.waitForDashCastReady(
            normalizedAddress,
            controller,
            session.transportId,
          );
          connectionChannel.send({
            type: 'CONNECT',
            origin: {},
            userAgent: 'PyChromecast',
            senderInfo: {
              sdkType: 2,
              version: '15.605.1.3',
              browserVersion: '44.0.2403.30',
              platform: 4,
              systemVersion: 'Macintosh; Intel Mac OS X10_10_3',
              connectionType: 1,
            },
          });
          dashCastChannel = client.client.createChannel(
            senderId,
            session.transportId,
            DASHCAST_NAMESPACE,
            'JSON',
          );
          this.setStatus({
            phase: 'sending',
            address: normalizedAddress,
            receiver: {
              ...before,
              state: 'dashcast_active',
              applications: [
                ...before.applications.filter(
                  (application) => application.appId !== DASHCAST_APP_ID,
                ),
                toApplicationSummary(session),
              ],
            },
          });
          dashCastChannel.send({
            url: parsedUrl.data,
            force: true,
            reload: false,
            reload_time: 0,
            requestId,
            sessionId: session.sessionId,
          });
          // Force mode navigates the receiver itself about a second later, so
          // DashCast may unload the page-side listener before it echoes. Keep
          // the Cast connection alive long enough for navigation to complete.
          await delay(NAVIGATION_SETTLE_DELAY_MS);
          this.setStatus({
            phase: 'sent_unconfirmed',
            address: normalizedAddress,
            receiver: readyReceiver,
          });
          return {
            address: normalizedAddress,
            appId: DASHCAST_APP_ID,
            receiver: readyReceiver,
            delivery: 'sent_unconfirmed',
          };
        } catch (error) {
          if (error instanceof DashCastOperationError) throw error;
          throw new DashCastOperationError('channel_error');
        } finally {
          closeChannel(dashCastChannel);
          closeChannel(connectionChannel);
        }
      },
      this.timeoutMs * 6,
    );
  }

  /** Closes any active Cast socket and prevents further use of this instance. */
  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelActiveOperation?.();
    this.closeClient(this.activeClient);
    this.activeClient = undefined;
    this.setStatus({
      phase: 'closed',
      ...(this._status.address === undefined
        ? {}
        : { address: this._status.address }),
      ...(this._status.receiver === undefined
        ? {}
        : { receiver: this._status.receiver }),
      failure: 'closed',
    });
  }

  private async readReceiverStatus(
    address: string,
    controller: ReceiverController,
    timeoutMs = this.timeoutMs,
  ): Promise<DashCastReceiverSnapshot> {
    const response = await withTimeout(
      new Promise<unknown>((resolve, reject) => {
        controller.getStatus((error, value) => {
          if (error)
            reject(new DashCastOperationError('receiver_status_error'));
          else resolve(value);
        });
      }),
      timeoutMs,
    );
    const parsed = ReceiverStatusSchema.safeParse(response);
    if (!parsed.success) {
      throw new DashCastOperationError('receiver_status_error');
    }
    const snapshot = summarizeReceiverStatus(address, parsed.data);
    this.setStatus({
      phase: 'checking_receiver',
      address,
      receiver: snapshot,
    });
    return snapshot;
  }

  /** Waits for DashCast's page receiver before sending its first URL command. */
  private async waitForDashCastReady(
    address: string,
    controller: ReceiverController,
    transportId: string,
  ): Promise<DashCastReceiverSnapshot> {
    const deadline = Date.now() + this.timeoutMs;
    while (true) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new DashCastOperationError('timeout');

      const receiver = await this.readReceiverStatus(
        address,
        controller,
        remainingMs,
      );
      if (receiver.state === 'other_app_active') {
        throw new DashCastOperationError('active_app_conflict');
      }
      const dashCast = receiver.applications.find(
        (application) =>
          application.appId === DASHCAST_APP_ID &&
          application.transportId === transportId,
      );
      if (dashCast?.statusText === DASHCAST_READY_STATUS) return receiver;

      const nextPollDelay = Math.min(
        READINESS_POLL_INTERVAL_MS,
        deadline - Date.now(),
      );
      if (nextPollDelay <= 0) throw new DashCastOperationError('timeout');
      await delay(nextPollDelay);
    }
  }

  /** Waits until the stopped Cast session is no longer the active DashCast app. */
  private async waitForDashCastStopped(
    address: string,
    controller: ReceiverController,
    sessionId: string,
  ): Promise<void> {
    const deadline = Date.now() + this.timeoutMs;
    while (true) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new DashCastOperationError('timeout');

      const receiver = await this.readReceiverStatus(
        address,
        controller,
        remainingMs,
      );
      if (receiver.state === 'other_app_active') {
        throw new DashCastOperationError('active_app_conflict');
      }
      const oldSessionStillActive = receiver.applications.some(
        (application) =>
          application.appId === DASHCAST_APP_ID &&
          (application.sessionId === undefined ||
            application.sessionId === sessionId),
      );
      if (!oldSessionStillActive && receiver.state !== 'dashcast_active') {
        return;
      }

      const nextPollDelay = Math.min(
        SESSION_STOP_POLL_INTERVAL_MS,
        deadline - Date.now(),
      );
      if (nextPollDelay <= 0) throw new DashCastOperationError('timeout');
      await delay(nextPollDelay);
    }
  }

  private async withConnection<T>(
    address: string,
    initialPhase: 'checking_receiver',
    operation: (client: DashCastClient) => Promise<T>,
    operationTimeoutMs = this.timeoutMs * 2,
  ): Promise<T> {
    if (this.disposed) {
      throw new DashCastOperationError('closed');
    }
    this.setStatus({ phase: 'connecting', address });

    let client: DashCastClient;
    try {
      client = this.clientFactory();
    } catch {
      this.setStatus({ phase: 'failed', address, failure: 'socket_error' });
      throw new DashCastOperationError('socket_error');
    }
    this.activeClient = client;

    let settled = false;
    let operationTimer: ReturnType<typeof setTimeout> | undefined;
    let rejectSocketFailure: ((error: Error) => void) | undefined;
    let rejectCancelled: ((error: Error) => void) | undefined;
    const socketFailure = new Promise<never>((_resolve, reject) => {
      rejectSocketFailure = reject;
    });
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectCancelled = reject;
    });
    const onClientError = (): void => {
      rejectSocketFailure?.(new DashCastOperationError('socket_error'));
    };
    client.on('error', onClientError);
    this.cancelActiveOperation = () => {
      if (!settled) rejectCancelled?.(new DashCastOperationError('closed'));
    };

    const connection = new Promise<void>((resolve, reject) => {
      operationTimer = setTimeout(
        () => reject(new DashCastOperationError('timeout')),
        this.timeoutMs,
      );
      try {
        client.connect({ host: address, port: DASHCAST_PORT }, resolve);
      } catch {
        reject(new DashCastOperationError('socket_error'));
      }
    });

    try {
      await Promise.race([connection, socketFailure, cancelled]);
      if (operationTimer) clearTimeout(operationTimer);
      operationTimer = undefined;
      this.setStatus({ phase: initialPhase, address });
      const result = await Promise.race([
        operation(client),
        socketFailure,
        cancelled,
        new Promise<never>((_resolve, reject) => {
          operationTimer = setTimeout(
            () => reject(new DashCastOperationError('timeout')),
            operationTimeoutMs,
          );
        }),
      ]);
      settled = true;
      return result;
    } catch (error) {
      settled = true;
      const failure = classifyFailure(error);
      if (!this.disposed) {
        this.setStatus({
          phase: 'failed',
          address,
          ...(this._status.receiver === undefined
            ? {}
            : { receiver: this._status.receiver }),
          failure,
        });
      }
      throw new DashCastOperationError(failure);
    } finally {
      if (operationTimer) clearTimeout(operationTimer);
      client.removeListener('error', onClientError);
      if (this.activeClient === client) this.activeClient = undefined;
      this.cancelActiveOperation = undefined;
      this.closeClient(client);
    }
  }

  private closeClient(client: DashCastClient | undefined): void {
    if (!client) return;
    try {
      client.close();
    } catch {
      // The library throws if a TLS socket has not finished connecting yet.
    }
  }

  private setStatus(update: Omit<DashCastStatus, 'updatedAt'>): void {
    this._status = { ...update, updatedAt: this.now() };
    for (const listener of this.listeners) {
      try {
        listener(this._status);
      } catch {
        // Observer failures must not interrupt a Cast operation.
      }
    }
  }
}

function requireReceiver(client: DashCastClient): ReceiverController {
  if (!client.receiver) {
    throw new DashCastOperationError('receiver_status_error');
  }
  return client.receiver;
}

function summarizeReceiverStatus(
  address: string,
  status: z.infer<typeof ReceiverStatusSchema>,
): DashCastReceiverSnapshot {
  const applications = (status.applications ?? []).map((application) => ({
    appId: application.appId,
    ...(application.displayName === undefined
      ? {}
      : { displayName: application.displayName }),
    ...(application.isIdleScreen === undefined
      ? {}
      : { isIdleScreen: application.isIdleScreen }),
    ...(application.sessionId === undefined
      ? {}
      : { sessionId: application.sessionId }),
    ...(application.statusText === undefined
      ? {}
      : { statusText: application.statusText }),
    ...(application.transportId === undefined
      ? {}
      : { transportId: application.transportId }),
  }));
  const activeApplications = applications.filter(
    (application) =>
      !application.isIdleScreen && application.appId !== IDLE_SCREEN_APP_ID,
  );
  const state: DashCastReceiverState = activeApplications.some(
    (application) => application.appId === DASHCAST_APP_ID,
  )
    ? 'dashcast_active'
    : activeApplications.length > 0
      ? 'other_app_active'
      : 'no_active_app';
  return { address, state, applications };
}

function toApplicationSummary(
  application: z.infer<typeof ApplicationSessionSchema>,
): DashCastApplication {
  return {
    appId: application.appId,
    ...(application.displayName === undefined
      ? {}
      : { displayName: application.displayName }),
    ...(application.isIdleScreen === undefined
      ? {}
      : { isIdleScreen: application.isIdleScreen }),
    ...(application.sessionId === undefined
      ? {}
      : { sessionId: application.sessionId }),
    ...(application.statusText === undefined
      ? {}
      : { statusText: application.statusText }),
    transportId: application.transportId,
  };
}

function parseAddress(value: string): string {
  const address = value.trim();
  if (!address || address.length > 253 || /[\s/\\]/.test(address)) {
    throw new DashCastOperationError('invalid_address');
  }
  return address;
}

function closeChannel(channel: CastChannel | undefined): void {
  if (!channel) return;
  try {
    channel.close();
  } catch {
    // Channel cleanup is best-effort after the Cast message has been sent.
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new DashCastOperationError('timeout')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function classifyFailure(error: unknown): DashCastFailureCode {
  if (error instanceof DashCastOperationError) return error.code;
  return 'receiver_status_error';
}

class DashCastOperationError extends Error {
  constructor(readonly code: DashCastFailureCode) {
    super(code);
  }
}
