# Review of bivouac v0.5.0

Six reviewers read one area each (task lifecycle, preview, MCP vs REST, install/update/accounts, security, code quality and dashboard). Every finding was then sent to a separate verifier that tried to refute it. Severity: P0 blocking or security, P1 a user path is broken, P2 quality. Verification was by reading the code and, where noted, by running a reproduction; items marked "code reading" were not reproduced. Fixes that share a commit are listed with the same sha.

## Confirmed and fixed

| # | Sev | Where | Failure scenario | Outcome |
|---|-----|-------|------------------|---------|
| 1 | P0 | `git.ts`, `gitdiff.ts`, `sandbox.ts` (marks, fingerprint, diffs) | The agent owns `/workspace/repo/.git/config`; `core.fsmonitor`, a `filter.*.clean` plus `.gitattributes`, or a `diff.*.textconv` runs in the executor at every attempt mark, with the executor's environment (executor token, Claude token). Reproduced. | fixed 0fd4d40 (config reduced to an allow-list before each host-side git call, hardened `-c` overrides, clean environment, uid drop, `--no-textconv`) |
| 2 | P1 (reported P0) | `sandbox.ts` `unpushed()` | `git rev-list --not --remotes` ran as root in the executor on the agent's repository (partial-clone `uploadpack` command). The final trigger was **not reproduced**; the git behaviour on a promisor remote was only partly shown. Same class as 1 and strictly worse (root). | fixed 0fd4d40 (uid drop, `extensions.*` and `remote.*.uploadpack` removed by the allow-list, `GIT_NO_LAZY_FETCH`) |
| 3 | P0 | `sandbox.ts` `push()` | The agent sets `remote.origin.url`/`pushurl`/`insteadOf`; Push or Open PR sends the repository write token (`http.extraheader`) to that host. | fixed 0fd4d40 (`remote.origin.url` is reset to the project URL before pushing; `pushurl` and `url.*` are removed) |
| 4 | P0 | `sandbox.ts` `HostWorkspace.readFile/readBinary/tail/writeFile` | A symlink planted by the agent (`.bivouac/blocked.md`, `dev.log`, a screenshot file name) makes the executor (root) read `/proc/self/environ` or another project's files, or truncate any file. Reproduced by the reviewer. | fixed 63d9bea (`lstat` on every path component, `O_NOFOLLOW`) |
| 5 | P1 | `supervisor.mjs:47,150` | The first `restart.req` of a supervisor's life was ignored (restart_preview, dashboard button, recovery from `down`); the unit test wrote the file twice. | fixed 7ff7227 |
| 6 | P1 | `preview.ts` `verify` | A share cookie was not tied to a task: after the alias moved to another task, an old visitor kept seeing the new task. | fixed 3f7dc7e |
| 7 | P1 | `server.ts`, `auth.ts` | Members of an allowed organisation or team could sign in but `getSession` refused them: bounced to the login page forever. Reproduced. | fixed 2220805 (the member is added as an individual allowed user at sign-in; removing the organisation later does not remove them) |
| 8 | P1 | `projectcontext.ts` | `get_project_context` read the 5000 oldest events: the last message, last check and changed files of a long task were stale. Reproduced. | fixed f463a72 |
| 9 | P1 | `projectcontext.ts` | The snapshot looked up the pull request of every task (sequential GitHub calls, 8 s timeout each) while showing 8. | fixed f463a72 |
| 10 | P1 | `runner.ts` | `pushed` was never reset: after a first push, new commits were not reported as unpushed on delete, and Open PR skipped the push. | fixed 037b161, 276aea2 |
| 11 | P1 | `install.sh`, `apply.sh` | Re-running `install.sh` to update rewrote the env file before the backup, so the "rollback" restored the new version. | fixed 402a50a |
| 12 | P1 | `apply.sh` | Under `set -e`, a failing render, firewall restart or `docker compose up` after the backup stopped the web service left it stopped, with no rollback. | fixed 402a50a |
| 13 | P1 | `apply.sh` `write_status` | The status file was written through a predictable temporary name in a directory the web user owns, then `chown`ed by root: a symlink there let a compromised web container overwrite and chown any file. Checked in a sandbox. | fixed 402a50a (`mktemp`) |
| 14 | P1 | `task-manage.tsx` | After renaming, the page navigated to `#manage`, an unknown tab: Activity opened instead of Settings. | fixed d20bf2d |
| 15 | P2 | `preview.ts` | A `never` share link stopped working after 30 days (cookie lifetime) and showed "expired". | fixed 3f7dc7e |
| 16 | P2 | `preview.ts` `decide` | Public-path matching used the parsed path; `/api/webhooks/..%2f..%2fadmin` matched the prefix. Exploitability depends on the app decoding `%2f`. | fixed 3f7dc7e (encoded separators, backslashes and leading `//` never match) |
| 17 | P2 | `service.ts` | REST task creation accepted negative or non-numeric `maxTokens` (stopped at once), fractional or huge `maxIterations`. | fixed ebae302 |
| 18 | P2 | `service.ts` | `resume_task` on a running or queued task changed the limits and then failed with "Unexpected error". | fixed ebae302 |
| 19 | P2 | `service.ts` | A project named like a number (`2048`) could not be found; `2` found another project. | fixed ebae302 |
| 20 | P2 | `service.ts` | `get_attempt_diff` for `base` never listed commits; the dashboard said "uncommitted changes only". | fixed ebae302 |
| 21 | P2 | `service.ts` | `send_instruction` on a `budget_exceeded` task restarted it pointlessly. | fixed ebae302 (code reading) |
| 22 | P2 | `mcp.ts` | Bad `detail`, unknown task, bad path in `get_project_context` were reported as "Unexpected error ... Retry once". | fixed 33910e4 |
| 23 | P2 | `server.ts` | Open redirect after sign-in: `next=/\evil.com`. | fixed 287c8f9 |
| 24 | P2 | `routes-api.ts` | Any signed-in user could revoke MCP clients. | fixed 0d60d29 |
| 25 | P2 | `service-watch.ts`, `preview-watch.ts` | Floating promises in timers: a task deleted during a tick could crash the daemon (Node ≥ 15 default). | fixed d94b425 |
| 26 | P2 | `remote.ts` | A stream cut mid-line made `exec` throw instead of returning an exit code. | fixed 227780b (code reading) |
| 27 | P2 | `snapshot.ts` | Two tasks finishing `setup` together wrote the same temporary archive. Reproduced. | fixed 49c4023 |
| 28 | P2 | `sandbox.ts`, `git.ts` | Multibyte characters split across chunks became U+FFFD in agent output, diffs and check output. | fixed 6ca7fec, 0fd4d40 |
| 29 | P2 | `sandbox.ts` | Task containers had no pids limit and allowed swap. | fixed 6ca7fec |
| 30 | P2 | dashboard | Sign out, the task card's "Open preview" and confirmation dialogs (Cancel, Esc) had no pending state or could be repeated or dismissed mid-request; `costLabel` was dead code. | fixed b29159f |

