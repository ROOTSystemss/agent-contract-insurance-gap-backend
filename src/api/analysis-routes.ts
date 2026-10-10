import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { AnalysisService } from "../analysis/analysis-service.js";
import { ReportService } from "../reports/report-service.js";
import { buildAssurancePack, verifyAssurancePack } from "../reports/assurance-pack.js";
import { timestampPack, verifyPackTimestamps } from "../reports/pack-timestamps.js";
import { isTrunkActive } from "../governance/trunk.js";
import { reconcile, requireVerifiedCertificate } from "../authority/certificate.js";
import type { DocumentRecord, Finding } from "../domain/types.js";
import { generateReportPdf } from "../reports/pdf-report.js";
import { AppError, notFound } from "../shared/errors.js";
import { actor, audit, paginatedMeta, pagination, requireRole, success } from "./helpers.js";
import { analysisCreateSchema } from "./schemas.js";

const projectParams = z.object({ projectId: z.string().uuid() });
const analysisParams = z.object({ id: z.string().uuid() });

export const projectAnalysisRoutes: FastifyPluginAsync = async (app) => {
  const service = new AnalysisService(app.store);
  app.addHook("preHandler", app.authenticate);

  app.post("/:projectId/analyses", async (request, reply) => {
    requireRole(request, "analyst");
    const { projectId } = projectParams.parse(request.params);
    const analysis = await service.create({
      organizationId: actor(request).organizationId,
      projectId,
      ...analysisCreateSchema.parse(request.body),
    });
    await audit(app.store, request, "analysis", analysis.id, "analysis.create", { projectId });
    return reply.code(201).send(success(request, analysis));
  });

  app.get("/:projectId/analyses", async (request) => {
    const { projectId } = projectParams.parse(request.params);
    const result = await app.store.listAnalyses(
      actor(request).organizationId,
      projectId,
      pagination(request.query),
    );
    return success(request, result.items, paginatedMeta(result));
  });
};

