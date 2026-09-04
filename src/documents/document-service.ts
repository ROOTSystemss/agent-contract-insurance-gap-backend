import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { AppConfig } from "../config/env.js";
import type { DocumentRecord, DocumentType } from "../domain/types.js";
import type { Store } from "../persistence/store.js";
import { AppError, notFound } from "../shared/errors.js";
import { extractDocument, segmentText, validateDocumentFile } from "./extraction.js";
import { sanitizeFilename, type DocumentStorage } from "./storage.js";

export interface UploadInput {
  organizationId: string;
  projectId: string;
  uploaderId: string;
  filename: string;
  mimeType: string;
  buffer: Buffer;
  documentType: DocumentType;
  countryCode: string;
  subdivisionCode?: string;
}

export class DocumentService {
  constructor(
    private readonly store: Store,
    private readonly storage: DocumentStorage,
    private readonly config: AppConfig,
  ) {}

  async upload(input: UploadInput): Promise<DocumentRecord> {
    if (input.buffer.byteLength > this.config.MAX_FILE_SIZE_BYTES) {
      throw new AppError(
        413,
        "FILE_TOO_LARGE",
        `File exceeds the ${this.config.MAX_FILE_SIZE_BYTES}-byte limit.`,
      );
    }
    if (!(await this.store.getProject(input.organizationId, input.projectId)))
      throw notFound("Project");
    const safeFilename = sanitizeFilename(input.filename);
    const extension = validateDocumentFile(safeFilename, input.mimeType, input.buffer);
    const id = randomUUID();
    const storageKey = `${input.organizationId}/${input.projectId}/${id}${extension}`;
    await this.storage.put(storageKey, input.buffer);
    const extraction = await extractDocument(input.buffer, extension);
    const timestamp = new Date().toISOString();
    const document: DocumentRecord = {
      id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      uploaderId: input.uploaderId,
      originalFilename: path.basename(input.filename),
      safeFilename,
      mimeType: input.mimeType,
      size: input.buffer.byteLength,
      checksum: createHash("sha256").update(input.buffer).digest("hex"),
      documentType: input.documentType,
      countryCode: input.countryCode.toUpperCase(),
      subdivisionCode: input.subdivisionCode?.toUpperCase() ?? null,
      storageKey,
      extractionStatus: extraction.status,
      extractionError: extraction.error,
      extractionWarnings: extraction.warnings,
      pageCount: extraction.pageCount,
      extractedText: extraction.text,
      segments: segmentText(input.organizationId, id, extraction.text),
      retentionStatus: "active",
      deleteAfter: new Date(
        Date.now() + this.config.DOCUMENT_RETENTION_DAYS * 86_400_000,
      ).toISOString(),
      deletedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return this.store.createDocument(document);
  }

  async retryExtraction(organizationId: string, id: string): Promise<DocumentRecord> {
    const document = await this.store.getDocument(organizationId, id);
    if (!document) throw notFound("Document");
    const buffer = await this.storage.get(document.storageKey);
    const extension = validateDocumentFile(document.safeFilename, document.mimeType, buffer);
    const extraction = await extractDocument(buffer, extension);
    const updated: DocumentRecord = {
      ...document,
      extractionStatus: extraction.status,
      extractionError: extraction.error,
      extractionWarnings: extraction.warnings,
      pageCount: extraction.pageCount,
      extractedText: extraction.text,
      segments: segmentText(organizationId, id, extraction.text),
      updatedAt: new Date().toISOString(),
    };
    await this.store.updateDocument(updated);
    return updated;
  }

  async delete(organizationId: string, id: string): Promise<boolean> {
    const document = await this.store.deleteDocument(organizationId, id);
    if (!document) return false;
    await this.storage.delete(document.storageKey);
    return true;
  }
}
