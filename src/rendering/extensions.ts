/**
 * @file rendering/extensions.ts
 * @brief Define how custom renderers receive updates, draw and handle picking.
 * @author Norman
 */
import type { Scene } from "@babylonjs/core/scene.js";
import type { Matrix } from "@babylonjs/core/Maths/math.vector.js";
import type { SceneStore } from "../geo/SceneStore.js";
import type { GeoFeature, LayerName } from "../geo/types.js";
import type { ViewportSnapshot } from "../geo/Viewport.js";

export interface ExtensionFrame {
  readonly viewport: ViewportSnapshot;
  /** Place local metre coordinates in Mercator world space, then apply this matrix to reach clip space. */
  readonly cameraMatrix: Matrix;
  readonly hidden: ReadonlySet<LayerName>;
  readonly selected: string | null;
}
export interface RendererExtension {
  /** Only changed IDs for this renderer are included. A removed feature has the value undefined. */
  sync(changes: ReadonlyMap<string, GeoFeature | undefined>): void;
  render(frame: ExtensionFrame): void;
  /** The coordinates and dimensions come from the drawing buffer and already account for CSS scaling.
   * Return the hit distance in Mercator units so the renderer can choose the closest hit. */
  pick?(x: number, y: number, width: number, height: number): { id: string; distance: number } | null;
  dispose(): void;
}
export interface RendererExtensionFactory {
  readonly id: string;
  create(context: { scene: Scene; store: SceneStore; invalidate(): void }): RendererExtension;
}

/** If an extension fails during an update, drawing or picking, remove it so the others can keep running. */
export class ExtensionRegistry {
  private entries = new Map<string, { plugin: RendererExtension; ids: Set<string> }>();
  private warned = new Set<string>();
  constructor(
    factories: readonly RendererExtensionFactory[],
    context: Parameters<RendererExtensionFactory["create"]>[0],
    private report: (message: string) => void,
  ) {
    const names = new Set<string>();
    for (const factory of factories) {
      if (!/^[a-z][\w.-]{0,50}$/.test(factory.id) || names.has(factory.id))
        throw new Error("Render extension IDs must be valid and unique.");
      names.add(factory.id);
    }
    try {
      for (const factory of factories)
        this.entries.set(factory.id, { plugin: factory.create(context), ids: new Set() });
    } catch (error) { this.dispose(); throw error; }
  }
  private run(id: string, action: (plugin: RendererExtension) => void) {
    const entry = this.entries.get(id);
    if (!entry) return;
    try { action(entry.plugin); }
    catch (error) {
      this.entries.delete(id);
      try { entry.plugin.dispose(); } catch { /* Report the error that caused the extension to fail. */ }
      this.report(`Render extension ${id} disabled: ${String(error)}`);
    }
  }
  sync(store: SceneStore, ids: readonly string[]) {
    for (const [name, entry] of this.entries) {
      const changes = new Map<string, GeoFeature | undefined>();
      for (const id of ids) {
        const f = store.get(id);
        if (f?.model?.kind === "custom" && f.model.rendererId === name) {
          entry.ids.add(id); changes.set(id, f);
        } else if (entry.ids.delete(id)) changes.set(id, undefined);
      }
      if (changes.size) this.run(name, (plugin) => plugin.sync(changes));
    }
    for (const id of ids) {
      const f = store.get(id);
      const name = f?.model?.kind === "custom" ? f.model.rendererId : undefined;
      if (name && !this.entries.has(name) && !this.warned.has(name)) {
        this.warned.add(name); this.report(`No active render extension for ${name}.`);
      }
    }
  }
  render(frame: ExtensionFrame) {
    for (const name of this.entries.keys()) this.run(name, (p) => p.render(frame));
  }
  pick(x: number, y: number, width: number, height: number) {
    let closest: { id: string; distance: number } | null = null;
    for (const [name, entry] of this.entries) this.run(name, (p) => {
      const hit = p.pick?.(x, y, width, height);
      if (hit && entry.ids.has(hit.id) && Number.isFinite(hit.distance) && hit.distance >= 0 && (!closest || hit.distance < closest.distance)) closest = hit;
    });
    return closest as { id: string; distance: number } | null;
  }
  dispose() {
    for (const { plugin } of this.entries.values()) {
      try { plugin.dispose(); } catch (error) { this.report(String(error)); }
    }
    this.entries.clear();
  }
}
