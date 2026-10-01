import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CvTooLargeError, extractCvText, MAX_CV_BYTES, MAX_PDF_PAGES, NoTextError, sniffCvType, UnsupportedCvTypeError } from './cv-text';

const fixture = (name: string) => readFileSync(path.resolve('tests/fixtures/cvs/files', name));

describe('sniffCvType', () => {
  it('recognises PDF and DOCX by content, not by file name', () => {
    expect(sniffCvType(fixture('nurse-uk.pdf'))).toBe('pdf');
    expect(sniffCvType(fixture('nurse-uk.docx'))).toBe('docx');
    expect(sniffCvType(Buffer.from('hello world'))).toBeNull();
    expect(sniffCvType(Buffer.from('PK\u0003\u0004 some zip without word'))).toBeNull();
  });
});

describe('extractCvText', () => {
  it('extracts text with line structure from a PDF', async () => {
    const { text, type } = await extractCvText(fixture('software-engineer-india.pdf'));
    expect(type).toBe('pdf');
    expect(text).toContain('asha.rao@example.com');
    expect(text).toMatch(/Asha Rao\s*\n/);
    expect(text).toContain('Fictional Labs Pvt Ltd');
  });

  it('extracts text from a DOCX', async () => {
    const { text, type } = await extractCvText(fixture('sales-manager-us.docx'));
    expect(type).toBe('docx');
    expect(text).toContain('marcus.delaney@example.net');
    expect(text).toMatch(/Regional Sales Manager\s*\n/);
  });

  it('rejects unsupported files', async () => {
    await expect(extractCvText(Buffer.from('just text'))).rejects.toBeInstanceOf(UnsupportedCvTypeError);
  });

  it('rejects files over the size limit before parsing', async () => {
    await expect(extractCvText(Buffer.alloc(MAX_CV_BYTES + 1))).rejects.toBeInstanceOf(CvTooLargeError);
  });

  it('explains when a PDF has no extractable text (scanned image)', async () => {
    await expect(extractCvText(fixture('image-only.pdf'))).rejects.toBeInstanceOf(NoTextError);
  });
});

/** A ZIP whose central directory claims `claimed` bytes for word/document.xml (the data itself is tiny). */
function zipClaiming(claimed: number): Buffer {
  const name = Buffer.from('word/document.xml');
  const data = Buffer.from('<w:document/>');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(claimed, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(claimed, 24);
  central.writeUInt16LE(name.length, 28);
  const cdOffset = local.length + name.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + name.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, name, data, central, name, eocd]);
}

/** A plain PDF with one line of text on each of `pages` pages. */
function pdfWithPages(pages: number): Buffer {
  const objects: string[] = [];
  const kids = Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(' ');
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (let i = 0; i < pages; i++) {
    const stream = `BT /F1 12 Tf 72 720 Td (Experience page ${i + 1} Backend Engineer at Example Payments) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

describe('limits on what a CV file may cost to read (M1 deferred minor)', () => {
  it('refuses a Word file that would unpack to far more than any CV (zip bomb), before unpacking it', async () => {
    const bomb = extractCvText(zipClaiming(500 * 1024 * 1024));
    await expect(bomb).rejects.toBeInstanceOf(CvTooLargeError);
    await expect(extractCvText(zipClaiming(500 * 1024 * 1024))).rejects.toThrow(/unpacks/);
  });

  it(`reads a normal PDF, and refuses one with more than ${MAX_PDF_PAGES} pages`, async () => {
    expect((await extractCvText(pdfWithPages(3))).text).toContain('Experience page 3');
    await expect(extractCvText(pdfWithPages(MAX_PDF_PAGES + 10))).rejects.toThrow(/pages/);
  });
});
