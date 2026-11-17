import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Organization } from "../domain/types.js";
import { notFound } from "../shared/errors.js";
import { actor, audit, requireRole, success } from "./helpers.js";
import { agentIdSchema } from "./console-records-routes.js";
import { gateCertificates } from "./console-agent-ops-routes.js";

// N-AT-06 one connected flow (knock-out Phase 5, 2026-11-17).
//
// One guided path for a workspace: describe the agent (N-AT-04 wizard) -> certificate issued -> gate policy set ->
// runtime gate running with a workspace runtime key (BM-40) -> first ledger action seen -> monthly statement (BM-43).
// Every step's status is READ from the real source each time (projects' agent profiles, Agent Certificates, the gate
// policy, gate decisions made with a runtime key, the Trust Proof ledger, signed statements). Three states:
//   observed      seen in the source just now;
//   not-observed  the source answered and the step is not there yet ("Not verified" in the console);
//   unavailable   the source could not be read, so nothing is claimed.
// Nothing is ever marked done by a click. The only thing stored is a small progress record (ConsoleRecord kind
// "flow-progress": the chosen agent id and the step the person was on) so the flow can be resumed; the workspace export
// and deletion already cover ConsoleRecords.

export const FLOW_STEPS = ["describe", "certificate", "gate-policy", "runtime-gate", "ledger", "statement"] as const;
type StepId = (typeof FLOW_STEPS)[number];
type StepState = "observed" | "not-observed" | "unavailable";
type Step = { id: StepId; title: string; state: StepState; detail: string; observedAt: string | null; href: string };
type Progress = { agentId: string | null; currentStep: StepId; startedAt: string; startedBy: string; updatedAt: string; updatedBy: string };

const KIND = "flow-progress";
const KEY = "connected-flow";
const putBody = z.object({ agentId: agentIdSchema.nullable().optional(), currentStep: z.enum(FLOW_STEPS).optional() }).strict();

async function describedAgents(app: FastifyInstance, organizationId: string): Promise<string[]> {
  const names: string[] = [];
  for (let page = 1; page <= 10; page++) {
    const projects = await app.store.listProjects(organizationId, { page, pageSize: 100 });
    for (const project of projects.items) for (const agent of await app.store.listAgents(organizationId, project.id)) names.push(agent.name);
    if (page * 100 >= projects.total) break;
  }
  return names;
}

