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
  mkdir -p "$DIR/docs/plans" "$DIR/.ralphex/progress"
  WATCH_ARGS="$WATCH_ARGS --watch $DIR/.ralphex/progress"
done

# dashboard: monitor every repo's progress files (Coolify maps a domain to :8080)
# NOTE: verify --serve --watch runs idle without prompting on your ralphex version.
ralphex --serve --port "${RALPHEX_PORT:-8080}" $WATCH_ARGS &

echo "executr: watching plans across: $REPOS"
while true; do
  for entry in $REPO_LIST; do
    parse_entry "$entry"
    [ -d "$DIR" ] || continue
    for plan in "$DIR"/docs/plans/*.md; do
      [ -e "$plan" ] || continue
      echo "executr: [$NAME] running $(basename "$plan")"
      ( cd "$DIR" && ralphex --no-color \
          --claude-command=/usr/local/bin/fya-wrapper.sh \
          --external-review-tool="${EXTERNAL_REVIEW:-none}" \
          "docs/plans/$(basename "$plan")" ) || echo "executr: [$NAME] plan failed: $(basename "$plan")"
    done
  done
  sleep "${POLL_SECONDS:-30}"
done
