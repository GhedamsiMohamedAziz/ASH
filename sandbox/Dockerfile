# sandbox — instructions.md §11.1 (image), §11.2 (hardening), ADR 002 (gVisor)
#
# Hardened OpenCode sandbox image: standard agent dev toolchain, non-root user,
# OpenCode binary + agent profiles. The FULL runtime hardening (gVisor
# RuntimeClass, egress NetworkPolicy to mcp-gateway/llm-proxy only, read-only
# rootfs, dropped capabilities) is applied when this image is RUN, not baked
# into it — see AX-075/AX-076 and README.md. This image only guarantees what
# a Dockerfile can: non-root, minimal surface, reproducible build.
FROM debian:12-slim

# --- standard agent dev toolchain (§11.1) ---
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    nodejs \
    npm \
    bash \
    git \
    curl \
    ca-certificates \
    ripgrep \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# --- OpenCode (headless agent server, §12, ADR 009) ---
# Installed from the npm registry (the canonical, reliable source — the GitHub
# release CDN is not always reachable). Pin OPENCODE_VERSION for reproducibility.
# The orchestrator drives it via `opencode serve` (verified: services/orchestrator/
# opencode.go + TestRealOpenCodeServer).
ARG OPENCODE_VERSION=1.17.15
RUN npm install -g opencode-ai@${OPENCODE_VERSION} \
    && ln -sf "$(npm root -g)/opencode-ai/bin/opencode" /usr/local/bin/opencode 2>/dev/null || true
RUN opencode --version || echo "opencode installed via npm global bin"

# --- agent profiles (§12) ---
RUN mkdir -p /etc/opencode/profiles
COPY profiles/ /etc/opencode/profiles/

# --- non-root user + workspace ---
RUN useradd -m -u 1000 -s /bin/bash agent \
    && mkdir -p /workspace /home/agent/.config/opencode \
    && chown -R agent:agent /workspace /etc/opencode /home/agent/.config

# --- OpenCode config (§12): MCP Gateway as the SOLE remote MCP server ---
# opencode loads its global config from $XDG_CONFIG_HOME/opencode (= ~/.config/opencode
# for the agent user; verified against opencode 1.17's config loader). This file wires
# the MCP Gateway (https://mcp-gateway.internal:8443/mcp, Authorization: Bearer ${TASK_JWT})
# as the only remote MCP server and carries the profile tool-group allow-list — see
# README.md "OpenCode + profiles wiring". No secret is baked in: TASK_JWT is resolved at
# runtime from the env the Orchestrator injects ({env:TASK_JWT}).
COPY --chown=agent:agent opencode.json /home/agent/.config/opencode/opencode.json

USER agent
WORKDIR /workspace

# Default command starts the OpenCode server (the orchestrator pushes turns on
# :4096, §22.3). Use CMD (not ENTRYPOINT) so the image stays a usable base:
# `docker run <img>` runs the agent server, while `docker run <img> whoami`,
# a shell, or a health probe still work — needed for ops and verification.
CMD ["opencode", "serve", "--port", "4096", "--hostname", "0.0.0.0"]
