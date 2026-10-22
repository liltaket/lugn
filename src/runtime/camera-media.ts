import type { CameraDashboardService } from '../application/camera-dashboard.js';
import {
  CameraError,
  CameraDashboardConfigSchema,
  type CameraDashboardConfig,
  type CameraDashboardSnapshot,
  type CameraViewer,
} from '../core/cameras.js';
import { systemClock, type Clock } from '../core/clock.js';

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
    this.unsubscribe = service.subscribe(() => {
      const active = new Set(
        (['bed', 'desk', 'web'] as const)
          .map((viewer) => service.snapshot(viewer).active?.cameraId)
          .filter(Boolean),
      );
      for (const [cameraId, controller] of this.controllers)
        if (!active.has(cameraId)) controller.abort();
      for (const cameraId of this.cache.keys())
        if (!active.has(cameraId)) {
          this.cache.delete(cameraId);
          this.cachedAt.delete(cameraId);
        }
    });
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
    const cached = this.cache.get(cameraId);
    if (
      cached &&
      this.clock.monotonicNow() - (this.cachedAt.get(cameraId) ?? -Infinity) <
        750
    )
      return { ...cached, body: new Uint8Array(cached.body) };
    if ((this.failedUntil.get(cameraId) ?? 0) > this.clock.monotonicNow())
      throw new CameraError(503, 'camera_image_unavailable');
    let pending = this.inFlight.get(cameraId);
    if (!pending) {
      // At most two fixed camera transports; never queue a backlog behind controls.
      if (this.inFlight.size >= 2)
        throw new CameraError(503, 'camera_image_busy');
      pending = this.load(cameraId);
      this.inFlight.set(cameraId, pending);
      void pending
        .finally(() => {
          if (this.inFlight.get(cameraId) === pending)
            this.inFlight.delete(cameraId);
        })
        .catch(() => {});
    }
    const image = await pending;
    this.assertView(viewer, viewId, cameraId);
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
