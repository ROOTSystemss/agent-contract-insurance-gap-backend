import { randomBytes, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/env.js";
import type { Analysis, DocumentRecord, Finding } from "../src/domain/types.js";
import { EmailVault } from "../src/persistence/email-vault.js";
import { FieldVault } from "../src/persistence/field-vault.js";
import { MemoryStore } from "../src/persistence/memory-store.js";
import { PrismaStore } from "../src/persistence/prisma-store.js";
import { loggableError } from "../src/shared/errors.js";
import { agentInput, openTestDatabase } from "./helpers.js";

const key = randomBytes(32);

describe("FieldVault", () => {
  const vault = new FieldVault(key);

  it("seals strings, optional values and lists and opens them back", () => {
    const sealed = vault.seal("Acme Corp master services agreement");
    expect(sealed.startsWith("enc:v1:")).toBe(true);
    expect(sealed).not.toContain("Acme");
    expect(vault.open(sealed)).toBe("Acme Corp master services agreement");
    expect(vault.open(vault.seal(""))).toBe("");
    expect(vault.sealOptional(null)).toBeNull();
    expect(vault.sealOptional(undefined)).toBeNull();
    expect(vault.openOptional(vault.sealOptional("Initech"))).toBe("Initech");
    const list = vault.sealList(["Acme", "Initech"]);
    expect(list.every((item) => item.startsWith("enc:v1:"))).toBe(true);
    expect(vault.openList(list)).toEqual(["Acme", "Initech"]);
  });

  it("seals Json values into a sealed string and opens them back", () => {
    const value = { name: "Acme agent", tools: ["Acme ERP"], limit: 5000, nested: { ok: true, none: null } };
    const sealed = vault.sealJson(value);
    expect(typeof sealed).toBe("string");
    expect(vault.isSealed(sealed)).toBe(true);
    expect(sealed as string).not.toContain("Acme");
    expect(vault.openJson(sealed)).toEqual(value);
  });

  it("reads legacy plaintext as-is and passes values through without a key", () => {
    const keyless = new FieldVault(null);
    expect(vault.open("legacy name")).toBe("legacy name");
    expect(vault.openJson({ legacy: true })).toEqual({ legacy: true });
    expect(keyless.enabled).toBe(false);
    expect(keyless.seal("dev")).toBe("dev");
    expect(keyless.sealJson({ dev: true })).toEqual({ dev: true });
    expect(() => keyless.open(vault.seal("secret"))).toThrow(/DOCUMENT_ENCRYPTION_KEY/);
  });

  it("rejects tampered values and wrong-sized keys", () => {
    const sealed = vault.seal("Acme");
    expect(() => vault.open(sealed.slice(0, -4) + "AAAA")).toThrow();
    expect(() => new FieldVault(randomBytes(16))).toThrow(/32 bytes/);
  });

  it("shares the key and format with EmailVault", () => {
    const emails = new EmailVault(key);
    expect(vault.open(emails.seal("owner@example.com"))).toBe("owner@example.com");
    expect(emails.openJson(vault.sealJson({ a: 1 }))).toEqual({ a: 1 });
  });
});

describe("customer data protection outside the database", () => {
  it("refuses to load production configuration without the encryption key", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        JWT_SECRET: "production-jwt-value-with-more-than-thirty-two-random-characters",
        PERSISTENCE_DRIVER: "postgres",
        DATABASE_URL: "postgresql://service:password@database:5432/acg",
        ATLAS_OAUTH_CLIENT_SECRET: "production-oauth-value-with-more-than-thirty-two-characters",
        ATLAS_OAUTH_REDIRECT_URIS: "https://readiness.example.com/auth/atlas/callback",
      }),
    ).toThrow(/DOCUMENT_ENCRYPTION_KEY/);
  });

  it("keeps Prisma error messages, which can quote query arguments, out of logs", () => {
    const error = new Error("Invalid `prisma.user.create()` invocation: { name: 'Jane Customer' }");
    error.name = "PrismaClientValidationError";
    expect(JSON.stringify(loggableError(error))).not.toContain("Jane");
    const plain = new Error("boom");
    expect(loggableError(plain)).toBe(plain);
  });

  it("has nothing to upgrade in the memory store", async () => {
    expect(await new MemoryStore().encryptStoredData()).toBe(0);
  });
});

