import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { buildApp } from "./app.js";
import { loadConfig } from "./config/env.js";
import { loggableError } from "./shared/errors.js";

async function main(): Promise<void> {
  if (existsSync(".env")) loadEnvFile(".env");
  const config = loadConfig();
  const app = await buildApp({ config });
  try {
    const upgraded = await app.store.encryptStoredData();
    if (upgraded > 0) app.log.info({ upgraded }, "encrypted stored customer data");
  } catch (error) {
    app.log.error({ err: loggableError(error) }, "stored customer data encryption failed");
  }
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  await app.listen({ host: config.HOST, port: config.PORT });
  // QA 2026-11-18 F21: Trust Proof now accepts a certificate only from the Atlas issuer the workspace has
  // linked. Link the issuer of every workspace activated before that change (background, best effort).
  if (app.governance.status().atlas && app.governance.status().trustProof) {
    void (async () => {
      try {
        const ids = await app.store.listServiceLinkOrganizationIds();
        const organizations = (await Promise.all(ids.map((id) => app.store.getOrganization(id)))).filter((o) => o !== null);
        const result = await app.governance.linkAllIssuers(organizations);
        app.log.info(result, "Trust Proof issuer links checked");
      } catch (error) {
        app.log.error({ err: loggableError(error) }, "Trust Proof issuer link backfill failed");
      }
    })();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Startup failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exit(1);
});
