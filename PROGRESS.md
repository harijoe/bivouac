# PROGRESS

## Mission revue v0.5 (2026-11-12)
Six revues parallèles, chaque constat soumis à un vérificateur indépendant, puis correctifs (un commit par correctif, 19 commits de `0fd4d40` à `b29159f`). Détail, constats rejetés et constats reportés : `docs/review-v0.5.md` ; CHANGELOG `## 0.5.1`. Publié en 0.5.1 (voir le journal 0.5.1).
- **Corrigé, sécurité (P0)** : l'agent pouvait faire exécuter des commandes à l'exécuteur via `.git/config` (fsmonitor, filtres, textconv), envoyer le token d'écriture à une autre URL (`remote.origin.url`/`pushurl`) et faire lire/tronquer des fichiers de l'exécuteur par des liens symboliques. Tests de non-régression ajoutés.
- **Corrigé, P1** : premier `restart.req` ignoré, cookie de partage lié à la tâche, session des membres d'une organisation autorisée, `get_project_context` (événements périmés, lenteur), avertissement « non poussé » après un premier push, retour arrière réel de `install.sh` et d'un démarrage raté dans `apply.sh`, fichier d'état écrit par root, onglet après renommage.
- **Reporté** (liste dans `docs/review-v0.5.md`) : plafond des ressources des services demandés par l'agent, rotation de `dev.log`, rédaction des secrets dans `get_task`, élagage des marques git, fenêtre de lancement de la mise à jour, etc.
- **Non vérifié** : les chemins d'échec de `apply.sh` n'ont pas été rejoués sur une VM (aucune VM créée) ; `bash -n` et un bac à sable pour `write_status` seulement.
- Local : build, lint, typecheck, 13 + 67 + 189 tests unitaires et 7 tests d'intégration Docker verts.

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
8. **v0.3.1** : connexion Claude réelle avec ton compte (code collé de ~90 caractères, token enregistré, première tâche réelle qui démarre sans « Not logged in »), étape GitHub « organisation » sur github.com, ajout d'un dépôt par token fine-grained sur un dépôt d'organisation, tâche sur `tracks` (Node 26 + pnpm 11 installés automatiquement), mise à jour 0.3.0 → 0.3.1 depuis le dashboard.
9. **v0.4** : lecture critique du nouveau design (téléphone et ordinateur, deux modes), création d'une tâche depuis le dashboard, logs en direct sur une vraie tâche, ajout d'un second compte Claude (connexion réelle) et choix par projet, mise à jour 0.3.1 → 0.4.0 depuis le dashboard.
10. **v0.4.1** : sur ta vraie tâche longue, lire l'historique par attempt (ouverture, filtres, recherche, lien `#attempt-N`) ; modifier le budget d'une tâche en `budget_exceeded` puis reprendre ; `push_branch` sur harijoe/tracks avec son hook pre-push ; service Postgres à 1 Go (et message si tué) ; mise à jour 0.4.0 → 0.4.1 depuis le dashboard.
11. **v0.5** : lecture critique des nouvelles sections (bandeau de santé du preview, galerie de captures, diff par attempt, onglet Changes, alias et instantanés dans Réglages > Projets) sur téléphone et ordinateur ; créer un alias (`app`) dans Réglages > Projets, le pointer sur une tâche et vérifier qu'il s'ouvre avec le cookie du dashboard ; test réel d'un callback OAuth / webhook sur l'alias avec un chemin public ; vérifier les captures sur ta vraie tâche (`preview.screenshots` dans bivouac.yml) ; mise à jour 0.4.1 → 0.5.0 depuis le dashboard (l'image de tâche grossit d'environ 400 Mo : Chromium).
7. **v0.3** : première mise à jour depuis le dashboard avec une vraie release suivante (0.3.0 → 0.3.1 quand elle existera) ; bandeau et notes rendus depuis le vrai corps d'une release GitHub ; mises à jour automatiques la nuit (seule la logique est testée, pas l'heure réelle) ; pare-feu sur ton hébergeur réel si tu utilises nftables seul.

