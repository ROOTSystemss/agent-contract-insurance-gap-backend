import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyPluginAsync } from "fastify";

const assets = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
  "/floor3.css": { file: "floor3.css", type: "text/css; charset=utf-8" },
  "/favicon.svg": { file: "favicon.svg", type: "image/svg+xml" },
  "/favicon-64.png": { file: "favicon-64.png", type: "image/png" },
  "/apple-touch-icon.png": { file: "apple-touch-icon.png", type: "image/png" },
  "/rs-mark-cream.png": { file: "rs-mark-cream.png", type: "image/png" },
  "/oauth/authorize": { file: "authorize.html", type: "text/html; charset=utf-8" },
  "/authorize.js": { file: "authorize.js", type: "text/javascript; charset=utf-8" },
  // Agent Governance console (Floor 3): one page app plus its self-hosted fonts and logo.
  "/console": { file: "console.html", type: "text/html; charset=utf-8" },
  "/console.js": { file: "console.js", type: "text/javascript; charset=utf-8" },
  "/console.css": { file: "console.css", type: "text/css; charset=utf-8" },
  "/rs-logo.svg": { file: "rs-logo.svg", type: "image/svg+xml" },
  "/fonts/fraunces-normal.woff2": { file: "fonts/fraunces-normal.woff2", type: "font/woff2" },
  "/fonts/fraunces-italic.woff2": { file: "fonts/fraunces-italic.woff2", type: "font/woff2" },
  "/fonts/inter-normal.woff2": { file: "fonts/inter-normal.woff2", type: "font/woff2" },
  "/fonts/jetbrains-mono-normal.woff2": { file: "fonts/jetbrains-mono-normal.woff2", type: "font/woff2" },
} as const;

export const uiRoutes: FastifyPluginAsync = async (app) => {
  const publicDirectory = path.resolve(__dirname, "../../public");

  for (const [route, asset] of Object.entries(assets)) {
    app.get(route, async (_request, reply) => {
      const contents = await readFile(path.join(publicDirectory, asset.file));
      return reply
        .header("Cache-Control", route === "/" || route === "/console" ? "no-cache" : "public, max-age=3600")
        .type(asset.type)
        .send(contents);
    });
  }
};
