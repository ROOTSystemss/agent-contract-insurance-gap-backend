import { sha512Hex, verifyWithPublicKey, type PqSigner } from "./pq-sign.js";

// The signing key history, published at /.well-known/rootsystems-signing-keys.json in the
// rootsystems.keyring/v1 format the other RootSystems products use, so a document signed before a key
// rotation still checks afterwards. Today there is one key. After a rotation, set PQ_KEY_HISTORY_JSON to
// the full keyring that the rotation tool wrote (the new key "active", earlier keys "retired" with
// validUntil, each later key endorsed by the key before it).
//
// QA 2026-11-14: a keyring that is set but unusable stops the service at startup (assertKeyHistory), with
// the exact problem, instead of being ignored with a warning. Ignoring it silently published only the new
// key, and every document signed with the old key then failed verification. At publish time the same
// check still applies (fail closed).

export const KEYRING_FORMAT = "rootsystems.keyring/v1";

interface RingKey { keyId: string; algorithm?: string; publicKey: string; status: "active" | "retired"; validFrom?: string | null; validUntil?: string | null; endorsedBy?: { keyId?: unknown; format?: unknown; signature?: unknown } }

const isDate = (v: unknown) => v === null || v === undefined || (typeof v === "string" && !Number.isNaN(Date.parse(v)));

// The message a key signs to endorse its successor (rootsystems-core src/keyring.js, v1 and v2).
export function endorsementMessage(keyId: string, publicKey: string, algorithm?: string): Buffer {
  return Buffer.from(algorithm ? `rootsystems-key-endorsement:v2:${algorithm}:${keyId}:${publicKey}` : `rootsystems-key-endorsement:v1:${keyId}:${publicKey}`, "utf8");
}

// null when the keyring is usable with this signer; otherwise what is wrong, in words.
export function keyHistoryProblem(signer: PqSigner | null, raw: string): string | null {
  if (!signer) return "PQ_SIGNING_SEED is not set, so there is no current key for the history to end with";
  let ring: { format?: unknown; keys?: unknown };
  try {
    ring = JSON.parse(raw) as typeof ring;
  } catch {
    return "it is not valid JSON";
  }
  if (!ring || ring.format !== KEYRING_FORMAT) return `its format is not ${KEYRING_FORMAT}`;
  if (!Array.isArray(ring.keys) || ring.keys.length === 0) return "it lists no keys";
  const keys = ring.keys as RingKey[];
  for (const [index, k] of keys.entries()) {
    const at = `key ${index + 1}`;
    if (!k || typeof k.publicKey !== "string" || typeof k.keyId !== "string") return `${at} has no keyId or publicKey`;
    if (k.algorithm !== undefined && k.algorithm !== "ML-DSA-65") return `${at} uses ${String(k.algorithm)}, but this service verifies ML-DSA-65 only`;
    if (k.status !== "active" && k.status !== "retired") return `${at} has status "${String(k.status)}" (expected active or retired)`;
    if (!isDate(k.validFrom) || !isDate(k.validUntil)) return `${at} has a date that cannot be read`;
    if (k.keyId !== sha512Hex(Buffer.from(k.publicKey, "base64")).slice(0, 32)) return `${at}: keyId ${k.keyId} is not the fingerprint of its public key`;
    if (k.status === "retired" && !k.validUntil) return `${at} is retired but has no validUntil, so it would keep accepting new signatures`;
    if (index > 0) {
      const previous = keys[index - 1]!;
      const endorsement = k.endorsedBy;
      if (!endorsement || endorsement.keyId !== previous.keyId || typeof endorsement.signature !== "string") return `${at} is not endorsed by the key before it (offline verifiers refuse such a history)`;
      const message = endorsement.format === "v2" ? endorsementMessage(k.keyId, k.publicKey, k.algorithm ?? "ML-DSA-65") : endorsementMessage(k.keyId, k.publicKey);
      if (!verifyWithPublicKey(message, endorsement.signature, previous.publicKey)) return `${at}: the endorsement by the key before it does not verify`;
    }
  }
  const active = keys.filter((k) => k.status === "active");
  if (active.length !== 1) return `it has ${active.length} active keys (exactly one is required)`;
  if (active[0]!.publicKey !== signer.publicKey) return `its active key (${active[0]!.keyId}) is not the key PQ_SIGNING_SEED produces (${signer.keyId})`;
  return null;
}

// Startup: refuses to run with a history that is set but unusable.
export function assertKeyHistory(signer: PqSigner | null, raw: string | undefined): void {
  if (!raw) return;
  const problem = keyHistoryProblem(signer, raw);
  if (problem) throw new Error(`PQ_KEY_HISTORY_JSON cannot be used: ${problem}. Fix or remove it; the service will not start with it.`);
}

export interface PublishedKey { keyId: string; publicKey: string; status: "active" | "retired"; validUntil: string | null }

// Whether a document signed (by its own signed timestamp) at `signedAt` may count under this key: a retired
// key only covers what it signed before it was retired. Unknown time + retired key = no.
export function keyCoversTime(key: PublishedKey, signedAt: unknown): boolean {
  if (key.status !== "retired") return true;
  const at = typeof signedAt === "string" ? Date.parse(signedAt) : NaN;
  return key.validUntil !== null && Number.isFinite(at) && at <= Date.parse(key.validUntil);
}

export function publishedKeys(signer: PqSigner | null, rawHistory: string | undefined): PublishedKey[] {
  const history = keyHistory("ai-agent-trust", signer, rawHistory);
  return history ? history.keys.map((k) => ({ keyId: k.keyId, publicKey: k.publicKey, status: k.status as PublishedKey["status"], validUntil: k.validUntil })) : [];
}

export function keyHistory(product: string, signer: PqSigner | null, rawHistory: string | undefined) {
  if (!signer) return null;
  if (rawHistory && keyHistoryProblem(signer, rawHistory) === null) {
    const ring = JSON.parse(rawHistory) as { keys: RingKey[] };
    return { format: KEYRING_FORMAT, product, keys: ring.keys.map((k) => ({ keyId: k.keyId, algorithm: k.algorithm ?? "ML-DSA-65", publicKey: k.publicKey, status: k.status, validFrom: k.validFrom ?? null, validUntil: k.validUntil ?? null, ...(k.endorsedBy ? { endorsedBy: k.endorsedBy } : {}) })) };
  }
  return { format: KEYRING_FORMAT, product, keys: [{ keyId: signer.keyId, algorithm: "ML-DSA-65", publicKey: signer.publicKey, status: "active", validFrom: null, validUntil: null }] };
}
