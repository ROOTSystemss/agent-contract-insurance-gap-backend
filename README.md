# Agent Contract & Insurance Gap Engine

Backend-first, API-first software that identifies where an AI agent's declared authority may exceed what supplied contracts and insurance documents clearly contemplate.

> **Informational-use boundary:** This analysis is an automated informational review intended to identify areas that may warrant further examination. It is not legal advice, insurance advice, a coverage opinion, or a determination of contractual enforceability. Insurance coverage and contractual obligations depend on complete policy language, endorsements, facts, governing law, and professional interpretation. Consult qualified legal counsel and licensed insurance professionals before making decisions.

The application never requires an LLM or paid API. Its initial findings are deterministic, versioned, reproducible, and traceable to exact extracted text where responsive evidence exists.

## Product boundaries

The engine may identify potential ambiguity, missing responsive language, or a mismatch that warrants professional review. It must not say that a party is covered or not covered, that a contract is invalid or enforceable, or that an insurer must pay. It does not generate legally approved replacement clauses.

Contracts and insurance documents may contain confidential information. Deployers are responsible for encryption, access control, retention, backups, data residency, incident response, and appropriate agreements with infrastructure providers.

## Architecture

- Fastify transport with versioned `/api/v1` routes, Zod validation, uniform envelopes, request IDs, Swagger, security headers, rate limiting, restricted CORS, and redacted Pino logs.
- Application services for uploads, extraction, analysis, scoring, and reports.
- Domain types for organizations, projects, agent profiles, evidence, findings, and analysis state.
- A `Store` boundary with PostgreSQL/Prisma and isolated in-memory implementations.
- A `DocumentStorage` boundary with local private filesystem storage and an interface suitable for S3-compatible storage.
- PDF, DOCX, and TXT extraction followed by traceable segmentation.
- Data-driven clause taxonomy and deterministic phrase/proximity signals.
- GLOBAL universal rules composed with versioned jurisdiction packs. Unreviewed markets visibly fall back to structural analysis.
- Future model-provider interface whose output is untrusted and must pass evidence validation before persistence.

See [architecture](docs/architecture.md), [risk model](docs/risk-model.md), [jurisdiction packs](docs/jurisdiction-packs.md), [API workflow](docs/api-workflow.md), and [legal/insurance boundaries](docs/legal-and-insurance-boundaries.md).

## Folder structure

```text
src/api/            Fastify routes, schemas, envelopes, authorization
src/analysis/       taxonomy, deterministic detection, gap rules, scoring
src/config/         validated runtime configuration
src/demo/           fictional reusable demo profiles
src/documents/      extraction, segmentation, storage, upload service
src/domain/         domain types and enums
src/jurisdictions/  validated versioned pack schema and pack catalog
src/persistence/    Store interface, memory adapter, Prisma adapter
src/reports/        deterministic report assembly
src/shared/         canonical disclaimer and application errors
prisma/             normalized schema, migration, and seed
demo/fixtures/      repository-authored fictional sample documents
tests/              unit and API integration tests
```

## Technology

Node.js 22 LTS recommended, strict TypeScript, Fastify, PostgreSQL, Prisma, Zod, JWT, bcrypt, Swagger/OpenAPI, Pino, Vitest, ESLint, Prettier, Docker, `pdf-parse`, and Mammoth.

## Quick start without PostgreSQL

```bash
npm install
copy .env.example .env
```

Set a long random `JWT_SECRET` and keep `PERSISTENCE_DRIVER=memory`, then:

```bash
npm run dev
```

Open `http://127.0.0.1:4400/` for the Agent Contract Gap product interface. The frontend is served by the same Fastify process, so it has no separate runtime or framework dependency. API documentation remains available at `http://127.0.0.1:4400/docs`.

The interface supports registration and login, project creation, agent authority profiling, PDF/DOCX/TXT upload, deterministic analysis, and review-ready findings. Memory mode is for evaluation and tests; data is lost when the process stops.

## PostgreSQL setup

Set `PERSISTENCE_DRIVER=postgres` and `DATABASE_URL`, then run:

```bash
npm run prisma:generate
npx prisma migrate deploy
npm run prisma:seed
npm run dev
```

For a development migration after changing the schema:

```bash
npm run prisma:migrate
```

The normal Windows helper securely prompts for the existing PostgreSQL administrator password:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/configure-local-postgres.ps1
```

If that password has been lost but another local project already has a working PostgreSQL credential, the following helper can reuse it without displaying the credential, restarting PostgreSQL, or changing authentication. It creates a restricted account and database used only by Authority Atlas:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/configure-from-existing-postgres.ps1
```

## Docker

Copy `.env.docker.example` to `.env`, replace every placeholder with independently generated values, and URL-encode the database password inside `DATABASE_URL`. Then run:

```bash
docker compose up --build
```

The API listens on `http://localhost:4400`. Compose now fails closed when database, JWT, or document-encryption secrets are absent. Uploaded files and PostgreSQL data use named volumes and are not publicly served.

## Commands

```bash
npm run dev
npm run build
npm start
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:live
npm run test:coverage
npm run verify
npm run prisma:validate
npm run demo
npm run postgres:backup
```

`npm run demo` uses memory persistence and prints report-ready JSON. It requires no credentials or external service. With a server already running, `npm run test:live` exercises the complete HTTP workflow from registration through report generation.

## Environment variables

