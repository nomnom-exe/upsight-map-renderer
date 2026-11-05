/** @file Start a map with one editable sample building. @author Norman */
import { Map as MapLibreMap } from "maplibre-gl";
import {
  applyFeatureEnvelope,
  DEFAULT_STYLE,
  SceneStore,
  type RendererOptions,
} from "@upsight/map-renderer";
import { MapLibreConnection } from "@upsight/map-renderer/maplibre";

// Import maplibre-gl/dist/maplibre-gl.css in your application entry point.
// Give the container a visible width and height before calling this function.
export async function createBasicMap(
  container: HTMLElement,
  styleUrl: string,
  signal: AbortSignal,
  options: RendererOptions = {},
) {
  if (signal.aborted) throw new DOMException("Map startup cancelled.", "AbortError");
  if (container.clientWidth <= 0 || container.clientHeight <= 0)
    throw new Error("The map container needs a visible CSS width and height.");

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

  // The app chooses the style URL. Its tiles, glyphs and sprites must be reachable.
  const map = new MapLibreMap({
    container,
    style: styleUrl,
    center: [103.80015, 1.3001],
    zoom: 19,
    pitch: 50,
    bearing: -17,
    renderWorldCopies: false,
    attributionControl: { compact: true },
  });
  let connection: MapLibreConnection | undefined;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener("abort", dispose);
    connection?.dispose();
    // fromMap does not own this map, so this example removes it separately.
    map.remove();
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        map.off("style.load", loaded);
        signal.removeEventListener("abort", cancelled);
        if (error) reject(error);
        else resolve();
      };
      const loaded = () => finish();
      const cancelled = () => finish(new DOMException("Map startup cancelled.", "AbortError"));
      const timer = setTimeout(() => finish(new Error("Map style did not load within 25 seconds.")), 25000);
      map.on("style.load", loaded);
      signal.addEventListener("abort", cancelled, { once: true });
      if (signal.aborted) cancelled();
      else if (map.isStyleLoaded()) loaded();
    });
    if (signal.aborted) throw new DOMException("Map startup cancelled.", "AbortError");

    connection = MapLibreConnection.fromMap(map);
    const renderer = connection.attach(store, options);
    connection.bindInput((x, y) => renderer.select(renderer.pick(x, y)), () => {});
    signal.addEventListener("abort", dispose, { once: true });
    return { map, connection, store, renderer, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
