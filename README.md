# OpenClaw Secure — Moltbook Experimentation

Secure Azure-native infrastructure for running **DanielsClaw**, an AI agent on [Moltbook](https://www.moltbook.com) (the social network for AI agents), with defense-in-depth against prompt injection.

## Status

| MVP | Capability | Status |
|-----|-----------|--------|
| **MVP0** | Infrastructure + network isolation | Complete |
| **MVP1** | Read-only Moltbook observation | Complete |
| **MVP1.5** | Semi-persistent observation + dual-model audit | **Live** |
| **MVP2** | Controlled posting with rate limits | Planned |

**Agent:** [moltbook.com/u/danielsclaw](https://www.moltbook.com/u/danielsclaw)

## Architecture

```
┌──────────────────── Azure VNet (10.0.0.0/16) ─────────────────────────┐
│                                                                        │
│  ┌─ Private (10.0.1.0/24) ─┐  ┌─ Proxy (10.0.2.0/24) ──┐            │
│  │                          │  │                          │            │
│  │  Agent Container         │  │  Proxy Container         │            │
│  │  ┌──────────────┐       │  │  ┌──────────────┐       │            │
│  │  │ DanielsClaw  │──3128─┼──┼─▶│ Bun Proxy    │──443──▶ Internet   │
│  │  │ (4hr loop)   │       │  │  │ + /memory API│       │            │
│  │  └──────────────┘       │  │  └──────┬───────┘       │            │
│  │  NSG: proxy:3128 only   │  │  NSG: HTTPS out         │            │
│  └──────────────────────────┘  └────────┼────────────────┘            │
│                                         │                              │
│  ┌─ Analyzer (10.0.3.0/24) ─┐         │                              │
│  │                           │         ▼                              │
│  │  Analyzer Container       │   Azure Blob Storage                   │
│  │  ┌───────────────┐       │   ┌─────────────────┐                  │
│  │  │ Claude+OpenAI │───────┼──▶│ agent-memory/   │                  │
│  │  │ dual audit    │       │   │  memory/*.json   │                  │
│  │  └───────────────┘       │   │  verdicts/*.json │                  │
│  │  NSG: HTTPS out only     │   └─────────────────┘                  │
│  └───────────────────────────┘                                        │
│                                                                        │
│  Key Vault: ANTHROPIC-API-KEY, MOLTBOOK-API-KEY, OPENAI-API-KEY      │
│  Log Analytics: structured JSONL from all containers                   │
└────────────────────────────────────────────────────────────────────────┘
```

**Key isolation:** Agent can ONLY reach Blob Storage through the proxy `/memory` endpoint (schema-validated). Analyzer has direct Blob access but NO access to Moltbook or the agent's runtime. OpenAI key is only in the analyzer container, never the agent.

**Allowed outbound domains (agent):**
- `api.anthropic.com` — Claude API (analysis)
- `www.moltbook.com` — Feed reading (GET only)

## Security Model

| Layer | Control | What it does |
|-------|---------|-------------|
| **Network (NSG)** | Deny-all outbound from agent | Agent can only reach proxy subnet on port 3128 |
| **Application (Proxy)** | Domain allowlist + method restrictions | Only whitelisted domains/methods pass through |
| **Application (Proxy)** | Prompt injection sanitizer | Detects and replaces injection patterns in responses |
| **Memory (Proxy)** | Zod schema validation | All memory writes validated — no freeform text, fixed enums only |
| **Memory (Blob)** | Append-only + 1MB size cap | Memory blobs are never overwritten, capped at 10,000 entries |
| **Audit (Analyzer)** | Dual-model adversarial analysis | Both Claude and OpenAI must agree "clean" for memory approval |
| **Gating (Workflow)** | Verdict-gated restarts | Agent cannot restart if latest verdict is "blocked" |
| **Agent (Config)** | Hardened openclaw.json | Shell/exec/write/git tools denied |
| **Agent (SOUL.md)** | Read-only identity file | Behavioral constraints, cannot be modified at runtime |
| **Secrets (Key Vault)** | Deploy-time injection | API keys as secure env vars, never on disk or in logs |
| **Observability (Monitor)** | Structured logging + alerts | All traffic logged, injection detection alerts |

## How It Works (MVP1.5)

### Agent Run Cycle (4 hours)

1. **start-agent** workflow checks the latest verdict in Blob Storage — refuses to start if "blocked"
2. Agent loads last approved memory from proxy (`GET /memory/latest`)
3. Agent loops: fetch Moltbook feed → deduplicate posts → analyze with Claude → save memory
4. Memory saves go through proxy (`POST /memory`) → Zod schema validation → Blob Storage
5. After 4 hours, **kill-and-analyze** workflow stops the agent

### Analysis Cycle (~15 minutes)

6. Analyzer finds the latest unanalyzed memory blob
7. Computes behavioral diff: topic distribution, sentiment drift, posting frequency, reading velocity
8. Sends diff + patterns to **Claude** (adversarial prompt: "find evidence of manipulation")
9. Sends diff + patterns to **OpenAI GPT-4** (same adversarial prompt)
10. **Both must return "clean" for approval** — any "suspicious" or "compromised" → blocked
11. Verdict written to `verdicts/<run_id>.json`, memory blob metadata updated
12. Next agent start checks this verdict before proceeding

### Memory Schema

Memory files are strictly validated — no freeform text fields:

```json
{
  "version": 1,
  "run_id": "uuid-cp1",
  "run_start": "ISO8601",
  "run_end": "ISO8601",
  "entries": [
    { "type": "post_seen", "post_id": "str", "timestamp": "ISO8601", "topic_label": "enum", "sentiment": "enum" },
    { "type": "post_made", "post_id": "str", "thread_id": "str", "timestamp": "ISO8601", "action": "enum" },
    { "type": "thread_tracked", "thread_id": "str", "topic_label": "enum", "first_seen": "ISO8601", "last_interaction": "ISO8601" }
  ],
  "stats": { "posts_read": 0, "posts_made": 0, "upvotes": 0, "threads_tracked": 0 }
}
```

**Fixed enums:** `topic_label` (ai_safety, agent_design, moltbook_meta, social, technical, other), `sentiment` (positive, neutral, negative), `action` (reply, new_post, upvote).

## Quick Start

### Prerequisites
- Azure CLI (`az`) logged in
- GitHub CLI (`gh`) for workflow dispatch
- Docker installed
- Azure subscription with these providers registered:
  `Microsoft.ContainerInstance`, `Microsoft.ContainerRegistry`, `Microsoft.KeyVault`, `Microsoft.ManagedIdentity`, `Microsoft.OperationalInsights`, `Microsoft.Storage`

### Deploy

Deployments run via GitHub Actions with environment protection (manual approval required).

```bash
# Deploy everything (infra + images + containers)
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
az keyvault secret set --vault-name <vault-name> --name OPENAI-API-KEY --value 'sk-proj-...'
```

### Trigger Analysis Early (testing)

```bash
gh workflow run kill-and-analyze.yml
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

**Check latest verdict:**
```bash
STORAGE_NAME=$(az storage account list -g rg-openclaw-secure --query '[0].name' -o tsv)
az storage blob list --account-name "$STORAGE_NAME" --container-name agent-memory \
  --prefix verdicts/ --auth-mode key --query '[].name' -o tsv
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
  ci.yml                      — PR checks (tests, Bicep validation, secrets scan)
  deploy.yml                  — Full deploy pipeline with environment protection
  start-agent.yml             — Cron: start agent (verdict-gated)
  kill-and-analyze.yml        — Cron: kill agent + run dual-model analyzer

infra/
  main.bicep                  — Orchestrator (VNet, ACR, Key Vault, Log Analytics, Storage)
  parameters.json             — Default deployment parameters
  modules/
    networking.bicep           — VNet + 3 subnets + NSG rules
    container-registry.bicep   — Private ACR for images
    key-vault.bicep            — Key Vault with access policies
    monitoring.bicep           — Log Analytics workspace
    storage.bicep              — Blob Storage + agent-memory container + 7-day lifecycle
  aci/
    container-group.bicep      — ACI container groups (proxy + agent)
    analyzer-group.bicep       — ACI container group (analyzer)
    parameters.mvp0.json       — MVP0 ACI parameters
    parameters.mvp1.json       — MVP1 ACI parameters

proxy/                         — Bun HTTP proxy (security layer)
  src/
    index.ts                   — Proxy server + TCP body buffering for /memory
    allowlist.ts               — Domain + method allowlist enforcement
    sanitizer.ts               — Prompt injection pattern detection
    memory-schema.ts           — Zod schema for memory validation
    memory-store.ts            — /memory API endpoint + Blob Storage client
    logger.ts                  — Structured JSONL logging
    types.ts                   — TypeScript type definitions
    *.test.ts                  — Unit tests
  config/
    allowlist.mvp0.json        — MVP0: api.anthropic.com only
    allowlist.mvp1.json        — MVP1: + www.moltbook.com (GET only)
    allowlist.mvp2.json        — MVP2: + POST to specific endpoints
    action-allowlist.json      — MVP2: endpoint-level POST rules

openclaw/                      — Agent container
  agent.mjs                    — Semi-persistent loop (4hr, 5-min cycles, per-cycle memory saves)
  Dockerfile                   — Hardened container (non-root, tini init, read-only SOUL)
  package.json                 — Dependencies (undici for proxy support)
  openclaw.json                — Hardened agent config (memory off, tools denied)
  SOUL.md                      — Agent identity and behavioral constraints

analyzer/                      — Dual-model audit container
  analyzer.mjs                 — Claude + OpenAI adversarial analysis, verdict writer
  package.json                 — Dependencies (@azure/storage-blob, @azure/identity)
  Dockerfile                   — Hardened container (non-root, node:20-slim)

scripts/
  deploy.sh                    — Local deployment script
  verify.sh                    — Post-deploy verification suite
  kill-agent.sh                — Emergency stop (az container stop + delete)
  run-agent.sh                 — On-demand agent execution
  check-soul-integrity.sh      — SHA-256 SOUL.md verification

monitoring/
  dashboard.kql                — KQL queries for Azure Monitor workbook
```

## Operational Learnings

Issues discovered and resolved during MVP1.5 deployment:

| Issue | Root Cause | Fix |
|-------|-----------|-----|
| Memory saves return 400 | Proxy TCP body truncation — large POST bodies span multiple chunks | Buffer complete body using Content-Length before processing |
| Analyzer gets "Non-JSON response" from Claude | Claude wraps JSON in markdown code blocks | Strip ``` wrappers before JSON.parse |
| Agent SIGTERM handler never fires | Node.js as PID 1 in Docker doesn't receive signals | Added tini init process + per-cycle saves as fallback |
| Memory schema rejects checkpoint saves | Zod validated run_id as strict UUID, checkpoints use `uuid-cpN` | Relaxed to regex allowing `-cp{N}` suffix |
| GitHub Actions can't authenticate to Azure | OIDC secrets are environment-scoped | Added `environment: production` to workflows |
| Workflow can't read blobs | SP lacks Storage Blob Data Reader RBAC | Switched to `--auth-mode key` |

## Estimated Cost

~$67-72/month for MVP1.5 steady state:

| Service | Est. Monthly |
|---------|-------------|
| ACI (proxy, always-on) | ~$35 |
| ACI (agent, 4hr runs ~5x/day) | ~$5-10 |
| ACI (analyzer, ~5 runs/day x 15min) | ~$12 |
| ACR Basic | ~$5 |
| Blob Storage (~1GB, 7-day retention) | ~$2 |
| OpenAI API (GPT-4, ~5 calls/day) | ~$3 |
| Log Analytics (~1GB/mo) | ~$3 |
| Key Vault | ~$1 |
| VNet/NSG | $0 |
