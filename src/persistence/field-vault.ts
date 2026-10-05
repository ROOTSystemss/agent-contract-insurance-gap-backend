import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Customer data stored in Postgres is sealed with AES-256-GCM under DOCUMENT_ENCRYPTION_KEY as
// "enc:v1:<iv>.<tag>.<ciphertext>". Json columns hold the sealed JSON text as a JSON string. Values
// without the prefix are legacy plaintext and are returned as-is until the startup upgrade seals
// them. Without a key (development and tests) values are stored as-is; production refuses to start
// without the key (see config/env.ts).
export const SEALED_PREFIX = "enc:v1:";

export class FieldVault {
  constructor(protected readonly key: Buffer | null) {
    if (key && key.length !== 32) throw new Error("Encryption key must be 32 bytes");
  }

  get enabled(): boolean {
    return this.key !== null;
  }

  isSealed(value: unknown): boolean {
    return typeof value === "string" && value.startsWith(SEALED_PREFIX);
  }

  seal(value: string): string {
    if (!this.key) return value;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return SEALED_PREFIX + [iv, cipher.getAuthTag(), body].map((part) => part.toString("base64")).join(".");
  }

  open(value: string): string {
    if (!value.startsWith(SEALED_PREFIX)) return value;
    if (!this.key) throw new Error("DOCUMENT_ENCRYPTION_KEY is required to read encrypted stored data");
    const parts = value.slice(SEALED_PREFIX.length).split(".").map((part) => Buffer.from(part, "base64"));
    if (parts.length !== 3) throw new Error("Malformed sealed value");
    const [iv, tag, body] = parts as [Buffer, Buffer, Buffer];
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  }

  sealOptional(value: string | null | undefined): string | null {
    return value === null || value === undefined ? null : this.seal(value);
  }

  openOptional(value: string | null): string | null {
    return value === null ? null : this.open(value);
  }

  sealList(values: string[]): string[] {
    return values.map((value) => this.seal(value));
  }

  openList(values: string[]): string[] {
    return values.map((value) => this.open(value));
  }

  sealJson<T>(value: T): T | string {
    return this.key ? this.seal(JSON.stringify(value)) : value;
  }

  openJson<T>(value: unknown): T {
    return (this.isSealed(value) ? JSON.parse(this.open(value as string)) : value) as T;
  }
}
