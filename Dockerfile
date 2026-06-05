# executr — containerized ralphex + fya + agent-browser + codex/claude stack.
# Debian base so agent-browser's Chrome-for-Testing (glibc) runs reliably.
FROM node:22-bookworm

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

# --- CLIs: pnpm, Claude Code, Codex, agent-browser (+ its Chrome) ---
# NOTE: confirm the npm package names if an install fails (claude-code / codex).
RUN corepack enable && corepack prepare pnpm@latest --activate
RUN npm install -g @anthropic-ai/claude-code @openai/codex agent-browser
RUN agent-browser install                     # downloads Chrome-for-Testing (glibc -> fine on Debian)

# --- fya (Max-plan driver) + ralphex, from GitHub releases ---
# NOTE: confirm the exact asset filenames on the releases pages if the build fails.
RUN set -eux; ARCH="$(dpkg --print-architecture)"; \
    curl -fsSL "https://github.com/umputun/fya/releases/latest/download/fya_linux_${ARCH}.tar.gz" \
      | tar -xz -C /usr/local/bin fya; \
    curl -fsSL "https://github.com/umputun/ralphex/releases/latest/download/ralphex_linux_${ARCH}.tar.gz" \
      | tar -xz -C /usr/local/bin ralphex; \
    chmod +x /usr/local/bin/fya /usr/local/bin/ralphex

# --- fya wrapper: align FYA_CLAUDE_DIR with claude's config dir ---
RUN printf '#!/bin/sh\nexport FYA_CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"\nexec /usr/local/bin/fya "$@"\n' \
      > /usr/local/bin/fya-wrapper.sh && chmod +x /usr/local/bin/fya-wrapper.sh

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /workspace
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
