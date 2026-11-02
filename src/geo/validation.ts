/**
 * @file src/geo/validation.ts
 * @brief Check geographic features before they enter a scene.
 * @author Norman
 * @description Checks coordinates, polygon shape, styles and model settings.
 */

import { extentOf, pointsOf } from "./math.js";
import { MAX_LINE_ELEVATION, MIN_LINE_ELEVATION } from "./elevations.js";
import type { GeoFeature, Geometry, Position } from "./types.js";

export function finite(value: unknown, min: number, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    throw new Error(`Expected a finite number from ${min} to ${max}.`);
  return value;
}
export function position(value: unknown): Position {
  if (!Array.isArray(value) || value.length !== 2)
    throw new Error("Coordinates must be [longitude, latitude].");
  return Object.freeze([
    finite(value[0], -180, 180),
    finite(value[1], -85, 85),
  ]) as Position;
}
const cross = (a: Position, b: Position, c: Position) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function crossing(a: Position, b: Position, c: Position, d: Position) {
  return (
    Math.max(Math.min(a[0], b[0]), Math.min(c[0], d[0])) <=
      Math.min(Math.max(a[0], b[0]), Math.max(c[0], d[0])) &&
    Math.max(Math.min(a[1], b[1]), Math.min(c[1], d[1])) <=
      Math.min(Math.max(a[1], b[1]), Math.max(c[1], d[1])) &&
    cross(a, b, c) * cross(a, b, d) <= 0 &&
    cross(c, d, a) * cross(c, d, b) <= 0
  );
}
function inside(p: Position, ring: readonly Position[]) {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      result = !result;
  }
  return result;
}
function ring(value: unknown): readonly Position[] {
  if (!Array.isArray(value) || value.length < 3 || value.length > 513)
    throw new Error("Polygon rings need 3–512 vertices.");
  const p = value.map(position);
  if (p[0][0] === p.at(-1)![0] && p[0][1] === p.at(-1)![1]) p.pop();
  if (p.length < 3) throw new Error("Degenerate polygon.");
  let area = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i],
      b = p[(i + 1) % p.length];
    if (a[0] === b[0] && a[1] === b[1])
      throw new Error("Duplicate polygon vertex.");
    area += cross(p[0], a, b);
    for (let j = i + 2; j < p.length; j++)
      if (
        !(i === 0 && j === p.length - 1) &&
        crossing(a, b, p[j], p[(j + 1) % p.length])
      )
        throw new Error("Self-intersecting polygon.");
  }
  if (Math.abs(area) < 1e-12) throw new Error("Polygon has no area.");
  return Object.freeze(p);
}
export function geometry(value: Geometry): Geometry {
  if (!value || typeof value !== "object") throw new Error("Missing geometry.");
  let g: Geometry;
  if (value.type === "Point")
    g = { type: value.type, coordinates: position(value.coordinates) };
  else if (value.type === "LineString") {
    if (
      !Array.isArray(value.coordinates) ||
      value.coordinates.length < 2 ||
      value.coordinates.length > 10000
    )
      throw new Error("Line needs 2–10,000 points.");
    const p = value.coordinates.map(position);
    if (p.every((v) => v[0] === p[0][0] && v[1] === p[0][1]))
      throw new Error("Line has no length.");
    g = { type: value.type, coordinates: Object.freeze(p) };
  } else if (value.type === "Polygon") {
    if (
      !Array.isArray(value.coordinates) ||
      !value.coordinates.length ||
      value.coordinates.length > 16
    )
      throw new Error("Polygon needs 1–16 rings.");
    const rings = value.coordinates.map(ring);
    for (let i = 1; i < rings.length; i++) {
      if (!inside(rings[i][0], rings[0]))
        throw new Error("Hole lies outside polygon.");
      for (let j = 0; j < i; j++) {
        if (
          j > 0 &&
          (inside(rings[i][0], rings[j]) || inside(rings[j][0], rings[i]))
        )
          throw new Error("Nested holes are unsupported.");
        for (let a = 0; a < rings[i].length; a++)
          for (let b = 0; b < rings[j].length; b++)
            if (
              crossing(
                rings[i][a],
                rings[i][(a + 1) % rings[i].length],
                rings[j][b],
                rings[j][(b + 1) % rings[j].length],
              )
            )
              throw new Error("Polygon rings intersect.");
      }
    }
    g = { type: value.type, coordinates: Object.freeze(rings) };
  } else throw new Error("Unsupported geometry type.");
  const e = extentOf(pointsOf(g));
  if (e.east - e.west > 2 || e.north - e.south > 2)
    throw new Error(
      "Split geometry larger than 2° or crossing the antimeridian before importing.",
    );
  return Object.freeze(g);
}
const validated = new WeakSet<object>();
/** Only a validated, deeply frozen feature can reuse its cached signature. */
export function isValidatedFeature(f: GeoFeature): boolean {
  return validated.has(f);
}
/** Accept only worker copies of features that already passed validation.
 * Uploaded files and network responses must go through validateFeature first. */
