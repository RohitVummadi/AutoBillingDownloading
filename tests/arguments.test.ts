import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { HELP_TEXT, parseArguments } from '../src/utils/arguments.js';

const required = [
  '--portal',
  'duke',
  '--start-date',
  '2025-06-01',
  '--end-date',
  '2025-06-30',
];

describe('argument validation', () => {
  it('documents that the date range filters billing-cycle start dates', () => {
    expect(HELP_TEXT).toMatch(/billing-cycle start/u);
    expect(HELP_TEXT).toMatch(/Inclusive lower bound/u);
    expect(HELP_TEXT).toMatch(/Inclusive upper bound/u);
  });

  it('applies headed mode and the default output folder', () => {
    const parsed = parseArguments(required);
    expect(parsed.headless).toBe(false);
    expect(parsed.currentAccountOnly).toBe(false);
    expect(parsed.outputDir).toBe(path.resolve('./downloads'));
  });

  it('accepts the single-current-account opt-out flag', () => {
    expect(parseArguments([...required, '--current-account-only']).currentAccountOnly).toBe(true);
    expect(HELP_TEXT).toMatch(/current-account-only/u);
  });

  it('accepts headless mode and an explicit output root', () => {
    const parsed = parseArguments([...required, '--headless', '--output-dir', './bills']);
    expect(parsed.headless).toBe(true);
    expect(parsed.outputDir).toBe(path.resolve('./bills'));
  });

  it('accepts targeted billing-cycle mode with its named-building default output folder', () => {
    const parsed = parseArguments([
      '--portal', 'duke', '--account-map', './meters.csv',
      '--billing-start-month', '2026-06',
    ]);
    expect(parsed.mode).toBe('target-start-month');
    expect(parsed.startDate).toBeNull();
    expect(parsed.billingStartMonthText).toBe('2026-06');
    expect(parsed.outputDir).toBe(path.resolve('./downloads/named-building-bills'));
  });

  it('accepts values stripped by npm when invoked through PowerShell', () => {
    const parsed = parseArguments(['duke', '2025-06-01', '2025-06-30', './bills']);
    expect(parsed.portal).toBe('duke');
    expect(parsed.startDateText).toBe('2025-06-01');
    expect(parsed.endDateText).toBe('2025-06-30');
    expect(parsed.outputDir).toBe(path.resolve('./bills'));
  });

  it.each([
    [['--start-date', '2025-06-01', '--end-date', '2025-06-30'], /--portal/u],
    [[...required.slice(0, 4)], /--end-date/u],
    [[...required, '--unknown'], /Unknown argument/u],
    [[...required, '--portal', 'duke'], /more than once/u],
    [[...required, '--current-account-only', '--current-account-only'], /more than once/u],
    [['--portal', 'duke', '--account-map', './meters.csv'], /billing-start-month/u],
    [['--portal', 'duke', '--billing-start-month', '2026-06'], /requires --account-map/u],
    [['--portal', 'duke', '--account-map', './meters.csv', '--billing-start-month', '2026-6'], /expected YYYY-MM/u],
    [['--portal', 'duke', '--account-map', './meters.csv', '--billing-start-month', '2026-06', '--start-date', '2025-06-01'], /cannot be combined/u],
  ] as const)('rejects missing, unknown, or repeated arguments', (arguments_, message) => {
    expect(() => parseArguments(arguments_)).toThrow(message);
  });

  it('rejects unsupported portals clearly', () => {
    expect(() =>
      parseArguments([
        '--portal',
        'blue-ridge',
        '--start-date',
        '2025-06-01',
        '--end-date',
        '2025-06-30',
      ]),
    ).toThrow(/Unsupported portal.*blue-ridge/u);
  });

  it.each(['2025-02-29', '06/01/2025', '2025-13-01'])('rejects invalid date %s', (date) => {
    expect(() =>
      parseArguments([
        '--portal',
        'duke',
        '--start-date',
        date,
        '--end-date',
        '2025-06-30',
      ]),
    ).toThrow(/Invalid/u);
  });

  it('rejects a reversed range', () => {
    expect(() =>
      parseArguments([
        '--portal',
        'duke',
        '--start-date',
        '2025-07-01',
        '--end-date',
        '2025-06-30',
      ]),
    ).toThrow(/cannot be later/u);
  });
});
