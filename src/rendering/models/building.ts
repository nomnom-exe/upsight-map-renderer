/**
 * @file src/rendering/models/building.ts
 * @brief Build different types of structures from their mapped footprints.
 * @author Norman
 * @description Keeps passages and courtyards open and uses mapped roof shapes and dimensions where supported.
 */
import type { GeoFeature } from "../../geo/types.js";
import { hash } from "../../geo/hash.js";
import { buildingIdentity } from "../../geo/buildingGroups.js";
import { MeshWriter, rgb, type V2 } from "./MeshWriter.js";
import { planRoof, roofEdges, roofSurface } from "./roofs.js";

export function building(
  w: MeshWriter,
  rings: readonly (readonly V2[])[],
  f: GeoFeature,
  detail: 0 | 1,
) {
  const s = f.style,
    model = f.model!,
    top = s.elevation + s.height,
    color = rgb(s.color);
  const roofColor = rgb(model.roof?.color ?? "#aebcbb");
  const roof = planRoof(rings, model.roof, top);
  const eaves = roof?.eaves ?? top;
  // Add an underside so an elevated building is visible from the passage below.
  // Using the same rings keeps its courtyards open.
  if (s.elevation > 0 && model.family !== "canopy")
    w.polygon(
      rings,
      s.elevation,
      [color[0] * 0.7, color[1] * 0.7, color[2] * 0.7],
      4,
    );
  if (model.family === "canopy") {
    // Leave the space below the canopy open. The support positions are estimates.
    const thickness = Math.min(0.25, s.height * 0.1);
    const soffitAt = (p: V2) => Math.max(s.elevation, (roof?.boundaryHeight(p) ?? top) - thickness);
    if (roof) {
      roofSurface(w, roof, roofColor);
      roofSurface(w, roof, color, -thickness, s.elevation);
      roofEdges(w, rings, roof, color, thickness, s.elevation);
    } else {
      const soffit = Math.max(s.elevation, top - thickness);
      w.walls(rings, soffit, top, color);
      w.polygon(rings, top, roofColor, 4);
      w.polygon(rings, soffit, color, 4);
    }
    const excluded = new Set(model.omitSupports ?? []);
    for (const p of rings[0].filter(
      (_, i) =>
        !excluded.has(i) &&
        i % Math.max(1, Math.ceil(rings[0].length / 12)) === 0,
    ))
      w.box(
        p[0],
        s.elevation,
        p[1],
        0.2,
        soffitAt(p) - s.elevation,
        0.2,
        rgb("#a2adaa"),
      );
    return;
  }
  if (model.family === "parking" && detail && s.height >= 3 && s.height <= 65) {
    // Use the mapped footprint and height, and estimate the spacing of decks and supports.
    // If a passage splits the building into sections, give each section its share of
    // the mapped floor count so the decks stay the right distance apart.
    const sourceSpan =
      Number(f.properties.sourceHeight) - Number(f.properties.sourceMinHeight);
    const mappedFloors = Number(f.properties.levels) || 0;
    const floors = Math.max(
      1,
      Math.min(
        20,
        Math.round(
          mappedFloors
            ? f.properties.visualCorrection && sourceSpan > 0
              ? (mappedFloors * s.height) / sourceSpan
              : mappedFloors
            : s.height / 3.2,
        ),
      ),
    );
    const floorHeight = (eaves - s.elevation) / floors;
    for (let i = 0; i < floors; i++) {
      const base = s.elevation + i * floorHeight;
      w.polygon(rings, Math.min(eaves, base + 0.15), rgb("#adb4ad"), 4);
      w.walls(rings, base, Math.min(eaves, base + 0.9), color);
    }
    // Each perimeter pillar runs through all floors.
    let columns = 0;
    for (const ring of rings)
      for (let i = 0; i < ring.length && columns < 96; i++) {
        const a = ring[i],
          b = ring[(i + 1) % ring.length];
        const bays = Math.max(
          1,
          Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 6),
        );
        for (let j = 0; j < bays && columns < 96; j++, columns++)
          w.box(
            a[0] + ((b[0] - a[0]) * j) / bays,
            s.elevation,
            a[1] + ((b[1] - a[1]) * j) / bays,
            0.28,
            eaves - s.elevation,
            0.28,
            color,
          );
      }
    if (roof) {
      roofSurface(w, roof, roofColor);
      roofEdges(w, rings, roof, color);
    } else w.polygon(rings, top, roofColor, 4);
    return;
  }
  // The shader draws facade bands on the existing mesh and fades them with distance.
  const surface =
    model.family === "parking"
      ? 8
      : model.family === "industrial"
        ? 10
        : model.facade === "glass"
            ? 1
            : model.facade === "brick"
              ? 3
              : model.family === "residential" && model.facade === "stone"
                ? 9
                : model.family === "house" && model.facade === "stone"
                  ? 12
              : model.facade === "stone"
                ? 2
                : 0;
  // The fractional part of the material number picks a facade pattern.
  // Parts in the same verified building group share a pattern number.
  const identity = buildingIdentity(f) ?? `${f.source}:${f.properties.sourceId || f.id}`;
  const material = surface + (surface ? (hash(identity) % 3) / 10 : 0);
  const levels = Number(f.properties.levels);
  const corrected = Boolean(f.properties.visualCorrection);
  const datum = corrected ? Number(f.properties.sourceMinHeight) : s.elevation;
  // Use the original building height for every section around a passage.
  // This keeps floor lines aligned even when only the top section has a roof.
  const span = corrected
    ? Number(f.properties.sourceHeight) - datum
    : eaves - s.elevation;
  const floorHeight = levels > 0 ? span / levels : 3.2;
  const facade = {
    floorHeight: Number.isFinite(floorHeight) && floorHeight >= 2 && floorHeight <= 8 ? floorHeight : 3.2,
    datum: Number.isFinite(datum) ? datum : s.elevation,
  };
  w.walls(rings, s.elevation, eaves, color, material, facade);
  if (roof) {
    roofSurface(w, roof, roofColor);
    roofEdges(w, rings, roof, color);
  } else w.polygon(rings, top, roofColor, 4);
}
