import fs from "node:fs";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { removePageBackground } from "./removePageBackground";


async function mergeFirstLast(pdfPaths: string[], outputPath: string) {
  const out = await PDFDocument.create();
  out.addPage()

  for (const p of pdfPaths) {
    const bytes = await Bun.file(p).arrayBuffer();
    const doc = await PDFDocument.load(bytes);



    const pageCount = doc.getPageCount();
    const pageIndices = doc.getPageIndices();


    // Sonraki PDF'ler: ilk sayfayı önceki PDF'in son sayfasının üzerine overlay yap
    // Önce tüm sayfaları kopyala
    const copiedPages = await out.copyPages(doc, pageIndices);

    // İlk sayfanın arka planını kaldır
    const firstCopiedPage = copiedPages.at(0);
    if (!firstCopiedPage) continue
    removePageBackground(firstCopiedPage);

    // İlk sayfayı embed edip önceki sayfanın üzerine çiz
    const embeddedFirstPage = await out.embedPage(firstCopiedPage);
    const lastPageOfOutput = out.getPage(out.getPageCount() - 1);
    lastPageOfOutput.drawPage(embeddedFirstPage);


    // Geri kalan sayfaları normal olarak ekle
    for (let p = 1; p < copiedPages.length; p++) {
      out.addPage(copiedPages[p]);
    }

  }



  const pdfBytes = await out.save();
  fs.writeFileSync(outputPath, pdfBytes);
  console.log(`\n${pdfPaths.length} PDF birleştirildi -> ${outputPath}`);
}

const folder = process.argv[2] || ".";
const output = process.argv[3] || "output.pdf";

const pdfs = fs
  .readdirSync(folder)
  .filter((f) => f.endsWith(".pdf") && f !== "output.pdf")
  .sort()
  .map((f) => path.join(folder, f));

if (pdfs.length === 0) {
  console.log("PDF bulunamadı!");
  process.exit(1);
}

console.log(
  `Bulunan PDF'ler: ${pdfs.map((p) => path.basename(p)).join(", ")}`
);
await mergeFirstLast(pdfs, output);
