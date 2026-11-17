-- Knock-out 2026-11-16 (S-11): two-factor sign-in. Additive only: a new table, nothing existing changes.

-- CreateTable
CREATE TABLE "UserTwoFactor" (
    "userId" UUID NOT NULL,
    "secret" TEXT NOT NULL,
    "enabledAt" TIMESTAMP(3),
    "lastStep" BIGINT,
    "recoveryHashes" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserTwoFactor_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "UserTwoFactor" ADD CONSTRAINT "UserTwoFactor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
