import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Organization } from "../domain/types.js";
import { notFound } from "../shared/errors.js";
import { actor, audit, requireRole, success } from "./helpers.js";

// Agent Governance console API. One workspace login reaches the whole Floor 3 chain: certificates
// are issued and revoked in Authority Atlas, actions are read from the Trust Proof ledger, and the
// existing Contract Gap analyses stay where they are. Every call runs through app.governance.

// Mirrors Authority Atlas's own validation so mistakes are caught here with a clear message.
const agentId = z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/, "Agent id: 1-100 letters, digits or . _ : -");
const permission = z
  .string()
  .regex(/^[A-Za-z0-9_.:*/-]{1,100}$/, 'Permissions look like "invoices:read" or "email:send".');
const issueBody = z.object({
  agentId,
  agentName: z.string().trim().min(1).max(100),
  permissions: z.array(permission).min(1).max(50),
  limits: z
    .object({
      maxAmountUsd: z.number().positive().max(1e12).optional(),
      maxActionsPerDay: z.number().int().positive().max(1e12).optional(),
    })
    .strict()
    .default({}),
  expiresInDays: z.number().int().min(1).max(365).default(30),
});
const jtiParams = z.object({ jti: z.string().uuid() });
const ledgerQuery = z.object({
  agentId: agentId.optional(),
  verdict: z.enum(["within_authority", "outside_authority"]).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

export const consoleRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  async function workspace(request: FastifyRequest): Promise<Organization> {
    const organization = await app.store.getOrganization(actor(request).organizationId);
    if (!organization) throw notFound("Workspace");
    return organization;
  }

  app.get("/status", async (request) => {
    const organization = await workspace(request);
    const linked = Boolean(await app.store.getServiceLink(organization.id));
    return success(request, { configured: app.governance.status(), linked, workspace: { id: organization.id, name: organization.name } });
  });

  // Links the workspace to Atlas and Trust Proof (first use only; later calls are no-ops).
  app.post("/link", async (request) => {
    requireRole(request, "analyst");
    const organization = await workspace(request);
    const already = Boolean(await app.store.getServiceLink(organization.id));
    await app.governance.ensureLink(organization);
    if (!already) await audit(app.store, request, "organization", organization.id, "console.linked");
    return success(request, { linked: true });
  });

  app.get("/overview", async (request) => {
    const organization = await workspace(request);
    const [certificates, ledger] = await Promise.all([
      app.governance.listCertificates(organization),
      app.governance.ledger(organization, { limit: 1000 }),
    ]);
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const recent = ledger.actions.filter((item) => Date.parse(item.occurredAt) >= dayAgo);
    return success(request, {
      certificates: {
        active: certificates.filter((item) => item.status === "active").length,
        revoked: certificates.filter((item) => item.status === "revoked").length,
        expired: certificates.filter((item) => item.status === "expired").length,
      },
      ledger: {
        total: ledger.count,
        blocked: ledger.actions.filter((item) => item.verdict === "outside_authority").length,
        last24h: recent.length,
        blocked24h: recent.filter((item) => item.verdict === "outside_authority").length,
        sampled: ledger.actions.length < ledger.count,
      },
      latest: ledger.actions.slice(0, 8),
    });
  });

  app.get("/certificates", async (request) => {
    const organization = await workspace(request);
    return success(request, await app.governance.listCertificates(organization));
  });

  app.post("/certificates", async (request, reply) => {
    requireRole(request, "analyst");
    const organization = await workspace(request);
    const input = issueBody.parse(request.body);
    const issued = await app.governance.issueCertificate(organization, input);
    await audit(app.store, request, "certificate", issued.jti, "console.certificate_issued", { agentId: issued.agentId });
    return reply.code(201).send(success(request, issued));
  });

  app.post("/certificates/:jti/revoke", async (request) => {
    requireRole(request, "admin");
    const organization = await workspace(request);
    const { jti } = jtiParams.parse(request.params);
    const revoked = await app.governance.revokeCertificate(organization, jti);
    await audit(app.store, request, "certificate", jti, "console.certificate_revoked");
    return success(request, revoked);
  });

  app.get("/certificates/:jti/verify", async (request) => {
    const organization = await workspace(request);
    const { jti } = jtiParams.parse(request.params);
    return success(request, await app.governance.verifyCertificate(organization, jti));
  });

  app.get("/ledger", async (request) => {
    const organization = await workspace(request);
    return success(request, await app.governance.ledger(organization, ledgerQuery.parse(request.query)));
  });

  app.get("/ledger/verify", async (request) => {
    const organization = await workspace(request);
    return success(request, await app.governance.verifyLedger(organization));
  });

  // The Trust Proof key an agent runtime uses to report actions. Admins only; never logged.
  app.get("/connection", async (request, reply) => {
    requireRole(request, "admin");
    const organization = await workspace(request);
    const connection = await app.governance.agentConnection(organization);
    await audit(app.store, request, "organization", organization.id, "console.connection_viewed");
    reply.header("Cache-Control", "no-store");
    return success(request, connection);
  });
};
