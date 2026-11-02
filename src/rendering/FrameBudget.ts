/**
 * @file src/rendering/FrameBudget.ts
 * @brief Reduce visual detail when preparing frames takes too much CPU time.
 * @author Norman
 * @description Times CPU work per frame and waits for a run of slow or fast samples before changing detail.
 */
export class FrameBudget {
  private samples: number[] = [];
  private cursor = 0;
  private slow = 0;
  private fast = 0;
  reduced = false;
  p95 = 0;
  sample(ms: number) {
    if (!Number.isFinite(ms) || ms < 0) return false;
    this.samples[this.cursor++ % 60] = ms;
    if (this.cursor % 30 !== 0) return false;
    const sorted = [...this.samples].sort((a, b) => a - b);
    this.p95 = sorted[Math.floor((sorted.length - 1) * 0.95)];
    this.slow = this.p95 > 12 ? this.slow + 1 : 0;
    this.fast = this.p95 < 5 ? this.fast + 1 : 0;
    if (!this.reduced && this.slow >= 2) {
      this.reduced = true;
      this.fast = 0;
      return true;
    }
    if (this.reduced && this.fast >= 8) {
      this.reduced = false;
      this.slow = 0;
      return true;
    }
    return false;
  }
}
