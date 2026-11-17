import { PQ_ALGORITHM, PQ_STANDARD, sha512Hex, type PqSigner } from "../crypto/pq-sign.js";
import { canonicalJson, hashPack } from "./assurance-pack.js";

// Signed JSON documents in exactly the Agent Assurance Pack format ({ pack, contentHash, signature }), so the public
// /verify checks them the same way (verifyAssurancePack: SHA-256 of the canonical bytes + ML-DSA-65 by a key this
// service publishes). Used by the insurance broker pack (AD-059) and the monthly agent statement (BM-43).
export const BROKER_PACK_SCHEMA = "rootsystems.agent-broker-pack.v1";
export const MONTHLY_STATEMENT_SCHEMA = "rootsystems.agent-monthly-statement.v1";
export const ACCOUNT_EXPORT_SCHEMA = "rootsystems.account-export-manifest.v1";

// What /verify calls each kind of signed document (the schema is inside the hashed, signed content).
export const DOCUMENT_KINDS: Record<string, string> = {
  [BROKER_PACK_SCHEMA]: "broker-pack",
  [MONTHLY_STATEMENT_SCHEMA]: "monthly-statement",
  [ACCOUNT_EXPORT_SCHEMA]: "account-export",
};

export function signDocument(doc: Record<string, unknown>, signer: PqSigner | null) {
  const bytes = Buffer.from(canonicalJson(doc), "utf8");
  return {
    pack: doc,
    contentHash: hashPack(doc),
    hashAlgorithm: "sha256",
    contentHashSha512: sha512Hex(bytes),
    canonicalization: "JSON with object keys sorted recursively; UTF-8; no whitespace",
    signature: signer
      ? { status: "signed" as const, algorithm: PQ_ALGORITHM, standard: PQ_STANDARD, keyId: signer.keyId, publicKey: signer.publicKey, signs: "the canonical document bytes (the same bytes contentHash covers)", value: signer.sign(bytes) }
      : { status: "not_configured" as const, algorithm: PQ_ALGORITHM },
  };
}
