import type { RoomState } from './schemas.js';

export type Artwork = {
  url: string | null;
  status: 'available' | 'missing' | 'unavailable';
  source: 'home_assistant' | null;
};
export type ArtworkMap = Record<string, Artwork>;
/** Server-only metadata: image tokens/content URLs must never enter RoomState. */
export type HomeAssistantArtworkMetadata = {
  /** Changes only when identity/location metadata changes, including A → B → A. */
  generation: number;
  source: string | null;
  title: string | null;
  artist: string | null;
  album: string | null;
  mediaContentId: string | null;
  entityPicture: string | null;
};
export type ArtworkAsset = {
  body: Uint8Array;
  contentType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
};

/** Optional presentation service. Snapshots never await image I/O. */
export interface ArtworkProvider {
  /** Prefix is a trusted same-origin route, including its trailing slash. */
  snapshot(state: RoomState, pathPrefix: string): ArtworkMap;
  /** Only previously issued tokens for the current track can resolve. */
  read(token: string, state: RoomState): Promise<ArtworkAsset | null>;
  subscribe?(listener: () => void): () => void;
}
