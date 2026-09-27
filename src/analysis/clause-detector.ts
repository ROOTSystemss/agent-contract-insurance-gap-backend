import type {
  ClauseDetection,
  DocumentRecord,
  EvidenceReference,
  InsuranceCategory,
} from "../domain/types.js";
import { CLAUSE_TAXONOMY } from "./clause-taxonomy.js";

export interface DocumentClassification {
  category: InsuranceCategory;
  confidence: number;
  evidence: EvidenceReference[];
  limitations: string[];
}

export function evidenceForMatch(
  document: DocumentRecord,
  segmentIndex: number,
  start: number,
  length: number,
): EvidenceReference {
  const segment = document.segments[segmentIndex];
  if (!segment) throw new Error("Segment index is out of bounds.");
  const excerptStart = Math.max(0, start - 45);
  const excerptEnd = Math.min(segment.originalText.length, start + length + 75);
  return {
    segmentId: segment.id,
    documentId: document.id,
    pageNumber: segment.pageNumber,
    excerpt: segment.originalText.slice(excerptStart, excerptEnd),
    characterStart: segment.characterStart + excerptStart,
    characterEnd: segment.characterStart + excerptEnd,
  };
}

export function detectClauses(document: DocumentRecord): ClauseDetection[] {
  const detections: ClauseDetection[] = [];
  for (const item of CLAUSE_TAXONOMY) {
    let best: ClauseDetection | null = null;
    for (const [segmentIndex, segment] of document.segments.entries()) {
      const lower = segment.originalText.toLowerCase();
      for (const phrase of item.phraseFamilies) {
        const index = lower.indexOf(phrase.toLowerCase());
        if (index < 0) continue;
        const headingMatch =
          segment.sectionHeading?.toLowerCase().includes(phrase.toLowerCase()) ?? false;
        const negated = /\b(no|not|never|without)\b/.test(
          lower.slice(Math.max(0, index - 35), index),
        );
        const confidence = Math.max(
          0.45,
          Math.min(0.92, 0.68 + (headingMatch ? 0.16 : 0) - (negated ? 0.08 : 0)),
        );
        const detection: ClauseDetection = {
          category: item.id,
          evidence: evidenceForMatch(document, segmentIndex, index, phrase.length),
          confidence,
          detectorId: `deterministic.phrase.${item.id}`,
          ruleVersion: "clause-detector@1.0.0",
          explanation: `${headingMatch ? "Heading and phrase" : "Phrase"} pattern matched “${phrase}”.${negated ? " Nearby negation was detected and lowers confidence." : ""}`,
          limitations: [
            "A deterministic phrase match identifies potentially responsive language but does not interpret legal effect.",
          ],
        };
        if (!best || detection.confidence > best.confidence) best = detection;
      }
    }
    if (best) detections.push(best);
  }
  return detections;
}

const insuranceSignals: Array<[InsuranceCategory, string[]]> = [
  ["cyber", ["cyber", "privacy breach", "network security"]],
  ["technology_errors_and_omissions", ["technology errors and omissions", "technology services"]],
  ["professional_liability", ["professional liability", "professional services"]],
  [
    "commercial_general_liability",
    ["commercial general liability", "bodily injury", "property damage"],
  ],
  ["directors_and_officers", ["directors and officers", "management liability"]],
  ["crime_and_fidelity", ["crime", "fidelity", "social engineering"]],
  ["media_liability", ["media liability", "defamation"]],
  ["product_liability", ["product liability"]],
  ["employment_practices_liability", ["employment practices liability"]],
];

export function classifyInsuranceDocument(document: DocumentRecord): DocumentClassification {
  const lower = document.extractedText.toLowerCase();
  let best: { category: InsuranceCategory; phrase: string; index: number } | null = null;
  for (const [category, phrases] of insuranceSignals) {
    for (const phrase of phrases) {
      const index = lower.indexOf(phrase);
      if (index >= 0 && (!best || phrase.length > best.phrase.length))
        best = { category, phrase, index };
    }
  }
  if (!best) {
    return {
      category: "other_or_unknown",
      confidence: 0.25,
      evidence: [],
      limitations: ["No sufficiently specific insurance-category phrase was located."],
    };
  }
  const segmentIndex = document.segments.findIndex(
    (segment) =>
      best !== null && segment.characterStart <= best.index && segment.characterEnd >= best.index,
  );
  return {
    category: best.category,
    confidence: 0.72,
    evidence:
      segmentIndex >= 0
        ? [
            evidenceForMatch(
              document,
              segmentIndex,
              Math.max(0, best.index - document.segments[segmentIndex]!.characterStart),
              best.phrase.length,
            ),
          ]
        : [],
    limitations: ["Classification is informational and based on deterministic text signals."],
  };
}

export interface ModelAssistedDetector {
  readonly providerName: string;
  classifyDocument(text: string): Promise<unknown>;
  classifyClauses(text: string): Promise<unknown>;
  extractStructuredData(text: string): Promise<unknown>;
  explainFinding(finding: unknown): Promise<unknown>;
}

export function validateUntrustedProviderEvidence(
  excerpt: string,
  document: DocumentRecord,
): boolean {
  return excerpt.length > 0 && document.extractedText.includes(excerpt);
}
