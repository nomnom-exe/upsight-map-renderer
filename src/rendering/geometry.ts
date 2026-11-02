/**
 * @file src/rendering/geometry.ts
 * @brief Build mesh buffers from map features on the CPU.
 * @author Norman
 * @description Builds map meshes with feature IDs for picking, plus a vehicle mesh for route previews.
 */

import earcut from "earcut";
import { localFrame } from "../geo/math.js";
import type { GeoFeature, Position } from "../geo/types.js";
import { buildCityModels } from "./models/cityModels.js";

export interface MeshData {
  positions: Float32Array;
  colors: Float32Array;
  keys: Float32Array;
  surface?: Float32Array;
  indices: Uint32Array;
  faceIds: string[];
}

/** Build the route preview vehicle in local metres. */
export function buildVehicleGeometry(): MeshData {
  const p: number[] = [],
    c: number[] = [],
    indices: number[] = [];
  const box = (w: number, h: number, d: number, y: number, color: number[]) => {
    const start = p.length / 3;
    for (const dy of [0, h])
      for (const [x, z] of [
        [-w / 2, -d / 2],
        [w / 2, -d / 2],
        [w / 2, d / 2],
        [-w / 2, d / 2],
      ]) {
        p.push(x, y + dy, z);
        c.push(...color.map((v) => v * (dy ? 1 : 0.6)));
      }
    for (const [a, b, e, f] of [
      [0, 3, 2, 1],
      [4, 5, 6, 7],
      [0, 1, 5, 4],
      [1, 2, 6, 5],
      [2, 3, 7, 6],
      [3, 0, 4, 7],
    ])
      indices.push(
        start + a,
        start + b,
        start + e,
        start + a,
        start + e,
        start + f,
      );
  };
  box(1.9, 0.8, 4.5, 0.4, [0.05, 0.5, 0.56]);
  box(1.6, 0.65, 2.3, 1.2, [0.12, 0.22, 0.31]);
  return {
    positions: new Float32Array(p),
    colors: new Float32Array(c),
    keys: new Float32Array(p.length / 3).fill(-2),
    indices: new Uint32Array(indices),
    faceIds: [],
  };
}

