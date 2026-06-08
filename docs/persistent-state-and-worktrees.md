# Design plan: persistent dev-container data + worktree untracked inheritance

Status: **proposal** (not yet implemented). Two related goals for the executr
container(s):

1. **Persistence** — make the data inside a dev container survive a Coolify
   redeploy/recreate, not just a `docker restart`.
2. **Worktree inheritance** — when work is isolated in a git worktree, give that
   worktree the *untracked* files from `main`'s checkout (env, secrets, model
   caches, build output) so builds/auth actually work inside it.

Read `CLAUDE.md` (restart vs redeploy table) first — it defines the durability
boundary this plan is built around.

---

## Part 1 — Persistent dev-container data

### Current state (measured 2026-06-08)

| Path | Backing | Survives `docker restart` | Survives Coolify redeploy/recreate |
|---|---|---|---|
| `/workspace` (repo clones, `docs/plans`, `.ralphex/` progress + plan-state) | named volume `…_executr-repo` | ✅ | ✅ |
| `/home/node/.claude` (**26 MB**, config + **46 session transcripts**) | writable layer | ✅ | ❌ wiped |
| `/home/node/.cache` (**904 MB**: SwiftPM/build caches, model + tool downloads, pnpm) | writable layer | ✅ | ❌ wiped → re-downloaded |
| `/opt/swift` (live-installed toolchain on the *current* container) | writable layer | ✅ | ❌ wiped (until the Swift-baked image ships) |
| `~/.codex/auth.json` (if used for `EXTERNAL_REVIEW=codex`) | writable layer | ✅ | ❌ wiped |
| `~/.claude.json`, `~/.git-credentials`, baked `~/.claude/settings.json` | re-seeded by `entrypoint.sh` each start | ✅ | ✅ (re-created) |

So today **only `/workspace` is durable across a redeploy.** A redeploy throws
away ~930 MB of caches + all Claude transcripts, and (on the currently-running
pre-bake image) the live Swift toolchain.

### What actually needs to persist

- **Claude transcripts** (`~/.claude/projects/**/*.jsonl`) — the only record of
  what each turn did; useful for debugging stalls and auditing runs.
- **Caches** (`~/.cache`, pnpm store) — avoid the 900 MB re-download/rebuild on
  every redeploy (slow cold starts).
- **Codex auth** (`~/.codex`) — so `EXTERNAL_REVIEW=codex` keeps working without
  re-auth (or keep using the `OPENAI_API_KEY` env var, which already persists via
  Coolify).
- **Tool installs** — should be **baked into the image**, not persisted as data
  (Swift is already baked in the Dockerfile as of `2f2d395`; the running
  container just predates that image — see migration note).

### Recommended approach: targeted HOME sub-volumes + bake tools

Add named volumes for the *stateful* HOME subdirs only. Do **not** mount all of
`/home/node` — it would shadow baked content (Chrome-for-Testing, `settings.json`)
and bloat the volume.

`docker-compose.yml`:

```yaml
    volumes:
      - executr_repo:/workspace                 # existing
      - executr_claude:/home/node/.claude       # config + transcripts (durable history)
      - executr_cache:/home/node/.cache         # build/model/pnpm caches (fast cold start)
      - executr_codex:/home/node/.codex         # codex auth (optional; or use OPENAI_API_KEY)
volumes:
  executr_repo:
  executr_claude:
  executr_cache:
  executr_codex:
```

Notes / gotchas:

- **First-mount copy:** a fresh named volume is seeded from the image's contents
  at that path, so the baked `~/.claude/settings.json` lands in `executr_claude`
  on first creation; `entrypoint.sh` re-asserts it on every start anyway, so the
  `skipDangerousModePermissionPrompt` fix still holds.
- **Ownership:** the entrypoint already starts as root and `chown`s `/workspace`;
  extend that `chown` to the new mount points (`/home/node/.claude`,
  `~/.cache`, `~/.codex`) so `node` owns freshly-created volumes.
- **Keep baking tools** (Swift, gh, codex, agent-browser, Chrome) into the image
  rather than persisting them as data — deterministic and rebuildable.
