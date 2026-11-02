/**
 * @file tests/CameraFrame.test.ts
 * @brief Test conversions between map and screen coordinates.
 * @author Norman
 * @description Checks that points project back to their original locations, raised objects appear above the ground, and clicks outside the map are rejected.
 */

import { describe, expect, it } from "vitest";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { PerformanceConfigurator } from "@babylonjs/core/Engines/performanceConfigurator";
import { CameraFrame } from "@upsight/map-renderer/rendering/CameraFrame";
import { localFrame, mercator } from "@upsight/map-renderer/geo/math";
import type { Position } from "@upsight/map-renderer/geo/types";

PerformanceConfigurator.SetMatrixPrecision(true);
function camera(center: Position, pitch: number, bearing: number, width = 1000, height = 700) {
  const f = localFrame(center), [mx,my] = mercator(center), k = 1 / f.scale;
  const local = Matrix.FromArray([k,0,0,0, 0,-k,0,0, 0,0,k,0, -mx*k,my*k,0,1]);
  const p = pitch * Math.PI / 180, b = bearing * Math.PI / 180;
  const eye = new Vector3(-Math.sin(b)*300*Math.sin(p), -Math.cos(b)*300*Math.sin(p), 300*Math.cos(p));
  const view = Matrix.LookAtRH(eye, Vector3.Zero(), new Vector3(Math.sin(b),Math.cos(b),0));
  const projection = Matrix.PerspectiveFovRH(Math.PI/3,width/height,0.5,10000);
  const frame = new CameraFrame();
  frame.update(local.multiply(view).multiply(projection).asArray(),width,height);
  return { frame, f };
}

describe("rendered camera coordinate contract", () => {
  it("round trips ground points through perspective at multiple latitudes, pitches, bearings and viewport sizes", () => {
    for (const center of [[103.85,1.28],[2.17,41.39],[151.2,-33.8]] as Position[])
      for (const pitch of [0,40,75]) for (const bearing of [0,90,210]) for (const [w,h] of [[1000,700],[390,844]]) {
        const {frame,f} = camera(center,pitch,bearing,w,h);
        const point = f.unproject(8,12), pixel = frame.project(point)!;
        expect(pixel).not.toBeNull();
        const ground = frame.screenToGround(pixel.x,pixel.y)!;
        expect(ground).not.toBeNull();
        expect(ground[0]).toBeCloseTo(point[0],7);
        expect(ground[1]).toBeCloseTo(point[1],7);
      }
  });
  it("projects the camera target to the centre and elevations above their footprint", () => {
    const {frame} = camera([103.85,1.28],40,0);
    const ground = frame.project([103.85,1.28])!, roof = frame.project([103.85,1.28],30)!;
    expect(ground.x).toBeCloseTo(500,5);
    expect(ground.y).toBeCloseTo(350,5);
    expect(roof.y).toBeLessThan(ground.y);
  });
  it("rejects sky clicks, off-canvas points, invalid matrices and hidden frames", () => {
    const {frame} = camera([103.85,1.28],85,0);
    expect(frame.screenToGround(500,0)).toBeNull();
    expect(frame.screenToGround(-1,300)).toBeNull();
    expect(frame.screenToGround(NaN,300)).toBeNull();
    frame.update(new Array(16).fill(0),1000,700);
    expect(frame.screenToGround(500,350)).toBeNull();
    expect(frame.project([103.85,1.28])).toBeNull();
    frame.update(Matrix.Identity().asArray(),0,0);
    expect(frame.screenToGround(0,0)).toBeNull();
  });
});
