#!/usr/bin/env tsx
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { PROJECT_ROOT } from '../src/config.js';
import { runAgent, killActiveProcesses } from '../src/ai/claude.js';
import { classifyIntent } from '../src/bot/resolver.js';
import { getSkillRegistry } from '../src/bot/skill-registry.js';

export type AssertionType =
  | 'substring'
  | 'citation_present'
  | 'max_length_chars'
  | 'json_shape'
  | 'regex';

export interface Assertion {
  type: AssertionType;
  value?: string | number;
  target?: string;
  required_keys?: string[];
  pattern?: string;
  flags?: string;
}

export interface Fixture {
  name: string;
  input: string;
  timeout_ms?: number;
  assertions: Assertion[];
}

export interface EvalFile {
  agent: string;
  fixtures: Fixture[];
}

export interface AssertionResult {
  type: string;
  passed: boolean;
  detail?: string;
}

export function runAssertion(assertion: Assertion, output: string): AssertionResult {
  switch (assertion.type) {
    case 'substring': {
      const value = String(assertion.value ?? '');
      const passed = output.includes(value);
      return {
        type: 'substring',
        passed,
        detail: passed ? undefined : `missing substring: ${JSON.stringify(value)}`,
      };
    }
    case 'citation_present': {
      const target = String(assertion.target ?? '');
      const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`\\[\\[${escaped}(?:\\|[^\\]]+)?\\]\\]`);
      const passed = re.test(output);
      return {
        type: 'citation_present',
        passed,
        detail: passed ? undefined : `missing citation: [[${target}]]`,
      };
    }
    case 'max_length_chars': {
      const limit = Number(assertion.value);
      const passed = output.length <= limit;
      return {
        type: 'max_length_chars',
        passed,
        detail: passed ? undefined : `output ${output.length} chars exceeds max ${limit}`,
      };
    }
    case 'json_shape': {
      const required = assertion.required_keys ?? [];
      let parsed: unknown;
      try {
        parsed = JSON.parse(output);
      } catch (err) {
        return {
          type: 'json_shape',
          passed: false,
          detail: `output is not valid JSON: ${(err as Error).message}`,
        };
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return {
          type: 'json_shape',
          passed: false,
          detail: 'output is not a JSON object',
        };
      }
      const missing = required.filter((k) => !(k in (parsed as Record<string, unknown>)));
      return {
        type: 'json_shape',
        passed: missing.length === 0,
        detail: missing.length === 0 ? undefined : `missing keys: ${missing.join(', ')}`,
      };
    }
    case 'regex': {
      const pattern = String(assertion.pattern ?? '');
      const flags = assertion.flags ?? '';
      let re: RegExp;
      try {
        re = new RegExp(pattern, flags);
      } catch (err) {
        return {
          type: 'regex',
          passed: false,
          detail: `invalid regex: ${(err as Error).message}`,
        };
      }
      const passed = re.test(output);
      return {
        type: 'regex',
        passed,
        detail: passed ? undefined : `regex did not match: /${pattern}/${flags}`,
      };
    }
    default:
      return {
        type: String((assertion as { type?: unknown }).type ?? 'unknown'),
        passed: false,
        detail: `unknown assertion type`,
      };
  }
}

export function validateEvalFile(
  data: unknown,
): { ok: true; file: EvalFile } | { ok: false; error: string } {
  if (typeof data !== 'object' || data === null) {
    return { ok: false, error: 'root must be a mapping' };
  }
  const obj = data as Record<string, unknown>;
  if (typeof obj['agent'] !== 'string' || obj['agent'].length === 0) {
    return { ok: false, error: '`agent` must be a non-empty string' };
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(obj['agent'])) {
    return {
      ok: false,
      error: '`agent` must be lowercase-kebab-case (matches /^[a-z0-9][a-z0-9-]*$/) — prevents path traversal into `.claude/agents/`',
    };
  }
  if (!Array.isArray(obj['fixtures'])) {
    return { ok: false, error: '`fixtures` must be a list' };
  }
  for (let i = 0; i < obj['fixtures'].length; i++) {
    const fx = obj['fixtures'][i] as Record<string, unknown> | null | undefined;
    if (!fx || typeof fx !== 'object') {
      return { ok: false, error: `fixtures[${i}] must be a mapping` };
    }
    if (typeof fx['name'] !== 'string' || fx['name'].length === 0) {
      return { ok: false, error: `fixtures[${i}].name must be a non-empty string` };
    }
    if (typeof fx['input'] !== 'string' || fx['input'].length === 0) {
      return { ok: false, error: `fixtures[${i}].input must be a non-empty string` };
    }
    if (!Array.isArray(fx['assertions']) || fx['assertions'].length === 0) {
      return {
        ok: false,
        error: `fixtures[${i}].assertions must be a non-empty list`,
      };
    }
  }
  return { ok: true, file: obj as unknown as EvalFile };
}

