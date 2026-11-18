/**
 * Per-provider concurrency limiter (semaphore) so a burst of UI requests can
 * never stampede an external API with unbounded parallel calls.
 */

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

class Semaphore {
  private active = 0;
  private waiters: Waiter[] = [];

  constructor(private limit: number) {}

  get activeCount(): number {
    return this.active;
  }

  get queueLength(): number {
    return this.waiters.length;
  }

  async acquire(timeoutMs: number): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new Error("queue wait timeout"));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
    this.active++;
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve();
    }
  }
}

const semaphores = new Map<string, Semaphore>();

function semaphoreFor(name: string, limit: number): Semaphore {
  let s = semaphores.get(name);
  if (!s) {
    s = new Semaphore(limit);
    semaphores.set(name, s);
  }
  return s;
}

export interface QueueStats {
  active: number;
  queued: number;
}

/** Run `fn` while holding a slot for `name` (max `limit` concurrent). */
export async function withSlot<T>(
  name: string,
  limit: number,
  timeoutMs: number,
  fn: () => Promise<T>
): Promise<T> {
  const sem = semaphoreFor(name, limit);
  await sem.acquire(timeoutMs);
  try {
    return await fn();
  } finally {
    sem.release();
  }
}

export function queueStats(name: string): QueueStats | undefined {
  const s = semaphores.get(name);
  if (!s) return undefined;
  return { active: s.activeCount, queued: s.queueLength };
}
