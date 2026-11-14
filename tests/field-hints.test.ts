// AD-072 (2026-11-13): plain-English one-line hints under the AI Agent Trust profile fields buyers find
// confusing, and on the less obvious capability toggles.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const app = readFileSync(join(process.cwd(), "public", "app.js"), "utf8");

describe("agent profile field hints", () => {
  const fields = ["agentType", "primaryJurisdiction", "deploymentCountries", "affectedCountries", "autonomyLevel", "humanOversightLevel", "reversibility", "loggingLevel", "perTransactionLimit", "aggregateSpendingLimit", "approvalThresholds", "emergencyStopMechanism", "incidentResponseOwner"];
  it.each(fields)("%s has a one-line hint", (name) => {
    const m = app.match(new RegExp(`data-hint="${name}">([^<]+)<`));
    expect(m, name).not.toBeNull();
    expect((m?.[1] ?? "").length).toBeGreaterThan(15);
    expect((m?.[1] ?? "").length).toBeLessThan(160);
  });
  it("the unclear capabilities carry a hint, rendered escaped", () => {
    for (const name of ["canMakeRepresentations", "canAcceptTerms", "canExecuteTransactions", "canAccessRegulatedData", "canDelegateToSubAgents"]) {
      expect(app).toMatch(new RegExp(`${name}: "`));
    }
    expect(app).toContain('data-hint="${name}"');
    expect(app).toContain("escapeHtml(capabilityHints[name])");
  });
  it("hints make no compliance claims", () => {
    const hints = [...app.matchAll(/data-hint="[^"]+">([^<]+)</g)].map((m) => m[1] ?? "").join(" ");
    expect(hints).not.toMatch(/compliant|guarantee|certified/i);
  });
});
