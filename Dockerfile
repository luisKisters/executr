# executr — containerized ralphex + fya + agent-browser + codex/claude stack.
# Debian base so agent-browser's Chrome-for-Testing (glibc) runs reliably.
FROM node:22-bookworm

# --- OCI image metadata (shown on the GHCR package page) ---
LABEL org.opencontainers.image.title="executr" \
      org.opencontainers.image.description="Containerized autonomous plan execution (ralphex + fya + agent-browser), deployable on Coolify." \
      org.opencontainers.image.source="https://github.com/luiskisters/executr" \
      org.opencontainers.image.url="https://github.com/luiskisters/executr"

# --- system deps: git, search, headless-Chrome shared libs, gh CLI ---
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl gnupg ripgrep jq tini \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
      libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
      libpango-1.0-0 libcairo2 fonts-liberation \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# --- CLIs: pnpm, Claude Code, Codex, agent-browser (verified package names) ---
RUN corepack enable && corepack prepare pnpm@latest --activate
RUN npm install -g @anthropic-ai/claude-code @openai/codex agent-browser

# --- fya (Max-plan driver) + ralphex, latest release resolved at build time ---
# Release assets are versioned (fya_<ver>_linux_<arch>.tar.gz), so resolve the tag first.
RUN set -eux; ARCH="$(dpkg --print-architecture)"; \
    FYA_VER="$(curl -fsSL https://api.github.com/repos/umputun/fya/releases/latest | jq -r .tag_name | sed 's/^v//')"; \
    curl -fsSL "https://github.com/umputun/fya/releases/download/v${FYA_VER}/fya_${FYA_VER}_linux_${ARCH}.tar.gz" \
      | tar -xz -C /usr/local/bin fya; \
    RLX_VER="$(curl -fsSL https://api.github.com/repos/umputun/ralphex/releases/latest | jq -r .tag_name | sed 's/^v//')"; \
    curl -fsSL "https://github.com/umputun/ralphex/releases/download/v${RLX_VER}/ralphex_${RLX_VER}_linux_${ARCH}.tar.gz" \
      | tar -xz -C /usr/local/bin ralphex; \
    chmod +x /usr/local/bin/fya /usr/local/bin/ralphex

# --- fya wrapper: align FYA_CLAUDE_DIR with claude's config dir ---
RUN printf '#!/bin/sh\nexport FYA_CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"\nexec /usr/local/bin/fya "$@"\n' \
      > /usr/local/bin/fya-wrapper.sh && chmod +x /usr/local/bin/fya-wrapper.sh

# --- seed Claude config so fya's interactive session never blocks on a dialog ---
# Claude >=2.1 shows a modal "Bypass Permissions mode" acceptance dialog on EVERY
# interactive launch with --dangerously-skip-permissions. fya drives the interactive
# claude TUI and can't dismiss it, so the prompt is never delivered, no transcript is
# written, and every turn dies on FYA_TRANSIENT_TIMEOUT (30m) -> ralphex retries the
# same iteration forever, making zero progress while burning Max usage.
# `skipDangerousModePermissionPrompt` is claude's settings escape hatch (the pp() gate)
# that suppresses that dialog. Bake it in so it survives container recreation.
RUN mkdir -p /home/node/.claude \
 && printf '%s' '{"theme":"dark","skipDangerousModePermissionPrompt":true}' \
      > /home/node/.claude/settings.json \
 && chown -R node:node /home/node/.claude

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# --- non-root user (Claude refuses --dangerously-skip-permissions as root) ---
# node:22-bookworm already ships a non-root `node` user (uid 1000); reuse it.
# Download Chrome-for-Testing into its HOME so it's found at runtime.
USER node
RUN agent-browser install
USER root

WORKDIR /workspace
EXPOSE 8080
# entrypoint starts as root to chown the volume, then drops to `app`.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
