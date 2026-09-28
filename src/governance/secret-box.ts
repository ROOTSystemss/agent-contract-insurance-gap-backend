import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Seals the credentials the Agent Governance console holds for a workspace (its Atlas password,
// Trust Proof password and Trust Proof API key) with AES-256-GCM under DOCUMENT_ENCRYPTION_KEY.
// Without a key (development and tests) values are stored with a "plain:" marker; production
// refuses to start without the key (see config/env.ts), so plain values never reach Postgres there.
const SEALED = "enc:v1:";
const PLAIN = "plain:";

export class SecretBox {
  constructor(private readonly key: Buffer | null) {
    if (key && key.length !== 32) throw new Error("SecretBox key must be 32 bytes");
  }

  seal(value: string): string {
    if (!this.key) return PLAIN + value;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return SEALED + [iv, cipher.getAuthTag(), body].map((part) => part.toString("base64")).join(".");
  }

  open(value: string): string {
    if (value.startsWith(PLAIN)) return value.slice(PLAIN.length);
    if (!value.startsWith(SEALED)) throw new Error("Unrecognised sealed value");
    if (!this.key) throw new Error("DOCUMENT_ENCRYPTION_KEY is required to read sealed console credentials");
    const parts = value.slice(SEALED.length).split(".").map((part) => Buffer.from(part, "base64"));
    if (parts.length !== 3) throw new Error("Malformed sealed value");
    const [iv, tag, body] = parts as [Buffer, Buffer, Buffer];
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  }
}
