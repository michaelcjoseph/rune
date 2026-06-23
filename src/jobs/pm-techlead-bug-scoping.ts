import { randomUUID } from 'node:crypto';
import type { BacklogItem } from '../intent/backlog-parser.js';
import {
  buildPmRolePrompt,
  buildTechLeadRolePrompt,
  extractFencedJson,
  type RoleModelCall,
} from '../intent/planning-roles-wiring.js';
import type { BugScopingFacts } from './bug-fix-gate.js';

const PM_BUG_SCOPE_INSTRUCTION = [
  'A single open bug follows. As the product manager, decide whether it is well scoped enough',
  'for a one-click Fix run. Require enough product detail that a builder can act without a',
  'planning interview: the observed problem, a concrete reproduction or trigger, and the',
  'expected user-visible behavior.',
  '',
  'Respond with EXACTLY ONE fenced ```pm-bug-scope block containing JSON, and nothing after it:',
  '```pm-bug-scope',
  '{"wellScoped": true, "reason": "<why the bug is actionable>"}',
  '```',
  'or:',
  '```pm-bug-scope',
  '{"wellScoped": false, "reason": "<what product detail is missing>"}',
  '```',
].join('\n');

const TECH_LEAD_BUG_SCOPE_INSTRUCTION = [
  'A PM-approved bug follows. As the tech lead, review whether this is feasible and scoped',
  'for one bounded Fix run. Object when the fix likely spans multiple unrelated systems,',
  'requires product replanning, or lacks enough technical boundary to start safely.',
  '',
  'Respond with EXACTLY ONE fenced ```tech-lead-bug-scope block containing JSON, and nothing after it:',
  '```tech-lead-bug-scope',
  '{"objection": null}',
  '```',
  'or:',
  '```tech-lead-bug-scope',
  '{"objection": "<specific feasibility or scope objection>"}',
  '```',
].join('\n');

export interface RunPmTechLeadBugScopingInput {
  product: string;
  bug: BacklogItem;
  modelCall?: RoleModelCall;
}

const defaultBugScopeModelCall: RoleModelCall = async ({ role, systemPrompt, message }) => {
  const sessionId = randomUUID();
  const { askClaudeWithContext, cleanupSession } = await import('../ai/claude.js');
  try {
    const result = await askClaudeWithContext(message, sessionId, systemPrompt, {
      opLabel: `bug-scope:${role}`,
    });
    if (result.error) throw new Error(`bug scoping role '${role}' model call failed: ${result.error}`);
    return result.text ?? '';
  } finally {
    cleanupSession(sessionId);
  }
};

function roleMessage(ctx: { referenceContext: string }, instruction: string): string {
  return ctx.referenceContext ? `${ctx.referenceContext}\n\n${instruction}` : instruction;
}

function isEligibleBug(bug: BacklogItem): boolean {
  return (
    bug.kind === 'bugs' &&
    bug.status === 'open' &&
    !bug.promotedTo &&
    bug.warnings.length === 0
  );
}

function hasMinimumBugFields(bug: BacklogItem): boolean {
  if (bug.text.trim()) return true;
  return bug.body.some((line) => line.trim());
}

function renderBug(product: string, bug: BacklogItem): string {
  return [
    `## Product`,
    product,
    '',
    `## Bug`,
    '',
    `ID: ${bug.id}`,
    `Title: ${bug.text.trim() || '(empty)'}`,
    '',
    'Body:',
    bug.body.length > 0 ? bug.body.join('\n') : '(empty)',
  ].join('\n');
}

function baseFacts(bug: BacklogItem): BugScopingFacts {
  return {
    itemEligible: isEligibleBug(bug),
    fieldsComplete: hasMinimumBugFields(bug),
    pmAssessed: false,
    pmWellScoped: false,
    techLeadReviewed: false,
  };
}

function parsePmBugScope(reply: string): { wellScoped: boolean; reason: string } | null {
  const parsed = extractFencedJson(reply, 'pm-bug-scope');
  if (!parsed || typeof parsed !== 'object') return null;
  const value = parsed as Record<string, unknown>;
  if (typeof value['wellScoped'] !== 'boolean') return null;
  if (typeof value['reason'] !== 'string' || !value['reason'].trim()) return null;
  return {
    wellScoped: value['wellScoped'],
    reason: value['reason'].trim(),
  };
}

function parseTechLeadBugScope(reply: string): { objection?: string } | null {
  const parsed = extractFencedJson(reply, 'tech-lead-bug-scope');
  if (!parsed || typeof parsed !== 'object') return null;
  const value = parsed as Record<string, unknown>;
  const objection = value['objection'];
  if (objection === null) return {};
  if (typeof objection === 'string') {
    const trimmed = objection.trim();
    return trimmed ? { objection: trimmed } : {};
  }
  return null;
}

export async function runPmTechLeadBugScoping(
  input: RunPmTechLeadBugScopingInput,
): Promise<BugScopingFacts> {
  const facts = baseFacts(input.bug);
  if (!facts.itemEligible || !facts.fieldsComplete) return facts;

  const modelCall = input.modelCall ?? defaultBugScopeModelCall;
  const bugBrief = renderBug(input.product, input.bug);
  const pmCtx = buildPmRolePrompt(PM_BUG_SCOPE_INSTRUCTION);
  let pmReply = '';
  try {
    pmReply = await modelCall({
      role: 'pm',
      systemPrompt: pmCtx.systemInstructions,
      message: roleMessage(pmCtx, bugBrief),
    });
  } catch {
    return {
      ...facts,
      pmReason: 'PM bug scoping model call failed; treating as not well scoped.',
    };
  }
  const pmScope = parsePmBugScope(pmReply);
  if (!pmScope) {
    return {
      ...facts,
      pmReason: 'PM bug scoping reply was unparseable; treating as not well scoped.',
    };
  }

  const pmFacts: BugScopingFacts = {
    ...facts,
    pmAssessed: true,
    pmWellScoped: pmScope.wellScoped,
    ...(pmScope.wellScoped ? {} : { pmReason: pmScope.reason }),
  };
  if (!pmScope.wellScoped) return pmFacts;

  const techLeadCtx = buildTechLeadRolePrompt(TECH_LEAD_BUG_SCOPE_INSTRUCTION);
  let techLeadReply = '';
  try {
    techLeadReply = await modelCall({
      role: 'tech-lead',
      systemPrompt: techLeadCtx.systemInstructions,
      message: roleMessage(techLeadCtx, bugBrief),
    });
  } catch {
    return {
      ...pmFacts,
      techLeadObjection: 'Tech-Lead bug scoping model call failed; treating as a scope objection.',
    };
  }
  const techLeadScope = parseTechLeadBugScope(techLeadReply);
  if (!techLeadScope) {
    return {
      ...pmFacts,
      techLeadObjection: 'Tech-Lead bug scoping reply was unparseable; treating as a scope objection.',
    };
  }

  return {
    ...pmFacts,
    techLeadReviewed: true,
    ...(techLeadScope.objection ? { techLeadObjection: techLeadScope.objection } : {}),
  };
}
