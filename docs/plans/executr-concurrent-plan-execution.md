# Plan: per-project concurrent plan execution (worktree-isolated)

## Overview

executr's watch loop in `entrypoint.sh` runs **one plan at a time per repo**: it
iterates repos (`get_repo_list`) → plans serially and **blocks** on each `ralphex`
call until that plan fully finishes (tasks → review → PR). Because `ralphex` runs
**in-place** in the single repo clone (`/workspace/<name>`), two plans for the same
repo cannot run at once — they fight over one working tree.

This plan makes plan execution **concurrent, opt-in per repository**: a repo listed
in a new `CONCURRENT_REPOS` env var runs its not-yet-seen plans **in parallel**, each
in its **own git worktree** on its **own branch**, so e.g. three features build at the
same time and each opens its own PR. Repos NOT listed keep today's exact sequential
behavior — this MUST be a zero-behavior-change default.

Cross-feature auto-merge is **explicitly out of scope** (manual merge is fine for
now); it is recorded as a future idea in `docs/ideas.md`.

This builds on the **control-plane** branch. Preserve its additions verbatim:
`get_repo_list()` (registry-backed repo enumeration via
`/workspace/.executr/repos.list`, falling back to `REPO_LIST`) and the additive
`control_plane_claim_decision()` guard. Concurrency layers on top of both — it does
not replace or bypass them.

## Autonomy & Environment (unattended execution — READ FIRST)

Executed UNATTENDED by ralphex inside the executr Linux container (Debian 12,
non-root `node` user; `/bin/sh` is **dash**, not bash). Rules:

- **Work fully autonomously.** Never pause for confirmation; use non-interactive
  flags everywhere; never leave a command waiting on a prompt.
- **POSIX sh only.** `entrypoint.sh` is `#!/bin/sh` (dash). No bashisms: no arrays,
  no `[[ ]]`, no `read -d`, no process substitution, do not rely on `local`. Match
  the existing style (`for entry in …`, `case` matching, `printf`). Available:
  `git`, `tar` (GNU), `jq`, `pnpm`, `ripgrep`, `gh`. **`rsync` is NOT installed.**
- **Opt-in must be a true no-op when off.** With `CONCURRENT_REPOS` empty, the run
  path must be behaviorally identical to today (the existing synchronous block,
  unchanged). Verify this explicitly.
- **Do not remove or weaken the control-plane integration.** `get_repo_list()` and
  the `control_plane_claim_decision()` "skip" check must still gate every plan in
  BOTH the sequential and the new concurrent path.
- **Commit and push after each task.** Use `- [ ]` task bullets; number tasks from
  Task 1 (do not renumber).

## Validation Commands

- `sh -n entrypoint.sh` — POSIX syntax check; MUST pass after every task.
- `shellcheck -s sh entrypoint.sh` — install with `sudo apt-get install -y shellcheck`
  if missing; if it cannot be installed (no sudo), say so and continue — do NOT block.
- `sh scripts/test-concurrent.sh` — the dry-run harness added in Task 6.

> NOTE on CI: executr's only workflow (`.github/workflows/build.yml`) builds the
> Docker image and triggers **only on push to `main`** — it does NOT run on feature
> branches or PRs. There is therefore **no GitHub Actions run to wait on for this
> branch**; do NOT stall polling `gh run` for a run that will never start. Local
> validation (above) is the gate. Just keep `entrypoint.sh` syntactically valid so
> the image still builds when this later merges to `main`.

## Out of scope (do NOT do in this plan)

- Automatic cross-feature merge / integration PR — manual merge for now (record it
  as an idea in `docs/ideas.md`).
- Sharing heavy caches (`node_modules`, `.build/`, model dirs) across worktrees via
  hardlink/symlink — v1 just runs `pnpm install` per worktree (record as an idea).
- Any change to the control-plane service (`control-plane/`), the registry format,
  or the claim/lease files.
- Running concurrency for repos not listed in `CONCURRENT_REPOS`.

---

### Task 1: Concurrency config + helpers (plumbing only, no behavior change)

- [ ] After the `REPO_LIST` / `get_repo_list` setup near the top of `entrypoint.sh`,
      read two new env vars: `CONCURRENT_REPOS="${CONCURRENT_REPOS:-}"` (comma-
      separated repo **names**, matching the `name=` in `REPOS`/registry; also accept
      the literal `all` or `*` to mean every repo), and
      `MAX_PARALLEL_PLANS="${MAX_PARALLEL_PLANS:-3}"`. Normalize `CONCURRENT_REPOS`
      by stripping spaces (`tr -d ' '`).
