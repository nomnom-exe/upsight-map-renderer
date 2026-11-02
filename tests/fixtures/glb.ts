/** @file tests/fixtures/glb.ts @brief Build small GLB models in memory for renderer tests. @author Norman */
export const triangle = new Float32Array([1, 0, 0, -1, 0, 0, 0, 0, 1]);
export function glb(extra: Record<string, unknown> = {}, payload = new Uint8Array(triangle.buffer)) {
  const doc = {
    asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    buffers: [{ byteLength: payload.byteLength }], bufferViews: [{ buffer: 0, byteLength: payload.byteLength }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [-1, 0, 0], max: [1, 0, 1] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], ...extra,
  };
  const json = new TextEncoder().encode(JSON.stringify(doc)), jsonLength = Math.ceil(json.length / 4) * 4;
  const length = 28 + jsonLength + Math.ceil(payload.byteLength / 4) * 4;
  const bytes = new Uint8Array(length), view = new DataView(bytes.buffer);
  [0x46546c67, 2, length, jsonLength, 0x4e4f534a].forEach((v, i) => view.setUint32(i * 4, v, true));
  bytes.fill(0x20, 20, 20 + jsonLength); bytes.set(json, 20);
  view.setUint32(20 + jsonLength, length - 28 - jsonLength, true);
  view.setUint32(24 + jsonLength, 0x004e4942, true); bytes.set(payload, 28 + jsonLength);
  return bytes;
}
