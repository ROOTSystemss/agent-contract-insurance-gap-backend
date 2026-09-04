import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { AnalysisService } from "../analysis/analysis-service.js";
import { ReportService } from "../reports/report-service.js";
import { generateReportPdf } from "../reports/pdf-report.js";
import { notFound } from "../shared/errors.js";
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
