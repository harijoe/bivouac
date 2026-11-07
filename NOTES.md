# NOTES — VPS inspection (2026-11-07)

- Host: Ubuntu, kernel 6.8, 2 vCPU, 7.8 GiB RAM, 96 GB disk. Node 22, pnpm 12, Docker 29 installed. Tailscale NOT installed.
- Listening: 22 (ssh), 3000 (jeanmichelimmo-mcp container, owned by another agent), DNS stubs on loopback.
- 80/443 are free but we never install bivouac here; local tests use high ports (3100 etc.).
- Foreign Docker resources (do not touch): jeanmichelimmo-* containers, `jeanmichelimmo_internal` network.
- Everything we create in Docker is prefixed `bivouac-dev-`. VMs: Hetzner Cloud only, servers prefixed `bivouac-dev-`.
- Git push uses `GIT_ASKPASS=~/.bivouac-askpass.sh` (reads token from ~/bivouac-inputs.env; token never stored in repo).
- Real CLI: `claude` 2.1.319 available locally. Captured fixture: packages/shared/fixtures/real-run.jsonl
  (flags used: `-p --output-format stream-json --verbose --dangerously-skip-permissions`).
  Event types seen: system/init (session_id, model, tools), assistant (message.content[], message.usage), user (tool_result),
  rate_limit_event, result (total_cost_usd, usage, session_id, stop_reason, num_turns...).
- Repo harijoe/bivouac is PRIVATE. GHCR packages inherit privacy; fresh VMs cannot pull anonymously (see PROGRESS.md BLOQUÉ).