function findingFor(ids: { organizationId: string; analysisId: string; projectId: string; documentId: string }): Finding {
  return {
    id: randomUUID(),
    ...ids,
    title: "Acme agent may spend beyond the Initech contract limit",
    category: "transaction_limit_mismatch",
    severity: "high",
    confidence: 0.8,
    status: "open",
    affectedAgentCapability: "canSpendMoney",
    affectedDocumentId: ids.documentId,
    clauseCategory: "payment_terms",
    documentFact: "Initech MSA caps purchases at USD 1,000.",
    agentProfileFact: "Acme agent may spend USD 5,000 per transaction.",
    systemInference: "Agent authority exceeds the contract cap.",
    reviewRule: "spend-vs-cap",
    factualBasis: "Clause 4.2 of the Initech MSA.",
    analysisExplanation: "The agent limit is higher than the contract allows.",
    evidence: [{ segmentId: randomUUID(), documentId: ids.documentId, pageNumber: 1, excerpt: "Acme Corp shall indemnify Initech", characterStart: 0, characterEnd: 33 }],
    applicableUniversalRule: "universal-spend",
    applicableJurisdictionRule: null,
    uncertainty: "Low.",
    limitations: ["Initech annex not supplied"],
    recommendedReviewQuestions: ["Should Acme lower the agent limit?"],
    suggestedProfessionalReviewer: "legal_counsel",
    disclaimer: "Not legal advice.",
    ruleVersion: "1.0.0",
    createdAt: new Date().toISOString(),
  };
}

const sealedText = (value: string | null | undefined) => expect(value?.startsWith("enc:v1:")).toBe(true);
const sealedJson = (value: unknown) => expect(typeof value === "string" && value.startsWith("enc:v1:")).toBe(true);

