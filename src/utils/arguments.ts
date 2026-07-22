import path from 'node:path';

import { compareCalendarDates, parseIsoDate } from './dates.js';

export const SUPPORTED_PORTALS = ['duke'] as const;
export type SupportedPortal = (typeof SUPPORTED_PORTALS)[number];

export interface CliArguments {
  mode: 'date-range' | 'target-start-month';
  portal: SupportedPortal;
  startDate: Date | null;
  startDateText: string | null;
  endDate: Date | null;
  endDateText: string | null;
  accountMapPath: string | null;
  billingStartMonth: Date | null;
  billingStartMonthText: string | null;
  outputDir: string;
  headless: boolean;
  currentAccountOnly: boolean;
}

export const HELP_TEXT = `Usage:
  npm run download -- --portal duke --start-date YYYY-MM-DD --end-date YYYY-MM-DD [options]
  npm run download -- --portal duke --account-map <csv-path> --billing-start-month YYYY-MM [options]

Options:
  --portal <name>       Required. Supported portals: duke
  --start-date <date>   Required. Inclusive lower bound for billing-cycle start.
  --end-date <date>     Required. Inclusive upper bound for billing-cycle start.
  --output-dir <path>   Output root (default: ./downloads).
  --account-map <path>  CSV with Account Number and Building Name columns.
  --billing-start-month <YYYY-MM>  Required CSV-bill cycle start month.
  --current-account-only  Process only the active Business Partner account.
  --headless            Run without a visible browser (headed by default).
  --help                Show this help text.`;

const VALUE_OPTIONS = new Set([
  '--portal', '--start-date', '--end-date', '--output-dir', '--account-map', '--billing-start-month',
]);

export function hasHelpFlag(argv: readonly string[]): boolean {
  return argv.includes('--help') || argv.includes('-h');
}

export function parseArguments(argv: readonly string[]): CliArguments {
  // Some npm/PowerShell combinations strip option names before invoking a
  // package script, leaving only the values. Recover that exact documented
  // invocation shape without accepting arbitrary positional arguments.
  const normalizedArgv = normalizeStrippedNpmArguments(argv);
  const values = new Map<string, string>();
  let headless = false;
  let currentAccountOnly = false;

  for (let index = 0; index < normalizedArgv.length; index += 1) {
    const argument = normalizedArgv[index];
    if (argument === '--headless') {
      if (headless) {
        throw new Error('Argument --headless was provided more than once.');
      }
      headless = true;
      continue;
    }
    if (argument === '--current-account-only') {
      if (currentAccountOnly) {
        throw new Error('Argument --current-account-only was provided more than once.');
      }
      currentAccountOnly = true;
      continue;
    }
    if (!argument || !VALUE_OPTIONS.has(argument)) {
      throw new Error(`Unknown argument "${argument ?? ''}".\n${HELP_TEXT}`);
    }
    if (values.has(argument)) {
      throw new Error(`Argument ${argument} was provided more than once.`);
    }

    const value = normalizedArgv[index + 1];
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

  const accountMapValue = values.get('--account-map');
  const hasDates = values.has('--start-date') || values.has('--end-date');
  if (accountMapValue !== undefined) {
    if (hasDates) throw new Error('--account-map cannot be combined with --start-date or --end-date.');
    if (accountMapValue.trim().length === 0 || accountMapValue.includes('\0')) {
      throw new Error('Invalid --account-map: provide a non-empty CSV path.');
    }
    const billingStartMonthText = requiredValue(values, '--billing-start-month');
    const billingStartMonth = parseIsoMonth(billingStartMonthText, 'billing start month');
    const outputDirValue = values.get('--output-dir') ?? './downloads/named-building-bills';
    return buildArguments({
      mode: 'target-start-month',
      portal: portalValue as SupportedPortal,
      startDate: null,
      startDateText: null,
      endDate: null,
      endDateText: null,
      accountMapPath: path.resolve(accountMapValue),
      billingStartMonth,
      billingStartMonthText,
      outputDirValue,
      headless,
      currentAccountOnly,
    });
  }
  if (values.has('--billing-start-month')) {
    throw new Error('--billing-start-month requires --account-map.');
  }

  const startDateText = requiredValue(values, '--start-date');
  const endDateText = requiredValue(values, '--end-date');
  const startDate = parseIsoDate(startDateText, 'start date');
  const endDate = parseIsoDate(endDateText, 'end date');
  if (compareCalendarDates(startDate, endDate) > 0) {
    throw new Error('Invalid date range: --start-date cannot be later than --end-date.');
  }
  return buildArguments({
    mode: 'date-range',
    portal: portalValue as SupportedPortal,
    startDate,
    startDateText,
    endDate,
    endDateText,
    accountMapPath: null,
    billingStartMonth: null,
    billingStartMonthText: null,
    outputDirValue: values.get('--output-dir') ?? './downloads',
    headless,
    currentAccountOnly,
  });
}

function parseIsoMonth(value: string, label: string): Date {
  if (!/^\d{4}-\d{2}$/u.test(value)) {
    throw new Error(`Invalid ${label} "${value}": expected YYYY-MM.`);
  }
  return parseIsoDate(`${value}-01`, label);
}

function buildArguments(input: Omit<CliArguments, 'outputDir'> & { outputDirValue: string }): CliArguments {
  const outputDirValue = input.outputDirValue;
  if (outputDirValue.trim().length === 0 || outputDirValue.includes('\0')) {
    throw new Error('Invalid --output-dir: provide a non-empty filesystem path.');
  }
  return {
    ...input,
    outputDir: path.resolve(outputDirValue),
  };
}

function normalizeStrippedNpmArguments(argv: readonly string[]): readonly string[] {
  if (
    (argv.length !== 3 && argv.length !== 4) ||
    argv.some((argument) => argument.startsWith('-'))
  ) {
    return argv;
  }

  const portal = argv[0]!;
  const startDate = argv[1]!;
  const endDate = argv[2]!;
  const outputDir = argv[3];
  return [
    '--portal',
    portal,
    '--start-date',
    startDate,
    '--end-date',
    endDate,
    ...(outputDir === undefined ? [] : ['--output-dir', outputDir]),
  ];
}

function requiredValue(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) {
    throw new Error(`Missing required argument ${name}.\n${HELP_TEXT}`);
  }
  return value;
}
