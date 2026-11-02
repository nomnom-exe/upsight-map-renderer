/**
 * @file tests/ScenePreview.test.ts
 * @brief Test how drag previews affect undo history and saved scene data.
 * @author Norman
 */
import { expect, it } from "vitest";
import { SceneStore } from "@upsight/map-renderer/geo/SceneStore";
import { DEFAULT_STYLE, type GeoFeature } from "@upsight/map-renderer/geo/types";
const object: GeoFeature = {
  id: "test:one",
  source: "test",
  layer: "buildings",
  label: "Building",
  geometry: { type: "Point", coordinates: [103.8, 1.3] },
  style: DEFAULT_STYLE,
  properties: {},
};
const moved = {
  ...object,
  geometry: {
    type: "Point" as const,
    coordinates: [103.81, 1.31] as [number, number],
  },
};
function setup() {
  const store = new SceneStore();
  store.execute({ type: "upsert", features: [object] });
  return store;
}
it("renders previews but exports committed data; one undo reverses the whole drag", () => {
  const store = setup(),
    before = store.exportScenario();
  const edit = store.beginPreview(object.id);
  edit.update(moved);
  edit.update({ ...moved, label: "Moved" });
  expect(store.get(object.id)?.label).toBe("Moved");
  expect(store.exportScenario()).toBe(before);
  edit.finish(true);
  store.undo();
  expect(store.exportScenario()).toBe(before);
  store.redo();
  expect(store.get(object.id)?.label).toBe("Moved");
});
it("cancels without a history entry and ignores stale drag callbacks", () => {
  const store = setup(),
    before = store.exportScenario();
  const edit = store.beginPreview(object.id);
  edit.update(moved);
  edit.finish(false);
  expect(store.get(object.id)?.geometry).toEqual(object.geometry);
  expect(store.exportScenario()).toBe(before);
  edit.update(moved);
  edit.finish(true);
  store.undo();
  expect(store.size).toBe(0);
});
it("does not let a stale drag overwrite a concurrent edit or removal", () => {
  const store = setup(),
    edit = store.beginPreview(object.id);
  edit.update(moved);
  store.execute({ type: "remove", ids: [object.id] });
  edit.finish(true);
  expect(store.get(object.id)).toBeUndefined();
  store.undo();
  expect(store.get(object.id)?.geometry).toEqual(object.geometry);
});
it("rejects protected objects and mismatched preview IDs", () => {
  expect(() =>
    new SceneStore({ readOnlyIds: [object.id] }).beginPreview(object.id),
  ).toThrow();
  const store = setup(),
    edit = store.beginPreview(object.id);
  expect(() => edit.update({ ...moved, id: "test:other" })).toThrow();
  edit.finish(false);
});
