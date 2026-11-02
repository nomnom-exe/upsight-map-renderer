/**
 * @file src/engine/CameraView.ts
 * @brief Define the camera operations the renderer and editor use.
 * @author Norman
 * @description Both the standalone camera and the MapLibre camera use this interface.
 */

import type { Matrix } from "@babylonjs/core/Maths/math.vector.js";
import type { Extent, Position } from "../geo/types.js";
import type { ViewportSnapshot } from "../geo/Viewport.js";

export interface MapView {
  center: Position;
  zoom: number;
  pitch: number;
  bearing: number;
}
/** Convert between map coordinates and screen pixels, and control the view. */
export interface CameraView {
  readonly state: MapView;
  readonly transform: Matrix;
  snapshot(): ViewportSnapshot;
  subscribe(listener: () => void): () => void;
  resize(width: number, height: number, ratio?: number): void;
  project(p: Position, elevation?: number): { x: number; y: number } | null;
  screenToGround(x: number, y: number): Position | null;
  setView(view: Partial<MapView>): void;
  firstPerson(center: Position, bearing: number, surfaceElevation?: number): void;
  pan(fromX: number, fromY: number, toX: number, toY: number): void;
  zoomAt(delta: number, x?: number, y?: number): void;
  fitBounds(bounds: Extent): void;
}
