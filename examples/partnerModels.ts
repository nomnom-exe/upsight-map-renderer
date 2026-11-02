/** @file examples/partnerModels.ts @brief Load a GLB from the host app and place editable copies on the map. @author Norman */
import {
  DEFAULT_STYLE, MAX_GLB_BYTES, inspectGLB,
  type AssetResolver, type GeoFeature, type Position, type SceneStore,
} from "@upsight/map-renderer";

export interface PartnerModelPlacement {
  /** A persistent ID for this placement, unique within its source. */
  id: string;
  assetId: string;
  label: string;
  position: Position;
  /** Length of the model's longest horizontal side in metres. Scaling preserves its proportions. */
  lengthMetres: number;
  headingDegrees?: number;
  /** Height in metres above or below the host scene's reference elevation. */
  elevationMetres?: number;
}

/** Use this example in the host app, which loads and stores the GLB files.
 * Register bytes from File.arrayBuffer() or a fetch, then pass resolveAsset to RendererOptions.
 * Each asset ID identifies one version. To replace "depot-v1", register "depot-v2"
 * and update the placed model's asset ID with SceneStore.execute.
 *
 * A saved scene records each model's asset ID and placement. Register its GLB bytes under
 * the same ID before restoring the scene. Keep the bytes after deleting a placement so undo can restore it.
 * Dispose of the renderer or map connection before disposing of this library. The library releases its
 * copies of the bytes. The host app still owns the scene, the original files and its GPU resources.
 */
export function createPartnerModels(store: SceneStore, source = "partner-models", maxBytes = 40 * 1024 * 1024) {
  if (!/^[a-z][\w.-]{0,59}$/.test(source)) throw new Error("Use a unique source ID beginning with a lowercase letter.");
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Model byte budget must be a positive integer.");
  const models = new Map<string, Uint8Array>();
  let bytesHeld = 0, disposed = false;
  const requireOpen = () => { if (disposed) throw new Error("Partner model library is disposed."); };
  const key = (value: string) => {
    if (!/^[\w.-]{1,80}$/.test(value)) throw new Error("Use a model or instance key of 1–80 letters, digits, dots, dashes or underscores.");
    return `${source}:${value}`;
  };
  const resolveAsset: AssetResolver = async (id) => {
    requireOpen();
    const data = models.get(id);
    if (!data) throw new Error(`Register model bytes before resolving ${id}.`);
    // Give the decoder a copy because it may keep or transfer the buffer.
    return data.slice();
  };
  return {
    get byteLength() { return bytesHeld; },
    get size() { return models.size; },
    register(modelKey: string, data: ArrayBuffer | Uint8Array): string {
      requireOpen();
      const id = key(modelKey);
      if (models.has(id)) throw new Error("Model IDs are immutable. Register a new version key instead.");
      if (data.byteLength > MAX_GLB_BYTES || bytesHeld + data.byteLength > maxBytes)
        throw new Error("Model library byte budget exceeded.");
      // A Uint8Array can cover part of a buffer. Copy just that range.
      const copy = new Uint8Array(data instanceof Uint8Array ? data : new Uint8Array(data));
      inspectGLB(copy.buffer);
      models.set(id, copy);
      bytesHeld += copy.byteLength;
      return id;
    },
    place(options: PartnerModelPlacement): GeoFeature {
      requireOpen();
      if (!models.has(options.assetId)) throw new Error("Register the model before placing an instance.");
      const id = key(options.id);
      if (store.get(id) || store.committedOverrides().some(([savedId]) => savedId === id))
        throw new Error("Instance ID already exists. Edit it through SceneStore or choose a new ID.");
      const feature: GeoFeature = {
        id, source, layer: "imported", label: options.label,
        geometry: { type: "Point", coordinates: options.position },
        // White keeps the GLB's original colours and textures.
        style: { ...DEFAULT_STYLE, color: "#ffffff", elevation: options.elevationMetres ?? 0 },
        model: { kind: "asset", assetId: options.assetId, length: options.lengthMetres,
          heading: options.headingDegrees ?? 0 },
        properties: {},
      };
      store.execute({ type: "upsert", features: [feature] });
      return store.get(id)!;
    },
    resolveAsset,
    dispose() { disposed = true; models.clear(); bytesHeld = 0; },
  };
}
