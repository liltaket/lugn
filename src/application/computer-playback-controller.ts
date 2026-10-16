import { randomUUID } from 'node:crypto';
import type { Clock, TimerHandle } from '../core/clock.js';
import { isHumanActor } from '../core/automation-holds.js';
import type {
  ComputerPlaybackRouteSnapshot,
  MusicCommandRecord,
  MusicObservationValues,
  MusicRequest,
  Provenance,
  RoomState,
} from '../core/schemas.js';
import type {
  ComputerPlaybackAck,
  ComputerPlaybackCommand,
  ComputerPlaybackMqttAdapter,
  ComputerPlaybackPlayer,
  ComputerPlaybackState,
} from '../adapters/computer-playback-mqtt.js';
import {
  ComputerNowPlayingSelector,
  type ComputerAudioRoute,
} from './computer-now-playing.js';

type PlaybackRequest = Extract<MusicRequest, { property: 'playback' }>;
export interface ComputerPlaybackControl {
  readonly state?: Record<string, ComputerPlaybackRouteSnapshot>;
  handles(target: string): boolean;
  getPlayback(target: string): MusicObservationValues['playback'];
  canResume(target: string): boolean;
  request(
    target: string,
    request: PlaybackRequest,
    provenance: Provenance,
  ): Promise<MusicCommandRecord>;
  observe(): void;
  invalidate(target?: string): void;
  dispose(): void;
}
export type ComputerPlaybackTransport = Pick<
  ComputerPlaybackMqttAdapter,
  'getSnapshot' | 'sendCommand'
>;
type Context = {
  route: ComputerAudioRoute;
  control: ComputerPlaybackState;
  transport: ComputerPlaybackTransport;
};
type Ownership = {
  commandId: string;
  sessionId: string;
  connectionId: string;
  player: string;
  instanceId: string;
  contentId: string;
  token: string | null;
  expiresAt: number;
  pending: Promise<MusicCommandRecord> | null;
  awaitingLeaseUntil: number | null;
  leaseTimer: TimerHandle | undefined;
};
type PendingCommand = {
  requested: PlaybackRequest;
  command: ComputerPlaybackCommand;
  operation: Promise<MusicCommandRecord>;
};
type ResumedPlayer = {
  command: ComputerPlaybackCommand;
  baselineSequence: number;
  expiresAt: number;
};

/** Explicit desktop command intent, separate from the receiver's physical state.
 * Ownership is deliberately memory-only: restarting or reconnecting never resumes old media.
 */
export class ComputerPlaybackController implements ComputerPlaybackControl {
  readonly state: Record<string, ComputerPlaybackRouteSnapshot> = {};
  private readonly selector: ComputerNowPlayingSelector;
  private readonly ownership = new Map<string, Ownership>();
  private readonly pending = new Map<string, PendingCommand>();
  private readonly revisions = new Map<string, number>();
  private readonly resumedPlayers = new Map<string, ResumedPlayer>();
  private disposed = false;
  private readonly waiters = new Set<() => void>();
  constructor(
    private readonly options: {
      routes: Readonly<Record<string, ComputerAudioRoute>>;
      clock: Clock;
      getState: () => RoomState | undefined;
      observationTrusted: (target: string) => boolean;
      automaticResumeAllowed?: (target: string) => boolean;
      automaticPauseAllowed?: (target: string) => boolean;
      adapterForDevice: (
        deviceId: string,
      ) => ComputerPlaybackTransport | undefined;
      onChange?: () => void;
      uuid?: () => string;
    },
  ) {
    this.selector = new ComputerNowPlayingSelector(options.routes);
  }

  handles(target: string): boolean {
    const route = this.options.routes[target];
    const source =
      this.options.getState()?.music.devices[target]?.observed.source;
    return !!route && (source == null || source === route.source);
  }

