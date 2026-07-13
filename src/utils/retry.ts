export const BATCH_RETRY_DELAYS_MS = [2_000, 5_000, 10_000] as const;

export interface RetryContext {
  failedAttempt: number;
  nextAttempt: number;
  delayMs: number;
  error: unknown;
}

export interface RetryOptions {
  delaysMs?: readonly number[];
  onRetry?: (context: RetryContext) => void | Promise<void>;
  sleep?: (milliseconds: number) => Promise<void>;
}

export async function retry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const delays = options.delaysMs ?? BATCH_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? delay;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      const delayMs = delays[attempt - 1];
      if (delayMs === undefined) {
        throw error;
      }

      await options.onRetry?.({
        failedAttempt: attempt,
        nextAttempt: attempt + 1,
        delayMs,
        error,
      });
      await sleep(delayMs);
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
