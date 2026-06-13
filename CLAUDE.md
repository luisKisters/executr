# executr — operations & debugging guide

This is the deployment layer that runs **ralphex** (the Ralph loop) via **fya** (Max-plan
Claude driver), agent-browser, and the executr control-plane in one container on Coolify. The
control-plane defaults new claimed plans to Codex (`gpt-5.5`, reasoning `xhigh`); unclaimed
plans still run through the legacy Claude/fya loop. This file is how to debug it when a plan
looks "stuck". Read top-to-bottom the first time.

## Access

- **SSH:** `ssh root@ssh.luiskisters.com` (cloudflared ProxyCommand + 1Password SSH agent).
  If signing fails with *"communication with agent failed"* → unlock / authorize 1Password and retry.
- **Container:** `executr-<id>` (e.g. `executr-vbupc2pw4ynwyl5ynhgbnxfb`), image `ghcr.io/luiskisters/executr:latest`.
  Find it: `docker ps | grep executr`.
- **Run as `node`** (owns `/workspace` and `~/.claude`):
  `docker exec -u node -e HOME=/home/node <C> sh -c '…'`. Running git/claude as **root** hits
  git's *"dubious ownership"* and refuses to operate. For `apt`/system installs, use root (default exec).
- **Dashboard:** https://executr.luiskisters.com (ralphex `--serve`, bound `0.0.0.0`).
- **Coolify config:** `/data/coolify/services/<id>/` → `docker-compose.yml` + `.env`. `REPOS` is only
  a bootstrap seed now; the control-plane registry is the live source of truth.

## How the loop works

