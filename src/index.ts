import 'dotenv/config';

import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { runPortal } from './core/runPortal.js';
import { readAccountMap } from './core/accountMap.js';
import { runTargetedPortal } from './core/runTargetedPortal.js';
import { DukePortal } from './portals/duke/DukePortal.js';
import { getDukeConfig, getDukeCredentials } from './portals/duke/config.js';
import { hasHelpFlag, HELP_TEXT, parseArguments } from './utils/arguments.js';
import {
  consoleLogger,
  createRedactingLogger,
  errorMessage,
  redactSensitiveText,
} from './utils/logging.js';

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (hasHelpFlag(argv)) {
    console.log(HELP_TEXT);
    return 0;
  }

  const arguments_ = parseArguments(argv);

  switch (arguments_.portal) {
    case 'duke': {
      // Credential validation occurs before runPortal launches Playwright.
      const credentials = getDukeCredentials();
      const config = getDukeConfig();
      const logger = createRedactingLogger(consoleLogger, [
        credentials.username,
        credentials.password,
      ]);
      const result = arguments_.mode === 'target-start-month'
        ? await runTargetedPortal({
            portalName: arguments_.portal,
            accountMap: await readAccountMap(arguments_.accountMapPath!),
            billingStartMonth: arguments_.billingStartMonth!,
            outputDirectory: arguments_.outputDir,
            headless: arguments_.headless,
            currentAccountOnly: arguments_.currentAccountOnly,
            logger,
            createPortal: ({ page, context }) =>
              new DukePortal(page, context, credentials, config, logger),
          })
        : await runPortal({
            portalName: arguments_.portal,
            startDate: arguments_.startDate!,
            startDateText: arguments_.startDateText!,
            endDate: arguments_.endDate!,
            endDateText: arguments_.endDateText!,
            outputRoot: arguments_.outputDir,
            headless: arguments_.headless,
            currentAccountOnly: arguments_.currentAccountOnly,
            logger,
            createPortal: ({ page, context }) =>
              new DukePortal(page, context, credentials, config, logger),
          });
      return result.hadFailures ? 1 : 0;
    }
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void main().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    async (error: unknown) => {
      const secrets = [process.env.DUKE_USERNAME ?? '', process.env.DUKE_PASSWORD ?? ''];
      consoleLogger.error(redactSensitiveText(errorMessage(error), secrets));
      process.exitCode = 1;

      // The browser is left open on failure so the user can inspect the page.
      // Close it only after the user acknowledges the error.
      const failed = error as Error & {
        browser?: { close(): Promise<void> };
        context?: { close(): Promise<void> };
      };
      if (process.stdin.isTTY) {
        consoleLogger.error('\nThe browser is still open for inspection. Press Enter to close it and exit...');
        process.stdin.resume();
        await new Promise<void>((resolve) => {
          process.stdin.once('data', () => resolve());
        });
        process.stdin.pause();
      }
      if (failed.context) {
        await failed.context.close().catch(() => undefined);
      }
      if (failed.browser) {
        await failed.browser.close().catch(() => undefined);
      }
    },
  );
}
