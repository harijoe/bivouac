#!/usr/bin/env bash
# bivouac installer: Ubuntu 22.04 / 24.04. No questions. Idempotent: re-run it to update (also from 0.1.x).
#
#   curl -fsSL https://raw.githubusercontent.com/harijoe/bivouac/main/install.sh | sudo bash
#
# Optional environment variables (all have sane defaults; used by tests and advanced installs):
#   BIVOUAC_DOMAIN             host name to serve (default: <public-ip-with-dashes>.sslip.io; the setup wizard can change it later)
#   BIVOUAC_PUBLIC_IP          public IPv4 (default: detected)
#   BIVOUAC_ACME_EMAIL         e-mail for Let's Encrypt expiry notices (optional)
#   BIVOUAC_ACME_STAGING=1     use the Let's Encrypt staging CA (tests: untrusted certificates, no rate limits)
#   BIVOUAC_VERSION            image tag to install (default: the version pinned in this script)
#   BIVOUAC_REGISTRY           image registry/namespace (default: ghcr.io/harijoe)
#   BIVOUAC_REGISTRY_USER / BIVOUAC_REGISTRY_TOKEN   registry credentials when images are private
#   CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY      preset Claude credentials (otherwise connect Claude in the wizard)
#   BIVOUAC_CLAUDE_BIN         claude binary inside task containers (default: claude; tests use /opt/bivouac/fake-claude)
#   BIVOUAC_MAX_PARALLEL       tasks running at once (default 4)
#   BIVOUAC_SOURCE_DIR         developer option: build the images from a source checkout instead of pulling them
set -euo pipefail

DEFAULT_VERSION="0.2.0"
BV_VERSION="${BIVOUAC_VERSION:-$DEFAULT_VERSION}"
REGISTRY="${BIVOUAC_REGISTRY:-ghcr.io/harijoe}"
ETC=/etc/bivouac
OPT=/opt/bivouac
DATA=/var/lib/bivouac
ENV_FILE="$ETC/bivouac.env"

log()  { printf '\033[1;33m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;31m!!\033[0m  %s\n' "$*" >&2; }
die()  { warn "$*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run as root: curl -fsSL <url> | sudo bash"
[ -r /etc/os-release ] || die "Unsupported OS."
. /etc/os-release
if [ "${ID:-}" != "ubuntu" ] || { [ "${VERSION_ID:-}" != "24.04" ] && [ "${VERSION_ID:-}" != "22.04" ]; }; then
  die "Unsupported OS: ${PRETTY_NAME:-unknown}. bivouac supports Ubuntu 24.04 and 22.04."
fi
case "$(uname -m)" in x86_64|aarch64) ;; *) die "Unsupported CPU architecture: $(uname -m)";; esac

# ---- values from a previous installation (so that re-running is a safe update)
PREV_EXEC_TOKEN=""; UPGRADED_FROM_01=0
if [ -f "$ENV_FILE" ]; then
  while IFS='=' read -r k v; do
    case "$k" in
      BIVOUAC_EXECUTOR_TOKEN) PREV_EXEC_TOKEN="$v";;
      BIVOUAC_ACCESS_TOKEN) UPGRADED_FROM_01=1;;
      CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|BIVOUAC_ACME_EMAIL|BIVOUAC_CLAUDE_BIN|BIVOUAC_MAX_PARALLEL|BIVOUAC_ACME_STAGING)
        if [ -n "$v" ] && [ -z "${!k:-}" ]; then export "$k=$v"; fi;;
    esac
  done < "$ENV_FILE"
  if [ "$UPGRADED_FROM_01" = 1 ]; then log "Existing bivouac 0.1 installation found: upgrading to $BV_VERSION (Tailscale is no longer used)"
  else log "Existing installation found: updating to $BV_VERSION"; fi
fi

export DEBIAN_FRONTEND=noninteractive
log "Installing prerequisites"
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg openssl jq qrencode >/dev/null

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

