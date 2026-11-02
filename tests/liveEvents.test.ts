/** @file tests/liveEvents.test.ts @brief Test how providers replace live observations, expire old ones and protect them from local edits. @author Norman */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LiveEventLayer, MAX_LIVE_EVENTS, type LiveEventSnapshotV1, type LiveMapEvent } from "../src/geo/LiveEventLayer";
import { SceneStore } from "../src/geo/SceneStore";
import { DEFAULT_STYLE, type GeoFeature } from "../src/geo/types";
import { BatchIndex } from "../src/rendering/BatchIndex";
const now = Date.parse("2026-10-27T00:00:00Z"), iso = (offset: number) => new Date(now + offset).toISOString();
const source = { id: "traffic", label: "Traffic observations", attribution: "Test provider" };
const event: LiveMapEvent = { id: "slow-a", kind: "slow-traffic", label: "Slow traffic", message: "Reported speeds",
  geometry: { type: "LineString", coordinates: [[103.8, 1.3], [103.801, 1.301]] } };
const snapshot = (events: readonly LiveMapEvent[] = [event], observed = 0): LiveEventSnapshotV1 =>
  ({ schemaVersion: 1, observedAt: iso(observed), expiresAt: iso(observed + 10000), events });
const local: GeoFeature = { id: "user:a", source: "user", layer: "scenario", label: "My object", geometry: { type: "Point", coordinates: [103.81, 1.3] }, style: DEFAULT_STYLE, properties: {} };
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => vi.useRealTimers());

it("replaces live observations without touching local edits or unrelated batches", () => {
  const store = new SceneStore(); store.execute({ type: "upsert", features: [local] });
  const saved = store.exportScenario(), index = new BatchIndex();
  index.sync(store, [local.id]); const localVersion = [...index.batches.values()][0].version;
  const off = store.subscribe(change => index.sync(store, change.ids));
  const layer = new LiveEventLayer(store, source);
  layer.apply(snapshot());
  expect(store.get("traffic:slow-a")?.model?.kind).toBe("line");
  expect(store.isEditable("traffic:slow-a")).toBe(false);
  const trafficBatch = [...index.batches.values()].find(batch => batch.layer === "custom:traffic")!;
  const version = trafficBatch.version;
  vi.advanceTimersByTime(1000);
  expect(layer.apply(snapshot([event], 1000))).toBe(true);
  expect(trafficBatch.version).toBe(version);
  expect([...index.batches.values()].find(batch => batch.layer === "scenario")!.version).toBe(localVersion);
  expect(store.exportScenario()).toBe(saved);
  layer.apply(snapshot([], 2000));
  expect(store.get("traffic:slow-a")).toBeUndefined();
  expect(store.get(local.id)).toBeDefined(); off(); layer.dispose();
});

it("ignores old and identical snapshots and expires observations even if polling stops", () => {
  const store = new SceneStore(), layer = new LiveEventLayer(store, source), observer = vi.fn();
  layer.subscribe(observer);
  layer.apply(snapshot([event, { ...event, id: "short", expiresAt: iso(3000) }]));
  expect(layer.apply(snapshot())).toBe(false);
  expect(layer.apply(snapshot([], -1000))).toBe(false);
  vi.advanceTimersByTime(3000);
  expect(store.get("traffic:short")).toBeUndefined(); expect(store.get("traffic:slow-a")).toBeDefined();
  vi.advanceTimersByTime(7000);
  expect(layer.events()).toEqual([]); expect(layer.getState().source.status).toBe("stale");
  expect(vi.getTimerCount()).toBe(0); expect(observer).toHaveBeenCalledTimes(3);
  expect(store.canUndo).toBe(false); layer.dispose();
});

it("validates a whole snapshot before replacing any active records", () => {
  const store = new SceneStore(), layer = new LiveEventLayer(store, source);
  layer.apply(snapshot()); const revision = store.revision;
  const bad = (events: readonly LiveMapEvent[]) => ({ ...snapshot(events, 1) });
  expect(() => layer.apply(bad([event, event]))).toThrow("Invalid live event");
  expect(() => layer.apply(bad([{ ...event, geometry: { type: "Point", coordinates: [NaN, 1.3] } }]))).toThrow();
  expect(() => layer.apply(bad(Array.from({ length: MAX_LIVE_EVENTS + 1 }, (_, i) => ({ ...event, id: `a${i}` }))))).toThrow("bounded");
  expect(() => layer.apply({ ...snapshot([], 1), expiresAt: iso(86400002) })).toThrow("freshness");
  expect(store.revision).toBe(revision); expect(store.get("traffic:slow-a")).toBeDefined(); layer.dispose();
});