/** Build opaque, shaded meshes in metres from the batch origin. */
export function buildGeometry(
  features: Iterable<GeoFeature>,
  origin: Position,
  keyOf: (id: string) => number,
  detail: 0 | 1,
): MeshData {
  const all = [...features],
    models = all.filter((f) => f.model);
  if (models.length === all.length && all.length)
    return buildCityModels(models, origin, keyOf, detail);
  const positions: number[] = [],
    colors: number[] = [],
    keys: number[] = [],
    indices: number[] = [],
    faceIds: string[] = [];
  const frame = localFrame(origin);
  for (const f of all.filter((f) => !f.model)) {
    const color = [1, 3, 5].map(
        (i) => parseInt(f.style.color.slice(i, i + 2), 16) / 255,
      ),
      key = keyOf(f.id),
      s = f.style;
    const vertex = (x: number, y: number, z: number, shade = 1) => {
      const i = positions.length / 3;
      positions.push(x, y, z);
      colors.push(...color.map((c) => c * shade));
      keys.push(key);
      return i;
    };
    const tri = (a: number, b: number, c: number) => {
      indices.push(a, b, c);
      faceIds.push(f.id);
    };
    const quad = (a: number, b: number, c: number, d: number) => {
      tri(a, b, c);
      tri(a, c, d);
    };
    const cylinder = (
      x: number,
      z: number,
      r: number,
      height: number,
      base: number,
      segments: number,
    ) => {
      const top = vertex(x, base + height, z, 1),
        bottom = vertex(x, base, z, 0.65);
      for (let i = 0; i < segments; i++) {
        const a = (i * Math.PI * 2) / segments,
          b = ((i + 1) * Math.PI * 2) / segments;
        const shade = 0.68 + (0.25 * (Math.cos(a - 0.6) + 1)) / 2;
        const u = vertex(x + Math.cos(a) * r, base, z + Math.sin(a) * r, shade),
          v = vertex(x + Math.cos(b) * r, base, z + Math.sin(b) * r, shade),
          w = vertex(
            x + Math.cos(b) * r,
            base + height,
            z + Math.sin(b) * r,
            shade,
          ),
          q = vertex(
            x + Math.cos(a) * r,
            base + height,
            z + Math.sin(a) * r,
            shade,
          );
        quad(u, v, w, q);
        tri(top, q, w);
        tri(bottom, v, u);
      }
    };
    if (f.geometry.type === "Point") {
      const [x, z] = frame.project(f.geometry.coordinates),
        n = detail ? 12 : 6;
      cylinder(x, z, s.radius * 1.7, 0.25, s.elevation, n);
      cylinder(x, z, s.radius * 0.65, Math.max(0.2, s.height), s.elevation, n);
      cylinder(x, z, s.radius, 0.5, s.elevation + s.height, n);
    } else if (f.geometry.type === "LineString") {
      const p = f.geometry.coordinates.map((v) => frame.project(v));
      for (let i = 1; i < p.length; i++) {
        const [ax, az] = p[i - 1],
          [bx, bz] = p[i],
          dx = bx - ax,
          dz = bz - az,
          length = Math.hypot(dx, dz);
        if (length < 0.001) continue;
        const nx = ((-dz / length) * s.width) / 2,
          nz = ((dx / length) * s.width) / 2;
        quad(
          vertex(ax + nx, s.elevation, az + nz),
          vertex(ax - nx, s.elevation, az - nz),
          vertex(bx - nx, s.elevation, bz - nz),
          vertex(bx + nx, s.elevation, bz + nz),
        );
      }
      // Round off the joins so sharp turns have no gaps.
      for (const [x, z] of p) {
        const center = vertex(x, s.elevation, z),
          segments = detail ? 10 : 5;
        for (let i = 0; i < segments; i++) {
          const a = (i * Math.PI * 2) / segments,
            b = ((i + 1) * Math.PI * 2) / segments;
          tri(
            center,
            vertex(
              x + (Math.cos(a) * s.width) / 2,
              s.elevation,
              z + (Math.sin(a) * s.width) / 2,
            ),
            vertex(
              x + (Math.cos(b) * s.width) / 2,
              s.elevation,
              z + (Math.sin(b) * s.width) / 2,
            ),
          );
        }
      }
    } else {
      const rings = f.geometry.coordinates.map((r) =>
          r.map((p) => frame.project(p)),
        ),
        flat: number[] = [],
        holes: number[] = [];
      for (const [index, r] of rings.entries()) {
        if (index) holes.push(flat.length / 2);
        for (const p of r) flat.push(...p);
      }
      const start = positions.length / 3;
      for (let i = 0; i < flat.length; i += 2)
        vertex(flat[i], s.elevation + s.height, flat[i + 1]);
      const faces = earcut(flat, holes, 2);
      for (let i = 0; i < faces.length; i += 3)
        tri(start + faces[i], start + faces[i + 1], start + faces[i + 2]);
      if (s.height > 0)
        for (const r of rings)
          for (let i = 0; i < r.length; i++) {
            const [ax, az] = r[i],
              [bx, bz] = r[(i + 1) % r.length],
              shade =
                0.65 +
                0.2 * Math.abs((bx - ax) / (Math.hypot(bx - ax, bz - az) || 1));
            quad(
              vertex(ax, s.elevation, az, shade),
              vertex(bx, s.elevation, bz, shade),
              vertex(bx, s.elevation + s.height, bz, shade),
              vertex(ax, s.elevation + s.height, az, shade),
            );
          }
    }
  }
  const basic: MeshData = {
    positions: new Float32Array(positions),
    colors: new Float32Array(colors),
    keys: new Float32Array(keys),
    indices: new Uint32Array(indices),
    faceIds,
  };
  if (!models.length) return basic;
  const city = buildCityModels(models, origin, keyOf, detail),
    offset = basic.positions.length / 3;
  const join = (a: Float32Array, b: Float32Array) => {
    const result = new Float32Array(a.length + b.length);
    result.set(a);
    result.set(b, a.length);
    return result;
  };
  const joinedIndices = new Uint32Array(
    basic.indices.length + city.indices.length,
  );
  joinedIndices.set(basic.indices);
  for (let i = 0; i < city.indices.length; i++)
    joinedIndices[basic.indices.length + i] = city.indices[i] + offset;
  return {
    positions: join(basic.positions, city.positions),
    colors: join(basic.colors, city.colors),
    keys: join(basic.keys, city.keys),
    surface: join(new Float32Array(basic.positions.length), city.surface!),
    indices: joinedIndices,
    faceIds: [...basic.faceIds, ...city.faceIds],
  };
}
