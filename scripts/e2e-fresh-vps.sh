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
PRIMARY_IP_ID=161046145

RUN="$(date +%s)-$RANDOM"
NAME="bivouac-dev-e2e-$RUN"
TMP="$(mktemp -d)"
API=https://api.hetzner.cloud/v1
hc() { curl -fsS -H "Authorization: Bearer $HCLOUD_TOKEN" -H 'Content-Type: application/json' "$@"; }
say() { printf '\n\033[1;36m[e2e %s]\033[0m %s\n' "$NAME" "$*"; }
SERVER_ID=""; KEY_ID=""; IP=""
SSH=(ssh -i "$TMP/key" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ServerAliveInterval=15 -o ConnectTimeout=10)

cleanup() {
  local rc=$?
  set +e
  say "cleanup (exit code $rc)"
  [ -n "$SERVER_ID" ] && hc -X DELETE "$API/servers/$SERVER_ID" >/dev/null && say "server $SERVER_ID deleted"
  # wait for the server to be gone before removing its key
  for _ in $(seq 1 30); do [ -z "$SERVER_ID" ] && break; hc "$API/servers/$SERVER_ID" >/dev/null 2>&1 || break; sleep 2; done
  [ -n "$KEY_ID" ] && hc -X DELETE "$API/ssh_keys/$KEY_ID" >/dev/null && say "ssh key $KEY_ID deleted"
  left=$(hc "$API/servers?label_selector=purpose%3Dbivouac-dev-e2e" | jq -r '.servers[].name' | grep -c "$RUN")
  [ "$left" = 0 ] && say "no leftover resource" || say "WARNING: leftover server(s) for run $RUN"
  rm -rf "$TMP"
  exit $rc
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# stale servers of previous (crashed) runs: ours by prefix, older than 3 hours
hc "$API/servers?label_selector=purpose%3Dbivouac-dev-e2e" | jq -r --argjson cutoff "$(( $(date +%s) - 10800 ))" '.servers[] | select(.name|startswith("bivouac-dev-e2e-")) | select((.created|fromdateiso8601) < $cutoff) | .id' | while read -r id; do
  say "deleting stale server $id"; hc -X DELETE "$API/servers/$id" >/dev/null || true
done

say "publishing the example app branch"
GIT_ASKPASS="$HOME/.bivouac-askpass.sh" ./scripts/publish-example.sh example-app >/dev/null 2>&1 || say "(could not publish example-app, using existing branch)"

say "creating SSH key and server"
ssh-keygen -q -t ed25519 -N '' -f "$TMP/key"
KEY_ID=$(hc -X POST "$API/ssh_keys" -d "$(jq -n --arg n "$NAME" --arg k "$(cat "$TMP/key.pub")" '{name:$n,public_key:$k,labels:{purpose:"bivouac-dev-e2e"}}')" | jq -r .ssh_key.id)
TYPE="${HCLOUD_TYPE:-$(hc "$API/server_types?per_page=50" | jq -r '[.server_types[] | select(.deprecated != true and .architecture=="x86" and .cores>=2 and .memory>=4 and .cpu_type=="shared")] | sort_by(.prices[0].price_hourly.gross|tonumber) | .[0].name')}"
LOCATION="${HCLOUD_LOCATION:-nbg1}"
say "server type: $TYPE in $LOCATION"
if [ "$DOMAINMODE" = 1 ]; then
  assigned=$(hc "$API/primary_ips/$PRIMARY_IP_ID" | jq -r '.primary_ip.assignee_id // empty')
  [ -z "$assigned" ] || { echo "reserved primary IP is still attached to server $assigned" >&2; exit 1; }
  PUBNET=$(jq -n --argjson ip "$PRIMARY_IP_ID" '{enable_ipv4:true,enable_ipv6:false,ipv4:$ip}'); LOCATION=nbg1
else PUBNET='{"enable_ipv6":false}'; fi
resp=$(hc -X POST "$API/servers" -d "$(jq -n --arg n "$NAME" --arg t "$TYPE" --arg l "$LOCATION" --argjson k "$KEY_ID" --argjson pn "$PUBNET" '{name:$n,server_type:$t,image:"ubuntu-24.04",location:$l,ssh_keys:[$k],labels:{purpose:"bivouac-dev-e2e"},public_net:$pn}')")
SERVER_ID=$(echo "$resp" | jq -r .server.id)
IP=$(echo "$resp" | jq -r .server.public_net.ipv4.ip)
say "server $SERVER_ID at $IP"
for _ in $(seq 1 60); do "${SSH[@]}" "root@$IP" true 2>/dev/null && break; sleep 3; done
"${SSH[@]}" "root@$IP" 'grep PRETTY /etc/os-release; command -v docker || echo "(fresh: no docker)"'

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
SSHR() { "${SSH[@]}" "root@$IP" "$@"; }
SSHR 'docker ps --format "{{.Names}} {{.Status}}" | grep ^bivouac' | sed 's/^/  vm| /'
SSHR '! docker inspect bivouac-web --format "{{json .HostConfig.Binds}}" | grep -q docker.sock' && say "web has no Docker socket mounted"
SSHR '! docker exec bivouac-web test -e /var/run/docker.sock' && say "web cannot see the Docker socket"
SSHR '[ "$(docker inspect bivouac-traefik --format "{{json .NetworkSettings.Networks}}" | jq -r "keys|join(\",\")")" = bivouac-edge ]' && say "Traefik is on the edge network only"
SSHR '! docker exec bivouac-traefik getent hosts bivouac-executor' && say "the executor does not resolve from the public edge"
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
