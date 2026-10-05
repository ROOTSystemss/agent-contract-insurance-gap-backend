import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { buildApp } from "./app.js";
import { loadConfig } from "./config/env.js";

async function main(): Promise<void> {
  if (existsSync(".env")) loadEnvFile(".env");
  const config = loadConfig();
  const app = await buildApp({ config });
  try {
    const upgraded = await app.store.encryptStoredEmails();
    if (upgraded > 0) app.log.info({ upgraded }, "encrypted stored account emails");
  } catch (error) {
    app.log.error({ err: error }, "account email encryption failed");
  }
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  await app.listen({ host: config.HOST, port: config.PORT });
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Startup failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exit(1);
});
