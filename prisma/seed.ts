import { readFile } from "node:fs/promises";
import path from "node:path";
import bcrypt from "bcryptjs";
import { loadConfig } from "../src/config/env.js";
import { DEMO_EMAIL, DEMO_PASSWORD, procurementAgent } from "../src/demo/data.js";
import { DocumentService } from "../src/documents/document-service.js";
import { LocalDocumentStorage } from "../src/documents/storage.js";
import { EmailVault } from "../src/persistence/email-vault.js";
import { PrismaStore } from "../src/persistence/prisma-store.js";

async function main(): Promise<void> {
  const config = loadConfig({ ...process.env, PERSISTENCE_DRIVER: "postgres" });
  const key = config.DOCUMENT_ENCRYPTION_KEY ? Buffer.from(config.DOCUMENT_ENCRYPTION_KEY, "base64") : null;
  const store = new PrismaStore(undefined, new EmailVault(key));
  try {
    let user = await store.findUserByEmail(DEMO_EMAIL);
    let membership = user ? await store.getMembership(user.id) : null;
    if (!user || !membership) {
      const registration = await store.createRegistration({
        email: DEMO_EMAIL,
        name: "Demo Analyst",
        passwordHash: await bcrypt.hash(process.env.DEMO_PASSWORD || DEMO_PASSWORD, 12),
        organizationName: "Fictional Acme Procurement Ltd",
      });
      user = registration.user;
      membership = registration.membership;
    }
    const projects = await store.listProjects(membership.organizationId, { page: 1, pageSize: 1000 });
    const existing = projects.items.find((project) => project.name === "Fictional Procurement Agent Review");
    if (existing) {
      process.stdout.write(`Demo project already exists: ${existing.id}\n`);
      return;
    }
    const project = await store.createProject(membership.organizationId, {
      name: "Fictional Procurement Agent Review",
      description: "Safe fictional data for deterministic demonstration scenarios.",
      primaryCountryCode: "US",
      primarySubdivisionCode: "US-IL",
      affectedCountryCodes: ["CA"],
    });
    await store.createAgent(membership.organizationId, project.id, procurementAgent());
    const service = new DocumentService(
      store,
      new LocalDocumentStorage(path.resolve(config.UPLOAD_DIRECTORY)),
      config,
    );
    for (const [filename, documentType] of [
      ["contract-no-agent-language.txt", "commercial_contract"],
      ["contract-human-approval.txt", "commercial_contract"],
      ["insurance-ambiguous.txt", "insurance_policy"],
    ] as const) {
      await service.upload({
        organizationId: membership.organizationId,
        projectId: project.id,
        uploaderId: user.id,
        filename,
        mimeType: "text/plain",
        buffer: await readFile(path.resolve("demo/fixtures", filename)),
        documentType,
        countryCode: "US",
        subdivisionCode: "US-IL",
      });
    }
    process.stdout.write(`Seeded demo login ${DEMO_EMAIL} and project ${project.id}.\n`);
  } finally {
    await store.disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : "Seed failed"}\n`);
  process.exit(1);
});
