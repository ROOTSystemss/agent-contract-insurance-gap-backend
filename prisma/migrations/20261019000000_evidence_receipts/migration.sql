-- Evidence Notary receipts: signed, chained per workspace, anchored with OpenTimestamps.
CREATE TABLE "EvidenceReceipt" (
    "organizationId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "receipt" JSONB NOT NULL,
    "anchorHash" TEXT NOT NULL,
    "otsProof" TEXT,
    "otsStatus" TEXT NOT NULL DEFAULT 'not-submitted',
    "otsConfirmedAt" TIMESTAMP(3),
    "otsBlockHeight" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EvidenceReceipt_pkey" PRIMARY KEY ("organizationId","seq")
);

CREATE INDEX "EvidenceReceipt_otsStatus_createdAt_idx" ON "EvidenceReceipt"("otsStatus", "createdAt");

ALTER TABLE "EvidenceReceipt" ADD CONSTRAINT "EvidenceReceipt_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;