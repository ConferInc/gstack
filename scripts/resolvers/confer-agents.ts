/**
 * Confer fleet resolver (SP-10) — injects fleet awareness into Confer skills.
 *
 * Loads the declarative roster at `resolver/agents.yaml` (the SP-10
 * source-of-truth) and exposes two placeholders:
 *
 *   {{CONFER_FLEET}}      — a compact rendered roster (name → role/tier/client)
 *                           for fleet-aware skills.
 *   {{ESCALATION_CHAIN}}  — for the current agent (ctx.skillName, or the
 *                           CONFER_AGENT env var), the escalates_to path up to
 *                           a human.
 *
 * GATING — this resolver is a strict NO-OP unless `resolver/agents.yaml` is
 * present. That file is Confer-only and never exists in an upstream
 * garrytan/gstack checkout, so on any non-Confer host (or upstream fork) the
 * `appliesTo` gate returns false and gen-skill-docs substitutes empty string.
 * This mirrors gbrain.ts's host-gated suppression: the resolver only injects
 * where the Confer registry is wired, and it CANNOT alter any upstream skill's
 * generated output. (Belt-and-suspenders: no upstream SKILL.md.tmpl references
 * these placeholders, so even ungated they would never fire upstream — the
 * gate makes the guarantee structural.)
 *
 * Parsing — uses Bun.YAML.parse when available (Bun >= 1.2.17). If the runtime
 * predates it (the repo's declared floor is Bun >= 1.0.0), the loader returns
 * null and the resolver degrades to a no-op rather than throwing. We never want
 * a YAML/runtime hiccup to break the build for everyone.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { TemplateContext } from './types';

/** Absolute path to the Confer fleet registry. */
export const AGENTS_YAML_PATH = path.resolve(import.meta.dir, '../../resolver/agents.yaml');

export interface ConferAgent {
  name: string;
  role: string;
  tier: string;
  host?: string;
  client?: string | null;
  gbrain_sources?: string[];
  escalates_to?: string;
}

export interface ConferFleetRegistry {
  version: number;
  defaults?: { gbrain_url?: string; escalates_to?: string };
  agents: ConferAgent[];
}

/**
 * Minimal structural guard for `Bun.YAML`. Declared via a narrow interface so
 * this module type-checks even on a Bun whose @types lack the YAML namespace.
 */
function getBunYamlParse(): ((src: string) => unknown) | null {
  const b = (globalThis as { Bun?: { YAML?: { parse?: (src: string) => unknown } } }).Bun;
  return typeof b?.YAML?.parse === 'function' ? b.YAML.parse : null;
}

/**
 * Load + validate the registry. Returns null when the file is absent (the gate
 * condition) OR when YAML cannot be parsed on this runtime (graceful no-op).
 * Throws only on a file that exists but is structurally malformed — a real
 * Confer-side authoring error we want surfaced loudly.
 */
export function loadConferFleet(yamlPath: string = AGENTS_YAML_PATH): ConferFleetRegistry | null {
  if (!fs.existsSync(yamlPath)) return null;

  const parseYaml = getBunYamlParse();
  if (!parseYaml) {
    // Runtime predates Bun.YAML (<1.2.17). The file EXISTS but we can't parse it,
    // so the fleet/escalation blocks would silently render empty. Warn loudly
    // instead of a bare null so an operator regenerating docs on an old Bun sees
    // why the roster vanished. (.bun-version floor is 1.2.17; this guards drift.)
    console.error(
      `[confer-agents] WARNING: ${yamlPath} exists but Bun.YAML is unavailable ` +
      `(need Bun >= 1.2.17, have ${typeof Bun !== 'undefined' ? Bun.version : 'non-Bun runtime'}). ` +
      `Fleet/escalation blocks will render EMPTY. Upgrade Bun and re-run gen:skill-docs.`,
    );
    return null;
  }

  const raw = fs.readFileSync(yamlPath, 'utf-8');
  const parsed = parseYaml(raw) as Partial<ConferFleetRegistry> | null;

  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.agents)) {
    throw new Error(`resolver/agents.yaml is malformed: expected a top-level 'agents:' list (got ${typeof parsed}).`);
  }
  for (const a of parsed.agents) {
    if (!a || typeof a.name !== 'string' || typeof a.role !== 'string' || typeof a.tier !== 'string') {
      throw new Error(`resolver/agents.yaml: every agent needs string 'name', 'role', and 'tier' (offending entry: ${JSON.stringify(a)}).`);
    }
  }
  return {
    version: typeof parsed.version === 'number' ? parsed.version : 1,
    defaults: parsed.defaults ?? {},
    agents: parsed.agents,
  };
}

/** Gate: only fires when the Confer registry is present + parseable. */
function conferFleetPresent(): boolean {
  return loadConferFleet() !== null;
}

