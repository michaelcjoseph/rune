import { describe, it, expect } from 'vitest';
import {
  appendTerminalBugsToBacklog,
  formatTerminalBugLine,
  terminalBugSignature,
} from './terminal-bug-backlog.js';
import type { OrchestrationTerminalBugEntry } from './project-orchestrator.js';

function entry(over: Partial<OrchestrationTerminalBugEntry> = {}): OrchestrationTerminalBugEntry {
  return {
    runId: 'run-1',
    taskId: 'wire-the-index-writer',
    findingId: 'finding-abc',
    sourceGate: 'reviewer',
    class: 'data-integrity',
    severity: 'critical',
    location: 'src/finalizer.ts:285',
    rationale: 'project index never marked Done — completed project stays Active',
    reversible: true,
    ...over,
  };
}

describe('terminal-bug-backlog — formatting', () => {
  it('collapses a multi-line rationale to a single line', () => {
    const line = formatTerminalBugLine(entry({ rationale: 'first line\n  second line\n\nthird' }));
    expect(line).not.toContain('\n');
    expect(line).toContain('first line second line third');
  });

  it('begins the bullet text with the dedup signature and carries provenance', () => {
    const e = entry();
    const line = formatTerminalBugLine(e);
    expect(line).toContain(terminalBugSignature(e));
    expect(line).toContain('finding finding-abc');
    expect(line).toContain('task wire-the-index-writer');
  });
});

describe('terminal-bug-backlog — append', () => {
  it('creates a ## Loop-filed section at EOF when none exists', () => {
    const before = ['# Bugs', '', '## User-authored', '- [ ] something a human filed', ''].join('\n');
    const { content, appended } = appendTerminalBugsToBacklog(before, [entry()]);
    expect(appended).toBe(1);
    expect(content).toContain('## Loop-filed');
    // User-authored content preserved.
    expect(content).toContain('- [ ] something a human filed');
    // The new bullet sits under Loop-filed.
    const lines = content.split('\n');
    const loopIdx = lines.findIndex((l) => /^##\s+Loop-filed/.test(l));
    const bugIdx = lines.findIndex((l) => l.includes('src/finalizer.ts:285'));
    expect(loopIdx).toBeGreaterThanOrEqual(0);
    expect(bugIdx).toBeGreaterThan(loopIdx);
    expect(content.endsWith('\n')).toBe(true);
  });

  it('inserts as the LAST entry within an existing Loop-filed section, above a following heading', () => {
    const before = [
      '# Bugs',
      '',
      '## Loop-filed',
      '- [ ] earlier loop bug',
      '',
      '## Notes',
      'trailing section',
      '',
    ].join('\n');
    const { content, appended } = appendTerminalBugsToBacklog(before, [entry()]);
    expect(appended).toBe(1);
    const lines = content.split('\n');
    const earlierIdx = lines.findIndex((l) => l.includes('earlier loop bug'));
    const newIdx = lines.findIndex((l) => l.includes('src/finalizer.ts:285'));
    const notesIdx = lines.findIndex((l) => l === '## Notes');
    // New bullet is after the earlier loop bug but still inside the section.
    expect(newIdx).toBeGreaterThan(earlierIdx);
    expect(newIdx).toBeLessThan(notesIdx);
  });

  it('skips an entry already present (dedup by signature, returns content unchanged)', () => {
    const first = appendTerminalBugsToBacklog('# Bugs\n', [entry()]);
    const second = appendTerminalBugsToBacklog(first.content, [entry({ findingId: 'finding-different-id' })]);
    // Same defect signature, different findingId → not re-filed.
    expect(second.appended).toBe(0);
    expect(second.content).toBe(first.content);
  });

  it('dedups within a single batch', () => {
    const { content, appended } = appendTerminalBugsToBacklog('# Bugs\n', [
      entry(),
      entry({ findingId: 'finding-second', taskId: 'other-task' }),
    ]);
    expect(appended).toBe(1);
    const occurrences = content.split('\n').filter((l) => l.includes('src/finalizer.ts:285')).length;
    expect(occurrences).toBe(1);
  });

  it('files distinct defects separately', () => {
    const { content, appended } = appendTerminalBugsToBacklog('# Bugs\n', [
      entry(),
      entry({ location: 'src/other.ts:10', rationale: 'a different defect entirely' }),
    ]);
    expect(appended).toBe(2);
    expect(content).toContain('src/finalizer.ts:285');
    expect(content).toContain('src/other.ts:10');
  });
});
