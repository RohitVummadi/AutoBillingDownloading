const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const US_DATE_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/u;
const BILLING_CYCLE_PATTERN =
  /^\s*(\d{1,2}\/\d{1,2}\/\d{4})\s*[-–—]\s*(\d{1,2}\/\d{1,2}\/\d{4})\s*$/u;

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
      `Invalid billing cycle "${value}". Expected MM/DD/YYYY - MM/DD/YYYY.`,
    );
  }

  const start = parseUsDate(match[1] ?? '', 'billing cycle start');
  const end = parseUsDate(match[2] ?? '', 'billing cycle end');
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

export function dateRangesOverlap(
  firstStart: Date,
  firstEnd: Date,
  secondStart: Date,
  secondEnd: Date,
): boolean {
  return (
    compareCalendarDates(firstStart, secondEnd) <= 0 &&
    compareCalendarDates(firstEnd, secondStart) >= 0
  );
}