| Variable                              | Purpose                                                                       |
| ------------------------------------- | ----------------------------------------------------------------------------- |
| `NODE_ENV`                            | `development`, `test`, or `production`                                        |
| `HOST`, `PORT`                        | listener configuration                                                        |
| `DATABASE_URL`                        | PostgreSQL connection URL                                                     |
| `PERSISTENCE_DRIVER`                  | `memory` or `postgres`; production requires `postgres`                        |
| `JWT_SECRET`                          | signing key; production rejects missing, short, or obvious placeholder values |
| `JWT_EXPIRES_IN`                      | access-token lifetime                                                         |
| `CORS_ORIGINS`                        | comma-separated exact allowed origins                                         |
| `UPLOAD_DIRECTORY`                    | private local document store                                                  |
| `DOCUMENT_ENCRYPTION_KEY`             | base64 256-bit AES-GCM key; required in production                            |
| `MAX_FILE_SIZE_BYTES`                 | upload size ceiling                                                           |
| `DOCUMENT_RETENTION_DAYS`             | initial deletion-review date                                                  |
| `RETENTION_SWEEP_INTERVAL_MS`         | interval for automatic expired-document deletion                              |
| `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW` | global request throttling                                                     |
| `LOG_LEVEL`, `TRUST_PROXY`            | operations settings                                                           |

## API documentation

- Swagger UI: `http://localhost:4400/docs`
- OpenAPI JSON: `http://localhost:4400/api/v1/openapi.json`
- Health: `GET /health`
- Readiness: `GET /ready`

### Endpoint summary

- Auth: register, login, current user
- Organizations: current organization, update, members
- Jurisdictions and packs: list/get
- Projects: create/list/get/update/logical delete
- Agent profiles: create/list/get/update/delete
- Documents: multipart upload/list/get/safe delete/retry extraction/automatic retention purge
- Analyses: create/list/get/run/rerun/findings/JSON and PDF reports
- Findings: get/update workflow status
- Audit: project audit-event list

All tenant resources are filtered by the authenticated organization. Cross-tenant guessed IDs return `404` rather than revealing existence. Owners and admins manage destructive operations; analysts create and run work; viewers are read-only.

## Example workflow

Register:

```bash
curl -X POST http://localhost:4400/api/v1/auth/register \
  -H "content-type: application/json" \
  -d '{"email":"analyst@example.test","password":"a-long-demo-password","name":"Demo Analyst","organizationName":"Fictional Acme Ltd"}'
```

Use the returned token:

```bash
curl -X POST http://localhost:4400/api/v1/projects \
  -H "authorization: Bearer TOKEN" -H "content-type: application/json" \
  -d '{"name":"Procurement review","primaryCountryCode":"US","primarySubdivisionCode":"US-IL","affectedCountryCodes":["CA"]}'
```

Upload metadata is passed as query parameters and the document as multipart field `file`:

```bash
curl -X POST "http://localhost:4400/api/v1/projects/PROJECT_ID/documents?documentType=commercial_contract&countryCode=US&subdivisionCode=US-IL" \
  -H "authorization: Bearer TOKEN" -F "file=@demo/fixtures/contract-human-approval.txt;type=text/plain"
```

Create an agent profile using the complete shape in `src/demo/data.ts`, create an analysis with its ID and document IDs, then call `POST /api/v1/analyses/:id/run` and `GET /api/v1/analyses/:id/report`.

## Autonomy and attention score

Autonomy levels range from 0 (informational only) through 5 (broad consequential operation and possible delegation). Autonomy is only one contribution. The 0–100 attention score also considers financial and contractual authority, external communication, data sensitivity, operational impact, oversight, reversibility, delegation, document clarity, insurance ambiguity, missing documents, and jurisdiction-pack maturity.

Labels are `low_attention`, `moderate_attention`, `high_attention`, and `critical_review`. The result exposes every contribution and is not a legal-risk, loss, or coverage probability. See [risk-model.md](docs/risk-model.md).

## Jurisdiction behavior

Any recognized ISO 3166-1 alpha-2 country may be selected, with optional subdivision codes such as `US-IL` or `CA-ON`. GLOBAL rules always perform structural review. Initial US, UK, EU, Canada, India, and Australia packs are research scaffolds—not verified law—and therefore trigger explicit GLOBAL fallback warnings.

To add a pack, validate it with `jurisdictionPackSchema`, provide immutable version/effective/review metadata, sources and limitations, compute its checksum, and add only rules verified by qualified reviewers. Pack data is parsed as data and never executed. See [jurisdiction-packs.md](docs/jurisdiction-packs.md).

## Adding deterministic rules

1. Add phrase families to `src/analysis/clause-taxonomy.ts`.
2. Add a narrowly scoped capability comparison to `gap-engine.ts`.
3. Give it a stable rule ID and increment the ruleset version.
4. Add positive, negative, negation, exact-evidence, and idempotency tests.
5. Keep document fact, profile fact, inference, rule, and professional-review question separate.

## Demo and seed

`npm run demo` needs no database. For PostgreSQL, `npm run prisma:seed` creates safe fictional data. Default development-only login:

```text
demo@example.test
Demo-Only-Change-Me-123!
```

Override `DEMO_PASSWORD` before seeding any shared environment. Never use demo credentials in production.

## Current limitations and roadmap

- Scanned PDFs are detected and marked `ocr_required`; OCR is not bundled.
- Page-level PDF text is extracted, but current segmentation does not yet preserve exact per-page mapping.
- Initial country packs contain no localized rules pending qualified professional review.
- Local document bytes support authenticated AES-256-GCM encryption when `DOCUMENT_ENCRYPTION_KEY` is configured. Horizontally scaled deployments still require an encrypted S3-compatible adapter.
- JWT access tokens have no refresh/revocation service yet.
- Next milestones requiring external infrastructure or professional input: qualified pack review, encrypted object storage, asynchronous extraction/OCR workers, membership invitations, refresh-token revocation, email delivery, and production monitoring/backups.

## License

No open-source license has been selected. All rights are reserved unless the owner chooses and adds a license explicitly.
