/**
 * @file tests/buildingGroups.test.ts
 * @brief Test how building parts are grouped, moved, resized and restored in one undo.
 * @author Norman
 */
import { expect, it } from "vitest";
import { SceneStore } from "@upsight/map-renderer/geo/SceneStore";
import { DEFAULT_STYLE, type GeoFeature } from "@upsight/map-renderer/geo/types";
import { localFrame, pointsOf } from "@upsight/map-renderer/geo/math";
import { resizeBuildingHeight } from "@upsight/map-renderer/geo/buildingGroups";
const frame = localFrame([103.85, 1.3]);
const source = {
  id: "city",
  label: "OSM",
  status: "snapshot" as const,
  attribution: "OSM",
};
function part(id: string, x: number, height = 20, elevation = 0): GeoFeature {
  return {
    id,
    source: "city",
    layer: "buildings",
    label: "Test building",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [x, 0],
          [x + 10, 0],
          [x + 10, 10],
          [x, 10],
        ].map(([x, z]) => frame.unproject(x, z)),
      ],
    },
    model: {
      kind: "building",
      roof: { shape: "gabled", height: 2, color: "#aabbcc" },
    },
    style: { ...DEFAULT_STYLE, height, elevation },
    properties: {
      buildingGroup: "relation/10",
      buildingGroupBasis: "OSM building relation",
      buildingGroupMembers: 2,
    },
  };
}
const first = part("part:a", 0),
  second = part("part:b", 10, 10, 10);
function setup() {
  const store = new SceneStore();
  store.replaceSource(source, [first, second]);
  return store;
}
it("selects mapped parts as one entity but never merges nearby buildings by appearance", () => {
  const store = setup();
  store.replaceSource(source, [
    first,
    second,
    {
      ...part("other", 22),
      properties: {
        buildingGroup: "relation/11",
        buildingGroupBasis: "OSM building relation",
        buildingGroupMembers: 1,
      },
    },
  ]);
  expect(store.selectionMembers(first.id).map((f) => f.id)).toEqual([
    first.id,
    second.id,
  ]);
  expect(store.building(first.id)?.complete).toBe(true);
  expect(store.selectionMembers("other")).toHaveLength(1);
  const unverified = {
    ...part("tile", 30),
    properties: { buildingGroup: "relation/10" },
  };
  store.execute({ type: "upsert", features: [unverified] });
  expect(store.selectionMembers(unverified.id)).toHaveLength(1);
});
it("rotates all parts about one pivot without opening seams or losing vertical clearances", () => {
  const store = setup();
  const moved = store.transformSelection(first.id, 40, 20, 90, 2);
  const sharedA = pointsOf(moved[0].geometry)[1],
    sharedB = pointsOf(moved[1].geometry)[0];
  expect(sharedA[0]).toBeCloseTo(sharedB[0], 10);
  expect(sharedA[1]).toBeCloseTo(sharedB[1], 10);
  expect(moved[1].style.elevation).toBe(20);
  expect(moved[1].style.height).toBe(20);
  expect(moved[1].model?.roof?.height).toBe(4);
  store.execute({ type: "upsert", features: moved });
  store.undo();
  expect(store.get(first.id)?.geometry).toEqual(first.geometry);
  expect(store.get(second.id)?.geometry).toEqual(second.geometry);
});
it("resizes height proportionally rather than filling an elevated part's opening", () => {
  const changed = resizeBuildingHeight([first, second], 40);
  expect(changed[0].style.height).toBe(40);
  expect(changed[1].style.elevation).toBe(20);
  expect(changed[1].style.height).toBe(20);
});
it("commits an entire group drag as one undo and retains it across source refreshes and export", () => {
  const store = setup(),
    original = store.exportScenario();
  const preview = store.beginSelectionPreview(first.id);
  preview.move(5, 0);
  preview.move(15, 0);
  expect(store.exportScenario()).toBe(original);
  expect(
    frame.project(pointsOf(store.get(second.id)!.geometry)[0])[0],
  ).toBeCloseTo(25, 4);
  preview.finish(true);
  store.replaceSource(source, [first, second]);
  expect(
    frame.project(pointsOf(store.get(second.id)!.geometry)[0])[0],
  ).toBeCloseTo(25, 4);
  const copy = setup();
  copy.importScenario(store.exportScenario());
  expect(copy.get(second.id)?.geometry).toEqual(store.get(second.id)?.geometry);
  store.undo();
  expect(store.exportScenario()).toBe(original);
  store.redo();
  expect(store.get(second.id)?.geometry).toEqual(copy.get(second.id)?.geometry);
});
it("blocks partial, protected and invalid group edits without leaving a half-edited building", () => {
  const store = new SceneStore();
  store.replaceSource(source, [first]);
  expect(store.building(first.id)?.complete).toBe(false);
  expect(() => store.beginSelectionPreview(first.id)).toThrow(
    "complete building",
  );
  store.replaceSource(source, [first, second]);
  const before = store.exportScenario();
  const preview = store.beginSelectionPreview(first.id);
  preview.move(5, 0);
  preview.finish(false);
  expect(store.exportScenario()).toBe(before);
  const invalid = store.transformSelection(first.id, 1, 0);
  expect(() =>
    store.execute({
      type: "upsert",
      features: [
        invalid[0],
        { ...invalid[1], style: { ...invalid[1].style, height: -1 } },
      ],
    }),
  ).toThrow();
  expect(store.exportScenario()).toBe(before);
  const protectedStore = new SceneStore({ readOnlyIds: [second.id] });
  protectedStore.replaceSource(source, [first, second]);
  expect(() => protectedStore.requireSelection(first.id)).toThrow();
});
it("removes and restores all parts together and cancels stale drags during refresh", () => {
  const store = setup(),
    preview = store.beginSelectionPreview(first.id);
  preview.move(5, 0);
  store.replaceSource(source, [first, second]);
  preview.finish(true);
  expect(store.canUndo).toBe(false);
  store.execute({
    type: "remove",
    ids: store.requireSelection(first.id).map((f) => f.id),
  });
  store.replaceSource(source, [first, second]);
  expect(store.size).toBe(0);
  store.undo();
  expect(store.selectionMembers(first.id)).toHaveLength(2);
});
