import { documentTypes, insuranceCategories } from "../domain/types.js";
import { calculatePackChecksum, validatePack, type JurisdictionPack } from "./pack-schema.js";

const basePack = {
  id: "GLOBAL@1.0.0",
  name: "Global structural review",
  countryCode: "GLOBAL",
  subdivisionCode: null,
  regionType: "global" as const,
  version: "1.0.0",
  status: "production" as const,
  effectiveDate: "2026-09-01",
  reviewedDate: "2026-09-01",
  supportedDocumentTypes: [...documentTypes],
  supportedInsuranceCategories: [...insuranceCategories],
  universalRuleOverrides: {},
  additionalRules: [],
  terminology: {
    attention: "A signal for professional review, not a probability of loss or coverage.",
  },
  limitations: [
    "Provides structural document comparison only and does not apply country-specific law.",
    "Does not determine coverage, enforceability, or legal effect.",
  ],
  disclaimerAddendum: "Jurisdiction-specific professional review is required.",
  sources: [],
  reviewerMetadata: {
    reviewer: null,
    qualifications: null,
    reviewNotes: "Universal rules are product logic, not statements of law.",
  },
};

function withChecksum(input: Omit<JurisdictionPack, "checksum">): JurisdictionPack {
  return validatePack({ ...input, checksum: calculatePackChecksum(input) });
}

export const GLOBAL_PACK = withChecksum(basePack);

const scaffoldCountries = [
  ["US", "United States"],
  ["GB", "United Kingdom"],
  ["EU", "European Union"],
  ["CA", "Canada"],
  ["IN", "India"],
  ["AU", "Australia"],
] as const;

export const JURISDICTION_PACKS: JurisdictionPack[] = [
  GLOBAL_PACK,
  ...scaffoldCountries.map(([code, name]) =>
    withChecksum({
      ...basePack,
      id: `${code}@0.1.0`,
      name: `${name} research scaffold`,
      countryCode: code,
      regionType: code === "EU" ? "supranational" : "country",
      version: "0.1.0",
      status: "research_required",
      reviewedDate: null,
      supportedDocumentTypes: [],
      supportedInsuranceCategories: [],
      limitations: [
        `No verified ${name}-specific legal or insurance rules are included.`,
        "Analysis falls back to the GLOBAL structural rules.",
      ],
      disclaimerAddendum: `No localized conclusion is made for ${name}.`,
      reviewerMetadata: {
        reviewer: null,
        qualifications: null,
        reviewNotes:
          "Requires qualified local legal and insurance review before localized rules are enabled.",
      },
    }),
  ),
];

export interface PackSelection {
  packs: JurisdictionPack[];
  status: JurisdictionPack["status"];
  warnings: string[];
}

export function selectJurisdictionPacks(countryCode: string): PackSelection {
  const normalized = countryCode.toUpperCase();
  const localized = JURISDICTION_PACKS.find((pack) => pack.countryCode === normalized);
  if (
    !localized ||
    localized.status === "research_required" ||
    localized.status === "universal_only"
  ) {
    return {
      packs: localized ? [GLOBAL_PACK, localized] : [GLOBAL_PACK],
      status: "universal_only",
      warnings: [
        `Only universal structural analysis is available for ${normalized}. No localized legal or insurance conclusion is provided.`,
      ],
    };
  }
  return { packs: [GLOBAL_PACK, localized], status: localized.status, warnings: [] };
}
