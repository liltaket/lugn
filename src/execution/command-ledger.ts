import { randomUUID } from 'node:crypto';
import type { Clock } from '../core/clock.js';
import type {
  CommandRecord,
  LightingProperty,
  LightingValues,
} from '../core/schemas.js';

export class CommandLedger {
  readonly records: CommandRecord[] = [];
  private readonly idPrefix = `cmd-${randomUUID()}-`;
  private sequence = 0;
  private readonly latestIdByTarget = new Map<string, string>();
  private readonly supersededAtById = new Map<string, number>();

  constructor(
    private readonly clock: Clock,
    private readonly attributionWindowMs = 60_000,
    private readonly terminalHistoryLimit = 256,
  ) {
    if (!Number.isSafeInteger(terminalHistoryLimit) || terminalHistoryLimit < 1)
      throw new Error('terminalHistoryLimit must be a positive safe integer');
  }

  /** IDs are opaque and belong to this ledger instance, including retired records. */
  isKnownCommandId(commandId: string): boolean {
    if (!commandId.startsWith(this.idPrefix)) return false;
    const suffix = commandId.slice(this.idPrefix.length);
    const sequence = Number(suffix);
    return (
      Number.isSafeInteger(sequence) &&
      sequence > 0 &&
      sequence <= this.sequence &&
      String(sequence) === suffix
    );
  }

  latestCommandId(target: string): string | undefined {
    return this.latestIdByTarget.get(target);
  }

  /** Keep every pending record and the newest terminal records in issue order. */
  pruneTerminalRecords(): boolean {
    let retainedTerminal = 0;
    const retained = this.records.filter(
      (record) => record.status === 'pending',
    );
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      const record = this.records[index]!;
      if (
        record.status !== 'pending' &&
        retainedTerminal < this.terminalHistoryLimit
      ) {
        retained.push(record);
        retainedTerminal += 1;
      }
    }
    if (retained.length === this.records.length) return false;
    const keep = new Set(retained);
    const ordered = this.records.filter((record) => keep.has(record));
    this.records.splice(0, this.records.length, ...ordered);
    const retainedIds = new Set(ordered.map((record) => record.id));
    for (const commandId of this.supersededAtById.keys())
      if (!retainedIds.has(commandId)) this.supersededAtById.delete(commandId);
    return true;
  }

  issue(
    input: Omit<
      CommandRecord,
      'id' | 'issuedAt' | 'status' | 'confirmedProperties'
    >,
  ): CommandRecord {
    const record: CommandRecord = {
      ...input,
      id: `${this.idPrefix}${++this.sequence}`,
      issuedAt: this.clock.now(),
      status: 'pending',
      confirmedProperties: [],
    };
    this.records.push(record);
    this.latestIdByTarget.set(record.target, record.id);
    this.pruneTerminalRecords();
    return record;
  }

  supersedePending(reason: string, target?: string): void {
    for (const command of this.records) {
      if (
        command.status === 'pending' &&
        (target === undefined || command.target === target)
      ) {
        command.status = 'superseded';
        command.diagnosticReason = reason;
        this.supersededAtById.set(command.id, this.clock.now());
      }
    }
    this.pruneTerminalRecords();
  }

  cancelRevision(revision: number, reason: string): void {
    for (const command of this.records) {
      if (command.revision === revision && command.status === 'pending') {
        command.status = 'cancelled';
        command.diagnosticReason = reason;
      }
    }
    this.pruneTerminalRecords();
  }

  cancel(commandId: string, reason: string): boolean {
    const command = this.records.find(
      (candidate) => candidate.id === commandId,
    );
    if (!command || command.status !== 'pending') return false;
    command.status = 'cancelled';
    command.diagnosticReason = reason;
    this.pruneTerminalRecords();
    return true;
  }

  invalidate(commandId: string, reason: string): boolean {
    const command = this.records.find(
      (candidate) => candidate.id === commandId,
    );
    if (!command || command.status !== 'pending') return false;
    command.status = 'invalidated';
    command.diagnosticReason = reason;
    this.pruneTerminalRecords();
    return true;
  }

  attributeObservation(
    target: string,
    property: LightingProperty,
    value: LightingValues[LightingProperty],
    now: number,
    commandId?: string,
  ): CommandRecord | undefined {
    const command = commandId
      ? this.records.find((candidate) => candidate.id === commandId)
      : [...this.records]
          .reverse()
          .find(
            (candidate) =>
              candidate.target === target &&
              candidate.status === 'pending' &&
              now - candidate.issuedAt <= this.attributionWindowMs &&
              candidate.desired[property] === value,
          );
    if (
      !command ||
      command.target !== target ||
      command.desired[property] !== value
    )
      return undefined;
    if (command.status !== 'pending') return command;
    if (!command.confirmedProperties.includes(property))
      command.confirmedProperties.push(property);
    const keys = Object.keys(command.desired) as LightingProperty[];
    if (keys.every((key) => command.confirmedProperties.includes(key))) {
      command.status = 'confirmed';
      command.confirmedAt = now;
      command.diagnosticReason = 'All requested properties observed';
    }
    this.pruneTerminalRecords();
    return command;
  }

  /**
   * HA state_changed events do not carry Lugn command IDs. During a rapid
   * intent change, a delayed old value can therefore be mistaken for a manual
   * override. This bounded lookup lets the engine recognize a recent,
   * superseded command without attributing ordinary settled-state changes to
   * the command ledger.
   */
  recentSupersededMatch(
    target: string,
    property: LightingProperty,
    value: LightingValues[LightingProperty],
    now: number,
  ): CommandRecord | undefined {
    const windowMs = Math.min(this.attributionWindowMs, 10_000);
    return [...this.records]
      .reverse()
      .find(
        (command) =>
          command.status === 'superseded' &&
          command.target === target &&
          command.desired[property] === value &&
          this.supersededAtById.has(command.id) &&
          this.supersededAtById.get(command.id)! <= now &&
          now - this.supersededAtById.get(command.id)! <= windowMs,
      );
  }

  latestPending(
    target: string,
    property: LightingProperty,
    value: LightingValues[LightingProperty],
  ): CommandRecord | undefined {
    return [...this.records]
      .reverse()
      .find(
        (command) =>
          command.status === 'pending' &&
          command.target === target &&
          command.desired[property] === value,
      );
  }
}
