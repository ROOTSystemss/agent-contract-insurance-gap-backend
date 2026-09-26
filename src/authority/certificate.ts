import type { AgentProfile, AgentProfileInput } from "../domain/types.js";

// Reconciles an Authority Atlas agent authority certificate (a signed statement of what an
// organization authorized an AI agent to do) with the agent profile that drives the gap analysis.
//
// Why this matters: the gap engine judges contracts against the CAPABILITIES declared on the
// profile. If the profile says the agent cannot spend money but its signed certificate permits
// payments, the analysis under-reports risk. This module finds those mismatches. It never
// changes anything by itself and gives no legal or insurance advice.

export interface CertificateSummary {
  agentId: string;
  agentName: string;
  organization: string;
  permissions: string[];
  limits: { maxAmountUsd?: number; maxActionsPerDay?: number };
  issuedAt: string;
  expiresAt: string;
}

export type VerifyResult =
  | { ok: true; certificate: CertificateSummary }
  | { ok: false; reason: string };

export type CertificateVerifier = (certificate: string) => Promise<VerifyResult>;

// Asks Authority Atlas (GET /agents/verify) whether a certificate is genuine, unexpired and not
// revoked. Fails closed: any problem reaching or understanding Atlas is "verifier_unavailable".
export function createAtlasVerifier(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5000,
): CertificateVerifier {
  return async (certificate) => {
    try {
      const response = await fetchImpl(
        `${baseUrl}/agents/verify?certificate=${encodeURIComponent(certificate)}`,
        { signal: AbortSignal.timeout(timeoutMs) },
      );
      if (!response.ok) return { ok: false, reason: "verifier_unavailable" };
      const body = (await response.json()) as {
        valid?: boolean;
        reason?: string;
        certificate?: CertificateSummary;
      };
      if (body.valid === true && body.certificate && Array.isArray(body.certificate.permissions)) {
        return { ok: true, certificate: body.certificate };
      }
      return { ok: false, reason: typeof body.reason === "string" ? body.reason : "invalid_certificate" };
    } catch {
      return { ok: false, reason: "verifier_unavailable" };
    }
  };
}

export type CapabilityKey =
  | "canCommunicateExternally"
  | "canMakeRepresentations"
  | "canAcceptTerms"
  | "canExecuteTransactions"
  | "canSpendMoney"
  | "canIssueRefundsOrCredits"
  | "canChangePrices"
  | "canEnterContracts"
  | "canApproveOrRejectPeople"
  | "canApproveOrRejectVendors"
  | "canAccessPersonalData"
  | "canAccessSensitivePersonalData"
  | "canAccessConfidentialBusinessData"
  | "canAccessRegulatedData"
  | "canModifyOrDeleteData"
  | "canPublishContent"
  | "canDeployCode"
  | "canControlInfrastructure"
  | "canHireOrTerminateWorkers"
  | "canDelegateToSubAgents";

export const ALL_CAPABILITIES: CapabilityKey[] = [
  "canCommunicateExternally",
  "canMakeRepresentations",
  "canAcceptTerms",
  "canExecuteTransactions",
  "canSpendMoney",
  "canIssueRefundsOrCredits",
  "canChangePrices",
  "canEnterContracts",
  "canApproveOrRejectPeople",
  "canApproveOrRejectVendors",
  "canAccessPersonalData",
  "canAccessSensitivePersonalData",
  "canAccessConfidentialBusinessData",
  "canAccessRegulatedData",
  "canModifyOrDeleteData",
  "canPublishContent",
  "canDeployCode",
  "canControlInfrastructure",
  "canHireOrTerminateWorkers",
  "canDelegateToSubAgents",
];

