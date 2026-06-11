# Plan: executr Control Plane — Operator UI + Telegram Planning + Autonomous Orchestrator

## Product Intent

Build a single **executr control-plane service** that sits next to the existing ralphex
dashboard and does three things:

1. **Operator UI + API** — a real multi-repo executor overview (not just passive progress
   logs): see every repo/plan/agent, submit new plans into the right repo as ralphex-format
   markdown, and choose the execution provider (Claude Code vs Codex) per plan.
2. **Autonomous orchestrator** — keep long-running agent loops moving without asking the
   user for every hiccup. Observe → classify → run safe non-destructive recovery → bounded
   retry → notify. Only ask a human when the next action is destructive, expensive,
   ambiguous, or changes product/architecture direction.
3. **Telegram planning bot** — plan *with* Claude over Telegram (text first, voice later),
   then convert a session into a ralphex-format plan and submit it through the executr API.

This is **one** plan on purpose: the UI, the orchestrator, and the Telegram flow share the
same provider abstraction and the same `/workspace` state, so they ship together rather than
being merged later.

## Running this plan (executr executes itself)

This plan lives in **executr's own** `docs/plans/`, so executr must clone itself to pick it
up. Add executr to its own `REPOS` (the clone lands at `/workspace/executr`):

```
REPOS=executr=https://github.com/luiskisters/executr.git#main
```

(combine with other repos comma-separated as usual). `.env.example` already shows this.
Changing `REPOS` needs a Coolify recreate — Swift is baked into the image now, so a recreate
is safe. Alternatively run ralphex on the executr clone manually.

**Bootstrap note for the executing agent:** this plan is itself run by the existing
`entrypoint.sh` loop via the Claude Code / fya path. Do **not** stop, kill, or restructure
that running loop or the `phase_pusher` while executing. The execution-ownership work in
Task 2 must be **purely additive** (a new guard the loop consults), so the loop that is
running this very plan keeps working unchanged for default/Claude-provider plans.

## Naming note

The agent loop / plan format is **ralphex** (one word). Anywhere a source doc said "RALFX"
or "Ralph X", it was a transcription error — write **ralphex** and **ralphex-format**.

## Hard Testing Requirement (applies to EVERY task)

Every feature and every phase added by this plan must be tested **two ways before its task is
marked complete**:

- **Unit tests** — pure logic, validators, classifiers, recovery decisions, command handlers,
  API handlers, **and view-model/render logic** (route rendering, markdown preview generation,
  time-since formatting, health-badge mapping) regardless of SSR or SPA. Use `vitest`.
  External effects (git, `codex exec`, fya, Telegram API, filesystem roots) are mocked or
  pointed at a temp fixture workspace.
- **agent-browser** — drive the actual UI in a headless Chrome (`agent-browser` is already in
  the image) and assert the rendered result / screenshot for the view or surfaced state this
  task touches. Backend-only tasks (contracts, provider runner, orchestrator) must still add
  an agent-browser assertion that the feature's effect is **visible in the UI** (status,
  recovery event, provider used, session state, approval request).

A task whose unit tests OR agent-browser checks are missing or failing is **not** complete.
Do not mark a `- [ ]` until both exist and pass.

## Tech / Placement

- Language/runtime: **Node 22 + TypeScript** (matches the `node:22-bookworm` image; `pnpm` is
  already enabled). HTTP via a small framework (Fastify or Express — implementer's choice,
  keep it lean). UI can be server-rendered + minimal JS, or a small SPA; keep v1 simple.
- Location: a new directory in this **executr** repo, e.g. `control-plane/` (its own
  `package.json`, `tsconfig.json`, `vitest` config). It is a **sibling service** to the
  ralphex dashboard, not a rewrite of `entrypoint.sh`.
- Config — every `/workspace`-relative path is env-overridable so tests can use a fixture dir:
  - `WORKSPACE_ROOT` (default `/workspace`)
  - `ORCHESTRATOR_DB_PATH` (default `${WORKSPACE_ROOT}/.executr/orchestrator.db`)
  - `CLAIMS_DIR` (default `${WORKSPACE_ROOT}/.executr/claims`)
