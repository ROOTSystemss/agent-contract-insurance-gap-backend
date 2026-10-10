import type { Organization } from "../domain/types.js";
import type { Store } from "../persistence/store.js";
import type { AtlasCertificate, GovernanceGateway, LedgerAction } from "./gateway.js";
import { isTrunkActive } from "./trunk.js";

// RootSystems Trunk: continuous authority checks. Once a day, every Trunk workspace's agent authority
// is re-checked against Authority Atlas and the Trust Proof ledger:
//   - a certificate expiring within 14 days, or an agent left with no valid certificate
//   - an action recorded after its certificate was revoked or had expired
//   - an agent over its certificate's maxActionsPerDay on a day
//   - an action outside authority (also alerted in real time by Trust Proof webhooks; listed here so
//     the daily summary is complete)
//   - the ledger's hash chain no longer verifying
// When something new needs attention, the workspace owners and admins get one email (when mail is
// configured). The stored state records when each check and alert ran; a check a person starts with
// "Check now" is also written to the audit log under their name (the console route does that).
//
// Data minimisation: only item keys (certificate / agent / action ids + rule names) and times are
// stored; the email carries counts by kind, never agent names or actions.

const DAY = 86_400_000;
const SOON_DAYS = 14;
const RECENT_DAYS = 7;

export type WatchSeverity = "critical" | "high" | "normal";
export interface WatchItem {
  key: string;
  kind:
    | "expiring"
    | "uncovered"
    | "after_revocation"
    | "over_daily_limit"
    | "outside_authority"
    | "chain";
  severity: WatchSeverity;
  title: string;
  why: string;
}

export const KIND_LABELS: Record<WatchItem["kind"], string> = {
  expiring: "certificate expiring soon",
  uncovered: "agent with no valid certificate",
  after_revocation: "action after its certificate was revoked or expired",
  over_daily_limit: "agent over its daily action limit",
  outside_authority: "action outside authority",
  chain: "ledger chain that does not verify",
};

const day = (iso: string) => new Date(iso).toISOString().slice(0, 10);

export interface WatchInputs {
  certificates: AtlasCertificate[];
  actions: LedgerAction[];
  chainValid: boolean | null; // null = not checked
}

// Pure: the same inputs and day always give the same items. Most urgent first.
export function computeAuthorityWatch(
  inputs: WatchInputs,
  asOf: Date = new Date(),
): { asOf: string; items: WatchItem[] } {
  const now = asOf.getTime();
  const items: WatchItem[] = [];
  const add = (item: WatchItem) => items.push(item);
  const label = (c: AtlasCertificate) => c.agentName || c.agentId;

  if (inputs.chainValid === false) {
    add({
      key: "ledger:chain:broken",
      kind: "chain",
      severity: "critical",
      title: "The action ledger's hash chain does not verify",
      why: "A recorded action was changed or removed after it was written. Check the ledger in Trust Proof.",
    });
  }

  const byAgent = new Map<string, AtlasCertificate[]>();
  for (const c of inputs.certificates)
    byAgent.set(c.agentId, [...(byAgent.get(c.agentId) ?? []), c]);
  for (const [agent, certs] of byAgent) {
    const active = certs.filter((c) => c.status === "active" && Date.parse(c.expiresAt) > now);
    if (!active.length) {
      const latest = [...certs].sort((a, b) => Date.parse(b.issuedAt) - Date.parse(a.issuedAt))[0]!;
      const acting = inputs.actions.some(
        (a) => a.agentId === agent && now - Date.parse(a.occurredAt) <= RECENT_DAYS * DAY,
      );
      if (acting) {
        add({
          key: `agent:${agent}:uncovered`,
          kind: "uncovered",
          severity: "high",
          title: `Agent has no valid certificate: ${label(latest)}`,
          why: `Its latest certificate is ${latest.status}${latest.revokedAt ? " since " + day(latest.revokedAt) : " (expires " + day(latest.expiresAt) + ")"}, and it recorded actions in the last ${RECENT_DAYS} days.`,
        });
      }
      continue;
    }
    // Only warn about expiry when no other active certificate outlives the soon window.
    const longest = active.reduce((a, b) =>
      Date.parse(a.expiresAt) >= Date.parse(b.expiresAt) ? a : b,
    );
    const left = Math.ceil((Date.parse(longest.expiresAt) - now) / DAY);
    if (left <= SOON_DAYS) {
      add({
        key: `cert:${longest.jti}:expiring`,
        kind: "expiring",
        severity: "normal",
        title: `Certificate expires in ${left} day(s): ${label(longest)}`,
        why: `It expires on ${day(longest.expiresAt)}. Issue a new one before then or the agent's actions will be outside authority.`,
      });
    }
  }

  const certByJti = new Map(inputs.certificates.map((c) => [c.jti, c]));
  const perDay = new Map<string, number>();
  for (const a of inputs.actions) {
    const cert = certByJti.get(a.certificateJti);
    const at = Date.parse(a.occurredAt);
    if (cert) {
      const revokedAt = cert.revokedAt ? Date.parse(cert.revokedAt) : null;
      if ((revokedAt !== null && at > revokedAt) || at > Date.parse(cert.expiresAt)) {
        add({
          key: `action:${a.id}:after_revocation`,
          kind: "after_revocation",
          severity: "critical",
          title: `Action after the certificate ${revokedAt !== null && at > revokedAt ? "was revoked" : "expired"}: ${label(cert)}`,
          why: `"${a.action}" on ${day(a.occurredAt)} used certificate ${cert.jti.slice(0, 8)}, ${revokedAt !== null && at > revokedAt ? "revoked on " + day(cert.revokedAt!) : "expired on " + day(cert.expiresAt)}.`,
        });
      }
      const k = `${cert.jti}|${day(a.occurredAt)}`;
      perDay.set(k, (perDay.get(k) ?? 0) + 1);
    }
    if (a.verdict === "outside_authority" && now - at <= RECENT_DAYS * DAY) {
      add({
        key: `action:${a.id}:outside_authority`,
        kind: "outside_authority",
        severity: "high",
        title: `Action outside authority: ${cert ? label(cert) : a.agentId}`,
        why: `"${a.action}" on ${day(a.occurredAt)}: ${(a.reasons || []).join("; ") || "outside the certificate's permissions or limits"}.`,
      });
    }
  }
  for (const [k, count] of perDay) {
    const [jti, date] = k.split("|") as [string, string];
    const cert = certByJti.get(jti)!;
    const limit = cert.limits?.maxActionsPerDay;
    if (limit && count > limit && now - Date.parse(date + "T00:00:00Z") <= RECENT_DAYS * DAY) {
      add({
        key: `cert:${jti}:over_daily_limit:${date}`,
        kind: "over_daily_limit",
        severity: "high",
        title: `Over its daily action limit: ${label(cert)}`,
        why: `${count} actions on ${date}; the certificate allows ${limit} a day.`,
      });
    }
  }

  const order: Record<WatchSeverity, number> = { critical: 0, high: 1, normal: 2 };
  items.sort((a, b) => order[a.severity] - order[b.severity] || a.key.localeCompare(b.key));
  return { asOf: asOf.toISOString(), items };
}

