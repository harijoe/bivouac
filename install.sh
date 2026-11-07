#!/usr/bin/env bash
# bivouac installer — Ubuntu 22.04 / 24.04. Idempotent: re-run it to update.
#
#   curl -fsSL https://raw.githubusercontent.com/harijoe/bivouac/main/install.sh | sudo bash
#
# Non-interactive configuration (environment variables):
#   TS_AUTHKEY                 Tailscale auth key (otherwise a login URL is printed)
#   CLAUDE_CODE_OAUTH_TOKEN    from `claude setup-token`   } at least one, or set it later
#   ANTHROPIC_API_KEY          Anthropic API key           } in the dashboard
#   BIVOUAC_DOMAIN             base domain for previews (default: <tailscale-ip>.sslip.io)
#   BIVOUAC_TLS                "cloudflare" to get Let's Encrypt certs via DNS-01 (needs CF_DNS_API_TOKEN + ACME_EMAIL)
#   BIVOUAC_VERSION            image tag to install (default: the version pinned in this script)
#   BIVOUAC_REGISTRY           image registry/namespace (default: ghcr.io/harijoe)
#   BIVOUAC_REGISTRY_USER / BIVOUAC_REGISTRY_TOKEN   registry credentials when images are private
#   BIVOUAC_CLAUDE_BIN         claude binary inside task containers (default: claude; tests use /opt/bivouac/fake-claude)
#   BIVOUAC_LISTEN_IP          IP to listen on (default: Tailscale IPv4). Use 0.0.0.0 ONLY if you know what you are doing.
#   BIVOUAC_SKIP_TAILSCALE=1   do not install/configure Tailscale (requires BIVOUAC_LISTEN_IP)
#   BIVOUAC_NONINTERACTIVE=1   never prompt
set -euo pipefail

DEFAULT_VERSION="0.1.0"
BV_VERSION="${BIVOUAC_VERSION:-$DEFAULT_VERSION}"
REGISTRY="${BIVOUAC_REGISTRY:-ghcr.io/harijoe}"
ETC=/etc/bivouac
OPT=/opt/bivouac
DATA=/var/lib/bivouac
ENV_FILE="$ETC/bivouac.env"

log()  { printf '\033[1;33m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;31m!!\033[0m  %s\n' "$*" >&2; }
die()  { warn "$*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run as root (use sudo)."
[ -r /etc/os-release ] || die "Unsupported OS."
. /etc/os-release
if [ "${ID:-}" != "ubuntu" ] || { [ "${VERSION_ID:-}" != "24.04" ] && [ "${VERSION_ID:-}" != "22.04" ]; }; then
  die "Unsupported OS: ${PRETTY_NAME:-unknown}. bivouac supports Ubuntu 24.04 and 22.04."
fi
case "$(uname -m)" in x86_64|aarch64) ;; *) die "Unsupported CPU architecture: $(uname -m)";; esac

INTERACTIVE=0
if [ -z "${BIVOUAC_NONINTERACTIVE:-}" ] && [ -r /dev/tty ] && [ -t 1 ]; then INTERACTIVE=1; fi
# read from the terminal even when the script itself comes from a pipe (curl | bash)
ask() { # ask VAR "question" [secret]
  local var="$1" q="$2" secret="${3:-}" val=""
  [ "$INTERACTIVE" = 1 ] || return 0
  [ -z "${!var:-}" ] || return 0
  if [ -n "$secret" ]; then read -r -s -p "$q " val < /dev/tty || true; echo
  else read -r -p "$q " val < /dev/tty || true; fi
  [ -z "$val" ] || printf -v "$var" '%s' "$val"
}

# Keep values from a previous install (idempotent updates)
PREV_TOKEN=""
if [ -f "$ENV_FILE" ]; then
  while IFS='=' read -r k v; do
    case "$k" in
      BIVOUAC_ACCESS_TOKEN) PREV_TOKEN="$v";;
      BIVOUAC_VERSION|BIVOUAC_TASK_IMAGE|BIVOUAC_DAEMON_IMAGE|BIVOUAC_LISTEN_IP|BIVOUAC_PREVIEW_*|BIVOUAC_CERT_RESOLVER|BIVOUAC_DATA_DIR|"") ;;
      BIVOUAC_DOMAIN) case "$v" in *.sslip.io) ;; *) [ -n "${BIVOUAC_DOMAIN:-}" ] || export BIVOUAC_DOMAIN="$v";; esac;;
      *) if [ -n "$v" ] && [ -z "${!k:-}" ]; then export "$k=$v"; fi;;
    esac
  done < "$ENV_FILE"
  log "Existing installation found — updating to version $BV_VERSION"
fi

ask TS_AUTHKEY "Tailscale auth key (tskey-auth-…, empty = print a login URL):" secret
ask CLAUDE_CODE_OAUTH_TOKEN "Claude token from 'claude setup-token' (empty = use an API key or set later):" secret
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then ask ANTHROPIC_API_KEY "Anthropic API key (empty = skip):" secret; fi
ask BIVOUAC_DOMAIN "Custom preview domain (empty = <tailscale-ip>.sslip.io):"

