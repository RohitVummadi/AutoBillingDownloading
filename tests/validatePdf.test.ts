import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterEach, describe, expect, it } from 'vitest';

import { validatePdf, validatePdfBuffer } from '../src/pdf/validatePdf.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function validPdfBytes(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText('Synthetic unit-test PDF', { x: 72, y: 720, font, size: 12 });
  return document.save();
}

describe('PDF validation', () => {
  it('accepts a real PDF with the expected signature', async () => {
    const bytes = await validPdfBytes();
    expect(Buffer.from(bytes.subarray(0, 4)).toString('ascii')).toBe('%PDF');
    expect(validatePdfBuffer(bytes, 100)).toMatchObject({ valid: true });
  });

  it('rejects HTML incorrectly saved with a PDF filename', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'bill-pdf-test-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'login.pdf');
    const html = Buffer.from(
      `<!doctype html><html><body><form>Sign in</form>${'x'.repeat(2_000)}</body></html>`,
    );
    await writeFile(filePath, html);

    const result = await validatePdf(filePath);
    expect(result.valid).toBe(false);
    expect(result.message).toMatch(/HTML|login|error page/iu);
  });

  it('rejects empty, undersized, and non-PDF content clearly', () => {
    expect(validatePdfBuffer(Buffer.alloc(0)).message).toMatch(/empty/u);
    expect(validatePdfBuffer(Buffer.from('%PDF-1.7'), 100).message).toMatch(/too small/u);
    expect(validatePdfBuffer(Buffer.from('plain text'), 1).message).toMatch(/%PDF/u);
  });

  it('rejects an HTML error payload even when it is prefixed with a PDF signature', () => {
    const polyglot = Buffer.from('%PDF-1.7\n<body><form>Login failed</form></body>');
    const result = validatePdfBuffer(polyglot, 1);
    expect(result).toMatchObject({ valid: false });
    expect(result.message).toMatch(/HTML error page/u);
  });

  it('rejects a missing file', async () => {
    const result = await validatePdf(path.join(os.tmpdir(), 'definitely-missing-bill.pdf'));
    expect(result).toMatchObject({ valid: false, message: 'PDF file does not exist.' });
  });
});
