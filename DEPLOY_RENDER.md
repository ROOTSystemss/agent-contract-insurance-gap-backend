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

Uploaded documents live on the container disk, which is ephemeral on Render's free plan; they are deleted after `DOCUMENT_RETENTION_DAYS` (default 30) anyway, and structured data lives in Postgres.
