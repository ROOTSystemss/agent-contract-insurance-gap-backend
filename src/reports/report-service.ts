import type { Analysis, DocumentRecord, Finding } from "../domain/types.js";
import type { Store } from "../persistence/store.js";
import { CANONICAL_DISCLAIMER } from "../shared/disclaimer.js";
import { notFound } from "../shared/errors.js";

const severityOrder = ["critical", "high", "moderate", "low", "informational"];

function groupBy<T>(items: T[], key: (item: T) => string): Record<string, T[]> {
  return items.reduce<Record<string, T[]>>((groups, item) => {
    const value = key(item);
    (groups[value] ??= []).push(item);
    return groups;
  }, {});
}

export class ReportService {
  constructor(private readonly store: Store) {}

  async generate(organizationId: string, analysisId: string) {
    const analysis = await this.store.getAnalysis(organizationId, analysisId);
    if (!analysis) throw notFound("Analysis");
    const project = await this.store.getProject(organizationId, analysis.projectId);
    const agent = await this.store.getAgent(organizationId, analysis.agentProfileId);
    if (!project || !agent) throw notFound("Analysis dependency");
    const documents: DocumentRecord[] = [];
    for (const id of analysis.documentIds) {
      const document = await this.store.getDocument(organizationId, id);
      if (document) documents.push(document);
    }
    const result = await this.store.listFindings(organizationId, analysisId, {
      page: 1,
      pageSize: 100,
    });
    const findings = [...result.items].sort(
      (a, b) => severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity),
    );
    const questionsForCounsel = findings
      .filter((finding) => finding.suggestedProfessionalReviewer === "legal_counsel")
      .flatMap((finding) => finding.recommendedReviewQuestions);
    const questionsForInsurance = findings
      .filter((finding) => finding.suggestedProfessionalReviewer === "insurance_broker_or_insurer")
      .flatMap((finding) => finding.recommendedReviewQuestions);
    return {
      projectSummary: { id: project.id, name: project.name, description: project.description },
      agentSummary: {
        id: agent.id,
        name: agent.name,
        autonomyLevel: agent.autonomyLevel,
        humanOversightLevel: agent.humanOversightLevel,
        businessPurpose: agent.businessPurpose,
      },
      jurisdictionSelection: {
        primary: project.primaryCountryCode,
        subdivision: project.primarySubdivisionCode,
        affected: project.affectedCountryCodes,
      },
      jurisdictionSupportLevel: analysis.warnings.some((warning) =>
        warning.includes("universal structural"),
      )
        ? "universal_only"
        : "localized",
      analyzedDocuments: documents.map((document) => ({
        id: document.id,
        filename: document.originalFilename,
        documentType: document.documentType,
        checksum: document.checksum,
        extractionStatus: document.extractionStatus,
        pageCount: document.pageCount,
      })),
      extractionWarnings: documents.flatMap((document) => document.extractionWarnings),
      overallAttentionScore: analysis.attentionScore?.score ?? null,
      attentionLabel: analysis.attentionScore?.label ?? null,
      confidence: analysis.attentionScore?.confidence ?? null,
      scoreContributions: analysis.attentionScore?.contributions ?? [],
      executiveSummary: this.executiveSummary(analysis, findings),
      findingsBySeverity: groupBy(findings, (finding) => finding.severity),
      findingsByCategory: groupBy(findings, (finding) => finding.category),
      evidenceReferences: findings.flatMap((finding) =>
        finding.evidence.map((evidence) => ({ findingId: finding.id, ...evidence })),
      ),
      missingInformation: findings
        .filter((finding) =>
          ["missing_document", "insufficient_evidence"].includes(finding.category),
        )
        .map((finding) => finding.documentFact),
      questionsForLegalCounsel: [...new Set(questionsForCounsel)],
      questionsForInsuranceBrokerOrInsurer: [...new Set(questionsForInsurance)],
      limitations: [
        ...new Set([...analysis.warnings, ...findings.flatMap((finding) => finding.limitations)]),
      ],
      disclaimer: CANONICAL_DISCLAIMER,
      analysisEngineVersion: analysis.engineVersion,
      rulesetVersions: analysis.rulesetVersions,
      jurisdictionPackVersions: analysis.jurisdictionPackIds,
      generationTimestamp: new Date().toISOString(),
    };
  }

  private executiveSummary(analysis: Analysis, findings: Finding[]): string {
    const high = findings.filter(
      (finding) => finding.severity === "high" || finding.severity === "critical",
    ).length;
    const score = analysis.attentionScore?.score ?? 0;
    return `The deterministic review produced ${findings.length} finding${findings.length === 1 ? "" : "s"}, including ${high} requiring high or critical attention. The overall attention score is ${score}/100. This score prioritizes review and is not a legal-risk or coverage probability.`;
  }
}