  private context(target: string): Context | undefined {
    if (this.disposed || !this.handles(target)) return;
    const state = this.options.getState();
    const route = this.options.routes[target]!;
    const device = state?.music.devices[target];
    const computer = state?.computer.devices[route.deviceId];
    const transport = this.options.adapterForDevice(route.deviceId);
    const snapshot = transport?.getSnapshot();
    if (
      !device ||
      device.observed.source !== route.source ||
      device.availability !== 'available' ||
      !this.options.observationTrusted(target) ||
      !computer ||
      computer.availability !== 'online' ||
      computer.freshness !== 'fresh' ||
      !snapshot?.fresh ||
      snapshot.state.session_id !== computer.sessionId ||
      !transport
    )
      return;
    return { route, control: snapshot.state, transport };
  }

  private ownedPlayer(
    context: Context,
    owned: Ownership,
  ): ComputerPlaybackPlayer | undefined {
    if (
      context.control.session_id !== owned.sessionId ||
      context.control.connection_id !== owned.connectionId ||
      this.options.clock.now() >= owned.expiresAt
    )
      return;
    const player = context.control.players.find(
      (player) => player.player === owned.player,
    );
    if (
      !player ||
      player.player_instance_id !== owned.instanceId ||
      player.content_id !== owned.contentId
    )
      return;
    return player;
  }

  private selected(
    context: Context,
    target: string,
  ): ComputerPlaybackPlayer | undefined {
    const state = this.options.getState();
    if (!state) return;
    const name = this.selector.selectedPlayer(state, target);
    return context.control.players.find(
      (player) => player.player === name && player.content_id !== null,
    );
  }

  getPlayback(target: string): MusicObservationValues['playback'] {
    const context = this.context(target);
    if (!context) return 'unknown';
    const pending = this.pending.get(target);
    if (
      pending?.requested.value === 'playing' &&
      this.resumedPlayer(context, pending.command)
    )
      return 'playing';
    const owned = this.ownership.get(target);
    const player = owned
      ? this.ownedPlayer(context, owned)
      : this.selected(context, target);
    if (player?.playback_status === 'Playing') return 'playing';
    if (player?.playback_status === 'Paused') return 'paused';
    // A known nonplaying desktop never inherits the receiver's still-Playing Optical status.
    return context.control.players.every((player) =>
      ['Paused', 'Stopped'].includes(player.playback_status ?? ''),
    )
      ? 'paused'
      : 'unknown';
  }

  canResume(target: string): boolean {
    const context = this.context(target);
    const owned = this.ownership.get(target);
    if (!context || !owned) return false;
    const player = this.ownedPlayer(context, owned);
    if (!player) return false;
    if (owned.pending) return true;
    if (this.leaseReported(context, owned)) {
      this.acceptLease(owned);
      return true;
    }
    return (
      owned.awaitingLeaseUntil !== null &&
      this.options.clock.monotonicNow() < owned.awaitingLeaseUntil &&
      (player.playback_status === 'Playing' ||
        player.playback_status === 'Paused') &&
      player.pause_lease === null
    );
  }

  private acceptLease(owned: Ownership): void {
    owned.awaitingLeaseUntil = null;
    if (owned.leaseTimer !== undefined)
      this.options.clock.clearTimeout(owned.leaseTimer);
    owned.leaseTimer = undefined;
  }

  private dropOwnership(target: string): void {
    const owned = this.ownership.get(target);
    if (owned) this.acceptLease(owned);
    this.ownership.delete(target);
  }

  private resumedPlayer(
    context: Context,
    command: ComputerPlaybackCommand,
  ): ComputerPlaybackPlayer | undefined {
    if (
      context.control.session_id !== command.session_id ||
      context.control.connection_id !== command.connection_id
    )
      return;
    return context.control.players.find(
      (player) =>
        player.player === command.player &&
        player.player_instance_id === command.player_instance_id &&
        player.content_id === command.content_id,
    );
  }

