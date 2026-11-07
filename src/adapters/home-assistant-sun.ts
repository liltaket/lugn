/** Reads sun elevation from Home Assistant's built-in sun entity. */
export class HomeAssistantSunAdapter {
  private lastUpdated = 0;
  constructor(private readonly onElevation: (elevation: number) => void) {}

  acceptState(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const state = value as Record<string, unknown>;
    if (
      state['entity_id'] !== 'sun.sun' ||
      state['state'] === 'unavailable' ||
      state['state'] === 'unknown'
    )
      return;
    const attributes = state['attributes'];
    if (!attributes || typeof attributes !== 'object') return;
    const elevation = (attributes as Record<string, unknown>)['elevation'];
    if (typeof elevation !== 'number' || !Number.isFinite(elevation)) return;
    const updated =
      typeof state['last_updated'] === 'string'
        ? Date.parse(state['last_updated'])
        : NaN;
    if (Number.isFinite(updated) && updated < this.lastUpdated) return;
    if (Number.isFinite(updated)) this.lastUpdated = updated;
    this.onElevation(elevation);
  }

  acceptEvent(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const envelope = value as Record<string, unknown>;
    const event = (envelope['event'] ?? envelope) as Record<string, unknown>;
    if (
      event['event_type'] !== 'state_changed' ||
      !event['data'] ||
      typeof event['data'] !== 'object'
    )
      return;
    const data = event['data'] as Record<string, unknown>;
    if (data['entity_id'] === 'sun.sun') this.acceptState(data['new_state']);
  }
}
