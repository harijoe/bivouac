# PROGRESS

## BLOQUÉ / questions
- Aucun pour l'instant. (`dev.deslope.com` et `*.dev.deslope.com` résolvent déjà vers 78.47.63.246.)

## À valider manuellement par Julien
Ces points ne peuvent pas être testés de façon automatique (ils demandent ton compte GitHub, ton compte Claude ou tes apps de chat). Tout le reste est couvert par les tests unitaires, d'intégration et e2e.
1. **Création réelle de la GitHub App** : ouvrir le lien d'installation, étape « GitHub » → GitHub demande de confirmer le nom de l'app → retour sur bivouac. (Le flux manifest est testé avec GitHub mocké ; la forme exacte du manifest n'a jamais été acceptée par github.com.)
2. **Connexion GitHub réelle** : « Se connecter avec GitHub » après la création ; vérifier que tu deviens administrateur, puis ajouter un second compte / une organisation dans Réglages > Qui peut se connecter.
3. **Choix des repos** : « Choisir les repos sur GitHub » → installation de l'app → retour automatique sur l'assistant ; ajouter un repo comme projet ; vérifier qu'un `push` et une PR fonctionnent avec le token limité au repo (permissions contents + pull requests).
4. **Connexion Claude réelle** depuis le dashboard (`claude setup-token` dans le conteneur : URL, code collé, token stocké). Le parseur est testé sur la vraie sortie capturée du CLI 2.1.319, mais jamais bout en bout avec ton compte.
5. **Ajout du connecteur MCP dans Claude.ai** (web et desktop), **Claude Code** (`claude mcp add --transport http …`) et **ChatGPT** (mode développeur) : le flux OAuth (métadonnées, DCR, PKCE) est testé avec le SDK officiel, pas avec ces trois clients réels. Points à surveiller : l'URL de retour de claude.ai / chatgpt.com (liste d'autorisation configurable via `BIVOUAC_OAUTH_REDIRECT_ALLOW`), l'affichage des annotations.
6. Lecture critique de l'UI sur ton téléphone (captures dans `docs/screenshots`).

## État v0.2
(voir plus bas, section « Journal v0.2 »)

## Fait (v0.1)

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
