export interface DukeBatchSelectionSummary {
  expectedKeys: string[];
  expectedSelectableKeys: string[];
  selectedKeys: string[];
  missingKeys: string[];
  unavailableKeys: string[];
  pagesVisited: number[];
}

/**
 * Records a single Duke bulk-selection pass. Keeping this state separate from
 * locators makes the required key-based checks explicit and prevents table
 * re-renders from changing what the batch is expected to contain.
 */
export class DukeBatchSelectionTracker {
  private readonly expected = new Set<string>();
  private readonly selected = new Set<string>();
  private readonly unavailable = new Set<string>();
  private readonly pages = new Set<number>();

  public constructor(expectedKeys: readonly string[]) {
    for (const key of expectedKeys) {
      if (this.expected.has(key)) {
        throw new Error(`Duke bulk batch contains duplicate bill key: ${key}`);
      }
      this.expected.add(key);
    }
  }

  public visitPage(pageNumber: number): void {
    this.pages.add(pageNumber);
  }

  public isExpected(key: string): boolean {
    return this.expected.has(key);
  }

  public markSelected(key: string): void {
    if (!this.expected.has(key)) {
      throw new Error(`Cannot select a bill that is not in the Duke bulk batch: ${key}`);
    }
    this.selected.add(key);
  }

  public markUnavailable(key: string): void {
    if (!this.expected.has(key)) {
      throw new Error(`Cannot mark a bill outside the Duke bulk batch as unavailable: ${key}`);
    }
    this.unavailable.add(key);
  }

  public allExpectedSelectableBillsAreSelected(): boolean {
    return this.expectedSelectableKeys().every((key) => this.selected.has(key));
  }

  public summary(): DukeBatchSelectionSummary {
    const expectedKeys = [...this.expected];
    const expectedSelectableKeys = this.expectedSelectableKeys();
    const selectedKeys = expectedKeys.filter((key) => this.selected.has(key));
    return {
      expectedKeys,
      expectedSelectableKeys,
      selectedKeys,
      missingKeys: expectedSelectableKeys.filter((key) => !this.selected.has(key)),
      unavailableKeys: expectedKeys.filter((key) => this.unavailable.has(key)),
      pagesVisited: [...this.pages].sort((left, right) => left - right),
    };
  }

  private expectedSelectableKeys(): string[] {
    return [...this.expected].filter((key) => !this.unavailable.has(key));
  }
}
