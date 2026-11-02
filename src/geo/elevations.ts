/** @file src/geo/elevations.ts @brief Calculate road and route heights in metres. @author Norman */
import type { GeoFeature } from "./types.js";

// At the default style elevation of 0.18 m, each vertex keeps its mapped height.
export function roadBaseHeight(f: GeoFeature, vertex: number) {
  const measured = f.model?.road?.elevations?.[vertex];
  return measured === undefined ? f.style.elevation : measured + f.style.elevation - 0.18;
}
export const ASPHALT_OFFSET = 0.08;
// Mapped heights and style elevations can each reach ±1,000 m.
// The route sits another 0.14 m above the asphalt.
export const MIN_LINE_ELEVATION = -2000;
export const MAX_LINE_ELEVATION = 2000.05;
