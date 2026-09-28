-- Agent Governance console: members with a personal Trust Proof signing key.
CREATE TABLE "ConsoleSigner" (
    "organizationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "trustProofEmail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConsoleSigner_pkey" PRIMARY KEY ("organizationId","userId")
);

ALTER TABLE "ConsoleSigner" ADD CONSTRAINT "ConsoleSigner_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
