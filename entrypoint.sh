#!/bin/sh
# executr entrypoint: clone/update one or more target repos, install deps, serve
# the dashboard, and watch each repo's docs/plans for plans to execute.
#
# Repos are configured via the REPOS env var (comma-separated). Each entry is
#   name=URL[#branch]   or   URL[#branch]   (name derived from the URL)
# e.g. REPOS="app=https://github.com/your-org/your-repo.git#main,\
#             api=https://github.com/your-org/api.git"
# Back-compat: if REPOS is empty, falls back to REPO_URL[#REPO_BRANCH].
set -eu

# Started as root (to fix the mounted volume's ownership), then drop to `node`
# because Claude refuses --dangerously-skip-permissions as root.
if [ "$(id -u)" = "0" ]; then
  mkdir -p /workspace
  chown -R node:node /workspace 2>/dev/null || true
  exec runuser -u node -- "$0" "$@"
fi

: "${GITHUB_TOKEN:?set GITHUB_TOKEN (repo + workflow scope)}"

REPOS="${REPOS:-}"
if [ -z "$REPOS" ]; then
  REPOS="${REPO_URL:-https://github.com/your-org/your-repo.git}#${REPO_BRANCH:-main}"
fi
REPO_LIST="$(echo "$REPOS" | tr ',' ' ')"

git config --global user.name  "${GIT_AUTHOR_NAME:-executr bot}"
git config --global user.email "${GIT_AUTHOR_EMAIL:-you@example.com}"
git config --global credential.helper store
printf 'https://x-access-token:%s@github.com\n' "$GITHUB_TOKEN" > "$HOME/.git-credentials"

# Keep build output (Swift .build/, .swiftpm/, etc.) AND ralphex's own runtime
# state (.ralphex/ = executr plan-state + ralphex progress logs) from dirtying
# repo trees: ralphex refuses to create a feature branch when the working tree is
# dirty. Once a repo has run its first plan, the leftover untracked .ralphex/
# files would otherwise make the tree dirty and block branch creation for EVERY
# subsequent plan ("worktree has uncommitted changes"). Belt-and-suspenders: also
# add it to each repo's .git/info/exclude below (survives a restart that re-runs
# this entrypoint, since core.excludesfile is rewritten here on every start).
mkdir -p "$HOME/.config/git"
printf '%s\n' '.build/' '.swiftpm/' '*.swiftmodule' '.ralphex/' > "$HOME/.config/git/ignore"
git config --global core.excludesfile "$HOME/.config/git/ignore"

# Claude-only for now: execution already goes through Claude Code via fya, and
# external cross-model review is disabled even if older deploy env still sets it.
EXTERNAL_REVIEW=none
export EXTERNAL_REVIEW

# --- Claude Code config: keep fya's interactive session from blocking on a dialog ---
# Claude >=2.1 shows a modal "Bypass Permissions mode" acceptance dialog on EVERY
# interactive launch with --dangerously-skip-permissions. fya drives the interactive
# claude TUI and can't dismiss it, so the prompt never lands, no transcript is written,
# and the turn dies on FYA_TRANSIENT_TIMEOUT (30m) -> ralphex retries the same iteration
# forever with zero progress while burning Max usage. `skipDangerousModePermissionPrompt`
# is claude's settings escape hatch for that dialog (also baked into the image); re-assert
# it here so it holds even if the config dir lands on a fresh/overridden volume.
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
mkdir -p "$CLAUDE_DIR"
printf '%s' '{"theme":"dark","skipDangerousModePermissionPrompt":true}' > "$CLAUDE_DIR/settings.json"
[ -f "$HOME/.claude.json" ] || echo '{}' > "$HOME/.claude.json"

# Global agent instruction read on EVERY turn (incl. ralphex review rounds) for
# ALL repos: a plan isn't done until the project's CI is green. `gh` is installed
# and authenticated, so the agent can actually check. Seeded as user-level memory
# (~/.claude/CLAUDE.md) so it applies everywhere without touching each repo/plan.
cat > "$CLAUDE_DIR/CLAUDE.md" <<'EOF'
# Required for every plan: CI must pass

A plan is not complete until the project's continuous-integration checks are
green — GitHub Actions and/or Vercel, whatever that repo uses. Before finalizing,
verify it: `gh` is installed and authenticated (`gh run list`,
`gh run view --log-failed <run-id>`); check the Vercel deployment status when the
repo deploys to Vercel. If any check is red, read the failing logs and fix the
cause. Never mark work complete or open/merge a PR with failing CI.
EOF

# pre-accept onboarding + per-repo "trust this folder" so the TUI never stops on those.
trust_repo() {  # $1 = repo working dir
  tmp="$(mktemp)" || return 0
  if jq --arg d "$1" \
       '.hasCompletedOnboarding=true | .bypassPermissionsModeAccepted=true | .projects[$d].hasTrustDialogAccepted=true' \
       "$HOME/.claude.json" > "$tmp" 2>/dev/null; then
    mv "$tmp" "$HOME/.claude.json"
  else
    rm -f "$tmp"
  fi
}

# parse one entry -> sets NAME, URL, BRANCH, DIR
parse_entry() {
  e="$1"
  case "$e" in
    *=*) NAME="${e%%=*}"; rest="${e#*=}" ;;
    *)   rest="$e"; NAME="" ;;
  esac
  case "$rest" in
    *\#*) URL="${rest%#*}"; BRANCH="${rest##*#}" ;;
    *)    URL="$rest"; BRANCH="main" ;;
  esac
  [ -n "$NAME" ] || NAME="$(basename "$URL" .git)"
  DIR="/workspace/$NAME"
}

