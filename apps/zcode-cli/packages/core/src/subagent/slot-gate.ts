// ============================================================
// Sando: parallel-children cap (SANDO-SUBAGENTS.md)
// ============================================================
// At most N children execute at once per subagent port (one port per parent runtime). A call over the
// cap waits FIFO instead of failing; while it waits it feeds the inactivity watchdog, and an abort of
// the parent turn takes it out of the queue. The slot is held around exactly one child execution.

export const DEFAULT_SUBAGENT_MAX_PARALLEL = 2;
const QUEUED_HEARTBEAT_MS = 5_000;

export interface SubagentSlotGate {
  readonly capacity: number;
  /** Children executing now (for tests and diagnostics). */
  active(): number;
  /** Children waiting for a slot. */
  queued(): number;
  run<T>(
    task: () => Promise<T>,
    options?: { signal?: AbortSignal; heartbeat?: () => void },
  ): Promise<T>;
}

export function resolveSubagentMaxParallel(value: number | string | undefined): number {
  const n = typeof value === "string" ? Number(value.trim()) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 ? n : DEFAULT_SUBAGENT_MAX_PARALLEL;
}

export function createSubagentSlotGate(capacity: number): SubagentSlotGate {
  let running = 0;
  const waiters: Array<() => void> = [];

  const release = () => {
    const next = waiters.shift();
    if (next) {
      // The slot passes straight to the next waiter, so `running` stays the same.
      next();
      return;
    }
    running -= 1;
  };

  const acquire = (signal?: AbortSignal, heartbeat?: () => void): Promise<void> => {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (running < capacity) {
      running += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const timer = heartbeat ? setInterval(heartbeat, QUEUED_HEARTBEAT_MS) : undefined;
      const cleanup = () => {
        if (timer) clearInterval(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const grant = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => {
        const index = waiters.indexOf(grant);
        if (index >= 0) waiters.splice(index, 1);
        cleanup();
        reject(abortReason(signal));
      };
      waiters.push(grant);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  };

  return {
    capacity,
    active: () => running,
    queued: () => waiters.length,
    async run(task, options = {}) {
      await acquire(options.signal, options.heartbeat);
      try {
        return await task();
      } finally {
        release();
      }
    },
  };
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new Error("Subagent launch was cancelled while waiting for a free slot");
}
