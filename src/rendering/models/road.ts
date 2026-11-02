/**
 * @file src/rendering/models/road.ts
 * @brief Draw connected roads using mapped widths and elevations at shared points.
 * @author Norman
 * @description Builds asphalt, mapped sidewalks and lane markings together in one mesh batch.
 */
import type { GeoFeature } from "../../geo/types.js";
import { ASPHALT_OFFSET, roadBaseHeight } from "../../geo/elevations.js";
import { MeshWriter, rgb, type V2 } from "./MeshWriter.js";
export function road(
  w: MeshWriter,
  points: readonly V2[],
  f: GeoFeature,
  detail: 0 | 1,
) {
  const s = f.style,
    recipe = f.model?.road;
  const profile = points.map((_, i) => roadBaseHeight(f, i));
  const lift = (amount: number) => profile.map((h) => h + amount);
  // Draw sidewalks only beside the road. A layer beneath the asphalt sits so
  // close to it that the two surfaces can flicker at a distance.
  const sidewalkSides =
    recipe?.sidewalkSide === "left"
      ? [1]
      : recipe?.sidewalkSide === "right"
        ? [-1]
        : [-1, 1];
  if (recipe?.sidewalk && !recipe.footway)
    for (const side of sidewalkSides)
      w.ribbon(
        points,
        1.2,
        lift(0.12),
        rgb("#c4c3b6"),
        0,
        false,
        side * (s.width / 2 + 0.6),
      );
  w.ribbon(
    points,
    s.width,
    lift(ASPHALT_OFFSET),
    rgb(recipe?.paved === false ? "#b5a98e" : s.color),
  );
  if (!detail || recipe?.footway || recipe?.paved === false) return;
  // Draw lane dividers only when the map gives a lane count.
  for (let lane = 1; lane < (recipe?.lanes ?? 0); lane++)
    w.ribbon(
      points,
      0.12,
      lift(0.1),
      rgb("#e8e6d6"),
      5,
      false,
      s.width * (lane / recipe!.lanes - 0.5),
    );
  if (s.width >= 5)
    for (const side of [-1, 1])
      w.ribbon(
        points,
        0.1,
        lift(0.1),
        rgb("#e1dfcc"),
        11,
        false,
        side * (s.width / 2 - 0.22),
      );
}