# --- plan-state: run each plan once per content, never re-run on every poll ---
plan_digest() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# ralphex errors out ("no executable task sections") on plans lacking these,
# so treat them as notes and skip rather than failing them every cycle.
has_executable_sections() {
  grep -Eq '^### (Task|Iteration) [0-9]+:' "$1"
}

# map a plan path to its state-file stem under the repo's plan-state dir
plan_state_file() {
  printf '%s/%s' "$1" "$(basename "$2" | tr -c 'A-Za-z0-9._-' '_')"
}

record_plan_state() {  # state_dir plan digest status
  sf="$(plan_state_file "$1" "$2")"
  printf '%s\n' "$3" > "$sf.sha256"
  printf '%s\n' "$4" > "$sf.status"
}

plan_seen_unchanged() {  # state_dir plan digest
  sf="$(plan_state_file "$1" "$2")"
  [ -f "$sf.sha256" ] && [ "$(cat "$sf.sha256")" = "$3" ]
}

# clone/update + install each repo; collect dashboard watch dirs
WATCH_ARGS=""
for entry in $REPO_LIST; do
  parse_entry "$entry"
  if [ ! -d "$DIR/.git" ]; then
    echo "executr: cloning $URL ($BRANCH) -> $DIR"
    git clone --branch "$BRANCH" "$URL" "$DIR" || { echo "executr: clone failed: $URL"; continue; }
  fi
  ( cd "$DIR" && git fetch origin && git checkout "$BRANCH" && git pull --ff-only ) || true
  if [ -f "$DIR/package.json" ]; then
    echo "executr: pnpm install in $NAME ..."
    ( cd "$DIR" && pnpm install --prefer-offline || pnpm install ) || true
  fi
  mkdir -p "$DIR/docs/plans" "$DIR/.ralphex/progress" "$DIR/.ralphex/plan-state"
  # ralphex's runtime state must never count as a "dirty" tree, or branch
  # creation fails for the 2nd+ plan. Persist the rule in the repo's own
  # exclude (lives in the /workspace volume; survives restarts/redeploys).
  if [ -f "$DIR/.git/info/exclude" ] && ! grep -qxF '.ralphex/' "$DIR/.git/info/exclude"; then
    printf '%s\n' '.ralphex/' >> "$DIR/.git/info/exclude"
  fi
  trust_repo "$DIR"
  WATCH_ARGS="$WATCH_ARGS --watch $DIR/.ralphex/progress"
done

# dashboard: monitor every repo's progress files (Coolify maps a domain to :8080)
# Bind 0.0.0.0 (ralphex defaults to 127.0.0.1) so Coolify's reverse proxy and the
# published port can reach it from outside the container — otherwise it's a 502.
# NOTE: verify --serve --watch runs idle without prompting on your ralphex version.
ralphex --serve --host "${RALPHEX_WEB_HOST:-0.0.0.0}" --port "${RALPHEX_PORT:-8080}" $WATCH_ARGS &

# Background: push each repo's active feature branch after every committed phase,
# so work-in-progress is visible on GitHub and any branch-preview env redeploys per
# phase. finalize still opens the PR at plan completion. Best-effort; never blocks.
# Runs in a forked subshell, so it can't clobber the main loop's parse_entry globals.
phase_pusher() {
  while true; do
    for entry in $REPO_LIST; do
      parse_entry "$entry"
      [ -d "$DIR/.git" ] || continue
      ( cd "$DIR"
        cur="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
        [ -n "$cur" ] && [ "$cur" != "$BRANCH" ] && [ "$cur" != "HEAD" ] \
          && git push origin "$cur" 2>/dev/null ) || true
    done
    sleep "${PHASE_PUSH_SECONDS:-60}"
  done
}
phase_pusher &

echo "executr: ralphex execution uses Claude Code via fya; external review disabled"
echo "executr: watching plans across: $REPOS"
while true; do
  for entry in $REPO_LIST; do
    parse_entry "$entry"
    [ -d "$DIR" ] || continue
    # refresh from origin each poll so plans/code pushed to the repo are picked up
    # without a restart, and so each run starts from the latest base branch (best-effort)
    ( cd "$DIR" && git fetch origin --quiet && git checkout "$BRANCH" --quiet 2>/dev/null && git pull --ff-only --quiet ) || true
    STATE_DIR="$DIR/.ralphex/plan-state"
    for plan in "$DIR"/docs/plans/*.md; do
      [ -e "$plan" ] || continue

      digest="$(plan_digest "$plan")"
      # already handled this exact content (completed/failed/invalid) -> don't re-run.
      # To retry, edit the plan so its hash changes.
      if plan_seen_unchanged "$STATE_DIR" "$plan" "$digest"; then
        continue
      fi

      if ! has_executable_sections "$plan"; then
        echo "executr: [$NAME] skipping non-executable plan $(basename "$plan") (no '### Task N:' / '### Iteration N:')"
        record_plan_state "$STATE_DIR" "$plan" "$digest" invalid
        continue
      fi

      echo "executr: [$NAME] running $(basename "$plan")"
      if ( cd "$DIR" && ralphex --no-color \
          --claude-command=/usr/local/bin/fya-wrapper.sh \
          --external-review-tool="${EXTERNAL_REVIEW:-none}" \
          "docs/plans/$(basename "$plan")" ); then
        echo "executr: [$NAME] plan completed: $(basename "$plan")"
        record_plan_state "$STATE_DIR" "$plan" "$digest" completed
      else
        echo "executr: [$NAME] plan failed: $(basename "$plan")"
        record_plan_state "$STATE_DIR" "$plan" "$digest" failed
      fi
    done
  done
  sleep "${POLL_SECONDS:-30}"
done
