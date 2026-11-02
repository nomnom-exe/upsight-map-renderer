/**
 * @file src/geo/Viewport.ts
 * @brief Describe the map viewport as it appeared in the last frame.
 * @author Norman
 * @description Includes camera settings, canvas size and the ground visible at the canvas corners.
 */

import type { Extent, Position } from "./types.js";

/** Use canvas-relative CSS pixels for screen coordinates. */
export interface ViewportSnapshot {
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
  readonly center: Position;
  readonly zoom: number;
  readonly pitch: number;
  readonly bearing: number;
  /** Map area to check for features. The standalone camera limits each axis to 5 km from the centre. */
  readonly bounds: Extent;
  /** Clockwise from the top left. A corner is null when its view ray misses the ground. */
  readonly groundCorners: readonly (Position | null)[];
}