  private leaseReported(context: Context, owned: Ownership): boolean {
    const player = this.ownedPlayer(context, owned);
    return (
      !!player &&
      player.playback_status === 'Paused' &&
      player.can_play &&
      !!owned.token &&
      player.pause_lease?.pause_command_id === owned.commandId &&
      player.pause_lease.resume_token === owned.token &&
      player.pause_lease.expires_at_ms > this.options.clock.now()
    );
  }

  observe(): void {
    if (this.disposed) return;
    const state = this.options.getState();
    if (state) this.selector.observe(state.computer.devices);
    for (const [target, owned] of this.ownership) {
      const context = this.context(target);
      const player = context && this.ownedPlayer(context, owned);
      if (!player) this.dropOwnership(target);
      else if (!owned.pending) {
        if (this.leaseReported(context!, owned)) this.acceptLease(owned);
        else if (!this.canResume(target)) this.dropOwnership(target);
      }
    }
    this.refresh();
    for (const notify of [...this.waiters]) notify();
  }

  invalidate(target?: string): void {
    const targets =
      target === undefined ? Object.keys(this.options.routes) : [target];
    for (const item of targets) {
      this.revisions.set(item, (this.revisions.get(item) ?? 0) + 1);
      this.dropOwnership(item);
      this.resumedPlayers.delete(item);
    }
    for (const notify of [...this.waiters]) notify();
    this.refresh();
  }

  private refresh(): void {
    let changed = false;
    for (const [target, route] of Object.entries(this.options.routes)) {
      const context = this.context(target);
      const player = context && this.selected(context, target);
      const snapshot: ComputerPlaybackRouteSnapshot = {
        active: this.handles(target),
        deviceId: route.deviceId,
        playback:
          this.getPlayback(target) === 'playing'
            ? 'playing'
            : this.getPlayback(target) === 'paused'
              ? 'paused'
              : 'unknown',
        canPause:
          !!player && player.playback_status === 'Playing' && player.can_pause,
        canResume: this.canResume(target),
        pending: this.pending.has(target),
        lastCommand: this.state[target]?.lastCommand ?? null,
      };
      if (JSON.stringify(this.state[target]) !== JSON.stringify(snapshot)) {
        this.state[target] = snapshot;
        changed = true;
      }
    }
    if (changed) this.options.onChange?.();
  }

