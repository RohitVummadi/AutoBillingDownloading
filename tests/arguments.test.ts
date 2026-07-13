import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseArguments } from '../src/utils/arguments.js';

const required = [
  '--portal',
  'duke',
  '--start-date',
  '2025-06-01',
  '--end-date',
  '2025-06-30',
];

describe('argument validation', () => {
  it('applies headed mode and the default output folder', () => {
    const parsed = parseArguments(required);
    expect(parsed.headless).toBe(false);
    expect(parsed.outputDir).toBe(path.resolve('./downloads'));
  });

  it('accepts headless mode and an explicit output root', () => {
    const parsed = parseArguments([...required, '--headless', '--output-dir', './bills']);
    expect(parsed.headless).toBe(true);
    expect(parsed.outputDir).toBe(path.resolve('./bills'));
  });

  it.each([
    [['--start-date', '2025-06-01', '--end-date', '2025-06-30'], /--portal/u],
    [[...required.slice(0, 4)], /--end-date/u],
    [[...required, '--unknown'], /Unknown argument/u],
    [[...required, '--portal', 'duke'], /more than once/u],
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
