/**
 * @file tests/BabylonRenderer.test.ts
 * @brief Test Babylon rendering and resource updates.
 * @author Norman
 * @description Checks which meshes are drawn, where they appear, which one a click selects and how the renderer handles edits and resizes.
 */

import { afterEach, expect, it, vi } from "vitest";
import { MapCamera } from "@upsight/map-renderer/engine/MapCamera";
import { SceneStore } from "@upsight/map-renderer/geo/SceneStore";
import { DEFAULT_STYLE, type GeoFeature, type SourceInfo } from "@upsight/map-renderer/geo/types";
import { localFrame } from "@upsight/map-renderer/geo/math";
import { qualityForDevice } from "@upsight/map-renderer/rendering/quality";
import { buildGeometry } from "@upsight/map-renderer/rendering/geometry";
import type { BuildRequest, BuildResponse, GeometryWorker } from "@upsight/map-renderer/rendering/GeometryBuilder";

const qualityHints = vi.hoisted(() => ({ width: 1440 }));
vi.mock("@upsight/map-renderer/rendering/quality", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@upsight/map-renderer/rendering/quality")>();
  return {
    ...actual,
    deviceQuality: () => actual.qualityForDevice({
      width: qualityHints.width, dpr: 3, coarse: false, cores: 8,
    }),
  };
});

// Babylon's NullEngine runs scene, buffer, mesh and ray-picking tests on the CPU.
vi.mock("@babylonjs/core/Engines/engine", async () => {
  const { NullEngine } = await import("@babylonjs/core/Engines/nullEngine");
  return {
    Engine: class extends NullEngine {
      constructor() {
        super({
          useHighPrecisionMatrix: true,
          renderWidth: 800,
          renderHeight: 600,
          textureSize: 512,
          deterministicLockstep: false,
          lockstepMaxSteps: 4,
        });
      }
    },
  };
});
import { BabylonRenderer } from "@upsight/map-renderer/rendering/BabylonRenderer";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { glb } from "./fixtures/glb";

