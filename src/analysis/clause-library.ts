import type { AgentProfile, ClauseDetection, DocumentRecord, FindingCategory, Severity } from "../domain/types.js";
import { evidenceForMatch } from "./clause-detector.js";

// BM clause library: fixed, deterministic patterns for RESTRICTIONS in contracts and insurance
// documents, and the contradiction check that compares them with what the agent profile declares.
// A contradiction is raised only when a sentence both (a) matches a restriction pattern and (b) is about
// the same subject as a declared capability; the finding quotes that sentence and the capability. It is
// an attention signal for professional review, not a legal interpretation.

export const CLAUSE_LIBRARY_VERSION = "bm-clause-library@1.0.0";

export type RestrictionKind =
  | "approval_required"
  | "written_approval"
  | "authorized_personnel_only"
  | "prohibition"
  | "automation_exclusion"
  | "spending_limit"
  | "access_record";

export const RESTRICTION_PATTERNS: Array<{ kind: RestrictionKind; label: string; pattern: RegExp }> = [
  { kind: "written_approval", label: "written approval", pattern: /\b(?:prior\s+)?written\s+(?:approval|consent|authori[sz]ation)\b/i },
  {
    kind: "approval_required",
    label: "must be approved",
    pattern: /\b(?:must|shall|will)\s+(?:first\s+|only\s+)?be\s+(?:pre-?)?approved\b|\b(?:require|requires|required|need|needs|subject\s+to)\s+(?:the\s+)?(?:prior\s+|express\s+)?(?:\w+\s+){0,2}approval\b|\bwithout\s+(?:the\s+)?(?:prior\s+)?(?:\w+\s+){0,2}approval\b|\bapproved\s+(?:in\s+advance\s+)?by\s+(?:the\s+)?\w+/i,
  },
  { kind: "authorized_personnel_only", label: "only authorized personnel", pattern: /\bonly\s+(?:duly\s+|properly\s+)?authori[sz]ed\s+(?:personnel|employees|staff|officers|representatives|individuals|persons|people|signatories)\b/i },
  { kind: "prohibition", label: "may not / prohibited", pattern: /\b(?:may|shall|must|will)\s+not\b|\bprohibited\b|\bis\s+not\s+permitted\b|\bforbidden\b/i },
  {
    kind: "automation_exclusion",
    label: "excludes automated systems / software",
    pattern: /\bexclu\w*\b[^.;]{0,160}\b(?:automated\s+(?:systems?|decisions?|processes?|means)|software|autonomous\s+(?:systems?|agents?)|bots?|algorithm\w*|artificial\s+intelligence)\b|\b(?:automated\s+systems?|software|autonomous\s+agents?|bots?)\b[^.;]{0,160}\bexclu\w*\b/i,
  },
  {
    kind: "spending_limit",
    label: "spending limit",
    pattern: /\b(?:not\s+to\s+exceed|in\s+excess\s+of|exceeding|exceeds?|above|over|more\s+than|greater\s+than|up\s+to|limit\s+of|threshold\s+of|maximum\s+of)\s+(?:USD|US\$|\$)\s*\d[\d,]*(?:\.\d{1,2})?/i,
  },
  { kind: "access_record", label: "record of every access", pattern: /\b(?:record|log|audit\s+trail)s?\b[^.;]{0,40}\b(?:of\s+)?(?:every|each|all)\b[^.;]{0,60}\baccess\w*\b|\b(?:every|each|all)\b[^.;]{0,40}\baccess\w*\b[^.;]{0,60}\b(?:recorded|logged)\b/i },
];

// Subjects a restriction sentence can be about. A sentence can have several.
type Subject = "refunds_credits" | "representations" | "pricing" | "personal_data" | "contracts" | "spending" | "delegation" | "automation";
const SUBJECTS: Array<[Subject, RegExp]> = [
  ["refunds_credits", /\b(?:refunds?|credits?|credit\s+notes?|chargebacks?|rebates?|write-?offs?)\b/i],
  ["representations", /\b(?:statements?|representations?|represent|promises?|commitments?|assurances?|warrant(?:y|ies)?|quotes?)\b/i],
  ["pricing", /\b(?:pric(?:e|es|ing)|discounts?|rates?|fees?)\b/i],
  ["personal_data", /\bpersonal[\s-](?:data|information)\b|\b(?:PII|customer\s+data|data\s+subjects?)\b/i],
  ["contracts", /\b(?:contracts?|agreements?|terms|purchase\s+orders?)\b/i],
  ["spending", /\b(?:payments?|purchases?|spend\w*|expenditures?|disburse\w*|transactions?)\b/i],
  ["delegation", /\b(?:subcontract\w*|delegat\w*|sub-?agents?|assign\s+(?:its\s+)?(?:rights|obligations))\b/i],
  ["automation", /\b(?:automated|software|autonomous|bots?|algorithm\w*|artificial\s+intelligence|AI)\b/],
];

