import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AppError } from "../shared/errors.js";

export interface DocumentStorage {
  put(storageKey: string, data: Buffer): Promise<void>;
  get(storageKey: string): Promise<Buffer>;
  delete(storageKey: string): Promise<void>;
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
