import type { Clock } from '../core/clock.js';
import { isHumanActor } from '../core/automation-holds.js';
import type { IntelligenceSettingsRepository } from '../core/intelligence.js';
import { ComputerIntelligence } from '../application/computer-intelligence.js';
import type { ComputerAudioRoute } from '../application/computer-now-playing.js';
import type { LugnEngine } from '../application/lugn-engine.js';
import type { CapabilityRegistry } from '../application/capabilities.js';

export type ComputerIntelligenceRuntimeOptions = {
  clock: Clock;
  engine: LugnEngine;
  capabilities: CapabilityRegistry;
  settingsStore: IntelligenceSettingsRepository;
  computerDeviceIds: readonly string[];
  computerAudio: Readonly<Record<string, ComputerAudioRoute>>;
  observationTrusted: (target: string) => boolean;
};

/** Composes advisory context with the existing authoritative engine and observation trust. */
export function createComputerIntelligenceRuntime(
  options: ComputerIntelligenceRuntimeOptions,
): {
  service: ComputerIntelligence;
  dispose(): void;
} {
  const { clock, engine, settingsStore } = options;
  const manualMusicUntil = new Map<string, number>();
  const timeFormat = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Stockholm',
    hour: '2-digit',
    hourCycle: 'h23',
  });
  const service = new ComputerIntelligence({
    clock,
    settingsStore,
    computerDeviceIds: options.computerDeviceIds,
    computerAudio: options.computerAudio,
    capabilities: options.capabilities,
    getState: () => engine.state,
    availableSceneIds: () => [...engine.scenes.keys()],
    sceneName: (id) => engine.scenes.get(id)?.name ?? 'ditt valda ljusläge',
    getTrust: (deviceId, target) => {
      const computer = engine.state.computer.devices[deviceId];
      const policy = target
        ? engine.getMusicPlaybackPolicySnapshots()[target]
        : undefined;
      const hour = Number(timeFormat.format(clock.now()));
      const quietHours = policy?.quietHours ?? (hour < 6 || hour >= 23);
      const manualPause = !!policy?.manualPause;
      return {
        computerTrusted:
          computer?.availability === 'online' &&
          computer.freshness === 'fresh' &&
          computer.reason === 'live',
        receiverTrusted: target !== null && options.observationTrusted(target),
        playbackAllowed:
          target !== null && engine.automaticMusicPlaybackAllowed(target),
        quietHours,
        manualPause,
        manualSourceHold:
          target !== null &&
          clock.monotonicNow() < (manualMusicUntil.get(target) ?? 0),
      };
    },
  });
  const unsubscribeState = engine.stream.subscribe(() => service.observe());
  const unsubscribeInterventions = engine.subscribeInterventions((event) => {
    if (event.domain === 'music') {
      const until =
        clock.monotonicNow() +
        settingsStore.snapshot().settings.optical.cooldownMs;
      for (const target of event.target
        ? [event.target]
        : Object.keys(engine.state.music.devices))
        manualMusicUntil.set(target, until);
    }
    // Explicit choices consume existing prompts for that context. The service keeps
    // dismissal attached to the desktop activity session, rather than a timer alone.
    for (const suggestion of service.snapshot().suggestions) {
      if (
        (event.domain === 'lighting' && suggestion.kind === 'scene') ||
        (event.domain === 'music' && suggestion.kind === 'optical')
      )
        void service
          .respondSuggestion(suggestion.id, 'dismiss')
          .catch(() => undefined);
    }
  });
  // Preserve a recent manual music choice already recorded before composition.
  for (const command of engine.state.music.commands) {
    if (isHumanActor(command.provenance.actor)) {
      const remaining =
        settingsStore.snapshot().settings.optical.cooldownMs -
        (clock.now() - command.issuedAt);
      if (remaining > 0)
        manualMusicUntil.set(command.target, clock.monotonicNow() + remaining);
    }
  }
  return {
    service,
    dispose() {
      unsubscribeState();
      unsubscribeInterventions();
      service.dispose();
    },
  };
}
