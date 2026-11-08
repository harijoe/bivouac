# Shared by the e2e scripts: disposable Hetzner Cloud server, always destroyed on exit. Source it, then call vm_up.
# Needs HCLOUD_TOKEN. Servers and keys are prefixed bivouac-dev-e2e-; the reserved primary IP is never deleted.
API=https://api.hetzner.cloud/v1
PRIMARY_IP_ID=161046145
hc() { curl -fsS -H "Authorization: Bearer $HCLOUD_TOKEN" -H 'Content-Type: application/json' "$@"; }
say() { printf '\n\033[1;36m[e2e %s]\033[0m %s\n' "${NAME:-?}" "$*"; }
SERVER_ID=""; KEY_ID=""; IP=""; TMP="$(mktemp -d)"; RUN="$(date +%s)-$RANDOM"
SSH=(ssh -i "$TMP/key" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ServerAliveInterval=15 -o ConnectTimeout=10)
SSHR() { "${SSH[@]}" "root@$IP" "$@"; }

vm_cleanup() {
  local rc=$?
  set +e
  say "cleanup (exit code $rc)"
  if [ "$rc" != 0 ] && [ -n "$IP" ]; then
    say "diagnostics from the VM"
    timeout 60 "${SSH[@]}" "root@$IP" 'cat /var/lib/bivouac/web/update-status.json 2>/dev/null; echo; tail -n 60 /var/lib/bivouac/update.log 2>/dev/null; docker ps -a --format "{{.Names}} {{.Status}}" | head -20; docker logs --tail 15 bivouac-web 2>&1 | cut -c1-200' 2>&1 | sed 's/^/  diag| /'
  fi
  [ -n "$SERVER_ID" ] && hc -X DELETE "$API/servers/$SERVER_ID" >/dev/null && say "server $SERVER_ID deleted"
  for _ in $(seq 1 30); do [ -z "$SERVER_ID" ] && break; hc "$API/servers/$SERVER_ID" >/dev/null 2>&1 || break; sleep 2; done
  [ -n "$KEY_ID" ] && hc -X DELETE "$API/ssh_keys/$KEY_ID" >/dev/null && say "ssh key $KEY_ID deleted"
  left=$(hc "$API/servers?label_selector=purpose%3Dbivouac-dev-e2e" | jq -r '.servers[].name' | grep -c "$RUN")
  [ "$left" = 0 ] && say "no leftover resource" || say "WARNING: leftover server(s) for run $RUN"
  rm -rf "$TMP"
  exit $rc
}
trap vm_cleanup EXIT
trap 'exit 130' INT TERM

vm_up() { # [--domain]
  NAME="bivouac-dev-e2e-$RUN"
  hc "$API/servers?label_selector=purpose%3Dbivouac-dev-e2e" | jq -r --argjson cutoff "$(( $(date +%s) - 10800 ))" '.servers[] | select(.name|startswith("bivouac-dev-e2e-")) | select((.created|fromdateiso8601) < $cutoff) | .id' | while read -r id; do
    say "deleting stale server $id"; hc -X DELETE "$API/servers/$id" >/dev/null || true
  done
  say "creating SSH key and server"
  ssh-keygen -q -t ed25519 -N '' -f "$TMP/key"
  KEY_ID=$(hc -X POST "$API/ssh_keys" -d "$(jq -n --arg n "$NAME" --arg k "$(cat "$TMP/key.pub")" '{name:$n,public_key:$k,labels:{purpose:"bivouac-dev-e2e"}}')" | jq -r .ssh_key.id)
  local type location=nbg1 pubnet='{"enable_ipv6":false}'
  type="${HCLOUD_TYPE:-$(hc "$API/server_types?per_page=50" | jq -r '[.server_types[] | select(.deprecated != true and .architecture=="x86" and .cores>=2 and .memory>=4 and .cpu_type=="shared")] | sort_by(.prices[0].price_hourly.gross|tonumber) | .[0].name')}"
  if [ "${1:-}" = --domain ]; then
    local assigned; assigned=$(hc "$API/primary_ips/$PRIMARY_IP_ID" | jq -r '.primary_ip.assignee_id // empty')
    [ -z "$assigned" ] || { echo "reserved primary IP is still attached to server $assigned" >&2; exit 1; }
    pubnet=$(jq -n --argjson ip "$PRIMARY_IP_ID" '{enable_ipv4:true,enable_ipv6:false,ipv4:$ip}')
  fi
  say "server type: $type in $location"
  local resp
  resp=$(hc -X POST "$API/servers" -d "$(jq -n --arg n "$NAME" --arg t "$type" --arg l "$location" --argjson k "$KEY_ID" --argjson pn "$pubnet" '{name:$n,server_type:$t,image:"ubuntu-24.04",location:$l,ssh_keys:[$k],labels:{purpose:"bivouac-dev-e2e"},public_net:$pn}')")
  SERVER_ID=$(echo "$resp" | jq -r .server.id)
  IP=$(echo "$resp" | jq -r .server.public_net.ipv4.ip)
  say "server $SERVER_ID at $IP"
  for _ in $(seq 1 60); do "${SSH[@]}" "root@$IP" true 2>/dev/null && break; sleep 3; done
  SSHR 'grep PRETTY /etc/os-release'
}
