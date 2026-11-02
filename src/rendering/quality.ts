/**
 * @file src/rendering/quality.ts
 * @brief Choose rendering limits and levels of detail.
 * @author Norman
 * @description Uses screen size and device capabilities to limit pixel density, cache size and uploads per frame.
 */

import type { Extent, Position } from "../geo/types.js";
import { distance } from "../geo/math.js";

export interface RenderQuality {
  name: "mobile" | "standard";
  pixelRatio: number;
  maxVisible: number;
  maxCached: number;
  cacheBytes: number;
  uploadsPerFrame: number;
  uploadBudgetMs: number;
  nearMetres: number;
}
export function qualityForDevice(hints: { width: number; dpr: number; coarse: boolean; cores?: number; memoryGB?: number }): RenderQuality {
  const mobile = hints.width <= 768 || hints.coarse || (hints.cores !== undefined && hints.cores <= 4) || (hints.memoryGB !== undefined && hints.memoryGB <= 4);
  return {
    name: mobile ? "mobile" : "standard",
    pixelRatio: Math.min(Math.max(1, hints.dpr || 1), mobile ? 1.5 : 2),
    maxVisible: mobile ? 96 : 256,
    maxCached: mobile ? 128 : 320,
    cacheBytes: (mobile ? 48 : 128) * 1024 * 1024,
    uploadsPerFrame: mobile ? 1 : 3,
    uploadBudgetMs: mobile ? 3 : 6,
    nearMetres: mobile ? 450 : 900,
  };
}
export function deviceQuality(): RenderQuality {
  return qualityForDevice({
    width: window.innerWidth,
    dpr: window.devicePixelRatio,
    coarse: window.matchMedia("(pointer: coarse)").matches,
    cores: navigator.hardwareConcurrency,
    memoryGB: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
  });
}
/** Keep the same footprint at both detail levels. Different thresholds for entering and leaving the near view avoid repeated rebuilds. */
export function batchDetail(bounds: Extent, centre: Position, zoom: number, quality: RenderQuality, previous = 0): 0 | 1 {
  const nearest: Position = [Math.max(bounds.west, Math.min(bounds.east, centre[0])), Math.max(bounds.south, Math.min(bounds.north, centre[1]))];
  const threshold = quality.nearMetres * (previous ? 1.3 : 1);
  return zoom >= (previous ? 15.8 : 16.2) && distance(centre, nearest) <= threshold ? 1 : 0;
}
