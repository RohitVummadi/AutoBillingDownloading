import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { chromium } from 'playwright';
import { PDFDocument } from 'pdf-lib';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runPortal } from '../src/core/runPortal.js';
import { DukeBatchSelectionTracker } from '../src/portals/duke/batchSelection.js';
import type { Bill } from '../src/types/Bill.js';
import type { BillingPortal } from '../src/types/BillingPortal.js';
import type { PortalAccount } from '../src/types/PortalAccount.js';
import type { Logger } from '../src/utils/logging.js';

vi.mock('playwright', () => ({ chromium: { launch: vi.fn() } }));

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  vi.clearAllMocks();
});

function bill(index: number): Bill {
  const accountNumber = `910000${String(index).padStart(6, '0')}`;
  return {
    portal: 'duke',
    accountNumber,
    serviceAddress: `${index} Main Street`,
    billingCycleStart: '2026-06-01',
    billingCycleEnd: '2026-06-30',
    uniqueKey: `${accountNumber}|2026-06-01|2026-06-30`,
  };
}

describe('Duke bulk batch selection state', () => {
  it('selects a 25-bill batch across pages 1 through 6 in one forward pass', () => {
    const expected = Array.from({ length: 25 }, (_, index) => bill(index).uniqueKey);
    const tracker = new DukeBatchSelectionTracker(expected);
    for (let page = 1; page <= 6; page += 1) {
      tracker.visitPage(page);
      for (const key of expected.slice((page - 1) * 5, page * 5)) tracker.markSelected(key);
    }

    expect(tracker.allExpectedSelectableBillsAreSelected()).toBe(true);
    expect(tracker.summary()).toMatchObject({
      pagesVisited: [1, 2, 3, 4, 5, 6],
      selectedKeys: expected,
      missingKeys: [],
    });
  });

  it('uses unique keys through a table re-render without double-counting a row', () => {
    const target = bill(1).uniqueKey;
    const tracker = new DukeBatchSelectionTracker([target]);
    tracker.visitPage(3);
    tracker.markSelected(target);
    // Reacquiring the same page after a Duke re-render sees the same key, not
    // a new positional row to be selected again.
    tracker.visitPage(3);
    tracker.markSelected(target);

    expect(tracker.summary()).toMatchObject({ pagesVisited: [3], selectedKeys: [target] });
  });

  it('reports a missing unique key and excludes a missing View Bill row from selectable count', () => {
    const available = bill(1).uniqueKey;
    const unavailable = bill(2).uniqueKey;
    const missing = bill(3).uniqueKey;
    const tracker = new DukeBatchSelectionTracker([available, unavailable, missing]);
    tracker.visitPage(1);
    tracker.markSelected(available);
    tracker.markUnavailable(unavailable);

    expect(tracker.summary()).toEqual({
      expectedKeys: [available, unavailable, missing],
      expectedSelectableKeys: [available, missing],
      selectedKeys: [available],
      missingKeys: [missing],
      unavailableKeys: [unavailable],
      pagesVisited: [1],
    });
  });
});

class BulkPortal implements BillingPortal {
  public readonly name = 'duke';
  public readonly events: string[] = [];
  public readonly downloads: Bill[][] = [];
  public selected: Bill[] = [];
  public failFirstDownload = false;

  public async login(): Promise<void> {}
  public async navigateToBills(): Promise<void> {}
  public async listAccounts(): Promise<PortalAccount[]> {
    return [{ id: 'partner-1', label: 'Partner 1', isCurrent: true }];
  }
  public async activateAccount(): Promise<void> {}
  public async scanBills(): Promise<Bill[]> {
    return Array.from({ length: 69 }, (_, index) => bill(index));
  }
  public async selectBatch(bills: Bill[]): Promise<void> {
    this.selected = [...bills];
    this.events.push(`select:${bills.map((candidate) => candidate.uniqueKey).join(',')}`);
  }
  public async downloadSelectedBatch(
    batchNumber: number,
    outputPath: string,
    expectedBillCount: number,
  ): Promise<string> {
    this.events.push(`download:${batchNumber}`);
    this.downloads.push([...this.selected]);
    if (this.failFirstDownload) {
      this.failFirstDownload = false;
      throw new Error('temporary Duke PRINT BILLS timeout');
    }
    if (this.selected.length !== expectedBillCount) throw new Error('selected count mismatch');
    await mkdir(path.dirname(outputPath), { recursive: true });
    const document = await PDFDocument.create();
    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      document.addPage([100, 100]);
    }
    await writeFile(outputPath, await document.save());
    return outputPath;
  }
  public async clearSelections(): Promise<void> {
    this.events.push(`clear:${this.selected.length}`);
    this.selected = [];
  }
  public async verifySelectionCount(expectedCount: number): Promise<void> {
    if (this.selected.length !== expectedCount) {
      throw new Error(`expected ${expectedCount} selected rows, found ${this.selected.length}`);
    }
  }
}

async function runBulkPortal(portal: BulkPortal): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'duke-bulk-batch-'));
  temporaryDirectories.push(directory);
  const page = {};
  const context = { newPage: vi.fn().mockResolvedValue(page), close: vi.fn().mockResolvedValue(undefined) };
  const browser = {
    newContext: vi.fn().mockResolvedValue(context),
    close: vi.fn().mockResolvedValue(undefined),
    isConnected: () => false,
  };
  vi.mocked(chromium.launch).mockResolvedValue(browser as never);
  const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const result = await runPortal({
    portalName: 'duke',
    startDate: new Date(Date.UTC(2026, 5, 1)),
    startDateText: '2026-06-01',
    endDate: new Date(Date.UTC(2026, 6, 12)),
    endDateText: '2026-07-12',
    outputRoot: directory,
    headless: true,
    currentAccountOnly: true,
    logger,
    createPortal: () => portal,
  });
  const manifest = JSON.parse(await readFile(result.runSummaryPath, 'utf8'));
  expect(manifest.accounts[0]).toMatchObject({ status: 'completed' });
}

describe('Duke bulk batch orchestration', () => {
  it('clicks one bulk download per batch and clears before beginning the next batch', async () => {
    const portal = new BulkPortal();
    await runBulkPortal(portal);

    expect(portal.downloads.map((batch) => batch.length)).toEqual([25, 25, 19]);
    expect(portal.events.filter((event) => event.startsWith('download:'))).toEqual([
      'download:1', 'download:2', 'download:3',
    ]);
    const firstDownload = portal.events.indexOf('download:1');
    const firstCleanup = portal.events.indexOf('clear:25', firstDownload);
    const secondSelection = portal.events.findIndex((event) => event.startsWith('select:') && event !== portal.events[1]);
    expect(firstCleanup).toBeGreaterThan(firstDownload);
    expect(secondSelection).toBeGreaterThan(firstCleanup);
  });

  it('clears and reselects the complete batch once before retrying a failed bulk download', async () => {
    const portal = new BulkPortal();
    portal.failFirstDownload = true;
    await runBulkPortal(portal);

    expect(portal.downloads.slice(0, 2).map((batch) => batch.map((candidate) => candidate.uniqueKey))).toEqual([
      portal.downloads[0]?.map((candidate) => candidate.uniqueKey),
      portal.downloads[0]?.map((candidate) => candidate.uniqueKey),
    ]);
    expect(portal.events.filter((event) => event === 'download:1')).toHaveLength(2);
  }, 10_000);
});