## Confirmed, deferred

| Sev | Where | Scenario | Reason |
|-----|-------|----------|--------|
| P2 | `sandbox.ts` `syncServices` | The agent can set a service `memory`/`cpus` in `bivouac.yml` with no ceiling. | Needs an administrator-level maximum setting (a feature); the agent already runs arbitrary code in its own container. |
| P2 | `runner.ts`, `sandbox.ts` | `dev.log` is unbounded and `readFile` loads it whole. | Needs log rotation in the supervisor; no disk quota on task containers either. |
| P2 | `service.ts` `describeTask`, `addTokenProject` | `get_task` returns agent messages and check output without `redactSecrets`; `repoUrl` with embedded credentials is echoed and stored. | Larger change in several outputs; the project-context path already redacts. |
| P2 | `snapshot.ts` | A secret inside a wholly ignored directory (for example `.vercel/.env.production.local`) is archived. | Needs file-level listing of ignored directories. |
| P2 | `snapshot.ts` | The snapshot fingerprint ignores `.gitignore`; a restore can overwrite tracked files if a directory became tracked. | Unlikely layout. |
| P2 | `gitdiff.ts` | Live reads write a permanent `refs/bivouac/marks/<sha>` per call; never pruned. | Needs a pruning policy for marks. |
| P2 | `runner.ts` | An attempt interrupted by a crash never gets an end mark; durations include idle time before a resume; the cost of a killed attempt is not counted (cost only arrives in `result`). | Needs a change of how events are attributed to attempts and a cost estimate. |
| P2 | `runner.ts` | An instruction sent while the task is checking or finishing stays pending; instructions are consumed before the run starts. | Behaviour change in the loop. |
| P2 | `updates.ts` | Window between `launch` and the first status write where new work is not blocked; a retry of the same version audits the old outcome; the nightly auto update retries every 10 s when launch throws and uses the container's time zone. | Needs a state machine change in the updater; covered by the e2e only with test versions. |
| P2 | `routes-api.ts` | `settleLogin` race can show an error after a successful Claude sign-in; the domain settings route is weaker than the wizard's check; a project token edit is not validated. | Small each, but each needs UI/flow testing against GitHub or Claude accounts that I cannot do here. |
| P2 | `preview-watch.ts`, `shots.ts` | No "recovered" note after a manual restart if the poll saw `starting`; a timed-out capture may leave processes and files; `shot_runs` of failed captures are never pruned. | Cosmetic or rare. |
| P2 | `oauth.ts`, `mcp.ts`, `gitdiff.ts` | `redirect_uri` optional at the token endpoint (PKCE still required); `list_tasks` unbounded; costKind missing on `list_projects`; `get_attempt_diff` truncation signalling; up to 50 parallel attempt diffs. | Low impact. |
| P2 | `install.sh` | A `BIVOUAC_DOMAIN` given only through the environment is not kept when `install.sh` is re-run (a domain set in the wizard is kept). | Narrow. |
| P2 | `routes.ts` | `trustForwardHeader: true` on forwardAuth. Not exploitable with the shipped Traefik configuration (it strips untrusted `X-Forwarded-*`). | Hygiene only. |
| P2 | `checkRef`, SSE replay | Base branches containing `+` or `@` fail to diff; a reconnect more than 5000 events behind skips the gap. | Rare. |
| P2 | whole repo | About 180 comment lines were added since v0.4.1. | Left in place: mass removal would touch files unrelated to any fix. |
| P2 | dashboard | The task page `reload` ignores errors other than 404; tab lists have no scroll hint at 375 px; a few buttons (confirm Cancel, theme toggle) are under 44 px. | Visual or rare. |

## Rejected or reduced by the verifiers

- Preview watch "floating promise crash": rejected for `PreviewWatch` (each check is already caught; only the DB-level `listTasks` could fail). Kept for `ServiceWatch` (fixed, item 25), and the catch was added to both timers anyway.
- Resume overriding an owner limit at or below the current attempt (`runner.ts:100`): rejected, it matches `docs/decisions.md` (a limit already reached would stop the task at once).
- "Trust forward header" (see above): rejected as a vulnerability.
- Instructions "lost" when sent during a check: reduced to a UX defect (the instruction is not lost; it is applied at the next resume).
- Item 2 is reported as P0 by the reviewers; the verifier could not reproduce the final step, so it is listed as P1 and fixed with the rest of the git hardening.
- A reviewer's tokenizer worry in `claude.ts` (`tokenFromLines`) was not reported as a finding: it needs a layout not present in the captured output.

## Not verified

The fixes to `apply.sh`/`install.sh` were checked with `bash -n` and a sandbox for `write_status`; the failure paths of `deploy` were not run against Docker or systemd (no VM was created for this mission). The Docker integration tests (services, snapshot benchmark, task runtime) pass locally after the git changes.
