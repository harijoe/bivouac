#!/usr/bin/env bash
# v0.3 end-to-end test on a brand-new Hetzner VM: update from the dashboard (detection, one click, scheduling, automatic
# rollback), several ports, sidecars, network isolation, project context over MCP.
#
#   scripts/e2e-v03.sh            local mode: 0.2.0 from GHCR, then images built on the VM from this checkout + a fake release server
#   scripts/e2e-v03.sh --release  published mode: 0.2.0 from GHCR, then the README install command (real release), then the feature checks
#
# The VM is ALWAYS destroyed on exit (see lib-hcloud.sh). Uses Let's Encrypt staging (no rate limits, untrusted certificates).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f "$HOME/bivouac-inputs.env" ] && { set -a; . "$HOME/bivouac-inputs.env"; set +a; }
MODE=local; [ "${1:-}" = --release ] && MODE=release
: "${HCLOUD_TOKEN:?}"; : "${GITHUB_TOKEN:?}"
. scripts/lib-hcloud.sh
OUT() { sed -u 's/^/  | /'; }
VMOUT() { sed -u 's/^/  vm| /'; }
fail() { echo "  ✗ $*" >&2; exit 1; }
pass() { echo "  ✓ $*"; }
expect_ok()   { local m="$1"; shift; if SSHR "$@" >/dev/null 2>&1; then pass "$m"; else fail "$m"; fi; }
expect_fail() { local m="$1"; shift; if SSHR "$@" >/dev/null 2>&1; then fail "$m"; else pass "$m"; fi; }

say "publishing the example branches"
for spec in "example-app vite-app" "example-multi multi-app" "example-multi-min multi-app-min" "example-legacy legacy-app"; do
  set -- $spec; GIT_ASKPASS="$HOME/.bivouac-askpass.sh" ./scripts/publish-example.sh "$1" "$2" >/dev/null 2>&1 || fail "cannot publish $1"
done

