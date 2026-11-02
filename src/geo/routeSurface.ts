/**
 * @file geo/routeSurface.ts
 * @brief Match a route to mapped road surfaces for display. Its path stays the same.
 * @author Norman
 */
import { distance, localFrame } from "./math.js";
import { ASPHALT_OFFSET, roadBaseHeight } from "./elevations.js";
import { geometry, validateFeature } from "./validation.js";
import type { GeoFeature, Position, RouteData, RouteSurfaceState } from "./types.js";

type XY = readonly [number, number];
type Segment = { a: XY; b: XY; h0: number; h1: number; width: number; hidden: boolean; nodes?: readonly number[] };
const CELL = 50, MATCH_DISTANCE = 6, MAX_SEGMENTS = 100000, MAX_CHECKS = 250000, MAX_POINT_CHECKS = 512, MAX_POINTS = 10000;
const pairKey = (a: number, b: number) => a < b ? `${a}:${b}` : `${b}:${a}`;
const dot = (a: XY, b: XY) => a[0] * b[0] + a[1] * b[1];
const unit = (a: XY, b: XY): XY => {
  const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy) || 1;
  return [dx / length, dy / length];
};

/** Find the stretch of a route edge that runs along a road. A short tunnel or slope
 * can fall between samples taken 10 m apart. */
function corridorOverlap(a: XY, b: XY, s: Segment): readonly [number, number] | undefined {
  const direction = unit(s.a, s.b), edge = unit(a, b);
  if (Math.abs(dot(direction, edge)) < 0.866) return;
  const halfWidth = Math.min(MATCH_DISTANCE, (s.width - 0.8) / 2);
  if (halfWidth < 0) return;
  const length = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
  const start: XY = [a[0] - s.a[0], a[1] - s.a[1]], delta: XY = [b[0] - a[0], b[1] - a[1]];
  let lo = 0, hi = 1;
  for (const [value, change, min, max] of [
    [dot(start, direction), dot(delta, direction), 0, length],
    [start[0] * direction[1] - start[1] * direction[0], delta[0] * direction[1] - delta[1] * direction[0], -halfWidth, halfWidth],
  ]) {
    if (Math.abs(change) < 1e-10) { if (value < min || value > max) return; }
    else {
      const first = (min - value) / change, last = (max - value) / change;
      lo = Math.max(lo, Math.min(first, last)); hi = Math.min(hi, Math.max(first, last));
      if (hi <= lo) return;
    }
  }
  if ((hi - lo) * Math.hypot(delta[0], delta[1]) > 0.01) return [lo, hi];
}

function heightAt(s: Segment, p: XY) {
  const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - s.a[0]) * dx + (p[1] - s.a[1]) * dy) / (dx * dx + dy * dy)));
  return s.h0 + (s.h1 - s.h0) * t;
}

/** Rebuild the index when the road data changes and reuse it as the camera moves.
 * Heights based on OSM layers are estimates. Where roads overlap at different heights,
 * a matching road node pair can identify which road the route follows. */
