# Upstream Pinning Policy — confer/gstack

**Upstream:** https://github.com/garrytan/gstack
**Pinned SHA:** 19770ea8b41da3e79c510a2c80d1aad3f34d4075
**Pinned at:** 2026-05-27

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

Tracked in `.bun-version` at repo root. Floor matches upstream `engines.bun` (currently `>=1.0.0`). Aether bumps when upstream raises the floor.
