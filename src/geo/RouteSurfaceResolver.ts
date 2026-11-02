/** @file geo/RouteSurfaceResolver.ts @brief Match routes to roads in a worker when one is available. @author Norman */
import { RoadSurfaceIndex } from "./routeSurface.js";
import type { GeoFeature, Position, RouteData } from "./types.js";
export interface SurfaceRequest { id: number; revision: number; origin: Position; roads?: readonly GeoFeature[]; route: RouteData }
export type SurfaceResponse = { id: number; route: RouteData } | { id: number; error: string };
export interface SurfaceWorker {
  postMessage(message: SurfaceRequest): void;
  onmessage: ((event: MessageEvent<SurfaceResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  terminate(): void;
}
const createWorker = (): SurfaceWorker | null => {
  try { return typeof Worker === "undefined" ? null : new Worker(new URL("./routeSurface.worker.js", import.meta.url), { type: "module" }); }
  catch { return null; }
};
/** Match against the roads the host displays. While one job runs, keep only the newest waiting request. */
export class RouteSurfaceResolver {
  private roads: readonly GeoFeature[] = [];
  private origin: Position = [0, 0];
  private revision = 0;
  private sentRevision = -1;
  private serial = 0;
  private active = 0;
  private disposed = false;
  private queued?: { id: number; route: RouteData; result: (route: RouteData) => void };
  private deliver?: (route: RouteData) => void;
  private activeRoute?: RouteData;
  private timeout?: ReturnType<typeof setTimeout>;
  constructor(private worker: SurfaceWorker | null = createWorker()) {
    if (worker) {
      worker.onmessage = ({ data }) => {
        if (data.id !== this.active || this.disposed) return;
        clearTimeout(this.timeout);
        const deliver = this.deliver;
        const original = this.activeRoute;
        this.active = 0; this.deliver = undefined; this.activeRoute = undefined;
        if (data.id === this.serial && original) deliver?.("route" in data ? data.route : unresolved(original));
        this.pump();
      };
      worker.onerror = () => this.stopWorker();
    }
  }
  setRoads(roads: readonly GeoFeature[], origin: Position) {
    if (this.disposed) return;
    // Skip provider metadata when copying roads to the worker. Matching uses geometry, model settings and style.
    this.roads = roads.filter(f => f.model?.kind === "road" && f.layer === "roads")
      .map(f => ({ ...f, properties: {} }));
    this.origin = origin; this.revision++;
    this.cancel();
  }
  resolve(route: RouteData, result: (route: RouteData) => void) {
    if (this.disposed) return;
    this.queued = { id: ++this.serial, route, result };
    this.pump();
  }
  cancel() { this.serial++; this.queued = undefined; this.deliver = undefined; }
  private pump() {
    if (this.disposed || this.active || !this.queued) return;
    const job = this.queued; this.queued = undefined;
    if (!this.worker) {
      // Without a worker, match small scenes locally. Leave larger routes unresolved so the map stays responsive.
      const vertices = this.roads.reduce((n, f) => n + (f.geometry.type === "LineString" ? f.geometry.coordinates.length : 0), 0);
      let result = unresolved(job.route);
      if (vertices <= 2000 && job.route.positions.length <= 2000) {
        try { result = new RoadSurfaceIndex(this.roads, this.origin).resolve(job.route); }
        catch { /* Keep the route unresolved if the geometry is invalid. */ }
      }
      job.result(result);
      return;
    }
    this.active = job.id; this.deliver = job.result; this.activeRoute = job.route;
    try {
      this.worker.postMessage({ id: job.id, revision: this.revision, origin: this.origin, route: job.route,
        ...(this.sentRevision !== this.revision ? { roads: this.roads } : {}) });
      this.sentRevision = this.revision;
      this.timeout = setTimeout(() => this.stopWorker(), 15000);
    } catch { this.stopWorker(); }
  }
  private stopWorker() {
    this.worker?.terminate(); this.worker = null;
    const deliver = this.active === this.serial ? this.deliver : undefined, route = this.activeRoute;
    clearTimeout(this.timeout); this.active = 0; this.deliver = undefined; this.activeRoute = undefined;
    if (!this.disposed && route) deliver?.(unresolved(route));
    this.pump();
  }
  dispose() {
    this.disposed = true; this.cancel(); this.stopWorker(); this.roads = [];
  }
}

/** Clear the previous road heights when a fresh match fails. */
function unresolved(route: RouteData): RouteData {
  return { ...route, elevations: undefined, widths: undefined,
    segmentMask: Array.from({ length: Math.max(0, route.positions.length - 1) }, () => false),
    segmentStates: Array.from({ length: Math.max(0, route.positions.length - 1) }, () => "limited"),
    surfaceMatch: { matched: 0, unknown: route.positions.length, ambiguous: 0, truncated: true } };
}
