/**
 * @file src/rendering/GeometryBuilder.ts
 * @brief Queue mesh builds and reuse recently built meshes.
 * @author Norman
 * @description Uses a worker when available and schedules builds on the main thread otherwise.
 */

import { buildGeometry, type MeshData } from "./geometry.js";
import type { GeoFeature, Position } from "../geo/types.js";
import { isValidatedFeature } from "../geo/validation.js";

export interface BuildRequest {
  id: number;
  features: GeoFeature[];
  origin: Position;
  keys: [string, number][];
  detail: 0 | 1;
}
interface BuildResult {
  data: MeshData;
  buildMs: number;
}
interface PendingBuild {
  id: number;
  request: Omit<BuildRequest, "id">;
  cacheKey: string;
  resolve: (value: BuildResult) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  cleanup(): void;
  cancelled?: boolean;
}
interface CachedBuild {
  result: BuildResult;
  featureKeys: Map<string, number>;
  bytes: number;
}
export type BuildResponse =
  | ({ id: number } & BuildResult)
  | { id: number; error: string };
export interface GeometryWorker {
  postMessage(value: BuildRequest): void;
  onmessage: ((event: MessageEvent<BuildResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  terminate(): void;
}
/** Run one build at a time with room for one more in the queue. Drop the least recently used buffers when the cache fills up. */
export class GeometryBuilder {
  private serial = 0;
  private disposed = false;
  private jobs = new Map<number, PendingBuild>();
  private active?: PendingBuild;
  private cache = new Map<string, CachedBuild>();
  private cacheSize = 0;
  private signatures = new WeakMap<GeoFeature, string>();
  constructor(private worker: GeometryWorker | null, private cacheLimit = 16 * 1024 * 1024) {
    if (worker) {
      worker.onmessage = ({ data }) => {
        const job = this.active;
        if (!job || job.id !== data.id) return;
        this.complete(job, data);
      };
      worker.onerror = () => {
        worker.terminate();
        this.worker = null;
        this.active = undefined;
        for (const job of this.jobs.values()) {
          job.cleanup();
          job.reject(
            new Error(
              "Geometry worker failed; retrying with reduced main-thread scheduling.",
            ),
          );
        }
        this.jobs.clear();
      };
    }
  }
  get pending() {
    // A cancelled build still counts until the worker sends its result.
    return this.jobs.size + (this.active && !this.jobs.has(this.active.id) ? 1 : 0);
  }
  get cachedBytes() { return this.cacheSize; }
  setCacheLimit(bytes: number) {
    this.cacheLimit = Math.max(0, bytes);
    this.trimCache();
  }
  get mode() {
    return this.worker
      ? ("worker" as const)
      : ("main-thread fallback" as const);
  }
  build(request: Omit<BuildRequest, "id">, signal?: AbortSignal) {
    if (this.disposed)
      return Promise.reject(new Error("Geometry builder disposed."));
    if (signal?.aborted) return Promise.reject(new DOMException("Geometry build cancelled.", "AbortError"));
    const cacheKey = JSON.stringify([request.origin, request.detail, request.features.map((feature) => {
      let signature = this.signatures.get(feature);
      if (signature === undefined) {
        signature = JSON.stringify(feature);
        if (isValidatedFeature(feature)) this.signatures.set(feature, signature);
      }
      return signature;
    })]);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      const featureKeys = new Map(request.keys), remap = new Map<number, number>();
      let compatible = true;
      for (const [id, key] of cached.featureKeys) {
        const next = featureKeys.get(id);
        if (next === undefined || (remap.has(key) && remap.get(key) !== next)) {
          compatible = false;
          break;
        }
        remap.set(key, next);
      }
      if (compatible) {
        // The scene can reuse selection keys after it unloads provider cells.
        // Keep the cached positions and update the vertex keys to match the current features.
        if ([...remap].some(([old, next]) => old !== next)) {
          const keys = cached.result.data.keys.map((key) => remap.get(key) ?? key);
          cached.result = { data: { ...cached.result.data, keys }, buildMs: 0 };
          cached.featureKeys = featureKeys;
        }
        this.cache.delete(cacheKey);
        this.cache.set(cacheKey, cached);
        return Promise.resolve({ ...cached.result, buildMs: 0 });
      }
    }
    if (this.pending >= 2)
      return Promise.reject(new Error("Geometry queue is full."));
    const id = ++this.serial;
    return new Promise<BuildResult>((resolve, reject) => {
      const abort = () => this.cancel(job);
      // Copy inputs that might change before the build starts.
      // Frozen SceneStore features are safe to share.
      const snapshot: PendingBuild["request"] = {
        ...request, origin: [...request.origin], keys: request.keys.map(([id, key]) => [id, key]),
        features: request.features.map(f => isValidatedFeature(f) ? f : structuredClone(f)),
      };
      const job: PendingBuild = { id, request: snapshot, cacheKey, resolve, reject,
        cleanup: () => signal?.removeEventListener("abort", abort) };
      this.jobs.set(id, job);
      signal?.addEventListener("abort", abort, { once: true });
      this.pump();
    });
  }
  private cancel(job: PendingBuild) {
    if (!this.jobs.delete(job.id)) return;
    job.cancelled = true;
    job.cleanup();
    job.reject(new DOMException("Geometry build cancelled.", "AbortError"));
    if (job.timer !== undefined) {
      clearTimeout(job.timer);
      if (this.active === job) this.active = undefined;
    }
    this.pump();
  }
  private pump() {
    if (this.disposed || this.active) return;
    const job = this.jobs.values().next().value as PendingBuild | undefined;
    if (!job) return;
    this.active = job;
    if (this.worker) {
      try { this.worker.postMessage({ ...job.request, id: job.id }); }
      catch (error) { this.complete(job, { id: job.id, error: String(error) }); }
    } else {
      // On the main thread, the timer gives other work a turn and lets us cancel a build before it starts.
      job.timer = setTimeout(() => {
        const start = performance.now(), request = job.request, keys = new Map(request.keys);
        try {
          const data = buildGeometry(request.features, request.origin, (key) => keys.get(key)!, request.detail);
          this.complete(job, { id: job.id, data, buildMs: performance.now() - start });
        } catch (error) { this.complete(job, { id: job.id, error: String(error) }); }
      }, 0);
    }
  }
  private complete(job: PendingBuild, result: BuildResponse) {
    this.active = undefined;
    this.jobs.delete(job.id);
    job.cleanup();
    if (!job.cancelled && !this.disposed) {
      if ("error" in result) job.reject(new Error(result.error));
      else {
        this.remember(job, result);
        job.resolve(result);
      }
    }
    this.pump();
  }
  private remember(job: PendingBuild, result: BuildResult) {
    const { data } = result;
    const bytes = data.positions.byteLength + data.colors.byteLength + data.keys.byteLength +
      (data.surface?.byteLength ?? 0) + data.indices.byteLength + data.faceIds.length * 8 +
      [...new Set(data.faceIds)].reduce((sum, id) => sum + id.length * 2, 0) +
      job.cacheKey.length * 2 + job.request.keys.reduce((sum, [id]) => sum + id.length * 2 + 16, 0);
    const previous = this.cache.get(job.cacheKey);
    if (previous) { this.cacheSize -= previous.bytes; this.cache.delete(job.cacheKey); }
    if (bytes > this.cacheLimit) return;
    this.cache.set(job.cacheKey, { result, featureKeys: new Map(job.request.keys), bytes });
    this.cacheSize += bytes;
    this.trimCache();
  }
  private trimCache() {
    while (this.cache.size > 32 || this.cacheSize > this.cacheLimit) {
      const oldest = this.cache.entries().next().value!;
      this.cache.delete(oldest[0]);
      this.cacheSize -= oldest[1].bytes;
    }
  }
  dispose() {
    this.disposed = true;
    this.worker?.terminate();
    for (const job of this.jobs.values()) {
      clearTimeout(job.timer);
      job.cleanup();
      job.reject(new Error("Geometry builder disposed."));
    }
    this.jobs.clear();
    this.active = undefined;
    this.cache.clear();
    this.cacheSize = 0;
    this.signatures = new WeakMap();
  }
}
