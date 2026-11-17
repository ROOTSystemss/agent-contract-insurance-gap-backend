-- Knock-out Phase 5 (2026-11-17): console governance records. Additive only: a new table, nothing existing changes.

-- CreateTable
CREATE TABLE "ConsoleRecord" (
    "organizationId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsoleRecord_pkey" PRIMARY KEY ("organizationId","kind","key")
);

-- CreateIndex
CREATE INDEX "ConsoleRecord_organizationId_kind_idx" ON "ConsoleRecord"("organizationId", "kind");

-- AddForeignKey
ALTER TABLE "ConsoleRecord" ADD CONSTRAINT "ConsoleRecord_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;