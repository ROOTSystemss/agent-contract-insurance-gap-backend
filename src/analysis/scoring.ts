import type {
  AgentProfile,
  AttentionScore,
  ClauseDetection,
  DocumentRecord,
  Finding,
  ScoreContribution,
} from "../domain/types.js";

function contribution(
  dimension: string,
  points: number,
  maximum: number,
  explanation: string,
): ScoreContribution {
  return {
    dimension,
    points: Math.max(0, Math.min(maximum, Math.round(points))),
    maximum,
    explanation,
  };
}

export function calculateAttentionScore(input: {
  agent: AgentProfile;
  documents: DocumentRecord[];
  detections: ClauseDetection[];
  jurisdictionUniversalOnly: boolean;
  findings?: Array<Pick<Finding, "severity">>;
}): AttentionScore {
  const { agent, documents, detections } = input;
  const contributions: ScoreContribution[] = [];
  contributions.push(
    contribution(
      "autonomy",
      agent.autonomyLevel * 2.4,
      12,
      `Declared autonomy level ${agent.autonomyLevel}/5.`,
    ),
  );
  contributions.push(
    contribution(
      "financial_authority",
      agent.canSpendMoney
        ? 5 + (agent.perTransactionLimit && agent.perTransactionLimit > 10_000 ? 5 : 2)
        : 0,
      10,
      agent.canSpendMoney
        ? "Agent can spend money; configured limits affect attention."
        : "No spending authority declared.",
    ),
  );
  contributions.push(
    contribution(
      "contractual_authority",
      agent.canEnterContracts || agent.canAcceptTerms ? 9 : agent.canMakeRepresentations ? 4 : 0,
      9,
      "Contract, terms, and representation permissions are considered.",
    ),
  );
  contributions.push(
    contribution(
      "external_communication",
      agent.canCommunicateExternally ? 5 : 0,
      5,
      "External communication can create commercial consequences.",
    ),
  );
  const dataFlags = [
    agent.canAccessPersonalData,
    agent.canAccessSensitivePersonalData,
    agent.canAccessConfidentialBusinessData,
    agent.canAccessRegulatedData,
  ].filter(Boolean).length;
  contributions.push(
    contribution(
      "data_sensitivity",
      dataFlags * 2.25,
      9,
      `${dataFlags} sensitive-data capability groups were declared.`,
    ),
  );
  const operationalFlags = [
    agent.canDeployCode,
    agent.canControlInfrastructure,
    agent.canModifyOrDeleteData,
    agent.canHireOrTerminateWorkers,
  ].filter(Boolean).length;
  contributions.push(
    contribution(
      "operational_impact",
      operationalFlags * 2,
      8,
      `${operationalFlags} material operational permissions were declared.`,
    ),
  );
  contributions.push(
    contribution(
      "human_oversight",
      (
        {
          continuous: 0,
          pre_action_approval: 1,
          threshold_approval: 3,
          periodic_review: 5,
          exception_only: 7,
          none: 8,
        } as const
      )[agent.humanOversightLevel],
      8,
      `Oversight is ${agent.humanOversightLevel.replaceAll("_", " ")}.`,
    ),
  );
  contributions.push(
    contribution(
      "reversibility",
      agent.reversibility === "irreversible"
        ? 7
        : agent.reversibility === "partially_reversible"
          ? 4
          : agent.reversibility === "unknown"
            ? 5
            : 0,
      7,
      `Actions are described as ${agent.reversibility.replaceAll("_", " ")}.`,
    ),
  );
  contributions.push(
    contribution(
      "sub_agent_delegation",
      agent.canDelegateToSubAgents ? 6 : 0,
      6,
      agent.canDelegateToSubAgents
        ? "Sub-agent delegation is enabled."
        : "No sub-agent delegation declared.",
    ),
  );
  const responsiveCategories = new Set(detections.map((detection) => detection.category)).size;
  contributions.push(
    contribution(
      "document_clarity",
      documents.length === 0 ? 8 : Math.max(0, 7 - responsiveCategories / 4),
      8,
      documents.length === 0
        ? "No documents were available."
        : `${responsiveCategories} responsive clause categories were detected.`,
    ),
  );
  const insuranceDocs = documents.filter((document) =>
    document.documentType.startsWith("insurance_"),
  );
  const insuranceDefinitionFound = detections.some((detection) =>
    ["insured_persons_entities", "covered_acts_services", "definitions_automation_ai"].includes(
      detection.category,
    ),
  );
  contributions.push(
    contribution(
      "insurance_ambiguity",
      insuranceDocs.length === 0 ? 7 : insuranceDefinitionFound ? 2 : 7,
      7,
      insuranceDocs.length === 0
        ? "No insurance document was supplied."
        : insuranceDefinitionFound
          ? "Some responsive insurance definitions were detected."
          : "No responsive actor or autonomous-system definition was detected.",
    ),
  );
  contributions.push(
    contribution(
      "missing_documents",
      documents.length === 0 ? 6 : insuranceDocs.length === 0 ? 3 : 0,
      6,
      documents.length === 0
        ? "No documents were supplied."
        : insuranceDocs.length === 0
          ? "No insurance document was supplied."
          : "Contract and insurance material were supplied.",
    ),
  );
  contributions.push(
    contribution(
      "jurisdiction_pack_maturity",
      input.jurisdictionUniversalOnly ? 5 : 1,
      5,
      input.jurisdictionUniversalOnly
        ? "Only GLOBAL structural logic is available; confidence is reduced."
        : "A localized pack is available.",
    ),
  );

  const rawScore = Math.min(
    100,
    contributions.reduce((sum, item) => sum + item.points, 0),
  );
  const severities = new Set(input.findings?.map((finding) => finding.severity) ?? []);
  const severityFloor = severities.has("critical")
    ? 76
    : severities.has("high")
      ? 51
      : severities.has("moderate")
        ? 26
        : 0;
  const score = Math.max(rawScore, severityFloor);
  if (score > rawScore) {
    contributions.push(
      contribution(
        "finding_severity_guardrail",
        score - rawScore,
        76,
        `The score was raised from ${rawScore} to ${score} so the overall attention level does not understate the most severe finding.`,
      ),
    );
  }
  const label: AttentionScore["label"] =
    score >= 76
      ? "critical_review"
      : score >= 51
        ? "high_attention"
        : score >= 26
          ? "moderate_attention"
          : "low_attention";
  const extractable = documents.filter(
    (document) =>
      document.extractionStatus === "completed" ||
      document.extractionStatus === "completed_with_warnings",
  ).length;
  const confidence = Math.round(
    Math.max(
      20,
      Math.min(
        95,
        55 +
          extractable * 8 +
          Math.min(15, responsiveCategories) -
          (input.jurisdictionUniversalOnly ? 15 : 0),
      ),
    ),
  );
  return { score, label, confidence, contributions };
}
