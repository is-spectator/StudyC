import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const require = createRequire(import.meta.url);
const standardFontDataUrl = pathToFileURL(join(dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + '/').href;

export const PDF_MAX_PAGES = 30;
export const PDF_TEXT_MAX_BYTES = 1024 * 1024;
const parseTimeoutMs = 12_000;

export class PdfTimeoutError extends Error {
  constructor() { super('pdf_parse_timeout'); this.name = 'PdfTimeoutError'; }
}

export type PdfFailureCode = 'encrypted_pdf' | 'invalid_pdf' | 'no_extractable_text' | 'too_many_pages' | 'text_too_large';
export interface PdfPageText { number: number; text: string }
export interface PdfExtracted {
  pages: PdfPageText[];
  body: string;
  ranges: { page: number; start: number; end: number }[];
}
export type PdfExtractResult = { ok: true; value: PdfExtracted } | { ok: false; code: PdfFailureCode };

interface TextItem { str?: string; hasEOL?: boolean }

/** Drop NUL and lone surrogates. PostgreSQL text cannot store either, and neither is readable source text. */
export function cleanPdfText(value: string): string {
  let out = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0) continue;
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) { out += value.charAt(index) + value.charAt(index + 1); index += 1; }
      continue;
    }
    if (code >= 0xDC00 && code <= 0xDFFF) continue;
    out += value.charAt(index);
  }
  return out.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function pageText(items: TextItem[]): string {
  let text = '';
  for (const item of items) {
    if (typeof item.str === 'string') text += item.str;
    if (item.hasEOL) text += '\n';
  }
  return cleanPdfText(text).trim();
}

function assemble(pages: PdfPageText[]): PdfExtractResult {
  let body = '';
  const ranges: PdfExtracted['ranges'] = [];
  const readable = pages.filter(page => page.text.length > 0);
  if (!readable.length) return { ok: false, code: 'no_extractable_text' };
  for (const page of readable) {
    const chunk = `[第 ${page.number} 页]\n${page.text}`;
    if (body) body += '\n\n';
    const start = body.length;
    body += chunk;
    ranges.push({ page: page.number, start, end: body.length });
  }
  if (Buffer.byteLength(body, 'utf8') > PDF_TEXT_MAX_BYTES) return { ok: false, code: 'text_too_large' };
  return { ok: true, value: { pages: readable, body, ranges } };
}

/** Text operators only. A scanned or image-only PDF is a failure, not an empty success. */
export async function extractPdfText(data: Uint8Array): Promise<PdfExtractResult> {
  const task = getDocument({
    data, password: '', isEvalSupported: false, disableFontFace: true, useSystemFonts: false, standardFontDataUrl,
  });
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      void task.destroy().catch(() => undefined);
      reject(new PdfTimeoutError());
    }, parseTimeoutMs);
  });
  try {
    return await Promise.race([timeout, readDocument()]);
  } finally { clearTimeout(timer); }

  async function readDocument(): Promise<PdfExtractResult> {
    try {
      const document = await task.promise;
      try {
        if (document.numPages > PDF_MAX_PAGES) return { ok: false, code: 'too_many_pages' };
        const pages: PdfPageText[] = [];
        for (let number = 1; number <= document.numPages; number += 1) {
          const page = await document.getPage(number);
          try {
            const content = await page.getTextContent();
            pages.push({ number, text: pageText(content.items as TextItem[]) });
          } finally { page.cleanup(); }
        }
        return assemble(pages);
      } finally { await document.destroy(); }
    } catch (error) {
      if (timedOut || error instanceof PdfTimeoutError) throw new PdfTimeoutError();
      if (error instanceof Error && error.name === 'PasswordException') return { ok: false, code: 'encrypted_pdf' };
      return { ok: false, code: 'invalid_pdf' };
    }
  }
}
