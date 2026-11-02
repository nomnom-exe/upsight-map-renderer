/**
 * @file tests/MapLibreConnection.test.ts
 * @brief Test how the Babylon renderer connects to MapLibre.
 * @author Norman
 * @description Covers startup, recovery after the graphics context is lost, cancellation and the first-person camera target.
 */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  CustomLayerInterface,
  LngLat,
  Map as LibreMap,
} from "maplibre-gl";
import { SceneStore } from "@upsight/map-renderer/geo/SceneStore";
import { distance } from "@upsight/map-renderer/geo/math";

const mocks = vi.hoisted(() => {
  const events = new Map<string, Set<() => void>>();
  const layers = new Map<string, CustomLayerInterface>();
  const map = {
    on: vi.fn((name: string, fn: () => void) => {
      if (!events.has(name)) events.set(name, new Set());
      events.get(name)!.add(fn);
    }),
    off: vi.fn((name: string, fn: () => void) => events.get(name)?.delete(fn)),
    getCanvas: () => ({ setAttribute: vi.fn() }),
    getContainer: () => ({}),
    // MapLibre can return the style's layers while its tiles are still loading.
    isStyleLoaded: () => false,
    getStyle: () => ({
      layers: [
        { id: "road-arrows", type: "symbol" },
        { id: "bridge-casing", type: "line" },
        {
          id: "native-buildings",
          type: "fill-extrusion",
          "source-layer": "building",
        },
        { id: "labels", type: "symbol" },
      ],
    }),
    getLayer: (id: string) => layers.get(id) ?? (id === "native-buildings" ? { id, type: "fill-extrusion" } : undefined),
    addLayer: vi.fn(),
    removeLayer: vi.fn(),
    setLayoutProperty: vi.fn(),
    setStyle: vi.fn(),
    remove: vi.fn(),
    triggerRepaint: vi.fn(),
    setCenterClampedToGround: vi.fn(),
    calculateCameraOptionsFromTo: vi.fn(() => ({ elevation: 0, pitch: 84.8 })),
    jumpTo: vi.fn(),
  };
  const instances: {
    select: ReturnType<typeof vi.fn>;
    setVehicle: ReturnType<typeof vi.fn>;
    setLayerVisible: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    subscribeFrame: ReturnType<typeof vi.fn>;
    render: ReturnType<typeof vi.fn>;
    pick: ReturnType<typeof vi.fn>;
  }[] = [];
  return { events, layers, map, instances };
});
vi.mock("maplibre-gl", () => ({
  Map: class {
    constructor() {
      return mocks.map;
    }
  },
  LngLat: class {
    constructor(
      public lng: number,
      public lat: number,
    ) {}
    toArray() {
      return [this.lng, this.lat];
    }
  },
  setWorkerUrl: vi.fn(),
}));
vi.mock("@upsight/map-renderer/rendering/quality", () => ({
  deviceQuality: () => ({ pixelRatio: 1 }),
}));
vi.mock("@upsight/map-renderer/rendering/BabylonRenderer", () => ({
  BabylonRenderer: class {
    select = vi.fn();
    setVehicle = vi.fn();
    setLayerVisible = vi.fn();
    dispose = vi.fn();
    subscribeFrame = vi.fn();
    render = vi.fn();
    pick = vi.fn(() => "city:building-1");
    constructor() {
      mocks.instances.push(this);
    }
  },
}));
import { MapLibreConnection } from "@upsight/map-renderer/engine/MapLibreConnection";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.events.clear();
  mocks.layers.clear();
  mocks.instances.length = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  mocks.map.addLayer.mockImplementation((layer: CustomLayerInterface) => {
    mocks.layers.set(layer.id, layer);
    layer.onAdd?.(
      mocks.map as unknown as LibreMap,
      {} as WebGL2RenderingContext,
    );
  });
  mocks.map.removeLayer.mockImplementation((id: string) => {
    mocks.layers
      .get(id)
      ?.onRemove?.(
        mocks.map as unknown as LibreMap,
        {} as WebGL2RenderingContext,
      );
    mocks.layers.delete(id);
  });
  // Simulate a style replacement that clears custom layers without calling onRemove.
  mocks.map.setStyle.mockImplementation(() => mocks.layers.clear());
});
afterEach(() => vi.unstubAllGlobals());
const emit = (name: string) => {
  for (const fn of mocks.events.get(name) ?? []) fn();
};
async function connect() {
  const pending = MapLibreConnection.create(
    {} as HTMLElement,
    [103.85, 1.29],
    new AbortController().signal,
    { style: "https://example.test/style.json" },
  );
  emit("style.load");
  return pending;
}

