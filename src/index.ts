/** @file Public types and functions for working with a map scene. @author Norman */
export { SceneStore } from "./geo/SceneStore.js";
export type { BuildingSnapshotPin, BuildingRefreshConflict, SelectionPreview } from "./geo/SceneStore.js";
export * from "./geo/types.js";
export * from "./geo/math.js";
export * from "./geo/buildingGroups.js";
export { validateFeature } from "./geo/validation.js";
export type { PropertyEditorContext } from "./geo/PropertyEditorContext.js";
export type { ViewportSnapshot } from "./geo/Viewport.js";
export type { CameraView, MapView } from "./engine/CameraView.js";
export type { RendererOptions, RendererHandle, RenderStats, VehiclePose } from "./rendering/types.js";
export type { AssetResolver } from "./rendering/AssetLayer.js";
export type { RenderQuality } from "./rendering/quality.js";
export type { SharedDrawingSurface } from "./rendering/BabylonRenderer.js";
export { inspectGLB, MAX_GLB_BYTES } from "./assets/validation.js";

export * from "./geo/provider.js";
export * from "./geo/LiveEventLayer.js";
export * from "./geo/persistence.js";
export { FollowHeading } from "./engine/FollowHeading.js";
export { RoutePlayback, RouteSampler } from "./engine/RoutePlayback.js";
export type { PlaybackState } from "./engine/RoutePlayback.js";
export { RoadSurfaceIndex } from "./geo/routeSurface.js";
export { RouteSurfaceResolver } from "./geo/RouteSurfaceResolver.js";
export type { SurfaceWorker } from "./geo/RouteSurfaceResolver.js";
export type { RendererExtension, RendererExtensionFactory, ExtensionFrame } from "./rendering/extensions.js";
export { LabelLayer } from "./rendering/LabelLayer.js";
export { auditScene } from "./geo/diagnostics.js";
export type { SceneIssue } from "./geo/diagnostics.js";

export { fromGeoJSON, routeFeature, type AdaptedSource } from "./geo/adapters.js";
export { groupAnnotations, type ScreenPoint, type AnnotationGroup } from "./engine/annotations.js";
