# PROGRESS

## BLOQUÉ / questions
- (Q1) Repo `harijoe/bivouac` is private → GHCR images will be private; `curl | bash` install from a fresh VM cannot work anonymously.
  Working assumption: the e2e passes a read-only registry credential to the installer (`BIVOUAC_GHCR_USER/TOKEN`) and
  the repo should be made public before v0.1.0 for the documented install to work. Needs owner decision (make repo public?).

## Fait
- M1: monorepo, task image (real CLI verified non-root in container with OAuth token), real stream-json fixture.
- M2: daemon (SQLite store, runner/success loop, budgets, sandbox abstraction, git, REST+SSE API) — 24 unit tests green with fake claude.

## En cours
- M3: Docker integration (daemon image, Traefik compose, preview, parallel tasks).

## Décisions
See docs/decisions.md.
