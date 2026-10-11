// RootSystems Trunk: the verified-evidence upgrade, the same idea as in the compliance products
// (their src/lib/trunk.js). The base plans (Trial/Team/Business) are unchanged; Trunk adds proof
// that holds up outside this console.
//
// Until Trunk has its own Dodo product it is sold by conversation: the console button records the
// interest in the workspace audit log and opens the contact form, and Trunk is switched on per
// workspace with TRUNK_ORGANIZATION_IDS (comma-separated workspace ids).
//
// `status` keeps the panel honest: "live" = in this console now, "by-hand" = we deliver it for
// Trunk customers while it is built in, "coming" = not available yet.

export type TrunkStatus = "live" | "by-hand" | "coming";

export interface TrunkFeature {
  id: string;
  title: string;
  text: string;
  status: TrunkStatus;
}

export const TRUNK_CONTACT_URL = `https://rootsystems.app/contact?topic=${encodeURIComponent("RootSystems Trunk (AI Agent Trust)")}`;

export const TRUNK_STATUS_LABELS: Record<TrunkStatus, string> = {
  live: "Live",
  "by-hand": "Delivered by our team",
  coming: "Coming",
};

export const TRUNK_FEATURES: TrunkFeature[] = [
  {
    id: "verify",
    title: "Evidence anyone can verify",
    text: "Assurance Packs and the action ledger are signed with ML-DSA-65 (the algorithm in NIST FIPS 204) and hash-chained. An auditor or insurer checks them without an account or trusting us.",
    status: "live",
  },
  {
    id: "authority-review",
    title: "Authority vs. contracts review",
    text: "We compare what your agents' certificates allow with what your contracts and insurance policies contemplate, and hand over a signed gap report with the reason for each finding.",
    status: "by-hand",
  },
  {
    id: "two-timestamps",
    title: "Two independent timestamps",
    text: "A Bitcoin-anchored OpenTimestamps proof plus a standard RFC 3161 timestamp from a public timestamp authority on every Assurance Pack, checkable at the pack verify endpoint.",
    // Built in; live where FEATURE_RFC3161=1 (the RFC 3161 half is off without it).
    get status(): TrunkStatus {
      return process.env.FEATURE_RFC3161 === "1" ? "live" : "by-hand";
    },
  },
  {
    id: "continuous",
    title: "Continuous authority checks",
    text: "Every day certificates, limits and ledger verdicts are re-checked: expiring certificates, agents left without one, actions after a revocation, daily limits exceeded and a ledger chain that no longer verifies. Owners and admins are emailed when something new appears.",
    status: "live",
  },
];

// Master switch. Trunk is parked until its storefront is decided: on the live server
// (NODE_ENV=production) it is OFF unless TRUNK_ENABLED=1 - no Settings panel, no Trunk endpoints,
// no Trunk features even for a granted workspace. Local runs and tests have it on unless
// TRUNK_ENABLED=0.
export function isTrunkEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.TRUNK_ENABLED === "1") return true;
  if (env.TRUNK_ENABLED === "0") return false;
  return env.NODE_ENV !== "production";
}

export function isTrunkActive(
  organizationId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isTrunkEnabled(env)) return false;
  return String(env.TRUNK_ORGANIZATION_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(organizationId);
}

export const KEYRING_FORMAT = "rootsystems.keyring/v1";

// The signing key history (rootsystems.keyring/v1, the format of @rootsystems/core's keyring.js).
// One key today; after a rotation PQ_KEY_HISTORY_JSON holds the full endorsed keyring and is served
// as long as its active key is the one signing now.
export function keyHistory(
  info: { configured: boolean; algorithm: string; keyId?: string; publicKey?: string },
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!info.configured || !info.publicKey || !info.keyId) return null;
  const raw = env.PQ_KEY_HISTORY_JSON;
  if (raw) {
    try {
      const ring = JSON.parse(raw) as {
        format?: string;
        keys?: Array<{ status?: string; publicKey?: string }>;
      };
      const active = Array.isArray(ring.keys)
        ? ring.keys.filter((key) => key.status === "active")
        : [];
      if (
        ring.format === KEYRING_FORMAT &&
        active.length === 1 &&
        active[0]?.publicKey === info.publicKey
      )
        return ring;
    } catch {
      // fall through to the single-key history
    }
  }
  return {
    format: KEYRING_FORMAT,
    product: "agent-governance",
    keys: [
      {
        keyId: info.keyId,
        algorithm: info.algorithm,
        publicKey: info.publicKey,
        status: "active",
        validFrom: null,
        validUntil: null,
      },
    ],
  };
}