export async function flowStatus(app: FastifyInstance, organization: Organization, agentId: string | null): Promise<Step[]> {
  const orgId = organization.id;
  const forAgent = agentId ? ` for ${agentId}` : "";
  const step = (id: StepId, title: string, href: string, state: StepState, detail: string, observedAt: string | null = null): Step => ({ id, title, state, detail, observedAt, href });
  const linked = Boolean(await app.store.getServiceLink(orgId));
  const steps: Step[] = [];

  // 1. Describe the agent (N-AT-04 wizard in the coverage app).
  try {
    const names = await describedAgents(app, orgId);
    steps.push(names.length
      ? step("describe", "Describe the agent", "/app", "observed", `${names.length} agent profile${names.length === 1 ? "" : "s"} described: ${names.slice(0, 3).join(", ")}${names.length > 3 ? "â€¦" : ""}`)
      : step("describe", "Describe the agent", "/app", "not-observed", "No agent profile yet. Use the step-by-step wizard in a project (Agent profile, Use the wizard)."));
  } catch (error) {
    app.log.warn({ err: (error as Error).message }, "connected flow: agent profiles could not be read");
    steps.push(step("describe", "Describe the agent", "/app", "unavailable", "Agent profiles could not be read just now."));
  }

  // 2. Certificate issued (read live from Agent Certificates; never assumed).
  const certs = await gateCertificates(app, organization);
  if (certs.source === "not-activated") steps.push(step("certificate", "Issue its certificate", "#/agents", "not-observed", "Activate Agent Governance, then issue the agent a certificate."));
  else if (certs.source === "not-verified") steps.push(step("certificate", "Issue its certificate", "#/agents", "unavailable", "Agent Certificates could not be read just now, so this is not claimed."));
  else {
    const active = certs.certificates.filter((c) => c.status === "active" && (!agentId || c.agentId === agentId));
    const newest = active.sort((a, b) => Date.parse(b.issuedAt) - Date.parse(a.issuedAt))[0];
    steps.push(newest
      ? step("certificate", "Issue its certificate", "#/agents", "observed", `Active certificate for ${newest.agentId}, valid until ${newest.expiresAt.slice(0, 10)}.`, newest.issuedAt)
      : step("certificate", "Issue its certificate", "#/agents", "not-observed", `No active certificate${forAgent} in Agent Certificates.`));
  }

  // 3. Gate policy saved by an admin (AD-057). Until then the default applies, which is not "set".
  const policy = await app.store.getConsoleRecord(orgId, "settings", "gates");
  const rules = policy ? ((policy.data as { rules?: unknown[] }).rules ?? []).length : 0;
  steps.push(policy
    ? step("gate-policy", "Set the gate policy", "#/start", "observed", `Gate policy saved with ${rules} rule${rules === 1 ? "" : "s"}.`, policy.updatedAt)
    : step("gate-policy", "Set the gate policy", "#/start", "not-observed", "No gate policy saved yet; every action counts as medium impact until an admin saves one."));

  // 4. Runtime gate: observed only when a gate decision was asked with a runtime key (BM-40), not when a key exists.
  const keys = (await app.store.listConsoleRecords(orgId, "runtime-key")).map((r) => r.data as { revokedAt: string | null });
  const activeKeys = keys.filter((k) => !k.revokedAt).length;
  const runtimeChecks = (await app.store.listConsoleRecords(orgId, "gate"))
    .map((r) => r.data as { by?: string; agentId?: string; at?: string })
    .filter((d) => typeof d.by === "string" && d.by.startsWith("runtime-key:") && (!agentId || d.agentId === agentId))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  steps.push(runtimeChecks.length
    ? step("runtime-gate", "Connect the runtime gate", "#/start", "observed", `${runtimeChecks.length} gate check${runtimeChecks.length === 1 ? "" : "s"} from your runtime${forAgent}; ${activeKeys} active runtime key${activeKeys === 1 ? "" : "s"}.`, runtimeChecks[0]!.at ?? null)
    : step("runtime-gate", "Connect the runtime gate", "#/start", "not-observed", activeKeys ? `${activeKeys} active runtime key${activeKeys === 1 ? "" : "s"}; waiting for the first gate check from your runtime${forAgent}.` : "Create a runtime key and put the snippet in your agent runtime."));

  // 5. First action seen in the Trust Proof ledger.
  if (!linked) steps.push(step("ledger", "See the first ledger action", "#/ledger", "not-observed", "Activate Agent Governance first."));
  else {
    try {
      const ledger = await app.governance.ledger(organization, { ...(agentId ? { agentId } : {}), limit: 1 });
      const latest = ledger.actions[0];
      steps.push(ledger.count > 0 && latest
        ? step("ledger", "See the first ledger action", "#/ledger", "observed", `${ledger.count} action${ledger.count === 1 ? "" : "s"} recorded${forAgent}; latest ${latest.action} (${latest.verdict === "within_authority" ? "within authority" : "outside authority"}).`, latest.occurredAt)
        : step("ledger", "See the first ledger action", "#/ledger", "not-observed", `No action recorded in the ledger${forAgent} yet.`));
    } catch (error) {
      app.log.warn({ err: (error as Error).message }, "connected flow: ledger could not be read");
      steps.push(step("ledger", "See the first ledger action", "#/ledger", "unavailable", "The action ledger could not be read just now, so this is not claimed."));
    }
  }

  // 6. A signed monthly statement (BM-43).
  const statements = (await app.store.listConsoleRecords(orgId, "statement")).map((r) => r.data as { month: string; generatedAt: string; ledger?: string });
  const last = statements.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))[0];
  steps.push(last
    ? step("statement", "Make the monthly statement", "#/records", "observed", `Signed statement for ${last.month} (ledger: ${last.ledger ?? "unknown"}).`, last.generatedAt)
    : step("statement", "Make the monthly statement", "#/records", "not-observed", "No signed monthly statement yet."));
  return steps;
}

