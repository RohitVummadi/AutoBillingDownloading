import type { Bill } from '../types/Bill.js';

export const MAX_BILLS_PER_BATCH = 25;

export function batchBills(
  bills: readonly Bill[],
  batchSize = MAX_BILLS_PER_BATCH,
): Bill[][] {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BILLS_PER_BATCH) {
    throw new Error(`Batch size must be an integer from 1 to ${MAX_BILLS_PER_BATCH}.`);
  }

  const batches: Bill[][] = [];
  for (let index = 0; index < bills.length; index += batchSize) {
    batches.push(bills.slice(index, index + batchSize));
  }
  return batches;
}
