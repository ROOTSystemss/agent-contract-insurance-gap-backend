import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Organization } from "../domain/types.js";
import { AppError, notFound } from "../shared/errors.js";
import { recordReceipt } from "../evidence/receipts.js";
import { actor, audit, requireRole, success } from "./helpers.js";
import { approvalView, evaluateGate, gateCheckBody, type ApprovalRequest } from "./console-agent-ops-routes.js";

// BM-40 runtime gate (knock-out Phase 5, 2026-11-17).
//
// An agent runtime cannot use a person's sign-in (access tokens last an hour), so a workspace admin creates a RUNTIME
// KEY for it. The key is shown once, stored only as a SHA-256 hash, and can be revoked at any time. It works on exactly
// two routes and nothing else:
//   POST /api/v1/runtime/gate/check          the same gate decision as the console's /gates/check (AD-057)
//   GET  /api/v1/runtime/approvals/:requestId  the state of an approval request THIS key opened (BM-41 inbox)
// Requests opened by a key are "requested by runtime-key:<id>", so a person (an admin) always decides them.
// The SDK in sdk/runtime-gate calls these, waits a bounded time for approval, records the outcome in the Trust Proof
// ledger, and fails closed. Decision support: a runtime that never asks is not stopped.

const KEY_RE = /^rgk_([0-9a-f-]{36})_([A-Za-z0-9_-]{43})$/;
const KIND = "runtime-key";

type RuntimeKey = { id: string; name: string; prefix: string; keyHash: string; createdAt: string; createdBy: string; revokedAt: string | null; revokedBy?: string; lastUsedAt: string | null };

const sha256 = (v: string) => createHash("sha256").update(v, "utf8").digest("hex");
const publicView = (k: RuntimeKey) => ({ id: k.id, name: k.name, prefix: k.prefix, createdAt: k.createdAt, createdBy: k.createdBy, revokedAt: k.revokedAt, lastUsedAt: k.lastUsedAt, state: k.revokedAt ? "revoked" : "active" });

const createBody = z.object({ name: z.string().trim().min(2).max(80) }).strict();
const idParams = z.object({ id: z.string().uuid() });
const requestParams = z.object({ requestId: z.string().uuid() });

// ---------- console side: admins create, list and revoke runtime keys ----------
export const runtimeKeyConsoleRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", async (request) => {
    await app.accountSecurity.requireVerified(actor(request).userId);
  });

  async function workspace(request: FastifyRequest): Promise<Organization> {
    const organization = await app.store.getOrganization(actor(request).organizationId);
    if (!organization) throw notFound("Workspace");
    return organization;
  }

  app.get("/runtime-keys", async (request) => {
    requireRole(request, "admin");
    const organization = await workspace(request);
    const keys = (await app.store.listConsoleRecords(organization.id, KIND)).map((r) => publicView(r.data as RuntimeKey));
    return success(request, { keys, note: "A runtime key lets an agent runtime ask the gate (POST /api/v1/runtime/gate/check) and read the approvals it opened. It cannot read or change anything else." });
  });

  app.post("/runtime-keys", async (request, reply) => {
    requireRole(request, "admin");
    const organization = await workspace(request);
    const { name } = createBody.parse(request.body);
    const active = (await app.store.listConsoleRecords(organization.id, KIND)).filter((r) => !(r.data as RuntimeKey).revokedAt);
    if (active.length >= 20) throw new AppError(409, "TOO_MANY_KEYS", "A workspace can have at most 20 active runtime keys. Revoke one first.");
    const id = randomUUID();
    const secret = randomBytes(32).toString("base64url");
    const key = `rgk_${organization.id}_${secret}`;
    const record: RuntimeKey = { id, name, prefix: secret.slice(0, 6), keyHash: sha256(key), createdAt: new Date().toISOString(), createdBy: actor(request).userId, revokedAt: null, lastUsedAt: null };
    await app.store.saveConsoleRecord({ organizationId: organization.id, kind: KIND, key: id, data: record });
    await audit(app.store, request, "organization", organization.id, "console.runtime_key_created", { keyId: id, prefix: record.prefix });
    const receipt = await recordReceipt(app.store, app.pqSigner, {
      orgId: organization.id, type: "runtime-key-created", subject: { kind: "runtime-key", id },
      facts: { keyId: id, prefix: record.prefix, by: record.createdBy, at: record.createdAt },
    }, request.log);
    reply.header("Cache-Control", "no-store");
    return reply.code(201).send(success(request, { ...publicView(record), key, receiptSeq: receipt?.seq ?? null, note: "Copy the key now: it is shown only once. Keep it in your agent runtime's secret store." }));
  });

  app.post("/runtime-keys/:id/revoke", async (request) => {
    requireRole(request, "admin");
    const organization = await workspace(request);
    const { id } = idParams.parse(request.params);
    const saved = await app.store.getConsoleRecord(organization.id, KIND, id);
    if (!saved) throw notFound("Runtime key");
    const record = saved.data as RuntimeKey;
    if (record.revokedAt) throw new AppError(409, "ALREADY_REVOKED", "This runtime key is already revoked.");
    record.revokedAt = new Date().toISOString();
    record.revokedBy = actor(request).userId;
    await app.store.saveConsoleRecord({ organizationId: organization.id, kind: KIND, key: id, data: record });
    await audit(app.store, request, "organization", organization.id, "console.runtime_key_revoked", { keyId: id, prefix: record.prefix });
    const receipt = await recordReceipt(app.store, app.pqSigner, {
      orgId: organization.id, type: "runtime-key-revoked", subject: { kind: "runtime-key", id },
      facts: { keyId: id, prefix: record.prefix, by: record.revokedBy, at: record.revokedAt },
    }, request.log);
    return success(request, { ...publicView(record), receiptSeq: receipt?.seq ?? null });
  });
};

