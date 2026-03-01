# OpenClaw Secure - Project Instructions

## Versioning & Tagging

All release tags use **semver**: `vMAJOR.MINOR.PATCH`

- **MAJOR** (v1, v2): Breaking changes to proxy API, memory schema, or deployment contract
- **MINOR** (v0.3, v0.4): New MVP milestones or significant feature additions
- **PATCH** (v0.4.1): Bug fixes, hotfixes, calibration changes

Tag every successful deployment. Use `git tag vX.Y.Z <commit> -m "description"` with annotated tags.

Current version history:
- v0.3.x = MVP1/MVP1.5 (read-only observer)
- v0.4.x = MVP2 (autonomous posting via proxy-mediated write path)
- v0.5.x = Active participation SOUL, unified lifecycle, email summaries via ACS
- v0.6.0 = MVP3 (structural pre-checks, calibrated verdicts, stable operation)
- v0.6.1 = Memory normalization, size-aware pruning, rate limits replaced with statistical anomaly detection
- v0.6.2 = Analyzer upgraded to GPT-4.1, removed obsolete rate limit pre-checks from analyzer
- v0.6.3 = Post-schema and anomaly-detection unit tests, E2E proxy attack taxonomy tests
- v0.6.4 = Analyzer unit tests (computeDiff, computePatterns, structuralPreCheck, computeVerdict) and verdict scenario tests
- v0.6.5 = Behavioral drift and drift-exploitation tests (proxy + analyzer)
- v0.6.6 = Agent pure function unit tests (extractPostIds, filterNewPosts, buildMemoryPayload, normalizeSentiment, normalizeTopic)
- v0.6.7 = Testing documentation (docs/TESTING.md) with peer review
- v0.6.8 = SOUL.md clarification, deploy CI fix, documentation updates (deployed)
- v0.6.9/v0.6.10 = Comments write API (proxy + agent), comment handler tests
- v0.7.0 = Comment read-through (proxy fetches/sanitizes Moltbook comments), comment_made memory type, agent reads comments before deciding, SOUL commenting guidelines
- v0.7.1 = Remove hard-coded comment cap from SOUL (align with statistical anomaly detection), fix verify.sh timeout with proxy log fallback, run all 390 tests in CI (including e2e)
- v0.7.2 = Conversation participation tracking (reply detection, response_to field), email summary engagement breakdown (4 types), verify.sh reliability fixes (timeout + set -e), 406 tests

## Project Structure

- `proxy/` - Security proxy (TypeScript/Bun). Routes, validates, monitors all outbound traffic (statistical anomaly detection, observe-only).
- `openclaw/` - Agent (Node.js). Reads feed, analyzes with Claude, posts through proxy.
- `analyzer/` - Dual-model behavioral auditor (Claude + OpenAI). Runs between agent cycles.
- `infra/` - Azure Bicep templates for ACI deployment.
- `summary/` - Post-run email summaries (Claude summarization + ACS delivery).
- `scripts/` - Operational scripts (verify, kill-agent, check-soul-integrity).
- `.github/workflows/` - CI/CD (deploy, start-agent, kill-and-analyze).

## Workflow

- **Always commit and push** after making changes. Don't treat commit/push as a separate activity — if you changed files, commit and push before moving on.
- **Open a GitHub issue first** for every bug, improvement, or learning you discover — before fixing it. The issue is the record; the fix is the resolution. No silent fixes.
- **Tag after meaningful changes.** Patch (v0.X.Y) for bug fixes, minor (v0.X.0) for features or behavioral changes. Don't let multiple significant changes accumulate untagged.
- **Close issues** with the resolving commit reference when fixed.
- These are not optional habits — they are project conventions that apply to every session.

## Key Conventions

- Proxy holds MOLTBOOK_API_KEY for authenticated POST forwarding
- Agent holds MOLTBOOK_API_KEY for authenticated feed reads (CONNECT tunnel)
- Agent holds ANTHROPIC_API_KEY for Claude analysis
- All agent writes go through proxy endpoints (`/post`, `/vote`, `/memory`)
- Memory saves happen every cycle (not just on shutdown)
- GitHub Issues track all bugs/improvements; close via commit message `Closes #N`

## Issue Tracking

Use GitHub Issues as the living record of all bugs, improvements, and learnings:

- **Create an issue** whenever you discover a bug, identify an improvement, or learn something that should change
- **Label issues** appropriately: `bug`, `enhancement`, `cleanup`
- **Close issues** via commit message (`Closes #N`) when the fix is pushed, or with `gh issue close` + comment
- **Don't batch** — file issues as you find them, even mid-implementation. This creates an audit trail.
- Issues are the project's memory of what went wrong and what was learned. Err on the side of filing too many.

## Documentation

Update documentation after every successful milestone (new semver tag):

- **README.md** — Update architecture diagrams, feature lists, security model, and learnings when a minor version ships (e.g., v0.4.0)
- **CLAUDE.md** — Update version history, test counts, and any new conventions as they emerge
- **SOUL.md** — Update behavioral guidelines when agent capabilities change (new actions, new limits)
- Don't update docs for every patch — only when the project's public-facing description or operational model meaningfully changes

## Testing

```bash
cd proxy && bun test       # 255 tests across 12 files (allowlist, sanitizer, logger, memory-store, post-schema, anomaly-detection, indirect-injection, behavioral-drift, e2e-proxy, redos, comment, comment-reader)
cd analyzer && bun test    # 106 tests across 5 files (analyzer, verdict, drift-exploitation, consensus-manipulation, analyzer.test.mjs)
cd openclaw && bun test    # 45 tests across 1 file (agent pure functions + reply detection)
# Total: 406 tests — all run in CI
```

## Deployment

```bash
gh workflow run deploy.yml -f mvp_level=mvp2 -f resource_group=rg-openclaw-secure -f action=deploy
```
