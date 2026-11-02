/**
 * @file tests/sourceRefresh.test.ts
 * @brief Test which local edits survive when a provider refreshes its data.
 * @author Norman
 */
import { describe, expect, it, vi } from "vitest";
import { SceneStore } from "../src/geo/SceneStore";
import { connectScenePersistence } from "../src/geo/persistence";
import { localFrame, transformFeature } from "../src/geo/math";
import { DEFAULT_STYLE, type GeoFeature } from "../src/geo/types";

const source = {
  id: "city", label: "Raw OSM", status: "snapshot" as const,
  attribution: "OpenStreetMap contributors", asOf: "2026-09-29T00:00:00Z",
};
const refreshedSource = { ...source, asOf: "2026-10-23T00:00:00Z" };
const frame = localFrame([103.85, 1.3]);
function building(id: string, east = 0, height = 12): GeoFeature {
  return {
    id, source: "city", layer: "buildings", label: "Mapped building",
    geometry: { type: "Polygon", coordinates: [[
      frame.unproject(east, 0), frame.unproject(east + 10, 0),
      frame.unproject(east + 10, 10), frame.unproject(east, 10),
    ]] },
    model: { kind: "building", facade: "stone" },
    style: { ...DEFAULT_STYLE, height, elevation: 0 },
    properties: { sourceId: id, datasetRevision: "old" },
  };
}
function asset(id: string, source = "local"): GeoFeature {
  return {
    id, source, layer: "imported", label: "My uploaded model",
    geometry: { type: "Point", coordinates: frame.unproject(30, 15) },
    model: { kind: "asset", assetId: "local:uploaded-glb", length: 14, heading: 45 },
    style: { ...DEFAULT_STYLE, height: 7, width: 8, elevation: 1 },
    properties: {},
  };
}
const updated = (f: GeoFeature): GeoFeature => ({
  ...transformFeature(f, 2, 1), label: "New mapped name",
  style: { ...f.style, height: f.style.height + 6, color: "#abcdef" },
  properties: { ...f.properties, datasetRevision: "new" },
});
const grouped = (f: GeoFeature, count: number): GeoFeature => ({
  ...f, properties: { ...f.properties, buildingGroup: "relation/100",
    buildingGroupBasis: "OSM building relation", buildingGroupMembers: count },
});
const groupBefore = [grouped(building("city:part-a"), 2), grouped(building("city:part-b", 10), 2)];
const groupAfter = [...groupBefore.map((f) => grouped(updated(f), 3)), grouped(building("city:part-c", 20), 3)];

