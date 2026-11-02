/**
 * @file geo/provider.ts
 * @brief Define the feature format providers send to the renderer. Providers handle authentication and network requests.
 * @author Norman
 */
import type { Extent, GeoFeature, SourceInfo } from "./types.js";
import type { SceneStore } from "./SceneStore.js";

export interface FeatureEnvelopeV1 { schemaVersion: 1; source: SourceInfo; features: readonly GeoFeature[] }
export interface FeatureProvider {
  load(query: { bounds: Extent; zoom: number; signal: AbortSignal }): Promise<FeatureEnvelopeV1>;
}
/** Replace one source's entire set of base features after validation. Omitted features leave that source's base data. */
export function applyFeatureEnvelope(store: SceneStore, value: FeatureEnvelopeV1) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.features)) throw new Error("Expected a v1 feature envelope.");
  const source = value.source;
  if (!source || !/^[\w.-]{1,60}$/.test(source.id) || typeof source.label !== "string" || source.label.length > 160 ||
    typeof source.attribution !== "string" || source.attribution.length > 2000 ||
    !["live", "stale", "snapshot", "local"].includes(source.status) ||
    (source.asOf !== undefined && (typeof source.asOf !== "string" || !Number.isFinite(Date.parse(source.asOf))))) throw new Error("Invalid source metadata.");
  store.replaceSource(source, value.features);
}
