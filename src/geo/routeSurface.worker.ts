/** @file geo/routeSurface.worker.ts @brief Reuse the road index across requests for the same road revision. @author Norman */
import { RoadSurfaceIndex } from "./routeSurface.js";
import type { SurfaceRequest, SurfaceResponse } from "./RouteSurfaceResolver.js";
let index: RoadSurfaceIndex | undefined, revision = -1;
self.onmessage = ({ data }: MessageEvent<SurfaceRequest>) => {
  let response: SurfaceResponse;
  try {
    if (data.roads) { index = new RoadSurfaceIndex(data.roads, data.origin); revision = data.revision; }
    if (!index || revision !== data.revision) throw new Error("Road index revision unavailable.");
    response = { id: data.id, route: index.resolve(data.route) };
  } catch (error) { response = { id: data.id, error: error instanceof Error ? error.message : "Road matching unavailable." }; }
  self.postMessage(response);
};