  async request(
    target: string,
    request: PlaybackRequest,
    provenance: Provenance,
  ): Promise<MusicCommandRecord> {
    const revision = (this.revisions.get(target) ?? 0) + 1;
    this.revisions.set(target, revision);
    for (const notify of [...this.waiters]) notify();
    const prior = this.pending.get(target);
    let resumed = this.resumedPlayers.get(target);
    if (prior) {
      if (request.value === 'paused' && prior.requested.value === 'paused')
        return prior.operation;
      await prior.operation;
      this.assertCurrent(target, revision, request, provenance);
      if (prior.requested.value === 'playing')
        resumed = this.resumedPlayers.get(target);
    }
    if (resumed && this.options.clock.monotonicNow() >= resumed.expiresAt)
      resumed = undefined;
    if (
      request.value === 'paused' &&
      resumed &&
      this.options.clock.monotonicNow() < resumed.expiresAt
    ) {
      const recent = resumed;
      await this.waitFor(
        target,
        revision,
        () => {
          const context = this.context(target);
          const player = context && this.resumedPlayer(context, recent.command);
          return (
            !!context &&
            !!player &&
            context.control.sequence > recent.baselineSequence &&
            player.playback_status === 'Playing' &&
            player.can_pause &&
            player.pause_lease === null
          );
        },
        () => {
          const context = this.context(target);
          return !!context && !!this.resumedPlayer(context, recent.command);
        },
      );
    }
    const resumeClaim = this.ownership.get(target);
    const resumeContext = this.context(target);
    if (
      request.value === 'playing' &&
      resumeClaim?.token &&
      resumeContext &&
      this.canResume(target) &&
      !this.leaseReported(resumeContext, resumeClaim)
    ) {
      await this.waitFor(
        target,
        revision,
        () => {
          const context = this.context(target);
          const owned = this.ownership.get(target);
          return !!context && !!owned && this.leaseReported(context, owned);
        },
        () => !!this.context(target) && this.ownership.has(target),
      );
    }
    this.assertCurrent(target, revision, request, provenance);
    const context = this.context(target);
    if (!context) throw new Error('Computer playback is unavailable');
    const owned = this.ownership.get(target);
    if (request.value === 'paused' && owned && this.canResume(target)) {
      // Explicit Pause keeps the lease for an explicit Play; the engine's human hold blocks automation.
      return this.recordNoop(target, request, provenance);
    }
    const player =
      request.value === 'paused'
        ? resumed
          ? context.control.sequence > resumed.baselineSequence
            ? this.resumedPlayer(context, resumed.command)
            : undefined
          : this.selected(context, target)
        : owned && this.ownedPlayer(context, owned);
    if (!player || !player.content_id)
      throw new Error('No unambiguous controllable computer media');
    if (
      request.value === 'playing' &&
      (!owned || !this.leaseReported(context, owned))
    )
      throw new Error('Lugn does not own a resumable computer pause');
    if (
      request.value === 'paused' &&
      (player.playback_status !== 'Playing' ||
        !player.can_pause ||
        player.pause_lease !== null)
    )
      throw new Error('Computer media cannot be paused');
    const now = this.options.clock.now();
    const commandId = (this.options.uuid ?? randomUUID)();
    const command: ComputerPlaybackCommand = {
      schema_version: 1,
      device_id: context.route.deviceId,
      session_id: context.control.session_id,
      connection_id: context.control.connection_id,
      command_id: commandId,
      action: request.value === 'paused' ? 'pause' : 'resume',
      player: player.player,
      player_instance_id: player.player_instance_id,
      content_id: player.content_id,
      issued_at_ms: now,
      expires_at_ms: now + 10_000,
      pause_command_id: request.value === 'playing' ? owned!.commandId : null,
      resume_token: request.value === 'playing' ? owned!.token : null,
      lease_ttl_ms: request.value === 'paused' ? 20 * 60_000 : null,
    };
    const record: MusicCommandRecord = {
      id: commandId,
      target,
      requested: request,
      provenance,
      issuedAt: now,
      status: 'pending',
      acceptedAt: now,
    };
    const claim: Ownership | undefined =
      request.value === 'paused'
        ? {
            commandId,
            sessionId: command.session_id,
            connectionId: command.connection_id,
            player: command.player,
            instanceId: command.player_instance_id,
            contentId: command.content_id,
            token: null,
            expiresAt: now + 20 * 60_000,
            pending: null,
            awaitingLeaseUntil: null,
            leaseTimer: undefined,
          }
        : undefined;
    this.dropOwnership(target);
    if (claim) {
      this.ownership.set(target, claim);
      this.resumedPlayers.delete(target);
    } else {
      resumed = {
        command,
        baselineSequence: context.control.sequence,
        expiresAt: this.options.clock.monotonicNow() + 12_000,
      };
      this.resumedPlayers.set(target, resumed);
    }
    const operation = this.execute(context, command, record, claim);
    const pending: PendingCommand = {
      operation,
      command,
      requested: request,
    };
    this.pending.set(target, pending);
    if (claim) claim.pending = operation;
    this.refresh();
    this.setRecord(target, record);
    try {
      return await operation;
    } finally {
      if (this.pending.get(target) === pending) this.pending.delete(target);
      if (
        request.value === 'playing' &&
        this.resumedPlayers.get(target) === resumed
      )
        resumed!.expiresAt = this.options.clock.monotonicNow() + 2_000;
      this.refresh();
    }
  }

