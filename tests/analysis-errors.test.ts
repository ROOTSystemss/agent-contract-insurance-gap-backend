import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import PDFDocument from "pdfkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import type { Analysis, DocumentRecord } from "../src/domain/types.js";
import { EmailVault } from "../src/persistence/email-vault.js";
import { MemoryStore } from "../src/persistence/memory-store.js";
import { PrismaStore } from "../src/persistence/prisma-store.js";
import type { Store } from "../src/persistence/store.js";
import { agentInput, openTestDatabase } from "./helpers.js";

// QA 2026-11-14 H1: an analysis must never say plain "completed" when a selected document's text was
// not read (extraction failed, scanned PDF) or the document was deleted before or during the run.

const HEALTHY_TEXT =
  "Approval Requirements\n\nSoftware tools may prepare purchase orders. Human approval is required before any commitment above USD 1,000. Confidential information must be protected and audit log records retained.";
// Starts with the PDF signature, so the upload is accepted, but is not a PDF: extraction fails.
const BROKEN_PDF = Buffer.from("%PDF-1.7\nthis file only pretends to be a PDF; there is no cross-reference table and no objects\n%%EOF\n");

function emptyPdf(): Promise<Buffer> {
  return new Promise((resolve) => {
    const document = new PDFDocument({ autoFirstPage: true });
    const chunks: Buffer[] = [];
    document.on("data", (chunk: Buffer) => chunks.push(chunk));
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.end();
  });
}

// Deletes one chosen document the moment the run starts (state "running"): a deletion mid-run.
class DeletingStore extends MemoryStore {
  deleteDuringRun: { organizationId: string; documentId: string } | null = null;
  override async updateAnalysis(analysis: Analysis): Promise<Analysis | null> {
    const result = await super.updateAnalysis(analysis);
    if (analysis.state === "running" && this.deleteDuringRun) {
      const { organizationId, documentId } = this.deleteDuringRun;
      this.deleteDuringRun = null;
      await this.deleteDocument(organizationId, documentId);
    }
    return result;
  }
}

async function setup(store: Store) {
  const dir = await mkdtemp(path.join(tmpdir(), "gap-analysis-errors-"));
  const app = await buildApp({
    config: loadConfig({ NODE_ENV: "test", JWT_SECRET: "test-secret-with-at-least-thirty-two-characters", UPLOAD_DIRECTORY: dir, LOG_LEVEL: "silent", PERSISTENCE_DRIVER: "memory" }),
    store, logger: false, certificateVerifier: null, pqSigner: null,
  });
  await app.ready();
  const call = (method: "GET" | "POST" | "DELETE", url: string, token: string, payload?: object) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });
  const data = <T>(r: { body: string }) => (JSON.parse(r.body) as { data: T }).data;
  const registration = data<{ accessToken: string; user: { id: string }; organization: { id: string } }>(
    await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { email: `errors-${Date.now()}-${Math.random()}@example.test`, name: "Errors Tester", organizationName: "Fictional Errors Ltd", password: "Correct Horse Battery 123!" } }),
  );
  const token = registration.accessToken;
  const projectId = data<{ id: string }>(await call("POST", "/api/v1/projects", token, { name: "Errors Project", description: "Fictional", primaryCountryCode: "US", primarySubdivisionCode: "US-IL", affectedCountryCodes: ["CA"] })).id;
  const agentId = data<{ id: string }>(await call("POST", `/api/v1/projects/${projectId}/agents`, token, agentInput({ canEnterContracts: true }))).id;
  const upload = (filename: string, buffer: Buffer, mimeType: string): Promise<DocumentRecord> =>
    app.documentService.upload({ organizationId: registration.organization.id, projectId, uploaderId: registration.user.id, filename, mimeType, buffer, documentType: "commercial_contract", countryCode: "US", subdivisionCode: "US-IL" });
  const analyze = async (documentIds: string[], verb: "run" | "rerun" = "run", existing?: string) => {
    const id = existing ?? data<Analysis>(await call("POST", `/api/v1/projects/${projectId}/analyses`, token, { agentProfileId: agentId, documentIds })).id;
    const response = await call("POST", `/api/v1/analyses/${id}/${verb}`, token);
    expect(response.statusCode).toBe(200);
    return data<{ analysis: Analysis }>(response).analysis;
  };
  return { app, dir, call, data, token, organizationId: registration.organization.id, projectId, agentId, upload, analyze };
}

