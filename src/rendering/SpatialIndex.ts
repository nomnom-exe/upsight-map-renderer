/**
 * @file src/rendering/SpatialIndex.ts
 * @brief Find features whose bounds overlap an area of the map.
 * @author Norman
 * @description Groups feature IDs by grid cell and checks large features separately.
 */

import { intersects } from "../geo/math.js";
import type { Extent } from "../geo/types.js";

/** Store features that span too many grid cells in a separate set. */
export class SpatialIndex {
  private bounds = new Map<string, Extent>();
  private cells = new Map<string, Set<string>>();
  private membership = new Map<string, string[] | null>();
  private overflow = new Set<string>();
  private keys(b: Extent): string[] | null {
    const x0 = Math.floor(b.west * 50),
      x1 = Math.floor(b.east * 50),
      y0 = Math.floor(b.south * 50),
      y1 = Math.floor(b.north * 50);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 256) return null;
    const keys: string[] = [];
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) keys.push(`${x}:${y}`);
    return keys;
  }
  set(id: string, b: Extent) {
    this.delete(id);
    const keys = this.keys(b);
    this.bounds.set(id, b);
    this.membership.set(id, keys);
    if (!keys) this.overflow.add(id);
    for (const key of keys ?? []) {
      const bucket = this.cells.get(key) ?? new Set();
      bucket.add(id);
      this.cells.set(key, bucket);
    }
  }
  delete(id: string) {
    for (const key of this.membership.get(id) ?? []) {
      const bucket = this.cells.get(key)!;
      bucket.delete(id);
      if (!bucket.size) this.cells.delete(key);
    }
    this.membership.delete(id);
    this.bounds.delete(id);
    this.overflow.delete(id);
  }
  query(b: Extent) {
    const keys = this.keys(b),
      ids = keys ? new Set(this.overflow) : new Set(this.bounds.keys());
    for (const key of keys ?? [])
      for (const id of this.cells.get(key) ?? []) ids.add(id);
    return [...ids].filter((id) => intersects(this.bounds.get(id)!, b));
  }
}
