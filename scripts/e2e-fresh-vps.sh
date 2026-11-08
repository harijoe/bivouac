#!/usr/bin/env bash
# End-to-end test on a brand-new Ubuntu 24.04 Hetzner Cloud server, driven from this machine.
#
#   scripts/e2e-fresh-vps.sh [--real] [--ghcr] [--domain] [--staging]
#
#   (default)  fake claude, sslip.io address, images built on the VM from the current checkout
#   --real     real `claude` CLI: one small task (uses CLAUDE_CODE_OAUTH_TOKEN, a few cents)
#   --ghcr     pull the published images (BIVOUAC_VERSION, default edge)
#   --domain   attach the reserved primary IP and move to $PREVIEW_DOMAIN through the setup wizard's domain step
#   --staging  Let's Encrypt staging CA (untrusted certificates, no rate limits)
#
# It runs the install command found in README.md (between the e2e markers) as root on the VM, creates a test session with
# `bivouac session create`, then runs scripts/e2e-client.mjs from here (official MCP SDK client over the public internet).
# The server is ALWAYS destroyed on exit; the reserved IP is never deleted.
# Environment (or ~/bivouac-inputs.env): HCLOUD_TOKEN, GITHUB_TOKEN, CLAUDE_CODE_OAUTH_TOKEN, PREVIEW_DOMAIN
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f "$HOME/bivouac-inputs.env" ] && { set -a; . "$HOME/bivouac-inputs.env"; set +a; }
MODE=fake; IMAGES=local; DOMAINMODE=0; STAGING=0
for a in "$@"; do case "$a" in --real) MODE=real;; --ghcr) IMAGES=ghcr;; --domain) DOMAINMODE=1;; --staging) STAGING=1;; *) echo "unknown arg $a" >&2; exit 2;; esac; done
: "${HCLOUD_TOKEN:?HCLOUD_TOKEN is required}"; : "${GITHUB_TOKEN:?GITHUB_TOKEN is required}"
[ "$MODE" = fake ] || : "${CLAUDE_CODE_OAUTH_TOKEN:?CLAUDE_CODE_OAUTH_TOKEN is required for --real}"
[ "$DOMAINMODE" = 0 ] || : "${PREVIEW_DOMAIN:?PREVIEW_DOMAIN is required for --domain}"
. scripts/lib-hcloud.sh

say "publishing the example app branch"
GIT_ASKPASS="$HOME/.bivouac-askpass.sh" ./scripts/publish-example.sh example-app >/dev/null 2>&1 || say "(could not publish example-app, using existing branch)"

vm_up $([ "$DOMAINMODE" = 1 ] && echo --domain)

# ---- the install command, taken verbatim from the README
CMD="$(awk '/<!-- e2e:install:start -->/{f=1;next} /<!-- e2e:install:end -->/{f=0} f' README.md | sed '/^```/d')"
[ -n "$CMD" ] || { echo "no e2e:install block in README.md" >&2; exit 1; }
say "README install command: $CMD"
ENVS=("BIVOUAC_VERSION=${BIVOUAC_VERSION:-edge}")
if [ "$MODE" = real ]; then ENVS+=("CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN"); else ENVS+=("BIVOUAC_CLAUDE_BIN=/opt/bivouac/fake-claude"); fi
[ "$STAGING" = 0 ] || ENVS+=("BIVOUAC_ACME_STAGING=1")
CMD="${CMD//sudo bash/sudo -E bash}"
if [ "$IMAGES" = local ]; then
  say "uploading the source checkout (images are built on the VM)"
  git archive --format=tar.gz HEAD | "${SSH[@]}" "root@$IP" 'mkdir -p /root/src && tar xz -C /root/src'
  ENVS+=("BIVOUAC_SOURCE_DIR=/root/src")
  # the script may not be on main yet: use the checkout's install.sh instead of downloading it
  CMD="${CMD/curl -fsSL https:\/\/raw.githubusercontent.com\/harijoe\/bivouac\/main\/install.sh/cat /root/src/install.sh}"
  say "(local-image mode) install command used: $CMD"
fi
printf '%s\n' "${ENVS[@]/#/export }" | sed -E "s/^export ([A-Za-z_]+)=(.*)$/export \1='\2'/" > "$TMP/env.sh"
say "running the installer on the VM"
{ cat "$TMP/env.sh"; echo "$CMD"; } | "${SSH[@]}" "root@$IP" 'bash -s' 2>&1 | sed -u 's/^/  vm| /' | sed -E 's/(tskey-[A-Za-z0-9-]+|sk-ant-[A-Za-z0-9_-]+)/***/g'
[ "${PIPESTATUS[1]}" = 0 ] || { echo "installer failed" >&2; exit 1; }

