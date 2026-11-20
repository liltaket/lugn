import type {
  GoveeControlCapabilities,
  GoveeControlDelivery,
  GoveeControlRequest,
  GoveeWriteGuard,
} from './govee-control-server.js';

/** Device writers only: the engine has already granted the scene generation. */
export type GoveePresetControls = {
  capabilities(): GoveeControlCapabilities;
  apply(
    command: GoveeControlRequest,
    guard: GoveeWriteGuard,
  ): Promise<GoveeControlDelivery>;
};

/** LAN effects can complement official-API zones on the same physical fixture. */
export function combineGoveePresetControls(
  local: GoveePresetControls,
  platform?: GoveePresetControls,
): GoveePresetControls {
  return {
    capabilities() {
      const result = { ...local.capabilities() };
      for (const [target, capability] of Object.entries(
        platform?.capabilities() ?? {},
      )) {
        const lan = result[target];
        result[target] = {
          effects: lan?.effects.length ? lan.effects : capability.effects,
          zones: Boolean(lan?.zones || capability.zones),
          ...(capability.staticColor ? { staticColor: true } : {}),
          ...((capability.colorTemperature ?? lan?.colorTemperature)
            ? {
                colorTemperature:
                  capability.colorTemperature ?? lan!.colorTemperature!,
              }
            : {}),
        };
      }
      return result;
    },
    async apply(command, guard) {
      const lan = local.capabilities()[command.target];
      const cloud = platform?.capabilities()[command.target];
      if (command.staticColor) {
        // White/RGB and its zone mask are one ordered cloud sequence.
        if (!platform || !cloud?.staticColor || (command.zones && !cloud.zones))
          throw new Error('Govee static color unavailable');
        await guard();
        return platform.apply(command, guard);
      }
      let effect: GoveeControlDelivery | undefined;
      let zones: GoveeControlDelivery | undefined;
      if (command.effect !== undefined) {
        await guard();
        const source = lan?.effects.includes(command.effect) ? local : platform;
        if (!source) throw new Error('Govee effect unavailable');
        effect = await source.apply(
          {
            requestId: command.requestId,
            target: command.target,
            controlId: command.controlId,
            effect: command.effect,
            ...(command.modeOnly ? { modeOnly: true as const } : {}),
          },
          guard,
        );
      }
      if (command.zones !== undefined) {
        await guard();
        const source = lan?.zones ? local : cloud?.zones ? platform : undefined;
        if (!source) throw new Error('Govee zones unavailable');
        zones = await source.apply(
          {
            requestId: command.requestId,
            target: command.target,
            controlId: command.controlId,
            zones: command.zones,
            ...(command.zoneOrder ? { zoneOrder: command.zoneOrder } : {}),
            ...(command.modeOnly ? { modeOnly: true as const } : {}),
          },
          guard,
        );
      }
      await guard();
      const transports = new Set(
        [effect?.transport, zones?.transport].filter(Boolean),
      );
      return {
        transport:
          transports.size > 1
            ? 'mixed'
            : (effect?.transport ?? zones?.transport ?? 'lan'),
        ...(effect?.effect ? { effect: effect.effect } : {}),
        ...(zones?.zones ? { zones: zones.zones } : {}),
      };
    },
  };
}