export interface RestrictionClause {
  kind: RestrictionKind;
  label: string;
  documentId: string;
  documentType: DocumentRecord["documentType"];
  sentence: string;
  subjects: Subject[];
  amounts: number[];
  requiresPriorHumanApproval: boolean;
  evidence: ClauseDetection["evidence"];
}

const AMOUNT = /(?:USD|US\$|\$)\s*(\d[\d,]*(?:\.\d{1,2})?)/gi;

/** Every restriction sentence in a document, one entry per (sentence, kind). */
export function findRestrictions(document: DocumentRecord): RestrictionClause[] {
  const out: RestrictionClause[] = [];
  for (const [segmentIndex, segment] of document.segments.entries()) {
    for (const m of segment.originalText.matchAll(/[^.;!?\n]+[.;!?]?/g)) {
      const sentence = m[0].trim();
      if (sentence.length < 12) continue;
      const start = (m.index ?? 0) + m[0].indexOf(sentence);
      const subjects = SUBJECTS.filter(([, re]) => re.test(sentence)).map(([s]) => s);
      const amounts = [...sentence.matchAll(AMOUNT)].map((a) => Number(a[1]!.replaceAll(",", ""))).filter(Number.isFinite);
      for (const { kind, label, pattern } of RESTRICTION_PATTERNS) {
        if (!pattern.test(sentence)) continue;
        if (kind === "automation_exclusion" && !document.documentType.startsWith("insurance_")) continue;
        out.push({
          kind, label, documentId: document.id, documentType: document.documentType, sentence, subjects, amounts,
          requiresPriorHumanApproval: /\bwithout\s+(?:the\s+)?prior\s+(?:\w+\s+){0,2}(?:human\s+)?(?:approval|review|authori[sz]ation)\b/i.test(sentence),
          evidence: { ...evidenceForMatch(document, segmentIndex, start, sentence.length), excerpt: sentence },
        });
      }
    }
  }
  return out;
}

export interface ContradictionDraft {
  key: string;
  title: string;
  category: FindingCategory;
  severity: Severity;
  confidence: number;
  capability: string;
  documentId: string;
  clauseCategory: string;
  documentFact: string;
  agentFact: string;
  inference: string;
  rule: string;
  evidence: ClauseDetection["evidence"][];
  question: string;
  reviewer: "legal_counsel" | "insurance_broker_or_insurer" | "security_or_privacy";
}

const APPROVAL_KINDS: RestrictionKind[] = ["approval_required", "written_approval", "authorized_personnel_only", "prohibition"];
const HUMAN_APPROVES_EVERY_ACTION = new Set(["continuous", "pre_action_approval"]);
const oversightText = (a: AgentProfile) => a.humanOversightLevel.replaceAll("_", " ");
const quote = (s: string) => `"${s.length > 280 ? s.slice(0, 277) + "..." : s}"`;
const docWord = (c: RestrictionClause) => (c.documentType.startsWith("insurance_") ? "The insurance document" : "The contract");

