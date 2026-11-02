/** @file tests/AssetLayer.test.ts @brief Test GLB validation, placement and picking. @author Norman */
import { expect, it, vi } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { inspectGLB } from "../src/assets/validation";
import { AssetLayer } from "../src/rendering/AssetLayer";
import { MapCamera } from "../src/engine/MapCamera";
import { SceneStore } from "../src/geo/SceneStore";
import { DEFAULT_STYLE, type GeoFeature, type Position } from "../src/geo/types";
import { localFrame, unmercator } from "../src/geo/math";

import { glb, triangle } from "./fixtures/glb";
it("refuses URI-bearing extensions, oversized implicit accessors and out-of-bounds sparse data before decoding", () => {
  const external = glb({ extensionsUsed: ["EXT_lights_ies"],
    extensions: { EXT_lights_ies: { lights: [{ uri: "https://example.invalid/external.ies" }] } },
    nodes: [{ mesh: 0, extensions: { EXT_lights_ies: { light: 0 } } }] });
  expect(() => inspectGLB(external.buffer)).toThrow("self-contained");
  const indices = { bufferView: 0, componentType: 5121, count: 3, type: "SCALAR" };
  const mesh = { primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] };
  const position = { componentType: 5126, count: 100_000_000, type: "VEC3" };
  expect(() => inspectGLB(glb({ accessors: [position, indices], meshes: [mesh] }).buffer)).toThrow("decoded asset budget");
  const sparse = { count: 3, indices: { bufferView: 0, byteOffset: 35, componentType: 5121 }, values: { bufferView: 0 } };
  expect(() => inspectGLB(glb({ accessors: [{ ...position, count: 3, sparse }, indices], meshes: [mesh] }).buffer)).toThrow("buffer view");
});
it("validates embedded texture dimensions before asking Babylon to decode them", () => {
  const payload = new Uint8Array(36 + 33), png = new DataView(payload.buffer, 36);
  payload.set(new Uint8Array(triangle.buffer));
  [0x89504e47, 0x0d0a1a0a, 13, 0x49484452, 64000, 1].forEach((v, i) => png.setUint32(i * 4, v));
  const views = [{ buffer: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 33 }];
  const metadata = { bufferViews: views, images: [{ bufferView: 1, mimeType: "image/png" }], textures: [{ source: 0 }] };
  expect(() => inspectGLB(glb(metadata, payload).buffer)).toThrow("dimensions");
  png.setUint32(16, 2048); png.setUint32(20, 2048);
  expect(() => inspectGLB(glb({ ...metadata, textures: [{ source: 0 }, { source: 0 }] }, payload).buffer)).toThrow("pixel budget");
});

it("counts each distinct uploaded buffer view even when their binary ranges overlap", () => {
  const payload = new Uint8Array(1024 * 1024);
  payload.set(new Uint8Array(triangle.buffer));
  const bufferViews = Array.from({ length: 80 }, () => ({ buffer: 0, byteLength: payload.byteLength, byteStride: 12 }));
  const accessors = bufferViews.map((_, bufferView) => ({ bufferView, componentType: 5126, count: 3, type: "VEC3" }));
  const primitives = accessors.map((_, POSITION) => ({ attributes: { POSITION } }));
  expect(() => inspectGLB(glb({ bufferViews, accessors, meshes: [{ primitives }] }, payload).buffer))
    .toThrow("decoded asset budget");
  // All 80 accessors use one GPU buffer if they share the same buffer view.
  const shared = accessors.map((a) => ({ ...a, bufferView: 0 }));
  expect(inspectGLB(glb({ bufferViews: bufferViews.slice(0, 1), accessors: shared, meshes: [{ primitives }] }, payload).buffer).triangles).toBe(80);
});

const center: Position = [103.85, 1.3];
const feature: GeoFeature = { id: "team:floor", source: "team", layer: "imported", label: "Floor",
  geometry: { type: "Point", coordinates: center }, style: { ...DEFAULT_STYLE, elevation: 0 },
  properties: {}, model: { kind: "asset", assetId: "team:floor-v1", length: 10 } };