it("keeps explicit, directional road impacts separate from ordinary geographic warnings", () => {
  const store = new SceneStore(), layer = new LiveEventLayer(store, source);
  const impact = { basis: "provider-confirmed", roadIds: ["provider:road-4"], direction: "forward", kind: "closure" } as const;
  layer.apply(snapshot([{ ...event, kind: "closure", impact }]));
  expect(layer.events()[0].impact).toEqual(impact);
  expect(Object.isFrozen(layer.events()[0].impact!.roadIds)).toBe(true);
  expect(() => layer.apply(snapshot([{ ...event, impact: { ...impact, basis: "nearby" as "provider-confirmed" } }], 1))).toThrow("assignments");
  layer.dispose();
});

it.each(["Point", "LineString"] as const)("retains a provider's measured below-datum %s event without guessing a tunnel depth", (type) => {
  const store = new SceneStore(), layer = new LiveEventLayer(store, source);
  const measured: LiveMapEvent = { ...event, elevation: -12,
    geometry: type === "Point" ? { type, coordinates: [103.8, 1.3] } : event.geometry };
  layer.apply(snapshot([measured]));
  expect(layer.events()[0].elevation).toBe(-12);
  expect(store.get("traffic:slow-a")?.style.elevation).toBe(-12);
  expect(store.get("traffic:slow-a")?.properties.elevationBasis).toBe("provider");
  expect(() => layer.apply(snapshot([{ ...measured, elevation: -1001 }], 1))).toThrow();
  expect(store.get("traffic:slow-a")?.style.elevation).toBe(-12);
  layer.apply(snapshot([{ ...event, elevation: undefined }], 2));
  expect(store.get("traffic:slow-a")?.style.elevation).toBe(0.35);
  expect(store.get("traffic:slow-a")?.properties.elevationBasis).toBe("unmatched-display-overlay");
  layer.dispose();
});

it("blocks imported edits and tombstones before, during and after provider observations", () => {
  const store = new SceneStore({ readOnlySources: ["traffic"] });
  const forged = { ...local, id: "traffic:future", source: "user" };
  expect(() => store.execute({ type: "upsert", features: [forged] })).toThrow("provider");
  expect(() => store.execute({ type: "upsert", features: [{ ...local, source: "traffic" }] })).toThrow("provider");
  expect(() => store.importScenario(JSON.stringify({ version: 1, overrides: [["traffic:future", null]] }))).toThrow("provider");
  const layer = new LiveEventLayer(store, source); layer.apply(snapshot());
  expect(() => store.execute({ type: "remove", ids: ["traffic:slow-a"] })).toThrow("provider");
  layer.dispose();
  expect(() => store.importScenario(JSON.stringify({ version: 1, overrides: [[forged.id, forged]] }))).toThrow("provider");
  expect(store.exportScenario()).not.toContain("traffic:");
});

it("refuses to silently discard edits when claiming a source that was already edited", () => {
  const store = new SceneStore(); store.execute({ type: "upsert", features: [{ ...local, id: "traffic:old" }] });
  const before = store.exportScenario();
  expect(() => new LiveEventLayer(store, source)).toThrow("already has scenario edits");
  expect(store.exportScenario()).toBe(before);
});

it("disposes only its source and prevents delayed work or later publication", () => {
  const store = new SceneStore(); store.execute({ type: "upsert", features: [local] });
  const layer = new LiveEventLayer(store, source), listener = vi.fn(); layer.subscribe(listener); layer.apply(snapshot());
  layer.dispose(); layer.dispose(); vi.advanceTimersByTime(60000);
  expect(listener).toHaveBeenCalledOnce(); expect(store.get(local.id)).toBeDefined();
  expect(store.get("traffic:slow-a")).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
  expect(() => layer.apply(snapshot())).toThrow("disposed");
  const untouched = new LiveEventLayer(store, { ...source, id: "never-used" }), revision = store.revision;
  untouched.dispose(); expect(store.revision).toBe(revision);
});

it("allows only one expiry owner per store/source and releases its lease on disposal", () => {
  const store = new SceneStore(), first = new LiveEventLayer(store, source);
  first.apply(snapshot());
  expect(() => new LiveEventLayer(store, source)).toThrow("active layer");
  first.dispose();
  const replacement = new LiveEventLayer(store, source);
  replacement.apply({ ...snapshot(), expiresAt: iso(20000) });
  vi.advanceTimersByTime(10000);
  expect(store.get("traffic:slow-a")).toBeDefined();
  expect(store.isEditable("traffic:slow-a")).toBe(false);
  const otherStore = new SceneStore(), independent = new LiveEventLayer(otherStore, source);
  independent.apply(snapshot()); independent.dispose();
  expect(store.get("traffic:slow-a")).toBeDefined();
  replacement.dispose();
  expect(store.isEditable("traffic:future")).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
