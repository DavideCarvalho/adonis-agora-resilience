export interface Clock {
  now(): number;
  setTimer(ms: number, cb: () => void): () => void;
  /**
   * Resolves after `ms`, or rejects with `signal.reason` when `signal` aborts first.
   * The abort listener is removed once the delay settles, so repeated delays on one
   * long-lived signal (e.g. retry attempts) do not accumulate listeners.
   */
  delay(ms: number, signal?: AbortSignal): Promise<void>;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
  setTimer(ms: number, cb: () => void): () => void {
    const t = setTimeout(cb, ms);
    return () => clearTimeout(t);
  }
  delay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error('aborted'));
        return;
      }
      const onAbort = () => {
        cancel();
        reject(signal?.reason ?? new Error('aborted'));
      };
      const cancel = this.setTimer(ms, () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      });
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

export const systemClock: Clock = new SystemClock();

interface FakeTimer {
  at: number;
  cb: () => void;
  id: number;
}

export class FakeClock implements Clock {
  private t = 0;
  private seq = 0;
  private timers: FakeTimer[] = [];

  now(): number {
    return this.t;
  }
  setTimer(ms: number, cb: () => void): () => void {
    const id = ++this.seq;
    this.timers.push({ at: this.t + ms, cb, id });
    return () => {
      this.timers = this.timers.filter((x) => x.id !== id);
    };
  }
  delay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error('aborted'));
        return;
      }
      const onAbort = () => {
        cancel();
        reject(signal?.reason ?? new Error('aborted'));
      };
      const cancel = this.setTimer(ms, () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      });
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  /** Advance virtual time, firing any timers that come due (in order). */
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      const due = this.timers.filter((x) => x.at <= target).sort((a, b) => a.at - b.at);
      const next = due[0];
      if (next === undefined) break;
      this.timers = this.timers.filter((x) => x.id !== next.id);
      this.t = next.at;
      next.cb();
    }
    this.t = target;
  }
}
