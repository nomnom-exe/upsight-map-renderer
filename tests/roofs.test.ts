/** @file tests/roofs.test.ts @brief Test roof shapes, courtyard openings, slope directions and what gets drawn when roof data is incomplete. @author Norman */
import { expect, it } from "vitest";
import { planRoof } from "../src/rendering/models/roofs";
import { building } from "../src/rendering/models/building";
import { MeshWriter, type V2 } from "../src/rendering/models/MeshWriter";
import { DEFAULT_STYLE, type GeoFeature, type ModelStyle } from "../src/geo/types";
import { localFrame, transformFeature } from "../src/geo/math";
import { validateFeature } from "../src/geo/validation";
const rectangle: readonly V2[] = [[0, 0], [20, 0], [20, 10], [0, 10]];
const roof = (shape: NonNullable<ModelStyle["roof"]>["shape"], direction?: number) => ({ shape, height: 3, color: "#aabbcc", ...(direction !== undefined ? { direction } : {}) });
const area = (triangles: NonNullable<ReturnType<typeof planRoof>>["triangles"]) => triangles.reduce((sum, [a, b, c]) => sum + Math.abs((b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0])) / 2, 0);

it("keeps a skillion plane's courtyard completely open and follows downhill compass direction", () => {
  const hole: readonly V2[] = [[6, 3], [14, 3], [14, 7], [6, 7]];
  const plan = planRoof([rectangle, hole], roof("skillion", 0), 12)!;
  expect(area(plan.triangles)).toBeCloseTo(168, 8);
  expect(plan.boundaryHeight([0, 0])).toBe(12);
  expect(plan.boundaryHeight([0, 10])).toBe(9);
  for (const triangle of plan.triangles) {
    const x = triangle.reduce((sum, p) => sum + p[0], 0) / 3;
    const z = triangle.reduce((sum, p) => sum + p[2], 0) / 3;
    expect(x > 6 && x < 14 && z > 3 && z < 7).toBe(false);
    for (const [px, y, pz] of triangle) {
      expect(y).toBeCloseTo(12 - pz * 0.3, 8);
      expect(px).toBeGreaterThanOrEqual(0);
    }
  }
});

it("preserves a concave skillion footprint without bridging its inward corner", () => {
  const l: readonly V2[] = [[0, 0], [20, 0], [20, 4], [4, 4], [4, 10], [0, 10]];
  const plan = planRoof([l], roof("skillion", 90), 12)!;
  expect(area(plan.triangles)).toBeCloseTo(104, 8);
  for (const triangle of plan.triangles) {
    const x = triangle.reduce((sum, p) => sum + p[0], 0) / 3;
    const z = triangle.reduce((sum, p) => sum + p[2], 0) / 3;
    expect(x > 4 && z > 4).toBe(false);
  }
});

it("supports mapped gables with redundant edge vertices and aligns the ridge perpendicular to the slope", () => {
  const ring: readonly V2[] = [[0, 0], [8, 0], [20, 0], [20, 10], [7, 10], [0, 10]];
  const north = planRoof([ring], roof("gabled", 0), 12)!;
  expect(area(north.triangles)).toBeCloseTo(200);
  const ridge = north.triangles.flat().filter(p => p[1] === 12);
  expect(ridge.every(p => p[2] === 5)).toBe(true);
  const east = planRoof([ring], roof("gabled", 90), 12)!;
  expect(east.triangles.flat().filter(p => p[1] === 12).every(p => p[0] === 10)).toBe(true);
  expect(north.splitEdge([0, 0], [0, 10])).toEqual([[0, 0], [0, 5], [0, 10]]);
});

it("supports convex pyramidal roofs without extending beyond the mapped footprint", () => {
  const triangle: readonly V2[] = [[0, 0], [20, 0], [0, 10]];
  const plan = planRoof([triangle], roof("pyramidal"), 12)!;
  expect(area(plan.triangles)).toBeCloseTo(100);
  for (const [x, y, z] of plan.triangles.flat()) {
    expect(x / 20 + z / 10).toBeLessThanOrEqual(1.000001);
    expect(y).toBeGreaterThanOrEqual(9); expect(y).toBeLessThanOrEqual(12);
  }
});

