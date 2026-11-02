/**
 * @file rendering/models/roofs.ts
 * @brief Build roofs from mapped shapes and dimensions.
 * @author Norman
 * @description Keeps concave outlines and courtyards intact. Unsupported shapes use a flat roof.
 */
import earcut from "earcut";
import type { ModelStyle } from "../../geo/types.js";
import { MeshWriter, type RGB, type V2, type V3 } from "./MeshWriter.js";

type Triangle = readonly [V3, V3, V3];
export interface RoofPlan {
  readonly eaves: number;
  readonly triangles: readonly Triangle[];
  /** Height at a point on the roof edge, used to close a gable or the rim of a canopy. */
  boundaryHeight(point: V2): number;
  splitEdge(a: V2, b: V2): readonly V2[];
}
const length = (a: V2, b: V2) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const mid = (a: V2, b: V2): V2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const at = (p: V2, height: number): V3 => [p[0], height, p[1]];
const directEdge = (a: V2, b: V2): readonly V2[] => [a, b];

/** Remove redundant points along straight roof edges. The walls use the original points. */
function corners(ring: readonly V2[]): V2[] {
  const points = [...ring];
  if (points.length > 1 && length(points[0], points[points.length - 1]) < 0.001) points.pop();
  let changed = true;
  while (changed && points.length > 3) {
    changed = false;
    for (let i = 0; i < points.length; i++) {
      const a = points[(i + points.length - 1) % points.length], b = points[i], c = points[(i + 1) % points.length];
      const dx = c[0] - a[0], dz = c[1] - a[1], span = Math.hypot(dx, dz);
      const t = span > 0 ? ((b[0] - a[0]) * dx + (b[1] - a[1]) * dz) / (span * span) : -1;
      if (span > 0 && t >= 0 && t <= 1 && Math.abs(dx * (b[1] - a[1]) - dz * (b[0] - a[0])) / span < 0.01) {
        points.splice(i, 1); changed = true; break;
      }
    }
  }
  return points;
}
function rectangle(points: readonly V2[]) {
  return points.length === 4 && points.every((p, i) => {
    const a = points[(i + 1) % 4], b = points[(i + 2) % 4];
    const ux = a[0] - p[0], uz = a[1] - p[1], vx = b[0] - a[0], vz = b[1] - a[1];
    return Math.abs(ux * vx + uz * vz) < 0.05 * Math.hypot(ux, uz) * Math.hypot(vx, vz);
  });
}
function convex(points: readonly V2[]) {
  let sign = 0;
  return points.every((p, i) => {
    const a = points[(i + 1) % points.length], b = points[(i + 2) % points.length];
    const cross = (a[0] - p[0]) * (b[1] - a[1]) - (a[1] - p[1]) * (b[0] - a[0]);
    if (Math.abs(cross) < 1e-8) return true;
    if (!sign) sign = Math.sign(cross);
    return Math.sign(cross) === sign;
  });
}
function centroid(points: readonly V2[]): V2 {
  let area = 0, x = 0, z = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length], cross = a[0] * b[1] - b[0] * a[1];
    area += cross; x += (a[0] + b[0]) * cross; z += (a[1] + b[1]) * cross;
  }
  return [x / (3 * area), z / (3 * area)];
}