// Declared capabilities that an approval / personnel / prohibition clause about the same subject restricts.
const CAPABILITY_SUBJECTS: Array<{ capability: keyof AgentProfile; label: (a: AgentProfile) => string; subjects: Subject[]; category: FindingCategory; reviewer: ContradictionDraft["reviewer"] }> = [
  { capability: "canIssueRefundsOrCredits", label: (a) => `issues refunds or credits${a.perTransactionLimit !== undefined ? ` (up to ${a.currency ?? ""} ${a.perTransactionLimit}`.replace("  ", " ") + ")" : ""}`, subjects: ["refunds_credits"], category: "approval_control_mismatch", reviewer: "legal_counsel" },
  { capability: "canMakeRepresentations", label: () => "makes representations or statements to outside parties", subjects: ["representations"], category: "authority_mismatch", reviewer: "legal_counsel" },
  { capability: "canChangePrices", label: () => "changes prices", subjects: ["pricing"], category: "authority_mismatch", reviewer: "legal_counsel" },
  { capability: "canEnterContracts", label: () => "enters contracts", subjects: ["contracts"], category: "authority_mismatch", reviewer: "legal_counsel" },
  { capability: "canAcceptTerms", label: () => "accepts terms", subjects: ["contracts"], category: "authority_mismatch", reviewer: "legal_counsel" },
  { capability: "canSpendMoney", label: (a) => `spends money${a.perTransactionLimit !== undefined ? ` (up to ${a.currency ?? ""} ${a.perTransactionLimit} per transaction)`.replace("  ", " ") : ""}`, subjects: ["spending"], category: "approval_control_mismatch", reviewer: "legal_counsel" },
  { capability: "canDelegateToSubAgents", label: () => "delegates work to sub-agents", subjects: ["delegation"], category: "sub_agent_gap", reviewer: "legal_counsel" },
];

/** Contradictions between declared capabilities and restriction clauses. Deterministic. */
export function findContradictions(agent: AgentProfile, documents: DocumentRecord[]): ContradictionDraft[] {
  const drafts: ContradictionDraft[] = [];
  const seen = new Set<string>();
  const push = (d: ContradictionDraft) => { if (!seen.has(d.key)) { seen.add(d.key); drafts.push(d); } };
  const clauses = documents.flatMap(findRestrictions);
  const humanApprovesEach = HUMAN_APPROVES_EVERY_ACTION.has(agent.humanOversightLevel);

  // 1. Approval, authorized-personnel and prohibition clauses vs capabilities on the same subject.
  for (const rule of CAPABILITY_SUBJECTS) {
    if (agent[rule.capability] !== true) continue;
    for (const c of clauses) {
      if (!APPROVAL_KINDS.includes(c.kind) || !rule.subjects.some((s) => c.subjects.includes(s))) continue;
      // A human approving every action satisfies an approval clause, but not an "only authorized personnel"
      // clause or a prohibition: the agent is still the one acting.
      if (humanApprovesEach && (c.kind === "approval_required" || c.kind === "written_approval")) continue;
      const personnel = c.kind === "authorized_personnel_only";
      const prohibited = c.kind === "prohibition";
      push({
        key: `contradiction:${String(rule.capability)}:${c.kind}:${c.documentId}`,
        title: personnel
          ? `Contradiction: the agent ${rule.label(agent)}, but only authorized personnel may`
          : prohibited
            ? `Contradiction: the agent ${rule.label(agent)}, which a clause prohibits`
            : `Contradiction: the agent ${rule.label(agent)} without the approval a clause requires`,
        category: rule.category,
        severity: "high",
        confidence: 0.8,
        capability: String(rule.capability),
        documentId: c.documentId,
        clauseCategory: personnel ? "authorized_users" : prohibited ? "representations_commitments" : "approval_requirements",
        documentFact: `${docWord(c)} says: ${quote(c.sentence)}`,
        agentFact: `The agent profile declares that "${agent.name}" ${rule.label(agent)}, with human oversight "${oversightText(agent)}"${agent.approvalThresholds.length ? ` and approval thresholds ${agent.approvalThresholds.map((t) => `"${t}"`).join(", ")}` : ""}.`,
        inference: personnel
          ? "The clause reserves this action for authorized personnel; the profile has software performing it."
          : prohibited
            ? "The clause forbids an action on this subject that the profile says the agent performs."
            : "The clause requires approval for this action; the declared oversight lets the agent act without approving each one.",
        rule: `BM.CONTRADICTION.${c.kind.toUpperCase()}`,
        evidence: [c.evidence],
        question: personnel
          ? "Ask counsel whether the agent can be treated as authorized personnel here, or whether a named person must make or confirm these actions."
          : "Ask counsel and the business owner whether each of these agent actions must be approved before it takes effect, and change the agent's controls to match.",
        reviewer: rule.reviewer,
      });
    }
  }

  // 2. Spending limits: a documented amount below the agent's per-transaction limit, on a money subject.
  if ((agent.canSpendMoney || agent.canIssueRefundsOrCredits) && agent.perTransactionLimit !== undefined) {
    for (const c of clauses.filter((x) => x.kind === "spending_limit" && x.amounts.length)) {
      if (!c.subjects.some((s) => s === "spending" || s === "refunds_credits")) continue;
      const documented = Math.min(...c.amounts);
      if (agent.perTransactionLimit <= documented) continue;
      push({
        key: `contradiction:perTransactionLimit:spending_limit:${c.documentId}`,
        title: `Contradiction: the agent's limit (${agent.currency ?? ""} ${agent.perTransactionLimit}) is above a documented limit of ${documented}`.replace("( ", "("),
        category: "transaction_limit_mismatch", severity: "high", confidence: 0.82,
        capability: "perTransactionLimit", documentId: c.documentId, clauseCategory: "approval_requirements",
        documentFact: `${docWord(c)} says: ${quote(c.sentence)}`,
        agentFact: `The agent profile declares a per-transaction limit of ${agent.currency ?? "(currency unspecified)"} ${agent.perTransactionLimit}.`,
        inference: "The agent may act above the amount the document sets as its limit.",
        rule: "BM.CONTRADICTION.SPENDING_LIMIT", evidence: [c.evidence],
        question: "Ask the business owner whether the agent's technical limit must be lowered to the documented amount.",
        reviewer: "legal_counsel",
      });
    }
  }

  // 3. "Record of every access" vs personal-data access with no or basic logging.
  if ((agent.canAccessPersonalData || agent.canAccessSensitivePersonalData) && (agent.loggingLevel === "none" || agent.loggingLevel === "basic")) {
    for (const c of clauses.filter((x) => x.kind === "access_record")) {
      push({
        key: `contradiction:loggingLevel:access_record:${c.documentId}`,
        title: `Contradiction: every access must be recorded, but the agent's logging is "${agent.loggingLevel}"`,
        category: "recordkeeping_gap", severity: "high", confidence: 0.8,
        capability: "loggingLevel", documentId: c.documentId, clauseCategory: "recordkeeping",
        documentFact: `${docWord(c)} says: ${quote(c.sentence)}`,
        agentFact: `The agent profile declares personal-data access with logging level "${agent.loggingLevel}".`,
        inference: "Basic or no logging may not produce a record of each access the agent makes.",
        rule: "BM.CONTRADICTION.ACCESS_RECORD", evidence: [c.evidence],
        question: "Ask privacy counsel whether the agent's logs must record every personal-data access (who, what, when), and raise the logging level to match.",
        reviewer: "security_or_privacy",
      });
    }
  }

  // 4. Insurance that excludes automated systems / software, vs an agent acting without approving each action.
  const acting = (["canIssueRefundsOrCredits", "canMakeRepresentations", "canSpendMoney", "canExecuteTransactions", "canEnterContracts", "canAcceptTerms", "canChangePrices", "canCommunicateExternally"] as const).filter((k) => agent[k] === true);
  if (acting.length && !humanApprovesEach) {
    for (const c of clauses.filter((x) => x.kind === "automation_exclusion")) {
      push({
        key: `contradiction:autonomy:automation_exclusion:${c.documentId}`,
        title: c.requiresPriorHumanApproval
          ? "Contradiction: insurance excludes automated actions without prior human approval, and the agent acts without it"
          : "Contradiction: insurance excludes automated systems, and the agent acts on its own",
        category: "potential_exclusion_relevance", severity: "high", confidence: c.requiresPriorHumanApproval ? 0.85 : 0.72,
        capability: "humanOversightLevel", documentId: c.documentId, clauseCategory: "exclusions",
        documentFact: `${docWord(c)} says: ${quote(c.sentence)}`,
        agentFact: `The agent profile declares that "${agent.name}" can ${acting.map((k) => k.replace(/^can/, "").replace(/([A-Z])/g, " $1").trim().toLowerCase()).join(", ")}, with human oversight "${oversightText(agent)}".`,
        inference: "Loss caused by the agent's own actions may fall inside this exclusion.",
        rule: "BM.CONTRADICTION.AUTOMATION_EXCLUSION", evidence: [c.evidence],
        question: "Ask the broker whether this exclusion applies to the agent's actions, and whether prior human approval of each action, an endorsement or a buy-back restores cover.",
        reviewer: "insurance_broker_or_insurer",
      });
    }
  }
  return drafts;
}
