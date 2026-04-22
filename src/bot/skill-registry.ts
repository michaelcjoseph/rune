import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import config, { PROJECT_ROOT } from '../config.js';
import { clearAgentDefCache, loadAgentDef, type AgentDef } from '../ai/claude.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('skill-registry');

/** What kind of skill an entry represents.
 *  - 'agent'  — a markdown agent in .claude/agents/ invoked via runAgent()
 *  - 'slash'  — a hardcoded slash command handler in src/bot/handlers/text.ts
 *  - 'intent' — a synthetic semantic destination (e.g. kb_query) that maps to
 *               a code path rather than a single runAgent/handler call */
export type SkillKind = 'agent' | 'slash' | 'intent';

/** Few-shot example used to anchor the resolver's classification. */
export interface SkillExample {
  message: string;
  /** Kept separate from expected_skill for the kb_query matrix — the carried-
   *  forward Project 02 matrix labels examples KB-shaped vs not, not all of
   *  which route to kb_query (some fall through to journal, freeform, etc). */
  kb_shaped?: boolean;
  /** Skill name this example should classify to; omit for negative fixtures. */
  expected_skill?: string;
}

export interface SkillEntry {
  /** Stable identifier used by the resolver + intent log. Matches agent name
   *  for 'agent' kind, slash command name (sans `/`) for 'slash', or a free
   *  identifier like 'kb_query' for 'intent'. */
  name: string;
  kind: SkillKind;
  /** One-line description shown to the classifier. */
  description: string;
  /** Natural-language trigger phrases the classifier can match against. */
  triggers?: string[];
  /** Few-shot examples (used for kb_query; optional otherwise). */
  examples?: SkillExample[];
}

/** Curated metadata for slash-command skills the resolver may route to.
 *
 *  This is a hand-maintained table — the slash-command branches in
 *  src/bot/handlers/text.ts are hardcoded imports, not frontmatter-driven,
 *  so there is no natural source to scrape. The resolver needs curated
 *  phrasing anyway (the handler's implementation doesn't describe itself
 *  well enough for a classifier prompt). Keep in sync with handlers/text.ts
 *  when adding/removing slash commands. */
export const SLASH_COMMAND_METADATA: readonly { name: string; description: string; triggers: string[] }[] = [
  {
    name: 'journal',
    description: 'Append an entry to today\'s journal.',
    triggers: ['add to my journal', 'log in journal', 'jot this down', 'note this'],
  },
  {
    name: 'ask',
    description: 'One-shot freeform vault query.',
    triggers: ['ask the vault', 'quick question'],
  },
  {
    name: 'kb',
    description: 'Query the knowledge base for a synthesized answer with citations.',
    triggers: ['search kb', 'look it up in my notes'],
  },
  {
    name: 'ingest',
    description: 'Ingest a vault file into the knowledge base.',
    triggers: ['ingest this file', 'add to kb'],
  },
  {
    name: 'priorities',
    description: 'Review yesterday\'s priorities.',
    triggers: ['what were my priorities', 'what was i focused on'],
  },
  {
    name: 'workout',
    description: 'Today\'s workout prescription.',
    triggers: ['what\'s my workout', 'lift today'],
  },
  {
    name: 'study',
    description: 'Current study progress and assignments.',
    triggers: ['study progress', 'what am i studying'],
  },
  {
    name: 'family',
    description: '14-day scan of family mentions across journals.',
    triggers: ['what did i note about family', 'recent family mentions'],
  },
  {
    name: 'career',
    description: 'Active job applications.',
    triggers: ['what jobs am i tracking', 'applications status'],
  },
  {
    name: 'prep',
    description: 'Run morning prep now.',
    triggers: ['morning prep', 'start the day'],
  },
  {
    name: 'daily',
    description: 'Daily review — process journal tags into JSON updates.',
    triggers: ['daily review', 'run daily'],
  },
  {
    name: 'weekly',
    description: 'End-of-week review interview.',
    triggers: ['weekly review', 'do the weekly'],
  },
  {
    name: 'monthly',
    description: 'Monthly review interview.',
    triggers: ['monthly review', 'do the monthly'],
  },
  {
    name: 'quarterly',
    description: 'Quarterly review interview.',
    triggers: ['quarterly review', 'do the quarterly'],
  },
  {
    name: 'yearly',
    description: 'Yearly review (7 Questions).',
    triggers: ['yearly review', 'annual review'],
  },
  {
    name: 'think',
    description: 'Open-ended thinking partner session.',
    triggers: ['think through', 'help me reason about'],
  },
  {
    name: 'health',
    description: 'Health coaching session.',
    triggers: ['health check-in', 'coach me on health'],
  },
  {
    name: 'blog',
    description: 'Blog writing session.',
    triggers: ['draft a blog post', 'write an essay'],
  },
  {
    name: 'lenny',
    description: 'Search Lenny\'s Podcast transcripts.',
    triggers: ['what did lenny say', 'lenny episode about'],
  },
  {
    name: 'pg',
    description: 'Search Paul Graham essays.',
    triggers: ['what does pg say', 'paul graham on'],
  },
  {
    name: 'learn',
    description: 'Append a runtime learning that future agents auto-prepend.',
    triggers: ['remember that i prefer', 'note this preference'],
  },
  {
    name: 'learn-list',
    description: 'Show the runtime learnings currently prepended to agents.',
    triggers: ['show my learnings', 'what have you learned', 'list my preferences'],
  },
  {
    name: 'fresh',
    description: 'Save the conversation to the journal and reset the session.',
    triggers: ['start fresh', 'reset the session', 'clear the context'],
  },
] as const;

