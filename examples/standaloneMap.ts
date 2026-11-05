/** @file Draw one editable building without a basemap or MapLibre. @author Norman */
import {
  applyFeatureEnvelope,
  DEFAULT_STYLE,
  SceneStore,
  type RendererOptions,
} from "@upsight/map-renderer";
import { BabylonRenderer } from "@upsight/map-renderer/babylon";
import { MapCamera } from "@upsight/map-renderer/engine/MapCamera";
import { MapControls } from "@upsight/map-renderer/engine/MapControls";

// Give the canvas a visible CSS width and height before calling this function.
export function createStandaloneMap(canvas: HTMLCanvasElement, options: RendererOptions = {}) {
  if (canvas.clientWidth <= 0 || canvas.clientHeight <= 0)
    throw new Error("The canvas needs a visible CSS width and height.");

  const store = new SceneStore();
  applyFeatureEnvelope(store, {
    schemaVersion: 1,
    source: { id: "example", label: "Sample building", status: "snapshot", attribution: "Synthetic example" },
    features: [{
      id: "example:building", source: "example", layer: "buildings", label: "Sample building",
      geometry: {
        type: "Polygon",
        coordinates: [[[103.8, 1.3], [103.8003, 1.3], [103.8003, 1.3002],
          [103.8, 1.3002], [103.8, 1.3]]],
      },
      style: { ...DEFAULT_STYLE, height: 8 },
      model: { kind: "building", family: "industrial" },
      properties: {},
    }],
  });

  const camera = new MapCamera([103.80015, 1.3001]);
  camera.setView({ zoom: 19, pitch: 50, bearing: -17 });
  const previous = {
    tabIndex: canvas.tabIndex,
    touchAction: canvas.style.touchAction,
    label: canvas.getAttribute("aria-label"),
  };
  // The renderer observes canvas resizing and schedules frames when something changes.
  // Do not add another requestAnimationFrame loop just to redraw this static scene.
  const renderer = new BabylonRenderer(canvas, camera, store, options);
  canvas.tabIndex = 0;
  canvas.style.touchAction = "none";
  canvas.setAttribute("aria-label", "Interactive map. Drag to pan, scroll or pinch to zoom. Right drag to orbit.");
  const controls = new MapControls(canvas, camera,
    (x, y) => renderer.select(renderer.pick(x, y)), () => {});
  let disposed = false;
  return {
    store, camera, controls, renderer,
    dispose() {
      if (disposed) return;
      disposed = true;
      controls.dispose();
      renderer.dispose();
      canvas.tabIndex = previous.tabIndex;
      canvas.style.touchAction = previous.touchAction;
      if (previous.label === null) canvas.removeAttribute("aria-label");
      else canvas.setAttribute("aria-label", previous.label);
    },
  };
}
