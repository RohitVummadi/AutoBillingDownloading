import type { Bill } from './Bill.js';
import type { PortalAccount } from './PortalAccount.js';

export interface PdfValidationResult {
  valid: boolean;
  sizeBytes: number;
  message: string;
}

export interface BatchManifestRecord {
  batchNumber: number;
  numberOfBills: number;
  batchPdfPath: string;
  downloadTimestamp: string;
  validationResult: PdfValidationResult;
  includedBillUniqueKeys: string[];
}

export interface BillManifestRecord extends Bill {
  batchNumber: number;
  batchPdfPath: string;
}

export interface Manifest {
  portal: string;
  account?: PortalAccount;
  /** Present for per-account runs so a zero-bill scan is distinguishable from a failed scan. */
  accountStatus?: 'pending' | 'completed' | 'failed';
  failureMessage?: string;
  requestedStartDate: string;
  requestedEndDate: string;
  totalMatchingBills: number;
  totalBatches: number;
  downloadStartTimestamp: string;
  downloadCompletionTimestamp: string | null;
  finalMergedPdfPath: string | null;
  batches: BatchManifestRecord[];
  bills: BillManifestRecord[];
}

export interface AccountRunSummary {
  account: PortalAccount;
  status: 'pending' | 'completed' | 'failed';
  totalMatchingBills: number;
  totalBatches: number;
  manifestPath: string | null;
  combinedPdfPath: string | null;
  failureMessage: string | null;
}

export interface RunSummary {
  portal: string;
  requestedStartDate: string;
  requestedEndDate: string;
  startedAt: string;
  completedAt: string | null;
  accounts: AccountRunSummary[];
  totalUniqueMatchingBills?: number;
  finalMergedPdfPath?: string | null;
}

export interface FinalRunManifest {
  portal: string;
  requestedStartDate: string;
  requestedEndDate: string;
  totalUniqueMatchingBills: number;
  totalBatches: number;
  finalMergedPdfPath: string | null;
  bills: Array<Bill & { sourcePartnerIds: string[] }>;
  accounts: AccountRunSummary[];
}
