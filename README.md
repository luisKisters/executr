# executr

Containerized **autonomous plan execution** for [summario](https://github.com/luisKisters/summario), deployable on Coolify.

It wraps [umputun/ralphex](https://github.com/umputun/ralphex) (the "extended Ralph loop") and drives it through [umputun/fya](https://github.com/umputun/fya) so unattended runs stay on the **Claude Max plan** instead of the Agent-SDK credit pool. Each plan task runs in a fresh Claude session, gets validated, **browser-verified with [agent-browser](https://github.com/vercel-labs/agent-browser)**, code-reviewed (Claude agents + optional codex cross-model), and shipped as a GitHub PR.

> Status: deployment scaffold. The image + Coolify wiring below are the focus; a couple of items are flagged **VERIFY** and the voice "ask-human" escalation is not built yet.

## What's in the container

| Tool | Role |
|---|---|
| Claude Code + **fya** | task execution & reviews on the Max plan (fya = PTY wrapper for headless interactive Claude) |
| ralphex | the loop: tasks → validation → review → finalize/PR |
| **agent-browser** (+ Chrome) | per-task browser verification against the app's dev server |
| codex | optional cross-model external review |
| pnpm, gh, git, ripgrep | toolchain |

## How it runs

A long-running worker container:

1. Clones the target repo (`REPO_URL`) into a persistent volume on first boot, `pnpm install`s it.
2. Serves the ralphex **dashboard** on `:8080` (Coolify maps a domain).
3. **Watches `docs/plans/*.md`** — drop a plan in and it executes: implement → validate → agent-browser check → commit → review → open PR.

A plan is plain markdown:

```markdown
# Plan: My Feature
## Validation Commands
- `pnpm test`
### Task 1: Do the thing
- [ ] implement X
- [ ] add tests
```

## Step 1 — Mint headless auth tokens (on your Mac)

There's no macOS keychain on the server, so auth is **token-based**:

```bash
# Claude (Max plan, headless): mint a portable OAuth token
claude setup-token            # -> CLAUDE_CODE_OAUTH_TOKEN   (VERIFY this keeps you on Max, not SDK credits)

# GitHub: a token with 'repo' + 'workflow' scope -> GITHUB_TOKEN

# Codex (optional cross-model review): either an OPENAI_API_KEY, or copy ~/.codex/auth.json
# into the container, or leave EXTERNAL_REVIEW=none.
```

## Step 2 — Deploy on Coolify

1. **New Resource → Docker Compose**, pointed at this repo (it has the `Dockerfile`, `entrypoint.sh`, `docker-compose.yml`).
2. **Environment Variables** — set these (secrets where sensitive); see [`.env.example`](./.env.example):
   - `CLAUDE_CODE_OAUTH_TOKEN`, `GITHUB_TOKEN` (required)
   - `REPO_URL`, `REPO_BRANCH` (default: summario / main)
   - `EXTERNAL_REVIEW` (`none` default; set `codex` + `OPENAI_API_KEY` to enable cross-model review)
   - `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL`
   - optional: `GROQ_API_KEY`, `TELEGRAM_BOT_TOKEN`
3. **Storage** — the named volume `executr_repo` persists the clone, `docs/plans/`, and `.ralphex/` state across redeploys.
4. **Domain** — point one at port `8080` for the dashboard.
5. **Deploy.** First boot is slow (clone + `pnpm install` + Chrome already baked in).

## Step 3 — Run work

Drop a markdown plan into `/workspace/docs/plans/` — via Coolify's container terminal, a committed file in the target repo, or the mounted volume. The loop picks it up; watch the dashboard; the PR lands on GitHub.

## How your MCPs / skills / envs carry over

- **MCPs** — the target repo's `.mcp.json` rides along in the clone; Claude-via-fya auto-loads it. MCP servers needing keys → add those as Coolify env vars.
- **Skills** — commit Claude skills into the repo, or bake them into the image (`COPY` into `$CLAUDE_CONFIG_DIR`). agent-browser skills ship with the CLI.
- **Envs** — the app's `.env.local` rides in the clone (or inject values as Coolify secrets, which is cleaner than committing).

## Gotchas (VERIFY on first deploy)

1. **Claude token billing** — confirm `CLAUDE_CODE_OAUTH_TOKEN` + fya's interactive path bills to Max, not Agent-SDK credits. Smoke-test with a trivial plan first.
2. **Release asset names** — confirm the exact `fya` / `ralphex` linux tarball filenames on their releases pages (the Dockerfile guesses `*_linux_<arch>.tar.gz`).
3. **npm package names** — confirm `@anthropic-ai/claude-code` and `@openai/codex` if those installs fail.
4. **Codex headless** — `OPENAI_API_KEY` bills per use; for the ChatGPT-plan codex, mount `~/.codex/auth.json` instead, or keep `EXTERNAL_REVIEW=none`.
5. **Dashboard idle** — verify `ralphex --serve --watch` runs without prompting on your ralphex version.
6. **Voice ask-human** — not wired yet; `TELEGRAM_BOT_TOKEN` here only powers ralphex's built-in notifications for now.

## Local test

```bash
cp .env.example .env   # fill in tokens
docker compose up --build
# dashboard: http://localhost:8080
```

## Background

This is the deployment layer of the "executr" idea — adopting ralphex + fya rather than building an orchestrator from scratch. See the design notes in the summario/exponential work for the fuller picture (XML/markdown plans, per-phase browser gate, Telegram voice escalation).
