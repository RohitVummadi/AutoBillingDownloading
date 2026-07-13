export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const consoleLogger: Logger = {
  info(message: string): void {
    console.log(message);
  },
  warn(message: string): void {
    console.warn(`Warning: ${message}`);
  },
  error(message: string): void {
    console.error(`Error: ${message}`);
  },
};

export function createRedactingLogger(
  logger: Logger,
  secrets: readonly string[],
): Logger {
  return {
    info(message: string): void {
      logger.info(redactSensitiveText(message, secrets));
    },
    warn(message: string): void {
      logger.warn(redactSensitiveText(message, secrets));
    },
    error(message: string): void {
      logger.error(redactSensitiveText(message, secrets));
    },
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function redactSensitiveText(message: string, secrets: readonly string[]): string {
  let redacted = message;
  const orderedSecrets = [...new Set(secrets.filter((secret) => secret.length > 0))].sort(
    (left, right) => right.length - left.length,
  );
  for (const secret of orderedSecrets) {
    redacted = redacted.split(secret).join('[REDACTED]');
  }

  return redacted
    .replace(
      /("authorization"\s*:\s*")[^"\r\n]*"/giu,
      '$1[REDACTED]"',
    )
    .replace(
      /('authorization'\s*:\s*')[^'\r\n]*'/giu,
      "$1[REDACTED]'",
    )
    .replace(/(\bauthorization\s*[:=]\s*)[^\r\n]*/giu, '$1[REDACTED]')
    .replace(/("(?:set-)?cookie"\s*:\s*")[^"\r\n]*"/giu, '$1[REDACTED]"')
    .replace(/('(?:set-)?cookie'\s*:\s*')[^'\r\n]*'/giu, "$1[REDACTED]'")
    .replace(/(\b(?:set-)?cookie\s*[:=]\s*)[^\r\n]*/giu, '$1[REDACTED]')
    .replace(
      /([?&](?:access[_-]?token|id[_-]?token|refresh[_-]?token|token|session(?:[_-]?(?:id|token))?|auth(?:orization|[_-]?token)?|api[_-]?key|key|(?:x[_-]?amz[_-]?)?(?:signature|credential|security[_-]?token)|sig)\s*=)[^&#\s]+/giu,
      '$1[REDACTED]',
    )
    .replace(/(https?:\/\/)[^/@\s:]+:[^/@\s]+@/giu, '$1[REDACTED]@');
}

export function contextualError(
  operation: string,
  message: string,
  context: Readonly<Record<string, string | number | undefined>>,
  cause?: unknown,
): Error {
  const fields = Object.entries(context)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
  const prefix = fields.length > 0 ? `[${fields}] ` : '';
  return new Error(`${prefix}${operation}: ${message}`, cause === undefined ? undefined : { cause });
}
