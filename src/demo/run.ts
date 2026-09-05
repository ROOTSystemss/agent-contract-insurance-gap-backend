import { readFile } from "node:fs/promises";
import path from "node:path";
import { AnalysisService } from "../analysis/analysis-service.js";
import { loadConfig } from "../config/env.js";
import { DocumentService } from "../documents/document-service.js";
import { MemoryDocumentStorage } from "../documents/storage.js";
import { MemoryStore } from "../persistence/memory-store.js";
import { ReportService } from "../reports/report-service.js";
import { procurementAgent } from "./data.js";

async function main(): Promise<void> {
  const store = new MemoryStore();
  const config = loadConfig({
    NODE_ENV: "test",
    JWT_SECRET: "demo-secret-that-is-long-enough-for-tests",
    UPLOAD_DIRECTORY: "./uploads/demo",
    LOG_LEVEL: "silent",
  });
  const registration = await store.createRegistration({
    email: "demo@example.test",
    name: "Demo Analyst",
    passwordHash: "not-used-by-this-script",
    organizationName: "Fictional Acme Procurement Ltd",
  });
  const project = await store.createProject(registration.organization.id, {
    name: "Fictional Procurement Agent Review",
    description: "Deterministic demonstration",
    primaryCountryCode: "US",
    primarySubdivisionCode: "US-IL",
    affectedCountryCodes: ["CA"],
  });
  const agent = await store.createAgent(
    registration.organization.id,
    project.id,
    procurementAgent(),
  );
  const documents = new DocumentService(store, new MemoryDocumentStorage(), config);
  const fixture = await readFile(path.resolve("demo/fixtures/contract-human-approval.txt"));
  const document = await documents.upload({
    organizationId: registration.organization.id,
    projectId: project.id,
    uploaderId: registration.user.id,
    filename: "contract-human-approval.txt",
    mimeType: "text/plain",
    buffer: fixture,
    documentType: "commercial_contract",
    countryCode: "US",
    subdivisionCode: "US-IL",
  });
  const analyses = new AnalysisService(store);
  const analysis = await analyses.create({
    organizationId: registration.organization.id,
    projectId: project.id,
    agentProfileId: agent.id,
    documentIds: [document.id],
  });
  await analyses.run(registration.organization.id, analysis.id);
  const report = await new ReportService(store).generate(registration.organization.id, analysis.id);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : "Demo failed"}\n`);
  process.exitCode = 1;
});
