import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import config, { PROJECT_ROOT } from '../config.js';
import { clearAgentDefCache, loadAgentDef, type AgentDef } from '../ai/claude.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('skill-registry');

/** What kind of skill an entry represents.
 *  - 'agent'  — a markdown agent in .claude/agents/ invoked via runAgent()
 *  - 'slash'  — a hardcoded slash command handler in src/bot/handlers/text.ts
 *
 *  Intent-kind synthetic destinations were removed when KB queries became a
 *  capability of the default conversation handler instead of a routed skill. */
export type SkillKind = 'agent' | 'slash';

/** Few-shot example used to anchor the resolver's classification. */
export interface SkillExample {
  message: string;
  /** Skill name this example should classify to; omit for negative fixtures. */
  expected_skill?: string;
}

export interface SkillEntry {
  /** Stable identifier used by the resolver + intent log. Matches agent name
   *  for 'agent' kind, slash command name (sans `/`) for 'slash'. */
  name: string;
  kind: SkillKind;
  /** One-line description shown to the classifier. */
  description: string;
  /** Natural-language trigger phrases the classifier can match against. */
  triggers?: string[];
  /** Few-shot examples (optional). */
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
    description: 'Append an entry to today\'s journal. Also closes the active conversation thread.',
    triggers: ['add to my journal', 'log in journal', 'jot this down', 'note this', 'log this conversation'],
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
    description: 'Generates a tailored daily workout from goals, equipment, recent training, and Whoop recovery.',
    triggers: [
      'give me a workout',
      'what should I train today',
      'I\'m at the gym what should I do',
      'design me a session',
    ],
  },
  {
    name: 'done-workout',
    description: 'Logs the most recently generated workout to today\'s journal with a #workout tag.',
    triggers: [
      'workout done',
      'mark workout complete',
      'log my workout',
      'I finished my workout',
    ],
  },
  {
    name: 'syllabus',
    description: 'Current study syllabus progress and assignments.',
    triggers: ['study progress', 'what am i studying'],
  },
  {
    name: 'study',
    description: 'Spaced-repetition quiz session over due wiki concepts.',
    triggers: ['quiz me', 'review wiki', 'spaced repetition', 'lunch review'],
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
    name: 'health',
    description: 'Health coaching session.',
    triggers: ['health check-in', 'coach me on health'],
  },
  {
    name: 'blog',
    description: 'Start a writing-product blog draft or publish run.',
    triggers: ['draft a blog post', 'write an essay'],
  },
  {
    name: 'writing-critique',
    description: 'Start a writing-product critique run for a draft or target.',
    triggers: ['critique this writing', 'review this draft', 'writing critique'],
  },
  {
    name: 'library-sync',
    description: 'Pull new Lenny posts and podcasts from the Lenny MCP into the vault library.',
    triggers: ['sync lenny', 'pull new lenny posts', 'fetch new lenny content'],
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
    name: 'new-project',
    description: 'Start a product interview to plan a new Rune project and generate spec, tasks, and test plan.',
    triggers: [
      'plan a new project',
      'start a new feature',
      'I want to build something new',
      'new project setup',
      'create a project spec',
    ],
  },
  {
    name: 'plan',
    description: 'Start a Planner conversation scoped to a product — turns a fuzzy idea into an approved spec through Socratic scoping. Pass a product slug to scope immediately.',
    triggers: [
      'let\'s plan a project',
      'plan something for one of my products',
      'plan a feature',
      'kick off planning',
      'I want to scope a new project',
    ],
  },
  {
    name: 'fresh',
    description: 'Save the conversation to the journal and reset the session.',
    triggers: ['start fresh', 'reset the session', 'clear the context'],
  },
  {
    name: 'fresh-full',
    description: 'Save the full verbatim conversation transcript to the journal with speaker labels, reset session.',
    triggers: ['log full transcript', 'save full conversation', 'log everything verbatim'],
  },
] as const;

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
  return entries;
}

let cache: SkillEntry[] | null = null;

/** Scan Rune + vault `.claude/agents/` for agents with `triggers:` frontmatter
 *  and assemble the full registry. Cached — call `reloadSkillRegistry()` after
 *  frontmatter edits. Rune-first precedence matches loadAgentDef.
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