- State: SQLite at `ORCHESTRATOR_DB_PATH` (durable on the `/workspace` volume, inspectable).
- Reads existing file-based state first (`docs/plans/*.md`, `.ralphex/progress`,
  `.ralphex/plan-state`, git, in-container process table, in-container log stream). Do not
  migrate ralphex internals in v1.
- Auth (UI/API): **one shared password** via `CONTROL_PLANE_PASSWORD`. A single login gate
  whose only job is to keep random people off the dashboard — no user accounts, no roles.
  Telegram has its own separate allowlist (`TELEGRAM_ALLOWLIST` of user IDs).

## Shared Contracts & Execution Model (implemented in Task 2; referenced everywhere)

These types/mechanisms are defined once, early, so later tasks consume stable interfaces:

- **`AttemptResult`** (machine-readable; same shape for both providers): `status`
  (`completed | failed | needs_review | aborted`), `provider` (`claude-code | codex`),
  `model`, `branch`, `tasksCompleted` (int), `commits` (sha list), `validation`
  (`passed | failed | skipped` + log ref), `classification` (a `ClassificationSignal`),
  `summary` (string), `startedAt`/`endedAt`.
- **`ClassificationSignal`** enum (the only allowed status vocabulary): `healthy`,
  `long_running_but_active`, `known_startup_stall`, `rate_limited`, `waiting_for_human`,
  `failed_finalize`, `dirty_tree_blocked`, `auth_missing`, `tool_missing`, `dead_loop`.
- **`ProviderStatus`**: `available` (bool), `reason` (e.g. `auth_missing`, `rate_limited`,
  `cooldown_until`).
- **Approval-request store** (DB table): `id`, `repo`, `plan`, `action`, `context`,
  `status` (`pending | approved | denied`), `channel`, `decidedBy`, `createdAt`/`decidedAt`.
  This is provider/channel-agnostic; Telegram (Task 10) is just one approval channel.
- **Plan claim / lease + lock**: a claim file under `CLAIMS_DIR` per `(repo, plan-hash)` with
  the requested provider and a lease TTL. `entrypoint.sh` gets a small **additive guard**
  (Task 2) that **skips** any plan whose active claim names a **non-`claude-code`** provider
  (the control-plane runs those); unclaimed and `claude-code`/default plans keep flowing
  through the existing loop untouched. A per-`(repo, plan)` lock serializes execution so the
  base-branch checkout + `phase_pusher` (60s) can't race a control-plane-driven run.

## Validation Commands

```
cd control-plane && pnpm install
pnpm run lint
pnpm run typecheck
pnpm run test            # vitest unit tests (must pass)
pnpm run test:e2e        # agent-browser UI checks against a locally started server (must pass)
pnpm run build
```

`local-validate` for ralphex = the above must all succeed. `test:e2e` boots the control-plane
server against a temp fixture `/workspace` and drives it with agent-browser.

---

### Task 1: Scaffold the control-plane service + single-password auth gate

- [x] Create `control-plane/` with `package.json`, `tsconfig.json`, lint config, and a
      `vitest` setup; add the scripts from Validation Commands (`lint`, `typecheck`, `test`,
      `test:e2e`, `build`).
- [x] HTTP server with a `GET /healthz` endpoint and a login page (`GET /login`,
      `POST /login`) that checks `CONTROL_PLANE_PASSWORD` and sets a signed session cookie.
- [x] Auth middleware that protects all `/api/*` and UI routes except `/healthz` and `/login`;
      unauthenticated requests redirect to `/login` (UI) or return `401` (API).
- [x] Wire the env config (`WORKSPACE_ROOT`, `ORCHESTRATOR_DB_PATH`, `CLAIMS_DIR`) with the
      documented defaults; tests point them at a temp fixture dir.
- [x] **Unit tests:** auth middleware allows valid cookie / rejects missing+wrong password;
      `/healthz` is public; wrong password on `POST /login` fails; config defaults resolve.
