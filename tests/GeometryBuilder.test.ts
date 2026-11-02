/**
 * @file tests/GeometryBuilder.test.ts
 * @brief Test geometry build scheduling and failures.
 * @author Norman
 * @description Checks queue limits, cleanup, late worker replies and builds that run without a worker.
 */

import { afterEach, expect, it, vi } from "vitest";
import { GeometryBuilder, type BuildRequest, type BuildResponse, type GeometryWorker } from "@upsight/map-renderer/rendering/GeometryBuilder";
import { DEFAULT_STYLE, type GeoFeature } from "@upsight/map-renderer/geo/types";

const request = { features: [], origin: [103.85, 1.28] as const, keys: [], detail: 0 as const };
class FakeWorker implements GeometryWorker {
  messages: BuildRequest[] = [];
  onmessage: GeometryWorker["onmessage"] = null;
  onerror: GeometryWorker["onerror"] = null;
  terminate = vi.fn();
  postMessage(value: BuildRequest) { this.messages.push(value); }
  reply(value: BuildResponse) { this.onmessage?.({ data: value } as MessageEvent<BuildResponse>); }
}
afterEach(() => vi.useRealTimers());
it("bounds queued builds and rejects pending requests on disposal, ignoring late results", async () => {
  const worker = new FakeWorker(), builder = new GeometryBuilder(worker);
  const first = builder.build(request).catch(error => error.message);
  const second = builder.build(request).catch(error => error.message);
  await expect(builder.build(request)).rejects.toThrow(/full/);
  expect(worker.messages.length).toBe(1); // The second request can still be cancelled before it reaches the worker.
  builder.dispose();
  expect(await first).toMatch(/disposed/);
  expect(await second).toMatch(/disposed/);
  worker.reply({ id: 1, error: "late" });
  expect(builder.pending).toBe(0);
  expect(worker.terminate).toHaveBeenCalledTimes(1);
});
it("surfaces a worker failure and yields between compatibility builds", async () => {
  vi.useFakeTimers();
  const worker = new FakeWorker(), builder = new GeometryBuilder(worker);
  const failed = builder.build(request).catch(error => error.message);
  worker.onerror?.({} as ErrorEvent);
  expect(await failed).toMatch(/worker failed/);
  expect(builder.mode).toBe("main-thread fallback");
  const next = builder.build(request);
  expect(builder.pending).toBe(1);
  await vi.runAllTimersAsync();
  expect((await next).data.positions).toHaveLength(0);
  builder.dispose();
});

const feature: GeoFeature = {
  id: "test:charger", source: "test", layer: "chargers", label: "Charger",
  geometry: { type: "Point", coordinates: [103.85, 1.28] },
  style: DEFAULT_STYLE, properties: { datasetRevision: "one" }, model: { kind: "charger" },
};
const populated = { ...request, features: [feature], keys: [[feature.id, 7] as [string, number]] };
function finish(worker: FakeWorker) {
  const sent = worker.messages.at(-1)!;
  const data = { positions: new Float32Array([0, 0, 0]), colors: new Float32Array([1, 0, 0]),
    keys: new Float32Array(sent.keys.map(([, key]) => key)), indices: new Uint32Array([0]),
    faceIds: sent.features.map((f) => f.id) };
  worker.reply({ id: sent.id, data, buildMs: 3 });
  return data;
}

it("skips obsolete waiting work and drains one cancelled active job without restarting the worker", async () => {
  const worker = new FakeWorker(), builder = new GeometryBuilder(worker),
    active = new AbortController(), waiting = new AbortController();
  const first = builder.build(populated, active.signal).catch(error => error.name);
  const second = builder.build({ ...populated, detail: 1 }, waiting.signal).catch(error => error.name);
  waiting.abort();
  active.abort();
  expect(await first).toBe("AbortError");
  expect(await second).toBe("AbortError");
  expect(builder.pending).toBe(1); // The cancelled build occupies the worker until it replies.
  const current = builder.build({ ...populated, origin: [103.9, 1.3] });
  expect(worker.messages).toHaveLength(1);
  const old = worker.messages[0];
  finish(worker);
  expect(worker.messages).toHaveLength(2);
  expect(worker.messages[1].origin).toEqual([103.9, 1.3]);
  expect(builder.cachedBytes).toBe(0); // The cache skips the cancelled build's result.
  worker.reply({ id: old.id, error: "duplicate late result" });
  expect(builder.pending).toBe(1);
  finish(worker);
  await current;
  expect(builder.pending).toBe(0);
  expect(worker.terminate).not.toHaveBeenCalled();
  builder.dispose();
});