export interface FixtureReport {
  fixture: string;
  passed: boolean;
  elapsedMs: number;
  assertions: AssertionResult[];
  agentError?: string;
}

interface AgentReport {
  agent: string;
  file: string;
  fixtures: FixtureReport[];
}

interface FileSkip {
  file: string;
  reason: string;
}

interface RunReport {
  agents: AgentReport[];
  skipped: FileSkip[];
}

export async function runFixture(
  agent: string,
  fixture: Fixture,
): Promise<FixtureReport> {
  // The resolver is a module, not an agent file — it cannot be invoked via
  // runAgent. Special-case the name: call the real classifyIntent pipeline
  // with the live skill registry and serialize the routing-ready fields as
  // JSON. `raw` is dropped so the eval output is stable across runs.
  if (agent === 'resolver') {
    const rStart = Date.now();
    try {
      const result = await classifyIntent(fixture.input, getSkillRegistry());
      const output = JSON.stringify({
        skill: result.skill,
        args: result.args,
        confidence: result.confidence,
        second_skill: result.second_skill,
        second_confidence: result.second_confidence,
        ambiguous: result.ambiguous,
      });
      const results = fixture.assertions.map((a) => runAssertion(a, output));
      return {
        fixture: fixture.name,
        passed: results.every((r) => r.passed),
        elapsedMs: Date.now() - rStart,
        assertions: results,
      };
    } catch (err) {
      return {
        fixture: fixture.name,
        passed: false,
        elapsedMs: Date.now() - rStart,
        assertions: [],
        agentError: (err as Error).message,
      };
    }
  }
  const start = Date.now();
  const result = await runAgent(agent, fixture.input, fixture.timeout_ms);
  const elapsedMs = Date.now() - start;
  if (result.error !== null || result.text === null) {
    return {
      fixture: fixture.name,
      passed: false,
      elapsedMs,
      assertions: [],
      agentError: result.error ?? 'agent returned no output',
    };
  }
  const output = result.text;
  const results = fixture.assertions.map((a) => runAssertion(a, output));
  return {
    fixture: fixture.name,
    passed: results.every((r) => r.passed),
    elapsedMs,
    assertions: results,
  };
}

async function runEvalFile(
  file: string,
  parsed: EvalFile,
): Promise<AgentReport> {
  const fixtures: FixtureReport[] = [];
  for (const fx of parsed.fixtures) {
    process.stdout.write(`  • ${fx.name} ... `);
    const report = await runFixture(parsed.agent, fx);
    if (report.agentError) {
      console.log(`FAIL (${(report.elapsedMs / 1000).toFixed(1)}s) — agent error: ${report.agentError}`);
    } else if (report.passed) {
      console.log(`PASS (${(report.elapsedMs / 1000).toFixed(1)}s, ${report.assertions.length} assertions)`);
    } else {
      console.log(`FAIL (${(report.elapsedMs / 1000).toFixed(1)}s)`);
      for (const r of report.assertions.filter((a) => !a.passed)) {
        console.log(`      ✗ ${r.type}: ${r.detail ?? 'failed'}`);
      }
    }
    fixtures.push(report);
  }
  return { agent: parsed.agent, file, fixtures };
}

export interface CliArgs {
  agentFilter: string | null;
  dryRun: boolean;
  help: boolean;
  unknown: string[];
}

