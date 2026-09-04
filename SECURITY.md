# Security Policy

Report vulnerabilities privately to the repository owner; do not open a public issue containing exploit details or confidential documents.

## Data handling

Contracts and insurance policies may be highly confidential. Production deployments should use encrypted object storage, encrypted database volumes, TLS, least-privilege service credentials, centralized secret management, backups, retention enforcement, monitoring, and documented incident response. Local uploads are private and never served by Fastify.

Passwords and JWTs are redacted from application logs. Uploaded document content is not included in audit metadata. Production startup rejects weak JWT configuration and memory persistence.

Rotate a secret immediately if it is exposed. Delete the exposed value from the provider and repository history using an approved incident process rather than ordinary Git rewriting.

No security-support SLA has been established for this early-stage repository.
