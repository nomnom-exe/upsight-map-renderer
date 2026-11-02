/**
 * @file tests/rendering.test.ts
 * @brief Test how the renderer groups nearby features and builds their meshes.
 * @author Norman
 * @description Checks search results, updates after an edit, triangles in a polygon with a hole and the feature IDs attached to those triangles.
 */

import { expect, it } from "vitest";
import { SpatialIndex } from "@upsight/map-renderer/rendering/SpatialIndex";
import { BatchIndex } from "@upsight/map-renderer/rendering/BatchIndex";
import { buildGeometry } from "@upsight/map-renderer/rendering/geometry";
import { SceneStore } from "@upsight/map-renderer/geo/SceneStore";
import { extentOf, featureExtent, geometryExtent, intersects, localFrame, pointsOf, transformFeature } from "@upsight/map-renderer/geo/math";
import { DEFAULT_STYLE, type GeoFeature, type Geometry } from "@upsight/map-renderer/geo/types";
import { fromGeoJSON } from "@upsight/map-renderer";

it("spatial query equals brute force, including long extents and deletion", () => {
  const index = new SpatialIndex(),
    records = Array.from({ length: 300 }, (_, i) => ({
      west: 2 + i * 0.001,
      east: 2 + i * 0.001 + 0.004,
      south: 41,
      north: 41.003,
    }));
  records[2] = { west: 1, east: 4, south: 40, north: 42 };
  records.forEach((b, i) => index.set(String(i), b));
  for (let j = 0; j < 20; j++) {
    const q = {
      west: 2 + j * 0.013,
      east: 2.02 + j * 0.013,
      south: 40.99,
      north: 41.001,
    };
    expect(index.query(q).sort()).toEqual(
      records.flatMap((b, i) => (intersects(b, q) ? [String(i)] : [])).sort(),
    );
  }
  index.delete("2");
  expect(index.query({ west: 1, east: 4, south: 40, north: 42 })).not.toContain(
    "2",
  );
});
it("only increments affected spatial batch versions", () => {
  const store = new SceneStore(),
    index = new BatchIndex();
  const f = (id: string, lon: number): GeoFeature => ({
    id,
    source: "x",
    layer: "scenario",
    label: id,
    geometry: { type: "Point", coordinates: [lon, 41] },
    style: DEFAULT_STYLE,
    properties: {},
  });
  store.replaceSource(
    { id: "x", label: "X", status: "local", attribution: "" },
    [f("a", 2), f("b", 3)],
  );
  index.sync(store, ["a", "b"]);
  const untouched = [...index.batches.values()].find((b) =>
    b.features.has("b"),
  )!;
  const version = untouched.version;
  store.execute({
    type: "upsert",
    features: [{ ...f("a", 2), style: { ...DEFAULT_STYLE, height: 20 } }],
  });
  expect(index.sync(store, ["a"]).size).toBe(1);
  expect(untouched.version).toBe(version);
});
it("preserves raw bounds and latitude-aware padding for points, lines and polygon rings", () => {
  const geometries: Geometry[] = [
    { type: "Point", coordinates: [103.85, 1.28] },
    { type: "LineString", coordinates: [[103.85, 1.28], [103.86, 1.285], [103.853, 1.29]] },
    { type: "Polygon", coordinates: [
      [[2, 41], [2.01, 41], [2.01, 41.01], [2, 41.01], [2, 41]],
      [[2.002, 41.002], [2.002, 41.004], [2.004, 41.004], [2.004, 41.002], [2.002, 41.002]],
    ] },
  ];
  for (const geometry of geometries) {
    const f: GeoFeature = { id: "bounds", source: "x", layer: "scenario", label: "Bounds",
      geometry, style: { ...DEFAULT_STYLE, width: 12, radius: 7 }, properties: {} };
    const old = extentOf(pointsOf(geometry)), pad = 12 / 111000;
    const lonPad = pad / Math.cos(Math.max(Math.abs(old.south), Math.abs(old.north)) * Math.PI / 180);
    expect(geometryExtent(geometry)).toEqual(old);
    expect(featureExtent(f)).toEqual({ west: old.west - lonPad, east: old.east + lonPad,
      south: old.south - pad, north: old.north + pad });
    expect(featureExtent(f, old)).toEqual(featureExtent(f));
  }
});
it("refreshes cached bounds after width and translation edits without moving the batch for padding alone", () => {
  const store = new SceneStore(), index = new BatchIndex();
  const f: GeoFeature = { id: "bounds", source: "x", layer: "scenario", label: "Bounds",
    geometry: { type: "Polygon", coordinates: [[[103.85, 1.28], [103.8501, 1.28],
      [103.8501, 1.2801], [103.85, 1.2801], [103.85, 1.28]]] },
    style: { ...DEFAULT_STYLE, width: 1, radius: 1 }, properties: {} };
  store.replaceSource({ id: "x", label: "X", status: "local", attribution: "" }, [f]);
  index.sync(store, [f.id]);
  const original = [...index.batches.values()][0], oldExtent = { ...original.extent };
  const outside = { west: oldExtent.east + .0001, east: oldExtent.east + .0002,
    south: oldExtent.south, north: oldExtent.north };
  expect(index.spatial.query(outside)).toEqual([]);
  store.execute({ type: "upsert", features: [{ ...store.get(f.id)!, style: { ...f.style, width: 80 } }] });
  index.sync(store, [f.id]);
  expect([...index.batches.keys()]).toEqual([original.id]);
  expect(original.extent).toEqual(featureExtent(store.get(f.id)!));
  expect(index.spatial.query(outside)).toEqual([original.id]);
  store.execute({ type: "upsert", features: [transformFeature(store.get(f.id)!, 2000, 1200)] });
  index.sync(store, [f.id]);
  const moved = [...index.batches.values()][0];
  expect(moved.id).not.toBe(original.id);
  expect(index.batches.has(original.id)).toBe(false);
  expect(index.spatial.query(oldExtent)).toEqual([]);
  expect(moved.extent).toEqual(featureExtent(store.get(f.id)!));
  expect(index.spatial.query(moved.extent)).toEqual([moved.id]);
});
it("queries the visible edge of a variable-width ribbon and scales its profile with an edit", () => {
  const origin = [103.85, 1.3] as const, frame = localFrame(origin);
  const feature: GeoFeature = { id: "route", source: "test", layer: "route", label: "Route",
    geometry: { type: "LineString", coordinates: [frame.unproject(0, 0), frame.unproject(100, 0)] },
    model: { kind: "line", line: { widths: [12, 20], elevations: [7, 8] } },
    style: { ...DEFAULT_STYLE, width: 1, radius: 1 }, properties: {} };
  const store = new SceneStore(), index = new BatchIndex();
  store.execute({ type: "upsert", features: [feature] });
  index.sync(store, [feature.id]);
  const bounds = extentOf([frame.unproject(70, 6), frame.unproject(80, 7)]);
  expect(index.spatial.query(bounds)).toHaveLength(1);
  const scaled = transformFeature(feature, 0, 0, 0, 2);
  expect(scaled.model?.line).toEqual({ widths: [24, 40], elevations: [7, 8] });
  const mesh = buildGeometry([scaled], origin, () => 1, 0);
  expect(mesh.positions[2]).toBeCloseTo(-12);
  expect(mesh.positions[8]).toBeCloseTo(-20);
});
it("partitions a dense cell into builds that fit the mobile triangle budget and preserves shard membership on edits", () => {
  const origin = [103.85, 1.3] as const;
  const features: GeoFeature[] = Array.from({ length: 2308 }, (_, i) => ({
    id: `tree:${i}`, source: "forest", layer: "landscape", label: "Tree",
    geometry: { type: "Point", coordinates: origin }, model: { kind: "tree" },
    style: { ...DEFAULT_STYLE, height: 10 }, properties: {},
  }));
  const store = new SceneStore(), index = new BatchIndex();
  store.replaceSource({ id: "forest", label: "Forest", status: "snapshot", attribution: "" }, features);
  index.sync(store, features.map(f => f.id));
  const triangles = buildGeometry([features[0]], origin, () => 1, 1).indices.length / 3;
  expect(triangles * features.length).toBeGreaterThan(300000);
  expect(index.batches.size).toBeGreaterThan(1);
  expect([...index.batches.values()].every(b => b.features.size * triangles <= 300000)).toBe(true);
  expect([...index.batches.values()].reduce((n, b) => n + b.features.size, 0)).toBe(features.length);
  const last = features.at(-1)!;
  const shard = [...index.batches.values()].find(b => b.features.has(last.id))!;
  store.execute({ type: "upsert", features: [{ ...last, label: "Edited tree" }] });
  expect([...index.sync(store, [last.id])]).toEqual([shard.id]);
  expect(shard.features.get(last.id)?.label).toBe("Edited tree");
});
it("encodes broad dashed overlays separately from subpixel lane paint", () => {
  const origin = [103.85, 1.3] as const, frame = localFrame(origin);
  const f: GeoFeature = { id: "traffic", source: "test", layer: "custom:traffic", label: "Traffic",
    geometry: { type: "LineString", coordinates: [origin, frame.unproject(100, 0)] },
    model: { kind: "line", line: { dashed: true } }, style: { ...DEFAULT_STYLE, width: 2.5 }, properties: {} };
  const materials = (f: GeoFeature) => {
    const data = buildGeometry([f], origin, () => 1, 1);
    return new Set(data.surface!.filter((_, i) => i % 3 === 2));
  };
  expect(materials(f)).toEqual(new Set([0, 13]));
  expect(materials({ ...f, model: { kind: "road", road: { lanes: 2, footway: false, paved: true, sidewalk: false } } })).toContain(5);
});
it("triangulates a concave polygon with a hole and conserves area", () => {
  const origin = [2, 41] as const,
    frame = localFrame(origin),
    p = (x: number, z: number) => frame.unproject(x, z);
  const outer = [
      p(0, 0),
      p(100, 0),
      p(100, 50),
      p(50, 50),
      p(50, 100),
      p(0, 100),
    ],
    hole = [p(10, 10), p(20, 10), p(20, 20), p(10, 20)];
  const source = fromGeoJSON({
    type: "Feature",
    properties: { height: 0 },
    geometry: { type: "Polygon", coordinates: [outer, hole] },
  });
  const data = buildGeometry(source.features, origin, () => 1, 1);
  let area = 0;
  for (let i = 0; i < data.indices.length; i += 3) {
    const [a, b, c] = [0, 1, 2].map((n) => data.indices[i + n] * 3);
    area +=
      Math.abs(
        (data.positions[b] - data.positions[a]) *
          (data.positions[c + 2] - data.positions[a + 2]) -
          (data.positions[c] - data.positions[a]) *
            (data.positions[b + 2] - data.positions[a + 2]),
      ) / 2;
  }
  expect(area).toBeCloseTo(7400, 1);
  expect(data.faceIds).toHaveLength(data.indices.length / 3);
  expect(Math.max(...data.indices)).toBeLessThan(data.positions.length / 3);
});
it("far detail submits fewer marker triangles with stable feature identity", () => {
  const f: GeoFeature = {
    id: "m",
    source: "x",
    layer: "scenario",
    label: "M",
    geometry: { type: "Point", coordinates: [2, 41] },
    style: DEFAULT_STYLE,
    properties: {},
  };
  const near = buildGeometry([f], [2, 41], () => 7, 1),
    far = buildGeometry([f], [2, 41], () => 7, 0);
  expect(far.indices.length).toBeLessThan(near.indices.length);
  expect(new Set(near.faceIds)).toEqual(new Set(["m"]));
  expect(new Set(near.keys)).toEqual(new Set([7]));
});
