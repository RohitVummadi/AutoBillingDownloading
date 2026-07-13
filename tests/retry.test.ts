import { describe, expect, it, vi } from 'vitest';

import { BATCH_RETRY_DELAYS_MS, retry } from '../src/utils/retry.js';

describe('batch retry policy', () => {
  it('uses one initial attempt and three retries with 2/5/10-second backoffs', async () => {
    const attempts: number[] = [];
    const sleep = vi.fn(async (_milliseconds: number) => undefined);

    const result = await retry(
      async (attempt) => {
        attempts.push(attempt);
        if (attempt < 4) throw new Error('transient');
        return 'downloaded';
      },
      { sleep },
    );

    expect(result).toBe('downloaded');
    expect(attempts).toEqual([1, 2, 3, 4]);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([...BATCH_RETRY_DELAYS_MS]);
  });

  it('rethrows after the fourth failed attempt', async () => {
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const operation = vi.fn(async () => {
      throw new Error('permanent');
    });

    await expect(retry(operation, { sleep })).rejects.toThrow('permanent');
    expect(operation).toHaveBeenCalledTimes(4);
  });
});
