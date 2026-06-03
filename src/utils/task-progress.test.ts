import { describe, it, expect } from 'vitest';
import { parseTaskProgress } from './task-progress.js';

describe('parseTaskProgress', () => {
  it('counts done/total across the whole file', () => {
    const md = [
      '# Tasks',
      '',
      '- [x] one',
      '- [x] two',
      '- [ ] three',
    ].join('\n');
    const { done, total } = parseTaskProgress(md);
    expect(done).toBe(2);
    expect(total).toBe(3);
  });

  it('groups by Phase headers', () => {
    const md = [
      '## Phase 1 — setup',
      '- [x] a',
      '- [ ] b',
      '## Phase 2 — build',
      '- [x] c',
      '- [x] d',
    ].join('\n');
    const { done, total, perPhase } = parseTaskProgress(md);
    expect(done).toBe(3);
    expect(total).toBe(4);
    expect(perPhase).toEqual([
      { phase: 'Phase 1 — setup', done: 1, total: 2 },
      { phase: 'Phase 2 — build', done: 2, total: 2 },
    ]);
  });

  it('matches done checkboxes case-insensitively', () => {
    expect(parseTaskProgress('- [X] done').done).toBe(1);
  });

  it('ignores non-checkbox lines and prose', () => {
    const md = [
      '- [x] real task',
      'just a bullet:',
      '- not a checkbox',
      '  - [ ] indented (not top-level) — ignored',
    ].join('\n');
    const { done, total } = parseTaskProgress(md);
    expect(done).toBe(1);
    expect(total).toBe(1);
  });

  it('returns an empty tally for checkbox-free text', () => {
    expect(parseTaskProgress('# Just a heading\n\nSome prose.')).toEqual({
      done: 0,
      total: 0,
      perPhase: [],
    });
  });
});
