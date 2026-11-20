import { createHash, randomBytes } from 'node:crypto';
import type {
  HomeAssistantPrinterAdapter,
  PrinterActivitySnapshot,
} from '../adapters/home-assistant-printer.js';
import type { ArtworkAsset } from '../core/artwork.js';

export type PrinterActivityPayload = Omit<
  PrinterActivitySnapshot,
  'coverRevision'
> & { imageUrl: string | null };

export interface PrinterActivityProvider {
  /** Null while the printer has nothing worth showing. Never awaits I/O. */
  snapshot(imageBasePath: string): PrinterActivityPayload | null;
  readCover(token: string): Promise<ArtworkAsset | null>;
  subscribe(listener: () => void): () => void;
}

const MAX_COVER_BYTES = 2 * 1024 * 1024;

/**
 * Serves the print as a Hub live activity. The cover image is fetched from the
 * fixed Home Assistant image proxy with the server token, so no HA credential
 * or upstream URL ever reaches a browser. One image is cached per revision.
 */
export class PrinterActivityService implements PrinterActivityProvider {
  private readonly secret = randomBytes(16);
  private cached: { token: string; asset: ArtworkAsset } | null = null;
  private pending: {
    token: string;
    promise: Promise<ArtworkAsset | null>;
  } | null = null;

  constructor(
    private readonly adapter: HomeAssistantPrinterAdapter,
    private readonly options: {
      baseUrl: string;
      token: string;
      timeoutMs?: number;
    },
    private readonly transport: typeof fetch = fetch,
  ) {}

  subscribe(listener: () => void): () => void {
    return this.adapter.subscribe(listener);
  }

  snapshot(imageBasePath: string): PrinterActivityPayload | null {
    const activity = this.adapter.activity();
    if (!activity) return null;
    const { coverRevision, ...rest } = activity;
    const token = coverRevision ? this.tokenFor(coverRevision) : null;
    return {
      ...rest,
      imageUrl: token ? `${imageBasePath}${token}` : null,
    };
  }

  async readCover(token: string): Promise<ArtworkAsset | null> {
    const revision = this.adapter.snapshot().coverRevision;
    if (!revision || this.tokenFor(revision) !== token) return null;
    if (this.cached?.token === token) return this.cached.asset;
    if (this.pending?.token !== token) {
      const promise = this.fetchCover().then(
        (asset) => {
          if (asset) this.cached = { token, asset };
          return asset;
        },
        () => null,
      );
      this.pending = { token, promise };
      void promise.finally(() => {
        if (this.pending?.promise === promise) this.pending = null;
      });
    }
    return this.pending.promise;
  }

  private tokenFor(revision: string): string {
    return createHash('sha256')
      .update(this.secret)
      .update(revision)
      .digest('base64url')
      .slice(0, 32);
  }

  private async fetchCover(): Promise<ArtworkAsset | null> {
    const response = await this.transport(
      `${this.options.baseUrl}/api/image_proxy/${this.adapter.coverEntityId}`,
      {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 5_000),
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          Accept: 'image/png, image/jpeg, image/webp',
        },
      },
    );
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => {});
      return null;
    }
    const length = Number(response.headers.get('content-length') ?? '0');
    if (length > MAX_COVER_BYTES) {
      void response.body?.cancel().catch(() => {});
      return null;
    }
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength === 0 || body.byteLength > MAX_COVER_BYTES) return null;
    // ha-bambulab labels its PNG cover image/jpeg, so the bytes decide.
    const contentType = sniffImageType(body);
    return contentType ? { body, contentType } : null;
  }
}

export function sniffImageType(
  body: Uint8Array,
): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  const b = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (
    b.subarray(0, 4).toString('ascii') === 'RIFF' &&
    b.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'image/webp';
  return null;
}
