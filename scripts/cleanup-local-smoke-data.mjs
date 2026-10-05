import { Buffer } from "node:buffer";
import { createDecipheriv } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const SEALED = "enc:v1:";
const key = process.env.DOCUMENT_ENCRYPTION_KEY ? Buffer.from(process.env.DOCUMENT_ENCRYPTION_KEY, "base64") : null;

// Emails are stored encrypted, so smoke-test accounts are matched after decrypting.
function openEmail(value) {
  if (!value.startsWith(SEALED)) return value;
  if (!key) throw new Error("DOCUMENT_ENCRYPTION_KEY is required to read stored account emails");
  const [iv, tag, body] = value.slice(SEALED.length).split(".").map((part) => Buffer.from(part, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

function isSmokeEmail(email) {
  return (email.startsWith("live-smoke-") && email.endsWith("@example.test")) || email === "persistence-check@example.test";
}

try {
  const candidates = await prisma.user.findMany({
    select: { id: true, email: true, memberships: { select: { organizationId: true } } },
  });
  const users = candidates.filter((user) => isSmokeEmail(openEmail(user.email)));
  const userIds = users.map((user) => user.id);
  const organizationIds = [
    ...new Set(users.flatMap((user) => user.memberships.map((item) => item.organizationId))),
  ];
  if (organizationIds.length || userIds.length) {
    await prisma.$transaction(async (transaction) => {
      if (organizationIds.length) {
        await transaction.analysisDocument.deleteMany({
          where: { analysis: { organizationId: { in: organizationIds } } },
        });
        await transaction.organization.deleteMany({ where: { id: { in: organizationIds } } });
      }
      if (userIds.length) await transaction.user.deleteMany({ where: { id: { in: userIds } } });
    });
  }
  process.stdout.write(
    `Removed ${userIds.length} smoke-test user(s) and ${organizationIds.length} smoke-test organization(s).\n`,
  );
} finally {
  await prisma.$disconnect();
}
