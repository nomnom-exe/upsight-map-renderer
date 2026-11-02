/** @file tests/routeSurface.test.ts @brief Test how the route follows road heights and where gaps appear at bridges, tunnels or uncertain crossings. @author Norman */
import { describe, expect, it } from "vitest";
import { RoadSurfaceIndex } from "../src/geo/routeSurface";
import { DEFAULT_STYLE, type GeoFeature, type Position, type RouteData } from "../src/geo/types";
import { localFrame } from "../src/geo/math";
import { buildGeometry } from "../src/rendering/geometry";
import { validateFeature } from "../src/geo/validation";
import { routeFeature } from "../src/geo/adapters";
import { RouteSampler } from "../src/engine/RoutePlayback";
const origin: Position = [103.85, 1.3], frame = localFrame(origin);
const p = (x: number, y = 0) => frame.unproject(x, y);
const route: RouteData = { positions: [p(0), p(100)], durationSeconds: 10, distanceMetres: 100, source: "test" };
const road = (id: string, points = [p(0), p(100)], heights = [0.18, 0.18], width = 6): GeoFeature => ({
  id, source: "roads", layer: "roads", label: id, geometry: { type: "LineString", coordinates: points },
  style: { ...DEFAULT_STYLE, width, elevation: 0.18 },
  model: { kind: "road", road: { elevations: heights, lanes: 0, footway: false, paved: true, sidewalk: false } }, properties: {},
});
describe("route surface reconciliation", () => {
  it.each([-1000, 1000])("supports derived ribbon heights at the road profile limit %s", value => {
    const base = road("raised", undefined, [value, value]);
    const shifted = { ...base, style: { ...base.style, elevation: value } };
    const result = new RoadSurfaceIndex([shifted], origin).resolve(route);
    expect(result.elevations![0]).toBeCloseTo(2 * value + 0.04, 6);
    const ribbon = routeFeature(result);
    expect(new RouteSampler(result.positions, result.elevations).sample(1).elevation).toBeCloseTo(ribbon.model!.line!.elevations![0], 6);
  });

  it("rejects non-boolean flags and detaches nested provider extras from validated roads", () => {
    const input = road("raw");
    for (const flag of ["footway", "paved", "sidewalk"]) {
      const malformed = { ...input, model: { ...input.model!, road: { ...input.model!.road!, [flag]: "false" } } };
      expect(() => validateFeature(malformed)).toThrow("booleans");
      expect(() => new RoadSurfaceIndex([malformed], origin)).toThrow("booleans");
    }
    const metadata = { description: "raw" };
    const normalized = validateFeature({ ...input, model: { ...input.model!, metadata,
      road: { ...input.model!.road!, metadata } } } as GeoFeature);
    metadata.description = "mutated";
    expect(normalized.model).not.toHaveProperty("metadata");
    expect(normalized.model!.road).not.toHaveProperty("metadata");
  });
  it("follows a mapped ramp and narrows the ribbon without changing the routed path", () => {
    const result = new RoadSurfaceIndex([road("bridge", undefined, [0.18, 5.18], 2)], origin).resolve(route);
    expect(result.positions.length).toBeGreaterThan(2);
    expect(result.positions[0]).toEqual(route.positions[0]);
    expect(result.positions.at(-1)).toEqual(route.positions[1]);
    expect(result.positions.every(point => Math.abs(frame.project(point)[1]) < 0.001)).toBe(true);
    expect(result.elevations?.[0]).toBeCloseTo(0.4);
    expect(result.elevations?.at(-1)).toBeCloseTo(5.4);
    expect(Math.max(...result.widths!)).toBeCloseTo(1.6);
    expect(result.surfaceMatch?.unknown).toBe(0);
  });
  it("rejects a perpendicular flyover instead of lifting the route onto it", () => {
    const result = new RoadSurfaceIndex([road("surface"), road("flyover", [p(50, -50), p(50, 50)], [5.18, 5.18])], origin).resolve(route);
    expect(result.elevations?.every(h => Math.abs(h - 0.4) < 0.001)).toBe(true);
    expect(result.surfaceMatch?.ambiguous).toBe(0);
  });
  it("does not guess between parallel stacked roads, but uses shared OSM nodes when available", () => {
    const lower = road("lower"), upper = road("upper", undefined, [5.18, 5.18]);
    const withNodes = { ...upper, model: { ...upper.model!, road: { ...upper.model!.road!, nodeIds: [101, 102] } } };
    const index = new RoadSurfaceIndex([lower, withNodes], origin);
    expect(index.resolve(route).surfaceMatch?.ambiguous).toBeGreaterThan(0);
    const matched = index.resolve({ ...route, nodeIds: [101, 102], nodePairs: [[101, 102]] });
    expect(matched.surfaceMatch?.ambiguous).toBe(0);
    expect(matched.elevations?.every(h => Math.abs(h - 5.4) < 0.001)).toBe(true);
    expect(index.resolve({ ...route, nodeIds: [101, 201, 102], nodePairs: [[101, 201], [201, 102]] }).surfaceMatch?.ambiguous).toBeGreaterThan(0);
    expect(index.resolve({ ...route, nodePairs: [[102, 101]] }).surfaceMatch?.ambiguous).toBe(0);
  });
  it("leaves a gap at the edge of bridge coverage rather than inventing a ramp to ground", () => {
    const result = new RoadSurfaceIndex([road("bridge", [p(0), p(40)], [5.18, 5.18])], origin).resolve(route);
    expect(result.surfaceMatch!.matched).toBeGreaterThan(0);
    expect(result.surfaceMatch!.unknown).toBeGreaterThan(0);
    const transition = result.elevations!.findIndex((height, i, values) => i > 0 && Math.abs(height - values[i - 1]) > 1) - 1;
    expect(transition).toBeGreaterThanOrEqual(0);
    expect(result.segmentMask![transition]).toBe(false);
    expect(result.segmentMask!.at(-1)).toBe(true); // Beyond the bridge, the route stays visible at its default height.
  });
  it("does not bridge an unsupported jump between two separately mapped road levels", () => {
    const result = new RoadSurfaceIndex([road("ground", [p(0), p(45)]), road("bridge", [p(55), p(100)], [5.18, 5.18])], origin).resolve(route);
    expect(result.segmentMask!.some(visible => !visible)).toBe(true);
    result.segmentMask!.forEach((visible, i) => {
      if (visible) expect(Math.abs(result.elevations![i + 1] - result.elevations![i])).toBeLessThan(1);
    });
  });
  it("hides ambiguous stacked edges rather than drawing a ground-level route through them", () => {
    const result = new RoadSurfaceIndex([road("lower"), road("upper", undefined, [5.18, 5.18])], origin).resolve(route);
    expect(result.surfaceMatch?.ambiguous).toBe(result.positions.length);
    expect(result.segmentMask?.every(visible => !visible)).toBe(true);
  });
  it("uses tunnel identities to hide the underground route and does not infer its altitude", () => {
    const base = road("tunnel");
    const tunnel = { ...base, model: { ...base.model!, road: { ...base.model!.road!, surfaceHidden: true, nodeIds: [101, 102] } } };
    const surfaceBase = road("surface");
    const surface = { ...surfaceBase, model: { ...surfaceBase.model!, road: { ...surfaceBase.model!.road!, nodeIds: [201, 202] } } };
    const index = new RoadSurfaceIndex([tunnel, surface], origin);
    const underground = index.resolve({ ...route, nodePairs: [[101, 102]] });
    expect(underground.surfaceMatch?.matched).toBe(underground.positions.length);
    expect(underground.elevations?.every(value => value > 0)).toBe(true); // The tunnel has no measured depth. Its reference height stays above zero.
    expect(underground.segmentMask?.every(visible => !visible)).toBe(true);
    expect(underground.segmentStates?.every(state => state === "hidden")).toBe(true);
    expect(underground.surfaceMatch?.hidden).toBe(underground.positions.length);
    const above = index.resolve({ ...route, nodePairs: [[201, 202]] });
    expect(above.segmentMask?.every(visible => visible)).toBe(true);
    const uncertain = index.resolve(route);
    expect(uncertain.surfaceMatch?.ambiguous).toBe(uncertain.positions.length);
    expect(uncertain.segmentMask?.every(visible => !visible)).toBe(true);
    expect(uncertain.segmentStates?.every(state => state === "ambiguous")).toBe(true);
    expect(buildGeometry([validateFeature(tunnel)], origin, () => 1, 1).indices).toHaveLength(0);
    expect(() => validateFeature({ ...tunnel, model: { ...tunnel.model, road: { ...tunnel.model.road, surfaceHidden: "yes" as unknown as boolean } } })).toThrow(/visibility/);
  });
  it("detects a short tunnel between samples without treating a surface road above it as underground", () => {
    const base = road("short-tunnel", [p(3), p(4)]);
    const tunnel = { ...base, model: { ...base.model!, road: { ...base.model!.road!, surfaceHidden: true, nodeIds: [101, 102] } } };
    const surfaceBase = road("surface");
    const surface = { ...surfaceBase, model: { ...surfaceBase.model!, road: { ...surfaceBase.model!.road!, nodeIds: [201, 202] } } };
    const index = new RoadSurfaceIndex([tunnel, surface], origin);
    const uncertain = index.resolve(route);
    expect(uncertain.segmentStates![0]).toBe("ambiguous");
    expect(uncertain.segmentMask![0]).toBe(false);
    const below = index.resolve({ ...route, nodePairs: [[101, 102]] });
    expect(below.segmentStates![0]).toBe("hidden");
    expect(below.segmentMask![0]).toBe(false);
    const above = index.resolve({ ...route, nodePairs: [[201, 202]] });
    expect(above.segmentStates!.every(state => state === "surface")).toBe(true);
    expect(above.segmentMask!.every(Boolean)).toBe(true);
    expect(below.positions[0]).toEqual(route.positions[0]);
    expect(below.positions.at(-1)).toEqual(route.positions.at(-1));
    expect(below.durationSeconds).toBe(route.durationSeconds);
  });
  it("detects a short separate deck between samples instead of drawing straight through it", () => {
    const index = new RoadSurfaceIndex([road("surface"), road("short-deck", [p(3), p(4)], [5.18, 5.18])], origin);
    const result = index.resolve(route);
    expect(result.segmentStates![0]).toBe("ambiguous");
    expect(result.segmentMask![0]).toBe(false);
  });
  it("supports explicit signed road heights without inferring underground visibility from altitude", () => {
    const belowDatum = validateFeature(road("surveyed-below-datum", undefined, [-6, -4]));
    const result = new RoadSurfaceIndex([belowDatum], origin).resolve(route);
    expect(result.elevations![0]).toBeCloseTo(-5.78);
    expect(result.elevations!.at(-1)).toBeCloseTo(-3.78);
    expect(result.segmentStates!.every(state => state === "surface")).toBe(true);
    const data = buildGeometry([belowDatum], origin, () => 1, 1);
    const heights = Array.from(data.positions).filter((_, i) => i % 3 === 1);
    expect(Math.min(...heights)).toBeCloseTo(-5.92);
    expect(Math.max(...heights)).toBeLessThan(-3.8);
    const shifted = validateFeature({ ...belowDatum, style: { ...belowDatum.style, elevation: -2 } });
    expect(new RoadSurfaceIndex([shifted], origin).resolve(route).elevations![0]).toBeCloseTo(-7.96);
    expect(() => validateFeature(road("invalid", undefined, [-1001, -4]))).toThrow(/finite/);
  });
  it("leaves missing coverage unresolved and never attaches a route to a footpath", () => {
    const path = road("path");
    const result = new RoadSurfaceIndex([{ ...path, model: { ...path.model!, road: { ...path.model!.road!, footway: true } } }], origin).resolve(route);
    expect(result.surfaceMatch?.matched).toBe(0);
    expect(result.surfaceMatch?.unknown).toBe(result.positions.length);
  });
  it("bounds resampling while preserving all input turns", () => {
    const turns = Array.from({ length: 10000 }, (_, i) => p(i, i % 2));
    const result = new RoadSurfaceIndex([], origin).resolve({ ...route, positions: turns });
    expect(result.positions).toEqual(turns);
    expect(result.positions).toHaveLength(10000);
    expect(() => new RoadSurfaceIndex([], origin).resolve({ ...route, positions: [...turns, p(10001)] })).toThrow(/at most 10,000/);
  });
  it("samples short straight edges within ten metres and stays bounded on long sparse routes", () => {
    const index = new RoadSurfaceIndex([], origin);
    const short = index.resolve({ ...route, positions: [p(0), p(19)] });
    expect(short.positions.length).toBe(3);
    const turns = Array.from({ length: 1000 }, (_, i) => p(i * 150, i % 2));
    const long = index.resolve({ ...route, positions: turns });
    expect(long.positions.length).toBeLessThanOrEqual(10000);
    const keys = new Set(long.positions.map(position => position.join(",")));
    expect(turns.every(position => keys.has(position.join(",")))).toBe(true);
  });
  it("does not claim a match after scanning only part of an overloaded road cell", () => {
    const roads = Array.from({ length: 513 }, (_, i) => road(`road-${i}`));
    const result = new RoadSurfaceIndex(roads, origin).resolve(route);
    expect(result.surfaceMatch).toMatchObject({ matched: 0, truncated: true });
    expect(result.surfaceMatch!.unknown).toBe(result.positions.length);
    expect(result.segmentMask!.every(visible => !visible)).toBe(true);
  });
  it("does not claim a surface match when a competing tunnel exceeds the index coverage budget", () => {
    const tunnel = road("tunnel", [p(-500, -500), p(500, 500)]);
    const hidden = { ...tunnel, model: { ...tunnel.model!, road: { ...tunnel.model!.road!, surfaceHidden: true } } };
    const positions = [p(0), p(100, 100)];
    const result = new RoadSurfaceIndex([road("surface", positions), hidden], origin).resolve({ ...route, positions });
    expect(result.surfaceMatch).toEqual({ matched: 0, unknown: 2, ambiguous: 0, truncated: true });
    expect(result.segmentMask).toEqual([false]);
    expect(result.elevations).toBeUndefined();
  });
  it("never uses a partial list of route node pairs as proof of a road match", () => {
    const nodePairs = Array.from({ length: 200001 }, () => [101, 102] as const);
    const result = new RoadSurfaceIndex([road("surface")], origin).resolve({ ...route, nodePairs });
    expect(result.surfaceMatch).toMatchObject({ matched: 0, truncated: true });
    expect(result.segmentMask).toEqual([false]);
  });
  it("bounds total matching work and labels the unexamined route samples", () => {
    const roads = Array.from({ length: 500 }, (_, i) => road(`road-${i}`));
    const positions = Array.from({ length: 10000 }, (_, i) => p((i % 2) * 100));
    const result = new RoadSurfaceIndex(roads, origin).resolve({ ...route, positions });
    expect(result.surfaceMatch).toMatchObject({ matched: 500, unknown: 9500, truncated: true });
    expect(result.segmentMask![499]).toBe(false);
    expect(result.segmentMask!.slice(499).every(visible => !visible)).toBe(true);
  });
  it("builds elevated variable-width ribbons and rejects malformed profiles", () => {
    const feature: GeoFeature = { ...road("route"), layer: "route", model: { kind: "line", line: { elevations: [1, 5], widths: [1, 2] } } };
    const data = buildGeometry([validateFeature(feature)], origin, () => 1, 1);
    const heights = Array.from(data.positions).filter((_, i) => i % 3 === 1);
    expect(Math.min(...heights)).toBe(1); expect(Math.max(...heights)).toBe(5);
    expect(() => validateFeature({ ...feature, model: { kind: "line", line: { elevations: [1] } } })).toThrow(/profile/);
    expect(() => validateFeature({ ...feature, model: { kind: "line", line: { widths: [1, NaN] } } })).toThrow(/finite/);
  });
  it("keeps masked edges empty without rounded caps protruding into internal gaps", () => {
    const feature = validateFeature({ ...road("route", [p(0), p(10), p(20), p(30)], [0.18, 0.18, 0.18, 0.18]),
      layer: "route", model: { kind: "line", line: { elevations: [1, 1, 5, 5], segmentMask: [true, false, true] } } });
    const data = buildGeometry([feature], origin, () => 1, 1);
    const xs = Array.from(data.positions).filter((_, i) => i % 3 === 0);
    expect(xs.every(x => x <= 10.001 || x >= 19.999)).toBe(true);
    expect(data.indices.length).toBeGreaterThan(0);
    expect(Object.isFrozen(feature.model!.line!.segmentMask)).toBe(true);
    expect(() => validateFeature({ ...feature, model: { kind: "line", line: { segmentMask: [true] } } })).toThrow(/mask/);
    expect(() => validateFeature({ ...feature, model: { kind: "line", line: { segmentMask: [true, 1, true] as unknown as boolean[] } } })).toThrow(/mask/);
    const hidden = validateFeature({ ...feature, model: { kind: "line", line: { segmentMask: [false, false, false] } } });
    expect(buildGeometry([hidden], origin, () => 1, 1).indices).toHaveLength(0);
  });
});
