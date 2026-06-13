# Plan: Port executr control plane and run it with GPT-5.5 xhigh

## Overview

Port the existing executr control-plane implementation from `origin/t3code/a00a0868`
onto current `main`, reconcile it with the current runtime, and prove the service
builds and starts. The old branch contains the intended UI/orchestrator/Telegram
work; do not reimplement from scratch if a file can be restored and adjusted.

Current user intent:

- Use the Codex/GPT executor path for this work: `gpt-5.5` with reasoning effort
  `xhigh`.
- Preserve the newest user-visible behavior from current `main` unless this plan
  explicitly changes it.
- Make executr run the custom control-plane UI alongside the ralphex dashboard.
- Fix/retain stall observation and safe recovery behavior.
- Include Telegram text planning and approval-channel integration.
- Leave Telegram voice transcription as a separate follow-up plan unless it is
  already implemented.

## Validation Commands

- `sh -n entrypoint.sh`
- `cd control-plane && pnpm install`
- `cd control-plane && pnpm run lint`
- `cd control-plane && pnpm run typecheck`
- `cd control-plane && pnpm run test`
- `cd control-plane && pnpm run test:e2e`
- `cd control-plane && pnpm run build`
- `tmp="$(mktemp -d)" && CONTROL_PLANE_PASSWORD=test CONTROL_PLANE_PORT=8099 WORKSPACE_ROOT="$tmp" ORCHESTRATOR_DB_PATH="$tmp/.executr/orchestrator.db" CLAIMS_DIR="$tmp/.executr/claims" node control-plane/dist/index.js`

### Task 1: Restore and reconcile the control-plane implementation

- [x] Restore `control-plane/` from `origin/t3code/a00a0868`.
- [x] Restore the control-plane docs/plans from `origin/t3code/a00a0868`, but keep
      completed work under `docs/plans/completed/` and keep follow-up plans top-level.
- [x] Reconcile `Dockerfile`, `docker-compose.yml`, `.env.example`, `README.md`,
      `CLAUDE.md`, and `entrypoint.sh` with current `main`.
- [x] Re-add the Codex CLI only where required for the requested GPT execution path.
- [x] Ensure the default control-plane provider/model is `codex` with model
      `gpt-5.5` and reasoning effort `xhigh`, while the legacy watch loop remains
      explicit and predictable.
- [x] Preserve the current requirement that ralphex execution can run without
      external review unless a plan explicitly chooses another provider.
- [x] Run the validation commands and fix every failure.

### Task 2: Prove the control-plane runs

- [x] Build `control-plane`.
- [x] Start `node control-plane/dist/index.js` with test env on a non-default port.
- [x] Verify `/healthz` returns success.
- [x] Log in with `CONTROL_PLANE_PASSWORD=test` and verify the overview page renders.
- [x] Stop the test server cleanly.
- [x] Run `git status --short` and make sure only intended files changed.
- [x] Commit the finished port and updated plan.