it("closes near-rectangular gable ends without raising the long eave edges", () => {
  const skew: readonly V2[] = [[0, 0], [20, 0], [20.2, 10], [0.2, 10]];
  const plan = planRoof([skew], roof("gabled", 0), 12)!;
  for (const p of skew) expect(plan.boundaryHeight(p)).toBeCloseTo(9, 8);
  expect(plan.boundaryHeight([10, 0])).toBe(9);
  expect(plan.boundaryHeight([0.1, 5])).toBe(12);
  expect(plan.boundaryHeight([20.1, 5])).toBe(12);
  expect(plan.splitEdge(skew[1], skew[2])).toEqual([skew[1], [20.1, 5], skew[2]]);
});

it("does not invent missing dimensions, skillion directions or complex gabled/hipped ridge layouts", () => {
  const l: readonly V2[] = [[0, 0], [20, 0], [20, 4], [4, 4], [4, 10], [0, 10]];
  expect(planRoof([rectangle], roof("skillion"), 12)).toBeUndefined();
  expect(planRoof([rectangle], { ...roof("gabled"), height: 0 }, 12)).toBeUndefined();
  expect(planRoof([rectangle], roof("flat"), 12)).toBeUndefined();
  for (const shape of ["gabled", "hipped", "pyramidal"] as const) {
    expect(planRoof([l], roof(shape, 0), 12)).toBeUndefined();
    expect(planRoof([rectangle, [[4, 2], [8, 2], [8, 4], [4, 4]]], roof(shape, 0), 12)).toBeUndefined();
  }
  expect(planRoof([[[0, 0], [10, 0], [10, 10], [0, 10]]], roof("gabled"), 12)).toBeUndefined();
});

function model(family: ModelStyle["family"]): GeoFeature {
  return { id: "test:roof", source: "test", layer: "buildings", label: "Mapped roof", geometry: { type: "Polygon", coordinates: [rectangle] },
    style: { ...DEFAULT_STYLE, height: 8, elevation: 4 }, model: { kind: "building", family, roof: roof("gabled", 0) }, properties: {} };
}
it("draws a mapped canopy as a thin pitched shell and retains its open passage", () => {
  const writer = new MeshWriter(); writer.id = "test:roof";
  building(writer, [rectangle], { ...model("canopy"), model: { ...model("canopy").model!, omitSupports: [0, 1, 2, 3] } }, 1);
  const mesh = writer.finish();
  const heights = Array.from(mesh.positions).filter((_, index) => index % 3 === 1);
  expect(Math.min(...heights)).toBeCloseTo(8.75);
  expect(Math.max(...heights)).toBe(12);
  expect(heights).toContain(11.75);
});
it("keeps a parking roof pitched while decks and supports end below its mapped eaves", () => {
  const writer = new MeshWriter(); writer.id = "test:roof";
  building(writer, [rectangle], model("parking"), 1);
  const mesh = writer.finish();
  expect(Array.from(mesh.positions).filter((_, index) => index % 3 === 1)).toContain(12);
  const top = [];
  for (let i = 0; i < mesh.positions.length; i += 3) if (mesh.positions[i + 1] > 9.001) top.push([mesh.positions[i], mesh.positions[i + 2]]);
  expect(top.length).toBeGreaterThan(0);
  expect(top.every(([, z]) => Math.abs(z - 5) < 0.001)).toBe(true);
});
it("rotates a mapped downhill bearing with editor geometry and rejects invalid bearings", () => {
  const frame = localFrame([103.85, 1.3]);
  const feature = validateFeature({ ...model("house"), geometry: { type: "Polygon", coordinates: [rectangle.map(p => frame.unproject(...p))] } });
  const rotated = transformFeature(feature, 0, 0, 90, 2);
  expect(rotated.model?.roof?.direction).toBe(270);
  expect(rotated.model?.roof?.height).toBe(6);
  expect(feature.model?.roof?.direction).toBe(0);
  expect(() => validateFeature({ ...feature, model: { ...feature.model!, roof: { ...feature.model!.roof!, direction: NaN } } })).toThrow();
});
