/**
 * @file src/rendering/CameraFrame.ts
 * @brief Convert between map and screen coordinates.
 * @author Norman
 * @description Uses the camera matrix and screen dimensions from the same frame for both conversions.
 */

import { Matrix } from "@babylonjs/core/Maths/math.vector.js";
import { PerformanceConfigurator } from "@babylonjs/core/Engines/performanceConfigurator.js";
import { localFrame, mercator, unmercator } from "../geo/math.js";
import type { Position } from "../geo/types.js";

/** Both conversions use the rendered Mercator-to-clip matrix and run entirely on the CPU. */
export class CameraFrame {
  private matrix = new Float64Array(16);
  private inverse?: ArrayLike<number>;
  private valid = false;
  width = 0;
  height = 0;

  update(matrix: ArrayLike<number>, width: number, height: number) {
    this.valid = matrix.length === 16 && Array.from(matrix).every(Number.isFinite) && width > 0 && height > 0;
    this.width = width;
    this.height = height;
    if (this.valid) this.matrix.set(Array.from(matrix));
    this.inverse = undefined;
  }

  project(position: Position, elevation = 0) {
    if (!this.valid || ![...position, elevation].every(Number.isFinite) || Math.abs(position[1]) > 85) return null;
    const [x, y] = mercator(position), z = elevation * localFrame(position).scale;
    const p = this.transform(this.matrix, x, y, z);
    if (!p || p[3] <= 0 || p[2] < -1 || p[2] > 1) return null;
    return { x: (p[0] + 1) * this.width / 2, y: (1 - p[1]) * this.height / 2 };
  }

  screenToGround(x: number, y: number): Position | null {
    if (!this.valid || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > this.width || y > this.height) return null;
    if (!this.inverse) {
      // Use double precision so large map coordinates keep their accuracy.
      PerformanceConfigurator.SetMatrixPrecision(true);
      const matrix = Matrix.FromArray(this.matrix);
      if (!Number.isFinite(matrix.determinant()) || matrix.determinant() === 0) return null;
      this.inverse = Matrix.Invert(matrix).asArray();
    }
    const nx = x / this.width * 2 - 1, ny = 1 - y / this.height * 2;
    const a = this.transform(this.inverse, nx, ny, -1), b = this.transform(this.inverse, nx, ny, 1);
    if (!a || !b) return null;
    const dz = b[2] - a[2];
    if (Math.abs(dz) < 1e-15) return null;
    const t = -a[2] / dz;
    // Only accept ground between the camera's near and far clipping planes.
    if (t < 0 || t > 1) return null;
    const mx = a[0] + (b[0] - a[0]) * t, my = a[1] + (b[1] - a[1]) * t;
    const p = unmercator([mx, my]);
    return p.every(Number.isFinite) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 85 ? p : null;
  }

  private transform(m: ArrayLike<number>, x: number, y: number, z: number) {
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (!Number.isFinite(w) || Math.abs(w) < 1e-15) return null;
    const p = [
      (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
      (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
      (m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
      w,
    ];
    return p.every(Number.isFinite) ? p : null;
  }
}
