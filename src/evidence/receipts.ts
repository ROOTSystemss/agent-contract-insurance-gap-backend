import { createHash } from "node:crypto";
import type { EvidenceReceiptRecord } from "../domain/types.js";
import type { Store } from "../persistence/store.js";
import { PQ_ALGORITHM, PQ_STANDARD, sha512Hex, type PqSigner } from "../crypto/pq-sign.js";
import { canonicalJson } from "../reports/assurance-pack.js";

// Evidence Notary receipts for AI Agent Trust: every assurance pack, certificate issued or revoked and
// approval signed or declined becomes a small signed receipt, chained per workspace, in exactly the
// format the other RootSystems products use (their lib/evidenceReceipts.js), so one checker reads all:
//
//   receipt = seal({ receiptVersion: 1, system, type, orgId, seq, issuedAt,
//                    subject: { kind, id },   // an id, never a name
//                    facts,                   // ids, hashes and outcomes only
//                    previousReceiptHash })   // the previous receipt's signature.sha512
//
// The first receipt names sha512("rootsystems-receipts/genesis:" + system + ":" + orgId). Deleting,
// editing or reordering any receipt breaks every link after it. Each receipt is also anchored in
// Bitcoin with OpenTimestamps by the SHA-256 of its signed bytes (evidence/timestamps.ts).

export const RECEIPT_SYSTEM = "AI Agent Trust";
export const RECEIPT_VERSION = 1;

type Doc = Record<string, unknown>;
const sha512 = (text: string) => sha512Hex(Buffer.from(text, "utf8"));
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
export const genesis = (orgId: string) => sha512(`rootsystems-receipts/genesis:${RECEIPT_SYSTEM}:${orgId}`);
// What is signed: the canonical JSON of the receipt without its signature, after a JSON round trip.
const signedText = (doc: Doc) => {
  const { signature: _signature, ...rest } = doc;
  return canonicalJson(JSON.parse(JSON.stringify(rest)) as unknown);
};
export const fingerprint = (receipt: Doc | null | undefined): string | null =>
  (receipt && (receipt.signature as { sha512?: string } | undefined)?.sha512) || null;

const plain = (doc: Doc): Doc => JSON.parse(JSON.stringify(doc)) as Doc;

export function seal(doc: Doc, signer: PqSigner | null): Doc {
  const text = signedText(doc);
  const bytes = Buffer.from(text, "utf8");
  if (!signer) return { ...plain(doc), signature: { status: "not_configured", algorithm: PQ_ALGORITHM, sha512: sha512Hex(bytes) } };
  return {
    ...plain(doc),
    signature: {
      status: "signed",
      algorithm: PQ_ALGORITHM,
      standard: PQ_STANDARD,
      keyId: signer.keyId,
      publicKey: signer.publicKey,
      sha512: sha512Hex(bytes),
      canonicalization: "JSON with object keys sorted at every level, no whitespace, the signature field removed",
      value: signer.sign(bytes),
    },
  };
}

export interface ReceiptInput {
  orgId: string;
  type: string;
  subject?: { kind: string; id: string } | null;
  facts?: Record<string, unknown>;
  now?: Date;
}

// Appends one receipt to the workspace's chain. Two receipts issued at the same moment cannot fork the
// chain: the store refuses a taken sequence number (SEQ_TAKEN) and this retries.
export async function issueReceipt(store: Store, signer: PqSigner | null, input: ReceiptInput, attempts = 5): Promise<EvidenceReceiptRecord> {
  for (let i = 0; i < attempts; i++) {
    const prev = await store.lastReceipt(input.orgId);
    const doc: Doc = {
      receiptVersion: RECEIPT_VERSION,
      system: RECEIPT_SYSTEM,
      type: input.type,
      orgId: input.orgId,
      seq: prev ? prev.seq + 1 : 1,
      issuedAt: (input.now ?? new Date()).toISOString(),
      subject: input.subject ?? null,
      facts: input.facts ?? {},
      previousReceiptHash: prev ? fingerprint(prev.receipt) : genesis(input.orgId),
    };
    const receipt = seal(doc, signer);
    try {
      return await store.addReceipt({ organizationId: input.orgId, seq: doc.seq as number, receipt, anchorHash: sha256(signedText(receipt)), otsProof: null, otsStatus: "not-submitted" });
    } catch (error) {
      if ((error as { code?: string }).code !== "SEQ_TAKEN") throw error;
    }
  }
  throw new Error(`could not append the receipt after ${attempts} attempts`);
}

