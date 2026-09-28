-- Agent Governance console: linked Atlas / Trust Proof accounts and issued certificates.
CREATE TABLE "ServiceLink" (
    "organizationId" UUID NOT NULL,
    "atlasEmail" TEXT NOT NULL,
    "atlasSecret" TEXT NOT NULL,
    "trustProofEmail" TEXT NOT NULL,
    "trustProofSecret" TEXT NOT NULL,
    "trustProofApiKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ServiceLink_pkey" PRIMARY KEY ("organizationId")
);

CREATE TABLE "ConsoleCertificate" (
    "jti" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "agentId" TEXT NOT NULL,
    "certificate" TEXT NOT NULL,
    "pqSignature" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConsoleCertificate_pkey" PRIMARY KEY ("jti")
);

CREATE INDEX "ConsoleCertificate_organizationId_createdAt_idx" ON "ConsoleCertificate"("organizationId", "createdAt");

ALTER TABLE "ServiceLink" ADD CONSTRAINT "ServiceLink_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ConsoleCertificate" ADD CONSTRAINT "ConsoleCertificate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
