FROM node:20-slim AS base

# OpenClaw requires Node.js runtime
WORKDIR /app

# Install OpenClaw CLI (placeholder — replace with actual package when available)
# RUN npm install -g @openclaw/cli@latest

# Copy agent configuration
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
ENV NO_PROXY="localhost,127.0.0.1"
ENV SOUL_PATH="/etc/openclaw/SOUL.md"
ENV CONFIG_PATH="./openclaw.json"

# Health check placeholder
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "process.exit(0)"

# Entry point — OpenClaw agent start
# CMD ["openclaw", "start", "--config", "./openclaw.json", "--soul", "/etc/openclaw/SOUL.md"]
CMD ["node", "-e", "console.log('OpenClaw agent placeholder - replace with actual openclaw CLI when available'); process.exit(0)"]