describe("analyses with unreadable or deleted documents (QA 2026-11-14 H1)", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let store: DeletingStore;
  beforeAll(async () => {
    store = new DeletingStore();
    ctx = await setup(store);
  });
  afterAll(async () => {
    await ctx.app.close();
    await rm(ctx.dir, { recursive: true, force: true });
  });

  it("a document whose extraction failed: completed_with_errors, named in errors, excluded from review", async () => {
    const healthy = await ctx.upload("healthy-contract.txt", Buffer.from(HEALTHY_TEXT), "text/plain");
    const broken = await ctx.upload("broken-scan.pdf", BROKEN_PDF, "application/pdf");
    expect(broken.extractionStatus).toBe("failed");
    const analysis = await ctx.analyze([healthy.id, broken.id]);
    expect(analysis.state).toBe("completed_with_errors");
    expect(analysis.errors).toHaveLength(1);
    expect(analysis.errors[0]).toContain('"broken-scan.pdf" could not be read (text extraction failed');
    expect(analysis.errors[0]).toContain("was not reviewed");

    const report = ctx.data<{ analysisState: string; analysisErrors: string[]; selectedDocumentCount: number; analyzedDocuments: Array<{ id: string }>; executiveSummary: string; evidenceReferences: Array<{ documentId: string }> }>(
      await ctx.call("GET", `/api/v1/analyses/${analysis.id}/report`, ctx.token),
    );
    expect(report.analysisState).toBe("completed_with_errors");
    expect(report.analysisErrors).toEqual(analysis.errors);
    expect(report.selectedDocumentCount).toBe(2);
    expect(report.analyzedDocuments.map((d) => d.id)).toEqual([healthy.id]);
    expect(report.executiveSummary).toMatch(/^Completed with errors: 1 of the 2 selected documents were not reviewed/);
    expect(report.evidenceReferences.every((e) => e.documentId !== broken.id)).toBe(true);

    const pdf = await ctx.call("GET", `/api/v1/analyses/${analysis.id}/report.pdf`, ctx.token);
    expect(pdf.statusCode).toBe(200);
    const parser = new PDFParse({ data: pdf.rawPayload });
    const parsed = await parser.getText();
    await parser.destroy();
    const text = parsed.text.replace(/\s+/g, " ");
    expect(text.replace(/\s+/g, "")).toContain("COMPLETEDWITHERRORS"); // letter-spaced heading
    expect(text).toContain("1 of 2 selected documents were not reviewed");
    // Every page has content and the footer counts the real pages (no blank footer-only pages).
    expect(text).toContain(`Page ${parsed.total} of ${parsed.total}`);
    expect(text).not.toContain(`Page ${parsed.total + 1}`);
    expect(parsed.pages.every((page) => page.text.replace(/Agent Contract Gap\s*•\s*Page \d+ of \d+/g, "").trim().length > 0)).toBe(true);
    expect(text).toContain("broken-scan.pdf");
    expect(text).toContain("Documents reviewed: 1 of 2 selected");

    // A signed Assurance Pack is refused: it would present a partial review as complete.
    const pack = await ctx.call("POST", `/api/v1/analyses/${analysis.id}/assurance-pack`, ctx.token, {});
    expect(pack.statusCode).toBe(409);
    const body = JSON.parse(pack.body) as { error: { code: string; details: Array<{ message: string }> } };
    expect(body.error.code).toBe("ANALYSIS_HAS_ERRORS");
    expect(body.error.details[0]!.message).toContain("broken-scan.pdf");

    // A rerun recomputes the errors instead of piling them up.
    const rerun = await ctx.analyze([], "rerun", analysis.id);
    expect(rerun.state).toBe("completed_with_errors");
    expect(rerun.errors).toEqual(analysis.errors);
  });

  it("a scanned PDF with no text (OCR required): completed_with_errors", async () => {
    const scanned = await ctx.upload("scanned-policy.pdf", await emptyPdf(), "application/pdf");
    expect(scanned.extractionStatus).toBe("ocr_required");
    const analysis = await ctx.analyze([scanned.id]);
    expect(analysis.state).toBe("completed_with_errors");
    expect(analysis.errors[0]).toContain('"scanned-policy.pdf" has no readable text');
  });

  it("a document deleted after the analysis was created but before it ran: completed_with_errors", async () => {
    const keep = await ctx.upload("keep.txt", Buffer.from(HEALTHY_TEXT), "text/plain");
    const gone = await ctx.upload("gone.txt", Buffer.from(HEALTHY_TEXT + " Extra."), "text/plain");
    const created = ctx.data<Analysis>(await ctx.call("POST", `/api/v1/projects/${ctx.projectId}/analyses`, ctx.token, { agentProfileId: ctx.agentId, documentIds: [keep.id, gone.id] }));
    expect((await ctx.call("DELETE", `/api/v1/documents/${gone.id}`, ctx.token)).statusCode).toBe(204);
    const analysis = await ctx.analyze([], "run", created.id);
    expect(analysis.state).toBe("completed_with_errors");
    expect(analysis.errors).toEqual([`A selected document (id ${gone.id}) was deleted before the analysis ran, so it was not reviewed.`]);
    const report = ctx.data<{ analysisErrors: string[]; analyzedDocuments: Array<{ id: string }>; limitations: string[] }>(await ctx.call("GET", `/api/v1/analyses/${analysis.id}/report`, ctx.token));
    expect(report.analysisErrors).toEqual(analysis.errors);
    expect(report.analyzedDocuments.map((d) => d.id)).toEqual([keep.id]);
    expect(report.limitations.some((l) => l.includes(gone.id))).toBe(false);
  });

  it("a document deleted while the analysis is running: completed_with_errors", async () => {
    const stays = await ctx.upload("stays.txt", Buffer.from(HEALTHY_TEXT), "text/plain");
    const vanishes = await ctx.upload("vanishes.txt", Buffer.from(HEALTHY_TEXT + " More."), "text/plain");
    store.deleteDuringRun = { organizationId: ctx.organizationId, documentId: vanishes.id };
    const analysis = await ctx.analyze([stays.id, vanishes.id]);
    expect(store.deleteDuringRun).toBeNull();
    expect(analysis.state).toBe("completed_with_errors");
    expect(analysis.errors).toEqual([`"vanishes.txt" (id ${vanishes.id}) was deleted while the analysis was running. Findings that cite it can no longer be traced to the document.`]);
    const report = ctx.data<{ analysisErrors: string[]; limitations: string[] }>(await ctx.call("GET", `/api/v1/analyses/${analysis.id}/report`, ctx.token));
    expect(report.analysisErrors).toEqual(analysis.errors);
    expect(report.limitations.some((l) => l.includes(vanishes.id))).toBe(false);
  });

  it("a document deleted after a clean run is named in the report's limitations, not silently dropped", async () => {
    const one = await ctx.upload("one.txt", Buffer.from(HEALTHY_TEXT), "text/plain");
    const two = await ctx.upload("two.txt", Buffer.from(HEALTHY_TEXT + " Two."), "text/plain");
    const analysis = await ctx.analyze([one.id, two.id]);
    expect(analysis.state).not.toBe("completed_with_errors");
    await ctx.call("DELETE", `/api/v1/documents/${two.id}`, ctx.token);
    const report = ctx.data<{ analysisState: string; limitations: string[] }>(await ctx.call("GET", `/api/v1/analyses/${analysis.id}/report`, ctx.token));
    expect(report.analysisState).toBe(analysis.state);
    expect(report.limitations.some((l) => l.includes(two.id) && l.includes("has since been deleted"))).toBe(true);
  });

  it("only readable documents: never completed_with_errors, no errors, and the pack is built", async () => {
    const good = await ctx.upload("good.txt", Buffer.from(HEALTHY_TEXT), "text/plain");
    const analysis = await ctx.analyze([good.id]);
    expect(["completed", "completed_with_warnings"]).toContain(analysis.state);
    expect(analysis.errors).toEqual([]);
    const report = ctx.data<{ analysisErrors: string[]; executiveSummary: string }>(await ctx.call("GET", `/api/v1/analyses/${analysis.id}/report`, ctx.token));
    expect(report.analysisErrors).toEqual([]);
    expect(report.executiveSummary.startsWith("Completed with errors")).toBe(false);
    expect((await ctx.call("POST", `/api/v1/analyses/${analysis.id}/assurance-pack`, ctx.token, {})).statusCode).toBe(200);
  });
});

