import type { Bill } from './Bill.js';
import type { PortalAccount } from './PortalAccount.js';

export interface BillingPortal {
  readonly name: string;

  login(): Promise<void>;
  navigateToBills(): Promise<void>;
  listAccounts(): Promise<PortalAccount[]>;
  activateAccount(account: PortalAccount): Promise<void>;

  scanBills(requestedStart: Date, requestedEnd: Date): Promise<Bill[]>;

  selectBatch(bills: Bill[], requestedStart: Date, requestedEnd: Date): Promise<void>;
  downloadSelectedBatch(
    batchNumber: number,
    outputPath: string,
    expectedBillCount: number,
    requestedStart: Date,
    requestedEnd: Date,
  ): Promise<string>;
  clearSelections(): Promise<void>;
  verifySelectionCount(expectedCount: number): Promise<void>;
}