describe("provider refresh with local scene edits", () => {
  it("keeps a gesture active after invalid provider and editor transactions", () => {
    const store = new SceneStore(), original = building("city:one"), other = asset("other:one", "other");
    store.replaceSource(source, [original]);
    store.replaceSource({ ...source, id: other.source }, [other]);
    const drag = store.beginSelectionPreview(original.id);
    drag.move(25, 0);
    const displayed = store.get(original.id), revision = store.revision;
    expect(() => store.replaceSource(source, [building(other.id)])).toThrow("collides");
    expect(() => store.execute({ type: "remove", ids: ["missing"] })).toThrow("unknown");
    expect(store.revision).toBe(revision);
    expect(store.get(original.id)).toBe(displayed);
    drag.finish(true);
    expect(store.get(original.id)).toEqual(displayed);
    store.undo();
    expect(store.get(original.id)).toEqual(original);
  });

  it("prunes only newly protected bare IDs from the current scenario and both history stacks", () => {
    const store = new SceneStore({ readOnlySources: [source.id] });
    const userObject = asset("local:kept");
    store.importScenario(JSON.stringify({ version: 1, overrides: [["depot", null], [userObject.id, userObject]] }));
    store.execute({ type: "upsert", features: [{ ...userObject, label: "Second version" }] });
    store.execute({ type: "upsert", features: [{ ...userObject, label: "Third version" }] });
    store.undo();
    const depot = building("depot");
    store.replaceSource(source, [depot]);
    expect(store.get(depot.id)).toEqual(depot);
    expect(store.isEditable(depot.id)).toBe(false);
    expect(store.isOverridden(depot.id)).toBe(false);
    store.redo();
    expect(store.get(userObject.id)?.label).toBe("Third version");
    expect(store.get(depot.id)).toEqual(depot);
    store.undo(); store.undo();
    expect(store.get(userObject.id)?.label).toBe(userObject.label);
    expect(store.get(depot.id)).toEqual(depot);
    store.execute({ type: "upsert", features: [{ ...userObject, label: "Still editable" }] });
    store.replaceSource(source, []);
    expect(() => store.importScenario(JSON.stringify({ version: 1, overrides: [["depot", null]] }))).toThrow("provider");
  });

  it("restores independent storage partitions that together exceed one document's limit", () => {
    const store = new SceneStore(), onError = vi.fn();
    const fixtures = Array.from({ length: 2600 }, (_, i) => ({ ...asset(`local:${i}`), properties: { note: "x".repeat(500) } }));
    for (const [start, end] of [[0, 1300], [1300, 2600]]) {
      const slice = fixtures.slice(start, end);
      const ids = new Set(slice.map(f => f.id));
      const partition = new SceneStore();
      partition.execute({ type: "upsert", features: slice });
      const saved = partition.exportScenario();
      const off = connectScenePersistence(store, { load: () => saved, save: vi.fn() },
        { include: id => ids.has(id), onError });
      off();
    }
    expect(store.values()).toEqual(fixtures);
    expect(onError).not.toHaveBeenCalled();
    expect(() => store.exportScenario()).toThrow("2 MB");
  });

  it("rejects pins forged against protected providers before and after loading a building", () => {
    const store = new SceneStore({ readOnlySources: [source.id] });
    const forged = JSON.stringify({ version: 1, overrides: [["other", null]],
      buildingPins: [{ source: source.id, groupId: "relation/100", memberIds: ["other"] }] });
    expect(() => store.importScenario(forged)).toThrow("provider");
    store.replaceSource(source, groupBefore);
    expect(() => store.importScenario(forged)).toThrow("provider");
    expect(store.values()).toEqual(groupBefore);
    const otherStore = new SceneStore();
    otherStore.importScenario(forged);
    expect(() => otherStore.protectSource(source.id)).toThrow("scenario edits");
  });

  it("uses the same compact size boundary for export, restore and storage", () => {
    const store = new SceneStore(), point = asset("unused");
    let saved: string | null = null;
    const onError = vi.fn();
    const off = connectScenePersistence(store, { load: () => null, save: text => { saved = text; } }, { onError });
    const fixtures = Array.from({ length: 3200 }, (_, i) => ({ ...point, id: `local:${i}` }));
    store.execute({ type: "upsert", features: fixtures });
    const text = store.exportScenario();
    expect(text).toBe(saved);
    expect(JSON.stringify(JSON.parse(text), null, 2).length).toBeGreaterThan(2_000_000);
    const restored = new SceneStore(); restored.importScenario(text);
    expect(restored.size).toBe(fixtures.length);
    store.execute({ type: "upsert", features: fixtures.map(f => ({ ...f, properties: { note: "x".repeat(500) } })) });
    expect(() => store.exportScenario()).toThrow("2 MB");
    expect(onError).toHaveBeenCalledOnce();
    expect(saved).toBe(text);
    const lateSave = vi.fn(), lateError = vi.fn();
    const lateOff = connectScenePersistence(store, { load: () => null, save: lateSave }, { onError: lateError });
    expect(lateError).toHaveBeenCalledOnce();
    store.undo();
    expect(store.exportScenario()).toBe(text);
    expect(lateSave).toHaveBeenCalledWith(text);
    off(); lateOff();
  });
  it("reuses unchanged overlapping records without republishing an identical source", () => {
    const store = new SceneStore(), a = building("city:a"), b = building("city:b", 20);
    store.replaceSource(source, [a, b]);
    const original = store.get(a.id), listener = vi.fn();
    store.subscribe(listener);
    store.replaceSource({ ...source }, structuredClone([a, b]));
    expect(store.get(a.id)).toBe(original);
    expect(listener).not.toHaveBeenCalled();

    store.replaceSource(source, structuredClone([a, building("city:c", 40)]));
    expect(store.get(a.id)).toBe(original);
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ ids: [b.id, "city:c"] }));
    // The provider can update a feature's geometry while keeping its ID.
    store.replaceSource(refreshedSource, [updated(a)]);
    expect(store.get(a.id)).not.toBe(original);
    expect(store.get(a.id)).toEqual(updated(a));
    expect(store.sourceInfo()).toEqual([refreshedSource]);
  });

  it("publishes source metadata changes even when geometry stays identical", () => {
    const store = new SceneStore(), a = building("city:a");
    store.replaceSource(source, [a]);
    const original = store.get(a.id), listener = vi.fn();
    store.subscribe(listener);
    store.replaceSource(refreshedSource, structuredClone([a]));
    expect(store.get(a.id)).toBe(original);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ ids: [], reason: "source" }));
    expect(store.sourceInfo()).toEqual([refreshedSource]);
  });

  it("canonicalizes optional undefined fields and reordered scalar properties without publishing", () => {
    const store = new SceneStore(), base = building("city:equivalent");
    const originalInput = { ...base, properties: { ...base.properties, count: 0, enabled: false, unknown: null } };
    store.replaceSource(source, [originalInput]);
    const original = store.get(base.id), listener = vi.fn();
    store.subscribe(listener);
    store.replaceSource(source, [{ ...structuredClone(originalInput),
      model: { ...base.model!, heading: undefined, roof: undefined },
      properties: { unknown: null, enabled: false, count: -0,
        datasetRevision: "old", sourceId: base.id },
    }]);
    expect(store.get(base.id)).toBe(original);
    expect(listener).not.toHaveBeenCalled();
  });

  it("detects independent geometry, appearance, nested model and scalar property changes", () => {
    const simple = building("city:details");
    const base: GeoFeature = { ...simple,
      geometry: { type: "Polygon", coordinates: [
        ...(simple.geometry.type === "Polygon" ? simple.geometry.coordinates : []),
        [frame.unproject(2, 2), frame.unproject(4, 2), frame.unproject(4, 4), frame.unproject(2, 4)],
      ] },
      model: { ...simple.model!, family: "canopy", omitSupports: [0, 1],
        roof: { shape: "gabled", height: 2, color: "#123456", across: false } },
      properties: { ...simple.properties, count: 2, enabled: false, unknown: null },
    };
    const changes: GeoFeature[] = [
      { ...base, label: "Updated label" },
      { ...base, layer: "scenario" },
      ...Object.entries({ color: "#abcdef", height: 15, radius: 3, width: 6, elevation: 1 })
        .map(([key, value]) => ({ ...base, style: { ...base.style, [key]: value } })),
      transformFeature(base, 0.1, 0),
      { ...base, geometry: simple.geometry }, // Removing a courtyard is a geometry change.
      { ...base, model: { ...base.model!, facade: "glass" } },
      { ...base, model: { ...base.model!, heading: 15 } },
      { ...base, model: { ...base.model!, omitSupports: [1, 0] } },
      { ...base, model: { ...base.model!, omitSupports: [0] } },
      { ...base, model: { ...base.model!, roof: undefined } },
      ...Object.entries({ shape: "hipped", height: 3, color: "#abcdef", across: true })
        .map(([key, value]) => ({ ...base, model: { ...base.model!, roof: { ...base.model!.roof!, [key]: value } } })),
      ...Object.entries({ count: 3, enabled: true, unknown: "known", extra: null })
        .map(([key, value]) => ({ ...base, properties: { ...base.properties, [key]: value } })),
      { ...base, properties: { ...simple.properties, count: 2, enabled: false } },
    ];
    for (const changed of changes) {
      const store = new SceneStore();
      store.replaceSource(source, [base]);
      const original = store.get(base.id), listener = vi.fn();
      store.subscribe(listener);
      store.replaceSource(source, [structuredClone(changed)]);
      expect(store.get(base.id), JSON.stringify(changed)).not.toBe(original);
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ ids: [base.id] }));
    }
  });

  it("detects nested road profile and asset reference changes without losing local overrides", () => {
    const road: GeoFeature = { ...building("city:road"), layer: "roads",
      geometry: { type: "LineString", coordinates: [frame.unproject(0, 0), frame.unproject(10, 10)] },
      model: { kind: "road", road: { lanes: 2, footway: false, paved: true, sidewalk: true,
        sidewalkSide: "left", elevations: [0, 2] } },
    };
    const imported = asset("city:asset", "city");
    const cases: Array<[GeoFeature, GeoFeature]> = [
      ...Object.entries({ lanes: 3, footway: true, paved: false, sidewalk: false,
        sidewalkSide: "right", elevations: [0, 3] }).map(([key, value]): [GeoFeature, GeoFeature] =>
        [road, { ...road, model: { ...road.model!, road: { ...road.model!.road!, [key]: value } } }]),
      ...Object.entries({ assetId: "local:new-model", length: 20, heading: 80, replacement: "city:original" })
        .map(([key, value]): [GeoFeature, GeoFeature] => [imported, { ...imported, model: { ...imported.model!, [key]: value } }]),
    ];
    for (const [base, changed] of cases) {
      const store = new SceneStore();
      store.replaceSource(source, [base]);
      const local = transformFeature(base, 20, 10);
      store.execute({ type: "upsert", features: [local] });
      const overridden = store.get(base.id);
      store.replaceSource(refreshedSource, [structuredClone(changed)]);
      expect(store.get(base.id)).toBe(overridden);
      store.resetOverrides([base.id]);
      expect(store.get(base.id)).toEqual(changed);
    }
  });

  it("updates untouched records while retaining moves, resizing, styling, labels, GLB replacements and removals", () => {
    const originals = ["untouched", "moved", "appearance", "replacement", "deleted", "retired"]
      .map((id, i) => building(`city:${id}`, i * 20));
    const store = new SceneStore();
    store.replaceSource(source, originals);
    store.execute({ type: "upsert", features: [
      transformFeature(originals[1], 40, 25, 30, 1.5),
      { ...originals[2], label: "My building name", model: { kind: "building", facade: "glass" },
        style: { ...originals[2].style, color: "#123456", height: 31 } },
      { ...asset(originals[3].id, "city"), model: {
        kind: "asset", assetId: "local:replacement-glb", length: 20,
        heading: 60, replacement: originals[3].id,
      } },
      asset("local:extra"),
    ] });
    store.execute({ type: "remove", ids: [originals[4].id] });
    const before = new Map(store.committedOverrides());
    const changed = originals.slice(0, 5).map(updated);
    const added = building("city:new", 160);

    store.replaceSource(refreshedSource, [...changed, added]);

    expect(store.get(originals[0].id)).toEqual(changed[0]);
    expect(store.get(added.id)).toEqual(added);
    expect(store.get(originals[5].id)).toBeUndefined();
    for (const [id, value] of before) {
      expect(store.get(id)).toEqual(value ?? undefined);
      expect(store.isOverridden(id)).toBe(true);
    }
    expect(store.sourceInfo()).toEqual([refreshedSource]);
    expect(store.get(originals[1].id)?.style.height).toBe(18);
    expect(store.get(originals[3].id)?.model?.assetId).toBe("local:replacement-glb");
  });

  it("restores only local edits before the new base arrives and does not save source refreshes", () => {
    const base = building("city:original"), removed = building("city:removed", 20);
    let saved: string | null = null;
    const save = vi.fn((value: string) => { saved = value; });
    const storage = { load: () => saved, save };
    const store = new SceneStore();
    const disconnect = connectScenePersistence(store, storage);
    store.replaceSource(source, [base, removed]);
    expect(save).not.toHaveBeenCalled();
    store.execute({ type: "upsert", features: [transformFeature(base, 10, 8, 0, 2), asset("local:extra")] });
    store.execute({ type: "remove", ids: [removed.id] });
    const expected = store.exportScenario();
    const writes = save.mock.calls.length;
    disconnect();

    const restored = new SceneStore();
    const detachRestored = connectScenePersistence(restored, storage);
    const fresh = building("city:new", 40);
    restored.replaceSource(refreshedSource, [updated(base), updated(removed), fresh]);
    expect(restored.exportScenario()).toBe(expected);
    expect(restored.get(base.id)).toEqual(store.get(base.id));
    expect(restored.get("local:extra")).toEqual(store.get("local:extra"));
    expect(restored.get(removed.id)).toBeUndefined();
    expect(restored.get(fresh.id)).toEqual(fresh);
    expect(restored.canUndo).toBe(false);
    expect(save).toHaveBeenCalledTimes(writes);
    expect(saved).not.toContain('"city:new"');
    detachRestored();
  });

  it("undo and redo operate over the refreshed base without resurrecting an old snapshot", () => {
    const base = building("city:one"), latest = updated(base);
    const store = new SceneStore();
    store.replaceSource(source, [base]);
    store.execute({ type: "upsert", features: [transformFeature(base, 20, 0, 0, 2)] });
    const local = store.get(base.id);
    store.execute({ type: "remove", ids: [base.id] });
    store.replaceSource(refreshedSource, [latest]);
    store.undo();
    expect(store.get(base.id)).toEqual(local);
    store.undo();
    expect(store.get(base.id)).toEqual(latest);
    expect(store.canUndo).toBe(false);
    store.redo();
    expect(store.get(base.id)).toEqual(local);
    store.redo();
    expect(store.get(base.id)).toBeUndefined();
    store.resetOverrides([base.id]);
    expect(store.get(base.id)).toEqual(latest);
  });

  it("does not turn a stale in-flight drag into an edit after a source refresh", () => {
    const base = building("city:one"), latest = updated(base);
    const store = new SceneStore();
    store.replaceSource(source, [base]);
    const drag = store.beginSelectionPreview(base.id);
    drag.move(30, 0);
    store.replaceSource(refreshedSource, [latest]);
    drag.move(60, 0);
    drag.finish(true);
    expect(store.get(base.id)).toEqual(latest);
    expect(store.committedOverrides()).toEqual([]);
    expect(store.canUndo).toBe(false);
  });

  it("pins a moved building and reports a newly mapped part without rendering it at the old location", () => {
    const [first, second] = groupBefore;
    const store = new SceneStore();
    store.replaceSource(source, [first, second]);
    store.execute({ type: "upsert", features: store.transformSelection(first.id, 20, 10, 45, 1.2) });
    const before = store.selectionMembers(first.id);
    store.replaceSource(refreshedSource, [updated(first), updated(second)]);
    expect(store.selectionMembers(first.id)).toEqual(before);
    expect(store.canEditSelection(first.id)).toBe(true);

    const third = groupAfter[2];
    store.replaceSource(refreshedSource, groupAfter);
    expect(store.get(first.id)).toEqual(before[0]);
    expect(store.get(second.id)).toEqual(before[1]);
    expect(store.get(third.id)).toBeUndefined();
    expect(store.canEditSelection(first.id)).toBe(true);
    expect(store.buildingRefreshConflicts()).toEqual([{
      reason: "membership-changed", source: "city", groupId: "relation/100",
      savedMemberIds: [first.id, second.id], incomingMemberIds: groupAfter.map((f) => f.id),
      incomingComplete: true,
    }]);
    store.undo();
    expect(store.canEditSelection(first.id)).toBe(true);
    expect(store.selectionMembers(first.id)).toHaveLength(3);
    expect(store.buildingRefreshConflicts()).toEqual([]);
    store.redo();
    expect(store.get(third.id)).toBeUndefined();
    expect(store.get(first.id)).toEqual(before[0]);
    store.resetOverrides([first.id]);
    expect(store.selectionMembers(first.id)).toEqual(groupAfter);
    expect(store.committedBuildingPins()).toEqual([]);
  });

  it("preserves moved and deleted parts when a compiler corrects their base grouping", () => {
    const regrouped = groupBefore.map((f, index) => {
      const latest = updated(f);
      return { ...latest, properties: { ...latest.properties,
        buildingGroup: `relation/${200 + index}`, buildingGroupMembers: 1 } };
    });
    for (const removed of [false, true]) {
      const store = new SceneStore();
      store.replaceSource(source, groupBefore);
      store.execute(removed
        ? { type: "remove", ids: groupBefore.map(f => f.id) }
        : { type: "upsert", features: store.transformSelection(groupBefore[0].id, 20, 10) });
      const saved = store.exportScenario(), visible = store.values();
      store.replaceSource(refreshedSource, regrouped);
      expect(store.values()).toEqual(visible);
      expect(store.exportScenario()).toBe(saved);
      const restored = new SceneStore();
      restored.importScenario(saved);
      restored.replaceSource(refreshedSource, regrouped);
      expect(restored.values()).toEqual(visible);
      restored.resetOverrides(groupBefore.map(f => f.id));
      expect(restored.values()).toEqual(regrouped);
      expect(restored.selectionMembers(groupBefore[0].id)).toHaveLength(1);
    }
  });

  it("keeps pin metadata through a deleted-building save/restore and releases it on reset", () => {
    let saved: string | null = null;
    const store = new SceneStore();
    const off = connectScenePersistence(store, { load: () => null, save: (value) => { saved = value; } });
    store.replaceSource(source, groupBefore);
    store.execute({ type: "remove", ids: groupBefore.map((f) => f.id) });
    off();
    const copy = new SceneStore();
    connectScenePersistence(copy, { load: () => saved, save: vi.fn() });
    copy.replaceSource(refreshedSource, groupAfter);
    expect(copy.size).toBe(0);
    expect(copy.committedBuildingPins()).toEqual(store.committedBuildingPins());
    expect(copy.buildingRefreshConflicts()).toHaveLength(1);
    copy.resetOverrides([groupBefore[1].id]);
    expect(copy.values()).toEqual(groupAfter);
    copy.undo();
    expect(copy.size).toBe(0);
    expect(copy.committedBuildingPins()).toHaveLength(1);
  });

  it("keeps a custom GLB replacement as the only visible model for its pinned building", () => {
    const store = new SceneStore();
    store.replaceSource(source, groupBefore);
    // Hide the building parts and give the replacement model one part's original ID.
    // The local replacement should stay visible when the provider reloads the building.
    store.execute({ type: "remove", ids: groupBefore.map((f) => f.id) });
    const replacement = {
      ...asset(groupBefore[0].id, "city"),
      model: { ...asset("unused").model!, replacement: groupBefore[0].id },
    };
    store.execute({ type: "upsert", features: [replacement] });
    const copy = new SceneStore();
    copy.importScenario(store.exportScenario());
    copy.replaceSource(refreshedSource, groupAfter);
    expect(copy.values()).toEqual([replacement]);
    expect(copy.buildingRefreshConflicts()).toHaveLength(1);
    copy.resetOverrides([replacement.id]);
    expect(copy.values()).toEqual(groupAfter);
  });

  it("does not confuse streamed-out members with deletion, but reports observed removal", () => {
    const store = new SceneStore();
    store.replaceSource(source, groupBefore);
    store.execute({ type: "upsert", features: store.transformSelection(groupBefore[0].id, 25, 0) });
    const snapshot = store.values();
    store.replaceSource(source, []);
    expect(store.values()).toEqual(snapshot);
    expect(store.buildingRefreshConflicts()).toEqual([]);
    store.replaceSource(source, [groupBefore[0]]);
    expect(store.buildingRefreshConflicts()).toEqual([]);
    store.replaceSource(refreshedSource, [grouped(updated(groupBefore[0]), 1)]);
    expect(store.values()).toEqual(snapshot);
    expect(store.buildingRefreshConflicts()).toEqual([expect.objectContaining({
      incomingMemberIds: [groupBefore[0].id], incomingComplete: true,
    })]);
    store.resetOverrides([groupBefore[0].id]);
    expect(store.get(groupBefore[1].id)).toBeUndefined();
  });

  it("recovers verified complete groups from legacy nondeleted saves, but never guesses legacy tombstone groups", () => {
    const edited = groupBefore.map((f) => transformFeature(f, 10, 0));
    const copy = new SceneStore();
    copy.importScenario(JSON.stringify({ version: 1, overrides: edited.map((f) => [f.id, f]) }));
    copy.replaceSource(refreshedSource, groupAfter);
    expect(copy.values()).toEqual(edited);
    expect(copy.committedBuildingPins()).toHaveLength(1);
    const legacyDeleted = new SceneStore();
    legacyDeleted.importScenario(JSON.stringify({ version: 1, overrides: groupBefore.map((f) => [f.id, null]) }));
    legacyDeleted.replaceSource(refreshedSource, groupAfter);
    expect(legacyDeleted.committedBuildingPins()).toEqual([]);
    expect(legacyDeleted.values()).toEqual([groupAfter[2]]);
  });

  it("persists complete pins in their own partition without erasing another partition", () => {
    let saved: string | null = null;
    const first = new SceneStore();
    first.replaceSource(source, groupBefore);
    const off = connectScenePersistence(first,
      { load: () => null, save: (value) => { saved = value; } },
      { include: (id) => id.startsWith("city:") });
    first.execute({ type: "remove", ids: groupBefore.map((f) => f.id) });
    off();
    const restored = new SceneStore();
    const local = asset("local:kept");
    restored.execute({ type: "upsert", features: [local] });
    connectScenePersistence(restored, { load: () => saved, save: vi.fn() },
      { include: (id) => id.startsWith("city:") });
    restored.replaceSource(refreshedSource, groupAfter);
    expect(restored.values()).toEqual([local]);
    expect(restored.committedBuildingPins()).toHaveLength(1);
    const save = vi.fn(), onError = vi.fn();
    const detach = connectScenePersistence(restored, { load: () => null, save },
      { include: (id) => id === groupBefore[0].id, onError });
    restored.execute({ type: "upsert", features: [{ ...local, label: "Renamed" }] });
    expect(save).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    detach();
  });
});
