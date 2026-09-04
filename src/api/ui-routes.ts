import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyPluginAsync } from "fastify";

const assets = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
  "/favicon.svg": { file: "favicon.svg", type: "image/svg+xml" },
} as const;

export const uiRoutes: FastifyPluginAsync = async (app) => {
  const publicDirectory = path.resolve(process.cwd(), "public");

  for (const [route, asset] of Object.entries(assets)) {
    app.get(route, async (_request, reply) => {
      const contents = await readFile(path.join(publicDirectory, asset.file));
      return reply
        .header("Cache-Control", route === "/" ? "no-cache" : "public, max-age=3600")
        .type(asset.type)
        .send(contents);
    });
  }
};
