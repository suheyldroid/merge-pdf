import fs from "node:fs";
import { inflate } from "pako";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
} from "pdf-lib";

const pdfPath = process.argv[2];
const pageIndex = parseInt(process.argv[3] || "0");

if (!pdfPath) {
  console.log("Kullanım: bun run debug-pdf.ts <pdf-dosyası> [sayfa-index]");
  process.exit(1);
}

const bytes = fs.readFileSync(pdfPath);
const doc = await PDFDocument.load(bytes);
const page = doc.getPage(pageIndex);

console.log(`\n=== PDF: ${pdfPath} ===`);
console.log(`Toplam sayfa: ${doc.getPageCount()}`);
console.log(`İncelenen sayfa: ${pageIndex}`);
console.log(`Sayfa boyutu: ${page.getWidth()} x ${page.getHeight()}`);

// --- Sayfa Content Stream ---
console.log("\n--- SAYFA CONTENT STREAM ---");
const contentsRef = page.node.get(PDFName.of("Contents"));
if (contentsRef) {
  const resolveStream = (streamObj: any, label: string) => {
    if (streamObj instanceof PDFRawStream) {
      const filterObj = streamObj.dict.get(PDFName.of("Filter"));
      const filterName = filterObj ? (filterObj as PDFName).asString() : "none";
      let decoded: Uint8Array;
      if (filterName === "/FlateDecode") {
        decoded = inflate(streamObj.contents);
      } else {
        decoded = streamObj.contents;
      }
      const text = new TextDecoder().decode(decoded);
      console.log(`\n[${label}] Filter: ${filterName}, Length: ${text.length} chars`);
      // İlk 2000 karakter
      console.log(text.substring(0, 2000));
      if (text.length > 2000) console.log(`... (${text.length - 2000} karakter daha)`);
    }
  };

  const contentsObj = page.node.context.lookup(contentsRef as PDFRef);
  if (contentsObj instanceof PDFArray) {
    console.log(`Content stream: PDFArray (${contentsObj.size()} eleman)`);
    for (let i = 0; i < contentsObj.size(); i++) {
      const ref = contentsObj.get(i);
      const stream = page.node.context.lookup(ref as PDFRef);
      resolveStream(stream, `ContentStream[${i}]`);
    }
  } else {
    console.log("Content stream: Tek stream");
    resolveStream(contentsObj, "ContentStream");
  }
}

// --- Resources ---
console.log("\n--- RESOURCES ---");
const resourcesRef = page.node.get(PDFName.of("Resources"));
if (!resourcesRef) {
  console.log("Resources bulunamadı!");
  process.exit(0);
}

const resourcesDict = page.node.context.lookupMaybe(resourcesRef, PDFDict) as PDFDict | undefined;
if (!resourcesDict) {
  console.log("Resources dict çözülemedi!");
  process.exit(0);
}

console.log("Resource anahtarları:", resourcesDict.entries().map(([k]) => (k as PDFName).asString()));

// --- XObject ---
const xObjectRef = resourcesDict.get(PDFName.of("XObject"));
if (!xObjectRef) {
  console.log("\nXObject dict bulunamadı! Arka plan doğrudan content stream'de olabilir.");
  process.exit(0);
}

const xObjectDict = page.node.context.lookupMaybe(xObjectRef, PDFDict) as PDFDict | undefined;
if (!xObjectDict) {
  console.log("XObject dict çözülemedi!");
  process.exit(0);
}

console.log("\n--- XOBJECT ENTRIES ---");
const entries = xObjectDict.entries();
for (const [name, ref] of entries) {
  const nameStr = (name as PDFName).asString();
  const xObj = page.node.context.lookup(ref as PDFRef);

  if (xObj instanceof PDFRawStream) {
    const subtype = xObj.dict.get(PDFName.of("Subtype"));
    const subtypeStr = subtype ? (subtype as PDFName).asString() : "yok";
    const filterObj = xObj.dict.get(PDFName.of("Filter"));
    const filterName = filterObj ? (filterObj as PDFName).asString() : "none";

    console.log(`\n${nameStr}: Subtype=${subtypeStr}, Filter=${filterName}`);
    console.log(`  Dict keys: ${xObj.dict.entries().map(([k]) => (k as PDFName).asString())}`);

    if (subtypeStr === "/Form") {
      let decoded: Uint8Array;
      if (filterName === "/FlateDecode") {
        decoded = inflate(xObj.contents);
      } else {
        decoded = xObj.contents;
      }
      const content = new TextDecoder().decode(decoded);
      console.log(`  Content (${content.length} chars):`);
      console.log(content.substring(0, 1500));
      if (content.length > 1500) console.log(`  ... (${content.length - 1500} karakter daha)`);
    } else {
      console.log(`  (${subtypeStr} - content gösterilmedi)`);
    }
  } else {
    console.log(`${nameStr}: ${xObj?.constructor?.name || "bilinmeyen tür"}`);
  }
}
