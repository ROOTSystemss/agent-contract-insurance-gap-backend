import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Organization } from "../domain/types.js";
import type { AtlasCertificate } from "../governance/gateway.js";
import { notFound } from "../shared/errors.js";
import { recordReceipt } from "../evidence/receipts.js";
import { actor, audit, requireRole, success } from "./helpers.js";
import { agentIdSchema, sha256Hex } from "./console-records-routes.js";

// Agent operations on the Agent Governance console (knock-out Phase 5 medium items, 2026-11-17).
//
// AD-057 approval gates by impact level. A workspace admin sets a gate policy: rules that give an action (exact, or a
// "prefix:*" pattern, optionally for one agent) an impact level, plus an amount above which it counts as high. Before
// acting, an integration asks POST /gates/check. The answer is one of:
//   - "blocked"         the agent has no active certificate, the action is outside its certificate's permissions, or the
//                       amount is above its certificate's limit;
//   - "needs-approval"  high impact, OR the certificate could not be read / has no permission list (unknown is never a
//                       pass): a pending approval request is opened for a named human (BM-41 inbox);
//   - "allowed"         low or medium impact, active certificate, within permissions and limits.
// Every check is recorded; blocked and needs-approval decisions also get a signed "gate-decision" receipt.
// Decision support only: the console cannot stop a runtime that does not ask; the gate is advisory for such runtimes.

const impactSchema = z.enum(["low", "medium", "high"]);
const actionSchema = z.string().trim().regex(/^[A-Za-z0-9_.:-]{1,100}$/, "Action: 1-100 letters, digits or . _ : -");
const rulePattern = z.string().trim().regex(/^(\*|[A-Za-z0-9_.:-]{1,100}(:\*)?)$/, "Rule action: an exact action, 'prefix:*' or '*'");
const ruleSchema = z
  .object({ action: rulePattern, agentId: agentIdSchema.optional(), impact: impactSchema, highAboveUsd: z.number().nonnegative().max(1e12).optional() })
  .strict();
export const gatePolicySchema = z
  .object({ defaultImpact: impactSchema.default("medium"), rules: z.array(ruleSchema).max(100).default([]) })
  .strict();
export type GatePolicy = z.infer<typeof gatePolicySchema>;
const checkBody = z
  .object({ agentId: agentIdSchema, action: actionSchema, resource: z.string().trim().max(200).default(""), amountUsd: z.number().nonnegative().max(1e12).optional() })
  .strict();

const DEFAULT_POLICY: GatePolicy = { defaultImpact: "medium", rules: [] };
export const APPROVAL_TTL_MS = 24 * 3600 * 1000;

export const patternMatches = (pattern: string, action: string): boolean =>
  pattern === "*" || pattern === action || (pattern.endsWith(":*") && action.startsWith(pattern.slice(0, -1)));

export function impactFor(policy: GatePolicy, input: { agentId: string; action: string; amountUsd?: number }): { impact: "low" | "medium" | "high"; rule: number | null } {
  const index = policy.rules.findIndex((r) => patternMatches(r.action, input.action) && (!r.agentId || r.agentId === input.agentId));
  const rule = index >= 0 ? policy.rules[index] : null;
  let impact = rule ? rule.impact : policy.defaultImpact;
  if (rule?.highAboveUsd !== undefined && input.amountUsd !== undefined && input.amountUsd > rule.highAboveUsd) impact = "high";
  return { impact, rule: index >= 0 ? index : null };
}

