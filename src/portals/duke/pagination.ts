export interface DukePaginationMetadata {
  currentPage: number | null;
  totalPages: number | null;
  rangeStart: number | null;
  rangeEnd: number | null;
  totalResults: number | null;
}

export type DukeSortDirection = 'ascending' | 'descending' | 'unknown';

export interface DukeSortState {
  ariaSort: string | null;
  dataSort: string | null;
  dataSortDirection: string | null;
  className: string;
  iconSignals: readonly string[];
}

export interface DukePaginationAdvance {
  rangeChanged: boolean;
  fingerprintChanged: boolean;
}

export type DukeDescendingScanDecision = 'skip-newer' | 'include' | 'stop-before-start';
export type DukeDiscoveryDecision = DukeDescendingScanDecision | 'include-unavailable';

export interface DukePaginationControlState {
  exists: boolean;
  visible: boolean;
  enabled: boolean;
  disabledAttribute: string | null;
  ariaDisabled: string | null;
  className: string;
  ancestorClassName: string;
}

export function parseDukePaginationMetadata(text: string): DukePaginationMetadata {
  const rangeMatch = /(\d+)\s*-\s*(\d+)\s+of\s+(\d+)/iu.exec(text);
  if (rangeMatch) {
    const rangeStart = Number(rangeMatch[1]);
    const rangeEnd = Number(rangeMatch[2]);
    const totalResults = Number(rangeMatch[3]);
    const pageSize = rangeEnd - rangeStart + 1;
    if (
      Number.isSafeInteger(rangeStart) &&
      Number.isSafeInteger(rangeEnd) &&
      Number.isSafeInteger(totalResults) &&
      rangeStart > 0 &&
      rangeEnd >= rangeStart &&
      totalResults >= rangeEnd &&
      pageSize > 0
    ) {
      return {
        currentPage: Math.ceil(rangeStart / pageSize),
        totalPages: Math.ceil(totalResults / pageSize),
        rangeStart,
        rangeEnd,
        totalResults,
      };
    }
  }

  const match = /(?:page\s*)?(\d+)\s*(?:of|\/)\s*(\d+)/iu.exec(text);
  if (!match) {
    return {
      currentPage: null,
      totalPages: null,
      rangeStart: null,
      rangeEnd: null,
      totalResults: null,
    };
  }

  const currentPage = Number(match[1]);
  const totalPages = Number(match[2]);
  if (!Number.isSafeInteger(currentPage) || !Number.isSafeInteger(totalPages)) {
    return {
      currentPage: null,
      totalPages: null,
      rangeStart: null,
      rangeEnd: null,
      totalResults: null,
    };
  }
  return {
    currentPage,
    totalPages,
    rangeStart: null,
    rangeEnd: null,
    totalResults: null,
  };
}

export function detectDukeSortDirection(state: DukeSortState): DukeSortDirection {
  const ariaSort = state.ariaSort?.trim().toLowerCase();
  if (ariaSort === 'descending') return 'descending';
  if (ariaSort === 'ascending') return 'ascending';

  const signals = [
    state.dataSort,
    state.dataSortDirection,
    state.className,
    ...state.iconSignals,
  ]
    .filter((value): value is string => value !== null)
    .map((value) => value.toLowerCase());
  const text = signals.join(' ');

  if (/(?:\bdescending\b|\bsort[-_ ]?desc\b|\bicon[-_ ]?sort[-_ ]?down\b|\bfa-sort-down\b|\bchevron-down\b|↓)/u.test(text)) {
    return 'descending';
  }
  if (/(?:\bascending\b|\bsort[-_ ]?asc\b|\bicon[-_ ]?sort[-_ ]?up\b|\bfa-sort-up\b|\bchevron-up\b|↑)/u.test(text)) {
    return 'ascending';
  }
  return 'unknown';
}

export function shouldClickForDescendingBillingCycleSort(direction: DukeSortDirection): boolean {
  return direction !== 'descending';
}

export function areDukeBillingCycleStartsNonIncreasing(
  starts: readonly Date[],
): boolean {
  return starts.every(
    (start, index) => index === 0 || start.getTime() <= (starts[index - 1]?.getTime() ?? NaN),
  );
}

/** The inclusive rule applies only to Billing Cycle start, never the end date. */
export function classifyDukeBillingCycleStart(
  billingCycleStart: Date,
  requestedStart: Date,
  requestedEnd: Date,
): DukeDescendingScanDecision {
  const value = billingCycleStart.getTime();
  if (value > requestedEnd.getTime()) return 'skip-newer';
  if (value < requestedStart.getTime()) return 'stop-before-start';
  return 'include';
}

export function classifyDukeBillForDiscovery(
  billingCycleStart: Date,
  requestedStart: Date,
  requestedEnd: Date,
  hasViewBillAction: boolean,
): DukeDiscoveryDecision {
  const decision = classifyDukeBillingCycleStart(
    billingCycleStart,
    requestedStart,
    requestedEnd,
  );
  return decision === 'include' && !hasViewBillAction ? 'include-unavailable' : decision;
}

export function canUseDukeDescendingEarlyStop(
  direction: DukeSortDirection,
  starts: readonly Date[],
): boolean {
  return direction === 'descending' && areDukeBillingCycleStartsNonIncreasing(starts);
}

export function hasDukePaginationAdvanced(
  before: { paginationRange: string; fingerprint: string },
  after: { paginationRange: string; fingerprint: string },
): DukePaginationAdvance {
  return {
    rangeChanged: before.paginationRange !== after.paginationRange,
    fingerprintChanged: before.fingerprint !== after.fingerprint,
  };
}

export function createDukeBillRowsFingerprint(
  rowKeys: readonly string[],
  emptyMessage: string | null,
): string {
  return JSON.stringify({ rowKeys, emptyMessage });
}

export function isDukePaginationControlEnabled(state: DukePaginationControlState): boolean {
  const disabledClass = /(?:^|\s)(?:disabled|is-disabled|isDisabled)(?:\s|$)/u;
  return (
    state.exists &&
    state.visible &&
    state.enabled &&
    state.disabledAttribute === null &&
    state.ariaDisabled?.toLowerCase() !== 'true' &&
    !disabledClass.test(state.className) &&
    !disabledClass.test(state.ancestorClassName)
  );
}