export function parseCliArgs(argv: string[]): CliArgs {
  const result: CliArgs = { agentFilter: null, dryRun: false, help: false, unknown: [] };
  for (const arg of argv) {
    if (arg === '--dry-run') {
      result.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else if (arg.startsWith('-')) {
      // Any other -flag / --flag is unknown
      result.unknown.push(arg);
    } else if (result.agentFilter === null) {
      result.agentFilter = arg;
    } else {
      result.unknown.push(arg);
    }
  }
  return result;
}

const USAGE = `Usage: npm run evals [-- [<agent-name>] [--dry-run]]

Options:
  <agent-name>    Run only evals for that agent (matches filename stem).
  --dry-run       Validate YAML + count planned calls; no agent invocations.
  --help, -h      Show this help.`;

function printUsage(stream: NodeJS.WriteStream = process.stdout): void {
  stream.write(`${USAGE}\n`);
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    process.exit(0);
  }
  if (args.unknown.length > 0) {
    console.error(`Unknown argument(s): ${args.unknown.join(', ')}`);
    printUsage(process.stderr);
    process.exit(2);
  }

  const evalsDir = join(PROJECT_ROOT, 'evals');
  let entries: string[];
  try {
    entries = readdirSync(evalsDir).filter((f) => extname(f) === '.yaml').sort();
  } catch (err) {
    console.error(`Cannot read evals directory ${evalsDir}: ${(err as Error).message}`);
    process.exit(1);
  }

  if (args.agentFilter !== null) {
    const expected = `${args.agentFilter}.yaml`;
    entries = entries.filter((f) => f === expected);
    if (entries.length === 0) {
      console.error(`No eval file found for agent "${args.agentFilter}" (expected ${expected}).`);
      process.exit(1);
    }
  }

  const report: RunReport = { agents: [], skipped: [] };
  let dryRunFixtureCount = 0;

  for (const f of entries) {
    const path = join(evalsDir, f);
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (err) {
      report.skipped.push({ file: f, reason: `read error: ${(err as Error).message}` });
      continue;
    }
    let data: unknown;
    try {
      data = parseYaml(raw);
    } catch (err) {
      report.skipped.push({ file: f, reason: `YAML parse error: ${(err as Error).message}` });
      continue;
    }
    const validated = validateEvalFile(data);
    if (!validated.ok) {
      report.skipped.push({ file: f, reason: validated.error });
      continue;
    }
    const stem = f.slice(0, -'.yaml'.length);
    if (stem !== validated.file.agent) {
      report.skipped.push({
        file: f,
        reason: `filename stem "${stem}" does not match \`agent\` field "${validated.file.agent}"`,
      });
      continue;
    }

    if (args.dryRun) {
      console.log(`[dry-run] ${f}: ${validated.file.agent} — ${validated.file.fixtures.length} fixtures`);
      dryRunFixtureCount += validated.file.fixtures.length;
      continue;
    }

    console.log(`\n## ${validated.file.agent}  (${validated.file.fixtures.length} fixtures)`);
    report.agents.push(await runEvalFile(f, validated.file));
  }

  console.log('');
  console.log('─'.repeat(60));

  if (args.dryRun) {
    console.log(`[dry-run] ${entries.length - report.skipped.length} files would run, ${dryRunFixtureCount} fixtures (${report.skipped.length} skipped)`);
    if (report.skipped.length > 0) {
      console.log(`\nSkipped files (${report.skipped.length}):`);
      for (const s of report.skipped) {
        console.log(`  ${s.file}: ${s.reason}`);
      }
    }
    process.exit(report.skipped.length > 0 ? 1 : 0);
  }

  const totalFixtures = report.agents.reduce((n, a) => n + a.fixtures.length, 0);
  const passedFixtures = report.agents.reduce(
    (n, a) => n + a.fixtures.filter((f) => f.passed).length,
    0,
  );

  console.log(`${passedFixtures}/${totalFixtures} fixtures passed across ${report.agents.length} agents`);
  if (report.skipped.length > 0) {
    console.log(`\nSkipped files (${report.skipped.length}):`);
    for (const s of report.skipped) {
      console.log(`  ${s.file}: ${s.reason}`);
    }
  }

  const anyFail =
    passedFixtures !== totalFixtures || report.skipped.length > 0;
  process.exit(anyFail ? 1 : 0);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  // Ctrl-C should reap any in-flight Claude CLI child — otherwise a resolver
  // fixture's 20-second Haiku call can be orphaned briefly. Mirrors the
  // shutdown pattern in src/index.ts.
  process.on('SIGINT', () => {
    killActiveProcesses();
    process.exit(130);
  });
  main().catch((err) => {
    console.error('Runner crashed:', err);
    process.exit(1);
  });
}
