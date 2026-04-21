import { registerReviewHandler } from './orchestrator.js';
import { createInterviewHandler, toScannerDate } from './interview.js';
import type { InterviewReviewConfig } from './interview.js';
import type { ReviewSession } from './session.js';

/** Get first and last day of the month containing targetDate */
export function getMonthRange(targetDate: string): { first: string; last: string } {
  const parts = targetDate.split('-').map(Number) as [number, number, number];
  const first = new Date(parts[0], parts[1] - 1, 1);
  const last = new Date(parts[0], parts[1], 0); // day 0 of next month = last day of this month
  const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { first: fmt(first), last: fmt(last) };
}

const monthlyConfig: InterviewReviewConfig = {
  type: 'monthly',
  outlineMarker: 'review outline:',
  skillPath: '.claude/skills/monthly/SKILL.md',
  defaultInstructions: 'Conduct a monthly review interview covering: last month\'s goals, theme check-in, memories, project status, learning, reflection, and next month\'s goals. End by presenting a "[Month Year] Review outline:" with key points for each section.',
  buildPromptHeader: (session: ReviewSession) => {
    const { first, last } = getMonthRange(session.targetDate);
    return `You are conducting a monthly review interview. This review covers ${first} to ${last}.`;
  },
  prepAgents: (session: ReviewSession) => {
    const { first, last } = getMonthRange(session.targetDate);
    return [
      { agent: 'journal-scanner', prompt: `start_date: ${toScannerDate(first)}, end_date: ${toScannerDate(last)}, focus_areas: [family, projects, tags, emotions, reading, unresolved, psychology]`, label: 'Journal Scanner Results' },
      { agent: 'system-scanner', prompt: 'systems: [health, study, career, investments, psychology, writing]', label: 'System Scanner Results' },
    ];
  },
  postAgents: 'dynamic',
  psychologyScope: 'pattern_check',
};

export const monthlyHandler = createInterviewHandler(monthlyConfig);

registerReviewHandler('monthly', monthlyHandler);