- [ ] Add `repo_is_concurrent <name>`: returns 0 when `CONCURRENT_REPOS` is `all`/`*`,
      or when the comma-list contains `<name>` (match via
      `case ",$CONCURRENT_REPOS," in *",$1,"*)` so first/last entries work); else 1.
- [ ] Initialize `RUNNING_PIDS=""` (global, before the main loop) and add a
      `plans_running` helper that prunes dead PIDs from `RUNNING_PIDS` (test each with
      `kill -0 "$p" 2>/dev/null`), rewrites `RUNNING_PIDS` to the live set, and prints
      the live count to stdout.
- [ ] `sh -n entrypoint.sh` + shellcheck pass. With `CONCURRENT_REPOS` unset, nothing
      about the run changes yet (helpers defined but unused).

### Task 2: Worktree-isolated plan runner

- [ ] Add `run_plan_concurrent` taking 6 positional args: repo name, repo dir, state
      dir, plan path, plan digest, base branch. It launches **one** backgrounded
      subshell `( … ) &` and returns immediately so the caller keeps scanning. Inside
      the subshell, reference the function's **positional params directly** (`$1`=name
      … `$6`=base) — do NOT assign globals, so the main loop's `parse_entry` globals
      (`NAME`/`DIR`/`BRANCH`) are never clobbered. The subshell must:
  - [ ] Compute a fs-safe slug from the plan basename (strip `.md`, then
        `tr -c 'A-Za-z0-9._-' '-'`) and `WT=/workspace/.worktrees/<name>/<slug>`.
  - [ ] Clean any stale worktree first
        (`git -C <dir> worktree remove --force "$WT" 2>/dev/null; rm -rf "$WT"`), then
        create a fresh **detached** worktree at the latest base:
        `git -C <dir> worktree add --detach "$WT" "<base>"`. Detached so ralphex is
        free to create its own filename-derived branch inside (same naming as
        sequential mode). On `worktree add` failure: record the plan `failed` and exit
        the subshell.
  - [ ] Make the dashboard see this run: `mkdir -p "$WT/.ralphex"` then
        `ln -s "<dir>/.ralphex/progress" "$WT/.ralphex/progress"` (the main clone's
        `.ralphex/progress` already exists and is what `ralphex --serve --watch`
        monitors; `.ralphex/` is git-ignored, so the symlink never dirties the tree).
  - [ ] Seed untracked-but-not-ignored files (`.env`, local config, any uncommitted
        `docs/plans/*.md`) from the main clone into the worktree:
        `git -C <dir> ls-files --others --exclude-standard -z | tar --null -C <dir> -cf - --files-from=- | tar -C "$WT" -xf -`.
        Tolerate an empty list (no error).
  - [ ] If `"$WT/package.json"` exists:
        `( cd "$WT" && pnpm install --prefer-offline || pnpm install )` (pnpm's store
        is shared, so this is cheap).
  - [ ] Run ralphex with CWD in the worktree using the SAME flags as the sequential
        call: `( cd "$WT" && ralphex --no-color --claude-command=/usr/local/bin/fya-wrapper.sh --external-review-tool="${EXTERNAL_REVIEW:-none}" "docs/plans/<basename>" )`.
  - [ ] On success `record_plan_state <state_dir> <plan> <digest> completed`, else
        `… failed`; echo a `[<name>] … (concurrent)` line either way.
  - [ ] Always clean up: `git -C <dir> worktree remove --force "$WT" 2>/dev/null || true`
        (leave the branch + PR on origin).
- [ ] `sh -n` + shellcheck pass.

### Task 3: Wire concurrency into the watch loop (claim-guard preserved)

- [ ] Keep the existing per-plan ordering unchanged and applied to EVERY plan first:
      `plan_seen_unchanged` skip → `has_executable_sections` invalid-skip →
      `control_plane_claim_decision "$NAME" "$digest"` == `skip` guard.
