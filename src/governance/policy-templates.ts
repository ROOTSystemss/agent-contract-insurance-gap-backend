// AD-060 (knock-out Phase 5): policy templates for AI agents. Original wording written for RootSystems; a starting
// point to adapt, not legal advice. Readiness wording only. The workspace edits a template, publishes a version, and
// members acknowledge it (signed receipts).
export interface PolicyTemplate {
  id: "ai-use" | "agent-approval";
  title: string;
  supports: string[];
  text: string;
}

const NOTICE = "TEMPLATE - adapt it to your organisation and review it with your advisor before use. Not legal advice.";

export const POLICY_TEMPLATES: PolicyTemplate[] = [
  {
    id: "ai-use",
    title: "AI use policy",
    supports: ["ISO/IEC 42001 readiness (AI policy, roles, responsible use)", "EU AI Act readiness (AI literacy and transparency duties)", "NIST AI RMF Govern function"],
    text: [
      NOTICE,
      "",
      "1. Purpose. This policy sets how people in [Organisation] may use AI tools and AI agents at work.",
      "2. Approved tools. Only AI tools and agents listed in the agent inventory may be used with company data. Ask [Owner role] to add a tool before using it.",
      "3. Data. Do not put customer personal data, health information, payment card data, passwords or secrets into an AI tool unless the inventory says that tool is approved for that data.",
      "4. People stay accountable. A named person is accountable for every agent and for every decision an agent prepares. AI output is checked by a person before it is sent to a customer, published or used for a decision about a person.",
      "5. Transparency. Tell people when they are interacting with an AI system or reading content an AI system generated, where that is expected or required.",
      "6. Mistakes and incidents. Report any AI mistake that affected a customer, money, data or a decision about a person to [Owner role] the same day. It is recorded in the agent incident log.",
      "7. Training. Everyone who uses AI tools completes the short AI-use briefing when they start and once a year.",
      "8. Review. [Owner role] reviews this policy at least once a year and after any significant AI incident.",
    ].join("\n"),
  },
  {
    id: "agent-approval",
    title: "Agent approval policy",
    supports: ["ISO/IEC 42001 readiness (approval of AI systems, change control)", "NIST AI RMF Govern and Manage functions"],
    text: [
      NOTICE,
      "",
      "1. Purpose. This policy sets how an AI agent gets permission to act for [Organisation], and how that permission changes or ends.",
      "2. Before an agent acts. Every agent has an entry in the agent inventory (owner role, vendor, purpose, data access) and a signed authority certificate listing exactly what it may do and its limits.",
      "3. Approval. A new agent, a new permission or a higher limit needs sign-off by a named approver who is not the person requesting it. The approval is recorded and signed.",
      "4. Limits. Payments and other high-impact actions have a written limit per action and per day. Anything above the limit goes to a person.",
      "5. Re-certification. Each agent's permissions are re-approved at least every [90] days. Permissions that are no longer needed are reduced or revoked.",
      "6. Stopping an agent. Any approver may stop an agent at once with the kill switch when it acts outside its authority or a risk appears. The reason is recorded.",
      "7. Records. Certificates, the action ledger, approvals, re-certifications and incidents are kept as signed records for [retention period].",
      "8. Review. [Owner role] reviews this policy at least once a year.",
    ].join("\n"),
  },
];

export const policyTemplate = (id: string): PolicyTemplate | undefined => POLICY_TEMPLATES.find((t) => t.id === id);
