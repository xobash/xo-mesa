## Purpose

Fuzz native sync input parsers with synthetic adversarial data.

## Ownership

Owns the isolated Cargo fuzz manifest, lockfile, fuzz target and seed corpus.

## Local Contracts

- Seeds contain only synthetic inputs. Generated corpora, crashes and compiler output remain local.
- Keep parser limits and rejection behavior aligned with the production sync modules.
- Add new tracked fuzz sources and seeds to the public allowlist.

## Work Guidance

Use the existing `sync_input` target; inspect failures before changing input limits.

## Verification

Run native sync regression tests and the `parser-fuzz` CI workflow. Its `sync_input` target uses pinned Cargo fuzz and nightly versions, synthetic seeds and a 120-second bound. The smoke run is bounded coverage, not exhaustive validation.

## Child DOX Index

None. Targets and seeds are owned here.