export class RoadSurfaceIndex {
  private frame: ReturnType<typeof localFrame>;
  private cells = new Map<string, Segment[]>();
  private incomplete = false;
  constructor(roads: readonly GeoFeature[], origin: Position) {
    this.frame = localFrame(origin);
    let count = 0, memberships = 0;
    outer: for (const input of roads) {
      if (input.layer !== "roads" || input.model?.kind !== "road") continue;
      const f = validateFeature(input);
      if (f.geometry.type !== "LineString" || f.model?.road?.footway) continue;
      const points = f.geometry.coordinates.map(this.frame.project);
      const nodes = f.model?.road?.nodeIds;
      for (let i = 1; i < points.length; i++) {
        if (++count > MAX_SEGMENTS) { this.incomplete = true; break outer; }
        const a = points[i - 1], b = points[i];
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.001) continue;
        // Draw the route 0.14 m above the asphalt.
        const height = (n: number) => roadBaseHeight(f, n) + ASPHALT_OFFSET + 0.14;
        const segment: Segment = { a, b, h0: height(i - 1), h1: height(i), width: f.style.width, hidden: f.model?.road?.surfaceHidden === true,
          ...(nodes ? { nodes: [nodes[i - 1], nodes[i]] } : {}) };
        const x0 = Math.floor((Math.min(a[0], b[0]) - MATCH_DISTANCE) / CELL), x1 = Math.floor((Math.max(a[0], b[0]) + MATCH_DISTANCE) / CELL);
        const y0 = Math.floor((Math.min(a[1], b[1]) - MATCH_DISTANCE) / CELL), y1 = Math.floor((Math.max(a[1], b[1]) + MATCH_DISTANCE) / CELL);
        if ((x1 - x0 + 1) * (y1 - y0 + 1) > 256) { this.incomplete = true; continue; }
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
          if (++memberships > 500000) { this.incomplete = true; break outer; }
          const key = `${x}:${y}`, bucket = this.cells.get(key) ?? [];
          bucket.push(segment); this.cells.set(key, bucket);
        }
      }
    }
  }
  resolve(route: RouteData): RouteData {
    if (route.positions.length > MAX_POINTS) throw new Error("Route surface matching supports at most 10,000 points; split longer routes first.");
    geometry({ type: "LineString", coordinates: route.positions });
    if (this.incomplete || (route.nodePairs?.length ?? 0) > 200000) {
      // An unchecked road or node pair could belong to a tunnel or bridge. Hide these edges.
      return { ...route, elevations: undefined, widths: undefined,
        segmentMask: Array.from({ length: route.positions.length - 1 }, () => false),
        segmentStates: Array.from({ length: route.positions.length - 1 }, () => "limited"),
        surfaceMatch: { matched: 0, unknown: route.positions.length, ambiguous: 0, truncated: true } };
    }
    // Keep all original route vertices, including turns.
    let remaining = MAX_POINTS - route.positions.length;
    const lengths = route.positions.slice(1).map((p, i) => distance(route.positions[i], p));
    // Aim for gaps of at most 10 m. Increase the spacing only to stay within the point limit.
    const insertions = (step: number) => lengths.reduce((total, length) => total + Math.max(0, Math.ceil(length / step) - 1), 0);
    let step = 10;
    if (insertions(step) > remaining) {
      let low = step, high = lengths.reduce((longest, length) => Math.max(longest, length), step);
      for (let i = 0; i < 40; i++) {
        const middle = (low + high) / 2;
        if (insertions(middle) > remaining) low = middle; else high = middle;
      }
      step = high;
    }
    const positions: Position[] = [route.positions[0]];
    for (let i = 1; i < route.positions.length; i++) {
      const a = route.positions[i - 1], b = route.positions[i];
      const parts = Math.min(remaining, Math.max(0, Math.ceil(lengths[i - 1] / step) - 1)) + 1;
      for (let j = 1; j < parts; j++) positions.push([a[0] + (b[0] - a[0]) * j / parts, a[1] + (b[1] - a[1]) * j / parts]);
      remaining -= parts - 1;
      positions.push(b);
    }
    const points = positions.map(this.frame.project);
    // Match consecutive route nodes in either order. Vertex order does not determine traffic direction.
    const pairs = new Set((route.nodePairs ?? []).map(([a, b]) => pairKey(a, b)));
    const elevations: number[] = [], widths: number[] = [];
    const states: ("matched" | "hidden" | "unknown" | "ambiguous" | "limited")[] = [];
    const selected: (Segment | undefined)[] = [];
    let checks = 0, matched = 0, ambiguous = 0, unknown = 0, truncated = false;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const directions = [unit(points[Math.max(0, i - 1)], p), unit(p, points[Math.min(points.length - 1, i + 1)])];
      const candidates: { height: number; width: number; distance: number; exact: boolean; score: number; segment: Segment }[] = [];
      const bucket = this.cells.get(`${Math.floor(p[0] / CELL)}:${Math.floor(p[1] / CELL)}`) ?? [];
      // Skip a cell if we cannot check every candidate. An unchecked road could pass above or below this one.
      const limited = bucket.length > MAX_POINT_CHECKS || checks + bucket.length > MAX_CHECKS;
      if (limited) truncated = true;
      for (const s of limited ? [] : bucket) {
        checks++;
        const direction = unit(s.a, s.b), alignment = Math.max(...directions.map(d => Math.abs(dot(d, direction))));
        if (alignment < 0.866) continue; // Ignore roads that cross the route at a steep angle.
        const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1];
        const t = Math.max(0, Math.min(1, ((p[0] - s.a[0]) * dx + (p[1] - s.a[1]) * dy) / (dx * dx + dy * dy)));
        const d = Math.hypot(p[0] - s.a[0] - t * dx, p[1] - s.a[1] - t * dy);
        const width = Math.min(3, s.width - 2 * d - 0.4);
        if (d > MATCH_DISTANCE || width < 0.4) continue;
        const exact = !!s.nodes && pairs.has(pairKey(s.nodes[0], s.nodes[1]));
        candidates.push({ height: s.h0 + (s.h1 - s.h0) * t, width, distance: d, exact, score: d + (1 - alignment) * 2 - (exact ? 10 : 0), segment: s });
      }
      candidates.sort((a, b) => a.score - b.score);
      const best = candidates[0];
      const conflict = best && candidates.some(c => c.exact === best.exact && c.distance <= best.distance + 1.5 && (Math.abs(c.height - best.height) > 1 || c.segment.hidden !== best.segment.hidden));
      if (best && !conflict) {
        elevations.push(best.height); widths.push(best.width); matched++;
        states.push(best.segment.hidden ? "hidden" : "matched"); selected.push(best.segment);
      } else {
        // Use a flat drawing height while the actual height is unknown.
        elevations.push(0.4); widths.push(2.5);
        states.push(limited ? "limited" : conflict ? "ambiguous" : "unknown"); selected.push(undefined);
        if (conflict) ambiguous++; else unknown++;
      }
    }
    const segmentStates: RouteSurfaceState[] = states.slice(1).map((state, i) => {
      const previous = states[i];
      if (state === "limited" || previous === "limited") return "limited";
      if (state === "ambiguous" || previous === "ambiguous") return "ambiguous";
      if (state === "hidden" || previous === "hidden") return "hidden";
      if (state !== previous) return "transition";
      if (state === "unknown") return "unknown";
      if (Math.abs(elevations[i] - elevations[i + 1]) <= 1) return "surface";
      // Bridge a height change over 1 m only if a mapped road segment spans both heights.
      return [selected[i], selected[i + 1]].some(s => s && Math.min(s.h0, s.h1) - 0.25 <= Math.min(elevations[i], elevations[i + 1]) && Math.max(s.h0, s.h1) + 0.25 >= Math.max(elevations[i], elevations[i + 1])) ? "surface" : "transition";
    });
    // Check between samples for hidden roads or changes in height. Hide edges we cannot finish checking.
    const exact = (s: Segment) => !!s.nodes && pairs.has(pairKey(s.nodes[0], s.nodes[1]));
    for (let i = 0; i < segmentStates.length; i++) {
      if (segmentStates[i] !== "surface" && segmentStates[i] !== "unknown") continue;
      const a = points[i], b = points[i + 1];
      const x0 = Math.floor(Math.min(a[0], b[0]) / CELL), x1 = Math.floor(Math.max(a[0], b[0]) / CELL);
      const y0 = Math.floor(Math.min(a[1], b[1]) / CELL), y1 = Math.floor(Math.max(a[1], b[1]) / CELL);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 256) { segmentStates[i] = "limited"; truncated = true; continue; }
      const candidates = new Set<Segment>();
      let limited = false;
      scan: for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const bucket = this.cells.get(`${x}:${y}`) ?? [];
        if (bucket.length > MAX_POINT_CHECKS || checks + bucket.length > MAX_CHECKS) { limited = true; break scan; }
        checks += bucket.length;
        bucket.forEach(s => candidates.add(s));
      }
      if (limited) { segmentStates[i] = "limited"; truncated = true; continue; }
      const spans = Array.from(candidates, s => ({ s, range: corridorOverlap(a, b, s) })).filter(row => row.range !== undefined);
      const someSpan = (predicate: (row: typeof spans[number]) => boolean) => {
        for (const row of spans) {
          if (++checks > MAX_CHECKS) { limited = true; return false; }
          if (predicate(row)) return true;
        }
        return false;
      };
      for (const { s, range } of spans) {
        const t = (range![0] + range![1]) / 2;
        const p: XY = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        const expected = elevations[i] + (elevations[i + 1] - elevations[i]) * t;
        if (!s.hidden && Math.abs(heightAt(s, p) - expected) <= 1) continue;
        // Ignore a competing road only if a route node pair identifies a visible road at this point and height.
        if (!exact(s) && someSpan(other => !other.s.hidden && exact(other.s) && other.range![0] <= t && other.range![1] >= t && Math.abs(heightAt(other.s, p) - expected) <= 1)) continue;
        if (limited) break;
        const competing = someSpan(other => other.s !== s && other.range![0] <= t && other.range![1] >= t && exact(other.s) === exact(s) && (other.s.hidden !== s.hidden || Math.abs(heightAt(other.s, p) - heightAt(s, p)) > 1));
        segmentStates[i] = s.hidden && !competing ? "hidden" : "ambiguous";
        break;
      }
      if (limited) { segmentStates[i] = "limited"; truncated = true; }
    }
    const segmentMask = segmentStates.map(state => state === "surface" || state === "unknown");
    return { ...route, positions, elevations, widths, segmentMask, segmentStates,
      surfaceMatch: { matched, ambiguous, unknown, hidden: states.filter(state => state === "hidden").length, truncated } };
  }
}
