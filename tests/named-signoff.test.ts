import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Named Sign-off is wired, not "coming soon": the Contract & Insurance Gap analysis hands its decision
// to the console's Approvals (named owners sign with their own keys), and Approvals opens the request
// with that decision filled in. The handoff stays in this tab (sessionStorage) on the same origin.
describe("Named Sign-off handoff", () => {
  const pub = path.join(__dirname, "..", "public");

  it("the analysis offers to ask a named owner to sign, and no longer says coming soon", async () => {
    const app = await readFile(path.join(pub, "app.js"), "utf8");
    expect(app).not.toMatch(/Coming soon/);
    expect(app).toContain("data-request-signoff");
    expect(app).toMatch(/sessionStorage\.setItem\("rsSignoffDraft"/);
    expect(app).toContain('window.location.href = "/console#/approvals"');
  });

  it("Approvals opens the request with the decision filled in, once", async () => {
    const consoleJs = await readFile(path.join(pub, "console.js"), "utf8");
    expect(consoleJs).toMatch(/function openRequestDrawer\(data, after, prefill\)/);
    expect(consoleJs).toMatch(/sessionStorage\.getItem\("rsSignoffDraft"\)/);
    expect(consoleJs).toMatch(/sessionStorage\.removeItem\("rsSignoffDraft"\)/);
  });

  it("the draft fits the approval request's limits", async () => {
    const app = await readFile(path.join(pub, "app.js"), "utf8");
    // title and reference are cut to 200 characters, as POST /api/v1/console/approvals requires.
    expect((app.match(/\.slice\(0, 200\)/g) || []).length).toBeGreaterThanOrEqual(2);
  });
});
