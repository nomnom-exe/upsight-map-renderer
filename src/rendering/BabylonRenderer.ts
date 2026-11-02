/**
 * @file src/rendering/BabylonRenderer.ts
 * @brief Draw editable map features with Babylon.
 * @author Norman
 * @description Groups nearby features into batches, uploads their meshes and handles picking and selection.
 */

import "@babylonjs/core/Culling/ray.js";
import { Ray } from "@babylonjs/core/Culling/ray.js";
import { Engine } from "@babylonjs/core/Engines/engine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { Camera } from "@babylonjs/core/Cameras/camera.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial.js";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { SceneInstrumentation } from "@babylonjs/core/Instrumentation/sceneInstrumentation.js";
import { Color4 } from "@babylonjs/core/Maths/math.color.js";
import type { CameraView } from "../engine/CameraView.js";
import { localFrame, RAD } from "../geo/math.js";
import { buildingIdentity } from "../geo/buildingGroups.js";
import type { ViewportSnapshot } from "../geo/Viewport.js";

import type { SceneStore } from "../geo/SceneStore.js";
import type { LayerName, Position } from "../geo/types.js";
import { BatchIndex, type Batch } from "./BatchIndex.js";
import { buildVehicleGeometry, type MeshData } from "./geometry.js";
import { GeometryBuilder } from "./GeometryBuilder.js";
import { batchDetail, deviceQuality, type RenderQuality } from "./quality.js";
import type { RendererHandle, RendererOptions, VehiclePose } from "./types.js";
import { CITY_VERTEX, cityFragment } from "./models/materials.js";
import { AssetLayer } from "./AssetLayer.js";
import { ExtensionRegistry } from "./extensions.js";
import { FrameBudget } from "./FrameBudget.js";

type Cached = {
  mesh: Mesh;
  material: ShaderMaterial;
  world: Matrix;
  combined: Matrix;
  version: number;
  detail: number;
  used: number;
  faceIds: string[];
  bytes: number;
  scale: number;
  batch?: Batch;
};

/** A map host can provide its WebGL context and request each frame. */
export interface SharedDrawingSurface {
  context: WebGLRenderingContext | WebGL2RenderingContext;
  requestFrame(): void;
}

function meshBytes(data: MeshData) {
  return data.positions.byteLength + data.colors.byteLength + data.keys.byteLength +
    (data.surface?.byteLength ?? data.positions.byteLength) + data.indices.byteLength;
}

