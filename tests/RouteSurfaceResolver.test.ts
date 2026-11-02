/** @file tests/RouteSurfaceResolver.test.ts @brief Test how the worker handles new routes, cancels old requests and recovers from errors. @author Norman */
import { afterEach, expect, it, vi } from "vitest";
import { RouteSurfaceResolver, type SurfaceRequest, type SurfaceWorker } from "../src/geo/RouteSurfaceResolver";
import { DEFAULT_STYLE, type GeoFeature, type RouteData } from "../src/geo/types";
const route: RouteData = { positions: [[103.8, 1.3], [103.801, 1.3]], distanceMetres: 111, durationSeconds: 10, source: "test" };
const road: GeoFeature = { id: "road", source: "city", layer: "roads", label: "Road", geometry: { type: "LineString", coordinates: route.positions }, style: DEFAULT_STYLE, model: { kind: "road" }, properties: {} };
class WorkerStub implements SurfaceWorker {
  onmessage: SurfaceWorker["onmessage"] = null;
  onerror: SurfaceWorker["onerror"] = null;
  postMessage = vi.fn<(request: SurfaceRequest) => void>();
  terminate = vi.fn();
  reply(id: number) { this.onmessage?.({ data: { id, route } } as MessageEvent); }
}
afterEach(() => vi.useRealTimers());
it("keeps only the newest pending route and reuses the worker's road index", () => {
  const worker = new WorkerStub(), resolver = new RouteSurfaceResolver(worker), first = vi.fn(), second = vi.fn(), latest = vi.fn();
  resolver.setRoads([road], [103.8, 1.3]);
  resolver.resolve(route, first); resolver.resolve(route, second); resolver.resolve(route, latest);
  const initial = worker.postMessage.mock.calls[0][0];
  expect(worker.postMessage).toHaveBeenCalledTimes(1); expect(initial.roads).toEqual([road]);
  worker.reply(initial.id);
  expect(first).not.toHaveBeenCalled(); expect(second).not.toHaveBeenCalled();
  const pending = worker.postMessage.mock.calls[1][0];
  expect(pending.roads).toBeUndefined(); worker.reply(pending.id);
  expect(latest).toHaveBeenCalledWith(route); resolver.dispose();
});
it("discards old city results, transmits replacement roads, and ignores disposed delivery", () => {
  const worker = new WorkerStub(), resolver = new RouteSurfaceResolver(worker), result = vi.fn();
  resolver.setRoads([road], [103.8, 1.3]); resolver.resolve(route, result);
  const old = worker.postMessage.mock.calls[0][0];
  resolver.setRoads([], [103.9, 1.3]); resolver.resolve(route, result); worker.reply(old.id);
  const next = worker.postMessage.mock.calls[1][0];
  expect(next.roads).toEqual([]); expect(next.revision).not.toBe(old.revision);
  expect(result).not.toHaveBeenCalled(); resolver.dispose(); worker.reply(next.id);
  expect(result).not.toHaveBeenCalled(); expect(worker.terminate).toHaveBeenCalledTimes(1);
});
it("terminates a hung worker and safely resolves the latest small job without a worker", () => {
  vi.useFakeTimers();
  const worker = new WorkerStub(), resolver = new RouteSurfaceResolver(worker), first = vi.fn(), latest = vi.fn();
  resolver.setRoads([], route.positions[0]); resolver.resolve(route, first); resolver.resolve(route, latest);
  vi.advanceTimersByTime(15000);
  expect(worker.terminate).toHaveBeenCalledTimes(1); expect(first).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledOnce(); expect(latest.mock.calls[0][0].surfaceMatch.unknown).toBeGreaterThan(0);
  resolver.dispose(); expect(vi.getTimerCount()).toBe(0);
});
it("leaves large scenes unresolved when workers are unavailable rather than matching on the UI thread", () => {
  const resolver = new RouteSurfaceResolver(null), result = vi.fn();
  resolver.setRoads(Array.from({ length: 1001 }, (_, i) => ({ ...road, id: String(i) })), route.positions[0]);
  resolver.resolve(route, result);
  expect(result.mock.calls[0][0].surfaceMatch).toEqual({ matched: 0, unknown: 2, ambiguous: 0, truncated: true });
  expect(result.mock.calls[0][0].segmentMask).toEqual([false]);
  expect(result.mock.calls[0][0].segmentStates).toEqual(["limited"]);
  expect(result.mock.calls[0][0].elevations).toBeUndefined(); resolver.dispose();
});
it("clears stale level metadata on worker failure and handles invalid fallback roads", () => {
  const worker = new WorkerStub(), resolver = new RouteSurfaceResolver(worker), result = vi.fn();
  resolver.resolve({ ...route, elevations: [5, 5], segmentStates: ["surface"] }, result);
  worker.onerror?.({} as ErrorEvent);
  expect(result.mock.calls[0][0].elevations).toBeUndefined();
  expect(result.mock.calls[0][0].segmentMask).toEqual([false]);
  expect(result.mock.calls[0][0].segmentStates).toEqual(["limited"]);
  resolver.setRoads([{ ...road, style: { ...DEFAULT_STYLE, width: NaN } }], route.positions[0]);
  expect(() => resolver.resolve(route, result)).not.toThrow();
  expect(result.mock.calls[1][0].surfaceMatch.truncated).toBe(true); resolver.dispose();
});
it("does not reveal a known hidden span when a worker reports a matching error", () => {
  const worker = new WorkerStub(), resolver = new RouteSurfaceResolver(worker), result = vi.fn();
  resolver.resolve({ ...route, elevations: [5, 5], segmentMask: [false] }, result);
  const request = worker.postMessage.mock.calls[0][0];
  worker.onmessage?.({ data: { id: request.id, error: "Road matching unavailable" } } as MessageEvent);
  expect(result.mock.calls[0][0].segmentMask).toEqual([false]);
  expect(result.mock.calls[0][0].elevations).toBeUndefined();
  expect(result.mock.calls[0][0].surfaceMatch.truncated).toBe(true);
  resolver.dispose();
});
it("does not complete a cancelled route after the worker fails while a newer route is queued", () => {
  const worker = new WorkerStub(), resolver = new RouteSurfaceResolver(worker), cancelled = vi.fn(), current = vi.fn();
  resolver.resolve(route, cancelled); resolver.cancel();
  resolver.resolve({ ...route, durationSeconds: 20 }, current);
  worker.onerror?.({} as ErrorEvent);
  expect(cancelled).not.toHaveBeenCalled();
  expect(current).toHaveBeenCalledOnce();
  expect(current.mock.calls[0][0].durationSeconds).toBe(20);
  resolver.dispose();
});
