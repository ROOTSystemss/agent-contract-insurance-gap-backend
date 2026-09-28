-- Agent Governance console billing (Dodo Payments).
CREATE TABLE "ConsoleSubscription" (
    "organizationId" UUID NOT NULL,
    "plan" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "dodoCustomerId" TEXT,
    "dodoSubscriptionId" TEXT,
    "renewsAt" TIMESTAMP(3),
    "lastEventAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ConsoleSubscription_pkey" PRIMARY KEY ("organizationId")
);

CREATE TABLE "BillingWebhookEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BillingWebhookEvent_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ConsoleSubscription" ADD CONSTRAINT "ConsoleSubscription_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
