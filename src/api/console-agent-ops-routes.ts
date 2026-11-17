import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import type { Organization } from "../domain/types.js";
import type { AtlasCertificate } from "../governance/gateway.js";
import { AppError, notFound } from "../shared/errors.js";
import { recordReceipt } from "../evidence/receipts.js";
import { actor, audit, requireRole, success } from "./helpers.js";
import { agentIdSchema, sha256Hex } from "./console-records-routes.js";
import { extractItems, proposeProfile } from "../governance/capability-import.js";

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

  // ---------- BM-41 approval inbox ----------
  // High-impact (or unverifiable) actions wait here for a named human. An admin who is NOT the person or integration
  // account that asked approves or declines with a note; the decision becomes a signed "action-approval" receipt with
  // the approver's name, role and the time. Requests expire after 24 hours (expired never counts as approved). The
  // integration polls GET /action-approvals/:requestId. No email or phone delivery: the inbox is in the console.
  type ApprovalRequest = {
    requestId: string; agentId: string; action: string; resource: string; amountUsd: number | null; impact: string; reasons: string[];
    requestedBy: string; requestedAt: string; expiresAt: string; status: "pending" | "approved" | "declined";
    decidedBy?: string; decidedByName?: string; decidedAt?: string; noteSha256?: string; receiptSeq?: number | null;
  };
  const stateOf = (r: ApprovalRequest, now = Date.now()): ApprovalRequest["status"] | "expired" =>
    r.status === "pending" && Date.parse(r.expiresAt) <= now ? "expired" : r.status;
  const view = (r: ApprovalRequest) => ({ ...r, state: stateOf(r) });
  const requestParams = z.object({ requestId: z.string().uuid() });
  const decideBody = z.object({ decision: z.enum(["approve", "decline"]), note: z.string().trim().min(3).max(1000) }).strict();

  app.get("/action-approvals", async (request) => {
    const organization = await workspace(request);
    const rows = (await app.store.listConsoleRecords(organization.id, "approval-request")).map((r) => view(r.data as ApprovalRequest)).reverse();
    return success(request, { pending: rows.filter((r) => r.state === "pending").length, requests: rows });
  });

  app.get("/action-approvals/:requestId", async (request) => {
    const organization = await workspace(request);
    const { requestId } = requestParams.parse(request.params);
    const saved = await app.store.getConsoleRecord(organization.id, "approval-request", requestId);
    if (!saved) throw notFound("Approval request");
    return success(request, view(saved.data as ApprovalRequest));
  });

  app.post("/action-approvals/:requestId/decide", async (request, reply) => {
    requireRole(request, "admin");
    const organization = await workspace(request);
    const { requestId } = requestParams.parse(request.params);
    const input = decideBody.parse(request.body);
    const saved = await app.store.getConsoleRecord(organization.id, "approval-request", requestId);
    if (!saved) throw notFound("Approval request");
    const current = saved.data as ApprovalRequest;
    const state = stateOf(current);
    if (state === "expired") throw new AppError(409, "REQUEST_EXPIRED", "This request expired (24 hours) and cannot be approved. Ask again from the gate.");
    if (state !== "pending") throw new AppError(409, "ALREADY_DECIDED", `This request was already ${state}.`);
    const approver = actor(request);
    if (approver.userId === current.requestedBy) throw new AppError(403, "SELF_APPROVAL", "The person or integration that asked cannot approve its own request. Another admin must decide.");
    const user = await app.store.getUser(approver.userId);
    const decidedAt = new Date().toISOString();
    const status = input.decision === "approve" ? "approved" : "declined";
    const noteSha256 = sha256Hex(input.note);
    const receipt = await recordReceipt(app.store, app.pqSigner, {
      orgId: organization.id, type: "action-approval", subject: { kind: "approval-request", id: requestId },
      facts: { decision: status, approverUserId: approver.userId, approverName: user?.name ?? null, approverRole: approver.role, decidedAt, agentId: current.agentId, action: current.action, amountUsd: current.amountUsd, impact: current.impact, requestedAt: current.requestedAt, noteSha256 },
    }, request.log);
    if (!receipt) throw new AppError(503, "RECEIPT_FAILED", "The signed record could not be written, so the decision was not saved. Try again.");
    const updated: ApprovalRequest = { ...current, status, decidedBy: approver.userId, decidedByName: user?.name ?? undefined, decidedAt, noteSha256, receiptSeq: receipt.seq };
    await app.store.saveConsoleRecord({ organizationId: organization.id, kind: "approval-request", key: requestId, data: { ...updated, note: input.note } });
    await audit(app.store, request, "organization", organization.id, "console.action_approval_decided", { requestId, decision: status });
    return reply.code(200).send(success(request, view(updated)));
  });

  // ---------- BM-38 / N-AT-07 capability import ----------
  // Reads an MCP tool list, an OpenAPI JSON document or an AWS IAM policy (pasted text, never fetched), proposes the
  // agent profile's capabilities from it with the engine's fixed rules, and seals what was read as a signed
  // "capability-snapshot" receipt (input fingerprint, counts, matched capabilities). The raw input is not kept.
  // Nothing is applied automatically: a person copies the proposal into the profile form.
  const importBody = z.object({ format: z.enum(["mcp", "openapi", "iam"]), content: z.string().min(2).max(1_000_000) }).strict();

  app.post("/agents/:agentId/capability-import", async (request, reply) => {
    requireRole(request, "analyst");
    const organization = await workspace(request);
    const { agentId } = z.object({ agentId: agentIdSchema }).parse(request.params);
    const { format, content } = importBody.parse(request.body);
    let extracted: { items: string[]; notes: string[] };
    try {
      extracted = extractItems(format, content);
    } catch (error) {
      throw new AppError(400, "IMPORT_UNREADABLE", (error as Error).message);
    }
    if (!extracted.items.length) throw new AppError(400, "IMPORT_EMPTY", "Nothing to read: the input lists no tools, operations or allowed actions.");
    const proposal = proposeProfile(extracted.items);
    const at = new Date().toISOString();
    const inputSha256 = sha256Hex(content);
    const capabilityKeys = Object.keys(proposal.capabilities).sort();
    const snapshot = { agentId, format, inputSha256, at, items: extracted.items.length, matched: proposal.matches.length, unmatched: proposal.unmatched.length, capabilities: capabilityKeys, otherCapabilities: proposal.otherCapabilities.length };
    await app.store.saveConsoleRecord({ organizationId: organization.id, kind: "capability-snapshot", key: `${agentId}:${at}`, data: snapshot });
    await audit(app.store, request, "organization", organization.id, "console.capability_import", { agentId, format, items: extracted.items.length });
    const receipt = await recordReceipt(app.store, app.pqSigner, {
      orgId: organization.id, type: "capability-snapshot", subject: { kind: "agent", id: agentId },
      facts: { format, inputSha256, items: snapshot.items, matched: snapshot.matched, unmatched: snapshot.unmatched, capabilities: capabilityKeys, otherCapabilities: snapshot.otherCapabilities, at },
    }, request.log);
    return reply.code(201).send(success(request, {
      agentId, format, inputSha256,
      proposal: { capabilities: proposal.capabilities, otherCapabilities: proposal.otherCapabilities },
      matches: proposal.matches.slice(0, 500),
      needsHumanReview: proposal.unmatched.slice(0, 500),
      notes: [...extracted.notes, "Proposal only: nothing was changed in the agent profile. Copy what applies into the profile form.", "Matching uses fixed keyword rules; an item that matches nothing is listed for review, never treated as harmless."],
      receiptSeq: receipt?.seq ?? null,
    }));
  });

  // ---------- N-AT-09 retire an agent, with proof (non-human identity link with Offboarding) ----------
  // Retiring proves two things in one signed "agent-retired" receipt: Agent Certificates confirms the agent has NO
  // active certificate (if it still has one, use the kill switch first; if certificates cannot be read, nothing is
  // retired), and, optionally, an Offboarding Proof signed report that covers the agent's non-human accounts.
  // This service holds no Offboarding Proof keys, so it checks ONLY that the report's files match the fingerprint in
  // the report's own manifest, and says so (signatureCheckedHere: false). SAMPLE reports are refused. Files are
  // fingerprinted and discarded.
  const retireBody = z
    .object({
      reason: z.string().trim().min(5).max(500),
      offboarding: z.object({ manifest: z.string().min(2).max(200_000), pdfBase64: z.string().min(4), csvBase64: z.string().optional() }).strict().optional(),
    })
    .strict();
  const OFFBOARDING = "Offboarding Proof";

  app.post("/agents/:agentId/retire", async (request, reply) => {
    requireRole(request, "admin");
    const organization = await workspace(request);
    const { agentId } = z.object({ agentId: agentIdSchema }).parse(request.params);
    const input = retireBody.parse(request.body);
    if (await app.store.getConsoleRecord(organization.id, "retired", agentId)) throw new AppError(409, "ALREADY_RETIRED", "This agent is already retired.");
    const { source, certificates } = await certificatesFor(organization);
    if (source !== "authority-atlas") throw new AppError(503, "CERTIFICATES_UNAVAILABLE", "Agent Certificates could not be read, so retirement cannot be proven. Nothing was recorded. Try again in a minute.");
    const mine = certificates.filter((c) => c.agentId === agentId);
    if (mine.some((c) => c.status === "active")) throw new AppError(409, "STILL_ACTIVE", "This agent still has an active certificate. Use the kill switch first (it revokes the certificate and records the proof), then retire it.");
    let offboarding: Record<string, unknown> | null = null;
    if (input.offboarding) {
      let manifest: Record<string, unknown>;
      try { manifest = JSON.parse(input.offboarding.manifest) as Record<string, unknown>; } catch { throw new AppError(400, "MANIFEST_INVALID", "The manifest is not valid JSON."); }
      if (![manifest.system, manifest.product, manifest.issuer].some((v) => typeof v === "string" && v.includes(OFFBOARDING))) throw new AppError(400, "NOT_OFFBOARDING", "Only signed reports from Offboarding Proof can be attached here.");
      if (manifest.sample === true || /^SAMPLE$/i.test(String(manifest.recordId ?? ""))) throw new AppError(400, "SAMPLE_REPORT", "That is a SAMPLE report with made-up data. It cannot be used as proof.");
      const pdf = Buffer.from(input.offboarding.pdfBase64, "base64");
      const csv = input.offboarding.csvBase64 ? Buffer.from(input.offboarding.csvBase64, "base64") : null;
      const wantsCsv = Boolean((manifest.files as { csv?: unknown } | undefined)?.csv);
      if (wantsCsv && !csv) throw new AppError(400, "CSV_MISSING", "This report has a CSV too: attach it as well, exactly as you received it.");
      const content = wantsCsv && csv ? Buffer.concat([pdf, csv]) : pdf;
      const contentSha = createHash("sha256").update(content).digest("hex");
      offboarding = {
        product: OFFBOARDING,
        recordType: String(manifest.recordType ?? "").slice(0, 80) || null,
        recordGeneratedAt: String(manifest.generatedAt ?? "").slice(0, 40) || null,
        manifestSha256: sha256Hex(input.offboarding.manifest),
        pdfSha256: createHash("sha256").update(pdf).digest("hex"),
        csvSha256: csv ? createHash("sha256").update(csv).digest("hex") : null,
        filesMatch: typeof manifest.contentHash === "string" && contentSha === manifest.contentHash.toLowerCase(),
        signatureCheckedHere: false,
      };
    }
    const kills = (await app.store.listConsoleRecords(organization.id, "kill")).filter((k) => (k.data as { agentId?: string }).agentId === agentId);
    const at = new Date().toISOString();
    const by = actor(request).userId;
    const certificatesSummary = {
      active: 0,
      revoked: mine.filter((c) => c.status === "revoked").map((c) => c.jti),
      expired: mine.filter((c) => c.status === "expired").map((c) => c.jti),
    };
    const receipt = await recordReceipt(app.store, app.pqSigner, {
      orgId: organization.id, type: "agent-retired", subject: { kind: "agent", id: agentId },
      facts: { certificates: certificatesSummary, certificateSource: source, killSwitchUses: kills.length, offboarding, reasonSha256: sha256Hex(input.reason), by, at },
    }, request.log);
    if (!receipt) throw new AppError(503, "RECEIPT_FAILED", "The signed record could not be written, so nothing was recorded. Try again.");
    const record = { agentId, reason: input.reason, at, by, certificates: certificatesSummary, killSwitchUses: kills.length, offboarding, receiptSeq: receipt.seq };
    await app.store.saveConsoleRecord({ organizationId: organization.id, kind: "retired", key: agentId, data: record });
    await audit(app.store, request, "organization", organization.id, "console.agent_retired", { agentId, offboardingAttached: Boolean(offboarding), filesMatch: offboarding ? Boolean(offboarding.filesMatch) : null });
    return reply.code(201).send(success(request, {
      ...record,
      notes: [
        "Agent Certificates confirmed no active certificate for this agent when it was retired.",
        offboarding ? (offboarding.filesMatch ? "The Offboarding Proof report's files match its own manifest. Its signature is checked on Offboarding Proof's /verify page, not here." : "The Offboarding Proof report's files do NOT match its manifest, so it does not count as proof. It is recorded as attached-but-not-matching.") : "No Offboarding Proof report was attached: the agent's non-human accounts outside Agent Certificates are not proven removed by this record.",
      ],
    }));
  });

  app.get("/agents/:agentId/retirement", async (request) => {
    const organization = await workspace(request);
    const { agentId } = z.object({ agentId: agentIdSchema }).parse(request.params);
    const saved = await app.store.getConsoleRecord(organization.id, "retired", agentId);
    if (!saved) throw notFound("Retirement");
    return success(request, saved.data);
  });

  app.get("/agents/:agentId/capability-snapshots", async (request) => {
    const organization = await workspace(request);
    const { agentId } = z.object({ agentId: agentIdSchema }).parse(request.params);
    const rows = await app.store.listConsoleRecords(organization.id, "capability-snapshot");
    return success(request, rows.filter((r) => (r.data as { agentId?: string }).agentId === agentId).map((r) => r.data).reverse());
  });
};