/** Format one agent's client field for display. */
function clientLabel(client: ConferAgent['client']): string {
  if (client === null || client === undefined) return 'internal';
  // A genuinely-unknown client binding is recorded in agents.yaml as the
  // placeholder `<tbd>` (with a `# TODO: confirm` note) rather than guessed.
  // That token is meaningful internal signal, but must NEVER ship verbatim into
  // a rendered roster an operator reads — surface it as a clean, honest label.
  // Future-proofs any new `<tbd>`/blank entry against the GS-INC-6 leak.
  const trimmed = client.trim();
  if (trimmed === '' || trimmed === '<tbd>') return 'unassigned';
  return client;
}

/**
 * {{CONFER_FLEET}} — compact roster table grouped for at-a-glance scanning.
 * Returns empty string when the registry is absent (the gate already prevents
 * this path in gen-skill-docs, but we stay defensive for direct callers/tests).
 */
export function generateConferFleet(_ctx: TemplateContext): string {
  const registry = loadConferFleet();
  if (!registry) return '';

  const rows = registry.agents
    .map(a => `| \`${a.name}\` | ${a.role} | ${a.tier} | ${clientLabel(a.client)} |`)
    .join('\n');

  return `## Confer Fleet

The Confer OpenClaw fleet (source: \`resolver/agents.yaml\`, SP-10). Address only
your direct subordinates; escalate blockers up your chain (see escalation path).

| Agent | Role | Tier | Client |
|-------|------|------|--------|
${rows}`;
}

/**
 * Walk escalates_to from a starting agent up to `human`. Defensive against
 * cycles and dangling references; falls back to the registry default and
 * finally to `human`.
 */
export function buildEscalationChain(registry: ConferFleetRegistry, startName: string): string[] {
  const byName = new Map(registry.agents.map(a => [a.name, a]));
  const fallback = registry.defaults?.escalates_to ?? 'human';
  const chain: string[] = [startName];
  const seen = new Set<string>([startName]);

  let current = byName.get(startName);
  // If the start name isn't a known agent, we have nothing to walk.
  if (!current) return chain;

  while (current) {
    const next = current.escalates_to ?? fallback;
    if (next === 'human') {
      chain.push('human');
      break;
    }
    if (seen.has(next)) {
      // Cycle or self-reference — terminate at human to keep the chain finite.
      chain.push('human');
      break;
    }
    chain.push(next);
    seen.add(next);
    const nextAgent = byName.get(next);
    if (!nextAgent) {
      // Dangling escalates_to (e.g. points at a non-registry name) — top out at human.
      chain.push('human');
      break;
    }
    current = nextAgent;
  }
  return chain;
}

/**
 * {{ESCALATION_CHAIN}} — escalation path for the current agent. The agent is
 * taken from the CONFER_AGENT env var when set, else from ctx.skillName. If the
 * agent isn't in the registry, emits a generic "escalate to human" line so the
 * skill still has guidance.
 */
export function generateEscalationChain(ctx: TemplateContext): string {
  const registry = loadConferFleet();
  if (!registry) return '';

  const agentName = process.env.CONFER_AGENT?.trim() || ctx.skillName;
  const known = registry.agents.some(a => a.name === agentName);

  // Specific-agent path: only when CONFER_AGENT (or a skillName that is an
  // actual fleet agent) resolves to a registered agent — i.e. the skill is
  // running AS that agent. Renders that one agent's chain.
  if (known) {
    const chain = buildEscalationChain(registry, agentName);
    const rendered = chain.map(n => (n === 'human' ? '**human**' : `\`${n}\``)).join(' → ');
    return `## Escalation

When you hit a blocker you cannot resolve autonomously, escalate up this chain:

${rendered}

Address only your direct manager (the next hop); do not skip levels.`;
  }

  // Gen-time / unknown-agent path: CONFER_AGENT is not set (this is what
  // happens when gen-skill-docs renders the static SKILL.md — ctx.skillName is
  // the SKILL name, not a fleet agent). DON'T bake a misleading "you are not
  // registered → human" line. Instead emit the FULL escalation reference for
  // every agent, so whoever runs the skill (operator, or an agent acting on
  // behalf of another) can find the right chain. Deterministic + always
  // accurate; auto-scopes to a single chain when CONFER_AGENT is set at runtime.
  const rows = registry.agents
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(a => {
      const chain = buildEscalationChain(registry, a.name);
      const rendered = chain.map(n => (n === 'human' ? '**human**' : `\`${n}\``)).join(' → ');
      return `| \`${a.name}\` | ${rendered} |`;
    });

  return `## Escalation

Escalation paths by agent. Find the agent you are acting as and escalate to its
next hop — do not skip levels. (Set \`CONFER_AGENT=<your-name>\` to auto-scope
this block to just your own chain.)

| Agent | Escalation path (→ up to human) |
|-------|----------------------------------|
${rows.join('\n')}`;
}
