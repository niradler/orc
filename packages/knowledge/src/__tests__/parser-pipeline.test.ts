import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import * as XLSX from "xlsx";
import { chunkBlocks } from "../chunker.js";
import { parseBasic } from "../parsers/basic.js";
import { KnowledgeStorage } from "../storage.js";

function pdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...["First page phoenix", "Second page lunar"].map((text) => {
      const stream = `BT /F1 12 Tf 30 700 Td (${text}) Tj ET`;
      return `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    }),
  ];
  let result = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(result.length);
    result += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = result.length;
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) result += `${String(offset).padStart(10, "0")} 00000 n \n`;
  return `${result}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

test("built-in formats preserve extractable text, checksums and page/sheet source references into chunks", async () => {
  const root = mkdtempSync(join(tmpdir(), "orc-parser-process-"));
  const workbook = XLSX.utils.book_new();
  for (const name of ["Inventory", "Recovery"])
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["Item", "Action"],
        ["phoenix", "verify checksum"],
      ]),
      name,
    );
  const docx = zipSync({
    "[Content_Types].xml": strToU8(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    "_rels/.rels": strToU8(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    "word/document.xml": strToU8(
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>phoenix recovery instructions</w:t></w:r></w:p></w:body></w:document>',
    ),
  });
  const pptx = zipSync(
    Object.fromEntries(
      [1, 2].map((page) => [
        `ppt/slides/slide${page}.xml`,
        strToU8(
          `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:sp><a:p><a:r><a:t>phoenix slide ${page}</a:t></a:r></a:p></p:sp></p:sld>`,
        ),
      ]),
    ),
  );
  const fixtures: [string, string | Uint8Array][] = [
    ["md", "# phoenix\n\nRecovery instructions."],
    ["txt", "phoenix text instructions"],
    ["html", "<h1>phoenix</h1><p>Recovery instructions</p>"],
    ["csv", "Item,Action\nphoenix,verify checksum\n"],
    ["xlsx", XLSX.write(workbook, { type: "buffer", bookType: "xlsx" })],
    ["docx", docx],
    ["pptx", pptx],
    ["pdf", pdf()],
  ];
  for (const [ext, content] of fixtures) {
    const path = join(root, `fixture.${ext}`);
    writeFileSync(path, content);
    const result = await parseBasic(path, ext);
    expect(result.status).not.toBe("failed");
    expect(result.source_sha256).toBe(KnowledgeStorage.sha256(content));
    const chunks = chunkBlocks(result.blocks);
    expect(chunks.map((c) => c.text).join("\n")).toContain("phoenix");
    if (ext === "pdf" || ext === "pptx")
      expect([...new Set(chunks.map((c) => c.locator?.page))]).toEqual([1, 2]);
    if (ext === "xlsx")
      expect([...new Set(chunks.map((c) => c.locator?.sheet))]).toEqual(["Inventory", "Recovery"]);
    expect(chunks.every((c) => c.text.length <= 2400)).toBe(true);
  }
});
