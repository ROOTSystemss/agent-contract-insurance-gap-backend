import { randomUUID } from "node:crypto";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import type { ExtractionStatus, TextSegment } from "../domain/types.js";
import { AppError } from "../shared/errors.js";

export interface ExtractionResult {
  status: ExtractionStatus;
  text: string;
  pageCount: number | null;
  warnings: string[];
  error: string | null;
}

const allowed = {
  ".pdf": ["application/pdf"],
  ".docx": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ".txt": ["text/plain"],
} as const;

export function validateDocumentFile(
  filename: string,
  mimeType: string,
  buffer: Buffer,
): ".pdf" | ".docx" | ".txt" {
  const extension = filename.toLowerCase().match(/\.[^.]+$/)?.[0] as
    keyof typeof allowed | undefined;
  if (!extension || !(extension in allowed)) {
    throw new AppError(
      415,
      "UNSUPPORTED_FILE_TYPE",
      "Only PDF, DOCX, and TXT files are supported.",
    );
  }
  if (!(allowed[extension] as readonly string[]).includes(mimeType)) {
    throw new AppError(
      415,
      "MIME_TYPE_MISMATCH",
      "The file MIME type does not match its extension.",
    );
  }
  if (extension === ".pdf" && buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new AppError(415, "FILE_SIGNATURE_MISMATCH", "The file is not a valid PDF.");
  }
  if (extension === ".docx" && buffer.subarray(0, 2).toString("ascii") !== "PK") {
    throw new AppError(415, "FILE_SIGNATURE_MISMATCH", "The file is not a valid DOCX archive.");
  }
  if (extension === ".txt" && buffer.includes(0)) {
    throw new AppError(
      415,
      "BINARY_TEXT_REJECTED",
      "The TXT upload appears to contain binary data.",
    );
  }
  return extension;
}

export async function extractDocument(
  buffer: Buffer,
  extension: ".pdf" | ".docx" | ".txt",
): Promise<ExtractionResult> {
  try {
    let text: string;
    let pageCount: number | null = null;
    const warnings: string[] = [];

    if (extension === ".pdf") {
      const parser = new PDFParse({ data: buffer });
      try {
        const parsed = await parser.getText();
        text = parsed.text;
        pageCount = parsed.total;
      } finally {
        await parser.destroy();
      }
    } else if (extension === ".docx") {
      const parsed = await mammoth.extractRawText({ buffer });
      text = parsed.value;
      warnings.push(...parsed.messages.map((message) => message.message));
    } else {
      text = buffer.toString("utf8");
    }

    text = text.replace(/\r\n/g, "\n").split("\u0000").join("").trim();
    if (text.length < 50) {
      return {
        status: extension === ".pdf" ? "ocr_required" : "completed_with_warnings",
        text,
        pageCount,
        warnings: [
          ...warnings,
          extension === ".pdf"
            ? "Little or no extractable text was found. The PDF may be scanned and requires OCR."
            : "Very little extractable text was found; analysis confidence will be limited.",
        ],
        error: null,
      };
    }
    return {
      status: warnings.length ? "completed_with_warnings" : "completed",
      text,
      pageCount,
      warnings,
      error: null,
    };
  } catch (error) {
    return {
      status: "failed",
      text: "",
      pageCount: null,
      warnings: [],
      error: error instanceof Error ? error.message.slice(0, 500) : "Document extraction failed.",
    };
  }
}

export function segmentText(
  organizationId: string,
  documentId: string,
  text: string,
): TextSegment[] {
  if (!text) return [];
  const segments: TextSegment[] = [];
  const paragraphs = text.split(/\n\s*\n|(?<=\.)\s+(?=[A-Z][A-Za-z ]{2,40}:)/g);
  let searchFrom = 0;
  let currentHeading: string | null = null;

  for (const rawParagraph of paragraphs) {
    const originalText = rawParagraph.trim();
    if (!originalText) continue;
    const characterStart = text.indexOf(originalText, searchFrom);
    const safeStart = characterStart >= 0 ? characterStart : searchFrom;
    const characterEnd = safeStart + originalText.length;
    const headingLike = originalText.length < 100 && !/[.!?]$/.test(originalText);
    if (headingLike) currentHeading = originalText;
    segments.push({
      id: randomUUID(),
      organizationId,
      documentId,
      pageNumber: null,
      sectionHeading: currentHeading,
      paragraphNumber: segments.length + 1,
      characterStart: safeStart,
      characterEnd,
      normalizedText: originalText.replace(/\s+/g, " ").trim(),
      originalText,
      extractionConfidence: 1,
    });
    searchFrom = characterEnd;
  }
  return segments;
}

export function evidenceExcerptIsExact(excerpt: string, sourceText: string): boolean {
  return excerpt.length > 0 && sourceText.includes(excerpt);
}
