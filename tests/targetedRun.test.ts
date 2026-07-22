import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { chromium } from 'playwright';
import { PDFDocument } from 'pdf-lib';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AccountMap } from '../src/core/accountMap.js';
import { runTargetedPortal, type TargetStartMonthBillingPortal } from '../src/core/runTargetedPortal.js';
import type { Bill } from '../src/types/Bill.js';
import type { PortalAccount } from '../src/types/PortalAccount.js';
import type { Logger } from '../src/utils/logging.js';

vi.mock('playwright', () => ({ chromium: { launch: vi.fn() } }));

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  vi.clearAllMocks();
});

function bill(accountNumber: string, cycleStart: string): Bill {
  return {
    portal: 'duke', accountNumber, serviceAddress: '1 Main Street', billingCycleStart: cycleStart,
    billingCycleEnd: '2026-07-10', uniqueKey: `${accountNumber}|${cycleStart}|2026-07-10`,
  };
}

class TargetPortal implements TargetStartMonthBillingPortal {
  public readonly name = 'duke';
  public readonly selected: Bill[][] = [];
  public readonly selectedUnderPartners: string[] = [];
  public readonly directDownloadsUnderPartners: string[] = [];
  public readonly activationCalls: string[] = [];
  public readonly events: string[] = [];
  public downloads = 0;
  public navigateCalls = 0;
  public activePartnerId = 'partner-1';
  public async login(): Promise<void> {}
  public async navigateToBills(): Promise<void> { this.navigateCalls += 1; }
  public async listAccounts(): Promise<PortalAccount[]> {
    return [
      { id: 'partner-1', label: 'Partner 1', isCurrent: true },
      { id: 'partner-2', label: 'Partner 2', isCurrent: false },
    ];
  }
  public async activateAccount(account: PortalAccount): Promise<void> {
    this.activationCalls.push(account.id);
    this.events.push(`activate:${account.id}`);
    this.activePartnerId = account.id;
  }
  public async scanBills(): Promise<Bill[]> { return []; }
  public readonly requestedMonths: string[] = [];
  public async scanBillsForTargetStartMonth(
    targets: ReadonlySet<string>,
    start: Date,
    onMatch?: (bill: Bill) => Promise<void>,
  ): Promise<Bill[]> {
    this.requestedMonths.push(start.toISOString().slice(0, 7));
    this.events.push(`scan:${this.activePartnerId}`);
    const visible = this.activePartnerId === 'partner-1'
      ? [bill('910000000001', '2026-06-10')]
      : [bill('910000000002', '2026-06-05')];
    const matches = visible.filter((candidate) => targets.has(candidate.accountNumber));
    for (const match of matches) {
      this.events.push(`found:${this.activePartnerId}`);
      await onMatch?.(match);
    }
    return matches;
  }
  public async selectBatch(bills: Bill[]): Promise<void> {
    this.selected.push([...bills]);
    this.selectedUnderPartners.push(this.activePartnerId);
    this.events.push(`select:${this.activePartnerId}`);
  }
  public async downloadTargetBill(_: Bill, __: number, outputPath: string): Promise<string> {
    this.downloads += 1;
    this.directDownloadsUnderPartners.push(this.activePartnerId);
    this.events.push(`direct-download:${this.activePartnerId}`);
    const document = await PDFDocument.create();
    for (let page = 0; page < 100; page += 1) document.addPage([100, 100]);
    await writeFile(outputPath, await document.save());
    return outputPath;
  }
  public async downloadSelectedBatch(_: number, outputPath: string): Promise<string> {
    this.downloads += 1;
    this.events.push(`download:${this.activePartnerId}`);
    const document = await PDFDocument.create();
    for (let page = 0; page < 100; page += 1) document.addPage([100, 100]);
    await writeFile(outputPath, await document.save());
    return outputPath;
  }
  public async clearSelections(): Promise<void> {
    this.events.push(`clear:${this.activePartnerId}`);
  }
  public async verifySelectionCount(): Promise<void> {}
}

describe('targeted start-month runner', () => {
  it('downloads each partner\'s matching bills before moving to the next partner', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'duke-targeted-run-'));
    directories.push(directory);
    const accountMap: AccountMap = {
      sourcePath: path.join(directory, 'meters.csv'),
      entries: [
        { accountNumber: '910000000001', buildingName: 'One', rowNumber: 2 },
        { accountNumber: '910000000002', buildingName: 'Two', rowNumber: 3 },
        { accountNumber: '910000000003', buildingName: 'Missing', rowNumber: 4 },
      ],
      byAccountNumber: new Map(),
    };
    const page = {};
    const context = { newPage: vi.fn().mockResolvedValue(page), close: vi.fn().mockResolvedValue(undefined) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(chromium.launch).mockResolvedValue(browser as never);
    const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const first = new TargetPortal();
    const options = {
      portalName: 'duke', accountMap, billingStartMonth: new Date(Date.UTC(2026, 5, 1)), outputDirectory: directory,
      headless: true, currentAccountOnly: false, logger,
    };
    const firstResult = await runTargetedPortal({ ...options, createPortal: () => first });
    expect(firstResult).toMatchObject({ downloaded: 2, reused: 0, unmatched: 1, hadFailures: false });
    expect(first.selected).toHaveLength(0);
    expect(first.requestedMonths).toEqual(['2026-06', '2026-06']);
    expect(first.directDownloadsUnderPartners).toEqual(['partner-1', 'partner-2']);
    expect(first.activationCalls).toEqual(['partner-2']);
    expect(first.navigateCalls).toBe(1);
    expect(first.events).toEqual([
      'scan:partner-1',
      'found:partner-1',
      'direct-download:partner-1',
      'clear:partner-1',
      'activate:partner-2',
      'scan:partner-2',
      'found:partner-2',
      'direct-download:partner-2',
      'clear:partner-2',
    ]);
    const report = JSON.parse(await readFile(path.join(directory, 'targeted-run.json'), 'utf8'));
    expect(report.targets.map((target: { status: string }) => target.status)).toEqual(['downloaded', 'downloaded', 'unmatched']);

    const second = new TargetPortal();
    const secondResult = await runTargetedPortal({ ...options, createPortal: () => second });
    expect(secondResult).toMatchObject({ downloaded: 0, reused: 2, unmatched: 1, hadFailures: false });
    expect(second.downloads).toBe(0);
  });
});
