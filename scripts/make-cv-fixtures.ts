/**
 * Regenerates binary CV fixtures (PDF/DOCX) from the synthetic CV texts.
 * Run: pnpm exec tsx scripts/make-cv-fixtures.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Document, Packer, Paragraph } from 'docx';
import { chromium } from '@playwright/test';
import { SYNTHETIC_CVS } from '../tests/fixtures/cvs/synthetic';

const OUT = path.resolve('tests/fixtures/cvs/files');
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const cv of SYNTHETIC_CVS) {
    const html = cv.text
      .split('\n')
      .map((l) => `<p style="margin:0 0 4px;font:12px Arial">${escape(l) || '&nbsp;'}</p>`)
      .join('');
    await page.setContent(`<html><body>${html}</body></html>`);
    writeFileSync(path.join(OUT, `${cv.slug}.pdf`), await page.pdf({ format: 'A4' }));

    const doc = new Document({ sections: [{ children: cv.text.split('\n').map((l) => new Paragraph(l)) }] });
    writeFileSync(path.join(OUT, `${cv.slug}.docx`), await Packer.toBuffer(doc));
  }
  // A "scanned" CV: text rendered to an image, embedded in a PDF with no text layer.
  await page.setContent(`<html><body style="margin:0"><p style="font:16px Arial;padding:20px">Scanned CV — Image Only</p></body></html>`);
  const png = await page.screenshot({ clip: { x: 0, y: 0, width: 400, height: 80 } });
  await page.setContent(`<html><body><img src="data:image/png;base64,${png.toString('base64')}"></body></html>`);
  writeFileSync(path.join(OUT, 'image-only.pdf'), await page.pdf({ format: 'A4' }));
  await browser.close();
  console.log(`Wrote fixtures to ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
