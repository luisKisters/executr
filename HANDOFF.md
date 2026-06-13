# Handoff — executr (as of 2026-06-08, session 2)

State dump for picking this back up in a fresh session. For *how to debug*, read **`CLAUDE.md`**.

## TL;DR
- executr (ralphex + fya loop) runs in prod on Coolify, container `executr-vbupc2pw4ynwyl5ynhgbnxfb`,
  driving `REPOS`: **summario, timy, calendrino, notetakr** (notetakr already in env — confirmed).
- **calendrino** "riso-ui-restyle": ✅ done, **PR #3**, plan-state=`completed`.
- **notetakr** "meeting-notes-mvp": ✅ done + merged (**PR #2**); plan-state flipped `failed`→`completed`
  (finalize had failed on a post-merge non-ff push). Plan file **reformatted** (Task 1..9, `- [ ]`) to
  fix the "stuck at Task 1" dashboard label; reseeded plan-state so it does NOT re-run.
- **notetakr** "next-product-phase" (the new PRD): 🟢 **RUNNING** on branch `next-product-phase`.
  Task 1 done (`e787291`, 98 tests pass), on Task 2 as of 15:07. No spend-limit block during this run.

## 🔑 Root-cause fix this session: `.ralphex/` dirtied the tree → 2nd plan couldn't branch
- Symptom: the new plan failed instantly with `create branch …: worktree has uncommitted changes`,
  listing `.ralphex/plan-state/*`. ralphex refuses to branch from a dirty tree; executr's own
  `.ralphex/` (plan-state + progress) was **untracked and not gitignored**, so once a repo ran its
  **first** plan, the leftover files blocked **every later plan**. (Every repo so far had only run its
  first plan, so this was latent until now.)
- **Fix (live, durable via the volume):** added `.ralphex/` to each repo's `.git/info/exclude`
  (`/workspace/<repo>/.git/info/exclude`) — survives restart **and** redeploy.
- **Fix (code, for fresh containers/new repos):** `entrypoint.sh` now writes `.ralphex/` into the
  global excludesfile **and** appends it to each repo's `.git/info/exclude` in the clone loop. *On a
  branch, not yet pushed/redeployed* — see Pending.

## What got executed/changed this session
1. Confirmed **notetakr is already in `REPOS`** (container env + Coolify `.env`) — no env change needed.
2. Moved the new PRD `notetakr docs/prd-next-steps-ralphex.md` → `docs/plans/20260608-next-product-phase.md`
   and pushed to notetakr `main` (executr only watches `docs/plans/*.md`, so it never picked it up before).
   Loop picked it up → **running**.
3. Marked notetakr meeting-notes-mvp plan-state `completed`; reformatted that plan (Task 0..8→1..9,
   `* [ ]`→`- [ ]`) to fix the dashboard; reseeded its `.sha256` so the reformat does NOT trigger a re-run.
4. Fixed the `.ralphex/` dirty-tree bug (above).
5. Added design plan `docs/persistent-state-and-worktrees.md` (persistence + worktree untracked inheritance).

## Current important state / gotchas
- **Running image predates the Swift bake.** The live container's image is dated **2026-06-07 23:43**,
  i.e. *before* commit `2f2d395` (Swift bake). So Swift is still a **live `/opt/swift` install** on this
  container → a redeploy/recreate **WILL re-break Swift** unless it pulls the Swift-baked `:latest`.
- **Persistence gap:** only `/workspace` is a volume. `~/.claude` (26 MB, 46 transcripts) and `~/.cache`
  (904 MB) live in the writable layer → **wiped on redeploy**. See the design doc for the volume plan.
- **Codex review is removed for now.** executr forces `--external-review-tool=none`, ignores stale
  `EXTERNAL_REVIEW=codex` env, and the image no longer installs the Codex CLI.
- **Dashboard label bug** is cosmetic + in the compiled ralphex binary (can't patch). Triggered by
  `Task 0` numbering + `* [ ]` bullets. **Always author plans with `- [ ]` and number from Task 1.**

## Pending / next steps
1. **Watch next-product-phase finish** (Tasks 2–6 + reviews → finalize/PR). If finalize's push fails
   (like calendrino/meeting-notes-mvp), push the branch + open the PR manually.
2. **Push + merge the executr fix branch**, let CI build the new `:latest` (carries the `.ralphex/`
   entrypoint fix + Swift bake), then **redeploy** — but only **after** the notetakr run finishes
   (redeploy interrupts the current turn; it resumes from `/workspace`).
3. **(Optional) Implement the persistence volumes** from `docs/persistent-state-and-worktrees.md` in the
   same redeploy so transcripts + caches survive.

## Key links / access
- Dashboard: https://executr.luiskisters.com
- calendrino PR #3: https://github.com/luiskisters/calendrino/pull/3
- notetakr: branch `next-product-phase` (running) · `meeting-notes-mvp` merged (PR #2)
```sh
ssh root@ssh.luiskisters.com                       # cloudflared + 1Password agent
C=executr-vbupc2pw4ynwyl5ynhgbnxfb
docker exec $C ps -o etime,time,pcpu,cmd -ax | grep -E 'ralphex|fya|claude' | grep -v grep
# stalled? (empty=stalled)
docker exec -u node -e HOME=/home/node $C find /home/node/.claude/projects/-workspace-notetakr -name '*.jsonl' -newermt '-2 min'
docker exec -u node $C git -C /workspace/notetakr log --oneline next-product-phase | grep -i Task
```
