/**
 * @file geo/adapters.ts
 * @brief Build scene features from GeoJSON imports and routes.
 * @author Norman
 */
import { DEFAULT_STYLE, type GeoFeature, type Geometry, type RouteData, type SourceInfo } from "./types.js";
import { validateFeature } from "./validation.js";

/** A GeoJSON import returns source details and the features it created. */
export interface AdaptedSource {
  info: SourceInfo;
  features: GeoFeature[];
}
type JsonRow = Record<string, unknown>;
const row = (v: unknown): JsonRow =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as JsonRow)
    : {};
/** Split GeoJSON multi-geometries into features. Each ID includes the source and part number. */
export function fromGeoJSON(
  input: unknown,
  source = "imported",
): AdaptedSource {
  const root = row(input);
  if (root.crs)
    throw new Error("Convert projected GeoJSON to WGS84 before import.");
  const entries =
    root.type === "FeatureCollection"
      ? root.features
      : root.type === "Feature"
        ? [root]
        : null;
  if (!Array.isArray(entries) || entries.length > 10000)
    throw new Error(
      "Expected a GeoJSON FeatureCollection (maximum 10,000 features).",
    );
  const features: GeoFeature[] = [];
  for (const [index, entry] of entries.entries()) {
    const f = row(entry),
      g = row(f.geometry),
      p = row(f.properties);
    let parts: Geometry[];
    if (["Point", "LineString", "Polygon"].includes(String(g.type)))
      parts = [g as unknown as Geometry];
    else if (
      ["MultiPoint", "MultiLineString", "MultiPolygon"].includes(
        String(g.type),
      ) &&
      Array.isArray(g.coordinates)
    )
      parts = g.coordinates.map(
        (coordinates) =>
          ({ type: String(g.type).slice(5), coordinates }) as Geometry,
      );
    else
      throw new Error(
        `Feature ${index + 1}: unsupported geometry ${String(g.type)}.`,
      );
    const properties: Record<string, string | number | boolean | null> = {};
    for (const [k, v] of Object.entries(p))
      if (
        v === null ||
        typeof v === "string" ||
        typeof v === "boolean" ||
        typeof v === "number"
      )
        properties[k] = v;
    const stable = String(f.id ?? index)
      .replace(/[^\w.-]/g, "_")
      .slice(0, 80);
    for (const [part, shape] of parts.entries())
      features.push(
        validateFeature({
          id: `${source}:${stable}:${part}`,
          source,
          layer: "imported",
          label: String(
            p.name ?? p.label ?? `Imported object ${index + 1}`,
          ).slice(0, 160),
          geometry: shape,
          style: {
            ...DEFAULT_STYLE,
            color:
              typeof p.color === "string"
                ? p.color
                : shape.type === "Polygon"
                  ? "#7b94a6"
                  : "#087f8c",
            height:
              typeof p.height === "number"
                ? p.height
                : shape.type === "Polygon"
                  ? 0
                  : 5,
            width: typeof p.width === "number" ? p.width : 5,
          },
          properties,
        }),
      );
  }
  if (new Set(features.map((f) => f.id)).size !== features.length)
    throw new Error("Duplicate GeoJSON IDs after normalization.");
  return {
    info: {
      id: source,
      label: "Imported GeoJSON",
      status: "local",
      attribution: "User supplied",
    },
    features,
  };
}
export function routeFeature(route: RouteData, routeId = "active"): GeoFeature {
  return validateFeature({
    id: `route:${routeId}`,
    source: "routing",
    layer: "route",
    label: "Driving route",
    geometry: { type: "LineString", coordinates: route.positions },
    model: { kind: "line", line: {
      ...(route.elevations ? { elevations: route.elevations } : {}),
      ...(route.widths ? { widths: route.widths } : {}),
      ...(route.segmentMask ? { segmentMask: route.segmentMask } : {}),
    } },
    style: {
      ...DEFAULT_STYLE,
      color: "#087f8c",
      width: 2.5,
      height: 0,
      elevation: 0.4,
    },
    properties: {
      source: route.source,
      distanceMetres: route.distanceMetres,
      durationSeconds: route.durationSeconds,
      matchedRoadSamples: route.surfaceMatch?.matched ?? 0,
      ambiguousRoadSamples: route.surfaceMatch?.ambiguous ?? 0,
      unknownRoadSamples: route.surfaceMatch?.unknown ?? route.positions.length,
      surfaceMatchTruncated: route.surfaceMatch?.truncated ?? false,
      elevationBasis: "Matched provider road surface where unambiguous; flat reference for uncovered spans. Ambiguous surfaces and coverage transitions are hidden. Not surveyed altitude.",
    },
  });
}