  private assertCurrent(
    target: string,
    revision: number,
    request: PlaybackRequest,
    provenance: Provenance,
  ): void {
    if (this.disposed || this.revisions.get(target) !== revision)
      throw new Error('Computer playback intent was superseded');
    if (
      !isHumanActor(provenance.actor) &&
      (request.value === 'playing'
        ? this.options.automaticResumeAllowed?.(target) === false
        : this.options.automaticPauseAllowed?.(target) === false)
    )
      throw new Error('Automatic computer playback is no longer allowed');
  }

  private waitFor(
    target: string,
    revision: number,
    ready: () => boolean,
    valid: () => boolean,
  ): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        this.options.clock.clearTimeout(timer);
        this.waiters.delete(check);
        resolve();
      };
      const check = () => {
        if (
          this.disposed ||
          this.revisions.get(target) !== revision ||
          ready() ||
          !valid()
        )
          finish();
      };
      const timer = this.options.clock.setTimeout(finish, 2_000);
      this.waiters.add(check);
      check();
    });
  }

  private async execute(
    context: Context,
    command: ComputerPlaybackCommand,
    record: MusicCommandRecord,
    claim?: Ownership,
  ): Promise<MusicCommandRecord> {
    try {
      const ack: ComputerPlaybackAck =
        await context.transport.sendCommand(command);
      if (ack.outcome !== 'applied') {
        record.status = ack.outcome === 'uncertain' ? 'unconfirmed' : 'failed';
        record.diagnosticReason = `computer_${ack.outcome}:${ack.reason}`;
        if (claim && this.ownership.get(record.target) === claim)
          this.dropOwnership(record.target);
      } else {
        record.status = 'confirmed';
        record.confirmedAt = this.options.clock.now();
        if (claim && this.ownership.get(record.target) === claim) {
          if (!ack.resume_token || !ack.lease_expires_at_ms)
            this.dropOwnership(record.target);
          else {
            claim.token = ack.resume_token;
            claim.expiresAt = ack.lease_expires_at_ms;
            // ACK and state are independent MQTT topics: even a newer state can
            // precede the pause. Wait briefly for its exact lease, without
            // treating intermediate Playing/Paused snapshots as resume authority.
            const latest = this.context(record.target);
            if (latest && this.leaseReported(latest, claim))
              this.acceptLease(claim);
            else {
              claim.awaitingLeaseUntil =
                this.options.clock.monotonicNow() + 2_000;
              claim.leaseTimer = this.options.clock.setTimeout(() => {
                if (
                  this.ownership.get(record.target) === claim &&
                  claim.awaitingLeaseUntil !== null
                )
                  this.dropOwnership(record.target);
                this.refresh();
                for (const notify of [...this.waiters]) notify();
              }, 2_000);
            }
          }
        }
      }
    } catch {
      record.status = 'unconfirmed';
      record.diagnosticReason = 'computer_delivery_uncertain';
      if (claim && this.ownership.get(record.target) === claim)
        this.dropOwnership(record.target);
    } finally {
      if (claim) claim.pending = null;
      this.setRecord(record.target, record);
    }
    return structuredClone(record);
  }

  private setRecord(target: string, record: MusicCommandRecord): void {
    if (!this.state[target]) this.refresh();
    if (this.state[target])
      this.state[target]!.lastCommand = structuredClone(record);
    this.options.onChange?.();
  }

  private recordNoop(
    target: string,
    requested: PlaybackRequest,
    provenance: Provenance,
  ): MusicCommandRecord {
    const record: MusicCommandRecord = {
      id: (this.options.uuid ?? randomUUID)(),
      target,
      requested,
      provenance,
      issuedAt: this.options.clock.now(),
      status: 'confirmed',
      confirmedAt: this.options.clock.now(),
    };
    this.setRecord(target, record);
    return record;
  }

  dispose(): void {
    this.disposed = true;
    for (const target of this.ownership.keys()) this.dropOwnership(target);
    this.resumedPlayers.clear();
    this.selector.reset();
    for (const notify of [...this.waiters]) notify();
  }
}
