# OpenClaw Secure — Moltbook Experimentation

Secure Azure-native infrastructure for running an OpenClaw AI agent on Moltbook with defense-in-depth against prompt injection.

## Architecture

- **Azure VNet** with NSG-enforced network isolation
- **Bun HTTP proxy** with domain allowlisting, prompt injection sanitization, and structured logging
- **Azure Key Vault** for secrets management (no secrets on disk)
- **Azure Container Instances** for ephemeral, pay-per-second execution
- **Azure Monitor / Log Analytics** for observability and alerting

## Quick Start

### Prerequisites
- Azure CLI (`az`) logged in with subscription access
- Docker installed and running
- Bash shell

### Deploy MVP0 (Infrastructure Only)
```bash
# Deploy infrastructure + containers
./scripts/deploy.sh mvp0 rg-openclaw-secure

# Set your API key in Key Vault
az keyvault secret set --vault-name <vault-name> --name ANTHROPIC-API-KEY --value 'sk-ant-...'

# Run verification tests
./scripts/verify.sh rg-openclaw-secure
```

### Kill Switch
```bash
./scripts/kill-agent.sh rg-openclaw-secure
```

## MVP Progression

| MVP | Capability | Status |
|-----|-----------|--------|
| **MVP0** | Infrastructure + network isolation | Building |
| **MVP1** | Read-only Moltbook observation | Planned |
| **MVP2** | Controlled posting with rate limits | Planned |

## Security Model

1. **Network Layer (NSG):** OpenClaw container cannot reach internet — only the proxy subnet
2. **Application Layer (Proxy):** Domain allowlist + method restrictions + prompt injection sanitizer
3. **Agent Layer (Config):** Memory disabled, dangerous tools denied, SOUL.md read-only
4. **Secrets Layer (Key Vault):** API keys injected at runtime via managed identity
5. **Observability (Monitor):** All proxy traffic logged, injection alerts, rate limit tracking

## Estimated Cost

~$50-55/month for MVP1 steady state (ACI + Log Analytics + ACR + Key Vault).

## Project Structure

```
infra/          — Azure Bicep IaC (VNet, NSG, ACR, Key Vault, ACI)
proxy/          — Bun HTTP proxy with security controls
openclaw/       — Agent configuration and identity
scripts/        — Deployment, verification, and operations
monitoring/     — KQL dashboard queries
```
