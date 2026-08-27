import { deflate, inflate } from "pako";
import { PDFDict, PDFName, PDFPage, PDFRawStream, PDFRef } from "pdf-lib";

/**
 * Content stream metninden beyaz arka plan dikdörtgenlerini kaldırır.
 *
 * Tespit edilen pattern:
 * ```
 * q
 * /gs0 gs
 * 1 1 1 rg /a0 gs       <- beyaz renk ayarlama
 * 0 0 1240 1753 re f     <- tam sayfa dikdörtgen doldurma
 * 0 0 1240 1753 re f     <- (tekrarlar olabilir)
 * ```
 *
 * Strateji: Satır bazlı işle. Beyaz renk satırını bul,
 * ardından gelen "re f" satırlarını kaldır.
 */
function removeWhiteBackgroundRects(content: string): string {
  const lines = content.split("\n");
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();

    // "1 1 1 rg" veya "1 g" pattern'ı: beyaz renk ayarlama
    const isWhiteRgb = /^1\s+1\s+1\s+rg\b/.test(line);
    const isWhiteGray = /^1\s+g\b/.test(line) && line.match(/^1\s+g(\s|$)/);

    if (isWhiteRgb || isWhiteGray) {
      // Satırın geri kalanında ek operatörler olabilir (örn: "1 1 1 rg /a0 gs")
      // Beyaz renk ayarını ve ardından gelen tam sayfa re f satırlarını topla
      const colorParts = line;

      // Sonraki satırları kontrol et - tam sayfa re f ise kaldır
      let j = i + 1;
      const refsToRemove: number[] = [];

      while (j < lines.length) {
        const nextLine = lines[j].trim();
        // "0 0 W H re f" pattern'ı - tam sayfa dikdörtgen
        const reMatch = nextLine.match(
          /^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+re\s+f\*?\s*$/
        );
        if (reMatch) {
          const x = parseFloat(reMatch[1]);
          const y = parseFloat(reMatch[2]);
          const w = parseFloat(reMatch[3]);
          const h = parseFloat(reMatch[4]);

          // Sadece tam sayfa kaplayan (origin'den başlayan, büyük alan) dikdörtgenleri kaldır
          if (x === 0 && y === 0 && w > 100 && h > 100) {
            refsToRemove.push(j);
            j++;
            continue;
          }
        }
        break;
      }

      if (refsToRemove.length > 0) {
        // Beyaz renk satırını da kaldırmamız lazım, ama satırda başka operatörler olabilir
        // Örn: "1 1 1 rg /a0 gs" -> sadece "1 1 1 rg" kısmını kaldır, "/a0 gs" kalsın
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

        // re f satırlarını atla
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
 * Bir sayfanın Form XObject content stream'inden beyaz arka plan dikdörtgenlerini kaldırır.
 *
 * Pure function: Sadece verilen PDFPage üzerinde çalışır, başka bir yan etkisi yoktur.
 *
 * PDF yapısı: Sayfa -> Content Stream -> Form XObject referansı (/x7 Do)
 * Form XObject'in content stream'i şu pattern'ı içerir:
 *   1 1 1 rg /a0 gs
 *   0 0 W H re f        <- tam sayfa beyaz dikdörtgen
 *
 * Bu fonksiyon Form XObject'in stream'ini decode eder, beyaz arka plan satırlarını
 * kaldırır ve yeni bir stream olarak geri yazar.
 */
export function removePageBackground(page: PDFPage): void {
  // Sayfa Resources -> XObject dict'ini bul
  const resourcesRef = page.node.get(PDFName.of("Resources"));
  if (!resourcesRef) return;

  const resourcesDict = page.node.context.lookupMaybe(
    resourcesRef,
    PDFDict
  ) as PDFDict | undefined;
  if (!resourcesDict) return;

  const xObjectRef = resourcesDict.get(PDFName.of("XObject"));
  if (!xObjectRef) return;

  const xObjectDict = page.node.context.lookupMaybe(
    xObjectRef,
    PDFDict
  ) as PDFDict | undefined;
  if (!xObjectDict) return;

  // XObject dict'teki tüm Form XObject'leri tara
  const entries = xObjectDict.entries();
  for (const [name, ref] of entries) {
    const xObj = page.node.context.lookup(ref as PDFRef);
    if (!(xObj instanceof PDFRawStream)) continue;

    const subtype = xObj.dict.get(PDFName.of("Subtype"));
    if (!subtype || (subtype as PDFName).asString() !== "/Form") continue;

    // Form XObject'in content stream'ini decode et
    const filterObj = xObj.dict.get(PDFName.of("Filter"));
    const filterName = filterObj ? (filterObj as PDFName).asString() : "none";

    let decoded: Uint8Array;
    if (filterName === "/FlateDecode") {
      decoded = inflate(xObj.contents);
    } else {
      decoded = xObj.contents;
    }

    const content = new TextDecoder().decode(decoded);

    // Beyaz arka plan pattern'larını kaldır:
    // Pattern 1: "1 1 1 rg" (RGB beyaz) ardından gelen "X Y W H re f" satırları
    // Pattern 2: "1 g" (grayscale beyaz) ardından gelen "X Y W H re f" satırları
    const cleaned = removeWhiteBackgroundRects(content);

    if (cleaned === content) continue; // Değişiklik yoksa devam et

    // Yeni stream'i oluştur ve geri yaz
    const newBytes = new TextEncoder().encode(cleaned);

    // Mevcut stream'i güncelle - yeni PDFRawStream oluştur
    const newStream = page.node.context.flateStream(newBytes, {});

    // Mevcut XObject dict entry'sini yeni stream ile güncelle
    // dict'teki diğer özellikleri kopyala
    const newStreamDict = (newStream as any).dict as PDFDict;
    // Orijinal dict'ten gerekli alanları kopyala
    for (const [key, val] of xObj.dict.entries()) {
      const keyStr = (key as PDFName).asString();
      if (
        keyStr !== "/Filter" &&
        keyStr !== "/Length" &&
        keyStr !== "/DecodeParms"
      ) {
        newStreamDict.set(key as PDFName, val);
      }
    }

    // Yeni stream'i register et ve XObject dict'te güncelle
    const newRef = page.node.context.register(newStream);
    xObjectDict.set(name as PDFName, newRef);

    console.log(
      `  Arka plan kaldırıldı: ${(name as PDFName).asString()} (${content.length} -> ${cleaned.length} chars)`
    );
  }
}
