import { randomUUID } from "node:crypto";
import type { Analysis, DocumentRecord, Finding, PaginationInput } from "../domain/types.js";
import { selectJurisdictionPacks } from "../jurisdictions/packs.js";
import type { Store } from "../persistence/store.js";
import { AppError, notFound } from "../shared/errors.js";
import { detectClauses } from "./clause-detector.js";
import { analyzeGaps, ENGINE_VERSION, UNIVERSAL_RULE_VERSION } from "./gap-engine.js";
import { calculateAttentionScore } from "./scoring.js";

// Why a selected document cannot be reviewed, or null when its text was read. A document with little
// text ("completed_with_warnings") is still reviewed; its warning travels with the analysis.
export function unreviewableReason(document: DocumentRecord | null, documentId: string): string | null {
  if (!document) return `A selected document (id ${documentId}) was deleted before the analysis ran, so it was not reviewed.`;
  const name = `"${document.originalFilename}"`;
  switch (document.extractionStatus) {
    case "failed":
      return `${name} could not be read (text extraction failed${document.extractionError ? `: ${document.extractionError}` : ""}), so it was not reviewed.`;
    case "ocr_required":
      return `${name} has no readable text (it looks like a scanned PDF and needs OCR), so it was not reviewed.`;
    case "pending":
      return `${name} had not been read yet when the analysis ran, so it was not reviewed.`;
    default:
      return null;
  }
}

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
      errors: [],
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
    // Only documents whose text was actually read are reviewed. Every other selected document is named
    // in `errors` and the analysis finishes as completed_with_errors, never as plain "completed".
    const documents: DocumentRecord[] = [];
    const errors: string[] = [];
    for (const documentId of analysis.documentIds) {
      const document = await this.store.getDocument(organizationId, documentId);
      const problem = unreviewableReason(document, documentId);
      if (problem) errors.push(problem);
      else documents.push(document!);
    }
    const started: Analysis = {
      ...analysis,
      state: "running",
      errors: [],
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
        findings,
      });
      const extractionWarnings = documents.flatMap((document) => document.extractionWarnings);
      const warnings = [...packSelection.warnings, ...extractionWarnings];
      // A document removed while the run was in progress: its findings were computed, but it is gone now.
      for (const document of documents) {
        if (!(await this.store.getDocument(organizationId, document.id))) {
          errors.push(`"${document.originalFilename}" (id ${document.id}) was deleted while the analysis was running. Findings that cite it can no longer be traced to the document.`);
        }
      }
      const completedAt = new Date().toISOString();
      const completed: Analysis = {
        ...started,
        state: errors.length ? "completed_with_errors" : warnings.length ? "completed_with_warnings" : "completed",
        jurisdictionPackIds: packSelection.packs.map((pack) => pack.id),
        attentionScore: score,
        warnings,
        errors,
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
