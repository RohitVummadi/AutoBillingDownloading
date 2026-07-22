const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const US_DATE_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/u;
const BILLING_US_DATE_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+.*)?$/u;
const LONG_US_DATE_PATTERN = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})(?:\s+.*)?$/u;
const MONTH_NAMES: Readonly<Record<string, number>> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};
const BILLING_CYCLE_PATTERN =
  /^\s*(.+?)\s*[-–—]\s*(.+?)\s*$/u;

export interface BillingCycle {
  start: Date;
  end: Date;
  startIso: string;
  endIso: string;
}

function calendarDate(year: number, month: number, day: number, label: string): Date {
  const value = new Date(Date.UTC(year, month - 1, day));
  if (
    value.getUTCFullYear() !== year ||
    value.getUTCMonth() !== month - 1 ||
    value.getUTCDate() !== day
  ) {
    throw new Error(`Invalid ${label}: the value is not a real calendar date.`);
  }

  return value;
}

export function parseIsoDate(value: string, label = 'date'): Date {
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) {
    throw new Error(`Invalid ${label} "${value}". Expected YYYY-MM-DD.`);
  }

  return calendarDate(Number(match[1]), Number(match[2]), Number(match[3]), label);
}

export function parseUsDate(value: string, label = 'date'): Date {
  const match = US_DATE_PATTERN.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid ${label} "${value}". Expected MM/DD/YYYY.`);
  }

  return calendarDate(Number(match[3]), Number(match[1]), Number(match[2]), label);
}

export function formatCalendarDate(value: Date): string {
  if (Number.isNaN(value.getTime())) {
    throw new Error('Cannot format an invalid calendar date.');
  }

  const year = value.getUTCFullYear().toString().padStart(4, '0');
  const month = (value.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = value.getUTCDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function compareCalendarDates(left: Date, right: Date): number {
  const leftValue = Date.UTC(left.getUTCFullYear(), left.getUTCMonth(), left.getUTCDate());
  const rightValue = Date.UTC(right.getUTCFullYear(), right.getUTCMonth(), right.getUTCDate());
  return Math.sign(leftValue - rightValue);
}

export function parseBillingCycle(value: string): BillingCycle {
  const match = BILLING_CYCLE_PATTERN.exec(value);
  if (!match) {
    throw new Error(
      `Invalid billing cycle "${value}". Expected MM/DD/YYYY - MM/DD/YYYY or Month D, YYYY - Month D, YYYY.`,
    );
  }

  const start = parseBillingDate(match[1] ?? '', 'billing cycle start');
  const end = parseBillingDate(match[2] ?? '', 'billing cycle end');
  if (compareCalendarDates(start, end) > 0) {
    throw new Error(`Invalid billing cycle "${value}": start date is after end date.`);
  }

  return {
    start,
    end,
    startIso: formatCalendarDate(start),
    endIso: formatCalendarDate(end),
  };
}

function parseBillingDate(value: string, label: string): Date {
  const trimmed = value.trim();
  if (US_DATE_PATTERN.test(trimmed)) {
    return parseUsDate(trimmed, label);
  }

  const numericMatch = BILLING_US_DATE_PATTERN.exec(trimmed);
  if (numericMatch) {
    return calendarDate(
      Number(numericMatch[3]),
      Number(numericMatch[1]),
      Number(numericMatch[2]),
      label,
    );
  }

  const longMatch = LONG_US_DATE_PATTERN.exec(trimmed);
  const month = longMatch ? MONTH_NAMES[longMatch[1]?.toLowerCase() ?? ''] : undefined;
  if (!longMatch || month === undefined) {
    throw new Error(
      `Invalid ${label} "${value}". Expected MM/DD/YYYY or Month D, YYYY.`,
    );
  }

  return calendarDate(Number(longMatch[3]), month, Number(longMatch[2]), label);
}

export function isBillingCycleStartInRange(
  billingCycleStart: Date,
  requestedStart: Date,
  requestedEnd: Date,
): boolean {
  return (
    compareCalendarDates(billingCycleStart, requestedStart) >= 0 &&
    compareCalendarDates(billingCycleStart, requestedEnd) <= 0
  );
}
