# PROGRESS

## BLOQUÉ / questions
- Aucun. Q1 (repo + packages GHCR publics) et Q2 (lecture Actions) sont résolus: pull anonyme vérifié (`edge` et `0.1.0`, daemon et task), CI lue via l'API GitHub.

## Fait
- M1: monorepo, task image (real CLI verified as non-root in the container with the OAuth token), real stream-json fixture.
- M2: daemon (SQLite store, runner / success loop, budgets, sandbox abstraction, host-side git, REST + SSE API): 24 unit tests with the fake claude.
- M3: Docker integration test (real Docker + Traefik v3.6 + fake claude): two parallel tasks on one project, previews through Traefik on distinct hostnames, live update of a file visible in the preview of that task only, cleanup. Passes locally.
- M4: dashboard (React/Vite, SSE, responsive; screenshots in docs/screenshots, no horizontal overflow at 390px).
- M6: `install.sh`, `uninstall.sh`, systemd unit, compose generation, GHCR workflow (written, see Q3).
- M7: `scripts/e2e-fresh-vps.sh` + `scripts/e2e-verify.sh`. Results on fresh Hetzner cx23 / Ubuntu 24.04 VMs (Tailscale joined with TS_AUTHKEY, images built on the VM, install command taken from the README):
  - fake claude run #1: PASSED; run #2 (new VM): PASSED. Each covers health, dashboard, auth, no public listener, 2 parallel tasks with previews over sslip.io, success loop (task 2 needs 2 iterations), non-root/no docker.sock, independent files, totals, task delete cleanup, idempotent re-install, uninstall --purge.
  - real claude run: PASSED (task succeeded, cost $0.044, preview contains the new button, tool calls and usage recorded).
  - Hetzner servers/keys: all destroyed after each run (0 left).
- README written (install command delimited by `e2e:install` markers so the e2e executes it verbatim).

## État final (2026-11-07)
- CI verte sur `main` (lue via l'API Actions: test, integration, images = success). Contournement `report` / branche `ci-status` supprimé (local et distant), CI toujours verte après suppression.
- Release `v0.1.0` + images `0.1.0` et `edge` publiées sur `ghcr.io/harijoe/bivouac-{daemon,task}`, pull anonyme OK.
- `scripts/e2e-fresh-vps.sh --ghcr` (BIVOUAC_VERSION=0.1.0, commande `curl raw.githubusercontent.com | sudo -E bash` prise dans le README, images tirées de GHCR) : PASSED x2 sur VM Hetzner cx23 Ubuntu 24.04 neuves, y compris ré-installation idempotente et désinstallation.
- Vrai CLI: PASSED sur VM neuve (voir M7, tâche réelle `succeeded`).
- Hetzner: 0 serveur restant; 0 conteneur `bivouac*` sur ce VPS.

## Définition de terminé
Tous les points sont vérifiés.

## Limites connues
- Sidecars (Postgres/Redis) non implémentés; clé `image:` de bivouac.yml réservée (images dérivées de l'image de tâche uniquement).
- Previews publiques + basic auth: étiquettes Traefik générées et testées en unitaire, jamais testées sur un vrai accès public.
- Injection d'instructions: file d'attente appliquée à l'itération suivante (pas de `--input-format stream-json`).
- Le daemon monte le socket Docker (root-équivalent): protégé par Tailscale + token.
- TLS Let's Encrypt/Cloudflare écrit mais non testé de bout en bout.
- Coût d'une session `--resume`: supposé par invocation (cohérent avec le test réel: 0,044 $).
- Cas non testés: arm64 en conditions réelles, Ubuntu 22.04.

## Prochaines étapes suggérées
1. Tests TLS DNS-01, previews publiques, Ubuntu 22.04/arm64.
2. Sidecars de services par projet.

## Décisions
See docs/decisions.md.

MISSION_TERMINEE
