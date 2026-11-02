/**
 * @file tests/geo.test.ts
 * @brief Test geographic scene data and how edits affect it.
 * @author Norman
 * @description Covers validation, source refreshes, history, coordinate transforms and provider adapters.
 */

import { describe, expect, it } from "vitest";
import { SceneStore } from "@upsight/map-renderer/geo/SceneStore";
import { fromGeoJSON } from "@upsight/map-renderer";
import { distance, localFrame, transformFeature } from "@upsight/map-renderer/geo/math";
import { DEFAULT_STYLE, type GeoFeature } from "@upsight/map-renderer/geo/types";
import { validateFeature } from "@upsight/map-renderer/geo/validation";
const marker = (id = "provider:a", lon = 103.85, lat = 1.28): GeoFeature => ({
  id,
  source: "provider",
  layer: "chargers",
  label: id,
  geometry: { type: "Point", coordinates: [lon, lat] },
  style: DEFAULT_STYLE,
  properties: { count: 1 },
});
const info = {
  id: "provider",
  label: "Provider",
  status: "live" as const,
  attribution: "Test",
};

describe("geographic scene contracts", () => {
  it("accepts multiple hemispheres and preserves local metre distances", () => {
    for (const p of [
      [103.85, 1.28],
      [2.16, 41.39],
      [-73.98, 40.75],
      [151.2, -33.8],
    ] as const) {
      const f = localFrame(p),
        q = f.unproject(10, 20),
        local = f.project(q);
      expect(local[0]).toBeCloseTo(10, 5);
      expect(local[1]).toBeCloseTo(20, 5);
      expect(distance(p, q)).toBeCloseTo(Math.hypot(10, 20), 0);
      expect(validateFeature(marker("a", ...p)).geometry.coordinates).toEqual(
        p,
      );
    }
  });
  it("rejects invalid geometry atomically without consuming a revision or undo step", () => {
    const store = new SceneStore();
    store.replaceSource(info, [marker()]);
    const revision = store.revision;
    expect(() =>
      store.execute({
        type: "upsert",
        features: [
          { ...marker(), geometry: { type: "Point", coordinates: [999, 1] } },
        ],
      }),
    ).toThrow();
    expect(store.revision).toBe(revision);
    expect(store.canUndo).toBe(false);
    expect(store.size).toBe(1);
  });
  it("keeps source refreshes out of undo history and restores the newest base on undo", () => {
    const store = new SceneStore();
    store.replaceSource(info, [marker()]);
    store.execute({
      type: "upsert",
      features: [{ ...marker(), style: { ...DEFAULT_STYLE, height: 30 } }],
    });
    store.replaceSource(info, [{ ...marker(), label: "Updated provider" }]);
    expect(store.get("provider:a")!.style.height).toBe(30);
    store.undo();
    expect(store.get("provider:a")!.label).toBe("Updated provider");
    store.redo();
    expect(store.get("provider:a")!.style.height).toBe(30);
    store.execute({ type: "remove", ids: ["provider:a"] });
    store.replaceSource(info, [marker()]);
    expect(store.size).toBe(0);
    store.undo();
    expect(store.size).toBe(1);
  });
  it("copies and freezes accepted data, exports overrides and restores removals", () => {
    const store = new SceneStore(),
      f = marker();
    store.replaceSource(info, [f]);
    expect(store.get(f.id)).not.toBe(f);
    expect(Object.isFrozen(store.get(f.id)!.style)).toBe(true);
    store.execute({ type: "remove", ids: [f.id] });
    const next = new SceneStore();
    next.replaceSource(info, [f]);
    next.importScenario(store.exportScenario());
    expect(next.size).toBe(0);
    next.undo();
    expect(next.size).toBe(1);
    expect(() =>
      next.importScenario('{"version":1,"overrides":[["x",{}]]}'),
    ).toThrow();
    expect(next.size).toBe(1);
  });
  it("namespaces GeoJSON IDs, splits multi-geometries, and retains polygon holes", () => {
    const source = fromGeoJSON({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: 7,
          properties: { name: "District", height: 18 },
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [2, 41],
                [2.01, 41],
                [2.01, 41.01],
                [2, 41.01],
                [2, 41],
              ],
              [
                [2.002, 41.002],
                [2.004, 41.002],
                [2.004, 41.004],
                [2.002, 41.004],
                [2.002, 41.002],
              ],
            ],
          },
        },
        {
          type: "Feature",
          id: 8,
          properties: {},
          geometry: {
            type: "MultiPoint",
            coordinates: [
              [2, 41],
              [2.001, 41],
            ],
          },
        },
      ],
    });
    expect(source.features).toHaveLength(3);
    expect(source.features[0].id).toBe("imported:7:0");
    expect(source.features[0].geometry.coordinates).toHaveLength(2);
    expect(() =>
      fromGeoJSON({
        type: "Feature",
        geometry: { type: "GeometryCollection" },
      }),
    ).toThrow(/unsupported/);
  });
  it("rejects self intersections, intersecting holes, polar and dateline geometry", () => {
    const polygon = (coordinates: unknown) =>
      fromGeoJSON({
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates },
      });
    expect(() =>
      polygon([
        [
          [0, 0],
          [1, 1],
          [0, 1],
          [1, 0],
        ],
      ]),
    ).toThrow();
    expect(() =>
      polygon([
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
        [
          [0.5, 0.5],
          [1.1, 0.5],
          [0.5, 0.8],
        ],
      ]),
    ).toThrow();
    expect(() => validateFeature(marker("a", 0, 86))).toThrow();
    expect(() =>
      fromGeoJSON({
        type: "Feature",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: [
            [179, 0],
            [-179, 0],
          ],
        },
      }),
    ).toThrow(/antimeridian/);
  });
  it("transforms scenario objects in metres without modifying the original", () => {
    const f = marker(),
      moved = transformFeature(f, 20, 0);
    expect(f.geometry.coordinates).toEqual([103.85, 1.28]);
    expect(
      distance(
        f.geometry.coordinates as [number, number],
        moved.geometry.coordinates as [number, number],
      ),
    ).toBeCloseTo(20, 0);
  });

});
