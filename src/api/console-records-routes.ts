import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Organization } from "../domain/types.js";
import type { AtlasCertificate } from "../governance/gateway.js";
import { createHash, randomUUID } from "node:crypto";
import { AppError, notFound } from "../shared/errors.js";
import { POLICY_TEMPLATES } from "../governance/policy-templates.js";
import { checkChain, recordReceipt } from "../evidence/receipts.js";
import { BROKER_PACK_SCHEMA, signDocument } from "../reports/signed-document.js";
import { CANONICAL_DISCLAIMER } from "../shared/disclaimer.js";
import { actor, audit, requireRole, success } from "./helpers.js";

export const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

// Console governance records (knock-out Phase 5, 2026-11-17). Everything here is this workspace's own record
// keeping on top of the live chain (Authority Atlas certificates, Trust Proof ledger and approvals):
//   - AD-056 agent inventory: every agent with its owner, vendor, purpose and data access. Owner, vendor, purpose
//     and data access are what a person in the workspace entered (attested); certificate status is read live from
//     Authority Atlas. When Atlas cannot be read the status says "not verified", never a guess.
// Decision support only: nothing here is legal or insurance advice.

export const agentIdSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/, "Agent id: 1-100 letters, digits or . _ : -");
const agentParams = z.object({ agentId: agentIdSchema });
const agentBody = z
  .object({
    name: z.string().trim().min(1).max(100),
    // A role or team ("Finance operations lead"), not a personal email address.
    owner: z.string().trim().min(2).max(120),
    vendor: z.string().trim().max(120).default(""),
    purpose: z.string().trim().max(500).default(""),
    dataAccess: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  })
  .strict();

export type CertificateSource = "authority-atlas" | "not-activated" | "not-verified";

export interface InventoryRow {
  agentId: string;
  name: string;
  owner: string | null;
  vendor: string | null;
  purpose: string | null;
  dataAccess: string[];
  registered: boolean;
  certificates: { active: number; revoked: number; expired: number; activeJtis: string[]; firstIssuedAt: string | null } | null;
  status: "active" | "revoked" | "expired" | "no certificate" | "not verified";
}

