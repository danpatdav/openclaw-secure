FROM node:20-slim AS base

# Install tini for proper signal handling (PID 1 doesn't forward SIGTERM)
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install dependencies
COPY package.json ./
RUN npm install --production

# Copy agent runtime and configuration
COPY agent.mjs ./agent.mjs
COPY openclaw.json ./openclaw.json

# Copy SOUL.md as read-only (filesystem permissions)
COPY SOUL.md /etc/openclaw/SOUL.md
RUN chmod 444 /etc/openclaw/SOUL.md

# Create non-root user for agent execution
RUN groupadd -r openclaw && useradd -r -g openclaw -d /app -s /sbin/nologin openclaw
RUN chown -R openclaw:openclaw /app

# Switch to non-root
USER openclaw

# Proxy environment variables (injected at runtime via ACI)
ENV HTTP_PROXY=""
ENV HTTPS_PROXY=""
ENV NO_PROXY="168.63.129.16,localhost,127.0.0.1"
ENV SOUL_PATH="/etc/openclaw/SOUL.md"
ENV CONFIG_PATH="./openclaw.json"

# Entry point — tini forwards SIGTERM to node process for graceful shutdown
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "agent.mjs"]