- [x] **agent-browser:** load `/` unauthenticated → redirected to login; submit the correct
      password → reach an (empty) overview page; screenshot asserts the gate works.

### Task 2: Shared contracts, state DB & execution ownership

- [x] Implement the SQLite store at `ORCHESTRATOR_DB_PATH` with migrations for: executions
      (repo, plan file, plan hash, attempt ID, provider requested, provider used, model,
      branch/worktree, status, latest progress ts, latest transcript ts, rate-limit/cooldown,
      last recovery action) and the **approval-request** table from Shared Contracts.
- [x] Define and export the `AttemptResult`, `ClassificationSignal`, and `ProviderStatus`
      types (single source of truth consumed by Tasks 6–10).
- [x] Implement the **plan claim / lease** API (claim, renew, release, read) backed by
      `CLAIMS_DIR`, plus the per-`(repo, plan)` lock.
- [x] Add the **additive guard to `entrypoint.sh`**: before running a plan, skip it if an
      active claim names a non-`claude-code` provider. Must be a no-op for unclaimed/default
      plans (the loop running THIS plan must keep working). Keep the change minimal and
      reversible.
- [x] **Unit tests:** migrations create the schema; claim lease expiry + lock mutual exclusion
      behave correctly; the entrypoint-guard decision function returns skip only for active
      non-claude claims and run/observe for everything else (cover unclaimed, expired-claim,
      claude-claim, codex-claim).
- [x] **agent-browser:** an internal `/api/_debug/contracts` (or the overview) renders a
      seeded execution + a pending approval row from the DB, proving the store is live.

### Task 3: Filesystem-backed repo/plan discovery + normalized execution state (read-only API)

- [ ] `GET /api/repos` — list repos under `WORKSPACE_ROOT` with current branch, latest commit,
      and active plan if any.
- [ ] `GET /api/repos/:repo/plans` — list plans from `docs/plans/*.md` with plan-state status
      (`completed|failed|invalid|none`), content hash, created time, last run time, and
      branch/PR link if known.
- [ ] `GET /api/repos/:repo/plans/:plan` — rendered plan markdown + progress-log tail
      (`.ralphex/progress`) + recent commit summary + validation/review/finalize state.
- [ ] `GET /api/executions` — one normalized record per active execution, joined with the
      Task 2 DB, including the `ClassificationSignal` (the live classifier lands in Task 8;
      until then this field is `healthy`/unknown placeholder, clearly marked).
- [ ] Plan parsing returns explicit fields: `rawTaskNumber`, `normalizedDisplayNumber`, and a
      `validationWarnings[]` list — so `Task 0` / `* [ ]` plans are normalized **and** the
      mismatch is surfaced, never silently mislabeled.
- [ ] **Unit tests:** all four endpoints against a temp fixture workspace with sample
      repos/plans/`.ralphex` state; assert parsed fields incl. the `Task 0` / `* [ ]` edge
      cases produce the right `normalizedDisplayNumber` + warnings.
- [ ] **agent-browser:** overview view renders the fixture repos/plans/state from the live API.

### Task 4: Plan creation API — validated, atomic ralphex-format writes

- [ ] `POST /api/repos/:repo/plans` — accept `{ title, body, validationCommands, provider }`,
      generate **ralphex-format** markdown, and write it atomically (temp file + rename) into
      `<repo>/docs/plans/`.
- [ ] Format validator enforces the known-good shape: `# Plan: …`, a `## Validation Commands`
      section, `### Task 1:` headings numbered **from 1** (reject `Task 0`), and `- [ ]`
      checkboxes (reject `* [ ]`). Reject + return a clear error on malformed input.
- [ ] If `provider != claude-code`, also write a claim (Task 2) for the new plan so the
      control-plane — not the legacy loop — will execute it.
- [ ] Reject path traversal in `:repo`/title; never write outside `<repo>/docs/plans/`.
- [ ] **Unit tests:** valid input writes a well-formed file atomically; each malformed case
      (Task 0, `* [ ]`, missing Validation Commands, traversal) is rejected; a non-claude
      provider writes a claim; concurrent writes don't corrupt.
