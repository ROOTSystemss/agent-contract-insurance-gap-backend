import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Organization } from "../domain/types.js";
import type { AtlasCertificate } from "../governance/gateway.js";
import { createHash } from "node:crypto";
import { notFound } from "../shared/errors.js";
import { recordReceipt } from "../evidence/receipts.js";
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