export const analysisRoutes: FastifyPluginAsync = async (app) => {
  const service = new AnalysisService(app.store);
  const reports = new ReportService(app.store);
  app.addHook("preHandler", app.authenticate);

  app.get("/:id", async (request) => {
    const { id } = analysisParams.parse(request.params);
    const analysis = await app.store.getAnalysis(actor(request).organizationId, id);
    if (!analysis) throw notFound("Analysis");
    return success(request, analysis);
  });

  async function run(request: FastifyRequest) {
    requireRole(request, "analyst");
    const { id } = analysisParams.parse(request.params);
    const result = await service.run(actor(request).organizationId, id);
    await audit(app.store, request, "analysis", id, "analysis.run", {
      projectId: result.analysis.projectId,
      state: result.analysis.state,
    });
    return success(request, result);
  }

  app.post("/:id/run", run);
  app.post("/:id/rerun", run);

  app.get("/:id/findings", async (request) => {
    const { id } = analysisParams.parse(request.params);
    const result = await service.findings(
      actor(request).organizationId,
      id,
      pagination(request.query),
    );
    return success(request, result.items, paginatedMeta(result));
  });

  app.get("/:id/report", async (request) => {
    const { id } = analysisParams.parse(request.params);
    const report = await reports.generate(actor(request).organizationId, id);
    await audit(app.store, request, "analysis", id, "report.generate", {
      projectId: report.projectSummary.id,
    });
    return success(request, report);
  });

  // Builds the fingerprinted Agent Assurance Pack for one finished analysis. With a certificate in
  // the body, the pack also states whether the agent's profile covers what its signed authority
  // certificate allows (the certificate is verified live with Authority Atlas first).
  app.post("/:id/assurance-pack", async (request) => {
    requireRole(request, "analyst");
    const { id } = analysisParams.parse(request.params);
    const { certificate } = z
      .object({ certificate: z.string().min(20).max(8000).optional() })
      .parse(request.body ?? {});
    const orgId = actor(request).organizationId;
    const analysis = await app.store.getAnalysis(orgId, id);
    if (!analysis) throw notFound("Analysis");
    // A finished analysis may carry warnings; they are included in the pack rather than blocking it.
    if (analysis.state !== "completed" && analysis.state !== "completed_with_warnings") {
      throw new AppError(
        409,
        "ANALYSIS_NOT_COMPLETED",
        "The analysis must be completed before an assurance pack can be built.",
      );
    }
    const project = await app.store.getProject(orgId, analysis.projectId);
    const agent = await app.store.getAgent(orgId, analysis.agentProfileId);
    if (!project || !agent) throw notFound("Analysis dependency");
    const organization = await app.store.getOrganization(orgId);

    const findings: Finding[] = [];
    for (let page = 1; ; page++) {
      const result = await app.store.listFindings(orgId, id, { page, pageSize: 100 });
      findings.push(...result.items);
      if (findings.length >= result.total || result.items.length === 0) break;
    }
    const documents: DocumentRecord[] = [];
    for (const documentId of analysis.documentIds) {
      const document = await app.store.getDocument(orgId, documentId);
      if (document) documents.push(document);
    }
    const reconciliation = certificate
      ? reconcile(agent, await requireVerifiedCertificate(app.certificateVerifier, certificate))
      : null;

    const built = buildAssurancePack(
      {
        organizationName: organization?.name ?? "Unknown organization",
        projectName: project.name,
        agent,
        analysis,
        findings,
        documents,
        certificate: reconciliation,
      },
      app.pqSigner,
    );
    // Trunk workspaces also get two independent timestamps on the contentHash (best effort).
    const timestamps = isTrunkActive(orgId) ? await timestampPack(built.contentHash) : null;
    await audit(app.store, request, "analysis", id, "assurance_pack.generate", {
      projectId: analysis.projectId,
      contentHash: built.contentHash,
      withCertificate: reconciliation !== null,
      rfc3161: Boolean(timestamps?.rfc3161),
      openTimestamps: Boolean(timestamps?.openTimestamps),
    });
    return success(request, { ...built, timestamps });
  });

  // Recomputes a pack's fingerprint. Proves the pack is unchanged since it was built.
  app.post("/assurance-pack/verify", async (request) => {
    const body = z
      .object({
        pack: z.record(z.string(), z.unknown()),
        contentHash: z.string().regex(/^[0-9a-fA-F]{64}$/),
        signature: z
          .object({
            value: z.string().min(1).max(8000),
            publicKey: z.string().max(4000).optional(),
          })
          .passthrough()
          .optional(),
        timestamps: z
          .object({
            rfc3161: z
              .object({ tokenBase64: z.string().min(1).max(20000) })
              .passthrough()
              .nullish(),
            openTimestamps: z
              .object({ proofBase64: z.string().min(1).max(20000) })
              .passthrough()
              .nullish(),
          })
          .passthrough()
          .nullish(),
      })
      .parse(request.body);
    const result = verifyAssurancePack(body.pack, body.contentHash, body.signature, app.pqSigner);
    if (!body.timestamps) return success(request, result);
    // Timestamps are checked against the hash recomputed from the pack, not the one supplied.
    return success(request, {
      ...result,
      timestamps: verifyPackTimestamps(result.computedHash, {
        rfc3161: body.timestamps.rfc3161 ?? undefined,
        openTimestamps: body.timestamps.openTimestamps ?? undefined,
      }),
    });
  });

  app.get("/:id/report.pdf", async (request, reply) => {
    const { id } = analysisParams.parse(request.params);
    const report = await reports.generate(actor(request).organizationId, id);
    const contents = await generateReportPdf(report);
    const safeName = report.projectSummary.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80);
    await audit(app.store, request, "analysis", id, "report.pdf_generate", {
      projectId: report.projectSummary.id,
    });
    return reply
      .header("Content-Disposition", `attachment; filename="${safeName || "authority-review"}.pdf"`)
      .type("application/pdf")
      .send(contents);
  });
};
