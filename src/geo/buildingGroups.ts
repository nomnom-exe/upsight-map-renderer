/**
 * @file src/geo/buildingGroups.ts
 * @brief Group building parts using the provider's records.
 * @author Norman
 * @description Move and scale the parts around a shared centre.
 */
import { extentOf, pointsOf, transformFeature } from "./math.js";
import type { GeoFeature, Position } from "./types.js";

/** Use verified group IDs from the same provider. Tile IDs alone can refer to different buildings. */
export function buildingIdentity(f: GeoFeature) {
  const p = f.properties;
  return f.model?.kind === "building" &&
    typeof p.buildingGroup === "string" &&
    p.buildingGroup.length > 0 &&
    p.buildingGroupBasis &&
    Number.isInteger(p.buildingGroupMembers) &&
    Number(p.buildingGroupMembers) > 0
    ? `${f.source}:${p.buildingGroup}`
    : null;
}
export function buildingSelection(members: readonly GeoFeature[]) {
  const bounds = extentOf(members.flatMap((f) => pointsOf(f.geometry)));
  const center: Position = [
    (bounds.west + bounds.east) / 2,
    (bounds.south + bounds.north) / 2,
  ];
  const base = Math.min(...members.map((f) => f.style.elevation));
  const height =
    Math.max(...members.map((f) => f.style.elevation + f.style.height)) - base;
  const expected = Math.max(
    ...members.map((f) => Number(f.properties.buildingGroupMembers) || 1),
  );
  return {
    members,
    bounds,
    center,
    base,
    height,
    expected,
    complete:
      members.length === expected &&
      members.every((f) => f.properties.buildingGroupMembers === expected),
    basis: String(
      members[0].properties.buildingGroupBasis ?? "Unverified membership",
    ),
  };
}
export type BuildingSelection = ReturnType<typeof buildingSelection>;
export function transformBuilding(
  members: readonly GeoFeature[],
  east: number,
  north: number,
  angle = 0,
  scale = 1,
) {
  const group = buildingSelection(members);
  return members.map((f) => {
    const transformed = transformFeature(
      f,
      east,
      north,
      angle,
      scale,
      group.center,
    );
    if (transformed === f) return f;
    return {
      ...transformed,
      style: {
        ...transformed.style,
        elevation: group.base + (f.style.elevation - group.base) * scale,
      },
    };
  });
}
export function resizeBuildingHeight(
  members: readonly GeoFeature[],
  height: number,
) {
  const group = buildingSelection(members);
  if (!Number.isFinite(height) || height <= 0 || group.height <= 0)
    throw new Error("Building height must be positive.");
  const scale = height / group.height;
  return members.map((f) => ({
    ...f,
    style: {
      ...f.style,
      height: f.style.height * scale,
      elevation: group.base + (f.style.elevation - group.base) * scale,
    },
    model: {
      ...f.model!,
      ...(f.model?.roof
        ? { roof: { ...f.model.roof, height: f.model.roof.height * scale } }
        : {}),
    },
  }));
}