`entrypoint.sh` (baked into the image): seeds the control-plane registry from `$REPOS` when present,
starts the control-plane on `CONTROL_PLANE_PORT`, serves the ralphex dashboard, starts a background
**phase_pusher** (pushes each repo's feature branch every ~60s), then loops forever over
`/workspace/.executr/repos.list`: per repo → ensure clone/init → `git pull` base branch → run
`ralphex` on each new, unclaimed `docs/plans/*.md`.

- **control-plane state** (`/workspace/.executr/orchestrator.db` by default): SQLite registry,
  execution rows, approval requests, provider policy state, and Telegram sessions. Inspect with
  `sqlite3 /workspace/.executr/orchestrator.db`.
- **repo registry bridge** (`/workspace/.executr/repos.list`): active registry repos in
  `name=URL#branch` format for the shell loop. If the loop is not seeing a repo, inspect this file
  first.
- **plan-state** (`<repo>/.ralphex/plan-state/<plan>.md_.{sha256,status}`): each plan runs **once per
  content hash**; status = `completed|failed|invalid`. The loop skips a plan whose hash is unchanged.
  - **Re-run / unstick a plan:** delete its `.sha256` + `.status` files → loop re-runs it within `POLL_SECONDS` (30s).
- **claims** (`/workspace/.executr/claims` by default): an active claim for a non-`claude-code`
  provider makes the legacy loop skip that plan so the control-plane provider path owns it.
- **observer/recovery pollers:** the control-plane process classifies running executions every
  ~45s and runs recovery checks every ~60s. Approval requests appear in the Activity UI and can be
  decided from the UI or Telegram.
- Each task = one ralphex **iteration** = one fya-driven Claude turn. After all tasks →
  **code-review rounds** → **finalize** (push branch + open PR). `finalize` is best-effort: if its
  `git push` hits a non-fast-forward (e.g. after a squash) it gives up — the branch/PR may not appear,
  push it manually.

## ⚠️ The #1 issue: the no-transcript startup STALL

**Symptom:** dashboard shows a task "running" ~30 min with no new transcript; the `claude` process has
high elapsed time but ≈0 CPU; no `*.jsonl` is being written.

**Cause:** fya launches the *interactive* claude TUI and types the prompt, but claude intermittently
produces **no transcript** (a startup race). fya then waits its full **30 min turn-timeout** →
`FYA_TRANSIENT_TIMEOUT` → ralphex **retries the iteration** (self-heals).

- **It self-heals in ≤30 min. Do NOT `kill` claude/fya externally** — an external kill makes ralphex
  report `claude execution: context canceled` and **fail the whole plan** (marks plan-state=failed),
  instead of retrying the turn.
- **Things that do NOT fix it** (tried, reverted): `fya --gate` (only counts idle *after* the first
  transcript write, so it misses no-transcript stalls **and** would kill genuinely-long turns); an
  external watchdog kill (→ plan failure); a short `--turn-timeout` (cuts legit long turns). The safe
  behavior is the default 30 m self-heal.
- **Stalled vs working:** `find ~/.claude/projects/-workspace-<repo> -name '*.jsonl' -newermt '-2 min'`
  → empty = stalled; non-empty = working. (Also: working turns show real CPU + child build processes.)

## Debug recipes (run as `node`)

```sh
C=executr-<id>
# what's running
docker exec $C ps -o etime,time,pcpu,cmd -ax | grep -E 'ralphex|fya|claude|codex|node .*control-plane' | grep -v grep
# stalled or working?  (empty = stalled)
docker exec -u node -e HOME=/home/node $C find /home/node/.claude/projects/-workspace-<repo> -name '*.jsonl' -newermt '-2 min'
# SOURCE OF TRUTH for current task = the agent's own words + commits (NOT the dashboard label):
docker exec -u node $C tail -20 /workspace/<repo>/.ralphex/progress/progress-<plan>.txt
docker exec -u node $C git -C /workspace/<repo> log --oneline <branch> | grep -iE 'feat:.*Task'
# control-plane state
docker exec -u node $C sh -c 'sqlite3 /workspace/.executr/orchestrator.db ".tables"'
docker exec -u node $C cat /workspace/.executr/repos.list
docker exec -u node $C ls -la /workspace/.executr/claims
# how many stalls so far
docker exec -u node $C grep -c 'fya turn timeout' /workspace/<repo>/.ralphex/progress/progress-<plan>.txt
# loop decisions (filter SSE noise)
docker logs --tail 60 $C 2>&1 | grep -v '\[SSE\]'
```

## Control-plane development

The service is a Node 22/Fastify app in `control-plane/`; it uses Node's built-in `node:sqlite`,
Vitest, and a `node-sqlite-compat` Vitest plugin so Vite resolves the experimental builtin.

```sh
cd control-plane
pnpm install
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run test:e2e
pnpm run build
```

The baked image includes `/opt/executr-control-plane/dist/index.js`; `CONTROL_PLANE_DIR` can point
the entrypoint at another source checkout for live debugging.

## Dashboard display bugs (cosmetic — ignore the labels)

- **"Stuck on Task 1":** if a plan numbers tasks from `Task 0`, the dashboard renders it as "Task 1"
  and **pins that label on every timeline row** — so it always looks like it's "still on Task 1".
  Ignore it; trust the commit messages + the transcript text.
- **No subtasks in the sidebar:** the sidebar only parses `- [ ]` checkboxes. Plans written with
  `* [ ]` (asterisk) show task headings but no sub-items, and number oddly. **Write plans with
  `- [ ]` bullets and number tasks from `Task 1`** to make the dashboard render correctly.

## The dialog fix (baked into the image — if it regresses, EVERYTHING stalls)

Claude ≥2.1 shows a *"Bypass Permissions mode"* modal on every interactive
`--dangerously-skip-permissions` launch; fya can't dismiss it → every turn stalls forever with no
transcript. Fixed by `~/.claude/settings.json` → `{"skipDangerousModePermissionPrompt": true}` (baked
in the image + re-asserted by entrypoint). The entrypoint also pre-accepts onboarding + per-repo
trust in `~/.claude.json`. If a brand-new run stalls on *every* turn from the start, check these first.

## Swift / macOS plans (e.g. `notetakr`) — Swift is now BAKED INTO THE IMAGE

Swift 6.3.2 is baked into the Dockerfile (`ARG SWIFT_VERSION=6.3.2`, native Debian 12 swift.org
build at `/opt/swift`, symlinked to `/usr/local/bin/swift`), so `local-validate` (`swift test`)
works out of the box and **a recreate/redeploy no longer re-breaks Swift plans**. History/details:

- It was originally installed **live** (swiftly's auto-install is **broken on Debian** — it builds a
  URL with a space), then baked into the image so it survives a recreate. The `~1 GB` layer is the
  tradeoff (slower image pulls).
- A **global gitignore** prevents `swift build` output from dirtying the tree (else ralphex refuses to
  create the feature branch): `git config --global core.excludesfile ~/.config/git/ignore` with
  `.build/`, `.swiftpm/` (set by the entrypoint).
- A macOS `.dmg` can't be built in the Linux container — it's built on the repo's **GitHub Actions
  macOS runner** (`xcodebuild archive` → `hdiutil create`). SwiftPM with no `platforms:` in
  `Package.swift` archives at an ancient macOS target → pass `MACOSX_DEPLOYMENT_TARGET=13.0`.

## `docker restart` vs Coolify redeploy — KNOW THE DIFFERENCE

| Action | Writable layer (live config patches, caches, `~/.codex` auth, transcripts) | Effect |
|---|---|---|
| `docker restart <C>` | **PRESERVED** | Stops+starts the same container; re-runs entrypoint (re-clone/pull, re-seed config, restart dashboard+loop). Kills the current run and restarts the loop. |
| Coolify **Redeploy** / `docker compose up` / recreate | **WIPED** (fresh container from the image) | Loses any **live-only** change. Swift is baked into the image now, so this no longer re-breaks Swift plans — but it still wipes `~/.cache`, Claude transcripts, and live `~/.codex` auth. |

So: a plain **restart is safe** (keeps everything). A **redeploy/recreate is safe for Swift** now (it's
baked in) but still throws away caches/transcripts/live auth — only do it when you mean to. A restart
rarely *helps* a stall — it just restarts the loop (and re-runs the in-progress plan from its last
committed state); the stall self-heals on its own anyway.
