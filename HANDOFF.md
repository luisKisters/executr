# Handoff — executr (as of 2026-06-08)

State dump for picking this back up in a fresh session. For *how to debug*, read **`CLAUDE.md`**.

## TL;DR
- executr (ralphex + fya loop) runs in prod on Coolify, container `executr-vbupc2pw4ynwyl5ynhgbnxfb`,
  driving repos in `REPOS`: **summario, timy, calendrino, notetakr**.
- **calendrino** "riso-ui-restyle" plan: ✅ done — all 11 tasks, reviewed, pushed to `release`, **PR #3** open.
- **notetakr** "meeting-notes-mvp" plan: ✅ all 9 tasks implemented + committed; **in code review** (grinding
  through stalls); a macOS **`.dmg` is built + released** (`notetakr-dev-20260608`).
- The whole reason early runs failed was found + fixed: a Claude bypass-permissions **dialog** (now baked),
  and for notetakr, **no Swift** in the container (installed live, now being **baked into the image**).

## The big root-cause fixes this session (all on executr `main`)
1. **Bypass-permissions dialog** — Claude ≥2.1 shows a modal on every interactive
   `--dangerously-skip-permissions` launch; fya can't dismiss it → every turn stalled forever.
   Fix: `~/.claude/settings.json` `{"skipDangerousModePermissionPrompt": true}` (baked + entrypoint-seeded).
2. **Reconciled entrypoint** — prod was running plan-state dedup + `--host 0.0.0.0` + codex fallback that
   were never committed (lived in closed PR #1). Now in `main`.
3. **phase_pusher** — pushes each repo's feature branch every ~60s (per-phase preview); finalize still PRs.
4. **No-transcript stall** — intermittent fya/claude startup race; **self-heals in ≤30m via retry**. Do NOT
   external-kill (causes plan FAILURE). `--gate` / watchdog / short turn-timeout all rejected (see CLAUDE.md).
5. **Swift for notetakr** — installed live (Swift 6.3.2, Debian 12 native build → `/opt/swift`), + a global
   gitignore for `.build/`. **Now baked into the Dockerfile/entrypoint** so it survives redeploys (this commit).

## Current important state / gotchas
- **Live-only vs baked:** the running container has Swift + gitignore as **live** changes (writable layer).
  They survive `docker restart` but a **Coolify redeploy/recreate WIPES them** → re-breaks notetakr — *unless*
  the redeploy pulls the new Swift-baked image (this commit, after CI builds it).
- **Dashboard label bugs** (cosmetic): plans numbered from `Task 0` show "Task 1" pinned on every row;
  `* [ ]` checkbox bullets don't render subtasks. Truth = git commits + transcript text. Future plans: use
  `- [ ]` and number from Task 1.
- **finalize is best-effort:** calendrino's finalize failed to push (post-squash non-ff) — had to push the
  branch + open PR #3 + fast-forward `release` manually. Watch for the same on notetakr.

## Pending / next steps
1. **Let notetakr's review finish** → it will `finalize` → open a PR on `meeting-notes-mvp`. If finalize's push
   fails (like calendrino), push the branch + open the PR manually.
2. **Redeploy executr in Coolify** *after* CI builds the Swift-baked image (this commit) — once on the new
   image, redeploys are safe (Swift persists). Don't redeploy before the image is built, or Swift drops out.
   A redeploy interrupts the running notetakr review (resumes from the volume).
3. Optional: point the `dmg-build` workflow at notetakr's final reviewed commit for an updated `.dmg`.
4. Optional: fix the notetakr plan formatting (`* `→`- `, renumber from Task 1) so the dashboard renders right.

## Key links
- Dashboard: https://executr.luiskisters.com
- calendrino PR: https://github.com/luiskisters/calendrino/pull/3 · `release` branch updated
- notetakr release/.dmg: https://github.com/luiskisters/notetakr/releases/tag/notetakr-dev-20260608
- notetakr branch: `meeting-notes-mvp` · dmg workflow on branch `dmg-build`

## Access / quick commands
```sh
ssh root@ssh.luiskisters.com                       # cloudflared + 1Password agent
C=executr-vbupc2pw4ynwyl5ynhgbnxfb
docker exec $C ps -o etime,time,pcpu,cmd -ax | grep -E 'ralphex|fya|claude' | grep -v grep
# stalled? (empty=stalled)
docker exec -u node -e HOME=/home/node $C find /home/node/.claude/projects/-workspace-notetakr -name '*.jsonl' -newermt '-2 min'
docker exec -u node $C git -C /workspace/notetakr log --oneline meeting-notes-mvp | grep -i Task
```
