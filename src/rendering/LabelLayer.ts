/**
 * @file rendering/LabelLayer.ts
 * @brief Draw a limited number of map labels that can be edited through scene commands.
 * @author Norman
 */
import { SpatialIndex } from "./SpatialIndex.js";
import { featureExtent } from "../geo/math.js";
import type { SceneStore } from "../geo/SceneStore.js";
import type { GeoFeature, LayerName } from "../geo/types.js";
import type { RendererHandle } from "./types.js";

/** The host supplies a positioned container for these plain-text DOM labels. They draw
 * over 3D objects and work without React. To let objects hide labels, use a custom
 * renderer with depth testing. */
export class LabelLayer {
  private root: HTMLDivElement;
  private labels = new Map<string, GeoFeature>();
  private index = new SpatialIndex();
  private nodes = new Map<string, HTMLButtonElement>();
  private hidden = new Set<LayerName>();
  private visible = true;
  private offs: (() => void)[];
  private limit: number;
  constructor(container: HTMLElement, store: SceneStore, private renderer: RendererHandle,
    private select: (id: string) => void, limit = 80) {
    this.limit = Math.max(1, Math.min(200, Math.floor(limit) || 80));
    this.root = document.createElement("div");
    Object.assign(this.root.style, { position: "absolute", inset: "0", pointerEvents: "none", overflow: "hidden" });
    container.appendChild(this.root);
    const sync = (ids: readonly string[]) => {
      for (const id of ids) {
        const f = store.get(id);
        if (f?.model?.kind === "label") { this.labels.set(id, f); this.index.set(id, featureExtent(f)); }
        else { this.labels.delete(id); this.index.delete(id); }
      }
      this.draw();
    };
    this.offs = [store.subscribe(({ ids }) => sync(ids)), renderer.subscribeFrame(() => this.draw())];
    sync(store.values().map((f) => f.id));
  }
  setLayerVisible(layer: LayerName, visible: boolean) {
    if (visible) this.hidden.delete(layer); else this.hidden.add(layer);
    this.draw();
  }
  setVisible(visible: boolean) {
    this.visible = visible;
    this.root.style.display = visible ? "" : "none";
    if (visible) this.draw();
  }
  private draw() {
    if (!this.visible) return;
    const view = this.renderer.getViewport();
    if (!view) return;
    const visible = new Set<string>();
    const boxes: { x: number; y: number; w: number; h: number }[] = [];
    for (const id of this.index.query(view.bounds).sort().slice(0, 500)) {
      const f = this.labels.get(id)!;
      if (visible.size >= this.limit) break;
      if (this.hidden.has(f.layer) || f.geometry.type !== "Point") continue;
      const p = this.renderer.project(f.geometry.coordinates, f.style.elevation);
      if (!p || p.x < 0 || p.y < 0 || p.x > view.width || p.y > view.height) continue;
      const size = f.model?.fontSize ?? 13;
      const box = { x: p.x, y: p.y, w: Math.min(260, f.label.length * size * 0.7 + 16), h: size + 12 };
      if (boxes.some((b) => Math.abs(b.x - box.x) < (b.w + box.w) / 2 && Math.abs(b.y - box.y) < (b.h + box.h) / 2)) continue;
      boxes.push(box); visible.add(id);
      let node = this.nodes.get(id);
      if (!node) {
        node = document.createElement("button"); node.type = "button";
        Object.assign(node.style, { position: "absolute", pointerEvents: "auto", transform: "translate(-50%, -50%)", border: "0", borderRadius: "4px", padding: "4px 8px", background: "rgba(255,255,255,.92)", maxWidth: "260px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
        node.onclick = (event) => { event.stopPropagation(); this.select(id); };
        this.root.appendChild(node); this.nodes.set(id, node);
      }
      if (node.textContent !== f.label) node.textContent = f.label;
      Object.assign(node.style, { left: `${p.x}px`, top: `${p.y}px`, color: f.style.color, fontSize: `${size}px` });
    }
    for (const [id, node] of this.nodes) if (!visible.has(id)) { node.remove(); this.nodes.delete(id); }
  }
  dispose() { this.offs.forEach((off) => off()); this.root.remove(); this.nodes.clear(); this.labels.clear(); }
}
