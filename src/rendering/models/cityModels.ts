/**
 * @file src/rendering/models/cityModels.ts
 * @brief Build city models from the shapes of map features.
 * @author Norman
 * @description Uses local coordinates and adds detail when the camera is close.
 */

import { localFrame } from "../../geo/math.js";
import type { GeoFeature, Position } from "../../geo/types.js";
import { hash } from "../../geo/hash.js";
import { MeshWriter, rgb, type V2 } from "./MeshWriter.js";
import { building } from "./building.js";
import { road } from "./road.js";

function inside([x, z]: V2, ring: readonly V2[]) {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (
      a[1] > z !== b[1] > z &&
      x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]
    )
      result = !result;
  }
  return result;
}
function tree(
  w: MeshWriter,
  x: number,
  z: number,
  height: number,
  base: number,
  detail: number,
) {
  w.box(x, base, z, 0.35, height * 0.55, 0.35, rgb("#85715b"));
  const r = height * 0.3;
  w.crown(x, base + height * 0.67, z, r, rgb("#6c935d"), detail ? 8 : 5);
  if (detail)
    w.crown(
      x + r * 0.55,
      base + height * 0.57,
      z + r * 0.25,
      r * 0.67,
      rgb("#86a66b"),
      7,
    );
}
/** Start with mapped shapes and add details such as windows, roof surfaces and trees. */
export function buildCityModels(
  features: readonly GeoFeature[],
  origin: Position,
  keyOf: (id: string) => number,
  detail: 0 | 1,
) {
  const w = new MeshWriter(),
    frame = localFrame(origin);
  for (const f of features) {
    w.id = f.id;
    w.key = keyOf(f.id);
    w.pointTransform = undefined;
    const s = f.style,
      g = f.geometry,
      kind = f.model!.kind,
      color = rgb(s.color);
    if (g.type === "Polygon") {
      const rings = g.coordinates.map((r) => r.map((p) => frame.project(p))),
        outer = rings[0];
      if (kind === "building") {
        building(w, rings, f, detail);
      } else {
        w.polygon(
          rings,
          s.elevation,
          color,
          kind === "water" ? 6 : kind === "park" ? 7 : 0,
        );
        if (kind === "park" && detail) {
          // Use the park ID to place decorative trees in the same spots each time. Skip holes in the park.
          const xs = outer.map((p) => p[0]),
            zs = outer.map((p) => p[1]),
            left = Math.min(...xs),
            bottom = Math.min(...zs),
            width = Math.max(...xs) - left,
            depth = Math.max(...zs) - bottom;
          let seed = hash(f.id),
            added = 0;
          const random = () => {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            return seed / 4294967296;
          };
          for (
            let i = 0;
            i < Math.min(80, (width * depth) / 90) && added < 24;
            i++
          ) {
            const p: V2 = [left + random() * width, bottom + random() * depth];
            if (inside(p, outer) && !rings.slice(1).some((h) => inside(p, h))) {
              tree(w, p[0], p[1], 5 + random() * 4, s.elevation, detail);
              added++;
            }
          }
        }
      }
    } else if (g.type === "LineString") {
      const p = g.coordinates.map((v) => frame.project(v));
      if (kind === "road") {
        if (!f.model?.road?.surfaceHidden) road(w, p, f, detail);
      } else if (kind === "line") {
        w.ribbon(p, f.model?.line?.widths ?? s.width, f.model?.line?.elevations ?? s.elevation, color, f.model?.line?.dashed ? 13 : 0, true, 0, f.model?.line?.segmentMask);
      }
    } else {
      const [x, z] = frame.project(g.coordinates);
      w.pointTransform = {
        x,
        z,
        angle: ((f.model?.heading ?? 0) * Math.PI) / 180,
      };
      if (kind === "tree") tree(w, x, z, s.height, s.elevation, detail);
      if (kind === "charger") {
        w.box(x, s.elevation, z, 1.4, 0.16, 1.0, rgb("#b6beb8"));
        w.box(x, s.elevation + 0.16, z, 0.85, s.height, 0.55, color);
        w.box(
          x,
          s.elevation + s.height * 0.6,
          z - 0.29,
          0.55,
          0.5,
          0.035,
          rgb("#183741"),
        );
        w.box(
          x,
          s.elevation + s.height * 0.68,
          z - 0.315,
          0.36,
          0.23,
          0.02,
          rgb("#99e0d7"),
        );
        w.box(
          x,
          s.elevation + s.height + 0.16,
          z,
          1.05,
          0.12,
          0.7,
          rgb("#d7e5df"),
        );
        w.box(
          x + 0.49,
          s.elevation + 0.6,
          z,
          0.09,
          s.height * 0.5,
          0.09,
          rgb("#293e43"),
        );
      }
    }
  }
  return w.finish();
}
