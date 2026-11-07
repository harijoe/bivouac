# PROGRESS

## BLOQUÉ / questions
- (Q1) Repo `harijoe/bivouac` is private → GHCR images will be private; `curl | bash` install from a fresh VM cannot work anonymously.
  Working assumption: the e2e passes a read-only registry credential to the installer (`BIVOUAC_GHCR_USER/TOKEN`) and
  the repo should be made public before v0.1.0 for the documented install to work. Needs owner decision (make repo public?).

- (Q2) The provided GITHUB_TOKEN cannot read Actions/Checks/Packages (403). Workaround: CI job `report` writes results to branch `ci-status` (status/latest.json) which I read with contents:read. Please confirm CI is green on the Actions tab if that branch is missing.
- (Q3) GHCR package visibility cannot be changed through the API: after the first image publish, set `bivouac-daemon` and `bivouac-task` packages to Public in GitHub UI (needed for the documented `curl | bash` install to pull images).

## Fait
- M1: monorepo, task image (real CLI verified non-root in container with OAuth token), real stream-json fixture.
- M2: daemon (SQLite store, runner/success loop, budgets, sandbox abstraction, git, REST+SSE API) — 24 unit tests green with fake claude.

## En cours
- M3: Docker integration (daemon image, Traefik compose, preview, parallel tasks).

## Décisions
See docs/decisions.md.
