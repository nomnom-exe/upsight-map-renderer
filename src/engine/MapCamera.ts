/**
 * @file src/engine/MapCamera.ts
 * @brief Control the map camera without MapLibre.
 * @author Norman
 * @description Use Babylon matrices to convert between map coordinates and screen pixels.
 */

import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { PerformanceConfigurator } from "@babylonjs/core/Engines/performanceConfigurator.js";
import {
  CIRCUMFERENCE,
  extentOf,
  localFrame,
  mercator,
  RAD,
  unmercator,
} from "../geo/math.js";
import type { Extent, Position } from "../geo/types.js";
import type { ViewportSnapshot } from "../geo/Viewport.js";
import { CameraFrame } from "../rendering/CameraFrame.js";
import type { CameraView, MapView } from "./CameraView.js";

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

export class MapCamera implements CameraView {
  private view: MapView;
  private width = 1;
  private height = 1;
  private ratio = 1;
  private eyeHeight: number | null = null;
  private coordinates = new CameraFrame();
  private listeners = new Set<() => void>();
  private matrix = Matrix.Identity();
  private revision = 0;
  constructor(center: Position) {
    PerformanceConfigurator.SetMatrixPrecision(true);
    if (
      !center.every(Number.isFinite) ||
      Math.abs(center[0]) > 180 ||
      Math.abs(center[1]) > 85
    )
      throw new Error("Invalid map center.");
    this.view = { center, zoom: 15.8, pitch: 40, bearing: -17 };
    this.update();
  }
  get state(): MapView {
    return { ...this.view, center: [...this.view.center] };
  }
  get transform() {
    return this.matrix;
  }
  get version() {
    return this.revision;
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  resize(width: number, height: number, ratio = 1) {
    if (
      width <= 0 ||
      height <= 0 ||
      ratio <= 0 ||
      ![width, height, ratio].every(Number.isFinite)
    )
      return;
    if (width === this.width && height === this.height && ratio === this.ratio)
      return;
    this.width = width;
    this.height = height;
    this.ratio = ratio;
    this.update();
  }
  setView(next: Partial<MapView>) {
    const v = { ...this.view, ...next };
    if (![...v.center, v.zoom, v.pitch, v.bearing].every(Number.isFinite))
      return;
    this.eyeHeight = null;
    this.view = {
      center: [clamp(v.center[0], -180, 180), clamp(v.center[1], -85, 85)],
      zoom: clamp(v.zoom, 8, 21),
      pitch: clamp(v.pitch, 0, 80),
      bearing: ((((v.bearing + 180) % 360) + 360) % 360) - 180,
    };
    this.update();
  }
  firstPerson(center: Position, bearing: number, surfaceElevation = 0) {
    if (
      ![...center, bearing, surfaceElevation].every(Number.isFinite) ||
      Math.abs(center[0]) > 180 ||
      Math.abs(center[1]) > 85
    )
      return;
    this.view = { center, zoom: 19, pitch: 90, bearing };
    this.eyeHeight = Math.max(-1000, Math.min(1000, surfaceElevation)) + 1.8;
    this.update();
  }
  project = (p: Position, elevation = 0) =>
    this.coordinates.project(p, elevation);
  screenToGround = (x: number, y: number) =>
    this.coordinates.screenToGround(x, y);
  private get metresPerPixel() {
    return (
      (CIRCUMFERENCE * Math.cos(this.view.center[1] * RAD)) /
      (512 * 2 ** this.view.zoom)
    );
  }
  private shift(from: Position, to: Position) {
    const a = mercator(from),
      b = mercator(to),
      c = mercator(this.view.center);
    this.setView({
      center: unmercator([c[0] + a[0] - b[0], c[1] + a[1] - b[1]]),
    });
  }
  pan(fromX: number, fromY: number, toX: number, toY: number) {
    const a = this.screenToGround(fromX, fromY),
      b = this.screenToGround(toX, toY);
    if (a && b) this.shift(a, b);
    else {
      const f = localFrame(this.view.center),
        r = this.view.bearing * RAD;
      const x = (fromX - toX) * this.metresPerPixel,
        z = (toY - fromY) * this.metresPerPixel;
      this.setView({
        center: f.unproject(
          x * Math.cos(r) + z * Math.sin(r),
          -x * Math.sin(r) + z * Math.cos(r),
        ),
      });
    }
  }
  zoomAt(delta: number, x = this.width / 2, y = this.height / 2) {
    const before = this.screenToGround(x, y);
    this.setView({ zoom: this.view.zoom + delta });
    const after = this.screenToGround(x, y);
    if (before && after) this.shift(before, after);
  }
  fitBounds(bounds: Extent) {
    const center: Position = [
      (bounds.west + bounds.east) / 2,
      (bounds.south + bounds.north) / 2,
    ];
    const size = localFrame(center).project([bounds.east, bounds.north]);
    const mpp = Math.max(
      1,
      (Math.abs(size[0]) * 2) / Math.max(1, this.width - 100),
      (Math.abs(size[1]) * 2) / Math.max(1, this.height - 200),
    );
    this.setView({
      center,
      zoom: Math.log2(
        (CIRCUMFERENCE * Math.cos(center[1] * RAD)) / (512 * mpp),
      ),
      pitch: 0,
      bearing: 0,
    });
  }
  snapshot(): ViewportSnapshot {
    const groundCorners = [
      [0, 0],
      [this.width, 0],
      [this.width, this.height],
      [0, this.height],
    ].map(([x, y]) => this.screenToGround(x, y));
    const f = localFrame(this.view.center);
    // Near the horizon, a corner can hit the ground far away. Limit each map axis to 5 km from the centre.
    const points = groundCorners
      .filter((p): p is Position => Boolean(p))
      .map((p) => {
        const [x, z] = f.project(p);
        return f.unproject(clamp(x, -5000, 5000), clamp(z, -5000, 5000));
      });
    points.push(f.unproject(-250, -250), f.unproject(250, 250));
    // If a corner points above the horizon, the remaining ground hits can miss part of the view.
    if (groundCorners.some((p) => p === null)) {
      points.push(f.unproject(-5000, -5000), f.unproject(5000, 5000));
    }
    return {
      ...this.state,
      width: this.width,
      height: this.height,
      pixelRatio: this.ratio,
      bounds: extentOf(points),
      groundCorners,
    };
  }
  private update() {
    const { center, pitch, bearing } = this.view,
      f = localFrame(center),
      k = 1 / f.scale;
    // Convert Mercator axes (east, south, up) to local metres (east, up, north).
    const local = Matrix.FromArray([
      k,
      0,
      0,
      0,
      0,
      0,
      -k,
      0,
      0,
      k,
      0,
      0,
      -f.anchor[0] * k,
      0,
      f.anchor[1] * k,
      1,
    ]);
    const b = bearing * RAD,
      p = pitch * RAD,
      fov = Math.PI / 3;
    const range = (this.height * this.metresPerPixel) / (2 * Math.tan(fov / 2));
    const eye =
      this.eyeHeight === null
        ? new Vector3(
            -Math.sin(b) * Math.sin(p) * range,
            Math.cos(p) * range,
            -Math.cos(b) * Math.sin(p) * range,
          )
        : new Vector3(0, this.eyeHeight, 0);
    const target =
      this.eyeHeight === null
        ? Vector3.Zero()
        : new Vector3(Math.sin(b) * 25, this.eyeHeight, Math.cos(b) * 25);
    const up = new Vector3(
      Math.sin(b) * Math.cos(p),
      Math.sin(p),
      Math.cos(b) * Math.cos(p),
    );
    this.matrix = local
      .multiply(Matrix.LookAtLH(eye, target, up))
      .multiply(
        Matrix.PerspectiveFovLH(
          fov,
          this.width / this.height,
          this.eyeHeight === null ? Math.max(0.5, range / 2000) : 0.1,
          Math.max(20000, range * 4),
        ),
      );
    this.coordinates.update(this.matrix.asArray(), this.width, this.height);
    this.revision++;
    for (const listener of this.listeners) listener();
  }
}