// Permission strings look like "domain:action" ("invoices:pay", "email:send", "customers:*").
// Each rule maps a family of them to the profile capabilities they imply. The mapping is
// deliberately conservative: when in doubt a permission implies MORE capability, not less,
// because understating authority is the harmful direction.
const RULES: Array<{ test: RegExp; grants: CapabilityKey[] }> = [
  { test: /^(payments|payouts|spend|purchases|purchasing|billing)(:|$)/, grants: ["canSpendMoney", "canExecuteTransactions"] },
  { test: /^invoices:(pay|approve|send|\*)$/, grants: ["canSpendMoney", "canExecuteTransactions"] },
  { test: /^orders:(place|create|approve|\*)$/, grants: ["canSpendMoney", "canExecuteTransactions"] },
  { test: /^(refunds|credits)(:|$)/, grants: ["canIssueRefundsOrCredits", "canExecuteTransactions"] },
  { test: /^pricing(:|$)/, grants: ["canChangePrices"] },
  { test: /^contracts:(sign|accept|enter|create|\*)$/, grants: ["canEnterContracts", "canAcceptTerms"] },
  { test: /^terms:(accept|\*)$/, grants: ["canAcceptTerms"] },
  { test: /^(email|sms|messages|chat|social|external|calls)(:|$)/, grants: ["canCommunicateExternally"] },
  { test: /^(statements|quotes|proposals|claims)(:|$)/, grants: ["canMakeRepresentations", "canCommunicateExternally"] },
  { test: /^(customers|users|contacts|pii|people|patients)(:|$)/, grants: ["canAccessPersonalData"] },
  { test: /^(phi|health|medical|ssn|biometric|children)(:|$)/, grants: ["canAccessPersonalData", "canAccessSensitivePersonalData", "canAccessRegulatedData"] },
  { test: /^(documents|files|drive|crm|finance|contracts)(:|$)/, grants: ["canAccessConfidentialBusinessData"] },
  { test: /:(delete|remove|purge|write|update|edit|\*)$/, grants: ["canModifyOrDeleteData"] },
  { test: /^(code|deploy|ci|release)(:|$)/, grants: ["canDeployCode"] },
  { test: /^(infra|cloud|iam|servers|dns|network)(:|$)/, grants: ["canControlInfrastructure"] },
  { test: /^(hr|hiring|employees|workers)(:|$)/, grants: ["canHireOrTerminateWorkers"] },
  { test: /^(applicants|candidates|people):(approve|reject|decide|\*)$/, grants: ["canApproveOrRejectPeople"] },
  { test: /^vendors:(approve|reject|onboard|\*)$/, grants: ["canApproveOrRejectVendors"] },
  { test: /^(content|blog|website|social|press):(publish|post|\*)$/, grants: ["canPublishContent"] },
  { test: /^agents:(delegate|spawn|\*)$/, grants: ["canDelegateToSubAgents"] },
];

// Plain read-only permissions imply no capability from this list.
const READ_ONLY = /:(read|list|get|view|search)$/;

export interface DerivedAuthority {
  capabilities: CapabilityKey[];
  perTransactionLimitUsd?: number;
  maxActionsPerDay?: number;
  unmappedPermissions: string[];
  broadAuthority: boolean;
}

export function deriveAuthority(summary: CertificateSummary): DerivedAuthority {
  const granted = new Set<CapabilityKey>();
  const unmapped: string[] = [];
  let broad = false;
  for (const raw of summary.permissions) {
    const permission = raw.toLowerCase();
    if (permission === "*") {
      broad = true;
      for (const key of ALL_CAPABILITIES) granted.add(key);
      continue;
    }
    let matched = false;
    for (const rule of RULES) {
      if (rule.test.test(permission)) {
        matched = true;
        for (const key of rule.grants) granted.add(key);
      }
    }
    if (!matched && !READ_ONLY.test(permission)) unmapped.push(raw);
  }
  return {
    capabilities: ALL_CAPABILITIES.filter((key) => granted.has(key)),
    perTransactionLimitUsd: summary.limits.maxAmountUsd,
    maxActionsPerDay: summary.limits.maxActionsPerDay,
    unmappedPermissions: unmapped,
    broadAuthority: broad,
  };
}

export type DifferenceKind =
  | "profile_understates_certificate"
  | "profile_not_covered_by_certificate"
  | "profile_limit_below_certificate"
  | "profile_limit_above_certificate"
  | "limit_not_comparable";

export interface Difference {
  kind: DifferenceKind;
  severity: "high" | "moderate" | "informational";
  capability?: CapabilityKey;
  message: string;
}

export interface Reconciliation {
  certificate: CertificateSummary;
  derived: DerivedAuthority;
  differences: Difference[];
  // True when the profile does not understate what the certificate authorizes.
  profileCoversCertificate: boolean;
}

