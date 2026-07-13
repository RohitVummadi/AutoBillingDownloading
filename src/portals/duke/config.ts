export interface DukeCredentials {
  username: string;
  password: string;
}

export interface DukeConfig {
  loginUrl: string;
  billsUrl: string;
  navigationTimeoutMs: number;
  actionTimeoutMs: number;
  downloadTimeoutMs: number;
  maximumTablePages: number;
}

// LIVE-SITE VERIFICATION REQUIRED: Duke routes can vary by operating company and
// account type. These defaults are deliberately isolated here and can be
// overridden without changing application code.
export const DUKE_DEFAULT_LOGIN_URL = 'https://my.duke-energy.com/login';
export const DUKE_DEFAULT_BILLS_URL =
  'https://my.duke-energy.com/my-account/billing-payments/billing-history';

export function getDukeConfig(environment: NodeJS.ProcessEnv = process.env): DukeConfig {
  return {
    loginUrl: environment.DUKE_LOGIN_URL?.trim() || DUKE_DEFAULT_LOGIN_URL,
    billsUrl: environment.DUKE_BILLS_URL?.trim() || DUKE_DEFAULT_BILLS_URL,
    navigationTimeoutMs: 45_000,
    actionTimeoutMs: 20_000,
    downloadTimeoutMs: 90_000,
    maximumTablePages: 500,
  };
}

export function getDukeCredentials(
  environment: NodeJS.ProcessEnv = process.env,
): DukeCredentials {
  const username = environment.DUKE_USERNAME?.trim() ?? '';
  const password = environment.DUKE_PASSWORD ?? '';
  const missing: string[] = [];
  if (username.length === 0) {
    missing.push('DUKE_USERNAME');
  }
  if (password.length === 0) {
    missing.push('DUKE_PASSWORD');
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing required Duke credential environment variable${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}. Create a .env file from .env.example.`,
    );
  }

  return { username, password };
}
