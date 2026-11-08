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
6. Lecture critique de l'UI sur ton téléphone (captures dans `docs/screenshots`, dont la page `update`).
7. **v0.3** : première mise à jour depuis le dashboard avec une vraie release suivante (0.3.0 → 0.3.1 quand elle existera) ; bandeau et notes rendus depuis le vrai corps d'une release GitHub ; mises à jour automatiques la nuit (seule la logique est testée, pas l'heure réelle) ; pare-feu sur ton hébergeur réel si tu utilises nftables seul.

## Journal v0.3 (2026-11-08)
Tout est vérifié par moi, sauf la liste « À valider manuellement ».
- **Mises à jour depuis le dashboard** : détection quotidienne (releases GitHub, source configurable `BIVOUAC_RELEASES_URL`, brouillons/pré-releases ignorés), bandeau admin + notes de version, bouton avec confirmation, progression par étapes, audit (qui, de/vers, résultat), planification « quand plus rien ne tourne » (création de tâches refusée avec message clair), « maintenant » (tâches `stopped`, reprenables), mises à jour automatiques de nuit (option, off par défaut). Un seul script `apply.sh` partagé par `install.sh` et l'updater (conteneur éphémère lancé par l'executor, `web` sans socket Docker) : sauvegarde (3 gardées), pull, config, recréation, healthcheck, **retour arrière automatique** (images + config + base).
- **Ports multiples**, **sidecars** par tâche (Postgres, Redis…), **relecture de `bivouac.yml`** à chaque session de l'agent (fichier invalide = dernière config valide + erreur signalée), **pare-feu hôte** (`bivouac-firewall.service`), isolation vérifiée sur VM (hôte, SSH, web, executor, API Traefik, métadonnées : injoignables ; Internet : OK).
- **MCP** : `get_project_context`, `read_project_file`, prompt `plan_next_mission` ; secrets exclus et masqués.
- **Tests** : 103 unitaires + 3 d'intégration Docker en CI ; e2e `scripts/e2e-v03.sh` sur VM Hetzner neuve (0.2.0 GHCR → seed → 0.3.0 → mise à jour 0.3.1 → planifiée 0.3.2 → version cassée 0.3.3 avec retour arrière → « maintenant » 0.3.4 → ports/services/isolation/contexte → désinstallation) : **PASSÉ x2 de suite** sur le code final. L'ancien `e2e-fresh-vps.sh` (refactoré sur `lib-hcloud.sh`, attend 13 outils MCP) repasse aussi.
- **Release `v0.3.0`** publiée (tag, release GitHub avec les notes du CHANGELOG, `DEFAULT_VERSION`), images `ghcr.io/harijoe/bivouac-{daemon,task}` `0.3.0` et `latest` tirables anonymement ; CI verte sur `main` et sur le tag. `scripts/e2e-v03.sh --release` (VM neuve : 0.2.0 depuis GHCR, puis la commande d'installation du README = vraie 0.3.0, données intactes, ports multiples, sidecars, isolation, contexte MCP, désinstallation) : **PASSÉ**.
- **Passe finale** : voir `docs/review-v0.3.md` (bugs de retour arrière trouvés par l'e2e, fuite des mots de passe de services dans le contexte, audit des dépendances).
- **Écart à la spec** : la 0.2.0 n'a pas de détection de version, donc « la vraie 0.3.0 apparaît dans le bandeau d'une VM en 0.2.0 » est impossible. Vérifié à la place : 0.2.0 → vraie 0.3.0 par `install.sh` (README), données intactes ; le chemin dashboard est couvert par l'e2e avec des versions de test (0.3.0 → 0.3.4).
- Non réimplémenté : rattachement des agents en cours après un redémarrage (raisons dans `docs/decisions.md`).

## Journal v0.2 (2026-11-07)
Tout est vérifié par moi (voir la liste « À valider manuellement » pour ce qui ne peut pas l'être).
- **Architecture** : `web` (public, non-root, sans socket Docker) / `executor` (socket Docker, réseau interne `bivouac-ctl`, secret partagé, API étroite) ; Traefik en provider HTTP alimenté par la base (renommage ≈ 7-10 s, sans redémarrer le conteneur, dont l'émission du certificat du nouvel hôte), forwardAuth vers `web` (ticket propriétaire, liens de partage, cookie de preview retiré avant l'app). Tailscale entièrement retiré.
- **Tests** : 70 unitaires (noms, tickets/partages, routes dynamiques, tokens GitHub limités avec API mockée, manifest mocké, setup-token avec faux CLI + vraie sortie capturée, OAuth : PKCE/rotation/réutilisation/révocation/URLs refusées, MCP via SDK officiel, API executor) ; 3 tests d'intégration en conteneurs réels (topologie web/executor/Traefik réelle) — ils ont trouvé deux vrais bugs (redirection relative réécrite par Traefik, route SPA `/oauth/authorize`).
- **E2E sur VM Hetzner neuve** (installation par la commande du README, certificat Let's Encrypt réel, client MCP du SDK officiel depuis ce VPS) : PASSÉ x2 (sslip.io, images construites sur la VM) ; PASSÉ sur `dev.deslope.com` avec l'IP réservée (étape domaine de l'assistant, puis e2e complet) ; PASSÉ avec le vrai CLI claude (tâche `succeeded`, 0,048 $) ; PASSÉ depuis GHCR `0.2.0` via `curl raw.githubusercontent.com … | sudo bash`. Chaque passage couvre aussi : web sans accès au socket, executor non résolvable depuis l'edge, réinstallation idempotente, désinstallation `--purge` propre.
- **UI** : revue captures 390 px / 1280 px (clair et sombre) dans `docs/screenshots` ; corrigé : logo SVG (pas d'emoji), réglages repliés, boutons primaire/secondaire cohérents, formulaire d'autorisation (route SPA), états vides.
- **Release** `v0.2.0` publiée (GitHub release, tag, CHANGELOG), images `ghcr.io/harijoe/bivouac-{daemon,task}` `0.2.0` et `latest` tirées anonymement ; CI verte sur `main` et sur le tag.
- Nettoyage : 0 serveur Hetzner, 0 conteneur `bivouac*` sur ce VPS, IP réservée intacte.

## Limites connues (v0.2)
- Le flux manifest GitHub et la connexion GitHub réelle ne sont testés qu'avec GitHub mocké ; les clients Claude.ai / ChatGPT / Claude Code réels ne l'ont pas été (voir liste ci-dessus).
- Interface en anglais uniquement.
- Les certificats de preview sont émis par hôte (HTTP-01) : limite Let's Encrypt de 50 / semaine / domaine enregistré.
- Pas de test arm64 ni Ubuntu 22.04 en conditions réelles.
- Les 3 tests d'intégration ont besoin d'Docker et de ports 80 libres sur la VM de test ; ils sont lancés en CI.

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

MISSION_V02_TERMINEE

## Fix CI (flaky encryption test)
- `packages/daemon/test/misc.test.ts`: the ciphertext is now checked against the full plaintext secret instead of the 3-letter `ghp` (which random base64 could contain). Encryption code untouched.
- Audited the other tests: remaining `not.toContain` checks use long or non-base64 strings (hex hashes, `PRIVATE KEY`, 40-char tokens), so no other change was needed.
- CI on 4330ede verified through the Actions API (run 42427478913): test, integration and images all `success`.

MISSION_FIXCI_TERMINEE

MISSION_V03_TERMINEE