- [ ] **agent-browser:** "New plan" form → fill repo/title/body/validation/provider → submit →
      success state, and the new plan appears in the plans list view.

### Task 5: Dashboard UI views

- [ ] **Overview:** all repos, active plan, branch, latest commit, state, time-since-last
      transcript/progress, health classification.
- [ ] **Plans:** per-repo plan list with plan-state, content hash, created/last-run, PR/branch.
- [ ] **Plan detail:** rendered markdown, progress-log tail, recent transcript/commit summary,
      validation + review/finalize state, selected/used provider.
- [ ] **New plan:** repo picker, title, body, validation commands, provider selector, a
      live preview of the generated ralphex markdown, submit.
- [ ] **Activity / Timeline:** a chronological feed of execution events, recovery actions, and
      approval requests/decisions (the view Task 9 + Task 10 assert against).
- [ ] **Sessions:** Telegram planning sessions and whether each has been converted to a plan
      (data lands in Task 10; view renders empty gracefully until then).
- [ ] **Unit tests:** concrete tests for route/view-model rendering, markdown-preview
      generation, time-since formatting, and health-badge mapping.
- [ ] **agent-browser:** each of the six views loads against the fixture API and renders the
      expected content; screenshots asserted.

### Task 6: Provider abstraction (Claude Code ↔ Codex) as a first-class concept

- [ ] Define `AgentRunner`: `runPlan(repo, planPath, attemptConfig) -> AttemptResult`,
      `inspect(repo, question, mode) -> InspectionResult`,
      `draftPlan(session, repo) -> DraftPlanResult` (used by Telegram `/plan`),
      `availability() -> ProviderStatus`. Returns/consumes the Task 2 contract types.
- [ ] `ClaudeCodeRunner` wraps the current ralphex + `fya-wrapper.sh`/Claude Code path; its
      `runPlan` is the existing behavior, surfaced through the interface.
- [ ] `CodexRunner.inspect` uses `codex exec` (non-interactive, read-only or workspace-write
      mode) for rescue/inspection. (Full `CodexRunner.runPlan` is Task 7.)
- [ ] Provider selection plumbed through the API/UI: `auto | claude-code | codex`, stored per
      plan/attempt; **provider used recorded for every attempt** in the Task 2 DB.
- [ ] Provider selection policy: `auto` config with `prefer` + `fallback_order` and
      `switch_on` triggers (`provider_rate_limited`, `provider_auth_unavailable`,
      `startup_stall_repeated`, `transient_timeout_repeated`). Surfaced/editable in the UI.
- [ ] **Unit tests:** runner dispatch picks the right implementation; `codex exec` / fya argv
      built correctly (mock `child_process`); `availability()` reflects missing auth; `auto`
      policy picks prefer/fallback per trigger; `draftPlan` returns valid ralphex markdown.
- [ ] **agent-browser:** provider selector in the New-plan form persists the choice and the
      plan detail view shows the selected/used provider.

### Task 7: Codex as a full plan executor (`CodexRunner.runPlan`)

Codex is a first-class executor, not just a rescue inspector. `runPlan` consumes a
ralphex-format plan and drives Codex to completion, producing the **same observable artifacts**
the Claude Code path does, so a plan can be executed end-to-end by either provider and the
existing dashboard + orchestrator observe it identically.

- [ ] Implement `CodexRunner.runPlan(repo, planPath, attemptConfig)` via `codex exec`
      (`--sandbox workspace-write`, `--approval never`, configurable model e.g.
      `gpt-5.1-codex`, `cwd = repo`). May optionally use the Codex SDK/app-server for
      resumable threads, but the `codex exec` path must work as the baseline.
- [ ] **Artifact contract** — Codex must produce the same files the loop/dashboard rely on:
  - commits per task with `feat: … Task N` messages on a feature branch named like the
    Claude path's convention;
  - progress written to `<repo>/.ralphex/progress/progress-<plan>.txt`;
  - plan-state recorded at `<repo>/.ralphex/plan-state/<plan>_.{sha256,status}` exactly as
    the loop expects (`completed|failed|invalid`);
  - finalize: push the branch + open the PR (same as the Claude path), so no manual step.