function sceneFixture(bytes: Uint8Array) {
  // Create the camera before the engine so Babylon uses high-precision matrices for map coordinates.
  const camera = new MapCamera(center);
  const engine = new NullEngine({ renderWidth: 800, renderHeight: 600, textureSize: 512,
    deterministicLockstep: false, lockstepMaxSteps: 4, useHighPrecisionMatrix: true });
  const scene = new Scene(engine), store = new SceneStore(), errors = vi.fn();
  camera.resize(800, 600); camera.setView({ zoom: 20, pitch: 0, bearing: 0 });
  const layer = new AssetLayer(scene, () => {}, errors, () => {}, async () => bytes);
  const draw = () => layer.render(camera.snapshot(), camera.transform, new Set(), null, false);
  const off = store.subscribe(({ ids }) => layer.sync(store, ids));
  const upsert = (...features: GeoFeature[]) => store.execute({ type: "upsert", features });
  const dispose = () => { off(); layer.dispose(); scene.dispose(); engine.dispose(); };
  return { layer, camera, scene, store, errors, draw, upsert, dispose };
}

it("renders translated nodes sharing a non-indexed mesh, counts both, and picks them after an edit", async () => {
  const bytes = glb({ nodes: [{ mesh: 0 }, { mesh: 0, translation: [3, 0, 0] }], scenes: [{ nodes: [0, 1] }] });
  const { layer, camera, scene, store, draw, upsert, dispose } = sceneFixture(bytes);
  try {
    upsert(feature);
    await vi.waitFor(() => { draw(); expect(layer.stats.visible).toBe(1); }, { timeout: 10000 });
    expect(layer.stats.triangles).toBe(2);
    const meshes = scene.meshes.filter((mesh) => mesh.getTotalVertices() > 0);
    expect(meshes).toHaveLength(2);
    expect(new Set(meshes.map((m) => m.material)).size).toBe(2);
    const pixels = () => meshes.map((mesh) => {
      const world = mesh.getWorldMatrix();
      expect(mesh.material!.serialize().matrices.mapMatrix).toEqual(world.multiply(camera.transform).asArray());
      const centroid = Vector3.TransformCoordinates(new Vector3(0, 0, 1 / 3), world);
      return camera.project(unmercator([centroid.x, centroid.y]))!;
    });
    const before = pixels();
    expect(Math.abs(before[0].x - before[1].x)).toBeGreaterThan(10);
    before.forEach(({ x, y }) => expect(layer.pick(x, y, 800, 600)?.id).toBe(feature.id));
    upsert(...store.transformSelection(feature.id, 15, 0, 30, 1.5)); draw();
    before.forEach(({ x, y }) => expect(layer.pick(x, y, 800, 600)).toBeNull());
    pixels().forEach(({ x, y }) => expect(layer.pick(x, y, 800, 600)?.id).toBe(feature.id));
  } finally { dispose(); }
});

it.each([true, false])("keeps a flat ordinary asset usable with a charger (asset loaded first: %s)", async (cached) => {
  const { layer, camera, draw, upsert, dispose, errors } = sceneFixture(glb());
  try {
    const charger: GeoFeature = { ...feature, id: "team:charger", layer: "chargers", geometry: { type: "Point",
      coordinates: localFrame(center).unproject(15, 0) }, model: { kind: "charger", assetId: feature.model!.assetId } };
    if (cached) {
      upsert(feature);
      await vi.waitFor(() => { draw(); expect(layer.stats.visible).toBe(1); }, { timeout: 10000 });
      upsert(charger);
    } else upsert(charger, feature);
    await vi.waitFor(() => { draw(); expect(layer.stats).toMatchObject({ visible: 1, deferred: 1, triangles: 1 }); },
      { timeout: 10000 });
    const p = camera.project(center)!;
    expect(layer.pick(p.x, p.y, 800, 600)?.id).toBe(feature.id);
    draw();
    expect(errors.mock.calls.filter(([message]) => message.includes("nonzero height"))).toHaveLength(1);
  } finally { dispose(); }
});

it.each([true, false])("rejects external lighting payloads before loader URI resolution (declared: %s)", async (declared) => {
  const { GLTFLoader } = await import("@babylonjs/loaders/glTF/2.0/glTFLoader.js");
  const request = vi.spyOn(GLTFLoader.prototype, "loadUriAsync").mockRejectedValue(new Error("Unexpected URI request"));
  const bytes = glb({ ...(declared ? { extensionsUsed: ["EXT_lights_ies"] } : {}),
    nodes: [{ mesh: 0, extensions: { EXT_lights_ies: { light: 0 } } }],
    extensions: { EXT_lights_ies: { lights: [{ uri: "https://example.invalid/external.ies" }] } } });
  const { layer, errors, draw, upsert, dispose } = sceneFixture(bytes);
  try {
    upsert(feature);
    await vi.waitFor(() => { draw(); expect(errors).toHaveBeenCalledWith(expect.stringContaining("EXT_lights_ies")); });
    expect(layer.stats.visible).toBe(0);
    expect(request).not.toHaveBeenCalled();
  } finally { request.mockRestore(); dispose(); }
});
