-- Audit metadata is stored encrypted; the project it refers to moves to its own column for filtering.
ALTER TABLE "AuditEvent" ADD COLUMN "projectId" TEXT;
UPDATE "AuditEvent" SET "projectId" = "metadata"->>'projectId' WHERE jsonb_typeof("metadata") = 'object';
CREATE INDEX "AuditEvent_organizationId_projectId_idx" ON "AuditEvent"("organizationId", "projectId");
