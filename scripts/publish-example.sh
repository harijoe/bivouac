#!/usr/bin/env bash
# Publishes examples/vite-app as its own branch (`example-app`) of this repository, so that
# bivouac can use it as a project (bivouac.yml at the repo root). Used by the e2e script.
set -euo pipefail
cd "$(dirname "$0")/.."
BRANCH="${1:-example-app}"
tmp="$(git subtree split --prefix=examples/vite-app)"
GIT_ASKPASS="${GIT_ASKPASS:-}" git push -f origin "$tmp:refs/heads/$BRANCH"
