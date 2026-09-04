import type { AgentProfileInput } from "../domain/types.js";

export const DEMO_EMAIL = "demo@example.test";
export const DEMO_PASSWORD = "Demo-Only-Change-Me-123!";

export function procurementAgent(overrides: Partial<AgentProfileInput> = {}): AgentProfileInput {
  return {
    name: "Fictional Procurement Agent",
    description: "Communicates with vendors and creates bounded purchase orders.",
    deploymentStatus: "pilot",
    businessPurpose: "Support fictional procurement operations with bounded approvals.",
    operatorOrganization: "Fictional Acme Procurement Ltd",
    developerProvider: "Fictional Agent Works",
    deploymentCountries: ["US"],
    affectedCountries: ["US", "CA"],
    primaryJurisdiction: "US",
    jurisdictionSubdivisions: ["US-IL"],
    agentType: "procurement_workflow",
    autonomyLevel: 3,
    humanOversightLevel: "threshold_approval",
    canCommunicateExternally: true,
    canMakeRepresentations: true,
    canAcceptTerms: false,
    canExecuteTransactions: true,
    canSpendMoney: true,
    perTransactionLimit: 5_000,
    aggregateSpendingLimit: 25_000,
    currency: "USD",
    canIssueRefundsOrCredits: false,
    canChangePrices: false,
    canEnterContracts: false,
    canApproveOrRejectPeople: false,
    canApproveOrRejectVendors: true,
    canAccessPersonalData: true,
    canAccessSensitivePersonalData: true,
    canAccessConfidentialBusinessData: true,
    canAccessRegulatedData: false,
    canModifyOrDeleteData: false,
    canCreateIntellectualProperty: false,
    canPublishContent: false,
    canDeployCode: false,
    canControlInfrastructure: false,
    canHireOrTerminateWorkers: false,
    canDelegateToSubAgents: false,
    thirdPartyToolsUsed: ["Fictional Vendor Directory", "Fictional Payment Gateway"],
    systemsAccessed: ["Fictional Procurement Portal", "Fictional Vendor Records"],
    reversibility: "partially_reversible",
    loggingLevel: "detailed",
    approvalThresholds: ["Human approval required above USD 5,000"],
    emergencyStopMechanism: "Operator console kill switch",
    incidentResponseOwner: "Fictional Security Operations",
    knownLimitations: [
      "Cannot sign employment agreements",
      "Cannot deploy code",
      "Cannot hire or terminate workers",
    ],
    notes: "Entirely fictional seed profile.",
    ...overrides,
  };
}

export function controlledProcurementAgent(): AgentProfileInput {
  return procurementAgent({
    name: "Fictional Controlled Procurement Assistant",
    autonomyLevel: 2,
    humanOversightLevel: "pre_action_approval",
    canMakeRepresentations: false,
    canExecuteTransactions: false,
    canSpendMoney: false,
    perTransactionLimit: undefined,
    aggregateSpendingLimit: undefined,
    currency: undefined,
    canAccessSensitivePersonalData: false,
    reversibility: "fully_reversible",
  });
}
