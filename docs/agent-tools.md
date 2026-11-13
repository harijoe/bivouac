# Browser, documentation and skills for the agent

Every task agent starts with two MCP servers and two skills, so it can look at the UI it builds, read current library documentation and follow design guidance. Nothing needs to be configured; `bivouac.yml` and the dashboard only adjust it.

## What the agent has

| What | Where it comes from | Default |
|---|---|---|
| `playwright` MCP (`@playwright/mcp` 0.0.85) | task image, headless, the Chromium of the image | on |
| `context7` MCP (`@upstash/context7-mcp` 4.7.0) | task image, current docs for libraries | on |
| `frontend-design`, `webapp-testing` skills | task image, [anthropics/skills](https://github.com/anthropics/skills) at commit `2c5958e`, Apache-2.0 | on |
| Catalogue skills (`skills:`) | cached on the server, installed when the task starts | off |
| Skills of the repository (`.claude/skills`) | the repository | always work |
| Your own MCP servers (`mcp:`) | `bivouac.yml` | none |

The prompt tells the agent what it has, and that every user-interface change must be checked on the running preview with the browser (375 px and 1280 px, console errors) before it considers the work finished. The agent reaches its dev server at `http://localhost:<port>` for every port in `ports:`.

The task page ("Agent tools") and `get_task` (`tooling`) list the servers (with the status reported by the CLI: connected, failed, or skipped with the reason) and the skills the agent had in its last session.

Measured cost of the two default servers: about 700 more cached input tokens per request (tool definitions are loaded on demand by the CLI). Switch them off for tasks that never touch a UI.

## `mcp:` in `bivouac.yml`

```yaml
mcp:
  playwright: false        # turn a default off (both default to true)
  context7: false
  linear:                  # a server of your own: either `url` (HTTP) ...
    url: https://mcp.linear.app/mcp
    headers: { Authorization: "Bearer ${LINEAR_API_KEY}" }
    secrets: [LINEAR_API_KEY]
  docs:                    # ... or `command` (stdio)
    command: npx
    args: ["-y", "@acme/docs-mcp@2.1.0"]
    env: { DOCS_REGION: eu }       # not secret: it is in the repository
    secrets: [DOCS_TOKEN]          # also given to the process as $DOCS_TOKEN
```

- At most 6 servers; names are lowercase letters, digits, `-` and `_`.
- `${NAME}` can only refer to a name listed in that server's `secrets:`; anything else is refused when the file is read.
- A stdio server receives each of its secrets as an environment variable with the secret's name.

### Secrets

Secret values are never in the repository. An administrator enters them in the dashboard, **Settings > Projects > MCP servers and secrets**. They are stored encrypted like the other secrets, are write-only (the API lists names and dates, never values), are not written to the history, and are masked if the agent echoes one. The `--mcp-config` given to the agent contains only `${VARIABLE}` references; the values travel in the environment of the agent process.

**Approval.** `bivouac.yml` is written by the agent too, so a server that asks for secrets gets them only after an administrator approves its exact definition (name, command or URL, arguments, secret names) in the same dashboard section. Changing the definition withdraws the approval. Until then the server is skipped and the agent is told why. A server without secrets needs no approval.

Be aware that a secret handed to a server is, by nature, readable by the agent that uses that server (it is in the environment of the agent process). Give MCP servers credentials you would give the agent.

### Context7 key

Context7 works without a key. An administrator can add one in **Settings > Context7** for higher limits; it is passed to the server when present.

## `skills:` in `bivouac.yml`

```yaml
skills: [taste-skill]
```

The catalogue is small and kept by Bivouac: each entry is a repository pinned to a commit, fetched once into the server's cache and installed into the task's `~/.claude/skills` when it starts (a skill removed from the list is removed again at the next attempt).

| Name | Source | Licence |
|---|---|---|
| `taste-skill` (installs as `design-taste-frontend`) | [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill) at `f6b7657` | MIT |

Unknown names make the file invalid (the previous configuration stays in use and the error is shown).

**Your repository's own skills** in `.claude/skills/<name>/SKILL.md` keep working as before; they are listed on the task page as "repository".

### Hooks of catalogue skills

`taste-skill` declares a `Stop` hook that runs its own gate (`gate.mjs`, timeout 600 s) every time the agent finishes. That would run outside Bivouac's limits and could block the end of a session for ten minutes or push the agent into extra turns. Bivouac removes the `hooks:` block from the front matter of catalogue skills when it caches them. The skill is otherwise unchanged: the agent can still run the gate by hand when the skill says so (the prompt tells it to do that only if it ends within a few minutes), and a manual run is an ordinary command under the usual tool limits.

The success check (`success:`) is unaffected: it runs after the session, decides whether the task succeeded, and is the only thing that does. A skill's gate never replaces it. Hooks in the repository's own `.claude/settings.json` or `.claude/skills` are the repository's responsibility and are not touched.
