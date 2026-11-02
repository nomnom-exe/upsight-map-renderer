/** @file tests/partnerModels.test.ts @brief Test how the partner example registers GLBs, places them and manages copies of their bytes. @author Norman */
import { expect, it } from "vitest";
import { SceneStore, inspectGLB, localFrame } from "@upsight/map-renderer";
import { createPartnerModels } from "../examples/partnerModels";

/** A self-contained GLB with a single non-indexed triangle. */
function triangleGLB(extra: Record<string, unknown> = {}) {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const json = JSON.stringify({
    asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    buffers: [{ byteLength: positions.byteLength }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], ...extra,
  });
  const text = new TextEncoder().encode(json.padEnd(Math.ceil(json.length / 4) * 4));
  const bytes = new Uint8Array(20 + text.length + 8 + positions.byteLength), view = new DataView(bytes.buffer);
  [0x46546c67, 2, bytes.byteLength, text.length, 0x4e4f534a].forEach((value, index) => view.setUint32(index * 4, value, true));
  bytes.set(text, 20);
  view.setUint32(20 + text.length, positions.byteLength, true);
  view.setUint32(24 + text.length, 0x004e4942, true);
  bytes.set(new Uint8Array(positions.buffer), 28 + text.length);
  return bytes;
}

it("owns exact byte copies and never shares mutable buffers with the host or decoder", async () => {
  const store = new SceneStore(), library = createPartnerModels(store), original = triangleGLB();
  const padded = new Uint8Array(original.byteLength + 16);
  padded.set(original, 8);
  const id = library.register("depot-v1", padded.subarray(8, 8 + original.byteLength));
  padded.fill(0);
  const decoded = await library.resolveAsset(id);
  expect(decoded).toEqual(original);
  expect(inspectGLB(Uint8Array.from(decoded).buffer)).toEqual({ meshes: 1, triangles: 1 });
  decoded.fill(0);
  expect(await library.resolveAsset(id)).toEqual(original);
  expect(library.byteLength).toBe(original.byteLength);
  expect(library.size).toBe(1);
  expect(() => library.register("depot-v1", original)).toThrow("immutable");
});

it("places several editable instances, preserves authored colours, and keeps bytes available through delete/undo", async () => {
  const store = new SceneStore(), library = createPartnerModels(store, "team15"), frame = localFrame([103.85, 1.3]);
  const assetId = library.register("depot-v1", triangleGLB());
  const original = library.place({ id: "north-depot", assetId, label: "North depot", position: frame.unproject(0, 0), lengthMetres: 20, headingDegrees: 15, elevationMetres: -2 });
  const second = library.place({ id: "east-depot", assetId, label: "East depot", position: frame.unproject(50, 0), lengthMetres: 10 });
  expect(original.style.color).toBe("#ffffff");
  expect(original.style.elevation).toBe(-2);
  const gesture = store.beginSelectionPreview(original.id);
  gesture.transform(12, 8, 30, 2);
  gesture.finish(true);
  const edited = store.get(original.id)!;
  expect(edited.model).toMatchObject({ assetId, length: 40, heading: 45 });
  expect(edited.geometry.type).toBe("Point");
  if (edited.geometry.type === "Point") {
    const [east, north] = frame.project(edited.geometry.coordinates);
    expect(east).toBeCloseTo(12, 5); expect(north).toBeCloseTo(8, 5);
  }
  expect(store.get(second.id)).toEqual(second);
  const saved = store.exportScenario();
  const restored = new SceneStore(); restored.importScenario(saved);
  expect(restored.get(original.id)).toEqual(edited);
  expect(saved).not.toContain("buffers");
  store.execute({ type: "remove", ids: [original.id] });
  expect(() => library.place({ id: "north-depot", assetId, label: "Replacement", position: [103.85, 1.3], lengthMetres: 5 })).toThrow("already exists");
  expect((await library.resolveAsset(assetId)).byteLength).toBeGreaterThan(0);
  store.undo(); expect(store.get(original.id)).toEqual(edited);
  library.dispose(); library.dispose();
  expect(library.size).toBe(0); expect(library.byteLength).toBe(0);
  expect(store.get(original.id)).toEqual(edited);
  await expect(library.resolveAsset(assetId)).rejects.toThrow("disposed");
  expect(() => library.register("depot-v2", triangleGLB())).toThrow("disposed");
});

it("rejects nonportable bytes, unknown models, invalid placement and budget overflow without changing the scene", async () => {
  const store = new SceneStore(), bytes = triangleGLB(), library = createPartnerModels(store, "team15", bytes.byteLength);
  expect(() => library.register("broken", new ArrayBuffer(30))).toThrow("header");
  expect(library.size).toBe(0);
  expect(() => createPartnerModels(store, "Bad source")).toThrow("source ID");
  expect(() => createPartnerModels(store, "team15", -1)).toThrow("budget");
  const unbounded = createPartnerModels(store);
  expect(() => unbounded.register("external", triangleGLB({ buffers: [{ uri: "model.bin" }] }))).toThrow("self-contained");
  expect(() => unbounded.register("compressed", triangleGLB({ extensionsUsed: ["KHR_draco_mesh_compression"] }))).toThrow("uncompressed");
  const assetId = library.register("depot-v1", bytes.buffer);
  expect(() => library.register("depot-v2", bytes)).toThrow("budget");
  expect(library.byteLength).toBe(bytes.byteLength);
  const placement = { id: "depot-a", assetId, label: "Depot", position: [103.85, 1.3] as const, lengthMetres: 10 };
  expect(() => library.place({ ...placement, assetId: "other:missing" })).toThrow("Register");
  expect(() => library.place({ ...placement, lengthMetres: 0 })).toThrow();
  expect(store.size).toBe(0); expect(store.canUndo).toBe(false);
  await expect(library.resolveAsset("other:missing")).rejects.toThrow("Register");
});
