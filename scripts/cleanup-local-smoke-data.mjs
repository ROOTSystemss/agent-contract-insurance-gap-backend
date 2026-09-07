import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

try {
  const users = await prisma.user.findMany({
    where: {
      OR: [
        { email: { startsWith: "live-smoke-", endsWith: "@example.test" } },
        { email: "persistence-check@example.test" },
      ],
    },
    select: { id: true, memberships: { select: { organizationId: true } } },
  });
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
