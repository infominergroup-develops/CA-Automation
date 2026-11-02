import { createRequire } from 'node:module';
import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import type { ReportDoc } from './reports.ts';

const require = createRequire(import.meta.url);
const FONT = {
  regular: require.resolve('@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff'),
  bold: require.resolve('@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff'),
};
const INK = '#2d3e50', NAVY = '#1e293b', ORANGE = '#eb8a23', MUTED = '#64748b', LINE = '#e4e7ec', TINT = '#f5f6f8';

/** Indian grouping (12,34,567.89); negatives in brackets, as accountants expect. */
export function inr(n: number): string {
  const s = Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `(${s})` : s;
}
const cell = (v: string | number | null) => (v === null ? '' : typeof v === 'number' ? inr(v) : v);

export interface Viewer { name: string; firm: string; at: Date }

export function renderPdf(d: ReportDoc, viewer: Viewer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 48, bottom: 56, left: 44, right: 44 }, bufferPages: true,
      info: { Title: `${d.title} - ${d.company}`, Author: viewer.firm, Creator: `${viewer.firm} portal` } });
    doc.registerFont('r', FONT.regular);
    doc.registerFont('b', FONT.bold);
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const colX: number[] = [];
    d.columns.reduce((x, c) => { colX.push(x); return x + c.width * width; }, left);

    const header = () => {
      doc.rect(0, 0, doc.page.width, 6).fill(ORANGE);
      doc.font('b').fontSize(9).fillColor(MUTED).text(viewer.firm.toUpperCase(), left, 22, { characterSpacing: 1 });
      doc.font('b').fontSize(17).fillColor(INK).text(d.title, left, 36);
      doc.font('r').fontSize(10.5).fillColor(NAVY).text(d.company, left, doc.y + 2);
      doc.fillColor(MUTED).fontSize(9.5).text(d.period, left, doc.y + 1);
      if (d.provisional) {
        doc.font('b').fontSize(8).fillColor('#a85a0e');
        const w = doc.widthOfString('PROVISIONAL · UNAUDITED') + 14;
        doc.roundedRect(left + width - w, 38, w, 16, 3).fill('#fef6ec');
        doc.fillColor('#a85a0e').text('PROVISIONAL · UNAUDITED', left + width - w + 7, 42.5);
      }
      doc.y = Math.max(doc.y, 80) + 10;
      tableHead();
    };
    const tableHead = () => {
      const y = doc.y;
      doc.rect(left, y, width, 20).fill(NAVY);
      doc.font('b').fontSize(8).fillColor('#ffffff');
      d.columns.forEach((c, i) => doc.text(c.label.toUpperCase(), colX[i] + 6, y + 6.5, { width: c.width * width - 12, align: c.align, characterSpacing: 0.4 }));
      doc.y = y + 20;
    };

    header();
    let zebra = false;
    for (const row of d.rows) {
      const size = row.style === 'heading' || row.style === 'total' ? 9.5 : 9;
      doc.font(row.style && row.style !== 'muted' ? 'b' : 'r').fontSize(size);
      const indent = (row.indent ?? 0) * 12;
      const h = Math.max(...row.cells.map((v, i) => doc.heightOfString(cell(v), { width: d.columns[i].width * width - 12 - (i === 0 ? indent : 0) }))) + 9;
      if (doc.y + h > doc.page.height - doc.page.margins.bottom - 10) { doc.addPage(); header(); zebra = false; }
      const y = doc.y;
      if (row.style === 'total') { doc.rect(left, y, width, h).fill(TINT); doc.moveTo(left, y).lineTo(left + width, y).lineWidth(1).stroke(INK); }
      else if (row.style === 'subtotal') doc.rect(left, y, width, h).fill('#fef6ec');
      else if (row.style === 'heading') { /* no fill */ }
      else if (zebra) doc.rect(left, y, width, h).fill('#fbfbfc');
      zebra = !zebra;
      doc.fillColor(row.style === 'muted' ? MUTED : NAVY);
      row.cells.forEach((v, i) => {
        const neg = typeof v === 'number' && v < 0;
        doc.fillColor(neg ? '#b91c1c' : row.style === 'muted' ? MUTED : NAVY)
          .text(cell(v), colX[i] + 6 + (i === 0 ? indent : 0), y + 4.5, { width: d.columns[i].width * width - 12 - (i === 0 ? indent : 0), align: d.columns[i].align });
      });
      doc.moveTo(left, y + h).lineTo(left + width, y + h).lineWidth(0.5).stroke(LINE);
      doc.y = y + h;
    }

    if (d.notes?.length) {
      doc.moveDown(1);
      doc.font('b').fontSize(9).fillColor(INK).text('Notes', left);
      doc.font('r').fontSize(8.5).fillColor(MUTED);
      d.notes.forEach((n) => doc.text(`• ${n}`, left, doc.y + 2, { width }));
    }

    // Footer and watermark on every page.
    const range = doc.bufferedPageRange();
    const stamp = `Generated for ${viewer.name} on ${viewer.at.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST`;
    const asOf = `Tally data as of ${new Date(d.dataAsOf).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST`;
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      // Writing below the bottom margin would make pdfkit start a new page, so lift the margin for the footer.
      const margin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      const bottom = doc.page.height - 34;
      doc.save().rotate(-35, { origin: [doc.page.width / 2, doc.page.height / 2] })
        .font('b').fontSize(30).fillColor(INK).opacity(0.045)
        .text(viewer.name, 0, doc.page.height / 2 - 20, { width: doc.page.width, align: 'center', lineBreak: false }).restore();
      doc.opacity(1).moveTo(left, bottom - 6).lineTo(left + width, bottom - 6).lineWidth(0.5).stroke(LINE);
      doc.font('r').fontSize(7.5).fillColor(MUTED)
        .text(`${asOf} · ${stamp}${d.provisional ? ' · Provisional, subject to audit' : ''}`, left, bottom, { width: width - 60, lineBreak: false })
        .text(`Page ${i - range.start + 1} of ${range.count}`, left + width - 60, bottom, { width: 60, align: 'right', lineBreak: false });
      doc.page.margins.bottom = margin;
    }
    doc.end();
  });
}

