/**
 * @file src/engine/MapControls.ts
 * @brief Handle mouse, touch, and keyboard controls for the standalone map.
 * @author Norman
 * @description The editor can pause these controls while the user moves an object.
 */

import type { CameraView } from "./CameraView.js";

export class MapControls {
  private enabled = true;
  private pointers = new Map<number, { x: number; y: number }>();
  private start = { x: 0, y: 0 };
  private moved = false;
  private rotating = false;
  private abort = new AbortController();
  constructor(
    private canvas: HTMLCanvasElement,
    private camera: CameraView,
    private pick: (x: number, y: number) => void,
    private interact: () => void,
  ) {
    const signal = this.abort.signal;
    canvas.addEventListener("pointerdown", this.down, { signal });
    canvas.addEventListener("pointermove", this.move, { signal });
    canvas.addEventListener("pointerup", this.up, { signal });
    canvas.addEventListener("pointercancel", this.cancel, { signal });
    canvas.addEventListener("lostpointercapture", this.cancel, { signal });
    canvas.addEventListener("wheel", this.wheel, { passive: false, signal });
    canvas.addEventListener("keydown", this.key, { signal });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault(), {
      signal,
    });
  }
  isEnabled = () => this.enabled;
  enable = () => {
    this.enabled = true;
  };
  disable = () => {
    this.enabled = false;
    this.pointers.clear();
  };
  private point(e: MouseEvent) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  private down = (e: PointerEvent) => {
    if (!this.enabled || (e.button !== 0 && e.button !== 2)) return;
    this.interact();
    this.canvas.focus({ preventScroll: true });
    const p = this.point(e);
    if (!this.pointers.size) {
      this.start = p;
      this.moved = false;
      this.rotating = e.button === 2 || e.shiftKey;
    } else this.moved = true;
    this.pointers.set(e.pointerId, p);
    this.canvas.setPointerCapture(e.pointerId);
  };
  private move = (e: PointerEvent) => {
    const old = this.pointers.get(e.pointerId);
    if (!this.enabled || !old) return;
    const next = this.point(e),
      before = [...this.pointers.values()];
    this.pointers.set(e.pointerId, next);
    if (Math.hypot(next.x - this.start.x, next.y - this.start.y) > 4)
      this.moved = true;
    const after = [...this.pointers.values()];
    if (after.length === 2) {
      const middle = (p: typeof before) => ({
        x: (p[0].x + p[1].x) / 2,
        y: (p[0].y + p[1].y) / 2,
      });
      const a = middle(before),
        b = middle(after);
      this.camera.pan(a.x, a.y, b.x, b.y);
      const length = (p: typeof before) =>
        Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
      if (length(before) > 5 && length(after) > 5)
        this.camera.zoomAt(Math.log2(length(after) / length(before)), b.x, b.y);
    } else if (this.rotating) {
      const v = this.camera.state;
      this.camera.setView({
        bearing: v.bearing - (next.x - old.x) * 0.35,
        pitch: v.pitch + (next.y - old.y) * 0.25,
      });
    } else this.camera.pan(old.x, old.y, next.x, next.y);
  };
  private up = (e: PointerEvent) => {
    if (!this.pointers.has(e.pointerId)) return;
    const p = this.point(e);
    if (!this.moved && !this.rotating && this.enabled) this.pick(p.x, p.y);
    this.cancel(e);
  };
  private cancel = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
  };
  private wheel = (e: WheelEvent) => {
    if (!this.enabled) return;
    e.preventDefault();
    this.interact();
    const p = this.point(e),
      units =
        e.deltaMode === 1
          ? 16
          : e.deltaMode === 2
            ? this.canvas.clientHeight
            : 1;
    this.camera.zoomAt(
      Math.max(-1, Math.min(1, -e.deltaY * units * 0.002)),
      p.x,
      p.y,
    );
  };
  private key = (e: KeyboardEvent) => {
    if (
      !this.enabled ||
      ![
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "+",
        "=",
        "-",
        "Home",
      ].includes(e.key)
    )
      return;
    e.preventDefault();
    this.interact();
    const x = this.canvas.clientWidth / 2,
      y = this.canvas.clientHeight / 2;
    if (e.key === "Home") this.camera.setView({ pitch: 0, bearing: 0 });
    else if (["+", "=", "-"].includes(e.key))
      this.camera.zoomAt(e.key === "-" ? -0.5 : 0.5);
    else
      this.camera.pan(
        x,
        y,
        x + (e.key === "ArrowLeft" ? 50 : e.key === "ArrowRight" ? -50 : 0),
        y + (e.key === "ArrowUp" ? 50 : e.key === "ArrowDown" ? -50 : 0),
      );
  };
  dispose() {
    this.abort.abort();
    this.pointers.clear();
  }
}
