/** @file tests/editingApi.test.ts @brief Test drag, rotation and resize gestures through the public editing API. @author Norman */
import { describe, expect, it, vi } from "vitest";
import {
  SceneStore, DEFAULT_STYLE, applyFeatureEnvelope, connectScenePersistence,
  localFrame, pointsOf, type GeoFeature, type SelectionPreview,
} from "../src/index";

const frame = localFrame([103.85, 1.3]);
const source = { id: "partner", label: "Partner fixtures", status: "snapshot" as const, attribution: "Synthetic test data" };
const part = (id: string, east: number, elevation = 0): GeoFeature => ({
  id, source: source.id, layer: "buildings", label: "Building part",
  geometry: { type: "Polygon", coordinates: [[
    frame.unproject(east, 0), frame.unproject(east + 10, 0),
    frame.unproject(east + 10, 10), frame.unproject(east, 10),
  ]] },
  model: { kind: "building", roof: { shape: "gabled", height: 2, color: "#778899" } },
  style: { ...DEFAULT_STYLE, elevation, height: 12 },
  properties: { buildingGroup: "relation/123", buildingGroupBasis: "OSM building relation", buildingGroupMembers: 2 },
});

describe("public editing gestures", () => {
  it("keeps an untouched building or GLB provider-owned when a drag returns to its start", () => {
    const store = new SceneStore();
    const members = [part("partner:a", 0), part("partner:b", 10, 6)];
    const model: GeoFeature = { ...members[0], id: "partner:asset", layer: "imported",
      geometry: { type: "Point", coordinates: [103.8, 1.3] },
      model: { kind: "asset", assetId: "partner:model", length: 2 }, properties: {} };
    const fixtures = [...members, model];
    store.replaceSource(source, fixtures);
    for (const feature of [members[0], model]) {
      const drag = store.beginSelectionPreview(feature.id);
      drag.transform(10, 5, 30, 2);
      drag.move(0, 0);
      drag.finish(true);
    }
    expect(store.canUndo).toBe(false);
    expect(store.committedOverrides()).toEqual([]);
    expect(store.committedBuildingPins()).toEqual([]);
    store.replaceSource(source, fixtures.map(f => ({ ...f, label: "New provider label" })));
    expect(store.values().every(f => f.label === "New provider label")).toBe(true);
  });
  it("previews a whole-building rotation and resize without accumulating transforms or persisting intermediate frames", () => {
    const store = new SceneStore(), members = [part("partner:a", 0), part("partner:b", 10, 6)];
    applyFeatureEnvelope(store, { schemaVersion: 1, source, features: members });
    const save = vi.fn();
    const disconnect = connectScenePersistence(store, { load: () => null, save });
    const expected = store.transformSelection(members[0].id, 30, 20, 90, 2);
    const preview: SelectionPreview = store.beginSelectionPreview(members[0].id);
    preview.transform(10, 5, 15, 1.5);
    preview.transform(30, 20, 90, 2);
    expect(store.selectionMembers(members[0].id)).toEqual(expected);
    expect(save).not.toHaveBeenCalled();
    const [first, second] = store.selectionMembers(members[0].id);
    expect(pointsOf(first.geometry)[1]).toEqual(pointsOf(second.geometry)[0]);
    expect(second.style.elevation).toBe(12);
    expect(second.model?.roof?.height).toBe(4);
    preview.finish(true);
    expect(save).toHaveBeenCalledOnce();
    expect(store.committedBuildingPins()[0].memberIds).toEqual(members.map(f => f.id));
    store.undo();
    expect(store.selectionMembers(members[0].id)).toEqual(members);
    store.redo();
    expect(store.selectionMembers(members[0].id)).toEqual(expected);
    disconnect();
  });

  it.each(["asset", "charger", "label"] as const)("keeps %s identity through preview, refresh, persistence, deletion and reset", (kind) => {
    const original: GeoFeature = {
      id: `partner:${kind}`, source: source.id,
      layer: kind === "charger" ? "chargers" : kind === "label" ? "annotations" : "imported",
      label: "Partner object", geometry: { type: "Point", coordinates: frame.unproject(0, 0) },
      style: { ...DEFAULT_STYLE, height: 2 },
      model: kind === "label" ? { kind, fontSize: 16 } : { kind, assetId: "library:glb", length: 5, heading: 10 },
      properties: kind === "charger" ? { stationId: "station-a", connector: "CCS" } : {},
    };
    const store = new SceneStore();
    applyFeatureEnvelope(store, { schemaVersion: 1, source, features: [original] });
    const preview = store.beginSelectionPreview(original.id);
    preview.transform(12, 8, 25, 2);
    preview.finish(true);
    const edited = store.get(original.id)!;
    expect(edited.id).toBe(original.id);
    expect(edited.model?.kind).toBe(kind);
    expect(edited.properties).toEqual(original.properties);
    expect(edited.style.height).toBe(4);
    if (kind === "asset") expect(edited.model?.length).toBe(10);
    expect(frame.project(edited.geometry.coordinates as readonly [number, number])[0]).toBeCloseTo(12, 5);
    const refreshed = { ...original, label: "Updated provider name" };
    applyFeatureEnvelope(store, { schemaVersion: 1, source, features: [refreshed] });
    expect(store.get(original.id)).toEqual(edited);
    const restored = new SceneStore();
    restored.importScenario(store.exportScenario());
    applyFeatureEnvelope(restored, { schemaVersion: 1, source, features: [refreshed] });
    expect(restored.get(original.id)).toEqual(edited);
    restored.execute({ type: "remove", ids: [original.id] });
    expect(restored.get(original.id)).toBeUndefined();
    restored.undo();
    expect(restored.get(original.id)).toEqual(edited);
    restored.resetOverrides([original.id]);
    expect(restored.get(original.id)).toEqual(refreshed);
  });

  it("cancels rotation/resize gestures on refresh and rejects invalid scales without a partial group change", () => {
    const store = new SceneStore(), members = [part("partner:a", 0), part("partner:b", 10, 6)];
    store.replaceSource(source, members);
    const preview = store.beginSelectionPreview(members[0].id);
    preview.transform(10, 0, 30, 1.2);
    const before = store.selectionMembers(members[0].id);
    expect(() => preview.transform(0, 0, 0, -1)).toThrow("Invalid transform");
    expect(store.selectionMembers(members[0].id)).toEqual(before);
    store.replaceSource(source, members);
    preview.transform(100, 100, 90, 3);
    preview.finish(true);
    expect(store.selectionMembers(members[0].id)).toEqual(members);
    expect(store.canUndo).toBe(false);
  });
});