export function acceptValidatedFeature(f: GeoFeature): GeoFeature {
  const g = f.geometry;
  if (g.type === "Polygon") {
    for (const ring of g.coordinates) {
      ring.forEach(Object.freeze);
      Object.freeze(ring);
    }
  } else if (g.type === "LineString") g.coordinates.forEach(Object.freeze);
  Object.freeze(g.coordinates);
  Object.freeze(g);
  Object.freeze(f.style);
  Object.freeze(f.properties);
  if (f.model?.roof) Object.freeze(f.model.roof);
  if (f.model?.omitSupports) Object.freeze(f.model.omitSupports);
  if (f.model?.road) {
    if (f.model.road.elevations) Object.freeze(f.model.road.elevations);
    if (f.model.road.nodeIds) Object.freeze(f.model.road.nodeIds);
    Object.freeze(f.model.road);
  }
  if (f.model?.line) {
    if (f.model.line.elevations) Object.freeze(f.model.line.elevations);
    if (f.model.line.widths) Object.freeze(f.model.line.widths);
    if (f.model.line.segmentMask) Object.freeze(f.model.line.segmentMask);
    Object.freeze(f.model.line);
  }
  if (f.model) Object.freeze(f.model);
  Object.freeze(f);
  validated.add(f);
  return f;
}
/** Copy only the supported fields, leaving out extra provider metadata. */
function fields<T extends object, K extends keyof T>(value: T, keys: K[]): Pick<T, K> {
  const result = {} as Pick<T, K>;
  for (const key of keys) if (value[key] !== undefined) result[key] = value[key];
  return result;
}
export function validateFeature(f: GeoFeature): GeoFeature {
  // Validated features are frozen. Reuse them so panning doesn't repeat the polygon intersection checks.
  if (validated.has(f)) return f;
  if (
    !f ||
    typeof f.id !== "string" ||
    !/^[\w%:.-]{1,160}$/.test(f.id) ||
    typeof f.source !== "string" ||
    !/^[\w.-]{1,60}$/.test(f.source)
  )
    throw new Error("Invalid feature/source ID.");
  if (typeof f.label !== "string" || !f.label.trim() || f.label.length > 160)
    throw new Error("Label needs 1–160 characters.");
  if (
    ![
      "chargers",
      "route",
      "scenario",
      "imported",
      "buildings",
      "roads",
      "landscape",
      "annotations",
     ].includes(f.layer) && !/^custom:[a-z][\w.-]{0,50}$/.test(f.layer)
  )
    throw new Error("Unknown layer.");
  const s = f.style;
  if (!s || typeof s.color !== "string" || !/^#[\da-f]{6}$/i.test(s.color))
    throw new Error("Color must be #RRGGBB.");
  const style = Object.freeze({
    color: s.color,
    height: finite(s.height, 0, 1000),
    radius: finite(s.radius, 0.2, 100),
    width: finite(s.width, 0.2, 100),
    elevation: finite(s.elevation, -1000, 1000),
  });
  const properties: Record<string, string | number | boolean | null> = {};
  if (
    !f.properties ||
    typeof f.properties !== "object" ||
    Object.keys(f.properties).length > 50
  )
    throw new Error("Invalid properties.");
  for (const [k, v] of Object.entries(f.properties)) {
    if (
      !/^[\w:.-]{1,80}$/.test(k) ||
      ["__proto__", "constructor", "prototype"].includes(k)
    )
      throw new Error("Invalid property name.");
    if (
      v !== null &&
      typeof v !== "boolean" &&
      !(typeof v === "number" && Number.isFinite(v)) &&
      !(typeof v === "string" && v.length <= 500)
    )
      throw new Error("Properties must be short scalar values.");
    properties[k] = v;
  }
  if (f.model) {
    if (
      ![
        "building",
        "road",
        "line",
        "water",
        "park",
        "ground",
        "tree",
        "charger",
        "asset", "label", "custom",
      ].includes(f.model.kind)
    )
      throw new Error("Unknown model recipe.");
    if (f.model.fontSize !== undefined) finite(f.model.fontSize, 10, 40);
    if (f.model.replacement !== undefined && (typeof f.model.replacement !== "string" || !/^[\w%:.-]{1,160}$/.test(f.model.replacement))) throw new Error("Invalid replacement flag.");
    if ((f.model.kind === "custom" || f.model.rendererId !== undefined) &&
        (typeof f.model.rendererId !== "string" || !/^[a-z][\w.-]{0,50}$/.test(f.model.rendererId))) throw new Error("Invalid custom rendererId.");
    if (f.model.length !== undefined) finite(f.model.length, 0.1, 1000);
    if (f.model.facade !== undefined && !["glass", "stone", "brick"].includes(f.model.facade))
      throw new Error("Unknown facade.");
    if (
      f.model.family !== undefined &&
      ![
        "neutral",
        "residential",
        "house",
        "commercial",
        "industrial",
        "parking",
        "civic",
        "canopy",
      ].includes(f.model.family)
    )
      throw new Error("Unknown building family.");
    if (f.model.omitSupports) {
      const indices = f.model.omitSupports;
      const vertices =
        f.geometry.type === "Polygon" ? f.geometry.coordinates[0].length : 0;
      if (
        f.model.family !== "canopy" ||
        !vertices ||
        !Array.isArray(indices) ||
        indices.length > 512 ||
        indices.some((i) => !Number.isInteger(i) || i < 0 || i >= vertices)
      )
        throw new Error("Invalid canopy support exclusions.");
    }
    if (f.model.roof) {
      const roof = f.model.roof;
      if (
        !["flat", "gabled", "hipped", "pyramidal", "skillion"].includes(
          roof.shape,
        ) ||
        typeof roof.color !== "string" || !/^#[\da-f]{6}$/i.test(roof.color) ||
        (roof.across !== undefined && typeof roof.across !== "boolean")
      )
        throw new Error("Invalid roof recipe.");
      finite(roof.height, 0, s.height);
      if (roof.direction !== undefined) finite(roof.direction, 0, 360);
    }
    if (f.model.road) {
      finite(f.model.road.lanes, 0, 12);
      if ([f.model.road.footway, f.model.road.paved, f.model.road.sidewalk].some(value => typeof value !== "boolean"))
        throw new Error("Road footway, paved and sidewalk flags must be booleans.");
      if (f.model.road.surfaceHidden !== undefined && typeof f.model.road.surfaceHidden !== "boolean")
        throw new Error("Invalid road surface visibility.");
      if (
        f.model.road.sidewalkSide !== undefined &&
        !["left", "right", "both"].includes(f.model.road.sidewalkSide)
      )
        throw new Error("Invalid sidewalk side.");
      const profile = f.model.road.elevations;
      const nodes = f.model.road.nodeIds;
      if (nodes && (f.geometry.type !== "LineString" || !Array.isArray(nodes) || nodes.length !== f.geometry.coordinates.length || nodes.some(n => !Number.isSafeInteger(n) || n <= 0)))
        throw new Error("Road node IDs must match its vertices.");
      if (profile) {
        if (
          f.geometry.type !== "LineString" ||
          !Array.isArray(profile) ||
          profile.length !== f.geometry.coordinates.length
        )
          throw new Error("Road elevation profile must match its line.");
        profile.forEach((value) => finite(value, -1000, 1000));
      }
    }
    if (f.model.line) {
      if (f.model.kind !== "line") throw new Error("Line profiles require a line model.");
      for (const [field, values] of Object.entries(f.model.line)) {
        if (field === "dashed") {
          if (typeof values !== "boolean") throw new Error("Invalid line pattern.");
        } else if (field === "segmentMask") {
          if (f.geometry.type !== "LineString" || !Array.isArray(values) || values.length !== f.geometry.coordinates.length - 1 || values.some(value => typeof value !== "boolean"))
            throw new Error("Line segment mask must match its edges.");
        } else {
          if (!["elevations", "widths"].includes(field) || f.geometry.type !== "LineString" || !Array.isArray(values) || values.length !== f.geometry.coordinates.length)
            throw new Error("Line profile must match its vertices.");
          values.forEach(value => finite(value, field === "widths" ? 0.2 : MIN_LINE_ELEVATION,
            field === "widths" ? 100 : MAX_LINE_ELEVATION));
        }
      }
    }
    if (f.model.heading !== undefined) finite(f.model.heading, -360, 360);
    if (f.model.kind === "asset" || f.model.assetId !== undefined) {
      if (f.model.kind !== "asset" && f.model.kind !== "charger")
        throw new Error(
          "Only point assets and chargers can reference a model file.",
        );
      if (
        typeof f.model.assetId !== "string" ||
        !/^[a-z][\w.-]*:[\w:.-]{1,140}$/.test(f.model.assetId)
      )
        throw new Error(
          "Asset IDs must be namespaced, for example partner:vehicle-v1.",
        );
      if (f.model.kind === "asset") finite(f.model.length, 0.1, 1000);
      else finite(s.height, 0.1, 20);
    }
    const required = ["tree", "charger", "asset", "label"].includes(f.model.kind)
      ? "Point"
      : f.model.kind === "road" || f.model.kind === "line"
        ? "LineString"
        : "Polygon";
    if (f.model.kind !== "custom" && f.geometry.type !== required)
      throw new Error(`Model ${f.model.kind} requires ${required}.`);
  }
  const result = Object.freeze({
    id: f.id,
    source: f.source,
    layer: f.layer,
    label: f.label,
    geometry: geometry(f.geometry),
    style,
    ...(f.model
      ? {
          model: Object.freeze({
            ...fields(f.model, ["kind", "replacement", "rendererId", "fontSize", "facade", "family", "assetId", "length", "heading"]),
            ...(f.model.omitSupports
              ? { omitSupports: Object.freeze([...f.model.omitSupports]) }
              : {}),
            ...(f.model.roof
              ? { roof: Object.freeze(fields(f.model.roof, ["shape", "height", "color", "across", "direction"])) }
              : {}),
            ...(f.model.road
              ? {
                  road: Object.freeze({
                    ...fields(f.model.road, ["lanes", "footway", "paved", "sidewalk", "sidewalkSide", "surfaceHidden"]),
                    ...(f.model.road.nodeIds ? { nodeIds: Object.freeze([...f.model.road.nodeIds]) } : {}),
                    ...(f.model.road.elevations
                      ? {
                          elevations: Object.freeze([
                            ...f.model.road.elevations,
                          ]),
                        }
                      : {}),
                  }),
                }
              : {}),
            ...(f.model.line ? { line: Object.freeze({ ...fields(f.model.line, ["dashed"]),
              ...(f.model.line.elevations ? { elevations: Object.freeze([...f.model.line.elevations]) } : {}),
              ...(f.model.line.widths ? { widths: Object.freeze([...f.model.line.widths]) } : {}),
              ...(f.model.line.segmentMask ? { segmentMask: Object.freeze([...f.model.line.segmentMask]) } : {}),
            }) } : {}),
          }),
        }
      : {}),
    properties: Object.freeze(properties),
  });
  validated.add(result);
  return result;
}
