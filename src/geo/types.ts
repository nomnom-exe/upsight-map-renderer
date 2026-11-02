/**
 * @file src/geo/types.ts
 * @brief Define the map's shared geometry, features and styles.
 * @author Norman
 * @description Includes scene commands, provider details and route data.
 */

/** WGS84 coordinates in [longitude, latitude] order. */
export type Position = readonly [number, number];
export type Extent = {
  west: number;
  south: number;
  east: number;
  north: number;
};
export type LayerName =
  | "chargers"
  | "route"
  | "scenario"
  | "imported"
  | "buildings"
  | "roads"
  | "landscape"
  | "annotations"
  | `custom:${string}`;
/** Describes how to draw a feature without storing a Babylon mesh. */
export interface ModelStyle {
  readonly kind:
    | "building"
    | "road"
    | "line"
    | "water"
    | "park"
    | "ground"
    | "tree"
    | "charger"
    | "asset"
    | "label"
    | "custom";
  /** Set to the original feature's ID when replacing its geometry. Copies cannot replace the original. */
  readonly replacement?: string;
  readonly rendererId?: string;
  readonly fontSize?: number;
  readonly facade?: "glass" | "stone" | "brick";
  readonly family?:
    | "neutral"
    | "residential"
    | "house"
    | "commercial"
    | "industrial"
    | "parking"
    | "civic"
    | "canopy";
  /** Indices of outer-ring vertices where a canopy column would block a mapped road or path. */
  readonly omitSupports?: readonly number[];
  readonly roof?: {
    readonly shape: "flat" | "gabled" | "hipped" | "pyramidal" | "skillion";
    readonly height: number;
    readonly color: string;
    readonly across?: boolean;
    /** Bearing of the roof's downhill slope, in degrees clockwise from north (OSM roof:direction). */
    readonly direction?: number;
  };
  readonly road?: {
    readonly lanes: number;
    readonly footway: boolean;
    readonly paved: boolean;
    readonly sidewalk: boolean;
    readonly sidewalkSide?: "left" | "right" | "both";
    /** Hide a tunnel or indoor road from the surface view. The host still decides where routes can go. */
    readonly surfaceHidden?: boolean;
    /** Road heights in metres relative to the host's reference level. Values can be negative.
     * Add style.elevation minus 0.18 m to each height. An OSM layer number describes level order only. */
    readonly elevations?: readonly number[];
    /** Optional OSM node IDs, one per road vertex in the same order. */
    readonly nodeIds?: readonly number[];
  };
  /** Draw a route, traffic event or annotation as a strip. Heights are absolute elevations in metres. */
  readonly line?: {
    readonly elevations?: readonly number[];
    readonly widths?: readonly number[];
    /** One flag per edge. False leaves a gap when the road surface is uncertain. */
    readonly segmentMask?: readonly boolean[];
    readonly dashed?: boolean;
  };
  /** Stable model library ID for an asset or charger. Blob URLs are invalid here. */
  readonly assetId?: string;
  readonly length?: number;
  readonly heading?: number;
}
export type Geometry =
  | { readonly type: "Point"; readonly coordinates: Position }
  | { readonly type: "LineString"; readonly coordinates: readonly Position[] }
  | {
      readonly type: "Polygon";
      readonly coordinates: readonly (readonly Position[])[];
    };
export interface FeatureStyle {
  readonly color: string;
  readonly height: number;
  readonly radius: number;
  readonly width: number;
  readonly elevation: number;
}
export interface GeoFeature {
  readonly id: string;
  readonly source: string;
  readonly layer: LayerName;
  readonly label: string;
  readonly geometry: Geometry;
  readonly style: FeatureStyle;
  readonly model?: ModelStyle;
  readonly properties: Readonly<
    Record<string, string | number | boolean | null>
  >;
}
/** A charger can use a GLB model and still behave as a charger. */
export function usesModelAsset(feature: GeoFeature) {
  return (
    feature.model?.kind === "asset" ||
    (feature.model?.kind === "charger" && !!feature.model.assetId)
  );
}
export interface SourceInfo {
  readonly id: string;
  readonly label: string;
  readonly status: "live" | "stale" | "snapshot" | "local";
  readonly attribution: string;
  readonly asOf?: string;
}
export interface SceneChange {
  reason: "source" | "preview" | "commit";
  revision: number;
  ids: readonly string[];
}
export type SceneCommand =
  | { type: "upsert"; features: readonly GeoFeature[] }
  | { type: "remove"; ids: readonly string[] };
/** Describes how to draw a route. Hidden includes underground and indoor roads. The host decides road access. */
export type RouteSurfaceState = "surface" | "hidden" | "unknown" | "ambiguous" | "transition" | "limited";
export interface RouteData {
  readonly positions: readonly Position[];
  readonly durationSeconds: number;
  readonly distanceMetres: number;
  readonly source: string;
  readonly nodeIds?: readonly number[];
  /** Pairs of consecutive OSM nodes on the same route leg. */
  readonly nodePairs?: readonly (readonly [number, number])[];
  readonly elevations?: readonly number[];
  readonly widths?: readonly number[];
  readonly segmentMask?: readonly boolean[];
  /** Why each edge is shown or hidden. A host can draw hidden edges schematically when their depth is unknown. */
  readonly segmentStates?: readonly RouteSurfaceState[];
  /** Counts route samples, including hidden samples among the matches. Conflicts between samples appear only in segmentStates. */
  readonly surfaceMatch?: { matched: number; ambiguous: number; unknown: number; hidden?: number; truncated: boolean };
}
export const DEFAULT_STYLE: FeatureStyle = Object.freeze({
  color: "#087f8c",
  height: 5,
  radius: 2,
  width: 5,
  elevation: 0.4,
});
