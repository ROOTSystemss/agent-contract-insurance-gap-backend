import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

// Account emails are stored encrypted (AES-256-GCM under DOCUMENT_ENCRYPTION_KEY) with a keyed
// fingerprint, emailHash, used for lookups and uniqueness. The fingerprint key is derived from the
// encryption key rather than reusing it. Without a key (development and tests) emails are stored
// as-is and found through the plain column; production refuses to start without the key.
const SEALED = "enc:v1:";

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class EmailVault {
  private readonly indexKey: Buffer | null;

  constructor(private readonly key: Buffer | null) {
    if (key && key.length !== 32) throw new Error("EmailVault key must be 32 bytes");
    this.indexKey = key ? createHmac("sha256", key).update("email-index-v1").digest() : null;
  }

  index(email: string): string | null {
    if (!this.indexKey) return null;
    return createHmac("sha256", this.indexKey).update(normalizeEmail(email), "utf8").digest("hex");
  }

  seal(email: string): string {
    if (!this.key) return email;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([cipher.update(email, "utf8"), cipher.final()]);
    return SEALED + [iv, cipher.getAuthTag(), body].map((part) => part.toString("base64")).join(".");
  }

  open(value: string): string {
    if (!value.startsWith(SEALED)) return value;
    if (!this.key) throw new Error("DOCUMENT_ENCRYPTION_KEY is required to read stored account emails");
    const parts = value.slice(SEALED.length).split(".").map((part) => Buffer.from(part, "base64"));
    if (parts.length !== 3) throw new Error("Malformed sealed email");
    const [iv, tag, body] = parts as [Buffer, Buffer, Buffer];
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  }

  isSealed(value: string): boolean {
    return value.startsWith(SEALED);
  }
}