# ---- ports 80 and 443 must be ours
for p in 80 443; do
  owner="$(ss -Hltnp "sport = :$p" 2>/dev/null | grep -v docker-proxy | head -n1 || true)"
  if [ -n "$owner" ] && ! docker ps --format '{{.Names}}' | grep -qx bivouac-traefik; then
    die "Port $p is already used by another program on this server:
    $owner
  bivouac needs ports 80 and 443 for its secure (HTTPS) address. Stop that program or move it to another port, then run the installer again."
  fi
done

# ---- public address
IP="${BIVOUAC_PUBLIC_IP:-}"
if [ -z "$IP" ]; then
  for u in https://api.ipify.org https://ifconfig.me https://icanhazip.com; do
    IP="$(curl -4 -fsS --max-time 8 "$u" 2>/dev/null | tr -d '[:space:]' || true)"
    echo "$IP" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' && break || IP=""
  done
fi
[ -n "$IP" ] || die "Could not detect this server's public IPv4 address. Run again with BIVOUAC_PUBLIC_IP=<address>."
DOMAIN="${BIVOUAC_DOMAIN:-$(echo "$IP" | tr . -).sslip.io}"

# ---- directories and 0.1 data migration
install -d -m 0755 "$OPT" "$DATA" "$DATA/projects"
install -d -m 0700 "$ETC" "$DATA/traefik"
install -d -m 0700 -o 1000 -g 1000 "$DATA/web"
if [ -f "$DATA/bivouac.db" ] && [ ! -f "$DATA/web/bivouac.db" ]; then
  log "Migrating the 0.1 database"
  mv "$DATA"/bivouac.db* "$DATA/web/"; [ -f "$DATA/secret.key" ] && mv "$DATA/secret.key" "$DATA/web/"
  chown -R 1000:1000 "$DATA/web"
fi
if [ "$UPGRADED_FROM_01" = 1 ]; then
  # 0.1 task containers carry Traefik labels that no longer mean anything; workspaces on disk are kept
  docker ps -aq --filter label=bivouac.managed=true | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network ls -q --filter label=bivouac.managed=true | xargs -r docker network rm >/dev/null 2>&1 || true
fi

# ---- configuration
EXEC_TOKEN="${PREV_EXEC_TOKEN:-$(openssl rand -hex 24)}"
TASK_IMAGE="$REGISTRY/bivouac-task:$BV_VERSION"
DAEMON_IMAGE="$REGISTRY/bivouac-daemon:$BV_VERSION"
umask 077
cat > "$ENV_FILE" <<EOT
BIVOUAC_VERSION=$BV_VERSION
BIVOUAC_EXECUTOR_TOKEN=$EXEC_TOKEN
BIVOUAC_DOMAIN=$DOMAIN
BIVOUAC_PUBLIC_IP=$IP
BIVOUAC_TASK_IMAGE=$TASK_IMAGE
BIVOUAC_DAEMON_IMAGE=$DAEMON_IMAGE
BIVOUAC_CLAUDE_BIN=${BIVOUAC_CLAUDE_BIN:-claude}
BIVOUAC_MAX_PARALLEL=${BIVOUAC_MAX_PARALLEL:-4}
BIVOUAC_ACME_EMAIL=${BIVOUAC_ACME_EMAIL:-}
BIVOUAC_ACME_STAGING=${BIVOUAC_ACME_STAGING:-}
CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_CODE_OAUTH_TOKEN:-}
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
EOT
chmod 600 "$ENV_FILE"; umask 022

# ---- docker compose: Traefik (public), web (no Docker access), executor (Docker access, internal only)
ACME_EXTRA=""
[ -z "${BIVOUAC_ACME_EMAIL:-}" ] || ACME_EXTRA="$ACME_EXTRA
      - --certificatesresolvers.le.acme.email=$BIVOUAC_ACME_EMAIL"
[ -z "${BIVOUAC_ACME_STAGING:-}" ] || ACME_EXTRA="$ACME_EXTRA
      - --certificatesresolvers.le.acme.caserver=https://acme-staging-v02.api.letsencrypt.org/directory"
