import {
  DEFAULT_TSA_URL,
  requestTimestamp,
  verifyTimestampToken,
  type Rfc3161Stamp,
  type TimestampCheck,
} from "../crypto/tsa.js";
import { proofCommitsTo, submitTimestamp } from "../crypto/ots.js";

// RootSystems Trunk: two independent timestamps on an Assurance Pack's contentHash - an RFC 3161
// token from a public timestamp authority (FEATURE_RFC3161=1; TSA_URL, default DigiCert) and an
// OpenTimestamps proof anchored in Bitcoin (on unless FEATURE_OTS=0). Each is best effort: a failure
// is reported as null with the reason and never blocks the pack. The timestamps sit beside the pack,
// not inside it, so they do not change its contentHash or signature.

export interface PackTimestamps {
  covers: "contentHash";
  contentHash: string;
  rfc3161: Rfc3161Stamp | null;
  openTimestamps: { proofBase64: string; status: "pending" } | null;
  errors: string[];
}

export interface TimestampDeps {
  rfc3161?: (sha256Hex: string, tsaUrl: string) => Promise<Rfc3161Stamp>;
  ots?: (sha256Hex: string) => Promise<string>;
}

export async function timestampPack(
  contentHash: string,
  env: NodeJS.ProcessEnv = process.env,
  deps: TimestampDeps = {},
): Promise<PackTimestamps> {
  const out: PackTimestamps = {
    covers: "contentHash",
    contentHash,
    rfc3161: null,
    openTimestamps: null,
    errors: [],
  };
  const tasks: Promise<void>[] = [];
  if (env.FEATURE_RFC3161 === "1") {
    tasks.push(
      (deps.rfc3161 ?? requestTimestamp)(contentHash, env.TSA_URL || DEFAULT_TSA_URL)
        .then((stamp) => void (out.rfc3161 = stamp))
        .catch((err: Error) => void out.errors.push("rfc3161: " + err.message)),
    );
  }
  if (env.FEATURE_OTS !== "0") {
    tasks.push(
      (deps.ots ?? submitTimestamp)(contentHash)
        .then((proofBase64) => void (out.openTimestamps = { proofBase64, status: "pending" }))
        .catch((err: Error) => void out.errors.push("opentimestamps: " + err.message)),
    );
  }
  await Promise.all(tasks);
  return out;
}

// Offline checks of timestamps a holder supplies next to a pack.
export function verifyPackTimestamps(
  contentHash: string,
  timestamps:
    { rfc3161?: { tokenBase64: string }; openTimestamps?: { proofBase64: string } } | undefined,
): {
  rfc3161: TimestampCheck | "not_supplied";
  openTimestamps: "commits_to_this_pack" | "does_not_match" | "not_supplied";
} {
  return {
    rfc3161: timestamps?.rfc3161
      ? verifyTimestampToken(timestamps.rfc3161.tokenBase64, contentHash)
      : "not_supplied",
    openTimestamps: timestamps?.openTimestamps
      ? proofCommitsTo(timestamps.openTimestamps.proofBase64, contentHash)
        ? "commits_to_this_pack"
        : "does_not_match"
      : "not_supplied",
  };
}
