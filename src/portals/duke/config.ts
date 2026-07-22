export interface DukeCredentials {
  username: string;
  password: string;
}

export interface DukeConfig {
  homeUrl: string;
  loginUrl: string;
  businessBillsUrl: string;
  navigationTimeoutMs: number;
  postNavigationWaitMs: number;
  actionTimeoutMs: number;
  downloadTimeoutMs: number;
  maximumTablePages: number;
  /** Directory for per-bill staging PDFs before they are merged into a batch. */
  tempDirectory: string;
}

// LIVE-SITE VERIFICATION REQUIRED: Duke routes can vary by operating company and
// account type. These defaults are deliberately isolated here and can be
// overridden without changing application code.
export const DUKE_DEFAULT_LOGIN_URL = 'https://my.duke-energy.com/login';
export const DUKE_DEFAULT_HOME_URL = 'https://www.duke-energy.com/home';
export const DUKE_DEFAULT_BUSINESS_BILLS_URL =
  'https://businessportal2.duke-energy.com/billinghistory';

export function getDukeConfig(environment: NodeJS.ProcessEnv = process.env): DukeConfig {
  return {
    homeUrl: environment.DUKE_HOME_URL?.trim() || DUKE_DEFAULT_HOME_URL,
    loginUrl: environment.DUKE_LOGIN_URL?.trim() || DUKE_DEFAULT_LOGIN_URL,
    businessBillsUrl:
      environment.DUKE_BUSINESS_BILLS_URL?.trim() || DUKE_DEFAULT_BUSINESS_BILLS_URL,
    navigationTimeoutMs: 45_000,
    postNavigationWaitMs: 10_000,
    actionTimeoutMs: 20_000,
    downloadTimeoutMs: 90_000,
    maximumTablePages: 500,
    tempDirectory: environment.DUKE_TEMP_DIRECTORY?.trim() || 'downloads/duke/.staging',
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