const LABEL = (key: CapabilityKey): string => key.replace(/^can/, "").replace(/([A-Z])/g, " $1").trim().toLowerCase();

export function reconcile(profile: AgentProfile, summary: CertificateSummary): Reconciliation {
  const derived = deriveAuthority(summary);
  const differences: Difference[] = [];

  for (const key of ALL_CAPABILITIES) {
    const declared = profile[key] === true;
    const certified = derived.capabilities.includes(key);
    if (certified && !declared) {
      differences.push({
        kind: "profile_understates_certificate",
        severity: "high",
        capability: key,
        message: `The certificate authorizes ${LABEL(key)}, but the profile says the agent cannot. The gap analysis would under-report risk.`,
      });
    } else if (declared && !certified) {
      differences.push({
        kind: "profile_not_covered_by_certificate",
        severity: "moderate",
        capability: key,
        message: `The profile declares ${LABEL(key)}, but no permission on this certificate authorizes it. Either issue authority for it or correct the profile.`,
      });
    }
  }

  const certifiedLimit = derived.perTransactionLimitUsd;
  if (certifiedLimit !== undefined && profile.canSpendMoney) {
    if (profile.currency && profile.currency !== "USD") {
      differences.push({
        kind: "limit_not_comparable",
        severity: "informational",
        message: `The certificate limit is in USD but the profile uses ${profile.currency}; compare them manually.`,
      });
    } else if (profile.perTransactionLimit !== undefined) {
      if (profile.perTransactionLimit < certifiedLimit) {
        differences.push({
          kind: "profile_limit_below_certificate",
          severity: "high",
          message: `The profile's per-transaction limit (${profile.perTransactionLimit}) is below what the certificate allows (${certifiedLimit}). The analysis assumes the agent can spend less than it is authorized to.`,
        });
      } else if (profile.perTransactionLimit > certifiedLimit) {
        differences.push({
          kind: "profile_limit_above_certificate",
          severity: "moderate",
          message: `The profile's per-transaction limit (${profile.perTransactionLimit}) is above the certificate's (${certifiedLimit}).`,
        });
      }
    }
  }

  return {
    certificate: summary,
    derived,
    differences,
    profileCoversCertificate: !differences.some(
      (d) => d.kind === "profile_understates_certificate" || d.kind === "profile_limit_below_certificate",
    ),
  };
}

// Builds the profile changes that bring an under-stated profile up to what its certificate
// authorizes. ESCALATION ONLY: it turns capabilities on and raises limits, never the reverse, so
// adopting a certificate can only make the analysis more cautious. Returns null when a spending
// capability would be added but the certificate gives no limit to go with it (the profile schema
// requires one, and inventing a number would be wrong).
export function escalationPatch(
  profile: AgentProfile,
  summary: CertificateSummary,
): { patch: Partial<AgentProfileInput>; changed: string[] } | { error: string } {
  const derived = deriveAuthority(summary);
  const patch: Partial<AgentProfileInput> = {};
  const changed: string[] = [];
  for (const key of derived.capabilities) {
    if (profile[key] !== true) {
      (patch as Record<string, unknown>)[key] = true;
      changed.push(key);
    }
  }
  const spends = profile.canSpendMoney || derived.capabilities.includes("canSpendMoney");
  if (spends) {
    const usdLimit = derived.perTransactionLimitUsd;
    if (usdLimit === undefined && profile.perTransactionLimit === undefined) {
      return { error: "The certificate authorizes spending but sets no maxAmountUsd, and the profile has no per-transaction limit. Set the limit on the profile explicitly." };
    }
    if (profile.currency && profile.currency !== "USD" && usdLimit !== undefined) {
      return { error: `The certificate limit is in USD but the profile uses ${profile.currency}. Update the profile's limit manually.` };
    }
    if (usdLimit !== undefined && (profile.perTransactionLimit === undefined || profile.perTransactionLimit < usdLimit)) {
      patch.perTransactionLimit = usdLimit;
      changed.push("perTransactionLimit");
    }
    if (!profile.currency) {
      patch.currency = "USD";
      changed.push("currency");
    }
  }
  return { patch, changed };
}
