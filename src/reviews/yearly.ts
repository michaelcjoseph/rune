import { registerReviewHandler } from './orchestrator.js';
import { createInterviewHandler, toScannerDate } from './interview.js';
import type { InterviewReviewConfig } from './interview.js';
import type { ReviewSession } from './session.js';

/** Get the four quarter ranges for the year in targetDate */
function getYearQuarters(targetDate: string): Array<{ first: string; last: string; label: string }> {
  const year = Number(targetDate.split('-')[0]);
  const quarters = [
    { start: 1, end: 3, label: 'Journal Scanner (Q1)' },
    { start: 4, end: 6, label: 'Journal Scanner (Q2)' },
    { start: 7, end: 9, label: 'Journal Scanner (Q3)' },
    { start: 10, end: 12, label: 'Journal Scanner (Q4)' },
  ];

  return quarters.map(q => {
    const first = new Date(year, q.start - 1, 1);
    const last = new Date(year, q.end, 0);
    const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { first: fmt(first), last: fmt(last), label: q.label };
  });
}

const yearlyConfig: InterviewReviewConfig = {
  type: 'yearly',
  outlineMarker: 'review outline:',
  skillPath: '.claude/skills/yearly/SKILL.md',
  defaultInstructions: 'Conduct a yearly review interview using the 7 Questions framework: (1) What did I change my mind on? (2) What created energy? (3) What drained energy? (4) Boat anchors? (5) What fear stopped me? (6) Greatest hits & worst misses? (7) What did I learn? End by presenting a "[Year] Review outline:" with key points for each question.',
  buildPromptHeader: (session: ReviewSession) => {
    const year = session.targetDate.split('-')[0];
    return `You are conducting a yearly review interview. This review covers the year ${year}.`;
  },
  prepAgents: (session: ReviewSession) => {
    const quarters = getYearQuarters(session.targetDate);
    return [
      ...quarters.map(q => ({
        agent: 'journal-scanner',
        prompt: `start_date: ${toScannerDate(q.first)}, end_date: ${toScannerDate(q.last)}, focus_areas: [family, projects, emotions, reading, psychology, unresolved]`,
        label: q.label,
      })),
      { agent: 'system-scanner', prompt: 'systems: [psychology]', label: 'System Scanner Results' },
    ];
  },
  postAgents: 'psychology-only',
  psychologyScope: 'full_rewrite',
};

export const yearlyHandler = createInterviewHandler(yearlyConfig);

registerReviewHandler('yearly', yearlyHandler);