/** Carried-forward `kb_query` intent from Project 02 Phase 4. The matrix below
 *  is reproduced verbatim from docs/projects/03-resolver/spec.md lines 274–283
 *  as few-shot examples. In the resolver, kb_query is one routed skill among
 *  many — the binary "is this KB-shaped" classifier expands to N-way. */
export const KB_QUERY_ENTRY: SkillEntry = {
  name: 'kb_query',
  kind: 'intent',
  description:
    'Answer from the personal knowledge base — notes, beliefs, projects, reading, and conversations.',
  triggers: [
    'what did i think about',
    'what do i know about',
    'what did we decide about',
    'remind me what i noted',
    'who is',
    'what did X say about',
  ],
  examples: [
    { message: "What did Fred Wilson say about glp-1?", kb_shaped: true, expected_skill: 'kb_query' },
    { message: "What do I know about world models?", kb_shaped: true, expected_skill: 'kb_query' },
    { message: "Who runs Stripe these days?", kb_shaped: true, expected_skill: 'kb_query' },
    { message: "Remind me what we decided about Y last sprint?", kb_shaped: true, expected_skill: 'kb_query' },
    { message: "What time is sunset?", kb_shaped: false },
    { message: "Add this to my journal: 11am, called dad.", kb_shaped: false, expected_skill: 'journal' },
    { message: "Reply 'thanks' to that.", kb_shaped: false },
    { message: "How are you?", kb_shaped: false },
  ],
};

/** Minimal projection of AgentDef that buildSkillRegistry needs. Keeping this
 *  narrow lets the pure builder be tested without filesystem or loadAgentDef. */
export interface AgentDefLite {
  name: string;
  description?: string;
  triggers?: string[];
}

/** Pure composer: given a list of agent defs (already filtered to those with
 *  triggers), produce the full registry. Separated from getSkillRegistry so
 *  tests can exercise composition without fs. */
export function buildSkillRegistry(agents: AgentDefLite[]): SkillEntry[] {
  const entries: SkillEntry[] = [];
  for (const agent of agents) {
    if (!agent.triggers || agent.triggers.length === 0) continue;
    entries.push({
      name: agent.name,
      kind: 'agent',
      description: agent.description ?? `Agent: ${agent.name}`,
      triggers: agent.triggers,
    });
  }
  for (const slash of SLASH_COMMAND_METADATA) {
    entries.push({
      name: slash.name,
      kind: 'slash',
      description: slash.description,
      triggers: [...slash.triggers],
    });
  }
  entries.push(KB_QUERY_ENTRY);
  return entries;
}

let cache: SkillEntry[] | null = null;

/** Scan Jarvis + vault `.claude/agents/` for agents with `triggers:` frontmatter
 *  and assemble the full registry. Cached — call `reloadSkillRegistry()` after
 *  frontmatter edits. Jarvis-first precedence matches loadAgentDef.
 *
 *  Uses the same two-pass layout as `scanAgentCronJobs` in src/jobs/scheduler.ts
 *  (collect names → load defs) so `loadAgentDef`'s internal precedence cannot
 *  drift from the outer dedup. */
export function getSkillRegistry(): SkillEntry[] {
  if (cache) return cache;

  const seen = new Set<string>();
  const agentNames: string[] = [];

  for (const dir of [
    join(PROJECT_ROOT, '.claude', 'agents'),
    join(config.VAULT_DIR, '.claude', 'agents'),
  ]) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn(`Failed to scan agents dir ${dir}`, { error: (err as Error).message });
      }
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      const name = entry.slice(0, -'.md'.length);
      if (seen.has(name)) continue;
      seen.add(name);
      agentNames.push(name);
    }
  }

  const agents: AgentDefLite[] = [];
  for (const name of agentNames) {
    let def: AgentDef | undefined;
    try {
      def = loadAgentDef(name);
    } catch (err) {
      log.warn(`Could not load agent def for skill registry: ${name}`, {
        error: (err as Error).message,
      });
      continue;
    }
    if (!def.triggers || def.triggers.length === 0) continue;
    agents.push({ name, description: def.description, triggers: def.triggers });
  }

  cache = buildSkillRegistry(agents);
  return cache;
}

/** Evict the registry cache and the underlying agent-def cache in
 *  src/ai/claude.ts. Both caches derive from the same agent frontmatter, so
 *  they must be invalidated together. Call after frontmatter edits; also
 *  invoked from `scanAgentCronJobs` in src/jobs/scheduler.ts on every
 *  scheduler restart so the two caches cannot drift. */
export function reloadSkillRegistry(): void {
  cache = null;
  clearAgentDefCache();
}
