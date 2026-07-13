import type { Bill } from './Bill.js';

export interface BillingPortal {
  readonly name: string;

  login(): Promise<void>;
  navigateToBills(): Promise<void>;

  scanBills(requestedStart: Date, requestedEnd: Date): Promise<Bill[]>;

  selectBatch(bills: Bill[]): Promise<void>;
  downloadSelectedBatch(batchNumber: number, outputPath: string): Promise<string>;
  clearSelections(): Promise<void>;
  verifySelectionCount(expectedCount: number): Promise<void>;
}
