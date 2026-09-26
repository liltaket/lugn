import type { Clock } from '../core/clock.js';
import type {
  CommandRecord,
  LightingProperty,
  LightingValues,
} from '../core/schemas.js';

let sequence = 0;

export class CommandLedger {
  readonly records: CommandRecord[] = [];

  constructor(
    private readonly clock: Clock,
    private readonly attributionWindowMs = 60_000,
  ) {}

  issue(
    input: Omit<
      CommandRecord,
      'id' | 'issuedAt' | 'status' | 'confirmedProperties'
    >,
  ): CommandRecord {
    const record: CommandRecord = {
      ...input,
      id: `cmd-${++sequence}`,
      issuedAt: this.clock.now(),
      status: 'pending',
      confirmedProperties: [],
    };
    this.records.push(record);
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
      }
    }
  }

  cancelRevision(revision: number, reason: string): void {
    for (const command of this.records) {
      if (command.revision === revision && command.status === 'pending') {
        command.status = 'cancelled';
        command.diagnosticReason = reason;
      }
    }
  }

  cancel(commandId: string, reason: string): boolean {
    const command = this.records.find(
      (candidate) => candidate.id === commandId,
    );
    if (!command || command.status !== 'pending') return false;
    command.status = 'cancelled';
    command.diagnosticReason = reason;
    return true;
  }

  invalidate(commandId: string, reason: string): boolean {
    const command = this.records.find(
      (candidate) => candidate.id === commandId,
    );
    if (!command || command.status !== 'pending') return false;
    command.status = 'invalidated';
    command.diagnosticReason = reason;
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
    return command;
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
