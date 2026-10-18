import { sha512Hex, type PqSigner } from "./pq-sign.js";

// The signing key history, published at /.well-known/rootsystems-signing-keys.json in the
// rootsystems.keyring/v1 format the other RootSystems products use, so a document signed before a key
// rotation still checks afterwards. Today there is one key. After a rotation, set PQ_KEY_HISTORY_JSON to
// the full keyring (the new key "active", earlier keys "retired" with validUntil); it is used only when
// it is well formed, every keyId matches its public key and its one active key is the key signing now.
// Otherwise it is ignored and only the current key is published (fail closed).

export const KEYRING_FORMAT = "rootsystems.keyring/v1";

interface RingKey { keyId: string; algorithm?: string; publicKey: string; status: "active" | "retired"; validFrom?: string | null; validUntil?: string | null }

const isDate = (v: unknown) => v === null || v === undefined || (typeof v === "string" && !Number.isNaN(Date.parse(v)));

function wellFormed(ring: unknown, currentPublicKey: string): ring is { format: string; keys: RingKey[] } {
  const r = ring as { format?: unknown; keys?: unknown };
  if (!r || r.format !== KEYRING_FORMAT || !Array.isArray(r.keys) || r.keys.length === 0) return false;
  for (const k of r.keys as RingKey[]) {
    if (!k || typeof k.publicKey !== "string" || !["active", "retired"].includes(k.status) || !isDate(k.validFrom) || !isDate(k.validUntil)) return false;
    if (k.keyId !== sha512Hex(Buffer.from(k.publicKey, "base64")).slice(0, 32)) return false;
  }
  const active = (r.keys as RingKey[]).filter((k) => k.status === "active");
  return active.length === 1 && active[0]!.publicKey === currentPublicKey;
}

export function keyHistory(product: string, signer: PqSigner | null, rawHistory: string | undefined) {
  if (!signer) return null;
  if (rawHistory) {
    let ring: unknown = null;
    try { ring = JSON.parse(rawHistory); } catch { /* reported below */ }
    if (wellFormed(ring, signer.publicKey)) {
      return { format: KEYRING_FORMAT, product, keys: ring.keys.map((k) => ({ keyId: k.keyId, algorithm: k.algorithm ?? "ML-DSA-65", publicKey: k.publicKey, status: k.status, validFrom: k.validFrom ?? null, validUntil: k.validUntil ?? null })) };
    }
    console.warn("[keyHistory] PQ_KEY_HISTORY_JSON ignored: it is not a well-formed keyring whose active key is the key signing now.");
  }
  return { format: KEYRING_FORMAT, product, keys: [{ keyId: signer.keyId, algorithm: "ML-DSA-65", publicKey: signer.publicKey, status: "active", validFrom: null, validUntil: null }] };
}