say "verifying from the server side"
SSHR 'docker ps --format "{{.Names}} {{.Status}}" | grep ^bivouac' | sed 's/^/  vm| /'
SSHR '! docker inspect bivouac-web --format "{{json .HostConfig.Binds}}" | grep -q docker.sock' && say "web has no Docker socket mounted"
SSHR '! docker exec bivouac-web test -e /var/run/docker.sock' && say "web cannot see the Docker socket"
SSHR '[ "$(docker inspect bivouac-traefik --format "{{json .NetworkSettings.Networks}}" | jq -r "keys|join(\",\")")" = bivouac-edge ]' && say "Traefik is on the edge network only"
SSHR '! timeout 30 docker exec bivouac-traefik getent hosts bivouac-executor' && say "the executor does not resolve from the public edge"
SSHR 'stat -c "%a %n" /etc/bivouac/bivouac.env /var/lib/bivouac/web/secret.key' | sed 's/^/  vm| /'
SSHR 'ss -Hltn | awk "{print \$4}" | sort -u' | sed 's/^/  vm| listening: /'

SESSION=$(SSHR 'bivouac session create --github-id 9001' | tr -d '\r\n')
SETUP_LINK=$(SSHR 'bivouac setup-link' | tr -d '\r\n')
BASE="https://$(SSHR 'bivouac domain' | tr -d '\r\n')"
CLIENT_ARGS=(--repo-url https://github.com/harijoe/bivouac.git --repo-branch example-app --gh-token "$GITHUB_TOKEN")
CURLK=""; [ "$STAGING" = 0 ] || { CLIENT_ARGS+=(--insecure); CURLK="-k"; }
[ "$MODE" = fake ] || CLIENT_ARGS+=(--real)

if [ "$DOMAINMODE" = 1 ]; then
  say "setup wizard, step 1: move to $PREVIEW_DOMAIN (DNS must already point to the reserved IP)"
  CODE="${SETUP_LINK##*code=}"
  JAR="$TMP/jar"; curl -fsS $CURLK -c "$JAR" -o /dev/null "$SETUP_LINK"
  r=""
  for _ in $(seq 1 30); do
    r=$(curl -fsS $CURLK -b "$JAR" -H 'content-type: application/json' -d "{\"domain\":\"$PREVIEW_DOMAIN\"}" "$BASE/api/setup/domain/check")
    [ "$(echo "$r" | jq -r .ok)" = true ] && break; sleep 5
  done
  echo "$r" | jq -c .; [ "$(echo "$r" | jq -r .ok)" = true ] || { echo "DNS for $PREVIEW_DOMAIN does not point to $IP" >&2; exit 1; }
  curl -fsS $CURLK -b "$JAR" -H 'content-type: application/json' -d "{\"domain\":\"$PREVIEW_DOMAIN\",\"code\":\"$CODE\"}" "$BASE/api/setup/domain/apply" | jq -c .
  BASE="https://$PREVIEW_DOMAIN"
  for _ in $(seq 1 60); do curl -fsS $CURLK --max-time 5 "$BASE/api/health" >/dev/null 2>&1 && break; sleep 3; done
  curl -fsS $CURLK "$BASE/api/health" >/dev/null || { echo "new domain does not answer over HTTPS" >&2; exit 1; }
  say "$PREVIEW_DOMAIN answers over HTTPS"
fi

say "running the client checks from this machine against $BASE (mode: $MODE)"
node scripts/e2e-client.mjs --base "$BASE" --session "$SESSION" "${CLIENT_ARGS[@]}" 2>&1 | sed -u 's/^/  | /'
[ "${PIPESTATUS[0]}" = 0 ] || { echo "client checks failed" >&2; exit 1; }

if [ "$MODE" = fake ]; then
  say "re-running the installer on the same VM (idempotency / update)"
  { cat "$TMP/env.sh"; echo "$CMD"; } | "${SSH[@]}" "root@$IP" 'bash -s' 2>&1 | tail -12 | sed -u 's/^/  vm| /'
  [ "${PIPESTATUS[1]}" = 0 ] || { echo "second install run failed" >&2; exit 1; }
  curl -fsS $CURLK "$BASE/api/health" >/dev/null
  say "uninstall"
  SSHR 'bash /opt/bivouac/uninstall.sh --purge >/dev/null && ! docker ps -a --format {{.Names}} | grep -q bivouac && [ ! -e /var/lib/bivouac ] && ! docker network ls --format {{.Name}} | grep -q bivouac'
fi
say "E2E PASSED ($MODE, domain mode=$DOMAINMODE)"
