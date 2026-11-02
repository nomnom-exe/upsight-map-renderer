/**
 * @file src/rendering/geometry.worker.ts
 * @brief Build mesh geometry in a web worker.
 * @author Norman
 * @description Builds one batch per request and transfers its mesh buffers back to the renderer.
 */

import { buildGeometry } from "./geometry.js";
import type { BuildRequest, BuildResponse } from "./GeometryBuilder.js";

const scope = self as unknown as {
  onmessage: (event: MessageEvent<BuildRequest>) => void;
  postMessage(value: BuildResponse, transfer: Transferable[]): void;
};
scope.onmessage = ({ data: request }) => {
  try {
    const start = performance.now(), keys = new Map(request.keys);
    const data = buildGeometry(request.features, request.origin, key => keys.get(key)!, request.detail);
    const transfer: Transferable[] = [data.positions.buffer, data.colors.buffer, data.keys.buffer, data.indices.buffer] as ArrayBuffer[];
    if (data.surface) transfer.push(data.surface.buffer as ArrayBuffer);
    scope.postMessage({ id: request.id, data, buildMs: performance.now() - start }, transfer);
  } catch (error) {
    scope.postMessage({ id: request.id, error: String(error) }, []);
  }
};
