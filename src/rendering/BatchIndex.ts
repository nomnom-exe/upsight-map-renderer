/**
 * @file src/rendering/BatchIndex.ts
 * @brief Group nearby map features into batches for drawing.
 * @author Norman
 * @description Tracks which batches changed so an edit only rebuilds the affected geometry.
 */

import {
  featureExtent,
  geometryExtent,
  mercator,
  unmercator,
} from "../geo/math.js";
import type { SceneStore } from "../geo/SceneStore.js";
import type { Extent, GeoFeature, LayerName, Position } from "../geo/types.js";
import { usesModelAsset } from "../geo/types.js";
import { SpatialIndex } from "./SpatialIndex.js";

export interface Batch {
  id: string;
  origin: Position;
  layer: LayerName;
  features: Map<string, GeoFeature>;
  extent: Extent;
  version: number;
}
const GRID = 65536;
// Limit both the number of features and the number of source vertices per batch.
// Keep a large feature whole to preserve its holes, line joins and picking ID.
const BATCH_CAPACITY = 4096;
function featureCost(f: GeoFeature) {
  const g = f.geometry;
  const vertices = g.type === "Point" ? 1 : g.type === "LineString" ? g.coordinates.length :
    g.coordinates.reduce((n, ring) => n + ring.length, 0);
  return Math.max(f.model?.kind === "park" ? 128 : 32, vertices);
}
/** Each Mercator cell spans about 600 metres at the equator and less near the poles. */
export class BatchIndex {
  readonly batches = new Map<string, Batch>();
  readonly spatial = new SpatialIndex();
  private membership = new Map<string, string>();
  private costs = new WeakMap<Batch, number>();
  // SceneStore creates a new feature object for each edit. Cache bounds by object
  // so unused features and their old bounds can be freed together.
  private bounds = new WeakMap<GeoFeature, { raw: Extent; padded: Extent }>();
  private boundsOf(feature: GeoFeature) {
    let bounds = this.bounds.get(feature);
    if (!bounds) {
      const raw = geometryExtent(feature.geometry);
      bounds = { raw, padded: featureExtent(feature, raw) };
      this.bounds.set(feature, bounds);
    }
    return bounds;
  }
  sync(store: SceneStore, ids: readonly string[]) {
    const dirty = new Set<string>();
    for (const id of ids) {
      const old = this.membership.get(id);
      if (old) {
        const batch = this.batches.get(old)!;
        this.costs.set(batch, this.costs.get(batch)! - featureCost(batch.features.get(id)!));
        batch.features.delete(id);
        dirty.add(old);
        this.membership.delete(id);
      }
      const f = store.get(id);
      if (!f || usesModelAsset(f) || f.model?.kind === "label" || f.model?.kind === "custom") continue;
      const e = this.boundsOf(f).raw,
        m = mercator([(e.west + e.east) / 2, (e.south + e.north) / 2]);
      const x = Math.floor(m[0] * GRID),
        y = Math.floor(m[1] * GRID),
        cell = `${f.layer}:${x}:${y}`;
      const cost = featureCost(f);
      const fits = (id: string) => {
        const batch = this.batches.get(id);
        return !batch?.features.size || this.costs.get(batch)! + cost <= BATCH_CAPACITY;
      };
      // Keep the feature in its old batch if it still fits in the same cell.
      let key = old && (old === cell || old.startsWith(cell + "/")) && fits(old) ? old : cell;
      for (let i = 1; !fits(key); i++) key = `${cell}/${i}`;
      const b = this.batches.get(key) ?? {
        id: key,
        origin: unmercator([(x + 0.5) / GRID, (y + 0.5) / GRID]),
        layer: f.layer,
        features: new Map(),
        extent: e,
        version: 0,
      };
      b.features.set(id, f);
      this.costs.set(b, (this.costs.get(b) ?? 0) + cost);
      this.batches.set(key, b);
      this.membership.set(id, key);
      dirty.add(key);
    }
    for (const id of dirty) {
      const b = this.batches.get(id)!;
      this.spatial.delete(id);
      if (!b.features.size) {
        this.batches.delete(id);
        continue;
      }
      const e = {
        west: Infinity,
        east: -Infinity,
        south: Infinity,
        north: -Infinity,
      };
      for (const f of b.features.values()) {
        const v = this.boundsOf(f).padded;
        e.west = Math.min(e.west, v.west);
        e.east = Math.max(e.east, v.east);
        e.south = Math.min(e.south, v.south);
        e.north = Math.max(e.north, v.north);
      }
      b.extent = e;
      b.version++;
      this.spatial.set(id, e);
    }
    return dirty;
  }
}
