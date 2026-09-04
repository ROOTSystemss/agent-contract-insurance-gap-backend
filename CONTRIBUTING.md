# Contributing

Use Node.js 22 LTS and create focused changes that preserve traceability and product boundaries.

1. Create a branch and install with `npm ci`.
2. Never use real customer documents in fixtures.
3. Add tests for every rule, including negative cases and exact evidence.
4. Run `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`.
5. Explain any new legal or insurance source metadata; unreviewed material must remain `research_required`.
6. Never add a rule that claims coverage, enforceability, or legal certainty.

Schema changes require a Prisma migration. Rule changes require a version increment. Provider-assisted output must be treated as untrusted and validated before persistence.
