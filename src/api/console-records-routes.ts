import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Organization } from "../domain/types.js";
import type { AtlasCertificate } from "../governance/gateway.js";
import { notFound } from "../shared/errors.js";
import { actor, audit, requireRole, success } from "./helpers.js";

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
