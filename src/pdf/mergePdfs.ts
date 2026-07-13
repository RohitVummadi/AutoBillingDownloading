import { readFile, rm } from 'node:fs/promises';

import { PDFDocument } from 'pdf-lib';

import { writeBufferAtomically } from '../utils/files.js';
import { errorMessage } from '../utils/logging.js';
import { assertValidPdf } from './validatePdf.js';

export async function mergePdfs(inputPaths: readonly string[], outputPath: string): Promise<void> {
  if (inputPaths.length === 0) {
    throw new Error('Cannot merge an empty list of PDF files.');
  }

  const mergedDocument = await PDFDocument.create();
  for (let index = 0; index < inputPaths.length; index += 1) {
    const inputPath = inputPaths[index];
    if (!inputPath) throw new Error(`Merge batch ${index + 1} has no input path.`);
    try {
      await assertValidPdf(inputPath);
      const sourceBytes = await readFile(inputPath);
      const sourceDocument = await PDFDocument.load(sourceBytes);
      const pages = await mergedDocument.copyPages(
        sourceDocument,
        sourceDocument.getPageIndices(),
      );
      for (const page of pages) {
        mergedDocument.addPage(page);
      }
    } catch (error) {
      throw new Error(`Merge batch ${index + 1} failed: ${errorMessage(error)}`, {
        cause: error,
      });
    }
  }

  const mergedBytes = await mergedDocument.save();
  await writeBufferAtomically(outputPath, mergedBytes);
  try {
    await assertValidPdf(outputPath);
  } catch (error) {
    await rm(outputPath, { force: true }).catch(() => undefined);
    throw new Error(`Merged PDF validation failed: ${errorMessage(error)}`, { cause: error });
  }
}
