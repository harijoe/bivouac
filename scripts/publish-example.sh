#!/usr/bin/env bash
# Publishes examples/<dir> (default vite-app) as its own branch (default `example-app`) of this repository, so that
# bivouac can use it as a project (bivouac.yml at the repo root). Used by the e2e script.
set -euo pipefail
cd "$(dirname "$0")/.."
BRANCH="${1:-example-app}"
DIR="${2:-vite-app}"
tmp="$(git subtree split --prefix=examples/$DIR)"
GIT_ASKPASS="${GIT_ASKPASS:-}" git push -f origin "$tmp:refs/heads/$BRANCH"
