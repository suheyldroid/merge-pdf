import { inflate } from "pako";
import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFPage,
  PDFRawStream,
  PDFRef,
} from "pdf-lib";

/**
 * PDFRawStream'i decode edip text olarak döndürür.
 */
function decodeStream(stream: PDFRawStream): string {
  const filterObj = stream.dict.get(PDFName.of("Filter"));
  const filterName = filterObj ? (filterObj as PDFName).asString() : "none";

  let decoded: Uint8Array;
  if (filterName === "/FlateDecode") {
    decoded = inflate(stream.contents);
  } else {
    decoded = stream.contents;
  }
  return new TextDecoder().decode(decoded);
}

/**
 * Büyük beyaz dikdörtgen pattern'ını kontrol eder.
 * Origin'den (0,0) başlayan ve büyük alan kaplayan (w>100, h>100) dikdörtgenleri hedefler.
 */
function isFullPageRect(reMatch: RegExpMatchArray): boolean {
  const x = parseFloat(reMatch[1]);
  const y = parseFloat(reMatch[2]);
  const w = parseFloat(reMatch[3]);
  const h = parseFloat(reMatch[4]);
  return x === 0 && y === 0 && w > 100 && h > 100;
}

const RE_RECT =
  /^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+re\s*$/;
const RE_RECT_FILL =
  /^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+re\s+f\*?\s*$/;

/**
 * Content stream metninden beyaz arka plan dikdörtgenlerini kaldırır.
 *
 * Desteklenen pattern'lar:
 *
 * Pattern A (re f aynı satırda):
 *   1 1 1 rg /a0 gs
 *   0 0 W H re f
 *
 * Pattern B (re ve f ayrı satırlarda, CachyOS tarzı):
 *   1 1 1 rg
 *   0 0 W H re
 *   W
 *   n
 *   0 0 W H re
 *   f
 */
function removeWhiteBackgroundRects(content: string): string {
  const lines = content.split("\n");
  const result: string[] = [];
  const skipSet = new Set<number>();
  let i = 0;

  while (i < lines.length) {
    if (skipSet.has(i)) {
      i++;
      continue;
    }

    const line = lines[i].trim();

    // "1 1 1 rg" veya "1 g" pattern'ı: beyaz renk ayarlama
    const isWhiteRgb = /^1\s+1\s+1\s+rg\b/.test(line);
    const isWhiteGray = /^1\s+g\b/.test(line) && line.match(/^1\s+g(\s|$)/);

    if (isWhiteRgb || isWhiteGray) {
      let j = i + 1;
      const indicesToRemove: number[] = [];

      while (j < lines.length) {
        const nextLine = lines[j].trim();

        // Pattern A: "X Y W H re f" tek satırda
        const reFMatch = nextLine.match(RE_RECT_FILL);
        if (reFMatch && isFullPageRect(reFMatch)) {
          indicesToRemove.push(j);
          j++;
          continue;
        }

        // Pattern B: "X Y W H re" tek başına (ardından W/n/re/f gelecek)
        const reOnlyMatch = nextLine.match(RE_RECT);
        if (reOnlyMatch && isFullPageRect(reOnlyMatch)) {
          // İleriye bak: W, n, tekrar re, f pattern'ı
          const blockStart = j;
          const blockIndices: number[] = [j];
          let k = j + 1;
          let foundFill = false;

          while (k < lines.length) {
            const kLine = lines[k].trim();

            // Clipping operatörleri: W, W*, n
            if (kLine === "W" || kLine === "W*" || kLine === "n") {
              blockIndices.push(k);
              k++;
              continue;
            }

            // Tekrar eden rect tanımı
            const reAgain = kLine.match(RE_RECT);
            if (reAgain && isFullPageRect(reAgain)) {
              blockIndices.push(k);
              k++;
              continue;
            }

            // Fill operatörü: f veya f*
            if (kLine === "f" || kLine === "f*") {
              blockIndices.push(k);
              foundFill = true;
              k++;
              break;
            }

            break;
          }

          if (foundFill) {
            indicesToRemove.push(...blockIndices);
            j = k;
            continue;
          }
          // Fill bulamadıysak bu re satırını atla, normal devam et
        }

        break;
      }

      if (indicesToRemove.length > 0) {
        // Beyaz renk satırından renk kısmını kaldır, varsa diğer operatörleri koru
        if (isWhiteRgb) {
          const remaining = line.replace(/1\s+1\s+1\s+rg\s*/, "").trim();
          if (remaining) {
            result.push(remaining);
          }
        } else if (isWhiteGray) {
          const remaining = line.replace(/1\s+g\s*/, "").trim();
          if (remaining) {
            result.push(remaining);
          }
        }

        // Kaldırılacak satırları işaretle
        for (const idx of indicesToRemove) {
          skipSet.add(idx);
        }

        i = j;
        continue;
      }
    }

    result.push(lines[i]);
    i++;
  }

  return result.join("\n");
}

