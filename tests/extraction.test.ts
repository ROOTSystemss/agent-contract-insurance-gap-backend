import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Document, Packer, Paragraph } from "docx";
import PDFDocument from "pdfkit";
import { afterAll, describe, expect, it } from "vitest";
import {
  evidenceExcerptIsExact,
  extractDocument,
  segmentText,
  validateDocumentFile,
} from "../src/documents/extraction.js";
import {
  EncryptedDocumentStorage,
  LocalDocumentStorage,
  sanitizeFilename,
} from "../src/documents/storage.js";

const tempPaths: string[] = [];

async function makePdf(text: string): Promise<Buffer> {
  return new Promise((resolve) => {
    const document = new PDFDocument({ autoFirstPage: true });
    const chunks: Buffer[] = [];
    document.on("data", (chunk: Buffer) => chunks.push(chunk));
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.text(text);
    document.end();
  });
}

afterAll(async () => {
  for (const target of tempPaths) await rm(target, { recursive: true, force: true });
});

describe("document extraction and storage", () => {
  it("extracts TXT and creates traceable exact segments", async () => {
    const source =
      "Authority to Act\n\nThe procurement agent may prepare purchase orders but requires human approval before commitment.";
    const result = await extractDocument(Buffer.from(source), ".txt");
    const segments = segmentText("org", "doc", result.text);
    expect(result.status).toBe("completed");
    expect(segments.length).toBeGreaterThan(0);
    expect(segments.every((segment) => evidenceExcerptIsExact(segment.originalText, source))).toBe(
      true,
    );
  });

  it("extracts a real DOCX fixture", async () => {
    const document = new Document({
      sections: [
        {
          children: [
            new Paragraph(
              "Professional services include software-supported procurement review and human approval.",
            ),
          ],
        },
      ],
    });
    const buffer = await Packer.toBuffer(document);
    validateDocumentFile(
      "sample.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer,
    );
    const result = await extractDocument(buffer, ".docx");
    expect(result.text).toContain("Professional services");
  });

  it("extracts text from a real PDF and flags an empty PDF for OCR", async () => {
    const textPdf = await makePdf(
      "Technology services and professional services are described for this fictional policy document.",
    );
    expect((await extractDocument(textPdf, ".pdf")).text).toContain("Technology services");
    const emptyPdf = await makePdf("");
    expect((await extractDocument(emptyPdf, ".pdf")).status).toBe("ocr_required");
  });

  it("rejects extension/MIME mismatches, binary text, and traversal", () => {
    expect(() =>
      validateDocumentFile("fake.pdf", "application/pdf", Buffer.from("not pdf")),
    ).toThrow("valid PDF");
    expect(() => validateDocumentFile("binary.txt", "text/plain", Buffer.from([1, 0, 2]))).toThrow(
      "binary",
    );
    expect(sanitizeFilename("../../secret contract.txt")).toBe("secret-contract.txt");
  });

  it("keeps storage inside its configured root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gap-storage-"));
    tempPaths.push(root);
    const storage = new LocalDocumentStorage(root);
    await storage.put("org/project/document.txt", Buffer.from("fictional"));
    expect(await readFile(path.join(root, "org", "project", "document.txt"), "utf8")).toBe(
      "fictional",
    );
    await expect(storage.put("../escape.txt", Buffer.from("bad"))).rejects.toThrow("storage key");
  });

  it("encrypts local documents and rejects authenticated-data tampering", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gap-encrypted-storage-"));
    tempPaths.push(root);
    const local = new LocalDocumentStorage(root);
    const storage = new EncryptedDocumentStorage(local, Buffer.alloc(32, 7));
    const storageKey = "org/project/encrypted.txt";
    const plaintext = Buffer.from("confidential fictional contract language");
    await storage.put(storageKey, plaintext);

    const target = path.join(root, "org", "project", "encrypted.txt");
    const raw = await readFile(target);
    expect(raw.includes(plaintext)).toBe(false);
    expect(await storage.get(storageKey)).toEqual(plaintext);

    raw[raw.length - 1] = raw[raw.length - 1]! ^ 1;
    await writeFile(target, raw);
    await expect(storage.get(storageKey)).rejects.toThrow("authentication failed");
  });
});