- [ ] After those checks, branch on `repo_is_concurrent "$NAME"`:
  - [ ] **Concurrent path:** claim the plan immediately so the next poll won't
        relaunch it — `record_plan_state "$STATE_DIR" "$plan" "$digest" running` (this
        writes `.sha256`, so `plan_seen_unchanged` returns true next poll). Throttle:
        `while [ "$(plans_running)" -ge "$MAX_PARALLEL_PLANS" ]; do sleep 5; done`.
        Then `run_plan_concurrent "$NAME" "$DIR" "$STATE_DIR" "$plan" "$digest" "$BRANCH"`
        and append the new PID: `RUNNING_PIDS="$RUNNING_PIDS $!"`.
  - [ ] **Sequential path (else):** the existing synchronous `ralphex` block,
        completely unchanged (run → record `completed`/`failed`).
- [ ] Confirm semantics match: a failed concurrent plan stays `failed` and is not
      auto-retried (edit the plan to change its hash to retry) — identical to
      sequential.
- [ ] `sh -n` + shellcheck pass.

### Task 4: Worktree-aware phase_pusher + boot cleanup

- [ ] In `phase_pusher`, after pushing the main clone's current feature branch (the
      existing logic), ALSO push every active worktree branch for the repo: parse
      `git -C "$DIR" worktree list --porcelain`, take each `branch refs/heads/<b>`
      line, and `git -C "$DIR" push origin "<b>"` for branches that aren't the base
      branch. (In concurrent mode the main clone stays on the base branch and feature
      work lives on worktree branches, so without this their WIP never reaches GitHub.)
      Best-effort; never block.
- [ ] In the clone/update loop (where each repo is fetched), add
      `git -C "$DIR" worktree prune` and remove any stale `/workspace/.worktrees/<name>`
      left by a previous container, so a restart starts clean. Guard so this never
      aborts the loop.
- [ ] `sh -n` + shellcheck pass.

### Task 5: Config surface + operator docs

- [ ] `.env.example`: document `CONCURRENT_REPOS` (comma-separated repo names that run
      plans in parallel; empty = all sequential; `all`/`*` = every repo) and
      `MAX_PARALLEL_PLANS` (default 3).
- [ ] `docker-compose.yml`: pass both new vars through `environment:`, defaulted
      (`CONCURRENT_REPOS: ${CONCURRENT_REPOS:-}`, `MAX_PARALLEL_PLANS: ${MAX_PARALLEL_PLANS:-3}`).
- [ ] `CLAUDE.md`: add a short subsection under the loop docs — the two env vars, that
      each plan runs in its own worktree under `/workspace/.worktrees/<repo>/<slug>` on
      its own branch + PR, that the dashboard still shows all runs (progress symlinked
      back), that the main clone stays on the base branch, and that the control-plane
      claim-guard still applies. State that it is **opt-in** and the default is the
      unchanged sequential behavior.
- [ ] `sh -n entrypoint.sh` still clean.

### Task 6: Future-idea note, dry-run test, final review

- [ ] Create `docs/ideas.md` (if absent) and add: (1) **auto-merge finished
      features** — combine several completed feature branches into one integration
      branch/PR (options: a post-completion integration plan that `git merge`s the
      branches and resolves conflicts; or an octopus merge) — manual merge is the
      current stance; (2) **share heavy caches across worktrees** (hardlink/symlink
      `node_modules` / `.build` / model dirs instead of `pnpm install` per worktree).
- [ ] Add `scripts/test-concurrent.sh`: a self-contained dry run that creates a
      throwaway git repo with 2 dummy `docs/plans/*.md`, stubs `ralphex` with a script
      that sleeps a few seconds and touches a marker file, sets `CONCURRENT_REPOS=<name>`
      and `MAX_PARALLEL_PLANS=2`, drives the concurrent runner, and asserts: two
      worktrees are created, both stubs run overlapping in time, plan-state goes
      `running` → `completed`, a second pass does NOT relaunch (claim respected), and
      worktrees are removed at the end. Exit non-zero on any failed assertion. Run it
      until green.
- [ ] Final review: `sh -n entrypoint.sh` + `shellcheck -s sh entrypoint.sh` clean;
      diff-verify that with `CONCURRENT_REPOS` empty the loop behaves identically to
      before this plan (only new, unreached code paths added); confirm `get_repo_list`
      and `control_plane_claim_decision` are still called for every plan; confirm the
      `Dockerfile` still `COPY`s `entrypoint.sh` unchanged. Write a short completion
      note in `docs/agent-progress.md` summarizing what changed and how to enable
      concurrency (set `CONCURRENT_REPOS`, rebuild image, redeploy).
