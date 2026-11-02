/**
 * @file tests/MapControls.test.ts
 * @brief Test pointer gestures and control cleanup.
 * @author Norman
 * @description Checks that clicks select features, dragging moves the map, pinching zooms and cleanup removes event listeners.
 */

import { expect, it, vi } from "vitest";
import { MapCamera } from "@upsight/map-renderer/engine/MapCamera";
import { MapControls } from "@upsight/map-renderer/engine/MapControls";
import { InteractionLock } from "@upsight/map-renderer/rendering/InteractionLock";

class Canvas extends EventTarget {
  clientWidth = 800;
  clientHeight = 600;
  focus() {}
  setPointerCapture() {}
  getBoundingClientRect() {
    return { left: 20, top: 40 };
  }
  pointer(type: string, x: number, y: number, id = 1) {
    this.dispatchEvent(
      Object.assign(new Event(type), {
        clientX: x + 20,
        clientY: y + 40,
        pointerId: id,
        button: 0,
        shiftKey: false,
      }),
    );
  }
}
it("distinguishes picking from drag/pinch and releases listeners and editor leases", () => {
  const canvas = new Canvas(),
    camera = new MapCamera([103.85, 1.28]),
    pick = vi.fn();
  camera.resize(800, 600);
  const controls = new MapControls(
    canvas as unknown as HTMLCanvasElement,
    camera,
    pick,
    vi.fn(),
  );
  canvas.pointer("pointerdown", 400, 300);
  canvas.pointer("pointerup", 400, 300);
  expect(pick).toHaveBeenCalledWith(400, 300);
  pick.mockClear();
  const original = camera.state.center;
  canvas.pointer("pointerdown", 400, 300);
  canvas.pointer("pointermove", 500, 300);
  canvas.pointer("pointerup", 500, 300);
  expect(camera.state.center).not.toEqual(original);
  expect(pick).not.toHaveBeenCalled();
  const zoom = camera.state.zoom;
  canvas.pointer("pointerdown", 300, 300, 1);
  canvas.pointer("pointerdown", 500, 300, 2);
  canvas.pointer("pointermove", 600, 300, 2);
  canvas.pointer("pointercancel", 300, 300, 1);
  canvas.pointer("pointerup", 600, 300, 2);
  expect(camera.state.zoom).toBeGreaterThan(zoom);
  expect(pick).not.toHaveBeenCalled();
  const lock = new InteractionLock([controls]),
    a = lock.acquire(),
    b = lock.acquire(),
    version = camera.version;
  a();
  canvas.pointer("pointerdown", 400, 300);
  canvas.pointer("pointermove", 600, 300);
  expect(camera.version).toBe(version);
  b();
  expect(controls.isEnabled()).toBe(true);
  controls.dispose();
  canvas.pointer("pointerdown", 400, 300);
  canvas.pointer("pointermove", 600, 300);
  expect(camera.version).toBe(version);
  lock.dispose();
});