// ---------- runtime side: authenticated by a runtime key only ----------
async function authenticateKey(app: FastifyInstance, request: FastifyRequest): Promise<{ organization: Organization; key: RuntimeKey }> {
  const header = String(request.headers.authorization ?? "");
  const match = KEY_RE.exec(header.startsWith("Bearer ") ? header.slice(7).trim() : "");
  const fail = () => new AppError(401, "INVALID_RUNTIME_KEY", "Missing, unknown or revoked runtime key.");
  if (!match) throw fail();
  const organization = await app.store.getOrganization(match[1]!);
  if (!organization) throw fail();
  const presented = Buffer.from(sha256(match[0]), "hex");
  for (const row of await app.store.listConsoleRecords(organization.id, KIND)) {
    const key = row.data as RuntimeKey;
    const stored = Buffer.from(key.keyHash, "hex");
    if (stored.length === presented.length && timingSafeEqual(stored, presented)) {
      if (key.revokedAt) throw fail();
      // lastUsedAt at most once a minute, so a busy runtime does not rewrite the record on every call.
      if (!key.lastUsedAt || Date.now() - Date.parse(key.lastUsedAt) > 60_000) {
        key.lastUsedAt = new Date().toISOString();
        await app.store.saveConsoleRecord({ organizationId: organization.id, kind: KIND, key: key.id, data: key });
      }
      return { organization, key };
    }
  }
  throw fail();
}

export const runtimeGateRoutes: FastifyPluginAsync = async (app) => {
  app.post("/gate/check", { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (request, reply) => {
    const { organization, key } = await authenticateKey(app, request);
    const input = gateCheckBody.parse(request.body);
    const result = await evaluateGate(app, organization, input, `runtime-key:${key.id}`, request.log);
    reply.header("Cache-Control", "no-store");
    return reply.code(result.status).send(success(request, result.body));
  });

  app.get("/approvals/:requestId", { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (request, reply) => {
    const { organization, key } = await authenticateKey(app, request);
    const { requestId } = requestParams.parse(request.params);
    const saved = await app.store.getConsoleRecord(organization.id, "approval-request", requestId);
    // A key sees only the requests it opened; anything else answers like a missing request.
    if (!saved || (saved.data as ApprovalRequest).requestedBy !== `runtime-key:${key.id}`) throw notFound("Approval request");
    const v = approvalView(saved.data as ApprovalRequest);
    reply.header("Cache-Control", "no-store");
    return success(request, { requestId: v.requestId, agentId: v.agentId, action: v.action, state: v.state, decidedAt: v.decidedAt ?? null, decidedByName: v.decidedByName ?? null, receiptSeq: v.receiptSeq ?? null, expiresAt: v.expiresAt });
  });
};