export DEBIAN_FRONTEND=noninteractive
log "Installing prerequisites"
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg openssl jq >/dev/null

# ---- Docker (official repository)
if ! command -v docker >/dev/null 2>&1; then
  log "Installing Docker"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker compose version >/dev/null 2>&1 || die "docker compose plugin is missing (install docker-compose-plugin)."

# ---- Tailscale
LISTEN_IP="${BIVOUAC_LISTEN_IP:-}"
if [ -z "${BIVOUAC_SKIP_TAILSCALE:-}" ]; then
  if ! command -v tailscale >/dev/null 2>&1; then
    log "Installing Tailscale"
    curl -fsSL https://tailscale.com/install.sh | sh >/dev/null
  fi
  systemctl enable --now tailscaled >/dev/null 2>&1 || true
  if ! tailscale ip -4 >/dev/null 2>&1; then
    if [ -n "${TS_AUTHKEY:-}" ]; then
      log "Joining the tailnet"
      tailscale up --authkey "$TS_AUTHKEY" --hostname "${BIVOUAC_TS_HOSTNAME:-bivouac}" ${BIVOUAC_TS_TAGS:+--advertise-tags "$BIVOUAC_TS_TAGS"} >/dev/null
    else
      log "Tailscale is not connected. Log in with the URL below (this command waits)."
      tailscale up --hostname "${BIVOUAC_TS_HOSTNAME:-bivouac}"
    fi
  fi
  for _ in $(seq 1 30); do tailscale ip -4 >/dev/null 2>&1 && break; sleep 1; done
  TS_IP="$(tailscale ip -4 | head -n1)"
  [ -n "$TS_IP" ] || die "Could not get a Tailscale IPv4 address."
  [ -n "$LISTEN_IP" ] || LISTEN_IP="$TS_IP"
else
  [ -n "$LISTEN_IP" ] || die "BIVOUAC_SKIP_TAILSCALE requires BIVOUAC_LISTEN_IP."
  TS_IP="$LISTEN_IP"
fi

# ---- system user and directories
id bivouac >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin bivouac
install -d -m 0755 "$OPT" "$DATA" "$DATA/projects"
install -d -m 0700 "$ETC" "$DATA/traefik"

# ---- configuration
TOKEN="${PREV_TOKEN:-$(openssl rand -hex 24)}"
DOMAIN="${BIVOUAC_DOMAIN:-$(echo "$TS_IP" | tr . -).sslip.io}"
SCHEME=http; PREVIEW_PORT=80; RESOLVER=""
if [ "${BIVOUAC_TLS:-}" = "cloudflare" ]; then
  [ -n "${CF_DNS_API_TOKEN:-}" ] && [ -n "${ACME_EMAIL:-}" ] || die "BIVOUAC_TLS=cloudflare needs CF_DNS_API_TOKEN and ACME_EMAIL."
  [ -n "${BIVOUAC_DOMAIN:-}" ] || die "BIVOUAC_TLS=cloudflare needs BIVOUAC_DOMAIN."
  SCHEME=https; PREVIEW_PORT=443; RESOLVER=le
fi
TASK_IMAGE="$REGISTRY/bivouac-task:$BV_VERSION"
DAEMON_IMAGE="$REGISTRY/bivouac-daemon:$BV_VERSION"

umask 077
cat > "$ENV_FILE" <<EOF
BIVOUAC_VERSION=$BV_VERSION
BIVOUAC_ACCESS_TOKEN=$TOKEN
BIVOUAC_LISTEN_IP=$LISTEN_IP
BIVOUAC_DOMAIN=$DOMAIN
BIVOUAC_PREVIEW_SCHEME=$SCHEME
BIVOUAC_PREVIEW_PORT=$PREVIEW_PORT
BIVOUAC_CERT_RESOLVER=$RESOLVER
BIVOUAC_TASK_IMAGE=$TASK_IMAGE
BIVOUAC_DAEMON_IMAGE=$DAEMON_IMAGE
BIVOUAC_CLAUDE_BIN=${BIVOUAC_CLAUDE_BIN:-claude}
BIVOUAC_DATA_DIR=$DATA
BIVOUAC_MAX_PARALLEL=${BIVOUAC_MAX_PARALLEL:-4}
ACME_EMAIL=${ACME_EMAIL:-}
CF_DNS_API_TOKEN=${CF_DNS_API_TOKEN:-}
CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_CODE_OAUTH_TOKEN:-}
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
EOF
chmod 600 "$ENV_FILE"; umask 022

