/**
 * @file geo/diagnostics.ts
 * @brief Report possible map geometry conflicts within a fixed work limit.
 * @author Norman
 */
import type { GeoFeature, Position } from "./types.js";
import { extentOf, pointsOf } from "./math.js";
import { buildingIdentity } from "./buildingGroups.js";
import { ASPHALT_OFFSET, roadBaseHeight } from "./elevations.js";
import { SpatialIndex } from "../rendering/SpatialIndex.js";

export interface SceneIssue {
  kind: "duplicate-footprint" | "incomplete-building" | "possible-road-obstruction";
  ids: string[];
  message: string;
}
const cross = (a: Position, b: Position) => a[0] * b[1] - a[1] * b[0];
const minus = (a: Position, b: Position): Position => [a[0] - b[0], a[1] - b[1]];
function inside(p: Position, ring: readonly Position[]) {
  let yes = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) yes = !yes;
  }
  return yes;
}
/** Check mapped centre lines against building heights. This check leaves the scene unchanged.
 * Road width, terrain, mesh interiors and unmapped passages need separate review for navigation safety. */
export function auditScene(features: readonly GeoFeature[], options: { maxOperations?: number; maxIssues?: number; clearanceMetres?: number } = {}) {
  if (Object.values(options).some(value => !Number.isFinite(value))) throw new Error("Diagnostic budgets must be finite.");
  const maxOps = Math.max(1, Math.min(2_000_000, options.maxOperations ?? 100_000));
  const maxIssues = Math.max(1, Math.min(1000, options.maxIssues ?? 100));
  const clearance = Math.max(0, Math.min(20, options.clearanceMetres ?? 3));
  let operations = 0, truncated = false;
  const issues: SceneIssue[] = [];
  const spend = (n = 1) => { operations += n; if (operations > maxOps) { truncated = true; return false; } return true; };
  const add = (issue: SceneIssue) => { if (issues.length < maxIssues) issues.push(issue); else truncated = true; };
  const index = new SpatialIndex(), buildings = new Map<string, GeoFeature>();
  const shapes = new Map<string, string>(), groups = new Map<string, GeoFeature[]>();
  for (const f of features) {
    if (!spend()) break;
    if (f.model?.kind !== "building" || f.geometry.type !== "Polygon") continue;
    if (!spend(pointsOf(f.geometry).length)) break;
    buildings.set(f.id, f); index.set(f.id, extentOf(pointsOf(f.geometry)));
    const key = JSON.stringify([f.geometry.coordinates, f.style.elevation, f.style.height]);
    const duplicate = shapes.get(key);
    if (duplicate) add({ kind: "duplicate-footprint", ids: [duplicate, f.id], message: "Identical ordered footprint and vertical interval; review source duplication." });
    else shapes.set(key, f.id);
    const group = buildingIdentity(f);
    if (group) { const members = groups.get(group) ?? []; members.push(f); groups.set(group, members); }
  }
  for (const members of groups.values()) {
    const expected = members[0].properties.buildingGroupMembers;
    if (members.length !== expected || members.some(f => f.properties.buildingGroupMembers !== expected))
      add({ kind: "incomplete-building", ids: members.map(f => f.id), message: "Only part of this building group is loaded; group edits must wait." });
  }
  outer: for (const road of features) {
    if (road.geometry.type !== "LineString" || !(road.model?.kind === "road" || road.layer === "route")) continue;
    if (road.model?.road?.surfaceHidden) continue;
    const line = road.geometry.coordinates;
    const heightAt = (i: number) => road.model?.kind === "road"
      ? roadBaseHeight(road, i) + ASPHALT_OFFSET
      : road.model?.line?.elevations?.[i] ?? road.style.elevation;
    for (const id of index.query(extentOf(line))) {
      if (!spend()) break outer;
      const building = buildings.get(id)!;
      if (building.geometry.type !== "Polygon") continue;
      const rings = building.geometry.coordinates;
      const bottom = building.style.elevation, top = bottom + building.style.height;
      let blocked = false;
      for (let i = 1; i < line.length && !blocked; i++) {
        if (road.model?.line?.segmentMask?.[i - 1] === false) continue;
        const a = line[i - 1], b = line[i], d = minus(b, a), cuts = [0, 1];
        for (const ring of rings) for (let j = 0; j < ring.length; j++) {
          if (!spend()) break outer;
          const c = ring[j], e = minus(ring[(j + 1) % ring.length], c), ca = minus(c, a);
          const den = cross(d, e);
          if (Math.abs(den) < 1e-18) continue;
          const t = cross(ca, e) / den, u = cross(ca, d) / den;
          if (t > 0 && t < 1 && u >= 0 && u <= 1) cuts.push(t);
        }
        cuts.sort((x, y) => x - y);
        const h0 = heightAt(i - 1), h1 = heightAt(i);
        for (let j = 1; j < cuts.length; j++) {
          if (!spend(rings.reduce((n, ring) => n + ring.length, 0))) break outer;
          const lo = cuts[j - 1], hi = cuts[j], t = (lo + hi) / 2;
          if (hi - lo < 1e-9) continue;
          const p: Position = [a[0] + d[0] * t, a[1] + d[1] * t];
          if (!inside(p, rings[0]) || rings.slice(1).some(ring => inside(p, ring))) continue;
          const heights = [h0 + (h1 - h0) * lo, h0 + (h1 - h0) * hi];
          if (Math.min(...heights) < top && Math.max(...heights) + clearance > bottom) { blocked = true; break; }
        }
      }
      if (blocked) add({ kind: "possible-road-obstruction", ids: [road.id, id], message: "Mapped centerline overlaps the building volume at this clearance. Check elevation, passages and source accuracy." });
      if (issues.length >= maxIssues) { truncated = true; break outer; }
    }
  }
  return { issues, operations, truncated };
}
