// The package's "main" names a file it does not ship (Node falls back to index.js, bundlers do not),
// so the real entry is imported directly.
import OpenTimestamps from "opentimestamps/index.js";

// OpenTimestamps (Bitcoin-anchored public timestamps) for Assurance Packs (RootSystems Trunk). The
// same calls as rootsystems-core's ots.js: the proof commits to the pack's contentHash and is
// "pending" until a calendar's Bitcoin commitment confirms, usually within hours.

export async function submitTimestamp(sha256Hex: string): Promise<string> {
  const detached = OpenTimestamps.DetachedTimestampFile.fromHash(
    new OpenTimestamps.Ops.OpSHA256(),
    Buffer.from(sha256Hex, "hex"),
  );
  await OpenTimestamps.stamp(detached);
  return Buffer.from(detached.serializeToBytes()).toString("base64");
}

// Offline check, no network: does this proof commit to this hash at all?
export function proofCommitsTo(otsProofBase64: string, sha256Hex: string): boolean {
  try {
    const detached = OpenTimestamps.DetachedTimestampFile.deserialize(
      Buffer.from(otsProofBase64, "base64"),
    );
    return Buffer.from(detached.fileDigest()).toString("hex") === sha256Hex.toLowerCase();
  } catch {
    return false;
  }
}
