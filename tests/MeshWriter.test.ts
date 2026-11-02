/**
 * @file tests/MeshWriter.test.ts
 * @brief Test that floors with the same footprint can reuse its triangles.
 * @author Norman
 * @description Counts triangulations and checks holes, vertex order, edits to the footprint and each floor's appearance and ID.
 */
import { afterEach, expect, it, vi } from "vitest";
import earcut from "earcut";
import { MeshWriter, type V2, type RGB } from "@upsight/map-renderer/rendering/models/MeshWriter";
import { buildGeometry } from "@upsight/map-renderer/rendering/geometry";
import { DEFAULT_STYLE, type GeoFeature } from "@upsight/map-renderer/geo/types";
import { localFrame } from "@upsight/map-renderer/geo/math";

vi.mock("earcut", async (importOriginal) => {
  const actual = await importOriginal<typeof import("earcut")>();
  return { ...actual, default: vi.fn(actual.default) };
});
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

const clone = (rings: readonly (readonly V2[])[]) => rings.map((ring) => ring.map(([x, z]) => [x, z] as V2));
const courtyard = (): V2[][] => [
  [[0, 0], [40, 0], [40, 15], [25, 15], [25, 30], [0, 30]],
  [[5, 5], [5, 10], [10, 10], [10, 5]],
];

it("triangulates a repeated concave courtyard once while each cap keeps its own height, color, material and identity", () => {
  const rings = courtyard(), cached = new MeshWriter(), reference = new MeshWriter();
  const caps = Array.from({ length: 12 }, (_, i) => ({
    y: i * 3.2, color: [0.2 + i * 0.02, 0.4, 0.5] as RGB, material: i % 5,
  }));
  for (const [i, cap] of caps.entries()) {
    cached.id = `floor:${i}`;
    cached.key = i + 10;
    cached.polygon(rings, cap.y, cap.color, cap.material);
  }
  expect(earcut).toHaveBeenCalledTimes(1);
  vi.mocked(earcut).mockClear();
  for (const [i, cap] of caps.entries()) {
    reference.id = `floor:${i}`;
    reference.key = i + 10;
    reference.polygon(clone(rings), cap.y, cap.color, cap.material);
  }
  expect(earcut).toHaveBeenCalledTimes(12);
  expect(cached.finish()).toEqual(reference.finish());
});

it("reduces real parking-deck triangulation work while producing byte-identical mesh buffers", () => {
  const origin = [103.85, 1.28] as const, frame = localFrame(origin);
  const feature: GeoFeature = {
    id: "test:parking", source: "test", layer: "buildings", label: "Parking",
    geometry: { type: "Polygon", coordinates: courtyard().map((ring) => ring.map(([x, z]) => frame.unproject(x, z))) },
    style: { ...DEFAULT_STYLE, height: 38.4, elevation: 0 },
    model: { kind: "building", family: "parking" }, properties: { levels: 12 },
  };
  const optimized = buildGeometry([feature], origin, () => 1, 1);
  const cachedCalls = vi.mocked(earcut).mock.calls.length;
  vi.mocked(earcut).mockClear();
  const polygon = MeshWriter.prototype.polygon;
  vi.spyOn(MeshWriter.prototype, "polygon").mockImplementation(function (this: MeshWriter, rings, y, color, material) {
    // Copy the rings for each cap so the reference build triangulates the same footprint from scratch.
    return polygon.call(this, clone(rings), y, color, material);
  });
  const reference = buildGeometry([feature], origin, () => 1, 1);
  const uncachedCalls = vi.mocked(earcut).mock.calls.length;
  expect(uncachedCalls - cachedCalls).toBe(12); // Twelve decks plus the roof share one triangulation.
  expect(optimized).toEqual(reference);
  console.info("Parking cap triangulation workload", {
    uncachedCalls, cachedCalls, repeatedFootprintCalls: { before: 13, after: 1 },
    triangles: optimized.indices.length / 3,
  });
});

it("invalidates cached topology after coordinate, winding or hole-layout changes on a mutable caller", () => {
  const rings = courtyard(), cached = new MeshWriter(), reference = new MeshWriter();
  const cap = () => {
    cached.polygon(rings, 5, [1, 0, 0], 4);
    reference.polygon(clone(rings), 5, [1, 0, 0], 4);
  };
  cap();
  rings[0][1] = [45, 0];
  cap();
  rings[0].reverse();
  rings[1].reverse();
  cap();
  rings.push([[15, 5], [15, 10], [20, 10], [20, 5]]);
  cap();
  expect(earcut).toHaveBeenCalledTimes(8);
  expect(cached.finish()).toEqual(reference.finish());
});

it.each(([[], [[]], [[[0, 0], [1, 0], [2, 0]]]] as V2[][][]).map((rings) => ({ rings })))(
  "preserves empty and degenerate polygon behavior when repeated",
  ({ rings }) => {
    const cached = new MeshWriter(), reference = new MeshWriter();
    for (let i = 0; i < 2; i++) {
      cached.polygon(rings, i, [1, 1, 1]);
      reference.polygon(clone(rings), i, [1, 1, 1]);
    }
    expect(cached.finish()).toEqual(reference.finish());
    expect(cached.finish().indices).toHaveLength(0);
  },
);
