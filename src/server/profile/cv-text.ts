import mammoth from 'mammoth';
import WordExtractor from 'word-extractor';
import { extractText, getDocumentProxy } from 'unpdf';

export const MAX_CV_BYTES = 10 * 1024 * 1024;
/** A CV is a few pages; a document far longer is not one, and reading it would only cost time. */
export const MAX_PDF_PAGES = 30;
/** A Word CV unpacks to well under a megabyte of text and images; more means a zip bomb or not a CV. */
const MAX_DOCX_UNPACKED_BYTES = 40 * 1024 * 1024;
const MAX_DOCX_ENTRIES = 1000;
export type CvType = 'pdf' | 'docx' | 'doc';
export const CV_MIME: Record<CvType, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
};

export class UnsupportedCvTypeError extends Error {
  override name = 'UnsupportedCvTypeError';
  constructor() {
    super('Unsupported file. Please upload your CV as a PDF or Word (.docx or .doc) file.');
  }
}
export class CvTooLargeError extends Error {
  override name = 'CvTooLargeError';
  constructor(message = `The file is larger than ${MAX_CV_BYTES / 1024 / 1024} MB.`) {
    super(message);
  }
}
export class TooManyPagesError extends Error {
  override name = 'TooManyPagesError';
  constructor(pages: number) {
    super(`This PDF has ${pages} pages. Upload just your CV (usually 1–4 pages).`);
  }
}
export class NoTextError extends Error {
  override name = 'NoTextError';
  constructor() {
    super('No text could be read from this CV. It may be a scanned image; please upload a text-based PDF or a .docx file.');
  }
}

const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const WORD_STREAM = Buffer.from('WordDocument', 'utf16le');

/** Identifies the file type from its content (never trust the file name). */
export function sniffCvType(buf: Buffer): CvType | null {
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  // DOCX = ZIP container whose entries include the word/ directory.
  if (buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    return buf.includes('word/') ? 'docx' : null;
  }
  // Old .doc = OLE container; Excel and PowerPoint use the same one, only Word has a "WordDocument" stream.
  if (buf.subarray(0, 8).equals(OLE_MAGIC)) return buf.includes(WORD_STREAM) ? 'doc' : null;
  return null;
}

/**
 * What a ZIP (docx) would unpack to, from its central directory alone (nothing is unpacked). Unreadable or ZIP64
 * archives count as too large: a CV never needs them.
 */
export function zipUnpackedSize(buf: Buffer): { bytes: number; entries: number } {
  const tooLarge = { bytes: Number.POSITIVE_INFINITY, entries: 0 };
  const from = Math.max(0, buf.length - 22 - 65_535);
  let eocd = -1;
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return tooLarge;
  const entries = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  let bytes = 0;
  for (let n = 0; n < entries; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return tooLarge;
    const size = buf.readUInt32LE(p + 24);
    if (size === 0xffffffff) return tooLarge;
    bytes += size;
    p += 46 + buf.readUInt16LE(p + 28) + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return { bytes, entries };
}

function normalize(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function extractCvText(buf: Buffer): Promise<{ type: CvType; text: string }> {
  if (buf.length > MAX_CV_BYTES) throw new CvTooLargeError();
  const type = sniffCvType(buf);
  if (!type) throw new UnsupportedCvTypeError();

  let raw: string;
  if (type === 'pdf') {
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    try {
      if (pdf.numPages > MAX_PDF_PAGES) throw new TooManyPagesError(pdf.numPages);
      const { text } = await extractText(pdf, { mergePages: false });
      raw = text.join('\n');
    } finally {
      await pdf.loadingTask.destroy().catch(() => {});
    }
  } else if (type === 'doc') {
    raw = (await new WordExtractor().extract(buf)).getBody();
  } else {
    const unpacked = zipUnpackedSize(buf);
    if (unpacked.bytes > MAX_DOCX_UNPACKED_BYTES || unpacked.entries > MAX_DOCX_ENTRIES) throw new CvTooLargeError('This Word file unpacks to far more than a CV would. Save it again as .docx or PDF and upload that.');
    raw = (await mammoth.extractRawText({ buffer: buf })).value;
  }
  const text = normalize(raw);
  if (text.replace(/\s/g, '').length < 20) throw new NoTextError();
  return { type, text };
}