# ---- docker compose file (Traefik + daemon)
TLS_FLAGS=""; HTTPS_PORT=""
if [ "$SCHEME" = https ]; then
  TLS_FLAGS='
      - --entrypoints.websecure.address=:443
      - --certificatesresolvers.le.acme.dnschallenge=true
      - --certificatesresolvers.le.acme.dnschallenge.provider=cloudflare
      - --certificatesresolvers.le.acme.email=${ACME_EMAIL}
      - --certificatesresolvers.le.acme.storage=/letsencrypt/acme.json'
  HTTPS_PORT='
      - "${BIVOUAC_LISTEN_IP}:443:443"'
fi
cat > "$OPT/docker-compose.yml" <<EOF
# Generated by install.sh — edit /etc/bivouac/bivouac.env instead of this file.
name: bivouac
services:
  traefik:
    image: traefik:v3.6
    container_name: bivouac-traefik
    restart: unless-stopped
    command:
      - --providers.docker=true
      - --providers.docker.exposedbydefault=false
      - --providers.docker.constraints=Label(\`bivouac.managed\`,\`true\`)
      - --entrypoints.web.address=:80$TLS_FLAGS
      - --log.level=INFO
    environment:
      - CF_DNS_API_TOKEN=\${CF_DNS_API_TOKEN:-}
    ports:
      - "\${BIVOUAC_LISTEN_IP}:80:80"$HTTPS_PORT
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - $DATA/traefik:/letsencrypt
  daemon:
    image: \${BIVOUAC_DAEMON_IMAGE}
    container_name: bivouac-daemon
    restart: unless-stopped
    env_file: $ENV_FILE
    environment:
      - BIVOUAC_PORT=3000
      - BIVOUAC_BIND=0.0.0.0
      - BIVOUAC_TRAEFIK_CONTAINER=bivouac-traefik
    ports:
      - "\${BIVOUAC_LISTEN_IP}:3000:3000"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - $DATA:$DATA
    depends_on: [traefik]
EOF

# ---- systemd unit
cat > /etc/systemd/system/bivouac.service <<EOF
[Unit]
Description=bivouac (Traefik + daemon via docker compose)
Requires=docker.service
After=docker.service network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$OPT
EnvironmentFile=$ENV_FILE
ExecStartPre=/bin/sh -c 'for i in \$\$(seq 1 60); do ip -4 addr show | grep -q "inet \${BIVOUAC_LISTEN_IP}/" && exit 0; sleep 1; done; exit 1'
ExecStart=/usr/bin/docker compose up -d --remove-orphans
ExecStop=/usr/bin/docker compose down
TimeoutStartSec=300

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload

# ---- images
if [ -n "${BIVOUAC_REGISTRY_TOKEN:-}" ]; then
  log "Logging in to ${REGISTRY%%/*}"
  echo "$BIVOUAC_REGISTRY_TOKEN" | docker login "${REGISTRY%%/*}" -u "${BIVOUAC_REGISTRY_USER:-bivouac}" --password-stdin >/dev/null
fi
log "Pulling images (version $BV_VERSION)"
docker image inspect "$DAEMON_IMAGE" >/dev/null 2>&1 || docker pull -q "$DAEMON_IMAGE" >/dev/null || die "Cannot pull $DAEMON_IMAGE (private registry? set BIVOUAC_REGISTRY_USER / BIVOUAC_REGISTRY_TOKEN)."
docker image inspect "$TASK_IMAGE" >/dev/null 2>&1 || docker pull -q "$TASK_IMAGE" >/dev/null || die "Cannot pull $TASK_IMAGE."
docker pull -q traefik:v3.6 >/dev/null
ln -sf "$ENV_FILE" "$OPT/.env"
docker run --rm --entrypoint cat "$DAEMON_IMAGE" /app/uninstall.sh > "$OPT/uninstall.sh" && chmod 755 "$OPT/uninstall.sh"

# ---- start
log "Starting bivouac"
systemctl enable bivouac.service >/dev/null 2>&1
systemctl restart bivouac.service

log "Waiting for the daemon to become healthy"
ok=0
for _ in $(seq 1 90); do
  if curl -fsS "http://$LISTEN_IP:3000/api/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
if [ "$ok" != 1 ]; then
  docker compose -f "$OPT/docker-compose.yml" logs --tail 40 daemon >&2 || true
  die "The daemon did not become healthy. See: docker logs bivouac-daemon"
fi

cat <<EOF

  ⛺ bivouac $BV_VERSION is running.

  Dashboard:     http://$LISTEN_IP:3000   (reachable from devices on your tailnet)
  Access token:  $TOKEN
  Previews:      ${SCHEME}://t-<id>.<project>.$DOMAIN$( [ "$PREVIEW_PORT" = 80 ] || [ "$PREVIEW_PORT" = 443 ] || echo ":$PREVIEW_PORT" )
  Config:        $ENV_FILE
  Logs:          docker logs -f bivouac-daemon
  Uninstall:     sudo bash $OPT/uninstall.sh

EOF
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}${ANTHROPIC_API_KEY:-}" ]; then
  warn "No Claude credentials configured yet — add them in the dashboard or in $ENV_FILE."
fi
