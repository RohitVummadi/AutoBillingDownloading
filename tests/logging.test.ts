import { describe, expect, it, vi } from 'vitest';

import {
  createRedactingLogger,
  type Logger,
  redactSensitiveText,
} from '../src/utils/logging.js';

describe('sensitive log redaction', () => {
  it('redacts overlapping literal secrets longest-first', () => {
    const result = redactSensitiveText('user=alice password=alice-secret', [
      'alice',
      'alice-secret',
    ]);
    expect(result).toBe('user=[REDACTED] password=[REDACTED]');
    expect(result).not.toContain('-secret');
  });

  it.each([
    'Authorization: Bearer super-secret-token',
    'Authorization=Basic dXNlcjpwYXNz',
    'Authorization: Digest username="duke-user", response="digest-secret"',
    '{"authorization":"Bearer json-token","status":401}',
    'https://example.invalid/pdf?token=signed-token&file=bill.pdf',
    'https://example.invalid/pdf?access_token=url-token&signature=url-signature',
    'https://example.invalid/pdf?session_token=session-secret&authToken=auth-secret',
    'https://example.invalid/pdf?X-Amz-Credential=aws-user&X-Amz-Signature=aws-secret',
    '{"cookie":"session_id=cookie-secret","status":401}',
    'https://portal-user:portal-password@example.invalid/bill.pdf',
  ])('redacts authentication data from %s', (message) => {
    const result = redactSensitiveText(message, []);
    expect(result).not.toMatch(
      /super-secret-token|dXNlcjpwYXNz|duke-user|digest-secret|json-token|signed-token|url-token|url-signature|session-secret|auth-secret|aws-user|aws-secret|cookie-secret|portal-user|portal-password/u,
    );
    expect(result).toContain('[REDACTED]');
  });

  it('redacts warning and progress messages through the wrapped logger', () => {
    const base: Logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const logger = createRedactingLogger(base, ['secret-value']);
    logger.warn('Retry failed with secret-value');
    logger.info('Progress for secret-value');

    expect(base.warn).toHaveBeenCalledWith('Retry failed with [REDACTED]');
    expect(base.info).toHaveBeenCalledWith('Progress for [REDACTED]');
  });
});