// Spreadsheet programs run a cell that starts with = + - @ (or tab/CR) as a formula; prefix those with '.
export const csvCell = (value: unknown): string => {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export const consoleRecordsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", async (request) => {
    await app.accountSecurity.requireVerified(actor(request).userId);
  });

  async function workspace(request: FastifyRequest): Promise<Organization> {
    const organization = await app.store.getOrganization(actor(request).organizationId);
    if (!organization) throw notFound("Workspace");
    return organization;
  }

  // Certificates from Authority Atlas, or why they could not be read (three-state: never "none" on a failure).
  async function readCertificates(organization: Organization): Promise<{ source: CertificateSource; certificates: AtlasCertificate[] }> {
    const status = app.governance.status();
    if (!status.atlas || !(await app.store.getServiceLink(organization.id))) return { source: "not-activated", certificates: [] };
    try {
      return { source: "authority-atlas", certificates: await app.governance.listCertificates(organization) };
    } catch (error) {
      app.log.warn({ err: (error as Error).message }, "inventory: Authority Atlas could not be read");
      return { source: "not-verified", certificates: [] };
    }
  }

  async function inventory(organization: Organization): Promise<{ source: CertificateSource; agents: InventoryRow[] }> {
    const [{ source, certificates }, records] = await Promise.all([
      readCertificates(organization),
      app.store.listConsoleRecords(organization.id, "agent"),
    ]);
    const byAgent = new Map<string, AtlasCertificate[]>();
    for (const cert of certificates) byAgent.set(cert.agentId, [...(byAgent.get(cert.agentId) ?? []), cert]);
    const ids = new Set<string>([...records.map((r) => r.key), ...byAgent.keys()]);
    const agents: InventoryRow[] = [...ids].sort().map((agentId) => {
      const record = records.find((r) => r.key === agentId);
      const data = (record?.data ?? {}) as { name?: string; owner?: string; vendor?: string; purpose?: string; dataAccess?: string[] };
      const certs = byAgent.get(agentId) ?? [];
      const counts = source === "authority-atlas"
        ? {
            active: certs.filter((c) => c.status === "active").length,
            revoked: certs.filter((c) => c.status === "revoked").length,
            expired: certs.filter((c) => c.status === "expired").length,
            activeJtis: certs.filter((c) => c.status === "active").map((c) => c.jti),
            firstIssuedAt: certs.map((c) => c.issuedAt).sort()[0] ?? null,
          }
        : null;
      const status: InventoryRow["status"] = source !== "authority-atlas"
        ? "not verified"
        : counts!.active > 0 ? "active" : counts!.revoked > 0 ? "revoked" : counts!.expired > 0 ? "expired" : "no certificate";
      return {
        agentId,
        name: data.name ?? certs.find((c) => c.agentName)?.agentName ?? agentId,
        owner: data.owner ?? null,
        vendor: data.vendor || null,
        purpose: data.purpose || null,
        dataAccess: data.dataAccess ?? [],
        registered: Boolean(record),
        certificates: counts,
        status,
      };
    });
    return { source, agents };
  }
  app.decorate("consoleInventory", inventory);

  const SOURCE_NOTE: Record<CertificateSource, string> = {
    "authority-atlas": "Certificate status read live from Agent Certificates. Owner, vendor, purpose and data access are as entered by this workspace (attested, not verified).",
    "not-activated": "Certificates are not read yet: the console is not activated for this workspace. Statuses read 'not verified'.",
    "not-verified": "Agent Certificates could not be read just now, so certificate statuses read 'not verified'. Try again in a minute.",
  };

  // ---------- AD-056 agent inventory ----------
  app.get("/agents", async (request) => {
    const organization = await workspace(request);
    const { source, agents } = await inventory(organization);
    return success(request, { certificateSource: source, note: SOURCE_NOTE[source], agents });
  });

  app.get("/agents.csv", async (request, reply) => {
    const organization = await workspace(request);
    const { source, agents } = await inventory(organization);
    const header = ["agent_id", "name", "owner", "vendor", "purpose", "data_access", "status", "active_certificates", "revoked_certificates", "expired_certificates", "certificate_source"];
    const lines = agents.map((a) => [a.agentId, a.name, a.owner, a.vendor, a.purpose, a.dataAccess.join("; "), a.status, a.certificates?.active ?? "", a.certificates?.revoked ?? "", a.certificates?.expired ?? "", source].map(csvCell).join(","));
    return reply
      .header("Content-Disposition", 'attachment; filename="agent-inventory.csv"')
      .header("Cache-Control", "no-store")
      .type("text/csv; charset=utf-8")
      .send([header.join(","), ...lines].join("\n") + "\n");
  });

  app.put("/agents/:agentId", async (request) => {
    requireRole(request, "analyst");
    const organization = await workspace(request);
    const { agentId } = agentParams.parse(request.params);
    const input = agentBody.parse(request.body);
    const existed = Boolean(await app.store.getConsoleRecord(organization.id, "agent", agentId));
    const saved = await app.store.saveConsoleRecord({ organizationId: organization.id, kind: "agent", key: agentId, data: { ...input } });
    await audit(app.store, request, "organization", organization.id, existed ? "console.agent_updated" : "console.agent_registered", { agentId });
    return success(request, { agentId, ...saved.data });
  });

  // ---------- AD-058 periodic re-certification ----------
  // An admin re-approves each agent's permissions every N days (default 90). Each decision is recorded (note sealed
  // at rest) and becomes a signed "agent-recertified" receipt. The clock starts at the last re-certification, else
  // the first certificate issued, else when the agent was added to the inventory.
  const recertSettingsBody = z.object({ cadenceDays: z.number().int().min(30).max(365) }).strict();
  const recertBody = z
    .object({ decision: z.enum(["keep", "reduce", "revoke-requested"]), note: z.string().trim().min(3).max(1000) })
    .strict();
  async function cadenceDays(organizationId: string): Promise<number> {
    const saved = await app.store.getConsoleRecord(organizationId, "settings", "recertification");
    return Number((saved?.data as { cadenceDays?: number } | undefined)?.cadenceDays ?? 90);
  }
  const DAY = 864e5;
  async function recertification(organization: Organization, now = Date.now()) {
    const [{ source, agents }, history, days] = await Promise.all([
      inventory(organization),
      app.store.listConsoleRecords(organization.id, "recert"),
      cadenceDays(organization.id),
    ]);
    const agentRecords = await app.store.listConsoleRecords(organization.id, "agent");
    return {
      cadenceDays: days,
      certificateSource: source,
      agents: agents.map((agent) => {
        const mine = history.filter((h) => (h.data as { agentId?: string }).agentId === agent.agentId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const last = mine.at(-1)?.data as { decision?: string; at?: string } | undefined;
        const base = last?.at ?? agent.certificates?.firstIssuedAt ?? agentRecords.find((r) => r.key === agent.agentId)?.createdAt ?? null;
        const dueAt = base ? new Date(Date.parse(base) + days * DAY).toISOString() : null;
        const state = !base ? "never" : !last ? (Date.parse(dueAt!) < now ? "overdue" : "not yet re-certified") : Date.parse(dueAt!) < now ? "overdue" : Date.parse(dueAt!) - now < 14 * DAY ? "due soon" : "current";
        return { agentId: agent.agentId, name: agent.name, status: agent.status, lastRecertifiedAt: last?.at ?? null, lastDecision: last?.decision ?? null, dueAt, state, history: mine.length };
      }),
    };
  }

  app.get("/recertification", async (request) => {
    const organization = await workspace(request);
    return success(request, await recertification(organization));
  });

  app.put("/recertification/settings", async (request) => {
    requireRole(request, "admin");
    const organization = await workspace(request);
    const input = recertSettingsBody.parse(request.body);
    await app.store.saveConsoleRecord({ organizationId: organization.id, kind: "settings", key: "recertification", data: input });
    await audit(app.store, request, "organization", organization.id, "console.recertification_cadence_set", { cadenceDays: input.cadenceDays });
    return success(request, input);
  });

  app.post("/agents/:agentId/recertify", async (request, reply) => {
    requireRole(request, "admin");
    const organization = await workspace(request);
    const { agentId } = agentParams.parse(request.params);
    const input = recertBody.parse(request.body);
    const { agents } = await inventory(organization);
    if (!agents.some((a) => a.agentId === agentId)) throw notFound("Agent");
    const at = new Date().toISOString();
    const days = await cadenceDays(organization.id);
    const nextDueAt = new Date(Date.parse(at) + days * DAY).toISOString();
    const reviewerUserId = actor(request).userId;
    await app.store.saveConsoleRecord({ organizationId: organization.id, kind: "recert", key: `${agentId}:${at}`, data: { agentId, decision: input.decision, note: input.note, reviewerUserId, at, nextDueAt } });
    await audit(app.store, request, "organization", organization.id, "console.agent_recertified", { agentId, decision: input.decision });
    const receipt = await recordReceipt(app.store, app.pqSigner, {
      orgId: organization.id, type: "agent-recertified", subject: { kind: "agent", id: agentId },
      facts: { decision: input.decision, reviewerUserId, cadenceDays: days, nextDueAt, noteSha256: sha256Hex(input.note) },
    }, request.log);
    return reply.code(201).send(success(request, {
      agentId, decision: input.decision, at, nextDueAt, receiptSeq: receipt?.seq ?? null,
      ...(input.decision === "revoke-requested" ? { next: "Recorded only. To stop the agent, use the kill switch (it revokes the agent's certificates and records the proof)." } : {}),
    }));
  });

  // ---------- AD-059 insurance broker pack ----------
  // A signed summary of how this workspace governs its agents, for a conversation with a broker or insurer, plus the
  // questions worth asking them. Same signed format as the Agent Assurance Pack, so the public /verify checks it.
  // Counts and roles only: no contract text, no ledger details, no personal data.
  const BROKER_QUESTIONS = [
    "When an AI agent takes an action on our behalf, does the policy treat it as our action, and is that covered or excluded?",
    "Is there an exclusion for losses caused by automated or AI decision-making? Please share the exact wording.",
    "Are payments or changes an agent makes within its approved limits treated differently from ones outside them?",
    "Would signed records of an agent's authority (certificates, the action ledger, named approvals) help when a claim is assessed?",
    "What notice do you need after an agent error, and within how many days?",
    "Are failures of a third-party AI vendor's model or service covered, or only our own systems?",
    "Is there a sublimit for fraudulent instructions or social engineering that involve an AI agent?",
    "Do you expect named human sign-off for agent permission changes, and is our re-certification cadence acceptable?",
  ];
  async function coverageSummary(organizationId: string) {
    const projects = await app.store.listProjects(organizationId, { page: 1, pageSize: 50 });
    const byAttention: Record<string, number> = {};
    let total = 0;
    for (const project of projects.items) {
      const analyses = await app.store.listAnalyses(organizationId, project.id, { page: 1, pageSize: 50 });
      for (const analysis of analyses.items) {
        total++;
        const label = analysis.attentionScore?.label ?? (analysis.state === "completed" ? "not scored" : analysis.state);
        byAttention[label] = (byAttention[label] ?? 0) + 1;
      }
    }
    return { analyses: total, byAttention, truncated: projects.total > projects.items.length };
  }

  app.post("/broker-pack", async (request, reply) => {
    requireRole(request, "analyst");
    const organization = await workspace(request);
    const [{ source, agents }, recert, incidents, kills, coverage, receiptRecords] = await Promise.all([
      inventory(organization),
      recertification(organization),
      app.store.listConsoleRecords(organization.id, "incident"),
      app.store.listConsoleRecords(organization.id, "kill"),
      coverageSummary(organization.id),
      app.store.listReceipts(organization.id),
    ]);
    const byStatus: Record<string, number> = {};
    for (const a of agents) byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
    const chain = checkChain(organization.id, receiptRecords.map((r) => r.receipt));
    const doc = {
      schema: BROKER_PACK_SCHEMA,
      generatedAt: new Date().toISOString(),
      workspace: { name: organization.name },
      purpose: "How this workspace governs its AI agents, summarised for a conversation with an insurance broker or insurer.",
      agents: {
        certificateSource: source,
        total: agents.length,
        byStatus,
        list: agents.map((a) => {
          const r = recert.agents.find((x) => x.agentId === a.agentId);
          return { agentId: a.agentId, name: a.name, status: a.status, owner: a.owner ?? "not entered", vendor: a.vendor ?? "not entered", dataAccessAreas: a.dataAccess.length, recertification: { state: r?.state ?? "never", lastDecision: r?.lastDecision ?? null, dueAt: r?.dueAt ?? null } };
        }),
      },
      recertification: { cadenceDays: recert.cadenceDays, overdue: recert.agents.filter((a) => a.state === "overdue").length },
      incidents: { recorded: incidents.length, open: incidents.filter((i) => (i.data as { status?: string }).status !== "closed").length },
      killSwitch: { uses: kills.length },
      coverageAnalyses: coverage,
      evidenceChain: { receipts: receiptRecords.length, intact: chain.intact },
      questionsToAsk: BROKER_QUESTIONS,
      limitations: [
        "Owner, vendor, purpose and data access are entered by the workspace (attested), not independently verified.",
        source === "authority-atlas" ? "Certificate statuses were read live from Agent Certificates when this pack was made." : "Certificate statuses could not be read when this pack was made; they read 'not verified'.",
        "Counts only: no contract text, no action-ledger details and no personal data are included.",
      ],
      disclaimer: CANONICAL_DISCLAIMER,
    };
    const signed = signDocument(doc, app.pqSigner);
    await app.store.saveConsoleRecord({ organizationId: organization.id, kind: "broker-pack", key: signed.contentHash, data: { generatedAt: doc.generatedAt, contentHash: signed.contentHash, agents: agents.length } });
    await audit(app.store, request, "organization", organization.id, "console.broker_pack_issued", { contentHash: signed.contentHash });
    await recordReceipt(app.store, app.pqSigner, { orgId: organization.id, type: "broker-pack-issued", subject: { kind: "broker-pack", id: signed.contentHash }, facts: { contentHash: signed.contentHash, agents: agents.length } }, request.log);
    reply.header("Cache-Control", "no-store");
    return reply.code(201).send(success(request, signed));
  });

  app.get("/broker-packs", async (request) => {
    const organization = await workspace(request);
    const rows = await app.store.listConsoleRecords(organization.id, "broker-pack");
    return success(request, rows.map((r) => r.data).reverse());
  });

  // ---------- AD-060 policy templates with signed acknowledgement ----------
  // Admins publish a version of a template (text sealed at rest, SHA-256 + signed "policy-published" receipt); every
  // member acknowledges the CURRENT version (signed "policy-acknowledged" receipt with ids and the text's hash, no
  // name or email). A new version needs new acknowledgements; publishing unchanged text makes no new version.
  type PolicyVersion = { version: number; sha256: string; text: string; publishedAt: string; publishedBy: string };
  const policyParams = z.object({ policyId: z.enum(["ai-use", "agent-approval"]) });
  async function versionsOf(organizationId: string, policyId: string): Promise<PolicyVersion[]> {
    const saved = await app.store.getConsoleRecord(organizationId, "policy", policyId);
    return ((saved?.data as { versions?: PolicyVersion[] } | undefined)?.versions ?? []);
  }

  app.get("/policies", async (request) => {
    const organization = await workspace(request);
    const me = actor(request).userId;
    const acks = await app.store.listConsoleRecords(organization.id, "policy-ack");
    const out = [];
    for (const template of POLICY_TEMPLATES) {
      const versions = await versionsOf(organization.id, template.id);
      const current = versions.at(-1) ?? null;
      out.push({
        id: template.id, title: template.title, supports: template.supports, templateText: template.text,
        current: current ? { version: current.version, sha256: current.sha256, text: current.text, publishedAt: current.publishedAt } : null,
        acknowledgedByMe: Boolean(current && acks.some((a) => a.key === `${template.id}:${current.version}:${me}`)),
      });
    }
    return success(request, out);
  });

  app.post("/policies/:policyId/publish", async (request, reply) => {
    requireRole(request, "admin");
    const organization = await workspace(request);
    const { policyId } = policyParams.parse(request.params);
    const { text } = z.object({ text: z.string().trim().min(50).max(20000) }).strict().parse(request.body);
    const versions = await versionsOf(organization.id, policyId);
    const sha256 = sha256Hex(text);
    if (versions.at(-1)?.sha256 === sha256) return reply.code(200).send(success(request, { policyId, version: versions.at(-1)!.version, sha256, unchanged: true }));
    const version: PolicyVersion = { version: (versions.at(-1)?.version ?? 0) + 1, sha256, text, publishedAt: new Date().toISOString(), publishedBy: actor(request).userId };
    await app.store.saveConsoleRecord({ organizationId: organization.id, kind: "policy", key: policyId, data: { versions: [...versions, version] } });
    await audit(app.store, request, "organization", organization.id, "console.policy_published", { policyId, version: version.version });
    const receipt = await recordReceipt(app.store, app.pqSigner, { orgId: organization.id, type: "policy-published", subject: { kind: "policy", id: policyId }, facts: { version: version.version, sha256 } }, request.log);
    return reply.code(201).send(success(request, { policyId, version: version.version, sha256, receiptSeq: receipt?.seq ?? null }));
  });

  app.post("/policies/:policyId/acknowledge", async (request, reply) => {
    const organization = await workspace(request);
    const { policyId } = policyParams.parse(request.params);
    const { version } = z.object({ version: z.number().int().positive() }).strict().parse(request.body);
    const current = (await versionsOf(organization.id, policyId)).at(-1);
    if (!current) throw new AppError(409, "NOT_PUBLISHED", "This policy has not been published yet.");
    if (current.version !== version) throw new AppError(409, "NOT_CURRENT", `Version ${version} is not the current version (${current.version}). Read the current version and acknowledge that.`);
    const userId = actor(request).userId;
    const key = `${policyId}:${version}:${userId}`;
    if (await app.store.getConsoleRecord(organization.id, "policy-ack", key)) return reply.code(200).send(success(request, { policyId, version, alreadyAcknowledged: true }));
    const at = new Date().toISOString();
    await app.store.saveConsoleRecord({ organizationId: organization.id, kind: "policy-ack", key, data: { policyId, version, sha256: current.sha256, userId, at } });
    await audit(app.store, request, "organization", organization.id, "console.policy_acknowledged", { policyId, version });
    const receipt = await recordReceipt(app.store, app.pqSigner, { orgId: organization.id, type: "policy-acknowledged", subject: { kind: "policy", id: policyId }, facts: { version, sha256: current.sha256, userId } }, request.log);
    return reply.code(201).send(success(request, { policyId, version, at, receiptSeq: receipt?.seq ?? null }));
  });

  app.get("/policies/:policyId/acknowledgements", async (request) => {
    requireRole(request, "admin");
    const organization = await workspace(request);
    const { policyId } = policyParams.parse(request.params);
    const current = (await versionsOf(organization.id, policyId)).at(-1);
    const [members, acks] = await Promise.all([app.store.listMembers(organization.id), app.store.listConsoleRecords(organization.id, "policy-ack")]);
    return success(request, {
      policyId,
      version: current?.version ?? null,
      members: members.map((m) => {
        const ack = current ? acks.find((a) => a.key === `${policyId}:${current.version}:${m.userId}`) : undefined;
        return { userId: m.userId, name: m.user.name, role: m.role, acknowledgedAt: (ack?.data as { at?: string } | undefined)?.at ?? null };
      }),
    });
  });

  // ---------- AD-061 incident log for agent mistakes ----------
  // What the agent did wrong, who had approved the action, the fix. Text sealed at rest; each step a signed receipt
  // carrying ids, dates, the impact category and SHA-256 hashes of the text, never the text.
  const IMPACTS = ["money", "data", "customer", "decision-about-a-person", "internal-only", "other"] as const;
  const incidentBody = z
    .object({
      agentId: agentIdSchema,
      occurredAt: z.iso.datetime(),
      impact: z.enum(IMPACTS),
      whatHappened: z.string().trim().min(10).max(2000),
      approvedBy: z.string().trim().max(120).default(""),
      ledgerActionIds: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
      immediateAction: z.string().trim().max(1000).default(""),
    })
    .strict();
  const closeBody = z.object({ fix: z.string().trim().min(10).max(2000), rootCause: z.string().trim().max(2000).default("") }).strict();
  const incidentParams = z.object({ id: z.string().uuid() });

  app.get("/incidents", async (request) => {
    const organization = await workspace(request);
    const rows = await app.store.listConsoleRecords(organization.id, "incident");
    return success(request, rows.map((r) => ({ id: r.key, ...r.data })).reverse());
  });

  app.post("/incidents", async (request, reply) => {
    requireRole(request, "analyst");
    const organization = await workspace(request);
    const input = incidentBody.parse(request.body);
    if (Date.parse(input.occurredAt) > Date.now() + 5 * 60_000) throw new AppError(400, "VALIDATION_ERROR", "When it happened cannot be in the future.");
    const { agents } = await inventory(organization);
    if (!agents.some((a) => a.agentId === input.agentId)) throw notFound("Agent");
    const id = randomUUID();
    const recordedAt = new Date().toISOString();
    const recordedBy = actor(request).userId;
    await app.store.saveConsoleRecord({ organizationId: organization.id, kind: "incident", key: id, data: { ...input, status: "open", recordedAt, recordedBy } });
    await audit(app.store, request, "organization", organization.id, "console.agent_incident_recorded", { incidentId: id, agentId: input.agentId });
    const receipt = await recordReceipt(app.store, app.pqSigner, {
      orgId: organization.id, type: "agent-incident-recorded", subject: { kind: "incident", id },
      facts: { agentId: input.agentId, occurredAt: input.occurredAt, impact: input.impact, ledgerActions: input.ledgerActionIds.length, whatHappenedSha256: sha256Hex(input.whatHappened), recordedBy },
    }, request.log);
    return reply.code(201).send(success(request, { id, status: "open", recordedAt, receiptSeq: receipt?.seq ?? null }));
  });

  app.post("/incidents/:id/close", async (request) => {
    requireRole(request, "admin");
    const organization = await workspace(request);
    const { id } = incidentParams.parse(request.params);
    const input = closeBody.parse(request.body);
    const saved = await app.store.getConsoleRecord(organization.id, "incident", id);
    if (!saved) throw notFound("Incident");
    const current = saved.data as { status?: string; agentId: string; occurredAt: string };
    if (current.status === "closed") throw new AppError(409, "ALREADY_CLOSED", "This incident is already closed.");
    const closedAt = new Date().toISOString();
    const closedBy = actor(request).userId;
    await app.store.saveConsoleRecord({ organizationId: organization.id, kind: "incident", key: id, data: { ...saved.data, status: "closed", fix: input.fix, rootCause: input.rootCause, closedAt, closedBy } });
    await audit(app.store, request, "organization", organization.id, "console.agent_incident_closed", { incidentId: id });
    const daysOpen = Math.max(0, Math.round((Date.parse(closedAt) - Date.parse(current.occurredAt)) / 864e5));
    const receipt = await recordReceipt(app.store, app.pqSigner, {
      orgId: organization.id, type: "agent-incident-closed", subject: { kind: "incident", id },
      facts: { agentId: current.agentId, fixSha256: sha256Hex(input.fix), rootCauseSha256: input.rootCause ? sha256Hex(input.rootCause) : null, daysSinceOccurred: daysOpen, closedBy },
    }, request.log);
    return success(request, { id, status: "closed", closedAt, receiptSeq: receipt?.seq ?? null });
  });

  app.delete("/agents/:agentId", async (request) => {
    requireRole(request, "admin");
    const organization = await workspace(request);
    const { agentId } = agentParams.parse(request.params);
    const deleted = await app.store.deleteConsoleRecord(organization.id, "agent", agentId);
    if (!deleted) throw notFound("Agent record");
    await audit(app.store, request, "organization", organization.id, "console.agent_record_removed", { agentId });
    return success(request, { deleted: true, note: "Only the inventory details were removed. Certificates stay in Agent Certificates until revoked." });
  });
};

declare module "fastify" {
  interface FastifyInstance {
    consoleInventory(organization: Organization): Promise<{ source: CertificateSource; agents: InventoryRow[] }>;
  }
}