export async function renderXlsx(d: ReportDoc, viewer: Viewer): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = viewer.firm;
  wb.created = viewer.at;
  const ws = wb.addWorksheet(d.title.slice(0, 31).replace(/[\\/?*[\]:]/g, ' '), { views: [{ state: 'frozen', ySplit: 6 }] });
  ws.columns = d.columns.map((c) => ({ width: Math.max(12, Math.round(c.width * 110)) }));
  const last = d.columns.length;
  const title = (r: number, text: string, opts: Partial<ExcelJS.Font> = {}) => {
    ws.mergeCells(r, 1, r, last);
    const c = ws.getCell(r, 1);
    c.value = text;
    c.font = { name: 'Calibri', ...opts };
  };
  title(1, viewer.firm, { size: 9, color: { argb: 'FF64748B' }, bold: true });
  title(2, d.title, { size: 15, bold: true, color: { argb: 'FF2D3E50' } });
  title(3, `${d.company} · ${d.period}`, { size: 11 });
  title(4, `Tally data as of ${new Date(d.dataAsOf).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST${d.provisional ? ' · PROVISIONAL, UNAUDITED' : ''}`, { size: 9, italic: true, color: { argb: 'FF64748B' } });
  const head = ws.getRow(6);
  d.columns.forEach((c, i) => {
    const h = head.getCell(i + 1);
    h.value = c.label;
    h.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
    h.alignment = { horizontal: c.align };
  });
  let r = 7;
  for (const row of d.rows) {
    const xr = ws.getRow(r++);
    row.cells.forEach((v, i) => {
      const c = xr.getCell(i + 1);
      c.value = v;
      if (typeof v === 'number') c.numFmt = '#,##0.00;[Red](#,##0.00)';
      c.alignment = { horizontal: d.columns[i].align, indent: i === 0 ? (row.indent ?? 0) : 0, wrapText: i === 0 };
      c.font = { bold: row.style === 'heading' || row.style === 'total' || row.style === 'subtotal', color: row.style === 'muted' ? { argb: 'FF64748B' } : undefined };
      if (row.style === 'total') {
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F6F8' } };
        c.border = { top: { style: 'thin', color: { argb: 'FF2D3E50' } } };
      }
    });
  }
  if (d.notes?.length) {
    r++;
    for (const n of d.notes) { ws.mergeCells(r, 1, r, last); ws.getCell(r++, 1).value = `Note: ${n}`; }
  }
  ws.mergeCells(r + 1, 1, r + 1, last);
  ws.getCell(r + 1, 1).value = `Generated for ${viewer.name} on ${viewer.at.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`;
  ws.getCell(r + 1, 1).font = { size: 8, color: { argb: 'FF94A3B8' } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}
