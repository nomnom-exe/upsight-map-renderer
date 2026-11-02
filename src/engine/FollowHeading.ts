/**
 * @file engine/FollowHeading.ts
 * @brief Turn the camera smoothly using the elapsed time between frames.
 * @author Norman
 */
export class FollowHeading {
  private value?: number;
  private last?: number;
  reset() { this.value = undefined; this.last = undefined; }
  sample(target: number, now: number) {
    if (!Number.isFinite(target) || !Number.isFinite(now)) throw new Error("Invalid camera sample.");
    const dt = this.last === undefined ? Infinity : (now - this.last) / 1000;
    if (this.value === undefined || dt < 0 || dt > 0.5) this.value = target;
    else {
      const delta = ((target - this.value + 540) % 360 + 360) % 360 - 180;
      this.value += delta * -Math.expm1(-dt / 0.12);
    }
    this.last = now;
    return (this.value % 360 + 360) % 360;
  }
}
