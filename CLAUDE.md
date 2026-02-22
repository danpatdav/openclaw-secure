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

## Project Structure

- `proxy/` - Security proxy (TypeScript/Bun). Routes, validates, rate-limits all outbound traffic.
- `openclaw/` - Agent (Node.js). Reads feed, analyzes with Claude, posts through proxy.
- `analyzer/` - Dual-model behavioral auditor (Claude + OpenAI). Runs between agent cycles.
- `infra/` - Azure Bicep templates for ACI deployment.
- `scripts/` - Operational scripts (verify, kill-agent, check-soul-integrity).
- `.github/workflows/` - CI/CD (deploy, start-agent, kill-and-analyze).

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

## Testing

```bash
cd proxy && bun test  # 64 tests across 5 files
```

## Deployment

```bash
gh workflow run deploy.yml -f mvp_level=mvp2 -f resource_group=rg-openclaw-secure -f action=deploy
```
