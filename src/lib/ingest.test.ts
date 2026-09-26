import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { ingestBuffer } from "./books";
import { parseEpub } from "./ingest";
import { parsePdf } from "./pdf-layout";

async function difficultEpub(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/package.opf"/></rootfiles></container>`,
  );
  zip.file(
    "OEBPS/package.opf",
    `<?xml version="1.0"?>
      <package xmlns:dc="http://purl.org/dc/elements/1.1/">
        <metadata><dc:title>Odd &amp; Difficult</dc:title><dc:creator>A. Tester</dc:creator></metadata>
        <manifest>
          <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
          <item id="chapter" href="Text/chapter%201.xhtml" media-type="application/xhtml+xml"/>
        </manifest>
        <spine><itemref idref="cover"/><itemref idref="missing"/><itemref idref="chapter"/></spine>
      </package>`,
  );
  zip.file("OEBPS/cover.xhtml", "<html><body><p>Cover</p></body></html>");
  zip.file(
    "OEBPS/Text/chapter 1.xhtml",
    `<html><body><h1>Opening</h1><p>This chapter has enough readable prose to survive the short-page filter, even with an encoded path.</p><script>alert('no')</script></body></html>`,
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/** A dependency-free, valid multi-page PDF fixture with one text run per page. */
function manyPagePdf(pageCount: number, paddingBytes = 0): Buffer {
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };
  const catalog = add("<< /Type /Catalog /Pages 2 0 R >>");
  assert.equal(catalog, 1);
  add(""); // pages tree, filled after page object ids are known
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pageIds: number[] = [];

  for (let page = 1; page <= pageCount; page++) {
    const pageId = objects.length + 1;
    const contentId = pageId + 1;
    pageIds.push(pageId);
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${contentId} 0 R >>`);
    const line = `BT /F1 12 Tf 72 720 Td (Page ${page}: a long document still needs stable extraction and pagination.) Tj ET`;
    add(`<< /Length ${Buffer.byteLength(line)} >>\nstream\n${line}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Count ${pageCount} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`;

  // A legal PDF comment makes the fixture realistically large without hiding
  // the behavior under test behind a binary fixture checked into the repo.
  let pdf = `%PDF-1.4\n%${"x".repeat(paddingBytes)}\n`;
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

test("a difficult EPUB follows its encoded spine, skips missing items, and sanitizes markup", async () => {
  const book = await parseEpub(await difficultEpub());
  assert.equal(book.title, "Odd & Difficult");
  assert.equal(book.author, "A. Tester");
  assert.equal(book.chapters.length, 1);
  assert.equal(book.chapters[0].title, "Opening");
  assert.match(book.chapters[0].html, /stable|readable prose/);
  assert.doesNotMatch(book.chapters[0].html, /script|alert/);
});

test("a large multi-page PDF is extracted without dropping later pages", async () => {
  const fixture = manyPagePdf(180, 3 * 1024 * 1024);
  assert.ok(fixture.byteLength > 3 * 1024 * 1024);
  assert.ok(fixture.byteLength < 4 * 1024 * 1024);
  const book = await parsePdf(fixture, "Long PDF");
  const html = book.chapters.map((chapter) => chapter.html).join("\n");
  assert.equal(book.title, "Long PDF");
  assert.match(html, /Page 1:/);
  assert.match(html, /Page 180:/);
  assert.ok(html.length > 8_000);
});

test("malformed and disguised documents fail with actionable errors", async () => {
  await assert.rejects(parseEpub(Buffer.from("not a zip")), /zip|central directory|valid EPUB/i);
  await assert.rejects(ingestBuffer(Buffer.from("not a pdf"), "broken.pdf"), /damaged|valid PDF/i);
  await assert.rejects(ingestBuffer(Buffer.from([0xff, 0xfe, 0x00]), "notes.txt"), /UTF-8|binary/i);
  await assert.rejects(ingestBuffer(Buffer.from("hello"), "book.docx"), /Unsupported file type/);
});
