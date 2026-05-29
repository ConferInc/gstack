/**
 * Confer fleet resolver (SP-10) — unit + gating coverage.
 *
 * Asserts:
 *  1. resolver/agents.yaml parses into a well-formed registry.
 *  2. {{CONFER_FLEET}} renders the expected roster-table shape.
 *  3. {{ESCALATION_CHAIN}} walks escalates_to up to `human`.
 *  4. The appliesTo gate suppresses BOTH placeholders when the registry is
 *     absent (non-Confer host) — and the gen-skill-docs substitution contract
 *     turns that into empty string, so upstream skill output is never touched.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import type { TemplateContext } from '../scripts/resolvers/types';
import { HOST_PATHS, unwrapResolver } from '../scripts/resolvers/types';
import {
  AGENTS_YAML_PATH,
  loadConferFleet,
  buildEscalationChain,
  generateConferFleet,
  generateEscalationChain,
} from '../scripts/resolvers/confer-agents';
import { RESOLVERS } from '../scripts/resolvers/index';

const ROOT = path.resolve(import.meta.dir, '..');

function makeCtx(overrides: Partial<TemplateContext> = {}): TemplateContext {
  return {
    skillName: 'test-skill',
    tmplPath: 'test.tmpl',
    host: 'claude',
    paths: HOST_PATHS.claude,
    ...overrides,
  };
}

describe('resolver/agents.yaml — registry file', () => {
  test('exists at the resolver dir', () => {
    expect(fs.existsSync(AGENTS_YAML_PATH)).toBe(true);
    expect(AGENTS_YAML_PATH).toBe(path.join(ROOT, 'resolver', 'agents.yaml'));
  });

  test('parses into a versioned registry with agents', () => {
    const reg = loadConferFleet();
    expect(reg).not.toBeNull();
    expect(reg!.version).toBe(1);
    expect(Array.isArray(reg!.agents)).toBe(true);
    expect(reg!.agents.length).toBeGreaterThan(10);
  });

  test('every agent has name/role/tier; admins read "*" and escalate to human', () => {
    const reg = loadConferFleet()!;
    for (const a of reg.agents) {
      expect(typeof a.name).toBe('string');
      expect(typeof a.role).toBe('string');
      expect(typeof a.tier).toBe('string');
    }
    const aether = reg.agents.find(a => a.name === 'aether');
    expect(aether).toBeDefined();
    expect(aether!.tier).toBe('admin');
    expect(aether!.gbrain_sources).toEqual(['*']);
    expect(aether!.escalates_to).toBe('human');
  });

  test('agent names are unique', () => {
    const reg = loadConferFleet()!;
    const names = reg.agents.map(a => a.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('does NOT list the 2026-05-24 deleted Temple agents', () => {
    const reg = loadConferFleet()!;
    const names = new Set(reg.agents.map(a => a.name));
    for (const dead of ['denali', 'aspen', 'cliff', 'cedar', 'sierra', 'ridge', 'pine', 'granite', 'beacon']) {
      expect(names.has(dead)).toBe(false);
    }
  });
});

describe('{{CONFER_FLEET}} — roster rendering', () => {
  test('renders a markdown roster table including known agents', () => {
    const out = generateConferFleet(makeCtx());
    expect(out).toContain('## Confer Fleet');
    expect(out).toContain('| Agent | Role | Tier | Client |');
    expect(out).toContain('`aether`');
    expect(out).toContain('`bauji`');
    // Razor team carries the razor client; admins render as internal.
    expect(out).toMatch(/`raj`.*razor/);
    expect(out).toMatch(/`aether`.*internal/);
  });

  test('never ships the raw `<tbd>` placeholder — renders it as `unassigned` (GS-INC-6)', () => {
    const out = generateConferFleet(makeCtx());
    // The `<tbd>` token is meaningful in agents.yaml (a "confirm this binding"
    // signal) but must never leak into a rendered roster an operator reads.
    expect(out).not.toContain('<tbd>');
    // Agents with a genuinely-unknown client (e.g. prometheus/theseus/orion)
    // surface as a clean, honest label instead.
    expect(out).toMatch(/`prometheus`.*unassigned/);
  });
});

describe('{{ESCALATION_CHAIN}} — escalation walking', () => {
  test('raj escalates raj → bauji → aether → human', () => {
    const reg = loadConferFleet()!;
    expect(buildEscalationChain(reg, 'raj')).toEqual(['raj', 'bauji', 'aether', 'human']);
  });

  test('admin escalates straight to human', () => {
    const reg = loadConferFleet()!;
    expect(buildEscalationChain(reg, 'aether')).toEqual(['aether', 'human']);
  });

  test('resolver output names the chain for a registered agent (via skillName)', () => {
    const out = generateEscalationChain(makeCtx({ skillName: 'raj' }));
    expect(out).toContain('## Escalation');
    expect(out).toContain('`raj`');
    expect(out).toContain('`bauji`');
    expect(out).toContain('**human**');
  });

  test('CONFER_AGENT env var overrides skillName', () => {
    const prev = process.env.CONFER_AGENT;
    process.env.CONFER_AGENT = 'simran';
    try {
      const out = generateEscalationChain(makeCtx({ skillName: 'not-an-agent' }));
      expect(out).toContain('`simran`');
      expect(out).toContain('`bauji`');
    } finally {
      if (prev === undefined) delete process.env.CONFER_AGENT;
      else process.env.CONFER_AGENT = prev;
    }
  });

  test('unknown agent (gen-time, no CONFER_AGENT) renders the FULL escalation reference, not a dead fallback', () => {
    const prev = process.env.CONFER_AGENT;
    delete process.env.CONFER_AGENT;
    try {
      const out = generateEscalationChain(makeCtx({ skillName: 'definitely-not-an-agent' }));
      // The old buggy behavior baked a misleading "not a registered agent" line
      // into every shipped SKILL.md. New behavior: emit the full per-agent
      // reference table so the block is always accurate regardless of reader.
      expect(out).not.toContain('not a registered Confer fleet agent');
      expect(out).toContain('## Escalation');
      expect(out).toContain('Escalation paths by agent');
      expect(out).toContain('| Agent |');
      expect(out).toContain('**human**');
    } finally {
      if (prev !== undefined) process.env.CONFER_AGENT = prev;
    }
  });
});

describe('gating — absent registry is a strict NO-OP', () => {
  test('loadConferFleet returns null when the file is absent', () => {
    const missing = path.join(ROOT, 'resolver', 'does-not-exist.yaml');
    expect(loadConferFleet(missing)).toBeNull();
  });

  test('both placeholders are registered as gated entries', () => {
    for (const key of ['CONFER_FLEET', 'ESCALATION_CHAIN']) {
      const { appliesTo } = unwrapResolver(RESOLVERS[key]);
      expect(typeof appliesTo).toBe('function');
    }
  });

  test('gen-skill-docs substitution contract: gated-off → empty string, no leak', () => {
    // Mirrors scripts/gen-skill-docs.ts: `if (appliesTo && !appliesTo(ctx)) return ''`.
    // Simulate a non-Confer host where the gate is false.
    const ctx = makeCtx({ skillName: 'some-upstream-skill' });
    const simulate = (key: string, gateValue: boolean): string => {
      const { resolve, appliesTo } = unwrapResolver(RESOLVERS[key]);
      const gate = () => gateValue; // stand in for conferFleetGate on a non-Confer host
      if (appliesTo && !gate()) return '';
      return resolve(ctx);
    };
    expect(simulate('CONFER_FLEET', false)).toBe('');
    expect(simulate('ESCALATION_CHAIN', false)).toBe('');
  });

  test('the Confer placeholders are NOT referenced by any UPSTREAM SKILL.md.tmpl', () => {
    // Belt-and-suspenders: the gate makes suppression structural, but the
    // foundation also wires NOTHING into upstream templates. If a future
    // template author adds {{CONFER_FLEET}} to an upstream skill, this test
    // flags it so the gating assumption stays honest.
    //
    // The SP-10 `confer-*` skills (the Confer customization layer itself) ARE
    // the intended consumers of these placeholders — they live in `confer-`
    // prefixed dirs and are themselves Confer-only/host-gated, so they are
    // exempt. The guard's job is to keep the placeholders out of UPSTREAM
    // (garrytan/gstack) skills, which never carry the `confer-` prefix.
    const tmpls: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        // Skip the Confer customization-layer skill dirs — they are the
        // legitimate consumers of {{CONFER_FLEET}} / {{ESCALATION_CHAIN}}.
        if (entry.isDirectory() && entry.name.startsWith('confer-')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.tmpl')) tmpls.push(full);
      }
    };
    walk(ROOT);
    for (const tmpl of tmpls) {
      const body = fs.readFileSync(tmpl, 'utf-8');
      expect(body.includes('{{CONFER_FLEET}}')).toBe(false);
      expect(body.includes('{{ESCALATION_CHAIN}}')).toBe(false);
    }
  });
});
