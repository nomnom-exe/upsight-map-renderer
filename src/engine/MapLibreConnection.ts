/**
 * @file src/engine/MapLibreConnection.ts
 * @brief Draw a Babylon scene on a MapLibre map.
 * @author Norman
 * @description Share the map's camera and WebGL context so Babylon objects line up with the basemap.
 */

import {
  Map as LibreMap,
  LngLat,
  setWorkerUrl,
  type MapMouseEvent,
  type VisibilitySpecification,
} from "maplibre-gl";
import { Matrix } from "@babylonjs/core/Maths/math.vector.js";
import { PerformanceConfigurator } from "@babylonjs/core/Engines/performanceConfigurator.js";
import type { CameraView, MapView } from "./CameraView.js";
import type { Extent, LayerName, Position } from "../geo/types.js";
import { localFrame, RAD } from "../geo/math.js";
import type { SceneStore } from "../geo/SceneStore.js";
import type {
  RendererHandle,
  RendererOptions,
  VehiclePose,
} from "../rendering/types.js";
import { BabylonRenderer } from "../rendering/BabylonRenderer.js";
import { CameraFrame } from "../rendering/CameraFrame.js";
import { deviceQuality } from "../rendering/quality.js";

/** Read the MapLibre camera so Babylon objects stay aligned with the map. */
class HostCamera implements CameraView {
  readonly transform: Matrix;
  private frame = new CameraFrame();
  constructor(private map: LibreMap) {
    PerformanceConfigurator.SetMatrixPrecision(true);
    this.transform = Matrix.Identity();
  }
  get state(): MapView {
    const p = this.map.getCenter();
    return {
      center: [p.lng, p.lat],
      zoom: this.map.getZoom(),
      pitch: this.map.getPitch(),
      bearing: this.map.getBearing(),
    };
  }
  update(matrix: ArrayLike<number>) {
    Matrix.FromArrayToRef(matrix, 0, this.transform);
    const c = this.map.getCanvas();
    this.frame.update(matrix, c.clientWidth, c.clientHeight);
  }
  subscribe(listener: () => void) {
    this.map.on("move", listener);
    this.map.on("resize", listener);
    return () => {
      this.map.off("move", listener);
      this.map.off("resize", listener);
    };
  }
  resize() {
    this.map.resize();
  }
  project = (p: Position, elevation = 0) => this.frame.project(p, elevation);
  screenToGround = (x: number, y: number) => this.frame.screenToGround(x, y);
  snapshot() {
    const c = this.map.getCanvas(),
      b = this.map.getBounds(),
      width = c.clientWidth,
      height = c.clientHeight;
    return {
      ...this.state,
      width,
      height,
      pixelRatio: c.width / Math.max(1, width),
      bounds: {
        west: b.getWest(),
        east: b.getEast(),
        south: b.getSouth(),
        north: b.getNorth(),
      },
      groundCorners: [
        [0, 0],
        [width, 0],
        [width, height],
        [0, height],
      ].map(([x, y]) => this.screenToGround(x, y)),
    };
  }
  setView(view: Partial<MapView>) {
    this.map.setCenterClampedToGround(true);
    this.map.jumpTo({
      ...view,
      center: view.center ? [...view.center] : undefined,
      elevation: 0,
    });
  }
  firstPerson(center: Position, bearing: number, surfaceElevation = 0) {
    if (!Number.isFinite(surfaceElevation)) return;
    const elevation = Math.max(-1000, Math.min(1000, surfaceElevation));
    // Look at the ground 20 m ahead from 1.8 m above the road. A target near the horizon
    // makes MapLibre load less detailed tiles far from the vehicle.
    const target = localFrame(center).unproject(
      Math.sin(bearing * RAD) * 20,
      Math.cos(bearing * RAD) * 20,
    );
    this.map.setCenterClampedToGround(false);
    this.map.jumpTo(
      this.map.calculateCameraOptionsFromTo(
        new LngLat(...center),
        elevation + 1.8,
        new LngLat(...target),
        elevation,
      ),
    );
  }
  pan(fromX: number, fromY: number, toX: number, toY: number) {
    this.map.panBy([fromX - toX, fromY - toY], { duration: 0 });
  }
  zoomAt(delta: number, x?: number, y?: number) {
    const c = this.map.getCanvas();
    this.map.zoomTo(this.map.getZoom() + delta, {
      around: this.map.unproject([
        x ?? c.clientWidth / 2,
        y ?? c.clientHeight / 2,
      ]),
      duration: 0,
    });
  }
  fitBounds(b: Extent) {
    this.map.fitBounds(
      [
        [b.west, b.south],
        [b.east, b.north],
      ],
      { padding: 70, duration: 0, pitch: 0, bearing: 0 },
    );
  }
}