// Checks one workspace's whole chain, oldest first.
export function checkChain(orgId: string, receipts: Doc[]): { intact: true; receipts: number; head: string } | { intact: false; brokenAt: number; reason: string } {
  let previous = genesis(orgId);
  for (const [i, r] of receipts.entries()) {
    if (Number(r.seq) !== i + 1) return { intact: false, brokenAt: i + 1, reason: "a receipt is missing or out of order" };
    if (r.previousReceiptHash !== previous) return { intact: false, brokenAt: Number(r.seq), reason: "it does not link to the receipt before it" };
    if (sha512(signedText(r)) !== fingerprint(r)) return { intact: false, brokenAt: Number(r.seq), reason: "it was changed after it was issued" };
    previous = fingerprint(r) as string;
  }
  return { intact: true, receipts: receipts.length, head: previous };
}

// One receipt against this service's published keys: who issued it and that it is unchanged.
export interface PublishedKey { keyId: string; publicKey: string }
export function verifyOne(receipt: unknown, keys: PublishedKey[], verify: (bytes: Uint8Array, sig: string, publicKey: string) => boolean):
  { valid: true; keyId: string; type: unknown; seq: unknown; issuedAt: unknown; subject: unknown; facts: unknown; anchorHash: string } | { valid: false; reason: string } {
  if (!receipt || typeof receipt !== "object") return { valid: false, reason: "This is not an AI Agent Trust receipt." };
  const r = receipt as Doc;
  if (r.receiptVersion !== RECEIPT_VERSION || r.system !== RECEIPT_SYSTEM) return { valid: false, reason: "This is not an AI Agent Trust receipt." };
  const sig = r.signature as { status?: string; algorithm?: string; publicKey?: string; sha512?: string; value?: string } | undefined;
  if (!sig || sig.status !== "signed") return { valid: false, reason: "The receipt carries no signature." };
  if (sig.algorithm !== PQ_ALGORITHM) return { valid: false, reason: "The receipt is signed with an algorithm this checker does not accept." };
  const key = keys.find((k) => k.publicKey === sig.publicKey);
  if (!key) return { valid: false, reason: "The receipt was signed with a key AI Agent Trust has not published." };
  const text = signedText(r);
  if (sha512(text) !== sig.sha512) return { valid: false, reason: "The receipt was changed after it was issued." };
  if (!sig.value || !verify(Buffer.from(text, "utf8"), sig.value, key.publicKey)) return { valid: false, reason: "The signature does not match the receipt." };
  return { valid: true, keyId: key.keyId, type: r.type, seq: r.seq, issuedAt: r.issuedAt, subject: r.subject, facts: r.facts, anchorHash: sha256(text) };
}

// Issues a receipt without ever failing the request that triggered it: the action already happened,
// and a missing receipt shows up as a gap in the chain, not as a broken page.
export async function recordReceipt(store: Store, signer: PqSigner | null, input: ReceiptInput, log?: { error: (o: object, m: string) => void }): Promise<EvidenceReceiptRecord | null> {
  try {
    const saved = await issueReceipt(store, signer, input);
    void import("./timestamps.js").then((t) => t.anchorNow(store, saved)).catch(() => undefined);
    return saved;
  } catch (error) {
    log?.error({ err: (error as Error).message, type: input.type }, "evidence receipt could not be issued");
    return null;
  }
}
