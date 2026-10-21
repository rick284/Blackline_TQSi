/**
 * The tender letter as a PDF: the same content the screen previews (`letterDoc`), laid out on A4 in black and white. Written with PDFKit using its built-in
 * Helvetica, so there are no fonts to ship. PDFKit does not flow tables across pages by itself, so rows are measured and a new page started (with the
 * schedule's headings repeated) when one would not fit.
 */
import PDFDocument from "pdfkit";
import type { LetterDoc } from "../letter.js";

const MARGIN = { top: 56, bottom: 64, left: 60, right: 60 };
const GREY = "#e6e6e6", LINE = "#9a9a9a";

export function letterPdf(doc: LetterDoc, o: { title?: string; compress?: boolean } = {}): Promise<Buffer> {
  const pdf = new PDFDocument({ size: "A4", margins: MARGIN, bufferPages: true, compress: o.compress ?? true, info: { Title: o.title ?? doc.subject, Author: doc.company, Producer: "Blackline" } });
  const chunks: Buffer[] = [];
  pdf.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => { pdf.on("end", () => resolve(Buffer.concat(chunks))); pdf.on("error", reject); });

  const left = MARGIN.left, width = pdf.page.width - MARGIN.left - MARGIN.right, bottom = () => pdf.page.height - MARGIN.bottom;
  const paragraphs = (text: string) => text.split(/\n+/).map((t) => t.trim()).filter(Boolean);
  const need = (h: number) => { if (pdf.y + h > bottom()) { pdf.addPage(); return true; } return false; };

  // ---- head
  pdf.font("Helvetica-Bold").fontSize(12).text(doc.company, left, MARGIN.top, { width: width * 0.6, continued: false });
  pdf.font("Helvetica").fontSize(10).text(doc.date, left, MARGIN.top, { width, align: "right" });
  pdf.moveDown(2);
  pdf.font("Helvetica").fontSize(10).text([doc.addressee, doc.attention && `Attention: ${doc.attention}`, doc.reference && `Your reference: ${doc.reference}`].filter(Boolean).join("\n"), left, pdf.y, { width });
  pdf.moveDown(1.2);
  pdf.font("Helvetica-Bold").fontSize(13).text(doc.subject, left, pdf.y, { width });
  pdf.moveDown(0.6);
  pdf.font("Helvetica").fontSize(10);
  for (const p of paragraphs(doc.opening)) { pdf.text(p, left, pdf.y, { width, lineGap: 2 }); pdf.moveDown(0.5); }

  // ---- price schedule
  const ref = 70, amt = 96, desc = width - ref - amt - 12;
  const heading = (text: string) => { need(60); pdf.moveDown(0.8); pdf.font("Helvetica-Bold").fontSize(9).text(text.toUpperCase(), left, pdf.y, { width, characterSpacing: 0.6 }); pdf.moveDown(0.4); pdf.font("Helvetica").fontSize(10); };
  const tableHead = () => {
    const y = pdf.y;
    pdf.rect(left, y, width, 17).fill(GREY);
    pdf.fillColor("black").font("Helvetica-Bold").fontSize(8.5);
    pdf.text("REF", left + 4, y + 5, { width: ref - 4, lineBreak: false });
    pdf.text("DESCRIPTION", left + ref + 4, y + 5, { width: desc, lineBreak: false });
    pdf.text("AMOUNT $", left + ref + desc + 12, y + 5, { width: amt - 4, align: "right", lineBreak: false });
    pdf.font("Helvetica").fontSize(10);
    pdf.y = y + 19;
  };
  const row = (r: string, d: string, a: string, style: { bold?: boolean; fill?: string; top?: boolean } = {}) => {
    pdf.font(style.bold ? "Helvetica-Bold" : "Helvetica").fontSize(9.5);
    const h = Math.max(pdf.heightOfString(d, { width: desc }), 12) + 5;
    if (need(h)) tableHead();
    const y = pdf.y;
    if (style.fill) pdf.rect(left, y - 1, width, h).fill(style.fill).fillColor("black");
    if (style.top) pdf.moveTo(left, y - 1).lineTo(left + width, y - 1).lineWidth(0.7).strokeColor("black").stroke();
    pdf.fillColor("black");
    pdf.text(r, left + 4, y + 2, { width: ref - 4, lineBreak: false });
    pdf.text(d, left + ref + 4, y + 2, { width: desc });
    pdf.text(a, left + ref + desc + 12, y + 2, { width: amt - 4, align: "right", lineBreak: false });
    pdf.moveTo(left, y + h - 1).lineTo(left + width, y + h - 1).lineWidth(0.3).strokeColor(LINE).stroke();
    pdf.y = y + h;
  };

  heading("Price schedule");
  tableHead();
  for (const g of doc.groups) {
    row("", g.name, "", { bold: true, fill: "#f2f2f2" });
    for (const l of g.lines) row(l.ref, l.trade, l.amount);
    if (doc.groups.length > 1) row("", `Total ${g.name}`, g.total, { bold: true, top: true });
  }
  row("", "Total tender price excluding GST", doc.total, { bold: true, top: true, fill: GREY });
  pdf.fillColor("black").font("Helvetica").fontSize(10);

  // ---- alternatives
  if (doc.alternatives.length) {
    heading("Alternatives");
    for (const a of doc.alternatives) {
      const price = a.amount ? `${a.saving ? "Saving" : "Add"} $${a.amount.replace("-", "")}` : "Price on request";
      const text = a.description ? `${a.title}: ${a.description}` : a.title;
      const h = Math.max(pdf.heightOfString(text, { width: width - 130 }), 12) + 4;
      need(h);
      const y = pdf.y;
      pdf.text(text, left, y, { width: width - 130 });
      pdf.text(price, left + width - 120, y, { width: 120, align: "right", lineBreak: false });
      pdf.y = y + h;
    }
  }

  // ---- qualifications
  if (doc.qualifications.length) {
    heading("Qualifications, exclusions and assumptions");
    doc.qualifications.forEach((text, i) => {
      const h = pdf.heightOfString(text, { width: width - 22, lineGap: 1 }) + 4;
      need(h);
      const y = pdf.y;
      pdf.text(`${i + 1}.`, left, y, { width: 18, lineBreak: false });
      pdf.text(text, left + 22, y, { width: width - 22, lineGap: 1 });
      pdf.y = y + h;
    });
  }

  // ---- close
  pdf.moveDown(0.8);
  need(120);
  if (doc.validity) { pdf.text(doc.validity, left, pdf.y, { width }); pdf.moveDown(0.5); }
  for (const p of paragraphs(doc.closing)) { pdf.text(p, left, pdf.y, { width, lineGap: 2 }); pdf.moveDown(0.5); }
  pdf.moveDown(0.5);
  pdf.text("Yours faithfully", left, pdf.y, { width });
  if (doc.signatory) pdf.moveDown(2.5).text(doc.signatory, left, pdf.y, { width }).text(doc.company, left, pdf.y, { width });
  else pdf.text(doc.company, left, pdf.y, { width });

  // ---- page numbers, once the pages are known
  const range = pdf.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    pdf.switchToPage(i);
    pdf.page.margins.bottom = 0; // otherwise text this low would start a new page
    pdf.font("Helvetica").fontSize(8).fillColor("#5c5c5c").text(`${doc.company}  ·  ${doc.subject}  ·  Page ${i + 1} of ${range.count}`, left, pdf.page.height - 40, { width, align: "center", lineBreak: false });
  }
  pdf.end();
  return done;
}