## Journal v0.5 (2026-11-12)
Tout est vérifié par moi, sauf la liste « À valider manuellement ».
- **Diff par attempt** : début et fin de chaque attempt = HEAD + commit « instantané » de l'arbre de travail (index jetable, épinglé sous `refs/bivouac/marks/`), donc les changements non commités et les attempts sans commit ont un diff. API paginée par lignes, `get_task` (résumé `changes` par attempt) et `get_attempt_diff` (MCP), comparaison avec la branche de base. Test sur plusieurs attempts, attempt sans commit, attempt sans changement.
- **Preview fiable** : le superviseur sonde le serveur (port/chemin configurables), le redémarre (1, 2, 4, 8, 15, 30, 60, 60 s) et abandonne après 8 essais (`down`), écrit `health.json` ; `PreviewWatch` (daemon) en tire événements d'historique et notes pour l'agent ; bouton/outil « restart preview ». Hôte stable après arrêt/reprise (testé). Alias par projet (`app.<domaine>`, chemins publics réservés à l'administrateur, jamais lisibles dans `bivouac.yml`). Liens de partage : page claire expiré / révoqué (testé avec expiration forcée).
- **Captures** : Chromium dans l'image de tâche (+~400 Mo), script `shot.mjs` (375 et 1280 px, statut, titre, erreurs console, requêtes en échec, page blanche / overlay d'erreur), stockage borné (12 attempts, 60 Mo par tâche, supprimé avec la tâche), images MCP dans `get_task` (4 max, compressées) et `get_attempt_screenshots`. Un échec de capture est journalisé, jamais bloquant. Vérifié avec le vrai Chromium de l'image (tests dans un conteneur : cette VPS n'a pas les bibliothèques système de Chromium ; en CI, Chrome est présent).
- **Instantanés** : voir `docs/decisions.md` (archive des fichiers ignorés par git après `setup`, restaurée avant `setup` qui s'exécute toujours ; 3 par projet ; jamais de secrets). Mesure (VPS, Docker réel, projet Node + pnpm ~800 paquets + Postgres, `docs/bench-snapshot-v0.5.json`) : **avant** (v0.4, 2e tâche d'un projet) agent prêt en 16,1 s, preview disponible en 16,7 s ; **après** agent prêt en 5,0 s, preview en 6,3 s (restauration de 793 Mo en 2,8 s) ; première tâche d'un projet : 15,8 s / 17,2 s. Le gain est sous-estimé : le réseau de cette VPS est très rapide, il grandit avec un réseau lent ou un projet plus lourd. « Reconstruire » = supprime les instantanés, le prochain `setup` en refait un (pas de build à vide).
- **Dashboard** (deux agents en parallèle) : bandeau de santé, alias, galerie par attempt avec comparaison et dialogue plein écran, diffs repliables et paginés, onglet Changes, instantanés. Captures 375 px / 1280 px, deux modes, sans débordement horizontal ni erreur console : `docs/screenshots/v0.5` (avant : `docs/screenshots/v0.4.1`).
- **E2E sur VM neuve** (`scripts/e2e-fresh-vps.sh --staging`, images construites sur la VM, 18 outils MCP, diff / captures Chromium / santé du preview via MCP, réinstallation idempotente, désinstallation) : **PASSÉ** ; VM et clé SSH supprimées, `bivouac-manual` intacte.
- **CI** : le script `test` du daemon ne quotait pas `--exclude test/integration/**` (le shell développait le motif et les fichiers d'intégration tournaient dans le job unitaire : défaut ancien, révélé par le nouveau test) ; corrigé, et délai de test passé à 20 s (les marques git par attempt ralentissent les tests multi-attempts sur runner partagé).
- **Tests** : 182 unitaires daemon (dont superviseur réel, alias, expiration, instantanés, captures), 13 shared, 67 dashboard ; intégration Docker `test/integration/snapshot.test.ts` (benchmark réel).
- **Release** : tag `v0.5.0` (commit 045a2e1), CI verte sur `main` et sur le tag (test, integration, images), images `ghcr.io/harijoe/bivouac-{daemon,task}` `0.5.0` tirées en anonyme (l'image de tâche contient Chromium 156 et `shot.mjs`) ; release GitHub **non créée / en brouillon** : tu la crées et la publies, puis tu testes la mise à jour 0.4.1 → 0.5.0 depuis le dashboard. Le tag a été déplacé une fois (de 24451f7 à 045a2e1) avant toute publication : une course dans mon test de benchmark (la vérification de succès interrogeait le serveur avant son démarrage) avait fait échouer la CI du tag.
- **Pièges notés** : l'extraction d'une archive par un daemon non-root laisse des fichiers que l'utilisateur du conteneur ne peut pas `chmod` (pnpm échoue) : la restauration se fait donc dans le conteneur ; un `--exclude` non quoté dans un script npm est développé par le shell et change les tests exécutés.

## Journal v0.4.1 (2026-11-10)
Retours de la vraie tâche longue (tracks/agent-analytics). Tout est vérifié par moi, sauf la liste « À valider manuellement ».
- **Historique par attempt** : API paginée (`/api/tasks/:id/attempts`, événements d'une attempt, recherche), regroupement par SQL indexé, repères (instructions, arrêts, états, reprises, changements de limites) rattachés à l'attempt suivante ; UI repliable, filtres, recherche surlignée qui déplie, lien `#attempt-N`, chargement à la demande (testé avec 300 attempts), événements en direct sans replay du flux (`?tail=1`) ni saut de page. `get_task` : résumé par attempt paginé (et il lisait les 5000 plus *anciens* événements : corrigé).
- **Limites modifiables** : page de tâche (onglet Settings), MCP `update_task` et paramètres de `resume_task`, effet à l'attempt suivante, tracé dans l'historique ; reprise d'une tâche `budget_exceeded` refusée avec message clair (dialogue côté dashboard), `max_iterations` : nouvelle limite proposée.
- **`push_branch`** : `--no-verify` (test avec un hook pre-push qui échoue), message d'erreur selon la vraie cause (403 seulement pour les permissions).
- **Services** : mémoire par défaut 1 Go, appliquée aux conteneurs existants (`docker update`, sinon recréation avec volume conservé), sans swap ; un service tué (OOM ou code 137) ou arrêté est signalé dans l'historique et le log du service avec la limite, redémarré (5 fois max) et signalé à l'agent. Test d'intégration Docker réel (limites + vrai kill mémoire). Découverte : le drapeau `OOMKilled` de Docker est parfois faux, d'où le traitement du code 137.
- **Tests** : unitaires daemon 155, dashboard 47 + intégration Docker (`services.test.ts`) ; captures 375 px / 1280 px, deux modes, sans débordement : `docs/screenshots/v0.4.1` (avant : `docs/screenshots/v0.3`/`v0.4`, liste plate). 
- **Non fait** : e2e sur VM Hetzner neuve (`e2e-fresh-vps.sh`) non rejoué pour cette version (changements limités au daemon/dashboard, couverts par les tests unitaires et d'intégration Docker en CI) ; pas de VM créée.
- **Release** : tag `v0.4.1`, CI verte (commit 4b8d8ca et tag), images `ghcr.io/harijoe/bivouac-{daemon,task}` `0.4.1` tirées en anonyme ; release GitHub **non créée / en brouillon** : tu la crées et la publies, puis tu testes la mise à jour 0.4.0 → 0.4.1 depuis le dashboard.

## Journal v0.4 (2026-11-10)
Refonte du dashboard et nouvelles fonctions. Tout est vérifié par moi, sauf la liste « À valider manuellement ».
- **Design** : Tailwind v4 + shadcn/ui, thème Tiesen, noir par défaut, clair au choix (système au premier chargement, bascule dans l'en-tête, mémorisé), Geist / Geist Mono servis localement (bug trouvé à la relecture des captures : la famille « Geist Variable » était mal nommée, corrigé). Anciennes pages et `styles.css` supprimés.
- **Navigation par projets**, **création de tâche** depuis le dashboard (même service que `create_task`, testé), bloc « Connect your chat », sélecteur de dépôts avec recherche triés par `pushed_at`, **visionneuse de logs** en direct (sources, pause du défilement, ANSI, recherche, téléchargement, virtualisation), **plusieurs comptes Claude** (migration en « Default », compte par projet résolu à chaque session, erreurs nommant le compte, MCP sans token), **réglages** en sections avec « Avancé » replié et actions dangereuses en Dialog. Détail des déplacements dans le CHANGELOG.
- **Tests** : 191 unitaires (13 shared, 40 dashboard, 138 daemon) + intégration Docker en CI ; e2e `e2e-fresh-vps.sh --staging` sur VM neuve : **PASSÉ** (49 vérifications). Sans `--staging`, la VM n'a pas obtenu de certificat (probablement la limite Let's Encrypt partagée de sslip.io après les nombreux essais) : cause non vérifiée, non liée au code à ma connaissance. Captures 375 px / 1280 px, deux modes, sans débordement horizontal : `docs/screenshots/v0.4` (avant : `docs/screenshots/v0.3`).
- **CSP** : `style-src 'unsafe-inline'` (Radix/Sonner/virtualisation), scripts toujours stricts : voir `docs/decisions.md`.
- **Release** : tag `v0.4.0`, CI verte (commit f890271 et tag), images `ghcr.io/harijoe/bivouac-{daemon,task}` `0.4.0` tirées en anonyme ; release GitHub **en brouillon** (tu la publies, puis tu testes la mise à jour 0.3.1 → 0.4.0 depuis le dashboard).
- Non rejoué : l'e2e de mise à jour (`e2e-v03.sh`) ; `apply.sh` et le circuit de mise à jour sont inchangés.

## Journal v0.3.1 (2026-11-09)
Correctif issu du premier test manuel de la 0.3.0. Tout est vérifié par moi, sauf la liste « À valider manuellement ».
- **Connexion Claude** : le code est tapé puis `\r` envoyé séparément (le CLI Ink prenait l'ensemble pour un collage) ; l'écran du CLI est reconstitué avec `@xterm/headless` avant d'extraire le token (préfixe `sk-ant-oat01-` vérifié, token mal formé jamais enregistré, fixtures de sorties réelles) ; le daemon enregistre lui-même le token à la fin de la session ; un code refusé donne l'erreur du CLI et « Start over » ; état « Verifying the code… ».
- **DNS** relatifs à la zone (liste des suffixes publics : `@`/`*` pour un domaine racine, `dev`/`*.dev` pour un sous-domaine) ; propagation testée sur le domaine et un sous-domaine aléatoire. **Étape GitHub** : compte personnel (défaut) ou organisation (avertissements, validation du nom via l'API publique). **Dépôt par token** : action visible dans l'assistant et les réglages, permissions exactes, vérification à l'enregistrement.
- **Titres de tâche** sans Markdown. **Coût** : « estimated API equivalent » avec un abonnement (`costKind`, dashboard et `get_task`). **`blocked`** (fichier `/workspace/.bivouac/blocked.md` écrit par l'agent) et **`stuck`** (deux vérifications identiques sans changement de code) : jamais relancés, raison visible dashboard + `get_task`.
- **Versions d'outils** : mise dans l'image de tâche, détection (`mise.toml`, `.tool-versions`, `.nvmrc`, `.node-version`, `engines.node`, `packageManager`, `.python-version`, `go.mod`, `rust-toolchain`), `runtime:` dans `bivouac.yml`, cache en volume par projet ; `image:` retiré (erreur claire). Vérifié en vrai : Node 26 + pnpm 11 dans le conteneur (image Node 22), seconde tâche sans re-téléchargement (test d'intégration Docker, en CI).
- **UI** : boutons avec loader et libellé explicite partout, états bloqué/stuck, formulaires réécrits.
- **Tests** : 128 unitaires + 4 d'intégration Docker ; e2e `scripts/e2e-fresh-vps.sh` sur VM neuve **PASSÉ** (a révélé que le faux `setup-token` lisait en mode cuisiné sur un TTY : corrigé). Le test e2e de mise à jour (`e2e-v03.sh`) n'a pas été rejoué : `apply.sh` et le circuit de mise à jour n'ont pas changé.
- **Release** : tag `v0.3.1`, CI verte (commit cdf459f et tag), images `ghcr.io/harijoe/bivouac-{daemon,task}` `0.3.1` et `latest` tirées en anonyme ; release GitHub **en brouillon** (tu la publies, puis tu testes la mise à jour depuis le dashboard de ton instance 0.3.0).
- Pièges notés : pnpm 11.0.x est mal empaqueté pour mise (lien symbolique hors de l'arbre) : une version exacte `packageManager: pnpm@11.0.x` échoue à l'installation avec le message de mise ; mettre une autre version dans `runtime:`.

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

MISSION_V031_TERMINEE

MISSION_V04_TERMINEE

MISSION_V041_TERMINEE

MISSION_V05_TERMINEE

MISSION_REVIEW_V05_TERMINEE
