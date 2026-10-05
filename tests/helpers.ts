import { PrismaClient } from "@prisma/client";
import type { AgentProfileInput } from "../src/domain/types.js";

// Postgres suites share the one local database named by ACG_TEST_DATABASE_URL (after `prisma migrate
// deploy`). A single-connection client holding an advisory lock keeps suites in different test files
// from running against it at the same time; disconnecting releases the lock.
export async function openTestDatabase(url: string): Promise<PrismaClient> {
  const parsed = new URL(url);
  if (!["localhost", "127.0.0.1"].includes(parsed.hostname)) throw new Error("ACG_TEST_DATABASE_URL must point at a local database");
  parsed.searchParams.set("connection_limit", "1");
  const client = new PrismaClient({ datasources: { db: { url: parsed.toString() } } });
  await client.$executeRawUnsafe("SELECT pg_advisory_lock(72730501)");
  return client;
}

export function agentInput(overrides: Partial<AgentProfileInput> = {}): AgentProfileInput {
  return {
    name: "ProcureBot",
    description: "Fictional procurement workflow agent",
    deploymentStatus: "pilot",
    businessPurpose: "Prepare and approve bounded purchase orders",
    operatorOrganization: "Fictional Acme Procurement Ltd",
    developerProvider: "Fictional Systems Studio",
    deploymentCountries: ["US"],
    affectedCountries: ["US", "CA"],
    primaryJurisdiction: "US",
    jurisdictionSubdivisions: ["US-IL"],
    agentType: "procurement",
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
    canAccessSensitivePersonalData: false,
    canAccessConfidentialBusinessData: true,
    canAccessRegulatedData: false,
    canModifyOrDeleteData: false,
    canCreateIntellectualProperty: false,
    canPublishContent: false,
    canDeployCode: false,
    canControlInfrastructure: false,
    canHireOrTerminateWorkers: false,
    canDelegateToSubAgents: false,
    thirdPartyToolsUsed: ["Fictional Vendor Directory"],
    systemsAccessed: ["Fictional Procurement Portal"],
    reversibility: "partially_reversible",
    loggingLevel: "detailed",
    approvalThresholds: ["Human approval above USD 5,000"],
    emergencyStopMechanism: "Operator kill switch",
    incidentResponseOwner: "Fictional Security Operations",
    knownLimitations: ["Cannot sign employment agreements", "Cannot deploy code"],
    notes: "Safe fictional test data.",
    ...overrides,
  };
}
