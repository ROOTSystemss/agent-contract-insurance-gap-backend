import { z } from "zod";
import {
  deploymentStatuses,
  documentTypes,
  findingStatuses,
  humanOversightLevels,
} from "../domain/types.js";

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
const nonIsoRegionCodes = new Set([
  "AC",
  "CP",
  "CQ",
  "DG",
  "EA",
  "EU",
  "EZ",
  "IC",
  "TA",
  "UN",
  "XA",
  "XB",
  "ZZ",
]);
export function isIsoCountryCode(code: string): boolean {
  const name = regionNames.of(code);
  return Boolean(
    !nonIsoRegionCodes.has(code) && name && name !== code && name !== "Unknown Region",
  );
}
export const countryCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, "Use an ISO 3166-1 alpha-2 country code.")
  .refine(isIsoCountryCode, "Country code is not recognized as an ISO 3166-1 alpha-2 code.");
export const subdivisionCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}-[A-Z0-9]{1,3}$/, "Use a state or region code like US-IL (country code, a dash, then the region).")
  .optional();

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const registerSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(12).max(128),
  name: z.string().trim().min(2).max(100),
  organizationName: z.string().trim().min(2).max(160),
});

export const loginSchema = z.object({ email: z.email(), password: z.string().min(1).max(128) });

export const oauthAuthorizeSchema = z.object({
  clientId: z.string().min(1).max(200),
  redirectUri: z.url().max(2000),
  state: z.string().min(1).max(500),
  responseType: z.literal("code"),
});

export const oauthTokenSchema = z.object({
  grantType: z.literal("authorization_code"),
  code: z.string().min(1).max(500),
  redirectUri: z.url().max(2000),
  clientId: z.string().min(1).max(200),
  clientSecret: z.string().min(1).max(500),
});

export const projectCreateSchema = z.object({
  name: z.string().trim().min(2).max(160),
  description: z.string().trim().max(2000).nullable().default(null),
  primaryCountryCode: countryCodeSchema,
  primarySubdivisionCode: subdivisionCodeSchema.nullable().default(null),
  affectedCountryCodes: z.array(countryCodeSchema).max(50).default([]),
});

export const projectUpdateSchema = projectCreateSchema.partial();

const optionalMoney = z.number().nonnegative().max(1_000_000_000).optional();
export const agentProfileSchema = z
  .object({
    name: z.string().trim().min(2).max(160),
    description: z.string().trim().max(4000).optional(),
    deploymentStatus: z.enum(deploymentStatuses),
    businessPurpose: z.string().trim().min(5).max(4000),
    operatorOrganization: z.string().trim().min(2).max(200),
    developerProvider: z.string().trim().max(200).optional(),
    deploymentCountries: z.array(countryCodeSchema).min(1).max(50),
    affectedCountries: z.array(countryCodeSchema).max(50),
    primaryJurisdiction: countryCodeSchema,
    jurisdictionSubdivisions: z.array(z.string().trim().toUpperCase().max(16)).max(100),
    agentType: z.string().trim().min(2).max(120),
    autonomyLevel: z.union([
      z.literal(0),
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
    ]),
    humanOversightLevel: z.enum(humanOversightLevels),
    canCommunicateExternally: z.boolean(),
    canMakeRepresentations: z.boolean(),
    canAcceptTerms: z.boolean(),
    canExecuteTransactions: z.boolean(),
    canSpendMoney: z.boolean(),
    perTransactionLimit: optionalMoney,
    aggregateSpendingLimit: optionalMoney,
    currency: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    canIssueRefundsOrCredits: z.boolean(),
    canChangePrices: z.boolean(),
    canEnterContracts: z.boolean(),
    canApproveOrRejectPeople: z.boolean(),
    canApproveOrRejectVendors: z.boolean(),
    canAccessPersonalData: z.boolean(),
    canAccessSensitivePersonalData: z.boolean(),
    canAccessConfidentialBusinessData: z.boolean(),
    canAccessRegulatedData: z.boolean(),
    canModifyOrDeleteData: z.boolean(),
    canCreateIntellectualProperty: z.boolean(),
    canPublishContent: z.boolean(),
    canDeployCode: z.boolean(),
    canControlInfrastructure: z.boolean(),
    canHireOrTerminateWorkers: z.boolean(),
    canDelegateToSubAgents: z.boolean(),
    thirdPartyToolsUsed: z.array(z.string().trim().min(1).max(200)).max(100),
    systemsAccessed: z.array(z.string().trim().min(1).max(200)).max(100),
    reversibility: z.enum(["fully_reversible", "partially_reversible", "irreversible", "unknown"]),
    loggingLevel: z.enum(["none", "basic", "detailed", "tamper_evident"]),
    approvalThresholds: z.array(z.string().trim().min(1).max(500)).max(50),
    emergencyStopMechanism: z.string().trim().max(1000).optional(),
    incidentResponseOwner: z.string().trim().max(200).optional(),
    knownLimitations: z.array(z.string().trim().min(1).max(500)).max(100),
    notes: z.string().trim().max(5000).optional(),
  })
  .superRefine((profile, context) => {
    if (profile.canSpendMoney && (!profile.currency || profile.perTransactionLimit === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["perTransactionLimit"],
        message: "Spending agents require a currency and per-transaction limit.",
      });
    }
    if (
      !profile.canSpendMoney &&
      (profile.perTransactionLimit !== undefined || profile.aggregateSpendingLimit !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["canSpendMoney"],
        message: "Spending limits require canSpendMoney=true.",
      });
    }
  });

export const analysisCreateSchema = z.object({
  agentProfileId: z.string().uuid(),
  documentIds: z.array(z.string().uuid()).max(100).default([]),
});

export const findingStatusSchema = z.object({ status: z.enum(findingStatuses) });
export const documentMetadataSchema = z.object({
  documentType: z.enum(documentTypes),
  countryCode: countryCodeSchema,
  subdivisionCode: subdivisionCodeSchema,
});
