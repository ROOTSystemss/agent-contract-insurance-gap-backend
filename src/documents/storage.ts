import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AppError } from "../shared/errors.js";

export interface DocumentStorage {
  put(storageKey: string, data: Buffer): Promise<void>;
  get(storageKey: string): Promise<Buffer>;
  delete(storageKey: string): Promise<void>;
}

export class MemoryDocumentStorage implements DocumentStorage {
  private readonly documents = new Map<string, Buffer>();

  async put(storageKey: string, data: Buffer): Promise<void> {
    this.documents.set(storageKey, Buffer.from(data));
  }

  async get(storageKey: string): Promise<Buffer> {
    const document = this.documents.get(storageKey);
    if (!document) throw new AppError(404, "DOCUMENT_BYTES_NOT_FOUND", "Document bytes not found.");
    return Buffer.from(document);
  }

  async delete(storageKey: string): Promise<void> {
    this.documents.delete(storageKey);
  }
}

const ENCRYPTED_MAGIC = Buffer.from("RSENC1", "ascii");
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export class EncryptedDocumentStorage implements DocumentStorage {
  constructor(
    private readonly storage: DocumentStorage,
    private readonly key: Buffer,
  ) {
    if (key.byteLength !== 32) {
      throw new AppError(
        500,
        "INVALID_DOCUMENT_ENCRYPTION_KEY",
        "The document encryption key must decode to exactly 32 bytes.",
      );
    }
  }

  async put(storageKey: string, data: Buffer): Promise<void> {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
    const authTag = cipher.getAuthTag();
    await this.storage.put(storageKey, Buffer.concat([ENCRYPTED_MAGIC, iv, authTag, ciphertext]));
  }

  async get(storageKey: string): Promise<Buffer> {
    const encrypted = await this.storage.get(storageKey);
    const minimumLength = ENCRYPTED_MAGIC.length + IV_LENGTH + AUTH_TAG_LENGTH;
    if (
      encrypted.byteLength < minimumLength ||
      !encrypted.subarray(0, ENCRYPTED_MAGIC.length).equals(ENCRYPTED_MAGIC)
    ) {
      throw new AppError(
        500,
        "DOCUMENT_DECRYPTION_FAILED",
        "Stored document encryption metadata is invalid.",
      );
    }
    const ivStart = ENCRYPTED_MAGIC.length;
    const tagStart = ivStart + IV_LENGTH;
    const ciphertextStart = tagStart + AUTH_TAG_LENGTH;
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        encrypted.subarray(ivStart, tagStart),
      );
      decipher.setAuthTag(encrypted.subarray(tagStart, ciphertextStart));
      return Buffer.concat([
        decipher.update(encrypted.subarray(ciphertextStart)),
        decipher.final(),
      ]);
    } catch {
      throw new AppError(
        500,
        "DOCUMENT_DECRYPTION_FAILED",
        "Stored document authentication failed.",
      );
    }
  }

  async delete(storageKey: string): Promise<void> {
    await this.storage.delete(storageKey);
  }
}

function safePath(root: string, storageKey: string): string {
  if (!/^[a-zA-Z0-9/_-]+\.[a-zA-Z0-9]+$/.test(storageKey)) {
    throw new AppError(400, "UNSAFE_STORAGE_KEY", "The generated storage key is invalid.");
  }
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, storageKey);
  if (!target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new AppError(400, "PATH_TRAVERSAL_REJECTED", "Unsafe storage path rejected.");
  }
  return target;
}

export class LocalDocumentStorage implements DocumentStorage {
  constructor(private readonly root: string) {}

  async put(storageKey: string, data: Buffer): Promise<void> {
    const target = safePath(this.root, storageKey);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data, { flag: "wx" });
  }

  async get(storageKey: string): Promise<Buffer> {
    return readFile(safePath(this.root, storageKey));
  }

  async delete(storageKey: string): Promise<void> {
    await rm(safePath(this.root, storageKey), { force: true });
  }
}

export function sanitizeFilename(filename: string): string {
  const basename = path.basename(filename).normalize("NFKC");
  const safe = basename
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  if (!safe || safe === "." || safe === "..") {
    throw new AppError(400, "INVALID_FILENAME", "The uploaded filename is invalid.");
  }
  return safe;
}
