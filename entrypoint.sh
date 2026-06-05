#!/bin/sh
# executr entrypoint: clone/update the target repo, install deps, serve the
# dashboard, and watch docs/plans for plans to execute autonomously.
set -eu

# Started as root (to fix the mounted volume's ownership), then drop to `node`
# because Claude refuses --dangerously-skip-permissions as root.
if [ "$(id -u)" = "0" ]; then
  mkdir -p /workspace
  chown -R node:node /workspace 2>/dev/null || true
  exec runuser -u node -- "$0" "$@"
fi

: "${GITHUB_TOKEN:?set GITHUB_TOKEN (repo + workflow scope)}"
REPO_URL="${REPO_URL:-https://github.com/luisKisters/summario.git}"
REPO_BRANCH="${REPO_BRANCH:-main}"
PLANS_DIR="/workspace/docs/plans"

git config --global user.name  "${GIT_AUTHOR_NAME:-executr bot}"
git config --global user.email "${GIT_AUTHOR_EMAIL:-luis.w.kisters@gmail.com}"
git config --global credential.helper store
printf 'https://x-access-token:%s@github.com\n' "$GITHUB_TOKEN" > "$HOME/.git-credentials"

# clone the target repo into the persistent volume on first boot, else update
if [ ! -d /workspace/.git ]; then
  echo "executr: cloning $REPO_URL ..."
  git clone --branch "$REPO_BRANCH" "$REPO_URL" /workspace
fi
cd /workspace
git fetch origin && git checkout "$REPO_BRANCH" && git pull --ff-only || true

# install deps so the dev server / browser checks work (first boot is slow)
echo "executr: pnpm install ..."
pnpm install --prefer-offline || pnpm install || true

mkdir -p "$PLANS_DIR" /workspace/.ralphex/progress

# dashboard: monitor every session's progress files (Coolify maps a domain to :8080)
# NOTE: verify --serve --watch runs idle without prompting on your ralphex version.
ralphex --serve --port "${RALPHEX_PORT:-8080}" --watch /workspace/.ralphex/progress &

echo "executr: watching $PLANS_DIR for plans ..."
while true; do
  for plan in "$PLANS_DIR"/*.md; do
    [ -e "$plan" ] || continue
    echo "executr: running plan $plan"
    ralphex --no-color \
      --claude-command=/usr/local/bin/fya-wrapper.sh \
      --external-review-tool="${EXTERNAL_REVIEW:-none}" \
      "$plan" || echo "executr: plan failed: $plan"
  done
  sleep "${POLL_SECONDS:-30}"
done
