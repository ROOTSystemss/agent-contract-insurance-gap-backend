import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:4400";
let token = "";

async function request(path, options = {}) {
  const headers = new Headers(options.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (options.body && !(options.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const payload = response.status === 204 ? null : await response.json();
  assert.ok(response.ok, `${options.method ?? "GET"} ${path} failed: ${JSON.stringify(payload)}`);
  return payload?.data;
}

const product = await fetch(`${baseUrl}/`);
assert.equal(product.status, 200);
assert.match(await product.text(), /AI Agent Trust/);

const suffix = Date.now();
const registration = await request("/api/v1/auth/register", {
  method: "POST",
  body: JSON.stringify({
    email: `live-smoke-${suffix}@example.test`,
    password: "Correct Horse Battery 123!",
    name: "Live Test Reviewer",
    organizationName: "Root Systems Test Workspace",
  }),
});
token = registration.accessToken;

const project = await request("/api/v1/projects/", {
  method: "POST",
  body: JSON.stringify({
    name: "Live Authority Review",
    description: "End-to-end verification of the local product workflow.",
    primaryCountryCode: "US",
    primarySubdivisionCode: "US-IL",
    affectedCountryCodes: ["CA"],
  }),
});

const agent = await request(`/api/v1/projects/${project.id}/agents`, {
  method: "POST",
  body: JSON.stringify({
    name: "Procurement Agent",
    deploymentStatus: "pilot",
    businessPurpose: "Prepare and execute approved vendor purchases.",
    operatorOrganization: "Root Systems Test Workspace",
    deploymentCountries: ["US"],
    affectedCountries: ["CA"],
    primaryJurisdiction: "US",
    jurisdictionSubdivisions: ["US-IL"],
    agentType: "Transaction agent",
    autonomyLevel: 4,
    humanOversightLevel: "threshold_approval",
    canCommunicateExternally: true,
    canMakeRepresentations: true,
    canAcceptTerms: true,
    canExecuteTransactions: true,
    canSpendMoney: true,
    perTransactionLimit: 5000,
    aggregateSpendingLimit: 25000,
    currency: "USD",
    canIssueRefundsOrCredits: false,
    canChangePrices: false,
    canEnterContracts: true,
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
    thirdPartyToolsUsed: ["Procurement portal"],
    systemsAccessed: ["Vendor database"],
    reversibility: "partially_reversible",
    loggingLevel: "detailed",
    approvalThresholds: ["Human approval above USD 1,000"],
    emergencyStopMechanism: "Operator kill switch",
    incidentResponseOwner: "Security Operations",
    knownLimitations: ["Cannot independently verify vendor identity"],
  }),
});

const contract = await readFile(
  new URL("../demo/fixtures/contract-human-approval.txt", import.meta.url),
);
const uploadBody = new FormData();
uploadBody.append(
  "file",
  new Blob([contract], { type: "text/plain" }),
  "contract-human-approval.txt",
);
const document = await request(
  `/api/v1/projects/${project.id}/documents?documentType=commercial_contract&countryCode=US&subdivisionCode=US-IL`,
  { method: "POST", body: uploadBody },
);
assert.equal(document.extractionStatus, "completed");

const analysis = await request(`/api/v1/projects/${project.id}/analyses`, {
  method: "POST",
  body: JSON.stringify({ agentProfileId: agent.id, documentIds: [document.id] }),
});
const result = await request(`/api/v1/analyses/${analysis.id}/run`, { method: "POST" });
assert.match(result.analysis.state, /^completed/);
assert.ok(result.findings.length > 0);
assert.ok(result.analysis.attentionScore.score > 0);

const report = await request(`/api/v1/analyses/${analysis.id}/report`);
assert.equal(report.projectSummary.id, project.id);
const reportFindings = Object.values(report.findingsBySeverity).flat();
assert.ok(reportFindings.length > 0);

const pdfResponse = await fetch(`${baseUrl}/api/v1/analyses/${analysis.id}/report.pdf`, {
  headers: { Authorization: `Bearer ${token}` },
});
assert.equal(pdfResponse.status, 200);
assert.match(pdfResponse.headers.get("content-type") ?? "", /application\/pdf/);
const pdfSignature = Buffer.from(await pdfResponse.arrayBuffer())
  .subarray(0, 4)
  .toString();
assert.equal(pdfSignature, "%PDF");

const reviewedFinding = await request(`/api/v1/findings/${reportFindings[0].id}/status`, {
  method: "PATCH",
  body: JSON.stringify({ status: "under_review" }),
});
assert.equal(reviewedFinding.status, "under_review");

const updatedProject = await request(`/api/v1/projects/${project.id}`, {
  method: "PATCH",
  body: JSON.stringify({ name: "Updated Live Authority Review" }),
});
assert.equal(updatedProject.name, "Updated Live Authority Review");

const auditEvents = await request(`/api/v1/projects/${project.id}/audit-events?pageSize=100`);
assert.ok(auditEvents.some((event) => event.action === "finding.status_change"));

const organization = await request("/api/v1/organizations/current", {
  method: "PATCH",
  body: JSON.stringify({ name: "Updated Root Systems Test Workspace" }),
});
assert.equal(organization.name, "Updated Root Systems Test Workspace");
const members = await request("/api/v1/organizations/current/members");
assert.equal(members.length, 1);

await request(`/api/v1/documents/${document.id}`, { method: "DELETE" });
const remainingDocuments = await request(`/api/v1/projects/${project.id}/documents?pageSize=100`);
assert.equal(remainingDocuments.length, 0);
await request(`/api/v1/projects/${project.id}`, { method: "DELETE" });
const remainingProjects = await request("/api/v1/projects/?pageSize=100");
assert.equal(remainingProjects.length, 0);

console.log(
  JSON.stringify(
    {
      status: "passed",
      projectId: project.id,
      documentStatus: document.extractionStatus,
      analysisState: result.analysis.state,
      findings: result.findings.length,
      attentionScore: result.analysis.attentionScore.score,
      findingStatusTracking: reviewedFinding.status,
      auditEvents: auditEvents.length,
      documentRemoval: "passed",
      pdfReport: "passed",
      workspaceSettings: "passed",
      projectLifecycle: "passed",
    },
    null,
    2,
  ),
);
