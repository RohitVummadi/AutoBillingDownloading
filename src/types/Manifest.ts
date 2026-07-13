import type { Bill } from './Bill.js';

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
