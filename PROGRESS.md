# PROGRESS

## BLOQUÉ / questions
- (Q1) Repo `harijoe/bivouac` is private → GHCR images will be private; `curl | bash` install from a fresh VM cannot work anonymously.
  Working assumption: the e2e passes a read-only registry credential to the installer (`BIVOUAC_GHCR_USER/TOKEN`) and
  the repo should be made public before v0.1.0 for the documented install to work. Needs owner decision (make repo public?).

## Fait
- Real stream-json capture (fixtures).

## En cours
- Milestone 1: monorepo scaffold.

## Décisions
See docs/decisions.md.
