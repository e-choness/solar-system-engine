/** Frames per measurement window: about 0.75 s at 60 fps. */
const WINDOW = 45;
/** Below 26 fps the view is visibly struggling; a steady 30 is left alone. */
const SLOW_MS = 38;
/** Close enough to 60 fps that there is headroom for more pixels. */
const FAST_MS = 20;
const DOWN = 0.85;
const UP = 1.12;

/**
 * Holds a phone at a playable frame rate by trading resolution for speed, as
 * the GPU heats up or the view gets expensive. It judges the median frame, so a
 * one-off stall (a shader compile, a texture upload) never costs any sharpness.
 */
export class ResolutionGovernor {
  scale = 1;
  private readonly samples: number[] = [];
  private fastWindows = 0;
  /** Fast windows required before trying a higher scale; doubles when a try fails. */
  private patience = 4;
  private raisedAt = -1;
  private windows = 0;

  constructor(private readonly floor = 0.6) {}

  reset() {
    this.scale = 1;
    this.samples.length = 0;
    this.fastWindows = 0;
    this.patience = 4;
    this.raisedAt = -1;
    this.windows = 0;
  }

  /** Records one frame's duration; returns the new scale when it changes. */
  sample(frameMs: number): number | null {
    this.samples.push(frameMs);
    if (this.samples.length < WINDOW) return null;
    const median = this.samples.sort((a, b) => a - b)[WINDOW >> 1];
    this.samples.length = 0;
    this.windows++;

    if (median > SLOW_MS && this.scale > this.floor) {
      // Raising the scale just caused this: wait longer before trying again.
      if (this.raisedAt >= 0 && this.windows - this.raisedAt <= 3) this.patience = Math.min(64, this.patience * 2);
      this.raisedAt = -1;
      this.fastWindows = 0;
      this.scale = Math.max(this.floor, this.scale * DOWN);
      return this.scale;
    }
    this.fastWindows = median < FAST_MS ? this.fastWindows + 1 : 0;
    if (this.scale < 1 && this.fastWindows >= this.patience) {
      this.raisedAt = this.windows;
      this.fastWindows = 0;
      this.scale = Math.min(1, this.scale * UP);
      return this.scale;
    }
    return null;
  }
}
