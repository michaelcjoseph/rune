import type { OpKind } from './notification-bus.js';

/** Friendly labels per registered agent. Keys are the agent file basename
 *  (without `.md`); values are short user-facing phrases. Unknown agents fall
 *  back to a titlecased version of the agent name. */
const AGENT_LABELS: Record<string, string> = {
  // Runtime agents (Jarvis-resident)
  'kb-query':              'Querying knowledge base',
  'wiki-compiler':         'Compiling wiki entry',
  'wiki-linter':           'Checking knowledge base',
  'morning-prep':          'Preparing morning brief',
  'workout-generator':     'Generating workout',
  'content-triager':       'Routing content',
  'photo-classifier':      'Classifying photo',
  'session-summarizer':    'Summarizing conversation',
  'release-notes':         'Drafting release notes',
  'lenny-sync':            'Syncing Lenny library',
  'playbook-proposer':     'Drafting playbook entries',
  'project-updater':       'Updating projects',
  'playbook-updater':      'Updating playbook',
  'proposal-updater':      'Applying proposals',
  'worldview-updater':     'Updating worldview',
  'psychology-updater':    'Updating psychology profile',
  'json-updater':          'Updating data stores',
  'daily-content-updater': 'Updating daily content',
  'system-scanner':        'Scanning subsystem',
  'intent-scan':           'Scanning intent log',
  'project-setup-writer':  'Writing project files',
  // Vault-resident agents (loaded from $VAULT_DIR/.claude/agents/)
  'journal-scanner':       'Scanning journals',
  'project-scanner':       'Scanning projects',
  'review-writer':         'Writing up review',
  // Dev-tooling agents (invoked by /work)
  'test-specialist':       'Running test specialist',
  'code-reviewer':         'Reviewing code',
  'security-auditor':      'Auditing security',
  'architecture-reviewer': 'Reviewing architecture',
  'code-simplifier':       'Checking for simplifications',
  'docs-sync':             'Syncing docs',
};

/** Friendly labels per opLabel passed to askClaude / askClaudeOneShot. Keys are
 *  the raw opLabel strings used at call sites. */
const CALL_LABELS: Record<string, string> = {
  'chat':                       'Asking Claude',
  'ask':                        'Asking Claude',
  'review:daily':               'Daily review',
  'review:weekly':              'Weekly review',
  'review:monthly':             'Monthly review',
  'review:quarterly':           'Quarterly review',
  'review:yearly':              'Yearly review',
  'review:health':              'Health session',
  'review:blog':                'Blog session',
  'review:new-project':         'New project planning',
  'review:daily-routing':       'Choosing daily review updates',
  'review:weekly-routing':      'Choosing weekly review updates',
  'review:monthly-routing':     'Choosing monthly review updates',
  'review:quarterly-routing':   'Choosing quarterly review updates',
  'review:yearly-routing':      'Choosing yearly review updates',
};

/** Splits on `-`, `_`, and `:` so unknown labels of the shape
 *  `review:foo-bar` and `kb_query` both render as readable phrases when they
 *  fall through to this fallback. */
function titleCase(s: string): string {
  return s
    .split(/[-_:]/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** Map an in-flight op's (kind, rawLabel, agentName) to a short user-facing
 *  phrase used in both the Telegram tracker message and the webview pill.
 *  Unknown values fall back to titlecased forms so unknown agents don't show
 *  raw slugs to the user. */
export function formatOpLabel(opKind: OpKind, rawLabel: string, agentName?: string): string {
  if (opKind === 'agent' && agentName) {
    return AGENT_LABELS[agentName] ?? titleCase(agentName);
  }
  return CALL_LABELS[rawLabel] ?? titleCase(rawLabel);
}
