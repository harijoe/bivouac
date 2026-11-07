#!/usr/bin/env bash
# Runs ON the freshly installed VM (copied there by e2e-fresh-vps.sh).
# Usage: e2e-verify.sh fake|real   — env: E2E_REPO_URL E2E_REPO_BRANCH E2E_GH_TOKEN
set -euo pipefail
MODE="${1:-fake}"
. /etc/bivouac/bivouac.env
BASE="http://$BIVOUAC_LISTEN_IP:3000"
AUTH=(-H "Authorization: Bearer $BIVOUAC_ACCESS_TOKEN")
J=(-H "content-type: application/json")
say() { printf '\n[verify] %s\n' "$*"; }
fail() { printf '\n[verify] FAIL: %s\n' "$*" >&2; docker logs --tail 60 bivouac-daemon >&2 || true; exit 1; }
api() { curl -fsS "${AUTH[@]}" "${J[@]}" "$@"; }

say "health"
curl -fsS "$BASE/api/health" | jq -e '.ok == true' >/dev/null || fail "health"
say "dashboard served"
curl -fsS "$BASE/" | grep -q '<div id="root">' || fail "dashboard html missing"
say "api requires the token"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/projects")" = 401 ] || fail "API reachable without token"
say "daemon is not listening on the public interface"
pub="$(ip -4 route get 1.1.1.1 | grep -oP 'src \K\S+')"
if [ "$pub" != "$BIVOUAC_LISTEN_IP" ] && curl -s -m 3 -o /dev/null "http://$pub:3000/api/health"; then fail "daemon reachable on public IP $pub"; fi

say "add project"
P=$(api -X POST "$BASE/api/projects" -d "$(jq -n --arg u "$E2E_REPO_URL" --arg b "$E2E_REPO_BRANCH" --arg t "$E2E_GH_TOKEN" '{repoUrl:$u,defaultBranch:$b,githubToken:$t,name:"example"}')")
PID=$(echo "$P" | jq -r .id)

wait_status() { # id expected timeout
  local id="$1" want="$2" end=$(( $(date +%s) + $3 )) st
  while [ "$(date +%s)" -lt "$end" ]; do
    st=$(api "$BASE/api/tasks/$id" | jq -r .status)
    case "$st" in "$want") return 0;; failed|budget_exceeded|max_iterations|stopped) [ "$st" = "$want" ] || { api "$BASE/api/tasks/$id" | jq . >&2; api "$BASE/api/tasks/$id/events" | jq -c '.[] | select(.kind=="check" or .kind=="error" or .kind=="status")' | tail -20 >&2; fail "task $id ended as $st (wanted $want)"; };; esac
    sleep 3
  done
  fail "timeout waiting for task $id to be $want (last: $st)"
}
preview_ok() { # url-host
  local host="$1" end=$(( $(date +%s) + 240 ))
  while [ "$(date +%s)" -lt "$end" ]; do
    if curl -fsS -m 5 "http://$host/" 2>/dev/null | grep -q '<div id="root">'; then return 0; fi
    sleep 3
  done
  return 1
}

if [ "$MODE" = fake ]; then
  say "create two parallel tasks"
  T1=$(api -X POST "$BASE/api/projects/$PID/tasks" -d '{"prompt":"first task FAKE_SCENARIO=succeed"}')
  T2=$(api -X POST "$BASE/api/projects/$PID/tasks" -d '{"prompt":"second task FAKE_SCENARIO=fail-then-succeed","successCommand":"grep -q ok fake-output.txt && pnpm test"}')
  ID1=$(echo "$T1" | jq -r .id); ID2=$(echo "$T2" | jq -r .id)
  U1=$(echo "$T1" | jq -r .previewUrl); U2=$(echo "$T2" | jq -r .previewUrl)
  say "previews: $U1 $U2"
  [ "$U1" != "$U2" ] || fail "same preview URL"
  H1=${U1#http://}; H2=${U2#http://}
  preview_ok "$H1" || fail "preview 1 does not answer ($H1) — sslip.io resolution or Traefik routing"
  preview_ok "$H2" || fail "preview 2 does not answer ($H2)"
  wait_status "$ID1" succeeded 600
  wait_status "$ID2" succeeded 600
  [ "$(api "$BASE/api/tasks/$ID1" | jq .iteration)" = 1 ] || fail "task 1 iteration"
  [ "$(api "$BASE/api/tasks/$ID2" | jq .iteration)" = 2 ] || fail "task 2 should need 2 iterations"
  c1=$(api "$BASE/api/tasks/$ID1/events" | jq '[.[]|select(.kind=="check")]|length'); [ "$c1" = 1 ] || fail "task 1 checks=$c1"
  say "task containers are non-root and have no docker socket"
  for id in $ID1 $ID2; do
    [ "$(docker inspect -f '{{.Config.User}}' bivouac-task-$id)" = node ] || fail "task $id not running as node"
    docker inspect -f '{{range .HostConfig.Binds}}{{.}} {{end}}' bivouac-task-$id | grep -q docker.sock && fail "docker.sock mounted in task $id"
  done
  say "independent files"
  [ "$(docker exec bivouac-task-$ID1 cat /workspace/repo/fake-output.txt)" = ok ] || fail "fake output 1"
  curl -fsS "http://$H1/src/App.tsx" >/dev/null || fail "dev server source not served"
  say "totals"
  api "$BASE/api/totals" | jq -e '.tasks == 2 and .costUsd > 0' >/dev/null || fail "totals"
  say "delete task cleans container + dir"
  api -X DELETE "$BASE/api/tasks/$ID1?force=1" >/dev/null
  docker inspect bivouac-task-$ID1 >/dev/null 2>&1 && fail "container of deleted task still exists"
  [ ! -e "/var/lib/bivouac/projects/example/tasks/t-$ID1" ] || fail "task dir still exists"
else
  say "real CLI task"
  T=$(api -X POST "$BASE/api/projects/$PID/tasks" -d '{"prompt":"Add a button labelled \"Increment\" that increments a counter displayed next to it, and add a test for it.","maxCostUsd":3,"maxIterations":4}')
  ID=$(echo "$T" | jq -r .id); U=$(echo "$T" | jq -r .previewUrl)
  say "task t-$ID, preview $U"
  preview_ok "${U#http://}" || fail "preview does not answer"
  wait_status "$ID" succeeded 1500
  api "$BASE/api/tasks/$ID" | jq '{status,iteration,usage}'
  curl -fsS "${U}/src/App.tsx" | grep -qi 'button' || fail "preview does not contain the new button"
  api "$BASE/api/tasks/$ID/events" | jq -e '[.[]|select(.kind=="tool_use")]|length > 0' >/dev/null || fail "no tool use recorded"
  api "$BASE/api/tasks/$ID" | jq -e '.usage.costUsd > 0 and .usage.outputTokens > 0' >/dev/null || fail "no usage recorded"
fi
say "OK ($MODE)"
