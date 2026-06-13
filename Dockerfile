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
      git ca-certificates curl gnupg ripgrep jq sqlite3 tini \
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

# --- Swift toolchain (for Swift/macOS plans, e.g. notetakr) — Debian 12 native build ---
# The base image has no Swift; Swift plans' local-validate runs `swift test`. Baked in so a
# persistent dev env survives container recreation (a live-installed Swift is wiped on every
# Coolify redeploy). swiftly's auto-install is broken on Debian (it builds a URL with a space),
# so fetch the official debian12 tarball directly. NOTE: adds a ~1GB layer + slower image pulls.
ARG SWIFT_VERSION=6.3.2
RUN apt-get update && apt-get install -y --no-install-recommends \
      binutils libc6-dev libcurl4-openssl-dev libedit2 libgcc-12-dev libpython3-dev \
      libstdc++-12-dev libxml2-dev libz3-dev pkg-config tzdata unzip zlib1g-dev libncurses6 \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fSL "https://download.swift.org/swift-${SWIFT_VERSION}-release/debian12/swift-${SWIFT_VERSION}-RELEASE/swift-${SWIFT_VERSION}-RELEASE-debian12.tar.gz" \
      -o /tmp/swift.tar.gz \
 && mkdir -p /opt/swift && tar -xzf /tmp/swift.tar.gz -C /opt/swift --strip-components=1 \
 && rm /tmp/swift.tar.gz \
 && ln -sf /opt/swift/usr/bin/swift  /usr/local/bin/swift \
 && ln -sf /opt/swift/usr/bin/swiftc /usr/local/bin/swiftc \
 && swift --version

# --- fya wrapper: align FYA_CLAUDE_DIR with claude's config dir ---
# NB: keep the default 30m turn-timeout. fya/claude intermittently stalls at session
# startup (no transcript written); the 30m timeout then fires FYA_TRANSIENT_TIMEOUT and
# ralphex RETRIES the iteration (self-heals). Tempting fixes were rejected: fya --gate
# only counts idle *after* the first transcript write (so it misses the no-transcript
# startup stall, and would wrongly abort genuinely-long turns that idle the transcript
# during one command, e.g. a Swift toolchain download); an external watchdog kill makes
# ralphex report "context canceled" and FAIL the whole plan instead of retrying.
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

COPY control-plane/package.json control-plane/pnpm-lock.yaml control-plane/pnpm-workspace.yaml control-plane/pnpm.yaml control-plane/.npmrc control-plane/tsconfig.json /opt/executr-control-plane/
COPY control-plane/src /opt/executr-control-plane/src
RUN cd /opt/executr-control-plane \
 && pnpm install --frozen-lockfile \
 && pnpm run build

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
EXPOSE 8090
# entrypoint starts as root to chown the volume, then drops to `app`.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