export class MapLibreConnection {
  readonly camera: CameraView;
  readonly canvas: HTMLCanvasElement;
  private observer: ResizeObserver;
  private disposed = false;
  private rendererVisible = true;
  private basemapEnabled = true;
  private handles = new Set<() => void>();
  private inputCleanups = new Set<() => void>();
  private constructor(private map: LibreMap, private ownsMap = true, private basemapStyle?: string) {
    this.camera = new HostCamera(map);
    this.canvas = map.getCanvas();
    if (ownsMap) this.canvas.setAttribute(
      "aria-label",
      "Interactive city map. Drag to pan, scroll or pinch to zoom. Right drag to orbit.",
    );
    this.observer = new ResizeObserver(() => {
      if (!this.disposed) {
        if (ownsMap) map.setPixelRatio(deviceQuality().pixelRatio);
        map.resize();
      }
    });
    this.observer.observe(map.getContainer());
  }
  /** Reuse the application's map. It stays open when the renderer is disposed. */
  static fromMap(map: LibreMap) { return new MapLibreConnection(map, false); }
  static async create(
    container: HTMLElement,
    center: Position,
    signal: AbortSignal,
    options: { style: string; workerUrl?: string },
  ) {
    if (options.workerUrl) setWorkerUrl(options.workerUrl);
    const map = new LibreMap({
      container,
      style: options.style,
      center: new LngLat(...center),
      zoom: 15.8,
      pitch: 40,
      bearing: -17,
      maxPitch: 85,
      maxZoom: 24,
      renderWorldCopies: false,
      pixelRatio: deviceQuality().pixelRatio,
      attributionControl: false,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer);
          map.off("style.load", loaded);
          signal.removeEventListener("abort", abort);
          if (error) reject(error);
          else resolve();
        };
        const loaded = () => finish(),
          abort = () => finish(new Error("Map startup cancelled."));
        const timer = setTimeout(
          () =>
            finish(
              new Error(
                "Map style could not load. Check your connection and reload.",
              ),
            ),
          25000,
        );
        map.on("style.load", loaded);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
      return new MapLibreConnection(map, true, options.style);
    } catch (e) {
      map.remove();
      throw e;
    }
  }
  /** Hiding the renderer disables drawing and picking. Its geometry stays in memory. */
  setRendererVisible(visible: boolean) {
    if (this.disposed || this.rendererVisible === visible) return;
    this.rendererVisible = visible;
    this.map.triggerRepaint();
  }
  /** Turning off the basemap removes its sources. Only maps created by this connection support this. */
  setBasemapEnabled(enabled: boolean) {
    if (this.disposed || this.basemapEnabled === enabled) return;
    if (!this.ownsMap || !this.basemapStyle)
      throw new Error("The host application controls the style of an external map.");
    // Remove our layer first so its resources are freed even if the style change skips onRemove.
    if (this.handles.size && this.map.getLayer("upsightduck-models"))
      this.map.removeLayer("upsightduck-models");
    this.map.setStyle(enabled ? this.basemapStyle : {
      version: 8,
      sources: {},
      layers: [{ id: "demo-background", type: "background", paint: { "background-color": "#edf1f3" } }],
    }, { diff: false });
    this.basemapEnabled = enabled;
  }
  bindInput(pick: (x: number, y: number) => void, interact: () => void) {
    const click = (e: MapMouseEvent) => pick(e.point.x, e.point.y);
    const move = (e: { originalEvent?: unknown }) => {
      if (e.originalEvent) interact();
    };
    this.map.on("click", click);
    this.map.on("movestart", move);
    const dispose = () => {
      this.map.off("click", click);
      this.map.off("movestart", move);
      this.inputCleanups.delete(dispose);
    };
    this.inputCleanups.add(dispose);
    return {
      gestures: [
        this.map.dragPan,
        this.map.dragRotate,
        this.map.scrollZoom,
        this.map.boxZoom,
        this.map.doubleClickZoom,
        this.map.touchZoomRotate,
        this.map.touchPitch,
        this.map.keyboard,
      ],
      dispose,
    };
  }
  attach(store: SceneStore, options: RendererOptions): RendererHandle {
    if (this.disposed || this.handles.size) throw new Error("A connection supports one active renderer.");
    const map = this.map,
      id = "upsightduck-models";
    if (map.getLayer(id)) throw new Error("This map already has an Upsight renderer.");
    const originalVisibility = new Map<string, VisibilitySpecification | undefined>();
    let renderer: BabylonRenderer | undefined,
      disposed = false,
      selected: string | null = null,
      vehicle: VehiclePose | null = null;
    const hidden = new Set<LayerName>(["landscape"]),
      listeners = new Set<() => void>();
    const attach = () => {
      // The layer can be added at style.load. Waiting for isStyleLoaded() would also wait for tiles.
      if (disposed || map.getLayer(id) || !map.getStyle()?.layers) return;
      // Hide matching MapLibre 3D building layers across the map so buildings aren't drawn twice.
      for (const layer of map.getStyle().layers)
        if (
          layer.type === "fill-extrusion" &&
          layer["source-layer"] === "building"
        )
          {
          if (!originalVisibility.has(layer.id)) originalVisibility.set(layer.id, layer.layout?.visibility);
          map.setLayoutProperty(layer.id, "visibility", "none");
        }
      // Some styles draw road arrows before bridges. Place Babylon above the last map shape
      // so it stays above roads and below the labels drawn last.
      const layers = map.getStyle().layers;
      const lastGeometry = layers.reduce(
        (last, layer, index) => (layer.type === "symbol" ? last : index),
        -1,
      );
      map.addLayer(
        {
          id,
          type: "custom",
          renderingMode: "3d",
          onAdd: (_map, gl) => {
            // A style change can leave the old renderer alive. Release its workers, buffers, and listeners.
            const previous = renderer;
            renderer = undefined;
            previous?.dispose();
            renderer = new BabylonRenderer(
              this.canvas,
              this.camera,
              store,
              options,
              { context: gl, requestFrame: () => map.triggerRepaint() },
            );
            for (const layer of hidden) renderer.setLayerVisible(layer, false);
            renderer.select(selected);
            renderer.setVehicle(vehicle);
            renderer.subscribeFrame(() => {
              for (const listener of listeners) listener();
            });
          },
          render: (_gl, args) => {
            (this.camera as HostCamera).update(
              args.defaultProjectionData.mainMatrix,
            );
            if (this.rendererVisible) renderer?.render();
            else for (const listener of listeners) listener();
          },
          onRemove: () => {
            renderer?.dispose();
            renderer = undefined;
          },
        },
        layers[lastGeometry + 1]?.id,
      );
    };
    const styleLoaded = () => {
      // If our layer survived the reload, keep the saved building visibility so dispose() can restore it.
      if (map.getLayer(id)) return;
      originalVisibility.clear();
      attach();
    };
    const lost = () =>
      options.onError?.("Graphics context lost; waiting for recovery.");
    const restore = () => {
      if (disposed) return;
      if (map.getLayer(id)) map.removeLayer(id);
      attach();
      options.onError?.("");
    };
    map.on("style.load", styleLoaded);
    map.on("webglcontextlost", lost);
    map.on("webglcontextrestored", restore);
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      map.off("style.load", styleLoaded);
      map.off("webglcontextlost", lost);
      map.off("webglcontextrestored", restore);
      if (map.getLayer(id)) map.removeLayer(id);
      // A style reload may already have removed some building layers.
      renderer?.dispose();
      renderer = undefined;
      for (const [layerId, visibility] of originalVisibility) {
        if (map.getLayer(layerId)) map.setLayoutProperty(layerId, "visibility", visibility ?? "visible");
      }
      listeners.clear();
      this.handles.delete(dispose);
    };
    this.handles.add(dispose);
    try { attach(); } catch (error) { dispose(); throw error; }
    return {
      select: (value) => {
        selected = value;
        renderer?.select(value);
      },
      pick: (x, y) => this.rendererVisible ? renderer?.pick(x, y) ?? null : null,
      project: (p, e) => this.camera.project(p, e),
      screenToGround: (x, y) => this.camera.screenToGround(x, y),
      getViewport: () => this.camera.snapshot(),
      subscribeFrame: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      setLayerVisible: (layer, visible) => {
        if (layer === "landscape") return;
        if (visible) hidden.delete(layer);
        else hidden.add(layer);
        renderer?.setLayerVisible(layer, visible);
      },
      setVehicle: (value) => {
        vehicle = value;
        renderer?.setVehicle(value);
      },
      dispose,
    };
  }
  dispose() {
    if (!this.disposed) {
      this.disposed = true;
      this.observer.disconnect();
      for (const dispose of this.handles) dispose();
      for (const dispose of this.inputCleanups) dispose();
      if (this.ownsMap) this.map.remove();
    }
  }
}
