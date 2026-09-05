# Production readiness

The codebase fails closed on the most important production configuration mistakes: memory persistence, a missing PostgreSQL URL, weak JWT signing material, and missing document encryption. Passing the automated suite does not by itself authorize a public launch.

## Completed controls

- Organization-scoped persistence and identifier lookup
- Owner/admin/analyst/viewer authorization
- Password hashing, short-lived JWT access tokens, and log redaction
- Exact-origin CORS, request throttling, body limits, security headers, and request IDs
- File extension, MIME, magic-byte, binary-text, and path validation
- SHA-256 content checksums and optional AES-256-GCM authenticated storage encryption
- Automatic retention sweeps that remove stored bytes and extracted text
- Deterministic findings with evidence, confidence, rule versions, limitations, and disclaimers
- Immutable migration history, health/readiness endpoints, audit events, PDF/JSON reports, and backup tooling
- Production container runs as an unprivileged user and includes the product frontend

## Required external work before launch

1. Supply PostgreSQL, JWT, encryption, CORS, and email secrets through the deployment provider—not committed files.
2. Replace the single-node filesystem adapter with encrypted object storage when running more than one application replica.
3. Configure TLS, database encryption/backups, centralized logs, uptime alerts, error monitoring, and tested disaster recovery.
4. Add an email provider before enabling invitations or password recovery.
5. Add a queue and trusted OCR service before accepting scanned PDFs as analyzable evidence.
6. Have qualified counsel and licensed insurance professionals approve every localized jurisdiction pack and customer-facing limitation.
7. Commission an independent penetration test and privacy/security review using representative deployment architecture.
8. Define data-processing terms, privacy notices, retention defaults, incident response, support ownership, and breach procedures.

## Release gate

Run `npm run verify`, apply migrations with `npm run prisma:deploy`, verify `/ready`, execute `npm run test:live` against the release candidate, restore a recent database backup in an isolated environment, and confirm that uploaded bytes are encrypted at rest. Record the application commit, migration version, rule versions, pack checksums, and reviewer approvals for every release.
