import type { PortalAccount } from '../../types/PortalAccount.js';
import { assertPortalAccount } from '../../types/PortalAccount.js';

export interface DukeBusinessPartnerOption {
  text: string;
  value?: string | null;
  dataAccountId?: string | null;
  isCurrent: boolean;
}

/**
 * Duke's selector visibly prefixes each Business Partner with its numeric
 * account identifier. Prefer a live DOM value/data attribute, but only accept
 * it when it contains exactly one account-like number; labels alone are not
 * stable enough to use as an output key.
 */
export function toDukePortalAccount(option: DukeBusinessPartnerOption): PortalAccount {
  const values = [option.dataAccountId, option.value, option.text]
    .filter((value): value is string => typeof value === 'string')
    .flatMap((value) => value.match(/\d{6,}/gu) ?? []);
  const ids = [...new Set(values)];
  if (ids.length !== 1) {
    throw new Error(
      `Business Partner option does not expose exactly one stable numeric account id: "${option.text}".`,
    );
  }
  return assertPortalAccount({
    id: ids[0]!,
    label: option.text.trim(),
    isCurrent: option.isCurrent,
  });
}
