/**
 * @file tests/MapCamera.test.ts
 * @brief Test how the map camera projects points and responds to navigation.
 * @author Norman
 * @description Checks orientation, zoom around a fixed point, fitting an area on screen and finding the ground in first-person view.
 */

import { describe, expect, it } from "vitest";
import { MapCamera } from "@upsight/map-renderer/engine/MapCamera";
import { localFrame } from "@upsight/map-renderer/geo/math";
import type { Position } from "@upsight/map-renderer/geo/types";

describe("owned geographic camera", () => {
  it("keeps its view and projection stable when caller coordinates change", () => {
    const center: [number, number] = [103.852, 1.287];
    const camera = new MapCamera(center);
    camera.resize(1000, 600);
    const initial = camera.state;
    const matrix = [...camera.transform.asArray()];

    center[0] += 0.1;
    expect(camera.state).toEqual(initial);
    expect(camera.snapshot().center).toEqual(initial.center);
    expect([...camera.transform.asArray()]).toEqual(matrix);
    expect(camera.project(camera.state.center)!.x).toBeCloseTo(500, 3);

    const driver: [number, number] = [103.86, 1.29];
    camera.firstPerson(driver, 30, 5);
    const following = camera.state;
    const ground = camera.screenToGround(500, 500);
    driver[1] += 0.1;
    expect(camera.state).toEqual(following);
    expect(camera.snapshot().center).toEqual(following.center);
    expect(camera.screenToGround(500, 500)).toEqual(ground);

    camera.firstPerson(driver, 30, 5);
    expect(camera.state.center).toEqual(driver);
  });
  it.each([
    [103.852, 1.287],
    [2.17, 41.38],
    [-73.98, 40.75],
  ] as Position[])(
    "round trips in city %s,%s across camera poses",
    (lon, lat) => {
      const camera = new MapCamera([lon, lat]);
      camera.resize(1000, 600, 2);
      for (const pitch of [0, 40, 65])
        for (const bearing of [0, 90, -145]) {
          camera.setView({ pitch, bearing, zoom: 17 });
          const p = localFrame([lon, lat]).unproject(10, 20),
            screen = camera.project(p)!;
          const ground = camera.screenToGround(screen.x, screen.y)!;
          expect(ground[0]).toBeCloseTo(p[0], 7);
          expect(ground[1]).toBeCloseTo(p[1], 7);
          const center = camera.project([lon, lat])!;
          expect(center.x).toBeCloseTo(500, 3);
          expect(center.y).toBeCloseTo(300, 3);
        }
    },
  );
  it("points north up and east right, then keeps the zoom anchor and dragged point fixed", () => {
    const c = new MapCamera([103.852, 1.287]);
    c.resize(1000, 600);
    c.setView({ pitch: 0, bearing: 0 });
    const f = localFrame(c.state.center);
    expect(c.project(f.unproject(100, 0))!.x).toBeGreaterThan(500);
    expect(c.project(f.unproject(0, 100))!.y).toBeLessThan(300);
    const anchor = c.screenToGround(650, 400)!;
    c.zoomAt(1, 650, 400);
    expect(c.project(anchor)!.x).toBeCloseTo(650, 2);
    expect(c.project(anchor)!.y).toBeCloseTo(400, 2);
    c.pan(650, 400, 700, 450);
    expect(c.project(anchor)!.x).toBeCloseTo(700, 1);
    expect(c.project(anchor)!.y).toBeCloseTo(450, 1);
  });
  it("supports a first-person horizon without allowing placement in the sky", () => {
    const c = new MapCamera([103.852, 1.287]);
    c.resize(1000, 600);
    c.firstPerson(c.state.center, 0);
    expect(c.screenToGround(500, 100)).toBeNull();
    expect(c.screenToGround(500, 500)).not.toBeNull();
    const front = localFrame(c.state.center).unproject(0, 20);
    expect(c.project(front)!.x).toBeCloseTo(500, 2);
    expect(c.project(front)!.y).toBeGreaterThan(300);
    expect(c.project(localFrame(c.state.center).unproject(0, -20))).toBeNull();
  });
  it("fits bounds and rejects invalid inputs without corrupting the camera", () => {
    const c = new MapCamera([103.852, 1.287]);
    c.resize(1000, 600);
    c.fitBounds({ west: 103.84, east: 103.86, south: 1.28, north: 1.3 });
    for (const p of [
      [103.84, 1.28],
      [103.86, 1.3],
    ] as Position[]) {
      const screen = c.project(p)!;
      expect(screen.x).toBeGreaterThan(0);
      expect(screen.x).toBeLessThan(1000);
      expect(screen.y).toBeGreaterThan(0);
      expect(screen.y).toBeLessThan(600);
    }
    const version = c.version;
    c.setView({ zoom: NaN });
    c.resize(0, 0);
    c.resize(100, 100, -1);
    c.firstPerson([NaN, 0], 0);
    expect(c.version).toBe(version);
    expect(() => new MapCamera([0, 90])).toThrow();
  });
});
