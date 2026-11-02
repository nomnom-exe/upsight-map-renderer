/**
 * @file src/rendering/InteractionLock.ts
 * @brief Pause map gestures while editor tools use them.
 * @author Norman
 * @description Restores previously enabled gestures after the last tool releases its lock.
 */

interface Gesture {
  isEnabled(): boolean;
  disable(): void;
  enable(): void;
}
/** Count active locks so one tool can finish while another still needs gestures paused. */
export class InteractionLock {
  private count = 0;
  private restore: Gesture[] = [];
  private disposed = false;
  constructor(private gestures: readonly Gesture[]) {}
  acquire = () => {
    if (this.disposed) return () => {};
    if (this.count++ === 0) {
      this.restore = this.gestures.filter((g) => g.isEnabled());
      for (const g of this.restore) g.disable();
    }
    let released = false;
    return () => {
      if (released || this.disposed) return;
      released = true;
      if (--this.count === 0) {
        for (const g of this.restore) g.enable();
        this.restore = [];
      }
    };
  };
  dispose() {
    if (this.disposed) return;
    for (const g of this.restore) g.enable();
    this.restore = [];
    this.count = 0;
    this.disposed = true;
  }
}
