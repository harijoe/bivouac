#!/usr/bin/env bash
# bivouac uninstaller. Removes the service, containers and networks created by bivouac.
# Docker and Tailscale are left in place. Use --purge to also delete all data (projects, tasks, database, secrets).
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }
PURGE=0; [ "${1:-}" = "--purge" ] && PURGE=1
echo "==> Stopping bivouac"
systemctl disable --now bivouac.service 2>/dev/null || true
if [ -f /opt/bivouac/docker-compose.yml ]; then (cd /opt/bivouac && docker compose down --remove-orphans 2>/dev/null) || true; fi
echo "==> Removing task containers and networks"
docker ps -aq --filter label=bivouac.managed=true | xargs -r docker rm -f >/dev/null 2>&1 || true
docker network ls -q --filter label=bivouac.managed=true | xargs -r docker network rm >/dev/null 2>&1 || true
docker rm -f bivouac-daemon bivouac-traefik >/dev/null 2>&1 || true
rm -f /etc/systemd/system/bivouac.service
systemctl daemon-reload
rm -rf /opt/bivouac
if [ "$PURGE" = 1 ]; then
  echo "==> Purging data and configuration"
  rm -rf /var/lib/bivouac /etc/bivouac
  docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '/bivouac-(daemon|task):' | xargs -r docker rmi >/dev/null 2>&1 || true
  id bivouac >/dev/null 2>&1 && userdel bivouac 2>/dev/null || true
else
  echo "Data kept in /var/lib/bivouac and /etc/bivouac (re-run with --purge to delete it)."
fi
echo "bivouac removed."
