import { createHash } from "node:crypto";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";

// Post-quantum signatures (ML-DSA-65, NIST FIPS 204) for documents that have to stay trustworthy for
// years. ECDSA and RSA can be forged by a large enough quantum computer; ML-DSA is built to survive
// one. The key comes from PQ_SIGNING_SEED (32 random bytes, base64); ML-DSA key generation from a
// seed is deterministic, so the key is stable across restarts and deploys. Same scheme and key
// format as the rest of the RootSystems portfolio, so one verifier works for all of them.

export const PQ_ALGORITHM = "ML-DSA-65";
export const PQ_STANDARD = "NIST FIPS 204";

// SubjectPublicKeyInfo prefix for ML-DSA-65 (OID 2.16.840.1.101.3.4.3.18), so OpenSSL 3.5+ and
// Node 24+ load the published key directly.
const SPKI_PREFIX = Buffer.from("308207b2300b0609608648016503040312038207a100", "hex");

export interface PqSigner {
  keyId: string;
  publicKey: string;
  publicKeyPem: string;
  sign(bytes: Uint8Array): string;
  verify(bytes: Uint8Array, signatureB64: string): boolean;
}

export function sha512Hex(data: string | Uint8Array): string {
  return createHash("sha512").update(data).digest("hex");
}

export function verifyWithPublicKey(bytes: Uint8Array, signatureB64: string, publicKeyB64: string): boolean {
  try {
    return ml_dsa65.verify(Buffer.from(signatureB64, "base64"), bytes, Buffer.from(publicKeyB64, "base64"));
  } catch {
    return false;
  }
}

// Returns null when no seed is configured: nothing is signed then, and callers say so.
export function createPqSigner(seedB64: string | undefined): PqSigner | null {
  if (!seedB64) return null;
  const seed = Buffer.from(seedB64, "base64");
  if (seed.length !== 32) throw new Error("PQ_SIGNING_SEED must be 32 random bytes, base64-encoded.");
  const { publicKey, secretKey } = ml_dsa65.keygen(seed);
  const publicKeyB64 = Buffer.from(publicKey).toString("base64");
  const pemBody = Buffer.concat([SPKI_PREFIX, Buffer.from(publicKey)]).toString("base64").match(/.{1,64}/g)!.join("\n");
  return {
    keyId: sha512Hex(publicKey).slice(0, 32),
    publicKey: publicKeyB64,
    publicKeyPem: `-----BEGIN PUBLIC KEY-----\n${pemBody}\n-----END PUBLIC KEY-----\n`,
    sign: (bytes) => Buffer.from(ml_dsa65.sign(bytes, secretKey)).toString("base64"),
    verify: (bytes, signatureB64) => verifyWithPublicKey(bytes, signatureB64, publicKeyB64),
  };
}

export function publicKeyInfo(signer: PqSigner | null) {
  if (!signer) return { configured: false, algorithm: PQ_ALGORITHM, standard: PQ_STANDARD };
  return {
    configured: true,
    algorithm: PQ_ALGORITHM,
    standard: PQ_STANDARD,
    keyId: signer.keyId,
    publicKey: signer.publicKey,
    publicKeyPem: signer.publicKeyPem,
  };
}
