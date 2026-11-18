-- QA 2026-11-18 F33: a teammate added with a one-time password must choose their own first.
ALTER TABLE "User" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
