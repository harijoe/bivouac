#!/usr/bin/env bash
# End-to-end test on a brand-new Ubuntu 24.04 Hetzner Cloud server.
#
#   scripts/e2e-fresh-vps.sh [--real] [--ghcr]
#
#   (default)  fake claude: two parallel tasks, previews, success loop
#   --real     real `claude` CLI: one small task (uses CLAUDE_CODE_OAUTH_TOKEN, a few cents)
#   --ghcr     pull the published images (needs a public repo/packages or BIVOUAC_REGISTRY_USER/TOKEN)
#              default: build the images on the VM from the current checkout (BIVOUAC_SOURCE_DIR)
#
# It runs the install command found in README.md (between the e2e markers), non-interactively,
# then /scripts/e2e-verify.sh on the VM. The server is ALWAYS destroyed on exit.
# Environment (or ~/bivouac-inputs.env): HCLOUD_TOKEN, GITHUB_TOKEN, TS_AUTHKEY, CLAUDE_CODE_OAUTH_TOKEN
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f "$HOME/bivouac-inputs.env" ] && { set -a; . "$HOME/bivouac-inputs.env"; set +a; }
MODE=fake; IMAGES=local
for a in "$@"; do case "$a" in --real) MODE=real;; --ghcr) IMAGES=ghcr;; *) echo "unknown arg $a" >&2; exit 2;; esac; done
: "${HCLOUD_TOKEN:?HCLOUD_TOKEN is required}"; : "${GITHUB_TOKEN:?GITHUB_TOKEN is required}"
[ "$MODE" = fake ] || : "${CLAUDE_CODE_OAUTH_TOKEN:?CLAUDE_CODE_OAUTH_TOKEN is required for --real}"

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
  if [ -n "$IP" ] && [ -n "${TS_AUTHKEY:-}" ]; then "${SSH[@]}" "root@$IP" 'command -v tailscale >/dev/null && tailscale logout' >/dev/null 2>&1; fi
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
resp=$(hc -X POST "$API/servers" -d "$(jq -n --arg n "$NAME" --arg t "$TYPE" --arg l "$LOCATION" --argjson k "$KEY_ID" '{name:$n,server_type:$t,image:"ubuntu-24.04",location:$l,ssh_keys:[$k],labels:{purpose:"bivouac-dev-e2e"},public_net:{enable_ipv6:false}}')")
SERVER_ID=$(echo "$resp" | jq -r .server.id)
IP=$(echo "$resp" | jq -r .server.public_net.ipv4.ip)
say "server $SERVER_ID at $IP"
for _ in $(seq 1 60); do "${SSH[@]}" "root@$IP" true 2>/dev/null && break; sleep 3; done
"${SSH[@]}" "root@$IP" 'cat /etc/os-release | grep PRETTY; docker --version 2>&1 | head -1; command -v tailscale || echo "(fresh: no docker, no tailscale)"'

# ---- the install command, taken verbatim from the README
CMD="$(awk '/<!-- e2e:install:start -->/{f=1;next} /<!-- e2e:install:end -->/{f=0} f' README.md | sed '/^```/d')"
[ -n "$CMD" ] || { echo "no e2e:install block in README.md" >&2; exit 1; }
say "README install command: $CMD"
ENVS=("BIVOUAC_NONINTERACTIVE=1" "BIVOUAC_VERSION=${BIVOUAC_VERSION:-edge}")
[ -z "${TS_AUTHKEY:-}" ] || ENVS+=("TS_AUTHKEY=$TS_AUTHKEY" "BIVOUAC_TS_HOSTNAME=$NAME")
if [ -z "${TS_AUTHKEY:-}" ]; then ENVS+=("BIVOUAC_SKIP_TAILSCALE=1" "BIVOUAC_LISTEN_IP=$IP"); fi
if [ "$MODE" = real ]; then ENVS+=("CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN"); else ENVS+=("BIVOUAC_CLAUDE_BIN=/opt/bivouac/fake-claude"); fi
if [ "$IMAGES" = local ]; then
  say "uploading the source checkout (images are built on the VM)"
  git archive --format=tar.gz HEAD | "${SSH[@]}" "root@$IP" 'mkdir -p /root/src && tar xz -C /root/src'
  ENVS+=("BIVOUAC_SOURCE_DIR=/root/src")
  # the repo may be private: use the local copy of install.sh instead of downloading it
  CMD="${CMD/curl -fsSL https:\/\/raw.githubusercontent.com\/harijoe\/bivouac\/main\/install.sh/cat /root/src/install.sh}"
  say "(local-image mode) install command used: $CMD"
fi
printf '%s\n' "${ENVS[@]/#/export }" | sed -E "s/^export ([A-Za-z_]+)=(.*)$/export \1='\2'/" > "$TMP/env.sh"
say "running the installer on the VM"
{ cat "$TMP/env.sh"; echo "$CMD"; } | "${SSH[@]}" "root@$IP" 'bash -s' 2>&1 | sed -u 's/^/  vm| /' | sed -E 's/(tskey-[A-Za-z0-9-]+|sk-ant-[A-Za-z0-9_-]+)/***/g'
[ "${PIPESTATUS[1]}" = 0 ] || { echo "installer failed" >&2; exit 1; }

say "verifying (mode: $MODE)"
scp -q -i "$TMP/key" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR scripts/e2e-verify.sh "root@$IP:/root/e2e-verify.sh"
"${SSH[@]}" "root@$IP" "E2E_REPO_URL=https://github.com/harijoe/bivouac.git E2E_REPO_BRANCH=example-app E2E_GH_TOKEN='$GITHUB_TOKEN' bash /root/e2e-verify.sh $MODE" 2>&1 | sed -u 's/^/  vm| /'
[ "${PIPESTATUS[0]}" = 0 ] || { echo "verification failed" >&2; exit 1; }

if [ "$MODE" = fake ]; then
  say "re-running the installer on the same VM (idempotency / update)"
  { cat "$TMP/env.sh"; echo "$CMD"; } | "${SSH[@]}" "root@$IP" 'bash -s' 2>&1 | tail -12 | sed -u 's/^/  vm| /'
  [ "${PIPESTATUS[1]}" = 0 ] || { echo "second install run failed" >&2; exit 1; }
  "${SSH[@]}" "root@$IP" 'curl -fsS http://$(grep ^BIVOUAC_LISTEN_IP /etc/bivouac/bivouac.env | cut -d= -f2):3000/api/health' >/dev/null
  say "uninstall"
  "${SSH[@]}" "root@$IP" 'bash /opt/bivouac/uninstall.sh --purge >/dev/null && ! docker ps -a --format {{.Names}} | grep -q bivouac && [ ! -e /var/lib/bivouac ]'
fi
say "E2E PASSED ($MODE)"
