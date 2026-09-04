# Architecture

The API is a modular monolith with strict organization scoping. Fastify routes validate transport input and delegate to application services. Services operate on domain objects through `Store` and `DocumentStorage` interfaces. The PostgreSQL implementation uses parameterized Prisma operations; tests use a fresh `MemoryStore` without changing authorization logic.

```text
HTTP → validation/auth/role check → application service → domain rules
                                      ↓                ↓
                                  Store interface   Storage interface
                                  ↙         ↘             ↓
                           PostgreSQL     Memory      private local files
```

Document bytes are validated, checksummed, privately stored, extracted, and segmented. The detector returns exact evidence references. The gap engine compares declared capabilities with detected/absent clause concepts. The scoring module returns reproducible contributions. The report assembler groups—not reinterprets—stored findings.

Tenant IDs are derived from verified JWT membership, never accepted from request bodies. Every tenant-owned lookup includes organization ID. Audit events contain identifiers and limited metadata, never full text, passwords, or tokens.

Analysis reruns replace findings with stable deterministic IDs derived from analysis and rule keys. Engine and ruleset versions are persisted.