- [ ] **Result contract** — Codex must emit a strict machine-readable `AttemptResult` JSON to a
      known file (`<repo>/.ralphex/attempt-<plan>.json`). Define the schema, a single
      delimiter/file convention, retry-once on malformed output, and **exit-code-wins**
      precedence when exit status and summary disagree.
- [ ] Map Codex exits/output onto the Task 2 `ClassificationSignal` values (rate-limit / auth /
      stall / finalize) so the orchestrator handles Codex identically.
- [ ] Acquire the Task 2 per-`(repo, plan)` lock for the whole run and coordinate with the
      base-branch checkout + `phase_pusher`: the claim (Task 2 guard) keeps the legacy loop
      off this plan; ensure the active feature branch isn't clobbered by the poll checkout.
- [ ] **Unit tests:** adapter prompt built correctly from a fixture plan; `codex exec` argv
      (sandbox/approval/model/cwd) correct; the `AttemptResult` JSON file is parsed/validated;
      malformed output triggers the retry; failure/rate-limit/auth-missing exits map to the
      right `ClassificationSignal`; the lock is held for the run (mock `child_process`).
- [ ] **agent-browser:** create a plan with provider `codex`; the plan detail / executions
      view shows it executing under Codex with provider-used = codex and per-task progress.

### Task 8: Orchestrator observer + stuck-classification (no actions yet)

- [ ] Observer polls every 30–60s and writes normalized statuses into the Task 2 DB **without
      taking any action**.
