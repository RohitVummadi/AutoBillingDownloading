import type {
  APIResponse,
  BrowserContext,
  Download,
  Locator,
  Page,
  Response,
} from 'playwright';

import { validatePdfBuffer } from '../../pdf/validatePdf.js';
import { writeBufferAtomically } from '../../utils/files.js';

export interface DukeDownloadOptions {
  page: Page;
  context: BrowserContext;
  printAction: Locator;
  outputPath: string;
  timeoutMs: number;
  responseUrlHints: readonly string[];
}

export async function downloadDukePdf(options: DukeDownloadOptions): Promise<string> {
  let settled = false;
  let printStarted = false;
  let timeoutHandle: NodeJS.Timeout | undefined;
  const candidateFailures: string[] = [];

  let resolveResult: (contents: Buffer) => void = () => undefined;
  let rejectResult: (error: Error) => void = () => undefined;
  const result = new Promise<Buffer>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // The Print action itself can remain pending until the capture timeout. Mark
  // the result rejection as observed immediately, then await it normally below.
  void result.catch(() => undefined);

  const cleanup = (): void => {
    options.page.off('download', downloadHandler);
    options.page.off('popup', popupHandler);
    options.context.off('response', responseHandler);
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  };

  const considerCandidate = async (
    source: string,
    producer: () => Promise<Buffer>,
  ): Promise<void> => {
    if (settled) return;
    try {
      const contents = await producer();
      const validation = validatePdfBuffer(contents);
      if (!validation.valid) {
        throw new Error(validation.message);
      }
      if (!settled) {
        settled = true;
        cleanup();
        resolveResult(contents);
      }
    } catch {
      candidateFailures.push(source);
    }
  };

  function downloadHandler(download: Download): void {
    void considerCandidate('browser download', async () => {
      const failure = await download.failure();
      if (failure) {
        throw new Error('Browser download failed.');
      }
      const stream = await download.createReadStream();
      if (!stream) {
        throw new Error('Browser download did not expose a readable stream.');
      }
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    });
  }

  function responseHandler(response: Response): void {
    if (!printStarted || !isPdfResponse(response, options.responseUrlHints)) return;
    void considerCandidate('PDF network response', async () => {
      const responsePage = response.frame().page();
      if (responsePage !== options.page && (await responsePage.opener()) !== options.page) {
        throw new Error('PDF response was not initiated by the Duke billing page.');
      }
      return Buffer.from(await response.body());
    });
  }

  function popupHandler(popup: Page): void {
    void considerCandidate('PDF popup', async () => {
      try {
        return await readPopupPdf(popup, options.context, options.timeoutMs);
      } finally {
        await popup.close().catch(() => undefined);
      }
    });
  }

  options.page.on('download', downloadHandler);
  options.page.on('popup', popupHandler);
  options.context.on('response', responseHandler);
  timeoutHandle = setTimeout(() => {
    if (!settled) {
      settled = true;
      cleanup();
      const suffix =
        candidateFailures.length > 0
          ? ` Invalid candidates observed from: ${[...new Set(candidateFailures)].join(', ')}.`
          : '';
      rejectResult(
        new Error(`Timed out waiting for Duke to produce a valid PDF.${suffix}`),
      );
    }
  }, options.timeoutMs);

  try {
    printStarted = true;
    await options.printAction.click({ timeout: options.timeoutMs, noWaitAfter: true });
    const contents = await result;
    await writeBufferAtomically(options.outputPath, contents);
    return options.outputPath;
  } catch (error) {
    if (!settled) {
      settled = true;
      cleanup();
    }
    throw error;
  } finally {
    cleanup();
  }
}

function isPdfResponse(response: Response, urlHints: readonly string[]): boolean {
  const headers = response.headers();
  const contentType = headers['content-type']?.toLowerCase() ?? '';
  const disposition = headers['content-disposition']?.toLowerCase() ?? '';
  if (contentType.includes('application/pdf') || disposition.includes('.pdf')) {
    return true;
  }

  const url = response.url().toLowerCase();
  return urlHints.some((hint) => url.includes(hint.toLowerCase()));
}

async function readPopupPdf(
  popup: Page,
  context: BrowserContext,
  timeoutMs: number,
): Promise<Buffer> {
  await popup
    .waitForURL((url) => url.protocol !== 'about:', { timeout: timeoutMs })
    .catch(() => undefined);
  const url = popup.url();

  if (url.startsWith('blob:')) {
    const base64 = await popup.evaluate(async () => {
      const response = await fetch(window.location.href, { credentials: 'include' });
      if (!response.ok) throw new Error('Blob PDF request failed.');
      const bytes = new Uint8Array(await response.arrayBuffer());
      const chunkSize = 32_768;
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
      }
      return btoa(binary);
    });
    return Buffer.from(base64, 'base64');
  }

  if (url.startsWith('data:application/pdf')) {
    const commaIndex = url.indexOf(',');
    if (commaIndex < 0) throw new Error('Malformed PDF data URL.');
    const metadata = url.slice(0, commaIndex);
    const payload = url.slice(commaIndex + 1);
    return metadata.includes(';base64')
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload), 'latin1');
  }

  const candidateUrl = extractHttpPdfUrl(url);
  if (!candidateUrl) {
    throw new Error('Popup did not expose an authenticated HTTP or blob PDF URL.');
  }
  const response = await context.request.get(candidateUrl, { timeout: timeoutMs });
  return bodyFromApiResponse(response);
}

function extractHttpPdfUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    const embedded = parsed.searchParams.get('file') ?? parsed.searchParams.get('url');
    if (embedded) {
      // URLSearchParams.get() has already decoded the parameter once. A second
      // decode can corrupt percent signs in signed, temporary URLs.
      try {
        const embeddedUrl = new URL(embedded);
        if (embeddedUrl.protocol === 'http:' || embeddedUrl.protocol === 'https:') {
          return embeddedUrl.toString();
        }
      } catch {
        // Ignore a non-URL viewer parameter and try the popup URL itself.
      }
    }
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString();
    }
  } catch {
    return null;
  }
  return null;
}

async function bodyFromApiResponse(response: APIResponse): Promise<Buffer> {
  if (!response.ok()) {
    throw new Error(`Authenticated PDF request returned HTTP ${response.status()}.`);
  }
  return Buffer.from(await response.body());
}
