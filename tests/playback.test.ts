/**
 * @file tests/playback.test.ts
 * @brief Test distance-based route playback.
 * @author Norman
 * @description Checks routes with segments of different lengths, consistent playback across frame rates, pausing, resuming, replay and invalid inputs.
 */

import { expect, it } from "vitest";
import { RoutePlayback, RouteSampler } from "../src/engine/RoutePlayback";
const positions = [
  [2, 41],
  [2.001, 41],
  [2.01, 41],
] as const;
it("samples by distance rather than coordinate index", () => {
  const s = new RouteSampler(positions);
  expect(s.sample(0.5).position[0]).toBeCloseTo(2.005, 5);
  expect(s.sample(1).position).toEqual(positions[2]);
});
it("notifies subscribers once when a route clears, then accepts a new route", () => {
  const playback = new RoutePlayback();
  const progress: (number | null)[] = [];
  const off = playback.subscribe(state => progress.push(state?.progress ?? null));
  const route = { positions, durationSeconds: 10, distanceMetres: 840, source: "test" };
  playback.setRoute(route);
  playback.seek(0.5);
  playback.clear();
  playback.clear();
  playback.setRoute(route);
  off();
  playback.clear();
  expect(progress).toEqual([0, 0.5, null, 0]);
});
it("is independent of frame count and handles pause, seek, speed, end and replay", () => {
  const a = new RoutePlayback(),
    b = new RoutePlayback(),
    route = {
      positions,
      durationSeconds: 10,
      distanceMetres: 840,
      source: "test",
    };
  a.setRoute(route);
  b.setRoute(route);
  a.play();
  b.play();
  a.tick(2);
  for (let i = 0; i < 120; i++) b.tick(1 / 60);
  expect(a.state!.progress).toBeCloseTo(b.state!.progress, 8);
  a.pause();
  a.tick(5);
  expect(a.state!.progress).toBe(0.2);
  a.play();
  a.tick(1);
  expect(a.state!.progress).toBe(0.3);
  a.seek(0.5);
  a.setSpeed(5);
  a.play();
  a.tick(2);
  expect(a.state!.progress).toBe(1);
  expect(a.state!.playing).toBe(false);
  a.play();
  expect(a.state!.progress).toBe(0);
  a.clear();
  expect(a.state).toBeNull();
});
it("skips duplicate route points and validates inputs", () => {
  const s = new RouteSampler([
    [2, 41],
    [2, 41],
    [2.01, 41],
  ]);
  expect(s.sample(0).bearing).toBeCloseTo(90, 1);
  expect(
    () =>
      new RouteSampler([
        [2, 41],
        [2, 41],
      ]),
  ).toThrow();
  expect(() => new RoutePlayback().setSpeed(NaN)).toThrow();
});
it("interpolates road elevation by travelled distance, including duplicate vertices", () => {
  const sampler = new RouteSampler(positions, [0.4, 1.4, 10.4]);
  expect(sampler.sample(0.5).elevation).toBeCloseTo(5.4, 4);
  expect(sampler.sample(1).elevation).toBe(10.4);
  const repeated = new RouteSampler([positions[0], positions[0], positions[2]], [0.4, 0.4, 10.4]);
  expect(repeated.sample(0).elevation).toBe(0.4);
  expect(repeated.sample(0.5).elevation).toBeCloseTo(5.4, 4);
  expect(() => new RouteSampler(positions, [0.4])).toThrow();
  expect(() => new RouteSampler(positions, [0.4, NaN, 5])).toThrow();
});
it("keeps playback progress while replacing a road surface profile", () => {
  const playback = new RoutePlayback();
  const route = { positions, durationSeconds: 10, distanceMetres: 840, source: "test" };
  playback.setRoute(route); playback.play(); playback.tick(5);
  playback.setRoute({ ...route, elevations: [5.4, 5.4, 5.4] }, true);
  expect(playback.state).toMatchObject({ playing: true, progress: 0.5, elevation: 5.4 });
  expect(playback.ahead(20)?.elevation).toBe(5.4);
});
it("copies surface profiles so caller edits cannot change active playback", () => {
  const elevations = [2, 4, 6], segmentMask = [true, false];
  const route = { positions, elevations, segmentMask, durationSeconds: 10, distanceMetres: 840, source: "test" };
  const playback = new RoutePlayback();
  playback.setRoute(route);
  const initial = playback.state;
  const ahead = playback.ahead(20);
  playback.seek(0.5);
  const midpoint = playback.state;

  elevations[0] = NaN;
  elevations[1] = 100;
  segmentMask.reverse();
  expect(playback.state).toEqual(midpoint);
  playback.seek(0);
  expect(playback.state).toEqual(initial);
  expect(playback.ahead(20)).toEqual(ahead);

  elevations[0] = 10;
  playback.setRoute(route);
  expect(playback.state).toMatchObject({ elevation: 10, surfaceVisible: false });
});
it("marks a masked grade transition invisible throughout playback and look-ahead", () => {
  const route = { positions, elevations: [0.4, 5.4, 5.4], segmentMask: [false, true],
    durationSeconds: 10, distanceMetres: 840, source: "test" };
  const playback = new RoutePlayback();
  playback.setRoute(route);
  expect(playback.state!.surfaceVisible).toBe(false);
  expect(playback.ahead(20)?.surfaceVisible).toBe(false);
  playback.seek(0.5);
  expect(playback.state!.surfaceVisible).toBe(true);
  expect(playback.state!.elevation).toBe(5.4);
  expect(() => new RouteSampler(positions, undefined, [false])).toThrow(/mask/);
});