// Set ACG_TEST_DATABASE_URL to a disposable local database that has had `prisma migrate deploy` run.
const databaseUrl = process.env.ACG_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("PrismaStore customer field encryption (Postgres)", () => {
  let client: PrismaClient;
  let store: PrismaStore;
  let organizationId: string;
  let userId: string;
  let projectId: string;

  beforeAll(async () => {
    client = await openTestDatabase(databaseUrl!);
    store = new PrismaStore(client, new EmailVault(key));
    await store.reset();
    const registration = await store.createRegistration({
      email: "jane@acme.test",
      name: "Jane Customer",
      passwordHash: "hash",
      organizationName: "Acme Secret Holdings",
    });
    organizationId = registration.organization.id;
    userId = registration.user.id;
    expect(registration.organization.name).toBe("Acme Secret Holdings");
    expect(registration.user.name).toBe("Jane Customer");
  }, 120_000);

  afterAll(async () => {
    await client?.$disconnect();
  });

  it("stores account names and organization names encrypted", async () => {
    const rawUser = await client.user.findUniqueOrThrow({ where: { id: userId } });
    sealedText(rawUser.name);
    const rawOrg = await client.organization.findUniqueOrThrow({ where: { id: organizationId } });
    sealedText(rawOrg.name);
    expect((await store.getOrganization(organizationId))?.name).toBe("Acme Secret Holdings");
    expect((await store.listMembers(organizationId))[0]?.user.name).toBe("Jane Customer");

    await store.updateOrganization(organizationId, "Acme Renamed");
    sealedText((await client.organization.findUniqueOrThrow({ where: { id: organizationId } })).name);
    expect((await store.getOrganization(organizationId))?.name).toBe("Acme Renamed");
  });

  it("stores projects and agent profiles encrypted", async () => {
    const project = await store.createProject(organizationId, {
      name: "Acme procurement review",
      description: "Initech vendor contracts",
      primaryCountryCode: "US",
      primarySubdivisionCode: null,
      affectedCountryCodes: ["CA"],
    });
    projectId = project.id;
    expect(project.name).toBe("Acme procurement review");
    const rawProject = await client.project.findUniqueOrThrow({ where: { id: projectId } });
    sealedText(rawProject.name);
    sealedText(rawProject.description);
    await store.updateProject(organizationId, projectId, { description: "Updated Initech notes" });
    sealedText((await client.project.findUniqueOrThrow({ where: { id: projectId } })).description);
    expect((await store.getProject(organizationId, projectId))).toMatchObject({ name: "Acme procurement review", description: "Updated Initech notes" });
    expect((await store.listProjects(organizationId, { page: 1, pageSize: 10 })).items[0]?.name).toBe("Acme procurement review");

    const agent = await store.createAgent(organizationId, projectId, agentInput({ name: "Acme ProcureBot" }));
    sealedJson((await client.agentProfile.findUniqueOrThrow({ where: { id: agent.id } })).profile);
    expect(await store.getAgent(organizationId, agent.id)).toMatchObject(agentInput({ name: "Acme ProcureBot" }));
    await store.updateAgent(organizationId, agent.id, { notes: "Acme internal note" });
    sealedJson((await client.agentProfile.findUniqueOrThrow({ where: { id: agent.id } })).profile);
    expect((await store.listAgents(organizationId, projectId))[0]?.notes).toBe("Acme internal note");
  });

  it("stores documents, segments, analyses and findings encrypted", async () => {
    const documentId = randomUUID();
    const now = new Date().toISOString();
    const document: DocumentRecord = {
      id: documentId, organizationId, projectId, uploaderId: userId,
      originalFilename: "Initech MSA (confidential).pdf", safeFilename: "Initech_MSA_confidential.pdf",
      mimeType: "application/pdf", size: 1234, checksum: "a".repeat(64), documentType: "master_services_agreement",
      countryCode: "US", subdivisionCode: null, storageKey: `${organizationId}/${projectId}/${documentId}.pdf`,
      extractionStatus: "completed_with_warnings", extractionError: "Initech page 3 unreadable",
      extractionWarnings: ["Initech page 3 is scanned"], pageCount: 3,
      extractedText: "Acme Corp shall indemnify Initech for agent actions.",
      segments: [{
        id: randomUUID(), organizationId, documentId, pageNumber: 1, sectionHeading: "Initech indemnity", paragraphNumber: 1,
        characterStart: 0, characterEnd: 33, normalizedText: "acme corp shall indemnify initech", originalText: "Acme Corp shall indemnify Initech", extractionConfidence: 1,
      }],
      retentionStatus: "active", deleteAfter: null, deletedAt: null, createdAt: now, updatedAt: now,
    };
    const created = await store.createDocument(document);
    expect(created).toMatchObject({ originalFilename: document.originalFilename, extractedText: document.extractedText, extractionWarnings: document.extractionWarnings });
    const rawDocument = await client.document.findUniqueOrThrow({ where: { id: documentId }, include: { segments: true } });
    for (const value of [rawDocument.originalFilename, rawDocument.safeFilename, rawDocument.extractedText, rawDocument.extractionError, ...rawDocument.extractionWarnings]) sealedText(value);
    for (const value of [rawDocument.segments[0]?.sectionHeading, rawDocument.segments[0]?.normalizedText, rawDocument.segments[0]?.originalText]) sealedText(value);
    expect(rawDocument.checksum).toBe("a".repeat(64));
    const read = await store.getDocument(organizationId, documentId);
    expect(read?.segments[0]).toMatchObject({ sectionHeading: "Initech indemnity", originalText: "Acme Corp shall indemnify Initech" });
    expect((await store.listDocuments(organizationId, projectId, { page: 1, pageSize: 10 })).items[0]?.extractionError).toBe("Initech page 3 unreadable");

    const agent = (await store.listAgents(organizationId, projectId))[0]!;
    const analysis: Analysis = {
      id: randomUUID(), organizationId, projectId, agentProfileId: agent.id, documentIds: [documentId],
      state: "completed", engineVersion: "gap-engine@1.0.0", rulesetVersions: ["universal@1"], jurisdictionPackIds: ["global"],
      attentionScore: { score: 70, label: "high_attention", confidence: 0.8, contributions: [{ dimension: "spend", points: 10, maximum: 20, explanation: "Acme agent can spend USD 5,000" }] },
      warnings: ["Initech page 3 is scanned"], failureReason: "Initech annex missing",
      createdAt: now, updatedAt: now, completedAt: now,
    };
    await store.createAnalysis(analysis);
    const rawAnalysis = await client.analysis.findUniqueOrThrow({ where: { id: analysis.id } });
    sealedJson(rawAnalysis.attentionScore);
    sealedText(rawAnalysis.warnings[0]);
    sealedText(rawAnalysis.failureReason);
    expect(await store.getAnalysis(organizationId, analysis.id)).toMatchObject({ attentionScore: analysis.attentionScore, warnings: analysis.warnings, failureReason: analysis.failureReason });
    await store.updateAnalysis({ ...analysis, failureReason: null, warnings: ["Updated Initech warning"] });
    sealedText((await client.analysis.findUniqueOrThrow({ where: { id: analysis.id } })).warnings[0]);
    expect((await store.listAnalyses(organizationId, projectId, { page: 1, pageSize: 10 })).items[0]?.warnings).toEqual(["Updated Initech warning"]);

    const finding = findingFor({ organizationId, analysisId: analysis.id, projectId, documentId });
    await store.replaceFindings(organizationId, analysis.id, [finding]);
    const rawFinding = await client.finding.findUniqueOrThrow({ where: { id: finding.id } });
    sealedJson(rawFinding.payload);
    expect(rawFinding.severity).toBe("high");
    expect(await store.getFinding(organizationId, finding.id)).toEqual(finding);
    await store.updateFindingStatus(organizationId, finding.id, "accepted");
    sealedJson((await client.finding.findUniqueOrThrow({ where: { id: finding.id } })).payload);
    expect((await store.listFindings(organizationId, analysis.id, { page: 1, pageSize: 10 })).items[0]).toEqual({ ...finding, status: "accepted" });

    await store.deleteDocument(organizationId, documentId);
    sealedText((await client.document.findUniqueOrThrow({ where: { id: documentId } })).extractedText);
  });

  it("stores audit metadata encrypted and still filters and pages audit events by project", async () => {
    const otherProject = await store.createProject(organizationId, { name: "Other", description: null, primaryCountryCode: "US", primarySubdivisionCode: null, affectedCountryCodes: [] });
    const base = Date.now();
    const event = (resourceType: string, resourceId: string, metadata: Record<string, string>, offset: number) =>
      store.addAuditEvent({
        id: randomUUID(), organizationId, actorId: userId, resourceType, resourceId, action: `${resourceType}.test`,
        requestId: "req-1", metadata, createdAt: new Date(base + offset).toISOString(),
      });
    await event("project", projectId, { projectId }, 1000);
    await event("document", randomUUID(), { projectId, filename: "Initech MSA.pdf" }, 2000);
    await event("document", randomUUID(), { projectId: otherProject.id }, 3000);
    await event("organization", organizationId, { redirectUriHost: "acme.test" }, 4000);

    const raw = await client.auditEvent.findMany({ where: { organizationId } });
    for (const row of raw) sealedJson(row.metadata);
    expect(raw.filter((row) => row.projectId === projectId)).toHaveLength(2);

    const first = await store.listAuditEvents(organizationId, projectId, { page: 1, pageSize: 1 });
    const second = await store.listAuditEvents(organizationId, projectId, { page: 2, pageSize: 1 });
    expect(first.total).toBe(2);
    expect(first.items[0]?.metadata).toEqual({ projectId, filename: "Initech MSA.pdf" });
    expect(second.items[0]?.metadata).toEqual({ projectId });
    expect(second.items[0]).not.toHaveProperty("projectId");
  });

  it("stores console service link emails and certificates encrypted", async () => {
    await store.saveServiceLink({
      organizationId, atlasEmail: "atlas-acme@console.test", atlasSecret: "plain:a",
      trustProofEmail: "trustproof-acme@console.test", trustProofSecret: "plain:b", trustProofApiKey: "plain:c",
    });
    const rawLink = await client.serviceLink.findUniqueOrThrow({ where: { organizationId } });
    sealedText(rawLink.atlasEmail);
    sealedText(rawLink.trustProofEmail);
    expect(await store.getServiceLink(organizationId)).toMatchObject({ atlasEmail: "atlas-acme@console.test", trustProofEmail: "trustproof-acme@console.test" });

    const jti = randomUUID();
    await store.addConsoleCertificate({ jti, organizationId, agentId: "agent-1", certificate: "header.acme-claims.sig", pqSignature: { alg: "ML-DSA-65", value: "abc" } });
    const rawCertificate = await client.consoleCertificate.findUniqueOrThrow({ where: { jti } });
    sealedText(rawCertificate.certificate);
    sealedJson(rawCertificate.pqSignature);
    expect(await store.getConsoleCertificate(organizationId, jti)).toMatchObject({ certificate: "header.acme-claims.sig", pqSignature: { alg: "ML-DSA-65", value: "abc" } });
  });

  it("reads legacy plaintext rows and seals them once at startup", async () => {
    const legacyOrg = await client.organization.create({ data: { name: "Legacy Org" } });
    const keyless = new PrismaStore(client);
    expect(await keyless.encryptStoredData()).toBe(0);
    const devProject = await keyless.createProject(legacyOrg.id, { name: "Dev project", description: null, primaryCountryCode: "US", primarySubdivisionCode: null, affectedCountryCodes: [] });
    expect((await client.project.findUniqueOrThrow({ where: { id: devProject.id } })).name).toBe("Dev project");

    const project = await client.project.create({
      data: { organizationId: legacyOrg.id, name: "Legacy project", description: "Legacy notes", primaryCountryCode: "US", affectedCountryCodes: [] },
    });
    const agent = await client.agentProfile.create({ data: { organizationId: legacyOrg.id, projectId: project.id, profile: agentInput({ name: "Legacy bot" }) as unknown as Prisma.InputJsonValue } });
    const document = await client.document.create({
      data: {
        organizationId: legacyOrg.id, projectId: project.id, uploaderId: userId, originalFilename: "legacy.pdf", safeFilename: "legacy.pdf",
        mimeType: "application/pdf", size: 1, checksum: "b".repeat(64), documentType: "commercial_contract", countryCode: "US",
        storageKey: "x/y/z.pdf", extractionStatus: "completed", extractionError: null, extractionWarnings: ["legacy warning"], extractedText: "Legacy text",
        segments: { create: [{ organizationId: legacyOrg.id, sectionHeading: null, paragraphNumber: 1, characterStart: 0, characterEnd: 11, normalizedText: "legacy text", originalText: "Legacy text", extractionConfidence: 1 }] },
      },
    });
    const analysis = await client.analysis.create({
      data: {
        organizationId: legacyOrg.id, projectId: project.id, agentProfileId: agent.id, state: "completed", engineVersion: "gap-engine@1.0.0",
        rulesetVersions: [], jurisdictionPackIds: [], attentionScore: { score: 10, label: "low_attention", confidence: 1, contributions: [] },
        warnings: ["legacy analysis warning"], failureReason: "legacy failure",
      },
    });
    const finding = findingFor({ organizationId: legacyOrg.id, analysisId: analysis.id, projectId: project.id, documentId: document.id });
    await client.finding.create({
      data: {
        id: finding.id, organizationId: legacyOrg.id, analysisId: analysis.id, projectId: project.id, documentId: document.id,
        category: finding.category, severity: finding.severity, confidence: finding.confidence, stableKey: finding.id, payload: finding as unknown as Prisma.InputJsonValue,
      },
    });
    const audit = await client.auditEvent.create({
      data: { organizationId: legacyOrg.id, actorId: userId, resourceType: "document", resourceId: document.id, action: "document.upload", requestId: "r", metadata: { projectId: project.id } },
    });
    await client.serviceLink.create({
      data: { organizationId: legacyOrg.id, atlasEmail: "atlas-legacy@console.test", atlasSecret: "plain:a", trustProofEmail: "tp-legacy@console.test", trustProofSecret: "plain:b", trustProofApiKey: "plain:c" },
    });
    await client.consoleCertificate.create({ data: { jti: "legacy-jti-1", organizationId: legacyOrg.id, agentId: "a", certificate: "legacy.cert.one", pqSignature: { alg: "ML-DSA-65" } } });
    await client.consoleCertificate.create({ data: { jti: "legacy-jti-2", organizationId: legacyOrg.id, agentId: "a", certificate: "legacy.cert.two" } });

    expect((await store.getProject(legacyOrg.id, project.id))?.name).toBe("Legacy project");
    expect((await store.getAgent(legacyOrg.id, agent.id))?.name).toBe("Legacy bot");
    expect((await store.getFinding(legacyOrg.id, finding.id))?.title).toBe(finding.title);

    const projectBefore = await client.project.findUniqueOrThrow({ where: { id: project.id } });
    // organization, two projects, agent, document, segment, analysis, finding, audit event, service link, two certificates
    expect(await store.encryptStoredData()).toBe(12);
    expect(await store.encryptStoredData()).toBe(0);

    const projectAfter = await client.project.findUniqueOrThrow({ where: { id: project.id } });
    sealedText(projectAfter.name);
    sealedText(projectAfter.description);
    expect(projectAfter.updatedAt).toEqual(projectBefore.updatedAt);
    sealedText((await client.organization.findUniqueOrThrow({ where: { id: legacyOrg.id } })).name);
    sealedText((await client.project.findUniqueOrThrow({ where: { id: devProject.id } })).name);
    sealedJson((await client.agentProfile.findUniqueOrThrow({ where: { id: agent.id } })).profile);
    const rawDocument = await client.document.findUniqueOrThrow({ where: { id: document.id }, include: { segments: true } });
    for (const value of [rawDocument.originalFilename, rawDocument.safeFilename, rawDocument.extractedText, ...rawDocument.extractionWarnings]) sealedText(value);
    expect(rawDocument.extractionError).toBeNull();
    sealedText(rawDocument.segments[0]?.originalText);
    expect(rawDocument.segments[0]?.sectionHeading).toBeNull();
    const rawAnalysis = await client.analysis.findUniqueOrThrow({ where: { id: analysis.id } });
    sealedJson(rawAnalysis.attentionScore);
    sealedText(rawAnalysis.failureReason);
    sealedJson((await client.finding.findUniqueOrThrow({ where: { id: finding.id } })).payload);
    const rawAudit = await client.auditEvent.findUniqueOrThrow({ where: { id: audit.id } });
    sealedJson(rawAudit.metadata);
    expect(rawAudit.projectId).toBe(project.id);
    sealedText((await client.serviceLink.findUniqueOrThrow({ where: { organizationId: legacyOrg.id } })).trustProofEmail);
    const rawCertificates = await client.consoleCertificate.findMany({ where: { organizationId: legacyOrg.id }, orderBy: { jti: "asc" } });
    sealedText(rawCertificates[0]?.certificate);
    sealedJson(rawCertificates[0]?.pqSignature);
    sealedText(rawCertificates[1]?.certificate);
    expect(rawCertificates[1]?.pqSignature).toBeNull();

    expect(await store.getOrganization(legacyOrg.id)).toMatchObject({ name: "Legacy Org" });
    expect(await store.getProject(legacyOrg.id, project.id)).toMatchObject({ name: "Legacy project", description: "Legacy notes" });
    expect((await store.getAgent(legacyOrg.id, agent.id))?.name).toBe("Legacy bot");
    expect(await store.getDocument(legacyOrg.id, document.id)).toMatchObject({ extractedText: "Legacy text", extractionWarnings: ["legacy warning"] });
    expect(await store.getAnalysis(legacyOrg.id, analysis.id)).toMatchObject({ failureReason: "legacy failure", warnings: ["legacy analysis warning"] });
    expect(await store.getFinding(legacyOrg.id, finding.id)).toEqual(finding);
    const events = await store.listAuditEvents(legacyOrg.id, project.id, { page: 1, pageSize: 10 });
    expect(events.items.map((item) => item.metadata)).toEqual([{ projectId: project.id }]);
    expect((await store.getServiceLink(legacyOrg.id))?.atlasEmail).toBe("atlas-legacy@console.test");
    expect((await store.getConsoleCertificate(legacyOrg.id, "legacy-jti-1"))?.pqSignature).toEqual({ alg: "ML-DSA-65" });
    await expect(keyless.getProject(legacyOrg.id, project.id)).rejects.toThrow(/DOCUMENT_ENCRYPTION_KEY/);
  });
});
