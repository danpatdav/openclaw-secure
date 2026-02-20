FROM node:20-slim AS base

WORKDIR /app

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

# Entry point — run the agent
CMD ["node", "agent.mjs"]