it("cancels a compatibility build before it runs and starts the waiting request", async () => {
  vi.useFakeTimers();
  const builder = new GeometryBuilder(null), controller = new AbortController();
  const obsolete = builder.build(request, controller.signal).catch(error => error.name);
  const next = builder.build({ ...request, detail: 1 });
  controller.abort();
  expect(await obsolete).toBe("AbortError");
  expect(builder.pending).toBe(1);
  await vi.runAllTimersAsync();
  await expect(next).resolves.toMatchObject({ data: { faceIds: [] } });
  builder.dispose();
});

it("reuses identical source snapshots after unload and remaps recycled picking keys without mutating old buffers", async () => {
  const worker = new FakeWorker(), builder = new GeometryBuilder(worker);
  const first = builder.build(populated), original = finish(worker);
  await first;
  const bytes = builder.cachedBytes;
  const returned = await builder.build({ ...structuredClone(populated), keys: [[feature.id, 29]] });
  expect(worker.messages).toHaveLength(1);
  expect(returned.data.positions).toBe(original.positions);
  expect([...returned.data.keys]).toEqual([29]);
  expect([...original.keys]).toEqual([7]);
  expect(returned.data.faceIds).toEqual([feature.id]);
  expect(returned.buildMs).toBe(0);
  expect(builder.cachedBytes).toBe(bytes); // The cache replaces the old picking keys, so its size stays the same.
  expect((await builder.build(populated)).data.keys[0]).toBe(7);
  expect(worker.messages).toHaveLength(1);
  builder.dispose();
  expect(builder.cachedBytes).toBe(0);
});

it("snapshots mutable nested styles and invalidates a shallow-frozen caller's cached geometry", async () => {
  const builder = new GeometryBuilder(null);
  const style = { ...feature.style, height: 1 };
  const point = Object.freeze({ ...feature, style, model: undefined });
  const req = { ...populated, features: [point] };
  const first = builder.build(req);
  style.height = 50;
  const maxY = (positions: Float32Array) => Math.max(...positions.filter((_, i) => i % 3 === 1));
  try {
    expect(maxY((await first).data.positions)).toBeCloseTo(1.9);
    expect(maxY((await builder.build(req)).data.positions)).toBeCloseTo(50.9);
  } finally { builder.dispose(); }
});
it("never reuses cached geometry for edited styling, refreshed source revisions, origins or detail levels", async () => {
  const worker = new FakeWorker(), builder = new GeometryBuilder(worker);
  const variants = [populated,
    { ...populated, features: [{ ...feature, style: { ...feature.style, height: 50 } }] },
    { ...populated, features: [{ ...feature, properties: { datasetRevision: "two" } }] },
    { ...populated, origin: [103.9, 1.3] as const },
    { ...populated, detail: 1 as const },
  ];
  for (const [index, variant] of variants.entries()) {
    const result = builder.build(variant);
    expect(worker.messages).toHaveLength(index + 1);
    finish(worker);
    await result;
  }
  builder.dispose();
});

it("bounds retained mesh buffers and their signatures, evicts least recently used entries, and trims on device changes", async () => {
  const worker = new FakeWorker(), builder = new GeometryBuilder(worker);
  const first = builder.build(populated);
  finish(worker);
  await first;
  const oneEntryBytes = builder.cachedBytes;
  expect(oneEntryBytes).toBeGreaterThan(JSON.stringify(feature).length * 2);
  builder.setCacheLimit(oneEntryBytes * 2);
  const second = builder.build({ ...populated, detail: 1 });
  finish(worker);
  await second;
  await builder.build(populated); // Keep the first entry more recent than the second.
  const third = builder.build({ ...populated, origin: [103.86, 1.28] });
  finish(worker);
  await third;
  expect(builder.cachedBytes).toBeLessThanOrEqual(oneEntryBytes * 2);
  await builder.build(populated);
  expect(worker.messages).toHaveLength(3);
  const evicted = builder.build({ ...populated, detail: 1 });
  expect(worker.messages).toHaveLength(4);
  finish(worker);
  await evicted;
  builder.setCacheLimit(0);
  expect(builder.cachedBytes).toBe(0);
  builder.dispose();
});

it("rebuilds instead of reusing an ambiguous old group key after membership splits", async () => {
  const worker = new FakeWorker(), builder = new GeometryBuilder(worker);
  const grouped = { ...populated, features: [feature, { ...feature, id: "test:second" }],
    keys: [[feature.id, 7], ["test:second", 7]] as [string, number][] };
  const first = builder.build(grouped);
  finish(worker);
  await first;
  const split = builder.build({ ...grouped, keys: [[feature.id, 7], ["test:second", 8]] });
  expect(worker.messages).toHaveLength(2);
  finish(worker);
  expect([...(await split).data.keys]).toEqual([7, 8]);
  builder.dispose();
});