cat > "$OPT/docker-compose.yml" <<EOT
# Generated by install.sh: edit $ENV_FILE instead of this file.
name: bivouac
services:
  traefik:
    image: traefik:v3.6
    container_name: bivouac-traefik
    restart: unless-stopped
    command:
      - --providers.http.endpoint=http://bivouac-web:3001/internal/traefik
      - --providers.http.pollInterval=1s
      - --entrypoints.web.address=:80
      - --entrypoints.web.http.redirections.entrypoint.to=websecure
      - --entrypoints.web.http.redirections.entrypoint.scheme=https
      - --entrypoints.websecure.address=:443
      - --certificatesresolvers.le.acme.httpchallenge=true
      - --certificatesresolvers.le.acme.httpchallenge.entrypoint=web
      - --certificatesresolvers.le.acme.storage=/letsencrypt/acme.json$ACME_EXTRA
      - --log.level=INFO
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - $DATA/traefik:/letsencrypt
    networks: [edge]
  web:
    image: \${BIVOUAC_DAEMON_IMAGE}
    container_name: bivouac-web
    restart: unless-stopped
    user: "1000:1000"
    env_file: $ENV_FILE
    environment:
      - BIVOUAC_DATA_DIR=/data
      - BIVOUAC_PORT=3000
      - BIVOUAC_INTERNAL_PORT=3001
      - BIVOUAC_WEB_HOST=bivouac-web
      - BIVOUAC_EXECUTOR_URL=http://bivouac-executor:3002
      - BIVOUAC_CERT_RESOLVER=le
      - BIVOUAC_PREVIEW_SCHEME=https
    volumes:
      - $DATA/web:/data
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:3000/api/health"]
      interval: 5s
      timeout: 3s
      retries: 20
    networks: [edge, ctl]
  executor:
    image: \${BIVOUAC_DAEMON_IMAGE}
    container_name: bivouac-executor
    restart: unless-stopped
    user: "0:0"
    command: ["node", "packages/daemon/dist/executor-main.js"]
    env_file: $ENV_FILE
    environment:
      - BIVOUAC_DATA_DIR=$DATA
      - BIVOUAC_PORT=3002
      - BIVOUAC_TRAEFIK_CONTAINER=bivouac-traefik
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - $DATA/projects:$DATA/projects
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:3002/health"]
      interval: 5s
      timeout: 3s
      retries: 20
    networks: [ctl, egress]
networks:
  edge: { name: bivouac-edge }
  ctl: { name: bivouac-ctl, internal: true }
  egress: { name: bivouac-egress }
EOT
ln -sf "$ENV_FILE" "$OPT/.env"

cat > /etc/systemd/system/bivouac.service <<EOT
[Unit]
Description=bivouac (Traefik + web + executor via docker compose)
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$OPT
ExecStart=/usr/bin/docker compose up -d --remove-orphans
ExecStop=/usr/bin/docker compose down
TimeoutStartSec=300

[Install]
WantedBy=multi-user.target
EOT
systemctl daemon-reload

# `bivouac` command (setup link, recovery, test sessions): runs inside the web container
cat > /usr/local/bin/bivouac <<'EOT'
#!/bin/sh
# bivouac admin tool. Usage: sudo bivouac reset-admin | setup-link | status
exec docker exec -i bivouac-web node packages/daemon/dist/cli.js "$@"
EOT
chmod 755 /usr/local/bin/bivouac

# ---- images
if [ -n "${BIVOUAC_SOURCE_DIR:-}" ]; then
  log "Building images from $BIVOUAC_SOURCE_DIR"
  docker build -q -t "$DAEMON_IMAGE" -f "$BIVOUAC_SOURCE_DIR/packages/daemon/Dockerfile" --build-arg "VERSION=$BV_VERSION" "$BIVOUAC_SOURCE_DIR" >/dev/null
  docker build -q -t "$TASK_IMAGE" "$BIVOUAC_SOURCE_DIR/packages/task-image" >/dev/null
fi
if [ -n "${BIVOUAC_REGISTRY_TOKEN:-}" ]; then
  echo "$BIVOUAC_REGISTRY_TOKEN" | docker login "${REGISTRY%%/*}" -u "${BIVOUAC_REGISTRY_USER:-bivouac}" --password-stdin >/dev/null
