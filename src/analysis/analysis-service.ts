import { randomUUID } from "node:crypto";
import type { Analysis, Finding, PaginationInput } from "../domain/types.js";
import { selectJurisdictionPacks } from "../jurisdictions/packs.js";
import type { Store } from "../persistence/store.js";
import { AppError, notFound } from "../shared/errors.js";
import { detectClauses } from "./clause-detector.js";
import { analyzeGaps, ENGINE_VERSION, UNIVERSAL_RULE_VERSION } from "./gap-engine.js";
import { calculateAttentionScore } from "./scoring.js";

export class AnalysisService {
  constructor(private readonly store: Store) {}

  async create(input: {
    organizationId: string;
    projectId: string;
    agentProfileId: string;
    documentIds: string[];
  }): Promise<Analysis> {
    const project = await this.store.getProject(input.organizationId, input.projectId);
    if (!project) throw notFound("Project");
    const agent = await this.store.getAgent(input.organizationId, input.agentProfileId);
    if (!agent || agent.projectId !== project.id) throw notFound("Agent profile");
    for (const id of input.documentIds) {
      const document = await this.store.getDocument(input.organizationId, id);
      if (!document || document.projectId !== project.id) throw notFound("Document");
    }
    const timestamp = new Date().toISOString();
    return this.store.createAnalysis({
      id: randomUUID(),
      organizationId: input.organizationId,
      projectId: project.id,
      agentProfileId: agent.id,
      documentIds: [...new Set(input.documentIds)],
      state: input.documentIds.length ? "ready" : "waiting_for_documents",
      engineVersion: ENGINE_VERSION,
      rulesetVersions: [UNIVERSAL_RULE_VERSION, "clause-detector@1.0.0"],
      jurisdictionPackIds: [],
      attentionScore: null,
      warnings: [],
      failureReason: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
    });
  }

  async run(
    organizationId: string,
    id: string,
  ): Promise<{ analysis: Analysis; findings: Finding[] }> {
    const analysis = await this.store.getAnalysis(organizationId, id);
    if (!analysis) throw notFound("Analysis");
    const agent = await this.store.getAgent(organizationId, analysis.agentProfileId);
    if (!agent)
      throw new AppError(
        409,
        "AGENT_PROFILE_MISSING",
        "The selected agent profile no longer exists.",
      );
    const documents = [];
    for (const documentId of analysis.documentIds) {
      const document = await this.store.getDocument(organizationId, documentId);
      if (document) documents.push(document);
    }
    const started: Analysis = {
      ...analysis,
      state: "running",
      updatedAt: new Date().toISOString(),
      failureReason: null,
    };
    await this.store.updateAnalysis(started);
    try {
      const detections = new Map(
        documents.map((document) => [document.id, detectClauses(document)]),
      );
      const packSelection = selectJurisdictionPacks(agent.primaryJurisdiction);
      const findings = analyzeGaps({
        organizationId,
        projectId: analysis.projectId,
        analysisId: id,
        agent,
        documents,
        detections,
        packSelection,
      });
      const score = calculateAttentionScore({
        agent,
        documents,
        detections: [...detections.values()].flat(),
        jurisdictionUniversalOnly: packSelection.status === "universal_only",
      });
      const extractionWarnings = documents.flatMap((document) => document.extractionWarnings);
      const warnings = [...packSelection.warnings, ...extractionWarnings];
      const completedAt = new Date().toISOString();
      const completed: Analysis = {
        ...started,
        state: warnings.length ? "completed_with_warnings" : "completed",
        jurisdictionPackIds: packSelection.packs.map((pack) => pack.id),
        attentionScore: score,
        warnings,
        updatedAt: completedAt,
        completedAt,
      };
      await this.store.replaceFindings(organizationId, id, findings);
      await this.store.updateAnalysis(completed);
      return { analysis: completed, findings };
    } catch (error) {
      await this.store.updateAnalysis({
        ...started,
        state: "failed",
        failureReason: error instanceof Error ? error.message.slice(0, 500) : "Analysis failed.",
        updatedAt: new Date().toISOString(),
      });
      throw error;
    }
  }

  async findings(organizationId: string, analysisId: string, pagination: PaginationInput) {
    if (!(await this.store.getAnalysis(organizationId, analysisId))) throw notFound("Analysis");
    return this.store.listFindings(organizationId, analysisId, pagination);
  }
}
