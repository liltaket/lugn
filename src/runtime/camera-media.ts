import type { CameraDashboardService } from '../application/camera-dashboard.js';
import {
  CameraError,
  CameraDashboardConfigSchema,
  type CameraDashboardConfig,
  type CameraGridLease,
  type CameraDashboardSnapshot,
  type CameraViewer,
} from '../core/cameras.js';
import { systemClock, type Clock } from '../core/clock.js';

/** Upstream fetches at once: for single views, and for an open grid. */
const SINGLE_FETCHES = 2;
const GRID_FETCHES = 6;
/** How long a camera's frame is reused for the screens looking at it. */
const SINGLE_CACHE_MS = 750;
/** Shorter than the page's 0.8 s focus interval, or every other frame it asks
 * for would be the one it already has. */
const GRID_CACHE_MS = 600;

export type CameraImage = {
  body: Uint8Array;
  contentType: 'image/jpeg';
  observedAt: number;
};
/** Fixed HA image endpoints only. Never accepts an upstream URL from the browser. */
export class CameraMediaProvider {
  private readonly entities: Map<string, string>;
  private readonly base: string;
  private readonly cache = new Map<string, CameraImage>();
  private readonly cachedAt = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<CameraImage>>();
  /** Who started each fetch, so a grid cannot crowd out a single view. */
  private readonly inFlightGrid = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly failedUntil = new Map<string, number>();
  private readonly unsubscribe: () => void;
  private disposed = false;
  constructor(
    private readonly service: CameraDashboardService,
    config: CameraDashboardConfig,
    baseUrl: string,
    private readonly token: string,
    private readonly transport: typeof fetch = fetch,
    private readonly clock: Clock = systemClock,
  ) {
    const url = new URL(baseUrl);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error('Camera images require a fixed HA base URL');
    this.base = baseUrl.replace(/\/+$/, '');
    this.entities = new Map(
      CameraDashboardConfigSchema.parse(config).cameras.map((camera) => [
        camera.id,
        camera.entityId,
      ]),
    );
    this.unsubscribe = service.subscribe(() => this.prune());
  }
  snapshot(viewer: CameraViewer, prefix: string): CameraDashboardSnapshot {
    if (!/^\/(?!\/)[A-Za-z0-9_/-]+\/$/.test(prefix))
      throw new Error('Invalid camera route');
    const snapshot = this.service.snapshot(viewer);
    if (snapshot.active)
      snapshot.active.imageUrl = `${prefix}${snapshot.active.id}/${snapshot.active.cameraId}/image`;
    return snapshot;
  }
  subscribe(listener: () => void): () => void {
    return this.service.subscribe(listener);
  }
  async read(
    viewer: CameraViewer,
    viewId: string,
    cameraId: string,
  ): Promise<CameraImage> {
    this.assertView(viewer, viewId, cameraId);
    return this.frame(viewer, viewId, cameraId, false);
  }
  /** Opens or renews a screen's camera grid; see CameraDashboardService.openGrid. */
  openGrid(viewer: CameraViewer, prefix: string): CameraGridLease {
    if (!/^\/(?!\/)[A-Za-z0-9_/-]+\/$/.test(prefix))
      throw new Error('Invalid camera route');
    const lease = this.service.openGrid(viewer);
    return {
      expiresAt: lease.expiresAt,
      cameras: lease.cameras.map((camera) => ({
        ...camera,
        imageUrl: `${prefix}${camera.id}/image`,
      })),
    };
  }
  closeGrid(viewer: CameraViewer): void {
    this.service.closeGrid(viewer);
    this.prune();
  }
  /** Drops what no active view or open grid wants any more. */
  private prune(): void {
    const active = new Set(
      (['bed', 'desk', 'web'] as const)
        .map((viewer) => this.service.snapshot(viewer).active?.cameraId)
        .filter(Boolean),
    );
    // Cameras of an open grid are wanted too.
    for (const cameraId of this.service.gridCameraIds()) active.add(cameraId);
    for (const [cameraId, controller] of this.controllers)
      if (!active.has(cameraId)) controller.abort();
    for (const cameraId of this.cache.keys())
      if (!active.has(cameraId)) {
        this.cache.delete(cameraId);
        this.cachedAt.delete(cameraId);
      }
  }
  /** The next frame of one camera of an open grid. */
  async readGrid(viewer: CameraViewer, cameraId: string): Promise<CameraImage> {
    if (
      !this.entities.has(cameraId) ||
      !this.service.gridAllows(viewer, cameraId)
    )
      throw new CameraError(404, 'camera_view_unavailable');
    return this.frame(viewer, undefined, cameraId, true);
  }
  private async frame(
    viewer: CameraViewer,
    viewId: string | undefined,
    cameraId: string,
    grid: boolean,
  ): Promise<CameraImage> {
    const cached = this.cache.get(cameraId);
    if (
      cached &&
      this.clock.monotonicNow() - (this.cachedAt.get(cameraId) ?? -Infinity) <
        (grid ? GRID_CACHE_MS : SINGLE_CACHE_MS)
    )
      return { ...cached, body: new Uint8Array(cached.body) };
    if ((this.failedUntil.get(cameraId) ?? 0) > this.clock.monotonicNow())
      throw new CameraError(503, 'camera_image_unavailable');
    let pending = this.inFlight.get(cameraId);
    if (!pending) {
      // A few fixed camera transports; never queue a backlog behind controls.
      // A single view keeps to two; an open grid asks for several cameras at
      // once, one fetch each.
      const running = grid
        ? this.inFlightGrid.size
        : this.inFlight.size - this.inFlightGrid.size;
      if (running >= (grid ? GRID_FETCHES : SINGLE_FETCHES))
        throw new CameraError(503, 'camera_image_busy');
      if (grid) this.inFlightGrid.add(cameraId);
      pending = this.load(cameraId);
      this.inFlight.set(cameraId, pending);
      void pending
        .finally(() => {
          if (this.inFlight.get(cameraId) === pending) {
            this.inFlight.delete(cameraId);
            this.inFlightGrid.delete(cameraId);
          }
        })
        .catch(() => {});
    }
    const image = await pending;
    if (grid) {
      if (!this.service.gridAllows(viewer, cameraId))
        throw new CameraError(404, 'camera_view_unavailable');
    } else this.assertView(viewer, viewId!, cameraId);
    return { ...image, body: new Uint8Array(image.body) };
  }
  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    for (const controller of this.controllers.values()) controller.abort();
    this.cache.clear();
    this.cachedAt.clear();
    this.failedUntil.clear();
  }
  private assertView(
    viewer: CameraViewer,
    viewId: string,
    cameraId: string,
  ): void {
    const active = this.service.snapshot(viewer).active;
    if (
      this.disposed ||
      !this.entities.has(cameraId) ||
      active?.id !== viewId ||
      active.cameraId !== cameraId
    )
      throw new CameraError(404, 'camera_view_unavailable');
  }
  private async load(cameraId: string): Promise<CameraImage> {
    const controller = new AbortController();
    this.controllers.set(cameraId, controller);
    const timeout = this.clock.setTimeout(() => controller.abort(), 4_000);
    let rejectAbort: (() => void) | undefined;
    try {
      const aborted = new Promise<never>((_, reject) => {
        rejectAbort = () =>
          reject(new CameraError(503, 'camera_image_unavailable'));
        controller.signal.addEventListener('abort', rejectAbort, {
          once: true,
        });
      });
      const fetchImage = async (): Promise<CameraImage> => {
        const response = await this.transport(
          `${this.base}/api/camera_proxy/${this.entities.get(cameraId)}?width=640&height=360`,
          {
            method: 'GET',
            redirect: 'manual',
            signal: controller.signal,
            headers: {
              Authorization: `Bearer ${this.token}`,
              Accept: 'image/jpeg',
            },
          },
        );
        try {
          if (
            response.status !== 200 ||
            response.redirected ||
            response.headers
              .get('content-type')
              ?.split(';')[0]
              ?.trim()
              .toLowerCase() !== 'image/jpeg' ||
            !response.body
          )
            throw new Error('Camera image unavailable');
          const length = response.headers.get('content-length');
          if (
            length !== null &&
            (!/^\d+$/.test(length) || Number(length) > 1024 * 1024)
          )
            throw new Error('Camera image too large');
          const reader = response.body.getReader();
          const cancelReader = () => {
            void reader.cancel().catch(() => {});
          };
          controller.signal.addEventListener('abort', cancelReader, {
            once: true,
          });
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              bytes += value.byteLength;
              if (bytes > 1024 * 1024)
                throw new Error('Camera image too large');
              chunks.push(value);
            }
          } finally {
            controller.signal.removeEventListener('abort', cancelReader);
            void reader.cancel().catch(() => {});
            reader.releaseLock();
          }
          const body = Buffer.concat(chunks, bytes);
          if (body[0] !== 255 || body[1] !== 216 || body[2] !== 255)
            throw new Error('Invalid JPEG');
          return {
            body,
            contentType: 'image/jpeg',
            observedAt: this.clock.now(),
          };
        } finally {
          if (!response.body?.locked)
            void response.body?.cancel().catch(() => {});
        }
      };
      const image = await Promise.race([fetchImage(), aborted]);
      if (controller.signal.aborted || this.disposed)
        throw new CameraError(503, 'camera_image_unavailable');
      this.cache.set(cameraId, image);
      this.cachedAt.set(cameraId, this.clock.monotonicNow());
      // The configured allowlist bounds entries; additionally retain <=4MiB.
      while (
        [...this.cache.values()].reduce(
          (n, item) => n + item.body.byteLength,
          0,
        ) >
        4 * 1024 * 1024
      ) {
        const oldest = this.cache.keys().next().value!;
        this.cache.delete(oldest);
        this.cachedAt.delete(oldest);
      }
      return image;
    } catch {
      this.failedUntil.set(cameraId, this.clock.monotonicNow() + 1_000);
      throw new CameraError(503, 'camera_image_unavailable');
    } finally {
      this.clock.clearTimeout(timeout);
      if (rejectAbort)
        controller.signal.removeEventListener('abort', rejectAbort);
      controller.abort();
      if (this.controllers.get(cameraId) === controller)
        this.controllers.delete(cameraId);
    }
  }
}