it("mounts Babylon above interleaved road layers, below labels, and disables native buildings", async () => {
  const connection = await connect();
  const handle = connection.attach(new SceneStore(), {});
  expect(mocks.instances).toHaveLength(1);
  expect(mocks.map.setLayoutProperty).toHaveBeenCalledWith(
    "native-buildings",
    "visibility",
    "none",
  );
  expect(mocks.map.addLayer.mock.calls[0][1]).toBe("labels");
  expect(mocks.instances[0].setLayerVisible).toHaveBeenCalledWith(
    "landscape",
    false,
  );
  emit("style.load");
  expect(mocks.instances).toHaveLength(1);
  handle.dispose();
  handle.dispose();
  connection.dispose();
  expect(mocks.map.setLayoutProperty).toHaveBeenLastCalledWith(
    "native-buildings", "visibility", "visible",
  );
  expect(mocks.instances[0].dispose).toHaveBeenCalledTimes(1);
  expect(
    [...mocks.events.values()].every((listeners) => listeners.size === 0),
  ).toBe(true);
});

it("rebuilds after context recovery and preserves selection, visibility and frame subscriptions", async () => {
  const connection = await connect(),
    onError = vi.fn();
  const handle = connection.attach(new SceneStore(), { onError });
  const listener = vi.fn(),
    off = handle.subscribeFrame(listener);
  handle.select("city:building-1");
  handle.setLayerVisible("buildings", false);
  emit("webglcontextlost");
  emit("webglcontextrestored");
  expect(mocks.instances[0].dispose).toHaveBeenCalledTimes(1);
  expect(mocks.instances).toHaveLength(2);
  expect(mocks.instances[1].select).toHaveBeenCalledWith("city:building-1");
  expect(mocks.instances[1].setLayerVisible).toHaveBeenCalledWith(
    "buildings",
    false,
  );
  const frame = mocks.instances[1].subscribeFrame.mock.calls[0][0];
  frame();
  expect(listener).toHaveBeenCalledTimes(1);
  off();
  frame();
  expect(listener).toHaveBeenCalledTimes(1);
  expect(onError).toHaveBeenLastCalledWith("");
  handle.dispose();
  connection.dispose();
});

it("cancels startup without retaining a map or its listeners", async () => {
  const abort = new AbortController();
  const pending = MapLibreConnection.create(
    {} as HTMLElement,
    [103.85, 1.29],
    abort.signal,
    { style: "https://example.test/style.json" },
  );
  abort.abort();
  await expect(pending).rejects.toThrow("cancelled");
  expect(mocks.map.remove).toHaveBeenCalledTimes(1);
  expect(mocks.events.get("style.load")?.size).toBe(0);
});

it("keeps the first-person target near the vehicle rather than moving city loading to the horizon", async () => {
  const connection = await connect();
  const position: [number, number] = [103.85, 1.43];
  try {
    connection.camera.firstPerson(position, 90);
    const [from, altitude, to, ground] = mocks.map.calculateCameraOptionsFromTo
      .mock.calls[0] as unknown as [LngLat, number, LngLat, number];
    expect(from.toArray()).toEqual(position);
    expect(altitude).toBe(1.8);
    expect(ground).toBe(0);
    expect(distance(position, to.toArray())).toBeCloseTo(20, 0);
    expect(to.lng).toBeGreaterThan(position[0]);
    expect(to.lat).toBeCloseTo(position[1], 6);
    expect(mocks.map.jumpTo).toHaveBeenCalledWith({
      elevation: 0,
      pitch: 84.8,
    });
  } finally {
    connection.dispose();
  }
});


it("keeps first-person eye height above the matched bridge surface", async () => {
  const connection = await connect();
  try {
    connection.camera.firstPerson([103.85, 1.43], 90, 7.4);
    const [, altitude, , surface] = mocks.map.calculateCameraOptionsFromTo.mock.calls[0] as unknown as [LngLat, number, LngLat, number];
    expect(altitude).toBeCloseTo(9.2);
    expect(surface).toBe(7.4);
  } finally { connection.dispose(); }
});

