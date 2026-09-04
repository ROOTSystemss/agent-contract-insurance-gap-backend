import { createHash } from "node:crypto";
import { z } from "zod";

export const packStatusSchema = z.enum([
  "universal_only",
  "preliminary",
  "reviewed",
  "production",
  "unavailable",
  "research_required",
]);

export const sourceSchema = z.object({
  title: z.string().min(1),
  issuingOrganization: z.string().min(1),
  sourceType: z.enum(["official_guidance", "legislation", "regulation", "standard", "other"]),
  url: z.url(),
  publicationDate: z.iso.date().nullable(),
  accessDate: z.iso.date(),
  jurisdiction: z.string().min(1),
  notes: z.string(),
  verificationStatus: z.enum(["unverified", "verified", "superseded"]),
});

export const jurisdictionPackSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  countryCode: z.string().regex(/^(GLOBAL|EU|[A-Z]{2})$/),
  subdivisionCode: z.string().nullable(),
  regionType: z.enum(["global", "country", "supranational", "subdivision"]),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  status: packStatusSchema,
  effectiveDate: z.iso.date(),
  reviewedDate: z.iso.date().nullable(),
  supportedDocumentTypes: z.array(z.string()),
  supportedInsuranceCategories: z.array(z.string()),
  universalRuleOverrides: z.record(z.string(), z.unknown()),
  additionalRules: z.array(
    z.object({
      id: z.string(),
      description: z.string(),
      clauseCategories: z.array(z.string()),
      enabled: z.boolean(),
    }),
  ),
  terminology: z.record(z.string(), z.string()),
  limitations: z.array(z.string()).min(1),
  disclaimerAddendum: z.string(),
  sources: z.array(sourceSchema),
  reviewerMetadata: z.object({
    reviewer: z.string().nullable(),
    qualifications: z.string().nullable(),
    reviewNotes: z.string(),
  }),
  checksum: z.string(),
});

export type JurisdictionPack = z.infer<typeof jurisdictionPackSchema>;

export function calculatePackChecksum(pack: Omit<JurisdictionPack, "checksum">): string {
  return createHash("sha256").update(JSON.stringify(pack)).digest("hex");
}

export function validatePack(input: unknown): JurisdictionPack {
  const pack = jurisdictionPackSchema.parse(input);
  const { checksum: _checksum, ...withoutChecksum } = pack;
  const expected = calculatePackChecksum(withoutChecksum);
  if (pack.checksum !== expected)
    throw new Error(`Jurisdiction pack checksum mismatch: ${pack.id}`);
  return pack;
}