export function summarise(items: WatchItem[]): string[] {
  const counts = new Map<WatchItem["kind"], number>();
  for (const it of items) counts.set(it.kind, (counts.get(it.kind) ?? 0) + 1);
  return [...counts].map(([kind, n]) => `${n} ${KIND_LABELS[kind]}${n === 1 ? "" : " (items)"}`);
}

export type WatchMailer = (
  to: string[],
  workspace: string,
  lines: string[],
  url: string,
) => Promise<{ sent: boolean }>;

// One plain-text email through Resend when RESEND_API_KEY and MAIL_FROM are set; otherwise nothing is
// sent and the audit log still records the run.
export const resendMailer: WatchMailer = async (to, workspace, lines, url) => {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM;
  if (!key || !from || to.length === 0) return { sent: false };
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to,
        subject: `Agent authority: new items need attention in ${workspace}`,
        text: `Today's check of ${workspace} found:\n- ${lines.join("\n- ")}\n\nSee the details: ${url}\n\nYou get one email when something new needs attention, not a daily digest.`,
      }),
    });
    return { sent: response.ok };
  } catch {
    return { sent: false };
  }
};

export async function gatherInputs(
  gateway: GovernanceGateway,
  organization: Organization,
): Promise<WatchInputs> {
  const [certificates, ledger, chain] = await Promise.all([
    gateway.listCertificates(organization),
    gateway.ledger(organization, { limit: 1000 }),
    gateway.verifyLedger(organization).catch(() => null),
  ]);
  const chainValid =
    chain && typeof chain === "object" && "valid" in chain ? Boolean(chain.valid) : null;
  return { certificates, actions: ledger.actions, chainValid };
}

export interface CheckDeps {
  store: Store;
  gateway: GovernanceGateway;
  mailer?: WatchMailer;
  appUrl?: string;
  now?: Date;
}

// Checks one workspace, stores the new key set, alerts on what is new, and audits the run.
export async function checkWorkspace(organization: Organization, deps: CheckDeps) {
  const now = deps.now ?? new Date();
  const result = computeAuthorityWatch(await gatherInputs(deps.gateway, organization), now);
  const previous = new Set((await deps.store.getTrunkWatchState(organization.id))?.keys ?? []);
  const newItems = result.items.filter((it) => !previous.has(it.key));
  let alerted = false;
  if (newItems.length) {
    const members = await deps.store.listMembers(organization.id);
    const to = members
      .filter((m) => m.role === "owner" || m.role === "admin")
      .map((m) => m.user.email);
    alerted = (
      await (deps.mailer ?? resendMailer)(
        to,
        organization.name,
        summarise(newItems),
        `${deps.appUrl ?? ""}/console#settings`,
      )
    ).sent;
  }
  const prior = await deps.store.getTrunkWatchState(organization.id);
  await deps.store.saveTrunkWatchState({
    organizationId: organization.id,
    keys: result.items.map((it) => it.key),
    checkedAt: now.toISOString(),
    alertedAt: alerted ? now.toISOString() : (prior?.alertedAt ?? null),
  });
  return { result, newItems, alerted };
}

// The daily run over every Trunk workspace (TRUNK_ORGANIZATION_IDS) that is linked to the services.
export async function runAll(deps: CheckDeps, env: NodeJS.ProcessEnv = process.env) {
  let checked = 0;
  let alerts = 0;
  const ids = String(env.TRUNK_ORGANIZATION_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const id of ids) {
    if (!isTrunkActive(id, env)) continue;
    const organization = await deps.store.getOrganization(id);
    if (!organization || !(await deps.store.getServiceLink(id))) continue;
    try {
      const { alerted } = await checkWorkspace(organization, deps);
      checked++;
      if (alerted) alerts++;
    } catch {
      // One workspace's upstream failure must not stop the others; the next day retries.
    }
  }
  return { checked, alerts };
}