afterEach(() => {
  qualityHints.width = 1440;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("picks an edited GLB after a host has initialised Babylon at default matrix precision", async () => {
  const host = new NullEngine(); // Start the host engine before creating the camera or renderer.
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const canvas = { clientWidth: 800, clientHeight: 600, width: 800, height: 600 } as HTMLCanvasElement;
  const center = [103.85, 1.3] as const, camera = new MapCamera(center), store = new SceneStore();
  camera.resize(800, 600); camera.setView({ zoom: 20, pitch: 0, bearing: 0 });
  const asset: GeoFeature = { id: "host:model", source: "host", layer: "imported", label: "Model",
    geometry: { type: "Point", coordinates: center }, style: { ...DEFAULT_STYLE, elevation: 0 },
    model: { kind: "asset", assetId: "host:glb", length: 10 }, properties: {} };
  store.execute({ type: "upsert", features: [asset] });
  const renderer = new BabylonRenderer(canvas, camera, store, {
    quality: qualityForDevice({ width: 1000, dpr: 1, coarse: false }), resolveAsset: async () => glb(),
  }, { context: {} as WebGL2RenderingContext, requestFrame: vi.fn() });
  try {
    await vi.waitFor(() => { renderer.render(); expect(renderer.pick(400, 300)).toBe(asset.id); }, { timeout: 10000 });
    const coordinates = localFrame(center).unproject(15, 0);
    store.execute({ type: "upsert", features: [{ ...asset, geometry: { type: "Point", coordinates } }] });
    renderer.render();
    expect(renderer.pick(400, 300)).toBeNull();
    const pixel = renderer.project(coordinates)!;
    expect(renderer.pick(pixel.x, pixel.y)).toBe(asset.id);
  } finally { renderer.dispose(); host.dispose(); }
}, 15_000);

it("updates shared-surface rendering budgets when the host resizes to a phone viewport", () => {
  vi.useFakeTimers();
  const clock = vi.spyOn(performance, "now").mockReturnValue(1000);
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const canvas = { clientWidth: 800, clientHeight: 600, width: 800, height: 600 } as HTMLCanvasElement;
  const camera = new MapCamera([103.852, 1.287]);
  camera.resize(800, 600);
  const report = vi.fn();
  const renderer = new BabylonRenderer(canvas, camera, new SceneStore(),
    { onStats: report },
    { context: {} as WebGL2RenderingContext, requestFrame: vi.fn() },
  );
  try {
    vi.advanceTimersByTime(300);
    renderer.render();
    expect(report.mock.lastCall?.[0].profile).toBe("standard");
    qualityHints.width = 390;
    camera.resize(390, 844);
    clock.mockReturnValue(2000);
    vi.advanceTimersByTime(300);
    renderer.render();
    expect(report.mock.lastCall?.[0].profile).toBe("mobile");
  } finally {
    renderer.dispose();
  }
});
it("renders, projects and picks the same real mesh, idles, then rebuilds only changed geometry", async () => {
  vi.useFakeTimers();
  const frames = new Map<number, FrameRequestCallback>();
  let serial = 0;
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
    frames.set(++serial, fn);
    return serial;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const canvas = {
    clientWidth: 800,
    clientHeight: 600,
    width: 800,
    height: 600,
  } as HTMLCanvasElement;
  const camera = new MapCamera([103.852, 1.287]);
  camera.setView({ zoom: 18, pitch: 0, bearing: 0 });
  const store = new SceneStore(),
    f = localFrame(camera.state.center);
  const feature = {
    id: "test:building",
    source: "test",
    layer: "buildings" as const,
    label: "Building",
    properties: {},
    geometry: {
      type: "Polygon" as const,
      coordinates: [
        [
          f.unproject(-10, -10),
          f.unproject(10, -10),
          f.unproject(10, 10),
          f.unproject(-10, 10),
          f.unproject(-10, -10),
        ],
      ],
    },
    style: { ...DEFAULT_STYLE, height: 20 },
    model: { kind: "building" as const },
  };
  store.execute({ type: "upsert", features: [feature] });
  const report = vi.fn(),
    errors = vi.fn();
  const renderer = new BabylonRenderer(canvas, camera, store, {
    quality: qualityForDevice({ width: 1000, dpr: 1, coarse: false }),
    onStats: report,
    onError: errors,
  });
  const flush = async () => {
    for (let n = 0; n < 150 && frames.size; n++) {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((fn) => fn(n * 16));
      await vi.runOnlyPendingTimersAsync();
    }
  };
  try {
    await flush();
    expect(errors).not.toHaveBeenCalled();
    expect(report.mock.lastCall?.[0].triangles).toBeGreaterThan(0);
    const projected = renderer.project(camera.state.center, 20)!;
    expect(projected.x).toBeCloseTo(400, 2);
    expect(projected.y).toBeCloseTo(300, 2);
    expect(renderer.pick(projected.x, projected.y)).toBe(feature.id);
    expect(frames.size).toBe(0);
    const builds = report.mock.lastCall?.[0].geometryBuilds;
    camera.setView({ bearing: 30 });
    await flush();
    expect(report.mock.lastCall?.[0].geometryBuilds).toBe(builds);
    store.execute({ type: "remove", ids: [feature.id] });
    await flush();
    expect(renderer.pick(400, 300)).toBeNull();
  } finally {
    renderer.dispose();
  }
  expect(frames.size).toBe(0);
  expect(renderer.project(camera.state.center)).toBeNull();
});

class DeferredWorker implements GeometryWorker {
  messages: BuildRequest[] = [];
  onmessage: GeometryWorker["onmessage"] = null;
  onerror: GeometryWorker["onerror"] = null;
  terminate = vi.fn();
  postMessage(request: BuildRequest) { this.messages.push(request); }
  finish(index = this.messages.length - 1) {
    const request = this.messages[index], keys = new Map(request.keys);
    const data = buildGeometry(request.features, request.origin, (id) => keys.get(id)!, request.detail);
    this.onmessage?.({ data: { id: request.id, data, buildMs: 1 } } as MessageEvent<BuildResponse>);
  }
}
function providerFixture(cacheBytes?: number) {
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const canvas = { clientWidth: 800, clientHeight: 600, width: 800, height: 600 } as HTMLCanvasElement;
  const camera = new MapCamera([103.852, 1.287]);
  camera.resize(800, 600);
  camera.setView({ zoom: 18, pitch: 0, bearing: 0 });
  const frame = localFrame(camera.state.center);
  const feature: GeoFeature = {
    id: "test:building", source: "test", layer: "buildings", label: "Building",
    geometry: { type: "Polygon", coordinates: [[frame.unproject(-10, -10), frame.unproject(10, -10),
      frame.unproject(10, 10), frame.unproject(-10, 10), frame.unproject(-10, -10)]] },
    style: { ...DEFAULT_STYLE, height: 20 }, model: { kind: "building" }, properties: { datasetRevision: "one" },
  };
  const source: SourceInfo = { id: "test", label: "Test", status: "snapshot", attribution: "Test" };
  const store = new SceneStore(), worker = new DeferredWorker(), errors = vi.fn();
  store.replaceSource(source, [feature]);
  const renderer = new BabylonRenderer(canvas, camera, store,
    { createGeometryWorker: () => worker as unknown as Worker, onError: errors,
      quality: { ...qualityForDevice({ width: 1000, dpr: 1, coarse: false }),
        ...(cacheBytes === undefined ? {} : { cacheBytes }) } },
    { context: {} as WebGL2RenderingContext, requestFrame: vi.fn() });
  const settle = async () => {
    await Promise.resolve();
    renderer.render();
    await Promise.resolve();
    renderer.render();
  };
  return { camera, feature, source, store, worker, renderer, errors, settle };
}

it("retries an individually oversized near mesh at far detail and keeps the result pickable", async () => {
  const { camera, feature, source, store, worker, renderer, errors, settle } = providerFixture(8000);
  const tree: GeoFeature = { ...feature, id: "test:tree", layer: "landscape", model: { kind: "tree" },
    geometry: { type: "Point", coordinates: camera.state.center }, style: { ...DEFAULT_STYLE, height: 10 } };
  try {
    store.replaceSource(source, [tree]);
    renderer.render();
    expect(worker.messages.map(request => request.detail)).toEqual([1]);
    worker.finish();
    await settle();
    expect(worker.messages.map(request => request.detail)).toEqual([1, 0]);
    worker.finish();
    await settle();
    expect(renderer.pick(400, 300)).toBe(tree.id);
    renderer.invalidate();
    await settle();
    expect(worker.messages).toHaveLength(2);
    expect(errors).not.toHaveBeenCalled();
  } finally { renderer.dispose(); }
});
it("reuses CPU geometry on a provider-cell revisit while refreshed or edited geometry rebuilds", async () => {
  const { feature, source, store, worker, renderer, errors, settle } = providerFixture();
  try {
    renderer.render();
    worker.finish();
    await settle();
    expect(renderer.pick(400, 300)).toBe(feature.id);
    store.replaceSource(source, []);
    await settle();
    expect(renderer.pick(400, 300)).toBeNull();
    store.replaceSource(source, [structuredClone(feature)]);
    await settle();
    expect(worker.messages).toHaveLength(1);
    expect(renderer.pick(400, 300)).toBe(feature.id);

    // Reload between frames so the new batch also starts at version 1.
    // The renderer still needs a new mesh for the changed building.
    store.replaceSource(source, []);
    store.replaceSource(source, [{ ...feature, style: { ...feature.style, height: 35 },
      properties: { datasetRevision: "two" } }]);
    renderer.render();
    expect(worker.messages).toHaveLength(2);
    expect(renderer.pick(400, 300)).toBeNull();
    expect(worker.messages[1].features[0].style.height).toBe(35);
    worker.finish();
    await settle();
    expect(renderer.pick(400, 300)).toBe(feature.id);
    expect(errors).not.toHaveBeenCalled();
  } finally { renderer.dispose(); }
  expect(worker.terminate).toHaveBeenCalledTimes(1);
});

it("reconsiders an over-budget city batch when its feature is selected", async () => {
  const { feature, camera, worker, renderer, settle } = providerFixture(16);
  try {
    camera.setView({ zoom: 15 });
    renderer.render(); worker.finish(); await settle();
    expect(renderer.pick(400, 300)).toBeNull();
    renderer.select(feature.id); renderer.render();
    expect(worker.messages).toHaveLength(2);
    worker.finish(); await settle();
    expect(renderer.pick(400, 300)).toBe(feature.id);
  } finally { renderer.dispose(); }
});

it("discards obsolete results and sends the current view after only the already-running build", async () => {
  const { camera, feature, source, store, worker, renderer, errors, settle } = providerFixture();
  try {
    const other = { ...feature, id: "test:road", layer: "roads" as const, model: undefined };
    store.replaceSource(source, [feature, other]);
    renderer.render(); // The worker builds the building first. The road batch is still queued.
    expect(worker.messages).toHaveLength(1);
    camera.setView({ center: [103.9, 1.3] });
    store.replaceSource(source, []);
    renderer.render();
    await Promise.resolve();
    camera.setView({ center: [103.852, 1.287] });
    store.replaceSource(source, [{ ...feature, properties: { datasetRevision: "two" } }]);
    renderer.render();
    expect(worker.messages).toHaveLength(1);
    worker.finish(0);
    expect(worker.messages).toHaveLength(2);
    expect(worker.messages[1].features).toHaveLength(1);
    expect(worker.messages[1].features[0].properties.datasetRevision).toBe("two");
    await settle();
    expect(renderer.pick(400, 300)).toBeNull();
    worker.finish(1);
    await settle();
    expect(renderer.pick(400, 300)).toBe(feature.id);
    expect(errors).not.toHaveBeenCalled();
  } finally { renderer.dispose(); }
});