/** Build a sloped roof only when the mapped height and footprint support its shape. */
export function planRoof(rings: readonly (readonly V2[])[], roof: ModelStyle["roof"], top: number): RoofPlan | undefined {
  if (!roof || roof.shape === "flat" || !(roof.height > 0) || !rings.length) return;
  const eaves = top - roof.height;
  if (roof.shape === "skillion") {
    // A single-slope roof needs a direction to tell us which side is high.
    if (roof.direction === undefined) return;
    const rad = roof.direction * Math.PI / 180, dx = Math.sin(rad), dz = Math.cos(rad);
    const coordinate = (p: V2) => p[0] * dx + p[1] * dz;
    const values = rings[0].map(coordinate), low = Math.min(...values), high = Math.max(...values);
    if (high - low < 0.01) return;
    const boundaryHeight = (p: V2) => top - roof.height * Math.max(0, Math.min(1, (coordinate(p) - low) / (high - low)));
    const flat: number[] = [], holes: number[] = [], vertices: V2[] = [];
    for (const [i, ring] of rings.entries()) {
      if (i) holes.push(vertices.length);
      for (const p of ring) { vertices.push(p); flat.push(...p); }
    }
    const indices = earcut(flat, holes), triangles: Triangle[] = [];
    for (let i = 0; i < indices.length; i += 3)
      triangles.push([at(vertices[indices[i]], boundaryHeight(vertices[indices[i]])), at(vertices[indices[i + 1]], boundaryHeight(vertices[indices[i + 1]])), at(vertices[indices[i + 2]], boundaryHeight(vertices[indices[i + 2]]))]);
    return { eaves, triangles, boundaryHeight, splitEdge: directEdge };
  }
  if (rings.length !== 1) return;
  let p = corners(rings[0]);
  if (roof.shape === "pyramidal") {
    if (!convex(p)) return;
    const center = centroid(p);
    if (!center.every(Number.isFinite)) return;
    return { eaves, triangles: p.map((v, i) => [at(v, eaves), at(p[(i + 1) % p.length], eaves), at(center, top)]), boundaryHeight: () => eaves, splitEdge: directEdge };
  }
  if (!rectangle(p)) return;
  if (roof.direction !== undefined) {
    // Choose the footprint axis closest to the mapped compass bearing.
    const radians = roof.direction * Math.PI / 180, down: V2 = [Math.sin(radians), Math.cos(radians)];
    const alignment = (a: V2, b: V2) => Math.abs(((b[0] - a[0]) * down[0] + (b[1] - a[1]) * down[1]) / length(a, b));
    const along = alignment(p[0], p[1]), across = alignment(p[0], p[3]);
    if (Math.abs(along - across) < 0.1) return;
    if (along > across) p = [p[1], p[2], p[3], p[0]];
  } else {
    // A square has no longest side to guide the ridge. Leave it flat without a mapped direction.
    if (Math.abs(length(p[0], p[1]) - length(p[1], p[2])) < 0.01) return;
    if (length(p[0], p[1]) < length(p[1], p[2]) !== Boolean(roof.across)) p = [p[1], p[2], p[3], p[0]];
  }
  let a = mid(p[0], p[3]), b = mid(p[1], p[2]);
  if (roof.shape === "hipped") {
    const fraction = Math.min(0.5, length(p[0], p[3]) / length(p[0], p[1]) / 2);
    const aa: V2 = [a[0] + (b[0] - a[0]) * fraction, a[1] + (b[1] - a[1]) * fraction];
    b = [b[0] + (a[0] - b[0]) * fraction, b[1] + (a[1] - b[1]) * fraction]; a = aa;
  }
  const triangles: Triangle[] = [
    [at(p[0], eaves), at(p[1], eaves), at(b, top)], [at(p[0], eaves), at(b, top), at(a, top)],
    [at(p[2], eaves), at(p[3], eaves), at(a, top)], [at(p[2], eaves), at(a, top), at(b, top)],
  ];
  if (roof.shape === "hipped") triangles.push([at(p[3], eaves), at(p[0], eaves), at(a, top)], [at(p[1], eaves), at(p[2], eaves), at(b, top)]);
  const ends = [[p[0], p[3]], [p[1], p[2]]] as const;
  const edgePosition = (point: V2, a: V2, b: V2) => {
    const dx = b[0] - a[0], dz = b[1] - a[1], span = Math.hypot(dx, dz);
    if (Math.abs(dx * (point[1] - a[1]) - dz * (point[0] - a[0])) / span > 0.02) return;
    const t = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / (span * span);
    return t >= -1e-8 && t <= 1 + 1e-8 ? t : undefined;
  };
  const boundaryHeight = roof.shape === "gabled"
    ? (point: V2) => {
      for (const [a, b] of ends) {
        const t = edgePosition(point, a, b);
        if (t !== undefined) return eaves + roof.height * Math.max(0, 1 - Math.abs(t * 2 - 1));
      }
      return eaves;
    }
    : () => eaves;
  const splitEdge = roof.shape === "gabled" ? (a: V2, b: V2): readonly V2[] => {
    for (const [start, end] of ends) {
      const ridge = mid(start, end), t = edgePosition(ridge, a, b);
      if (t !== undefined && t > 1e-8 && t < 1 - 1e-8) return [a, ridge, b];
    }
    return [a, b];
  } : directEdge;
  return { eaves, triangles, boundaryHeight, splitEdge };
}

export function roofSurface(w: MeshWriter, plan: RoofPlan, color: RGB, offset = 0, floor = -Infinity) {
  for (const triangle of plan.triangles) {
    const points = triangle.map(([x, y, z]): V3 => [x, Math.max(floor, y + offset), z]);
    const [a, b, c] = points;
    const u = b.map((v, i) => v - a[i]), v = c.map((v, i) => v - a[i]);
    if (Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) < 1e-8) continue;
    const vertices = points.map(([x, y, z]) => w.vertex([x, y, z], color, [x, z], 4));
    w.tri(vertices[0], vertices[1], vertices[2]);
  }
}
/** Fill the edge below the roof. For a canopy, follow its thickness so the space beneath stays open. */
export function roofEdges(w: MeshWriter, rings: readonly (readonly V2[])[], plan: RoofPlan, color: RGB, thickness?: number, floor = -Infinity) {
  for (const ring of rings) for (let i = 0; i < ring.length; i++) {
    const edge = plan.splitEdge(ring[i], ring[(i + 1) % ring.length]);
    for (let j = 0; j < edge.length - 1; j++) {
      const a = edge[j], b = edge[j + 1], ah = plan.boundaryHeight(a), bh = plan.boundaryHeight(b);
      const lowA = thickness === undefined ? plan.eaves : Math.max(floor, ah - thickness);
      const lowB = thickness === undefined ? plan.eaves : Math.max(floor, bh - thickness);
      if (Math.max(ah - lowA, bh - lowB) < 0.001) continue;
      w.quad(at(a, lowA), at(b, lowB), at(b, bh), at(a, ah), color, 0, length(a, b), Math.max(ah - lowA, bh - lowB));
    }
  }
}