- This does not change the `docker restart` story (already durable); it closes
  the **redeploy** gap.

### Migration note (important, time-sensitive)

The running container uses an image built **2026-06-07 23:43**, i.e. **before**
the Swift-bake commit. Its Swift lives in the writable layer. Therefore:

1. Confirm CI has published the Swift-baked `:latest` (commit `2f2d395`).
2. Let the in-flight notetakr `next-product-phase` run finish (a redeploy
   interrupts the current turn; it resumes from `/workspace`).
3. Add the volumes above, then redeploy. After that, redeploys are safe **and**
   transcripts + caches persist.

---

## Part 2 — Worktrees include all untracked files from `main`

### Why this matters

executr today does **not** use git worktrees: `ralphex` runs in-place in the
repo dir and creates a feature *branch*. That couples every plan to one working
tree — which is exactly why the `.ralphex/` dirty-tree bug (now fixed) blocked
the 2nd plan, and why two plans can't run in one repo concurrently.

Moving to **one worktree per plan/repo** gives clean isolation (parallel plans,
no cross-plan dirty state, independent checkouts). But it surfaces a core git
fact:

> `git worktree add <path> <branch>` materializes only **tracked** files at that
> commit. Untracked and ignored files in `main`'s working tree are **not**
> copied.

So a new worktree is missing: `.env`/secrets, downloaded transcription/ML models,
`.build/` + SwiftPM caches, `node_modules`, and any other local-only state —
builds, auth, and `local-validate` break inside it.

### Proposed mechanism

After creating a worktree, replicate `main`'s untracked (and optionally ignored)
files into it. Enumerate with git itself so `.gitignore` semantics are respected:

```sh
SRC=/workspace/<repo>            # the canonical main checkout
WT=/workspace/.worktrees/<repo>/<branch>

git -C "$SRC" worktree add "$WT" "<branch>"

# 1) untracked-but-not-ignored (e.g. a freshly-written .env): always copy
git -C "$SRC" ls-files --others --exclude-standard -z \
  | rsync -a --from0 --files-from=- "$SRC"/ "$WT"/

# 2) ignored files (caches, models, node_modules, .build): copy as HARDLINKS to
#    avoid duplicating gigabytes, or share via symlink (see below)
git -C "$SRC" ls-files --others --ignored --exclude-standard -z \
  | rsync -a --from0 --link-dest="$SRC" --files-from=- "$SRC"/ "$WT"/
```

Wrap this in `scripts/new-worktree.sh <repo> <branch>` and a matching
`scripts/rm-worktree.sh` (`git worktree remove`).

### Policy decisions to make

- **Copy vs share for big dirs.** `node_modules`, `.build/`, model caches: prefer
  a **shared cache** (symlink the worktree's `.cache`/model dir at the
  `executr_cache` volume, or hardlink) over copying GBs per worktree. Copy only
  small config/secret files outright.
- **Secrets duplication.** Copying `.env` into every worktree spreads secrets
  across the disk — acceptable inside one container, but document it; prefer a
  single mounted secrets file + symlink if it grows.
- **Re-sync semantics.** If `main`'s untracked files change after the worktree is
  made (e.g. a new model download), decide whether to re-run the sync or treat
  the worktree as a point-in-time snapshot.
- **Cleanup.** Worktrees accumulate; `rm-worktree.sh` must `git worktree remove`
  *and* delete copied untracked files. Add `git worktree prune` to the loop.

### Integration with executr

If executr adopts worktree-per-plan, the watch loop in `entrypoint.sh` would, per
new plan: `new-worktree.sh <repo> <plan-branch>` → run `ralphex` with its CWD in
the worktree → `rm-worktree.sh` (or keep for inspection) on completion. The
`.ralphex/` exclude (already added) keeps each worktree's runtime state from
dirtying it; per-worktree state still lives under `/workspace` (durable per Part 1),
and big caches stay shared via the cache volume.

This is a larger change than Part 1 — recommend landing Part 1 (persistence)
first, then prototyping `new-worktree.sh` against a single repo before wiring it
into the loop.
