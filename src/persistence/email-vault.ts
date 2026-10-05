import { createHmac } from "node:crypto";
import { FieldVault } from "./field-vault.js";

// Account emails are sealed like every other customer field (see field-vault.ts) and also get a
// keyed fingerprint, emailHash, used for lookups and uniqueness. The fingerprint key is derived from
// the encryption key rather than reusing it. Without a key emails are stored as-is and found through
// the plain column.
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class EmailVault extends FieldVault {
  private readonly indexKey: Buffer | null;

  constructor(key: Buffer | null) {
    super(key);
    this.indexKey = key ? createHmac("sha256", key).update("email-index-v1").digest() : null;
  }

  index(email: string): string | null {
    if (!this.indexKey) return null;
    return createHmac("sha256", this.indexKey).update(normalizeEmail(email), "utf8").digest("hex");
  }
}
