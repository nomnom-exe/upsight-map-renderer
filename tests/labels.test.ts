/** @file tests/labels.test.ts @brief Test label placement, edits and cleanup using a simulated screen. @author Norman */
import { afterEach, expect, it, vi } from "vitest";
import { LabelLayer } from "../src/rendering/LabelLayer";
import { SceneStore } from "../src/geo/SceneStore";
import { DEFAULT_STYLE, type GeoFeature } from "../src/geo/types";
import type { RendererHandle } from "../src/rendering/types";
class Element {
  style = {}; textContent = ""; type = ""; onclick?: () => void;
  children: Element[] = []; parent?: Element;
  appendChild(child: Element) { child.parent = this; this.children.push(child); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); }
}
afterEach(() => vi.unstubAllGlobals());
it("renders text literally, suppresses collisions and removes edited/deleted labels", () => {
  vi.stubGlobal("document", { createElement: () => new Element() });
  const store = new SceneStore(), container = new Element(), off = vi.fn();
  const renderer = {
    getViewport: () => ({ width: 800, height: 600, bounds: { west: 100, east: 105, south: 0, north: 5 } }),
    project: () => ({ x: 200, y: 200 }), subscribeFrame: () => off,
  } as unknown as RendererHandle;
  const feature: GeoFeature = { id: "test:a", source: "test", label: "<img src=x>", geometry: { type: "Point", coordinates: [103.8,1.3] }, layer: "annotations", style: DEFAULT_STYLE, model: { kind: "label" }, properties: {} };
  store.execute({ type: "upsert", features: [feature, { ...feature, id: "test:b" }] });
  const labels = new LabelLayer(container as unknown as HTMLElement, store, renderer, vi.fn());
  const overlay = container.children[0];
  expect(overlay.children).toHaveLength(1); expect(overlay.children[0].textContent).toBe("<img src=x>");
  store.execute({ type: "upsert", features: [{ ...feature, label: "Updated" }] });
  expect(overlay.children[0].textContent).toBe("Updated");
  labels.setVisible(false);
  expect(overlay.style).toHaveProperty("display", "none");
  store.execute({ type: "upsert", features: [{ ...feature, label: "Edited while hidden" }] });
  labels.setVisible(true);
  expect(overlay.style).toHaveProperty("display", "");
  expect(overlay.children[0].textContent).toBe("Edited while hidden");
  labels.setLayerVisible("annotations", false); expect(overlay.children).toHaveLength(0);
  store.execute({ type: "remove", ids: ["test:a","test:b"] });
  labels.setLayerVisible("annotations", true); expect(overlay.children).toHaveLength(0);
  labels.dispose(); expect(off).toHaveBeenCalledOnce(); expect(container.children).toHaveLength(0);
});