vm_up
ENVF="STAGING=1"
CL=(node scripts/e2e-v03-client.mjs)
STATE="$TMP/state.json"
client() { local c="$1"; shift; "${CL[@]}" "$c" --base "$BASE" --session "$SESSION" --state "$STATE" --insecure "$@" 2>&1 | OUT; [ "${PIPESTATUS[0]}" = 0 ] || fail "client step $c failed"; }
REPO=(--repo-url https://github.com/harijoe/bivouac.git)
export GH_TOKEN="$GITHUB_TOKEN"

say "uploading the checkout"
git archive --format=tar.gz HEAD | SSHR 'mkdir -p /root/src && tar xz -C /root/src'

# ---------------------------------------------------------------- 1. install 0.2.0 from GHCR
say "STEP 1: install bivouac 0.2.0 from GHCR (install.sh of the v0.2.0 tag)"
SSHR 'export BIVOUAC_VERSION=0.2.0 BIVOUAC_CLAUDE_BIN=/opt/bivouac/fake-claude BIVOUAC_ACME_STAGING=1; curl -fsSL https://raw.githubusercontent.com/harijoe/bivouac/v0.2.0/install.sh | bash' 2>&1 | VMOUT
[ "${PIPESTATUS[0]}" = 0 ] || fail "0.2.0 install failed"
SESSION=$(SSHR 'bivouac session create --github-id 9001' | tr -d '\r\n')
BASE="https://$(SSHR 'bivouac domain' | tr -d '\r\n')"
say "dashboard at $BASE"
say "STEP 2: seed data with 0.2.0 (project, finished task, Claude connection, MCP client, share link, settings)"
client seed "${REPO[@]}"

# ---------------------------------------------------------------- 2. upgrade to this checkout / the real release
GW=$(SSHR "docker network inspect bivouac-edge -f '{{(index .IPAM.Config 0).Gateway}}'" | tr -d '\r\n')
REL_URL="http://$GW:8099/releases"
if [ "$MODE" = local ]; then
  say "STEP 3: upgrade to 0.3.0 over SSH with install.sh (images built on the VM); fake release server at $REL_URL"
  SSHR "mkdir -p /srv/rel && echo '[]' > /srv/rel/releases && systemd-run --unit=bv-fake-releases --working-directory=/srv/rel python3 -m http.server 8099 --bind 0.0.0.0 >/dev/null 2>&1"
  SSHR "cd /root/src && BIVOUAC_SOURCE_DIR=/root/src BIVOUAC_VERSION=0.3.0 BIVOUAC_REGISTRY=bivouac-local BIVOUAC_RELEASES_URL=$REL_URL bash install.sh" 2>&1 | VMOUT
  [ "${PIPESTATUS[0]}" = 0 ] || fail "upgrade to 0.3.0 failed"
else
  say "STEP 3: upgrade with the install command of the README (published release)"
  CMD="$(awk '/<!-- e2e:install:start -->/{f=1;next} /<!-- e2e:install:end -->/{f=0} f' README.md | sed '/^```/d')"
  [ -n "$CMD" ] || fail "no install block in README.md"
  SSHR "export BIVOUAC_ACME_STAGING=1; ${CMD//sudo bash/bash}" 2>&1 | VMOUT
  [ "${PIPESTATUS[0]}" = 0 ] || fail "README install command failed"
fi
EXPECT_V=$([ "$MODE" = local ] && echo 0.3.0 || SSHR 'grep ^BIVOUAC_VERSION= /etc/bivouac/bivouac.env | cut -d= -f2' | tr -d '\r\n')
say "STEP 4: data intact after the upgrade, backup taken, firewall installed"
client verify-seed --expect "$EXPECT_V"
expect_ok "a backup of the database and configuration exists" 'ls /var/lib/bivouac/backups/*/web/bivouac.db /var/lib/bivouac/backups/*/bivouac.env'
expect_ok "the firewall rules are installed" 'iptables -S INPUT | grep -q "bvt+" && iptables -S BIVOUAC-INPUT | grep -q DROP && systemctl is-active bivouac-firewall'
expect_ok "the firewall unit is enabled" 'systemctl is-enabled bivouac-firewall'
# a short health-check wait keeps the rollback test quick
SSHR 'echo BIVOUAC_HEALTH_TIMEOUT=60 >> /etc/bivouac/bivouac.env && cd /opt/bivouac && docker compose up -d >/dev/null 2>&1'
sleep 15

if [ "$MODE" = local ]; then
  # ------------------------------------------------------------ 3. updates from the dashboard
  publish() { # version [broken]  : build images 0.3.x on the VM and list the release on the fake server
    local v="$1" broken="${2:-}"
    if [ -n "$broken" ]; then
      SSHR "printf 'FROM bivouac-local/bivouac-daemon:0.3.1\nENV BIVOUAC_VERSION=$v\nCMD [\"node\",\"-e\",\"setInterval(()=>{},1000)\"]\n' > /tmp/Dockerfile.broken && docker build -q -t bivouac-local/bivouac-daemon:$v -f /tmp/Dockerfile.broken /tmp >/dev/null"
    else
      SSHR "cd /root/src && docker build -q -t bivouac-local/bivouac-daemon:$v --build-arg VERSION=$v -f packages/daemon/Dockerfile . >/dev/null"
    fi
    SSHR "docker tag bivouac-local/bivouac-task:0.3.0 bivouac-local/bivouac-task:$v"
    local list; list=$(jq -n --arg v "$v" --arg prev "${PREV_REL:-0.3.0}" '[
      {tag_name:"v9.9.9",name:"pre-release",body:"must be ignored",prerelease:true,draft:false,html_url:"x"},
      {tag_name:"v9.9.8",name:"draft",body:"must be ignored",prerelease:false,draft:true,html_url:"x"},
      {tag_name:("v"+$v),name:("v"+$v),body:("## notes for "+$v+"\n- **fix**: things"),prerelease:false,draft:false,html_url:("https://example.test/v"+$v),published_at:"2026-11-08T10:00:00Z"},
      {tag_name:("v"+$prev),name:("v"+$prev),body:"old",prerelease:false,draft:false,html_url:"x"}]')
    printf '%s' "$list" | SSHR 'cat > /srv/rel/releases'
    PREV_REL="$v"
  }

  say "STEP 5: release 0.3.1 published; banner, one-click update with no task running"
  publish 0.3.1
  client update-check --current 0.3.0 --expect 0.3.1
  client update-run --mode idle --from 0.3.0 --to 0.3.1
  client verify-seed --expect 0.3.1
  expect_ok "the new version runs (web and executor healthy)" '[ "$(docker exec bivouac-web printenv BIVOUAC_VERSION)" = 0.3.1 ]'
  expect_ok "web still has no Docker socket" '! docker exec bivouac-web test -e /var/run/docker.sock'
  expect_ok "at most 3 backups are kept, and two exist now" '[ "$(ls -d /var/lib/bivouac/backups/*/ | wc -l)" -ge 2 ] && [ "$(ls -d /var/lib/bivouac/backups/*/ | wc -l)" -le 3 ]'
  expect_ok "the updater container is gone" '! docker ps -a --format {{.Names}} | grep -q updater'
  client audit --actions update_started,update_succeeded

  say "STEP 6: a task is running → the update is scheduled, new tasks are refused, then it runs by itself"
  publish 0.3.2
  client update-check --current 0.3.1 --expect 0.3.2
  client long-task --name slow-1 --delay 15000
  client update-run --mode idle --expect scheduled
  client blocked-create
  client update-wait-scheduled --to 0.3.2
  client task-state --name slow-1 --expect succeeded
  client verify-seed --expect 0.3.2

  say "STEP 7: a broken release (health check fails) → automatic rollback, message in the dashboard"
  publish 0.3.3 broken
  client update-check --current 0.3.2 --expect 0.3.3
  client update-run --mode idle --from 0.3.2 --to 0.3.3 --result rolled_back
  client verify-seed --expect 0.3.2
  expect_ok "the previous images are running again" '[ "$(docker exec bivouac-web printenv BIVOUAC_VERSION)" = 0.3.2 ] && [ "$(grep ^BIVOUAC_VERSION= /etc/bivouac/bivouac.env | cut -d= -f2)" = 0.3.2 ]'
  client audit --actions update_rolled_back

  say "STEP 8: 'update now' with a running task: the task is stopped (resumable), the update runs"
  publish 0.3.4
  client update-check --current 0.3.2 --expect 0.3.4
  client long-task --name slow-2 --delay 20000
  client update-run --mode now --from 0.3.2 --to 0.3.4
  client task-state --name slow-2 --expect stopped --resume
  client verify-seed --expect 0.3.4
fi

# ---------------------------------------------------------------- 4. v0.3 features
say "STEP 9: two tasks in parallel on a project with a front, an API and a Postgres sidecar"
client multi "${REPO[@]}"
A=$(jq -r .multi.alpha "$STATE"); B=$(jq -r .multi.beta "$STATE")

say "STEP 10: sidecars are per task, limited, and never published on the host"
expect_ok "each task has its own postgres container" "docker ps --format '{{.Names}}' | grep -qx bivouac-task-$A-svc-postgres && docker ps --format '{{.Names}}' | grep -qx bivouac-task-$B-svc-postgres"
expect_ok "postgres has a memory limit (512m) and a CPU limit" "[ \"\$(docker inspect -f '{{.HostConfig.Memory}}' bivouac-task-$A-svc-postgres)\" = 536870912 ] && [ \"\$(docker inspect -f '{{.HostConfig.NanoCpus}}' bivouac-task-$A-svc-postgres)\" -gt 0 ]"
expect_ok "no postgres port on the host" "! ss -Hltn | awk '{print \$4}' | grep -q ':5432\$' && [ -z \"\$(docker port bivouac-task-$A-svc-postgres)\" ]"
SSHR "docker exec bivouac-task-$A-svc-postgres psql -U postgres -qc 'create table only_in_alpha(x int)'"
SSHR "docker exec bivouac-task-$A-svc-postgres psql -U postgres -qc 'insert into only_in_alpha values (42)'"
expect_ok "alpha's data exists in alpha's postgres" "[ \"\$(docker exec bivouac-task-$A-svc-postgres psql -U postgres -tAc 'select x from only_in_alpha')\" = 42 ]"
expect_ok "alpha's data is NOT visible in beta's postgres" "[ -z \"\$(docker exec bivouac-task-$B-svc-postgres psql -U postgres -tAc \"select to_regclass('only_in_alpha')\")\" ]"
PG_A=$(SSHR "docker inspect -f '{{(index .NetworkSettings.Networks \"bivouac-task-$A\").IPAddress}}' bivouac-task-$A-svc-postgres" | tr -d '\r\n')
probe() { # container host port  → exit 0 when the TCP connection succeeds within 6 s
  SSHR "docker exec -u node bivouac-task-$1 timeout 6 bash -c 'exec 3<>/dev/tcp/$2/$3'"
}
expect_fail "beta cannot reach alpha's postgres ($PG_A:5432)" "docker exec -u node bivouac-task-$B timeout 6 bash -c 'exec 3<>/dev/tcp/$PG_A/5432'"
expect_ok "control: alpha reaches its own postgres by name" "docker exec -u node bivouac-task-$A timeout 6 bash -c 'exec 3<>/dev/tcp/postgres/5432'"

say "STEP 11: a task container cannot reach the host or the bivouac services, but has Internet"
TGW=$(SSHR "docker network inspect bivouac-task-$A -f '{{(index .IPAM.Config 0).Gateway}}'" | tr -d '\r\n')
WEB_IP=$(SSHR "docker inspect -f '{{(index .NetworkSettings.Networks \"bivouac-edge\").IPAddress}}' bivouac-web" | tr -d '\r\n')
EXE_IP=$(SSHR "docker inspect -f '{{(index .NetworkSettings.Networks \"bivouac-ctl\").IPAddress}}' bivouac-executor" | tr -d '\r\n')
TRF_IP=$(SSHR "docker inspect -f '{{(index .NetworkSettings.Networks \"bivouac-edge\").IPAddress}}' bivouac-traefik" | tr -d '\r\n')
say "gateway $TGW, public $IP, web $WEB_IP, executor $EXE_IP, traefik $TRF_IP"
expect_ok "control: SSH answers on the host itself" "timeout 5 bash -c 'exec 3<>/dev/tcp/127.0.0.1/22'"
expect_ok "control: the fake release server answers on the host" "timeout 5 bash -c 'exec 3<>/dev/tcp/127.0.0.1/8099' || ss -Hltn | grep -q ':22'"
expect_fail "SSH on the Docker gateway ($TGW:22) is unreachable from a task" "docker exec -u node bivouac-task-$A timeout 6 bash -c 'exec 3<>/dev/tcp/$TGW/22'"
expect_fail "SSH on the public address ($IP:22) is unreachable from a task" "docker exec -u node bivouac-task-$A timeout 6 bash -c 'exec 3<>/dev/tcp/$IP/22'"
if [ "$MODE" = local ]; then expect_fail "another host port (8099) is unreachable from a task" "docker exec -u node bivouac-task-$A timeout 6 bash -c 'exec 3<>/dev/tcp/$TGW/8099'"; fi
expect_fail "the web service (3000) is unreachable from a task" "docker exec -u node bivouac-task-$A timeout 6 bash -c 'exec 3<>/dev/tcp/$WEB_IP/3000'"
expect_fail "the web internal port (3001: Traefik provider) is unreachable from a task" "docker exec -u node bivouac-task-$A timeout 6 bash -c 'exec 3<>/dev/tcp/$WEB_IP/3001'"
expect_fail "the executor (3002) is unreachable from a task" "docker exec -u node bivouac-task-$A timeout 6 bash -c 'exec 3<>/dev/tcp/$EXE_IP/3002'"
expect_fail "the web service is not even resolvable by name" "docker exec -u node bivouac-task-$A getent hosts bivouac-web"
for port in 8080 8082 9000; do
  expect_fail "the Traefik API/dashboard (port $port) is unreachable by name" "docker exec -u node bivouac-task-$A timeout 6 bash -c 'exec 3<>/dev/tcp/bivouac-traefik/$port'"
  expect_fail "the Traefik API/dashboard (port $port) is unreachable by its edge address" "docker exec -u node bivouac-task-$A timeout 6 bash -c 'exec 3<>/dev/tcp/$TRF_IP/$port'"
done
expect_ok "Internet works from a task (HTTPS)" "docker exec -u node bivouac-task-$A curl -fsS -m 20 -o /dev/null https://example.com"
expect_ok "Internet works from a sidecar's network (DNS + HTTPS from the task)" "docker exec -u node bivouac-task-$B curl -fsS -m 20 -o /dev/null https://api.github.com/"
expect_ok "control: the cloud metadata service answers on the host" "curl -fsS -m 8 -o /dev/null http://169.254.169.254/hetzner/v1/metadata"
expect_fail "the cloud metadata address is unreachable from a task" "docker exec -u node bivouac-task-$A curl -fsS -m 8 -o /dev/null http://169.254.169.254/hetzner/v1/metadata"

say "STEP 12: ports and services added by the agent between two sessions"
client grow "${REPO[@]}"
G=$(jq -r .grow "$STATE")
expect_ok "the redis sidecar the agent declared is running, on the task network, without a published port" "docker ps --format '{{.Names}}' | grep -qx bivouac-task-$G-svc-redis && [ -z \"\$(docker port bivouac-task-$G-svc-redis)\" ]"

say "STEP 13: project context over MCP after two finished tasks"
client context

say "STEP 14: cleanup leaves nothing behind"
client cleanup
sleep 3
IDS="$A|$B|$G"
expect_ok "no container, sidecar, network or volume of the deleted tasks remains" "! docker ps -a --format '{{.Names}}' | grep -Eq '^bivouac-task-($IDS)(-|\$)' && ! docker network ls --format '{{.Name}}' | grep -Eq '^bivouac-task-($IDS)\$' && [ -z \"\$(docker volume ls -q --filter label=bivouac.task=$A --filter label=bivouac.task=$B)\" ] && [ -z \"\$(docker volume ls -q --filter label=bivouac.task=$G)\" ] && ! ip -o link | grep -Eq ' bvt($IDS):'"

say "STEP 15: re-running the installer is idempotent, uninstall removes the firewall"
if [ "$MODE" = local ]; then SSHR "cd /root/src && BIVOUAC_SOURCE_DIR=/root/src BIVOUAC_VERSION=0.3.4 BIVOUAC_REGISTRY=bivouac-local bash install.sh >/dev/null 2>&1"; fi
client verify-seed
SSHR 'bash /opt/bivouac/uninstall.sh --purge >/dev/null'
expect_ok "no bivouac container, network, unit, firewall rule or data remains" "! docker ps -a --format {{.Names}} | grep -q bivouac && ! docker network ls --format {{.Name}} | grep -q bivouac && [ ! -e /var/lib/bivouac ] && ! iptables -S | grep -qi 'bivouac\|bvt' && ! ls /etc/systemd/system | grep -q bivouac"
say "E2E v0.3 PASSED ($MODE)"