// The same run against real Postgres: the new enum value and the encrypted errors column.
describe.runIf(Boolean(process.env.ACG_TEST_DATABASE_URL))("analyses with errors on Postgres", () => {
  it("stores completed_with_errors and the errors (encrypted) and reads them back", async () => {
    const client = await openTestDatabase(process.env.ACG_TEST_DATABASE_URL!);
    const store = new PrismaStore(client, new EmailVault(Buffer.alloc(32, 9)));
    const ctx = await setup(store);
    try {
      const healthy = await ctx.upload("pg-healthy.txt", Buffer.from(HEALTHY_TEXT), "text/plain");
      const broken = await ctx.upload("pg-broken.pdf", BROKEN_PDF, "application/pdf");
      const analysis = await ctx.analyze([healthy.id, broken.id]);
      expect(analysis.state).toBe("completed_with_errors");
      expect(analysis.errors[0]).toContain("pg-broken.pdf");
      const raw = await client.analysis.findUniqueOrThrow({ where: { id: analysis.id } });
      expect(raw.state).toBe("completed_with_errors");
      expect(raw.errors).toHaveLength(1);
      expect(raw.errors[0]).not.toContain("pg-broken.pdf");
      expect((await store.getAnalysis(ctx.organizationId, analysis.id))?.errors).toEqual(analysis.errors);
    } finally {
      await ctx.app.close();
      await rm(ctx.dir, { recursive: true, force: true });
      await client.$disconnect();
    }
  });
});
