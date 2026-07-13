import { readFile, stat } from 'node:fs/promises';

import { PDFDocument } from 'pdf-lib';

import type { PdfValidationResult } from '../types/Manifest.js';

export const DEFAULT_MINIMUM_PDF_BYTES = 1_024;

const HTML_MARKERS = [
  '<!doctype html',
  '<html',
  '<head',
  '<body',
  '<form',
  'sign in',
  'login',
  'access denied',
  'server error',
];
const HTML_STRUCTURE_MARKERS = ['<!doctype html', '<html', '<head', '<body', '<form'];

export function validatePdfBuffer(
  contents: Uint8Array,
  minimumBytes = DEFAULT_MINIMUM_PDF_BYTES,
): PdfValidationResult {
  const sizeBytes = contents.byteLength;
  if (sizeBytes === 0) {
    return invalid(sizeBytes, 'PDF file is empty.');
  }
  if (sizeBytes < minimumBytes) {
    return invalid(
      sizeBytes,
      `PDF file is too small (${sizeBytes} bytes; minimum is ${minimumBytes} bytes).`,
    );
  }

  const signature = Buffer.from(contents.subarray(0, 5)).toString('ascii');
  if (!signature.startsWith('%PDF')) {
    const sample = Buffer.from(contents.subarray(0, Math.min(sizeBytes, 8_192)))
      .toString('utf8')
      .toLowerCase();
    const looksLikeHtml = HTML_MARKERS.some((marker) => sample.includes(marker));
    return invalid(
      sizeBytes,
      looksLikeHtml
        ? 'Downloaded file is HTML, not a PDF (possibly a login or error page).'
        : 'Downloaded file does not start with the %PDF signature.',
    );
  }

  const leadingSample = Buffer.from(contents.subarray(0, Math.min(sizeBytes, 8_192)))
    .toString('latin1')
    .toLowerCase();
  if (HTML_STRUCTURE_MARKERS.some((marker) => leadingSample.includes(marker))) {
    return invalid(sizeBytes, 'Downloaded file contains an HTML error page.');
  }

  return { valid: true, sizeBytes, message: 'Valid PDF.' };
}

export async function validatePdf(
  filePath: string,
  minimumBytes = DEFAULT_MINIMUM_PDF_BYTES,
): Promise<PdfValidationResult> {
  let fileSize = 0;
  let contents: Buffer;
  try {
    const fileStats = await stat(filePath);
    if (!fileStats.isFile()) {
      return invalid(0, 'PDF path does not point to a regular file.');
    }
    fileSize = fileStats.size;
    contents = await readFile(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return invalid(fileSize, code === 'ENOENT' ? 'PDF file does not exist.' : 'PDF file cannot be read.');
  }

  const basicResult = validatePdfBuffer(contents, minimumBytes);
  if (!basicResult.valid) {
    return basicResult;
  }

  try {
    await PDFDocument.load(contents);
  } catch {
    return invalid(contents.byteLength, 'PDF structure is invalid or unsupported by pdf-lib.');
  }

  return basicResult;
}

export async function assertValidPdf(
  filePath: string,
  minimumBytes = DEFAULT_MINIMUM_PDF_BYTES,
): Promise<PdfValidationResult> {
  const result = await validatePdf(filePath, minimumBytes);
  if (!result.valid) {
    throw new Error(result.message);
  }
  return result;
}

function invalid(sizeBytes: number, message: string): PdfValidationResult {
  return { valid: false, sizeBytes, message };
}
