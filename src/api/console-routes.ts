import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Organization } from "../domain/types.js";
import { AppError, notFound } from "../shared/errors.js";
import { PLANS } from "../governance/billing.js";
import { isTrunkActive, TRUNK_CONTACT_URL, TRUNK_FEATURES, TRUNK_STATUS_LABELS } from "../governance/trunk.js";
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
    return success(request, {
      configured: app.governance.status(),
      linked,
      workspace: { id: organization.id, name: organization.name },
      // Public service address shown in Settings (the key itself is only in /connection).
      trustProofUrl: app.governance.trustProofUrl(),
    });
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

  // RootSystems Trunk (governance/trunk.ts): what it adds, and whether this workspace has it.
  app.get("/trunk", async (request) => {
    const organization = await workspace(request);
    return success(request, {
      active: isTrunkActive(organization.id),
      features: TRUNK_FEATURES.map((feature) => ({ ...feature, statusLabel: TRUNK_STATUS_LABELS[feature.status] })),
      contactUrl: TRUNK_CONTACT_URL,
    });
  });

  // "Talk to us about Trunk": recorded in the audit log as a demand signal, then the browser opens
  // the contact form at the returned url.
  app.post("/trunk/interest", async (request) => {
    const organization = await workspace(request);
    await audit(app.store, request, "organization", organization.id, "console.trunk_interest");
    return success(request, { url: TRUNK_CONTACT_URL });
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
    // Plan limit: active certificates at once (revoked and expired ones do not count).
    const { plan } = await app.billing.current(organization.id);
    const active = (await app.governance.listCertificates(organization)).filter((item) => item.status === "active").length;
    if (active >= plan.activeCertificates) {
      throw new AppError(
        402,
        "PLAN_LIMIT_REACHED",
        `The ${plan.name} plan allows ${plan.activeCertificates} active agent certificates. Revoke one or upgrade in Settings.`,
      );
    }
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

  // ----- alerts: Trust Proof webhooks fired when an agent acts outside its authority -----

  const webhookParams = z.object({ id: z.coerce.number().int().positive() });

  app.get("/alerts", async (request) => {
    const organization = await workspace(request);
    return success(request, await app.governance.listWebhooks(organization));
  });

  app.post("/alerts", async (request, reply) => {
    requireRole(request, "admin");
    const organization = await workspace(request);
    const { url } = z.object({ url: z.string().trim().min(8).max(2000) }).parse(request.body);
    const created = await app.governance.createWebhook(organization, url);
    await audit(app.store, request, "organization", organization.id, "console.alert_added");
    reply.header("Cache-Control", "no-store");
    return reply.code(201).send(success(request, created));
  });

  app.delete("/alerts/:id", async (request) => {
    requireRole(request, "admin");
    const organization = await workspace(request);
    const { id } = webhookParams.parse(request.params);
    await app.governance.deleteWebhook(organization, id);
    await audit(app.store, request, "organization", organization.id, "console.alert_deleted", { webhookId: id });
    return success(request, { deleted: true });
  });

  app.post("/alerts/:id/test", async (request) => {
    requireRole(request, "analyst");
    const organization = await workspace(request);
    const { id } = webhookParams.parse(request.params);
    return success(request, await app.governance.testWebhook(organization, id));
  });

  // ----- approvals: named people sign off decisions with their own Trust Proof keys -----

  async function teamWithSigners(organizationId: string) {
    const [members, signers] = await Promise.all([app.store.listMembers(organizationId), app.store.listConsoleSigners(organizationId)]);
    const enrolled = new Map(signers.map((item) => [item.userId, item]));
    return members.map((member) => ({
      userId: member.userId,
      name: member.user.name,
      email: member.user.email,
      role: member.role,
      canSign: enrolled.has(member.userId),
    }));
  }

  app.get("/team", async (request) => {
    const organization = await workspace(request);
    return success(request, await teamWithSigners(organization.id));
  });

  // Adds a teammate to this workspace. There is no email sending yet, so the one-time password is
  // returned once to the admin to pass on privately; it is stored only as a bcrypt hash.
  app.post("/team", async (request, reply) => {
    requireRole(request, "admin");
    const organization = await workspace(request);
    const input = z
      .object({ name: z.string().trim().min(2).max(100), email: z.email().max(254), role: z.enum(["admin", "analyst", "viewer"]) })
      .parse(request.body);
    const temporaryPassword = randomBytes(12).toString("base64url");
    try {
      await app.store.addMember(organization.id, { email: input.email, name: input.name, role: input.role, passwordHash: await bcrypt.hash(temporaryPassword, 12) });
    } catch (error) {
      if (error instanceof Error && error.message === "EMAIL_EXISTS") throw new AppError(409, "EMAIL_EXISTS", "That email already has a RootSystems account.");
      throw error;
    }
    await audit(app.store, request, "organization", organization.id, "console.member_added", { role: input.role });
    reply.header("Cache-Control", "no-store");
    return reply.code(201).send(success(request, { email: input.email.toLowerCase(), temporaryPassword }));
  });

  app.get("/approvals", async (request) => {
    const organization = await workspace(request);
    const [decisions, team] = await Promise.all([app.governance.listDecisions(organization), teamWithSigners(organization.id)]);
    const me = team.find((member) => member.userId === actor(request).userId);
    return success(request, { decisions, team, me: me ?? null });
  });

  app.get("/approvals/:id", async (request) => {
    const organization = await workspace(request);
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    return success(request, await app.governance.getDecision(organization, String(id)));
  });

  // Sets up the current member's personal signing key. The passphrase is never stored here.
  app.post("/signing-key", async (request) => {
    const organization = await workspace(request);
    const { passphrase } = z.object({ passphrase: z.string().min(10).max(200) }).parse(request.body);
    const user = await app.store.getUser(actor(request).userId);
    if (!user) throw notFound("User");
    const already = (await app.store.listConsoleSigners(organization.id)).some((item) => item.userId === user.id);
    if (already) throw new AppError(409, "ALREADY_ENROLLED", "You already have a signing key in this workspace.");
    const email = await app.governance.enrollSigner(organization, { id: user.id, name: user.name, email: user.email }, passphrase);
    await app.store.addConsoleSigner({ organizationId: organization.id, userId: user.id, trustProofEmail: email });
    await audit(app.store, request, "user", user.id, "console.signing_key_created");
    return success(request, { canSign: true });
  });

  app.post("/approvals", async (request, reply) => {
    requireRole(request, "analyst");
    const organization = await workspace(request);
    const input = z
      .object({
        title: z.string().trim().min(3).max(200),
        details: z.string().trim().min(3).max(20000),
        signerUserIds: z.array(z.string().uuid()).min(1).max(20),
        reference: z.string().trim().max(200).optional(),
      })
      .parse(request.body);
    const me = actor(request).userId;
    if (input.signerUserIds.includes(me)) {
      throw new AppError(400, "SELF_APPROVAL", "You cannot be a required signer on your own request.");
    }
    const signers = await app.store.listConsoleSigners(organization.id);
    const emails = input.signerUserIds.map((id) => signers.find((item) => item.userId === id)?.trustProofEmail);
    if (emails.some((email) => !email)) {
      throw new AppError(400, "SIGNER_NOT_READY", "Every signer must first set up their signing key (Approvals → Set up signing).");
    }
    const proposer = await app.store.getUser(me);
    const decision = await app.governance.createDecision(organization, {
      decisionType: input.title,
      content: input.details,
      requiredSigners: emails as string[],
      proposedBy: proposer?.email ?? me,
      ...(input.reference ? { externalRef: input.reference } : {}),
    });
    await audit(app.store, request, "organization", organization.id, "console.approval_requested", { signers: emails.length });
    return reply.code(201).send(success(request, decision));
  });

  async function signOrDecline(request: FastifyRequest, decline: boolean) {
    const organization = await workspace(request);
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const body = z.object({ passphrase: z.string().min(1).max(200), reason: z.string().trim().max(2000).optional() }).parse(request.body);
    const signer = (await app.store.listConsoleSigners(organization.id)).find((item) => item.userId === actor(request).userId);
    if (!signer) throw new AppError(400, "SIGNER_NOT_READY", "Set up your signing key first.");
    const result = await app.governance.signDecision(organization, signer.trustProofEmail, String(id), body.passphrase, decline ? { reason: body.reason } : undefined);
    await audit(app.store, request, "organization", organization.id, decline ? "console.approval_declined" : "console.approval_signed", { decisionId: id });
    return success(request, result);
  }
  app.post("/approvals/:id/sign", async (request) => signOrDecline(request, false));
  app.post("/approvals/:id/decline", async (request) => signOrDecline(request, true));

  // Coverage summary for the console: every project with its analyses (newest first) and each
  // analysis's attention level. Editing and running analyses stay in the coverage workspace.
  app.get("/coverage", async (request) => {
    const orgId = actor(request).organizationId;
    const projects = await app.store.listProjects(orgId, { page: 1, pageSize: 50 });
    const agentNames = new Map<string, string>();
    const items = [];
    for (const project of projects.items) {
      const analyses = await app.store.listAnalyses(orgId, project.id, { page: 1, pageSize: 20 });
      const rows = [];
      for (const analysis of analyses.items) {
        if (!agentNames.has(analysis.agentProfileId)) {
          agentNames.set(analysis.agentProfileId, (await app.store.getAgent(orgId, analysis.agentProfileId))?.name ?? "Agent");
        }
        rows.push({
          id: analysis.id,
          state: analysis.state,
          agentName: agentNames.get(analysis.agentProfileId),
          attention: analysis.attentionScore ? { score: analysis.attentionScore.score, label: analysis.attentionScore.label } : null,
          createdAt: analysis.createdAt,
          completedAt: analysis.completedAt,
        });
      }
      items.push({ id: project.id, name: project.name, analyses: rows });
    }
    return success(request, { projects: items, truncated: projects.total > projects.items.length });
  });

  app.get("/billing", async (request) => {
    const organization = await workspace(request);
    const { plan, subscription } = await app.billing.current(organization.id);
    return success(request, {
      plan,
      status: subscription?.status ?? "free",
      renewsAt: subscription?.renewsAt ?? null,
      plans: Object.values(PLANS),
      checkoutAvailable: app.billing.configured(),
    });
  });

  app.post("/billing/checkout", async (request) => {
    requireRole(request, "admin");
    const organization = await workspace(request);
    const { plan } = z.object({ plan: z.enum(["team", "business"]) }).parse(request.body);
    const user = await app.store.getUser(actor(request).userId);
    if (!user) throw notFound("User");
    const url = await app.billing.checkout(organization, user.email, plan);
    await audit(app.store, request, "organization", organization.id, "console.checkout_started", { plan });
    return success(request, { url });
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
