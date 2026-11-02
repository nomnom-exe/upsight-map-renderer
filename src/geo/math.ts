/**
 * @file src/geo/math.ts
 * @brief Project map coordinates and transform features.
 * @author Norman
 * @description Measure distances and bounds, and move features in metres around a local origin.
 */

import type { Extent, GeoFeature, Geometry, Position } from "./types.js";

export const CIRCUMFERENCE = 40075016.68557849;
export const RAD = Math.PI / 180;
export function mercator([lon, lat]: Position): Position {
  return [
    (lon + 180) / 360,
    (1 - Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2)) / Math.PI) / 2,
  ];
}
export function unmercator([x, y]: Position): Position {
  return [x * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / RAD];
}
/** A nearby origin keeps GPU coordinates small. Use its latitude to convert distances to metres. */
export function localFrame(origin: Position) {
  const anchor = mercator(origin);
  const scale = 1 / (CIRCUMFERENCE * Math.cos(origin[1] * RAD));
  return {
    anchor,
    scale,
    project(p: Position): Position {
      const m = mercator(p);
      return [(m[0] - anchor[0]) / scale, (anchor[1] - m[1]) / scale];
    },
    unproject(x: number, z: number): Position {
      return unmercator([anchor[0] + x * scale, anchor[1] - z * scale]);
    },
  };
}
export function pointsOf(g: Geometry): readonly Position[] {
  return g.type === "Point"
    ? [g.coordinates]
    : g.type === "LineString"
      ? g.coordinates
      : g.coordinates.flat();
}
export function extentOf(points: readonly Position[]): Extent {
  const e = {
    west: Infinity,
    south: Infinity,
    east: -Infinity,
    north: -Infinity,
  };
  for (const p of points) {
    e.west = Math.min(e.west, p[0]);
    e.east = Math.max(e.east, p[0]);
    e.south = Math.min(e.south, p[1]);
    e.north = Math.max(e.north, p[1]);
  }
  return e;
}
/** Read polygon rings directly to avoid copying their vertices. */
export function geometryExtent(g: Geometry): Extent {
  if (g.type === "Point") {
    const [lon, lat] = g.coordinates;
    return { west: lon, east: lon, south: lat, north: lat };
  }
  if (g.type === "LineString") return extentOf(g.coordinates);
  const e = { west: Infinity, east: -Infinity, south: Infinity, north: -Infinity };
  for (const ring of g.coordinates)
    for (const p of ring) {
      e.west = Math.min(e.west, p[0]);
      e.east = Math.max(e.east, p[0]);
      e.south = Math.min(e.south, p[1]);
      e.north = Math.max(e.north, p[1]);
    }
  return e;
}
export function featureExtent(f: GeoFeature, e = geometryExtent(f.geometry)): Extent {
  let metres = Math.max(f.style.radius, f.style.width, f.model?.length ?? 0);
  if (f.model?.kind === "line" || f.model?.kind === "road") {
    const widths = f.model.line?.widths;
    const width = widths?.reduce((max, w) => Math.max(max, w), 0) ?? f.style.width;
    const sidewalk = f.model.road?.sidewalk && !f.model.road.footway ? 1.2 : 0;
    // At sharp turns, the join can extend up to 2.5 times the half-width.
    metres = Math.max(metres, (width / 2 + sidewalk) * 2.5);
  } else if (!f.model && f.geometry.type === "Point") {
    metres = Math.max(metres, f.style.radius * 1.7);
  } else if (f.model?.kind === "tree") {
    metres = Math.max(metres, f.style.height * 0.5);
  } else if (f.model?.kind === "park") {
    metres = Math.max(metres, 4); // Tree crowns can extend past the park boundary.
  }
  const pad = metres / 111000;
  const lonPad =
    pad / Math.cos(Math.max(Math.abs(e.south), Math.abs(e.north)) * RAD);
  return {
    west: e.west - lonPad,
    east: e.east + lonPad,
    south: e.south - pad,
    north: e.north + pad,
  };
}
export const intersects = (a: Extent, b: Extent) =>
  a.west <= b.east &&
  a.east >= b.west &&
  a.south <= b.north &&
  a.north >= b.south;
export function distance(a: Position, b: Position): number {
  const dLat = (b[1] - a[1]) * RAD,
    dLon = (b[0] - a[0]) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 6371008.8 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}
export function bearing(a: Position, b: Position): number {
  const d = (b[0] - a[0]) * RAD;
  return (
    Math.atan2(
      Math.sin(d) * Math.cos(b[1] * RAD),
      Math.cos(a[1] * RAD) * Math.sin(b[1] * RAD) -
        Math.sin(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.cos(d),
    ) / RAD
  );
}
/** Move geometry east and north in metres. The original provider feature stays unchanged. */
export function transformFeature(
  f: GeoFeature,
  east: number,
  north: number,
  angle = 0,
  scale = 1,
  pivot?: Position,
): GeoFeature {
  if (![east, north, angle, scale].every(Number.isFinite) || scale <= 0)
    throw new Error("Invalid transform.");
  if (east === 0 && north === 0 && angle % 360 === 0 && scale === 1) return f;
  const e = extentOf(pointsOf(f.geometry));
  const frame = localFrame(
    pivot ?? [(e.west + e.east) / 2, (e.south + e.north) / 2],
  );
  const c = Math.cos(angle * RAD),
    s = Math.sin(angle * RAD);
  const move = (p: Position) => {
    const [x, z] = frame.project(p);
    return frame.unproject(
      (x * c - z * s) * scale + east,
      (x * s + z * c) * scale + north,
    );
  };
  const g = f.geometry;
  const geometry: Geometry =
    g.type === "Point"
      ? { type: g.type, coordinates: move(g.coordinates) }
      : g.type === "LineString"
        ? { type: g.type, coordinates: g.coordinates.map(move) }
        : { type: g.type, coordinates: g.coordinates.map((r) => r.map(move)) };
  let model = f.model;
  if (model?.roof) {
    const roof = model.roof;
    model = { ...model, roof: { ...roof, height: roof.height * scale,
      ...(roof.direction === undefined ? {} : { direction: ((roof.direction - angle) % 360 + 360) % 360 }) } };
  }
  if (model && g.type === "Point") {
    model = { ...model, heading: (((model.heading ?? 0) + angle) % 360 + 360) % 360,
      ...(model.kind === "asset" ? { length: (model.length ?? 1) * scale } : {}) };
  }
  if (scale !== 1 && model?.line?.widths) {
    model = { ...model, line: { ...model.line, widths: model.line.widths.map(width => width * scale) } };
  }
  return {
    ...f,
    geometry,
    ...(model ? { model } : {}),
    style: {
      ...f.style,
      radius: f.style.radius * scale,
      height: f.style.height * scale,
      width: f.style.width * scale,
    },
  };
}
