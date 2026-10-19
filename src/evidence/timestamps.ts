import type { EvidenceReceiptRecord } from "../domain/types.js";
import type { Store } from "../persistence/store.js";

// OpenTimestamps (Bitcoin) anchoring for Evidence Notary receipts, the same calls the other
// RootSystems products use (their lib/otsLib.js and lib/timestampSweep.js): a receipt's anchorHash is
// submitted to the public calendars as it is issued, and an hourly sweep resubmits any that failed,
// upgrades pending proofs and marks them confirmed once a Bitcoin block includes them.

export interface OtsClient {
  submit(hashHex: string): Promise<string>;
  upgrade(proofB64: string, hashHex: string): Promise<{ proofBase64: string; confirmation: { height: number } | null }>;
}

// The parts of the "opentimestamps" package used here (it ships no types).
interface DetachedTimestampFile { serializeToBytes(): Uint8Array }
interface OpenTimestampsLib {
  DetachedTimestampFile: { fromHash(op: unknown, hash: Buffer): DetachedTimestampFile; deserialize(bytes: Buffer): DetachedTimestampFile };
  Ops: { OpSHA256: new () => unknown };
  stamp(file: DetachedTimestampFile): Promise<void>;
  upgrade(file: DetachedTimestampFile): Promise<boolean>;
  verify(file: DetachedTimestampFile, original: DetachedTimestampFile, options: { ignoreBitcoinNode: boolean; timeout: number }): Promise<{ bitcoin?: { height: number } } | null>;
}

// The real calendars. Loaded lazily so the library is only touched when anchoring actually runs.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const loadOts = (): OpenTimestampsLib => require("opentimestamps") as OpenTimestampsLib;
export const openTimestamps: OtsClient = {
  async submit(hashHex) {
    const OTS = loadOts();
    const detached = OTS.DetachedTimestampFile.fromHash(new OTS.Ops.OpSHA256(), Buffer.from(hashHex, "hex"));
    await OTS.stamp(detached);
    return Buffer.from(detached.serializeToBytes()).toString("base64");
  },
  async upgrade(proofB64, hashHex) {
    const OTS = loadOts();
    const detached = OTS.DetachedTimestampFile.deserialize(Buffer.from(proofB64, "base64"));
    const changed = await OTS.upgrade(detached);
    let confirmation: { height: number } | null = null;
    if (changed) {
      const file = OTS.DetachedTimestampFile.fromHash(new OTS.Ops.OpSHA256(), Buffer.from(hashHex, "hex"));
      try {
        const result = await OTS.verify(detached, file, { ignoreBitcoinNode: true, timeout: 8000 });
        confirmation = result && result.bitcoin ? result.bitcoin : null;
      } catch {
        confirmation = null;
      }
    }
    return { proofBase64: Buffer.from(detached.serializeToBytes()).toString("base64"), confirmation };
  },
};

let client: OtsClient = openTimestamps;
// Tests stand in for the calendars here; production never calls this.
export function useOtsClientForTesting(next: OtsClient | null): void {
  client = next ?? openTimestamps;
}

// Submits one fresh receipt right away (best effort; the sweep retries later if this fails).
export async function anchorNow(store: Store, record: EvidenceReceiptRecord): Promise<void> {
  // Never reach the public calendars from a test run unless a test supplied its own client.
  if (process.env.TIMESTAMP_SWEEP === "0" || record.otsProof || (process.env.NODE_ENV === "test" && client === openTimestamps)) return;
  try {
    const proof = await client.submit(record.anchorHash);
    await store.updateReceiptTimestamp(record.organizationId, record.seq, { otsProof: proof, otsStatus: "pending" });
  } catch {
    // Calendar down: the record stays "not-submitted" and the hourly sweep resubmits it.
  }
}

export async function sweepReceiptTimestamps(store: Store, now: () => Date = () => new Date()) {
  const tally = { submitted: 0, confirmed: 0, stillPending: 0, failed: 0 };
  for (const r of await store.listUnanchoredReceipts(200)) {
    try {
      if (!r.otsProof) {
        const proof = await client.submit(r.anchorHash);
        await store.updateReceiptTimestamp(r.organizationId, r.seq, { otsProof: proof, otsStatus: "pending" });
        tally.submitted++;
        continue;
      }
      const result = await client.upgrade(r.otsProof, r.anchorHash);
      if (result.confirmation) {
        await store.updateReceiptTimestamp(r.organizationId, r.seq, { otsProof: result.proofBase64, otsStatus: "confirmed", otsConfirmedAt: now().toISOString(), otsBlockHeight: result.confirmation.height });
        tally.confirmed++;
      } else {
        await store.updateReceiptTimestamp(r.organizationId, r.seq, { otsProof: result.proofBase64 });
        tally.stillPending++;
      }
    } catch {
      tally.failed++;
    }
  }
  return tally;
}

const HOUR = 60 * 60 * 1000;
// Shortly after startup, then hourly. TIMESTAMP_SWEEP=0 turns it off.
export function startReceiptTimestampSweep(store: Store, log: { info: (o: object, m: string) => void; error: (o: object, m: string) => void }): () => void {
  if (process.env.TIMESTAMP_SWEEP === "0") return () => undefined;
  const run = () => {
    void sweepReceiptTimestamps(store)
      .then((tally) => { if (tally.submitted || tally.confirmed || tally.failed) log.info(tally, "receipt timestamp sweep"); })
      .catch((error: unknown) => log.error({ err: (error as Error).message }, "receipt timestamp sweep failed"));
  };
  const first = setTimeout(run, 60 * 1000);
  const every = setInterval(run, HOUR);
  first.unref();
  every.unref();
  return () => { clearTimeout(first); clearInterval(every); };
}
