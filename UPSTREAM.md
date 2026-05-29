# Upstream Pinning Policy — confer/gstack

**Upstream:** https://github.com/garrytan/gstack
**Pinned SHA:** 070722ac (merged via 777f3efa on 2026-05-29; supersedes 19770ea8)
**Pinned at:** 2026-05-29

## Rebase cadence

Quarterly. Aether (fork maintainer) runs:

```bash
git fetch upstream
git rebase upstream/main
bun test  # Tier 1 must pass
EVALS=1 bun run test:e2e  # Tier 2 must pass (~$3.85 budget)
git push --force-with-lease origin confer/main
```

## Maintainer chain
Identical to confer/gbrain: Aether → Vulcan → Yatin.

## Confer-local additions (DO NOT remove on rebase)

- `confer-packs/confer-everything-v1/` — schema pack
- `resolver/agents.yaml` — resolver source of truth (created in SP-10)
- Any skill directory prefixed `confer-` (created in SP-10+)

## Bun version

Tracked in `.bun-version` at repo root. Floor is `>=1.2.17` (the confer-agents resolver needs `Bun.YAML`, added in 1.2.17). Upstream engines.bun is lower. Aether bumps when upstream raises the floor.