/**
 * Tek bir PDFRawStream'in içeriğini temizler ve gerekirse yeni stream ile değiştirir.
 * @returns Yeni stream'in PDFRef'i veya değişiklik yoksa null
 */
function cleanStream(
  stream: PDFRawStream,
  context: PDFPage["node"]["context"],
  label: string
): PDFRef | null {
  const content = decodeStream(stream);
  const cleaned = removeWhiteBackgroundRects(content);

  if (cleaned === content) return null;

  const newBytes = new TextEncoder().encode(cleaned);
  const newStream = context.flateStream(newBytes, {});

  // Orijinal dict'ten gerekli alanları kopyala
  const newStreamDict = (newStream as any).dict as PDFDict;
  for (const [key, val] of stream.dict.entries()) {
    const keyStr = (key as PDFName).asString();
    if (
      keyStr !== "/Filter" &&
      keyStr !== "/Length" &&
      keyStr !== "/DecodeParms"
    ) {
      newStreamDict.set(key as PDFName, val);
    }
  }

  const newRef = context.register(newStream);
  console.log(
    `  Arka plan kaldırıldı: ${label} (${content.length} -> ${cleaned.length} chars)`
  );
  return newRef;
}

/**
 * Bir sayfanın beyaz arka plan dikdörtgenlerini kaldırır.
 *
 * Pure function: Sadece verilen PDFPage üzerinde çalışır.
 *
 * İki farklı PDF yapısını destekler:
 * 1. Form XObject içindeki arka plan (orijinal yapı)
 * 2. Doğrudan sayfa content stream'indeki arka plan (CachyOS tarzı)
 */
export function removePageBackground(page: PDFPage): void {
  const context = page.node.context;

  // --- 1. Sayfa Content Stream'ini işle ---
  const contentsEntry = page.node.get(PDFName.of("Contents"));
  if (contentsEntry) {
    const contentsObj = context.lookup(contentsEntry as PDFRef);

    if (contentsObj instanceof PDFRawStream) {
      // Tek content stream
      const newRef = cleanStream(contentsObj, context, "ContentStream");
      if (newRef) {
        page.node.set(PDFName.of("Contents"), newRef);
      }
    } else if (contentsObj instanceof PDFArray) {
      // Birden fazla content stream
      for (let i = 0; i < contentsObj.size(); i++) {
        const ref = contentsObj.get(i) as PDFRef;
        const stream = context.lookup(ref);
        if (stream instanceof PDFRawStream) {
          const newRef = cleanStream(stream, context, `ContentStream[${i}]`);
          if (newRef) {
            contentsObj.set(i, newRef);
          }
        }
      }
    }
  }

  // --- 2. Form XObject'leri işle ---
  const resourcesRef = page.node.get(PDFName.of("Resources"));
  if (!resourcesRef) return;

  const resourcesDict = context.lookupMaybe(
    resourcesRef,
    PDFDict
  ) as PDFDict | undefined;
  if (!resourcesDict) return;

  const xObjectRef = resourcesDict.get(PDFName.of("XObject"));
  if (!xObjectRef) return;

  const xObjectDict = context.lookupMaybe(
    xObjectRef,
    PDFDict
  ) as PDFDict | undefined;
  if (!xObjectDict) return;

  for (const [name, ref] of xObjectDict.entries()) {
    const xObj = context.lookup(ref as PDFRef);
    if (!(xObj instanceof PDFRawStream)) continue;

    const subtype = xObj.dict.get(PDFName.of("Subtype"));
    if (!subtype || (subtype as PDFName).asString() !== "/Form") continue;

    const newRef = cleanStream(
      xObj,
      context,
      (name as PDFName).asString()
    );
    if (newRef) {
      xObjectDict.set(name as PDFName, newRef);
    }
  }
}
