-- Account emails are stored encrypted; emailHash is their keyed fingerprint for lookups and uniqueness.
ALTER TABLE "User" ADD COLUMN "emailHash" TEXT;
CREATE UNIQUE INDEX "User_emailHash_key" ON "User"("emailHash");
