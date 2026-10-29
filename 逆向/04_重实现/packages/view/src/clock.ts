/**
 * Clocks. The view layer is full of 500 ms / 1200 ms / 10 s / 35 s timers; tests need to
 * drive them without waiting, so every module takes a `Clock` instead of calling globals.
 */

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(handle: number): void;
  setInterval(fn: () => void, ms: number): number;
  clearInterval(handle: number): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clearTimeout: (handle) => clearTimeout(handle as unknown as NodeJS.Timeout),
  setInterval: (fn, ms) => setInterval(fn, ms) as unknown as number,
  clearInterval: (handle) => clearInterval(handle as unknown as NodeJS.Timeout),
};

interface Timer {
  handle: number;
  at: number;
  fn: () => void;
  interval?: number;
  cleared: boolean;
}

/**
 * Deterministic clock: `advance(ms)` runs the timers that are due, in order (ties by handle).
 * `pending()` lists what is still armed, which is how the tests assert the original's exact
 * timer budget (e.g. "connection loader hides itself after 1200 ms, 30 s as a backstop").
 */
export class FakeClock implements Clock {
  private current: number;
  private nextHandle = 1;
  private timers = new Map<number, Timer>();

  constructor(start = 0) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  setTimeout(fn: () => void, ms: number): number {
    const handle = this.nextHandle++;
    this.timers.set(handle, { handle, at: this.current + ms, fn, cleared: false });
    return handle;
  }

  clearTimeout(handle: number): void {
    this.timers.delete(handle);
  }

  setInterval(fn: () => void, ms: number): number {
    const handle = this.nextHandle++;
    this.timers.set(handle, { handle, at: this.current + ms, fn, interval: ms, cleared: false });
    return handle;
  }

  clearInterval(handle: number): void {
    this.timers.delete(handle);
  }

  /** Run every timer due within `ms`, then move the clock forward. */
  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      const due = [...this.timers.values()]
        .filter((timer) => !timer.cleared && timer.at <= target)
        .sort((a, b) => (a.at === b.at ? a.handle - b.handle : a.at - b.at));
      if (!due.length) break;
      const timer = due[0];
      this.current = Math.max(this.current, timer.at);
      if (timer.interval === undefined) this.timers.delete(timer.handle);
      else timer.at = this.current + timer.interval;
      timer.fn();
    }
    this.current = target;
  }

  pending(): Array<{ handle: number; at: number; delay: number; repeats: boolean }> {
    return [...this.timers.values()]
      .filter((timer) => !timer.cleared)
      .sort((a, b) => a.at - b.at)
      .map((timer) => ({
        handle: timer.handle,
        at: timer.at,
        delay: timer.at - this.current,
        repeats: timer.interval !== undefined,
      }));
  }
}
