/**
 * @file src/rendering/types.ts
 * @brief Define the renderer API and its performance statistics.
 * @author Norman
 * @description Includes renderer options, controls for the map view and the vehicle position and heading.
 */

import type { LayerName, Position } from "../geo/types.js";
import type { RenderQuality } from "./quality.js";
import type { ViewportSnapshot } from "../geo/Viewport.js";
export interface RenderStats {
  renderCpuMs?: number;
  renderCpuP95?: number;
  reducedDetail?: boolean;
  deferredBatches?: number;
  assetsVisible?: number;
  assetsDeferred?: number;
  assetBytes?: number;
  features: number;
  batches: number;
  visible: number;
  cached: number;
  triangles: number;
  drawCalls: number;
  uploadedBytes: number;
  totalUploadedBytes: number;
  geometryBuilds: number;
  buildMs: number;
  uploadMs: number;
  cachedBytes: number;
  profile: "mobile" | "standard";
  geometryMode: "worker" | "main-thread fallback";
  detail: "near" | "far";
}
export interface VehiclePose {
  position: Position;
  bearing: number;
  visible: boolean;
  elevation?: number;
}
export interface RendererOptions {
  /** Create a worker that works with the host bundler and security policy. Return null to build one batch at a time on the main thread. */
  createGeometryWorker?: () => Worker | null;
  /** Return the GLB bytes for an asset ID. The host chooses where to load them from. */
  resolveAsset?: import("./AssetLayer.js").AssetResolver;
  extensions?: readonly import("./extensions.js").RendererExtensionFactory[];
  onAssetReady?: (assetId: string, ready: boolean) => void;
  quality?: RenderQuality;
  onStats?: (stats: RenderStats) => void;
  onError?: (error: string) => void;
}
export interface RendererHandle {
  subscribeFrame(listener: () => void): () => void;
  select(id: string | null): void;
  pick(x: number, y: number): string | null;
  project(
    position: Position,
    elevation?: number,
  ): { x: number; y: number } | null;
  screenToGround(x: number, y: number): Position | null;
  getViewport(): ViewportSnapshot | null;
  setLayerVisible(layer: LayerName, visible: boolean): void;
  setVehicle(pose: VehiclePose | null): void;
  dispose(): void;
}
