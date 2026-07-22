/** A stable portal-specific account context that can be activated before scanning bills. */
export interface PortalAccount {
  /** Stable, filesystem-safe identifier; never derived from a display label alone. */
  id: string;
  /** Human-readable text shown by the portal selector. */
  label: string;
  /** Whether the portal reported this context as active when it was discovered. */
  isCurrent: boolean;
}

export function assertPortalAccount(account: PortalAccount): PortalAccount {
  if (!/^[A-Za-z0-9_-]+$/u.test(account.id)) {
    throw new Error(`Unsafe portal account identifier "${account.id}".`);
  }
  if (account.label.trim().length === 0) {
    throw new Error(`Portal account "${account.id}" has an empty label.`);
  }
  return account;
}