- [ ] Inputs: in-container process table; the **in-container log stream** the control-plane
      can read directly (do NOT depend on host-side `docker logs`, which needs the Docker
      socket — read ralphex's own served log/SSE or the progress files instead); `.ralphex`
      progress + plan-state; Claude transcripts; Codex `attempt-<plan>.json`; git state;
      provider availability.
- [ ] Classifier produces the Task 2 `ClassificationSignal` values. `known_startup_stall`
      (no transcript after fya launch) must — per `CLAUDE.md` — be treated as self-healing
      after the 30m timeout and must **never** recommend an external kill.
- [ ] **Unit tests:** feed fixture process tables / logs / progress / git states and assert
      each classification — especially that a no-transcript startup stall is
      `known_startup_stall` and is never flagged for a kill.
- [ ] **agent-browser:** the Overview/Executions view shows the live classification per
      execution from the DB.

### Task 9: Safe automatic recoveries + approval gating

- [ ] `failed_finalize`: if a branch exists with commits but push/PR failed, push the branch
      and open the PR.
- [ ] `dirty_tree_blocked`: inspect dirty files — if only known runtime state (`.ralphex/`,
      caches, build output) dirties the tree, fix exclude rules and retry; if user/source
      files are dirty, **do not act — raise an approval request** (Task 2 store).
- [ ] `rate_limited`: set provider cooldown and switch to the next configured provider.
- [ ] `auth_missing`: switch to another authenticated provider if one exists; notify.
- [ ] `known_startup_stall`: wait through the self-healing window first; only after repeated
      stalls consider a bounded provider switch/restart.
- [ ] Every automatic retry is bounded by counters + cooldowns. Destructive/expensive actions
      (force-push, branch/worktree deletion, discarding uncommitted work, scope-changing plan
      rewrites, merge/close PR, large extra spend) are **never** automatic — they create a
      **pending approval request** in the Task 2 store and wait. Approval is channel-agnostic;
      Telegram becomes a channel in Task 10, but the gate works (UI-visible) without it.
- [ ] **Unit tests:** each recovery decision fires only in its precondition and is suppressed
      past its retry bound; dirty-tree distinguishes runtime-state-only from user-file-dirty;
      every destructive action produces a pending approval request instead of acting; no
      destructive action is ever selected automatically.
- [ ] **agent-browser:** a recovery event (e.g. "auto-pushed branch after failed finalize")
      and a pending approval request both appear in the Activity/Timeline view.

### Task 10: Telegram planning bot — text sessions, allowlist, approval channel

- [ ] Bot process (or sibling within the control-plane) using `TELEGRAM_BOT_TOKEN`; accept
      messages **only** from `TELEGRAM_ALLOWLIST` user IDs.
- [ ] Session commands: `/session new <name>`, `/session list`, `/session switch <id|name>`,
      `/session delete <id|name>`, `/repo <repo>` (target selector only), `/plan` (calls the
      provider `draftPlan` from Task 6 to synthesize the session into ralphex markdown),
      `/submit` (POST the draft to the plan-creation API from Task 4).
- [ ] Session state persisted (DB): telegram user/chat ID, session id/name, target repo,
      conversation transcript, draft plan, submission status, created/updated timestamps.
- [ ] Telegram as an approval/notification **channel** over the Task 2/Task 9 mechanisms:
      status notifications, provider-switch notices, "I fixed X automatically" notices
      (non-blocking), and **approval requests only** for the high-risk actions from Task 9
      (terse: what happened / what was already tried / proposed risky action /
      approve·deny·explain). Telegram must never be a normal blocking step in execution.
- [ ] **Unit tests:** allowlist rejects non-listed IDs; each command handler mutates session
      state correctly; `/plan` produces valid ralphex markdown via `draftPlan`; `/submit`
      calls the API; an approval decision over Telegram updates the Task 2 store (mock the
      Telegram API).
- [ ] **agent-browser:** the Sessions UI view reflects bot-created sessions and their
      submission status, and an approval decided via Telegram shows as resolved in the
      Activity/Timeline view.

### Task 11: Wire the control-plane into the container

- [ ] Start the control-plane service from `entrypoint.sh` alongside the ralphex dashboard
      (own port via `CONTROL_PLANE_PORT`, default `8090`; dashboard stays on 8080). Keep the
      Task 2 entrypoint guard intact.
- [ ] Add env to `docker-compose.yml` + `.env.example`: `CONTROL_PLANE_PASSWORD`,
      `CONTROL_PLANE_PORT`, `TELEGRAM_ALLOWLIST` (reuse existing `TELEGRAM_BOT_TOKEN`,
      `GROQ_API_KEY`). Document the new port mapping.
- [ ] Ensure the service starts as `node`, reads/writes `/workspace` correctly, and survives a
      `docker restart` (state in `ORCHESTRATOR_DB_PATH`).
- [ ] **Unit tests:** the env/config wiring resolves correctly for the container layout
      (ports, paths, allowlist parsing).
- [ ] **Integration tests:** boot the service with env wired as in the container and hit
      `/healthz` + one authed API route end-to-end against a fixture workspace.
- [ ] **agent-browser:** full end-to-end smoke — log in, view overview, create a plan via the
      form, confirm it lands in `docs/plans/` and appears in the list.

## Design Constraints (carry through all tasks)

- One shared UI password is the only web gate; Telegram has its own user-ID allowlist. Keep
  them separate — Telegram is never an unrestricted shell.
- Submitting a plan is always explicit (a `/submit` or a form submit), never automatic from
  chatter.
- Recovery is non-destructive by default. Destructive/expensive/ambiguous/architecture-
  changing actions are approval-gated (Task 2 store + Task 10 channel), not automatic.
- Generated plans always use the known-good ralphex format (`# Plan:`,
  `## Validation Commands`, `### Task 1:`, `- [ ]`, tasks numbered from 1).
- Plan files are written atomically.
- The entrypoint change is additive and reversible; the loop running this plan must keep
  working for default/Claude-provider plans throughout.
- Stay compatible with the existing file-based mechanism; defer any deeper ralphex-internals
  rewrite.

## Out of scope (separate future plan)

Telegram **voice → transcription** (accept voice messages, transcribe via Groq, append to the
session transcript) is intentionally **not** in this plan — it lives in
`docs/plans/executr-telegram-voice.md` so it doesn't become a required task here.
