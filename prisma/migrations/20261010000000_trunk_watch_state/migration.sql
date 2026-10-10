-- RootSystems Trunk continuous authority checks: item keys and times only.
CREATE TABLE "TrunkWatchState" (
    "organizationId" UUID NOT NULL,
    "keys" JSONB NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL,
    "alertedAt" TIMESTAMP(3),
    CONSTRAINT "TrunkWatchState_pkey" PRIMARY KEY ("organizationId")
);

ALTER TABLE "TrunkWatchState" ADD CONSTRAINT "TrunkWatchState_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
