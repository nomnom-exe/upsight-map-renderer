/**
 * @file src/geo/PropertyEditorContext.ts
 * @brief Define how a host editor interacts with the rendered map.
 * @author Norman
 * @description Select features, edit the scene and convert between screen and map coordinates.
 */

import type { GeoFeature, Position } from "./types.js";
import type { SceneStore } from "./SceneStore.js";
import type { ViewportSnapshot } from "./Viewport.js";
import type { BuildingSelection } from "./buildingGroups.js";
/** Use this interface for edits. The renderer owns the Babylon meshes. */
export interface PropertyEditorContext {
  readonly feature: GeoFeature | undefined;
  /** Building parts that belong together, however the renderer draws them. */
  readonly building?: BuildingSelection;
  readonly store: SceneStore;
  /** Find the feature at a pixel position relative to the canvas. */
  pick(x: number, y: number): string | null;
  select(id: string | null): void;
  focus(): void;
  /** Pause map gestures during a drag. Call the returned function when the pointer is released or cancelled. */
  beginInteraction(): () => void;
  project(
    position: Position,
    elevation?: number,
  ): { x: number; y: number } | null;
  /** Convert a position in canvas pixels to coordinates on flat ground. */
  screenToGround(x: number, y: number): Position | null;
  getViewport(): ViewportSnapshot | null;
  /** Listen for camera changes and canvas resizes. Call the returned function to unsubscribe. */
  subscribeViewport(listener: () => void): () => void;
}
