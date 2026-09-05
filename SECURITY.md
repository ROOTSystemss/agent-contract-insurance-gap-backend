# Security Policy

Report vulnerabilities privately to the repository owner; do not open a public issue containing exploit details or confidential documents.

## Data handling

Contracts and insurance policies may be highly confidential. Local document storage supports authenticated AES-256-GCM encryption through `DOCUMENT_ENCRYPTION_KEY`, and expired documents are automatically purged according to the configured retention window. Production deployments should still use encrypted object storage, encrypted database volumes, TLS, least-privilege service credentials, centralized secret management, backups, monitoring, and documented incident response. Local uploads are private and never served by Fastify.

Never rotate `DOCUMENT_ENCRYPTION_KEY` without first decrypting and re-encrypting existing objects through an approved migration. Losing the key makes stored document bytes unrecoverable.

Passwords and JWTs are redacted from application logs. Uploaded document content is not included in audit metadata. Production startup rejects weak JWT configuration and memory persistence.

Rotate a secret immediately if it is exposed. Delete the exposed value from the provider and repository history using an approved incident process rather than ordinary Git rewriting.

No security-support SLA has been established for this early-stage repository.