it("leaves an external map alive and restores native layers and input listeners on disposal", () => {
  const connection = MapLibreConnection.fromMap(mocks.map as unknown as LibreMap);
  const handle = connection.attach(new SceneStore(), {});
  connection.bindInput(vi.fn(), vi.fn());
  expect(() => connection.attach(new SceneStore(), {})).toThrow("one active");
  connection.dispose();
  expect(mocks.map.remove).not.toHaveBeenCalled();
  expect(mocks.map.setLayoutProperty).toHaveBeenLastCalledWith("native-buildings", "visibility", "visible");
  expect(mocks.events.get("click")?.size).toBe(0);
  expect(mocks.events.get("movestart")?.size).toBe(0);
  expect(mocks.instances[0].dispose).toHaveBeenCalledOnce();
  handle.dispose();
  expect(mocks.instances[0].dispose).toHaveBeenCalledOnce();
});

it("stops custom drawing and picking without disposing geometry, including after a style reload", async () => {
  const connection = await connect();
  const handle = connection.attach(new SceneStore(), {});
  const storeFrame = vi.fn();
  handle.subscribeFrame(storeFrame);
  vi.spyOn(connection.camera as typeof connection.camera & { update: () => void }, "update").mockImplementation(() => {});
  const draw = () => mocks.layers.get("upsightduck-models")!.render(
    {} as WebGL2RenderingContext,
    { defaultProjectionData: { mainMatrix: [] } } as unknown as Parameters<CustomLayerInterface["render"]>[1],
  );
  draw();
  expect(mocks.instances[0].render).toHaveBeenCalledOnce();
  expect(handle.pick(10, 10)).toBe("city:building-1");
  connection.setRendererVisible(false);
  draw();
  expect(mocks.instances[0].render).toHaveBeenCalledOnce();
  expect(mocks.instances[0].dispose).not.toHaveBeenCalled();
  expect(handle.pick(10, 10)).toBeNull();
  expect(storeFrame).toHaveBeenCalledOnce();
  mocks.map.setStyle("https://example.test/replacement-style.json");
  emit("style.load");
  draw();
  expect(mocks.instances[0].dispose).toHaveBeenCalledOnce();
  expect(mocks.instances[1].render).not.toHaveBeenCalled();
  connection.setRendererVisible(true);
  draw();
  expect(mocks.instances[1].render).toHaveBeenCalledOnce();
  expect(handle.pick(10, 10)).toBe("city:building-1");
  connection.dispose();
});

it("removes basemap sources and restores the original style without replacing the camera or edits", async () => {
  const connection = await connect();
  const camera = connection.camera;
  const store = new SceneStore();
  connection.attach(store, {});
  const revision = store.revision;
  connection.setBasemapEnabled(false);
  expect(mocks.instances[0].dispose).toHaveBeenCalledOnce();
  expect(mocks.map.removeLayer).toHaveBeenCalledWith("upsightduck-models");
  expect(mocks.map.setStyle).toHaveBeenLastCalledWith({
    version: 8, sources: {},
    layers: [{ id: "demo-background", type: "background", paint: { "background-color": "#edf1f3" } }],
  }, { diff: false });
  connection.setBasemapEnabled(false);
  expect(mocks.map.setStyle).toHaveBeenCalledOnce();
  emit("style.load");
  expect(mocks.instances).toHaveLength(2);
  connection.setBasemapEnabled(true);
  expect(mocks.instances[1].dispose).toHaveBeenCalledOnce();
  expect(mocks.map.setStyle).toHaveBeenLastCalledWith("https://example.test/style.json", { diff: false });
  emit("style.load");
  expect(mocks.instances).toHaveLength(3);
  expect(connection.camera).toBe(camera);
  expect(store.revision).toBe(revision);
  expect(mocks.map.remove).not.toHaveBeenCalled();
  connection.dispose();
  expect(mocks.instances[2].dispose).toHaveBeenCalledOnce();
});

it("releases a renderer if an external host discards its layer and unmounts before the new style loads", () => {
  const connection = MapLibreConnection.fromMap(mocks.map as unknown as LibreMap);
  connection.attach(new SceneStore(), {});
  mocks.map.setStyle("https://example.test/replacement-style.json");
  expect(mocks.instances[0].dispose).not.toHaveBeenCalled();
  connection.dispose();
  expect(mocks.instances[0].dispose).toHaveBeenCalledOnce();
  expect(mocks.map.remove).not.toHaveBeenCalled();
  emit("style.load");
  expect(mocks.instances).toHaveLength(1);
});

it("leaves external host styles under host control", () => {
  const connection = MapLibreConnection.fromMap(mocks.map as unknown as LibreMap);
  expect(() => connection.setBasemapEnabled(false)).toThrow("host application");
  expect(mocks.map.setStyle).not.toHaveBeenCalled();
  connection.dispose();
});