function snippet(publicBaseUrl: string, agentId: string | null) {
  const consoleUrl = new URL(publicBaseUrl).origin;
  const id = agentId ?? "your-agent-id";
  return {
    consoleUrl,
    agentId: id,
    env: `RUNTIME_GATE_KEY=<your runtime key, rgk_...>`,
    node: [
      `const { createRuntimeGate } = require("@rootsystems/runtime-gate");`,
      ``,
      `const gate = createRuntimeGate({`,
      `  consoleUrl: ${JSON.stringify(consoleUrl)},`,
      `  gateKey: process.env.RUNTIME_GATE_KEY,`,
      `  agentId: ${JSON.stringify(id)},`,
      `  approvalWaitMs: 10 * 60 * 1000, // wait up to 10 minutes for a person to approve`,
      `});`,
      ``,
      `await gate.run("invoices:pay", { resource: "INV-9", amountUsd: 120 }, () => payInvoice("INV-9"));`,
    ].join("\n"),
    curl: `curl -X POST ${consoleUrl}/api/v1/runtime/gate/check -H "Authorization: Bearer $RUNTIME_GATE_KEY" -H "Content-Type: application/json" -d '{"agentId":${JSON.stringify(id)},"action":"invoices:pay","amountUsd":120}'`,
  };
}

export const connectedFlowRoutes: FastifyPluginAsync<{ publicBaseUrl: string }> = async (app, options) => {
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", async (request) => {
    await app.accountSecurity.requireVerified(actor(request).userId);
  });

  async function workspace(request: FastifyRequest): Promise<Organization> {
    const organization = await app.store.getOrganization(actor(request).organizationId);
    if (!organization) throw notFound("Workspace");
    return organization;
  }

  async function view(organization: Organization, progress: Progress | null) {
    const agentId = progress?.agentId ?? null;
    const steps = await flowStatus(app, organization, agentId);
    const next = steps.find((s) => s.state !== "observed")?.id ?? null;
    return {
      agentId,
      steps,
      observed: steps.filter((s) => s.state === "observed").length,
      total: steps.length,
      complete: next === null,
      nextStep: next,
      resumeAt: progress?.currentStep ?? next ?? FLOW_STEPS[0],
      progress,
      snippet: snippet(options.publicBaseUrl, agentId),
      note: "Each step shows what the source says right now. 'Not verified' means not seen yet; 'Could not check' means the source did not answer, so nothing is claimed. Decision support only.",
    };
  }

  app.get("/connected-flow", async (request, reply) => {
    const organization = await workspace(request);
    const saved = await app.store.getConsoleRecord(organization.id, KIND, KEY);
    reply.header("Cache-Control", "no-store");
    return success(request, await view(organization, (saved?.data as Progress | undefined) ?? null));
  });

  app.put("/connected-flow", async (request) => {
    requireRole(request, "analyst");
    const organization = await workspace(request);
    const input = putBody.parse(request.body);
    const saved = (await app.store.getConsoleRecord(organization.id, KIND, KEY))?.data as Progress | undefined;
    const who = actor(request).userId;
    const now = new Date().toISOString();
    const progress: Progress = {
      agentId: input.agentId === undefined ? (saved?.agentId ?? null) : input.agentId,
      currentStep: input.currentStep ?? saved?.currentStep ?? FLOW_STEPS[0],
      startedAt: saved?.startedAt ?? now,
      startedBy: saved?.startedBy ?? who,
      updatedAt: now,
      updatedBy: who,
    };
    await app.store.saveConsoleRecord({ organizationId: organization.id, kind: KIND, key: KEY, data: progress });
    if (!saved || saved.agentId !== progress.agentId) await audit(app.store, request, "organization", organization.id, "console.connected_flow_agent_set", { agentId: progress.agentId });
    return success(request, await view(organization, progress));
  });
};
