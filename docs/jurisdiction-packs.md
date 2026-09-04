# Jurisdiction Packs

GLOBAL is the production base pack for universal structural comparison. Country or subdivision packs compose with it; they never dynamically execute code.

Every pack has an ID, semantic version, country/subdivision, region type, status, dates, supported document/insurance categories, overrides, additional rules, terminology, limitations, disclaimer addendum, source records, reviewer metadata, and SHA-256 checksum. Invalid schemas or checksums fail closed.

Initial US, GB, EU, CA, IN, and AU entries are `research_required`. They contain no statutes, cases, policy wording, or localized conclusions. All currently resolve to `universal_only` behavior with a visible warning.

Adding a pack requires qualified review, authoritative source metadata, short permitted excerpts only, tests, immutable versioning, checksum regeneration, and explicit limitations. Subdivisions use codes such as `US-IL` or `CA-ON` when a reviewed pack exists.
