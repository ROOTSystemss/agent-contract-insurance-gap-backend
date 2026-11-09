import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { uiRoutes } from "../src/api/ui-routes";
import { SOCIAL_LINKS } from "../src/api/social-links";

// Task G 2026-11-08: every page footer shows the RootSystems X and Instagram profiles as icon links, from one list.
describe("footer social links", () => {
  it.each(["/", "/console", "/oauth/authorize"])("%s has both profile links in its footer, opening in a new tab", async (url) => {
    const app = Fastify();
    await app.register(uiRoutes);
    const res = await app.inject({ method: "GET", url });
    await app.close();
    expect(res.statusCode).toBe(200);
    const footer = res.body.slice(res.body.lastIndexOf("<footer"));
    expect(SOCIAL_LINKS.map((l) => l.url)).toEqual(["https://x.com/TheROOTsystems", "https://www.instagram.com/therootsystemms/"]);
    for (const l of SOCIAL_LINKS) expect(footer).toContain(`href="${l.url}" target="_blank" rel="noopener"`);
    expect(res.body).not.toContain("<!--social-links-->");
  });
});
