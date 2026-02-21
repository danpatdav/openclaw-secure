# OpenClaw Secure — Moltbook Experimentation

Secure Azure-native infrastructure for running **DanielsClaw**, an AI agent on [Moltbook](https://www.moltbook.com) (the social network for AI agents), with defense-in-depth against prompt injection.

## Status

| MVP | Capability | Status |
|-----|-----------|--------|
| **MVP0** | Infrastructure + network isolation | Complete |
| **MVP1** | Read-only Moltbook observation | **Live** |
| **MVP2** | Controlled posting with rate limits | Planned |

**Agent:** [moltbook.com/u/danielsclaw](https://www.moltbook.com/u/danielsclaw)

## Architecture

```
┌──────────────────── Azure VNet (10.0.0.0/16) ────────────────────┐
│                                                                    │
│  ┌─ Private Subnet (10.0.1.0/24) ─┐  ┌─ Proxy Subnet (10.0.2.0/24) ─┐
│  │                                 │  │                                │
│  │  ACI: openclaw-openclaw         │  │  ACI: openclaw-proxy           │
│  │  ┌────────────────┐            │  │  ┌──────────────┐              │
│  │  │  DanielsClaw   │──TCP:3128──┼──┼─▶│  Bun Proxy   │──HTTPS──▶ Internet
│  │  │  (node:20)     │            │  │  │  (allowlist)  │              │
│  │  └────────────────┘            │  │  └──────────────┘              │
│  │  NSG: deny all outbound        │  │  NSG: allow HTTPS out          │
│  │       except proxy:3128        │  │       deny all inbound         │
│  └─────────────────────────────────┘  └────────────────────────────────┘
│                                                                    │
│  Key Vault ◄── secrets injected at deploy time (no IMDS needed)   │
│  Log Analytics ◄── structured JSONL from both containers          │
└────────────────────────────────────────────────────────────────────┘
```

**Allowed outbound domains (MVP1):**
- `api.anthropic.com` — Claude API (analysis)
- `www.moltbook.com` — Feed reading (GET only)

## Security Model

| Layer | Control | What it does |
|-------|---------|-------------|
| **Network (NSG)** | Deny-all outbound from agent | Agent can only reach proxy subnet on port 3128 |
| **Application (Proxy)** | Domain allowlist + method restrictions | Only whitelisted domains/methods pass through |
| **Application (Proxy)** | Prompt injection sanitizer | Detects and replaces injection patterns in responses |
| **Agent (Config)** | Hardened openclaw.json | Memory disabled, shell/exec/write/git tools denied |
| **Agent (SOUL.md)** | Read-only identity file | Behavioral constraints, cannot be modified at runtime |
| **Secrets (Key Vault)** | Deploy-time injection | API keys as secure env vars, never on disk or in logs |
| **Observability (Monitor)** | Structured logging + alerts | All traffic logged, injection detection alerts |

## Quick Start

### Prerequisites
- Azure CLI (`az`) logged in
- GitHub CLI (`gh`) for workflow dispatch
- Docker installed
- Azure subscription with these providers registered:
  `Microsoft.ContainerInstance`, `Microsoft.ContainerRegistry`, `Microsoft.KeyVault`, `Microsoft.ManagedIdentity`, `Microsoft.OperationalInsights`

### Deploy

Deployments run via GitHub Actions with environment protection (manual approval required).

```bash
# Deploy MVP1 (read-only Moltbook observation)
gh workflow run deploy.yml \
  --field mvp_level=mvp1 \
  --field resource_group=rg-openclaw-secure \
  --field action=deploy
```

The pipeline: preflight checks (SOUL integrity, Bicep validation, secrets scan) → infrastructure deploy → image build/push → ACI deploy → verification suite.

### Set Secrets (first time only)

```bash
az keyvault secret set --vault-name <vault-name> --name ANTHROPIC-API-KEY --value 'sk-ant-...'
az keyvault secret set --vault-name <vault-name> --name MOLTBOOK-API-KEY --value 'moltbook_sk_...'
```

### Monitor

**Azure Portal:** Log Analytics workspace `openclaw-logs` → Logs → look for the **OpenClaw** category in saved queries.

**Saved queries available:**
- Agent Activity (All)
- Agent Errors
- Agent Run History
- Feed Analysis Results
- Prompt Injection Detections
- Proxy Traffic

**Alerts configured (every 5 min):**
- Agent Error Detected (Sev 2)
- Prompt Injection Detected (Sev 1)
- Agent Fatal Error (Sev 1)

**CLI quick check:**
```bash
az container logs -g rg-openclaw-secure -n openclaw-openclaw --container-name openclaw
az container logs -g rg-openclaw-secure -n openclaw-proxy --container-name proxy
```

### Kill Switch

```bash
./scripts/kill-agent.sh rg-openclaw-secure
```

### Destroy Everything

```bash
gh workflow run deploy.yml \
  --field mvp_level=mvp1 \
  --field resource_group=rg-openclaw-secure \
  --field action=destroy
```

## Project Structure

```
.github/workflows/
  ci.yml                    — PR checks (tests, Bicep validation, secrets scan)
  deploy.yml                — Full deploy pipeline with environment protection

infra/
  main.bicep                — Orchestrator (VNet, ACR, Key Vault, Log Analytics)
  parameters.json           — Default deployment parameters
  modules/
    networking.bicep         — VNet + subnets + NSG rules
    container-registry.bicep — Private ACR for images
    key-vault.bicep          — Key Vault with access policies
    monitoring.bicep         — Log Analytics workspace
  aci/
    container-group.bicep    — ACI container groups (proxy + agent)
    parameters.mvp0.json     — MVP0 ACI parameters
    parameters.mvp1.json     — MVP1 ACI parameters

proxy/                       — Bun HTTP proxy (security layer)
  src/
    index.ts                 — Proxy server entry point
    allowlist.ts             — Domain + method allowlist enforcement
    sanitizer.ts             — Prompt injection pattern detection
    logger.ts                — Structured JSONL logging
    types.ts                 — TypeScript type definitions
    *.test.ts                — Unit tests
  config/
    allowlist.mvp0.json      — MVP0: api.anthropic.com only
    allowlist.mvp1.json      — MVP1: + www.moltbook.com (GET only)
    allowlist.mvp2.json      — MVP2: + POST to specific endpoints
    action-allowlist.json    — MVP2: endpoint-level POST rules

openclaw/                    — Agent container
  agent.mjs                  — Agent runtime (feed reader + Claude analysis)
  Dockerfile                 — Hardened container (non-root, read-only SOUL)
  package.json               — Dependencies (undici for proxy support)
  openclaw.json              — Hardened agent config (memory off, tools denied)
  SOUL.md                    — Agent identity and behavioral constraints

scripts/
  deploy.sh                  — Local deployment script
  verify.sh                  — Post-deploy verification suite (6 tests)
  kill-agent.sh              — Emergency stop (az container stop + delete)
  run-agent.sh               — On-demand agent execution
  check-soul-integrity.sh    — SHA-256 SOUL.md verification

monitoring/
  dashboard.kql              — KQL queries for Azure Monitor workbook
```

## How It Works (MVP1)

1. **Deploy** triggers GitHub Actions → builds images → pushes to ACR → deploys ACI containers into VNet
2. **Proxy starts** in proxy subnet, loads MVP1 allowlist (Anthropic + Moltbook GET-only)
3. **Agent starts** in private subnet, receives API keys as secure env vars
4. Agent fetches Moltbook feed **through the proxy** using `undici.ProxyAgent`
5. Agent sends feed to **Claude** for analysis (topics, injection detection, interesting threads, safety notes)
6. All activity logged as structured JSON → Azure Monitor → saved queries + alerts
7. Agent exits (restartPolicy: Never) — ephemeral by design

## Estimated Cost

~$50-55/month for MVP1 steady state:

| Service | Est. Monthly |
|---------|-------------|
| ACI (proxy, always-on) | ~$35 |
| ACI (agent, ephemeral runs) | ~$5-10 |
| ACR Basic | ~$5 |
| Log Analytics (~1GB/mo) | ~$3 |
| Key Vault | ~$1 |
| VNet/NSG | $0 |
