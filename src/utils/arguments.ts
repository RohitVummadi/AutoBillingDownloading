import path from 'node:path';

import { compareCalendarDates, parseIsoDate } from './dates.js';

export const SUPPORTED_PORTALS = ['duke'] as const;
export type SupportedPortal = (typeof SUPPORTED_PORTALS)[number];

export interface CliArguments {
  portal: SupportedPortal;
  startDate: Date;
  startDateText: string;
  endDate: Date;
  endDateText: string;
  outputDir: string;
  headless: boolean;
}

export const HELP_TEXT = `Usage:
  npm run download -- --portal duke --start-date YYYY-MM-DD --end-date YYYY-MM-DD [options]

Options:
  --portal <name>       Required. Supported portals: duke
  --start-date <date>   Required. First requested calendar date.
  --end-date <date>     Required. Last requested calendar date.
  --output-dir <path>   Output root (default: ./downloads).
  --headless            Run without a visible browser (headed by default).
  --help                Show this help text.`;

const VALUE_OPTIONS = new Set(['--portal', '--start-date', '--end-date', '--output-dir']);

export function hasHelpFlag(argv: readonly string[]): boolean {
  return argv.includes('--help') || argv.includes('-h');
}

export function parseArguments(argv: readonly string[]): CliArguments {
  const values = new Map<string, string>();
  let headless = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--headless') {
      if (headless) {
        throw new Error('Argument --headless was provided more than once.');
      }
      headless = true;
      continue;
    }

    if (!argument || !VALUE_OPTIONS.has(argument)) {
      throw new Error(`Unknown argument "${argument ?? ''}".\n${HELP_TEXT}`);
    }
    if (values.has(argument)) {
      throw new Error(`Argument ${argument} was provided more than once.`);
    }

    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Argument ${argument} requires a value.`);
    }
    values.set(argument, value);
    index += 1;
  }

  const portalValue = requiredValue(values, '--portal');
  if (!SUPPORTED_PORTALS.includes(portalValue as SupportedPortal)) {
    throw new Error(
      `Unsupported portal "${portalValue}". Supported portals: ${SUPPORTED_PORTALS.join(', ')}.`,
    );
  }

  const startDateText = requiredValue(values, '--start-date');
  const endDateText = requiredValue(values, '--end-date');
  const startDate = parseIsoDate(startDateText, 'start date');
  const endDate = parseIsoDate(endDateText, 'end date');
  if (compareCalendarDates(startDate, endDate) > 0) {
    throw new Error('Invalid date range: --start-date cannot be later than --end-date.');
  }

  const outputDirValue = values.get('--output-dir') ?? './downloads';
  if (outputDirValue.trim().length === 0 || outputDirValue.includes('\0')) {
    throw new Error('Invalid --output-dir: provide a non-empty filesystem path.');
  }

  return {
    portal: portalValue as SupportedPortal,
    startDate,
    startDateText,
    endDate,
    endDateText,
    outputDir: path.resolve(outputDirValue),
    headless,
  };
}

function requiredValue(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) {
    throw new Error(`Missing required argument ${name}.\n${HELP_TEXT}`);
  }
  return value;
}
