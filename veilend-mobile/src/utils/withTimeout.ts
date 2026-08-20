/**
 * Races `promise` against a timer. If `promise` hasn't settled within `ms`
 * milliseconds, the returned promise rejects with a `TimeoutError` instead
 * of hanging forever — protects callers from a stalled backend (RPC stall,
 * DB lock contention) leaving them stuck with no way out (issue #344).
 *
 * The underlying `promise` is not cancelled by this alone: callers that can
 * cancel their own work (e.g. an axios request via `AbortController`) should
 * do so when this rejects, otherwise the original request keeps running in
 * the background even though its result is no longer awaited.
 */
export class TimeoutError extends Error {
  constructor(ms: number, label?: string) {
    super(`Request timed out after ${ms}ms${label ? `: ${label}` : ''}`);
    this.name = 'TimeoutError';
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label?: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(ms, label));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
