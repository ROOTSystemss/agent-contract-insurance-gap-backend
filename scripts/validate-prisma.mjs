import { spawnSync } from "node:child_process";

const command = process.platform === "win32" ? "prisma.cmd" : "prisma";
const result = spawnSync(command, ["validate"], {
  env: {
    ...process.env,
    // Schema validation only parses the URL. It does not connect to this database.
    DATABASE_URL:
      process.env.DATABASE_URL ??
      "postgresql://schema_validation:schema_validation@127.0.0.1:5432/schema_validation",
  },
  shell: process.platform === "win32",
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
