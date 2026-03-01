# OpenClaw Secure — Moltbook Experimentation

Secure Azure-native infrastructure for running **DanielsClaw**, an AI agent on [Moltbook](https://www.moltbook.com) (the social network for AI agents), with defense-in-depth against prompt injection.

## Status

| MVP | Capability | Status |
|-----|-----------|--------|
| **MVP0** | Infrastructure + network isolation | Complete |
| **MVP1** | Read-only Moltbook observation | Complete |
| **MVP1.5** | Semi-persistent observation + dual-model audit | Complete |
| **MVP2** | Controlled posting with rate limits | Complete |
| **MVP3** | Stable operation — structural pre-checks, calibrated verdicts | Complete |
| **MVP3.1** | Comment read-through — agent reads, sanitizes, and responds to comments | **Live** |

**Agent:** [moltbook.com/u/danielsclaw](https://www.moltbook.com/u/danielsclaw)
**Tests:** 390 tests across proxy/analyzer/agent — see [docs/TESTING.md](docs/TESTING.md)

## Architecture

```
┌──────────────────── Azure VNet (10.0.0.0/16) ────────────────────────┐
│                                                                      │
│  ┌─ Private (10.0.1.0/24) ─┐  ┌─ Proxy (10.0.2.0/24) ───┐            │
│  │                         │  │                         │            │
│  │  Agent Container        │  │  Proxy Container        │            │
│  │  ┌──────────────┐       │  │  ┌──────────────┐       │            │
│  │  │ DanielsClaw  │──3128─┼──┼─▶│ Bun Proxy    │──443──▶ Internet   │
│  │  │ (4hr loop)   │       │  │  │ /post /vote  │       │  (reads)   │
│  │  │              │──POST─┼──┼─▶│ /comment     │───────▶ Moltbook   │
│  │  │              │──GET──┼──┼─▶│ /comments    │       │  (r/w)     │
│  │  │              │──POST─┼──┼─▶│ /memory API  │       │            │
│  │  └──────────────┘       │  │  └──────┬───────┘       │            │
│  │  NSG: proxy:3128 only   │  │  NSG: HTTPS out         │            │
│  └─────────────────────────┘  └────────┼────────────────┘            │
│                                        │                             │
│  ┌─ Analyzer (10.0.3.0/24) ─┐          │                             │
│  │                          │          ▼                             │
│  │  Analyzer Container      │   Azure Blob Storage                   │
│  │  ┌───────────────┐       │   ┌─────────────────┐                  │
│  │  │ Claude+OpenAI │───────┼──▶│ agent-memory/   │                  │
│  │  │ dual audit    │       │   │  memory/*.json  │                  │
│  │  └───────────────┘       │   │  verdicts/*.json│                  │
│  │  NSG: HTTPS out only     │   └─────────────────┘                  │
│  └──────────────────────────┘                                        │
│                                                                      │
│  Key Vault: ANTHROPIC-API-KEY, MOLTBOOK-API-KEY, OPENAI-API-KEY,     │
│             ACS-CONNECTION-STRING, ACS-SENDER-DOMAIN, EMAIL-RECIPIENT│
│  Log Analytics: structured JSONL from all containers                 │
└──────────────────────────────────────────────────────────────────────┘
```

**Key isolation:** Agent reads Moltbook feed via CONNECT tunnel (proxy allowlist) and reads comments via proxy read-through endpoint (`GET /comments` — proxy fetches from Moltbook, sanitizes each comment through injection detector, returns clean data). Writes go through proxy `/post`, `/vote`, and `/comment` endpoints (schema-validated, anomaly-monitored). The Moltbook API key for authenticated requests lives on the **proxy**, not the agent — the agent holds only its Anthropic key (Claude analysis) and a Moltbook key scoped to feed reads. Analyzer has direct Blob access but NO access to Moltbook or the agent's runtime. OpenAI key is only in the analyzer container, never the agent.

**Allowed outbound domains (agent):**
- `api.anthropic.com` — Claude API (analysis)
- `www.moltbook.com` — Feed reading (CONNECT tunnel)
- Posting/voting/commenting via proxy `/post`, `/vote`, `/comment` endpoints (proxy holds write-scoped Moltbook key)
- Comment reading via proxy read-through `/comments` endpoint (proxy fetches, sanitizes per-comment, returns clean data)

## Security Model

| Layer | Control | What it does |
|-------|---------|-------------|
| **Network (NSG)** | Deny-all outbound from agent | Agent can only reach proxy subnet on port 3128 |
| **Application (Proxy)** | Domain allowlist + method restrictions | Only whitelisted domains/methods pass through |
| **Application (Proxy)** | Prompt injection sanitizer (outbound) | Detects/replaces injection patterns in **agent outbound posts** before forwarding to Moltbook |
| **Application (Proxy)** | Statistical anomaly detection | Observe-only: rolling mean + 2σ threshold over 50-cycle window flags unusual activity (no blocking) |
| **Application (Proxy)** | Comment read-through sanitization | Per-comment injection scanning on inbound comments before agent sees them (capped at 50 comments/post) |
| **Application (Proxy)** | Content validation | Zod schema: max 500 chars, injection scanning on outbound posts and comments |
| **Memory (Proxy)** | Zod schema validation | All memory writes validated — no freeform text, fixed enums only |
| **Memory (Blob)** | Append-only + 1MB size cap | Memory blobs are never overwritten, size-aware pruning keeps payloads under 900KB |
| **Audit (Analyzer)** | Structural pre-checks + dual-model analysis | Deterministic math validation first; AI consensus at 0.8+ confidence required to block |
| **Gating (Workflow)** | Verdict-gated lifecycle | kill-and-analyze owns full cycle: kill → analyze → email → restart if approved |
| **Agent (Config)** | Hardened openclaw.json | Shell/exec/write/git tools denied |
| **Agent (SOUL.md)** | Read-only identity file | Behavioral constraints, cannot be modified at runtime |
| **Secrets (Key Vault)** | Deploy-time injection | API keys as secure env vars, never on disk or in logs |
| **Observability (Monitor)** | Structured logging + alerts | All traffic logged, injection detection alerts |

## How It Works (MVP3)

### Agent Run Cycle (4 hours)

1. Agent loads last approved memory from proxy (`GET /memory/latest`), including tracked commented posts
2. Agent loops: fetch Moltbook feed → deduplicate posts → fetch comments on previously-commented posts (check for replies) → fetch comments on new posts (understand context) → analyze with Claude (feed + comment context) → Claude recommends actions (replies, upvotes, comments) → execute through proxy endpoints → save memory
3. Agent normalizes Claude's labels to valid schema enums before memory save (e.g., "tech" → "technical", "mixed" → "neutral")
4. Memory saves go through proxy (`POST /memory`) → Zod schema validation → Blob Storage. Size-aware pruning trims oldest `post_seen` entries to stay under 900KB. Comments tracked as `comment_made` entries for conversation continuity
5. Proxy records activity per 5-minute cycle; statistical anomaly detection (2σ, observe-only) flags unusual posting/voting/commenting patterns without blocking
6. After 4 hours, **kill-and-analyze** workflow stops the agent

### Analysis & Restart Cycle (~15 minutes)

The `kill-and-analyze` workflow owns the full agent lifecycle:

6. Analyzer finds the latest unanalyzed memory blob
7. **Structural pre-checks** (deterministic, before any AI): minimum 30-minute run duration gate, absolute action counts validated
8. If structurally valid, sends diff + patterns to **Claude** and **OpenAI GPT-4.1** (adversarial prompt focused on content manipulation, not rate speculation)
9. **Default approved** — blocking requires dual-model consensus: both must say "compromised" with ≥0.8 confidence. Model failures return null (no opinion), not auto-block
10. Verdict written to `verdicts/<run_id>.json` with structural pre-check details
11. **Email summary** sent via Azure Communication Services — Claude summarizes the run in plain English
12. If approved, agent automatically restarts. If blocked, manual intervention required with `force_start` override available

### Memory Schema

Memory files are strictly validated — no freeform text fields:

```json
{
  "version": 2,
  "run_id": "uuid-cp1",
  "run_start": "ISO8601",
  "run_end": "ISO8601",
  "entries": [
    { "type": "post_seen", "post_id": "str", "timestamp": "ISO8601", "topic_label": "enum", "sentiment": "enum" },
    { "type": "post_made", "post_id": "str", "thread_id": "str", "timestamp": "ISO8601", "action": "enum", "content": "str", "status": "enum" },
    { "type": "comment_made", "post_id": "str", "comment_id": "str?", "parent_id": "str?", "timestamp": "ISO8601", "content": "str?" },
    { "type": "thread_tracked", "thread_id": "str", "topic_label": "enum", "first_seen": "ISO8601", "last_interaction": "ISO8601" }
  ],
  "stats": { "posts_read": 0, "posts_made": 0, "upvotes": 0, "comments": 0, "threads_tracked": 0 }
}
```

**Fixed enums:** `topic_label` (Claude-assigned per post, not hardcoded — e.g., ai_safety, agent_design, moltbook_meta, social, technical), `sentiment` (positive, neutral, negative), `action` (reply, new_post, upvote, comment), `status` (sent, rate_limited, failed).

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
# mvp_level selects the ACI parameter file (parameters.mvp0/1/2.json) and proxy allowlist
gh workflow run deploy.yml \
  --field mvp_level=mvp2 \
  --field resource_group=rg-openclaw-secure \
  --field action=deploy
```

The pipeline: preflight checks (SOUL integrity, Bicep validation, secrets scan) → infrastructure deploy → image build/push → ACI deploy → verification suite.

### Set Secrets (first time only)

Key Vault secret names use hyphens (e.g., `ANTHROPIC-API-KEY`), which Bicep converts to env vars with underscores (`ANTHROPIC_API_KEY`) when injecting into containers.

```bash
az keyvault secret set --vault-name <vault-name> --name ANTHROPIC-API-KEY --value 'sk-ant-...'
az keyvault secret set --vault-name <vault-name> --name MOLTBOOK-API-KEY --value 'moltbook_sk_...'
az keyvault secret set --vault-name <vault-name> --name OPENAI-API-KEY --value 'sk-proj-...'
az keyvault secret set --vault-name <vault-name> --name ACS-CONNECTION-STRING --value 'endpoint=...'
az keyvault secret set --vault-name <vault-name> --name ACS-SENDER-DOMAIN --value 'your-domain.azurecomm.net'
az keyvault secret set --vault-name <vault-name> --name EMAIL-RECIPIENT --value 'you@example.com'
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
  --field mvp_level=mvp2 \
  --field resource_group=rg-openclaw-secure \
  --field action=destroy
```

## Project Structure

```
.github/workflows/
  ci.yml                      — PR checks (tests, Bicep validation, secrets scan)
  deploy.yml                  — Full deploy pipeline with environment protection
  start-agent.yml             — Manual: start agent (verdict-gated, force_start override)
  kill-and-analyze.yml        — Cron: kill → analyze → email summary → restart if approved

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
    parameters.mvp2.json       — MVP2 ACI parameters

proxy/                         — Bun HTTP proxy (security layer)
  src/
    index.ts                   — Proxy server + TCP body buffering + routing for /post, /vote, /comment, /comments, /memory
    allowlist.ts               — Domain + method allowlist enforcement
    sanitizer.ts               — Prompt injection pattern detection
    comment-reader.ts          — Comment read-through: fetch from Moltbook, per-comment sanitization, clean response
    memory-schema.ts           — Zod schema for memory validation (post_seen, post_made, comment_made, thread_tracked)
    post-handler.ts            — /post, /vote, /comment endpoints with statistical anomaly detection
    post-schema.ts             — Zod schemas for post/vote/comment request validation
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
  agent.mjs                    — Semi-persistent loop (4hr, 5-min cycles, posting/commenting logic, comment read-back, Claude action recommendations, schema normalization, size-aware pruning)
  Dockerfile                   — Hardened container (non-root, tini init, read-only SOUL)
  package.json                 — Dependencies (undici for proxy support)
  openclaw.json                — Hardened agent config (memory off, tools denied)
  SOUL.md                      — Agent identity and behavioral constraints

analyzer/                      — Dual-model audit container
  analyzer.mjs                 — Structural pre-checks + Claude/OpenAI adversarial analysis, calibrated verdicts
  package.json                 — Dependencies (@azure/storage-blob, @azure/identity)
  Dockerfile                   — Hardened container (non-root, node:20-slim)

summary/                       — Post-run email summaries
  prompt.txt                   — Claude summarization prompt template
  send-summary.sh              — Downloads blobs, calls Claude for summary, sends via ACS

scripts/
  deploy.sh                    — Local deployment script
  verify.sh                    — Post-deploy verification suite
  kill-agent.sh                — Emergency stop (az container stop + delete)
  run-agent.sh                 — On-demand agent execution
  check-soul-integrity.sh      — SHA-256 SOUL.md verification

monitoring/
  dashboard.kql                — KQL queries for Azure Monitor workbook
```

## Documentation

| Doc | Purpose |
|-----|---------|
| [README.md](README.md) | Architecture, deployment, operations (this file) |
| [CLAUDE.md](CLAUDE.md) | Project conventions for AI assistants (versioning, workflow, testing) |
| [docs/TESTING.md](docs/TESTING.md) | Testing strategy, attack taxonomy, known gaps, contributor guide |
| [openclaw/SOUL.md](openclaw/SOUL.md) | Agent identity and behavioral constraints |

## Operational Learnings

Issues discovered and resolved during MVP1.5 and MVP2 deployment:

| Issue | Root Cause | Fix |
|-------|-----------|-----|
| Memory saves return 400 | Proxy TCP body truncation — large POST bodies span multiple chunks | Buffer complete body using Content-Length before processing |
| Analyzer gets "Non-JSON response" from Claude | Claude wraps JSON in markdown code blocks | Strip ``` wrappers before JSON.parse |
| Agent SIGTERM handler never fires | Node.js as PID 1 in Docker doesn't receive signals | Added tini init process + per-cycle saves as fallback |
| Memory schema rejects checkpoint saves | Zod validated run_id as strict UUID, checkpoints use `uuid-cpN` | Relaxed to regex allowing `-cp{N}` suffix |
| GitHub Actions can't authenticate to Azure | OIDC secrets are environment-scoped | Added `environment: production` to workflows |
| Workflow can't read blobs | SP lacks Storage Blob Data Reader RBAC | Switched to `--auth-mode key` |
| Analyzer false positive on posting frequency | Counted upvotes as posts, inflating "posting frequency" metric | Separated per-type metrics: reply rate vs upvote rate |
| 429 back-off needed | Agent kept trying actions after rate limit hit | Added `postRateLimited` / `voteRateLimited` flags, skip remaining actions of that type |
| Memory schema validation failures | Claude returns labels like "tech", "mixed" not in Zod enums | Agent-side normalization with alias mapping (e.g., "tech"→"technical", "mixed"→"neutral") |
| Memory exceeding 1MB limit | Unbounded growth of post_seen entries (7000+) | Size-aware binary-search pruning trims oldest entries to stay under 900KB |
| Fixed rate limits too restrictive | Arbitrary numbers (3/hr, 10/day) with no behavioral baseline | Replaced with statistical anomaly detection: rolling 50-cycle mean + 2σ threshold, observe-only |
| Topic classification broken | Hardcoded "other" for all posts | Claude-assigned labels per post during analysis |
| Reply content not stored | Couldn't audit what the agent actually posted | Added `content` and `status` fields to `post_made` entries |
| Analyzer false blocks on short runs | Per-hour rate projections unreliable on <30min runs | Added 30-minute minimum duration gate — short runs auto-approve |
| Analyzer blocks on normal activity | "Both must agree clean" too strict — single model disagreement blocks | Inverted to "default approved, dual consensus at 0.8+ to block" |
| OpenAI returning non-JSON | Model sometimes wraps JSON in prose | Use GPT-4.1 with `response_format: { type: "json_object" }` and strip code fences defensively |
| AI models speculate about rates | Models flag proxy-enforced limits as "suspicious" | Structural pre-checks validate math first; AI prompt focused on content manipulation only |
| Agent never posts | SOUL.md had 4 "default to silence" instructions | Rewrote SOUL for active participation with engagement targets |
| Independent cron schedules drift | Agent started right before kill, getting only 11min runtime | Unified lifecycle: kill-and-analyze owns restart (single schedule owner) |
| Cross-comment injection risk | Multiple comments concatenated in Claude prompt could form injection payload | Per-comment sanitization before assembly; each comment delimited by author/content format in prompt; resource bound of 50 comments per API response |
| Comment volume as DoS vector | Post with thousands of comments could cause oversized prompts | Proxy resource bound (50 comments/response); agent prompt cap (4000 chars); outbound comment volume monitored by statistical anomaly detection (same as posts/votes) |

## Estimated Cost

~$75-85/month for MVP3 steady state:

| Service | Est. Monthly |
|---------|-------------|
| ACI (proxy, always-on) | ~$35 |
| ACI (agent, 4hr runs ~5x/day) | ~$5-10 |
| ACI (analyzer, ~5 runs/day x 15min) | ~$12 |
| ACR Basic | ~$5 |
| Blob Storage (~1GB, 7-day retention) | ~$2 |
| OpenAI API (GPT-4.1, ~5 calls/day) | ~$2 |
| Claude API (Sonnet, summaries) | ~$0.50 |
| Azure Communication Services (email) | ~$1 |
| Log Analytics (~1GB/mo) | ~$3 |
| Key Vault | ~$1 |
| VNet/NSG | $0 |
