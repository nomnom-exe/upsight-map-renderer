/**
 * @file src/rendering/models/MeshWriter.ts
 * @brief Build model meshes from vertices and triangles.
 * @author Norman
 * @description Stores surface coordinates and a feature ID for each triangle so the renderer can identify what was picked.
 */

import earcut from "earcut";
import type { MeshData } from "../geometry.js";
export type V2 = readonly [number, number];
export type V3 = readonly [number, number, number];
export type RGB = readonly [number, number, number];
export const rgb = (hex: string): RGB =>
  [1, 3, 5].map(
    (i) => parseInt(hex.slice(i, i + 2), 16) / 255,
  ) as unknown as RGB;
/** Each triangle belongs to an editable feature. Surface coordinates (UVs) use metres by default. */
export class MeshWriter {
  private p: number[] = [];
  private c: number[] = [];
  private k: number[] = [];
  private s: number[] = [];
  private ix: number[] = [];
  private ids: string[] = [];
  private triangulations = new WeakMap<readonly (readonly V2[])[], {
    flat: number[];
    ringLengths: number[];
    indices: number[];
  }>();
  id = "";
  key = 0;
  pointTransform?: { x: number; z: number; angle: number };
  vertex(p: V3, color: RGB, uv: V2 = [0, 0], material = 0, shade = 1) {
    const i = this.p.length / 3;
    const t = this.pointTransform;
    if (t) {
      const x = p[0] - t.x,
        z = p[2] - t.z,
        c = Math.cos(t.angle),
        s = Math.sin(t.angle);
      this.p.push(t.x + x * c - z * s, p[1], t.z + x * s + z * c);
    } else this.p.push(p[0], p[1], p[2]);
    this.c.push(color[0] * shade, color[1] * shade, color[2] * shade);
    this.k.push(this.key);
    this.s.push(uv[0], uv[1], material);
    return i;
  }
  tri(a: number, b: number, c: number) {
    this.ix.push(a, b, c);
    this.ids.push(this.id);
  }
  quad(
    a: V3,
    b: V3,
    c: V3,
    d: V3,
    color: RGB,
    material = 0,
    u = 1,
    v = 1,
    shade = 1,
    vOffset = 0,
  ) {
    const aa = this.vertex(a, color, [0, vOffset], material, shade),
      bb = this.vertex(b, color, [u, vOffset], material, shade),
      cc = this.vertex(c, color, [u, vOffset + v], material, shade),
      dd = this.vertex(d, color, [0, vOffset + v], material, shade);
    this.tri(aa, bb, cc);
    this.tri(aa, cc, dd);
  }
  polygon(
    rings: readonly (readonly V2[])[],
    y: number,
    color: RGB,
    material = 0,
  ) {
    const saved = this.triangulations.get(rings);
    const cached = saved && saved.ringLengths.length === rings.length &&
      rings.every((ring, i) => ring.length === saved.ringLengths[i]) ? saved : undefined;
    let flat: number[] | undefined = cached ? undefined : [];
    let coordinate = 0;
    const vs: number[] = [];
    for (const ring of rings) {
      for (const [x, z] of ring) {
        // Parking decks at different heights can reuse the same triangle indices.
        // Check each coordinate in case the caller changed the footprint.
        // Each deck still gets its own height, material and feature ID.
        if (!flat && (cached!.flat[coordinate] !== x || cached!.flat[coordinate + 1] !== z))
          flat = cached!.flat.slice(0, coordinate);
        flat?.push(x, z);
        coordinate += 2;
        vs.push(this.vertex([x, y, z], color, [x, z], material));
      }
    }
    let indices = cached?.indices;
    if (flat) {
      const holes: number[] = [];
      let vertices = 0;
      for (const [i, ring] of rings.entries()) {
        if (i) holes.push(vertices);
        vertices += ring.length;
      }
      indices = earcut(flat, holes);
      this.triangulations.set(rings, { flat, ringLengths: rings.map((ring) => ring.length), indices });
    }
    if (!indices) return;
    for (let i = 0; i < indices.length; i += 3)
      this.tri(vs[indices[i]], vs[indices[i + 1]], vs[indices[i + 2]]);
  }
  walls(
    rings: readonly (readonly V2[])[],
    base: number,
    top: number,
    color: RGB,
    material = 0,
    facade?: { floorHeight: number; datum: number },
  ) {
    // Scale the vertical surface coordinates so each storey spans 3.2 UV units.
    const verticalScale = facade ? 3.2 / facade.floorHeight : 1;
    for (const ring of rings)
      for (let i = 0; i < ring.length; i++) {
        const [ax, az] = ring[i],
          [bx, bz] = ring[(i + 1) % ring.length],
          length = Math.hypot(bx - ax, bz - az);
        if (length < 0.01) continue;
        const shade =
          0.67 +
          0.3 * (0.5 + (0.5 * ((bz - az) * 0.7 - (bx - ax) * 0.7)) / length);
        this.quad(
          [ax, base, az],
          [bx, base, bz],
          [bx, top, bz],
          [ax, top, az],
          color,
          material,
          length,
          (top - base) * verticalScale,
          shade,
          facade ? (base - facade.datum) * verticalScale : 0,
        );
      }
  }
  box(
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    color: RGB,
    material = 0,
  ) {
    const ring: V2[] = [
      [x - w / 2, z - d / 2],
      [x + w / 2, z - d / 2],
      [x + w / 2, z + d / 2],
      [x - w / 2, z + d / 2],
    ];
    this.walls([ring], y, y + h, color, material);
    this.polygon([ring], y + h, color);
  }
  ribbon(
    points: readonly V2[],
    width: number | readonly number[],
    y: number | readonly number[],
    color: RGB,
    material = 0,
    round = true,
    offset = 0,
    segmentMask?: readonly boolean[],
  ) {
    if (segmentMask) {
      // Apply the mask before removing duplicate points so it matches the original edges.
      // Use flat ends at gaps to keep them open.
      for (let edge = 0; edge < segmentMask.length;) {
        if (!segmentMask[edge]) { edge++; continue; }
        const start = edge;
        while (edge < segmentMask.length && segmentMask[edge]) edge++;
        this.ribbon(points.slice(start, edge + 1), typeof width === "number" ? width : width.slice(start, edge + 1),
          typeof y === "number" ? y : y.slice(start, edge + 1), color, material, false, offset);
      }
      if (round) for (const index of [0, points.length - 1]) {
        if (!segmentMask[index === 0 ? 0 : index - 1]) continue;
        this.disc(points[index][0], typeof y === "number" ? y : y[index], points[index][1], (typeof width === "number" ? width : width[index]) / 2, color);
      }
      return;
    }
    // Use two vertices per point and share them between neighbouring segments.
    // That keeps each join connected without extra triangles for a round cap.
    const p = points
      .map((v, i) => ({ v, h: typeof y === "number" ? y : y[i], width: typeof width === "number" ? width : width[i] }))
      .filter(
        (p, i) =>
          !i ||
          Math.hypot(p.v[0] - points[i - 1][0], p.v[1] - points[i - 1][1]) >
            0.001,
      );
    if (p.length < 2) return;
    const normal = (a: V2, b: V2): V2 => {
      const dx = b[0] - a[0],
        dz = b[1] - a[1],
        length = Math.hypot(dx, dz) || 1;
      return [-dz / length, dx / length];
    };
    let distance = 0;
    const pairs: number[][] = [];
    for (let i = 0; i < p.length; i++) {
      const {
        v: [x, z],
        h,
        width,
      } = p[i];
      const before = normal(p[Math.max(0, i - 1)].v, p[i ? i : 1].v);
      const after = normal(
        p[i < p.length - 1 ? i : i - 1].v,
        p[Math.min(p.length - 1, i + 1)].v,
      );
      let nx = before[0] + after[0],
        nz = before[1] + after[1];
      const length = Math.hypot(nx, nz);
      if (length < 0.01) {
        nx = after[0];
        nz = after[1];
      } else {
        nx /= length;
        nz /= length;
      }
      const scale = Math.min(
        2.5,
        1 / Math.max(0.1, nx * after[0] + nz * after[1]),
      );
      if (i) distance += Math.hypot(x - p[i - 1].v[0], z - p[i - 1].v[1]);
      pairs.push(
        [-1, 1].map((side) => {
          const across = (offset + (side * width) / 2) * scale;
          return this.vertex(
            [x + nx * across, h, z + nz * across],
            color,
            [(side * width) / 2, distance],
            material,
          );
        }),
      );
      if (i) {
        this.tri(pairs[i - 1][0], pairs[i - 1][1], pairs[i][1]);
        this.tri(pairs[i - 1][0], pairs[i][1], pairs[i][0]);
      }
    }
    if (round)
      for (const end of [p[0], p[p.length - 1]])
        this.disc(end.v[0], end.h, end.v[1], end.width / 2, color);
  }
  disc(x: number, y: number, z: number, r: number, color: RGB) {
    const c = this.vertex([x, y, z], color);
    const ring: number[] = [];
    for (let i = 0; i < 10; i++) {
      const a = (i * Math.PI) / 5;
      ring.push(
        this.vertex([x + Math.cos(a) * r, y, z + Math.sin(a) * r], color),
      );
    }
    for (let i = 0; i < ring.length; i++)
      this.tri(c, ring[i], ring[(i + 1) % ring.length]);
  }
  crown(
    x: number,
    y: number,
    z: number,
    r: number,
    color: RGB,
    segments: number,
  ) {
    // All tree models use this shape for the crown. Shade each face of the ellipsoid separately.
    for (let band = 0; band < 4; band++)
      for (let i = 0; i < segments; i++) {
        const pt = (b: number, j: number): V3 => {
          const a = (b * Math.PI) / 4,
            t = (j * 2 * Math.PI) / segments;
          return [
            x + Math.sin(a) * Math.cos(t) * r,
            y + Math.cos(a) * r * 1.25,
            z + Math.sin(a) * Math.sin(t) * r,
          ];
        };
        const shade =
          0.68 +
          (0.27 * (1 + Math.cos((i * 2 * Math.PI) / segments - 0.8))) / 2;
        this.quad(
          pt(band, i),
          pt(band, i + 1),
          pt(band + 1, i + 1),
          pt(band + 1, i),
          color,
          0,
          1,
          1,
          shade,
        );
      }
  }
  finish(): MeshData {
    return {
      positions: new Float32Array(this.p),
      colors: new Float32Array(this.c),
      keys: new Float32Array(this.k),
      surface: new Float32Array(this.s),
      indices: new Uint32Array(this.ix),
      faceIds: this.ids,
    };
  }
}
