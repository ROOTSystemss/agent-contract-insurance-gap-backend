-- QA 2026-11-14 H1: an analysis that could not review every selected document finishes as
-- completed_with_errors and lists why in "errors" (stored encrypted, like "warnings").

-- AlterEnum
ALTER TYPE "AnalysisState" ADD VALUE 'completed_with_errors';

-- AlterTable
ALTER TABLE "Analysis" ADD COLUMN     "errors" TEXT[] DEFAULT ARRAY[]::TEXT[];
