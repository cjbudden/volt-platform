// ============================================================================
//  THE INVOICE AS A PDF (build queue B1-2).
//
//  A small PDF writer rather than a library: an invoice is a few lines of
//  text in one font, and PDF's built-in Helvetica needs nothing embedded. A4,
//  as many pages as the lines need, every page numbered. Text outside the
//  font's Latin range is shown as "?" rather than breaking the file.
// ============================================================================
import type { invoiceWithLines } from './index';

type Invoice = NonNullable<Awaited<ReturnType<typeof invoiceWithLines>>>;

const W = 595, H = 842, LEFT = 50, RIGHT = 545, ROWS_PER_PAGE = 34;

const pdfText = (s: string) => String(s).replace(/[^\x20-\x7e\xa0-\xff]/g, '?').replace(/[\\()]/g, (c) => `\\${c}`);
const money = (n: number) => `${n < 0 ? '-' : ''}${Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
// Helvetica is about half an em wide per character on average: enough to right-align figures.
const widthOf = (s: string, size: number) => s.length * size * 0.52;

export function invoicePdf(inv: Invoice, o: { accountName: string; issuer?: string }): Buffer {
  const issuer = o.issuer ?? (process.env.VOLT_BILLING_ISSUER || 'Volt Streaming');
  const rows = inv.lines.map((l) => [l.description, `${+l.quantity.toFixed(4)} ${l.unit}`, money(l.unitUsd), money(l.amountUsd)]);
  const pages: string[][] = [];
  for (let i = 0; i < Math.max(1, rows.length); i += ROWS_PER_PAGE) pages.push([]);

  const ops = (page: string[], text: string, x: number, y: number, size = 10, bold = false, align: 'l' | 'r' = 'l') => {
    const tx = align === 'r' ? x - widthOf(text, size) : x;
    page.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${tx.toFixed(1)} ${y} Td (${pdfText(text)}) Tj ET`);
  };
  pages.forEach((p, pi) => {
    let y = H - 60;
    ops(p, issuer, LEFT, y, 16, true);
    ops(p, `Invoice ${inv.number}`, RIGHT, y, 14, true, 'r');
    y -= 26;
    ops(p, `Billed to: ${o.accountName}`, LEFT, y);
    ops(p, `Period: ${inv.period}`, RIGHT, y, 10, false, 'r');
    y -= 14;
    ops(p, `Settled: ${inv.handling === 'contract' ? 'by contract, outside Volt' : 'card on file (Stripe)'}`, LEFT, y);
    ops(p, `Issued: ${new Date(inv.issuedAt).toISOString().slice(0, 10)}`, RIGHT, y, 10, false, 'r');
    y -= 14;
    ops(p, `Status: ${inv.status}${inv.paidReference ? ` (${inv.paidReference})` : ''}`, LEFT, y);
    ops(p, 'Currency: USD', RIGHT, y, 10, false, 'r');
    y -= 30;
    ops(p, 'Description', LEFT, y, 10, true); ops(p, 'Quantity', 360, y, 10, true, 'r'); ops(p, 'Unit price', 450, y, 10, true, 'r'); ops(p, 'Amount', RIGHT, y, 10, true, 'r');
    y -= 6; p.push(`${LEFT} ${y} m ${RIGHT} ${y} l S`); y -= 14;
    for (const r of rows.slice(pi * ROWS_PER_PAGE, (pi + 1) * ROWS_PER_PAGE)) {
      ops(p, r[0].length > 52 ? `${r[0].slice(0, 51)}...` : r[0], LEFT, y); ops(p, r[1], 360, y, 10, false, 'r'); ops(p, r[2], 450, y, 10, false, 'r'); ops(p, r[3], RIGHT, y, 10, false, 'r');
      y -= 16;
    }
    if (pi === pages.length - 1) {
      y -= 4; p.push(`330 ${y} m ${RIGHT} ${y} l S`); y -= 16;
      ops(p, 'Subtotal', 450, y, 10, false, 'r'); ops(p, money(inv.subtotalUsd), RIGHT, y, 10, false, 'r'); y -= 16;
      ops(p, `Tax (${+(inv.taxRate * 100).toFixed(2)}%)`, 450, y, 10, false, 'r'); ops(p, money(inv.taxUsd), RIGHT, y, 10, false, 'r'); y -= 18;
      ops(p, 'Total (USD)', 450, y, 11, true, 'r'); ops(p, money(inv.totalUsd), RIGHT, y, 11, true, 'r');
    }
    ops(p, `Page ${pi + 1} of ${pages.length}`, RIGHT, 40, 8, false, 'r');
  });

  // Objects: 1 catalog, 2 pages, 3 and 4 fonts, then a page and its content per page.
  const objs: string[] = [];
  const kids = pages.map((_, i) => `${5 + i * 2} 0 R`).join(' ');
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  pages.forEach((p, i) => {
    const stream = p.join('\n');
    objs[5 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`;
    objs[6 + i * 2] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
  });
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  for (let n = 1; n < objs.length; n++) {
    offsets[n] = Buffer.byteLength(out, 'latin1');
    out += `${n} 0 obj\n${objs[n]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objs.length; n++) out += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
