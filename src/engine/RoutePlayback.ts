/**
 * @file engine/RoutePlayback.ts
 * @brief Move a vehicle along a route using elapsed time.
 * @author Norman
 * @description Use distance along the route to find the vehicle's position between recorded points.
 */

import { bearing, distance } from "../geo/math.js";
import { geometry } from "../geo/validation.js";
import { MIN_LINE_ELEVATION, MAX_LINE_ELEVATION } from "../geo/elevations.js";
import type { Position, RouteData } from "../geo/types.js";

export interface PlaybackState {
  progress: number;
  elapsed: number;
  duration: number;
  playing: boolean;
  speed: number;
  position: Position;
  bearing: number;
  elevation: number;
  /** False where the route segment is hidden, for example at an uncertain change in road level. */
  surfaceVisible: boolean;
}
/** Longer segments take proportionally longer to travel. */
export class RouteSampler {
  readonly positions: readonly Position[];
  readonly cumulative: number[] = [0];
  readonly length: number;
  constructor(positions: readonly Position[], private elevations?: readonly number[], private segmentMask?: readonly boolean[]) {
    const g = geometry({ type: "LineString", coordinates: positions });
    this.positions = g.coordinates as readonly Position[];
    if (elevations && (elevations.length !== this.positions.length || elevations.some(n => !Number.isFinite(n) || n < MIN_LINE_ELEVATION || n > MAX_LINE_ELEVATION)))
      throw new Error("Invalid route elevation profile.");
    if (segmentMask && (segmentMask.length !== this.positions.length - 1 || segmentMask.some(value => typeof value !== "boolean")))
      throw new Error("Invalid route segment mask.");
    for (let i = 1; i < this.positions.length; i++)
      this.cumulative.push(
        this.cumulative[i - 1] +
          distance(this.positions[i - 1], this.positions[i]),
      );
    this.length = this.cumulative.at(-1)!;
    if (this.length < 0.01) throw new Error("Route has no length.");
  }
  sample(progress: number) {
    const target = Math.max(0, Math.min(1, progress)) * this.length;
    let lo = 1,
      hi = this.cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cumulative[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    while (
      lo < this.cumulative.length - 1 &&
      this.cumulative[lo] === this.cumulative[lo - 1]
    )
      lo++;
    const a = this.positions[lo - 1],
      b = this.positions[lo],
      length = this.cumulative[lo] - this.cumulative[lo - 1],
      t = length ? (target - this.cumulative[lo - 1]) / length : 0;
    return {
      position: [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
      ] as Position,
      bearing: bearing(a, b),
      elevation: this.elevations ? this.elevations[lo - 1] + (this.elevations[lo] - this.elevations[lo - 1]) * t : 0.4,
      surfaceVisible: this.segmentMask?.[lo - 1] !== false,
    };
  }
}
export class RoutePlayback {
  private sampler?: RouteSampler;
  private duration = 1;
  private elapsed = 0;
  private playing = false;
  private speed = 1;
  private listeners = new Set<(state: PlaybackState | null) => void>();
  setRoute(route: RouteData, preserveProgress = false) {
    if (!Number.isFinite(route.durationSeconds) || route.durationSeconds <= 0)
      throw new Error("Invalid route duration.");
    const progress = preserveProgress ? this.elapsed / this.duration : 0;
    this.sampler = new RouteSampler(route.positions, route.elevations, route.segmentMask);
    this.duration = route.durationSeconds;
    this.elapsed = progress * this.duration;
    if (!preserveProgress) this.playing = false;
    this.emit();
  }
  clear() {
    if (!this.sampler) return;
    this.sampler = undefined;
    this.elapsed = 0;
    this.playing = false;
    for (const listener of this.listeners) listener(null);
  }
  get state(): PlaybackState | null {
    return this.sampler
      ? {
          ...this.sampler.sample(this.elapsed / this.duration),
          progress: this.elapsed / this.duration,
          elapsed: this.elapsed,
          duration: this.duration,
          playing: this.playing,
          speed: this.speed,
        }
      : null;
  }
  /** Listeners receive null when the route is cleared, so they can hide the vehicle. */
  subscribe(fn: (state: PlaybackState | null) => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  private emit() {
    const s = this.state;
    if (s) for (const fn of this.listeners) fn(s);
  }
  play() {
    if (!this.sampler) return;
    if (this.elapsed >= this.duration) this.elapsed = 0;
    this.playing = true;
    this.emit();
  }
  pause() {
    this.playing = false;
    this.emit();
  }
  seek(progress: number) {
    if (!Number.isFinite(progress)) throw new Error("Invalid progress.");
    this.elapsed = Math.max(0, Math.min(1, progress)) * this.duration;
    if (this.elapsed >= this.duration) this.playing = false;
    this.emit();
  }
  setSpeed(speed: number) {
    if (!Number.isFinite(speed) || speed < 0.25 || speed > 100)
      throw new Error("Speed must be 0.25–100x.");
    this.speed = speed;
    this.emit();
  }
  tick(seconds: number) {
    if (!this.playing || !Number.isFinite(seconds) || seconds <= 0) return;
    this.elapsed = Math.min(this.duration, this.elapsed + seconds * this.speed);
    if (this.elapsed === this.duration) this.playing = false;
    this.emit();
  }
  ahead(metres: number) {
    return this.sampler?.sample(
      this.elapsed / this.duration + metres / this.sampler.length,
    );
  }
}
