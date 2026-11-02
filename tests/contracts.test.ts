/** @file tests/contracts.test.ts @brief Test how the package handles saved edits, provider data, camera tracking, road checks and extensions. @author Norman */
import { expect, it, vi } from "vitest";
import { SceneStore } from "../src/geo/SceneStore";
import { DEFAULT_STYLE, type GeoFeature } from "../src/geo/types";
import { connectScenePersistence } from "../src/geo/persistence";
import { applyFeatureEnvelope } from "../src/geo/provider";
import { FollowHeading } from "../src/engine/FollowHeading";
import { auditScene } from "../src/geo/diagnostics";
import { ExtensionRegistry, type RendererExtensionFactory, type ExtensionFrame } from "../src/rendering/extensions";
import type { Scene } from "@babylonjs/core/scene";

const source = { id: "test", label: "Test", status: "snapshot" as const, attribution: "Fixture" };
const point: GeoFeature = { id: "test:label", source: "test", layer: "annotations", label: "Depot", geometry: { type: "Point", coordinates: [103.8, 1.3] }, style: DEFAULT_STYLE, properties: {}, model: { kind: "label", fontSize: 14 } };
it("persists committed edits and tombstones, but not live refreshes or drag previews", () => {
  const store = new SceneStore(); store.replaceSource(source, [point]);
  let saved: string | null = null;
  const save = vi.fn((text: string) => { saved = text; });
  const off = connectScenePersistence(store, { load: () => saved, save });
  const preview = store.beginPreview(point.id); preview.update({ ...point, label: "Preview" });
  expect(save).not.toHaveBeenCalled(); preview.finish(false);
  store.execute({ type: "remove", ids: [point.id] }); expect(save).toHaveBeenCalledTimes(1);
  store.replaceSource(source, [{ ...point, label: "Refreshed" }]); expect(save).toHaveBeenCalledTimes(1);
  const restored = new SceneStore(); connectScenePersistence(restored, { load: () => saved, save });
  restored.replaceSource(source, [point]); expect(restored.get(point.id)).toBeUndefined();
  off(); store.undo(); expect(save).toHaveBeenCalledTimes(1);
});
it("does not destroy corrupt saved data and reports storage failures", () => {
  const store = new SceneStore(), save = vi.fn(), onError = vi.fn();
  connectScenePersistence(store, { load: () => "broken", save }, { onError });
  store.execute({ type: "upsert", features: [point] });
  expect(onError).toHaveBeenCalledOnce(); expect(save).not.toHaveBeenCalled();
});
it("applies a provider envelope atomically and rejects a foreign source/version", () => {
  const store = new SceneStore(); applyFeatureEnvelope(store, { schemaVersion: 1, source, features: [point] });
  expect(() => applyFeatureEnvelope(store, { schemaVersion: 1, source, features: [{ ...point, source: "other" }] })).toThrow();
  expect(store.get(point.id)?.label).toBe("Depot");
  expect(() => applyFeatureEnvelope(store, { schemaVersion: 2, source, features: [] } as never)).toThrow();
});
it("smooths the shortest heading arc independently of frame rate, and resets after a gap", () => {
  const a = new FollowHeading(), b = new FollowHeading();
  a.sample(359, 0); b.sample(359, 0);
  for (let i = 1; i <= 60; i++) a.sample(1, i * 1000 / 60);
  for (let i = 1; i <= 30; i++) b.sample(1, i * 1000 / 30);
  expect(a.sample(1, 1000)).toBeCloseTo(b.sample(1, 1000), 8);
  expect(a.sample(180, 2000)).toBe(180);
  a.reset(); expect(a.sample(90, 2016)).toBe(90);
});
const square = [[0,0],[0.01,0],[0.01,0.01],[0,0.01]] as const;
const building: GeoFeature = { ...point, id: "test:building", layer: "buildings", model: { kind: "building" }, geometry: { type: "Polygon", coordinates: [square] }, style: { ...DEFAULT_STYLE, elevation: 0, height: 10 } };
const road: GeoFeature = { ...point, id: "test:road", layer: "roads", model: { kind: "road" }, geometry: { type: "LineString", coordinates: [[-0.01,0.005],[0.02,0.005]] }, style: { ...DEFAULT_STYLE, elevation: 0 } };
it("reports centerline obstruction without flagging an elevated passage or courtyard", () => {
  expect(auditScene([road, building]).issues.map(i => i.kind)).toContain("possible-road-obstruction");
  expect(auditScene([road, { ...building, style: { ...building.style, elevation: 6 } }]).issues).toEqual([]);
  const courtyard: GeoFeature = { ...building, geometry: { type: "Polygon", coordinates: [square, [[0.002,0.002],[0.008,0.002],[0.008,0.008],[0.002,0.008]]] } };
  const internal: GeoFeature = { ...road, geometry: { type: "LineString", coordinates: [[0.003,0.005],[0.007,0.005]] } };
  expect(auditScene([internal, courtyard]).issues).toEqual([]);
  expect(auditScene([road, building], { maxOperations: 2 }).truncated).toBe(true);
});
it("audits the drawn height of profiled roads and routes and skips hidden edges", () => {
  const bridge: GeoFeature = { ...road, style: { ...road.style, elevation: 20 },
    model: { kind: "road", road: { footway: false, paved: true, sidewalk: false, lanes: 1, elevations: [0.18, 0.18] } } };
  const ribbon: GeoFeature = { ...road, layer: "route", model: { kind: "line", line: { elevations: [20, 20] } } };
  const upper = { ...building, style: { ...building.style, elevation: 18 } };
  for (const line of [bridge, ribbon]) {
    expect(auditScene([line, building]).issues).toEqual([]);
    expect(auditScene([line, upper]).issues.map(i => i.kind)).toEqual(["possible-road-obstruction"]);
  }
  expect(auditScene([{ ...ribbon, model: { kind: "line", line: { elevations: [20, 20], segmentMask: [false] } } }, upper]).issues).toEqual([]);
  expect(auditScene([{ ...bridge, model: { kind: "road", road: { ...bridge.model!.road!, surfaceHidden: true } } }, upper]).issues).toEqual([]);
});
it("routes extension changes, clears reassigned objects and isolates plugin failures", () => {
  const sync = vi.fn(), dispose = vi.fn(), report = vi.fn(), store = new SceneStore();
  const factory: RendererExtensionFactory = { id: "depot", create: () => ({ sync, dispose, render: () => { throw new Error("failed"); } }) };
  const registry = new ExtensionRegistry([factory], { scene: {} as Scene, store, invalidate: vi.fn() }, report);
  const custom: GeoFeature = { ...point, model: { kind: "custom", rendererId: "depot" } };
  store.execute({ type: "upsert", features: [custom] }); registry.sync(store, [point.id]);
  expect(sync.mock.calls[0][0].get(point.id)?.model.kind).toBe("custom");
  store.execute({ type: "upsert", features: [point] }); registry.sync(store, [point.id]);
  expect(sync.mock.calls[1][0].has(point.id)).toBe(true); expect(sync.mock.calls[1][0].get(point.id)).toBeUndefined();
  registry.render({} as ExtensionFrame); registry.render({} as ExtensionFrame);
  expect(dispose).toHaveBeenCalledOnce(); expect(report).toHaveBeenCalledOnce();
});
