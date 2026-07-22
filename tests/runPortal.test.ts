import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { chromium } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runPortal } from '../src/core/runPortal.js';
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

class MultiAccountPortal implements BillingPortal {
  public readonly name = 'duke';
  public readonly activated: string[] = [];
  public readonly scanned: string[] = [];
  private activeAccountId = '1102669802';
  public async login(): Promise<void> {}
  public async navigateToBills(): Promise<void> {}
  public async listAccounts(): Promise<PortalAccount[]> {
    return [
      { id: '1102669801', label: '1102669801 (FIRST)', isCurrent: false },
      { id: '1102669802', label: '1102669802 (CURRENT)', isCurrent: true },
      { id: '1102669803', label: '1102669803 (FAILS)', isCurrent: false },
    ];
  }
  public async activateAccount(account: PortalAccount): Promise<void> {
    this.activated.push(account.id);
    if (account.id === '1102669803') throw new Error('selector refresh failed');
    this.activeAccountId = account.id;
  }
  public async scanBills(): Promise<Bill[]> {
    this.scanned.push(this.activeAccountId);
    return [];
  }
  public async selectBatch(): Promise<void> { throw new Error('not reached'); }
  public async downloadSelectedBatch(): Promise<string> { throw new Error('not reached'); }
  public async clearSelections(): Promise<void> {}
  public async verifySelectionCount(): Promise<void> {}
}

describe('multi-account orchestration', () => {
  it('continues after an account failure and writes a per-account summary', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'multi-account-run-'));
    temporaryDirectories.push(directory);
    const page = {};
    const context = { newPage: vi.fn().mockResolvedValue(page), close: vi.fn().mockResolvedValue(undefined) };
    const browser = {
      newContext: vi.fn().mockResolvedValue(context),
      close: vi.fn().mockResolvedValue(undefined),
      isConnected: () => false,
    };
    vi.mocked(chromium.launch).mockResolvedValue(browser as never);
    const portal = new MultiAccountPortal();
    const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const result = await runPortal({
      portalName: 'duke',
      startDate: new Date(Date.UTC(2026, 5, 1)),
      startDateText: '2026-06-01',
      endDate: new Date(Date.UTC(2026, 6, 12)),
      endDateText: '2026-07-12',
      outputRoot: directory,
      headless: true,
      currentAccountOnly: false,
      logger,
      createPortal: () => portal,
      now: () => new Date('2026-07-14T00:00:00.000Z'),
    });

    expect(result.hadFailures).toBe(true);
    expect(result.accounts.map((account) => account.status)).toEqual(['completed', 'completed', 'failed']);
    // The initially active account is scanned first, then it is explicitly
    // re-selected after the first non-current account changes the session.
    expect(portal.scanned).toEqual(['1102669802', '1102669801']);
    expect(portal.activated).toEqual(['1102669801', '1102669803', '1102669803']);
    const summary = JSON.parse(await readFile(result.runSummaryPath, 'utf8'));
    expect(summary.accounts[0]).toMatchObject({ status: 'completed', totalMatchingBills: 0 });
    expect(summary.accounts[2]).toMatchObject({ status: 'failed', failureMessage: 'selector refresh failed' });
    const completedManifest = JSON.parse(
      await readFile(
        path.join(directory, 'duke', '2026-06-01-to-2026-07-12', 'accounts', 'account-1102669802', 'manifest.json'),
        'utf8',
      ),
    );
    const failedManifest = JSON.parse(
      await readFile(
        path.join(directory, 'duke', '2026-06-01-to-2026-07-12', 'accounts', 'account-1102669803', 'manifest.json'),
        'utf8',
      ),
    );
    expect(completedManifest).toMatchObject({ accountStatus: 'completed', totalMatchingBills: 0 });
    expect(failedManifest).toMatchObject({ accountStatus: 'failed', failureMessage: 'selector refresh failed' });
  });
});
