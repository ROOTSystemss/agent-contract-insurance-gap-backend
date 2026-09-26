# Deploying to Render (Docker web service)

Create a Render **Web Service** from this repo, Runtime: Docker, health check path `/health`.
On start the container applies database migrations (`prisma migrate deploy`) and then starts the API.

Required environment variables (production refuses to start without them):

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `PERSISTENCE_DRIVER` | `postgres` |
| `DATABASE_URL` | direct (non-pooled) Neon string for the `acg` database, ending `?sslmode=require` |
| `JWT_SECRET` | 32+ random characters, not containing "secret", "development" or "replace" |
| `DOCUMENT_ENCRYPTION_KEY` | base64 of 32 random bytes: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `ATLAS_OAUTH_CLIENT_SECRET` | 32+ random characters (same value configured on AI Compliance Readiness), no "secret"/"development"/"replace" |
| `ATLAS_OAUTH_REDIRECT_URIS` | `https://ai-compliance-readiness.onrender.com/auth/atlas/callback` (https only) |
| `CORS_ORIGINS` | the site origins allowed to call the API, comma-separated |
| `TRUST_PROXY` | `true` |
| `AUTHORITY_ATLAS_URL` | optional: the Authority Atlas base URL (https, no path), e.g. `https://authority-atlas.onrender.com`. Enables the certificate checks below; without it they answer 503. |

Uploaded documents live on the container disk, which is ephemeral on Render's free plan; they are deleted after `DOCUMENT_RETENTION_DAYS` (default 30) anyway, and structured data lives in Postgres.

## Agent authority certificate checks
Contract Gap compares an agent's declared profile with a signed authority certificate issued by Authority Atlas, because a profile that understates what the certificate authorizes makes the gap analysis under-report risk.
- POST /api/v1/agents/:id/certificate-check {certificate}: read-only. Returns the differences (high: profile understates the certificate or has a lower spending limit; moderate: profile declares something no certificate covers).
- POST /api/v1/agents/:id/adopt-certificate {certificate}: escalation only. Turns capabilities on and raises the limit to match the certificate; never turns anything off or lowers a limit. Refuses (422) to add spending authority when no limit is available.
- The certificate is always verified live with Atlas (signature, expiry, revocation). Any failure to verify stops the request: 422 for an invalid certificate, 503 when Atlas is unreachable or not configured.
- Tests: tests/certificate.test.ts (33 checks) and, against a real Atlas, ATLAS_DIR=<atlas checkout> node scripts/certificate-e2e.mjs (11 checks; run npm run build first).

## Agent Assurance Pack
One fingerprinted summary of an agent's authority, the contract and insurance findings, and any verified authority certificate, for a broker, auditor, customer or lawyer.
- POST /api/v1/analyses/:id/assurance-pack, optional body {certificate}. The analysis must be finished (completed or completed_with_warnings). Returns {pack, contentHash, hashAlgorithm, canonicalization}.
- POST /api/v1/analyses/assurance-pack/verify {pack, contentHash} recomputes the fingerprint: proves the pack is unchanged since it was built (not that its contents are true).
- Metadata only: no contract text, evidence excerpts or explanations; documents appear only as SHA-256 checksums.
- To anchor it with named human sign-off, submit the hash to Trust Proof: POST /api/v1/decisions with content {"type":"agent-assurance-pack","contentHash":"<hash>"} and the people who must sign. It then joins that organization's tamper-evident chain.
- Tests: tests/assurance-pack.test.ts (13 checks).