fi
log "Pulling images (version $BV_VERSION)"
docker image inspect "$DAEMON_IMAGE" >/dev/null 2>&1 || docker pull -q "$DAEMON_IMAGE" >/dev/null || die "Cannot pull $DAEMON_IMAGE (private registry? set BIVOUAC_REGISTRY_USER / BIVOUAC_REGISTRY_TOKEN)."
docker image inspect "$TASK_IMAGE" >/dev/null 2>&1 || docker pull -q "$TASK_IMAGE" >/dev/null || die "Cannot pull $TASK_IMAGE."
docker pull -q traefik:v3.6 >/dev/null
docker run --rm --entrypoint cat "$DAEMON_IMAGE" /app/uninstall.sh > "$OPT/uninstall.sh" && chmod 755 "$OPT/uninstall.sh"

# ---- start
log "Starting bivouac"
systemctl enable bivouac.service >/dev/null 2>&1
systemctl restart bivouac.service
log "Waiting for the services to become healthy"
ok=0
for _ in $(seq 1 90); do
  if [ "$(docker inspect -f '{{.State.Health.Status}}' bivouac-web 2>/dev/null)" = healthy ] && [ "$(docker inspect -f '{{.State.Health.Status}}' bivouac-executor 2>/dev/null)" = healthy ]; then ok=1; break; fi
  sleep 2
done
if [ "$ok" != 1 ]; then docker compose -f "$OPT/docker-compose.yml" logs --tail 40 web executor >&2 || true; die "bivouac did not become healthy. See: docker logs bivouac-web"; fi

# ---- the certificate comes from Let's Encrypt over port 80: wait for it
# The address of the dashboard is the first one the server answers on; the wizard may move it to your own domain later.
CURL_TLS=""; [ -z "${BIVOUAC_ACME_STAGING:-}" ] || CURL_TLS="-k"
SERVED_DOMAIN="$(docker exec bivouac-web node packages/daemon/dist/cli.js domain 2>/dev/null || echo "$DOMAIN")"
log "Getting the HTTPS certificate for $SERVED_DOMAIN (up to 2 minutes)"
cert_ok=0
for _ in $(seq 1 60); do
  # shellcheck disable=SC2086
  if curl -fsS $CURL_TLS --max-time 5 "https://$SERVED_DOMAIN/api/health" >/dev/null 2>&1; then cert_ok=1; break; fi
  sleep 2
done

URL="https://$SERVED_DOMAIN"
echo
if [ "$cert_ok" != 1 ]; then
  warn "Could not get a certificate for $SERVED_DOMAIN. Ports 80 and 443 of this server must be reachable from the internet."
  cat >&2 <<EOT

  What to check:
    1. In your hosting provider's firewall (security group), allow incoming TCP 80 and TCP 443 from anywhere.
       (Hetzner: Firewalls; AWS: Security groups; DigitalOcean: Networking > Firewalls; OVH: Edge Network Firewall.)
    2. If the server has its own firewall: sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
    3. Then run the installer again, or look at the logs: docker logs bivouac-traefik

EOT
fi

HAS_ADMIN="$(/usr/local/bin/bivouac status 2>/dev/null | sed -n 's/^admin=//p')"
if [ "$HAS_ADMIN" = "yes" ]; then
  cat <<EOT
  bivouac $BV_VERSION is up to date.

  Dashboard:  $URL
  Lost access?  sudo bivouac reset-admin

EOT
else
  LINK="$(/usr/local/bin/bivouac setup-link)"
  cat <<EOT
  bivouac $BV_VERSION is running. Open this link to finish the setup (it works once):

    $LINK

EOT
  qrencode -t ANSIUTF8 "$LINK" 2>/dev/null || true
  echo
  echo "  Lost the link? Run: sudo bivouac reset-admin"
  echo
fi
[ "$UPGRADED_FROM_01" != 1 ] || echo "  Note: Tailscale is no longer used by bivouac. You can remove it if nothing else needs it."