function worldAt(origin: Position, elevation = 0) {
  const { anchor, scale } = localFrame(origin);
  return Matrix.Compose(
    new Vector3(scale, scale, scale),
    Quaternion.FromEulerAngles(Math.PI / 2, 0, 0),
    new Vector3(anchor[0], anchor[1], elevation * scale),
  );
}
/** Draws the map scene and finds the feature under a screen point. */
export class BabylonRenderer implements RendererHandle {
  private scheduled = 0;
  private contextLost = false;
  private observer?: ResizeObserver;
  private offCamera?: () => void;
  private listeners = new Set<() => void>();
  private engine?: Engine;
  private surfaceShader!: string;
  private scene?: Scene;
  private instrumentation?: SceneInstrumentation;
  private index = new BatchIndex();
  private cache = new Map<string, Cached>();
  private keys = new Map<string, number>();
  private keyOwners = new Map<string, string>();
  private groupKeys = new Map<string, { key: number; ids: Set<string> }>();
  private freeKeys: number[] = [];
  private nextKey = 1;
  private off?: () => void;
  private selected: string | null = null;
  private hidden = new Set<LayerName>();
  private vehiclePose: VehiclePose | null = null;
  private vehicle?: Cached;
  private cameraMatrix?: Matrix;
  private frame = 0;
  private dirty = true;
  private ready = false;
  private lastReport = 0;
  private shaderWait = 0;
  private quality!: RenderQuality;
  private builder?: GeometryBuilder;
  private assets?: AssetLayer;
  private extensions?: ExtensionRegistry;
  private work = new Map<
    string,
    { batch: Batch; version: number; detail: 0 | 1; controller: AbortController; data?: MeshData; failed?: boolean }
  >();
  private lastBuildMs = 0;
  private removed = false;
  private viewport: Omit<ViewportSnapshot, "groundCorners"> | null = null;
  private totalUploadedBytes = 0;
  private geometryBuilds = 0;
  private frameBudget = new FrameBudget();
  private deferredBatches = 0;
  private budgetDeferred = new Set<string>();
  private oversizedNear = new WeakMap<Batch, { version: number; triangles: number; bytes: number }>();
  constructor(
    private canvas: HTMLCanvasElement,
    private camera: CameraView,
    private store: SceneStore,
    private options: RendererOptions = {},
    private shared?: SharedDrawingSurface,
  ) {
    try {
      this.quality = options.quality ?? deviceQuality();
      let worker: Worker | null = null;
      try {
        worker = options.createGeometryWorker ? options.createGeometryWorker() : new Worker(new URL("./geometry.worker.js", import.meta.url), {
          type: "module",
        });
      } catch {
        /* If the worker is unavailable, the builder runs one batch at a time on the main thread. */
      }
      this.builder = new GeometryBuilder(worker, this.quality.cacheBytes / 4);
      this.engine = new Engine(
        shared?.context ?? canvas,
        !shared && this.quality.name !== "mobile",
        {
          useHighPrecisionMatrix: true,
          stencil: true,
          doNotHandleContextLost: Boolean(shared),
        },
      );
      this.surfaceShader = cityFragment(this.engine);
      this.engine.onContextLostObservable.add(() => {
        this.contextLost = true;
        this.ready = false;
        options.onError?.("Graphics context lost; waiting for recovery.");
      });
      this.engine.onContextRestoredObservable.add(() => {
        this.contextLost = false;
        options.onError?.("");
        this.invalidate();
      });
      this.scene = new Scene(this.engine);
      if (shared) {
        this.scene.autoClear = false;
        this.scene.autoClearDepthAndStencil = false;
      }
      this.scene.clearColor = new Color4(0.86, 0.91, 0.93, 1);
      this.scene.detachControl();
      this.assets = new AssetLayer(
        this.scene,
        () => this.invalidate(),
        (message) => options.onError?.(message),
        (assetId, ready) => options.onAssetReady?.(assetId, ready),
        options.resolveAsset,
      );
      this.extensions = new ExtensionRegistry(options.extensions ?? [], { scene: this.scene, store, invalidate: () => this.invalidate() }, message => options.onError?.(message));
      this.scene.activeCamera = new Camera(
        "map-camera",
        Vector3.Zero(),
        this.scene,
      );
      this.instrumentation = new SceneInstrumentation(this.scene);
      this.cameraMatrix = Matrix.Identity();
      this.vehicle = this.createMesh(
        "vehicle",
        buildVehicleGeometry(),
        [0, 0],
        0,
        0,
      );
      if (!shared) {
        this.observer = new ResizeObserver(() => this.resize());
        this.observer.observe(canvas);
      }
      this.offCamera = camera.subscribe(() => {
        this.budgetDeferred.clear();
        this.invalidate();
      });
      if (!shared) this.resize();
      this.off = this.store.subscribe(({ ids }) => this.sync(ids));
      this.sync(this.store.values().map((f) => f.id));
    } catch (e) {
      this.dispose();
      throw e;
    }
  }
  subscribeFrame = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private requestFrame() {
    if (this.removed || this.contextLost || this.scheduled) return;
    if (this.shared) {
      this.shared.requestFrame();
      return;
    }
    this.scheduled = requestAnimationFrame(() => {
      this.scheduled = 0;
      this.render();
    });
  }
  private resize() {
    if (!this.engine || this.removed) return;
    this.quality = this.options.quality ?? deviceQuality();
    this.builder?.setCacheLimit(this.quality.cacheBytes / 4);
    this.engine.setHardwareScalingLevel(1 / this.quality.pixelRatio);
    this.engine.resize();
    this.camera.resize(
      this.canvas.clientWidth,
      this.canvas.clientHeight,
      this.quality.pixelRatio,
    );
    this.invalidate();
  }
  private sync(ids: readonly string[]) {
    this.budgetDeferred.clear();
    this.assets?.sync(this.store, ids);
    this.extensions?.sync(this.store, ids);
    this.index.sync(this.store, ids);
    for (const id of ids) {
      const f = this.store.get(id),
        previous = this.keyOwners.get(id);
      const identity = f ? (buildingIdentity(f) ?? `feature:${id}`) : undefined;
      if (identity === previous) continue;
      if (previous) {
        const owner = this.groupKeys.get(previous)!;
        owner.ids.delete(id);
        if (!owner.ids.size) {
          this.freeKeys.push(owner.key);
          this.groupKeys.delete(previous);
        }
      }
      this.keys.delete(id);
      this.keyOwners.delete(id);
      if (identity) {
        let owner = this.groupKeys.get(identity);
        if (!owner) {
          owner = {
            key: this.freeKeys.pop() ?? this.nextKey++,
            ids: new Set(),
          };
          this.groupKeys.set(identity, owner);
        }
        owner.ids.add(id);
        this.keyOwners.set(id, identity);
        this.keys.set(id, owner.key);
      }
    }
    if (this.selected && !this.store.get(this.selected)) this.selected = null;
    this.invalidate();
  }
  invalidate() {
    this.dirty = true;
    this.requestFrame();
  }
  select(id: string | null) {
    if (this.selected !== id) this.budgetDeferred.clear();
    this.selected = id;
    this.invalidate();
  }
  setLayerVisible(layer: LayerName, visible: boolean) {
    this.budgetDeferred.clear();
    if (visible) this.hidden.delete(layer);
    else this.hidden.add(layer);
    this.invalidate();
  }
  setVehicle(pose: VehiclePose | null) {
    this.vehiclePose = pose;
    this.requestFrame();
  }
  private createMesh(
    id: string,
    data: MeshData,
    origin: Position,
    version: number,
    detail: number,
  ): Cached {
    const mesh = new Mesh(id, this.scene!);
    mesh.setVerticesData("position", data.positions, false, 3);
    mesh.setVerticesData("tint", data.colors, false, 3);
    mesh.setVerticesData("featureKey", data.keys, false, 1);
    mesh.setVerticesData(
      "surface",
      data.surface ?? new Float32Array(data.positions.length),
      false,
      3,
    );
    mesh.setIndices(data.indices);
    const material = new ShaderMaterial(
      `${id}-material`,
      this.scene!,
      { vertexSource: CITY_VERTEX, fragmentSource: this.surfaceShader },
      {
        attributes: ["position", "tint", "featureKey", "surface"],
        uniforms: ["mapMatrix", "selectedKey"],
      },
    );
    material.backFaceCulling = false;
    mesh.material = material;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.freezeWorldMatrix();
    return {
      mesh,
      material,
      world: worldAt(origin),
      combined: Matrix.Identity(),
      version,
      detail,
      used: this.frame,
      faceIds: data.faceIds,
      bytes: meshBytes(data),
      scale: localFrame(origin).scale,
    };
  }
  private disposeEntry(entry: Cached) {
    entry.mesh.dispose();
    entry.material.dispose();
  }
  private cancelWork(id: string) {
    const job = this.work.get(id);
    this.work.delete(id);
    job?.controller.abort();
  }
  pick(x: number, y: number): string | null {
    if (!this.ready || this.removed) return null;
    const canvas = this.canvas,
      ratio = canvas.width / canvas.clientWidth;
    let nearest = Infinity,
      id: string | null = null;
    for (const entry of this.cache.values())
      if (entry.mesh.isEnabled()) {
        const ray = Ray.CreateNew(
          x * ratio,
          y * ratio,
          canvas.width,
          canvas.height,
          Matrix.Identity(),
          Matrix.Identity(),
          entry.combined,
        );
        const hit = ray.intersectsMesh(entry.mesh, false);
        // Convert each hit distance from local metres to Mercator units before comparing batches.
        if (hit.hit && hit.distance * entry.scale < nearest) {
          nearest = hit.distance * entry.scale;
          id = entry.faceIds[hit.faceId] ?? null;
        }
      }
    const asset = this.assets?.pick(
      x * ratio,
      y * ratio,
      canvas.width,
      canvas.height,
    );
    if (asset && asset.distance < nearest) { nearest = asset.distance; id = asset.id; }
    const custom = this.extensions?.pick(x * ratio, y * ratio, canvas.width, canvas.height);
    return custom && custom.distance < nearest ? custom.id : id;
  }
  project(p: Position, elevation = 0) {
    return this.ready ? this.camera.project(p, elevation) : null;
  }
  screenToGround(x: number, y: number) {
    return this.ready ? this.camera.screenToGround(x, y) : null;
  }
  getViewport(): ViewportSnapshot | null {
    if (!this.ready || !this.viewport) return null;
    const { width, height } = this.viewport;
    return {
      ...this.viewport,
      bounds: { ...this.viewport.bounds },
      center: [...this.viewport.center],
      groundCorners: [
        [0, 0],
        [width, 0],
        [width, height],
        [0, height],
      ].map(([x, y]) => this.screenToGround(x, y)),
    };
  }
  render() {
    if (
      this.removed ||
      this.contextLost ||
      !this.engine ||
      !this.scene ||
      !this.cameraMatrix
    )
      return;
    this.frame++;
    this.cameraMatrix.copyFrom(this.camera.transform);
    const previousViewport = this.viewport;
    this.viewport = this.camera.snapshot();
    if (
      previousViewport?.width !== this.viewport.width ||
      previousViewport?.height !== this.viewport.height
    ) {
      // MapLibre can resize its drawing surface between frames.
      // Update the batch and detail limits for the new screen size.
      this.quality = this.options.quality ?? deviceQuality();
      this.builder?.setCacheLimit(this.quality.cacheBytes / 4);
      this.dirty = true;
    }
    const start = performance.now();
    let bytes = 0,
      built = 0,
      pending = false,
      needsFrame = false;
    if (this.dirty) {
      const triangleLimit = this.quality.name === "mobile" ? 300000 : 1000000;
      const selectedIds = new Set(
        this.selected
          ? this.store.selectionMembers(this.selected).map((f) => f.id)
          : [],
      );
      const selectionBatches = new Set<string>();
      if (selectedIds.size)
        for (const [id, batch] of this.index.batches) {
          for (const featureId of batch.features.keys())
            if (selectedIds.has(featureId)) {
              selectionBatches.add(id);
              break;
            }
        }
      const containsSelection = (id: string) => selectionBatches.has(id);
      const essential = (id: string) => containsSelection(id) ||
        ["route", "scenario", "chargers", "imported"].includes(this.index.batches.get(id)!.layer);
      const { bounds, center } = this.viewport;
      const query = bounds;
      const candidates = this.index.spatial
        .query(query)
        .filter(
          (id) =>
            !this.budgetDeferred.has(id) &&
            !this.hidden.has(this.index.batches.get(id)!.layer),
        );
      candidates.sort((a, b) => {
        // Give selected features, routes and user objects first choice of the available batch slots.
        if (essential(a) !== essential(b)) return Number(essential(b)) - Number(essential(a));
        const x = this.index.batches.get(a)!.origin,
          y = this.index.batches.get(b)!.origin;
        return (
          (x[0] - center[0]) ** 2 +
          (x[1] - center[1]) ** 2 -
          ((y[0] - center[0]) ** 2 + (y[1] - center[1]) ** 2)
        );
      });
      const visible = new Set(candidates.slice(0, this.quality.maxVisible));
      // Drop queued batches that the new view no longer needs.
      // The worker can finish its current batch.
      for (const [id, job] of this.work)
        if (!visible.has(id) || this.index.batches.get(id) !== job.batch || job.batch.version !== job.version)
          this.cancelWork(id);
      for (const [id, entry] of this.cache) {
        entry.mesh.setEnabled(visible.has(id));
        if (!this.index.batches.has(id)) {
          this.disposeEntry(entry);
          this.cache.delete(id);
        }
      }
      for (const id of visible) {
        const batch = this.index.batches.get(id)!;
        let entry = this.cache.get(id);
        const near = this.oversizedNear.get(batch);
        const exceedsBudget = !essential(id) && near?.version === batch.version &&
          (near.triangles > triangleLimit || near.bytes > this.quality.cacheBytes);
        const detail = this.frameBudget.reduced || exceedsBudget
          ? 0
          : batchDetail(
              batch.extent,
              [center[0], center[1]],
              this.viewport.zoom,
              this.quality,
              entry?.detail,
            );
        if (
          !entry ||
          entry.batch !== batch ||
          entry.version !== batch.version ||
          entry.detail !== detail
        ) {
          let job = this.work.get(id);
          if (job && (job.version !== batch.version || job.detail !== detail)) {
            this.cancelWork(id);
            job = undefined;
          }
          // Count meshes waiting for GPU upload toward the queue limit.
          // Otherwise the worker can fill memory faster than a phone can upload them.
          const queued = [...this.work.values()].filter(
            (value) => !value.failed,
          ).length;
          if (!job && this.builder && this.builder.pending < 2 && queued < 2) {
            job = { batch, version: batch.version, detail, controller: new AbortController() };
            this.work.set(id, job);
            const ticket = job,
              builder = this.builder,
              oldMode = builder.mode;
            const features = [...batch.features.values()];
            const keys: [string, number][] = features.map((f) => {
              if (!this.keys.has(f.id))
                this.keys.set(f.id, this.freeKeys.pop() ?? this.nextKey++);
              return [f.id, this.keys.get(f.id)!];
            });
            void builder
              .build({ features, origin: batch.origin, keys, detail }, ticket.controller.signal)
              .then((result) => {
                if (this.removed) return;
                if (this.work.get(id) === ticket) {
                  if (
                    this.index.batches.get(id) === batch &&
                    batch.version === ticket.version
                  ) {
                    ticket.data = result.data;
                    this.lastBuildMs = result.buildMs;
                  } else this.work.delete(id);
                }
                this.invalidate();
              })
              .catch((error) => {
                if (this.removed || ticket.controller.signal.aborted) return;
                if (oldMode !== builder.mode) this.work.delete(id);
                else if (this.work.get(id) === ticket) ticket.failed = true;
                this.options.onError?.(String(error));
                this.invalidate();
              });
          }
          if (
            !job?.data ||
            built >= this.quality.uploadsPerFrame ||
            (built > 0 &&
              performance.now() - start > this.quality.uploadBudgetMs)
          ) {
            pending = true;
            if (job?.data) needsFrame = true;
            // Keep the old mesh during a detail change only if it still matches the batch version.
            entry?.mesh.setEnabled(entry.batch === batch && entry.version === batch.version);
            continue;
          }
          const data = job.data;
          this.work.delete(id);
          const uploadBytes = meshBytes(data), triangles = data.indices.length / 3;
          if (detail && !essential(id) && (uploadBytes > this.quality.cacheBytes || triangles > triangleLimit)) {
            // A single feature can exceed the device limit. Try it with less detail
            // before allocating a GPU mesh.
            this.oversizedNear.set(batch, { version: batch.version, triangles, bytes: uploadBytes });
            entry?.mesh.setEnabled(entry.batch === batch && entry.version === batch.version);
            pending = needsFrame = true;
            continue;
          }
          if (entry) this.disposeEntry(entry);
          entry = this.createMesh(
            id,
            data,
            batch.origin,
            batch.version,
            detail,
          );
          entry.batch = batch;
          this.cache.set(id, entry);
          built++;
          this.geometryBuilds++;
          bytes += uploadBytes;
        }
        entry.used = this.frame;
        entry.mesh.setEnabled(true);
      }
      let visibleBytes = 0,
        visibleTriangles = 0;
      this.deferredBatches =
        this.budgetDeferred.size +
        Math.max(0, candidates.length - visible.size);
      for (const id of visible) {
        const entry = this.cache.get(id);
        if (!entry?.mesh.isEnabled()) continue;
        const triangles = entry.mesh.getTotalIndices() / 3;
        if (
          !essential(id) &&
          (visibleBytes + entry.bytes > this.quality.cacheBytes ||
            visibleTriangles + triangles > triangleLimit)
        ) {
          entry.mesh.setEnabled(false);
          visible.delete(id);
          this.budgetDeferred.add(id);
          this.deferredBatches++;
        } else {
          visibleBytes += entry.bytes;
          visibleTriangles += triangles;
        }
      }
      let retainedBytes = this.cachedBytes();
      for (const [id, entry] of [...this.cache].sort(
        (a, b) => a[1].used - b[1].used,
      ))
        if (
          (this.cache.size > this.quality.maxCached ||
            retainedBytes > this.quality.cacheBytes) &&
          !visible.has(id)
        ) {
          retainedBytes -= entry.bytes;
          this.disposeEntry(entry);
          this.cache.delete(id);
        }
      this.dirty = pending;
    }
    const uploadMs = performance.now() - start;
    this.totalUploadedBytes += bytes;
    for (const entry of this.cache.values())
      if (entry.mesh.isEnabled()) {
        entry.world.multiplyToRef(this.cameraMatrix, entry.combined);
        entry.material.setMatrix("mapMatrix", entry.combined);
        entry.material.setFloat(
          "selectedKey",
          this.selected ? (this.keys.get(this.selected) ?? -1) : -1,
        );
      }
    if (this.vehicle) {
      const p = this.vehiclePose;
      this.vehicle.mesh.setEnabled(
        Boolean(p?.visible) && !this.hidden.has("route"),
      );
      if (p) {
        this.vehicle.world = Matrix.RotationY(p.bearing * RAD).multiply(
          worldAt(p.position, Number.isFinite(p.elevation) ? p.elevation : 0),
        );
        this.vehicle.world.multiplyToRef(
          this.cameraMatrix,
          this.vehicle.combined,
        );
        this.vehicle.material.setMatrix("mapMatrix", this.vehicle.combined);
        this.vehicle.material.setFloat("selectedKey", -1);
      }
    }
    this.assets?.render(
      this.viewport as ViewportSnapshot,
      this.cameraMatrix,
      this.hidden,
      this.selected,
      this.quality.name === "mobile",
    );
    if (this.shared) {
      this.engine.wipeCaches(true);
      // The map style uses its own depth offsets, which can make our roads flicker.
      // Clear only depth so the 3D objects share a fresh depth buffer and the map
      // keeps its colour and stencil.
      this.engine.clear(null, false, true, false);
    }
    this.extensions?.render({ viewport: this.viewport as ViewportSnapshot, cameraMatrix: this.cameraMatrix, hidden: this.hidden, selected: this.selected });
    this.scene.render(false);
    if (this.shared) this.engine.wipeCaches(true);
    const renderCpuMs = performance.now() - start;
    if (this.frameBudget.sample(renderCpuMs)) {
      this.dirty = true;
      needsFrame = true;
    }
    this.ready = true;
    for (const listener of this.listeners) listener();
    if (this.scene.isReady()) this.shaderWait = 0;
    else if (++this.shaderWait === 120)
      this.options.onError?.(
        "Custom shaders could not become ready. Reload the map to retry.",
      );
    if (needsFrame || (this.shaderWait > 0 && this.shaderWait < 120))
      this.requestFrame();
    if (performance.now() - this.lastReport > 250 || built) {
      this.lastReport = performance.now();
      const visible = [...this.cache.values()].filter((e) =>
        e.mesh.isEnabled(),
      );
      this.options.onStats?.({
        assetsVisible: this.assets?.stats.visible ?? 0,
        renderCpuMs,
        renderCpuP95: this.frameBudget.p95,
        reducedDetail: this.frameBudget.reduced,
        deferredBatches: this.deferredBatches,
        assetsDeferred: this.assets?.stats.deferred ?? 0,
        assetBytes: this.assets?.stats.bytes ?? 0,
        features: this.store.size,
        batches: this.index.batches.size,
        visible: visible.length,
        cached: this.cache.size,
        triangles: visible.reduce(
          (sum, e) => sum + e.mesh.getTotalIndices() / 3,
          this.assets?.stats.triangles ?? 0,
        ),
        drawCalls: this.instrumentation?.drawCallsCounter.current ?? 0,
        uploadedBytes: bytes,
        totalUploadedBytes: this.totalUploadedBytes,
        geometryBuilds: this.geometryBuilds,
        buildMs: this.lastBuildMs,
        uploadMs,
        cachedBytes: this.cachedBytes(),
        profile: this.quality.name,
        geometryMode: this.builder?.mode ?? "main-thread fallback",
        detail: visible.some((e) => e.detail) ? "near" : "far",
      });
    }
  }
  private cachedBytes() {
    let bytes = 0;
    for (const entry of this.cache.values()) bytes += entry.bytes;
    return bytes;
  }
  dispose() {
    if (this.removed) return;
    this.removed = true;
    cancelAnimationFrame(this.scheduled);
    this.observer?.disconnect();
    this.offCamera?.();
    this.listeners.clear();
    this.builder?.dispose();
    this.assets?.dispose();
    this.extensions?.dispose();
    this.builder = undefined;
    this.work.clear();
    this.off?.();
    this.off = undefined;
    this.instrumentation?.dispose();
    for (const e of this.cache.values()) this.disposeEntry(e);
    this.cache.clear();
    if (this.vehicle) this.disposeEntry(this.vehicle);
    this.vehicle = undefined;
    this.scene?.dispose();
    this.engine?.dispose();
    this.scene = undefined;
    this.engine = undefined;
    this.ready = false;
    this.viewport = null;
  }
}