export const consoleAgentOpsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", async (request) => {
    await app.accountSecurity.requireVerified(actor(request).userId);
  });

  async function workspace(request: FastifyRequest): Promise<Organization> {
    const organization = await app.store.getOrganization(actor(request).organizationId);
    if (!organization) throw notFound("Workspace");
    return organization;
  }

  // Certificates, or why they could not be read: "not-activated" and "not-verified" are never treated as "none".
  async function certificatesFor(organization: Organization): Promise<{ source: "authority-atlas" | "not-activated" | "not-verified"; certificates: AtlasCertificate[] }> {
    if (!app.governance.status().atlas || !(await app.store.getServiceLink(organization.id))) return { source: "not-activated", certificates: [] };
    try {
      return { source: "authority-atlas", certificates: await app.governance.listCertificates(organization) };
    } catch (error) {
      app.log.warn({ err: (error as Error).message }, "gates: Agent Certificates could not be read");
      return { source: "not-verified", certificates: [] };
    }
  }

  async function policyOf(organizationId: string): Promise<GatePolicy> {
    const saved = await app.store.getConsoleRecord(organizationId, "settings", "gates");
    return saved ? gatePolicySchema.parse(saved.data) : DEFAULT_POLICY;
  }

  // ---------- AD-057 approval gates by impact level ----------
  app.get("/gates", async (request) => {
    const organization = await workspace(request);
    return success(request, { policy: await policyOf(organization.id), note: "Rules are checked in order; the first rule whose action matches (and agent, if set) gives the impact. 'prefix:*' matches every action that starts with 'prefix:'." });
  });

  app.put("/gates", async (request) => {
    requireRole(request, "admin");
    const organization = await workspace(request);
    const policy = gatePolicySchema.parse(request.body);
    await app.store.saveConsoleRecord({ organizationId: organization.id, kind: "settings", key: "gates", data: policy as unknown as Record<string, unknown> });
    const policySha256 = sha256Hex(JSON.stringify(policy));
    await audit(app.store, request, "organization", organization.id, "console.gate_policy_set", { rules: policy.rules.length, defaultImpact: policy.defaultImpact });
    const receipt = await recordReceipt(app.store, app.pqSigner, {
      orgId: organization.id, type: "gate-policy-set", subject: { kind: "gate-policy", id: policySha256 },
      facts: { policySha256, rules: policy.rules.length, defaultImpact: policy.defaultImpact, by: actor(request).userId },
    }, request.log);
    return success(request, { policy, policySha256, receiptSeq: receipt?.seq ?? null });
  });

  app.post("/gates/check", async (request, reply) => {
    requireRole(request, "analyst");
    const organization = await workspace(request);
    const input = checkBody.parse(request.body);
    const policy = await policyOf(organization.id);
    const { impact, rule } = impactFor(policy, input);
    const { source, certificates } = await certificatesFor(organization);
    const reasons: string[] = [];
    let decision: "allowed" | "blocked" | "needs-approval";
    const active = certificates.filter((c) => c.agentId === input.agentId && c.status === "active");
    if (source !== "authority-atlas") {
      decision = "needs-approval";
      reasons.push(source === "not-activated" ? "Certificates are not read yet (console not activated): not verified, so a person must approve." : "Agent Certificates could not be read: not verified, so a person must approve.");
    } else if (!active.length) {
      decision = "blocked";
      reasons.push("The agent has no active certificate.");
    } else {
      const permissionLists = active.map((c) => c.permissions);
      const unknownPermissions = permissionLists.every((p) => p === null);
      const permitted = permissionLists.some((p) => Array.isArray(p) && p.some((granted) => patternMatches(granted, input.action)));
      const limits = active.map((c) => c.limits?.maxAmountUsd).filter((v): v is number => typeof v === "number");
      const overLimit = input.amountUsd !== undefined && limits.length > 0 && input.amountUsd > Math.max(...limits);
      if (!unknownPermissions && !permitted) {
        decision = "blocked";
        reasons.push(`"${input.action}" is outside the agent's certificate permissions.`);
      } else if (overLimit) {
        decision = "blocked";
        reasons.push(`The amount is above the certificate's limit of ${Math.max(...limits)} USD.`);
      } else if (unknownPermissions) {
        decision = "needs-approval";
        reasons.push("The certificate lists no permissions, so whether this action is allowed is not verified: a person must approve.");
      } else if (impact === "high") {
        decision = "needs-approval";
        reasons.push(rule !== null ? `Rule ${rule + 1} makes this a high-impact action.` : "The default impact is high.");
      } else {
        decision = "allowed";
        reasons.push(`Within the certificate's permissions and limits; ${impact} impact.`);
      }
    }
    const id = randomUUID();
    const at = new Date().toISOString();
    const requestedBy = actor(request).userId;
    let requestId: string | null = null;
    if (decision === "needs-approval") {
      requestId = randomUUID();
      await app.store.saveConsoleRecord({
        organizationId: organization.id, kind: "approval-request", key: requestId,
        data: { requestId, agentId: input.agentId, action: input.action, resource: input.resource, amountUsd: input.amountUsd ?? null, impact, reasons, requestedBy, requestedAt: at, expiresAt: new Date(Date.parse(at) + APPROVAL_TTL_MS).toISOString(), status: "pending" },
      });
    }
    await app.store.saveConsoleRecord({
      organizationId: organization.id, kind: "gate", key: `${at}:${id}`,
      data: { id, at, agentId: input.agentId, action: input.action, resourceSha256: input.resource ? sha256Hex(input.resource) : null, amountUsd: input.amountUsd ?? null, impact, decision, reasons, certificateSource: source, requestId, by: requestedBy },
    });
    let receiptSeq: number | null = null;
    if (decision !== "allowed") {
      const receipt = await recordReceipt(app.store, app.pqSigner, {
        orgId: organization.id, type: "gate-decision", subject: { kind: "agent", id: input.agentId },
        facts: { decision, impact, action: input.action, amountUsd: input.amountUsd ?? null, certificateSource: source, requestId, reasonsSha256: sha256Hex(reasons.join("\n")), at },
      }, request.log);
      receiptSeq = receipt?.seq ?? null;
    }
    reply.header("Cache-Control", "no-store");
    return reply.code(decision === "blocked" ? 403 : decision === "needs-approval" ? 202 : 200).send(success(request, { decision, impact, reasons, requestId, certificateSource: source, receiptSeq }));
  });

  app.get("/gates/decisions", async (request) => {
    const organization = await workspace(request);
    const rows = await app.store.listConsoleRecords(organization.id, "gate");
    return success(request, rows.slice(-200).map((r) => r.data).reverse());
  });
};
